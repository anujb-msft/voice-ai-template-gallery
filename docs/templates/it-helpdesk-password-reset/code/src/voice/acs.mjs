import { CallAutomationClient } from "@azure/communication-call-automation";
import { DefaultAzureCredential } from "@azure/identity";
import { config } from "../config.mjs";
import { callerArguments, telephonyAuth } from "../telephony.mjs";

let client;
export function acsClient() {
  if (!client) {
    // Entra first, so no ACS key has to live in a file. A connection string is
    // still accepted as an explicit fallback.
    const auth = telephonyAuth(config.acs);
    if (auth === "entra") client = new CallAutomationClient(config.acs.endpoint, new DefaultAzureCredential());
    else if (auth === "connection-string") client = new CallAutomationClient(config.acs.connectionString);
    else throw new Error("Set ACS_ENDPOINT (preferred) or ACS_CONNECTION_STRING");
  }
  return client;
}

/**
 * Place the proactive outbound call.
 *
 * The reset session id rides along in two places:
 *   - the media streaming transport URL query string, so the audio socket can be
 *     matched to the right browser session
 *   - the callback URL, so ACS lifecycle events are attributable
 *
 * Caller identity is mode-specific: either a geographic ACS number or a Teams
 * resource account configured for Teams Phone extensibility.
 */
export async function placeResetCall({ sessionId, toPhoneNumber }) {
  const base = config.publicBaseUrl;
  const wss = base.replace(/^https:/, "wss:");
  const caller = callerArguments({
    mode: config.acs.telephonyMode,
    callerId: config.acs.callerId,
    teamsResourceAccountId: config.acs.teamsResourceAccountId,
  });

  const result = await acsClient().createCall(
    {
      targetParticipant: { phoneNumber: toPhoneNumber },
      ...caller.invite,
    },
    `${base}/api/calls/callback?session=${encodeURIComponent(sessionId)}`,
    {
      ...caller.options,
      mediaStreamingOptions: {
        transportType: "websocket",
        transportUrl: `${wss}/ws/media?session=${encodeURIComponent(sessionId)}`,
        contentType: "audio",
        audioChannelType: "mixed",
        startMediaStreaming: true,
        enableBidirectional: true,
        // Matches the Voice Live PCM path exactly, so no resampling on this leg.
        audioFormat: "pcm24KMono",
      },
    },
  );

  return {
    callConnectionId: result.callConnectionProperties?.callConnectionId ?? null,
  };
}

export async function hangUp(callConnectionId) {
  if (!callConnectionId) return;
  try {
    await acsClient().getCallConnection(callConnectionId).hangUp(true);
  } catch {
    /* call may already be gone */
  }
}
