import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CLOCK_PRESETS, assertCallConfig, config, isSimulated, readiness } from "./config.mjs";
import { ScheduleAdapter } from "./schedule-store.mjs";
import { isMemoryPath } from "./sqlite.mjs";
import { SchedulingRoutes } from "./routes.mjs";
import { MemoryAudit } from "./audit.mjs";
import { SchedulingFlow } from "./flow.mjs";
import { dispatchTool } from "./tools.mjs";
import { createHub } from "./realtime.mjs";
import { handleUtterance, registerSimulatedAgent } from "./offline.mjs";
import { attachMediaBridge, activeBridges } from "./voice/call-bridge.mjs";
import { answerInboundCall, transferToTeams, startDtmfRecognition, hangUp } from "./voice/acs.mjs";
import { resourceAccountFrom } from "./handoff.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const routes = new SchedulingRoutes();
const hub = createHub();
const TIME_ZONE = routes.get("scheduling_team")?.hours?.timeZone ?? "America/Los_Angeles";

// ------------------------------------------------------------------ demo clock

/**
 * The clock the schedule and the flow see. Openings, lead times, "today" and
 * whether a Teams queue is staffed all depend on it. In simulation it starts
 * at DEMO_NOW (Tuesday 9:50 AM unless set), so every run offers the same
 * times, and the console can move it. A server answering real calls always
 * schedules on the real time.
 */
function startingClock() {
  if (!isSimulated()) {
    if (config.demoNowSet && config.demoNow) log("[clock] DEMO_NOW is ignored while answering real calls");
    return { at: null, preset: "real" };
  }
  if (!config.demoNow) return { at: null, preset: "real" };
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

// -------------------------------------------------------------------- stores

/**
 * The schedule. In simulation it is a fresh in-memory copy of the seeded
 * fixtures unless SCHEDULE_DB_PATH names a file, so every run starts from the
 * same day and a simulated booking never lands in a file real calls use. A
 * server answering real calls uses the file (data/schedule.db by default).
 */
const scheduleDbPath = (process.env.SCHEDULE_DB_PATH || !isSimulated()) ? config.schedule.dbPath : ":memory:";
const scheduleIsDemoCopy = isMemoryPath(scheduleDbPath);
const schedule = await ScheduleAdapter.open({ dbPath: scheduleDbPath, now: () => new Date(now()), log });

/**
 * SQLite is loaded only when it is actually going to be used. better-sqlite3 is
 * a native module, so if it cannot load the audit falls back to node:sqlite,
 * and failing that to memory, with one log line rather than a crash.
 */
async function createAudit() {
  try {
    const { SqliteAudit } = await import("./db.mjs");
    return await SqliteAudit.open(config.dbPath);
  } catch (e) {
    log(`[audit] falling back to the in-memory audit: ${e.message}`);
    return new MemoryAudit();
  }
}

const audit = await createAudit();

/** The real transfer. Absent in simulation, which is what makes the flow stub it out. */
const transfer = isSimulated()
  ? null
  : async (call, destination) =>
      transferToTeams({
        callConnectionId: call.callConnectionId,
        target: destination.target,
        type: destination.type,
        context: destination.context,
        callId: call.id,
      });

// Handoff frames already carry the VoIP headers, built by the same function
// the live transfer sends (src/handoff.mjs), so the console shows the wire.
const flow = new SchedulingFlow({ schedule, routes, audit, transfer, hub, now });

/**
 * Move the demo clock. Calls in progress shift by the same jump, so moving to
 * Friday evening mid-call does not blow that call's time budget.
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
      await onIncomingCall(event.data).catch((e) => log("[eventgrid] answer failed", e));
    }
  }),
);

async function onIncomingCall(data) {
  const raw = data?.from?.rawId ?? "";
  const fromPhone = data?.from?.phoneNumber?.value ?? (raw.startsWith("4:") ? raw.slice(2) : null);
  const voip = data?.customContext?.voipHeaders ?? {};

  const call = flow.create({
    callId: randomUUID(),
    fromPhone,
    incomingCallContext: data.incomingCallContext,
    resourceAccountId: resourceAccountFrom(data?.to),
    // Preserve an Auto Attendant's session id when this line sits behind one, so
    // the whole journey correlates in Teams rather than restarting here.
    sessionId: voip["CallDetails.SessionId"] ?? data.correlationId ?? null,
    // A call the reminder agent transferred here. Only the one-time token in it
    // can stand in for name and date of birth, and the flow checks that.
    handoff: reminderHandoff(voip["CallDetails.CallContext"]),
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

/** The CallContext header, when it is the reminder agent's handoff rather than some other app's context. */
function reminderHandoff(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && (parsed.patientRef || parsed.handoffToken || parsed.token || parsed.appointmentId) ? parsed : null;
  } catch {
    return null;
  }
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
          await startDtmfRecognition({
            callConnectionId: event.data?.callConnectionId,
            fromPhone: flow.get(callId)?.fromPhone,
          });
          break;

        case "ContinuousDtmfRecognitionToneReceived": {
          // ACS reports the tone by name; the flow's keypad map is keyed by digit.
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
  pound: "#",
  asterisk: "*",
};

// ------------------------------------------------------------------ simulation

/**
 * The offline demo. A typed transcript drives the same server gate, the same
 * holds, the same caller's-yes write and the same handoff assembly as a real
 * call — only the model and the audio path are stubbed. A simulated call is
 * never transferred for real.
 *
 * A simulated booking writes to the schedule, so on a server answering real
 * calls simulated calls are off: they would land in the live schedule.
 */
app.post("/api/simulate", (req, res) => {
  if (!isSimulated()) {
    return res.status(403).json({ error: "Simulated calls are off while this server answers real calls: their bookings would land in the live schedule." });
  }
  const call = flow.create({ fromPhone: cleanPhone(req.body?.fromPhone), simulated: true });
  registerSimulatedAgent(flow, call.id);
  flow.answered(call.id);
  res.json({ ok: true, callId: call.id, snapshot: flow.snapshot(call.id) });
});

/** The caller controls drive simulated calls only. A real call can be watched, never spoken for. */
function simulatedCall(req, res) {
  const call = flow.get(req.params.id);
  if (!call) {
    res.status(404).json({ error: "unknown call" });
    return null;
  }
  if (!call.simulated) {
    res.status(403).json({ error: "That is a real phone call. The console can watch it but not speak for the caller." });
    return null;
  }
  return call;
}

app.post(
  "/api/simulate/:id/say",
  asyncRoute(async (req, res) => {
    if (!simulatedCall(req, res)) return;
    const result = handleUtterance(flow, req.params.id, req.body?.text ?? "");
    await flow.settled(req.params.id);
    res.json({ ok: true, result, snapshot: flow.snapshot(req.params.id) });
  }),
);

app.post(
  "/api/simulate/:id/dtmf",
  asyncRoute(async (req, res) => {
    if (!simulatedCall(req, res)) return;
    const result = flow.dtmf(req.params.id, String(req.body?.digit ?? ""));
    await flow.settled(req.params.id);
    res.json({ ok: true, result, snapshot: flow.snapshot(req.params.id) });
  }),
);

app.post(
  "/api/simulate/:id/silence",
  asyncRoute(async (req, res) => {
    if (!simulatedCall(req, res)) return;
    const result = flow.noInput(req.params.id);
    await flow.settled(req.params.id);
    res.json({ ok: true, result, snapshot: flow.snapshot(req.params.id) });
  }),
);

app.post(
  "/api/simulate/:id/hangup",
  asyncRoute(async (req, res) => {
    if (!simulatedCall(req, res)) return;
    const result = flow.endCall(req.params.id, "caller_hung_up");
    await hangUp(flow.get(req.params.id)?.callConnectionId);
    res.json({ ok: true, result, snapshot: flow.snapshot(req.params.id) });
  }),
);

function cleanPhone(value) {
  const phone = String(value ?? "").replace(/[^\d+]/g, "").slice(0, 16);
  return phone.replace(/\D/g, "").length >= 7 ? phone : null;
}

// ----------------------------------------------------------------- demo controls

/** Demo controls refuse to touch a server that is answering real calls. */
function simulationOnly(res) {
  if (isSimulated()) return true;
  res.status(403).json({ error: "Demo controls are off while this server answers real calls." });
  return false;
}

const clockView = () => ({
  now: new Date(now()).toISOString(),
  timeZone: TIME_ZONE,
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
 * in the audit (calls from a real phone are kept), the seeded schedule back
 * (when it is the in-memory demo copy) and the starting clock.
 */
app.post("/api/demo/reset", (_req, res) => {
  if (!simulationOnly(res)) return;
  for (const id of flow.calls.keys()) hub.forget(id);
  flow.reset();
  audit.reset();
  if (scheduleIsDemoCopy) schedule.reseed();
  else log("[demo] the schedule was kept: SCHEDULE_DB_PATH points at a file that may hold real bookings");
  setClock(STARTING_CLOCK.at, STARTING_CLOCK.preset);
  log("[demo] reset");
  res.json({ ok: true, clock: clockView(), stats: statsView(), scheduleReseeded: scheduleIsDemoCopy });
});

const TAKE_SLOT_ERRORS = {
  nothing_to_take: "Nothing to take yet. Wait until a time has been offered or read back.",
  call_finished: "That call has finished.",
  slot_taken: "That time is already booked.",
};

/**
 * Demo only: the front desk books the time this caller is about to accept,
 * so the race can be shown on cue. The caller is not told; it surfaces when
 * they say yes and the server refuses to write.
 */
app.post("/api/demo/take-slot", (req, res) => {
  if (!simulationOnly(res)) return;
  const callId = req.body?.callId;
  if (!flow.get(callId)) return res.status(404).json({ error: "unknown call" });
  const result = flow.takeSlotForDemo(callId);
  if (!result.ok) {
    return res.status(409).json({ ...result, code: result.error, error: TAKE_SLOT_ERRORS[result.error] ?? result.error, snapshot: flow.snapshot(callId) });
  }
  res.json({ ...result, snapshot: flow.snapshot(callId) });
});

/**
 * Demo only: the model reaches for a tool through the same dispatcher a live
 * call uses (src/tools.mjs), to show on stage what the server does with it.
 * The model has no booking tool, so "book" comes back refused, the refusal is
 * on the decision trail, and nothing is written.
 */
app.post("/api/demo/tool", (req, res) => {
  if (!simulationOnly(res)) return;
  const { callId, name, args } = req.body ?? {};
  if (!flow.get(callId)) return res.status(404).json({ error: "unknown call" });
  if (typeof name !== "string" || !name) return res.status(400).json({ error: "Send { callId, name, args? }." });
  const result = dispatchTool(flow, callId, name, args && typeof args === "object" ? args : {});
  res.json({ ok: true, result, snapshot: flow.snapshot(callId) });
});

// ------------------------------------------------------------------ console API

/** One provider's next days in 15-minute cells: free, booked, held, break, past or closed. Never who. */
app.get("/api/schedule/grid", (req, res) => {
  const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 5, 1), 10);
  const grid = schedule.grid({ providerId: String(req.query.provider ?? "prov-patel"), days });
  return grid.ok ? res.json(grid) : res.status(404).json({ error: grid.error });
});

app.get("/api/calls/:id", (req, res) => {
  const snap = flow.snapshot(req.params.id);
  return snap ? res.json(snap) : res.status(404).json({ error: "unknown call" });
});

app.get("/api/calls/:id/events", (req, res) => res.json(audit.eventsFor(req.params.id)));

const statsView = () => ({ ...audit.stats(), schedule: schedule.stats() });

app.get("/api/stats", (_req, res) => res.json(statsView()));

app.post("/api/negotiate", (req, res) => res.json(hub.negotiate(req.body?.callId ?? "*")));

app.get("/health", (_req, res) => {
  const missing = assertCallConfig();
  const ready = readiness();
  res.json({
    ok: true,
    mode: missing.length === 0 ? "live" : "simulation",
    callReady: missing.length === 0,
    missingConfig: missing,
    ...ready,
    schedule: {
      ...ready.schedule,
      dbPath: scheduleIsDemoCopy ? ":memory: (a fresh copy of the seeded schedule)" : scheduleDbPath,
      driver: schedule.driver,
      reseededByReset: scheduleIsDemoCopy,
    },
    audit: { store: audit.name, persistTranscripts: config.persistTranscripts },
    realtime: hub.transport,
    scheduling: {
      optionsPerTurn: flow.options.optionsPerTurn,
      holdTtlMs: flow.options.holdTtlMs,
      minLeadMinutes: config.schedule.minLeadMinutes,
      callTimeBudgetMs: flow.options.callTimeBudgetMs,
      transferDelayMs: flow.options.transferDelayMs,
      locale: flow.options.locale,
    },
    clock: { preset: clockPreset, now: new Date(now()).toISOString() },
  });
});

// ----------------------------------------------------------------------- start

// Past the time budget a person takes over. Real calls only: a simulated call
// left open on stage is not suddenly transferred mid-sentence.
setInterval(() => {
  for (const call of flow.calls.values()) {
    if (!call.simulated) flow.checkBudget(call.id);
  }
}, 5_000).unref();

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

server.on("error", (e) => {
  log(e.code === "EADDRINUSE" ? `[server] port ${config.port} is already in use; set PORT to a free port` : `[server] ${e.message}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  log(`Appointment scheduling demo on http://${config.host}:${config.port}`);
  log(`  schedule           : ${scheduleIsDemoCopy ? "in-memory copy of the seeded schedule" : scheduleDbPath} (${schedule.driver})`);
  log(`  audit              : ${audit.name}${config.persistTranscripts ? " (transcripts persisted)" : ""}`);
  log(`  offers             : ${flow.options.optionsPerTurn} per turn · held ${Math.round(flow.options.holdTtlMs / 1000)}s · ${config.schedule.minLeadMinutes} min lead time`);
  log(`  call time budget   : ${Math.round(flow.options.callTimeBudgetMs / 1000)}s`);

  const missing = assertCallConfig();
  if (missing.length) {
    log(`  SIMULATION MODE    — set ${missing.join(", ")} to answer real calls`);
    log(`  demo clock         : ${clockPreset === "real" ? "real time" : `${new Date(now()).toISOString()} (${clockPreset})`}`);
  } else {
    log(`  voice model        : ${config.voiceLive.model} (WebSocket ${config.voiceLive.apiVersion})`);
    log(`  public base URL    : ${config.publicBaseUrl}`);
  }
});
