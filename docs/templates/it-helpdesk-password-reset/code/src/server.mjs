import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { knowledgeBase, watchKnowledge } from "./knowledge.mjs";
import { config, assertCallConfig } from "./config.mjs";
import { db } from "./db.mjs";
import { createDirectoryProvider } from "./providers/directory.mjs";
import { createTicketingProvider } from "./providers/ticketing.mjs";
import { createHub } from "./realtime.mjs";
import { ResetFlow } from "./flow.mjs";
import { attachMediaBridge, activeBridges } from "./voice/call-bridge.mjs";
import { placeResetCall } from "./voice/acs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const directory = createDirectoryProvider();
const ticketing = createTicketingProvider();
const hub = createHub();
const flow = new ResetFlow({ directory, ticketing, hub });

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(
  "/vendor/signalr",
  express.static(join(__dirname, "..", "node_modules", "@microsoft", "signalr", "dist", "browser")),
);
app.use(express.static(join(__dirname, "..", "public")));

const asyncRoute = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    log("route error", e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });

// ------------------------------------------------------------------ sign-in UI

app.post(
  "/api/login",
  asyncRoute(async (req, res) => {
    const { username, password } = req.body ?? {};
    const result = await directory.authenticate(username, password);
    res.json(
      result.ok
        ? { ok: true, user: { displayName: result.user.displayName } }
        : { ok: false, reason: result.reason },
    );
  }),
);

/**
 * The call connection currently live for each reset session.
 *
 * ACS delivers callbacks for every call that ever ran against this session, so a
 * redial means a disconnect for the *previous* connection can still arrive. The
 * wizard must only react to the connection it is actually on, otherwise a stale
 * event tears down a perfectly healthy call in the UI.
 */
const liveCall = new Map();

// ----------------------------------------------------------------- reset flow

/** The "Forgot password?" click: open a session and call the employee back. */
app.post(
  "/api/reset/start",
  asyncRoute(async (req, res) => {
    const username = req.body?.username?.trim();
    if (!username) return res.status(400).json({ error: "username is required" });

    const user = await directory.findByUsername(username);
    // Do not leak whether an account exists.
    if (!user) return res.status(202).json({ ok: true, pending: true });

    const { id: sessionId, ticketId } = await flow.create(user);

    // The demo always dials the configured number regardless of the directory
    // record, so it can be run safely against seeded sample users.
    const target = config.demo.defaultPhone || user.phone;

    const missing = assertCallConfig();
    if (missing.length) {
      log("call config incomplete, running in simulation mode:", missing.join(", "));
      res.json({ ok: true, sessionId, ticketId, simulated: true, missing });
      return;
    }

    res.json({ ok: true, sessionId, ticketId, callingNumber: maskPhone(target) });

    try {
      const { callConnectionId } = await placeResetCall({ sessionId, toPhoneNumber: target });
      liveCall.set(sessionId, callConnectionId);
      log("outbound call placed", callConnectionId, "->", maskPhone(target));
    } catch (e) {
      log("failed to place call", e);
      await hub.send(sessionId, "callFailed", { message: e.message });
    }
  }),
);

app.get(
  "/api/reset/:id",
  asyncRoute(async (req, res) => {
    const snap = await flow.snapshot(req.params.id);
    if (!snap) return res.status(404).json({ error: "unknown session" });
    res.json(snap);
  }),
);

/** Browser types the code the agent read aloud. */
app.post(
  "/api/reset/:id/code",
  asyncRoute(async (req, res) => res.json(await flow.submitCode(req.params.id, req.body?.code))),
);

/** Live policy feedback while typing, so the agent can coach in real time. */
app.post(
  "/api/reset/:id/check-password",
  asyncRoute(async (req, res) => res.json(await flow.checkPassword(req.params.id, req.body?.password))),
);

app.post(
  "/api/reset/:id/password",
  asyncRoute(async (req, res) => res.json(await flow.submitPassword(req.params.id, req.body?.password))),
);

/** Redial after a dropped or prematurely ended call, resuming the same session. */
app.post(
  "/api/reset/:id/recall",
  asyncRoute(async (req, res) => {
    const sessionId = req.params.id;
    const snap = await flow.snapshot(sessionId);
    if (!snap) return res.status(404).json({ error: "unknown session" });
    if (["completed", "escalated"].includes(snap.state)) {
      return res.status(409).json({ error: "session is already finished" });
    }

    const missing = assertCallConfig();
    if (missing.length) return res.json({ ok: true, simulated: true, missing });

    const target = config.demo.defaultPhone;
    try {
      const { callConnectionId } = await placeResetCall({ sessionId, toPhoneNumber: target });
      liveCall.set(sessionId, callConnectionId);
      log("redial placed", callConnectionId, "->", maskPhone(target));
      // Resume at the step the caller dropped out of.
      await flow.transition(sessionId, snap.state, "redial");
      res.json({ ok: true, callingNumber: maskPhone(target) });
    } catch (e) {
      log("redial failed", e);
      res.status(502).json({ error: e.message });
    }
  }),
);

app.post(
  "/api/reset/:id/escalate",
  asyncRoute(async (req, res) => {
    await flow.escalate(req.params.id, req.body?.reason ?? "user_requested");
    res.json({ ok: true });
  }),
);

// -------------------------------------------------------------------- realtime

app.post(
  "/api/negotiate",
  asyncRoute(async (req, res) => {
    const sessionId = req.body?.sessionId;
    if (!sessionId) return res.status(400).json({ error: "sessionId is required" });
    res.json(hub.negotiate(sessionId));
  }),
);

// --------------------------------------------------------------- ACS callbacks

app.post(
  "/api/calls/callback",
  asyncRoute(async (req, res) => {
    const sessionId = req.query.session;
    for (const event of req.body ?? []) {
      log("acs event", event.type, "session", sessionId);
      const bridge = activeBridges.get(sessionId);
      const callId = event.data?.callConnectionId;

      if (event.type === "Microsoft.Communication.CallConnected" && callId) {
        liveCall.set(sessionId, callId);
      }
      if (bridge && callId) bridge.callConnectionId = callId;

      // Ignore callbacks belonging to any call other than the one in progress.
      const isLiveCall = Boolean(callId) && liveCall.get(sessionId) === callId;

      if (event.type === "Microsoft.Communication.CallDisconnected") {
        if (!isLiveCall) {
          log("ignoring disconnect for stale call", callId, "session", sessionId);
          continue;
        }
        liveCall.delete(sessionId);
        bridge?.stop();
        // If the caller hung up (or the call dropped) before finishing, offer a
        // redial rather than stranding the wizard mid-flow.
        const snap = await flow.snapshot(sessionId);
        const resumable = Boolean(snap) && !["completed", "escalated"].includes(snap.state);
        await hub.send(sessionId, "callEnded", {
          resumable,
          state: snap?.state ?? null,
          label: snap?.label ?? null,
          callbackNumber: maskPhone(config.demo.defaultPhone),
        });
      }
      if (event.type === "Microsoft.Communication.CreateCallFailed" && isLiveCall) {
        liveCall.delete(sessionId);
        await hub.send(sessionId, "callFailed", { message: event.data?.resultInformation?.message ?? "call failed" });
      }
    }
    res.sendStatus(200);
  }),
);

// ---------------------------------------------------------------- demo metrics

app.get(
  "/api/stats",
  asyncRoute(async (_req, res) => res.json(await ticketing.deflectionStats())),
);

app.get(
  "/api/reset/:id/events",
  asyncRoute(async (req, res) =>
    res.json(
      db
        .prepare("SELECT source, kind, detail, created_at FROM session_events WHERE session_id = ? ORDER BY id")
        .all(req.params.id),
    ),
  ),
);

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    realtime: hub.transport,
    directory: directory.name,
    ticketing: ticketing.name,
    voiceModel: config.voiceLive.model,
    callReady: assertCallConfig().length === 0,
  }),
);

function maskPhone(p) {
  return String(p).replace(/^(\+\d{1,2})(\d+)(\d{4})$/, (_m, a, b, c) => `${a}${"•".repeat(b.length)}${c}`);
}

const server = createServer(app);
hub.attach?.(server);
attachMediaBridge(server, flow);

server.listen(config.port, config.host, () => {
  log(`IT help desk password reset demo on http://${config.host}:${config.port}`);
  log(`  realtime transport : ${hub.transport}`);
  log(`  voice model        : ${config.voiceLive.model} (WebSocket)`);
  log(`  agent FAQ answers  : ${knowledgeBase().entries.length}`);
  watchKnowledge();
  const missing = assertCallConfig();
  if (missing.length) log(`  SIMULATION MODE — set ${missing.join(", ")} to place real calls`);
  else log(`  public base URL    : ${config.publicBaseUrl}`);
});
