import { config } from "../config.mjs";
import { teamsIdentifier, buildCustomCallingContext } from "../handoff.mjs";

export { teamsIdentifier, buildCustomCallingContext };

const log = (...a) => console.log(new Date().toISOString(), "[acs]", ...a);

/**
 * The Azure SDKs load on first use, not at startup. Simulation never touches
 * ACS, and @azure/identity alone can add many seconds to a cold start on a slow
 * filesystem — the difference between a demo that restarts at once and one
 * that keeps the room waiting.
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
  // Entra first. A connection string is still accepted, but it means an ACS
  // key has to live in a file somewhere, and there is no reason to require
  // that when the SDK takes a TokenCredential.
  if (config.acs.endpoint) {
    const { DefaultAzureCredential } = await import("@azure/identity");
    return new CallAutomationClient(config.acs.endpoint, new DefaultAzureCredential());
  }
  return new CallAutomationClient(config.acs.connectionString);
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

  const acs = await acsClient();
  const result = await acs.answerCall(incomingCallContext, `${base}/api/calls/callback?call=${q}`, {
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
 * Subscribe to keypad presses for the rest of the call, so the caller can press
 * 0 for a person at any point. The flow maps 0 and ignores every other digit.
 */
export async function startDtmfRecognition({ callConnectionId, fromPhone }) {
  if (!callConnectionId || !fromPhone) return;
  try {
    await (await acsClient())
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
    await (await acsClient()).getCallConnection(callConnectionId).hangUp(true);
  } catch {
    /* call may already be gone */
  }
}
