/**
 * Boots its own server on the smoke port, in simulation with the in-memory CRM,
 * and checks what the presenter console depends on: both WebSocket upgrades,
 * the static console, a simulated call through the undo window (a mind change
 * that writes nothing, then a write that lands), a policy refusal handed off
 * with its VoIP headers, a failed PIN, and the demo controls.
 *
 * It never talks to a demo already running on 8097. The upgrades get a real
 * socket because they once failed: two WebSocketServers on one HTTP server
 * abort each other's handshakes, and the unit suite, dependency-free on
 * purpose, cannot see a transport fault.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

// The demo port plus 100, so a smoke run never collides with a running demo.
const PORT = 8197;
const BASE = `http://127.0.0.1:${PORT}`;
// A short undo window keeps the run quick; /health must report it back.
const UNDO_MS = 1500;
const NEW_MOBILE = "Update Fabrikam: Dana has a new mobile, 425 555 0143.";
const CREDIT_LIMIT = "Raise Fabrikam's credit limit to 500k and move them to net 60 payment terms.";

let failed = false;
function check(ok, label) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}

async function api(path, body) {
  const init = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  try {
    const r = await fetch(`${BASE}${path}`, init);
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, type: r.headers.get("content-type") ?? "", body: json, text };
  } catch (error) {
    return { status: 0, type: "", body: null, text: String(error) };
  }
}

const say = (callId, text) => api(`/api/simulate/${callId}/say`, { text });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(100);
  }
  return null;
}

if ((await api("/health")).status !== 0) {
  console.error(`Port ${PORT} is already in use. Stop whatever is listening there and run the smoke test again.`);
  process.exit(1);
}

const server = spawn(process.execPath, ["src/server.mjs"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    // Set but empty, so a local .env cannot switch the smoke run to real calls.
    ACS_ENDPOINT: "",
    ACS_CONNECTION_STRING: "",
    VOICE_LIVE_ENDPOINT: "",
    PUBLIC_BASE_URL: "",
    CRM_ADAPTER: "memory",
    DEMO_NOW: "",
    COMMIT_UNDO_MS: String(UNDO_MS),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
let exited = false;
server.stdout.on("data", (d) => (out += d));
server.stderr.on("data", (d) => (out += d));
server.on("exit", () => (exited = true));
const stop = () => {
  if (!exited) server.kill();
};
process.on("exit", stop);

function finish() {
  stop();
  if (failed) {
    console.error("\nSmoke test failed. Server output:\n" + out);
    process.exit(1);
  }
  console.log("\nsmoke ok");
  process.exit(0);
}

const up = await waitFor(async () => !exited && (await api("/health")).status === 200, Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000));
if (!up) {
  check(false, `server did not start on ${PORT}`);
  finish();
}

// ------------------------------------------------------------------ transport

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

for (const path of ["/ws/hub", "/ws/media"]) check(await upgrades(path), `upgrade ${path}`);
// An unknown path must be refused, not quietly upgraded.
check(!(await upgrades("/ws/nope")), "refuse  /ws/nope");

const health = (await api("/health")).body;
check(
  health?.mode === "simulation" && health?.crm?.adapter === "memory" && health?.policy?.commitUndoMs === UNDO_MS && health?.clock?.preset === "demo-day",
  "health  simulation, in-memory CRM, the undo window as policy, demo-day clock",
);

for (const path of ["/", "/app.js", "/beats.js", "/styles.css", "/presenter-kit.js", "/presenter-kit.css"]) {
  const r = await api(path);
  check(r.status === 200 && r.text.length > 0, `static  ${path}`);
}

// The console subscribes to every call.
const frames = [];
const hub = new WebSocket(`ws://127.0.0.1:${PORT}/ws/hub?user=*`);
hub.on("message", (raw) => {
  try {
    frames.push(JSON.parse(String(raw)));
  } catch {}
});
await new Promise((resolve, reject) => {
  hub.once("open", resolve);
  hub.once("error", reject);
});
const framesFor = (callId, target) => frames.filter((f) => f.target === target && f.arguments?.[0]?.callId === callId).map((f) => f.arguments[0]);

// ------------------------------------------------------------- a simulated call

const teams = (await api("/api/simulate", { repId: "rep-alex" })).body;
const id = teams?.callId;
check(Boolean(id) && teams.snapshot?.rep?.verifiedBy === "teams-user", "call    Teams caller verified by sign-in");
const brief = await say(id, "Brief me on Fabrikam");
check(/One task is due today: send the security questionnaire/.test(brief.body?.result?.phrase ?? ""), "call    briefing reads the demo-day task as due today");
check(brief.body?.snapshot?.record?.contact?.name === "Dana Ruiz" && brief.body.snapshot.record.contact.phone === null, "call    record card withholds the contact number until asked");
check(framesFor(id, "transcript").length >= 2, "hub     transcript reaches the console");

await say(id, NEW_MOBILE);
const yes = await say(id, "Yes, save it.");
check(yes.body?.result?.pending === true && yes.body?.snapshot?.pendingCommit?.windowMs === UNDO_MS, "window  a confirmed write waits in the undo window");
const wait = await say(id, "Wait, no — keep the old number.");
check(
  wait.body?.result?.cancelled === true && wait.body?.snapshot?.lastWrite?.status === "cancelled" && wait.body.snapshot.lastWrite.auditRows === 0,
  "window  a mind change inside it writes nothing",
);
check(framesFor(id, "event").some((e) => e.kind === "commit_cancelled"), "hub     the console hears the cancellation");

await say(id, NEW_MOBILE);
await say(id, "Yes, save it.");
const landed = await waitFor(async () => {
  const s = (await api(`/api/calls/${id}`)).body;
  return s?.lastWrite?.status === "committed" ? s : null;
}, UNDO_MS + 5000);
const row = landed?.lastWrite?.rows?.[0];
check(row?.before === "ending 0120" && row?.after === "425 555 0143" && landed.lastWrite.auditRows === 1, "window  without one, the write lands as the window closes, with an audit row");

const refused = await say(id, CREDIT_LIMIT);
check(refused.body?.result?.reason === "refused_by_policy" && refused.body?.snapshot?.offeredHandoff != null, "policy  credit limit and payment terms refused, a person offered");
const through = await say(id, "Yes, put me through.");
const handoff = framesFor(id, "handoff").at(-1);
const header = (key) => handoff?.voipHeaders?.find((h) => h.key === key)?.value;
check(
  through.body?.snapshot?.state === "transferred" && header("CallDetails.CallTopic") === "Fabrikam – credit limit, payment terms" && Boolean(header("CallDetails.CallContext")),
  "handoff topic and context reach the console as VoIP headers",
);
check(!/246810|12065550120|4255550143|425 555 0143/.test(JSON.stringify(handoff?.voipHeaders ?? "")), "handoff no PIN or phone number in the headers");

const mobile = (await api("/api/simulate", { repId: "rep-alex", fromPhone: "+14255550197" })).body;
const pin = await api(`/api/simulate/${mobile?.callId}/dtmf`, { digit: "135790" });
check(
  pin.body?.snapshot?.handoff?.callTopic === "Unverified caller – no records opened" && pin.body.snapshot.record === null,
  "verify  a wrong PIN discloses nothing and hands off",
);

const stats = (await api("/api/stats")).body;
check(
  stats?.lookups === 1 && stats.confirmedWrites === 1 && stats.undoneWrites === 1 && stats.refusals === 1 && stats.handoffs === 2 && stats.verificationFailures === 1,
  "metrics lookups, confirmed and undone writes, refusals, handoffs",
);

// ---------------------------------------------------------------- demo controls

const clock = await api("/api/demo/clock");
check(clock.status === 200 && clock.body?.adjustable === true && clock.body?.preset === "demo-day" && clock.body?.presets?.length >= 2, "demo    clock is adjustable in simulation");
const real = await api("/api/demo/clock", { preset: "real" });
check(real.status === 200 && real.body?.preset === "real", "demo    clock moves to real time");
check((await api("/api/demo/clock", { preset: "nope" })).status === 400, "demo    unknown clock preset refused");

const records = await api("/api/demo/records", {});
check(records.status === 200 && records.body?.restored === true && records.body?.counts?.contacts === 9, "demo    records restored from the seed");
const again = (await api("/api/simulate", { repId: "rep-alex" })).body;
await say(again?.callId, "Brief me on Fabrikam");
const number = await say(again?.callId, "What's Dana's number?");
check(/206 555 0120/.test(number.body?.result?.phrase ?? ""), "demo    the restored record has the seeded number again");

const reset = await api("/api/demo/reset", {});
check(
  reset.status === 200 && reset.body?.ok === true && reset.body?.stats?.calls === 0 && reset.body?.stats?.confirmedWrites === 0 && reset.body?.clock?.preset === "demo-day" && reset.body?.counts?.accounts === 8,
  "demo    reset clears calls and metrics, reseeds records, restores the clock",
);
check((await api(`/api/calls/${id}`)).status === 404, "demo    reset forgets the calls");
check((await say("no-such-call", "hello")).status === 404, "api     unknown call is a 404");
const fresh = (await api("/api/simulate", { repId: "rep-alex" })).body;
check((await api(`/api/simulate/${fresh?.callId}/dtmf`, { digit: "x" })).status === 400, "api     bad keypad input is a 400");

hub.close();
finish();
