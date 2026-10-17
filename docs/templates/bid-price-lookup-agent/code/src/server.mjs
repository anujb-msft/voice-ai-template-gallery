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
import { answerInboundCall, transferToTeams, startDtmfRecognition } from "./voice/acs.mjs";
import { resourceAccountFrom, buildCustomCallingContext } from "./handoff.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const normalizePhone = (phone) => String(phone ?? "").replace(/[^\d+]/g, "");

/**
 * SQLite is loaded only when it is actually going to be used. better-sqlite3 is
 * a native module, so keeping it off the offline path means the demo still
 * starts if its build step failed on an unusual platform.
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
const hub = createHub();

// ------------------------------------------------------------------ demo clock

/**
 * The business clock: the time the pricing policy sees. Freshness, the futures
 * session and the merchandisers' hours are all judged on it. A posted price is
 * only current for minutes, so in simulation the clock is pinned rather than
 * running (a fresh fixture stays fresh however long the presenter talks) and
 * the console moves it between presets. DEMO_NOW sets where it starts. A server
 * answering real calls always prices on the real time.
 */
const CLOCK_PRESETS = [
  // Tuesday, September 8, 2026: the fixtures' trading day, the morning after the Labor Day holiday.
  { id: "prices-fresh", label: "Prices fresh", at: "2026-09-08T10:45:00-05:00" },
  { id: "prices-stale", label: "Prices stale", at: "2026-09-08T11:20:00-05:00" },
  { id: "after-close", label: "Market closed", at: "2026-09-08T14:00:00-05:00" },
  { id: "after-hours", label: "After hours", at: "2026-09-08T18:30:00-05:00" },
  { id: "real", label: "Real time", at: null },
];
const DEFAULT_PRESET = "prices-fresh";

function presetClock(id) {
  const preset = CLOCK_PRESETS.find((p) => p.id === id);
  return { at: preset.at == null ? null : Date.parse(preset.at), preset: preset.id };
}

const presetAt = (at) => CLOCK_PRESETS.find((p) => p.at && Date.parse(p.at) === at)?.id ?? "custom";

function startingClock() {
  const value = config.pricing.demoNow;
  if (!isSimulated()) {
    if (value) log("[clock] DEMO_NOW is ignored while answering real calls");
    return presetClock("real");
  }
  // The fixtures are dated, so a demo without DEMO_NOW starts on the morning they are fresh.
  if (!value) return presetClock(DEFAULT_PRESET);
  if (CLOCK_PRESETS.some((p) => p.id === value)) return presetClock(value);
  const at = Date.parse(value);
  if (!Number.isFinite(at)) {
    log(`[clock] DEMO_NOW "${value}" is neither a preset nor an ISO 8601 time; starting at ${DEFAULT_PRESET}`);
    return presetClock(DEFAULT_PRESET);
  }
  return { at, preset: presetAt(at) };
}

const STARTING_CLOCK = startingClock();
let businessAt = STARTING_CLOCK.at;
let clockPreset = STARTING_CLOCK.preset;
const businessNow = () => new Date(businessAt ?? Date.now());

function setClock({ at, preset }) {
  businessAt = at;
  clockPreset = preset;
}

// --------------------------------------------------------------------- pricing

const feed = new FixtureFeed();
const priceBook = new PriceBook({ locations: LocationDirectory.load(), feed, now: businessNow });
const timeZone = feed.getMarket().timeZone ?? "America/Chicago";

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

// The flow's own stopwatch stays on the real time (call budgets); prices and hours use the business clock.
const flow = new BidLookupFlow({ priceBook, audit, transfer, hub: flowHub });
const stats = () => audit.stats({ minutesPerAutomatedCall: config.pricing.minutesPerAutomatedCall });

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
      await onIncomingCall(event.data).catch((e) => log("[eventgrid] answer failed", e));
    }
  }),
);

async function onIncomingCall(data) {
  const fromPhone = data?.from?.rawId?.replace(/^4:/, "") ?? data?.from?.phoneNumber?.value ?? null;

  const call = flow.create({
    callId: randomUUID(),
    fromPhone: fromPhone ? normalizePhone(fromPhone) : null,
    incomingCallContext: data.incomingCallContext,
    resourceAccountId: resourceAccountFrom(data?.to),
    // Preserve an Auto Attendant's session id when this line sits behind one,
    // so the whole journey correlates in Teams rather than restarting here.
    sessionId: data.customContext?.voipHeaders?.["CallDetails.SessionId"] ?? data.correlationId ?? null,
  });

  log("[call] incoming", call.id, "from", call.maskedPhone, "via", call.arrival);
  if (call.arrival === "acs-direct") {
    log("[call] note: no Teams resource account on this call — Teams Phone extensibility context is absent");
  }

  const { callConnectionId } = await answerInboundCall({ incomingCallContext: data.incomingCallContext, callId: call.id });
  flow.setCallConnection(call.id, callConnectionId);
}

// --------------------------------------------------------------- ACS callbacks

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
          // ACS reports the tone by name; the flow takes the key the caller pressed.
          const digit = TONE_DIGITS[event.data?.tone] ?? event.data?.tone;
          if (digit != null) flow.dtmf(callId, String(digit));
          activeBridges.get(callId)?.closeIfEnded();
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
          // Nobody picked up. The caller is still with the agent, so the flow
          // reopens the call and offers a callback instead of leaving silence.
          const message = event.data?.resultInformation?.message ?? "The merchandiser could not be reached";
          log("[call] transfer failed", callId, message);
          flow.transferFailed(callId, message);
          // With no caller ID there's no callback to offer, so the flow says goodbye and ends the call.
          activeBridges.get(callId)?.closeIfEnded();
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
 * price book, the same freshness policy and the same handoff assembly as a real
 * call; only the model and the audio path are stubbed. A simulated call is never
 * transferred for real, even on a server that answers real calls.
 */
app.post(
  "/api/simulate",
  asyncRoute(async (req, res) => {
    const fromPhone = req.body?.fromPhone ? normalizePhone(req.body.fromPhone) : null;
    const call = flow.create({ fromPhone, simulated: true });
    registerSimulatedAgent(flow, call.id);
    flow.answered(call.id);
    res.json({ ok: true, callId: call.id, snapshot: flow.snapshot(call.id) });
  }),
);

/** The simulate routes drive simulated calls only; a real call's id is not theirs to type into. */
const simulatedRoute = (act) =>
  asyncRoute(async (req, res) => {
    const id = req.params.id;
    if (!flow.get(id)?.simulated) return res.status(404).json({ error: "unknown call" });
    const result = act(id, req.body ?? {});
    await flow.settled(id);
    res.json({ ok: true, result, snapshot: flow.snapshot(id) });
  });

app.post("/api/simulate/:id/say", simulatedRoute((id, body) => handleUtterance(flow, id, String(body.text ?? ""))));
app.post("/api/simulate/:id/dtmf", simulatedRoute((id, body) => flow.dtmf(id, String(body.digit ?? ""))));
app.post("/api/simulate/:id/silence", simulatedRoute((id) => flow.noInput(id)));
app.post("/api/simulate/:id/hangup", simulatedRoute((id) => flow.endCall(id, "caller_hung_up")));

// ----------------------------------------------------------------- demo controls

/** Demo controls refuse to touch a server that is answering real calls. */
function simulationOnly(res) {
  if (isSimulated()) return true;
  res.status(403).json({ error: "Demo controls are off while this server answers real calls." });
  return false;
}

const clockView = () => ({
  now: businessNow().toISOString(),
  timeZone,
  preset: clockPreset,
  presets: CLOCK_PRESETS.map(({ id, label }) => ({ id, label })),
  adjustable: isSimulated(),
  // Pinned: the business clock stands still until a preset moves it.
  pinned: businessAt != null,
  marketState: priceBook.marketState(businessNow()),
});

app.get("/api/demo/clock", (_req, res) => res.json(clockView()));

app.post("/api/demo/clock", (req, res) => {
  if (!simulationOnly(res)) return;
  const { preset, at } = req.body ?? {};
  if (preset != null) {
    if (!CLOCK_PRESETS.some((p) => p.id === preset)) return res.status(400).json({ error: `Unknown clock preset "${preset}".` });
    setClock(presetClock(preset));
  } else if (at != null) {
    const parsed = typeof at === "string" ? Date.parse(at) : NaN;
    if (!Number.isFinite(parsed)) return res.status(400).json({ error: `"${at}" is not an ISO 8601 timestamp.` });
    setClock({ at: parsed, preset: presetAt(parsed) });
  } else {
    return res.status(400).json({ error: "Send { preset } or { at }." });
  }
  log(`[clock] demo clock → ${clockPreset} (${businessNow().toISOString()})`);
  res.json(clockView());
});

const feedView = () => ({ ok: true, feed: { up: !feed.isDown }, adjustable: isSimulated(), health: priceBook.health() });

app.get("/api/demo/feed", (_req, res) => res.json(feedView()));

/** Take the fixture price feed down (or bring it back) to show the no-number fallback. */
app.post("/api/demo/feed", (req, res) => {
  if (!simulationOnly(res)) return;
  const up = req.body?.up;
  if (typeof up !== "boolean") return res.status(400).json({ error: "Send { up: true } or { up: false }." });
  feed.setFeedDown(!up);
  log(`[demo] price feed ${up ? "restored" : "marked down"}`);
  res.json(feedView());
});

/**
 * A clean stage between run-throughs: no calls in memory, no simulated calls in
 * the audit (calls from a real phone are kept), the starting clock, and the
 * price feed up.
 */
app.post("/api/demo/reset", (_req, res) => {
  if (!simulationOnly(res)) return;
  for (const id of flow.calls.keys()) hub.forget(id);
  flow.reset();
  audit.reset();
  setClock(STARTING_CLOCK);
  feed.setFeedDown(false);
  log("[demo] reset");
  res.json({ ok: true, clock: clockView(), feed: { up: !feed.isDown }, stats: stats() });
});

// ------------------------------------------------------------------ console API

app.get("/api/locations", (_req, res) => {
  const at = businessNow();
  const directory = priceBook.locations;
  res.json({
    organization: directory.organization,
    timeZone,
    marketState: priceBook.marketState(at),
    // Teams object ids stay on the server: the console gets a name and a kind,
    // nothing it could dial. Open or closed is judged on the business clock,
    // the time the transfer decision uses.
    locations: directory.all().map((l) => ({
      id: l.id,
      displayName: l.displayName,
      open: directory.isMerchandiserOpen(l.id, at),
      hours: directory.hoursLabel(l.id),
      merchandiser: { displayName: l.merchandiser?.displayName ?? null, type: l.merchandiser?.type ?? null },
    })),
  });
});

app.get("/api/bid-board", (_req, res) => {
  const board = (commodity) => priceBook.list({ commodity }).quotes ?? [];
  res.json({ at: businessNow().toISOString(), health: priceBook.health(), corn: board("corn"), soybeans: board("soybeans"), wheat: board("wheat") });
});

app.get("/api/calls/:id", (req, res) => {
  const snap = flow.snapshot(req.params.id);
  return snap ? res.json(snap) : res.status(404).json({ error: "unknown call" });
});

app.get("/api/calls/:id/events", (req, res) => res.json(audit.eventsFor(req.params.id)));

app.get("/api/stats", (_req, res) => res.json(stats()));

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
    pricing: {
      source: config.pricing.feed,
      futuresStaleMinutes: priceBook.options.softStaleMinutes,
      futuresHardLimitMinutes: priceBook.options.hardLimitMinutes,
      callTimeBudgetMs: flow.options.callTimeBudgetMs,
      // The presenter's narration between lines is not caller time.
      budgetAppliesToSimulatedCalls: false,
    },
    clock: { preset: clockPreset, now: businessNow().toISOString(), pinned: businessAt != null },
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
  log(`Bid / price lookup demo on http://${config.host}:${config.port}`);
  log(`  organization       : ${priceBook.locations.organization}`);
  log(`  locations          : ${priceBook.locations.names().join(", ")}`);
  log(`  audit              : ${audit.name}${config.persistTranscripts ? " (transcripts persisted)" : ""}`);
  log(`  freshness window   : ${priceBook.options.softStaleMinutes} min (hard limit ${priceBook.options.hardLimitMinutes} min)`);
  log(`  call time budget   : ${flow.options.callTimeBudgetMs / 1000}s (real calls)`);

  const missing = assertCallConfig();
  if (missing.length) {
    log(`  SIMULATION MODE    — set ${missing.join(", ")} to answer real calls`);
    log(`  demo clock         : ${businessNow().toISOString()} (${clockPreset}${businessAt != null ? ", pinned" : ""})`);
  } else {
    log(`  voice model        : ${config.voiceLive.model} (WebSocket ${config.voiceLive.apiVersion})`);
    log(`  public base URL    : ${config.publicBaseUrl}`);
  }
});
