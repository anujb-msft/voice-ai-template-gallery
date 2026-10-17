import { config } from "../config.mjs";

const log = (...a) => console.log(new Date().toISOString(), "[acs]", ...a);
let client = null;

/** Lazy: the Call Automation SDK loads on the first real call, never in simulation mode. */
export function acsClient() {
  client ??= createClient().catch((e) => {
    client = null;
    throw e;
  });
  return client;
}

async function createClient() {
  const { CallAutomationClient } = await import("@azure/communication-call-automation");
  if (config.acs.endpoint) {
    const { DefaultAzureCredential } = await import("@azure/identity");
    return new CallAutomationClient(config.acs.endpoint, new DefaultAzureCredential());
  }
  if (config.acs.connectionString) return new CallAutomationClient(config.acs.connectionString);
  throw new Error("Set ACS_ENDPOINT or ACS_CONNECTION_STRING");
}

const phone = (value) => ({ phoneNumber: value });
/** SDK 1.6 CallInvite: who to ring, and the number the call presents — ACS_OUTBOUND_CALLER_ID, a number this ACS resource can call from (see README.md). */
const invite = (to) => ({ targetParticipant: phone(to), sourceCallIdNumber: phone(config.acs.outboundCallerId) });
const mediaStreaming = (q, leg) => ({
  transportType: "websocket",
  transportUrl: `${config.publicBaseUrl.replace(/^https:/, "wss:")}/ws/media?call=${q}&leg=${leg}`,
  contentType: "audio",
  audioChannelType: "mixed",
  startMediaStreaming: true,
  enableBidirectional: true,
  audioFormat: "pcm24KMono",
});
const callback = (q, leg) => `${config.publicBaseUrl}/api/calls/callback?call=${q}&leg=${leg}`;

export async function answerInboundCall({ incomingCallContext, callId }) {
  const q = encodeURIComponent(callId);
  const result = await (await acsClient()).answerCall(incomingCallContext, callback(q, "intake"), {
    operationContext: `answer:${callId}`,
    mediaStreamingOptions: mediaStreaming(q, "intake"),
  });
  const callConnectionId = result.callConnectionProperties?.callConnectionId ?? null;
  log("answered", callId, callConnectionId);
  return { callConnectionId };
}

/** The page: an outbound PSTN call to the technician's mobile, bridged to Voice Live, which reads the brief. */
export async function createPageCall({ incidentId, contact }) {
  const q = encodeURIComponent(incidentId);
  const result = await (await acsClient()).createCall(invite(contact.mobile), callback(q, "page"), {
    operationContext: `page:${incidentId}:${contact.id}`,
    mediaStreamingOptions: mediaStreaming(q, "page"),
  });
  return { callConnectionId: result.callConnectionProperties?.callConnectionId ?? null };
}

/** The call back to the tenant, bridged to Voice Live, which says the server-written update and hangs up. */
export async function createStatusCall({ incident, message }) {
  if (!incident.callbackNumber) return { skipped: true };
  const q = encodeURIComponent(incident.id);
  const result = await (await acsClient()).createCall(invite(incident.callbackNumber), callback(q, "status"), {
    operationContext: `status:${incident.id}`,
    mediaStreamingOptions: mediaStreaming(q, "status"),
  });
  log("status call", incident.id, message);
  return { callConnectionId: result.callConnectionProperties?.callConnectionId ?? null };
}

export async function addTenantParticipant({ callConnectionId, incident }) {
  if (!callConnectionId || !incident.callbackNumber) throw new Error("bridge requires active page call and tenant callback");
  await (await acsClient()).getCallConnection(callConnectionId).addParticipant(invite(incident.callbackNumber), { operationContext: `bridge:${incident.id}` });
  return { ok: true };
}

export async function startDtmfRecognition({ callConnectionId, targetPhone }) {
  if (!callConnectionId || !targetPhone) return;
  try {
    await (await acsClient()).getCallConnection(callConnectionId).getCallMedia().startContinuousDtmfRecognition(phone(targetPhone));
  } catch (e) {
    log("DTMF unavailable", e.message);
  }
}

export async function hangUp(callConnectionId) {
  if (!callConnectionId) return;
  try {
    await (await acsClient()).getCallConnection(callConnectionId).hangUp(true);
  } catch (e) {
    log("hang up failed", e.message);
  }
}
