import { config } from "../config.mjs";
import { teamsIdentifier, buildCustomCallingContext } from "../handoff.mjs";

export { teamsIdentifier, buildCustomCallingContext };

const log = (...a) => console.log(new Date().toISOString(), "[acs]", ...a);

// The Azure SDKs load on the first real call, so a simulation-only server never loads them.
let client;
export async function acsClient() {
  if (!client) {
    const { CallAutomationClient } = await import("@azure/communication-call-automation");
    // Entra first. A connection string is still accepted, but it means an ACS
    // key has to live in a file somewhere, and there is no reason to require
    // that when the SDK takes a TokenCredential.
    if (config.acs.endpoint) {
      client = new CallAutomationClient(config.acs.endpoint, await credential());
    } else if (config.acs.connectionString) {
      client = new CallAutomationClient(config.acs.connectionString);
    } else {
      throw new Error("Set ACS_ENDPOINT (preferred) or ACS_CONNECTION_STRING");
    }
  }
  return client;
}

let cred;
async function credential() {
  if (!cred) {
    const { DefaultAzureCredential } = await import("@azure/identity");
    cred = new DefaultAzureCredential();
  }
  return cred;
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

  const result = await (await acsClient()).answerCall(incomingCallContext, `${base}/api/calls/callback?call=${q}`, {
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

  const connection = (await acsClient()).getCallConnection(callConnectionId);
  await connection.transferCallToParticipant(teamsIdentifier(target), {
    operationContext: `transfer:${callId}`,
    customCallingContext: buildCustomCallingContext(context),
  });

  log("transfer requested", callId, "->", target.displayName ?? target.objectId);
}

/**
 * Subscribe to keypad presses for the rest of the call. A caller on a
 * registered mobile enters the PIN this way, so without it a PSTN caller cannot
 * be verified; a Teams caller is verified by sign-in and needs no keypad.
 */
export async function startDtmfRecognition({ callConnectionId, fromPhone }) {
  if (!callConnectionId || !fromPhone) return;
  try {
    await (await acsClient())
      .getCallConnection(callConnectionId)
      .getCallMedia()
      .startContinuousDtmfRecognition({ phoneNumber: fromPhone });
  } catch (e) {
    log("could not start DTMF recognition:", e.message);
  }
}

export async function hangUp(callConnectionId) {
  if (!callConnectionId) return;
  try {
    await (await acsClient()).getCallConnection(callConnectionId).hangUp(true);
  } catch {
    /* call may already be gone */
  }
}
