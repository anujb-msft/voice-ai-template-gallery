import { WebSocketServer } from "ws";
import { VoiceLiveSession, buildInstructions } from "./voice-live.mjs";
import { hangUp } from "./acs.mjs";
import { STATES, callLocale, isTerminal } from "../flow.mjs";

// When the flow ends a call, the agent still has to say the closing line. The
// bridge hangs up once that line has played: time for the reply to start, plus
// about 65 ms a character of speech, and never more than 25 s. A call the flow
// ends without a word (an early voicemail leaves no message) ends at once.
const REPLY_START_MS = 2500;
const MS_PER_CHAR = 65;
const MAX_GOODBYE_MS = 25000;
const SILENT_END_MS = 500;
const speakingMs = (text) => 1500 + String(text ?? "").length * MS_PER_CHAR;

/**
 * One live call: ACS media on one side, a Voice Live session on the other.
 * The model talks; the flow decides. Every tool the model calls lands on a flow
 * method, and the flow's server-owned lines reach the model as instructions.
 */
class CallBridge {
  constructor({ callId, acsSocket, flow }) {
    this.callId = callId;
    this.acs = acsSocket;
    this.flow = flow;
    this.hangUpAt = null;
    this.hangUpTimer = null;
    this.goodbyeDeadline = null;
    this.stopped = false;
  }

  async start() {
    const call = this.flow.get(this.callId);
    this.voice = new VoiceLiveSession({
      instructions: buildInstructions(null, callLocale(call)),
      language: call?.language ?? "en",
      onAgentAudio: (b) => this.#toCaller(b),
      onEvent: (e) => this.#onVoiceEvent(e),
      onToolCall: (name, args) => this.#onToolCall(name, args),
    });
    await this.voice.connect();
    this.flow.registerAgent(this.callId, {
      instruct: (text) => {
        this.voice.instruct(text);
        // A closing line is handed over just before the flow moves to its end state.
        queueMicrotask(() => this.#hangUpIfClosed(text));
      },
      nudge: (text, opts) => this.voice.nudge(text, opts),
    });
    this.flow.answered(this.callId);
  }

  /**
   * Confirmed, cancelled, voicemail, opted out, a transfer that failed: once the
   * flow has ended the call, hang up after the closing line has played, or at
   * once when there is no line to wait for. A call ACS is transferring is left alone.
   */
  #hangUpIfClosed(closingLine = null) {
    const state = this.flow.get(this.callId)?.state;
    if (this.stopped || !isTerminal(state) || state === STATES.TRANSFERRING) return;
    if (closingLine == null) {
      if (this.hangUpAt != null) return;
      // The deadline also stops the model's own reply from keeping the line open.
      this.goodbyeDeadline ??= Date.now() + SILENT_END_MS;
      this.#hangUpNoEarlierThan(this.goodbyeDeadline);
      return;
    }
    this.goodbyeDeadline ??= Date.now() + MAX_GOODBYE_MS;
    this.#hangUpNoEarlierThan(Date.now() + REPLY_START_MS + speakingMs(closingLine));
  }

  #hangUpNoEarlierThan(at) {
    const when = Math.min(at, this.goodbyeDeadline ?? at);
    if (this.hangUpAt != null && when <= this.hangUpAt) return;
    this.hangUpAt = when;
    clearTimeout(this.hangUpTimer);
    this.hangUpTimer = setTimeout(() => this.stop(), Math.max(0, when - Date.now()));
  }

  #toCaller(base64Pcm) {
    if (this.acs.readyState === this.acs.OPEN) this.acs.send(JSON.stringify({ kind: "AudioData", audioData: { data: base64Pcm } }));
  }

  #stopCallerPlayback() {
    if (this.acs.readyState === this.acs.OPEN) this.acs.send(JSON.stringify({ kind: "StopAudio", stopAudio: {} }));
  }

  #onVoiceEvent(e) {
    if (e.kind === "user_speech_started") {
      this.#stopCallerPlayback();
      this.voice.cancelResponse();
      return;
    }
    if (e.kind === "agent_transcript") {
      this.flow.pushTranscript(this.callId, "agent", e.text);
      // A closing line that is still being spoken pushes the hang-up back.
      if (this.hangUpAt != null) this.#hangUpNoEarlierThan(Date.now() + speakingMs(e.text));
      return;
    }
    if (e.kind !== "user_transcript") return;
    this.flow.pushTranscript(this.callId, "caller", e.text);
    const state = this.flow.get(this.callId)?.state;
    if (!state || isTerminal(state)) return;
    // On an outbound call the first words decide person or voicemail; the greeting is the signal.
    if (state === STATES.DETECTING) {
      this.flow.applyDialOutcome(this.callId, "answered", { greetingText: e.text });
      // Queued after any closing line, so only a call that ended silently hangs up at once.
      queueMicrotask(() => this.#hangUpIfClosed());
      return;
    }
    // Emergencies and opt-outs are caught by the server on every turn, whatever the model does.
    if (!this.flow.screen(this.callId, e.text)) this.flow.checkBudget(this.callId);
  }

  async #onToolCall(name, args) {
    const r = await this.#invokeTool(name, args ?? {});
    this.flow.recordAgentAction(this.callId, { tool: name, ok: !r?.error && r?.ok !== false, detail: r?.reason ?? r?.error ?? null });
    return r;
  }

  async #invokeTool(name, args) {
    switch (name) {
      case "confirm_identity": return this.flow.confirmIdentity(this.callId, args);
      case "check_dob": return this.flow.checkDob(this.callId, args);
      case "get_appointment_summary": return this.flow.presentAppointment(this.callId);
      case "confirm_appointment": return this.flow.confirmAppointment(this.callId, args);
      case "propose_cancel": return this.flow.proposeCancel(this.callId, args);
      case "cancel_appointment": return this.flow.cancelAppointment(this.callId, args);
      case "request_reschedule": return this.flow.requestReschedule(this.callId, args);
      case "opt_out": return this.flow.optOut(this.callId);
      case "nurse_line": return this.flow.nurseLine(this.callId, { connect: args.connect === true });
      case "repeat_last": return this.flow.repeatLast(this.callId);
      case "end_call":
        // Hanging up now would drop the patient on the way to the queue.
        if (this.flow.get(this.callId)?.state === STATES.TRANSFERRING) return { ok: false, reason: "transfer_in_progress" };
        // Time for a goodbye; a closing line that is still playing keeps its later hang-up.
        this.goodbyeDeadline ??= Date.now() + MAX_GOODBYE_MS;
        this.#hangUpNoEarlierThan(Date.now() + 3500);
        return this.flow.endCall(this.callId, args.reason ?? "agent_ended");
      default: return { error: `Unknown tool ${name}` };
    }
  }

  handleAcsMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.kind === "AudioData" && msg.audioData?.data && !msg.audioData.silent) this.voice?.writeCallerAudio(msg.audioData.data);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.hangUpTimer);
    this.flow.unregisterAgent(this.callId);
    this.voice?.close();
    try { this.acs.close(); } catch {}
    // A call ACS is transferring belongs to the queue now, so it is not ours to hang up.
    const call = this.flow.get(this.callId);
    if (call && call.state !== STATES.TRANSFERRING) hangUp(call.callConnectionId);
  }
}

export const activeBridges = new Map();

/** ACS media streaming connects here. noServer: the server routes upgrades by pathname. */
export function attachMediaBridge(flow) {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", async (socket, req) => {
    const callId = new URL(req.url, "http://localhost").searchParams.get("call");
    if (!callId || !flow.get(callId)) return socket.close();
    const bridge = new CallBridge({ callId, acsSocket: socket, flow });
    activeBridges.set(callId, bridge);
    socket.on("message", (raw) => bridge.handleAcsMessage(raw));
    socket.on("close", () => {
      bridge.voice?.close();
      flow.unregisterAgent(callId);
      activeBridges.delete(callId);
    });
    try { await bridge.start(); } catch { socket.close(); }
  });
  return wss;
}
