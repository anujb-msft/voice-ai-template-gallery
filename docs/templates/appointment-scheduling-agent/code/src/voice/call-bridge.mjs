import { WebSocketServer } from "ws";
import { VoiceLiveSession, buildInstructions } from "./voice-live.mjs";
import { hangUp } from "./acs.mjs";
import { config } from "../config.mjs";
import { TERMINAL, STATES } from "../flow.mjs";
import { dispatchTool } from "../tools.mjs";

const log = (...a) => console.log(new Date().toISOString(), "[bridge]", ...a);

// The flow hands over a closing line (the booking read-back, a callback filed,
// advice on who to call, a transfer that could not go through) just before it
// moves the call to an end state. The bridge hangs up once that line has played:
// time for the reply to start, plus about 65 ms a character of speech, and never
// more than 25 s. A booking read-back with its confirmation number runs close to
// 20 s. A call on its way to a person, or already with one, is never hung up here.
const REPLY_START_MS = 2_500;
const MS_PER_CHAR = 65;
const MAX_GOODBYE_MS = 25_000;
/** After end_call: time for the model's own goodbye. */
const END_CALL_GRACE_MS = 3_500;
const speakingMs = (text) => 1_500 + String(text ?? "").length * MS_PER_CHAR;
const HANDED_OFF = new Set([STATES.ESCALATING, STATES.TRANSFERRED]);

/**
 * Bridges one ACS call to one Voice Live session and wires both into the
 * scheduling flow.
 *
 *   PSTN or Teams caller
 *      ⇅  ACS bidirectional media streaming (WebSocket, PCM16 24 kHz mono)
 *   this process
 *      ⇅  Voice Live (WebSocket, PCM16 24 kHz mono, forwarded verbatim)
 *   gpt-realtime
 *
 * The bridge makes no scheduling decisions. Every caller line goes through the
 * server gate (flow.callerSaid) first, which is where the caller's own yes to
 * the active proposal is heard and the only place a booking is written. Tool
 * calls go through src/tools.mjs, which has no booking tool and refuses one by
 * name. That is why the flow can be tested without this file.
 */
class CallBridge {
  constructor({ callId, acsSocket, flow }) {
    this.callId = callId;
    this.acs = acsSocket;
    this.flow = flow;
    this.toolDepth = 0;
    this.hangUpAt = null;
    this.hangUpTimer = null;
    this.goodbyeDeadline = null;
    this.stopped = false;
  }

  async start() {
    const call = this.flow.get(this.callId);
    this.voice = new VoiceLiveSession({
      instructions: buildInstructions({ locale: config.locale, handoff: call?.inbound ?? null }),
      onAgentAudio: (base64Pcm) => this.#toCaller(base64Pcm),
      onEvent: (e) => this.#onVoiceEvent(e),
      onToolCall: (name, args) => this.#onToolCall(name, args),
    });

    await this.voice.connect();

    this.flow.registerAgent(this.callId, {
      instruct: (text, spoken, { interrupt = false } = {}) => {
        // The server took the caller's turn (their yes, their no, a safety
        // word): cut off whatever the model had started to say first. Never
        // mid-tool, where the response carries the function call itself.
        if (interrupt && this.toolDepth === 0) {
          this.#stopCallerPlayback();
          this.voice.cancelResponse();
        }
        this.voice.instruct(text);
        // A closing line is handed over just before the flow moves the call to its end state.
        queueMicrotask(() => this.#hangUpIfClosed(spoken ?? text));
      },
      nudge: (text) => this.voice.nudge(text, { speak: false }),
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
        this.#callerSaid(e.text);
        break;
      case "agent_transcript":
        this.flow.pushTranscript(this.callId, "agent", e.text);
        // A closing line that is still being spoken pushes the hang-up back.
        if (this.hangUpAt != null) this.#hangUpNoEarlierThan(Date.now() + speakingMs(e.text));
        break;
      case "error":
        log("voice error", JSON.stringify(e.error));
        break;
    }
  }

  /**
   * The caller's own words, as transcribed. The gate runs before the model
   * acts on them: if the line answers the active proposal, the server writes
   * (or refuses) and supplies the next line itself.
   */
  #callerSaid(text) {
    if (!String(text ?? "").trim()) return;
    this.flow.pushTranscript(this.callId, "caller", text);
    try {
      this.flow.callerSaid(this.callId, text, "speech");
    } catch (e) {
      log("gate error", e.message);
    }
  }

  async #onToolCall(name, args) {
    this.toolDepth += 1;
    let result;
    try {
      result = await dispatchTool(this.flow, this.callId, name, args);
    } catch (e) {
      // The exception stays in the server log; the model and the console get a fixed reason.
      log("tool error", name, e.message);
      result = { ok: false, error: "tool_failed" };
    } finally {
      this.toolDepth -= 1;
    }
    this.flow.recordAgentAction(this.callId, {
      tool: name,
      ok: !result?.error && result?.ok !== false,
      detail: result?.reason ?? result?.error ?? null,
    });
    // Time for the model's goodbye; a closing line still playing keeps its later
    // hang-up. A refused end_call (the call is on its way to a person) changes nothing.
    if (name === "end_call" && result?.ok !== false) {
      this.goodbyeDeadline ??= Date.now() + MAX_GOODBYE_MS;
      this.#hangUpNoEarlierThan(Date.now() + END_CALL_GRACE_MS);
    }
    return result;
  }

  /**
   * The flow writes the outcome right after it hands over the closing line. If
   * that left the call finished (booked, a callback filed, advice given, a
   * transfer that could not go through), hang up once the line has played,
   * whether or not the model calls end_call. A call handed to a person is left
   * alone: Teams has it, and the media socket closes on its own.
   */
  #hangUpIfClosed(closingLine) {
    const state = this.flow.get(this.callId)?.state;
    if (this.stopped || !TERMINAL.has(state) || HANDED_OFF.has(state)) return;
    this.goodbyeDeadline ??= Date.now() + MAX_GOODBYE_MS;
    this.#hangUpNoEarlierThan(Date.now() + REPLY_START_MS + speakingMs(closingLine));
  }

  /** Only ever moves the hang-up later, and never past the goodbye deadline. */
  #hangUpNoEarlierThan(at) {
    const when = Math.min(at, this.goodbyeDeadline ?? at);
    if (this.hangUpAt != null && when <= this.hangUpAt) return;
    this.hangUpAt = when;
    clearTimeout(this.hangUpTimer);
    this.hangUpTimer = setTimeout(() => this.stop(), Math.max(0, when - Date.now()));
    this.hangUpTimer.unref?.();
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
    } catch {}
    // A call handed to a person belongs to Teams now, so it is not ours to hang up.
    const call = this.flow.get(this.callId);
    if (call && !HANDED_OFF.has(call.state)) hangUp(call.callConnectionId);
  }
}

/** @type {Map<string, CallBridge>} */
export const activeBridges = new Map();

/**
 * Returns the server so the caller can route upgrades to it. Deliberately
 * `noServer`: two WebSocketServers sharing one HTTP server both receive every
 * upgrade event, and `ws` aborts the handshake (destroying the socket) for any
 * path a given server does not own, so whichever is registered first kills the
 * other's connections. server.mjs owns the single upgrade listener.
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
      bridge.stopped = true;
      clearTimeout(bridge.hangUpTimer);
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
