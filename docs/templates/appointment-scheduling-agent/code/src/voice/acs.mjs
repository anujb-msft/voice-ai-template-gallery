import { CallAutomationClient } from "@azure/communication-call-automation";
import { DefaultAzureCredential } from "@azure/identity";
import { config } from "../config.mjs";
import { buildCustomCallingContext } from "../handoff.mjs";

let client, cred;
function credential() { if (!cred) cred = new DefaultAzureCredential(); return cred; }
export function acsClient() { if (!client) { if (config.acs.endpoint) client = new CallAutomationClient(config.acs.endpoint, credential()); else if (config.acs.connectionString) client = new CallAutomationClient(config.acs.connectionString); else throw new Error("Set ACS_ENDPOINT or ACS_CONNECTION_STRING"); } return client; }
const mediaOptions = (callId) => ({ transportType: "websocket", transportUrl: `${config.publicBaseUrl.replace(/^https:/, "wss:")}/ws/media?call=${encodeURIComponent(callId)}`, contentType: "audio", audioChannelType: "mixed", startMediaStreaming: true, enableBidirectional: true, audioFormat: "pcm24KMono" });
export async function createOutboundCall({ to, callId, operationContext = `scheduling:${callId}` }) {
  const result = await acsClient().createCall({ phoneNumber: to }, `${config.publicBaseUrl}/api/calls/callback?call=${encodeURIComponent(callId)}`, { sourceCallIdNumber: { phoneNumber: config.acs.callerId }, operationContext, mediaStreamingOptions: mediaOptions(callId) });
  return { callConnectionId: result.callConnectionProperties?.callConnectionId ?? null };
}
export async function answerInboundCall({ incomingCallContext, callId }) {
  const result = await acsClient().answerCall(incomingCallContext, `${config.publicBaseUrl}/api/calls/callback?call=${encodeURIComponent(callId)}`, { operationContext: `answer:${callId}`, mediaStreamingOptions: mediaOptions(callId) });
  return { callConnectionId: result.callConnectionProperties?.callConnectionId ?? null };
}
export async function transferCall({ callConnectionId, target, context, callId }) {
  if (!callConnectionId) throw new Error("no call connection to transfer");
  const participant = /^\+/.test(target) ? { phoneNumber: target } : { microsoftTeamsUserId: target };
  await acsClient().getCallConnection(callConnectionId).transferCallToParticipant(participant, { operationContext: `transfer:${callId}`, customCallingContext: buildCustomCallingContext(context) });
}
export async function startDtmfRecognition({ callConnectionId, fromPhone }) { if (!callConnectionId || !fromPhone) return; try { await acsClient().getCallConnection(callConnectionId).getCallMedia().startContinuousDtmfRecognition({ phoneNumber: fromPhone }); } catch {} }
export async function hangUp(callConnectionId) { if (!callConnectionId) return; try { await acsClient().getCallConnection(callConnectionId).hangUp(true); } catch {} }
