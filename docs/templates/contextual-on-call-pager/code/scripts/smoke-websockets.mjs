/**
 * Boots the server in simulation and checks what the presenter console stands
 * on: both WebSocket endpoints accept an upgrade, the hub delivers every kind
 * of frame during a scripted page, and the demo controls answer.
 *
 * The upgrades matter because they once failed silently. Two WebSocketServers
 * attached to the same HTTP server make `ws` abort the handshake for any path a
 * given server does not own, so the hub, registered first, destroyed every
 * media socket. A real call connected and then sat in silence, and the unit
 * suite could not see it: those tests are deliberately dependency-free, and
 * this is a transport fault.
 */
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

// The demo port plus 100, so a smoke run never collides with a running demo.
const PORT = 8195;
const BASE = `http://127.0.0.1:${PORT}`;
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
    // The "Weeknight on call" preset: Morgan Lee is on call for Maple Court.
    DEMO_NOW: "2026-09-30T23:42:00-07:00",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
server.stdout.on("data", (d) => (out += d));
server.stderr.on("data", (d) => (out += d));

const stop = () => server.kill();
process.on("exit", stop);

async function waitForListen(timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000)) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start in ${timeoutMs}ms:\n${out}`);
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

async function api(path, body) {
  const init =
    body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(`${BASE}${path}`, init);
  return { status: r.status, body: await r.json().catch(() => null) };
}

let failed = false;
function check(ok, label) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}

await waitForListen();

for (const path of ["/ws/hub", "/ws/media?call=smoke&leg=intake"]) {
  check(await upgrades(path), `upgrade ${path}`);
}
// An unknown path must be refused, not quietly upgraded.
check(!(await upgrades("/ws/nope")), "refuse  /ws/nope");

// ---------------------------------------------------------------- the hub

// Listen the way the console does, then run beat 1: a leak, paged to Morgan, who accepts.
const frames = [];
const hub = new WebSocket(`ws://127.0.0.1:${PORT}/ws/hub?user=*`);
await new Promise((resolve, reject) => {
  hub.on("open", resolve);
  hub.on("error", reject);
});
hub.on("message", (data) => {
  try {
    const frame = JSON.parse(String(data));
    frames.push({ target: frame.target, payload: frame.arguments?.[0] ?? {} });
  } catch {}
});

const clock = await api("/api/demo/clock");
check(
  clock.status === 200 && clock.body?.adjustable === true && clock.body?.preset === "weeknight" && clock.body?.presets?.length >= 3,
  "clock   DEMO_NOW starts on the weeknight preset, adjustable",
);
const maple = clock.body?.onCall?.find((g) => g.properties?.includes("Maple Court"));
check(maple?.primary?.name === "Morgan Lee" && Boolean(maple?.why), "clock   the rotation says who is on call, and why");

const start = await api("/api/simulate", { fromPhone: "+12065550101" });
const id = start.body?.callId;
check(start.status === 200 && Boolean(id) && start.body?.snapshot?.state === "intake", "call    a simulated call answers");

let last = null;
for (const text of [
  "Water is pouring through my kitchen ceiling and it's spreading fast.",
  "Yes, 4B. You can go in — the spare key is in the lockbox by the back door.",
  "Yes, that's my cell.",
  "Morgan Lee here.",
  "I've got it — on my way.",
]) {
  last = await api(`/api/simulate/${id}/say`, { text });
}
check(last?.status === 200 && last.body?.snapshot?.state === "closed", "call    beat 1 ends acknowledged");
await new Promise((r) => setTimeout(r, 400));

const mine = frames.filter((f) => f.payload?.callId === id);
const seen = (target) => mine.some((f) => f.target === target);
check(seen("state") && seen("transcript") && seen("event"), "hub     delivers state, transcript and event frames");
const handoff = mine.find((f) => f.target === "handoff")?.payload;
const headers = handoff?.voipHeaders ?? [];
check(
  headers.length > 0 && !headers.some((h) => /\+?1?2065550101/.test(String(h.value))),
  "hub     delivers the page, with VoIP headers and no raw phone number",
);

const events = await api(`/api/calls/${id}/events`);
check(events.status === 200 && Array.isArray(events.body) && events.body.length > 0, "api     the call's events");
check((await api("/api/calls/nope")).status === 404, "api     an unknown call is a 404");

const stats = await api("/api/stats");
check(stats.status === 200 && stats.body?.pages === 1 && stats.body?.acknowledgements === 1, "api     stats count the page and the acknowledgement");

const health = await api("/health");
check(
  health.status === 200 && health.body?.mode === "simulation" && health.body?.callReady === false && Boolean(health.body?.clock),
  "health  simulation mode, with the demo clock",
);

for (const path of ["/", "/app.js", "/beats.js", "/styles.css", "/presenter-kit.js", "/presenter-kit.css"]) {
  const r = await fetch(`${BASE}${path}`);
  await r.arrayBuffer();
  check(r.ok, `static  ${path}`);
}

// ------------------------------------------------------- demo controls

const weekend = await api("/api/demo/clock", { preset: "weekend" });
check(weekend.status === 200 && weekend.body?.preset === "weekend", "demo    the weekend preset");

const before = Date.parse(weekend.body?.now);
const advanced = await api("/api/demo/clock/advance", { minutes: 3 });
check(
  advanced.status === 200 && Date.parse(advanced.body?.clock?.now) - before >= 3 * 60_000 && advanced.body?.clock?.preset === "custom",
  "demo    advance moves the clock 3 minutes",
);
check((await api("/api/demo/clock/advance", { minutes: -1 })).status === 400, "demo    advance refuses to go back");

const reset = await api("/api/demo/reset", {});
check(
  reset.status === 200 &&
    reset.body?.ok === true &&
    reset.body?.stats?.incidents === 0 &&
    reset.body?.stats?.pages === 0 &&
    reset.body?.clock?.preset === "weeknight",
  "demo    reset clears incidents and pages, and restores the clock",
);
check((await api(`/api/calls/${id}`)).status === 404, "demo    reset forgets the simulated call");

hub.close();
stop();
if (failed) {
  console.error("\nSmoke test failed. Server output:\n" + out);
  process.exit(1);
}
console.log("\nsmoke ok");
