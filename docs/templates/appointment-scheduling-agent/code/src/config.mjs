try { await import("dotenv/config"); } catch {}

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const codeRoot = resolve(__dirname, "..");
const bool = (value, fallback = false) => value == null || value === "" ? fallback : /^(1|true|yes|on)$/i.test(String(value));
const num = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const rel = (p) => resolve(codeRoot, p);

export const DEFAULT_DEMO_NOW = "2026-05-19T10:00:00-07:00";

export const config = {
  appName: "appointment-scheduling-agent",
  host: process.env.HOST ?? "127.0.0.1",
  port: num(process.env.PORT, 8100),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
  demoNow: process.env.DEMO_NOW ?? DEFAULT_DEMO_NOW,
  callTimeBudgetMs: num(process.env.CALL_TIME_BUDGET_MS, 420_000),
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
    holdTtlMs: num(process.env.HOLD_TTL_MS, 300_000),
    searchHorizonDays: num(process.env.SEARCH_HORIZON_DAYS, 90),
    optionsPerTurn: num(process.env.OPTIONS_PER_TURN, 3),
  },
  sms: {
    enabled: bool(process.env.SMS_ENABLED, false),
    from: process.env.ACS_SMS_FROM ?? "",
    allowedNumbers: (process.env.SMS_ALLOWED_NUMBERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  },
  schedulerMinutesPerBooking: num(process.env.SCHEDULER_MINUTES_PER_BOOKING, 6),
  retention: {
    transcripts: bool(process.env.TRANSCRIPT_RETENTION, false),
    days: num(process.env.TRANSCRIPT_RETENTION_DAYS, 7),
  },
  persistTranscripts: bool(process.env.TRANSCRIPT_RETENTION, false),
  dbPath: process.env.DB_PATH ?? rel("data/scheduling-audit.db"),
  paths: {
    clinics: rel("config/clinics.json"),
    eligibility: rel("config/eligibility.json"),
    orders: rel("config/orders.json"),
    prep: rel("config/prep.json"),
    providers: rel("config/providers.json"),
    referrals: rel("config/referrals.json"),
    routing: rel("config/routing.json"),
    safety: rel("config/safety.json"),
    visitTypes: rel("config/visit-types.json"),
  },
};

export function loadJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
export const fixtures = Object.fromEntries(Object.entries(config.paths).map(([k, p]) => [k, loadJson(p)]));
export function nowDate(now = config.demoNow) { return new Date(now); }

export function assertCallConfig(cfg = config) {
  const missing = [];
  if (!cfg.acs.endpoint && !cfg.acs.connectionString) missing.push("ACS_ENDPOINT");
  if (!cfg.publicBaseUrl) missing.push("PUBLIC_BASE_URL");
  if (!cfg.voiceLive.endpoint) missing.push("VOICE_LIVE_ENDPOINT");
  return missing;
}
export function isSimulated() { return assertCallConfig().length > 0; }
export function readiness({ schedule = null, audit = null, hub = null } = {}) {
  const missing = assertCallConfig();
  const stats = schedule?.stats?.() ?? {};
  return {
    ok: true,
    application: config.appName,
    mode: missing.length ? "simulation" : "live",
    simulation: missing.length > 0,
    missingConfig: missing,
    port: config.port,
    voiceLive: { ready: Boolean(config.voiceLive.endpoint), auth: config.voiceLive.apiKey ? "api-key" : "entra", model: config.voiceLive.model, apiVersion: config.voiceLive.apiVersion },
    acs: { ready: Boolean((config.acs.endpoint || config.acs.connectionString) && config.publicBaseUrl), auth: config.acs.endpoint ? "entra" : config.acs.connectionString ? "connection-string" : "none", teamsResourceAccountId: config.acs.teamsResourceAccountId || null },
    scheduleAdapter: config.schedule.adapter,
    scheduleDbPath: config.schedule.dbPath,
    scheduleDbSharedWithReminder: /appointment-reminder-agent/.test(config.schedule.dbPath),
    sms: { enabled: config.sms.enabled, mode: config.sms.enabled ? "acs" : "console" },
    activeHolds: stats.activeHolds ?? 0,
    demoNow: config.demoNow,
    realtime: hub?.transport ?? "local-ws",
    audit: { store: audit?.name ?? "memory", transcriptsPersisted: config.retention.transcripts },
  };
}
