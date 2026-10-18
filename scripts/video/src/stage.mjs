// Boot a template's console server in simulation mode, the way the CVP
// rehearsal engine does: nothing from your shell or .env reaches it. Its
// random ids come from a fixed seed (steady-ids.mjs), so every pass of a
// capture hears the same lines.
import { spawn } from "node:child_process";
import { devNull } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STEADY_IDS = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "steady-ids.mjs")).href;

const SYSTEM_ENV = new Set(
  "PATH HOME USER LOGNAME SHELL LANG LC_ALL LC_CTYPE TZ TMPDIR TMP TEMP".split(" "),
);
const systemEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => SYSTEM_ENV.has(name.toUpperCase())));

/** Per-template simulation settings, mirrored from each code/scripts/rehearse.mjs. */
export const SIMULATION = {
  "311-service-assistant": { DB_PATH: ":memory:" },
  "after-hours-sales-lead-capture": { DB_PATH: ":memory:" },
  "appointment-reminder-agent": { SCHEDULE_DB_PATH: ":memory:", AUDIT_DB_PATH: ":memory:" },
  "appointment-scheduling-agent": { DB_PATH: ":memory:", SCHEDULE_DB_PATH: ":memory:" },
  "bid-price-lookup-agent": { DB_PATH: ":memory:" },
  "contextual-on-call-pager": { DB_PATH: ":memory:" },
  "customer-record-lookup-update": { CRM_DB_PATH: ":memory:" },
  "general-inquiry-agent": { DB_PATH: ":memory:" },
  "intent-based-call-routing": { DB_PATH: ":memory:" },
  "it-helpdesk-password-reset": { DB_PATH: ":memory:" },
  "it-hr-help-desk-triage": { DB_PATH: ":memory:" },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health(origin) {
  try {
    const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} o
 * @param {string} o.repo  checkout holding docs/templates/<id>/code
 * @param {string} o.id    template id
 * @param {number} o.port
 */
export async function stage({ repo, id, port, env = {} }) {
  const root = join(repo, "docs", "templates", id, "code");
  const origin = `http://127.0.0.1:${port}`;
  if (await health(origin)) throw new Error(`port ${port} is already serving; pick another`);
  const child = spawn(process.execPath, ["--import", STEADY_IDS, "src/server.mjs"], {
    cwd: root,
    env: { ...systemEnv(), DOTENV_CONFIG_PATH: devNull, PORT: String(port), HOST: "127.0.0.1", ...SIMULATION[id], ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const keep = (c) => (output = (output + c).slice(-32_000));
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  const exited = new Promise((done) => child.once("exit", done));
  const deadline = Date.now() + 60_000;
  let h = null;
  while (Date.now() < deadline && child.exitCode === null) {
    h = await health(origin);
    if (h) break;
    await sleep(200);
  }
  if (!h) {
    child.kill();
    throw new Error(`${id} did not come up on ${port}:\n${output}`);
  }
  if (h.mode === "live" || h.callReady === true) {
    child.kill();
    throw new Error(`${id} booted in live mode; refusing to film it`);
  }
  return {
    origin,
    health: h,
    output: () => output,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill();
      await exited;
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [id, port] = process.argv.slice(2);
  if (!id || !port) {
    console.error("usage: node src/stage.mjs <template-id> <port>   (serves the console in simulation mode until Ctrl+C)");
    process.exit(2);
  }
  const repo = process.env.REPO ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const s = await stage({ repo, id, port: Number(port) });
  console.log(JSON.stringify(s.health));
  process.on("SIGINT", () => s.stop().then(() => process.exit(0)));
  process.on("SIGTERM", () => s.stop().then(() => process.exit(0)));
  await new Promise(() => {});
}
