import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { config, assertCallConfig, isSimulated, readiness } from "./config.mjs";
import { MemoryAudit } from "./audit.mjs";
import { createHub } from "./realtime.mjs";
import { CustomerRecordFlow } from "./flow.mjs";
import { handleUtterance, registerSimulatedAgent } from "./offline.mjs";
import { createCrmAdapter, RepDirectory, normalisePhone } from "./providers/crm.mjs";
import { answerInboundCall, transferToTeams, startDtmfRecognition, hangUp } from "./voice/acs.mjs";
import { attachMediaBridge, activeBridges } from "./voice/call-bridge.mjs";
import { resourceAccountFrom } from "./handoff.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const crm = createCrmAdapter();
const reps = RepDirectory.load();
const audit = new MemoryAudit({ persistTranscripts: config.persistTranscripts, afterCallMinutesBaseline: config.afterCallMinutesBaseline });
const hub = createHub();

const transfer = isSimulated()
  ? null
  : async (call, destination) => transferToTeams({ callConnectionId: call.callConnectionId, target: destination.target, context: destination.context, callId: call.id });
const flow = new CustomerRecordFlow({ crm, reps, audit, transfer, hub });

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
    if (event.eventType !== "Microsoft.Communication.IncomingCall") continue;
    if (seenEvents.has(event.id)) continue;
    seenEvents.add(event.id);
    await onIncomingCall(event.data).catch((e) => log("answer failed", e.message));
  }
}));

async function onIncomingCall(data) {
  const fromPhone = data?.from?.rawId?.replace(/^4:/, "") ?? data?.from?.phoneNumber?.value ?? null;
  const teamsUserId = data?.from?.rawId?.startsWith("8:orgid:") ? data.from.rawId : data?.from?.microsoftTeamsUserId ?? null;
  const call = flow.create({
    callId: randomUUID(),
    fromPhone: fromPhone ? normalisePhone(fromPhone) : null,
    teamsUserId,
    incomingCallContext: data.incomingCallContext,
    resourceAccountId: resourceAccountFrom(data?.to),
    sessionId: data.customContext?.voipHeaders?.["CallDetails.SessionId"] ?? data.correlationId ?? null,
  });
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
      case "MediaStreamingFailed":
        log("media streaming failed", event.data?.resultInformation?.message ?? "");
        break;
    }
  }
}));
const TONE_DIGITS = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", asterisk: "*" };

app.post("/api/simulate", asyncRoute(async (req, res) => {
  const call = flow.startSimulation({ repId: req.body?.repId ?? "rep-alex" });
  registerSimulatedAgent(flow, call.id);
  res.json({ ok: true, callId: call.id, snapshot: flow.snapshot(call.id) });
}));
app.post("/api/simulate/pstn", asyncRoute(async (req, res) => {
  const call = flow.create({ fromPhone: normalisePhone(req.body?.fromPhone ?? "+14255550197") });
  registerSimulatedAgent(flow, call.id);
  const result = flow.answer(call.id);
  res.json({ ok: true, callId: call.id, result, snapshot: flow.snapshot(call.id) });
}));
app.post("/api/simulate/:id/say", asyncRoute(async (req, res) => {
  if (!flow.get(req.params.id)) return res.status(404).json({ error: "unknown call" });
  const result = handleUtterance(flow, req.params.id, req.body?.text ?? "");
  res.json({ ok: true, result, snapshot: flow.snapshot(req.params.id) });
}));
app.post("/api/simulate/:id/dtmf", asyncRoute(async (req, res) => res.json({ ok: true, result: flow.dtmf(req.params.id, String(req.body?.digit ?? "")), snapshot: flow.snapshot(req.params.id) })));
app.post("/api/simulate/:id/hangup", asyncRoute(async (req, res) => { flow.endCall(req.params.id, "caller_hung_up"); await hangUp(flow.get(req.params.id)?.callConnectionId); res.json({ ok: true, snapshot: flow.snapshot(req.params.id) }); }));

app.get("/api/calls/:id", (req, res) => flow.snapshot(req.params.id) ? res.json(flow.snapshot(req.params.id)) : res.status(404).json({ error: "unknown call" }));
app.get("/api/calls/:id/events", (req, res) => res.json(audit.eventsFor(req.params.id)));
app.get("/api/stats", (_req, res) => res.json(audit.stats(crm)));
app.post("/api/crm/reset", (_req, res) => res.json({ ok: true, counts: crm.reset() }));
app.get("/api/crm/accounts", (_req, res) => res.json({ counts: crm.counts() }));
app.post("/api/negotiate", (req, res) => res.json(hub.negotiate(req.body?.callId ?? "*")));
app.get("/health", (_req, res) => {
  const missing = assertCallConfig();
  res.json({
    ok: true,
    application: "customer-record-lookup-update",
    mode: missing.length === 0 ? "live" : "simulation",
    callReady: missing.length === 0,
    missingConfig: missing,
    ...readiness({ crmCounts: crm.counts(), repCount: reps.count, routing: flow.routing }),
    audit: { store: audit.name, transcriptRetention: config.persistTranscripts },
    realtime: hub.transport,
    callBudgetMs: config.callTimeBudgetMs,
    demoNow: config.demoNow,
  });
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
  log(`Customer record lookup/update demo on http://${config.host}:${config.port}`);
  log(`  CRM adapter        : ${crm.name}`);
  log(`  simulation mode   : ${isSimulated()}`);
  if (assertCallConfig().length) log(`  set ${assertCallConfig().join(", ")} for live calls`);
});
