import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { config, assertCallConfig, isSimulated, readiness } from "./config.mjs";
import { ContentIndex } from "./content.mjs";
import { StaffedHours } from "./hours.mjs";
import { MemoryAudit } from "./audit.mjs";
import { InquiryFlow } from "./flow.mjs";
import { createHub } from "./realtime.mjs";
import { handleUtterance, registerSimulatedAgent, runOfflineTranscript } from "./offline.mjs";
import { attachMediaBridge, activeBridges } from "./voice/call-bridge.mjs";
import { answerInboundCall, transferToTeams, startDtmfRecognition, hangUp } from "./voice/acs.mjs";
import { buildCustomCallingContext, resourceAccountFrom } from "./handoff.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ------------------------------------------------------------------ demo clock

/**
 * The clock the grounding policy sees: whether an article is fresh, stale or
 * expired, whether City Hall is open, and whether the information desk is
 * staffed. Real time unless a demo moves it: in simulation mode DEMO_NOW (or
 * DEMO_TODAY), or the console, can pin it inside or outside office hours, so
 * one running server shows both paths on stage. A server answering real calls
 * always uses the real time.
 */
const CLOCK_PRESETS = [
  // A Wednesday morning: City Hall and the information desk are open.
  { id: "business-hours", label: "Business hours", at: "2026-09-30T10:00:00-07:00" },
  // The same evening: both are closed until Thursday at 8 a.m.
  { id: "after-hours", label: "After hours", at: "2026-09-30T19:00:00-07:00" },
  { id: "real", label: "Real time", at: null },
];

function startingClock() {
  const name = config.demoNow ? "DEMO_NOW" : "DEMO_TODAY";
  const raw = config.demoNow || (config.demoToday ? `${config.demoToday}T12:00:00-07:00` : "");
  if (!raw) return { at: null, preset: "real" };
  if (!isSimulated()) {
    log(`[clock] ${name} is ignored while answering real calls`);
    return { at: null, preset: "real" };
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) {
    log(`[clock] ${name} is not a valid ISO 8601 value (${config.demoNow || config.demoToday}); using the real time`);
    return { at: null, preset: "real" };
  }
  return { at, preset: CLOCK_PRESETS.find((p) => p.at && Date.parse(p.at) === at)?.id ?? "custom" };
}

const STARTING_CLOCK = startingClock();
let clockOffsetMs = STARTING_CLOCK.at == null ? 0 : STARTING_CLOCK.at - Date.now();
let clockPreset = STARTING_CLOCK.preset;
const now = () => new Date(Date.now() + clockOffsetMs);

const hours = StaffedHours.load(undefined, { now });
const content = ContentIndex.load(undefined, { now, timeZone: hours.timeZone });
const hub = createHub();

async function createAudit() {
  try {
    const { SqliteAudit } = await import("./db.mjs");
    return new SqliteAudit();
  } catch (e) {
    log(`[audit] falling back to in-memory audit: ${e.message}`);
    return new MemoryAudit({ persistTranscripts: config.persistTranscripts });
  }
}

const audit = await createAudit();

/** The real transfer. Absent in simulation, which is what makes the flow stub it out. */
const transfer = isSimulated()
  ? null
  : async (call, destination) =>
      transferToTeams({ callConnectionId: call.callConnectionId, target: destination.target, context: destination.context, callId: call.id });

/**
 * The console shows the VoIP headers a transfer actually sends, built by the
 * same function the transfer uses, rather than its own copy of the list.
 */
const flowHub = {
  send: (callId, target, payload) =>
    hub.send(callId, target, target === "handoff" ? { ...payload, voipHeaders: buildCustomCallingContext(payload) } : payload),
};

const flow = new InquiryFlow({ content, hours, audit, transfer, hub: flowHub, now });

/**
 * Move the demo clock. Calls in progress shift by the same jump, so switching
 * to after hours mid-call does not blow that call's time budget — and the
 * policy core never has to know a demo clock exists.
 */
function setClock(at, preset) {
  const offsetMs = at == null ? 0 : at - Date.now();
  flow.rebaseClock(offsetMs - clockOffsetMs);
  clockOffsetMs = offsetMs;
  clockPreset = preset;
}

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(join(__dirname, "..", "public")));

const asyncRoute = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  log("route error", e);
  if (!res.headersSent) res.status(500).json({ error: e.message });
});

// ------------------------------------------------------------------ live calls

const seenEvents = new Set();

app.post("/api/events", asyncRoute(async (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];
  for (const event of events) {
    if (event.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") return res.json({ validationResponse: event.data.validationCode });
  }
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
    fromPhone,
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
      case "CallTransferFailed": {
        // Close honestly rather than re-dispatch, which would loop for as long
        // as the queue kept failing.
        const message = event.data?.resultInformation?.message ?? "transfer failed";
        log("[call] transfer failed", message);
        flow.transferFailed(callId, message);
        break;
      }
      case "CallDisconnected":
        flow.endCall(callId, "caller_hung_up");
        activeBridges.get(callId)?.stop();
        break;
      case "MediaStreamingFailed":
        log("[call] media streaming failed", event.data?.resultInformation?.message ?? "");
        break;
    }
  }
}));

const TONE_DIGITS = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };

// ------------------------------------------------------------- simulated calls

// A simulated call never reaches Teams, even on a server that answers real calls.
app.post("/api/simulate", asyncRoute(async (req, res) => {
  if (Array.isArray(req.body?.turns)) {
    const result = await runOfflineTranscript(flow, { fromPhone: req.body.fromPhone ?? null, turns: req.body.turns });
    return res.json({ ok: true, ...result });
  }
  const call = flow.create({ fromPhone: req.body?.fromPhone ?? null, simulated: true });
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

app.post("/api/simulate/:id/dtmf", asyncRoute(async (req, res) => {
  if (!flow.get(req.params.id)) return res.status(404).json({ error: "unknown call" });
  const result = flow.dtmf(req.params.id, String(req.body?.digit ?? ""));
  await flow.settled(req.params.id);
  res.json({ ok: true, result, snapshot: flow.snapshot(req.params.id) });
}));

app.post("/api/simulate/:id/silence", asyncRoute(async (req, res) => {
  if (!flow.get(req.params.id)) return res.status(404).json({ error: "unknown call" });
  const result = flow.noInput(req.params.id);
  await flow.settled(req.params.id);
  res.json({ ok: true, result, snapshot: flow.snapshot(req.params.id) });
}));

app.post("/api/simulate/:id/hangup", asyncRoute(async (req, res) => {
  const call = flow.get(req.params.id);
  if (!call) return res.status(404).json({ error: "unknown call" });
  flow.endCall(call.id, "caller_hung_up");
  await hangUp(call.callConnectionId);
  res.json({ ok: true, snapshot: flow.snapshot(call.id) });
}));

// ----------------------------------------------------------------- demo controls

/** Demo controls refuse to touch a server that is answering real calls. */
function simulationOnly(res) {
  if (isSimulated()) return true;
  res.status(403).json({ error: "Demo controls are off while this server answers real calls." });
  return false;
}

const clockView = () => ({
  now: now().toISOString(),
  timeZone: hours.timeZone,
  preset: clockPreset,
  presets: CLOCK_PRESETS.map(({ id, label }) => ({ id, label })),
  adjustable: isSimulated(),
});

app.get("/api/demo/clock", (_req, res) => res.json(clockView()));

app.post("/api/demo/clock", (req, res) => {
  if (!simulationOnly(res)) return;
  const { preset, at } = req.body ?? {};
  if (preset != null) {
    const match = CLOCK_PRESETS.find((p) => p.id === preset);
    if (!match) return res.status(400).json({ error: `Unknown clock preset "${preset}".` });
    setClock(match.at == null ? null : Date.parse(match.at), match.id);
  } else if (at != null) {
    const parsed = Date.parse(at);
    if (!Number.isFinite(parsed)) return res.status(400).json({ error: `"${at}" is not an ISO 8601 timestamp.` });
    setClock(parsed, "custom");
  } else {
    return res.status(400).json({ error: "Send { preset } or { at }." });
  }
  log(`[clock] demo clock → ${clockPreset} (${now().toISOString()})`);
  res.json(clockView());
});

/**
 * A clean stage between run-throughs: no calls in memory, no simulated calls
 * in the audit (calls from a real phone are kept), and the starting clock.
 */
app.post("/api/demo/reset", (_req, res) => {
  if (!simulationOnly(res)) return;
  for (const id of flow.calls.keys()) hub.forget(id);
  flow.reset();
  audit.reset();
  setClock(STARTING_CLOCK.at, STARTING_CLOCK.preset);
  log("[demo] reset");
  res.json({ ok: true, clock: clockView(), stats: audit.stats() });
});

// ------------------------------------------------------------------ console API

app.get("/api/calls/:id", (req, res) => {
  const snap = flow.snapshot(req.params.id);
  return snap ? res.json(snap) : res.status(404).json({ error: "unknown call" });
});
app.get("/api/calls/:id/events", (req, res) => res.json(audit.eventsFor(req.params.id)));
// Freshness and staffed hours are judged on the demo clock — the time the policy uses.
app.get("/api/content", (_req, res) =>
  res.json({
    ...content.summary(),
    minScore: content.minScore,
    expiryGraceDays: content.expiryGraceDays,
    articles: content.catalog(),
    desk: hours.decision(),
  }));
app.get("/api/stats", (_req, res) => res.json(audit.stats()));
app.post("/api/negotiate", (req, res) => res.json(hub.negotiate(req.body?.callId ?? "*")));

app.get("/health", (_req, res) => {
  const missing = assertCallConfig();
  res.json({
    ok: true,
    application: "general-inquiry-agent",
    mode: missing.length === 0 ? "live" : "simulation",
    simulationMode: missing.length > 0,
    callReady: missing.length === 0,
    missingConfig: missing,
    ...readiness(content, hours),
    audit: { store: audit.name, persistTranscripts: config.persistTranscripts },
    realtime: hub.transport,
    callTimeBudgetMs: config.callTimeBudgetMs,
    retrievalMinScore: config.content.minScore,
    clock: { preset: clockPreset, now: now().toISOString(), timeZone: hours.timeZone },
  });
});

// ----------------------------------------------------------------------- start

const server = createServer(app);

// One upgrade listener, routed by pathname: two WebSocketServers attached to
// one HTTP server abort each other's handshakes.
const wsRoutes = new Map([["/ws/hub", hub.attach()], ["/ws/media", attachMediaBridge(flow)]]);
server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  const wss = wsRoutes.get(pathname);
  if (!wss) {
    log("[ws] no handler for", pathname);
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(config.port, config.host, () => {
  const summary = content.summary();
  log(`General inquiry agent demo on http://${config.host}:${config.port}`);
  log(`  articles: ${summary.articleCount} (${summary.staleCount} stale, ${summary.expiredCount} expired)`);
  log(`  audit   : ${audit.name}${config.persistTranscripts ? " (transcripts persisted)" : ""}`);
  const missing = assertCallConfig();
  if (missing.length) {
    log(`  SIMULATION MODE — set ${missing.join(", ")} for live calls`);
    if (clockPreset !== "real") log(`  demo clock: ${now().toISOString()} (${clockPreset})`);
  } else {
    log(`  voice model: ${config.voiceLive.model} (${config.voiceLive.apiVersion})`);
  }
});
