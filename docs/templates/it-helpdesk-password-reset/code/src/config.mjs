// dotenv is optional so the state machine and its tests run from a bare clone
// with no `npm install`. The server pulls it in for real deployments.
try {
  await import("dotenv/config");
} catch {
  /* running without dependencies installed */
}

import { normalizeTelephonyMode, telephonyMissing } from "./telephony.mjs";

/** An unset TELEPHONY_MODE means the default; a wrong one is reported as missing config, not a crash. */
function telephonyMode(value) {
  try {
    return normalizeTelephonyMode(value || undefined);
  } catch {
    return null;
  }
}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8090),

  /**
   * Public HTTPS base URL for this server. ACS must be able to reach it for
   * call callbacks, and it is also used to derive the media-streaming wss:// URL.
   * With devtunnel: `devtunnel host -p 8090 --allow-anonymous`.
   */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),

  acs: {
    connectionString: process.env.ACS_CONNECTION_STRING ?? "",
    telephonyMode: telephonyMode(process.env.TELEPHONY_MODE),
    /** Used only in acs-direct mode. Must be a geographic ACS number. */
    callerId: process.env.ACS_CALLER_ID ?? "",
    /** Used only in teams-phone mode. This is the Teams resource account object ID. */
    teamsResourceAccountId: process.env.TPE_RESOURCE_ACCOUNT_ID ?? "",
  },

  voiceLive: {
    /** e.g. https://<resource>.services.ai.azure.com */
    endpoint: (process.env.VOICE_LIVE_ENDPOINT ?? "").replace(/\/$/, ""),
    apiKey: process.env.VOICE_LIVE_API_KEY ?? "",
    model: process.env.VOICE_LIVE_MODEL ?? "gpt-realtime",
    /** WebSocket transport api-version. */
    apiVersion: process.env.VOICE_LIVE_API_VERSION ?? "2026-04-10",
    voice: process.env.VOICE_LIVE_VOICE ?? "en-US-Ava:DragonHDLatestNeural",
  },

  /** Locale and voice live together: change both to move off the English demo. */
  locale: process.env.LOCALE ?? "en-US",

  /**
   * Where a handoff goes: the IT service desk call queue (a Teams resource
   * account, `app`) or a named specialist (`user`), by Microsoft Entra object
   * ID. Optional; without it the agent ends the call after the handoff message.
   */
  serviceDesk: {
    id: process.env.SERVICE_DESK_TEAMS_ID ?? "",
    kind: process.env.SERVICE_DESK_TEAMS_KIND === "user" ? "user" : "app",
    /** "public", "dod" or "gcch": only change this for a sovereign Teams tenant. */
    cloud: process.env.TEAMS_CLOUD ?? "public",
    /** Gap between the agent's handoff line and the transfer, so the line is heard. */
    transferDelayMs: Number(process.env.TRANSFER_DELAY_MS ?? 4_000),
  },

  signalr: {
    /** Optional. When empty the server falls back to a built-in WebSocket hub. */
    connectionString: process.env.AZURE_SIGNALR_CONNECTION_STRING ?? "",
    hub: process.env.AZURE_SIGNALR_HUB ?? "helpdesk",
  },

  demo: {
    /**
     * Destination for the demo callback, in E.164. Overrides whatever number the
     * directory record holds, so the demo always rings the presenter's phone.
     * Required to place a real call; there is deliberately no default.
     */
    defaultPhone: process.env.DEMO_PHONE_NUMBER ?? "",
  },

  dbPath: process.env.DB_PATH ?? "./data/helpdesk.db",

  /**
   * Pins the demo clock, as an ISO 8601 timestamp, so code expiry plays out the
   * same way every run. Honored only in simulation; a live call always uses
   * the real time.
   */
  demoNow: process.env.DEMO_NOW ?? "",
};

/** Values copied from `.env.example` and never filled in: `<key>`, `+1XXXXXXXXXX`, the all-zero GUID. */
const PLACEHOLDER = /<[^>]+>|^\+?\d*X{4,}$|^0{8}-0{4}-0{4}-0{4}-0{12}$/;

export function isPlaceholder(value) {
  return !value || PLACEHOLDER.test(String(value).trim());
}

const real = (value) => (isPlaceholder(value) ? "" : value);

/**
 * Config needed to place a real call. Empty means live. Takes the config
 * explicitly so it is a pure function: a readiness check that silently reads
 * ambient process state is a check you cannot test.
 */
export function assertCallConfig(cfg = config) {
  const missing = [];
  const need = (value, name) => {
    if (isPlaceholder(value)) missing.push(name);
  };
  need(cfg.acs.connectionString, "ACS_CONNECTION_STRING");
  if (!cfg.acs.telephonyMode) missing.push("TELEPHONY_MODE");
  else {
    missing.push(
      ...telephonyMissing({
        mode: cfg.acs.telephonyMode,
        callerId: real(cfg.acs.callerId),
        teamsResourceAccountId: real(cfg.acs.teamsResourceAccountId),
      }),
    );
  }
  need(cfg.publicBaseUrl, "PUBLIC_BASE_URL");
  need(cfg.voiceLive.endpoint, "VOICE_LIVE_ENDPOINT");
  need(cfg.voiceLive.apiKey, "VOICE_LIVE_API_KEY");
  need(cfg.demo.defaultPhone, "DEMO_PHONE_NUMBER");
  return missing;
}

/** True when the sample is running without the Azure configuration a real call needs. */
export const isSimulated = (cfg = config) => assertCallConfig(cfg).length > 0;
