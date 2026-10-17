import { config } from "../config.mjs";
import { teamsIdentifier, buildCustomCallingContext } from "../handoff.mjs";

export { teamsIdentifier, buildCustomCallingContext };

const log = (...a) => console.log(new Date().toISOString(), "[acs]", ...a);

/**
 * The Azure SDKs load on first use, not at startup. Simulation never touches
 * ACS, and @azure/identity alone can add seconds to a cold start on a slow
 * filesystem, which is the difference between a demo that restarts at once and
 * one that keeps the room waiting.
 */
let client;
export function acsClient() {
  client ??= createClient().catch((e) => {
    client = null;
    throw e;
  });
  return client;
}

async function createClient() {
  if (!config.acs.endpoint && !config.acs.connectionString) {
    throw new Error("Set ACS_ENDPOINT (preferred) or ACS_CONNECTION_STRING");
  }
  const { CallAutomationClient } = await import("@azure/communication-call-automation");
  // Microsoft Entra ID first. A connection string still works, but it means an
  // ACS key has to live in a file somewhere.
  if (config.acs.endpoint) {
    const { DefaultAzureCredential } = await import("@azure/identity");
    return new CallAutomationClient(config.acs.endpoint, new DefaultAzureCredential());
  }
  return new CallAutomationClient(config.acs.connectionString);
}

/**
 * Answers an inbound call. After hours the media stream opens with the answer,
 * so the voice agent can greet the caller. In business hours the call is
 * answered without media (`startMedia: false`) only so it can be transferred
 * to the Teams sales queue.
 *
 * The call id travels in both the callback URL and the media transport URL, so
 * lifecycle events and the audio socket land on the right call without a
 * separate lookup table.
 */
export async function answerInboundCall({ incomingCallContext, callId, startMedia = true }) {
  const base = config.publicBaseUrl;
  const wss = base.replace(/^https:/, "wss:");
  const q = encodeURIComponent(callId);

  const options = { operationContext: `answer:${callId}` };
  if (startMedia) {
    options.mediaStreamingOptions = {
      transportType: "websocket",
      transportUrl: `${wss}/ws/media?call=${q}`,
      contentType: "audio",
      audioChannelType: "mixed",
      startMediaStreaming: true,
      enableBidirectional: true,
      // Matches the Voice Live PCM format exactly, so this leg needs no resampling.
      audioFormat: "pcm24KMono",
    };
  }

  const acs = await acsClient();
  const result = await acs.answerCall(incomingCallContext, `${base}/api/calls/callback?call=${q}`, options);
  const callConnectionId = result.callConnectionProperties?.callConnectionId ?? null;
  log("answered", callId, startMedia ? "with media" : "for transfer", "->", callConnectionId);
  return { callConnectionId };
}

/**
 * Hands the call to Teams: the sales queue in business hours, or the on-call
 * rep's Teams user after a page. The captured lead travels as VoIP headers, so
 * the person who answers sees it on the incoming-call toast.
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
 * Listens for keypad presses for the rest of the call, so a caller can press 0
 * to ask for a person at any point.
 */
export async function startDtmfRecognition({ callConnectionId, fromPhone }) {
  if (!callConnectionId || !fromPhone) return;
  try {
    await (await acsClient())
      .getCallConnection(callConnectionId)
      .getCallMedia()
      .startContinuousDtmfRecognition({ phoneNumber: fromPhone });
  } catch (e) {
    // Not fatal: speech still works, and the caller can still ask for a person.
    log("could not start DTMF recognition:", e.message);
  }
}

export async function hangUp(callConnectionId) {
  if (!callConnectionId) return;
  try {
    await (await acsClient()).getCallConnection(callConnectionId).hangUp(true);
  } catch {
    // The call may already be gone.
  }
}
