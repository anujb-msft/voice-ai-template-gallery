import WebSocket from "ws";
import { config } from "../config.mjs";
import { knowledgeBase } from "../knowledge.mjs";

/**
 * Tools the model can call to drive the reset flow. These are the *only* way the
 * agent can change state, which keeps the security-sensitive logic on the server.
 */
export const AGENT_TOOLS = [
  {
    type: "function",
    name: "confirm_identity",
    description:
      "Verify the caller by the last four digits of their employee ID. Call this as soon as they say the digits.",
    parameters: {
      type: "object",
      properties: { digits: { type: "string", description: "The four digits the caller said, e.g. '4417'." } },
      required: ["digits"],
    },
  },
  {
    type: "function",
    name: "issue_verification_code",
    description:
      "Generate the six-digit code to read aloud to the caller so they can type it into the browser. Call once.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "escalate",
    description: "Hand the caller to a human IT specialist.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string", description: "Short machine-readable reason." } },
      required: ["reason"],
    },
  },
  {
    type: "function",
    name: "end_call",
    description: "Politely end the call once the caller has nothing further.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

const BASE_INSTRUCTIONS = `You are the Contoso IT assistant, making an OUTBOUND phone call to an employee who just clicked "Forgot password" on the corporate sign-in page. They are expecting you.

Style: warm, efficient, human. One or two short sentences per turn — this is a phone call, not a chat window. Never read out lists or markdown. Never say "as an AI".

Security rules you must never break:
- Never ask the caller to say a password out loud. If they start to, interrupt politely and ask them to type it instead.
- Never reveal the caller's full employee ID, and never accept a password over the phone.
- Only ever change state by calling the provided tools.

Answering questions mid-call:
- Callers will interrupt the reset with questions. Answer them — a rushed agent that ignores questions is the reason people phone the help desk instead.
- Answer from the KNOWLEDGE BASE below, in your own words, in one or two spoken sentences. Never read it out verbatim and never mention that you have a document.
- If the question is not covered there, say honestly that you are not sure, and offer to hand off to a specialist. Never invent IT policy.
- After answering, steer straight back to the current step in the same breath, e.g. "...so, whenever you're ready, the last four digits?"
- Call \`escalate\` instead of improvising if they say they did NOT request this reset, if they are locked out of MFA as well, if they ask about something unrelated to passwords, or if they ask for a human.

You will be given step-by-step instructions as the call progresses. Always follow the most recent instruction you were given.`;

/** Base instructions plus the FAQ. Read lazily so edits to the markdown apply to the next call. */
export function baseInstructions() {
  const kb = knowledgeBase().text;
  return kb ? `${BASE_INSTRUCTIONS}\n\n=== KNOWLEDGE BASE ===\n${kb}\n=== END KNOWLEDGE BASE ===` : BASE_INSTRUCTIONS;
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
  }

  async connect() {
    const { endpoint, apiKey, model, apiVersion, voice } = config.voiceLive;
    const url =
      `${endpoint.replace(/^https:/, "wss:")}/voice-live/realtime` +
      `?api-version=${encodeURIComponent(apiVersion)}&model=${encodeURIComponent(model)}`;

    this.ws = new WebSocket(url, { headers: { "api-key": apiKey } });

    await new Promise((resolve, reject) => {
      const fail = setTimeout(() => reject(new Error("Voice Live connect timeout")), 20000);

      this.ws.on("open", () => {
        clearTimeout(fail);
        log(`connected (${model})`);
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
   * Voice Live allows exactly one in-flight response per conversation. A step
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
