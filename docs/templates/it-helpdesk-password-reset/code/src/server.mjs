import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { config, assertCallConfig, isSimulated, isPlaceholder } from "./config.mjs";
import { ResetFlow, maskPhone } from "./flow.mjs";
import { MemoryDirectory, MemoryTicketing, MemoryAudit } from "./store.mjs";
import { createHub } from "./realtime.mjs";
import { registerSimulatedAgent } from "./offline.mjs";
import { knowledgeBase, watchKnowledge } from "./knowledge.mjs";
import { attachMediaBridge, activeBridges } from "./voice/call-bridge.mjs";
import { placeResetCall, transferToServiceDesk, startDtmfRecognition } from "./voice/acs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const MISSING = assertCallConfig();
const SIMULATION = isSimulated();

// --------------------------------------------------------------------- storage

/**
 * Simulated calls only ever touch this sandbox: the two fictional Contoso
 * employees, in memory. Nothing a simulated call does can reach a real
 * directory, a real ticket queue or a real phone, even on a live server.
 */
const sandbox = { directory: new MemoryDirectory(), ticketing: new MemoryTicketing() };

/**
 * Where real calls read and write. SQLite (better-sqlite3, a native module)
 * loads only on a server that places real calls, so the offline demo starts
 * even where the native build failed. If it can't open, real calls fall back
 * to memory with one log line rather than a crash.
 */
async function createStorage() {
  if (SIMULATION) return { stores: sandbox, audit: new MemoryAudit() };
  try {
    const { openDb, SqliteAudit } = await import("./db.mjs");
    const db = await openDb();
    const { createDirectoryProvider } = await import("./providers/directory.mjs");
    const { createTicketingProvider } = await import("./providers/ticketing.mjs");
    const directory = createDirectoryProvider(undefined, { phone: config.demo.defaultPhone });
    if (directory.name === "sqlite" && !db.prepare("SELECT COUNT(*) AS n FROM users").get().n) {
      log(`[storage] the directory in ${config.dbPath} is empty; run \`npm run seed\` before requesting a reset`);
    }
    return { stores: { directory, ticketing: createTicketingProvider() }, audit: new SqliteAudit(db, { log }) };
  } catch (e) {
    log(`[storage] SQLite is unavailable (${e.message}); real calls use the in-memory directory and audit`);
    return {
      stores: { directory: new MemoryDirectory({ phone: config.demo.defaultPhone }), ticketing: new MemoryTicketing({ first: 8001 }) },
      audit: new MemoryAudit(),
    };
  }
}

const { stores, audit } = await createStorage();
const hub = await createHub({ connectionString: config.signalr.connectionString, hub: config.signalr.hub, log });

// ------------------------------------------------------------------ demo clock

/** The fictional Contoso office. Times in the audit trail are shown in this zone. */
const TIME_ZONE = "America/Los_Angeles";

/**
 * The clock every code expiry is judged on. Real time unless a demo moves it:
 * in simulation DEMO_NOW, or the console, can pin it, and jumping seven
 * minutes ahead lets the room watch a five-minute code expire without
 * waiting. A server placing real calls always uses the real time.
 */
const CLOCK_PRESETS = [
  // A Wednesday morning, at the start of the employee's shift.
  { id: "start-of-shift", label: "Start of shift", at: "2026-09-30T09:05:00-07:00" },
  { id: "seven-minutes-later", label: "7 minutes later", at: "2026-09-30T09:12:00-07:00" },
  { id: "real", label: "Real time", at: null },
];

function startingClock() {
  if (!config.demoNow) return { at: null, preset: "real" };
  if (!SIMULATION) {
    log("[clock] DEMO_NOW is ignored while placing real calls");
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

/**
 * Move the demo clock. Calls in progress feel the jump on purpose: a code read
 * at 9:05 is stale at 9:12, which is the point of the seven-minute preset.
 */
function setClock(at, preset) {
  clockOffsetMs = at == null ? 0 : at - Date.now();
  clockPreset = preset;
}

// ------------------------------------------------------------------- the flow

/**
 * The real transfer to the IT service desk in Teams. Absent in simulation, or
 * with no service desk configured, which is what makes the flow skip it.
 */
const SERVICE_DESK = !isPlaceholder(config.serviceDesk.id);
const transfer =
  SIMULATION || !SERVICE_DESK
    ? null
    : (s, { voipHeaders }) => transferToServiceDesk({ callConnectionId: s.callConnectionId, sessionId: s.id, voipHeaders });

const flow = new ResetFlow({
  stores,
  sandbox,
  audit,
  hub,
  now,
  log,
  options: { transfer, transferDelayMs: config.serviceDesk.transferDelayMs, timeZone: TIME_ZONE },
});

/** The offline agent standing in for Voice Live, per simulated call. */
const agents = new Map();

/**
 * The call connection currently live for each reset session. ACS delivers
 * callbacks for every call that ever ran against a session, so after a redial
 * a disconnect for the *previous* connection can still arrive; only the
 * current connection may end the call.
 */
const liveCall = new Map();

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use("/vendor/signalr", express.static(join(__dirname, "..", "node_modules", "@microsoft", "signalr", "dist", "browser")));
app.use(express.static(join(__dirname, "..", "public")));

const asyncRoute = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    log("route error", e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });

/** 404 for a session this server doesn't know. Returns the id, or null once it has answered. */
function known(req, res) {
  const id = req.params.id;
  if (flow.has(id)) return id;
  res.status(404).json({ error: "Unknown reset session." });
  return null;
}

// ------------------------------------------------------------------ sign-in page

/**
 * The sign-in page's "Sign in". A wrong username and a wrong password get the
 * same answer, so the page can't be used to find out who works here; only a
 * locked account says so, because that is what sends the employee to the reset.
 */
app.post(
  "/api/login",
  asyncRoute(async (req, res) => {
    const { username, password } = req.body ?? {};
    const result = await stores.directory.authenticate(username, password);
    res.json(
      result.ok
        ? { ok: true, user: { displayName: result.user.displayName } }
        : { ok: false, reason: result.reason === "locked" ? "locked" : "invalid" },
    );
  }),
);

// ------------------------------------------------------------------ reset flow

/**
 * A simulated callback: the agent "calls" the employee through Teams Phone
 * extensibility, the offline agent answers for Voice Live, and the console
 * plays the employee's phone. Nothing is dialed.
 */
async function simulateCallback(username, { restore = true } = {}) {
  // A scripted run starts from the fixture record (Alex locked, no password set), however often it runs.
  if (restore) sandbox.directory.restore(username);
  const snap = await flow.start({ username, simulated: true });
  if (!snap) return null;
  const id = snap.callId;
  const agent = registerSimulatedAgent(flow, id);
  agents.set(id, agent);
  await flow.run(id, () => flow.callbackSimulated(id));
  const result = await flow.run(id, () => agent.collect(() => flow.answered(id)));
  return { id, result };
}

/** Place (or re-place) the real outbound call for a session. */
async function placeCall(id, { redial = false } = {}) {
  const target = config.demo.defaultPhone;
  try {
    const { callConnectionId } = await placeResetCall({ sessionId: id, toPhoneNumber: target });
    if (callConnectionId) liveCall.set(id, callConnectionId);
    await flow.run(id, () => flow.callbackPlaced(id, { callConnectionId }));
    log(redial ? "[call] redial placed" : "[call] callback placed", callConnectionId, "->", maskPhone(target));
  } catch (e) {
    log("[call] could not place the call:", e.message);
    await flow.run(id, () => flow.callFailed(id, e.message));
  }
}

/** The "Forgot password?" click: open a session and call the employee back. */
app.post(
  "/api/reset/start",
  asyncRoute(async (req, res) => {
    const username = String(req.body?.username ?? "").trim();
    if (!username) return res.status(400).json({ error: "username is required" });

    if (SIMULATION) {
      const call = await simulateCallback(username, { restore: false });
      // Do not reveal whether an account exists.
      if (!call) return res.status(202).json({ ok: true, pending: true });
      const snap = flow.snapshot(call.id);
      return res.json({ ok: true, sessionId: call.id, callId: call.id, ticketId: snap.ticketId, simulated: true });
    }

    // The demo always dials the configured number, whatever the directory record holds.
    const via = config.acs.telephonyMode === "teams-phone" ? "Teams Phone extensibility" : "Azure Communication Services number";
    const snap = await flow.start({ username, phone: config.demo.defaultPhone, via });
    if (!snap) return res.status(202).json({ ok: true, pending: true });
    res.json({ ok: true, sessionId: snap.callId, callId: snap.callId, ticketId: snap.ticketId, callingNumber: maskPhone(config.demo.defaultPhone) });
    await placeCall(snap.callId);
  }),
);

app.get("/api/reset/:id", (req, res) => {
  const id = known(req, res);
  if (id) res.json(flow.snapshot(id));
});

/** The reset page sends the code the agent read aloud. */
app.post(
  "/api/reset/:id/code",
  asyncRoute(async (req, res) => {
    const id = known(req, res);
    if (id) res.json(await flow.run(id, () => flow.submitCode(id, String(req.body?.code ?? ""))));
  }),
);

/** Live policy feedback while the employee types, so the agent can coach. */
app.post(
  "/api/reset/:id/check-password",
  asyncRoute(async (req, res) => {
    const id = known(req, res);
    if (id) res.json(await flow.run(id, () => flow.checkPassword(id, String(req.body?.password ?? ""))));
  }),
);

app.post(
  "/api/reset/:id/password",
  asyncRoute(async (req, res) => {
    const id = known(req, res);
    if (id) res.json(await flow.run(id, () => flow.submitPassword(id, String(req.body?.password ?? ""))));
  }),
);

/** Redial after a dropped or prematurely ended call; the session resumes where it stopped. */
app.post(
  "/api/reset/:id/recall",
  asyncRoute(async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const snap = flow.snapshot(id);
    if (["completed", "escalated", "verification_failed"].includes(snap.state)) {
      return res.status(409).json({ error: "This reset is already finished." });
    }
    if (!snap.callEnded && snap.state !== "calling") return res.status(409).json({ error: "The call is still in progress." });

    if (snap.simulated) {
      const agent = registerSimulatedAgent(flow, id);
      agents.set(id, agent);
      await flow.run(id, async () => {
        flow.reopen(id);
        await flow.callbackSimulated(id);
      });
      await flow.run(id, () => agent.collect(() => flow.answered(id)));
      return res.json({ ok: true, simulated: true });
    }

    await flow.run(id, () => flow.reopen(id));
    res.json({ ok: true, callingNumber: maskPhone(config.demo.defaultPhone) });
    await placeCall(id, { redial: true });
  }),
);

/** "Talk to a person" on the reset page. */
app.post(
  "/api/reset/:id/escalate",
  asyncRoute(async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    await flow.run(id, () => flow.escalate(id, "user_requested"));
    res.json({ ok: true, snapshot: flow.snapshot(id) });
  }),
);

app.get("/api/reset/:id/events", (req, res) => {
  const id = known(req, res);
  if (id) res.json(flow.eventsFor(id));
});

// ------------------------------------------------------------------ simulation

/**
 * The offline demo. The console plays the employee's phone: what they say,
 * keypad presses, a noisy line, hanging up. The same state machine, the same
 * verification and password policy, and the same handoff assembly run as on a
 * real call; only the voice model and the audio path are stood in for. A
 * simulated call is never dialed or transferred, even on a live server.
 */
app.post(
  "/api/simulate",
  asyncRoute(async (req, res) => {
    const username = String(req.body?.username ?? "").trim() || "alex.morgan";
    const call = await simulateCallback(username);
    if (!call) return res.status(404).json({ error: `There is no demo employee "${username}".` });
    res.json({ ok: true, callId: call.id, snapshot: flow.snapshot(call.id), handset: flow.handset(call.id), result: call.result });
  }),
);

/** The simulated call behind `:id`, or null once a 404 or 403 has been sent. */
function simulatedCall(req, res) {
  const id = known(req, res);
  if (!id) return null;
  if (!flow.get(id).simulated) {
    res.status(403).json({ error: "That is a real call; the console can only play the phone on a simulated one." });
    return null;
  }
  let agent = agents.get(id);
  if (!agent) {
    agent = registerSimulatedAgent(flow, id);
    agents.set(id, agent);
  }
  return { id, agent };
}

/** A step on the employee's phone, run in the call's queue. Errors carry their HTTP status. */
const phone = (act) =>
  asyncRoute(async (req, res) => {
    const call = simulatedCall(req, res);
    if (!call) return;
    const { id, agent } = call;
    try {
      const result = await flow.run(id, () => act(agent, req.body ?? {}));
      res.json({ ok: true, result, snapshot: flow.snapshot(id), handset: flow.handset(id) });
    } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ error: e.message, snapshot: flow.snapshot(id) });
    }
  });

app.post("/api/simulate/:id/say", phone((agent, body) => agent.hear(String(body.text ?? ""))));
app.post("/api/simulate/:id/dtmf", phone((agent, body) => agent.press(String(body.digit ?? ""))));
app.post("/api/simulate/:id/silence", phone((agent) => agent.silence()));

app.post(
  "/api/simulate/:id/hangup",
  asyncRoute(async (req, res) => {
    const call = simulatedCall(req, res);
    if (!call) return;
    const { id, agent } = call;
    // Idempotent: hanging up a call that has already ended is not an error.
    if (flow.get(id).callEnded) return res.json({ ok: true, snapshot: flow.snapshot(id), handset: null });
    const result = await flow.run(id, () => agent.hangup());
    res.json({ ok: true, result, snapshot: flow.snapshot(id), handset: null });
  }),
);

/** What the simulated phone last heard: the code the agent read aloud. Simulation only. */
app.get("/api/simulate/:id/handset", (req, res) => {
  const call = simulatedCall(req, res);
  if (call) res.json({ handset: flow.handset(call.id) });
});

/**
 * The browser side of a simulated call, for the console's mock reset page.
 * The same flow methods the real reset page reaches through /api/reset/:id/*,
 * with what the agent said in reply.
 */
const portal = (act) =>
  asyncRoute(async (req, res) => {
    const call = simulatedCall(req, res);
    if (!call) return;
    const { id, agent } = call;
    let out = null;
    const result = await flow.run(id, () =>
      agent.collect(async () => {
        out = await act(id, req.body ?? {});
      }),
    );
    res.json({ ok: true, result: out, said: result.said, tools: result.tools, snapshot: flow.snapshot(id), handset: flow.handset(id) });
  });

app.post("/api/simulate/:id/portal/code", portal((id, body) => flow.submitCode(id, String(body.code ?? ""))));
app.post("/api/simulate/:id/portal/check", portal((id, body) => flow.checkPassword(id, String(body.password ?? ""))));
app.post("/api/simulate/:id/portal/password", portal((id, body) => flow.submitPassword(id, String(body.password ?? ""))));

// --------------------------------------------------------------- demo controls

/** Demo controls refuse to touch a server that is placing real calls. */
function simulationOnly(res) {
  if (SIMULATION) return true;
  res.status(403).json({ error: "Demo controls are off while this server answers real calls." });
  return false;
}

const clockView = () => ({
  now: new Date(now()).toISOString(),
  timeZone: TIME_ZONE,
  preset: clockPreset,
  presets: CLOCK_PRESETS.map(({ id, label }) => ({ id, label })),
  adjustable: SIMULATION,
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
 * A clean stage between run-throughs: no simulated calls in memory, the two
 * employees back to their fixture records, ticket numbers from the start, no
 * simulated sessions in the audit (a real call's record is kept), and the
 * starting clock.
 */
app.post("/api/demo/reset", (_req, res) => {
  if (!simulationOnly(res)) return;
  for (const id of flow.reset()) {
    hub.forget(id);
    agents.delete(id);
    liveCall.delete(id);
  }
  sandbox.directory.reset();
  sandbox.ticketing.reset();
  audit.reset();
  setClock(STARTING_CLOCK.at, STARTING_CLOCK.preset);
  log("[demo] reset");
  res.json({ ok: true, clock: clockView(), stats: audit.stats() });
});

// ------------------------------------------------------------------ console API

app.get("/api/calls/:id", (req, res) => {
  const snap = flow.snapshot(req.params.id);
  return snap ? res.json(snap) : res.status(404).json({ error: "Unknown call." });
});

app.get("/api/calls/:id/events", (req, res) => {
  const id = known(req, res);
  if (id) res.json(flow.eventsFor(id));
});

app.get("/api/stats", (_req, res) => res.json(audit.stats()));

/** Where a page listens for one session's updates (`*` hears every call). */
app.post("/api/negotiate", (req, res) => res.json(hub.negotiate(String(req.body?.sessionId ?? req.body?.callId ?? "*"))));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    mode: SIMULATION ? "simulation" : "live",
    callReady: !SIMULATION,
    missingConfig: MISSING,
    realtime: hub.transport,
    directory: stores.directory.name,
    ticketing: stores.ticketing.name,
    audit: audit.name,
    voiceModel: config.voiceLive.model,
    telephonyMode: config.acs.telephonyMode,
    serviceDesk: SERVICE_DESK,
    knowledge: knowledgeBase().entries.length,
    policy: {
      codeTtlMs: flow.options.codeTtlMs,
      maxIdentityAttempts: flow.options.maxIdentityAttempts,
      maxCodeAttempts: flow.options.maxCodeAttempts,
      maxCodes: flow.options.maxCodes,
      maxSkipRequests: flow.options.maxSkipRequests,
      transferDelayMs: flow.options.transferDelayMs,
    },
    clock: { preset: clockPreset, now: new Date(now()).toISOString() },
  });
});

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
  pound: "#",
  asterisk: "*",
};

app.post(
  "/api/calls/callback",
  asyncRoute(async (req, res) => {
    res.sendStatus(200);
    const id = String(req.query.session ?? "");
    const events = Array.isArray(req.body) ? req.body : [req.body];

    for (const event of events) {
      const type = String(event?.type ?? "").split(".").pop();
      const ccid = event?.data?.callConnectionId ?? null;
      log("[acs]", type, id);
      if (!flow.has(id)) continue;
      const current = !ccid || !liveCall.has(id) || liveCall.get(id) === ccid;

      switch (type) {
        case "CallConnected":
          if (ccid) liveCall.set(id, ccid);
          flow.get(id).callConnectionId = ccid;
          await startDtmfRecognition({ callConnectionId: ccid, phoneNumber: flow.get(id).phone });
          break;

        case "ContinuousDtmfRecognitionToneReceived": {
          if (!current) break;
          // ACS reports the tone by name; the flow takes the key.
          const digit = TONE_DIGITS[event.data?.tone] ?? event.data?.tone;
          if (/^[0-9*#]$/.test(String(digit ?? ""))) await flow.run(id, () => flow.keypad(id, String(digit)));
          break;
        }

        case "CallTransferAccepted":
          log("[call] transfer accepted", id);
          await flow.run(id, () => flow.endCall(id, "transferred"));
          break;

        case "CallTransferFailed":
          log("[call] transfer failed", event.data?.resultInformation?.message ?? "");
          await flow.run(id, () => flow.transferFailed(id, event.data?.resultInformation?.message));
          break;

        case "CallDisconnected":
          if (!ccid || liveCall.get(id) !== ccid) {
            log("[call] ignoring a disconnect for an earlier call", ccid);
            break;
          }
          liveCall.delete(id);
          await flow.run(id, () => flow.endCall(id, "caller_hung_up"));
          await activeBridges.get(id)?.stop("caller_hung_up");
          break;

        case "CreateCallFailed":
          if (!current) break;
          liveCall.delete(id);
          await flow.run(id, () => flow.callFailed(id, event.data?.resultInformation?.message ?? "The call could not be placed."));
          break;

        case "MediaStreamingFailed": {
          // Without the reason this reads as "it broke", which is how a socket
          // that never connected can look like a Voice Live problem.
          const info = event.data?.resultInformation ?? {};
          log("[call] media streaming failed", `code=${info.code} sub=${info.subCode}`, info.message ?? "");
          break;
        }
      }
    }
  }),
);

// ----------------------------------------------------------------------- start

const server = createServer(app);

// One upgrade listener, routed by pathname: two WebSocketServers attached to
// one HTTP server abort each other's handshakes.
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
  log(`[server] ${e.code === "EADDRINUSE" ? `port ${config.port} is already in use` : e.message}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const base = `http://${config.host}:${config.port}`;
  log(`IT help desk password reset demo on ${base}`);
  log(`  presenter console  : ${base}/`);
  log(`  reset page         : ${base}/portal.html`);
  log(`  realtime transport : ${hub.transport}`);
  log(`  directory / audit  : ${stores.directory.name} / ${audit.name}`);
  log(`  knowledge base     : ${knowledgeBase().entries.length} approved answers`);
  log(`  code lifetime      : ${Math.round(flow.options.codeTtlMs / 60_000)} minutes`);

  if (SIMULATION) {
    log(`  SIMULATION MODE    — set ${MISSING.join(", ")} to place real calls`);
    if (clockPreset !== "real") log(`  demo clock         : ${new Date(now()).toISOString()} (${clockPreset})`);
  } else {
    log(`  voice model        : ${config.voiceLive.model} (WebSocket ${config.voiceLive.apiVersion})`);
    log(`  telephony          : ${config.acs.telephonyMode}`);
    log(`  public base URL    : ${config.publicBaseUrl}`);
    log(`  service desk       : ${SERVICE_DESK ? `Teams ${config.serviceDesk.kind}` : "not configured; the agent ends the call after a handoff"}`);
  }
  watchKnowledge();
});
