/**
 * Boots the server and checks what the presenter console depends on: both
 * WebSocket endpoints accept an upgrade, the hub streams a simulated call to
 * the console, and the demo controls (clock, price feed, reset) work in
 * simulation and refuse a server configured to answer real calls.
 *
 * The upgrade check exists because the upgrades once failed. Two
 * WebSocketServers were attached to the same HTTP server, and `ws` aborts the
 * handshake for any path a given server does not own — so the presenter hub,
 * registered first, destroyed every media socket. ACS reported only
 * "MediaStreamingFailed", the call connected and then sat in silence, and
 * nothing in the unit suite could see it: those tests are deliberately
 * dependency-free, and this is a transport fault.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

// The demo port plus 100, so a smoke run never collides with a running demo.
const PORT = 8194;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000);

// No call configuration: the offline demo on its default clock.
const SIMULATION = {
  ACS_ENDPOINT: "",
  ACS_CONNECTION_STRING: "",
  PUBLIC_BASE_URL: "",
  VOICE_LIVE_ENDPOINT: "",
  VOICE_LIVE_API_KEY: "",
  DEMO_NOW: "",
};

// Configured like a server that answers real calls. Nothing calls in, so the
// reserved .invalid hosts are never contacted. DEMO_NOW must be ignored.
const LIVE = {
  ACS_ENDPOINT: "https://contoso-acs.invalid",
  ACS_CONNECTION_STRING: "",
  PUBLIC_BASE_URL: "https://contoso-bids.invalid",
  VOICE_LIVE_ENDPOINT: "https://contoso-voice.invalid",
  VOICE_LIVE_API_KEY: "",
  DEMO_NOW: "prices-stale",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
let server = null;
let out = "";

function check(ok, label) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}

const running = () => server != null && server.exitCode === null && server.signalCode === null;

async function portAnswers() {
  try {
    await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

/** Spawns the server and resolves with its /health once it listens. */
async function start(name, env) {
  // Another server on the port would answer the health check for us.
  if (await portAnswers()) throw new Error(`port ${PORT} is already in use; stop what is listening there and rerun`);
  out += `\n--- ${name} server ---\n`;
  server = spawn(process.execPath, ["src/server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DB_PATH: ":memory:", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (out += d));
  server.stderr.on("data", (d) => (out += d));

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline && running()) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error(running() ? `${name} server did not start in ${TIMEOUT_MS}ms` : `${name} server exited during startup`);
}

function stop() {
  const child = server;
  server = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
  });
}
process.on("exit", () => server?.kill());

async function api(path, body) {
  const init =
    body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(`${BASE}${path}`, init);
  return { status: r.status, body: await r.json().catch(() => null) };
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

/** Subscribes the way the console does: every call, every frame. */
function watchHub() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/hub?user=*`);
    const frames = [];
    ws.on("message", (data) => {
      const { target, arguments: args = [] } = JSON.parse(String(data));
      frames.push({ target, payload: args[0] ?? {} });
    });
    ws.once("open", () => resolve({ ws, frames }));
    ws.once("unexpected-response", () => reject(new Error("the hub refused the console's upgrade")));
    ws.once("error", reject);
  });
}

/** Hub frames arrive just after the HTTP reply that caused them. */
async function waitFor(find, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found || Date.now() > deadline) return found;
    await sleep(50);
  }
}

async function simulation() {
  const health = await start("simulation", SIMULATION);
  check(health.mode === "simulation" && health.clock?.preset === "prices-fresh" && health.clock?.pinned === true, "health  simulation mode, clock pinned at prices-fresh");

  for (const path of ["/ws/hub", "/ws/media"]) check(await upgrades(path), `upgrade ${path}`);
  // An unknown path must be refused, not quietly upgraded.
  check(!(await upgrades("/ws/nope")), "refuse  /ws/nope");

  const hub = await watchHub();
  const sent = (callId, target) => hub.frames.filter((f) => f.target === target && f.payload.callId === callId).map((f) => f.payload);
  const agentSaid = (callId, match) => waitFor(() => sent(callId, "transcript").find((t) => t.role === "agent" && match(t.text)));
  const placeCall = async (fromPhone) => (await api("/api/simulate", fromPhone ? { fromPhone } : {})).body?.callId;
  const say = (callId, text) => api(`/api/simulate/${callId}/say`, { text });

  try {
    const clock = await api("/api/demo/clock");
    const presets = clock.body?.presets?.map((p) => p.id) ?? [];
    check(
      clock.status === 200 && clock.body.adjustable === true && ["prices-fresh", "prices-stale", "after-close", "after-hours", "real"].every((id) => presets.includes(id)),
      "demo    clock is adjustable and lists every preset",
    );

    // A quote, then a request to lock it: the price card, then the merchandiser's toast.
    const dale = await placeCall("+14255550111");
    await say(dale, "What's corn paying at Riverside?");
    check(Boolean(await agentSaid(dale, (t) => t.includes("$4.12") && t.includes("as of 10:42 AM"))), "hub     transcript carries the spoken quote");
    check(Boolean(await waitFor(() => sent(dale, "event").find((e) => e.kind === "quote"))), "hub     decision trail gets the quote event");
    check(Boolean(await waitFor(() => sent(dale, "state").at(-1)?.lastQuote?.cashBid === 4.12)), "hub     state carries the price card");
    await say(dale, "Okay, lock in 5,000 bushels at that price.");
    const handoff = await waitFor(() => sent(dale, "handoff")[0]);
    check(
      handoff?.reason === "contract_request" &&
        Array.isArray(handoff.voipHeaders) &&
        handoff.voipHeaders.some((h) => h.key === "CallDetails.TransferReason" && h.value === "contract_request"),
      "hub     a lock request hands off with its VoIP headers",
    );

    // Feed down: no number, and a callback instead.
    const down = await api("/api/demo/feed", { up: false });
    check(down.status === 200 && down.body?.feed?.up === false, "demo    feed marked down");
    const rosa = await placeCall("+14255550112");
    await say(rosa, "Wheat at Lake Mills?");
    const noNumber = await agentSaid(rosa, (t) => t.includes("can't give you a price"));
    check(Boolean(noNumber) && !noNumber.text.includes("$"), "hub     feed down quotes no number");
    await say(rosa, "Have them call me back.");
    check(Boolean(await waitFor(() => sent(rosa, "callback")[0]?.reason === "feed_outage")), "hub     callback card for the feed outage");
    const up = await api("/api/demo/feed", { up: true });
    check(up.status === 200 && up.body?.feed?.up === true, "demo    feed restored");

    // The clock is what makes a price stale.
    const stale = await api("/api/demo/clock", { preset: "prices-stale" });
    check(stale.status === 200 && stale.body?.preset === "prices-stale", "demo    clock moves to prices-stale");
    const unknown = await placeCall(null);
    await say(unknown, "Soybeans at Riverside?");
    check(Boolean(await agentSaid(unknown, (t) => t.includes("$10.11") && t.includes("These prices may be delayed."))), "hub     a stale price carries the caveat");

    check((await api("/api/demo/clock", { preset: "tomorrow" })).status === 400, "demo    unknown clock preset is a 400");
    check((await api("/api/demo/clock", { at: "not a time" })).status === 400, "demo    bad clock time is a 400");
    check((await api("/api/demo/feed", { up: "down" })).status === 400, "demo    feed without a boolean is a 400");
    check((await api("/api/simulate/no-such-call/say", { text: "hello" })).status === 404, "api     unknown simulated call is a 404");
    check((await api("/api/calls/no-such-call")).status === 404, "api     unknown call snapshot is a 404");

    const stats = (await api("/api/stats")).body ?? {};
    check(
      stats.calls === 3 && stats.quotesGiven === 2 && stats.delayedQuotes === 1 && stats.feedOutages === 1 &&
        stats.contractsDeclined === 1 && stats.transfers === 1 && stats.callbacks === 1,
      "stats   counts the quotes, the refusals and the handoffs",
    );

    const reset = await api("/api/demo/reset", {});
    check(
      reset.status === 200 && reset.body?.ok === true && reset.body.stats?.calls === 0 &&
        reset.body.clock?.preset === "prices-fresh" && reset.body.feed?.up === true,
      "demo    reset clears calls, restores the clock and the feed",
    );
    check((await api(`/api/calls/${dale}`)).status === 404, "demo    reset forgets the calls");
    const board = (await api("/api/bid-board")).body ?? {};
    check(board.corn?.length === 5 && board.corn.every((q) => q.freshness === "live"), "api     bid board is live after reset");
  } finally {
    hub.ws.close();
  }
  await stop();
}

async function live() {
  const health = await start("live-configured", LIVE);
  check(health.mode === "live" && health.clock?.preset === "real" && health.clock?.pinned === false, "health  live mode prices on real time and ignores DEMO_NOW");
  check((await api("/api/demo/clock")).body?.adjustable === false, "demo    clock is not adjustable when live");
  check((await api("/api/demo/clock", { preset: "prices-fresh" })).status === 403, "demo    clock refuses a live server (403)");
  check((await api("/api/demo/feed", { up: false })).status === 403, "demo    feed refuses a live server (403)");
  check((await api("/api/demo/reset", {})).status === 403, "demo    reset refuses a live server (403)");
  await stop();
}

try {
  await simulation();
  await live();
} catch (e) {
  failed = true;
  console.error(`FAIL  ${e.message}`);
}
await stop();

if (failed) {
  console.error("\nSmoke test failed. Server output:\n" + out);
  process.exit(1);
}
console.log("\nsmoke ok");
