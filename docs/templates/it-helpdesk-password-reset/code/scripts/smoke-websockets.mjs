/**
 * Boots the server and checks that both WebSocket endpoints accept an upgrade.
 *
 * This exists because they once did not. The built-in browser hub and the ACS
 * media bridge were each attached to the HTTP server as their own
 * WebSocketServer, and `ws` aborts the handshake for any path a given server
 * does not own — so the hub, registered first, answered every media upgrade
 * with HTTP 400. The call connected, the agent never spoke, and nothing in the
 * unit suite could see it: those tests are deliberately dependency-free, and
 * this is a transport fault. It only bit without Azure SignalR, which is the
 * default, so this runs with SignalR explicitly unset.
 */
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 8190;
const server = spawn(process.execPath, ["src/server.mjs"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    DB_PATH: ":memory:",
    DIRECTORY_PROVIDER: "sqlite",
    ACS_ENDPOINT: "",
    ACS_CONNECTION_STRING: "",
    VOICE_LIVE_ENDPOINT: "",
    VOICE_LIVE_API_KEY: "",
    AZURE_SIGNALR_CONNECTION_STRING: "",
  },
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
// Both handlers close a socket that names no user or session, but only after
// the upgrade succeeds, which is what this checks.
for (const path of ["/ws/hub?user=smoke", "/ws/media?session=smoke"]) {
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
