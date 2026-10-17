import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { config, assertCallConfig, isSimulated, readiness } from "./config.mjs";
import { MemoryAudit } from "./audit.mjs";
import { MemoryCaseStore } from "./cases.mjs";
import { RequestCatalog, DepartmentDirectory, readJson } from "./fixtures.mjs";
import { ContentIndex } from "./content.mjs";
import { FixtureGeocoder } from "./geocoder.mjs";
import { ServiceAssistantFlow } from "./flow.mjs";
import { AcsSmsLinkSender } from "./sms.mjs";
import { createHub } from "./realtime.mjs";
import { handleUtterance, registerSimulatedAgent } from "./offline.mjs";
import { attachMediaBridge, activeBridges } from "./voice/call-bridge.mjs";
import { answerInboundCall, transferToTeams, startDtmfRecognition, hangUp } from "./voice/acs.mjs";
import { resourceAccountFrom } from "./handoff.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const requests = RequestCatalog.load(config.paths.requestTypes);
const departments = DepartmentDirectory.load(config.paths.departments, config.paths.holidays);
const geocoder = FixtureGeocoder.load(config.paths.addresses, config.paths.streets);
const emergency = readJson(config.paths.emergency);
const bulkPickup = readJson(config.paths.bulkPickup);
const hub = createHub();

// ------------------------------------------------------------------ demo clock

/**
 * The clock office hours, collection days, response targets and content
 * freshness are judged on. Real time unless a demo moves it: in simulation
 * mode DEMO_NOW, or the console, can pin it inside or outside business hours,
 * so one running server shows both paths on stage. A server answering real
 * calls always uses the real time.
 */
const CLOCK_PRESETS = [
  // A Wednesday: every department is open and the next bulk pickup is that Saturday.
  { id: "business-hours", label: "Business hours", at: "2026-09-30T10:30:00-07:00" },
  // The same Wednesday after 7 p.m.: Public Works and 311 staff have gone home.
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

const content = new ContentIndex(config.paths.articles, { now, expiryGraceDays: config.contentExpiryGraceDays });

// ---------------------------------------------------------------------- stores

/**
 * SQLite is loaded only when it is actually going to be used. better-sqlite3 is
 * a native module, so keeping it off the start-up path means the demo still
 * runs if the build step failed on an unusual platform.
 */
async function createStores() {
  if (config.caseStore === "memory") return { audit: new MemoryAudit(), cases: new MemoryCaseStore({ now }) };
  try {
    const { SqliteAudit, SqliteCaseStore } = await import("./db.mjs");
    return { audit: new SqliteAudit(config.dbPath), cases: new SqliteCaseStore({ path: config.dbPath, now }) };
  } catch (e) {
    log(`[store] SQLite unavailable, keeping cases and the audit in memory: ${e.message}`);
    return { audit: new MemoryAudit(), cases: new MemoryCaseStore({ now }) };
  }
}

const { audit, cases } = await createStores();
// Simulated rows from an earlier run are demo leftovers; real cases stay.
const leftovers = cases.reset();
audit.reset();
if (leftovers) log(`[store] cleared ${leftovers} simulated case(s) from an earlier run`);

// ------------------------------------------------------------------------ flow

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

/** Real texts need a live server and an SMS number. Otherwise they appear on the console only. */
const sms = isSimulated() || !config.acs.smsFrom ? null : new AcsSmsLinkSender();

const flow = new ServiceAssistantFlow({
  requests,
  departments,
  content,
  geocoder,
  cases,
  emergency,
  bulkPickup,
  audit,
  transfer,
  sms,
  hub,
  now,
  offlineTexts: isSimulated(),
  // On a real call, let "I'm connecting you with … now" play before the transfer.
  options: { transferDelayMs: isSimulated() ? 0 : 2000 },
});

/**
 * Move the demo clock. Calls in progress shift by the same jump, so switching
 * to after hours mid-call does not blow that call's time budget.
 */
function setClock(at, preset) {
  const offsetMs = at == null ? 0 : at - Date.now();
  flow.rebaseClock(offsetMs - clockOffsetMs);
  clockOffsetMs = offsetMs;
  clockPreset = preset;
}

// A real call's five-minute budget is enforced even if the caller goes quiet.
// Simulated calls check it on the next turn, so a presenter can pause.
setInterval(() => {
  for (const call of flow.calls.values()) if (!call.simulated) flow.checkBudget(call.id);
}, 5000).unref();

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
  const fromPhone = data?.from?.rawId?.replace(/^4:/, "") ?? data?.from?.phoneNumber?.value ?? null;
  const call = flow.create({
    callId: randomUUID(),
    fromPhone,
    incomingCallContext: data.incomingCallContext,
    resourceAccountId: resourceAccountFrom(data?.to),
    // Keep an Auto Attendant's session id so the whole journey correlates in Teams.
    sessionId: data.customContext?.voipHeaders?.["CallDetails.SessionId"] ?? data.correlationId ?? null,
  });

  log("[call] incoming", call.id, "from", call.maskedPhone ?? "a withheld number", "via", call.arrival);
  const { callConnectionId } = await answerInboundCall({ incomingCallContext: data.incomingCallContext, callId: call.id });
  flow.setCallConnection(call.id, callConnectionId);
}

// --------------------------------------------------------------- ACS callbacks

const TONE_DIGITS = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", asterisk: "*", pound: "#" };

app.post(
  "/api/calls/callback",
  asyncRoute(async (req, res) => {
    res.sendStatus(200);
    const callId = req.query.call;

    for (const event of req.body ?? []) {
      const type = event.type?.split(".").pop();
      log("[acs]", type, callId);
      if (!flow.get(callId)) continue;

      switch (type) {
        case "CallConnected":
          flow.setCallConnection(callId, event.data?.callConnectionId);
          await startDtmfRecognition({ callConnectionId: event.data?.callConnectionId, fromPhone: flow.get(callId)?.fromPhone });
          break;

        case "ContinuousDtmfRecognitionToneReceived": {
          // ACS reports the tone by name; the flow takes the digit.
          const digit = TONE_DIGITS[event.data?.tone] ?? event.data?.tone;
          if (digit != null) handleUtterance(flow, callId, String(digit));
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
          // ACS accepted the transfer request, then nobody picked up. The caller is
          // still here: close honestly, once, rather than dial the queue again,
          // which would loop for as long as it kept failing.
          const message = event.data?.resultInformation?.message ?? "transfer failed";
          log("[call] transfer failed", callId, message);
          flow.transferFailed(callId, message);
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

// ------------------------------------------------------------------ simulation

/**
 * The offline demo. A typed transcript drives the same state machine, the same
 * emergency rule, the same geocoder, the same approved content and the same
 * handoff assembly as a real call — only the voice model and the audio path
 * are stubbed. A simulated call is never transferred and never texted for
 * real, even on a server that answers real calls.
 */
app.post(
  "/api/simulate",
  asyncRoute(async (req, res) => {
    const fromPhone = req.body?.fromPhone ? String(req.body.fromPhone).trim() : null;
    const call = flow.create({ fromPhone, simulated: true });
    registerSimulatedAgent(flow, call.id);
    flow.answered(call.id);
    const snapshot = await flow.settled(call.id);
    res.json({ ok: true, callId: call.id, snapshot });
  }),
);

/** Every turn waits for the flow to settle, so the reply carries the finished state. */
function simulateRoute(act) {
  return asyncRoute(async (req, res) => {
    const id = req.params.id;
    if (!flow.get(id)) return res.status(404).json({ error: "unknown call" });
    const result = await act(id, req.body ?? {}, res);
    if (res.headersSent) return;
    const snapshot = await flow.settled(id);
    res.json({ ok: true, result, snapshot });
  });
}

app.post("/api/simulate/:id/say", simulateRoute((id, body) => handleUtterance(flow, id, body.text ?? "")));

app.post(
  "/api/simulate/:id/dtmf",
  simulateRoute((id, body, res) => {
    const digit = String(body.digit ?? "").trim();
    if (!/^[0-9*#]$/.test(digit)) return res.status(400).json({ error: "Send one keypad digit: 0-9, * or #." });
    // 1 and 2 answer the question just asked; 0 and * work anywhere.
    return handleUtterance(flow, id, digit);
  }),
);

app.post("/api/simulate/:id/silence", simulateRoute((id) => flow.noInput(id)));

app.post(
  "/api/simulate/:id/hangup",
  simulateRoute(async (id) => {
    const result = flow.endCall(id, "caller_hung_up");
    await hangUp(flow.get(id)?.callConnectionId);
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
  timeZone: departments.timeZone,
  preset: clockPreset,
  presets: CLOCK_PRESETS.map(({ id, label }) => ({ id, label })),
  adjustable: isSimulated(),
});

const stats = () => audit.stats(cases.all());

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
 * A clean stage between run-throughs: no simulated calls, service requests or
 * texts, and the starting clock. Calls and cases from a real phone are kept,
 * and case numbering carries on from the last real one.
 */
app.post("/api/demo/reset", (_req, res) => {
  if (!simulationOnly(res)) return;
  const texts = flow.outbox.filter((t) => t.simulated).length;
  const calls = flow.reset();
  for (const id of calls) hub.forget(id);
  const removedCases = cases.reset();
  audit.reset();
  setClock(STARTING_CLOCK.at, STARTING_CLOCK.preset);
  log(`[demo] reset: ${calls.length} call(s), ${removedCases} service request(s), ${texts} text(s) cleared`);
  res.json({ ok: true, removed: { calls: calls.length, cases: removedCases, texts }, clock: clockView(), stats: stats() });
});

// ------------------------------------------------------------------ console API

app.get("/api/calls/:id", (req, res) => {
  const snap = flow.snapshot(req.params.id);
  return snap ? res.json(snap) : res.status(404).json({ error: "unknown call" });
});

app.get("/api/calls/:id/events", (req, res) => res.json(audit.eventsFor(req.params.id)));

/** Service requests without contact details: the console never needs them. */
app.get("/api/cases", (_req, res) => res.json(cases.all().map(({ contact, attachments, ...c }) => ({ ...c, updates: Boolean(contact?.wantsUpdates) }))));

app.post("/api/cases/:id/close", (req, res) => {
  const closed = cases.close(req.params.id);
  return closed ? res.json({ ok: true, id: closed.id, status: closed.status }) : res.status(404).json({ error: "unknown case" });
});

/** The texts the console's phone panel shows. Simulated ones were never sent. */
app.get("/api/sms", (_req, res) => res.json(flow.outbox));

app.get("/api/stats", (_req, res) => res.json(stats()));

app.post("/api/negotiate", (req, res) => res.json(hub.negotiate(req.body?.callId ?? "*")));

app.get("/health", (_req, res) => {
  const missing = assertCallConfig();
  res.json({
    ok: true,
    application: "311-service-assistant",
    mode: missing.length === 0 ? "live" : "simulation",
    callReady: missing.length === 0,
    missingConfig: missing,
    ...readiness({ content, departments, caseStore: cases, geocoder, now }),
    audit: { store: audit.name, persistTranscripts: config.persistTranscripts },
    realtime: hub.transport,
    texts: sms ? "acs-sms" : "simulated",
    settings: {
      callTimeBudgetMs: config.callTimeBudgetMs,
      maxRequestsPerCall: config.maxRequestsPerCall,
      duplicateRadiusM: config.duplicate.radiusM,
      duplicateWindowDays: config.duplicate.windowDays,
      transferDelayMs: flow.options.transferDelayMs,
    },
    clock: { preset: clockPreset, now: new Date(now()).toISOString() },
  });
});

// ----------------------------------------------------------------------- start

const server = createServer(app);

// One upgrade listener, routed by pathname: two WebSocketServers on one HTTP
// server would each abort the other's handshakes.
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
  log(`311 Service Assistant demo on http://${config.host}:${config.port}`);
  log(`  report types : ${requests.ids().join(", ")}`);
  log(`  stores       : cases ${cases.name}, audit ${audit.name}${config.persistTranscripts ? " (transcripts persisted)" : ""}`);
  log(`  texts        : ${sms ? "sent through ACS SMS" : "simulated on the console, never sent"}`);
  log(`  call budget  : ${config.callTimeBudgetMs / 1000}s, up to ${config.maxRequestsPerCall} requests per call`);

  const missing = assertCallConfig();
  if (missing.length) {
    log(`  SIMULATION MODE — set ${missing.join(", ")} to answer real calls`);
    if (clockPreset !== "real") log(`  demo clock   : ${new Date(now()).toISOString()} (${clockPreset})`);
  } else {
    log(`  voice model  : ${config.voiceLive.model} (WebSocket ${config.voiceLive.apiVersion})`);
    log(`  public URL   : ${config.publicBaseUrl}`);
  }
});
