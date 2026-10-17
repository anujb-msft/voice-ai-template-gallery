/**
 * Demo rehearsal — plays a template's scripted beats (public/beats.js) against
 * its own server in simulation mode, the way the presenter console plays them,
 * and checks that every beat still shows the room what DEMO-SCRIPT.md says.
 *
 * VENDORED FILE. The canonical copy lives in scripts/presenter-kit/. Edit it
 * there and run `node scripts/sync-presenter-kit.js`; CI fails when a copy in
 * a template drifts. Each template's scripts/rehearse.mjs holds what is its
 * own: its console's start body, step wrapper and actions (public/app.js), and
 * the outcome pinned for each beat.
 *
 * The unit tests prove the policy and the smoke test proves the wiring. This
 * proves the stage:
 *
 * - every beat reaches its pinned outcome, with no failed request, no step the
 *   console has no handler for, and a hub that streams every call to the
 *   console;
 * - again after a reset, and again with the beats in reverse order and each
 *   one played twice: the "any beat, in any order" promise DEMO-SCRIPT.md makes;
 * - at Auto-play's pace, at a quick presenter's pace and at full speed, so no
 *   beat leans on a timer the script does not wait for;
 * - reset puts the metrics back where they started;
 * - DEMO-SCRIPT.md's beat count and headings match the beat strip;
 * - the console page, its styles and every module it imports are served;
 * - a server answering real calls refuses the demo controls (403).
 *
 * It runs the server with the template's shipped settings. Neither your .env
 * nor your shell's variables reach it (only what any process needs, like PATH),
 * so the rehearsal passes or fails the same way on every machine and in CI;
 * the template's `env` adds only what keeps its storage in memory. Demo timings
 * (a transfer's mind-change window, a page's answer window) keep their shipped
 * values, because the room sees them.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const CALL_STEPS = new Set(["start", "say", "dtmf", "silence", "hangup"]);
const DIRECTOR_STEPS = new Set(["note", "wait"]);
const POLL_MS = 100;
const BOOT_MS = Number(process.env.REHEARSE_BOOT_MS ?? 60_000);

// Auto-play's pause between steps (createDirector): the hub goes quiet, then a dwell.
const QUIET_MS = 650;
const QUIET_MAX_MS = 8000;
const DWELL_MS = 900;

const PACES = {
  autoplay: "at Auto-play's pace",
  presenter: "at a quick presenter's pace",
  fast: "at full speed",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plain = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const json = (value) => JSON.stringify(value);
const resolve = (value, ...args) => (typeof value === "function" ? value(...args) : (value ?? {}));
const resolveMs = (value, ...args) => Number(typeof value === "function" ? value(...args) : value);

// What any process needs to run. Nothing else from your shell reaches the server.
const SYSTEM_ENV = new Set(
  "PATH HOME USER LOGNAME SHELL LANG LC_ALL LC_CTYPE TZ TMPDIR TMP TEMP SYSTEMROOT SYSTEMDRIVE WINDIR COMSPEC PATHEXT USERPROFILE APPDATA LOCALAPPDATA HOMEDRIVE HOMEPATH".split(" "),
);
const systemEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => SYSTEM_ENV.has(name.toUpperCase())));

/** JSON as a person would write it in a .mjs file: short values on one line, the rest broken up. */
const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : json(k));
function literal(value) {
  if (value === null || typeof value !== "object") return json(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  const entries = Object.entries(value);
  return entries.length ? `{ ${entries.map(([k, v]) => `${key(k)}: ${literal(v)}`).join(", ")} }` : "{}";
}
function pretty(value, indent = "", lead = 0) {
  const inline = literal(value);
  if (value === null || typeof value !== "object" || indent.length + lead + inline.length <= 100) return inline;
  const next = `${indent}  `;
  const items = Array.isArray(value)
    ? value.map((v) => `${next}${pretty(v, next)}`)
    : Object.entries(value).map(([k, v]) => `${next}${key(k)}: ${pretty(v, next, key(k).length + 2)}`);
  if (!items.length) return inline;
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return `${open}\n${items.join(",\n")},\n${indent}${close}`;
}

/**
 * How long the director spends typing a caller line into the console before
 * it sends it (typeInto in presenter-kit.js). Nobody presses Next faster.
 */
export function typingMs(text = "") {
  const length = [...String(text)].length;
  return Math.max(12, Math.min(34, 1100 / Math.max(length, 1))) * length + 160;
}

const QUOTES = [
  [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'],
  [/[\u2018\u2019\u201A\u201B\u2032]/g, "'"],
];

/** Beat titles match regardless of curly quotes and spacing. */
export function sameTitle(a, b) {
  const norm = (s) =>
    QUOTES.reduce((text, [re, to]) => text.replace(re, to), String(s ?? ""))
      .replace(/\s+/g, " ")
      .trim();
  return norm(a) === norm(b);
}

/** The decision trail as the console lists it: event kinds, in order. */
export function eventKinds(events) {
  return (Array.isArray(events) ? events : []).map((e) => e?.kind).filter(Boolean);
}

/**
 * The decision trail with its details ("route_changed billing → support"),
 * in order, without `skip` kinds. Use it when no detail carries an id or a time.
 */
export function trail(events, { skip = ["state"] } = {}) {
  return (Array.isArray(events) ? events : [])
    .filter((e) => e?.kind && !skip.includes(e.kind))
    .map(({ kind, detail }) => {
      const text = detail == null ? "" : typeof detail === "string" ? detail : JSON.stringify(detail);
      return text ? `${kind} ${text}` : kind;
    });
}

/** Used when a template pins nothing more specific: each call's state and trail. */
export function defaultOutcome({ calls }) {
  return calls.map(({ snapshot, events }) => ({
    state: snapshot?.state ?? snapshot?.status ?? null,
    events: eventKinds(events),
  }));
}

function describe(step) {
  switch (step?.type) {
    case "say":
      return `say ${json(step.text)}`;
    case "dtmf":
      return `keypad ${step.digit}`;
    case "start":
      return "start a call";
    case "wait":
      return `wait ${step.ms ?? 1000} ms`;
    default:
      return step?.action ?? step?.type ?? "unknown step";
  }
}

/** Every beat can be played: a title, narration, and steps the console can run. */
export function checkBeats(beats, handlers = {}) {
  if (!Array.isArray(beats) || !beats.length) return ["createBeats() returned no beats"];
  const problems = [];
  const titles = new Set();
  beats.forEach((beat, i) => {
    const at = `beat ${i + 1}${beat?.title ? ` "${beat.title}"` : ""}`;
    if (typeof beat?.title !== "string" || !beat.title.trim()) problems.push(`${at}: no title`);
    else if (titles.has(beat.title)) problems.push(`${at}: another beat has the same title`);
    else titles.add(beat.title);
    if (typeof beat?.talk !== "string" || !beat.talk.trim()) problems.push(`${at}: no talk (the narration shown while it runs)`);
    if (beat?.prepare != null && typeof beat.prepare !== "function") problems.push(`${at}: prepare is not a function`);
    if (!Array.isArray(beat?.steps) || !beat.steps.length) {
      problems.push(`${at}: no steps`);
      return;
    }
    beat.steps.forEach((step, j) => {
      const where = `${at} step ${j + 1}`;
      if (CALL_STEPS.has(step?.type) || DIRECTOR_STEPS.has(step?.type)) {
        if (step.type === "say" && (typeof step.text !== "string" || !step.text.trim())) problems.push(`${where}: say has no text`);
        if (step.type === "dtmf" && String(step.digit ?? "") === "") problems.push(`${where}: dtmf has no digit`);
        if (step.type === "wait" && step.ms != null && !(Number(step.ms) >= 0)) problems.push(`${where}: wait has no usable ms`);
        return;
      }
      const name = step?.action ?? step?.type;
      if (!name) problems.push(`${where}: no type`);
      else if (typeof handlers[name] !== "function") problems.push(`${where}: the console has no handler for "${name}"`);
    });
  });
  return problems;
}

/** DEMO-SCRIPT.md describes the same beats, in the same order, as the beat strip. */
export function checkScript(markdown, beats) {
  const text = String(markdown).replace(/\r\n?/g, "\n");
  const problems = [];
  const title = text.match(/^# Demo script — (\d+) beats?\b/m);
  if (!title) problems.push('no "# Demo script — N beats, about M minutes" title');
  else if (Number(title[1]) !== beats.length) problems.push(`the title says ${title[1]} beats; beats.js has ${beats.length}`);
  const keys = text.match(/\*\*1\*\*–\*\*(\d+)\*\*/);
  if (keys && Number(keys[1]) !== beats.length) problems.push(`the keys table says 1–${keys[1]}; beats.js has ${beats.length} beats`);
  const headings = [...text.matchAll(/^## (\d+) — (.+?)(?:[ \t]+\*\(~[^)\n]*\)\*)?[ \t]*$/gm)];
  headings.forEach(([, n, heading], i) => {
    if (Number(n) !== i + 1) problems.push(`"## ${n} — ${heading}" is out of sequence (expected ${i + 1})`);
  });
  for (let i = 0; i < Math.max(headings.length, beats.length); i++) {
    const doc = headings[i]?.[2];
    const strip = beats[i]?.title;
    if (doc == null) problems.push(`beat ${i + 1} "${strip}" has no "## ${i + 1} — …" section`);
    else if (strip == null) problems.push(`"## ${i + 1} — ${doc}" has no beat in beats.js`);
    else if (!sameTitle(doc, strip)) problems.push(`beat ${i + 1}: beats.js "${strip}" ≠ DEMO-SCRIPT.md "${doc}"`);
  }
  return problems;
}

// ------------------------------------------------------------------ server

function boot(root, entry, env) {
  const child = spawn(process.execPath, [entry], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const keep = (chunk) => {
    output = (output + chunk).slice(-64_000);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  const exited = new Promise((done) => child.once("exit", done));
  const running = () => child.exitCode === null && child.signalCode === null;
  return {
    running,
    output: () => output,
    async stop() {
      if (!running()) return;
      child.kill();
      await exited;
    },
    kill: () => running() && child.kill(),
  };
}

async function health(origin) {
  try {
    const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function waitForHealth(origin, server) {
  const deadline = Date.now() + BOOT_MS;
  while (Date.now() < deadline && server.running()) {
    const answer = await health(origin);
    if (answer) return answer;
    await sleep(250);
  }
  throw new Error(`the server ${server.running() ? `did not answer /health within ${BOOT_MS} ms` : "exited while starting"}`);
}

async function request(origin, method, path, body) {
  const init = { method, headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(origin + path, init);
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** A promise that gives up after `ms`, without leaving the loser unhandled. */
function within(ms, promise, label) {
  const work = Promise.resolve(promise);
  work.catch(() => {});
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** The console's hub connection (connectHub in presenter-kit.js), minus the DOM. */
async function listen(origin, path) {
  const Socket = globalThis.WebSocket ?? (await import("ws")).WebSocket;
  const socket = new Socket(origin.replace(/^http/, "ws") + path);
  const frames = [];
  const listeners = new Set();
  let lastAt = 0;
  socket.onmessage = (event) => {
    lastAt = performance.now();
    let frame;
    try {
      frame = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const target = frame.target ?? frame.type;
    const payload = (Array.isArray(frame.arguments) ? frame.arguments[0] : (frame.payload ?? frame.data)) ?? {};
    if (!target) return;
    frames.push({ target, payload });
    for (const listener of listeners) listener(target, payload);
  };
  await new Promise((opened, failed) => {
    socket.onopen = opened;
    socket.onerror = () => failed(new Error(`the hub refused the console's connection (${path})`));
  });
  socket.onerror = null;
  return {
    frames,
    on: (listener) => listeners.add(listener),
    /** hubQuiet() in presenter-kit.js. */
    async quiet(quietMs = QUIET_MS, maxMs = QUIET_MAX_MS) {
      const started = performance.now();
      await sleep(Math.min(quietMs, 200));
      while (performance.now() - started < maxMs) {
        if (performance.now() - lastAt >= quietMs) return true;
        await sleep(60);
      }
      return false;
    },
    close() {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
  };
}

// --------------------------------------------------------------- console

const IS_LOCAL = (ref) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref);
const KIT_FILES = ["/presenter-kit.js", "/presenter-kit.css", "/beats.js"];

function moduleRefs(source) {
  return [
    ...source.matchAll(/^\s*(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']/gm),
    ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ]
    .map((m) => m[1])
    .filter((ref) => /^(?:\/|\.\/|\.\.\/)/.test(ref));
}

const pageRefs = (html) =>
  [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]).filter(IS_LOCAL);

/**
 * The console page and any page it links to, their styles and scripts, and
 * every module those import, are served with a type the browser will use.
 */
async function checkConsole(origin, report) {
  const queue = [`${origin}/`];
  const fetched = new Set();
  const broken = [];
  while (queue.length) {
    const url = new URL(queue.shift());
    url.hash = "";
    url.search = "";
    if (url.origin !== origin || fetched.has(url.pathname)) continue;
    fetched.add(url.pathname);
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      broken.push(`${url.pathname} answered ${res.status}`);
      await res.arrayBuffer();
      continue;
    }
    if (url.pathname === "/" || /\.html?$/.test(url.pathname)) {
      if (!/text\/html/.test(type)) broken.push(`${url.pathname} is served as ${type || "no type"}, not a page`);
      for (const ref of pageRefs(await res.text())) queue.push(new URL(ref, url).href);
    } else if (/\.m?js$/.test(url.pathname)) {
      if (!/javascript/.test(type)) broken.push(`${url.pathname} is served as ${type || "no type"}, so the browser won't run it`);
      for (const ref of moduleRefs(await res.text())) queue.push(new URL(ref, url).href);
    } else {
      if (/\.css$/.test(url.pathname) && !/text\/css/.test(type)) {
        broken.push(`${url.pathname} is served as ${type || "no type"}, so the browser won't apply it`);
      }
      await res.arrayBuffer();
    }
  }
  for (const file of KIT_FILES) if (!fetched.has(file)) broken.push(`the console never loads ${file}`);
  report.check(!broken.length, `console  ${fetched.size} pages, styles and modules load, including the kit and the beats`, broken);
}

// ---------------------------------------------------------------- report

function reporter() {
  let failures = 0;
  const line = (mark, label, detail) => {
    console.log(`${mark}  ${label}`);
    for (const d of [].concat(detail ?? [])) console.log(`      ${d}`);
  };
  return {
    get failures() {
      return failures;
    },
    section: (title) => console.log(`\n${title}`),
    ok: (label) => line("ok  ", label),
    fail(label, detail) {
      failures += 1;
      line("FAIL", label, detail);
    },
    check(passed, label, detail) {
      if (passed) line("ok  ", label);
      else this.fail(label, typeof detail === "function" ? detail() : detail);
      return passed;
    },
  };
}

// ------------------------------------------------------------------ rehearse

/**
 * @param {object} options
 * @param {number} options.port            Port for the rehearsal's own server: the demo port plus 200.
 * @param {object} [options.env]           Settings for the simulation server on top of the shipped defaults:
 *                                         in-memory storage. Nothing else from your shell or .env is passed.
 * @param {object} [options.liveEnv]       Fictional (.invalid) settings that make the server live, for the 403 checks.
 * @param {Array}  [options.liveRefused]   More POST routes (path, or [path, body]) a live server must refuse with 403.
 *                                         The demo clock and reset are always checked.
 * @param {(step, ctx) => object} [options.startBody]  The console's startBody() for a start step.
 * @param {object|((ctx) => object)} [options.hooks]   Extra hooks for createBeats() — setClock is built in.
 * @param {object|((ctx) => object)} [options.actions] Handlers for action steps — metrics is built in.
 * @param {(step, ctx) => Promise} [options.perform]   The console's perform() wrapper. The default waits while
 *                                         `busy`, then hangs up an unfinished call before a new start.
 * @param {(snapshot, ctx) => boolean} [options.busy]  True while something is about to land (a transfer in flight).
 * @param {number|((ctx) => number)} [options.settleMs] How long the console waits for a busy call before a new
 *                                         one, and how long a beat may stay busy after its last step.
 * @param {(state) => boolean} [options.isFinished]     The console's TERMINAL states.
 * @param {object|((ctx) => object)} [options.sessionOptions]  More createCallSession() options the console passes
 *                                         (stateTargets, stateOf, onFollow for calls the server starts itself).
 * @param {(target, payload) => boolean} [options.hubFilter]  Frames the console drops before its call session.
 * @param {(args) => object} [options.outcome]  What a beat leaves on screen, as plain JSON without ids or times.
 *                                         Gets { beat, calls: [{ id, snapshot, events, frames }], results, ctx }.
 * @param {object} [options.expected]      Beat title → pinned outcome.
 * @param {(stats) => object} [options.stats]  The metrics after a full run, without timings.
 * @param {object} [options.expectedStats] The pinned metrics after a full run.
 */
export async function rehearse({
  root = fileURLToPath(new URL("..", import.meta.url)),
  port,
  server = "src/server.mjs",
  env = {},
  liveEnv = null,
  liveRefused = [],
  hubPath = "/ws/hub?user=*",
  hubFilter = null,
  simulateBase = "/api/simulate",
  startBody = () => ({}),
  hooks = {},
  actions = {},
  perform = null,
  onReset = null,
  stateOf = (snapshot) => snapshot?.state ?? snapshot?.status,
  isFinished,
  sessionOptions = {},
  busy = null,
  settleMs = 10_000,
  stepTimeoutMs = 30_000,
  outcome = defaultOutcome,
  expected = null,
  stats = null,
  expectedStats = null,
  exit = true,
} = {}) {
  if (!Number.isInteger(port)) throw new TypeError("rehearse() needs a port for its own server");
  root = root instanceof URL ? fileURLToPath(root) : root;
  const origin = `http://127.0.0.1:${port}`;
  const report = reporter();
  const startedAt = Date.now();
  const kit = await import(pathToFileURL(join(root, "public", "presenter-kit.js")).href);
  const { createBeats } = await import(pathToFileURL(join(root, "public", "beats.js")).href);

  // ---- the console, without a page: one call session, one simulator.
  const ctx = { origin, kit, health: null, beat: null, calls: [], hub: null, sleep };
  ctx.get = (path) => kit.getJson(origin + path);
  ctx.post = (path, body) => kit.postJson(origin + path, body);
  ctx.request = (method, path, body) => request(origin, method, path, body);

  const session = kit.createCallSession({ isFinished, ...resolve(sessionOptions, ctx) });
  const track = (snapshot) => {
    const state = snapshot ? stateOf(snapshot) : null;
    if (session.id && state != null && state !== "") session.handle("state", { callId: session.id, state });
  };
  const handlers = { metrics: () => ctx.get("/api/stats"), ...resolve(actions, ctx) };
  const sim = kit.createSimulator({
    session,
    base: origin + simulateBase,
    startBody: (step) => startBody(step, ctx),
    onSnapshot: track,
    actions: handlers,
  });
  Object.assign(ctx, { session, sim });

  ctx.snapshot = async (id = session.id) => {
    if (!id) return null;
    const res = await ctx.request("GET", `/api/calls/${encodeURIComponent(id)}`);
    return res.status === 200 ? res.body : null;
  };

  /** Waits while the call on screen is busy (bounded, like the console), and refreshes its state. */
  ctx.settle = async ({ strict = false, ms = resolveMs(settleMs, ctx) } = {}) => {
    const id = session.id;
    if (!id) return null;
    const deadline = Date.now() + ms;
    for (;;) {
      const snapshot = await ctx.snapshot(id);
      if (id === session.id) track(snapshot);
      if (!snapshot || !busy?.(snapshot, ctx)) return snapshot;
      if (Date.now() >= deadline) {
        if (strict) throw new Error(`the call is still busy (${stateOf(snapshot)}) after ${ms} ms`);
        return snapshot;
      }
      await sleep(POLL_MS);
    }
  };

  const consolePerform =
    perform ??
    (async (step, c) => {
      if (step.type === "start") {
        await c.settle();
        if (c.session.id && !c.session.finished && !c.session.followed) await c.sim.hangup().catch(() => {});
      }
      return c.sim.perform(step);
    });

  const setClock = async (preset) => {
    await ctx.post("/api/demo/clock", { preset });
  };

  // ---- the script, before anything runs.
  report.section("Script");
  let beats = [];
  try {
    beats = createBeats({ setClock, ...resolve(hooks, ctx) });
  } catch (error) {
    report.fail(`beats    createBeats() threw: ${error?.message ?? error}`);
  }
  report.check(!checkBeats(beats, handlers).length, `beats    ${beats.length} beats, and the console can run every step`, () => checkBeats(beats, handlers));
  const markdown = await readFile(join(root, "DEMO-SCRIPT.md"), "utf8").catch(() => null);
  const scriptProblems = markdown == null ? ["DEMO-SCRIPT.md is missing"] : checkScript(markdown, beats);
  report.check(!scriptProblems.length, "script   DEMO-SCRIPT.md has the same beats, in the same order", scriptProblems);
  const stale = Object.keys(expected ?? {}).filter((title) => !beats.some((b) => b.title === title));
  report.check(!stale.length, "pins     every pinned outcome belongs to a beat", stale.map((t) => `"${t}" is pinned, but no beat has that title`));

  // ---- the stage.
  const simEnv = {
    ...systemEnv(),
    // dotenv/config reads this: load .env from the null device, which is empty.
    DOTENV_CONFIG_PATH: devNull,
    PORT: String(port),
    HOST: "127.0.0.1",
    ...env,
  };
  let srv = null;
  let phaseFailures = 0;
  const failedLogs = [];
  const startServer = (serverEnv, label) => {
    srv = boot(root, server, serverEnv);
    srv.label = label;
    phaseFailures = report.failures;
  };
  /** Stops the server, keeping its output when anything failed while it ran. */
  const stopServer = async () => {
    if (!srv) return;
    const output = srv.output().trim();
    if (report.failures > phaseFailures && output) failedLogs.push([srv.label, output]);
    await srv.stop();
    srv = null;
  };
  const first = new Map();
  let firstStats = null;
  let repin = false;
  let plays = 0;
  const noisy = [];
  process.on("exit", () => srv?.kill());

  /** The console's Reset button: the server's demo reset, then a blank screen. */
  async function resetStage() {
    const res = await ctx.request("POST", "/api/demo/reset", {});
    session.reset();
    if (res.status !== 200 || res.body?.ok === false) throw new Error(`POST /api/demo/reset answered ${res.status} ${json(res.body)}`);
    await onReset?.(ctx);
    const now = await ctx.get("/api/stats");
    return plain(stats ? stats(now) : now);
  }

  async function playBeat(beat, pace) {
    const before = session.id;
    const ids = [];
    const results = [];
    const from = ctx.hub.frames.length;
    ctx.beat = beat;
    ctx.calls = ids;
    const noteCall = () => {
      if (session.id && session.id !== before && !ids.includes(session.id)) ids.push(session.id);
    };
    let at = "prepare";
    try {
      await within(stepTimeoutMs, beat.prepare?.(), at);
      for (const [s, step] of beat.steps.entries()) {
        at = `step ${s + 1} (${describe(step)})`;
        if (pace === "autoplay" && s > 0 && !step.chain) {
          if (!(await ctx.hub.quiet())) noisy.push(`${beat.title}, before step ${s + 1}`);
          await sleep(DWELL_MS);
        }
        if (pace !== "fast" && step.type === "say" && !step.chain) await sleep(typingMs(step.text));
        if (step.type === "note") continue;
        if (step.type === "wait") {
          await sleep(step.ms ?? 1000);
          continue;
        }
        results.push(plain(await within(stepTimeoutMs, consolePerform(step, ctx), at)));
        noteCall();
      }
      at = "the end of the beat";
      await ctx.settle({ strict: true });
      noteCall();
    } catch (error) {
      return { error: `${at}: ${error?.message ?? error}` };
    }
    const calls = [];
    for (const id of ids) {
      const snapshot = await ctx.snapshot(id);
      const listed = await ctx.request("GET", `/api/calls/${encodeURIComponent(id)}/events`);
      const events = Array.isArray(listed.body) ? listed.body : Array.isArray(listed.body?.events) ? listed.body.events : [];
      const frames = ctx.hub.frames.slice(from).filter((f) => f.payload?.callId === id);
      calls.push({ id, snapshot, events, frames });
    }
    const silent = calls.filter((c) => !c.frames.length).map((c) => c.id);
    if (silent.length) return { error: `the hub sent the console nothing for ${silent.join(", ")}` };
    try {
      return plain(await outcome({ beat, calls, results, ctx }));
    } catch (error) {
      return { error: `outcome(): ${error?.message ?? error}` };
    }
  }

  try {
    if (await health(origin)) throw new Error(`something is already answering on port ${port}; stop it so the rehearsal runs its own server`);
    startServer(simEnv, "simulation mode");
    ctx.health = await waitForHealth(origin, srv);

    report.section(`Server — simulation mode, port ${port}`);
    report.check(!kit.isLive(ctx.health), "health   simulation mode: no Azure settings, so nothing real is called", [
      "this server thinks it is live: the runner's env (or the template's built-in defaults) must not configure Azure",
    ]);
    await checkConsole(origin, report);
    const clock = await ctx.request("GET", "/api/demo/clock");
    report.check(clock.status === 200 && clock.body?.adjustable === true, "clock    the demo clock is adjustable", [`GET /api/demo/clock answered ${clock.status} ${json(clock.body)}`]);
    ctx.hub = await listen(origin, hubPath);
    ctx.hub.on((target, payload) => {
      if (!hubFilter || hubFilter(target, payload)) session.handle(target, payload);
    });

    const order = beats.map((_, i) => i);
    const runs = [
      { what: "in order", pace: "autoplay", plays: order },
      { what: "after a reset, in order", pace: "presenter", plays: order },
      { what: "after a reset, last beat first, each beat twice", pace: "fast", plays: [...order].reverse().flatMap((i) => [i, i]) },
    ];
    const baseline = await resetStage();
    for (const [r, run] of runs.entries()) {
      if (r > 0) await resetStage();
      report.section(`Rehearsal ${r + 1} of ${runs.length} — ${run.what}, ${PACES[run.pace]}`);
      const runStarted = Date.now();
      const played = new Set();
      for (const i of run.plays) {
        const beat = beats[i];
        const label = `beat ${i + 1}${played.has(i) ? " again" : ""}  ${beat.title}`;
        played.add(i);
        plays += 1;
        const actual = await playBeat(beat, run.pace);
        if (r === 0) first.set(i, actual);
        if (actual?.error) {
          report.fail(label, actual.error);
        } else if (r === 0) {
          const want = expected?.[beat.title];
          if (want === undefined) {
            repin = true;
            report.fail(label, [`no outcome pinned; it reached ${json(actual)}`]);
          } else if (!report.check(isDeepStrictEqual(actual, plain(want)), label, [`pinned  ${json(want)}`, `reached ${json(actual)}`])) {
            repin = true;
          }
        } else {
          const want = first.get(i);
          report.check(!want?.error && isDeepStrictEqual(actual, want), `${label}  (as in rehearsal 1)`, [
            `rehearsal 1 ${json(want)}`,
            `this time   ${json(actual)}`,
          ]);
        }
      }
      // A beat in reverse order may restore the stage itself, so only in-order runs compare metrics.
      if (stats && r < 2) {
        const now = plain(stats(await ctx.get("/api/stats")));
        if (r === 0) {
          firstStats = now;
          if (expectedStats == null) {
            repin = true;
            report.fail("metrics  after every beat", [`no metrics pinned; they reached ${json(now)}`]);
          } else if (!report.check(isDeepStrictEqual(now, plain(expectedStats)), "metrics  after every beat", [`pinned  ${json(expectedStats)}`, `reached ${json(now)}`])) {
            repin = true;
          }
        } else {
          report.check(isDeepStrictEqual(now, firstStats), "metrics  after every beat  (as in rehearsal 1)", [`rehearsal 1 ${json(firstStats)}`, `this time   ${json(now)}`]);
        }
      }
      if (run.pace === "autoplay" && noisy.length) {
        console.log(`note  Auto-play waited the full ${QUIET_MAX_MS / 1000} s for the hub to go quiet ${noisy.length} time(s), which the room sees as a stall:`);
        for (const where of noisy) console.log(`      ${where}`);
      }
      console.log(`      ${((Date.now() - runStarted) / 1000).toFixed(1)} s`);
    }
    const after = await resetStage();
    report.check(
      isDeepStrictEqual(after, baseline),
      "reset    puts the metrics back where they started",
      [`before ${json(baseline)}`, `after  ${json(after)}`],
    );
    ctx.hub.close();
    await stopServer();

    if (liveEnv) {
      report.section("Server — live mode, with fictional .invalid settings (nothing is called)");
      startServer({ ...simEnv, ...liveEnv }, "live mode");
      report.check(kit.isLive(await waitForHealth(origin, srv)), "health   the server answers real calls", [
        "liveEnv did not make the server live, so the 403 checks below prove nothing",
      ]);
      const refused = [["/api/demo/clock", { preset: "real" }], ["/api/demo/reset", {}], ...liveRefused.map((x) => (Array.isArray(x) ? x : [x, {}]))];
      for (const [path, body] of refused) {
        const res = await ctx.request("POST", path, body ?? {});
        report.check(res.status === 403, `refused  POST ${path}  (403)`, [`answered ${res.status} ${json(res.body)}`]);
      }
      const live = await ctx.request("GET", "/api/demo/clock");
      report.check(live.status === 200 && live.body?.adjustable === false, "clock    real time, and not adjustable", [`GET /api/demo/clock answered ${live.status} ${json(live.body)}`]);
      await stopServer();
    }
  } catch (error) {
    report.fail(`stage    ${error?.message ?? error}`);
  } finally {
    ctx.hub?.close();
    await stopServer();
  }

  if (repin) {
    console.log("\nRehearsal 1 reached these outcomes. If each one is what DEMO-SCRIPT.md tells the room,");
    console.log("pin them in scripts/rehearse.mjs:\n");
    console.log("const EXPECTED = {");
    for (const [i, beat] of beats.entries()) {
      const reached = first.get(i);
      if (reached && !reached.error) console.log(`  ${json(beat.title)}: ${pretty(reached, "  ", json(beat.title).length + 2)},`);
    }
    console.log("};");
    if (stats && firstStats) console.log(`\nconst EXPECTED_STATS = ${pretty(firstStats, "", 22)};`);
  }

  const seconds = Math.round((Date.now() - startedAt) / 1000);
  if (report.failures) {
    for (const [label, output] of failedLogs) {
      console.error(`\nServer output, ${label} (last lines):\n${output.split("\n").slice(-40).join("\n")}`);
    }
    console.error(`\nRehearsal failed: ${report.failures} problem${report.failures === 1 ? "" : "s"} (${seconds} s).`);
  } else {
    console.log(`\nrehearsal ok — ${beats.length} beats, ${plays} plays, ${seconds} s`);
  }
  if (exit) process.exit(report.failures ? 1 : 0);
  return { failures: report.failures };
}
