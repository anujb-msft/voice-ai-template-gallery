try {
  await import("dotenv/config");
} catch {}

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const codeRoot = resolve(__dirname, "..");
const bool = (value, fallback = false) => {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
};
const num = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const rel = (p) => resolve(codeRoot, p);

export const DEFAULT_DEMO_NOW = "2026-05-19T10:00:00-07:00";

export const config = {
  appName: "appointment-reminder-agent",
  host: process.env.HOST ?? "127.0.0.1",
  port: num(process.env.PORT, 8099),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
  demoNow: process.env.DEMO_NOW ?? DEFAULT_DEMO_NOW,
  callTimeBudgetMs: num(process.env.CALL_TIME_BUDGET_MS, 240_000),
  acs: {
    endpoint: (process.env.ACS_ENDPOINT ?? "").replace(/\/$/, ""),
    connectionString: process.env.ACS_CONNECTION_STRING ?? "",
    callerId: process.env.ACS_CALLER_ID ?? "",
    teamsCloud: process.env.TEAMS_CLOUD ?? "public",
    teamsResourceAccountId: process.env.TEAMS_RESOURCE_ACCOUNT_ID ?? "",
  },
  voiceLive: {
    endpoint: (process.env.VOICE_LIVE_ENDPOINT ?? "").replace(/\/$/, ""),
    apiKey: process.env.VOICE_LIVE_API_KEY ?? "",
    model: process.env.VOICE_LIVE_MODEL ?? "gpt-realtime",
    apiVersion: process.env.VOICE_LIVE_API_VERSION ?? "2026-04-10",
    voice: process.env.VOICE_LIVE_VOICE ?? "en-US-Ava:DragonHDLatestNeural",
  },
  schedule: {
    adapter: process.env.SCHEDULE_ADAPTER ?? "sqlite",
    dbPath: process.env.SCHEDULE_DB_PATH ?? rel("data/schedule.db"),
    seedPath: process.env.SCHEDULE_SEED_PATH ?? rel("fixtures/appointments-seed.json"),
    handoffTokenSecret: process.env.HANDOFF_TOKEN_SECRET ?? "",
    handoffTokenTtlMs: num(process.env.HANDOFF_TOKEN_TTL_MS, 300_000),
  },
  campaign: {
    enabled: bool(process.env.CAMPAIGN_ENABLED, false),
    dryRun: bool(process.env.CAMPAIGN_DRY_RUN, true),
    maxConcurrent: num(process.env.CAMPAIGN_MAX_CONCURRENT, 2),
  },
  retention: {
    transcripts: bool(process.env.TRANSCRIPT_RETENTION, false),
    days: num(process.env.TRANSCRIPT_RETENTION_DAYS, 7),
  },
  voicemailGreetingMs: num(process.env.VOICEMAIL_GREETING_MS, 4500),
  schedulingAgentTarget: process.env.SCHEDULING_AGENT_TARGET ?? "",
  allowedTestNumbers: (process.env.ALLOWED_TEST_NUMBERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  paths: {
    campaign: rel("config/campaign.json"),
    clinics: rel("config/clinics.json"),
    prep: rel("config/prep.json"),
    scripts: rel("config/scripts.json"),
    detection: rel("config/detection.json"),
    routing: rel("config/routing.json"),
  },
};

export function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export const fixtures = {
  campaign: loadJson(config.paths.campaign),
  clinics: loadJson(config.paths.clinics),
  prep: loadJson(config.paths.prep),
  scripts: loadJson(config.paths.scripts),
  detection: loadJson(config.paths.detection),
  routing: loadJson(config.paths.routing),
};

export function nowDate(now = config.demoNow) {
  return new Date(now);
}

export function assertCallConfig(cfg = config) {
  const missing = [];
  if (!cfg.acs.endpoint && !cfg.acs.connectionString) missing.push("ACS_ENDPOINT");
  if (!cfg.acs.callerId) missing.push("ACS_CALLER_ID");
  if (!cfg.publicBaseUrl) missing.push("PUBLIC_BASE_URL");
  if (!cfg.voiceLive.endpoint) missing.push("VOICE_LIVE_ENDPOINT");
  return missing;
}

export function isSimulated() {
  return assertCallConfig().length > 0;
}

export function readiness() {
  const missing = assertCallConfig();
  return {
    ok: true,
    application: config.appName,
    mode: missing.length ? "simulation" : "live",
    simulation: missing.length > 0,
    missingConfig: missing,
    port: config.port,
    voiceLive: {
      ready: Boolean(config.voiceLive.endpoint),
      auth: config.voiceLive.apiKey ? "api-key" : "entra",
      model: config.voiceLive.model,
      apiVersion: config.voiceLive.apiVersion,
    },
    acs: {
      ready: Boolean((config.acs.endpoint || config.acs.connectionString) && config.acs.callerId && config.publicBaseUrl),
      auth: config.acs.endpoint ? "entra" : config.acs.connectionString ? "connection-string" : "none",
      callerIdConfigured: Boolean(config.acs.callerId),
      teamsResourceAccountId: config.acs.teamsResourceAccountId || null,
    },
    scheduleAdapter: config.schedule.adapter,
    scheduleDbPath: config.schedule.dbPath,
    campaignEnabled: config.campaign.enabled,
    campaignDryRun: config.campaign.dryRun,
    maxConcurrent: config.campaign.maxConcurrent,
    schedulingAgentTarget: config.schedulingAgentTarget || null,
    demoNow: config.demoNow,
  };
}
