import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config, fixtures, readiness, isSimulated, assertCallConfig } from "./config.mjs";
import { ScheduleAdapter } from "./schedule-store.mjs";
import { MemoryAudit } from "./audit.mjs";
import { AppointmentReminderFlow, handleUtterance, formatShort, timeZoneOf, maskName } from "./flow.mjs";
import { createHub } from "./realtime.mjs";
import { runOfflineReminder, dialGreeting } from "./offline.mjs";
import { attachMediaBridge, activeBridges } from "./voice/call-bridge.mjs";
import { answerInboundCall, createOutboundCall, startDtmfRecognition, hangUp, transferCall } from "./voice/acs.mjs";
import { resourceAccountFrom, buildCustomCallingContext } from "./handoff.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ------------------------------------------------------------------ demo clock

/**
 * The clock every reminder decision reads: the 48-hour reminder window, the
 * 24-hour cutoff, calling hours, attempt spacing and the nurse line's hours.
 * In simulation it starts at DEMO_NOW (two days before the seeded appointments
 * unless you set it), and the console can move it. A server placing real calls
 * always decides on the real time.
 */
const CLOCK_TIME_ZONE = "America/Los_Angeles";
const CLOCK_PRESETS = [
  { id: "two-days-before", label: "2 days before · 10:00 AM", at: "2026-05-19T10:00:00-07:00" },
  { id: "day-before", label: "Day before · 10:00 AM", at: "2026-05-20T10:00:00-07:00" },
  { id: "too-late", label: "Too late to call · 8:30 PM", at: "2026-05-19T20:30:00-07:00" },
  { id: "real", label: "Real time", at: null },
];

function startingClock() {
  if (!isSimulated()) {
    if (process.env.DEMO_NOW) log("[clock] DEMO_NOW is ignored while this server places real calls");
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
const now = () => new Date(Date.now() + clockOffsetMs);

// ------------------------------------------------------- schedule, audit, flow

/** better-sqlite3 when it loads; otherwise an in-memory copy of the seed, with one log line. */
const schedule = await ScheduleAdapter.open({ now, log });

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
const hub = createHub();
let callsInFlight = 0;

/**
 * Handoff frames carry the VoIP headers the transfer actually sends, built by
 * the same function the transfer uses rather than a console-side copy.
 */
const flowHub = {
  send: (callId, target, payload) =>
    hub.send(callId, target, target === "handoff" && !payload?.voipHeaders ? { ...payload, voipHeaders: buildCustomCallingContext(payload) } : payload),
};

/** The real transfer. Absent in simulation, and the flow never transfers a simulated call. */
const transfer = isSimulated()
  ? null
  : async (call, handoff) =>
      transferCall({
        callConnectionId: call.callConnectionId,
        target: handoff.target,
        context: { sessionId: call.sessionId, callTopic: handoff.callTopic, callContext: handoff.callContext },
        callId: call.id,
      });

const flow = new AppointmentReminderFlow({ schedule, audit, transfer, hub: flowHub, now });

/** Move the demo clock; calls in progress shift with it so their time budget stays sane. */
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
// ------------------------------------------------------------------ simulation

const DIAL_OUTCOMES = ["answered", "voicemail", "busy", "no_answer", "bad_number"];

/**
 * Simulated calls write to the schedule (confirm, cancel, reschedule request,
 * opt-out), so they and the demo controls are off on a server placing real calls.
 */
function simulationOnly(res, what = "Demo controls are") {
  if (isSimulated()) return true;
  res.status(403).json({ error: `${what} off while this server places real calls.` });
  return false;
}

/** Typed lines, keypad and silence drive simulated calls only, never a real patient's call. */
function simulatedCall(req, res) {
  const call = flow.get(req.params.id);
  if (!call) {
    res.status(404).json({ error: "unknown call" });
    return null;
  }
  if (!call.simulated) {
    res.status(403).json({ error: "This is a real call; typed lines only drive simulated calls." });
    return null;
  }
  return call;
}

/**
 * The console's "Place the call". Every dial gate runs first (consent, opt-out,
 * TTY, calling hours, reminder window, cutoff, attempts, spacing). A refused
 * call is recorded with the reason and the next allowed time, and nothing is
 * dialed. Otherwise the simulated phone answers, or voicemail picks up.
 */
app.post(
  "/api/simulate",
  asyncRoute(async (req, res) => {
    if (!simulationOnly(res, "Simulated reminder calls are")) return;
    const appointmentId = String(req.body?.appointmentId ?? "A-20418");
    const outcome = String(req.body?.outcome ?? "answered");
    if (!DIAL_OUTCOMES.includes(outcome)) return res.status(400).json({ error: `outcome must be one of ${DIAL_OUTCOMES.join(", ")}` });
    const appointment = schedule.getAppointment(appointmentId);
    if (!appointment) return res.status(404).json({ error: `unknown appointment ${appointmentId}` });
    const placed = flow.placeSimulatedCall({
      appointmentId,
      language: req.body?.language ?? null,
      attempt: req.body?.attempt ?? null,
      outcome,
      greeting: dialGreeting(outcome, appointment.patient?.firstName),
    });
    const snapshot = await flow.settled(placed.callId);
    res.json({
      ok: true,
      callId: placed.callId,
      refused: placed.refused,
      reason: placed.refused ? placed.gate.reason : null,
      why: snapshot?.why ?? null,
      nextAllowedAt: snapshot?.nextAllowedAt ?? null,
      snapshot,
    });
  }),
);

app.post(
  "/api/simulate/:id/say",
  asyncRoute(async (req, res) => {
    if (!simulatedCall(req, res)) return;
    const result = handleUtterance(flow, req.params.id, req.body?.text ?? "");
    res.json({ ok: true, result, snapshot: await flow.settled(req.params.id) });
  }),
);

app.post(
  "/api/simulate/:id/dtmf",
  asyncRoute(async (req, res) => {
    if (!simulatedCall(req, res)) return;
    // One key per press from the console keypad, or a run such as "03121984" for a keyed date of birth.
    const keys = String(req.body?.digit ?? req.body?.digits ?? "").replace(/[^0-9*#]/g, "");
    if (!keys) return res.status(400).json({ error: "Send { digit } with 0-9, * or #." });
    let result;
    for (const key of keys) result = flow.dtmf(req.params.id, key);
    res.json({ ok: true, result, snapshot: await flow.settled(req.params.id) });
  }),
);

app.post(
  "/api/simulate/:id/silence",
  asyncRoute(async (req, res) => {
    if (!simulatedCall(req, res)) return;
    const result = flow.noInput(req.params.id);
    res.json({ ok: true, result, snapshot: await flow.settled(req.params.id) });
  }),
);

app.post(
  "/api/simulate/:id/hangup",
  asyncRoute(async (req, res) => {
    const call = flow.get(req.params.id);
    if (!call) return res.status(404).json({ error: "unknown call" });
    const result = flow.endCall(req.params.id, "caller_hung_up");
    if (!call.simulated) await hangUp(call.callConnectionId);
    res.json({ ok: true, result, snapshot: await flow.settled(req.params.id) });
  }),
);

// ----------------------------------------------------------------- demo controls

const clockView = () => ({
  now: now().toISOString(),
  timeZone: CLOCK_TIME_ZONE,
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
  log(`[clock] demo clock → ${clockPreset} (${now().toISOString()})`);
  res.json(clockView());
});

/**
 * A clean stage between run-throughs: no calls in memory, no simulated calls in
 * the audit (calls from a real phone are kept), the seeded demo schedule back
 * (statuses, released slots, attempts, reschedule requests, opt-outs), and the
 * starting clock. Every run then starts identical.
 */
app.post("/api/demo/reset", (_req, res) => {
  if (!simulationOnly(res)) return;
  for (const id of flow.reset()) hub.forget(id);
  const forgotten = audit.reset();
  schedule.reseed();
  setClock(STARTING_CLOCK.at, STARTING_CLOCK.preset);
  log(`[demo] reset: ${forgotten} simulated call(s) forgotten, schedule reseeded`);
  res.json({ ok: true, clock: clockView(), stats: statsView() });
});

/** Each scripted beat puts its own appointments back to the seed, so beats run in any order. */
app.post("/api/demo/restore", (req, res) => {
  if (!simulationOnly(res)) return;
  const ids = Array.isArray(req.body?.appointmentIds) ? req.body.appointmentIds.map(String) : [];
  if (!ids.length) return res.status(400).json({ error: "Send { appointmentIds: [...] }." });
  const restored = ids.map((appointmentId) => ({ appointmentId, ok: schedule.restoreAppointment(appointmentId).ok }));
  const unknown = restored.find((r) => !r.ok);
  if (unknown) return res.status(404).json({ error: `unknown appointment ${unknown.appointmentId}`, restored });
  res.json({ ok: true, restored, board: flow.board({ appointmentIds: ids }) });
});
// ------------------------------------------------------------------ console API

/** The schedule panel's default rows: the four patients the scripted beats call. */
const DEMO_APPOINTMENTS = ["A-20418", "A-20419", "A-20423", "A-20424"];

function slotView(slot) {
  const appointment = schedule.getAppointment(slot.appointmentId);
  const row = appointment ? flow.describe(appointment) : null;
  return {
    appointmentId: slot.appointmentId,
    provider: row?.provider ?? slot.providerId,
    department: row?.department ?? null,
    location: row?.location ?? slot.location,
    timeZone: row?.timeZone ?? CLOCK_TIME_ZONE,
    start: slot.start,
    end: slot.end,
    localTime: row ? formatShort(slot.start, row.timeZone) : slot.start,
    reason: slot.reason,
    releasedAt: slot.releasedAt,
  };
}

/**
 * The schedule as the clinic sees it, judged on the demo clock: the beat rows,
 * every upcoming appointment for the picker (with whether it may be called right
 * now and why), freed slots and reschedule requests. Never a date of birth or phone.
 */
app.get("/api/schedule", (req, res) => {
  const at = now();
  const ids = String(req.query.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  res.json({
    now: at.toISOString(),
    timeZone: CLOCK_TIME_ZONE,
    board: flow.board({ now: at, appointmentIds: ids.length ? ids : DEMO_APPOINTMENTS }),
    appointments: schedule.listUpcoming({ from: at.toISOString(), statuses: null }).map((a) => flow.describe(a, { now: at })),
    releasedSlots: schedule.releasedSlots().map(slotView),
    rescheduleRequests: schedule.rescheduleRequests().map((r) => ({
      appointmentId: r.appointmentId,
      patient: maskName(schedule.getPatient(r.patientId)),
      status: r.status,
      createdAt: r.createdAt,
    })),
  });
});

/** The metrics strip: what the calls achieved, plus what they changed in the schedule. */
function statsView() {
  const booked = schedule.stats(now());
  return {
    ...audit.stats(),
    slotsReleased: booked.releasedSlots,
    rescheduleRequests: booked.rescheduleRequests,
    optOuts: booked.optOuts,
    appointments: booked.appointments,
    byStatus: booked.byStatus,
  };
}

app.get("/api/stats", (_req, res) => res.json(statsView()));

app.get("/api/calls/:id", (req, res) => {
  const snap = flow.snapshot(req.params.id);
  return snap ? res.json(snap) : res.status(404).json({ error: "unknown call" });
});

app.get("/api/calls/:id/events", (req, res) => res.json(audit.eventsFor(req.params.id)));

app.post("/api/negotiate", (req, res) => res.json(hub.negotiate(req.body?.callId ?? "*")));

/** Tonight's dial plan on the demo clock: who is due, and why anyone is skipped. Nothing is dialed. */
app.get("/api/campaign/dry-run", (_req, res) => res.json({ now: now().toISOString(), dialPlan: flow.buildDialPlan({ dryRun: true }) }));

/**
 * Real dialing needs all three: CAMPAIGN_ENABLED=true, CAMPAIGN_DRY_RUN=false,
 * and a server configured for real calls. Anything less returns the dial plan
 * and dials nobody.
 */
app.post(
  "/api/campaign/run",
  asyncRoute(async (_req, res) => {
    const dialing = config.campaign.enabled && !config.campaign.dryRun && !isSimulated();
    const dialPlan = flow.buildDialPlan({ dryRun: !dialing });
    const launched = [];
    if (dialing) {
      for (const row of dialPlan.filter((r) => r.state === "scheduled")) {
        // Checked again right before each dial, with no await in between: a run that
        // overlapped this one may have taken the last slot or already be calling this patient.
        if (callsInFlight >= config.campaign.maxConcurrent) break;
        const appointment = schedule.getAppointment(row.appointmentId);
        if (!appointment || !flow.evaluateDialEligibility(appointment, { dryRun: false }).ok) continue;
        const call = flow.create({ appointmentId: row.appointmentId });
        callsInFlight += 1;
        try {
          const { callConnectionId } = await createOutboundCall({ to: call.appointment.patient.phones?.[0]?.number, callId: call.id });
          call.callConnectionId = callConnectionId;
          launched.push(call.id);
        } catch (e) {
          log("[campaign] dial failed", call.id, e.message);
          callsInFlight = Math.max(0, callsInFlight - 1);
          flow.endCall(call.id, "create_call_failed");
        }
      }
    }
    res.json({ dryRun: !dialing, dialPlan, launched });
  }),
);

/** The offline harness on the current demo clock: an isolated in-memory schedule, never this server's. */
app.post("/api/offline-run", asyncRoute(async (req, res) => res.json(await runOfflineReminder({ at: now().toISOString(), ...(req.body ?? {}) }))));

app.get("/health", (_req, res) => {
  const missing = assertCallConfig();
  res.json({
    ...readiness(),
    ok: true,
    mode: missing.length === 0 ? "live" : "simulation",
    callReady: missing.length === 0,
    missingConfig: missing,
    demoNow: clockPreset === "real" ? null : now().toISOString(),
    callsInFlight,
    realtime: hub.transport,
    audit: { store: audit.name, transcriptsPersisted: config.retention.transcripts },
    schedule: { driver: schedule.driver, inMemory: schedule.inMemory },
    clock: { preset: clockPreset, now: now().toISOString(), timeZone: CLOCK_TIME_ZONE },
  });
});
// ------------------------------------------------------------- Event Grid intake

/** Event Grid delivers the same event more than once by design. */
const seenEvents = new Set();

/**
 * Patients calling back the reminder number arrive as an Event Grid
 * `IncomingCall` event. The first request Event Grid ever sends is a validation
 * handshake, so that is answered before anything else.
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

/** A callback is answered only when the number matches a patient with an upcoming appointment. */
async function onIncomingCall(data) {
  const fromPhone = data?.from?.rawId?.replace(/^4:/, "") ?? data?.from?.phoneNumber?.value ?? null;
  const appointment = schedule.listUpcoming().find((a) => a.patient?.phones?.some((p) => p.number === fromPhone));
  if (!appointment) return log("[call] callback from a number with no upcoming appointment; not answered");
  const call = flow.create({
    appointmentId: appointment.appointmentId,
    direction: "inbound",
    // Keep an Auto Attendant's session id when this number sits behind one, so the journey correlates in Teams.
    sessionId: data.customContext?.voipHeaders?.["CallDetails.SessionId"] ?? data.correlationId ?? randomUUID(),
  });
  call.resourceAccountId = resourceAccountFrom(data?.to);
  log("[call] callback", call.id, "about", appointment.appointmentId);
  const { callConnectionId } = await answerInboundCall({ incomingCallContext: data.incomingCallContext, callId: call.id });
  call.callConnectionId = callConnectionId;
}

// --------------------------------------------------------------- ACS callbacks

app.post(
  "/api/calls/callback",
  asyncRoute(async (req, res) => {
    res.sendStatus(200);
    const callId = req.query.call;
    for (const event of req.body ?? []) {
      const type = event.type?.split(".").pop();
      const call = flow.get(callId);
      log("[acs]", type, callId);
      switch (type) {
        case "CallConnected":
          if (!call) break;
          call.callConnectionId = event.data?.callConnectionId ?? call.callConnectionId;
          await startDtmfRecognition({ callConnectionId: call.callConnectionId, fromPhone: call.appointment.patient.phones?.[0]?.number });
          break;
        case "ContinuousDtmfRecognitionToneReceived": {
          // ACS reports the tone by name; the keypad menu is keyed by digit.
          const digit = TONE_DIGITS[event.data?.tone] ?? event.data?.tone;
          if (call && digit != null) flow.dtmf(callId, String(digit));
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
          // ACS accepted the transfer, then nobody at the queue picked up; the patient is
          // still on the line. The flow closes the call honestly instead of sending the
          // transfer again, which would loop for as long as the queue kept failing.
          const message = event.data?.resultInformation?.message ?? "transfer failed";
          log("[call] transfer failed", callId, message);
          const recovery = flow.transferFailed(callId, message);
          if (!recovery.recovered) log("[call] transfer failure ignored:", recovery.reason);
          break;
        }
        case "CallDisconnected":
          // An outbound call nobody picked up is a no-answer: the flow schedules the retry.
          if (call?.direction === "outbound" && !call.answeredAt) flow.applyDialOutcome(callId, "no_answer");
          else flow.endCall(callId, "caller_hung_up");
          activeBridges.get(callId)?.stop();
          if (call?.direction === "outbound") callsInFlight = Math.max(0, callsInFlight - 1);
          break;
        case "CreateCallFailed":
          flow.endCall(callId, "create_call_failed");
          callsInFlight = Math.max(0, callsInFlight - 1);
          break;
      }
    }
  }),
);

const TONE_DIGITS = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", asterisk: "*", pound: "#" };

// ----------------------------------------------------------------------- start

const server = createServer(app);

// One upgrade listener, routed by pathname: two WebSocketServers on one HTTP
// server abort each other's handshakes.
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
  log(e.code === "EADDRINUSE" ? `[server] port ${config.port} is already in use` : `[server] ${e.message}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const { callingWindow, leadTimeHours, cutoffHoursBeforeAppointment, maxAttempts } = fixtures.campaign;
  log(`Appointment reminder demo on http://${config.host}:${config.port}`);
  log(`  schedule           : ${schedule.driver}${schedule.inMemory ? " (in memory)" : ""}`);
  log(`  audit              : ${audit.name}${config.retention.transcripts ? " (masked transcripts kept)" : ""}`);
  log(`  reminder policy    : ${leadTimeHours} h ahead, stop ${cutoffHoursBeforeAppointment} h before, ${maxAttempts} attempts, calls ${callingWindow.start}–${callingWindow.end} patient time`);
  log(`  scheduling desk    : ${flow.options.schedulingAgentTarget ? "configured" : "not set (real reschedule requests become callbacks)"}`);
  const missing = assertCallConfig();
  if (missing.length) {
    log(`  SIMULATION MODE    — set ${missing.join(", ")} to place real calls`);
    if (clockPreset !== "real") log(`  demo clock         : ${now().toISOString()} (${clockPreset})`);
  } else {
    log(`  voice model        : ${config.voiceLive.model} (WebSocket ${config.voiceLive.apiVersion})`);
    log(`  public base URL    : ${config.publicBaseUrl}`);
    log(`  campaign           : ${config.campaign.enabled ? (config.campaign.dryRun ? "enabled, dry run" : "enabled, dialing") : "off"}`);
  }
});
