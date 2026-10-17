import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { config, assertCallConfig, isSimulated, readiness } from "./config.mjs";
import { HoursPolicy, Catalog, RepRoster, QualificationPolicy, clockLabel, normalisePhone } from "./policy.mjs";
import { MemoryLeadStore } from "./db.mjs";
import { LeadCaptureFlow, STATES } from "./flow.mjs";
import { createHub } from "./realtime.mjs";
import { handleUtterance, registerSimulatedAgent, runTranscript } from "./offline.mjs";
import { attachMediaBridge, activeBridges } from "./voice/call-bridge.mjs";
import { answerInboundCall, transferToTeams, startDtmfRecognition, hangUp } from "./voice/acs.mjs";
import { resourceAccountFrom, buildCustomCallingContext } from "./handoff.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const hours = HoursPolicy.load();
const catalog = Catalog.load();
const reps = RepRoster.load();
const qualification = QualificationPolicy.load(config.paths.qualification, catalog);
const hub = createHub();

/** "9 PM": when evening on-call cover ends, from hours.json. */
function onCallUntilLabel() {
  const [h, m] = String(hours.onCall?.until ?? "21:00").split(":").map(Number);
  return clockLabel(h * 60 + (m || 0));
}

// ------------------------------------------------------------------ demo clock

/**
 * The clock the sales-hours and on-call policy sees. Real time unless a demo
 * moves it: in simulation mode DEMO_NOW, or the console, can pin it inside or
 * outside sales hours, so one running server shows every path on stage. A
 * server answering real calls always decides on the real time.
 */
const CLOCK_PRESETS = [
  // A Wednesday: sales is open 8 AM to 6 PM and on-call cover runs until 9 PM.
  { id: "business-hours", label: "Business hours", at: "2026-09-02T10:30:00-07:00" },
  { id: "after-hours", label: "After hours", at: "2026-09-02T19:30:00-07:00" },
  { id: "late-night", label: "Late night", at: "2026-09-02T22:30:00-07:00" },
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

// ------------------------------------------------------------------ lead store

/**
 * SQLite is loaded only when it is actually going to be used. better-sqlite3 is
 * a native module, so keeping it off the import path means the demo still
 * starts if its build step failed on an unusual platform.
 */
async function createStore() {
  const options = { reps, qualification, hours, now };
  try {
    const { SqliteLeadStore } = await import("./db-sqlite.mjs");
    return new SqliteLeadStore(options);
  } catch (e) {
    log(`[store] SQLite is unavailable, so leads are kept in memory: ${e.message}`);
    return new MemoryLeadStore(options);
  }
}

const store = await createStore();

/** The real transfer. Absent in simulation, which is what makes the flow simulate it. */
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

const flow = new LeadCaptureFlow({
  hours,
  catalog,
  store,
  reps,
  qualification,
  transfer,
  hub: flowHub,
  now,
  options: { pageWindowMs: config.pageWindowMs },
});

/**
 * Move the demo clock. Calls in progress shift by the same jump, so switching
 * clocks mid-call does not blow that call's time budget, and the policy code
 * never has to know a demo clock exists.
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
 * only way to be told about a call to the Teams Phone resource account. The
 * first request Event Grid ever sends is a validation handshake, so that is
 * answered before anything else.
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
  const fromPhone = data?.from?.rawId?.replace(/^4:/, "") ?? data?.from?.phoneNumber?.value ?? null;
  const voipHeaders = data?.customContext?.voipHeaders ?? {};

  const call = flow.create({
    callId: randomUUID(),
    fromPhone: fromPhone ? normalisePhone(fromPhone) : null,
    incomingCallContext: data.incomingCallContext,
    resourceAccountId: resourceAccountFrom(data?.to),
    // Keep a Teams auto attendant's or call queue's session id when this line
    // sits behind one, so the whole journey correlates in Teams.
    sessionId: voipHeaders["CallDetails.SessionId"] ?? data.correlationId ?? null,
    // A sales call queue that overflows to this line marks the call, so an
    // in-hours caller is captured instead of being sent back into a full queue.
    overflow: Boolean(voipHeaders["CallDetails.QueueOverflow"]),
  });

  const route = flow.planRoute(call.id);
  log("[call] incoming", call.id, "from", call.maskedPhone ?? "a withheld number", "→", route.action, `(${route.reason})`);

  if (route.action === "transfer") {
    // In sales hours the call is answered only so it can be handed to the Teams
    // sales queue: no media stream and no voice agent. The transfer starts
    // once ACS reports the call connected.
    const { callConnectionId } = await answerInboundCall({
      incomingCallContext: data.incomingCallContext,
      callId: call.id,
      startMedia: false,
    });
    flow.setCallConnection(call.id, callConnectionId);
    return;
  }

  // The call is ready for the agent before it is answered, because the media
  // socket can connect before answerCall returns.
  flow.routeIncoming(call.id, { answer: false });
  const { callConnectionId } = await answerInboundCall({ incomingCallContext: data.incomingCallContext, callId: call.id });
  flow.setCallConnection(call.id, callConnectionId);
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
        case "CallConnected": {
          flow.setCallConnection(callId, event.data?.callConnectionId);
          const call = flow.get(callId);
          if (!call) break;
          if (call.routeDecision?.action === "transfer" && call.state === STATES.RINGING) {
            flow.routeIncoming(callId);
          } else {
            await startDtmfRecognition({ callConnectionId: event.data?.callConnectionId, fromPhone: call.fromPhone });
          }
          break;
        }

        case "ContinuousDtmfRecognitionToneReceived": {
          // ACS reports the tone by name; the flow expects the digit.
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
          flow.transferAccepted(callId);
          break;

        case "CallTransferFailed": {
          const reason = event.data?.resultInformation?.message ?? "transfer failed";
          log("[call] transfer failed", callId, reason);
          const result = flow.transferFailed(callId, reason);
          // A direct in-hours sales transfer has no voice agent on the line to
          // explain, so the call ends here. Otherwise the agent explains (a failed
          // page, or an overflow caller who pressed 0) and hangs up after its goodbye.
          if (result.kind === "sales" && !activeBridges.has(callId)) await hangUp(flow.get(callId)?.callConnectionId);
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

/**
 * The call time budget, enforced by the server rather than the model. Real
 * calls only: a simulated call checks it on the next typed line, so a demo
 * call abandoned on stage never turns into a surprise partial lead.
 */
setInterval(() => {
  for (const [id, call] of flow.calls) if (!call.simulated) flow.checkBudget(id);
}, 5000).unref();

// ------------------------------------------------------------------ simulation

/**
 * The offline demo. A typed caller drives the same state machine, the same
 * sales hours, lead scoring, on-call policy and Teams handoff as a real call;
 * only the language understanding and the audio path are stubbed. A simulated
 * call is never transferred for real, even on a server that answers real calls.
 */
app.post(
  "/api/simulate",
  asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const call = flow.create({
      fromPhone: body.fromPhone ? normalisePhone(body.fromPhone) : null,
      overflow: body.scenario === "overflow",
      simulated: true,
    });
    registerSimulatedAgent(flow, call.id);
    const route = flow.routeIncoming(call.id);
    await flow.settled(call.id);
    if (Array.isArray(body.transcript)) {
      const ran = await runTranscript(flow, call.id, body.transcript);
      return res.json({ ok: true, callId: call.id, route, result: ran.result, snapshot: ran.snapshot });
    }
    res.json({ ok: true, callId: call.id, route, snapshot: flow.snapshot(call.id) });
  }),
);

/** Typed input drives simulated calls only; a real call is never steered from the console. */
function simulatedCall(req, res) {
  const call = flow.get(req.params.id);
  if (!call) {
    res.status(404).json({ error: "unknown call" });
    return null;
  }
  if (!call.simulated) {
    res.status(409).json({ error: "That is a real call. Only simulated calls take typed input." });
    return null;
  }
  return call;
}

/** Runs one caller action, waits for any transfer it started, and returns the new snapshot. */
const simulateStep = (run) =>
  asyncRoute(async (req, res) => {
    if (!simulatedCall(req, res)) return;
    const result = run(req.params.id, req.body ?? {});
    await flow.settled(req.params.id);
    res.json({ ok: true, result, snapshot: flow.snapshot(req.params.id) });
  });

app.post("/api/simulate/:id/say", simulateStep((id, body) => handleUtterance(flow, id, body.text ?? "")));
app.post("/api/simulate/:id/dtmf", simulateStep((id, body) => flow.dtmf(id, String(body.digit ?? ""))));
app.post("/api/simulate/:id/silence", simulateStep((id) => flow.noInput(id)));
app.post("/api/simulate/:id/hangup", simulateStep((id) => flow.endCall(id, "caller_hung_up")));
// The paged rep doesn't pick up: what a real CallTransferFailed does to a page.
app.post("/api/simulate/:id/no-answer", simulateStep((id) => flow.transferFailed(id, "The on-call rep didn't answer")));

// ----------------------------------------------------------------- demo controls

/** Demo controls refuse to touch a server that is answering real calls. */
function simulationOnly(res) {
  if (isSimulated()) return true;
  res.status(403).json({ error: "Demo controls are off while this server answers real calls." });
  return false;
}

function clockView() {
  const at = new Date(now());
  const coverage = hours.onCallCoverage(at);
  return {
    now: at.toISOString(),
    timeZone: hours.timeZone,
    preset: clockPreset,
    presets: CLOCK_PRESETS.map(({ id, label }) => ({ id, label })),
    adjustable: isSimulated(),
    salesOpen: hours.isSalesOpen(at),
    opening: hours.openingPhrase(at),
    onCall: {
      covered: coverage.covered,
      reason: coverage.reason,
      repName: coverage.repId ? (reps.find(coverage.repId)?.displayName ?? null) : null,
      until: coverage.untilLabel,
    },
  };
}

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
 * A clean stage between run-throughs: no simulated calls in memory, no
 * simulated calls, leads or follow-up messages in the store (anything from a
 * real phone is kept), and the starting clock.
 */
app.post("/api/demo/reset", (_req, res) => {
  if (!simulationOnly(res)) return;
  const removed = flow.reset();
  for (const id of removed) hub.forget(id);
  const cleared = store.resetSimulated();
  setClock(STARTING_CLOCK.at, STARTING_CLOCK.preset);
  log(`[demo] reset: cleared ${cleared.calls} simulated calls and ${cleared.leads} simulated leads`);
  res.json({ ok: true, cleared, clock: clockView(), stats: store.stats() });
});

/**
 * A scripted beat's fresh start, so beats run in any order: forgets the
 * simulated leads from the beat's caller, so a re-run isn't merged into the
 * last one as a repeat call, and lines up the owner rotation on the rep the
 * script names. The calls stay counted, and anything from a real phone is kept.
 */
app.post("/api/demo/restore", (req, res) => {
  if (!simulationOnly(res)) return;
  const { phones, nextRep = null } = req.body ?? {};
  if (!Array.isArray(phones) || (nextRep != null && typeof nextRep !== "string")) {
    return res.status(400).json({ error: 'Send { "phones": ["+14255550193"], "nextRep": "ava" } (nextRep is optional).' });
  }
  const restored = store.restoreSimulated({ phones: phones.map(String), nextRep });
  if (!restored.ok) return res.status(400).json({ error: `"${nextRep}" isn't an active rep in config/reps.json.` });
  const next = restored.nextRep?.displayName ?? null;
  log(`[demo] restore: forgot ${restored.forgotten.length} simulated lead(s)${next ? `; ${next} gets the next lead` : ""}`);
  res.json({ ok: true, forgotten: restored.forgotten.length, nextRep: next, stats: store.stats() });
});

// ------------------------------------------------------------------ console API

/** The rules the console explains. Teams object ids and contact details stay on the server. */
app.get("/api/policy", (_req, res) => {
  const onCall = hours.onCall;
  res.json({
    organization: hours.organization,
    timeZone: hours.timeZone,
    salesHours: hours.hoursLabel(),
    salesQueue: hours.salesQueue?.displayName ?? null,
    support: hours.support ?? null,
    onCall: onCall?.rep
      ? { repName: reps.find(onCall.rep)?.displayName ?? null, until: onCallUntilLabel(), days: onCall.days ?? [1, 2, 3, 4, 5] }
      : null,
    scoring: { thresholds: qualification.rules.thresholds, maxPoints: qualification.maxPoints },
    reps: reps.reps.map((r) => ({ name: r.displayName, active: Boolean(r.active) })),
    catalog: catalog.lines.map((l) => ({ name: l.name, minimumOrderQuantity: l.minimumOrderQuantity })),
  });
});

app.get("/api/leads", (_req, res) => res.json(store.listLeads()));

app.get("/api/outbox", (_req, res) => res.json(store.listOutbox()));

app.post("/api/leads/:id/contacted", (req, res) => {
  const at = req.body?.at ? new Date(req.body.at) : new Date(now());
  if (Number.isNaN(at.getTime())) return res.status(400).json({ error: "at must be an ISO 8601 timestamp" });
  const lead = store.markContacted(req.params.id, at);
  return lead ? res.json({ ok: true, lead }) : res.status(404).json({ error: "unknown lead" });
});

app.get("/api/calls/:id", (req, res) => {
  const snap = flow.snapshot(req.params.id);
  return snap ? res.json(snap) : res.status(404).json({ error: "unknown call" });
});

app.get("/api/calls/:id/events", (req, res) => res.json(store.eventsFor(req.params.id)));

app.get("/api/stats", (_req, res) => res.json(store.stats()));

app.post("/api/negotiate", (req, res) => res.json(hub.negotiate(req.body?.callId ?? "*")));

app.get("/health", (_req, res) => {
  const missing = assertCallConfig();
  res.json({
    ok: true,
    application: "after-hours-sales-lead-capture",
    mode: missing.length === 0 ? "live" : "simulation",
    callReady: missing.length === 0,
    missingConfig: missing,
    ...readiness({ hours, reps, store }, config, now()),
    audit: { store: store.name, persistTranscripts: config.persistTranscripts },
    realtime: hub.transport,
    leadCapture: {
      dedupeWindowDays: config.dedupeWindowDays,
      callTimeBudgetMs: config.callTimeBudgetMs,
      pageWindowMs: flow.options.pageWindowMs,
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

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    log(`Port ${config.port} is already in use. Stop the other server, or set PORT to a free port.`);
    process.exit(1);
  }
  throw e;
});

server.listen(config.port, config.host, () => {
  const onCall = hours.onCall?.rep ? reps.find(hours.onCall.rep) : null;
  log(`After-hours sales lead capture demo on http://${config.host}:${config.port}`);
  log(`  organization       : ${hours.organization}`);
  log(`  sales hours        : ${hours.hoursLabel()} (${hours.timeZone})`);
  log(`  on-call cover      : ${onCall ? `${onCall.displayName} until ${onCallUntilLabel()}` : "none"}`);
  log(`  lead store         : ${store.name}${config.persistTranscripts ? " (transcripts persisted)" : ""}`);
  log(`  call time budget   : ${config.callTimeBudgetMs / 1000}s`);
  log(`  page window        : ${flow.options.pageWindowMs / 1000}s`);

  const missing = assertCallConfig();
  if (missing.length) {
    log(`  SIMULATION MODE    — set ${missing.join(", ")} to answer real calls`);
    if (clockPreset !== "real") log(`  demo clock         : ${new Date(now()).toISOString()} (${clockPreset})`);
  } else {
    log(`  voice model        : ${config.voiceLive.model} (WebSocket ${config.voiceLive.apiVersion})`);
    log(`  public base URL    : ${config.publicBaseUrl}`);
    log(`  sales queue        : ${hours.salesQueue?.displayName ?? "not configured"}`);
  }
});