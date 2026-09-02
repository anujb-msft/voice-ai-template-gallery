import WebSocket from "ws";
import { config } from "../config.mjs";
import { AGENT_TOOLS, buildInstructions } from "../agent.mjs";

export { AGENT_TOOLS, buildInstructions };

const log = (...a) => console.log(new Date().toISOString(), "[voice-live]", ...a);

const ENTRA_SCOPE = "https://ai.azure.com/.default";
let credential;

/**
 * Keyless auth is what Microsoft recommends, so it is the default here: set
 * VOICE_LIVE_API_KEY only if you cannot assign the two roles the README lists.
 * @azure/identity is imported lazily so this module stays loadable without it.
 */
async function authHeaders() {
  const { apiKey } = config.voiceLive;
  if (apiKey) return { "api-key": apiKey };

  if (!credential) {
    const { DefaultAzureCredential } = await import("@azure/identity");
    credential = new DefaultAzureCredential();
  }
  const token = await credential.getToken(ENTRA_SCOPE);
  if (!token?.token) throw new Error(`Could not acquire a token for ${ENTRA_SCOPE}`);
  return { Authorization: `Bearer ${token.token}` };
}

/**
 * One Voice Live session over the WebSocket transport.
 *
 * Audio is PCM16 mono 24 kHz in both directions, which is exactly what ACS
 * bidirectional media streaming emits and accepts (`audioFormat: "pcm24KMono"`),
 * so audio is forwarded verbatim — no transcoding, no resampling, no jitter buffer.
 */
export class VoiceLiveSession {
  constructor({ instructions, onAgentAudio, onEvent, onToolCall }) {
    this.baseInstructions = instructions;
    this.onAgentAudio = onAgentAudio;
    this.onEvent = onEvent ?? (() => {});
    this.onToolCall = onToolCall ?? (async () => ({}));
    this.closed = false;
    this.pending = [];
    this.activeResponse = false;
    this.pendingResponse = false;
  }

  async connect() {
    const { endpoint, model, apiVersion, voice } = config.voiceLive;
    const url =
      `${endpoint.replace(/^https:/, "wss:")}/voice-live/realtime` +
      `?api-version=${encodeURIComponent(apiVersion)}&model=${encodeURIComponent(model)}`;

    this.ws = new WebSocket(url, { headers: await authHeaders() });

    await new Promise((resolve, reject) => {
      const fail = setTimeout(() => reject(new Error("Voice Live connect timeout")), 20000);

      this.ws.on("open", () => {
        clearTimeout(fail);
        log(`connected (${model})`);
        this.#send({
          type: "session.update",
          session: {
            instructions: this.baseInstructions,
            modalities: ["text", "audio"],
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            voice: { name: voice, type: "azure-standard" },
            tools: AGENT_TOOLS,
            tool_choice: "auto",
            input_audio_transcription: { model: "whisper-1" },
            turn_detection: {
              type: "azure_semantic_vad",
              threshold: 0.3,
              prefix_padding_ms: 200,
              silence_duration_ms: 400,
            },
            input_audio_noise_reduction: { type: "azure_deep_noise_suppression" },
            input_audio_echo_cancellation: { type: "server_echo_cancellation" },
          },
        });
        for (const frame of this.pending.splice(0)) this.#send(frame);
        resolve();
      });

      this.ws.on("error", (e) => {
        clearTimeout(fail);
        reject(e);
      });
    });

    this.ws.on("message", (raw) => this.#handleEvent(raw));
    this.ws.on("close", (code) => {
      log("closed", code);
      this.closed = true;
    });
  }

  #send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
    else this.pending.push(obj);
  }

  /**
   * Voice Live allows exactly one in-flight response per conversation. A state
   * transition and a tool result can easily both want the agent to speak, so
   * requests are coalesced here instead of racing and erroring with
   * `conversation_already_has_active_response`.
   */
  #requestResponse() {
    if (this.activeResponse) this.pendingResponse = true;
    else {
      this.activeResponse = true;
      this.#send({ type: "response.create" });
    }
  }

  async #handleEvent(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "response.created":
        this.activeResponse = true;
        break;

      case "response.done":
      case "response.cancelled":
        this.activeResponse = false;
        if (this.pendingResponse) {
          this.pendingResponse = false;
          this.#requestResponse();
        }
        break;

      case "response.audio.delta":
        this.onAgentAudio(msg.delta);
        break;

      case "input_audio_buffer.speech_started":
        this.onEvent({ kind: "user_speech_started" });
        break;

      case "conversation.item.input_audio_transcription.completed":
        this.onEvent({ kind: "user_transcript", text: msg.transcript });
        break;

      case "response.audio_transcript.done":
        this.onEvent({ kind: "agent_transcript", text: msg.transcript });
        break;

      case "response.function_call_arguments.done":
        await this.#dispatchTool(msg);
        break;

      case "error":
        log("ERROR", JSON.stringify(msg.error));
        this.onEvent({ kind: "error", error: msg.error });
        break;
    }
  }

  async #dispatchTool(msg) {
    let args = {};
    try {
      args = msg.arguments ? JSON.parse(msg.arguments) : {};
    } catch {
      /* tolerate malformed tool args */
    }
    log("tool", msg.name, JSON.stringify(args));

    let result;
    try {
      result = await this.onToolCall(msg.name, args);
    } catch (e) {
      result = { error: e.message };
    }

    this.#send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: msg.call_id, output: JSON.stringify(result ?? {}) },
    });
    this.#requestResponse();
  }

  /** Replace the standing instructions for the current step, then let the agent speak. */
  instruct(text) {
    this.#send({ type: "session.update", session: { instructions: `${this.baseInstructions}\n\n${text}` } });
    this.#requestResponse();
  }

  /** Inject an out-of-band fact mid-call without necessarily prompting speech. */
  nudge(text, { speak = true } = {}) {
    this.#send({
      type: "conversation.item.create",
      item: { type: "message", role: "system", content: [{ type: "input_text", text }] },
    });
    if (speak) this.#requestResponse();
  }

  /** Caller started talking — stop the agent immediately. */
  cancelResponse() {
    this.pendingResponse = false;
    if (!this.activeResponse) return;
    this.activeResponse = false;
    this.#send({ type: "response.cancel" });
  }

  /** Feed caller audio straight through: base64 PCM16 24 kHz mono from ACS. */
  writeCallerAudio(base64Pcm) {
    this.#send({ type: "input_audio_buffer.append", audio: base64Pcm });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close();
    } catch {}
    log("session closed");
  }
}
