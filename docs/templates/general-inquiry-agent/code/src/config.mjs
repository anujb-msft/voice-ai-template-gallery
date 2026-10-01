try {
  await import("dotenv/config");
} catch {
  /* optional in tests */
}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8092),
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
  content: {
    articlesPath: process.env.CONTENT_ARTICLES_PATH ?? "./content/articles",
    minScore: Number(process.env.RETRIEVAL_MIN_SCORE ?? 2.5),
    expiryGraceDays: Number(process.env.CONTENT_EXPIRY_GRACE_DAYS ?? 90),
  },
  hoursPath: process.env.HOURS_PATH ?? "./config/hours.json",
  demoToday: process.env.DEMO_TODAY ?? null,
  demoNow: process.env.DEMO_NOW ?? null,
  callTimeBudgetMs: Number(process.env.CALL_TIME_BUDGET_MS ?? 300_000),
  persistTranscripts: /^(1|true|yes)$/i.test(process.env.PERSIST_TRANSCRIPTS ?? ""),
  dbPath: process.env.DB_PATH ?? "./data/general-inquiry.db",
};

export function referenceNow(cfg = config) {
  const raw = cfg.demoNow ?? (cfg.demoToday ? `${cfg.demoToday}T12:00:00-07:00` : null);
  const date = raw ? new Date(raw) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid DEMO_NOW/DEMO_TODAY: ${raw}`);
  return date;
}

export function assertCallConfig(cfg = config) {
  const missing = [];
  if (!cfg.acs.endpoint && !cfg.acs.connectionString) missing.push("ACS_ENDPOINT");
  if (!cfg.publicBaseUrl) missing.push("PUBLIC_BASE_URL");
  if (!cfg.voiceLive.endpoint) missing.push("VOICE_LIVE_ENDPOINT");
  return missing;
}

export function readiness(contentIndex, hours, cfg = config) {
  const placeholder = /^0{8}-0{4}-0{4}-0{4}-0{11}\d$/;
  const queueId = hours?.queue?.objectId ?? "";
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
      missing: assertCallConfig(cfg).filter((k) => k !== "VOICE_LIVE_ENDPOINT"),
    },
    teamsPhone: {
      ready: Boolean(queueId) && !placeholder.test(queueId),
      queue: hours?.queue?.displayName ?? "not configured",
      cloud: cfg.acs.teamsCloud,
    },
    contentIndex: contentIndex?.summary?.() ?? null,
  };
}

export const isSimulated = () => assertCallConfig().length > 0;
