import { WebSocketServer } from "ws";
import { VoiceLiveSession } from "./voice-live.mjs";
import { hangUp } from "./acs.mjs";

const log = (...a) => console.log(new Date().toISOString(), "[bridge]", ...a);

/**
 * Bridges one ACS call to one Voice Live session and wires both into the reset
 * flow, so the model, the phone call and the browser wizard stay in lockstep.
 *
 *   PSTN caller
 *      ⇅  ACS bidirectional media streaming (WebSocket, PCM16 24 kHz mono)
 *   this process
 *      ⇅  Voice Live (WebSocket, PCM16 24 kHz mono — forwarded verbatim)
 *   gpt-realtime-2
 */
class CallBridge {
  constructor({ sessionId, acsSocket, flow }) {
    this.sessionId = sessionId;
    this.acs = acsSocket;
    this.flow = flow;
    this.callConnectionId = null;
  }

  async start() {
    this.voice = new VoiceLiveSession({
      onAgentAudio: (base64Pcm) => this.#toCaller(base64Pcm),
      onEvent: (e) => this.#onVoiceEvent(e),
      onToolCall: (name, args) => this.#onToolCall(name, args),
    });

    await this.voice.connect();

    this.flow.registerAgent(this.sessionId, {
      instruct: (text) => this.voice.instruct(text),
      nudge: (text, opts) => this.voice.nudge(text, opts),
    });

    // Entering the first real step is what makes the agent speak its greeting.
    await this.flow.transition(this.sessionId, "verify_identity");
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

  async #onVoiceEvent(e) {
    switch (e.kind) {
      case "user_speech_started":
        // Barge-in: flush whatever ACS still has buffered so the agent stops instantly.
        this.#stopCallerPlayback();
        this.voice.cancelResponse();
        break;
      case "user_transcript":
        await this.flow.pushTranscript(this.sessionId, "caller", e.text);
        break;
      case "agent_transcript":
        await this.flow.pushTranscript(this.sessionId, "agent", e.text);
        break;
      case "error":
        log("voice error", JSON.stringify(e.error));
        break;
    }
  }

  async #onToolCall(name, args) {
    const result = await this.#invokeTool(name, args);
    // Surface every tool the model reaches for, accepted or not.
    await this.flow.recordAgentAction(this.sessionId, {
      tool: name,
      ok: !result?.error && result?.ok !== false,
      detail: result?.error ?? result?.reason ?? null,
    });
    return result;
  }

  async #invokeTool(name, args) {
    switch (name) {
      case "confirm_identity":
        return this.flow.confirmIdentity(this.sessionId, args.digits);
      case "issue_verification_code":
        return this.flow.issueVerificationCode(this.sessionId);
      case "escalate":
        await this.flow.escalate(this.sessionId, args.reason ?? "agent_requested");
        return { escalated: true };
      case "end_call":
        setTimeout(() => this.stop(), 4000); // let the closing line finish playing
        return { ending: true };
      default:
        return { error: `Unknown tool ${name}` };
    }
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
    this.flow.unregisterAgent(this.sessionId);
    this.voice?.close();
    try {
      this.acs.close();
    } catch {}
    hangUp(this.callConnectionId);
  }
}

/** @type {Map<string, CallBridge>} */
export const activeBridges = new Map();

export function attachMediaBridge(httpServer, flow, path = "/ws/media") {
  const wss = new WebSocketServer({ server: httpServer, path });

  wss.on("connection", async (socket, req) => {
    const sessionId = new URL(req.url, "http://localhost").searchParams.get("session");
    if (!sessionId || !flow.get(sessionId)) {
      log("rejecting media socket with unknown session", sessionId);
      return socket.close();
    }

    log("media socket connected for session", sessionId);
    const bridge = new CallBridge({ sessionId, acsSocket: socket, flow });
    activeBridges.set(sessionId, bridge);

    socket.on("message", (raw) => bridge.handleAcsMessage(raw));
    socket.on("close", () => {
      log("media socket closed for session", sessionId);
      bridge.voice?.close();
      flow.unregisterAgent(sessionId);
      activeBridges.delete(sessionId);
    });
    socket.on("error", (e) => log("media socket error", e.message));

    try {
      await bridge.start();
    } catch (e) {
      log("failed to start Voice Live session:", e.message);
      socket.close();
    }
  });

  log(`ACS media bridge listening on ${path}`);
  return wss;
}
