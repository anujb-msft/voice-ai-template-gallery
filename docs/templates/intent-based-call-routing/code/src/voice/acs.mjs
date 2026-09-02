import { CallAutomationClient } from "@azure/communication-call-automation";
import { config } from "../config.mjs";
import { teamsIdentifier, buildCustomCallingContext } from "../handoff.mjs";

export { teamsIdentifier, buildCustomCallingContext };

const log = (...a) => console.log(new Date().toISOString(), "[acs]", ...a);

let client;
export function acsClient() {
  if (!client) {
    if (!config.acs.connectionString) throw new Error("ACS_CONNECTION_STRING is not set");
    client = new CallAutomationClient(config.acs.connectionString);
  }
  return client;
}

/**
 * Answer an inbound PSTN call and open the media stream in one operation.
 *
 * The call id travels in both the callback URL and the media transport URL, so
 * lifecycle events and the audio socket both land on the right state machine
 * without any extra correlation table.
 */
export async function answerInboundCall({ incomingCallContext, callId }) {
  const base = config.publicBaseUrl;
  const wss = base.replace(/^https:/, "wss:");
  const q = encodeURIComponent(callId);

  const result = await acsClient().answerCall(incomingCallContext, `${base}/api/calls/callback?call=${q}`, {
    operationContext: `answer:${callId}`,
    mediaStreamingOptions: {
      transportType: "websocket",
      transportUrl: `${wss}/ws/media?call=${q}`,
      contentType: "audio",
      audioChannelType: "mixed",
      startMediaStreaming: true,
      enableBidirectional: true,
      // Matches the Voice Live PCM path exactly, so no resampling on this leg.
      audioFormat: "pcm24KMono",
    },
  });

  const callConnectionId = result.callConnectionProperties?.callConnectionId ?? null;
  log("answered", callId, "->", callConnectionId);
  return { callConnectionId };
}

/**
 * Hand the call to Teams and step out of the way.
 *
 * A blind transfer is deliberate for this template: the voice agent's job ends
 * once the context has been delivered, and staying on the line would mean a
 * silent third party on every routed call.
 */
export async function transferToTeams({ callConnectionId, target, context, callId }) {
  if (!callConnectionId) throw new Error("no call connection to transfer");

  const connection = acsClient().getCallConnection(callConnectionId);
  await connection.transferCallToParticipant(teamsIdentifier(target), {
    operationContext: `transfer:${callId}`,
    customCallingContext: buildCustomCallingContext(context),
  });

  log("transfer requested", callId, "->", target.displayName ?? target.objectId);
}

/**
 * Subscribe to keypad presses for the rest of the call. The caller can press a
 * digit at any point; the flow only *mentions* the keypad when speech has
 * already failed twice.
 */
export async function startDtmfRecognition({ callConnectionId, fromPhone }) {
  if (!callConnectionId || !fromPhone) return;
  try {
    await acsClient()
      .getCallConnection(callConnectionId)
      .getCallMedia()
      .startContinuousDtmfRecognition({ phoneNumber: fromPhone });
  } catch (e) {
    // Not fatal: speech still works, the caller just loses the keypad shortcut.
    log("could not start DTMF recognition:", e.message);
  }
}

export async function hangUp(callConnectionId) {
  if (!callConnectionId) return;
  try {
    await acsClient().getCallConnection(callConnectionId).hangUp(true);
  } catch {
    /* call may already be gone */
  }
}
