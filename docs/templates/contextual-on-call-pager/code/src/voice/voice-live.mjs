import WebSocket from "ws";
import { config } from "../config.mjs";
import { AGENT_TOOLS, buildInstructions, localeLanguage } from "../agent.mjs";

export { AGENT_TOOLS, buildInstructions, localeLanguage };
const ENTRA_SCOPE = "https://ai.azure.com/.default";
const log = (...a) => console.log(new Date().toISOString(), "[voice-live]", ...a);
let credential;

async function authHeaders() {
  if (config.voiceLive.apiKey) return { "api-key": config.voiceLive.apiKey };
  if (!credential) {
    const { DefaultAzureCredential } = await import("@azure/identity");
    credential = new DefaultAzureCredential();
  }
  const token = await credential.getToken(ENTRA_SCOPE);
  if (!token?.token) throw new Error(`Could not acquire token for ${ENTRA_SCOPE}`);
  return { Authorization: `Bearer ${token.token}` };
}

export class VoiceLiveSession {
  constructor({ instructions, tools = AGENT_TOOLS, onAgentAudio, onEvent, onToolCall }) {
    this.baseInstructions = instructions;
    this.tools = tools;
    this.onAgentAudio = onAgentAudio ?? (() => {});
    this.onEvent = onEvent ?? (() => {});
    this.onToolCall = onToolCall ?? (async () => ({}));
    this.pending = [];
    this.closed = false;
    this.activeResponse = false;
    this.pendingResponse = false;
  }

  async connect() {
    const { endpoint, model, apiVersion, voice } = config.voiceLive;
    const language = localeLanguage(config.locale);
    const url = `${endpoint.replace(/^https:/, "wss:")}/voice-live/realtime?api-version=${encodeURIComponent(apiVersion)}&model=${encodeURIComponent(model)}`;
    this.ws = new WebSocket(url, { headers: await authHeaders() });
    await new Promise((resolve, reject) => {
      const fail = setTimeout(() => reject(new Error("Voice Live connect timeout")), 20_000);
      this.ws.on("open", () => {
        clearTimeout(fail);
        log(`connected ${model}`);
        this.#send({ type: "session.update", session: { instructions: this.baseInstructions, modalities: ["text", "audio"], input_audio_format: "pcm16", output_audio_format: "pcm16", voice: { name: voice, type: "azure-standard" }, tools: this.tools, tool_choice: "auto", input_audio_transcription: { model: "gpt-4o-transcribe", language: language.code }, turn_detection: { type: "azure_semantic_vad", threshold: 0.3, prefix_padding_ms: 200, silence_duration_ms: 400 }, input_audio_noise_reduction: { type: "azure_deep_noise_suppression" }, input_audio_echo_cancellation: { type: "server_echo_cancellation" } } });
        for (const frame of this.pending.splice(0)) this.#send(frame);
        resolve();
      });
      this.ws.on("error", (e) => { clearTimeout(fail); reject(e); });
    });
    this.ws.on("message", (raw) => this.#handle(raw));
    this.ws.on("close", (code) => { this.closed = true; log("closed", code); });
  }

  #send(obj) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); else this.pending.push(obj); }
  #requestResponse() { if (this.activeResponse) this.pendingResponse = true; else { this.activeResponse = true; this.#send({ type: "response.create" }); } }
  async #handle(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case "response.created": this.activeResponse = true; break;
      case "response.done":
      case "response.cancelled":
        this.activeResponse = false;
        if (this.pendingResponse) { this.pendingResponse = false; this.#requestResponse(); }
        break;
      case "response.audio.delta": this.onAgentAudio(msg.delta); break;
      case "input_audio_buffer.speech_started": this.onEvent({ kind: "user_speech_started" }); break;
      case "conversation.item.input_audio_transcription.completed": this.onEvent({ kind: "user_transcript", text: msg.transcript }); break;
      case "response.audio_transcript.done": this.onEvent({ kind: "agent_transcript", text: msg.transcript }); break;
      case "response.function_call_arguments.done": await this.#dispatchTool(msg); break;
      case "error": log("ERROR", JSON.stringify(msg.error)); this.onEvent({ kind: "error", error: msg.error }); break;
    }
  }
  async #dispatchTool(msg) {
    let args = {};
    try { args = msg.arguments ? JSON.parse(msg.arguments) : {}; } catch {}
    let result;
    try { result = await this.onToolCall(msg.name, args); } catch (e) { result = { error: e.message }; }
    this.#send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: msg.call_id, output: JSON.stringify(result ?? {}) } });
    this.#requestResponse();
  }
  instruct(text) { this.#send({ type: "session.update", session: { instructions: `${this.baseInstructions}\n\n${text}` } }); this.#requestResponse(); }
  nudge(text, { speak = true } = {}) { this.#send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } }); if (speak) this.#requestResponse(); }
  cancelResponse() { this.pendingResponse = false; if (!this.activeResponse) return; this.activeResponse = false; this.#send({ type: "response.cancel" }); }
  writeCallerAudio(base64Pcm) { this.#send({ type: "input_audio_buffer.append", audio: base64Pcm }); }
  close() { if (this.closed) return; this.closed = true; try { this.ws?.close(); } catch {} }
}
