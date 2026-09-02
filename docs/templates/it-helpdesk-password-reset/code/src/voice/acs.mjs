import { CallAutomationClient } from "@azure/communication-call-automation";
import { config } from "../config.mjs";

let client;
export function acsClient() {
  if (!client) {
    if (!config.acs.connectionString) throw new Error("ACS_CONNECTION_STRING is not set");
    client = new CallAutomationClient(config.acs.connectionString);
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
 * Note: `callerId` must be a *geographic* ACS number. Toll-free numbers cannot
 * originate outbound PSTN calls.
 */
export async function placeResetCall({ sessionId, toPhoneNumber }) {
  const base = config.publicBaseUrl;
  const wss = base.replace(/^https:/, "wss:");

  const result = await acsClient().createCall(
    {
      targetParticipant: { phoneNumber: toPhoneNumber },
      // Required on the invite itself when dialling a PSTN number.
      sourceCallIdNumber: { phoneNumber: config.acs.callerId },
    },
    `${base}/api/calls/callback?session=${encodeURIComponent(sessionId)}`,
    {
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
