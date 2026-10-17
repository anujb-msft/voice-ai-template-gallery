import WebSocket from "ws";
import { config } from "../config.mjs";
import { knowledgeBase } from "../knowledge.mjs";
import { AGENT_TOOLS, buildInstructions, localeLanguage } from "../agent.mjs";

export { AGENT_TOOLS };

/** The standing instructions plus the FAQ. Read on every update, so edits to the markdown apply to the next turn. */
export function baseInstructions() {
  return buildInstructions({ locale: config.locale, knowledge: knowledgeBase().text });
}

const log = (...a) => console.log(new Date().toISOString(), "[voice-live]", ...a);

/**
 * One Voice Live session over the WebSocket transport.
 *
 * Audio is PCM16 mono 24 kHz in both directions, which is exactly what ACS
 * bidirectional media streaming emits and accepts (`audioFormat: "pcm24KMono"`),
 * so audio is forwarded verbatim — no transcoding, no resampling, no jitter buffer.
 *
 * See the README section "Why WebSocket and not WebRTC" for the transport rationale.
 */
export class VoiceLiveSession {
  constructor({ onAgentAudio, onEvent, onToolCall }) {
    this.onAgentAudio = onAgentAudio; // (base64Pcm24Mono) => void
    this.onEvent = onEvent ?? (() => {});
    this.onToolCall = onToolCall ?? (async () => ({}));
    this.closed = false;
    this.pending = [];
    this.activeResponse = false;
    this.pendingResponse = false;
    /** Tool calls in flight. Their result asks for the next response, so nothing else may. */
    this.toolCalls = 0;
  }

  async connect() {
    const { endpoint, apiKey, model, apiVersion, voice } = config.voiceLive;
    const language = localeLanguage(config.locale);
    const url =
      `${endpoint.replace(/^https:/, "wss:")}/voice-live/realtime` +
      `?api-version=${encodeURIComponent(apiVersion)}&model=${encodeURIComponent(model)}`;

    this.ws = new WebSocket(url, { headers: { "api-key": apiKey } });

    await new Promise((resolve, reject) => {
      const fail = setTimeout(() => reject(new Error("Voice Live connect timeout")), 20000);

      this.ws.on("open", () => {
        clearTimeout(fail);
        log(`connected (${model}, ${language.locale})`);
        this.#send({
          type: "session.update",
          session: {
            instructions: baseInstructions(),
            modalities: ["text", "audio"],
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            voice: { name: voice, type: "azure-standard" },
            tools: AGENT_TOOLS,
            tool_choice: "auto",
            // Pinning the language keeps a short answer such as a run of digits
            // from being transcribed as another language.
            input_audio_transcription: { model: "gpt-4o-transcribe", language: language.code },
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
   * Voice Live allows exactly one in-flight response per conversation. A step
   * transition and a tool result can easily both want the agent to speak, so
   * requests are coalesced here instead of racing and erroring with
   * `conversation_already_has_active_response`. While a tool call is in
   * flight, its result asks for the next response, so the model hears the
   * result and any new step together instead of answering before the result.
   */
  #requestResponse() {
    if (this.activeResponse || this.toolCalls) {
      this.pendingResponse = true;
      return;
    }
    this.activeResponse = true;
    this.pendingResponse = false;
    this.#send({ type: "response.create" });
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
        if (this.pendingResponse) this.#requestResponse();
        break;

      case "response.audio.delta":
        // Base64 PCM16 24 kHz mono — handed to ACS untouched.
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
    // The name only: arguments can hold the digits the caller said.
    log("tool", msg.name);

    let result;
    this.toolCalls += 1;
    try {
      result = await this.onToolCall(msg.name, args);
    } catch (e) {
      result = { error: e.message };
    } finally {
      this.toolCalls -= 1;
    }

    this.#send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: msg.call_id, output: JSON.stringify(result ?? {}) },
    });
    this.#requestResponse();
  }

  /** Replace the standing instructions for the current step, then let the agent speak. */
  instruct(text) {
    this.#send({ type: "session.update", session: { instructions: `${baseInstructions()}\n\n${text}` } });
    this.#requestResponse();
  }

  /** Inject an out-of-band fact mid-call (e.g. live password policy feedback). */
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
