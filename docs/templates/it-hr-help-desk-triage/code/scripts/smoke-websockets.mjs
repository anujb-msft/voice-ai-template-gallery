/**
 * Boots its own server in simulation mode and checks what the presenter
 * console depends on: both WebSocket upgrades, the hub frames a simulated call
 * produces (transcript, state, event, the mock inbox, and handoffs with their
 * VoIP headers), the simulator controls, the demo clock, and the reset that
 * clears simulated calls, tickets and one-time codes.
 *
 * The unit suite is deliberately free of express, ws and SQLite, so a
 * transport fault is invisible to it. Two WebSocketServers on one HTTP server,
 * for example, abort each other's handshakes: ACS reports only
 * "MediaStreamingFailed" and the call sits in silence. This catches that.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

// The demo port plus 100, so a smoke run never collides with a running demo.
const PORT = 8198;
const BASE = `http://127.0.0.1:${PORT}`;
const SAM_TEAMS = "8:orgid:11111111-1111-1111-1111-111111111111";
const SAM_MOBILE = "+14255550101";

const server = spawn(process.execPath, ["src/server.mjs"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    // Nothing touches the disk, and the default SQLite stores are still exercised.
    DB_PATH: ":memory:",
    TICKET_ADAPTER: "sqlite",
    // Simulation mode: no Azure, no network.
    ACS_ENDPOINT: "",
    ACS_CONNECTION_STRING: "",
    VOICE_LIVE_ENDPOINT: "",
    PUBLIC_BASE_URL: "",
    DEMO_NOW: "",
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
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await sleep(250);
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

async function api(path, body) {
  const init = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(`${BASE}${path}`, init);
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Every frame the console would see: { target, callId, ...payload }. */
const frames = [];
function watchHub() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/hub?user=*`);
    ws.on("message", (m) => {
      const { target, arguments: [payload] = [] } = JSON.parse(String(m));
      frames.push({ target, ...payload });
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
async function frame(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = frames.find(predicate);
    if (hit) return hit;
    await sleep(25);
  }
  return null;
}

async function call(who) {
  const r = await api("/api/simulate", who);
  return r.body?.callId;
}
const say = async (id, text) => (await api(`/api/simulate/${id}/say`, { text })).body;

await waitForListen();

// ------------------------------------------------------------------ transport
for (const path of ["/ws/hub", "/ws/media"]) check(await upgrades(path), `upgrade ${path}`);
// An unknown path must be refused, not quietly upgraded.
check(!(await upgrades("/ws/nope")), "refuse  /ws/nope");

const health = (await api("/health")).body;
check(health?.mode === "simulation" && health?.callReady === false && health?.clock?.preset === "real", "health  simulation mode, real clock");

const hubSocket = await watchHub();

// ----------------------------------------------------------------- demo clock
const clock = await api("/api/demo/clock");
check(clock.status === 200 && clock.body?.adjustable === true && clock.body?.presets?.length >= 3, "clock   adjustable in simulation");
const badPreset = await api("/api/demo/clock", { preset: "midnight" });
const badAt = await api("/api/demo/clock", { at: "soon" });
const empty = await api("/api/demo/clock", {});
check(
  badPreset.status === 400 && badPreset.body?.error === 'Unknown clock preset "midnight".' &&
    badAt.status === 400 && badAt.body?.error === '"soon" is not an ISO 8601 timestamp.' &&
    empty.status === 400 && empty.body?.error === "Send { preset } or { at }.",
  "clock   rejects bad input",
);
const open = await api("/api/demo/clock", { preset: "business-hours" });
const openRoutes = (await api("/api/routes")).body?.routes ?? [];
check(open.body?.preset === "business-hours" && openRoutes.length >= 6 && openRoutes.every((r) => r.open), "clock   business hours opens every queue");

// ---------------------------------------------- phone caller: one-time code
const pstn = await call({ fromPhone: SAM_MOBILE });
let step = await say(pstn, "What's happening with INC-004610?");
check(step?.snapshot?.state === "verifying" && step.snapshot.verified === false, "pstn    caller ID is not trusted for ticket status");
await say(pstn, "sam.rivera@contoso.com");
const otp = await frame((f) => f.callId === pstn && f.target === "outbox" && f.kind === "otp");
check(otp?.code === "123456" && otp?.to === "sam.rivera@contoso.com", "pstn    code shown in the mock inbox");
step = await say(pstn, "654321");
check(step?.snapshot?.verified === false && step.snapshot.verification?.lastResult === "refused", "pstn    wrong code refused");
step = await say(pstn, "123456");
check(step?.snapshot?.verified === true && /INC-004610/.test(step.snapshot.lastSpoken ?? ""), "pstn    right code, then the status");
const kinds = new Set(frames.filter((f) => f.callId === pstn).map((f) => f.target));
check(["transcript", "state", "event", "outbox"].every((k) => kinds.has(k)), "hub     transcript, state, event and outbox frames");

// ------------------------------------------------- Teams caller: a ticket
const teams = await call({ teamsUserId: SAM_TEAMS });
await say(teams, "My laptop screen keeps flickering and I can't work");
step = await say(teams, "Yes, file it");
const ticketCard = await frame((f) => f.callId === teams && f.target === "outbox" && f.kind === "ticket");
check(step?.result?.ticket?.number === "INC-004821" && ticketCard?.ticket?.number === "INC-004821", "teams   ticket INC-004821 filed and carded");

// ------------------------------------------------ sensitive HR, in hours
const private1 = await call({ teamsUserId: SAM_TEAMS });
step = await say(private1, "My manager keeps making comments about me");
const confidential = await frame((f) => f.callId === private1 && f.target === "handoff");
const headers = Object.fromEntries((confidential?.voipHeaders ?? []).map((h) => [h.key, h.value]));
check(
  step?.snapshot?.state === "transferred" && headers["CallDetails.CallContext"] === "Confidential HR" && headers["CallDetails.Confidential"] === "true",
  "hr      sensitive call routed privately, with minimal headers",
);
check(!JSON.stringify(frames.filter((f) => f.callId === private1)).includes("comments about me"), "hr      the console never sees what was said");

// ---------------------------------------------------- simulator controls
const keypad = await call({ teamsUserId: SAM_TEAMS });
step = (await api(`/api/simulate/${keypad}/dtmf`, { digit: "0" })).body;
const keypadHandoff = await frame((f) => f.callId === keypad && f.target === "handoff");
check(step?.snapshot?.state === "transferred" && keypadHandoff?.voipHeaders?.length > 0, "control keypad 0 reaches a person");
const quiet = await call({ teamsUserId: SAM_TEAMS });
await api(`/api/simulate/${quiet}/silence`, {});
step = (await api(`/api/simulate/${quiet}/silence`, {})).body;
check(step?.snapshot?.state === "ended", "control two silences end the call");
const gone = await call({ teamsUserId: SAM_TEAMS });
step = (await api(`/api/simulate/${gone}/hangup`, {})).body;
check(step?.snapshot?.state === "ended", "control hang up");
const unknown = await api("/api/simulate/no-such-call/say", { text: "hello" });
check(unknown.status === 404 && unknown.body?.error === "unknown call", "control unknown call is a 404");

// ------------------------------------------------- sensitive HR, after hours
const late = await api("/api/demo/clock", { preset: "after-hours" });
const lateRoutes = (await api("/api/routes")).body?.routes ?? [];
check(late.body?.preset === "after-hours" && lateRoutes.find((r) => r.id === "confidential-hr")?.open === false, "clock   after hours closes confidential HR");
const private2 = await call({ teamsUserId: SAM_TEAMS });
step = await say(private2, "I need to take medical leave");
check(step?.snapshot?.state === "after_hours_offer", "hr      after hours offers a callback instead");

// ------------------------------------------------------ metrics and reset
const story = (await api("/api/stats")).body?.story;
check(story?.ticketsFiled === 1 && story?.verifiedByCode === 1 && story?.codesRefused === 1 && story?.sensitiveRouted === "<5", "stats   closing metrics");
const reset = await api("/api/demo/reset", {});
check(
  reset.status === 200 && reset.body?.ok === true && reset.body?.stats?.calls === 0 && reset.body?.clock?.preset === "real",
  "reset   clears calls and restores the clock",
);
const again = await call({ teamsUserId: SAM_TEAMS });
await say(again, "My laptop screen keeps flickering and I can't work");
step = await say(again, "Yes, file it");
check(step?.result?.ticket?.number === "INC-004821", "reset   simulated tickets cleared: INC-004821 again");

hubSocket.close();
stop();
if (failed) {
  console.error("\nSmoke test failed. Server output:\n" + out);
  process.exit(1);
}
console.log("\nsmoke ok");
