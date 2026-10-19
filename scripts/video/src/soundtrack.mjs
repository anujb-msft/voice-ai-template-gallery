// The films' soundtrack. Every voice clip is loudness-matched on its own, placed
// at its film time and mixed in Node at 48 kHz; the mix is then normalised to
// broadcast-friendly loudness. The template films have no music bed, only the
// ring that opens them; the overview reel (reel.mjs) adds its score (score.mjs).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

export const RATE = 48000;
export const LOUDNESS = { clip: -19, film: -16, peak: -1.5 };
const CACHE = process.env.MIX_CACHE ?? join(homedir(), ".cache", "voice-ai-films", "mix");
const VERSION = 2;

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-nostdin", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    let err = "";
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => (err = (err + d).slice(-20000)));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve({ stdout: Buffer.concat(out), stderr: err }) : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-1500)}`))));
  });
}

function loudnormJson(stderr) {
  const m = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/s);
  if (!m) throw new Error(`no loudnorm measurement in ffmpeg output: ${stderr.slice(-400)}`);
  return JSON.parse(m[0]);
}

/** Phone-line colour for call voices: a little low end and air rolled off. */
export const PHONE = "highpass=f=110,lowpass=f=7000";

/**
 * A voice clip as 48 kHz mono float samples at a common loudness. `band`
 * applies the phone colour; `gainDb` sits a voice above or below the others.
 */
export async function prepareClip(file, { band = false, gainDb = 0 } = {}) {
  const info = await stat(file);
  const key = createHash("sha1")
    .update(JSON.stringify([VERSION, basename(file), info.size, band, gainDb, LOUDNESS.clip]))
    .digest("hex")
    .slice(0, 20);
  const out = join(CACHE, `${key}.f32`);
  if (!existsSync(out)) {
    await mkdir(CACHE, { recursive: true });
    const colour = band ? `${PHONE},` : "";
    const { stderr } = await ffmpeg(["-i", file, "-af", `${colour}loudnorm=I=${LOUDNESS.clip}:TP=-2:LRA=11:print_format=json`, "-f", "null", "-"]);
    const measured = Number(loudnormJson(stderr).input_i);
    // Very short clips can measure as silence; leave those at their recorded level.
    const gain = Number.isFinite(measured) && measured > -70 ? Math.min(18, Math.max(-12, LOUDNESS.clip - measured)) : 0;
    const tmp = `${out}.tmp`;
    await ffmpeg(["-y", "-i", file, "-af", `${colour}volume=${(gain + gainDb).toFixed(2)}dB,aresample=${RATE}:resampler=soxr`, "-ac", "1", "-f", "f32le", tmp]);
    await rename(tmp, out);
  }
  const bytes = await readFile(out);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** A soft marimba-like note: a fundamental with a quickly fading fourth partial. */
function note(freq, seconds, level) {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const attack = Math.min(1, t / 0.003);
    const body = Math.exp(-t / 0.26);
    const strike = Math.exp(-t / 0.045);
    out[i] =
      level *
      attack *
      (body * Math.sin(2 * Math.PI * freq * t) + 0.28 * strike * Math.sin(2 * Math.PI * freq * 3.98 * t) + 0.08 * body * Math.sin(2 * Math.PI * freq * 2 * t));
  }
  return out;
}

/** One ring of an incoming call: a gentle rising figure, played twice. */
export function ringBurst(level = 0.16) {
  const figure = [
    [0, 659.25],
    [0.085, 830.61],
    [0.17, 987.77],
    [0.42, 659.25],
    [0.505, 830.61],
    [0.59, 987.77],
  ];
  const out = new Float32Array(Math.round(1.6 * RATE));
  for (const [at, freq] of figure) {
    const tone = note(freq, 1.0, level);
    const start = Math.round(at * RATE);
    for (let i = 0; i < tone.length && start + i < out.length; i++) out[start + i] += tone[i];
  }
  return out;
}

/**
 * Lay clips into one mono track: [{ samples, at, until?, gain? }] in seconds.
 * `until` stops a clip early (a line the console cut off) with a short fade.
 */
export function mix(clips, duration) {
  const track = new Float32Array(Math.ceil(duration * RATE) + RATE);
  const fade = Math.round(0.04 * RATE);
  for (const clip of clips) {
    const start = Math.round(clip.at * RATE);
    let length = clip.samples.length;
    if (clip.until != null) length = Math.max(0, Math.min(length, Math.round((clip.until - clip.at) * RATE)));
    const cut = length < clip.samples.length;
    const gain = clip.gain ?? 1;
    for (let i = 0; i < length; i++) {
      const j = start + i;
      if (j < 0 || j >= track.length) continue;
      let g = gain;
      if (cut && i > length - fade) g *= (length - i) / fade;
      track[j] += clip.samples[i] * g;
    }
  }
  return track.subarray(0, Math.ceil(duration * RATE));
}

/**
 * Write the mix as a loudness-normalised 48 kHz stereo WAV (two-pass loudnorm).
 * `track` is one mono Float32Array, or `{ L, R }` for a stereo mix. With `limit`, a mix
 * whose peaks sit too far over its loudness for one linear gain is first brought to the
 * target and its peaks held 1.5 dB under the ceiling by a look-ahead limiter, so loudnorm
 * stays linear instead of compressing the whole programme.
 */
export async function master(track, file, { limit = false } = {}) {
  const stereo = !(track instanceof Float32Array);
  let samples = track;
  if (stereo) {
    const n = Math.min(track.L.length, track.R.length);
    samples = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      samples[2 * i] = track.L[i];
      samples[2 * i + 1] = track.R[i];
    }
  }
  const raw = `${file}.f32`;
  await writeFile(raw, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  const input = ["-f", "f32le", "-ar", String(RATE), "-ac", stereo ? "2" : "1", "-i", raw];
  const target = `I=${LOUDNESS.film}:TP=${LOUDNESS.peak}:LRA=11`;
  const measure = async (pre) => loudnormJson((await ffmpeg([...input, "-af", `${pre}loudnorm=${target}:print_format=json`, "-f", "null", "-"])).stderr);
  let m = await measure("");
  const measured = { lufs: Number(m.input_i), truePeak: Number(m.input_tp), lra: Number(m.input_lra) };
  let pre = "";
  const gain = LOUDNESS.film - measured.lufs;
  if (limit && measured.truePeak + gain > LOUDNESS.peak) {
    const ceiling = 10 ** ((LOUDNESS.peak - 1.5) / 20);
    pre = `volume=${gain.toFixed(2)}dB,alimiter=limit=${ceiling.toFixed(4)}:attack=5:release=80:level=false:latency=true,`;
    m = await measure(pre);
  }
  const second =
    `${pre}loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
    `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=json,aresample=${RATE}:resampler=soxr`;
  const applied = await ffmpeg(["-y", ...input, "-af", second, "-ac", "2", "-c:a", "pcm_s24le", file]);
  const check = await ffmpeg(["-i", file, "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"]);
  const final = loudnormJson(check.stderr);
  await rm(raw, { force: true });
  // "dynamic" means loudnorm could not meet the targets with one linear gain and compressed instead.
  const mode = loudnormJson(applied.stderr).normalization_type ?? "unknown";
  return { lufs: Number(final.input_i), truePeak: Number(final.input_tp), mode, measured, limited: Boolean(pre) };
}
