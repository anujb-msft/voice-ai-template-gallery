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
import { resourceAccountFrom } from "./handoff.mjs";

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

const flow = new RoutingFlow({ routes, callers, audit, transfer, hub });

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

        case "CallTransferFailed":
          // The flow already owns the retry ladder, so re-enter it rather than
          // improvising a second recovery path here.
          log("[call] transfer failed", event.data?.resultInformation?.message);
          flow.get(callId) && (flow.get(callId).dispatched = false);
          await flow.dispatchTransfer(callId).catch((e) => log("[call] recovery failed", e.message));
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
 * real call — only the classifier and the audio path are stubbed.
 */
app.post(
  "/api/simulate",
  asyncRoute(async (req, res) => {
    const fromPhone = req.body?.fromPhone ? normalisePhone(req.body.fromPhone) : null;
    const call = flow.create({ fromPhone });
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

// ------------------------------------------------------------------ console API

app.get("/api/routes", (_req, res) =>
  res.json({
    organization: routes.organization,
    fallbackRouteId: routes.fallbackRouteId,
    // Targets are deliberately withheld: the console has no business knowing
    // Teams object ids, and neither does anything else outside routes.json.
    routes: routes.menu().map((r) => ({ ...r, open: routes.isOpen(r.id) })),
  }),
);

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
      transferDelayMs: config.routing.transferDelayMs,
    },
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
  } else {
    log(`  voice model        : ${config.voiceLive.model} (WebSocket ${config.voiceLive.apiVersion})`);
    log(`  public base URL    : ${config.publicBaseUrl}`);
  }
});
