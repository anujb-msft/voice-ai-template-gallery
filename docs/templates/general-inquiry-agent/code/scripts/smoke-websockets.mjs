/**
 * Boots the server in simulation mode and checks what the presenter console
 * depends on, end to end: both WebSocket endpoints accept an upgrade and an
 * unknown path is refused, a simulated call publishes its frames over the hub,
 * and the demo controls (the clock, reset and stats) answer.
 *
 * The upgrade checks are here because a transport fault is invisible to the
 * unit suite, which is deliberately dependency-free. Two WebSocketServers
 * attached to one HTTP server abort each other's handshakes; ACS then reports
 * only "MediaStreamingFailed", and the call connects and sits in silence.
 *
 * Run it with `npm run smoke`. It needs no Azure resources and no network.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

// The demo port plus 100, so a smoke run never collides with a running demo.
const PORT = 8192;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthy() {
  try {
    return (await fetch(`${BASE}/health`)).ok;
  } catch {
    return false;
  }
}

// A server left running on the smoke port would answer in place of this one.
if (await healthy()) {
  console.error(`Something is already answering on port ${PORT}. Stop it, then run the smoke test again.`);
  process.exit(1);
}

// Simulation mode whatever .env says: every Azure setting blank, an in-memory
// audit, and the real clock until a check moves it.
const server = spawn(process.execPath, ["src/server.mjs"], {
  cwd: ROOT,
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
    DEMO_TODAY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
let exited = false;
server.stdout.on("data", (d) => (out += d));
server.stderr.on("data", (d) => (out += d));
server.on("exit", () => (exited = true));

const stop = () => server.kill();
process.on("exit", stop);

async function waitForListen(timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000)) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`the server exited before it listened:\n${out}`);
    if (await healthy()) return;
    await sleep(250);
  }
  throw new Error(`the server did not start in ${timeoutMs}ms:\n${out}`);
}

function upgrades(path) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
    const done = (v) => {
      try {
        ws.close();
      } catch {}
      resolve(v);
    };
    ws.on("open", () => done(true));
    ws.on("unexpected-response", () => done(false));
    ws.on("error", () => done(false));
    setTimeout(() => done(false), 10_000);
  });
}

/** Subscribes to every call on the hub, the way the console does. */
function listen() {
  const frames = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/hub?user=*`);
  ws.on("message", (data) => {
    try {
      const frame = JSON.parse(String(data));
      frames.push({ target: frame.target, payload: frame.arguments?.[0] ?? {} });
    } catch {}
  });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve({ ws, frames }));
    ws.on("error", reject);
  });
}

async function api(path, body) {
  const init =
    body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(`${BASE}${path}`, init);
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Hub frames can trail the HTTP response that caused them by a moment. */
async function until(find, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = find();
    if (found) return found;
    await sleep(50);
  }
  return find();
}

let failed = false;
function check(ok, label) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}

await waitForListen();

// ------------------------------------------------------------------ health

const health = (await api("/health")).body;
check(health?.simulationMode === true && health?.callReady === false, "health  simulation mode");
check(
  Array.isArray(health?.missingConfig) && health.missingConfig.includes("VOICE_LIVE_ENDPOINT"),
  "health  names the settings real calls still need",
);

// -------------------------------------------------------------- websockets

for (const path of ["/ws/hub", "/ws/media"]) {
  const ok = await upgrades(path);
  check(ok, `upgrade ${path}`);
}

// An unknown path must be refused, not quietly upgraded.
const bogus = await upgrades("/ws/nope");
check(!bogus, "refuse  /ws/nope");

// ------------------------------------------------------------------ console

for (const path of ["/", "/app.js", "/beats.js", "/styles.css", "/presenter-kit.js", "/presenter-kit.css"]) {
  const r = await fetch(`${BASE}${path}`);
  check(r.ok, `serve   ${path}`);
}

// --------------------------------------------------------------- the clock

const clock = await api("/api/demo/clock");
const presetIds = (clock.body?.presets ?? []).map((p) => p.id);
check(
  clock.status === 200 && clock.body?.adjustable === true && presetIds.includes("business-hours") && presetIds.includes("after-hours"),
  "demo    clock is adjustable, with business-hours and after-hours presets",
);
check((await api("/api/demo/clock", { preset: "teatime" })).status === 400, "demo    an unknown preset is refused");
check((await api("/api/demo/clock", { at: "not a time" })).status === 400, "demo    a bad timestamp is refused");

const open = await api("/api/demo/clock", { preset: "business-hours" });
const drift = Math.abs(Date.parse(open.body?.now) - Date.parse("2026-09-30T10:00:00-07:00"));
check(open.status === 200 && open.body?.preset === "business-hours" && drift < 60_000, "demo    business-hours clock is Wednesday 10 a.m.");

const library = (await api("/api/content")).body;
const statuses = new Set((library?.articles ?? []).map((a) => a.status));
check(
  library?.desk?.staffed === true && statuses.has("stale") && statuses.has("expired") && typeof library?.minScore === "number",
  "content desk staffed; stale and expired articles judged on the demo clock",
);

// ------------------------------------------------------- a call on the hub

const { ws: hubSocket, frames } = await listen();
const framesFor = (id, target) => frames.filter((f) => f.target === target && f.payload.callId === id);

const first = await api("/api/simulate", { fromPhone: "+14255550123" });
const firstId = first.body?.callId;
check(first.status === 200 && Boolean(firstId), "call    a simulated call is answered");

await api(`/api/simulate/${firstId}/say`, { text: "What are City Hall's hours?" });
const answer = await until(() =>
  framesFor(firstId, "decision").find((f) => f.payload.kind === "answer" && f.payload.passage?.articleId === "city-hall-hours"),
);
check(Boolean(answer), "hub     the grounded answer is published with its source");
check(
  ["state", "transcript", "event", "search"].every((target) => framesFor(firstId, target).length > 0),
  "hub     state, transcript, event and search frames arrive",
);

const handed = await api(`/api/simulate/${firstId}/say`, { text: "Can I talk to a person?" });
const handoff = await until(() => framesFor(firstId, "handoff")[0]);
const headers = handoff?.payload?.voipHeaders ?? [];
check(handed.body?.snapshot?.state === "transferred", "call    asking for a person in business hours transfers");
check(
  handoff?.payload?.simulated === true && headers.some((h) => h.key === "CallDetails.CallTopic" && h.value),
  "hub     the handoff carries the VoIP headers the transfer sends",
);

// ------------------------------------------------------------ after hours

await api("/api/demo/clock", { preset: "after-hours" });
const late = await api("/api/simulate", { fromPhone: "+14255550145" });
const lateId = late.body?.callId;
const closed = await api(`/api/simulate/${lateId}/say`, { text: "Can I talk to a person?" });
const lateDecision = await until(() => framesFor(lateId, "decision").find((f) => f.payload.kind === "after_hours"));
check(
  closed.body?.snapshot?.state === "closed" &&
    String(closed.body?.snapshot?.outcome).startsWith("after_hours") &&
    Boolean(lateDecision?.payload?.hours?.nextOpening) &&
    framesFor(lateId, "handoff").length === 0,
  "demo    after hours: no transfer, the next opening instead",
);

check((await api("/api/simulate/no-such-call/say", { text: "hello" })).status === 404, "call    an unknown call is a 404");

// ------------------------------------------------------- stats and reset

const stats = (await api("/api/stats")).body;
check(
  stats?.calls === 2 && stats?.answers === 1 && stats?.transfers === 1 && stats?.afterHoursClosures === 1,
  "stats   count the calls, answers, transfers and after-hours closures",
);

const reset = await api("/api/demo/reset", {});
check(
  reset.status === 200 && reset.body?.ok === true && reset.body?.stats?.calls === 0 && reset.body?.clock?.preset === "real",
  "demo    reset clears the calls and restores the starting clock",
);
check((await api(`/api/calls/${firstId}`)).status === 404, "demo    reset forgets the calls in memory");

hubSocket.close();
stop();
if (failed) {
  console.error("\nSmoke test failed. Server output:\n" + out);
  process.exit(1);
}
console.log("\nsmoke ok");
