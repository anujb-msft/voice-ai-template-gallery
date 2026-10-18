/**
 * GPT Realtime native voices, through Azure AI Voice Live.
 *
 * Every spoken line in the films is performed by `gpt-realtime` with one of its
 * native voices (marin, cedar, coral, ...). Voice Live hosts the model, so no
 * Azure OpenAI deployment is needed. Auth is keyless: an Entra token from the
 * Azure CLI (`az login`), scope https://ai.azure.com.
 *
 * A voice cannot change once a session has spoken, so each line gets its own
 * short session: one text item in, one audio response out. The model is told to
 * perform the line verbatim; its own transcript is checked against the script
 * and the line is retried when it drifts.
 *
 *   node src/realtime.mjs --voice marin --text "Thanks for calling."   (probe)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import WebSocket from "ws";

const run = promisify(execFile);

export const MODEL = process.env.VOICE_LIVE_MODEL ?? "gpt-realtime";
export const API_VERSION = process.env.VOICE_LIVE_API_VERSION ?? "2026-04-10";
export const SAMPLE_RATE = 24000;

let token = null;

async function accessToken() {
  if (token && token.expires - Date.now() > 5 * 60_000) return token.value;
  const { stdout } = await run("az", [
    "account",
    "get-access-token",
    "--resource",
    "https://ai.azure.com",
    "--query",
    "{t:accessToken,e:expires_on}",
    "-o",
    "json",
  ]);
  const { t, e } = JSON.parse(stdout);
  token = { value: t, expires: Number(e) * 1000 };
  return t;
}

function endpoint() {
  const value = process.env.VOICE_LIVE_ENDPOINT;
  if (!value) throw new Error("Set VOICE_LIVE_ENDPOINT to your Azure AI Services / Foundry endpoint.");
  return value.replace(/\/+$/, "").replace(/^https:/, "wss:");
}

const ACTOR = (style) =>
  [
    "You are a voice actor recording dialogue for a product film.",
    "Each message you receive is one line of script. Perform that line out loud, exactly as written:",
    "the same words in the same order. Add nothing, drop nothing, do not answer it, do not react to it,",
    "and never speak as anyone other than the character described below.",
    "Read numbers, times and names naturally, the way a person would say them.",
    `Character and delivery: ${style}`,
  ].join(" ");

/**
 * Perform one line. Resolves to { pcm: Buffer (PCM16 mono 24 kHz), transcript }.
 */
export async function performLine({ text, voice, style, timeoutMs = 45_000 }) {
  const url = `${endpoint()}/voice-live/realtime?api-version=${encodeURIComponent(API_VERSION)}&model=${encodeURIComponent(MODEL)}`;
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  const chunks = [];
  let transcript = "";

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`timed out performing "${text.slice(0, 40)}"`)), timeoutMs);
    const finish = (error, value) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      if (error) reject(error);
      else resolve(value);
    };
    const send = (frame) => ws.send(JSON.stringify(frame));

    ws.on("open", () => {
      send({
        type: "session.update",
        session: {
          instructions: ACTOR(style),
          modalities: ["text", "audio"],
          output_audio_format: "pcm16",
          voice: { type: "openai", name: voice },
          turn_detection: null,
          temperature: 0.7,
        },
      });
      send({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: `Line: ${text}` }] },
      });
      send({ type: "response.create" });
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      switch (msg.type) {
        case "response.audio.delta":
          chunks.push(Buffer.from(msg.delta, "base64"));
          break;
        case "response.audio_transcript.done":
          transcript = msg.transcript ?? transcript;
          break;
        case "response.done": {
          const status = msg.response?.status;
          if (status && status !== "completed") {
            finish(new Error(`response ${status}: ${JSON.stringify(msg.response?.status_details ?? {})}`));
          } else {
            finish(null, { pcm: Buffer.concat(chunks), transcript });
          }
          break;
        }
        case "error":
          finish(new Error(`Voice Live error: ${msg.error?.message ?? JSON.stringify(msg.error ?? msg)}`));
          break;
        default:
          break;
      }
    });
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => finish(new Error(`Voice Live HTTP ${res.statusCode}: ${body.slice(0, 300)}`)));
    });
    ws.on("error", (error) => finish(error));
  });
}

// ------------------------------------------------------------------ checks

const words = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

/** Word-level similarity between the script and what the model said (0..1). */
export function similarity(expected, actual) {
  const a = words(expected);
  const b = words(actual);
  if (!a.length && !b.length) return 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return 1 - d[a.length][b.length] / Math.max(a.length, b.length);
}

// ------------------------------------------------------------------- audio

/** Trim leading and trailing silence, keeping a short natural pad. */
export function trimSilence(pcm, { thresholdDb = -48, padMs = 60 } = {}) {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const threshold = 32768 * 10 ** (thresholdDb / 20);
  const window = Math.round(SAMPLE_RATE * 0.01);
  const loud = (i) => {
    let peak = 0;
    for (let k = i; k < Math.min(i + window, samples.length); k++) peak = Math.max(peak, Math.abs(samples[k]));
    return peak > threshold;
  };
  let start = 0;
  while (start < samples.length && !loud(start)) start += window;
  let end = samples.length;
  while (end > start && !loud(Math.max(0, end - window))) end -= window;
  const pad = Math.round((SAMPLE_RATE * padMs) / 1000);
  start = Math.max(0, start - pad);
  end = Math.min(samples.length, end + pad);
  return Buffer.from(samples.slice(start, end).buffer);
}

export function wav(pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export const durationMs = (pcm) => Math.round((pcm.length / 2 / SAMPLE_RATE) * 1000);

// ------------------------------------------------------------------- probe

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const text = arg("text", "Thanks for calling Northwind. What can I help you with today?");
  const voice = arg("voice", "marin");
  const style = arg("style", "a warm, professional contact-centre agent; natural pace.");
  const out = arg("out", `/tmp/probe-${voice}.wav`);
  const started = Date.now();
  const { pcm, transcript } = await performLine({ text, voice, style });
  const trimmed = trimSilence(pcm);
  await writeFile(out, wav(trimmed));
  console.log(
    JSON.stringify(
      {
        voice,
        ms: durationMs(trimmed),
        rawMs: durationMs(pcm),
        transcript,
        similarity: similarity(text, transcript),
        tookMs: Date.now() - started,
        out,
      },
      null,
      2,
    ),
  );
}
