import { WebSocketServer } from "ws";
import { VoiceLiveSession, buildInstructions } from "./voice-live.mjs";
import { hangUp } from "./acs.mjs";
import { config } from "../config.mjs";
import { STATES } from "../flow.mjs";

const log = (...a) => console.log(new Date().toISOString(), "[bridge]", ...a);

// When the flow ends a call, the agent still has to say the closing line. The
// bridge waits for that line to play before it hangs up: time for the reply to
// start, plus about 65 ms a character of speech, and never more than 25 s.
const REPLY_START_MS = 2500;
const MS_PER_CHAR = 65;
const MAX_GOODBYE_MS = 25000;
const speakingMs = (text) => 1500 + String(text ?? "").length * MS_PER_CHAR;

/**
 * Bridges one ACS call to one Voice Live session and wires both into the lead
 * capture flow.
 *
 *   PSTN caller
 *      ⇅  ACS bidirectional media streaming (WebSocket, PCM16 24 kHz mono)
 *   this process
 *      ⇅  Voice Live (WebSocket, PCM16 24 kHz mono, forwarded verbatim)
 *   gpt-realtime
 *
 * The bridge turns tool calls into flow methods and nothing else. The flow
 * decides when a lead is complete, who owns it and whether anyone is paged, so
 * it can be tested without the bridge.
 */
class CallBridge {
  constructor({ callId, acsSocket, flow }) {
    this.callId = callId;
    this.acs = acsSocket;
    this.flow = flow;
    this.lastSpoken = "";
    this.hangUpAt = null;
    this.hangUpTimer = null;
    this.goodbyeDeadline = null;
    this.stopped = false;
  }

  async start() {
    this.voice = new VoiceLiveSession({
      instructions: buildInstructions({ hours: this.flow.hours, catalog: this.flow.catalog }, config.locale),
      onAgentAudio: (base64Pcm) => this.#toCaller(base64Pcm),
      onEvent: (e) => this.#onVoiceEvent(e),
      onToolCall: (name, args) => this.#onToolCall(name, args),
    });

    await this.voice.connect();

    this.flow.registerAgent(this.callId, {
      // The flow passes a step prompt and the line it expects. The model gets
      // the prompt and says the line in its own words; its transcript comes
      // back through #onVoiceEvent.
      instruct: (prompt, spoken) => {
        this.lastSpoken = spoken ?? "";
        this.voice.instruct(prompt);
      },
      nudge: (prompt, opts) => this.voice.nudge(prompt, opts),
      end: () => this.#hangUpAfterGoodbye(),
    });

    // The caller ID counts as the callback number only once the agent has read it back.
    this.flow.expectReadBack(this.callId);
    // Moving into discovery is what makes the agent speak first.
    this.flow.answered(this.callId);
  }

  /** Both legs are PCM16 24 kHz mono, so the base64 payload is forwarded verbatim. */
  #toCaller(base64Pcm) {
    if (this.acs.readyState !== this.acs.OPEN) return;
    this.acs.send(JSON.stringify({ kind: "AudioData", audioData: { data: base64Pcm } }));
  }

  #stopCallerPlayback() {
    if (this.acs.readyState === this.acs.OPEN) {
      this.acs.send(JSON.stringify({ kind: "StopAudio", stopAudio: {} }));
    }
  }

  #onVoiceEvent(e) {
    switch (e.kind) {
      case "user_speech_started":
        // Barge-in: flush whatever ACS still has buffered so the agent stops at once.
        this.#stopCallerPlayback();
        this.voice.cancelResponse();
        break;
      case "user_transcript":
        this.flow.pushTranscript(this.callId, "caller", e.text);
        break;
      case "agent_transcript":
        this.flow.pushTranscript(this.callId, "agent", e.text);
        // A goodbye that is still being spoken pushes the hang-up back.
        if (this.hangUpAt != null) this.#hangUpNoEarlierThan(Date.now() + speakingMs(e.text));
        break;
      case "error":
        log("voice error", JSON.stringify(e.error));
        break;
    }
  }

  async #onToolCall(name, args = {}) {
    try {
      switch (name) {
        case "lookup_catalog":
          return this.flow.lookupCatalog(this.callId, args.query ?? "");
        case "save_lead":
          // The reply carries only the lead id and the follow-up promise, or
          // `contact_unconfirmed` with the number to read back.
          return this.flow.saveLead(this.callId, args.fields ?? {});
        case "classify_non_sales":
          return this.flow.classifyNonSales(this.callId, args.kind, args.note ?? "");
        case "end_call":
          if (args.reason) this.flow.logEvent(this.callId, "agent", "end_call", args.reason);
          // Refused while the on-call rep is being paged; the flow says so.
          return this.flow.endCall(this.callId, "agent_ended");
        default:
          return { error: `Unknown tool ${name}` };
      }
    } catch (e) {
      log("tool failed", name, e.message);
      return { error: e.message };
    }
  }

  /** The flow ended the call: hang up once the closing line has played. */
  #hangUpAfterGoodbye() {
    this.goodbyeDeadline ??= Date.now() + MAX_GOODBYE_MS;
    this.#hangUpNoEarlierThan(Date.now() + REPLY_START_MS + speakingMs(this.lastSpoken));
  }

  #hangUpNoEarlierThan(at) {
    const when = Math.min(at, this.goodbyeDeadline ?? at);
    if (this.hangUpAt != null && when <= this.hangUpAt) return;
    this.hangUpAt = when;
    clearTimeout(this.hangUpTimer);
    this.hangUpTimer = setTimeout(() => this.stop(), Math.max(0, when - Date.now()));
  }

  handleAcsMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.kind === "AudioMetadata") {
      log("acs audio metadata", JSON.stringify(msg.audioMetadata));
      return;
    }
    if (msg.kind === "AudioData" && msg.audioData?.data && !msg.audioData.silent) {
      this.voice?.writeCallerAudio(msg.audioData.data);
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.hangUpTimer);
    this.flow.unregisterAgent(this.callId);
    this.voice?.close();
    try {
      this.acs.close();
    } catch {
      // Already closed.
    }
    // A transferred call belongs to Teams now, so it is not ours to hang up.
    const call = this.flow.get(this.callId);
    if (call && call.state !== STATES.TRANSFERRED) hangUp(call.callConnectionId);
  }
}

/** @type {Map<string, CallBridge>} */
export const activeBridges = new Map();

/**
 * Returns the server so the caller can route upgrades to it. Deliberately
 * `noServer`: two WebSocketServers on one HTTP server both receive every
 * upgrade, and `ws` aborts the handshake for any path a server does not own, so
 * whichever is registered first breaks the other's connections.
 */
export function attachMediaBridge(flow, path = "/ws/media") {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", async (socket, req) => {
    const callId = new URL(req.url, "http://localhost").searchParams.get("call");
    if (!callId || !flow.get(callId)) {
      log("rejecting media socket with unknown call", callId);
      return socket.close();
    }

    log("media socket connected for call", callId);
    const bridge = new CallBridge({ callId, acsSocket: socket, flow });
    activeBridges.set(callId, bridge);

    socket.on("message", (raw) => bridge.handleAcsMessage(raw));
    socket.on("close", () => {
      log("media socket closed for call", callId);
      clearTimeout(bridge.hangUpTimer);
      bridge.voice?.close();
      flow.unregisterAgent(callId);
      activeBridges.delete(callId);
    });
    socket.on("error", (e) => log("media socket error", e.message));

    try {
      await bridge.start();
    } catch (e) {
      log("failed to start the Voice Live session:", e.message);
      socket.close();
    }
  });

  log(`ACS media bridge listening on ${path}`);
  return wss;
}
