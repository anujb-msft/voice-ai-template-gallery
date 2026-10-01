import { CallAutomationClient } from "@azure/communication-call-automation";
import { DefaultAzureCredential } from "@azure/identity";
import { config } from "../config.mjs";

const log = (...a) => console.log(new Date().toISOString(), "[acs]", ...a);
let client;
let cred;
function credential() { if (!cred) cred = new DefaultAzureCredential(); return cred; }
export function acsClient() {
  if (!client) {
    if (config.acs.endpoint) client = new CallAutomationClient(config.acs.endpoint, credential());
    else if (config.acs.connectionString) client = new CallAutomationClient(config.acs.connectionString);
    else throw new Error("Set ACS_ENDPOINT or ACS_CONNECTION_STRING");
  }
  return client;
}

const phone = (value) => ({ phoneNumber: value });

export async function answerInboundCall({ incomingCallContext, callId }) {
  const base = config.publicBaseUrl;
  const wss = base.replace(/^https:/, "wss:");
  const q = encodeURIComponent(callId);
  const result = await acsClient().answerCall(incomingCallContext, `${base}/api/calls/callback?call=${q}&leg=intake`, {
    operationContext: `answer:${callId}`,
    mediaStreamingOptions: { transportType: "websocket", transportUrl: `${wss}/ws/media?call=${q}&leg=intake`, contentType: "audio", audioChannelType: "mixed", startMediaStreaming: true, enableBidirectional: true, audioFormat: "pcm24KMono" },
  });
  const callConnectionId = result.callConnectionProperties?.callConnectionId ?? null;
  log("answered", callId, callConnectionId);
  return { callConnectionId };
}

export async function createPageCall({ incidentId, contact, briefKind = "page" }) {
  const base = config.publicBaseUrl;
  const wss = base.replace(/^https:/, "wss:");
  const q = encodeURIComponent(incidentId);
  const result = await acsClient().createCall(phone(contact.mobile), `${base}/api/calls/callback?call=${q}&leg=page`, {
    operationContext: `${briefKind}:${incidentId}:${contact.id}`,
    sourceCallerIdNumber: phone(config.acs.outboundCallerId),
    mediaStreamingOptions: { transportType: "websocket", transportUrl: `${wss}/ws/media?call=${q}&leg=page`, contentType: "audio", audioChannelType: "mixed", startMediaStreaming: true, enableBidirectional: true, audioFormat: "pcm24KMono" },
  });
  return { callConnectionId: result.callConnectionProperties?.callConnectionId ?? null };
}

export async function createStatusCall({ incident, message }) {
  if (!incident.callbackNumber) return { skipped: true };
  const result = await acsClient().createCall(phone(incident.callbackNumber), `${config.publicBaseUrl}/api/calls/callback?call=${encodeURIComponent(incident.id)}&leg=status`, { operationContext: `status:${incident.id}`, sourceCallerIdNumber: phone(config.acs.outboundCallerId) });
  log("status call", incident.id, message);
  return { callConnectionId: result.callConnectionProperties?.callConnectionId ?? null };
}

export async function addTenantParticipant({ callConnectionId, incident }) {
  if (!callConnectionId || !incident.callbackNumber) throw new Error("bridge requires active page call and tenant callback");
  await acsClient().getCallConnection(callConnectionId).addParticipant(phone(incident.callbackNumber), { operationContext: `bridge:${incident.id}` });
  return { ok: true };
}

export async function startDtmfRecognition({ callConnectionId, targetPhone }) {
  if (!callConnectionId || !targetPhone) return;
  try { await acsClient().getCallConnection(callConnectionId).getCallMedia().startContinuousDtmfRecognition(phone(targetPhone)); } catch (e) { log("DTMF unavailable", e.message); }
}

export async function hangUp(callConnectionId) {
  if (!callConnectionId) return;
  try { await acsClient().getCallConnection(callConnectionId).hangUp(true); } catch {}
}
