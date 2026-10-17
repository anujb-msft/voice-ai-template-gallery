import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { config, assertCallConfig, isSimulated, readiness } from "./config.mjs";
import { MemoryAudit } from "./audit.mjs";
import { createHub } from "./realtime.mjs";
import { CustomerRecordFlow, STATES } from "./flow.mjs";
import { handleUtterance, registerSimulatedAgent } from "./offline.mjs";
import { createCrmAdapter, RepDirectory, normalisePhone } from "./providers/crm.mjs";
import { answerInboundCall, transferToTeams, startDtmfRecognition, hangUp } from "./voice/acs.mjs";
import { attachMediaBridge, activeBridges } from "./voice/call-bridge.mjs";
import { resourceAccountFrom, buildCustomCallingContext } from "./handoff.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const FINISHED = new Set([STATES.REFUSED, STATES.TRANSFERRED, STATES.ENDED]);

// ------------------------------------------------------------------ demo clock

/**
 * The clock the policy and the CRM see. The seeded records carry real dates (a
 * task due on June 10, 2026, a renewal closing on June 30), so a simulation
 * starts on the demo-day preset and every run reads the same "due today" and
 * the same "Friday". DEMO_NOW, or the console, can move it. A server answering
 * real calls always runs on the real time.
 */
const CLOCK_PRESETS = [
  // Wednesday, June 10, 2026, noon in Redmond: the Fabrikam task is due today.
  { id: "demo-day", label: "Demo day", at: "2026-06-10T12:00:00-07:00" },
  { id: "real", label: "Real time", at: null },
];

function startingClock() {
  const demoDay = { at: Date.parse(CLOCK_PRESETS[0].at), preset: CLOCK_PRESETS[0].id };
  const wanted = config.demoNow.trim();
  if (!isSimulated()) {
    if (wanted) log("[clock] DEMO_NOW is ignored while answering real calls");
    return { at: null, preset: "real" };
  }
  if (!wanted) return demoDay;
  const named = CLOCK_PRESETS.find((p) => p.id === wanted.toLowerCase());
  if (named) return { at: named.at == null ? null : Date.parse(named.at), preset: named.id };
  const at = Date.parse(wanted);
  if (!Number.isFinite(at)) {
    log(`[clock] DEMO_NOW is not an ISO 8601 timestamp (${wanted}); using the demo-day preset`);
    return demoDay;
  }
  return { at, preset: CLOCK_PRESETS.find((p) => p.at && Date.parse(p.at) === at)?.id ?? "custom" };
}

const STARTING_CLOCK = startingClock();
let clockOffsetMs = STARTING_CLOCK.at == null ? 0 : STARTING_CLOCK.at - Date.now();
let clockPreset = STARTING_CLOCK.preset;
const now = () => Date.now() + clockOffsetMs;

// ------------------------------------------------------------------ the parts

const crm = await createCrmAdapter({ now, timeZone: config.timeZone, log });
const reps = RepDirectory.load();
const audit = new MemoryAudit({ persistTranscripts: config.persistTranscripts, now });
const hub = createHub();

/** The real transfer. Absent in simulation, which is what makes the flow stub it out. */
const transfer = isSimulated()
  ? null
  : async (call, destination) =>
      transferToTeams({
        callConnectionId: call.callConnectionId,
        target: destination.target,
        context: destination.context,
        callId: call.id,
      });

/**
 * The console shows the VoIP headers a transfer actually sends, built by the
 * same function the transfer uses, rather than its own copy of the list.
 */
const withHeaders = (handoff) => (handoff ? { ...handoff, voipHeaders: buildCustomCallingContext(handoff) } : handoff);
const flowHub = {
  send(callId, target, payload) {
    if (target === "handoff") payload = withHeaders(payload);
    else if (target === "state" && payload?.handoff) payload = { ...payload, handoff: withHeaders(payload.handoff) };
    hub.send(callId, target, payload);
  },
};

const flow = new CustomerRecordFlow({ crm, reps, audit, transfer, hub: flowHub, now, timeZone: config.timeZone });

/** A call as the console sees it, with the headers its handoff carried. */
function view(callId) {
  const snapshot = flow.snapshot(callId);
  return snapshot && { ...snapshot, handoff: withHeaders(snapshot.handoff) };
}

/**
 * Move the demo clock. Calls in progress shift by the same jump, so a clock
 * change mid-call does not spend that call's time budget. Undo windows run on
 * the real clock and are not affected.
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

const asyncRoute = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    log("route error", e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });

// ------------------------------------------------------------- Event Grid intake

/** Event Grid delivers the same event more than once by design. */
const seenEvents = new Set();

/**
 * Inbound calls arrive as an Event Grid `IncomingCall` event. The first request
 * Event Grid ever sends is a validation handshake, so that is answered first.
 */
app.post(
  "/api/events",
  asyncRoute(async (req, res) => {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    for (const event of events) {
      if (event?.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
        log("[eventgrid] subscription validation handshake");
        return res.json({ validationResponse: event.data.validationCode });
      }
    }
    res.sendStatus(200);
    for (const event of events) {
      if (event?.eventType !== "Microsoft.Communication.IncomingCall") continue;
      if (seenEvents.has(event.id)) {
        log("[eventgrid] ignoring duplicate delivery", event.id);
        continue;
      }
      seenEvents.add(event.id);
      await onIncomingCall(event.data).catch((e) => log("[eventgrid] answer failed", e.message));
    }
  }),
);

async function onIncomingCall(data) {
  const rawId = String(data?.from?.rawId ?? "");
  // A PSTN caller is "4:+1…"; a Teams user is "8:orgid:<object id>". Neither is ever logged in full.
  const fromPhone = rawId.startsWith("4:") ? rawId.slice(2) : (data?.from?.phoneNumber?.value ?? null);
  const teamsUserId = rawId.startsWith("8:orgid:") ? rawId : (data?.from?.microsoftTeamsUser?.userId ?? null);
  const call = flow.create({
    callId: randomUUID(),
    fromPhone: fromPhone ? normalisePhone(fromPhone) : null,
    teamsUserId,
    incomingCallContext: data.incomingCallContext,
    resourceAccountId: resourceAccountFrom(data?.to),
    // Keep an Auto Attendant's session id when this line sits behind one, so the journey correlates in Teams.
    sessionId: data.customContext?.voipHeaders?.["CallDetails.SessionId"] ?? data.correlationId ?? null,
  });
  log("[call] incoming", call.id, "via", call.arrival, teamsUserId ? "(Teams user)" : "(phone)");
  const { callConnectionId } = await answerInboundCall({ incomingCallContext: data.incomingCallContext, callId: call.id });
  flow.setCallConnection(call.id, callConnectionId);
  // The identity check starts when the media bridge has Voice Live connected (call-bridge.mjs), so the caller hears it.
}

// --------------------------------------------------------------- ACS callbacks

app.post(
  "/api/calls/callback",
  asyncRoute(async (req, res) => {
    res.sendStatus(200);
    const callId = req.query.call;
    for (const event of Array.isArray(req.body) ? req.body : []) {
      const type = event.type?.split(".").pop();
      log("[acs]", type, callId);
      switch (type) {
        case "CallConnected":
          flow.setCallConnection(callId, event.data?.callConnectionId);
          await startDtmfRecognition({ callConnectionId: event.data?.callConnectionId, fromPhone: flow.get(callId)?.fromPhone });
          break;
        case "ContinuousDtmfRecognitionToneReceived": {
          // ACS names the tone; the keypad map is keyed by digit. PIN digits are never logged.
          const digit = TONE_DIGITS[event.data?.tone];
          if (digit != null && flow.get(callId)) await flow.dtmf(callId, digit);
          break;
        }
        case "MediaStreamingFailed": {
          const info = event.data?.resultInformation ?? {};
          log("[call] media streaming failed", `code=${info.code} sub=${info.subCode}`, info.message ?? "");
          break;
        }
        case "CallTransferAccepted":
          log("[call] transfer accepted", callId);
          break;
        case "CallTransferFailed": {
          // ACS accepted the transfer, then nobody took it, and the caller is still on the line.
          // Close honestly rather than re-dispatch, which would loop for as long as the queue kept failing.
          const info = event.data?.resultInformation ?? {};
          const message = info.message ?? "transfer failed";
          log("[call] transfer failed", `code=${info.code} sub=${info.subCode}`, message);
          const recovery = flow.transferFailed(callId, message);
          // The bridge hangs up once the apology has played (call-bridge.mjs). Without a media
          // bridge there is no voice to wait for, so hang up at once rather than leave an open line.
          if (recovery.reason === "transfer_failed" && !activeBridges.has(callId)) await hangUp(flow.get(callId)?.callConnectionId);
          break;
        }
        case "CallDisconnected":
          flow.endCall(callId, "caller_hung_up");
          activeBridges.get(callId)?.stop();
          break;
      }
    }
  }),
);

const TONE_DIGITS = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", asterisk: "*", pound: "#" };

// ------------------------------------------------------------------ simulation

/**
 * The offline demo. A typed line drives the same identity checks, the same
 * allow-list, the same undo window and the same handoff assembly as a real
 * call; only the speech model and the audio path are stubbed. A simulated call
 * is never transferred for real, even on a server that answers real calls.
 */
app.post(
  "/api/simulate",
  asyncRoute(async (req, res) => {
    const repId = req.body?.repId ?? "rep-alex";
    if (!reps.reps.some((r) => r.id === repId)) return res.status(400).json({ error: `Unknown rep "${repId}".` });
    const fromPhone = req.body?.fromPhone ? normalisePhone(req.body.fromPhone) : null;
    const call = flow.startSimulation({ repId, fromPhone });
    registerSimulatedAgent(flow, call.id);
    res.json({ ok: true, callId: call.id, snapshot: view(call.id) });
  }),
);

/** Every simulate route answers `{ ok, result, snapshot }`, after any transfer has settled. */
function simulateRoute(handler) {
  return asyncRoute(async (req, res) => {
    const callId = req.params.id;
    if (!flow.get(callId)) return res.status(404).json({ error: "unknown call" });
    const result = await handler(callId, req, res);
    if (res.headersSent) return;
    await flow.settled(callId);
    res.json({ ok: true, result, snapshot: view(callId) });
  });
}

app.post(
  "/api/simulate/:id/say",
  simulateRoute((callId, req) => handleUtterance(flow, callId, req.body?.text ?? "")),
);

/** A keypad press, or a run of them ("246810" for a PIN). PIN digits show as dots. */
app.post(
  "/api/simulate/:id/dtmf",
  simulateRoute(async (callId, req, res) => {
    const keys = String(req.body?.digit ?? "").trim();
    if (!/^[0-9*#]{1,12}$/.test(keys)) {
      res.status(400).json({ error: "Send { digit } with keypad keys: 0-9, * or #." });
      return null;
    }
    const call = flow.get(callId);
    if (FINISHED.has(call.state)) return { ok: false, reason: "call_finished" };
    const collectingPin = call.state === STATES.IDENTIFYING && Boolean(call.pendingPstnRep);
    flow.pushTranscript(callId, "caller", `Keypad · ${collectingPin ? "•".repeat(keys.length) : keys}`);
    let result = null;
    for (const key of keys) {
      if (FINISHED.has(flow.get(callId)?.state)) break;
      result = await flow.dtmf(callId, key);
    }
    return result;
  }),
);

app.post(
  "/api/simulate/:id/silence",
  simulateRoute((callId) => flow.noInput(callId)),
);

app.post(
  "/api/simulate/:id/hangup",
  simulateRoute(async (callId) => {
    const result = flow.endCall(callId, "caller_hung_up");
    await hangUp(flow.get(callId)?.callConnectionId);
    return result;
  }),
);

// ----------------------------------------------------------------- demo controls

/** Demo controls refuse to touch a server that is answering real calls. */
function simulationOnly(res) {
  if (isSimulated()) return true;
  res.status(403).json({ error: "Demo controls are off while this server answers real calls." });
  return false;
}

const clockView = () => ({
  now: new Date(now()).toISOString(),
  timeZone: config.timeZone,
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
    setClock(parsed, CLOCK_PRESETS.find((p) => p.at && Date.parse(p.at) === parsed)?.id ?? "custom");
  } else {
    return res.status(400).json({ error: "Send { preset } or { at }." });
  }
  log(`[clock] demo clock → ${clockPreset} (${new Date(now()).toISOString()})`);
  res.json(clockView());
});

/**
 * A clean stage between run-throughs: no calls in memory, no simulated calls in
 * the audit (calls from a real phone are kept), the seeded records back in the
 * local demo CRM, and the starting clock. Open undo windows close unwritten.
 */
app.post("/api/demo/reset", (_req, res) => {
  if (!simulationOnly(res)) return;
  for (const id of flow.calls.keys()) hub.forget(id);
  flow.reset();
  audit.reset();
  const counts = crm.reset?.() ?? crm.counts?.() ?? {};
  setClock(STARTING_CLOCK.at, STARTING_CLOCK.preset);
  log("[demo] reset");
  res.json({ ok: true, clock: clockView(), stats: audit.stats(crm), counts });
});

/**
 * Put the seeded records back without touching calls or metrics, so each beat
 * starts from the same Fabrikam record while the metrics keep counting. Any
 * open undo window is waited out first (bounded), never cut short.
 */
app.post(
  "/api/demo/records",
  asyncRoute(async (_req, res) => {
    if (!simulationOnly(res)) return;
    const settled = await flow.settleAll();
    const restored = typeof crm.reset === "function";
    const counts = restored ? crm.reset() : (crm.counts?.() ?? {});
    res.json({ ok: true, restored, waited: settled.waited, counts });
  }),
);

// ------------------------------------------------------------------ console API

app.get("/api/calls/:id", (req, res) => {
  const snapshot = view(req.params.id);
  return snapshot ? res.json(snapshot) : res.status(404).json({ error: "unknown call" });
});

app.get("/api/calls/:id/events", (req, res) => res.json(audit.eventsFor(req.params.id)));

app.get("/api/stats", (_req, res) => res.json(audit.stats(crm)));

app.post("/api/negotiate", (req, res) => res.json(hub.negotiate(req.body?.callId ?? "*")));

app.get("/health", (_req, res) => {
  const missing = assertCallConfig();
  const ready = readiness({ crmCounts: crm.counts?.() ?? {}, repCount: reps.count, routing: flow.routing });
  res.json({
    ok: true,
    application: "customer-record-lookup-update",
    organization: "Contoso",
    mode: missing.length === 0 ? "live" : "simulation",
    callReady: missing.length === 0,
    missingConfig: missing,
    ...ready,
    crm: { ...ready.crm, adapter: crm.name, ready: ["sqlite", "memory"].includes(crm.name) },
    audit: { store: audit.name, transcriptRetention: config.persistTranscripts },
    realtime: hub.transport,
    policy: { commitUndoMs: flow.options.commitUndoMs, callBudgetMs: flow.options.callTimeBudgetMs, wrapUpMs: flow.options.wrapUpMs },
    clock: { preset: clockPreset, now: new Date(now()).toISOString(), timeZone: config.timeZone },
  });
});

// The call-time cap: a warning, a draft at wrap-up, then a polite end.
setInterval(() => {
  for (const id of [...flow.calls.keys()]) {
    try {
      flow.checkBudget(id);
    } catch (e) {
      log("[budget]", e.message);
    }
  }
}, 5000).unref();

// ----------------------------------------------------------------------- start

const server = createServer(app);

// One upgrade listener, routed by pathname: two WebSocketServers on one HTTP
// server would each abort the handshake for the other's path.
const wsRoutes = new Map([
  ["/ws/hub", hub.attach()],
  ["/ws/media", attachMediaBridge(flow)],
]);

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
  log(`Customer record lookup & update demo on http://${config.host}:${config.port}`);
  log(`  CRM adapter        : ${crm.name}`);
  log(`  reps               : ${reps.count}`);
  log(`  undo window        : ${flow.options.commitUndoMs / 1000}s`);
  log(`  audit              : ${audit.name}${config.persistTranscripts ? " (transcripts retained)" : ""}`);
  const missing = assertCallConfig();
  if (missing.length) {
    log(`  SIMULATION MODE    — set ${missing.join(", ")} to answer real calls`);
    log(`  demo clock         : ${new Date(now()).toISOString()} (${clockPreset})`);
  } else {
    log(`  voice model        : ${config.voiceLive.model} (WebSocket ${config.voiceLive.apiVersion})`);
    log(`  public base URL    : ${config.publicBaseUrl}`);
  }
});
