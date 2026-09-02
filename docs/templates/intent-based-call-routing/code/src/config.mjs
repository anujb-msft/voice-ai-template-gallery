// dotenv is optional so the state machine and its tests run from a bare clone
// with no `npm install`. The server pulls it in for real deployments.
try {
  await import("dotenv/config");
} catch {
  /* running without dependencies installed */
}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  /** 8091 so this runs alongside the password-reset sample on 8090. */
  port: Number(process.env.PORT ?? 8091),

  /**
   * Public HTTPS base URL for this server. ACS must be able to reach it for the
   * Event Grid incoming-call webhook and for call callbacks, and it is also used
   * to derive the media-streaming wss:// URL.
   * With devtunnel: `devtunnel host -p 8091 --allow-anonymous`.
   */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),

  acs: {
    connectionString: process.env.ACS_CONNECTION_STRING ?? "",
    /** "public", "dod" or "gcch" — only change this for a sovereign Teams tenant. */
    teamsCloud: process.env.TEAMS_CLOUD ?? "public",
  },

  voiceLive: {
    /** e.g. https://<resource>.services.ai.azure.com */
    endpoint: (process.env.VOICE_LIVE_ENDPOINT ?? "").replace(/\/$/, ""),
    /**
     * Optional. When empty the server falls back to DefaultAzureCredential,
     * which is what Microsoft recommends. See the README for the two roles and
     * the token scope that keyless auth needs.
     */
    apiKey: process.env.VOICE_LIVE_API_KEY ?? "",
    model: process.env.VOICE_LIVE_MODEL ?? "gpt-realtime",
    /** WebSocket transport api-version. */
    apiVersion: process.env.VOICE_LIVE_API_VERSION ?? "2026-04-10",
    voice: process.env.VOICE_LIVE_VOICE ?? "en-US-Ava:DragonHDLatestNeural",
  },

  /** Locale and voice live together — change both here to move off the English demo. */
  locale: process.env.LOCALE ?? "en-US",

  routing: {
    /**
     * Below this, the agent must ask a clarifying question instead of proposing
     * a destination. Flat across routes on purpose: a per-route threshold is a
     * tuning exercise that hides the mechanism this sample is meant to show.
     */
    confidenceThreshold: Number(process.env.CONFIDENCE_THRESHOLD ?? 0.75),
    /** Answer-to-confirmed-route budget. Expiry routes to reception. */
    timeBudgetMs: Number(process.env.ROUTE_TIME_BUDGET_MS ?? 90_000),
    /** Clarifying questions allowed before falling back to reception. */
    maxClarifications: Number(process.env.MAX_CLARIFICATIONS ?? 2),
    /**
     * Gap between "Connecting you now" and the actual ACS transfer. This is the
     * window in which a caller can still change their mind; once the transfer
     * dispatches, the route is frozen.
     */
    transferDelayMs: Number(process.env.TRANSFER_DELAY_MS ?? 1_200),
    routesPath: process.env.ROUTES_PATH ?? "./config/routes.json",
    callersPath: process.env.CALLERS_PATH ?? "./config/callers.json",
  },

  /**
   * Transcripts stay in memory unless this is explicitly enabled, so utterance
   * text does not reach disk by accident. Summaries and route decisions are
   * always persisted — those are the audit trail.
   */
  persistTranscripts: /^(1|true|yes)$/i.test(process.env.PERSIST_TRANSCRIPTS ?? ""),

  dbPath: process.env.DB_PATH ?? "./data/routing.db",
};

/** Config needed to answer a real inbound call. Empty array means we are live. */
export function assertCallConfig() {
  const missing = [];
  if (!config.acs.connectionString) missing.push("ACS_CONNECTION_STRING");
  if (!config.publicBaseUrl) missing.push("PUBLIC_BASE_URL");
  if (!config.voiceLive.endpoint) missing.push("VOICE_LIVE_ENDPOINT");
  return missing;
}

/**
 * Readiness broken out per subsystem, because "not ready" is rarely uniform.
 * Voice Live can be configured while ACS is not, and both can be configured
 * while the Teams routing targets are still placeholder GUIDs.
 */
export function readiness(routes) {
  const placeholder = /^0{8}-0{4}-0{4}-0{4}-0{11}\d$/;
  const unprovisioned = (routes?.menu?.() ?? [])
    .map((r) => routes.get(r.id))
    .filter((r) => !r?.target?.objectId || placeholder.test(r.target.objectId))
    .map((r) => r.id);

  return {
    voiceLive: {
      ready: Boolean(config.voiceLive.endpoint),
      auth: config.voiceLive.apiKey ? "api-key" : "entra",
      model: config.voiceLive.model,
      apiVersion: config.voiceLive.apiVersion,
    },
    telephony: {
      ready: Boolean(config.acs.connectionString) && Boolean(config.publicBaseUrl),
      missing: assertCallConfig().filter((k) => k !== "VOICE_LIVE_ENDPOINT"),
    },
    teams: {
      // Placeholder object ids answer the question "why did my transfer fail?"
      // before anyone has to read a log.
      ready: unprovisioned.length === 0,
      unprovisionedRoutes: unprovisioned,
      cloud: config.acs.teamsCloud,
    },
  };
}

/** True when the sample is running without any Azure configuration. */
export const isSimulated = () => assertCallConfig().length > 0;
