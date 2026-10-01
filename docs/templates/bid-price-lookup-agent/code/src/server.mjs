import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { config, assertCallConfig, isSimulated, readiness } from "./config.mjs";
import { MemoryAudit } from "./audit.mjs";
import { BidLookupFlow } from "./flow.mjs";
import { PriceBook, LocationDirectory, FixtureFeed } from "./pricing.mjs";
import { createHub } from "./realtime.mjs";
import { handleUtterance, registerSimulatedAgent } from "./offline.mjs";
import { attachMediaBridge, activeBridges } from "./voice/call-bridge.mjs";
import { answerInboundCall, transferToTeams, startDtmfRecognition, hangUp } from "./voice/acs.mjs";
import { resourceAccountFrom } from "./handoff.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const normalisePhone = (phone) => String(phone ?? "").replace(/[^\d+]/g, "");

const feed = new FixtureFeed();
const priceBook = new PriceBook({ locations: LocationDirectory.load(), feed, now: () => new Date(config.pricing.demoNow) });
const hub = createHub();

async function createAudit() {
  try { const { SqliteAudit } = await import("./db.mjs"); return new SqliteAudit(); }
  catch (e) { log(`[audit] falling back to in-memory audit: ${e.message}`); return new MemoryAudit(); }
}
const audit = await createAudit();
const transfer = isSimulated() ? null : async (call, destination) => transferToTeams({ callConnectionId: call.callConnectionId, target: destination.target, context: destination.context, callId: call.id });
const flow = new BidLookupFlow({ priceBook, audit, transfer, hub, now: () => Date.parse(config.pricing.demoNow) });

const app = express();
app.use(express.json({ limit: "256kb" }));
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
    await onIncomingCall(event.data).catch((e) => log("[eventgrid] answer failed", e));
  }
}));

async function onIncomingCall(data) {
  const fromPhone = data?.from?.rawId?.replace(/^4:/, "") ?? data?.from?.phoneNumber?.value ?? null;
  const call = flow.create({
    callId: randomUUID(),
    fromPhone: fromPhone ? normalisePhone(fromPhone) : null,
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
      case "ContinuousDtmfRecognitionToneReceived": {
        const digit = TONE_DIGITS[event.data?.tone] ?? event.data?.tone;
        if (digit != null) flow.dtmf(callId, String(digit));
        break;
      }
      case "CallDisconnected": flow.endCall(callId, "caller_hung_up"); activeBridges.get(callId)?.stop(); break;
    }
  }
}));

const TONE_DIGITS = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };

app.post("/api/simulate", asyncRoute(async (req, res) => {
  const call = flow.create({ fromPhone: req.body?.fromPhone ? normalisePhone(req.body.fromPhone) : null });
  registerSimulatedAgent(flow, call.id);
  flow.answered(call.id);
  res.json({ ok: true, callId: call.id, snapshot: flow.snapshot(call.id) });
}));
app.post("/api/simulate/:id/say", asyncRoute(async (req, res) => { if (!flow.get(req.params.id)) return res.status(404).json({ error: "unknown call" }); const result = handleUtterance(flow, req.params.id, req.body?.text ?? ""); await flow.settled(req.params.id); res.json({ ok: true, result, snapshot: flow.snapshot(req.params.id) }); }));
app.post("/api/simulate/:id/dtmf", asyncRoute(async (req, res) => { if (!flow.get(req.params.id)) return res.status(404).json({ error: "unknown call" }); const result = flow.dtmf(req.params.id, String(req.body?.digit ?? "")); await flow.settled(req.params.id); res.json({ ok: true, result, snapshot: flow.snapshot(req.params.id) }); }));
app.post("/api/simulate/:id/silence", asyncRoute(async (req, res) => { if (!flow.get(req.params.id)) return res.status(404).json({ error: "unknown call" }); const result = flow.noInput(req.params.id); res.json({ ok: true, result, snapshot: flow.snapshot(req.params.id) }); }));
app.post("/api/simulate/:id/hangup", asyncRoute(async (req, res) => { flow.endCall(req.params.id, "caller_hung_up"); await hangUp(flow.get(req.params.id)?.callConnectionId); res.json({ ok: true, snapshot: flow.snapshot(req.params.id) }); }));

app.get("/api/locations", (_req, res) => res.json({ organization: priceBook.locations.organization, locations: priceBook.locations.all().map((l) => ({ id: l.id, displayName: l.displayName, aliases: l.aliases })) }));
app.get("/api/bid-board", (_req, res) => res.json({ health: priceBook.health(), corn: priceBook.list({ commodity: "corn" }).quotes, soybeans: priceBook.list({ commodity: "soybeans" }).quotes, wheat: priceBook.list({ commodity: "wheat" }).quotes }));
app.post("/api/demo/feed-down", (req, res) => { feed.setFeedDown(req.body?.down !== false); res.json({ ok: true, health: priceBook.health() }); });
app.post("/api/demo/make-stale", (req, res) => { feed.makeStale(req.body?.minutes ?? 60); res.json({ ok: true, health: priceBook.health() }); });
app.get("/api/calls/:id", (req, res) => { const snap = flow.snapshot(req.params.id); return snap ? res.json(snap) : res.status(404).json({ error: "unknown call" }); });
app.get("/api/calls/:id/events", (req, res) => res.json(audit.eventsFor(req.params.id)));
app.get("/api/stats", (_req, res) => res.json(audit.stats({ minutesPerAutomatedCall: config.pricing.minutesPerAutomatedCall })));
app.post("/api/negotiate", (req, res) => res.json(hub.negotiate(req.body?.callId ?? "*")));

app.get("/health", (_req, res) => {
  const missing = assertCallConfig();
  res.json({
    ok: true,
    application: "bid-price-lookup-agent",
    mode: missing.length === 0 ? "live" : "simulation",
    simulationMode: missing.length > 0,
    callReady: missing.length === 0,
    missingConfig: missing,
    ...readiness(priceBook),
    audit: { store: audit.name, persistTranscripts: config.persistTranscripts },
    realtime: hub.transport,
    pricing: { callTimeBudgetMs: config.pricing.callTimeBudgetMs, demoNow: config.pricing.demoNow, futuresStaleMinutes: config.pricing.futuresStaleMinutes, futuresHardLimitMinutes: config.pricing.futuresHardLimitMinutes },
  });
});

const server = createServer(app);
const wsRoutes = new Map([["/ws/hub", hub.attach()], ["/ws/media", attachMediaBridge(flow)]]);
server.on("upgrade", (req, socket, head) => { const { pathname } = new URL(req.url, "http://localhost"); const wss = wsRoutes.get(pathname); if (!wss) return socket.destroy(); wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)); });
server.listen(config.port, config.host, () => {
  log(`Bid price lookup demo on http://${config.host}:${config.port}`);
  log(`  organization       : ${priceBook.locations.organization}`);
  log(`  audit              : ${audit.name}${config.persistTranscripts ? " (transcripts persisted)" : ""}`);
  const missing = assertCallConfig();
  if (missing.length) log(`  SIMULATION MODE    — set ${missing.join(", ")} to answer real calls`);
  else log(`  voice model        : ${config.voiceLive.model} (${config.voiceLive.apiVersion})`);
});
