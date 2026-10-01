import { WebSocketServer } from "ws";
import { VoiceLiveSession, buildInstructions } from "./voice-live.mjs";
import { hangUp } from "./acs.mjs";
import { config } from "../config.mjs";

const log = (...a) => console.log(new Date().toISOString(), "[bridge]", ...a);

class CallBridge {
  constructor({ callId, acsSocket, flow }) { this.callId = callId; this.acs = acsSocket; this.flow = flow; }
  async start() {
    this.voice = new VoiceLiveSession({
      instructions: buildInstructions(this.flow.priceBook, config.locale),
      onAgentAudio: (base64Pcm) => this.#toCaller(base64Pcm),
      onEvent: (e) => this.#onVoiceEvent(e),
      onToolCall: (name, args) => this.#onToolCall(name, args),
    });
    await this.voice.connect();
    this.flow.registerAgent(this.callId, { instruct: (text) => this.voice.instruct(text), nudge: (text, opts) => this.voice.nudge(text, opts) });
    this.flow.answered(this.callId);
  }
  #toCaller(base64Pcm) { if (this.acs.readyState === this.acs.OPEN) this.acs.send(JSON.stringify({ kind: "AudioData", audioData: { data: base64Pcm } })); }
  #stopCallerPlayback() { if (this.acs.readyState === this.acs.OPEN) this.acs.send(JSON.stringify({ kind: "StopAudio", stopAudio: {} })); }
  #onVoiceEvent(e) {
    switch (e.kind) {
      case "user_speech_started": this.#stopCallerPlayback(); this.voice.cancelResponse(); break;
      case "user_transcript": this.flow.pushTranscript(this.callId, "caller", e.text); break;
      case "agent_transcript": break;
      case "error": log("voice error", JSON.stringify(e.error)); break;
    }
  }
  async #onToolCall(name, args) {
    const result = await this.#invokeTool(name, args);
    this.flow.recordAgentAction(this.callId, { tool: name, ok: !result?.error && result?.ok !== false, detail: result?.error ?? result?.reason ?? null });
    return result;
  }
  async #invokeTool(name, args) {
    switch (name) {
      case "get_bid": return this.flow.getBid(this.callId, args);
      case "list_bids": return this.flow.listBids(this.callId, args);
      case "transfer_to_merchandiser": return this.flow.transferToMerchandiser(this.callId, args);
      case "repeat_last": return this.flow.repeatLast(this.callId);
      case "end_call": setTimeout(() => this.stop(), 4000); return this.flow.endCall(this.callId, args.reason ?? "agent_ended");
      default: return { error: `Unknown tool ${name}` };
    }
  }
  handleAcsMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.kind === "AudioMetadata") return log("acs audio metadata", JSON.stringify(msg.audioMetadata));
    if (msg.kind === "AudioData" && msg.audioData?.data && !msg.audioData.silent) this.voice?.writeCallerAudio(msg.audioData.data);
  }
  stop() { this.flow.unregisterAgent(this.callId); this.voice?.close(); try { this.acs.close(); } catch {} hangUp(this.flow.get(this.callId)?.callConnectionId); }
}

export const activeBridges = new Map();

export function attachMediaBridge(flow, path = "/ws/media") {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", async (socket, req) => {
    const callId = new URL(req.url, "http://localhost").searchParams.get("call");
    if (!callId || !flow.get(callId)) return socket.close();
    log("media socket connected for call", callId);
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
