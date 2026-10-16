#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { TEMPLATES_DIR, config, missingConfig } from "./src/config.mjs";
import { listArg, parseArgs, redactPhones } from "./src/util.mjs";

const HELP = `Voice harness: a second phone number calls each voice AI template, speaks its
demo script, and checks the call flow the template recorded.

Usage: node run.mjs <command> [options]

  list                       Show every suite and scenario.
  doctor                     Check config, Azure sign-in, speech, and both dev tunnels.
  serve                      Run only the harness line (Event Grid handshake, manual calls).
  call [--answer] [--to N]   Be the caller yourself: type a line to say it,
                             "/dtmf 12#" to press keys, "/bye" to hang up.
                             --answer waits for a template to call the harness instead.
  run [options]              Run suites over live calls, one template at a time.
      --template a,b         Only these templates (folder names under docs/templates).
      --scenario x,y         Only these scenarios.
      --attach               Test the template already running on TEMPLATE_PORT
                             instead of starting a fresh one.

Reports are written to out/<run-id>/report.md and report.json, with phone
numbers redacted.`;

const args = parseArgs(process.argv.slice(2));
const log = (m) => console.log(redactPhones(m));

function requireConfig() {
  const missing = missingConfig();
  if (missing.length) {
    throw new Error(`missing configuration: ${missing.join(", ")}. Copy .env.example to .env and fill it in.`);
  }
}

async function reachable(url) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10000) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (e) {
    return { status: 0, error: e.cause?.code ?? e.message };
  }
}

async function list() {
  const { loadSuites, suiteKey } = await import("./src/runner.mjs");
  for (const s of await loadSuites()) {
    log(`\n${suiteKey(s)}  [${s.direction}]  ${s.title}`);
    for (const sc of s.scenarios) log(`  ${sc.name.padEnd(30)} ${sc.skip ? `(skipped: ${sc.skip}) ` : ""}${sc.title}`);
  }
}

async function doctor() {
  let problems = 0;
  const report = (ok, name, detail) => {
    if (!ok) problems++;
    log(`${ok ? "✓" : "✗"} ${name}${detail ? `: ${detail}` : ""}`);
  };
  const missing = missingConfig();
  report(!missing.length, "configuration", missing.length ? `missing ${missing.join(", ")}` : null);

  const { addonCrashRisk, crashProneAddons, runnableTemplates } = await import("./src/preflight.mjs");
  const templates = runnableTemplates();
  const nodeModules = (t) => path.join(TEMPLATES_DIR, t, "code", "node_modules");
  const notInstalled = templates.filter((t) => !fs.existsSync(nodeModules(t)));
  if (notInstalled.length) log(`· run "npm ci" in these templates' code folders before testing them: ${notInstalled.join(", ")}`);
  if (addonCrashRisk()) {
    const prone = templates.filter((t) => crashProneAddons(nodeModules(t)).length);
    report(
      !prone.length,
      `native addons load on Node ${process.versions.node}`,
      prone.length
        ? `Node 24 before 24.22 aborts loading the native addons in ${prone.join(", ")}; use Node 22 LTS or 24.22+, or rebuild them (see README)`
        : null,
    );
  }
  if (missing.length) return (process.exitCode = 1);

  const { getToken } = await import("./src/azure.mjs");
  for (const [name, scope] of [
    ["Communication Services", "https://communication.azure.com/.default"],
    ["Speech", "https://cognitiveservices.azure.com/.default"],
  ]) {
    try {
      await getToken(scope);
      report(true, `Azure sign-in token for ${name}`);
    } catch (e) {
      report(false, `Azure sign-in token for ${name}`, `${e.message.split("\n")[0]} (run "az login")`);
    }
  }

  try {
    const { identifyLanguage, synthesize, transcribe } = await import("./src/speech.mjs");
    const pcm = await synthesize("Testing the voice harness, one two three.");
    const text = await transcribe(pcm);
    report(/voice harness/i.test(text), "speech round trip (synthesise, then transcribe)", `heard "${text}"`);
    const spoken = await identifyLanguage(pcm).catch((e) => ({ error: e.message }));
    log(
      spoken?.locale?.startsWith("en")
        ? `✓ language identification (flags an agent that drifts out of the expected language): heard ${spoken.locale}`
        : `· language identification unavailable (${spoken?.error ?? `heard ${spoken?.locale ?? "nothing"}`}); calls still run, without the language check`,
    );
  } catch (e) {
    report(false, "speech round trip", e.message);
  }

  const { portInUse } = await import("./src/runner.mjs");
  let harness = null;
  if (!(await portInUse(config.harnessPort))) {
    const { Harness } = await import("./src/harness.mjs");
    harness = new Harness({ log: () => {} });
    await harness.start();
  }
  const h = await reachable(config.harnessPublicUrl);
  report(
    h.body?.service === "voice-harness",
    "HARNESS_PUBLIC_URL reaches the harness",
    h.body?.service === "voice-harness" ? null : `${h.error ?? `HTTP ${h.status}`}; host its dev tunnel`,
  );
  await harness?.stop();

  const t = await reachable(config.templatePublicUrl);
  log(
    t.status === 200
      ? `· TEMPLATE_PUBLIC_URL reaches a running template (${t.body?.application ?? t.body?.service ?? "ok"})`
      : `· TEMPLATE_PUBLIC_URL has no template behind it right now (${t.error ?? `HTTP ${t.status}`}); fine, "run" starts one, but its dev tunnel must be hosted`,
  );
  log(problems ? `\n${problems} problem(s) to fix.` : "\nReady for live calls.");
  process.exitCode = problems ? 1 : 0;
}

async function serve() {
  requireConfig();
  const { Harness } = await import("./src/harness.mjs");
  const harness = new Harness({ log });
  await harness.start();
  log(`Harness line listening on 127.0.0.1:${config.harnessPort} (${config.harnessPublicUrl}).`);
  log("Unexpected calls to the harness number are rejected. Ctrl+C to stop.");
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await harness.stop();
}

async function call() {
  requireConfig();
  const { Harness } = await import("./src/harness.mjs");
  const harness = new Harness({ log });
  await harness.start();
  const rl = readline.createInterface({ input: process.stdin });
  try {
    let leg;
    if (args.answer) {
      log("Waiting up to 10 minutes for a call to the harness number…");
      leg = await harness.expectIncoming({ timeoutMs: 600000 });
    } else {
      leg = await harness.dial(typeof args.to === "string" ? args.to : config.templateNumber);
    }
    log('Connected. Type a line to say it, "/dtmf 12#" to press keys, "/bye" to hang up.');
    (async () => {
      while (!leg.ended) {
        const text = await leg.hear({ timeoutMs: 60000 });
        if (text) log(`agent: ${text}`);
      }
      log("(the call ended)");
      rl.close();
    })();
    for await (const line of rl) {
      const text = line.trim();
      if (!text) continue;
      if (text === "/bye" || leg.ended) break;
      try {
        if (text.startsWith("/dtmf ")) await leg.dtmf(text.slice(6).trim());
        else await leg.say(text);
      } catch (e) {
        log(`! ${e.message}`);
      }
    }
  } finally {
    rl.close();
    await harness.stop();
  }
}

async function run() {
  requireConfig();
  const { loadSuites, runSuite, suiteKey } = await import("./src/runner.mjs");
  const { Harness } = await import("./src/harness.mjs");
  const { summarize, writeReport } = await import("./src/report.mjs");

  const templates = listArg(args.template);
  const scenarios = listArg(args.scenario);
  const all = await loadSuites();
  // A template name selects all of its suites; a suite id selects just that one.
  const picks = (s) => templates.has(s.template) || templates.has(suiteKey(s));
  const unknown = [...(templates ?? [])].filter((t) => !all.some((s) => s.template === t || suiteKey(s) === t));
  if (unknown.length) throw new Error(`no suite for ${unknown.join(", ")}; see "node run.mjs list"`);
  const suites = all.filter(
    (s) => (!templates || picks(s)) && (!scenarios || s.scenarios.some((sc) => scenarios.has(sc.name))),
  );
  if (!suites.length) throw new Error('nothing matches those filters; see "node run.mjs list"');
  if (args.attach && suites.length !== 1) {
    throw new Error("--attach tests the one template already running on TEMPLATE_PORT; choose it with --template");
  }

  const id = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.join(config.dirs.out, id);
  const record = {
    id,
    startedAt: new Date().toISOString(),
    harnessNumber: config.harnessNumber,
    templateNumber: config.templateNumber,
    suites: [],
  };
  const harness = new Harness({ log });
  await harness.start();
  let stopping = false;
  const interrupt = async () => {
    if (stopping) process.exit(130);
    stopping = true;
    log("\nInterrupted: hanging up every call and stopping the template…");
    await harness.stop().catch(() => {});
    process.exit(130);
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const h = await reachable(config.harnessPublicUrl);
    if (h.body?.service !== "voice-harness") {
      throw new Error(`HARNESS_PUBLIC_URL does not reach the harness (${h.error ?? `HTTP ${h.status}`}); host its dev tunnel`);
    }
    for (const suite of suites) {
      record.suites.push(await runSuite(suite, { harness, attach: Boolean(args.attach), only: scenarios, outDir, log }));
      writeReport(record, outDir);
    }
  } finally {
    await harness.stop();
  }
  record.finishedAt = new Date().toISOString();
  const md = writeReport(record, outDir);
  const c = summarize(record);
  log(`\n${c.pass} passed, ${c.warn} passed with warnings, ${c.fail} failed, ${c.error} errored, ${c.skip} skipped.`);
  log(`Report: ${path.relative(process.cwd(), md)}`);
  process.exitCode = c.fail || c.error ? 1 : 0;
}

const commands = { list, doctor, serve, call, run, help: () => console.log(HELP) };
const command = commands[args._[0] ?? "help"];
if (!command) {
  console.error(`unknown command "${args._[0]}"\n`);
  console.log(HELP);
  process.exit(2);
}
try {
  await command();
} catch (e) {
  console.error(redactPhones(`error: ${e.message}`));
  process.exitCode = 1;
}
// Lingering timers (dropped-call cleanup, token refresh) must not hold the CLI open.
process.exit();
