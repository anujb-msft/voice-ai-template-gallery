import { WebSocketServer } from "ws";
import { VoiceLiveSession, buildInstructions } from "./voice-live.mjs";
import { hangUp } from "./acs.mjs";

class CallBridge {
  constructor({ callId, acsSocket, flow }) { this.callId = callId; this.acs = acsSocket; this.flow = flow; }
  async start() {
    const call = this.flow.get(this.callId);
    this.voice = new VoiceLiveSession({ instructions: buildInstructions(null, call?.appointment?.patient?.preferredLanguage === "es" ? "es-US" : "en-US"), onAgentAudio: (b) => this.#toCaller(b), onEvent: (e) => this.#onVoiceEvent(e), onToolCall: (name, args) => this.#onToolCall(name, args) });
    await this.voice.connect();
    this.flow.registerAgent(this.callId, { instruct: (text) => this.voice.instruct(text), nudge: (text, opts) => this.voice.nudge(text, opts) });
    this.flow.answered(this.callId);
  }
  #toCaller(base64Pcm) { if (this.acs.readyState === this.acs.OPEN) this.acs.send(JSON.stringify({ kind: "AudioData", audioData: { data: base64Pcm } })); }
  #stopCallerPlayback() { if (this.acs.readyState === this.acs.OPEN) this.acs.send(JSON.stringify({ kind: "StopAudio", stopAudio: {} })); }
  #onVoiceEvent(e) { if (e.kind === "user_speech_started") { this.#stopCallerPlayback(); this.voice.cancelResponse(); } else if (e.kind === "user_transcript") this.flow.pushTranscript(this.callId, "caller", e.text); else if (e.kind === "agent_transcript") this.flow.pushTranscript(this.callId, "agent", e.text); }
  async #onToolCall(name, args) { const r = await this.#invokeTool(name, args); this.flow.recordAgentAction(this.callId, { tool: name, ok: !r?.error && r?.ok !== false, detail: r?.reason ?? r?.error ?? null }); return r; }
  async #invokeTool(name, args) { switch (name) { case "confirm_identity": return this.flow.confirmIdentity(this.callId, args); case "check_dob": return this.flow.checkDob(this.callId, args); case "get_appointment_summary": return this.flow.presentAppointment(this.callId); case "confirm_appointment": return this.flow.confirmAppointment(this.callId, args); case "propose_cancel": return this.flow.proposeCancel(this.callId, args); case "cancel_appointment": return this.flow.cancelAppointment(this.callId, args); case "request_reschedule": return this.flow.requestReschedule(this.callId, args); case "opt_out": return this.flow.optOut(this.callId); case "nurse_line": return this.flow.nurseLine(this.callId); case "repeat_last": return this.flow.repeatLast(this.callId); case "end_call": setTimeout(() => this.stop(), 3500); return this.flow.endCall(this.callId, args.reason ?? "agent_ended"); default: return { error: `Unknown tool ${name}` }; } }
  handleAcsMessage(raw) { let msg; try { msg = JSON.parse(raw); } catch { return; } if (msg.kind === "AudioData" && msg.audioData?.data && !msg.audioData.silent) this.voice?.writeCallerAudio(msg.audioData.data); }
  stop() { this.flow.unregisterAgent(this.callId); this.voice?.close(); try { this.acs.close(); } catch {} hangUp(this.flow.get(this.callId)?.callConnectionId); }
}
export const activeBridges = new Map();
export function attachMediaBridge(flow, path = "/ws/media") {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", async (socket, req) => {
    const callId = new URL(req.url, "http://localhost").searchParams.get("call");
    if (!callId || !flow.get(callId)) return socket.close();
    const bridge = new CallBridge({ callId, acsSocket: socket, flow }); activeBridges.set(callId, bridge);
    socket.on("message", (raw) => bridge.handleAcsMessage(raw));
    socket.on("close", () => { bridge.voice?.close(); flow.unregisterAgent(callId); activeBridges.delete(callId); });
    try { await bridge.start(); } catch { socket.close(); }
  });
  return wss;
}
