try { await import("dotenv/config"); } catch {}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8093),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
  acs: {
    endpoint: (process.env.ACS_ENDPOINT ?? "").replace(/\/$/, ""),
    connectionString: process.env.ACS_CONNECTION_STRING ?? "",
    teamsCloud: process.env.TEAMS_CLOUD ?? "public",
  },
  voiceLive: {
    endpoint: (process.env.VOICE_LIVE_ENDPOINT ?? "").replace(/\/$/, ""),
    apiKey: process.env.VOICE_LIVE_API_KEY ?? "",
    model: process.env.VOICE_LIVE_MODEL ?? "gpt-realtime",
    apiVersion: process.env.VOICE_LIVE_API_VERSION ?? "2026-04-10",
    voice: process.env.VOICE_LIVE_VOICE ?? "en-US-Ava:DragonHDLatestNeural",
  },
  locale: process.env.LOCALE ?? "en-US",
  paths: {
    hours: process.env.HOURS_PATH ?? "./config/hours.json",
    reps: process.env.REPS_PATH ?? "./config/reps.json",
    qualification: process.env.QUALIFICATION_PATH ?? "./config/qualification.json",
    catalog: process.env.CATALOG_PATH ?? "./config/catalog.json",
  },
  dedupeWindowDays: Number(process.env.DEDUPE_WINDOW_DAYS ?? 30),
  callTimeBudgetMs: Number(process.env.CALL_TIME_BUDGET_MS ?? 360_000),
  demoNow: process.env.DEMO_NOW ?? "",
  persistTranscripts: /^(1|true|yes)$/i.test(process.env.PERSIST_TRANSCRIPTS ?? ""),
  dbPath: process.env.DB_PATH ?? "./data/after-hours-sales.db",
  notifications: {
    teamsWorkflowUrl: process.env.TEAMS_WORKFLOW_URL ?? "",
    acsEmailSender: process.env.ACS_EMAIL_SENDER ?? "",
  },
};

export function nowFromConfig(cfg = config) {
  return cfg.demoNow ? new Date(cfg.demoNow) : new Date();
}

export function assertCallConfig(cfg = config) {
  const missing = [];
  if (!cfg.acs.endpoint && !cfg.acs.connectionString) missing.push("ACS_ENDPOINT");
  if (!cfg.publicBaseUrl) missing.push("PUBLIC_BASE_URL");
  if (!cfg.voiceLive.endpoint) missing.push("VOICE_LIVE_ENDPOINT");
  return missing;
}

export const isSimulated = () => assertCallConfig().length > 0;

export function readiness({ hours, reps, store } = {}, cfg = config) {
  const placeholder = /^0{8}-0{4}-0{4}-0{4}-0{11}\d$/;
  return {
    voiceLive: { ready: Boolean(cfg.voiceLive.endpoint), auth: cfg.voiceLive.apiKey ? "api-key" : "entra", model: cfg.voiceLive.model, apiVersion: cfg.voiceLive.apiVersion },
    telephony: { ready: Boolean(cfg.acs.endpoint || cfg.acs.connectionString) && Boolean(cfg.publicBaseUrl), auth: cfg.acs.endpoint ? "entra" : cfg.acs.connectionString ? "connection-string" : "none", missing: assertCallConfig(cfg).filter((k) => k !== "VOICE_LIVE_ENDPOINT") },
    teamsPhone: { ready: Boolean(hours?.salesQueue?.objectId) && !placeholder.test(hours?.salesQueue?.objectId ?? ""), salesQueue: hours?.salesQueue?.displayName ?? null, cloud: cfg.acs.teamsCloud },
    hours: hours ? { open: hours.isSalesOpen(nowFromConfig(cfg)), timeZone: hours.timeZone, holiday: hours.isHoliday(nowFromConfig(cfg)) } : null,
    activeReps: reps?.activeReps?.().length ?? 0,
    outboxBacklog: store?.outboxBacklog?.() ?? 0,
  };
}
