try { await import("dotenv/config"); } catch {}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8098),
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
  classifierConfidenceMin: Number(process.env.CLASSIFIER_CONFIDENCE_MIN ?? 0.7),
  callTimeBudgetMs: Number(process.env.CALL_TIME_BUDGET_MS ?? 360_000),
  wrapUpMs: Number(process.env.WRAP_UP_MS ?? 300_000),
  ticketAdapter: process.env.TICKET_ADAPTER ?? "sqlite",
  hrisAdapter: process.env.HRIS_ADAPTER ?? "fixture",
  otpChannel: process.env.OTP_CHANNEL ?? "teams",
  passwordResetTarget: process.env.PASSWORD_RESET_TARGET ?? "",
  transcriptRetention: /^(1|true|yes)$/i.test(process.env.TRANSCRIPT_RETENTION ?? ""),
  transcriptRetentionDays: Number(process.env.TRANSCRIPT_RETENTION_DAYS ?? 30),
  statsMinCount: Number(process.env.STATS_MIN_COUNT ?? 5),
  demoNow: process.env.DEMO_NOW ?? "",
  dbPath: process.env.DB_PATH ?? "./data/triage.db",
  paths: {
    taxonomy: process.env.TAXONOMY_PATH ?? "./config/taxonomy.json",
    sensitive: process.env.SENSITIVE_PATH ?? "./config/sensitive.json",
    priority: process.env.PRIORITY_PATH ?? "./config/priority-matrix.json",
    outages: process.env.OUTAGES_PATH ?? "./config/outages.json",
    routing: process.env.ROUTING_PATH ?? "./config/routing.json",
    directory: process.env.DIRECTORY_PATH ?? "./config/directory.json",
    hris: process.env.HRIS_PATH ?? "./config/hris.json",
    itsmSeed: process.env.ITSM_SEED_PATH ?? "./config/itsm-seed.json",
    kbRoot: process.env.KB_ROOT ?? "./kb",
    routingFixtures: process.env.ROUTING_FIXTURES_PATH ?? "./config/routing-fixtures.json",
  },
};

export function nowDate(cfg = config) { return cfg.demoNow ? new Date(cfg.demoNow) : new Date(); }

export function assertCallConfig(cfg = config) {
  const missing = [];
  if (!cfg.acs.endpoint && !cfg.acs.connectionString) missing.push("ACS_ENDPOINT");
  if (!cfg.publicBaseUrl) missing.push("PUBLIC_BASE_URL");
  if (!cfg.voiceLive.endpoint) missing.push("VOICE_LIVE_ENDPOINT");
  return missing;
}

export const isSimulated = () => assertCallConfig().length > 0;

export function readiness({ routing = null, knowledge = null, outages = null } = {}, cfg = config) {
  const missing = assertCallConfig(cfg);
  const placeholder = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;
  const destinations = routing?.destinations ?? [];
  const unprovisionedRoutes = destinations.filter((d) => placeholder.test(d.target?.objectId ?? "")).map((d) => d.id);
  const at = nowDate(cfg);
  return {
    voiceLive: { ready: Boolean(cfg.voiceLive.endpoint), auth: cfg.voiceLive.apiKey ? "api-key" : "entra", model: cfg.voiceLive.model, apiVersion: cfg.voiceLive.apiVersion },
    telephony: { ready: Boolean(cfg.acs.endpoint || cfg.acs.connectionString) && Boolean(cfg.publicBaseUrl), auth: cfg.acs.endpoint ? "entra" : cfg.acs.connectionString ? "connection-string" : "none", missing: missing.filter((k) => k !== "VOICE_LIVE_ENDPOINT") },
    teamsPhone: { ready: unprovisionedRoutes.length === 0, cloud: cfg.acs.teamsCloud, unprovisionedRoutes },
    adapters: { ticket: cfg.ticketAdapter, hris: cfg.hrisAdapter, otp: cfg.otpChannel },
    knowledge: knowledge?.health?.(at) ?? null,
    activeOutages: outages?.active?.(at).map((o) => ({ service: o.service, parentIncident: o.parentIncident })) ?? [],
    routing: destinations.map((d) => ({ id: d.id, label: d.label, open: routing?.isOpen?.(d.id, at) ?? false })),
    passwordResetTarget: cfg.passwordResetTarget || null,
    simulation: missing.length > 0,
  };
}
