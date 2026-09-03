/**
 * Boots the server and checks that both WebSocket endpoints accept an upgrade.
 *
 * This exists because they once did not. Two WebSocketServers were attached to
 * the same HTTP server, and `ws` aborts the handshake for any path a given
 * server does not own — so the presenter hub, registered first, destroyed every
 * media socket. ACS reported only "MediaStreamingFailed", the call connected and
 * then sat in silence, and nothing in the unit suite could see it: those tests
 * are deliberately dependency-free, and this is a transport fault.
 */
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 8199;
const server = spawn(process.execPath, ["src/server.mjs"], {
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DB_PATH: ":memory:", ACS_ENDPOINT: "", ACS_CONNECTION_STRING: "", VOICE_LIVE_ENDPOINT: "" },
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

stop();
if (failed) {
  console.error("\nWebSocket smoke test failed. Server output:\n" + out);
  process.exit(1);
}
console.log("\nwebsocket smoke ok");
