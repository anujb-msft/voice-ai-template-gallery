/**
 * Boots the server on its own port and checks what the stage depends on that
 * the unit suite deliberately cannot see: those tests never load express, ws
 * or SQLite, and these are transport and wiring faults.
 *
 * - Both WebSocket endpoints accept an upgrade, and an unknown path is refused.
 *   Two WebSocketServers attached to one HTTP server abort each other's
 *   handshakes (`ws` destroys any path a given server does not own), and on a
 *   real call that looks like a connected call sitting in silence. One upgrade
 *   listener routes by pathname in src/server.mjs; this keeps it that way.
 * - The demo controls the console uses: the clock and its presets, take-slot,
 *   the model-tool action, stats, and reset restoring the seeded schedule.
 * - The booking invariant over HTTP and the hub: the model's "book" is refused,
 *   a time taken between the read-back and the yes is never written, and only
 *   a fresh choice with fresh consent books. A handoff carries the Teams VoIP
 *   headers.
 * - A server answering real calls refuses every demo control with 403. It is
 *   given fictional .invalid settings and is only asked for its demo routes,
 *   so no Azure resource and no network are needed.
 */
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

// The demo port plus 100, so a smoke run never collides with a running demo.
const PORT = 8200;
const BASE = `http://127.0.0.1:${PORT}`;
const DEMO_NOW = "2026-05-19T09:50:00-07:00";
const FRI_EVENING = "2026-05-22T18:30:00-07:00";
const AVERY = "+12065550101";
const JORDAN = "+12065550142";

// Enough for the server to consider itself live. Nothing here is reachable.
const LIVE_ENV = {
  ACS_CONNECTION_STRING: "endpoint=https://contoso-scheduling.invalid/;accesskey=ZmFrZQ==",
  VOICE_LIVE_ENDPOINT: "https://contoso-voice.invalid",
  VOICE_LIVE_API_KEY: "not-a-key",
  PUBLIC_BASE_URL: "https://contoso-scheduling.invalid",
  SCHEDULE_DB_PATH: ":memory:",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
let out = "";
let failed = false;

function check(ok, label) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failed = true;
  return ok;
}

const running = (child) => child && child.exitCode === null && child.signalCode === null;

// Settings a developer's .env might hold are overridden here: dotenv never
// replaces a variable that is already set, even to "".
function start(extraEnv = {}) {
  out = "";
  const child = spawn(process.execPath, ["src/server.mjs"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DB_PATH: ":memory:",
      SCHEDULE_DB_PATH: "",
      ACS_ENDPOINT: "",
      ACS_CONNECTION_STRING: "",
      VOICE_LIVE_ENDPOINT: "",
      PUBLIC_BASE_URL: "",
      DEMO_NOW,
      TRANSFER_DELAY_MS: "0",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  server = child;
  return child;
}

async function stop() {
  if (!running(server)) return;
  server.kill();
  await server.exited;
}

process.on("exit", () => {
  if (running(server)) server.kill();
});

async function health() {
  try {
    const r = await fetch(`${BASE}/health`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function waitForListen(child, timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000)) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && running(child)) {
    const h = await health();
    if (h) return h;
    await sleep(250);
  }
  throw new Error(`server ${running(child) ? `did not start in ${timeoutMs}ms` : "exited"}`);
}

async function api(path, body) {
  const init =
    body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(`${BASE}${path}`, init);
  return { status: r.status, body: await r.json().catch(() => null) };
}

const say = (callId, text) => api(`/api/simulate/${encodeURIComponent(callId)}/say`, { text });

async function until(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(100);
  }
  return false;
}

function upgrades(path) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
    let timer = null;
    const done = (v) => {
      clearTimeout(timer);
      try { ws.terminate(); } catch {}
      resolve(v);
    };
    ws.on("open", () => done(true));
    ws.on("unexpected-response", () => done(false));
    ws.on("error", () => done(false));
    timer = setTimeout(() => done(false), 10_000);
  });
}

/** Everything the presenter hub sends for every call, as the console sees it. */
function listen(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
    const frames = [];
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data));
        frames.push({ target: msg.target, payload: msg.arguments?.[0] ?? {} });
      } catch {}
    });
    ws.once("open", () => resolve({ frames, close: () => ws.terminate() }));
    ws.once("error", reject);
  });
}

const scheduleShape = (s) => s && [s.appointments, s.bookingsByVoice, s.frontDeskBookings, s.activeHolds].join("/");

async function simulationChecks() {
  for (const path of ["/ws/hub", "/ws/media"]) check(await upgrades(path), `upgrade ${path}`);
  // An unknown path must be refused, not quietly upgraded.
  check(!(await upgrades("/ws/nope")), "refuse  /ws/nope");

  const h = await health();
  check(h?.mode === "simulation" && h?.callReady === false && h?.missingConfig?.length > 0, "health  simulation mode, says what a real call still needs");

  const clock = await api("/api/demo/clock");
  check(
    clock.status === 200 && clock.body?.adjustable === true && clock.body?.preset === "tue-morning" &&
      ["tue-morning", "fri-evening", "real"].every((id) => clock.body?.presets?.some((p) => p.id === id)) &&
      Math.abs(Date.parse(clock.body?.now) - Date.parse(DEMO_NOW)) < 120_000,
    "demo    clock starts at DEMO_NOW (tue-morning) and is adjustable",
  );

  const baseline = (await api("/api/stats")).body;
  check(baseline?.calls === 0 && baseline?.booked === 0 && baseline?.schedule?.appointments > 0, "stats   baseline: no calls, the seeded schedule");

  const hub = await listen("/ws/hub?user=*");
  const framesFor = (callId, target) => hub.frames.filter((f) => f.payload.callId === callId && (!target || f.target === target));

  // The race, end to end: Avery is read back a time, the front desk books it,
  // Avery says yes. The server refuses the write and offers fresh times.
  const avery = await api("/api/simulate", { fromPhone: AVERY });
  const callId = avery.body?.callId;
  check(avery.status === 200 && Boolean(callId), "call    simulated call answered");

  const early = await api("/api/demo/take-slot", { callId });
  check(early.status === 409 && early.body?.code === "nothing_to_take", "demo    take-slot waits until a time has been offered (409)");

  let r = await say(callId, "Avery Stone, 06/09/1979");
  check(r.status === 200 && Boolean(r.body?.snapshot?.patient), "call    identity verified by name and date of birth");

  r = await say(callId, "A follow-up with Dr. Patel, please.");
  const offered = r.body?.snapshot?.options ?? [];
  check(r.body?.snapshot?.state === "offering" && offered.length > 0, "call    openings offered");

  const tool = await api("/api/demo/tool", { callId, name: "book", args: {} });
  check(
    tool.status === 200 && tool.body?.result?.refused === true && tool.body?.result?.reason === "model_cannot_book" &&
      !tool.body?.snapshot?.booking,
    "rule    the model's \"book\" is refused and nothing is written",
  );

  r = await say(callId, "The first one.");
  const first = r.body?.snapshot?.proposal;
  check(r.body?.snapshot?.state === "confirming" && first?.status === "active", "call    one time proposed and read back");

  const taken = await api("/api/demo/take-slot", { callId });
  check(taken.status === 200 && taken.body?.result === "taken" && taken.body?.proposalId === first?.id, "demo    take-slot books the proposed time out from under the caller");
  const again = await api("/api/demo/take-slot", { callId });
  check(again.status === 409, "demo    take-slot twice is refused (409)");

  r = await say(callId, "Yes, book it.");
  let snap = r.body?.snapshot;
  const fresh = snap?.options ?? [];
  check(!snap?.booking && snap?.raceLost?.proposalId === first?.id && snap?.state === "offering", "rule    a yes to a time taken in the meantime is refused, not written");
  check(
    fresh.length > 0 && !fresh.some((o) => o.start === first?.start && o.providerId === first?.providerId),
    "rule    fresh options are offered, never the taken time",
  );

  await say(callId, "The first one.");
  r = await say(callId, "Yes.");
  snap = r.body?.snapshot;
  check(
    snap?.state === "booked" && Boolean(snap?.booking?.proposalId) && snap.booking.proposalId !== first?.id && snap.booking.afterRace === true,
    "rule    only a fresh choice with fresh consent books",
  );

  // The console renders from these frames, so they must all arrive.
  await sleep(200);
  const kinds = new Set(framesFor(callId, "event").map((f) => f.payload.kind));
  check(
    ["identity_verified", "write_refused", "taken_elsewhere", "slot_taken", "race_resolved", "booked"].every((k) => kinds.has(k)),
    "hub     decision trail streamed: refusals, the race, the booking",
  );
  check(framesFor(callId, "state").some((f) => f.payload.state === "booked"), "hub     state snapshots streamed");
  const roles = new Set(framesFor(callId, "transcript").map((f) => f.payload.role));
  check(roles.has("caller") && roles.has("agent"), "hub     transcript streamed");
  const reasons = new Set(framesFor(callId, "schedule").map((f) => f.payload.reason));
  check(reasons.has("slot_taken") && reasons.has("taken_elsewhere"), "hub     schedule changes streamed");

  // A visit that needs a referral is not offered; the caller goes to a person
  // with the context in the Teams VoIP headers.
  const jordan = await api("/api/simulate", { fromPhone: JORDAN });
  const jordanId = jordan.body?.callId;
  await say(jordanId, "Jordan Rivera, 03/12/1984");
  r = await say(jordanId, "I'd like a skin check for a mole.");
  check(Boolean(r.body?.snapshot?.blocked) && !r.body?.snapshot?.options?.length, "policy  a visit that needs a referral is not offered");
  await say(jordanId, "Connect me with the referral coordinator.");
  check(await until(async () => (await api(`/api/calls/${jordanId}`)).body?.state === "transferred"), "handoff transferred to the referral coordinator");
  const handoff = framesFor(jordanId, "handoff").at(-1)?.payload;
  check(
    handoff?.destination === "referral_coordinator" && handoff?.voipHeaders?.some((v) => v.key === "CallDetails.CallTopic"),
    "handoff Teams VoIP headers on the hub",
  );
  const trail = await api(`/api/calls/${jordanId}/events`);
  check(trail.status === 200 && Array.isArray(trail.body) && trail.body.length > 0, "audit   the call's decision trail is kept");

  check((await say("no-such-call", "hello")).status === 404, "call    an unknown call is refused (404)");

  const stats = (await api("/api/stats")).body;
  check(
    stats?.calls === 2 && stats?.booked === 1 && stats?.refusedWrites >= 2 && stats?.racesResolved === 1 && stats?.handoffs === 1,
    "stats   calls, booked, refused writes, races resolved, handoffs",
  );

  const fri = await api("/api/demo/clock", { preset: "fri-evening" });
  check(
    fri.status === 200 && fri.body?.preset === "fri-evening" && Math.abs(Date.parse(fri.body?.now) - Date.parse(FRI_EVENING)) < 120_000,
    "demo    clock moves to a preset",
  );
  check((await api("/api/demo/clock", { preset: "someday" })).status === 400, "demo    an unknown preset is refused (400)");

  const reset = await api("/api/demo/reset", {});
  check(
    reset.status === 200 && reset.body?.ok === true && reset.body?.stats?.calls === 0 && reset.body?.clock?.preset === "tue-morning",
    "demo    reset clears calls and restores the starting clock",
  );
  check(
    reset.body?.scheduleReseeded === true && scheduleShape(reset.body?.stats?.schedule) === scheduleShape(baseline?.schedule),
    "demo    reset restores the seeded schedule",
  );
  check((await api(`/api/calls/${callId}`)).status === 404, "demo    reset forgets the calls");
  hub.close();
}

async function liveChecks() {
  const h = await health();
  check(h?.mode === "live", "live    fictional settings switch the server to live");
  const refused = [];
  for (const [path, body] of [
    ["/api/demo/clock", { preset: "fri-evening" }],
    ["/api/demo/reset", {}],
    ["/api/demo/take-slot", { callId: "x" }],
    ["/api/demo/tool", { callId: "x", name: "book" }],
    ["/api/simulate", { fromPhone: AVERY }],
  ]) {
    if ((await api(path, body)).status === 403) refused.push(path);
  }
  check(refused.length === 5, "live    demo controls and simulated calls answer 403");
  const clock = (await api("/api/demo/clock")).body;
  check(clock?.adjustable === false && clock?.preset === "real", "live    the clock is real time, DEMO_NOW ignored");
}

try {
  if (await health()) {
    throw new Error(`something is already answering on port ${PORT}; stop it so the smoke test checks its own server`);
  }
  await waitForListen(start());
  await simulationChecks();
  await stop();

  await waitForListen(start(LIVE_ENV));
  await liveChecks();
  await stop();
} catch (e) {
  console.error(`FAIL  ${e.message}`);
  failed = true;
  await stop();
}

if (failed) {
  console.error("\nSmoke test failed. Server output:\n" + out);
  process.exit(1);
}
console.log("\nsmoke ok");
process.exit(0);
