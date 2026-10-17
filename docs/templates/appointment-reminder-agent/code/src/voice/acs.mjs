import { config } from "../config.mjs";
import { buildCustomCallingContext } from "../handoff.mjs";

/**
 * Azure Communication Services Call Automation: call control and the media
 * bridge behind the Teams Phone channel. The SDKs load on first use, so a server
 * in simulation mode never loads them.
 */
let client;
export async function acsClient() {
  if (client) return client;
  const { CallAutomationClient } = await import("@azure/communication-call-automation");
  if (config.acs.endpoint) {
    const { DefaultAzureCredential } = await import("@azure/identity");
    client = new CallAutomationClient(config.acs.endpoint, new DefaultAzureCredential());
  } else if (config.acs.connectionString) {
    client = new CallAutomationClient(config.acs.connectionString);
  } else {
    throw new Error("Set ACS_ENDPOINT or ACS_CONNECTION_STRING");
  }
  return client;
}

const mediaOptions = (callId) => ({ transportType: "websocket", transportUrl: `${config.publicBaseUrl.replace(/^https:/, "wss:")}/ws/media?call=${encodeURIComponent(callId)}`, contentType: "audio", audioChannelType: "mixed", startMediaStreaming: true, enableBidirectional: true, audioFormat: "pcm24KMono" });

/**
 * The CallInvite createCall expects. The SDK reads the caller ID from the invite,
 * not from the options, and a PSTN call needs one.
 */
export function reminderCallInvite(to, callerId = config.acs.callerId) {
  return { targetParticipant: { phoneNumber: to }, sourceCallIdNumber: { phoneNumber: callerId } };
}

export async function createOutboundCall({ to, callId, operationContext = `reminder:${callId}` }) {
  const result = await (await acsClient()).createCall(reminderCallInvite(to), `${config.publicBaseUrl}/api/calls/callback?call=${encodeURIComponent(callId)}`, { operationContext, mediaStreamingOptions: mediaOptions(callId) });
  return { callConnectionId: result.callConnectionProperties?.callConnectionId ?? null };
}

export async function answerInboundCall({ incomingCallContext, callId }) {
  const result = await (await acsClient()).answerCall(incomingCallContext, `${config.publicBaseUrl}/api/calls/callback?call=${encodeURIComponent(callId)}`, { operationContext: `answer:${callId}`, mediaStreamingOptions: mediaOptions(callId) });
  return { callConnectionId: result.callConnectionProperties?.callConnectionId ?? null };
}

export async function transferCall({ callConnectionId, target, context, callId }) {
  if (!callConnectionId) throw new Error("no call connection to transfer");
  const participant = /^\+/.test(target) ? { phoneNumber: target } : { microsoftTeamsUserId: target };
  await (await acsClient()).getCallConnection(callConnectionId).transferCallToParticipant(participant, { operationContext: `transfer:${callId}`, customCallingContext: buildCustomCallingContext(context) });
}

export async function startDtmfRecognition({ callConnectionId, fromPhone }) {
  if (!callConnectionId || !fromPhone) return;
  try { await (await acsClient()).getCallConnection(callConnectionId).getCallMedia().startContinuousDtmfRecognition({ phoneNumber: fromPhone }); } catch {}
}

export async function hangUp(callConnectionId) {
  if (!callConnectionId) return;
  try { await (await acsClient()).getCallConnection(callConnectionId).hangUp(true); } catch {}
}
