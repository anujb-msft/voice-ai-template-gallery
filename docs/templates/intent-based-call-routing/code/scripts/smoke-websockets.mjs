/**
 * Boots the server and checks that both WebSocket endpoints accept an upgrade,
 * then that the demo controls the presenter console depends on answer.
 *
 * This exists because the upgrades once did not. Two WebSocketServers were
 * attached to the same HTTP server, and `ws` aborts the handshake for any path
 * a given server does not own — so the presenter hub, registered first,
 * destroyed every media socket. ACS reported only "MediaStreamingFailed", the
 * call connected and then sat in silence, and nothing in the unit suite could
 * see it: those tests are deliberately dependency-free, and this is a transport
 * fault.
 */
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

// The demo port plus 100, so a smoke run never collides with a running demo.
const PORT = 8191;
const server = spawn(process.execPath, ["src/server.mjs"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    DB_PATH: ":memory:",
    ACS_ENDPOINT: "",
    ACS_CONNECTION_STRING: "",
    VOICE_LIVE_ENDPOINT: "",
    DEMO_NOW: "",
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
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start in ${timeoutMs}ms:\n${out}`);
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

await waitForListen();

let failed = false;
for (const path of ["/ws/hub", "/ws/media"]) {
  const ok = await upgrades(path);
  console.log(`${ok ? "ok  " : "FAIL"}  upgrade ${path}`);
  if (!ok) failed = true;
}

// An unknown path must be refused, not quietly upgraded.
const bogus = await upgrades("/ws/nope");
console.log(`${bogus ? "FAIL" : "ok  "}  refuse  /ws/nope`);
if (bogus) failed = true;

async function api(path, body) {
  const init =
    body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  return { status: r.status, body: await r.json().catch(() => null) };
}

function check(ok, label) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}

const clock = await api("/api/demo/clock");
check(clock.status === 200 && clock.body?.adjustable === true && clock.body?.presets?.length >= 2, "demo    clock is adjustable in simulation");

const afterHours = await api("/api/demo/clock", { preset: "after-hours" });
const billing = (await api("/api/routes")).body?.routes?.find((r) => r.id === "billing");
check(afterHours.status === 200 && billing?.open === false, "demo    after-hours clock closes billing");

await api("/api/simulate", { fromPhone: "+14255550101" });
const reset = await api("/api/demo/reset", {});
check(
  reset.status === 200 && reset.body?.ok === true && reset.body?.stats?.calls === 0 && reset.body?.clock?.preset === "real",
  "demo    reset clears calls and restores the clock",
);

stop();
if (failed) {
  console.error("\nSmoke test failed. Server output:\n" + out);
  process.exit(1);
}
console.log("\nsmoke ok");
