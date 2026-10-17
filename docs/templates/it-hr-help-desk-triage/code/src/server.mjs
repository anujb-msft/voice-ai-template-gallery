import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config, assertCallConfig, isSimulated, readiness } from "./config.mjs";
import { MemoryAudit } from "./audit.mjs";
import { Taxonomy, SensitiveGuard, PriorityMatrix, OutagePolicy, RoutingPolicy, KnowledgeBase } from "./policy.mjs";
import { DirectoryAdapter } from "./adapters/directory.mjs";
import { HrisAdapter } from "./adapters/hris.mjs";
import { OtpSender } from "./adapters/otp.mjs";
import { createTicketAdapter } from "./adapters/tickets.mjs";
import { TriageFlow } from "./flow.mjs";
import { handleUtterance, registerSimulatedAgent, runTranscript } from "./offline.mjs";
import { createHub } from "./realtime.mjs";
import { attachMediaBridge, activeBridges } from "./voice/call-bridge.mjs";
import { answerInboundCall, transferToTeams, startDtmfRecognition, hangUp } from "./voice/acs.mjs";
import { resourceAccountFrom, buildCustomCallingContext } from "./handoff.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const taxonomy = Taxonomy.load();
const guard = SensitiveGuard.load();
const priority = PriorityMatrix.load();
const outages = OutagePolicy.load();
const routing = RoutingPolicy.load();
const knowledge = new KnowledgeBase();
const directory = new DirectoryAdapter();
const hris = new HrisAdapter();
const hub = createHub();

/**
 * SQLite is loaded lazily: if the native module cannot load or the file cannot
 * open, the demo keeps working in memory instead of refusing to start.
 */
async function createAudit() {
  try {
    const { SqliteAudit } = await import("./db.mjs");
    return new SqliteAudit(config.dbPath);
  } catch (e) {
    log(`[audit] falling back to in-memory audit: ${e.message}`);
    return new MemoryAudit();
  }
}

const audit = await createAudit();
const tickets = await createTicketAdapter(config.ticketAdapter, { path: config.dbPath, log });

// ------------------------------------------------------------------ demo clock

/**
 * The clock the triage policy sees: support hours, the outage window, article
 * review dates and one-time code expiry. Real time unless a demo moves it: in
 * simulation mode DEMO_NOW, or the console, can pin it inside or outside
 * business hours, so one running server shows both paths on stage. A server
 * answering real calls always uses the real time.
 */
const TIME_ZONE = "America/Los_Angeles";
const CLOCK_PRESETS = [
  // A Friday, so every weekday queue is open and the Outlook outage is active.
  { id: "business-hours", label: "Business hours", at: "2026-05-15T10:30:00-07:00" },
  { id: "after-hours", label: "After hours", at: "2026-05-15T19:30:00-07:00" },
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
// From here on the server owns the clock and passes it explicitly, so a stale
// DEMO_NOW must not pin time anywhere else — least of all on a live server.
config.demoNow = "";
let clockOffsetMs = STARTING_CLOCK.at == null ? 0 : STARTING_CLOCK.at - Date.now();
let clockPreset = STARTING_CLOCK.preset;
const now = () => Date.now() + clockOffsetMs;

/**
 * Simulated calls always get the fixed demo code and nothing is sent: the
 * console shows it in a mock inbox. Real calls get a random code, and delivery
 * is a stub until you wire it to Teams chat or SMS.
 */
const otp = new OtpSender({
  code: "123456",
  now,
  deliver: (_employee, record) =>
    log(`[otp] delivery is a stub: a ${record.channel} code was generated but not sent. Wire OtpSender.deliver before relying on phone verification.`),
});

/** The real transfer. Absent in simulation, which is what makes the flow stub it out. */
const transfer = isSimulated()
  ? null
  : async (call, { target, context }) =>
      transferToTeams({ callConnectionId: call.callConnectionId, target: target.target, context, callId: call.id });

/**
 * The console shows the VoIP headers a transfer actually sends, built by the
 * same function the transfer uses, rather than its own copy of the list.
 */
const flowHub = {
  send: (callId, target, payload) =>
    hub.send(callId, target, target === "handoff" ? { ...payload, voipHeaders: buildCustomCallingContext(payload) } : payload),
};

const flow = new TriageFlow({
  taxonomy, guard, knowledge, directory, hris, tickets, priority, outages, routing, audit, otp,
  transfer, hub: flowHub, now: () => new Date(now()),
});

/**
 * Move the demo clock. Calls in progress shift by the same jump, so switching
 * to after hours mid-call neither blows that call's time budget nor expires
 * its one-time code — and the policy core never has to know a demo clock exists.
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
 * Inbound calls arrive here as an Event Grid `IncomingCall` event. The first
 * request Event Grid ever sends is a validation handshake, so that is answered
 * before anything else.
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
      if (seenEvents.size > 1000) seenEvents.delete(seenEvents.values().next().value);
      await onIncomingCall(event.data).catch((e) => log("[eventgrid] answer failed", e));
    }
  }),
);

/**
 * A Teams caller arrives with an Entra identity, which is enough to read their
 * own tickets. A phone number is only ever a hint: the flow asks a phone caller
 * for a one-time code before reading out anything personal.
 */
async function onIncomingCall(data) {
  const rawId = data?.from?.rawId ?? "";
  const teamsUserId = rawId.startsWith("8:orgid:") ? rawId : null;
  const fromPhone = teamsUserId ? null : data?.from?.phoneNumber?.value ?? (rawId.startsWith("4:") ? rawId.slice(2) : null);
  const call = flow.create({
    callId: randomUUID(),
    teamsUserId,
    fromPhone,
    simulation: false,
    incomingCallContext: data?.incomingCallContext,
    resourceAccountId: resourceAccountFrom(data?.to),
    // Keep an Auto Attendant's session id when this line sits behind one, so
    // the whole journey correlates in Teams rather than restarting here.
    sessionId: data?.customContext?.voipHeaders?.["CallDetails.SessionId"] ?? data?.correlationId ?? null,
  });
  log("[call] incoming", call.id, "via", call.arrival, "on", call.channel, call.maskedPhone ?? "");
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
        case "CallConnected":
          // The media bridge greets the caller once audio flows; this only wires up the keypad.
          flow.setCallConnection(callId, event.data?.callConnectionId);
          await startDtmfRecognition({ callConnectionId: event.data?.callConnectionId, fromPhone: flow.get(callId)?.fromPhone });
          break;

        case "ContinuousDtmfRecognitionToneReceived": {
          // ACS reports the tone by name; the flow is keyed by digit.
          const digit = TONE_DIGITS[event.data?.tone] ?? event.data?.tone;
          if (digit != null && flow.get(callId)) flow.dtmf(callId, String(digit));
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

        case "CallTransferFailed":
          // The caller is still on the line: the flow apologizes and offers a ticket instead.
          log("[call] transfer failed", event.data?.resultInformation?.message ?? "");
          flow.transferFailed(callId, event.data?.resultInformation?.message ?? "transfer failed");
          break;

        case "CallDisconnected":
          flow.endCall(callId, "caller_hung_up");
          activeBridges.get(callId)?.stop();
          break;
      }
    }
  }),
);

const TONE_DIGITS = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  pound: "#", asterisk: "*",
};

// ------------------------------------------------------------------ simulation

/**
 * The offline demo. A typed transcript drives the same state machine, the same
 * identity gate, the same sensitive-topic guard and the same handoff assembly
 * as a real call — only the classifier and the audio path are stubbed. A
 * simulated call is never transferred and never sends a code, even on a server
 * that answers real calls.
 */
app.post(
  "/api/simulate",
  asyncRoute(async (req, res) => {
    const teamsUserId = req.body?.teamsUserId ? String(req.body.teamsUserId) : null;
    const fromPhone = !teamsUserId && req.body?.fromPhone ? String(req.body.fromPhone) : null;
    const call = flow.create({ teamsUserId, fromPhone, simulation: true });
    registerSimulatedAgent(flow, call.id);
    flow.answered(call.id);
    res.json({ ok: true, callId: call.id, snapshot: flow.snapshot(call.id) });
  }),
);

/** Every simulated step waits for the flow to settle, so the snapshot is the outcome. */
const simulateStep = (step) =>
  asyncRoute(async (req, res) => {
    const id = req.params.id;
    if (!flow.get(id)) return res.status(404).json({ error: "unknown call" });
    const result = await step(id, req.body ?? {});
    await flow.settled(id);
    res.json({ ok: true, result, snapshot: flow.snapshot(id) });
  });

app.post("/api/simulate/:id/say", simulateStep((id, body) => handleUtterance(flow, id, String(body.text ?? ""))));
app.post("/api/simulate/:id/dtmf", simulateStep((id, body) => flow.dtmf(id, String(body.digit ?? ""))));
app.post("/api/simulate/:id/silence", simulateStep((id) => flow.noInput(id)));
app.post(
  "/api/simulate/:id/hangup",
  simulateStep(async (id) => {
    const result = flow.endCall(id, "caller_hung_up");
    await hangUp(flow.get(id)?.callConnectionId);
    return result;
  }),
);

/** Runs a whole typed call in one request; handy for scripted checks. */
app.post(
  "/api/offline-call",
  asyncRoute(async (req, res) => {
    const result = runTranscript(flow, req.body ?? {});
    await flow.settled(result.callId);
    res.json({ ...result, snapshot: flow.snapshot(result.callId) });
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
 * A clean stage between run-throughs: no simulated calls in memory or in the
 * audit, no simulated tickets, HR cases or outage sign-ups (so the next ticket
 * is INC-004821 again), no one-time codes, and the starting clock. Anything a
 * real phone call created is kept.
 */
app.post("/api/demo/reset", (_req, res) => {
  if (!simulationOnly(res)) return;
  for (const id of flow.reset()) hub.forget(id);
  audit.reset();
  tickets.reset();
  otp.reset();
  setClock(STARTING_CLOCK.at, STARTING_CLOCK.preset);
  log("[demo] reset");
  res.json({ ok: true, clock: clockView(), stats: audit.stats(tickets.stats()) });
});
// ------------------------------------------------------------------ console API

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ZONE_NAMES = { "America/Los_Angeles": "PT", UTC: "UTC" };

/** "09:00" → "9 AM", "17:30" → "5:30 PM". */
function clock12(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

function hoursLabel({ hours }) {
  if (hours.days.length === 7 && hours.open === "00:00" && hours.close === "24:00") return "24/7";
  const days = hours.days.join() === "1,2,3,4,5" ? "Mon–Fri" : hours.days.map((d) => DAY_NAMES[d]).join(", ");
  return `${days}, ${clock12(hours.open)}–${clock12(hours.close)} ${ZONE_NAMES[hours.timeZone] ?? hours.timeZone}`;
}

app.get("/api/routes", (_req, res) => {
  const at = new Date(now());
  res.json({
    organization: routing.organization,
    fallbackDestination: routing.fallbackDestination,
    timeZone: TIME_ZONE,
    // Teams object ids are deliberately withheld: nothing outside routing.json needs them.
    // Open or closed is judged on the demo clock, the time the policy routes on.
    routes: routing.destinations.map((d) => ({
      id: d.id,
      label: d.label,
      description: d.description,
      queue: d.target?.displayName ?? d.label,
      dtmf: d.dtmf ?? null,
      hours: hoursLabel(d),
      open: routing.isOpen(d.id, at),
      confidential: d.id === "confidential-hr",
    })),
  });
});

app.get("/api/calls/:id", (req, res) => {
  const snap = flow.snapshot(req.params.id);
  return snap ? res.json(snap) : res.status(404).json({ error: "unknown call" });
});

app.get("/api/calls/:id/events", (req, res) => res.json(audit.eventsFor(req.params.id)));

app.get("/api/stats", (_req, res) => res.json(audit.stats(tickets.stats())));

app.post("/api/negotiate", (req, res) => res.json(hub.negotiate(req.body?.callId ?? "*")));

app.get("/health", (_req, res) => {
  const missing = assertCallConfig();
  const at = new Date(now());
  res.json({
    ok: true,
    mode: missing.length === 0 ? "live" : "simulation",
    callReady: missing.length === 0,
    missingConfig: missing,
    ...readiness({ routing, knowledge, outages }, config, at),
    audit: { store: audit.name, transcriptRetention: config.transcriptRetention },
    tickets: { store: tickets.name },
    realtime: hub.transport,
    triage: {
      confidenceMin: flow.options.confidenceMin,
      timeBudgetMs: flow.options.timeBudgetMs,
      otpChannel: flow.options.otpChannel,
      statsMinCount: config.statsMinCount,
    },
    clock: { preset: clockPreset, now: at.toISOString(), timeZone: TIME_ZONE },
  });
});

// Warn at wrap-up and end at the cap, even when nobody says anything.
setInterval(() => {
  for (const id of flow.calls.keys()) flow.checkBudget(id);
}, 5_000).unref();

// ----------------------------------------------------------------------- start

const server = createServer(app);

// One upgrade listener, routed by pathname: two WebSocketServers bound to one
// HTTP server abort each other's handshakes.
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
  log(`IT / HR help desk triage demo on http://${config.host}:${config.port}`);
  log(`  organization       : ${routing.organization}`);
  log(`  destinations       : ${routing.destinations.map((d) => d.id).join(", ")} (fallback: ${routing.fallbackDestination})`);
  log(`  audit / tickets    : ${audit.name} / ${tickets.name}${config.transcriptRetention ? " (transcripts retained)" : ""}`);
  log(`  confidence gate    : ${flow.options.confidenceMin}`);
  log(`  call time budget   : ${flow.options.timeBudgetMs / 1000}s`);
  log(`  one-time codes via : ${flow.options.otpChannel}`);

  const missing = assertCallConfig();
  if (missing.length) {
    log(`  SIMULATION MODE    — set ${missing.join(", ")} to answer real calls`);
    if (clockPreset !== "real") log(`  demo clock         : ${new Date(now()).toISOString()} (${clockPreset})`);
  } else {
    log(`  voice model        : ${config.voiceLive.model} (WebSocket ${config.voiceLive.apiVersion})`);
    log(`  public base URL    : ${config.publicBaseUrl}`);
  }
});
