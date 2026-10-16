import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HARNESS_DIR, TEMPLATES_DIR, config } from "./config.mjs";
import { TemplateProbe } from "./probe.mjs";
import { CheckFailed, ScenarioContext } from "./scenario.mjs";
import { crashSummary, redactPhones, sleep, templateReadiness, withTimeout } from "./util.mjs";

export async function loadSuites(dir = path.join(HARNESS_DIR, "scenarios")) {
  const suites = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort()) {
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    // A file exports one suite, or several for one template (each with its own `id`).
    for (const suite of [mod.default].flat()) suites.push({ file, ...suite });
  }
  return suites.sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || suiteKey(a).localeCompare(suiteKey(b)));
}

/** A template can have several suites (e.g. one per configuration); `id` tells them apart. */
export const suiteKey = (suite) => suite.id ?? suite.template;

/** What a template's /health says is stopping it from taking real calls. */
export const healthProblems = templateReadiness;

export function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** A clean per-run folder for the fixtures and databases a suite generates. */
function createRuntime(suite) {
  const dir = path.join(config.dirs.runtime, suiteKey(suite));
  const templateDir = path.join(TEMPLATES_DIR, suite.template, "code");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const runtime = {
    dir,
    templateDir,
    harnessNumber: config.harnessNumber,
    templateNumber: config.templateNumber,
    path: (name) => path.join(dir, name),
    /** Reads a JSON fixture that ships with the template. */
    readTemplateJson: (rel) => JSON.parse(fs.readFileSync(path.join(templateDir, rel), "utf8")),
    writeJson(name, value) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
      return file;
    },
    /** Runs a template script (e.g. its seed) with the same environment the server gets. */
    node(args, env) {
      return execFileSync(process.execPath, args, { cwd: templateDir, env: cleanEnv(env), encoding: "utf8" });
    },
  };
  // Templates load their own .env through dotenv/config. Pointing it at an empty
  // file keeps a developer's local .env (API keys, their own phone number) out of
  // the run: a template gets this harness's environment, the suite's env, and
  // its own defaults, and nothing else.
  const noDotenv = runtime.path("template.env");
  fs.writeFileSync(noDotenv, "");
  runtime.env = cleanEnv({
    ...process.env,
    DOTENV_CONFIG_PATH: noDotenv,
    HOST: "127.0.0.1",
    PORT: String(config.templatePort),
    PUBLIC_BASE_URL: config.templatePublicUrl,
    ACS_ENDPOINT: config.acsEndpoint,
    VOICE_LIVE_ENDPOINT: config.voiceLiveEndpoint,
    DB_PATH: runtime.path("audit.db"),
  });
  return runtime;
}

// Unset rather than empty: several templates read `Number("")` as 0.
export function cleanEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** What a log gained after `offset` bytes: one scenario's share of a suite's server.log. */
function readFrom(file, offset) {
  try {
    return fs.readFileSync(file).subarray(offset).toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Starts a template and waits for its /health. The handle's `crashed` settles
 * with the exit code (or signal) if the process ends without the harness
 * stopping it.
 */
async function startTemplate(suite, env, logFile) {
  const cwd = path.join(TEMPLATES_DIR, suite.template, "code");
  if (!fs.existsSync(path.join(cwd, "node_modules"))) throw new Error(`run "npm ci" in ${cwd} first`);
  const out = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, ["src/server.mjs"], { cwd, env, stdio: ["ignore", out, out] });
  fs.closeSync(out);
  const server = { child, logFile, exited: null, stopping: false };
  // However the harness exits (Ctrl+C included), it never leaves a template running.
  const killOnExit = () => child.kill("SIGKILL");
  process.once("exit", killOnExit);
  server.crashed = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      server.exited = code ?? signal;
      process.off("exit", killOnExit);
      if (!server.stopping) resolve(server.exited);
    });
  });
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    if (server.exited !== null) throw new Error(`the template exited while starting (${server.exited}); see ${logFile}`);
    try {
      const res = await fetch(`http://127.0.0.1:${config.templatePort}/health`);
      if (res.ok) return server;
    } catch {
      // not listening yet
    }
    await sleep(300);
  }
  server.stopping = true;
  child.kill("SIGKILL");
  throw new Error(`the template did not answer /health within 30 s; see ${logFile}`);
}

async function stopTemplate(server) {
  const child = server?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  server.stopping = true;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGINT");
  const clean = await withTimeout(exited, 6000).then(
    () => true,
    () => false,
  );
  if (!clean) child.kill("SIGKILL");
}

async function publicHealth(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function runSuite(suite, { harness, attach = false, only = null, outDir, log }) {
  const result = {
    template: suite.template,
    suite: suiteKey(suite),
    title: suite.title,
    startedAt: new Date().toISOString(),
    health: null,
    error: null,
    scenarios: [],
  };
  const suiteDir = path.join(outDir, suiteKey(suite));
  fs.mkdirSync(suiteDir, { recursive: true });
  const logFile = path.join(suiteDir, "server.log");
  const localUrl = `http://127.0.0.1:${config.templatePort}`;
  let server = null;
  let env = null;
  let probe = null;
  let runtime = null;
  log(`\n■ ${suite.title} (${suiteKey(suite)})`);
  try {
    if (!attach) {
      if (await portInUse(config.templatePort)) {
        throw new Error(
          `port ${config.templatePort} is in use; stop whatever is running there, or pass --attach to test it as it is`,
        );
      }
      runtime = createRuntime(suite);
      const extra = (await suite.prepare?.(runtime)) ?? {};
      env = cleanEnv({ ...runtime.env, ...(suite.env ?? {}), ...extra });
      server = await startTemplate(suite, env, logFile);
    }
    probe = new TemplateProbe({ baseUrl: localUrl, ...suite.probe });
    result.health = await probe.health();
    const problems = healthProblems(result.health);
    if (problems.length) throw new Error(problems.join("; "));
    if (!(await publicHealth(config.templatePublicUrl))) {
      throw new Error("TEMPLATE_PUBLIC_URL does not reach the template; is its dev tunnel hosted?");
    }
    await probe.connect();
    for (const scenario of suite.scenarios) {
      if (only && !only.has(scenario.name)) continue;
      if (server?.exited != null) {
        // The scenario before took the template down, and its record says so.
        // This one gets a fresh process (same environment and databases)
        // rather than a line nobody answers.
        log(`  ↻ restarting the template, which exited (${server.exited})`);
        probe.close();
        server = await startTemplate(suite, env, logFile);
        probe = new TemplateProbe({ baseUrl: localUrl, ...suite.probe });
        await probe.connect();
      }
      result.scenarios.push(
        await runScenario(suite, scenario, { harness, probe, runtime, server, settleMs: suite.cooldownMs ?? 4000, log }),
      );
    }
  } catch (e) {
    result.error = e.message;
    log(`  ! ${e.message}`);
  } finally {
    probe?.close();
    await stopTemplate(server);
  }
  result.finishedAt = new Date().toISOString();
  return result;
}

/**
 * How a scenario went, from what it threw and the checks it recorded: a failed
 * check that ended it, or a non-fatal one that let the call carry on, is a
 * failure; failed soft checks alone (model wording, timing) are a warning.
 */
export function scenarioStatus(checks, thrown = null) {
  if (thrown) return thrown instanceof CheckFailed ? "fail" : "error";
  if (checks.some((c) => !c.ok && !c.soft)) return "fail";
  if (checks.some((c) => !c.ok)) return "warn";
  return "pass";
}

async function runScenario(suite, scenario, { harness, probe, runtime, server = null, settleMs = 0, log }) {
  const r = { name: scenario.name, title: scenario.title, status: "pass", checks: [] };
  if (scenario.skip) {
    log(`  - ${scenario.name}: skipped (${scenario.skip})`);
    return { ...r, status: "skip", reason: scenario.skip };
  }
  log(`  ▶ ${scenario.name}: ${scenario.title}`);
  const t = new ScenarioContext({ harness, probe, suite, scenario, runtime, log });
  const started = Date.now();
  const logFrom = server ? fileSize(server.logFile) : 0;
  // Settles only if the template process dies; never, when the harness did not start it (--attach).
  const crashed = server ? server.crashed.then((code) => ({ code })) : new Promise(() => {});
  let thrown = null;
  let crash = null;
  try {
    await suite.beforeEach?.(t);
    const timeoutMs = scenario.timeoutMs ?? 240000;
    crash = await withTimeout(
      Promise.race([scenario.run(t).then(() => null), crashed]),
      timeoutMs,
      `scenario timed out after ${Math.round(timeoutMs / 1000)} s`,
    );
  } catch (e) {
    thrown = e;
    if (!(e instanceof CheckFailed)) {
      r.error = e.message;
      log(`    ! ${e.message}`);
    }
  } finally {
    t.end();
    await t.hangup().catch(() => {});
  }
  await t.checkLanguage().catch((e) => log(`    ! language check: ${e.message}`));
  // The cooldown before the next call doubles as the window for a crash on the
  // way out, e.g. in a handler that runs when the media socket closes.
  const settling = Date.now();
  crash ??= await Promise.race([crashed, sleep(settleMs).then(() => null)]);
  const settledMs = Date.now() - settling;
  if (crash) {
    const why = crashSummary(readFrom(server.logFile, logFrom));
    const detail = `it exited (${crash.code})${why ? `: ${why}` : `; see ${path.basename(server.logFile)}`}`;
    t.check("the template server kept running", false, redactPhones(detail), { fatal: false });
    // The template failing is the finding, even when it surfaced as a harness error ("the call ended").
    if (!(thrown instanceof CheckFailed)) thrown = new CheckFailed("the template server kept running");
  }
  r.status = scenarioStatus(t.checks, thrown);
  r.durationMs = Date.now() - started - settledMs;
  r.checks = t.checks;
  r.timeline = t.legs
    .flatMap((leg, i) => leg.timeline.map((e) => ({ ...e, at: leg.t0 + e.at - started, leg: i + 1 })))
    .sort((a, b) => a.at - b.at);
  r.audio = t.legs.map((l) => l.audio);
  if (t.id) {
    r.recordId = t.id;
    r.events = await probe.events(t.id).catch(() => []);
    r.record = await probe.record(t.id).catch(() => null);
    r.serverTranscript = probe.messagesFor(t.id, "transcript").map((m) => m.payload);
  }
  log(`    = ${r.status.toUpperCase()} in ${(r.durationMs / 1000).toFixed(0)} s`);
  return r;
}
