import "dotenv/config";
import { normalizeTelephonyMode, telephonyMissing } from "./telephony.mjs";

const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
};

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
    telephonyMode: normalizeTelephonyMode(process.env.TELEPHONY_MODE),
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

  signalr: {
    /** Optional. When empty the server falls back to a built-in WebSocket hub. */
    connectionString: process.env.AZURE_SIGNALR_CONNECTION_STRING ?? "",
    hub: process.env.AZURE_SIGNALR_HUB ?? "helpdesk",
  },

  demo: {
    /**
     * Destination for the demo callback, in E.164. Overrides whatever number the
     * directory record holds, so the demo always rings the presenter's phone.
     * Required to place a real call — there is deliberately no default.
     */
    defaultPhone: process.env.DEMO_PHONE_NUMBER ?? "",
    /** Loaded industry benchmark used by the deflection panel. */
    ticketCostUsd: Number(process.env.HELPDESK_TICKET_COST_USD ?? 25),
    ticketMinutes: Number(process.env.HELPDESK_TICKET_MINUTES ?? 18),
  },

  dbPath: process.env.DB_PATH ?? "./data/helpdesk.db",
  required,
};

export function assertCallConfig() {
  const missing = [];
  if (!config.acs.connectionString) missing.push("ACS_CONNECTION_STRING");
  missing.push(
    ...telephonyMissing({
      mode: config.acs.telephonyMode,
      callerId: config.acs.callerId,
      teamsResourceAccountId: config.acs.teamsResourceAccountId,
    }),
  );
  if (!config.publicBaseUrl) missing.push("PUBLIC_BASE_URL");
  if (!config.voiceLive.endpoint) missing.push("VOICE_LIVE_ENDPOINT");
  if (!config.voiceLive.apiKey) missing.push("VOICE_LIVE_API_KEY");
  if (!config.demo.defaultPhone) missing.push("DEMO_PHONE_NUMBER");
  return missing;
}
