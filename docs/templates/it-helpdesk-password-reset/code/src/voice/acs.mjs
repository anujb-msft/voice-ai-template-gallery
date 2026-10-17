import { config } from "../config.mjs";
import { callerArguments } from "../telephony.mjs";
import { serviceDeskIdentifier } from "../handoff.mjs";

const log = (...a) => console.log(new Date().toISOString(), "[acs]", ...a);

/**
 * The Call Automation SDK loads on first use, not at startup: the offline
 * simulation never touches ACS, so a demo laptop never pays for loading it.
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
  if (!config.acs.connectionString) throw new Error("ACS_CONNECTION_STRING is not set");
  const { CallAutomationClient } = await import("@azure/communication-call-automation");
  return new CallAutomationClient(config.acs.connectionString);
}

/**
 * Place the proactive outbound call.
 *
 * The reset session id rides along in two places:
 *   - the media streaming transport URL query string, so the audio socket can be
 *     matched to the right browser session
 *   - the callback URL, so ACS lifecycle events are attributable
 *
 * Caller identity is mode-specific: a Teams resource account through Teams
 * Phone extensibility, or a geographic ACS number.
 */
export async function placeResetCall({ sessionId, toPhoneNumber }) {
  const base = config.publicBaseUrl;
  const wss = base.replace(/^https:/, "wss:");
  const caller = callerArguments({
    mode: config.acs.telephonyMode,
    callerId: config.acs.callerId,
    teamsResourceAccountId: config.acs.teamsResourceAccountId,
  });

  const acs = await acsClient();
  const result = await acs.createCall(
    {
      targetParticipant: { phoneNumber: toPhoneNumber },
      ...caller.invite,
    },
    `${base}/api/calls/callback?session=${encodeURIComponent(sessionId)}`,
    {
      ...caller.options,
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

/**
 * Hand the call to the IT service desk in Teams and step out of the way. The
 * VoIP headers are built by `handoff.mjs`, the same function the console's
 * Teams panel shows, so what the presenter sees is what the specialist gets.
 */
export async function transferToServiceDesk({ callConnectionId, sessionId, voipHeaders }) {
  if (!callConnectionId) throw new Error("no call connection to transfer");
  const connection = (await acsClient()).getCallConnection(callConnectionId);
  await connection.transferCallToParticipant(serviceDeskIdentifier(config.serviceDesk), {
    operationContext: `transfer:${sessionId}`,
    customCallingContext: voipHeaders,
  });
  log("transfer requested", sessionId, "-> IT service desk");
}

/**
 * Listen for keypad presses for the rest of the call. The flow only uses them
 * on the identity step, for a caller on a noisy line.
 */
export async function startDtmfRecognition({ callConnectionId, phoneNumber }) {
  if (!callConnectionId || !phoneNumber) return;
  try {
    await (await acsClient())
      .getCallConnection(callConnectionId)
      .getCallMedia()
      .startContinuousDtmfRecognition({ phoneNumber });
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
    /* call may already be gone */
  }
}
