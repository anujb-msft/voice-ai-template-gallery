try {
  await import("dotenv/config");
} catch {}

const bool = (value, fallback = false) => {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
};
const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const list = (value, fallback) => String(value ?? fallback).split(",").map((v) => v.trim()).filter(Boolean);

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: num(process.env.PORT, 8096),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
  acs: {
    endpoint: (process.env.ACS_ENDPOINT ?? "").replace(/\/$/, ""),
    connectionString: process.env.ACS_CONNECTION_STRING ?? "",
    smsFrom: process.env.ACS_SMS_FROM ?? "",
    teamsCloud: process.env.TEAMS_CLOUD ?? "public",
  },
  voiceLive: {
    endpoint: (process.env.VOICE_LIVE_ENDPOINT ?? "").replace(/\/$/, ""),
    apiKey: process.env.VOICE_LIVE_API_KEY ?? "",
    model: process.env.VOICE_LIVE_MODEL ?? "gpt-realtime",
    apiVersion: process.env.VOICE_LIVE_API_VERSION ?? "2026-04-10",
    voices: list(process.env.VOICE_LIVE_VOICES, "en-US-Ava:DragonHDLatestNeural,es-US-ElviraNeural"),
    voice: list(process.env.VOICE_LIVE_VOICES, "en-US-Ava:DragonHDLatestNeural,es-US-ElviraNeural")[0],
  },
  locales: list(process.env.LOCALES, "en-US,es-US"),
  locale: list(process.env.LOCALES, "en-US,es-US")[0],
  paths: {
    requestTypes: process.env.REQUEST_TYPES_PATH ?? "./config/request-types.json",
    departments: process.env.DEPARTMENTS_PATH ?? "./config/departments.json",
    addresses: process.env.ADDRESSES_PATH ?? "./config/addresses.json",
    streets: process.env.STREETS_PATH ?? "./config/streets.json",
    bulkPickup: process.env.BULK_PICKUP_PATH ?? "./config/bulk-pickup.json",
    emergency: process.env.EMERGENCY_PATH ?? "./config/emergency.json",
    holidays: process.env.HOLIDAYS_PATH ?? "./config/holidays.json",
    articles: process.env.ARTICLES_PATH ?? "./content/articles",
  },
  caseStore: process.env.CASE_STORE ?? "sqlite",
  geocoder: process.env.GEOCODER ?? "fixture",
  duplicate: {
    radiusM: num(process.env.DUPLICATE_RADIUS_M, 50),
    windowDays: num(process.env.DUPLICATE_WINDOW_DAYS, 7),
  },
  maxRequestsPerCall: num(process.env.MAX_REQUESTS_PER_CALL, 3),
  caseRetentionDays: num(process.env.CASE_RETENTION_DAYS, 365),
  contentExpiryGraceDays: num(process.env.CONTENT_EXPIRY_GRACE_DAYS, 90),
  callTimeBudgetMs: num(process.env.CALL_TIME_BUDGET_MS, 300000),
  demoNow: process.env.DEMO_NOW ?? "",
  persistTranscripts: bool(process.env.PERSIST_TRANSCRIPTS, false),
  dbPath: process.env.DB_PATH ?? "./data/311-service.db",
};

export function clockNow(cfg = config) {
  const fixed = cfg.demoNow ? Date.parse(cfg.demoNow) : NaN;
  return Number.isFinite(fixed) ? fixed : Date.now();
}

export function assertCallConfig(cfg = config) {
  const missing = [];
  if (!cfg.acs.endpoint && !cfg.acs.connectionString) missing.push("ACS_ENDPOINT");
  if (!cfg.publicBaseUrl) missing.push("PUBLIC_BASE_URL");
  if (!cfg.voiceLive.endpoint) missing.push("VOICE_LIVE_ENDPOINT");
  return missing;
}

export const isSimulated = (cfg = config) => assertCallConfig(cfg).length > 0;

export function readiness({ content = null, departments = null, caseStore = null, geocoder = null } = {}, cfg = config) {
  return {
    voiceLive: {
      ready: Boolean(cfg.voiceLive.endpoint),
      auth: cfg.voiceLive.apiKey ? "api-key" : "entra",
      model: cfg.voiceLive.model,
      apiVersion: cfg.voiceLive.apiVersion,
      mode: "direct",
    },
    telephony: {
      ready: Boolean(cfg.acs.endpoint || cfg.acs.connectionString) && Boolean(cfg.publicBaseUrl),
      auth: cfg.acs.endpoint ? "entra" : cfg.acs.connectionString ? "connection-string" : "none",
      missing: assertCallConfig(cfg).filter((k) => k !== "VOICE_LIVE_ENDPOINT"),
    },
    teamsPhone: {
      ready: Boolean(cfg.acs.endpoint || cfg.acs.connectionString),
      entryPoint: "teams-phone-extensibility",
      fallback: "acs-direct",
      cloud: cfg.acs.teamsCloud,
    },
    sms: { ready: Boolean(cfg.acs.smsFrom), from: cfg.acs.smsFrom ? "configured" : "missing" },
    corpus: content?.summary?.() ?? null,
    caseStore: { type: caseStore?.name ?? cfg.caseStore },
    geocoder: { type: geocoder?.name ?? cfg.geocoder },
    departments: departments?.openSummary?.(new Date(clockNow(cfg))) ?? null,
  };
}
