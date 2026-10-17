/**
 * Boots the server in simulation mode and checks what the unit suite cannot
 * see: that both WebSocket endpoints accept an upgrade, that the hub carries a
 * call to the console the way the console expects, and that the demo controls
 * answer.
 *
 * The transport checks exist because the upgrades once did not work. Two
 * WebSocketServers were attached to the same HTTP server, and `ws` aborts the
 * handshake for any path a given server does not own, so the presenter hub,
 * registered first, destroyed every media socket. ACS reported only
 * "MediaStreamingFailed", the call connected and then sat in silence, and the
 * unit tests could not catch it: they deliberately never start Express or `ws`.
 */
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

// The demo port plus 100, so a smoke run never collides with a running demo.
const PORT = 8193;
const server = spawn(process.execPath, ["src/server.mjs"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    DB_PATH: ":memory:",
    ACS_ENDPOINT: "",
    ACS_CONNECTION_STRING: "",
    VOICE_LIVE_ENDPOINT: "",
    PUBLIC_BASE_URL: "",
    DEMO_NOW: "",
    // Long enough to see the "paging" stage, short enough to keep the run quick.
    PAGE_WINDOW_MS: "300",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
server.stdout.on("data", (d) => (out += d));
server.stderr.on("data", (d) => (out += d));

const stop = () => server.kill();
process.on("exit", stop);

let failed = false;
function check(ok, label) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForListen(timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000)) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`server did not start in ${timeoutMs}ms:\n${out}`);
}

async function until(test, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (test()) return true;
    await sleep(50);
  }
  return false;
}

function upgrades(path) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
    const done = (v) => { try { ws.close(); } catch {} resolve(v); };
    ws.on("open", () => done(true));
    ws.on("unexpected-response", () => done(false));
    ws.on("error", () => done(false));
    setTimeout(() => done(false), 10_000);
  });
}

/** Subscribes to every call, as the presenter console does, and keeps each frame. */
function watchHub() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/hub?user=*`);
    const frames = [];
    ws.on("message", (data) => {
      const { target, arguments: [payload] = [] } = JSON.parse(String(data));
      frames.push({ target, payload });
    });
    ws.on("open", () => resolve({
      of: (callId, target) => frames.filter((f) => f.target === target && f.payload?.callId === callId).map((f) => f.payload),
      close: () => ws.close(),
    }));
    ws.on("error", reject);
  });
}

async function api(path, body) {
  const init =
    body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  return { status: r.status, body: await r.json().catch(() => null) };
}

await waitForListen();

// --------------------------------------------------------------- transport

for (const path of ["/ws/hub", "/ws/media"]) check(await upgrades(path), `upgrade ${path}`);
// An unknown path must be refused, not quietly upgraded.
check(!(await upgrades("/ws/nope")), "refuse  /ws/nope");

// ----------------------------------------------------------- the demo clock

const health = await api("/health");
check(health.body?.mode === "simulation" && health.body?.callReady === false, "health  simulation mode with no Azure settings");

const clock = await api("/api/demo/clock");
check(clock.status === 200 && clock.body?.adjustable === true && clock.body?.presets?.length >= 3, "clock   adjustable in simulation");

const inHours = await api("/api/demo/clock", { preset: "business-hours" });
check(inHours.body?.salesOpen === true, "clock   business hours: sales is open");

const afterHours = await api("/api/demo/clock", { preset: "after-hours" });
check(
  afterHours.body?.salesOpen === false && afterHours.body?.onCall?.covered === true && afterHours.body?.onCall?.repName === "Ben Ortiz",
  "clock   after hours: sales is closed and Ben Ortiz is on call",
);

const unknownPreset = await api("/api/demo/clock", { preset: "lunchtime" });
check(unknownPreset.status === 400, "clock   an unknown preset is refused");

// -------------------------------------------- a call, as the console sees it

const hub = await watchHub();
const sim = await api("/api/simulate", {
  fromPhone: "+14255550162",
  transcript: [
    "This is Sam Rivera, operations director at Tailwind Traders. Our packaging line is down and we need 2,000 cartons by tomorrow morning. Can I talk to someone tonight?",
    "Yes, that's my cell.",
  ],
});
const callId = sim.body?.callId;
check(
  sim.status === 200 && sim.body?.snapshot?.state === "paging" && sim.body?.snapshot?.pageDecision?.code === "hot_urgent",
  "call    a hot, urgent lead pages the on-call rep",
);

await until(() => hub.of(callId, "handoff").some((h) => h.stage === "transferred"));
const roles = new Set(hub.of(callId, "transcript").map((line) => line.role));
check(roles.has("caller") && roles.has("agent"), "hub     the server pushes both sides of the transcript");

const stages = hub.of(callId, "handoff").map((h) => h.stage);
check(stages.join(",") === "paging,transferred", "hub     the handoff goes from paging to transferred");

const handoff = hub.of(callId, "handoff").at(-1);
const headers = Object.fromEntries((handoff?.voipHeaders ?? []).map((h) => [h.key, h.value]));
check(
  headers["CallDetails.RouteId"] === "on-call" && headers["CallDetails.AfterHours"] === "true" && Boolean(headers["CallDetails.CallContext"]),
  "hub     the handoff carries the Teams VoIP headers",
);
hub.close();

const finished = await api(`/api/calls/${callId}`);
check(finished.body?.outcome === "transferred:on-call", "call    the paged rep takes the call");

// ---------------------------------------------------------- demo controls

const unknownCall = await api("/api/simulate/no-such-call/say", { text: "Hello?" });
check(unknownCall.status === 404, "demo    typing into an unknown call is a 404");

const stats = await api("/api/stats");
check(stats.body?.leadsCaptured === 1 && stats.body?.pagesStarted === 1 && stats.body?.pagesConnected === 1, "stats   the lead and the page are counted");

await api("/api/simulate", { fromPhone: "+14255550193" });
const reset = await api("/api/demo/reset", {});
check(
  reset.status === 200
    && reset.body?.cleared?.calls === 2
    && reset.body?.cleared?.leads === 1
    && reset.body?.stats?.calls === 0
    && reset.body?.clock?.preset === "real",
  "demo    reset clears calls and leads and restores the clock",
);

const leads = await api("/api/leads");
check(Array.isArray(leads.body) && leads.body.length === 0, "demo    no simulated lead survives a reset");

stop();
if (failed) {
  console.error("\nSmoke test failed. Server output:\n" + out);
  process.exit(1);
}
console.log("\nsmoke ok");
