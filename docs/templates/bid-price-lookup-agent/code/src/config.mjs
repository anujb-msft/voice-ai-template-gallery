try {
  await import("dotenv/config");
} catch {
  /* optional in tests */
}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8094),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
  acs: {
    connectionString: process.env.ACS_CONNECTION_STRING ?? "",
    endpoint: (process.env.ACS_ENDPOINT ?? "").replace(/\/$/, ""),
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
  pricing: {
    feed: process.env.PRICE_FEED ?? "fixture",
    locationsPath: process.env.LOCATIONS_PATH ?? "./config/locations.json",
    bidsPath: process.env.BIDS_PATH ?? "./config/bids.json",
    futuresPath: process.env.FUTURES_PATH ?? "./config/futures.json",
    marketPath: process.env.MARKET_PATH ?? "./config/market.json",
    futuresStaleMinutes: Number(process.env.FUTURES_STALE_MINUTES ?? 20),
    futuresHardLimitMinutes: Number(process.env.FUTURES_HARD_LIMIT_MINUTES ?? 240),
    callTimeBudgetMs: Number(process.env.CALL_TIME_BUDGET_MS ?? 180_000),
    demoNow: process.env.DEMO_NOW ?? "2026-09-08T15:42:00Z",
    minutesPerAutomatedCall: Number(process.env.MINUTES_PER_AUTOMATED_CALL ?? 3),
  },
  persistTranscripts: /^(1|true|yes)$/i.test(process.env.PERSIST_TRANSCRIPTS ?? ""),
  dbPath: process.env.DB_PATH ?? "./data/bid-price-lookup.db",
};

export function assertCallConfig(cfg = config) {
  const missing = [];
  if (!cfg.acs.endpoint && !cfg.acs.connectionString) missing.push("ACS_ENDPOINT");
  if (!cfg.publicBaseUrl) missing.push("PUBLIC_BASE_URL");
  if (!cfg.voiceLive.endpoint) missing.push("VOICE_LIVE_ENDPOINT");
  return missing;
}

export function readiness(priceBook, cfg = config) {
  const placeholder = /^0{8}-0{4}-0{4}-0{4}-0{10}/;
  const unprovisioned = (priceBook?.locations?.all() ?? [])
    .filter((l) => !l?.merchandiser?.objectId || placeholder.test(l.merchandiser.objectId))
    .map((l) => l.id);
  const feed = priceBook?.health?.() ?? { ok: false };

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
    teams: { ready: unprovisioned.length === 0, unprovisionedLocations: unprovisioned, cloud: cfg.acs.teamsCloud },
    feed,
  };
}

export const isSimulated = () => assertCallConfig().length > 0;
