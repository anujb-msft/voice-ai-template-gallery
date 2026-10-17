import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { config, assertCallConfig, isSimulated, readiness, publicChain } from "./config.mjs";
import { MemoryAudit } from "./audit.mjs";
import { PagerFlow, SimulatedDialer } from "./flow.mjs";
import { PagerPolicy, normalisePhone } from "./policy.mjs";
import { TeamsNotifier } from "./notifications.mjs";
import { createHub } from "./realtime.mjs";
import { buildCustomCallingContext, levelLabel } from "./handoff.mjs";
import {
  startOfflineIntake,
  converse,
  pressKey,
  stayQuiet,
  leaveVoicemail,
  hangUp as hangUpSimulated,
  runTranscript,
} from "./offline.mjs";
import { attachMediaBridge, bridgeFor } from "./voice/call-bridge.mjs";
import {
  answerInboundCall,
  createPageCall,
  createStatusCall,
  addTenantParticipant,
  startDtmfRecognition,
  hangUp,
} from "./voice/acs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const policy = PagerPolicy.load();
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
// Simulated incidents from an earlier run would otherwise keep escalating in the
// background with nobody watching. Incidents from real calls are kept.
const staleSimulations = audit.reset();

// ------------------------------------------------------------------ demo clock

/**
 * The clock the on-call rotation and the escalation timers run on. In
 * simulation it starts on the "Weeknight on call" preset (or DEMO_NOW) and the
 * console can pin or advance it, so one running server shows the rotation, the
 * swap override and the weekend policy on stage. A server answering real calls
 * always pages on the real time.
 */
const CLOCK_PRESETS = [
  // Wednesday 11:42 PM: the regular rotations — Morgan for Maple Court, Omar for Pine Terrace.
  { id: "weeknight", label: "Weeknight on call", at: "2026-09-30T23:42:00-07:00" },
  // Thursday, October 1: a swap override puts Priya first for Maple Court.
  { id: "swap-night", label: "Swap night", at: "2026-10-01T23:10:00-07:00" },
  // Saturday night: a routine request waits for Monday's work order.
  { id: "weekend", label: "Weekend", at: "2026-10-03T22:15:00-07:00" },
  { id: "real", label: "Real time", at: null },
];

function presetClock(id) {
  const preset = CLOCK_PRESETS.find((p) => p.id === id);
  return { at: preset.at == null ? null : Date.parse(preset.at), preset: preset.id };
}

function startingClock() {
  const fallback = isSimulated() ? presetClock("weeknight") : presetClock("real");
  if (!config.demoNow) return fallback;
  if (!isSimulated()) {
    log("[clock] DEMO_NOW is ignored while answering real calls");
    return fallback;
  }
  const at = Date.parse(config.demoNow);
  if (!Number.isFinite(at)) {
    log(`[clock] DEMO_NOW is not an ISO 8601 timestamp (${config.demoNow}); starting on the ${fallback.preset} preset`);
    return fallback;
  }
  return { at, preset: CLOCK_PRESETS.find((p) => p.at && Date.parse(p.at) === at)?.id ?? "custom" };
}

const STARTING_CLOCK = startingClock();
let clockOffsetMs = STARTING_CLOCK.at == null ? 0 : STARTING_CLOCK.at - Date.now();
let clockPreset = STARTING_CLOCK.preset;
const now = () => Date.now() + clockOffsetMs;

// ------------------------------------------------------------------ the flow

/** Real calls. Simulated incidents always use `simDialer` and `simNotifier` instead. */
const acsDialer = {
  pageTechnician: ({ incident, contact }) => createPageCall({ incidentId: incident.id, contact }),
  statusCall: ({ incident, message }) => createStatusCall({ incident, message }),
  bridgeToTenant: ({ incident, callConnectionId }) =>
    addTenantParticipant({ incident, callConnectionId }).catch((e) => {
      log("[call] couldn't add the tenant to the page", e.message);
      throw e;
    }),
};

/**
 * The console shows the VoIP headers a page to a Teams client would carry,
 * built here by `buildCustomCallingContext` rather than kept as a copy in the
 * console. No live call sends them yet: the page is a PSTN call (see handoff.mjs).
 */
const flowHub = {
  send: (callId, target, payload) =>
    hub.send(callId, target, target === "handoff" ? { ...payload, voipHeaders: buildCustomCallingContext(payload) } : payload),
};

const flow = new PagerFlow({
  policy,
  audit,
  notifier: new TeamsNotifier({ workflowUrl: config.teams.workflowUrl, opsWorkflowUrl: config.teams.opsWorkflowUrl }),
  dialer: isSimulated() ? new SimulatedDialer() : acsDialer,
  simDialer: new SimulatedDialer(),
  simNotifier: new TeamsNotifier(),
  hub: flowHub,
  now,
});

/**
 * Move the demo clock to a preset or a time. Calls in progress shift by the
 * same jump, so switching presets mid-call neither fires nor stalls a pending
 * page — and the policy code never has to know a demo clock exists.
 */
function setClock(at, preset) {
  const offsetMs = at == null ? 0 : at - Date.now();
  flow.rebaseClock(offsetMs - clockOffsetMs);
  clockOffsetMs = offsetMs;
  clockPreset = preset;
}

// Escalation timers are due on the demo clock; this is what fires them.
const JOB_INTERVAL_MS = 5_000;
setInterval(() => {
  flow.processDueJobs().catch((e) => log("[scheduler] failed", e.message));
}, JOB_INTERVAL_MS).unref();

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
 * A tenant's call arrives as an Event Grid `IncomingCall` event. The first
 * request Event Grid ever sends is a validation handshake, so that is
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
  const raw = data?.from?.rawId?.replace(/^4:/, "") ?? data?.from?.phoneNumber?.value ?? null;
  const call = flow.createIntake({ callId: randomUUID(), fromPhone: raw ? normalisePhone(raw) : null, simulated: false });
  log("[call] incoming", call.id, "from", call.maskedPhone ?? "a withheld number");
  const { callConnectionId } = await answerInboundCall({ incomingCallContext: data.incomingCallContext, callId: call.id });
  flow.setCallConnection("intake", call.id, callConnectionId);
}

// --------------------------------------------------------------- ACS callbacks

/**
 * One callback URL for all three legs: `leg=intake` (the tenant's call, keyed
 * by call id), `leg=page` (the technician's page, keyed by incident id) and
 * `leg=status` (the call back to the tenant).
 */
app.post(
  "/api/calls/callback",
  asyncRoute(async (req, res) => {
    res.sendStatus(200);
    const id = String(req.query.call ?? "");
    const leg = String(req.query.leg ?? "intake");

    for (const event of Array.isArray(req.body) ? req.body : [req.body]) {
      const type = event?.type?.split(".").pop();
      const callConnectionId = event?.data?.callConnectionId ?? null;
      log("[acs]", type, leg, id);
      switch (type) {
        case "CallConnected": {
          // A page or status call is known from the moment it's dialed; a late connect from an older attempt mustn't replace it.
          if (leg === "intake" || !flow.connectionId(leg, id)) flow.setCallConnection(leg, id, callConnectionId);
          // Keypad presses are recognized for the person on the line: the tenant, or the paged technician.
          const targetPhone =
            leg === "intake" ? flow.intakes.get(id)?.fromPhone : leg === "page" ? technicianMobile(id) : null;
          await startDtmfRecognition({ callConnectionId, targetPhone });
          break;
        }

        case "ContinuousDtmfRecognitionToneReceived": {
          const digit = TONE_DIGITS[event.data?.tone] ?? event.data?.tone;
          if (leg === "page" && digit != null) await onPageDigit(id, String(digit), callConnectionId);
          break;
        }

        case "CreateCallFailed":
          if (leg === "page" && isCurrentCall(leg, id, callConnectionId)) flow.pageNoAnswer(id);
          log("[call] outbound call failed", leg, event.data?.resultInformation?.message ?? "");
          break;

        case "MediaStreamingFailed": {
          // Without the reason this reads as "it broke", which is how a socket
          // that never connected can look like a Voice Live problem.
          const info = event.data?.resultInformation ?? {};
          log("[call] media streaming failed", `code=${info.code} sub=${info.subCode}`, info.message ?? "");
          break;
        }

        case "AddParticipantSucceeded":
          if (leg === "page") bridgeFor(leg, id, callConnectionId)?.tenantJoined();
          break;

        case "AddParticipantFailed": {
          // ACS's reason stays in the server log; the console and the audit get a fixed one.
          log("[call] tenant bridge failed", event.data?.resultInformation?.message ?? "");
          if (leg !== "page") break;
          const missed = await flow.tenantBridgeFailed(id);
          if (missed.ok) bridgeFor(leg, id, callConnectionId)?.tenantMissed(missed.speak);
          break;
        }

        case "CallDisconnected":
          bridgeFor(leg, id, callConnectionId)?.stop({ hangUp: false });
          // A tenant hanging up after the report does not stop the paging; a page
          // that ends without an answer counts as unanswered and escalates.
          if (leg === "intake" && flow.intakes.has(id)) flow.hangup(id, { reason: "hung up" });
          else if (leg === "page" && isCurrentCall(leg, id, callConnectionId)) flow.pageNoAnswer(id);
          break;
      }
    }
  }),
);

/** A callback from an older call on the same leg (a retry has rung since) must not move the flow. */
function isCurrentCall(leg, id, callConnectionId) {
  const current = flow.connectionId(leg, id);
  return !current || !callConnectionId || current === callConnectionId;
}

/** The paged technician's number, looked up server-side for keypad recognition. Never sent to a client. */
function technicianMobile(incidentId) {
  const contactId = flow.pageSessions.get(incidentId)?.contact?.id;
  return contactId ? (policy.technicians.get(contactId)?.mobile ?? null) : null;
}

/** With an agent on the call, it says what the key did; without one (Voice Live down), the keypad still works. */
async function onPageDigit(incidentId, digit, callConnectionId) {
  const bridge = bridgeFor("page", incidentId, callConnectionId);
  if (bridge) return bridge.pressed(digit);
  if (!isCurrentCall("page", incidentId, callConnectionId)) return null;
  if (digit === "1") return flow.acknowledge(incidentId);
  if (digit === "2") return flow.decline(incidentId, "pressed 2");
  if (digit === "3") return flow.bridgeToTenant(incidentId);
  if (digit === "*") return flow.repeatBrief(incidentId);
  return null;
}

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
  asterisk: "*",
  pound: "#",
};

// ------------------------------------------------------------------ simulation

/**
 * The offline demo. A typed tenant drives the same state machine, the same
 * triage, the same rotation and the same escalation timers as a real call —
 * only the agent's words and the audio path are stubbed. Once the tenant is
 * done, the same call id follows the page: what the technician says or presses
 * goes through the same routes. A simulated call never dials, pages or posts
 * to Teams for real, even on a server that answers real calls.
 */
app.post(
  "/api/simulate",
  asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    // No fromPhone: the default tenant. An empty one: a withheld number.
    const fromPhone = "fromPhone" in body ? (body.fromPhone ? normalisePhone(body.fromPhone) : null) : undefined;
    // One demo call at a time: an unfinished one is ended and its pending pages canceled.
    flow.cancelOpenSimulations();
    await flow.settled();
    const call = startOfflineIntake(flow, { fromPhone, interactive: true });
    res.json({ ok: true, callId: call.id, snapshot: flow.snapshot(call.id) });
  }),
);

/** The whole tenant call from a list of lines, then submit — the original offline harness. */
app.post(
  "/api/simulate/intake",
  asyncRoute(async (req, res) => {
    const transcript = Array.isArray(req.body?.transcript) ? req.body.transcript.map(String) : [];
    if (!transcript.length) return res.status(400).json({ error: "Send { transcript: [lines] }, or POST /api/simulate for an interactive call." });
    const { callId, submitted } = await runTranscript(flow, {
      fromPhone: req.body?.fromPhone ?? undefined,
      transcript,
      pageOutcomes: Array.isArray(req.body?.pageOutcomes) ? req.body.pageOutcomes : [],
    });
    await flow.settled();
    res.json({
      ok: true,
      callId,
      submitted,
      snapshot: flow.snapshot(callId),
      incident: submitted.incidentId ? flow.snapshotIncident(submitted.incidentId) : null,
    });
  }),
);

/** Force the next pending page for a simulated incident: accept, decline, no-answer, voicemail or bridge. */
app.post(
  "/api/simulate/page/:incidentId",
  asyncRoute(async (req, res) => {
    const incident = audit.getIncident(req.params.incidentId);
    if (!incident?.simulated) return res.status(404).json({ error: "unknown simulated incident" });
    const result = await flow.forceNextPage(incident.id, String(req.body?.outcome ?? "accept"));
    await flow.settled();
    res.json({ ok: true, result, incident: flow.snapshotIncident(incident.id) });
  }),
);

/** The simulate routes act on simulated calls only: a real call is watched, never driven. */
function simulatedCall(req, res) {
  const ctx = flow.intakes.get(req.params.id);
  if (!ctx) {
    res.status(404).json({ error: "unknown call" });
    return null;
  }
  if (!ctx.simulated) {
    res.status(409).json({ error: "That is a real call. The console can follow it, not drive it." });
    return null;
  }
  return ctx;
}

const reply = async (res, id, result) => res.json({ ok: true, result, snapshot: await flow.settled(id) });

app.post(
  "/api/simulate/:id/say",
  asyncRoute(async (req, res) => {
    if (!simulatedCall(req, res)) return;
    await reply(res, req.params.id, await converse(flow, req.params.id, String(req.body?.text ?? "")));
  }),
);

app.post(
  "/api/simulate/:id/dtmf",
  asyncRoute(async (req, res) => {
    if (!simulatedCall(req, res)) return;
    const result = await pressKey(flow, req.params.id, String(req.body?.digit ?? ""));
    if (result?.ok === false) return res.status(400).json({ error: result.error });
    await reply(res, req.params.id, result);
  }),
);

app.post(
  "/api/simulate/:id/silence",
  asyncRoute(async (req, res) => {
    if (!simulatedCall(req, res)) return;
    await reply(res, req.params.id, await stayQuiet(flow, req.params.id));
  }),
);

/** The page rang through to the technician's voicemail. */
app.post(
  "/api/simulate/:id/voicemail",
  asyncRoute(async (req, res) => {
    if (!simulatedCall(req, res)) return;
    await reply(res, req.params.id, leaveVoicemail(flow, req.params.id));
  }),
);

app.post(
  "/api/simulate/:id/submit",
  asyncRoute(async (req, res) => {
    if (!simulatedCall(req, res)) return;
    await reply(res, req.params.id, await flow.submit(req.params.id));
  }),
);

/** Hang up. A real call can be hung up from the console too; its pages carry on. */
app.post(
  "/api/simulate/:id/hangup",
  asyncRoute(async (req, res) => {
    const ctx = flow.intakes.get(req.params.id);
    if (!ctx) return res.status(404).json({ error: "unknown call" });
    if (ctx.simulated) hangUpSimulated(flow, ctx.id);
    else {
      flow.hangup(ctx.id, { reason: "hung up" });
      await hangUp(flow.connectionId("intake", ctx.id));
    }
    const snapshot = await flow.settled(ctx.id);
    res.json({ ok: true, result: { state: snapshot?.state ?? null }, snapshot });
  }),
);

// ----------------------------------------------------------------- demo controls

/** Demo controls refuse to touch a server that is answering real calls. */
function simulationOnly(res) {
  if (isSimulated()) return true;
  res.status(403).json({ error: "Demo controls are off while this server answers real calls." });
  return false;
}

/** Who is on call for each property group right now, on the demo clock, and why. */
function onCallNow(at = now()) {
  return policy.groups().map((group) => ({
    ...publicChain(policy.onCallChain(group, new Date(at))),
    properties: policy.properties.filter((p) => p.group === group).map((p) => p.name),
  }));
}

const clockView = () => ({
  now: new Date(now()).toISOString(),
  timeZone: policy.timeZone,
  preset: clockPreset,
  presets: CLOCK_PRESETS.map(({ id, label }) => ({ id, label })),
  adjustable: isSimulated(),
  onCall: onCallNow(),
});

app.get("/api/demo/clock", (_req, res) => res.json(clockView()));

app.post("/api/demo/clock", (req, res) => {
  if (!simulationOnly(res)) return;
  const { preset, at } = req.body ?? {};
  if (preset != null) {
    const match = CLOCK_PRESETS.find((p) => p.id === preset);
    if (!match) return res.status(400).json({ error: `Unknown clock preset "${preset}".` });
    const { at: presetAt } = presetClock(match.id);
    setClock(presetAt, match.id);
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
 * Skip ahead: move the clock forward without shifting pending pages, so the
 * escalation timers come due exactly as they would after a real wait, then run
 * whatever is due. Send `{ minutes }` or `{ at }`; `callId` returns that call's
 * snapshot afterwards.
 */
app.post(
  "/api/demo/clock/advance",
  asyncRoute(async (req, res) => {
    if (!simulationOnly(res)) return;
    const { minutes, at, callId } = req.body ?? {};
    let target;
    if (at != null) {
      target = Date.parse(at);
      if (!Number.isFinite(target)) return res.status(400).json({ error: `"${at}" is not an ISO 8601 timestamp.` });
    } else {
      const m = Number(minutes);
      if (!Number.isFinite(m) || m <= 0 || m > 24 * 60) return res.status(400).json({ error: "Send { minutes } between 0 and 1440, or { at }." });
      target = now() + m * 60_000;
    }
    if (target < now()) return res.status(400).json({ error: "Advance only moves the clock forward. Use a preset to go back." });
    clockOffsetMs = target - Date.now();
    clockPreset = "custom";
    const results = await flow.processDueJobs();
    await flow.settled();
    log(`[clock] advanced to ${new Date(now()).toISOString()} — ${results.length} job(s) due`);
    res.json({ ok: true, clock: clockView(), processed: results.length, snapshot: callId ? flow.snapshot(String(callId)) : null });
  }),
);

/**
 * A clean stage between run-throughs: no simulated calls in memory, no
 * simulated incidents, pages, timers, Teams cards or status calls (incidents
 * from real calls are kept), and the starting clock.
 */
app.post(
  "/api/demo/reset",
  asyncRoute(async (_req, res) => {
    if (!simulationOnly(res)) return;
    await flow.settled();
    const ids = flow.reset();
    for (const id of ids) hub.forget(id);
    const incidents = audit.reset();
    setClock(STARTING_CLOCK.at, STARTING_CLOCK.preset);
    log(`[demo] reset — ${ids.length} simulated call(s), ${incidents} simulated incident(s) cleared`);
    res.json({ ok: true, clock: clockView(), stats: audit.stats() });
  }),
);

// ------------------------------------------------------------------ console API

app.get("/api/calls/:id", (req, res) => {
  const snap = flow.snapshot(req.params.id);
  return snap ? res.json(snap) : res.status(404).json({ error: "unknown call" });
});

app.get("/api/calls/:id/events", (req, res) => {
  if (!flow.intakes.has(req.params.id) && !audit.getIncident(req.params.id)) return res.status(404).json({ error: "unknown call" });
  res.json(flow.eventsFor(req.params.id));
});

app.get("/api/incidents", (_req, res) => res.json(audit.listIncidents().map((i) => flow.snapshotIncident(i.id))));

app.get("/api/incidents/:id", (req, res) => {
  const snap = audit.getIncident(req.params.id) ? flow.snapshotIncident(req.params.id) : null;
  return snap ? res.json(snap) : res.status(404).json({ error: "unknown incident" });
});

app.get("/api/incidents/:id/events", (req, res) => res.json(audit.eventsFor(req.params.id)));

app.get("/api/stats", (_req, res) => res.json(audit.stats()));

app.post("/api/negotiate", (req, res) => res.json(hub.negotiate(req.body?.callId ?? "*")));

app.get("/health", (_req, res) => {
  const missing = assertCallConfig();
  const { levels, attemptsPerLevel, gapMinutes, unacknowledgedAlertMinutes, duplicateWindowMinutes } = policy.escalation;
  res.json({
    ok: true,
    mode: missing.length === 0 ? "live" : "simulation",
    callReady: missing.length === 0,
    ...readiness(policy, flow, config, now()),
    missingConfig: missing,
    organization: policy.organization,
    audit: { store: audit.name, persistTranscripts: config.persistTranscripts },
    realtime: hub.transport,
    paging: {
      levels,
      attemptsPerLevel,
      gapMinutes,
      unacknowledgedAlertMinutes,
      duplicateWindowMinutes,
      noHeatThresholdF: policy.triage.noHeatThresholdF,
    },
    budgets: config.budgets,
    clock: { preset: clockPreset, now: new Date(now()).toISOString(), timeZone: policy.timeZone },
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
  const { levels, attemptsPerLevel, gapMinutes, unacknowledgedAlertMinutes } = policy.escalation;
  log(`Contextual on-call pager demo on http://${config.host}:${config.port}`);
  log(`  organization       : ${policy.organization}`);
  log(`  properties         : ${policy.properties.map((p) => `${p.name} (${p.group})`).join(", ")}`);
  log(`  audit              : ${audit.name}${config.persistTranscripts ? " (transcripts persisted)" : ""}${staleSimulations ? ` — cleared ${staleSimulations} simulated incident(s) from an earlier run` : ""}`);
  log(`  escalation         : ${levels.map(levelLabel).join(" → ")}, ${attemptsPerLevel} attempts each; gap ${Object.entries(gapMinutes).map(([k, v]) => `${k} ${v} min`).join(", ")}; ops alert at ${unacknowledgedAlertMinutes} min`);

  const missing = assertCallConfig();
  if (missing.length) {
    log(`  SIMULATION MODE    — set ${missing.join(", ")} to answer real calls`);
    log(`  demo clock         : ${new Date(now()).toISOString()} (${clockPreset})`);
  } else {
    log(`  voice model        : ${config.voiceLive.model} (WebSocket ${config.voiceLive.apiVersion})`);
    log(`  public base URL    : ${config.publicBaseUrl}`);
  }
  for (const chain of onCallNow()) log(`  on call (${chain.group.padEnd(7)}) : ${chain.primary?.name} → ${chain.secondary?.name} — ${chain.why}`);
});
