import WebSocket from "ws";
import { config } from "../config.mjs";
import { AGENT_TOOLS, buildInstructions, localeLanguage } from "../agent.mjs";

export { AGENT_TOOLS, buildInstructions, localeLanguage };

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
    this.lines = [];
    this.toolCalls = 0;
    this.responseSeq = 0;
    this.lastCreate = null;
    this.linesAsItems = false;
    this.requeued = new Set();
    this.deferredItems = [];
  }

  async connect() {
    const { endpoint, model, apiVersion, voice } = config.voiceLive;
    const language = localeLanguage(config.locale);
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
            // Voice Live expects an ISO-639-1 hint for multimodal-model
            // transcription ("en"), while the rest of the sample exposes the
            // more specific BCP-47 locale ("en-US").
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

    this.ws.on("message", (raw) => this.receive(raw).catch((e) => log("event handling failed", e)));
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
    if (this.activeResponse) {
      this.pendingResponse = true;
      return;
    }
    this.activeResponse = true;
    this.pendingResponse = false;
    const queued = this.lines.splice(0);
    const lines = queued.join("\n");
    const event_id = `response-${++this.responseSeq}`;
    if (lines && this.linesAsItems) {
      this.#send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: lines }] } });
    }
    // Server lines ride on this one response as per-response instructions, so they never
    // linger in the session prompt and get spoken again on a later turn.
    const viaInstructions = Boolean(lines) && !this.linesAsItems;
    this.lastCreate = { event_id, lines: viaInstructions ? queued : [] };
    this.#send({
      type: "response.create",
      event_id,
      ...(viaInstructions && { response: { instructions: `${this.baseInstructions}\n\n${lines}` } }),
    });
  }

  /**
   * A response that only calls tools never speaks the server lines it carried, and the
   * next response doesn't know about them, so they go back on the queue, once. A
   * cancelled response is the caller talking over the agent, so its lines are dropped.
   */
  #settleLines(msg) {
    const sent = this.lastCreate;
    // Only the response our last response.create started carried those lines.
    if (!sent || sent.responseId === undefined) return;
    if (sent.responseId !== null && sent.responseId !== msg.response?.id) return;
    this.lastCreate = null;
    const output = msg.response?.output;
    const toolOnly =
      msg.type === "response.done" &&
      msg.response?.status === "completed" &&
      Array.isArray(output) &&
      output.some((item) => item?.type === "function_call") &&
      !output.some((item) => item?.type === "message");
    if (!toolOnly) {
      for (const line of sent.lines) this.requeued.delete(line);
      return;
    }
    const retry = [];
    for (const line of sent.lines) {
      // A line already had its second chance: drop it, so a model that keeps calling tools can't loop on it.
      if (this.requeued.delete(line) || this.lines.includes(line)) continue;
      this.requeued.add(line);
      retry.push(line);
    }
    if (!retry.length) return;
    this.lines.unshift(...retry);
    this.pendingResponse = true;
    log(`re-queued ${retry.length} server line(s) that a tool-only response didn't speak`);
  }

  /** Handle one Voice Live server event: the socket's message handler, and how tests drive a session. */
  receive(raw) {
    return this.#handleEvent(raw);
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
        // Remember which response our last response.create started, to check what it said when it's done.
        if (this.lastCreate && this.lastCreate.responseId === undefined) this.lastCreate.responseId = msg.response?.id ?? null;
        if (this.lines.length) this.pendingResponse = true;
        break;

      case "response.done":
      case "response.cancelled":
        this.activeResponse = false;
        this.#settleLines(msg);
        // While a tool runs, its output requests the next response, which carries any queued lines.
        if (this.pendingResponse && !this.toolCalls) this.#requestResponse();
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

      case "error": {
        log("ERROR", JSON.stringify(msg.error));
        const refused = this.lastCreate;
        if (refused && msg.error?.event_id === refused.event_id) {
          // Our response.create was refused: keep its server lines for the next response.
          this.lastCreate = null;
          this.lines.unshift(...refused.lines.filter((line) => !this.lines.includes(line)));
          if (msg.error.code === "conversation_already_has_active_response") {
            if (this.activeResponse) this.pendingResponse = true;
            else setTimeout(() => this.#requestResponse(), 250);
          } else {
            this.activeResponse = false;
            if (refused.lines.length && !this.linesAsItems) {
              this.linesAsItems = true;
              this.#requestResponse();
            }
          }
        }
        this.onEvent({ kind: "error", error: msg.error });
        break;
      }
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
    if (!this.toolCalls) for (const event of this.deferredItems.splice(0)) this.#send(event);
    this.#requestResponse();
  }

  /**
   * Queue a server line (a directive plus the exact words) and let the agent speak it.
   * Lines raised while a tool call is running ride the response that follows its output.
   */
  instruct(instructions, text) {
    const line = [instructions, text && JSON.stringify(text)].filter(Boolean).join(" ");
    if (!line) return;
    if (!this.lines.includes(line)) this.lines.push(line);
    if (!this.toolCalls) this.#requestResponse();
  }

  /** Inject an out-of-band fact mid-call without necessarily prompting speech. */
  nudge(text, { speak = true } = {}) {
    const event = { type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } };
    // A tool's output has to follow its call, so a note raised while a tool runs goes in after that output.
    if (this.toolCalls) {
      this.deferredItems.push(event);
      return;
    }
    this.#send(event);
    if (speak) this.#requestResponse();
  }

  /** Caller started talking — stop the agent immediately. */
  cancelResponse() {
    this.pendingResponse = false;
    if (!this.activeResponse) return;
    this.activeResponse = false;
    this.#send({ type: "response.cancel" });
  }

  /** The server is taking over this turn: drop queued lines and stop the agent. */
  interrupt() {
    this.lines = [];
    this.requeued.clear();
    // The lines the current response carried are dropped too, even if it turns out to have only called tools.
    if (this.lastCreate) this.lastCreate.lines = [];
    this.cancelResponse();
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
