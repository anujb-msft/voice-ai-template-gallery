import { WebSocketServer } from "ws";
import { VoiceLiveSession, buildInstructions } from "./voice-live.mjs";
import { config } from "../config.mjs";
import { PAGE_TOOLS, INTAKE_TOOLS } from "../agent.mjs";
import { hangUp } from "./acs.mjs";

const log = (...a) => console.log(new Date().toISOString(), "[bridge]", ...a);

class CallBridge {
  constructor({ callId, leg, acsSocket, flow }) { this.callId = callId; this.leg = leg; this.acs = acsSocket; this.flow = flow; }
  async start() {
    this.voice = new VoiceLiveSession({ instructions: buildInstructions(this.flow.policy, config.locale, this.leg === "page" ? "page" : "intake"), tools: this.leg === "page" ? PAGE_TOOLS : INTAKE_TOOLS, onAgentAudio: (pcm) => this.#toCaller(pcm), onEvent: (e) => this.#onVoiceEvent(e), onToolCall: (name, args) => this.#onToolCall(name, args) });
    await this.voice.connect();
    if (this.leg === "intake") this.flow.answered(this.callId);
  }
  #toCaller(base64Pcm) { if (this.acs.readyState === this.acs.OPEN) this.acs.send(JSON.stringify({ kind: "AudioData", audioData: { data: base64Pcm } })); }
  #stopCallerPlayback() { if (this.acs.readyState === this.acs.OPEN) this.acs.send(JSON.stringify({ kind: "StopAudio", stopAudio: {} })); }
  #onVoiceEvent(e) { if (e.kind === "user_speech_started") { this.#stopCallerPlayback(); this.voice.cancelResponse(); } }
  async #onToolCall(name, args) {
    if (this.leg === "intake") {
      if (name === "identify_unit") return this.flow.identifyUnit(this.callId, args);
      if (name === "record_issue") return this.flow.recordIssue(this.callId, args);
      if (name === "classify_and_submit") return this.flow.classifyAndSubmit(this.callId);
      if (name === "end_call") return { ending: true };
    } else {
      if (name === "get_ticket_detail") return this.flow.getTicketDetail(this.callId, args.field);
      if (name === "acknowledge") return this.flow.acknowledge(this.callId);
      if (name === "decline") return this.flow.decline(this.callId, args.reason);
      if (name === "bridge_to_tenant") return this.flow.bridgeToTenant(this.callId);
      if (name === "repeat_brief") return this.flow.repeatBrief(this.callId);
    }
    return { error: `Unknown tool ${name}` };
  }
  handleAcsMessage(raw) { let msg; try { msg = JSON.parse(raw); } catch { return; } if (msg.kind === "AudioData" && msg.audioData?.data && !msg.audioData.silent) this.voice?.writeCallerAudio(msg.audioData.data); }
  stop() { this.voice?.close(); try { this.acs.close(); } catch {} hangUp(this.flow.snapshotIncident(this.callId)?.callConnectionId); }
}

export const activeBridges = new Map();
export function attachMediaBridge(flow, path = "/ws/media") {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", async (socket, req) => {
    const url = new URL(req.url, "http://localhost");
    const callId = url.searchParams.get("call");
    const leg = url.searchParams.get("leg") ?? "intake";
    if (!callId) return socket.close();
    const bridge = new CallBridge({ callId, leg, acsSocket: socket, flow });
    activeBridges.set(`${leg}:${callId}`, bridge);
    socket.on("message", (raw) => bridge.handleAcsMessage(raw));
    socket.on("close", () => { bridge.voice?.close(); activeBridges.delete(`${leg}:${callId}`); });
    socket.on("error", (e) => log("socket error", e.message));
    try { await bridge.start(); } catch (e) { log("failed", e.message); socket.close(); }
  });
  log(`ACS media bridge listening on ${path}`);
  return wss;
}
