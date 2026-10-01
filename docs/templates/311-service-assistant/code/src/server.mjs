import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { config, assertCallConfig, isSimulated, readiness, clockNow } from "./config.mjs";
import { MemoryAudit } from "./audit.mjs";
import { RequestCatalog, DepartmentDirectory, readJson } from "./fixtures.mjs";
import { ContentIndex } from "./content.mjs";
import { FixtureGeocoder } from "./geocoder.mjs";
import { MemoryCaseStore } from "./db.mjs";
import { ServiceAssistantFlow } from "./flow.mjs";
import { AcsSmsLinkSender } from "./sms.mjs";
import { createHub } from "./realtime.mjs";
import { handleUtterance, registerSimulatedAgent } from "./offline.mjs";
import { attachMediaBridge, activeBridges } from "./voice/call-bridge.mjs";
import { answerInboundCall, transferToTeams, startDtmfRecognition, hangUp } from "./voice/acs.mjs";
import { resourceAccountFrom } from "./handoff.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const now = () => clockNow(config);

const requests = RequestCatalog.load(config.paths.requestTypes);
const departments = DepartmentDirectory.load(config.paths.departments, config.paths.holidays);
const content = new ContentIndex(config.paths.articles, { now, expiryGraceDays: config.contentExpiryGraceDays });
const geocoder = FixtureGeocoder.load(config.paths.addresses, config.paths.streets);
const emergency = readJson(config.paths.emergency);
const bulkPickup = readJson(config.paths.bulkPickup);
const hub = createHub();

async function stores() {
  try {
    const { SqliteAudit, SqliteCaseStore } = await import("./db.mjs");
    return { audit: new SqliteAudit(config.dbPath), cases: new SqliteCaseStore({ path: config.dbPath, now }) };
  } catch (e) {
    log(`[store] falling back to memory: ${e.message}`);
    return { audit: new MemoryAudit(), cases: new MemoryCaseStore({ now }) };
  }
}
const { audit, cases } = await stores();

const transfer = isSimulated()
  ? null
  : async (call, destination) => transferToTeams({ callConnectionId: call.callConnectionId, target: destination.target, context: destination.context, callId: call.id });
const sms = isSimulated() || !config.acs.smsFrom ? null : new AcsSmsLinkSender();

const flow = new ServiceAssistantFlow({ requests, departments, content, geocoder, cases, emergency, bulkPickup, audit, transfer, sms, hub, now });

const app = express();
app.use(express.json({ limit: "512kb" }));
app.use(express.static(join(__dirname, "..", "public")));
const asyncRoute = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { log("route error", e); if (!res.headersSent) res.status(500).json({ error: e.message }); });

const seenEvents = new Set();
app.post("/api/events", asyncRoute(async (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];
  for (const event of events) if (event.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") return res.json({ validationResponse: event.data.validationCode });
  res.sendStatus(200);
  for (const event of events) {
    if (event.eventType !== "Microsoft.Communication.IncomingCall" || seenEvents.has(event.id)) continue;
    seenEvents.add(event.id);
    await onIncomingCall(event.data).catch((e) => log("answer failed", e.message));
  }
}));

async function onIncomingCall(data) {
  const fromPhone = data?.from?.rawId?.replace(/^4:/, "") ?? data?.from?.phoneNumber?.value ?? null;
  const call = flow.create({ callId: randomUUID(), fromPhone, incomingCallContext: data.incomingCallContext, resourceAccountId: resourceAccountFrom(data?.to), sessionId: data.customContext?.voipHeaders?.["CallDetails.SessionId"] ?? data.correlationId ?? null });
  const { callConnectionId } = await answerInboundCall({ incomingCallContext: data.incomingCallContext, callId: call.id });
  flow.setCallConnection(call.id, callConnectionId);
}

app.post("/api/calls/callback", asyncRoute(async (req, res) => {
  res.sendStatus(200);
  const callId = req.query.call;
  for (const event of req.body ?? []) {
    const type = event.type?.split(".").pop();
    switch (type) {
      case "CallConnected":
        flow.setCallConnection(callId, event.data?.callConnectionId);
        await startDtmfRecognition({ callConnectionId: event.data?.callConnectionId, fromPhone: flow.get(callId)?.fromPhone });
        break;
      case "ContinuousDtmfRecognitionToneReceived":
        flow.dtmf(callId, TONE_DIGITS[event.data?.tone] ?? event.data?.tone);
        break;
      case "CallDisconnected":
        flow.endCall(callId, "caller_hung_up");
        activeBridges.get(callId)?.stop();
        break;
    }
  }
}));

const TONE_DIGITS = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };

app.post("/api/simulate", asyncRoute(async (req, res) => {
  const call = flow.create({ fromPhone: req.body?.fromPhone ?? null });
  registerSimulatedAgent(flow, call.id);
  flow.answered(call.id);
  res.json({ ok: true, callId: call.id, snapshot: flow.snapshot(call.id) });
}));
app.post("/api/simulate/:id/say", asyncRoute(async (req, res) => {
  if (!flow.get(req.params.id)) return res.status(404).json({ error: "unknown call" });
  const result = handleUtterance(flow, req.params.id, req.body?.text ?? "");
  await flow.settled(req.params.id);
  res.json({ ok: true, result, snapshot: flow.snapshot(req.params.id) });
}));
app.post("/api/simulate/:id/dtmf", asyncRoute(async (req, res) => res.json({ ok: true, result: flow.dtmf(req.params.id, String(req.body?.digit ?? "")), snapshot: flow.snapshot(req.params.id) })));
app.post("/api/simulate/:id/silence", asyncRoute(async (req, res) => res.json({ ok: true, result: flow.noInput(req.params.id), snapshot: flow.snapshot(req.params.id) })));
app.post("/api/simulate/:id/hangup", asyncRoute(async (req, res) => { flow.endCall(req.params.id, "caller_hung_up"); await hangUp(flow.get(req.params.id)?.callConnectionId); res.json({ ok: true, snapshot: flow.snapshot(req.params.id) }); }));

app.get("/api/calls/:id", (req, res) => flow.snapshot(req.params.id) ? res.json(flow.snapshot(req.params.id)) : res.status(404).json({ error: "unknown call" }));
app.get("/api/calls/:id/events", (req, res) => res.json(audit.eventsFor(req.params.id)));
app.get("/api/cases", (_req, res) => res.json(cases.all()));
app.post("/api/cases/:id/close", (req, res) => res.json(cases.close(req.params.id) ?? { error: "not_found" }));
app.get("/api/stats", (_req, res) => res.json(audit.stats(cases.all())));
app.post("/api/negotiate", (req, res) => res.json(hub.negotiate(req.body?.callId ?? "*")));
app.get("/health", (_req, res) => {
  const missing = assertCallConfig();
  res.json({ ok: true, application: "311-service-assistant", mode: missing.length ? "simulation" : "live", callReady: missing.length === 0, missingConfig: missing, ...readiness({ content, departments, caseStore: cases, geocoder }), audit: { store: audit.name, persistTranscripts: config.persistTranscripts }, realtime: hub.transport, simulation: isSimulated(), settings: { callTimeBudgetMs: config.callTimeBudgetMs, maxRequestsPerCall: config.maxRequestsPerCall, duplicateRadiusM: config.duplicate.radiusM, duplicateWindowDays: config.duplicate.windowDays } });
});

const server = createServer(app);
const wsRoutes = new Map([["/ws/hub", hub.attach()], ["/ws/media", attachMediaBridge(flow)]]);
server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  const wss = wsRoutes.get(pathname);
  if (!wss) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(config.port, config.host, () => {
  log(`311 Service Assistant demo on http://${config.host}:${config.port}`);
  log(`  report types: ${requests.ids().join(", ")}`);
  log(`  store       : ${audit.name}/${cases.name}`);
  const missing = assertCallConfig();
  if (missing.length) log(`  SIMULATION MODE — set ${missing.join(", ")} to answer real calls`);
  else log(`  Voice Live : ${config.voiceLive.model} (${config.voiceLive.apiVersion})`);
});
