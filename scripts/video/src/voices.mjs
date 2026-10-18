// The films' voice bank: every spoken line performed by GPT Realtime, cached.
//
// A line is identified by (model, voice, style, language, text). Its recording
// lives in VOICE_CACHE (default ~/.cache/voice-ai-films/voices) as <hash>.wav
// with a <hash>.json sidecar (transcript, similarity, duration). Lines are
// retried when the model's own transcript drifts from the script.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performLine, trimSilence, wav, durationMs, MODEL, API_VERSION } from "./realtime.mjs";

const LANGUAGE = {
  es: "Latin American Spanish",
  fr: "French",
  de: "German",
  pt: "Brazilian Portuguese",
  it: "Italian",
  zh: "Mandarin Chinese",
  ja: "Japanese",
  ko: "Korean",
  vi: "Vietnamese",
  hi: "Hindi",
};

const NUMBER_WORDS = new Set(
  (
    "zero oh o one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen " +
    "seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million k " +
    "first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth " +
    "fifteenth sixteenth seventeenth eighteenth nineteenth twentieth thirtieth point dash double triple " +
    "cero uno una dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince dieciseis " +
    "diecisiete dieciocho diecinueve veinte veinti veintiuno veintidos veintitres veinticuatro veinticinco treinta cuarenta cincuenta " +
    "sesenta setenta ochenta noventa cien ciento doscientos trescientos cuatrocientos quinientos seiscientos " +
    "setecientos ochocientos novecientos mil y"
  ).split(" "),
);
const ABBREVIATIONS = { dr: "doctor", st: "street", ave: "avenue", mr: "mister", mrs: "missus", ms: "miz", vs: "versus" };

/** Words that must match: no digits, no number words, no spelled-out letters. */
function comparable(text) {
  return String(text)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ABBREVIATIONS[w] ?? w)
    .filter((w) => !/\d/.test(w) && !NUMBER_WORDS.has(w) && w.length > 1);
}

function editSimilarity(a, b) {
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

/** How faithfully the model read the line (0..1), forgiving how numbers and IDs are voiced. */
export function fidelity(script, transcript) {
  return editSimilarity(comparable(script), comparable(transcript));
}

export function styleFor(style, lang = "en-US") {
  const base = String(lang || "en").slice(0, 2).toLowerCase();
  return base !== "en" && LANGUAGE[base] ? `${style} Speak natively in ${LANGUAGE[base]}.` : style;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class VoiceBank {
  constructor({ dir = process.env.VOICE_CACHE ?? join(homedir(), ".cache", "voice-ai-films", "voices"), concurrency = 4, log = console.error } = {}) {
    this.dir = dir;
    this.limit = concurrency;
    this.active = 0;
    this.waiting = [];
    this.inflight = new Map();
    this.log = log;
  }

  key({ voice, style, lang = "en-US", text }) {
    return createHash("sha1").update(JSON.stringify([MODEL, API_VERSION, voice, styleFor(style, lang), text])).digest("hex").slice(0, 20);
  }

  file(key) {
    return join(this.dir, `${key}.wav`);
  }

  async cached(line) {
    const key = this.key(line);
    const meta = join(this.dir, `${key}.json`);
    if (!existsSync(meta) || !existsSync(this.file(key))) return null;
    return { ...JSON.parse(await readFile(meta, "utf8")), file: this.file(key), key, cached: true };
  }

  async slot(fn) {
    if (this.active >= this.limit) await new Promise((r) => this.waiting.push(r));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  /** The recording for one line: { file, ms, transcript, fidelity, cached }. */
  async get(line) {
    const key = this.key(line);
    const hit = await this.cached(line);
    if (hit) return hit;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const job = this.slot(() => this.generate(line, key)).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  async generate({ voice, style, lang = "en-US", text }, key) {
    await mkdir(this.dir, { recursive: true });
    const tries = 5;
    let best = null;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        const { pcm, transcript } = await performLine({ text, voice, style: styleFor(style, lang) });
        const trimmed = trimSilence(pcm);
        const score = fidelity(text, transcript);
        const ms = durationMs(trimmed);
        // A believable length: roughly 35-260 ms per character of script.
        const plausible = ms > 250 && ms < Math.max(2500, text.length * 260);
        const candidate = { pcm: trimmed, transcript, fidelity: score, ms, attempt, plausible };
        if (!best || (plausible && !best.plausible) || (plausible === best.plausible && score > best.fidelity)) best = candidate;
        if (plausible && score >= 0.9) break;
        this.log(`  retry ${attempt}/${tries} ${voice} fidelity ${score.toFixed(2)} "${text.slice(0, 60)}" -> "${transcript.slice(0, 60)}"`);
      } catch (error) {
        this.log(`  attempt ${attempt}/${tries} failed for ${voice} "${text.slice(0, 50)}": ${error.message}`);
        await sleep(1500 * attempt);
      }
    }
    if (!best) throw new Error(`could not perform "${text}" with ${voice}`);
    if (best.fidelity < 0.75) this.log(`  WARNING low fidelity ${best.fidelity.toFixed(2)} for ${voice}: "${text}" -> "${best.transcript}"`);
    const meta = { voice, lang, text, style: styleFor(style, lang), transcript: best.transcript, fidelity: best.fidelity, ms: best.ms, model: MODEL, apiVersion: API_VERSION };
    const tmp = `${this.file(key)}.tmp`;
    await writeFile(tmp, wav(best.pcm));
    await rename(tmp, this.file(key));
    await writeFile(join(this.dir, `${key}.json`), JSON.stringify(meta, null, 2));
    return { ...meta, file: this.file(key), key, cached: false };
  }
}
