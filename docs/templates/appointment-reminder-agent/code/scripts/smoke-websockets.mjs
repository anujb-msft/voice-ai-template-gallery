/**
 * Boots its own server in simulation mode on port 8199 (the demo port plus
 * 100, so it never collides with a running demo) and checks what the unit
 * suite cannot see:
 *
 * - The transport. Both WebSocket endpoints must accept an upgrade and an
 *   unknown path must be refused. Two WebSocketServers on one HTTP server abort
 *   each other's handshakes (`ws` destroys any path a server does not own); on
 *   a real call that shows up only as ACS "MediaStreamingFailed" and a silent
 *   line. The presenter hub must also carry a call's frames to the console.
 * - The demo controls the presenter console depends on: the demo clock, the
 *   calling-hours refusal, a simulated confirm and reschedule handoff, the
 *   metrics, and a reset that puts the seeded schedule back.
 *
 * It never talks to a server you already have running. If port 8199 is taken,
 * it waits for it to free up; it never stops a process it did not start.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { WebSocket } from "ws";

const PORT = Number(process.env.SMOKE_PORT ?? 8199);
const BASE = `http://127.0.0.1:${PORT}`;
const STARTING_CLOCK = "2026-05-19T10:00:00-07:00";
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 120_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
let out = "";
let failed = false;

const stop = () => {
  if (server && server.exitCode == null) server.kill();
};
process.on("exit", stop);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

function portFree() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(PORT, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function waitForFreePort(deadline) {
  let said = false;
  while (!(await portFree())) {
    if (Date.now() > deadline) throw new Error(`port ${PORT} is still in use; this script never stops a process it did not start`);
    if (!said) console.log(`wait  port ${PORT} is in use; waiting for it to free up…`);
    said = true;
    await sleep(2000);
  }
}

function boot() {
  out = "";
  server = spawn(process.execPath, ["src/server.mjs"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      ACS_ENDPOINT: "",
      ACS_CONNECTION_STRING: "",
      VOICE_LIVE_ENDPOINT: "",
      PUBLIC_BASE_URL: "",
      SCHEDULE_DB_PATH: ":memory:",
      AUDIT_DB_PATH: ":memory:",
      DEMO_NOW: STARTING_CLOCK,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (out += d));
  server.stderr.on("data", (d) => (out += d));
  return server;
}

/** Health is trusted only after our own child has logged that it is listening. */
async function start() {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    await waitForFreePort(deadline);
    const child = boot();
    while (child.exitCode == null && Date.now() < deadline) {
      if (out.includes(`on http://127.0.0.1:${PORT}`)) {
        try {
          if ((await fetch(`${BASE}/health`)).ok) return;
        } catch {}
      }
      await sleep(250);
    }
    if (child.exitCode == null) throw new Error(`server did not start in ${TIMEOUT_MS} ms:\n${out}`);
    if (!/already in use/.test(out) || Date.now() > deadline) throw new Error(`server exited (${child.exitCode}):\n${out}`);
    console.log(`wait  port ${PORT} was taken while the server started; retrying…`);
  }
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

/** What the console subscribes to: every call's frames. */
function watchHub() {
  return new Promise((resolve, reject) => {
    const frames = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/hub?user=*`);
    ws.on("message", (data) => {
      try {
        frames.push(JSON.parse(String(data)));
      } catch {}
    });
    ws.on("open", () => resolve({ frames, close: () => ws.close() }));
    ws.on("unexpected-response", () => reject(new Error("hub refused the upgrade")));
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

function check(ok, label) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}

/** Places a simulated reminder call and plays the patient's lines. */
async function call(appointmentId, lines) {
  const placed = await api("/api/simulate", { appointmentId, language: "en", outcome: "answered" });
  let snapshot = placed.body?.snapshot ?? null;
  for (const text of lines) {
    if (!placed.body?.callId || placed.body.refused) break;
    snapshot = (await api(`/api/simulate/${placed.body.callId}/say`, { text })).body?.snapshot ?? snapshot;
  }
  return { callId: placed.body?.callId, placed: placed.body, snapshot };
}

const row = (board, id) => board?.find((r) => r.appointmentId === id);

try {
  await start();

  for (const path of ["/ws/hub", "/ws/media"]) check(await upgrades(path), `upgrade ${path}`);
  // An unknown path must be refused, not quietly upgraded.
  check(!(await upgrades("/ws/nope")), "refuse  /ws/nope");

  const clock = await api("/api/demo/clock");
  check(
    clock.status === 200 && clock.body?.adjustable === true && clock.body?.presets?.length >= 3 && clock.body?.preset === "two-days-before",
    "clock   adjustable in simulation; DEMO_NOW starts it two days before the visits",
  );

  const hub = await watchHub();

  await api("/api/demo/clock", { preset: "too-late" });
  const late = await api("/api/simulate", { appointmentId: "A-20418", language: "en" });
  check(
    late.body?.refused === true && late.body?.reason === "calling_window" && late.body?.nextAllowedAt === "2026-05-20T15:00:00.000Z",
    "gate    too late to call: nothing is dialed, and the next allowed time is given",
  );

  await api("/api/demo/clock", { preset: "two-days-before" });
  const confirm = await call("A-20418", ["Yes, this is Jordan.", "March 12th, 1984.", "Yes, I'll be there."]);
  const schedule = (await api("/api/schedule?ids=A-20418,A-20423")).body;
  check(
    confirm.snapshot?.verified === true && confirm.snapshot?.outcome === "confirmed" && row(schedule?.board, "A-20418")?.status === "confirmed",
    "call    confirm: date of birth first, then the schedule shows A-20418 confirmed",
  );

  const reschedule = await call("A-20423", ["Yes, this is Riley.", "August 14th, 2002.", "Can I come next week instead?"]);
  await sleep(300);
  const handoff = hub.frames.find((f) => f.target === "handoff" && f.arguments?.[0]?.callId === reschedule.callId)?.arguments?.[0];
  const headers = Object.fromEntries((handoff?.voipHeaders ?? []).map((h) => [h.key, h.value]));
  check(
    reschedule.snapshot?.outcome === "reschedule_handoff" && Boolean(headers["CallDetails.CallContext"]) && Boolean(headers["CallDetails.CallTopic"]),
    "handoff reschedule goes to the scheduling desk with the context in VoIP headers",
  );

  const seen = new Set(hub.frames.filter((f) => f.arguments?.[0]?.callId === confirm.callId).map((f) => f.target));
  check(["state", "transcript", "event"].every((t) => seen.has(t)), "hub     the console hub carried the call's state, transcript and events");
  hub.close();

  const stats = (await api("/api/stats")).body;
  check(
    stats?.confirmed === 1 && stats?.reschedulesHandedOff === 1 && stats?.notPlaced === 1 && stats?.reached === 2,
    "stats   reached, confirmed, handed off and not-placed calls are counted",
  );

  const reset = await api("/api/demo/reset", {});
  const after = (await api("/api/schedule?ids=A-20418,A-20423")).body;
  check(
    reset.status === 200 &&
      reset.body?.ok === true &&
      reset.body?.stats?.calls === 0 &&
      reset.body?.clock?.preset === "two-days-before" &&
      row(after?.board, "A-20418")?.status === "booked" &&
      row(after?.board, "A-20423")?.rescheduleRequested === false,
    "reset   clears the calls, reseeds the schedule and restores the clock",
  );
} catch (error) {
  console.log(`FAIL  ${error.message}`);
  failed = true;
}

stop();
if (failed) {
  console.error(`\nSmoke test failed. Server output:\n${out}`);
  process.exit(1);
}
console.log("\nsmoke ok");
