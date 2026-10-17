import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { config, assertCallConfig, isSimulated, readiness } from "./config.mjs";
import { RoutePolicy, CallerDirectory, normalisePhone } from "./routes.mjs";
import { MemoryAudit } from "./audit.mjs";
import { RoutingFlow } from "./flow.mjs";
import { createHub } from "./realtime.mjs";
import { handleUtterance, registerSimulatedAgent } from "./offline.mjs";
import { attachMediaBridge, activeBridges } from "./voice/call-bridge.mjs";
import { answerInboundCall, transferToTeams, startDtmfRecognition, hangUp } from "./voice/acs.mjs";
import { resourceAccountFrom, buildCustomCallingContext } from "./handoff.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const routes = RoutePolicy.load();
const callers = CallerDirectory.load();
const hub = createHub();

/**
 * SQLite is loaded only when it is actually going to be used. better-sqlite3 is
 * a native module, so keeping it off the offline path means the demo still
 * starts if the build step failed on an unusual platform.
 */
async function createAudit() {
  try {
    const { SqliteAudit } = await import("./db.mjs");
    return new SqliteAudit();
  } catch (e) {
    log(`[audit] falling back to in-memory audit: ${e.message}`);
    return new MemoryAudit();
  }
}

const audit = await createAudit();

// ------------------------------------------------------------------ demo clock

/**
 * The clock the routing policy sees. Real time unless a demo moves it: in
 * simulation mode DEMO_NOW, or the console, can pin it inside or outside
 * business hours, so one running server shows both paths on stage. A server
 * answering real calls always routes on the real time.
 */
const CLOCK_PRESETS = [
  // A Wednesday, so every weekday route is in play.
  { id: "business-hours", label: "Business hours", at: "2026-09-30T10:30:00-07:00" },
  { id: "after-hours", label: "After hours", at: "2026-09-30T19:30:00-07:00" },
  { id: "real", label: "Real time", at: null },
];

function startingClock() {
  if (!config.demoNow) return { at: null, preset: "real" };
  if (!isSimulated()) {
    log("[clock] DEMO_NOW is ignored while answering real calls");
    return { at: null, preset: "real" };
  }
  const at = Date.parse(config.demoNow);
  if (!Number.isFinite(at)) {
    log(`[clock] DEMO_NOW is not an ISO 8601 timestamp (${config.demoNow}); using the real time`);
    return { at: null, preset: "real" };
  }
  return { at, preset: CLOCK_PRESETS.find((p) => p.at && Date.parse(p.at) === at)?.id ?? "custom" };
}

const STARTING_CLOCK = startingClock();
let clockOffsetMs = STARTING_CLOCK.at == null ? 0 : STARTING_CLOCK.at - Date.now();
let clockPreset = STARTING_CLOCK.preset;
const now = () => Date.now() + clockOffsetMs;

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
const flowHub = {
  send: (callId, target, payload) =>
    hub.send(callId, target, target === "handoff" ? { ...payload, voipHeaders: buildCustomCallingContext(payload) } : payload),
};

const flow = new RoutingFlow({ routes, callers, audit, transfer, hub: flowHub, now });

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

const asyncRoute = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    log("route error", e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });

// ------------------------------------------------------------- Event Grid intake

/** Event Grid delivers the same event more than once by design. */
const seenEvents = new Set();

/**
 * Inbound calls arrive here as an Event Grid `IncomingCall` event, which is the
 * only way to be told about a call to your ACS number. The first request Event
 * Grid ever sends is a validation handshake, so that is answered before
 * anything else.
 */
app.post(
  "/api/events",
  asyncRoute(async (req, res) => {
    const events = Array.isArray(req.body) ? req.body : [req.body];

    for (const event of events) {
      if (event.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
        log("[eventgrid] subscription validation handshake");
        return res.json({ validationResponse: event.data.validationCode });
      }
    }

    res.sendStatus(200);

    for (const event of events) {
      if (event.eventType !== "Microsoft.Communication.IncomingCall") continue;
      if (seenEvents.has(event.id)) {
        log("[eventgrid] ignoring duplicate delivery", event.id);
        continue;
      }
      seenEvents.add(event.id);
      await onIncomingCall(event.data).catch((e) => log("[eventgrid] answer failed", e));
    }
  }),
);

async function onIncomingCall(data) {
  const fromPhone = data?.from?.rawId?.replace(/^4:/, "") ?? data?.from?.phoneNumber?.value ?? null;
  const resourceAccountId = resourceAccountFrom(data?.to);

  const call = flow.create({
    callId: randomUUID(),
    fromPhone: fromPhone ? normalisePhone(fromPhone) : null,
    incomingCallContext: data.incomingCallContext,
    resourceAccountId,
    // Preserve an Auto Attendant's session id when this line sits behind one, so
    // the whole journey correlates in Teams rather than restarting here.
    sessionId: data.customContext?.voipHeaders?.["CallDetails.SessionId"] ?? data.correlationId ?? null,
  });

  log("[call] incoming", call.id, "from", call.maskedPhone, "via", call.arrival);
  if (call.arrival === "acs-direct") {
    log("[call] note: no Teams resource account on this call — Teams Phone extensibility context is absent");
  }

  const { callConnectionId } = await answerInboundCall({
    incomingCallContext: data.incomingCallContext,
    callId: call.id,
  });
  flow.setCallConnection(call.id, callConnectionId);
}

// --------------------------------------------------------------- ACS callbacks

app.post(
  "/api/calls/callback",
  asyncRoute(async (req, res) => {
    res.sendStatus(200);
    const callId = req.query.call;

    for (const event of req.body ?? []) {
      const type = event.type?.split(".").pop();
      log("[acs]", type, callId);

      switch (type) {
        case "CallConnected":
          flow.setCallConnection(callId, event.data?.callConnectionId);
          await startDtmfRecognition({
            callConnectionId: event.data?.callConnectionId,
            fromPhone: flow.get(callId)?.fromPhone,
          });
          break;

        case "ContinuousDtmfRecognitionToneReceived": {
          // ACS reports the tone by name; the keypad map is keyed by digit.
          const digit = TONE_DIGITS[event.data?.tone] ?? event.data?.tone;
          if (digit != null) flow.dtmf(callId, String(digit));
          break;
        }

        case "MediaStreamingFailed": {
          // Without the reason this reads as "it broke", which is how a socket
          // that never connected can look like a Voice Live problem.
          const info = event.data?.resultInformation ?? {};
          log("[call] media streaming failed", `code=${info.code} sub=${info.subCode}`, info.message ?? "");
          break;
        }

        case "CallTransferAccepted":
          log("[call] transfer accepted", callId);
          break;

        case "CallTransferFailed": {
          // ACS accepted the transfer, then the queue never picked up. The flow
          // owns the retry ladder and its attempt count, so re-enter it rather
          // than retrying here, which would loop on a target that always fails.
          const message = event.data?.resultInformation?.message ?? "transfer failed";
          log("[call] transfer failed", message);
          await flow.transferFailed(callId, message).catch((e) => log("[call] recovery failed", e.message));
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

const TONE_DIGITS = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

// ------------------------------------------------------------------ simulation

/**
 * The offline demo. A typed transcript drives the same state machine, the same
 * confidence gate, the same business hours and the same handoff assembly as a
 * real call — only the classifier and the audio path are stubbed. A simulated
 * call is never transferred for real, even on a server that answers real calls.
 */
app.post(
  "/api/simulate",
  asyncRoute(async (req, res) => {
    const fromPhone = req.body?.fromPhone ? normalisePhone(req.body.fromPhone) : null;
    const call = flow.create({ fromPhone, simulated: true });
    registerSimulatedAgent(flow, call.id);
    flow.answered(call.id);
    res.json({ ok: true, callId: call.id, snapshot: flow.snapshot(call.id) });
  }),
);

app.post(
  "/api/simulate/:id/say",
  asyncRoute(async (req, res) => {
    if (!flow.get(req.params.id)) return res.status(404).json({ error: "unknown call" });
    const result = handleUtterance(flow, req.params.id, req.body?.text ?? "");
    await flow.settled(req.params.id);
    res.json({ ok: true, result, snapshot: flow.snapshot(req.params.id) });
  }),
);

app.post(
  "/api/simulate/:id/dtmf",
  asyncRoute(async (req, res) => {
    if (!flow.get(req.params.id)) return res.status(404).json({ error: "unknown call" });
    const result = flow.dtmf(req.params.id, String(req.body?.digit ?? ""));
    await flow.settled(req.params.id);
    res.json({ ok: true, result, snapshot: flow.snapshot(req.params.id) });
  }),
);

app.post(
  "/api/simulate/:id/silence",
  asyncRoute(async (req, res) => {
    if (!flow.get(req.params.id)) return res.status(404).json({ error: "unknown call" });
    const result = flow.noInput(req.params.id);
    await flow.settled(req.params.id);
    res.json({ ok: true, result, snapshot: flow.snapshot(req.params.id) });
  }),
);

app.post(
  "/api/simulate/:id/hangup",
  asyncRoute(async (req, res) => {
    flow.endCall(req.params.id, "caller_hung_up");
    await hangUp(flow.get(req.params.id)?.callConnectionId);
    res.json({ ok: true, snapshot: flow.snapshot(req.params.id) });
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
  timeZone: routes.timeZone,
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
  log(`[clock] demo clock → ${clockPreset} (${new Date(now()).toISOString()})`);
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

app.get("/api/routes", (_req, res) => {
  const at = new Date(now());
  res.json({
    organization: routes.organization,
    fallbackRouteId: routes.fallbackRouteId,
    timeZone: routes.timeZone,
    // Targets are deliberately withheld: the console has no business knowing
    // Teams object ids, and neither does anything else outside routes.json.
    // Open or closed is judged on the demo clock — the time the policy routes on.
    routes: routes.menu().map((r) => ({ ...r, open: routes.isOpen(r.id, at), ...routes.describeHours(r.id) })),
  });
});

app.get("/api/calls/:id", (req, res) => {
  const snap = flow.snapshot(req.params.id);
  return snap ? res.json(snap) : res.status(404).json({ error: "unknown call" });
});

app.get("/api/calls/:id/events", (req, res) => res.json(audit.eventsFor(req.params.id)));

app.get("/api/stats", (_req, res) => res.json(audit.stats()));

app.post("/api/negotiate", (req, res) => res.json(hub.negotiate(req.body?.callId ?? "*")));

app.get("/health", (_req, res) => {
  const missing = assertCallConfig();
  const ready = readiness(routes);
  res.json({
    ok: true,
    mode: missing.length === 0 ? "live" : "simulation",
    callReady: missing.length === 0,
    missingConfig: missing,
    ...ready,
    audit: { store: audit.name, persistTranscripts: config.persistTranscripts },
    realtime: hub.transport,
    routing: {
      routes: routes.ids,
      confidenceThreshold: config.routing.confidenceThreshold,
      timeBudgetMs: config.routing.timeBudgetMs,
      maxClarifications: config.routing.maxClarifications,
      transferDelayMs: flow.options.transferDelayMs,
    },
    clock: { preset: clockPreset, now: new Date(now()).toISOString() },
  });
});

// ----------------------------------------------------------------------- start

const server = createServer(app);

// One upgrade listener, routed by pathname. See attachMediaBridge for why this
// cannot be left to `new WebSocketServer({ server, path })`.
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
  log(`Intent-based call routing demo on http://${config.host}:${config.port}`);
  log(`  organization       : ${routes.organization}`);
  log(`  routes             : ${routes.ids.join(", ")} (fallback: ${routes.fallbackRouteId})`);
  log(`  audit              : ${audit.name}${config.persistTranscripts ? " (transcripts persisted)" : ""}`);
  log(`  confidence gate    : ${config.routing.confidenceThreshold}`);
  log(`  route time budget  : ${config.routing.timeBudgetMs / 1000}s`);

  const missing = assertCallConfig();
  if (missing.length) {
    log(`  SIMULATION MODE    — set ${missing.join(", ")} to answer real calls`);
    if (clockPreset !== "real") log(`  demo clock         : ${new Date(now()).toISOString()} (${clockPreset})`);
  } else {
    log(`  voice model        : ${config.voiceLive.model} (WebSocket ${config.voiceLive.apiVersion})`);
    log(`  public base URL    : ${config.publicBaseUrl}`);
  }
});
