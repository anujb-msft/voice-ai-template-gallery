import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 8195;
const server = spawn(process.execPath, ["src/server.mjs"], {
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DB_PATH: ":memory:", ACS_ENDPOINT: "", ACS_CONNECTION_STRING: "", VOICE_LIVE_ENDPOINT: "", DEMO_NOW: "2026-09-30T23:42:00-07:00" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
server.stdout.on("data", (d) => (out += d));
server.stderr.on("data", (d) => (out += d));
const stop = () => server.kill();
process.on("exit", stop);
async function waitForListen(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start:\n${out}`);
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
for (const path of ["/ws/hub", "/ws/media?call=smoke&leg=intake"]) {
  const ok = await upgrades(path);
  console.log(`${ok ? "ok  " : "FAIL"} upgrade ${path}`);
  if (!ok) failed = true;
}
const bogus = await upgrades("/ws/nope");
console.log(`${bogus ? "FAIL" : "ok  "} refuse /ws/nope`);
if (bogus) failed = true;
stop();
if (failed) { console.error(out); process.exit(1); }
console.log("websocket smoke ok");
