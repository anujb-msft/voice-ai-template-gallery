import { config } from "../config.mjs";
import { teamsIdentifier, buildCustomCallingContext } from "../handoff.mjs";

export { teamsIdentifier, buildCustomCallingContext };

const log = (...a) => console.log(new Date().toISOString(), "[acs]", ...a);

/**
 * The Azure SDKs load on first use, not at startup. Simulation never touches
 * ACS, and @azure/identity alone can add seconds to a cold start, which is the
 * difference between a demo that restarts at once and one that keeps the room
 * waiting.
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
  // Entra first. A connection string still works, but it puts an ACS key in a
  // file, and the SDK takes a TokenCredential.
  if (config.acs.endpoint) {
    const { DefaultAzureCredential } = await import("@azure/identity");
    return new CallAutomationClient(config.acs.endpoint, new DefaultAzureCredential());
  }
  return new CallAutomationClient(config.acs.connectionString);
}

/**
 * Answer an inbound call and open the media stream in one operation.
 *
 * The call id travels in both the callback URL and the media transport URL, so
 * lifecycle events and the audio socket land on the same scheduling flow
 * without a correlation table.
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
 * Hand the call to a Teams queue (or user) and step out of the way.
 *
 * `target` is the destination from config/routing.json: its `target` object id
 * and `type`. The topic and context ride in VoIP headers built by the same
 * function the console uses to show them, so what the console shows is what
 * the scheduler receives.
 */
export async function transferToTeams({ callConnectionId, target, type = "callQueue", context, callId }) {
  if (!callConnectionId) throw new Error("no call connection to transfer");
  const identifier = teamsIdentifier(typeof target === "string" ? { objectId: target, type } : target);

  const connection = (await acsClient()).getCallConnection(callConnectionId);
  await connection.transferCallToParticipant(identifier, {
    operationContext: `transfer:${callId}`,
    customCallingContext: buildCustomCallingContext(context ?? {}),
  });

  log("transfer requested", callId, "->", type);
}

/**
 * Subscribe to keypad presses for the rest of the call: 1 confirms and 2
 * declines the active proposal, 0 asks for the scheduling team.
 */
export async function startDtmfRecognition({ callConnectionId, fromPhone }) {
  if (!callConnectionId || !fromPhone) return;
  try {
    await (await acsClient())
      .getCallConnection(callConnectionId)
      .getCallMedia()
      .startContinuousDtmfRecognition({ phoneNumber: fromPhone });
  } catch (e) {
    // Not fatal: speech still works, the caller just loses the keypad.
    log("could not start DTMF recognition:", e.message);
  }
}

export async function hangUp(callConnectionId) {
  if (!callConnectionId) return;
  try {
    await (await acsClient()).getCallConnection(callConnectionId).hangUp(true);
  } catch {
    /* the call may already be gone */
  }
}
