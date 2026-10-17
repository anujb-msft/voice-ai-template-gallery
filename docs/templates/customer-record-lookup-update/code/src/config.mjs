try {
  await import("dotenv/config");
} catch {
  /* optional in tests */
}

import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";

export const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const resolvePath = (p) => (isAbsolute(p) ? p : join(PKG_ROOT, p));

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8097),
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
  crm: {
    adapter: process.env.CRM_ADAPTER ?? "sqlite",
    dbPath: process.env.CRM_DB_PATH ?? "./data/crm.db",
    seedPath: process.env.CRM_SEED_PATH ?? "./config/crm-seed.json",
    repsPath: process.env.REPS_PATH ?? "./config/reps.json",
    writableFieldsPath: process.env.WRITABLE_FIELDS_PATH ?? "./config/writable-fields.json",
    picklistsPath: process.env.PICKLISTS_PATH ?? "./config/picklists.json",
    briefingPath: process.env.BRIEFING_PATH ?? "./config/briefing.json",
    routingPath: process.env.ROUTING_PATH ?? "./config/routing.json",
  },
  dataverse: {
    url: (process.env.DATAVERSE_URL ?? "").replace(/\/$/, ""),
    tenantId: process.env.ENTRA_TENANT_ID ?? "",
    clientId: process.env.ENTRA_CLIENT_ID ?? "",
  },
  pinRequiredForPstn: !/^(0|false|no)$/i.test(process.env.PIN_REQUIRED_FOR_PSTN ?? "true"),
  persistTranscripts: /^(1|true|yes)$/i.test(process.env.TRANSCRIPT_RETENTION ?? "false"),
  // Simulation only: where the demo clock starts. Empty means the demo-day preset. Real calls run on real time.
  demoNow: process.env.DEMO_NOW ?? "",
  timeZone: process.env.TIME_ZONE ?? "America/Los_Angeles",
  // How long a confirmed write waits, cancellable, before it commits. 0 commits at once.
  commitUndoMs: Math.max(0, Number(process.env.COMMIT_UNDO_MS ?? 6000) || 0),
  callTimeBudgetMs: Number(process.env.CALL_TIME_BUDGET_MS ?? 480_000),
  wrapUpMs: Number(process.env.WRAP_UP_MS ?? 420_000),
};

export function assertCallConfig(cfg = config) {
  const missing = [];
  if (!cfg.acs.endpoint && !cfg.acs.connectionString) missing.push("ACS_ENDPOINT");
  if (!cfg.publicBaseUrl) missing.push("PUBLIC_BASE_URL");
  if (!cfg.voiceLive.endpoint) missing.push("VOICE_LIVE_ENDPOINT");
  return missing;
}

export const isSimulated = (cfg = config) => assertCallConfig(cfg).length > 0;

export function readiness({ crmCounts = {}, repCount = 0, routing = null } = {}, cfg = config) {
  const placeholder = /^0{8}-0{4}-0{4}-0{4}-(?:0{12}|0{10}\d{2})$/;
  const target = routing?.salesOperations;
  const unprovisioned = target?.objectId && placeholder.test(target.objectId) ? ["salesOperations"] : [];
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
      teamsPhoneExtensibility: "primary",
      acsNumberFallback: true,
    },
    teams: { ready: unprovisioned.length === 0, unprovisionedTargets: unprovisioned, cloud: cfg.acs.teamsCloud },
    crm: { adapter: cfg.crm.adapter, ready: ["sqlite", "memory"].includes(cfg.crm.adapter), seedCounts: crmCounts },
    reps: { ready: repCount > 0, count: repCount, pinRequiredForPstn: cfg.pinRequiredForPstn },
  };
}
