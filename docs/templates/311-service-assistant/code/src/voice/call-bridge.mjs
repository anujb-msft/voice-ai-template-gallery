import { WebSocketServer } from "ws";
import { VoiceLiveSession, buildInstructions } from "./voice-live.mjs";
import { hangUp } from "./acs.mjs";
import { config } from "../config.mjs";

const log = (...a) => console.log(new Date().toISOString(), "[bridge]", ...a);

class CallBridge {
  constructor({ callId, acsSocket, flow }) {
    this.callId = callId;
    this.acs = acsSocket;
    this.flow = flow;
  }

  async start() {
    this.voice = new VoiceLiveSession({
      instructions: buildInstructions(this.flow, config.locale),
      onAgentAudio: (base64Pcm) => this.#toCaller(base64Pcm),
      onEvent: (e) => this.#onVoiceEvent(e),
      onToolCall: (name, args) => this.#onToolCall(name, args),
    });
    await this.voice.connect();
    this.flow.registerAgent(this.callId, { instruct: (text) => this.voice.instruct(text), nudge: (text, opts) => this.voice.nudge(text, opts) });
    this.flow.answered(this.callId);
  }

  #toCaller(base64Pcm) {
    if (this.acs.readyState === this.acs.OPEN) this.acs.send(JSON.stringify({ kind: "AudioData", audioData: { data: base64Pcm } }));
  }
  #stopCallerPlayback() { if (this.acs.readyState === this.acs.OPEN) this.acs.send(JSON.stringify({ kind: "StopAudio", stopAudio: {} })); }

  #onVoiceEvent(e) {
    switch (e.kind) {
      case "user_speech_started":
        this.#stopCallerPlayback();
        this.voice.cancelResponse();
        break;
      case "user_transcript": {
        const result = this.flow.observeCaller(this.callId, e.text);
        if (result?.category) {
          this.voice.cancelResponse();
          this.voice.nudge(result.phrase, { speak: true });
        }
        break;
      }
      case "agent_transcript":
        this.flow.pushTranscript(this.callId, "agent", e.text);
        break;
      case "error":
        log("voice error", JSON.stringify(e.error));
        break;
    }
  }

  async #onToolCall(name, args) {
    let result;
    try { result = await this.#invokeTool(name, args); } catch (e) { result = { ok: false, error: e.message }; }
    return result;
  }

  async #invokeTool(name, args) {
    switch (name) {
      case "search_faq": return this.flow.searchFaq(this.callId, args.query);
      case "start_request": return this.flow.startRequest(this.callId, args.type);
      case "resolve_location": return this.flow.resolveLocation(this.callId, args.utterance);
      case "set_field": return this.flow.setField(this.callId, args.name, args.value);
      case "submit_request": return this.flow.submitRequest(this.callId);
      case "set_contact": return this.flow.setContact(this.callId, args);
      case "get_case_status": return this.flow.getCaseStatus(this.callId, args.caseNumber);
      case "bulk_pickup": return this.flow.bulkPickup(this.callId, args.items ?? []);
      case "confirm_bulk_pickup": return this.flow.confirmBulkPickup(this.callId, args.location);
      case "send_form_link": return this.flow.sendFormLink(this.callId, args.serviceId);
      case "transfer": return this.flow.transfer(this.callId, { reason: args.reason, departmentId: args.department ?? "311-live" });
      case "repeat_last": return this.flow.repeatLast(this.callId);
      case "end_call": setTimeout(() => this.stop(), 3000); return this.flow.endCall(this.callId, args.reason ?? "agent_ended");
      default: return { ok: false, error: `Unknown tool ${name}` };
    }
  }

  handleAcsMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.kind === "AudioMetadata") return log("acs audio metadata", JSON.stringify(msg.audioMetadata));
    if (msg.kind === "AudioData" && msg.audioData?.data && !msg.audioData.silent) this.voice?.writeCallerAudio(msg.audioData.data);
  }

  stop() {
    this.flow.unregisterAgent(this.callId);
    this.voice?.close();
    try { this.acs.close(); } catch {}
    hangUp(this.flow.get(this.callId)?.callConnectionId);
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
