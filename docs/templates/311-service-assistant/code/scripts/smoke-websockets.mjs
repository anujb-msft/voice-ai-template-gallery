/**
 * Boots its own server in simulation and checks what the presenter console
 * depends on: both WebSocket endpoints accept an upgrade, hub frames reach a
 * console, every simulate route answers with the settled call, the demo clock
 * and reset work, texts are shown and never sent, and the console's files are
 * served.
 *
 * The upgrade check exists because two WebSocketServers on one HTTP server
 * abort each other's handshakes. ACS then reports only "MediaStreamingFailed",
 * the call connects and sits in silence, and no unit test can see it: this is
 * a transport fault, and the unit suite is deliberately server-free.
 *
 * Needs no Azure and no network, and never touches a demo running on 8096.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

// The demo port plus 100, so a smoke run never collides with a running demo.
const PORT = 8196;
const BASE = `http://127.0.0.1:${PORT}`;

// Something already answering here would be tested instead of this checkout.
if (await fetch(`${BASE}/health`).then(() => true, () => false)) {
  console.error(`Port ${PORT} is already in use. Stop the other server (or smoke run) and try again.`);
  process.exit(1);
}

const server = spawn(process.execPath, ["src/server.mjs"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    CASE_STORE: "memory",
    DB_PATH: ":memory:",
    ACS_ENDPOINT: "",
    ACS_CONNECTION_STRING: "",
    ACS_SMS_FROM: "",
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForListen(timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000)) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited with code ${server.exitCode}:\n${out}`);
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
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

/** A console on the hub: every frame it receives, as `{ target, payload }`. */
function listen(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
    const frames = [];
    ws.on("message", (data) => {
      try {
        const { target, arguments: [payload] = [] } = JSON.parse(String(data));
        frames.push({ target, payload });
      } catch {}
    });
    ws.on("open", () => resolve({ frames, close: () => ws.close() }));
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

let failed = false;
function check(ok, label) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}

await waitForListen();

for (const path of ["/ws/hub", "/ws/media"]) check(await upgrades(path), `upgrade ${path}`);
// An unknown path must be refused, not quietly upgraded.
check(!(await upgrades("/ws/nope")), "refuse  /ws/nope");

const health = await api("/health");
check(health.status === 200 && health.body?.mode === "simulation" && health.body?.texts === "simulated", "health  simulation mode, texts simulated");

const clock = await api("/api/demo/clock");
check(clock.status === 200 && clock.body?.adjustable === true && clock.body?.presets?.length >= 2, "demo    clock is adjustable in simulation");
check((await api("/api/demo/clock", { preset: "midnight" })).status === 400, "demo    unknown clock preset is refused");
const morning = await api("/api/demo/clock", { preset: "business-hours" });
check(morning.status === 200 && morning.body?.preset === "business-hours", "demo    business-hours clock");

const hub = await listen("/ws/hub?user=*");

// Beat 1: a pothole, read back, filed, and confirmed by a text that is never sent.
const pothole = await api("/api/simulate", { fromPhone: "+12065550142" });
const id = pothole.body?.callId;
check(pothole.status === 200 && Boolean(id), "call    a simulated call answers");
let snap;
for (const text of [
  "Hi, there's a big pothole on Oak Avenue, right at the corner of Fifth Street.",
  "Yes, that's right.",
  "Yes, text me updates please.",
]) {
  snap = (await api(`/api/simulate/${id}/say`, { text })).body?.snapshot;
}
check(snap?.lastCase?.id === "SR-26-0193" && snap?.texts?.length === 1, `say     pothole files SR-26-0193 and the reply carries the text (${snap?.lastCase?.id ?? snap?.state})`);
const texts = (await api("/api/sms")).body ?? [];
check(
  texts.length === 1 && texts[0].simulated === true && texts[0].status === "simulated" && texts[0].caseNumber === "SR-26-0193" && !/2065550142/.test(JSON.stringify(texts)),
  "sms     the confirmation is simulated, masked and shown, not sent",
);

const silence = await api(`/api/simulate/${id}/silence`, {});
check(silence.status === 200 && silence.body?.result?.noInputs === 1 && Boolean(silence.body?.snapshot), "silence answers with the settled call");
const repeat = await api(`/api/simulate/${id}/dtmf`, { digit: "*" });
check(repeat.status === 200 && Boolean(repeat.body?.result?.repeated) && Boolean(repeat.body?.snapshot), "dtmf    * repeats the last line");
check((await api(`/api/simulate/${id}/dtmf`, { digit: "x" })).status === 400, "dtmf    a key that isn't on a phone is refused");
const hangup = await api(`/api/simulate/${id}/hangup`, {});
check(hangup.status === 200 && hangup.body?.snapshot?.state === "ended" && hangup.body?.snapshot?.outcome === "caller_hung_up", "hangup  ends the call");
check((await api("/api/simulate/no-such-call/say", { text: "hello" })).status === 404, "call    an unknown call is a 404");

// Beat 2: gas short-circuits everything.
const gas = (await api("/api/simulate", { fromPhone: "+12065550118" })).body?.callId;
const g = (await api(`/api/simulate/${gas}/say`, { text: "Hi, I smell gas in my kitchen and I'm not sure what to do." })).body?.snapshot;
check(g?.state === "ended" && g?.outcome === "emergency:gas" && g?.emergency?.createdCase === false, "gas     the emergency rule gives guidance and files nothing");

// Office hours follow the demo clock.
await api("/api/demo/clock", { preset: "after-hours" });
const late = (await api("/api/simulate", { fromPhone: "+12065550118" })).body?.callId;
const l = (await api(`/api/simulate/${late}/say`, { text: "Can I talk to a person?" })).body?.snapshot;
check(l?.state === "listening" && !l?.handoff, "demo    after-hours clock: no transfer into an empty queue");

for (let i = 0; i < 20 && !hub.frames.some((f) => f.target === "sms"); i += 1) await sleep(100);
const seen = (target) => hub.frames.some((f) => f.target === target && f.payload?.callId === id);
check(seen("state") && seen("transcript") && seen("case") && seen("sms"), "hub     state, transcript, case and text frames reach the console");
hub.close();

const stats = (await api("/api/stats")).body;
check(
  stats?.calls === 3 && stats?.requestsCreated === 1 && stats?.emergenciesEscalated === 1 && stats?.texts === 1 && stats?.handedOff === 0,
  "stats   three calls, one request, one emergency, one text",
);

const reset = await api("/api/demo/reset", {});
check(
  reset.status === 200 && reset.body?.ok === true &&
    reset.body?.removed?.calls === 3 && reset.body?.removed?.cases === 1 && reset.body?.removed?.texts === 1 &&
    reset.body?.stats?.calls === 0 && reset.body?.stats?.requestsCreated === 0 && reset.body?.clock?.preset === "real",
  "demo    reset clears calls, requests, texts and stats, and restores the clock",
);
const [cases, sms] = [(await api("/api/cases")).body, (await api("/api/sms")).body];
check(cases?.length === 0 && sms?.length === 0, "demo    no simulated request or text is left after a reset");
const again = (await api("/api/simulate", { fromPhone: "+12065550142" })).body?.callId;
check(Boolean(again) && (await api(`/api/calls/${id}`)).status === 404, "demo    a fresh call works after a reset, and old calls are gone");

for (const path of ["/", "/app.js", "/beats.js", "/styles.css", "/presenter-kit.js", "/presenter-kit.css"]) {
  const r = await fetch(`${BASE}${path}`);
  check(r.ok, `static  ${path}`);
}

stop();
if (failed) {
  console.error("\nSmoke test failed. Server output:\n" + out);
  process.exit(1);
}
console.log("\nsmoke ok");
process.exit(0);
