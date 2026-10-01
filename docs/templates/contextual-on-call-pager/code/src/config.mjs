try {
  await import("dotenv/config");
} catch {
  /* optional in tests */
}

const bool = (value) => /^(1|true|yes)$/i.test(String(value ?? ""));
const stripSlash = (value) => String(value ?? "").replace(/\/$/, "");

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8095),
  publicBaseUrl: stripSlash(process.env.PUBLIC_BASE_URL),
  acs: {
    endpoint: stripSlash(process.env.ACS_ENDPOINT),
    connectionString: process.env.ACS_CONNECTION_STRING ?? "",
    outboundCallerId: process.env.ACS_OUTBOUND_CALLER_ID ?? "+15551239999",
    teamsCloud: process.env.TEAMS_CLOUD ?? "public",
  },
  voiceLive: {
    endpoint: stripSlash(process.env.VOICE_LIVE_ENDPOINT),
    apiKey: process.env.VOICE_LIVE_API_KEY ?? "",
    model: process.env.VOICE_LIVE_MODEL ?? "gpt-realtime",
    apiVersion: process.env.VOICE_LIVE_API_VERSION ?? "2026-04-10",
    voice: process.env.VOICE_LIVE_VOICE ?? "en-US-Ava:DragonHDLatestNeural",
  },
  locale: process.env.LOCALE ?? "en-US",
  teams: {
    workflowUrl: process.env.TEAMS_WORKFLOW_URL ?? "",
    opsWorkflowUrl: process.env.TEAMS_OPS_WORKFLOW_URL ?? "",
  },
  demoNow: process.env.DEMO_NOW ?? "",
  budgets: {
    intakeMs: Number(process.env.INTAKE_TIME_BUDGET_MS ?? process.env.CALL_TIME_BUDGET_MS ?? 300_000),
    pageMs: Number(process.env.PAGE_TIME_BUDGET_MS ?? 180_000),
  },
  paths: {
    properties: process.env.PROPERTIES_PATH ?? "./config/properties.json",
    tenants: process.env.TENANTS_PATH ?? "./config/tenants.json",
    oncall: process.env.ONCALL_PATH ?? "./config/oncall.json",
    triage: process.env.TRIAGE_PATH ?? "./config/triage.json",
    escalation: process.env.ESCALATION_PATH ?? "./config/escalation.json",
  },
  persistTranscripts: bool(process.env.PERSIST_TRANSCRIPTS),
  dbPath: process.env.DB_PATH ?? "./data/pager.db",
};

export function nowFromConfig(cfg = config) {
  if (cfg.demoNow) return new Date(cfg.demoNow).getTime();
  return Date.now();
}

export function assertCallConfig(cfg = config) {
  const missing = [];
  if (!cfg.acs.endpoint && !cfg.acs.connectionString) missing.push("ACS_ENDPOINT");
  if (!cfg.acs.outboundCallerId) missing.push("ACS_OUTBOUND_CALLER_ID");
  if (!cfg.publicBaseUrl) missing.push("PUBLIC_BASE_URL");
  if (!cfg.voiceLive.endpoint) missing.push("VOICE_LIVE_ENDPOINT");
  return missing;
}

export const isSimulated = (cfg = config) => assertCallConfig(cfg).length > 0;

export function readiness(policy, scheduler = null, cfg = config) {
  const missing = assertCallConfig(cfg);
  const now = cfg.demoNow ? new Date(cfg.demoNow) : new Date();
  const groups = policy?.groups?.() ?? [];
  return {
    application: { ready: true, port: cfg.port, locale: cfg.locale },
    voiceLive: {
      ready: Boolean(cfg.voiceLive.endpoint),
      auth: cfg.voiceLive.apiKey ? "api-key" : "entra",
      model: cfg.voiceLive.model,
      apiVersion: cfg.voiceLive.apiVersion,
      directMode: true,
    },
    teamsPhone: {
      ready: Boolean(cfg.acs.endpoint || cfg.acs.connectionString) && Boolean(cfg.publicBaseUrl),
      auth: cfg.acs.endpoint ? "entra" : cfg.acs.connectionString ? "connection-string" : "none",
      cloud: cfg.acs.teamsCloud,
      missing: missing.filter((k) => k !== "VOICE_LIVE_ENDPOINT"),
    },
    outboundCalling: {
      ready: Boolean(cfg.acs.outboundCallerId) && Boolean(cfg.acs.endpoint || cfg.acs.connectionString),
      callerId: cfg.acs.outboundCallerId ? "configured" : "missing",
    },
    scheduler: {
      lagMs: scheduler?.lagMs?.() ?? 0,
      pendingJobs: scheduler?.pendingCount?.() ?? 0,
    },
    currentOnCall: Object.fromEntries(groups.map((group) => [group, policy.onCallChain(group, now)])),
    simulationMode: missing.length > 0,
    missingConfig: missing,
  };
}
