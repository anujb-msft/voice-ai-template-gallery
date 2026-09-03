import { WebSocketServer } from "ws";
import { VoiceLiveSession, buildInstructions } from "./voice-live.mjs";
import { hangUp } from "./acs.mjs";

const log = (...a) => console.log(new Date().toISOString(), "[bridge]", ...a);

/**
 * Bridges one ACS call to one Voice Live session and wires both into the routing
 * flow.
 *
 *   PSTN caller
 *      ⇅  ACS bidirectional media streaming (WebSocket, PCM16 24 kHz mono)
 *   this process
 *      ⇅  Voice Live (WebSocket, PCM16 24 kHz mono — forwarded verbatim)
 *   gpt-realtime
 *
 * The bridge translates tool calls into flow methods and nothing else. It makes
 * no routing decisions of its own, which is why the flow can be tested without
 * it.
 */
class CallBridge {
  constructor({ callId, acsSocket, flow }) {
    this.callId = callId;
    this.acs = acsSocket;
    this.flow = flow;
  }

  async start() {
    this.voice = new VoiceLiveSession({
      instructions: buildInstructions(this.flow.routes),
      onAgentAudio: (base64Pcm) => this.#toCaller(base64Pcm),
      onEvent: (e) => this.#onVoiceEvent(e),
      onToolCall: (name, args) => this.#onToolCall(name, args),
    });

    await this.voice.connect();

    this.flow.registerAgent(this.callId, {
      instruct: (text) => this.voice.instruct(text),
      nudge: (text, opts) => this.voice.nudge(text, opts),
    });

    // Moving into the greeting is what makes the agent speak first.
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
        // Barge-in: flush whatever ACS still has buffered so the agent stops instantly.
        this.#stopCallerPlayback();
        this.voice.cancelResponse();
        break;
      case "user_transcript":
        this.flow.pushTranscript(this.callId, "caller", e.text);
        break;
      case "agent_transcript":
        this.flow.pushTranscript(this.callId, "agent", e.text);
        break;
      case "error":
        log("voice error", JSON.stringify(e.error));
        break;
    }
  }

  async #onToolCall(name, args) {
    const result = await this.#invokeTool(name, args);
    this.flow.recordAgentAction(this.callId, {
      tool: name,
      ok: !result?.error && result?.ok !== false,
      detail: result?.error ?? result?.reason ?? null,
    });
    return result;
  }

  async #invokeTool(name, args) {
    switch (name) {
      case "propose_route":
        return this.flow.proposeRoute(this.callId, args);
      case "confirm_route":
        return this.flow.confirmRoute(this.callId, args.routeId);
      case "request_human":
        return this.flow.requestHuman(this.callId, args.reason ?? "agent_requested");
      case "not_covered":
        return this.flow.outOfScope(this.callId, args.question);
      case "take_message":
        return this.flow.takeMessage(this.callId, args);
      case "end_call":
        setTimeout(() => this.stop(), 4000); // let the closing line finish playing
        this.flow.endCall(this.callId, "agent_ended");
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
    this.flow.unregisterAgent(this.callId);
    this.voice?.close();
    try {
      this.acs.close();
    } catch {}
    hangUp(this.flow.get(this.callId)?.callConnectionId);
  }
}

/** @type {Map<string, CallBridge>} */
export const activeBridges = new Map();

/**
 * Returns the server so the caller can route upgrades to it. Deliberately
 * `noServer`: two WebSocketServers sharing one HTTP server both receive every
 * upgrade event, and `ws` aborts the handshake — destroying the socket — for any
 * path a given server does not own. Whichever is registered first therefore
 * kills the other's connections. That is not a hypothetical: it silently broke
 * every media stream, because the presenter hub was attached first.
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
      bridge.voice?.close();
      flow.unregisterAgent(callId);
      activeBridges.delete(callId);
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
