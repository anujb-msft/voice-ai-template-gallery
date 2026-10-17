import { WebSocketServer } from "ws";
import { VoiceLiveSession } from "./voice-live.mjs";
import { hangUp } from "./acs.mjs";

const log = (...a) => console.log(new Date().toISOString(), "[bridge]", ...a);

const SENTIMENTS = { neutral: "Neutral", frustrated: "Frustrated", upset: "Upset" };

/**
 * Bridges one ACS call to one Voice Live session and wires both into the reset
 * flow, so the model, the phone call and the browser wizard stay in lockstep.
 *
 *   Employee's phone
 *      ⇅  Teams Phone extensibility / ACS bidirectional media streaming (WebSocket, PCM16 24 kHz mono)
 *   this process
 *      ⇅  Voice Live (WebSocket, PCM16 24 kHz mono — forwarded verbatim)
 *   gpt-realtime
 *
 * The model reaches the flow only through the tools in `agent.mjs`, each run
 * in the call's queue so a tool call can't interleave with a browser request.
 */
class CallBridge {
  constructor({ sessionId, acsSocket, flow }) {
    this.sessionId = sessionId;
    this.acs = acsSocket;
    this.flow = flow;
    this.stopped = false;
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
    await this.flow.run(this.sessionId, () => this.flow.answered(this.sessionId));
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
    const id = this.sessionId;
    try {
      switch (e.kind) {
        case "user_speech_started":
          // Barge-in: flush whatever ACS still has buffered so the agent stops instantly.
          this.#stopCallerPlayback();
          this.voice.cancelResponse();
          break;
        case "user_transcript":
          await this.flow.run(id, () => this.flow.pushTranscript(id, "caller", e.text));
          break;
        case "agent_transcript":
          await this.flow.run(id, () => this.flow.pushTranscript(id, "agent", e.text));
          break;
        case "error":
          log("voice error", e.error?.code ?? "", e.error?.message ?? "");
          break;
      }
    } catch (err) {
      log("event failed", e.kind, err.message);
    }
  }

  async #onToolCall(name, args) {
    const id = this.sessionId;
    // Shown before it runs, the same way the offline agent records it.
    await this.flow.recordAgentAction(id, { tool: name });
    const result = await this.#invokeTool(name, args ?? {});
    if (result?.error) await this.flow.recordAgentAction(id, { tool: name, ok: false, detail: result.error });
    return result;
  }

  #invokeTool(name, args) {
    const id = this.sessionId;
    const flow = this.flow;
    const queued = (fn) => flow.run(id, fn);
    switch (name) {
      case "confirm_identity":
        return queued(() => flow.confirmIdentity(id, String(args.digits ?? "")));
      case "issue_verification_code":
        return queued(() => flow.issueVerificationCode(id));
      case "refuse_request":
        return queued(() => flow.refuse(id, args.kind));
      case "request_human":
        return queued(() => flow.requestHuman(id, { sentiment: SENTIMENTS[args.sentiment] ?? null }));
      case "answer_question":
        return queued(() => flow.answerQuestion(id, String(args.question ?? "")));
      case "escalate":
        return queued(() => flow.escalate(id, String(args.reason ?? "agent_requested")));
      case "end_call":
        // Hanging up now would drop the caller on the way to the service desk.
        if (this.#handedOff()) return { ok: false, reason: "transfer_in_progress" };
        // Let the closing line finish playing first.
        setTimeout(() => this.stop("agent_ended"), 4000).unref?.();
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

  /** Escalated with a transfer configured, and the transfer hasn't failed: the call is on its way to a person. */
  #handedOff() {
    const s = this.flow.get(this.sessionId);
    return Boolean(s?.escalation && !s.transferFailedAt && this.flow.options.transfer);
  }

  async stop(reason = "ended") {
    if (this.stopped) return;
    this.stopped = true;
    const id = this.sessionId;
    const s = this.flow.get(id);
    const handedOff = this.#handedOff();
    if (s && !s.callEnded) await this.flow.run(id, () => this.flow.endCall(id, reason)).catch(() => {});
    this.flow.unregisterAgent(id);
    this.voice?.close();
    try {
      this.acs.close();
    } catch {}
    // A call handed to the service desk belongs to Teams now, so it is not ours to hang up.
    if (!handedOff) await hangUp(s?.callConnectionId);
  }
}

/** @type {Map<string, CallBridge>} */
export const activeBridges = new Map();

/**
 * Returns a `noServer` WebSocketServer; the server routes `/ws/media`
 * upgrades to it. Two WebSocketServers attached to one HTTP server abort each
 * other's handshakes, so every upgrade goes through one listener.
 */
export function attachMediaBridge(flow) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", async (socket, req) => {
    const sessionId = new URL(req.url, "http://localhost").searchParams.get("session");
    const session = sessionId ? flow.get(sessionId) : null;
    if (!session || session.simulated) {
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
      if (activeBridges.get(sessionId) === bridge) activeBridges.delete(sessionId);
    });
    socket.on("error", (e) => log("media socket error", e.message));

    try {
      await bridge.start();
    } catch (e) {
      log("failed to start Voice Live session:", e.message);
      socket.close();
    }
  });

  return wss;
}
