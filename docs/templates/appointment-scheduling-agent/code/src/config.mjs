// dotenv is optional so the flow, the store and their tests run from a bare
// clone with no `npm install`. The server pulls it in for real deployments.
try { await import("dotenv/config"); } catch {}

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const codeRoot = resolve(__dirname, "..");
const bool = (value, fallback = false) => value == null || value === "" ? fallback : /^(1|true|yes|on)$/i.test(String(value));
const num = (value, fallback) => value != null && value !== "" && Number.isFinite(Number(value)) ? Number(value) : fallback;
const rel = (p) => resolve(codeRoot, p);

/**
 * The demo's starting clock: Tuesday, May 19, 2026, 9:50 AM at the Northgate
 * clinic. Openings, lead times and "today" all depend on the time, so the
 * seeded schedule is written around this moment.
 */
export const DEFAULT_DEMO_NOW = "2026-05-19T09:50:00-07:00";

/**
 * Named demo clocks for the console and the offline driver. Simulation only:
 * a server answering real calls always schedules on the real time.
 */
export const CLOCK_PRESETS = Object.freeze([
  // Tuesday morning: the clinic and every Teams queue are open, with same-day openings left.
  { id: "tue-morning", label: "Tue 9:50 AM", at: DEFAULT_DEMO_NOW },
  // Friday evening: every queue is closed, so people become callbacks and the nurse line gives advice.
  { id: "fri-evening", label: "Fri 6:30 PM", at: "2026-05-22T18:30:00-07:00" },
  { id: "real", label: "Real time", at: null },
]);

export const config = {
  appName: "appointment-scheduling-agent",
  host: process.env.HOST ?? "127.0.0.1",
  port: num(process.env.PORT, 8100),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
  /**
   * Pins the clock the schedule sees, as an ISO 8601 timestamp, so every demo
   * run offers the same openings. Honored only in simulation mode: a server
   * answering real calls always schedules on the real time. Set it to an empty
   * value to run the simulation on the real time.
   */
  demoNow: process.env.DEMO_NOW ?? DEFAULT_DEMO_NOW,
  demoNowSet: process.env.DEMO_NOW != null,
  callTimeBudgetMs: num(process.env.CALL_TIME_BUDGET_MS, 420_000),
  /** Locale and voice live together — change both to move off the English demo. */
  locale: process.env.LOCALE ?? "en-US",
  acs: {
    endpoint: (process.env.ACS_ENDPOINT ?? "").replace(/\/$/, ""),
    connectionString: process.env.ACS_CONNECTION_STRING ?? "",
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
    /** How long an offered time is reserved for the caller while they decide. */
    holdTtlMs: num(process.env.HOLD_TTL_MS, 300_000),
    searchHorizonDays: num(process.env.SEARCH_HORIZON_DAYS, 90),
    /** Options read out per turn. Two is what a caller can hold in their head. */
    optionsPerTurn: num(process.env.OPTIONS_PER_TURN, 2),
    /** Nothing sooner than this is offered, so a caller can still get there. */
    minLeadMinutes: num(process.env.MIN_LEAD_MINUTES, 60),
  },
  /**
   * Gap between the agent's "I'm connecting you" and the ACS transfer on a real
   * call, so the caller hears the whole line before the transfer starts.
   */
  transferDelayMs: num(process.env.TRANSFER_DELAY_MS, 2_500),
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

/** The configured demo time, or the real time when DEMO_NOW is empty or not a timestamp. */
export function nowDate(now = config.demoNow) {
  const at = now ? Date.parse(now) : NaN;
  return Number.isFinite(at) ? new Date(at) : new Date();
}

/** Config needed to answer a real inbound call. An empty array means live. */
export function assertCallConfig(cfg = config) {
  const missing = [];
  if (!cfg.acs.endpoint && !cfg.acs.connectionString) missing.push("ACS_ENDPOINT");
  if (!cfg.publicBaseUrl) missing.push("PUBLIC_BASE_URL");
  if (!cfg.voiceLive.endpoint) missing.push("VOICE_LIVE_ENDPOINT");
  return missing;
}

/** True when the sample is running without the Azure configuration for real calls. */
export const isSimulated = () => assertCallConfig().length > 0;

/**
 * Readiness broken out per subsystem, because "not ready" is rarely uniform:
 * Voice Live can be configured while ACS is not, and both can be configured
 * while the Teams targets in routing.json are still placeholder ids.
 */
export function readiness(cfg = config) {
  const placeholder = /^0{8}-0{4}-0{4}-0{4}-0{11}\d$/;
  // Every destination is a Teams target except a callback ticket or a phone number.
  const unprovisioned = Object.entries(fixtures.routing.destinations ?? {})
    .filter(([, d]) => d.target !== "callback" && !String(d.target ?? "").startsWith("+"))
    .filter(([, d]) => !d.target || placeholder.test(d.target))
    .map(([id]) => id);
  return {
    voiceLive: { ready: Boolean(cfg.voiceLive.endpoint), auth: cfg.voiceLive.apiKey ? "api-key" : "entra", model: cfg.voiceLive.model, apiVersion: cfg.voiceLive.apiVersion },
    telephony: {
      ready: Boolean(cfg.acs.endpoint || cfg.acs.connectionString) && Boolean(cfg.publicBaseUrl),
      auth: cfg.acs.endpoint ? "entra" : cfg.acs.connectionString ? "connection-string" : "none",
      missing: assertCallConfig(cfg).filter((k) => k !== "VOICE_LIVE_ENDPOINT"),
      teamsResourceAccountId: cfg.acs.teamsResourceAccountId || null,
    },
    teams: { ready: unprovisioned.length === 0, unprovisionedDestinations: unprovisioned, cloud: cfg.acs.teamsCloud },
    schedule: { adapter: cfg.schedule.adapter, dbPath: cfg.schedule.dbPath, sharedWithReminder: /appointment-reminder-agent/.test(cfg.schedule.dbPath) },
  };
}
