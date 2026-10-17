import { WebSocketServer } from "ws";
import { VoiceLiveSession, buildInstructions } from "./voice-live.mjs";
import { hangUp } from "./acs.mjs";
import { config } from "../config.mjs";
import { STATES } from "../flow.mjs";

const log = (...a) => console.log(new Date().toISOString(), "[bridge]", ...a);

// When the flow ends a call (an unknown caller, the call-time cap, a transfer
// that failed), the agent still has to say the closing line. The bridge hangs up
// once that line has played: time for the reply to start, plus about 65 ms a
// character of speech, and never more than 25 s. A call on its way to a person,
// or already with one, is never hung up from here.
const REPLY_START_MS = 2500;
const MS_PER_CHAR = 65;
const MAX_GOODBYE_MS = 25000;
const speakingMs = (text) => 1500 + String(text ?? "").length * MS_PER_CHAR;
const CLOSED = new Set([STATES.REFUSED, STATES.ENDED]);
const HANDED_OFF = new Set([STATES.TRANSFERRING, STATES.TRANSFERRED]);

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
    this.voice = new VoiceLiveSession({
      instructions: buildInstructions(null, config.locale),
      onAgentAudio: (base64Pcm) => this.#toCaller(base64Pcm),
      onEvent: (e) => this.#onVoiceEvent(e),
      onToolCall: (name, args) => this.#onToolCall(name, args),
    });
    await this.voice.connect();
    // live: the bridge transcribes the agent itself. While a tool runs, its result carries the phrase,
    // so a server line is not voiced twice; outside a tool (the undo window closing) it is said once.
    this.flow.registerAgent(this.callId, {
      live: true,
      instruct: (text) => {
        if (!this.inTool) this.voice.nudge(`Say this to the rep now, as written: "${text}"`);
        // A closing line is handed over just before the flow moves to its end state.
        queueMicrotask(() => this.#hangUpIfClosed(text));
      },
      nudge: (text, opts) => this.voice.nudge(text, opts),
    });
    this.flow.answer(this.callId);
  }

  /** Once the flow has refused or ended the call, hang up after the closing line has played. */
  #hangUpIfClosed(closingLine) {
    if (this.stopped || !CLOSED.has(this.flow.get(this.callId)?.state)) return;
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
  #stopCallerPlayback() { if (this.acs.readyState === this.acs.OPEN) this.acs.send(JSON.stringify({ kind: "StopAudio", stopAudio: {} })); }
  #onVoiceEvent(e) {
    if (e.kind === "user_speech_started") { this.#stopCallerPlayback(); this.voice.cancelResponse(); }
    else if (e.kind === "user_transcript") this.flow.pushTranscript(this.callId, "caller", e.text);
    else if (e.kind === "agent_transcript") {
      this.flow.pushTranscript(this.callId, "agent", e.text);
      // A closing line that is still being spoken pushes the hang-up back.
      if (this.hangUpAt != null) this.#hangUpNoEarlierThan(Date.now() + speakingMs(e.text));
    } else if (e.kind === "error") log("voice error", JSON.stringify(e.error));
  }
  async #onToolCall(name, args) {
    this.inTool = true;
    let result;
    try {
      result = this.#invokeTool(name, args ?? {});
    } catch (e) {
      result = { error: e.message };
    } finally {
      this.inTool = false;
    }
    if (typeof result?.then === "function") {
      // A transfer settles once ACS has the call; the agent says its line now, not afterwards.
      result.catch((e) => log("transfer failed", e.message));
      result = { ok: true, transferring: true, phrase: this.flow.get(this.callId)?.lastPhrase ?? null };
    }
    this.flow.recordAgentAction(this.callId, { tool: name, ok: !result?.error && result?.ok !== false, detail: result?.error ?? result?.reason ?? null });
    return result;
  }
  #invokeTool(name, args) {
    switch (name) {
      case "find_account": return this.flow.findAccount(this.callId, args.utterance);
      case "select_account": return this.flow.selectAccount(this.callId, args.accountId);
      case "get_briefing": return this.flow.getBriefing(this.callId, args.accountId);
      case "get_detail": return this.flow.getDetail(this.callId, args.handle);
      case "get_contact_info": return this.flow.getContactInfo(this.callId, args.contactId, args.field);
      case "propose_update": return this.flow.proposeUpdate(this.callId, args.accountId, args.dictation);
      case "amend_proposal": return this.flow.amendProposal(this.callId, args.proposalId, args.change);
      case "commit_proposal": return this.flow.commitProposal(this.callId, args.proposalId, args.confirmation);
      case "cancel_pending_commit": return this.flow.cancelPendingCommit(this.callId, "caller_changed_mind");
      case "undo_last_commit": return this.flow.undoLastCommit(this.callId);
      case "save_draft": return this.flow.saveDraft(this.callId, args.proposalId, "agent_requested");
      case "resume_draft": return this.flow.resumeDraft(this.callId);
      case "pause": return this.flow.pause(this.callId);
      // The model's free-text reason is not trusted into the handoff; the flow knows why.
      case "transfer": return this.flow.transfer(this.callId, "explicit_request");
      case "repeat_last": return this.flow.repeatLast(this.callId);
      case "end_call":
        // Hanging up now would drop the rep on the way to a person.
        if (HANDED_OFF.has(this.flow.get(this.callId)?.state)) return { ok: false, reason: "transfer_in_progress" };
        // Time for a goodbye; a closing line that is still playing keeps its later hang-up.
        this.goodbyeDeadline ??= Date.now() + MAX_GOODBYE_MS;
        this.#hangUpNoEarlierThan(Date.now() + 3500);
        return this.flow.endCall(this.callId, "agent_ended");
      default: return { error: `Unknown tool ${name}` };
    }
  }
  handleAcsMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.kind === "AudioMetadata") return log("acs audio metadata", JSON.stringify(msg.audioMetadata));
    if (msg.kind === "AudioData" && msg.audioData?.data && !msg.audioData.silent) this.voice?.writeCallerAudio(msg.audioData.data);
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.hangUpTimer);
    this.flow.unregisterAgent(this.callId);
    this.voice?.close();
    try { this.acs.close(); } catch {}
    // A call handed to a person belongs to Teams now, so it is not ours to hang up.
    const call = this.flow.get(this.callId);
    if (call && !HANDED_OFF.has(call.state)) hangUp(call.callConnectionId);
  }
}

export const activeBridges = new Map();

export function attachMediaBridge(flow, path = "/ws/media") {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", async (socket, req) => {
    const callId = new URL(req.url, "http://localhost").searchParams.get("call");
    if (!callId || !flow.get(callId)) return socket.close();
    const bridge = new CallBridge({ callId, acsSocket: socket, flow });
    activeBridges.set(callId, bridge);
    socket.on("message", (raw) => bridge.handleAcsMessage(raw));
    socket.on("close", () => { bridge.voice?.close(); flow.unregisterAgent(callId); activeBridges.delete(callId); });
    socket.on("error", (e) => log("media socket error", e.message));
    try { await bridge.start(); } catch (e) { log("failed to start Voice Live session:", e.message); socket.close(); }
  });
  log(`ACS media bridge listening on ${path}`);
  return wss;
}
