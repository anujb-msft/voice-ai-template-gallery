// Settings come from the environment (and from .env when dotenv is installed).
// None are needed for the demo: with no Azure settings the server runs in
// simulation mode, and every call is typed in the console.
try {
  await import("dotenv/config");
} catch {
  // dotenv is optional; plain environment variables work too.
}

const env = process.env;
const withoutTrailingSlash = (value) => String(value ?? "").replace(/\/$/, "");

export const config = {
  host: env.HOST ?? "127.0.0.1",
  port: Number(env.PORT ?? 8093),
  publicBaseUrl: withoutTrailingSlash(env.PUBLIC_BASE_URL),
  acs: {
    endpoint: withoutTrailingSlash(env.ACS_ENDPOINT),
    connectionString: env.ACS_CONNECTION_STRING ?? "",
    teamsCloud: env.TEAMS_CLOUD ?? "public",
  },
  voiceLive: {
    endpoint: withoutTrailingSlash(env.VOICE_LIVE_ENDPOINT),
    apiKey: env.VOICE_LIVE_API_KEY ?? "",
    model: env.VOICE_LIVE_MODEL ?? "gpt-realtime",
    apiVersion: env.VOICE_LIVE_API_VERSION ?? "2026-04-10",
    voice: env.VOICE_LIVE_VOICE ?? "en-US-Ava:DragonHDLatestNeural",
  },
  locale: env.LOCALE ?? "en-US",
  paths: {
    hours: env.HOURS_PATH ?? "./config/hours.json",
    reps: env.REPS_PATH ?? "./config/reps.json",
    qualification: env.QUALIFICATION_PATH ?? "./config/qualification.json",
    catalog: env.CATALOG_PATH ?? "./config/catalog.json",
  },
  dedupeWindowDays: Number(env.DEDUPE_WINDOW_DAYS ?? 30),
  callTimeBudgetMs: Number(env.CALL_TIME_BUDGET_MS ?? 360_000),
  // How long a paged caller hears "please stay on the line" before the call is
  // transferred to the on-call rep. In simulation, the console counts it down.
  pageWindowMs: Number(env.PAGE_WINDOW_MS ?? 6000),
  // Simulation only: the time the demo clock starts at, such as 2026-09-02T19:30:00-07:00.
  demoNow: env.DEMO_NOW ?? "",
  persistTranscripts: /^(1|true|yes)$/i.test(env.PERSIST_TRANSCRIPTS ?? ""),
  dbPath: env.DB_PATH ?? "./data/after-hours-sales.db",
  notifications: {
    teamsWorkflowUrl: env.TEAMS_WORKFLOW_URL ?? "",
    acsEmailSender: env.ACS_EMAIL_SENDER ?? "",
  },
};

export function nowFromConfig(cfg = config) {
  return cfg.demoNow ? new Date(cfg.demoNow) : new Date();
}

/** The settings a real call needs. An empty list means live calls can be answered. */
export function assertCallConfig(cfg = config) {
  const missing = [];
  if (!cfg.acs.endpoint && !cfg.acs.connectionString) missing.push("ACS_ENDPOINT");
  if (!cfg.publicBaseUrl) missing.push("PUBLIC_BASE_URL");
  if (!cfg.voiceLive.endpoint) missing.push("VOICE_LIVE_ENDPOINT");
  return missing;
}

export const isSimulated = () => assertCallConfig().length > 0;

// An unprovisioned object id: all zeros except the last digit.
const PLACEHOLDER_ID = /^0{8}-0{4}-0{4}-0{4}-0{11}\d$/;

/**
 * What is configured, for /health. `now` is the server's clock (the demo clock
 * in simulation); without it, DEMO_NOW or the real time is used.
 */
export function readiness({ hours, reps, store } = {}, cfg = config, now = null) {
  const at = now ? new Date(now) : nowFromConfig(cfg);
  const queueId = hours?.salesQueue?.objectId ?? "";
  const coverage = hours?.onCallCoverage?.(at) ?? null;
  const onCallRep = coverage?.repId ? reps?.find?.(coverage.repId) : null;
  return {
    voiceLive: {
      ready: Boolean(cfg.voiceLive.endpoint),
      auth: cfg.voiceLive.apiKey ? "api-key" : "entra",
      model: cfg.voiceLive.model,
      apiVersion: cfg.voiceLive.apiVersion,
    },
    telephony: {
      ready: Boolean(cfg.acs.endpoint || cfg.acs.connectionString) && Boolean(cfg.publicBaseUrl),
      auth: cfg.acs.endpoint ? "entra" : cfg.acs.connectionString ? "connection-string" : "none",
      missing: assertCallConfig(cfg).filter((key) => key !== "VOICE_LIVE_ENDPOINT"),
    },
    teamsPhone: {
      ready: Boolean(queueId) && !PLACEHOLDER_ID.test(queueId),
      salesQueue: hours?.salesQueue?.displayName ?? null,
      cloud: cfg.acs.teamsCloud,
    },
    hours: hours ? { open: hours.isSalesOpen(at), timeZone: hours.timeZone, holiday: hours.isHoliday(at) } : null,
    onCall: coverage
      ? {
          configured: Boolean(coverage.repId),
          covered: coverage.covered,
          reason: coverage.reason,
          repName: onCallRep?.displayName ?? null,
          until: coverage.untilLabel,
        }
      : null,
    activeReps: reps?.activeReps?.().length ?? 0,
    outboxBacklog: store?.outboxBacklog?.() ?? 0,
  };
}
