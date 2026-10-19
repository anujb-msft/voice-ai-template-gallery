// An original score for the overview reel, synthesised here in Node: no samples and
// no licensed music. Deterministic (seeded), 100 BPM in E major (the key of the
// incoming-call ring), rendered as 48 kHz stereo float samples.
//
// The arrangement follows the picture, section by section (reel times in seconds):
//   riser      noise swelling into the title's downbeat (under the cold open's last seconds)
//   intro      a soft hit, then pad and marimba arpeggio (the title)
//   groove     pad, arpeggio, bass, a soft kick and shaker (the montage); `accents` chime on each card
//   breakdown  pad and a sparse arpeggio (the trust beat)
//   finale     the groove for `groove` bars (default 2), then a ringing E major 9 (the end card)
// Every section restarts the progression on its first bar; boundaries should sit on
// the beat grid from the first downbeat (see BEAT). Levels are relative: reel.mjs
// sets the bed's loudness and ducks it under the voices.
import { RATE } from "./soundtrack.mjs";

export const BPM = 100;
export const BEAT = 60 / BPM;
export const BAR = 4 * BEAT;

const TAU = 2 * Math.PI;
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

// One chord per bar: a bass root and four pad tones voiced around middle C.
const PROGRESSION = [
  { root: 40, pad: [56, 59, 63, 66] }, // Emaj9   (E | G# B D# F#)
  { root: 37, pad: [56, 59, 63, 64] }, // C#m9    (C# | G# B D# E)
  { root: 33, pad: [56, 59, 61, 64] }, // Amaj9   (A | G# B C# E)
  { root: 35, pad: [54, 59, 61, 64] }, // Bsus    (B | F# B C# E)
];
const ARP = [0, 1, 2, 3, 4, 3, 2, 1]; // eighth notes over the chord's tones, an octave up

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Bus {
  constructor(n) {
    this.L = new Float32Array(n);
    this.R = new Float32Array(n);
  }
  add(at, mono, gain = 1, pan = 0) {
    const start = Math.round(at * RATE);
    const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < mono.length; i++) {
      const j = start + i;
      if (j < 0) continue;
      if (j >= this.L.length) break;
      this.L[j] += mono[i] * gl;
      this.R[j] += mono[i] * gr;
    }
  }
}

/** RBJ biquad, applied in place. */
function biquad(x, type, freq, q = 0.707) {
  const w = (TAU * freq) / RATE;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === "lowpass") [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
  else if (type === "highpass") [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  else [b0, b1, b2] = [alpha, 0, -alpha]; // bandpass, 0 dB peak
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    x[i] = y;
  }
  return x;
}

// ----------------------------------------------------------------- voices

const TABLE = (() => {
  // A soft, slightly hollow saw: the pad's single cycle.
  const n = 4096;
  const t = new Float32Array(n + 1);
  const amps = [1, 0.42, 0.24, 0.12, 0.07, 0.035];
  for (let i = 0; i <= n; i++) for (let h = 0; h < amps.length; h++) t[i] += amps[h] * Math.sin((TAU * (h + 1) * i) / n);
  const peak = t.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  return t.map((v) => v / peak);
})();

/** One pad note: three detuned oscillators spread across the stereo field. */
function padNote(bus, midi, at, dur, level, rand) {
  const attack = 0.7;
  const release = 1.3;
  const n = Math.round((dur + release) * RATE);
  for (const [cents, pan] of [[-7, -0.7], [0, 0], [7, 0.7]]) {
    const step = (hz(midi) * 2 ** (cents / 1200) * 4096) / RATE;
    let phase = rand() * 4096;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const env = t < attack ? Math.sin((t / attack) * (Math.PI / 2)) ** 2 : t < dur ? 1 : Math.max(0, 1 - (t - dur) / release) ** 2;
      const k = phase | 0;
      out[i] = env * (TABLE[k] + (TABLE[k + 1] - TABLE[k]) * (phase - k));
      phase += step;
      if (phase >= 4096) phase -= 4096;
    }
    bus.add(at, out, level / 3, pan);
  }
}

const plucks = new Map();
/** A marimba-like strike: a warm fundamental with a fast-fading bright partial. */
function pluck(midi) {
  if (plucks.has(midi)) return plucks.get(midi);
  const f = hz(midi);
  const out = new Float32Array(Math.round(1.6 * RATE));
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const a = Math.min(1, t / 0.004);
    out[i] = a * (Math.exp(-t / 0.42) * Math.sin(TAU * f * t) + 0.07 * Math.exp(-t / 0.3) * Math.sin(TAU * 2 * f * t) + 0.2 * Math.exp(-t / 0.035) * Math.sin(TAU * 3.98 * f * t));
  }
  plucks.set(midi, out);
  return out;
}

/** A soft bell: inharmonic partials with long, staggered decays. */
function bell(midi, length = 4) {
  const f = hz(midi);
  const out = new Float32Array(Math.round(length * RATE));
  const partials = [[1, 1, 2.6], [2.76, 0.32, 1.1], [5.4, 0.14, 0.5], [8.93, 0.06, 0.22]];
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const a = Math.min(1, t / 0.006);
    let v = 0;
    for (const [ratio, amp, decay] of partials) v += amp * Math.exp(-t / decay) * Math.sin(TAU * f * ratio * t);
    out[i] = a * v;
  }
  return out;
}

function bassNote(midi, dur) {
  const f = hz(midi);
  const out = new Float32Array(Math.round((dur + 0.25) * RATE));
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const env = Math.min(1, t / 0.012) * (t < dur ? Math.exp(-t / 1.6) : Math.exp(-dur / 1.6) * Math.max(0, 1 - (t - dur) / 0.25));
    // The second and third harmonics carry the line on small speakers.
    out[i] = env * (Math.sin(TAU * f * t) + 0.35 * Math.sin(TAU * 2 * f * t) + 0.12 * Math.sin(TAU * 3 * f * t));
  }
  return out;
}

const KICK = (() => {
  const out = new Float32Array(Math.round(0.45 * RATE));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    phase += (TAU * (46 + 96 * Math.exp(-t / 0.032))) / RATE;
    out[i] = Math.min(1, t / 0.002) * Math.exp(-t / 0.16) * Math.sin(phase);
  }
  return out;
})();

function shaker(rand) {
  const out = new Float32Array(Math.round(0.09 * RATE));
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    out[i] = (rand() * 2 - 1) * Math.min(1, t / 0.006) * Math.exp(-t / 0.028);
  }
  return biquad(biquad(out, "highpass", 5200), "highpass", 5200);
}

function boom() {
  const out = new Float32Array(Math.round(2.6 * RATE));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    phase += (TAU * (36 + 30 * Math.exp(-t / 0.35))) / RATE;
    out[i] = Math.min(1, t / 0.004) * Math.exp(-t / 0.85) * (Math.sin(phase) + 0.25 * Math.sin(2 * phase));
  }
  return out;
}

function riser(dur, rand) {
  const n = Math.round(dur * RATE);
  const out = new Float32Array(n);
  // Noise through a band-pass sweeping up, swelling; a quiet rising tone underneath.
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, tone = 0;
  for (let i = 0; i < n; i++) {
    const p = i / n;
    const freq = 300 * (5200 / 300) ** p;
    const w = (TAU * freq) / RATE;
    const alpha = Math.sin(w) / (2 * 2.2);
    const a0 = 1 + alpha;
    const x = rand() * 2 - 1;
    const y = (alpha * x - alpha * x2 + 2 * Math.cos(w) * y1 - (1 - alpha) * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    tone += (TAU * 220 * 4 ** p) / RATE;
    const swell = p ** 2.4;
    const end = Math.min(1, (n - i) / (0.03 * RATE));
    out[i] = end * swell * (2.4 * y + 0.12 * Math.sin(tone));
  }
  return out;
}

// ------------------------------------------------------------------ effects

/** Ping-pong delay: the input bounces left, right, left... */
function pingPong(bus, seconds, feedback, wet) {
  const d = Math.round(seconds * RATE);
  const n = bus.L.length;
  const dl = new Float32Array(n);
  const dr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const inL = bus.L[i] + bus.R[i];
    dl[i] = (i >= d ? dr[i - d] * feedback : 0) + inL * 0.5;
    dr[i] = i >= d ? dl[i - d] : 0;
  }
  for (let i = 0; i < n; i++) {
    bus.L[i] += wet * (i >= d ? dl[i - d] : 0);
    bus.R[i] += wet * dr[i];
  }
}

/** Freeverb (Jezar's tunings at 48 kHz): eight damped combs and four all-passes per side. */
function freeverb(input, { room = 0.84, damp = 0.32, spread = 23 } = {}) {
  const scale = RATE / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const alls = [556, 441, 341, 225];
  const side = (x, offset) => {
    const out = new Float32Array(x.length);
    for (const tune of combs) {
      const len = Math.round((tune + offset) * scale);
      const buf = new Float32Array(len);
      let idx = 0, store = 0;
      for (let i = 0; i < x.length; i++) {
        const y = buf[idx];
        store = y * (1 - damp) + store * damp;
        buf[idx] = x[i] * 0.015 + store * room;
        if (++idx >= len) idx = 0;
        out[i] += y;
      }
    }
    for (const tune of alls) {
      const len = Math.round((tune + offset) * scale);
      const buf = new Float32Array(len);
      let idx = 0;
      for (let i = 0; i < out.length; i++) {
        const b = buf[idx];
        const y = -out[i] + b;
        buf[idx] = out[i] + b * 0.5;
        if (++idx >= len) idx = 0;
        out[i] = y;
      }
    }
    return out;
  };
  const mono = new Float32Array(input.L.length);
  for (let i = 0; i < mono.length; i++) mono[i] = input.L[i] + input.R[i];
  return { L: side(mono, 0), R: side(mono, spread) };
}

// -------------------------------------------------------------------- score

/**
 * The bed for `total` seconds: { L, R } Float32Arrays. `sections`: [{ kind, at, end, accents?, groove? }]
 * with kind riser | intro | groove | breakdown | finale.
 */
export function score({ total, sections, seed = 11 }) {
  const n = Math.ceil(total * RATE);
  const rand = prng(seed);
  const pad = new Bus(n);
  const keys = new Bus(n);
  const low = new Bus(n);
  const hits = new Bus(n);

  const chords = (s, bars) =>
    Array.from({ length: bars }, (_, b) => ({ at: s.at + b * BAR, chord: PROGRESSION[b % PROGRESSION.length], bar: b }));
  const barsIn = (s) => Math.max(1, Math.ceil((s.end - s.at) / BAR - 0.01));
  const chime = (at, level, top = false) => {
    // An E major 9 strummed upward, high and soft.
    [76, 80, 83, 87, ...(top ? [90] : [])].forEach((m, i) => hits.add(at + i * 0.028, bell(m), level * (1 - i * 0.12), -0.35 + i * 0.18));
  };
  const arp = (c, from, until, level, every = 1) => {
    const tones = [...c.chord.pad.map((m) => m + 12), c.chord.root + 36].sort((a, b) => a - b);
    for (let k = 0; k < 8; k += every) {
      const at = c.at + k * (BEAT / 2);
      if (at < from || at >= until - 0.05) continue;
      const accent = k % 4 === 0 ? 1 : k % 2 === 0 ? 0.82 : 0.68;
      keys.add(at, pluck(tones[ARP[k]]), level * accent, k % 2 ? 0.28 : -0.28);
    }
  };
  const groove = (c, from, until, { kick = true } = {}) => {
    const root = c.chord.root;
    const bass = [[0, 1.05], [1.5, 0.42], [2.5, 0.5]];
    for (const [beat, dur] of bass) {
      const at = c.at + beat * BEAT;
      if (at >= from && at < until - 0.1) low.add(at, bassNote(root, Math.min(dur, until - at)), 0.2);
    }
    for (let b = 0; b < 4; b++) {
      const at = c.at + b * BEAT;
      if (kick && (b === 0 || b === 2) && at >= from && at < until - 0.05) low.add(at, KICK, 0.34);
      const off = at + BEAT / 2;
      if (off >= from && off < until - 0.05) hits.add(off, shaker(rand), b % 2 ? 0.05 : 0.035, 0.35);
    }
  };

  for (const s of sections) {
    const bars = barsIn(s);
    if (s.kind === "riser") {
      hits.add(s.at, riser(s.end - s.at - 0.06, rand), 0.07, 0);
      continue;
    }
    if (s.kind === "intro") {
      low.add(s.at, boom(), 0.55);
      chime(s.at, 0.07, true);
    }
    if (s.accents) for (const at of s.accents) chime(at, 0.05);
    for (const c of chords(s, bars)) {
      const until = Math.min(s.end, c.at + BAR);
      if (c.at >= s.end - 0.05) break;
      const finale = s.kind === "finale" && c.bar >= (s.groove ?? 2);
      if (finale) {
        // The last chord: the full Emaj9 with its root, ringing out.
        const ring = s.end - c.at;
        for (const m of [40, 52, ...PROGRESSION[0].pad, 71]) padNote(pad, m, c.at, Math.max(0.5, ring - 1.6), m < 50 ? 0.1 : 0.075, rand);
        chime(c.at, 0.06, true);
        low.add(c.at, bassNote(40, Math.max(0.5, ring - 0.6)), 0.16);
        break;
      }
      for (const m of c.chord.pad) padNote(pad, m, c.at, until - c.at + 0.25, s.kind === "breakdown" ? 0.085 : 0.07, rand);
      if (s.kind === "intro") arp(c, c.at, until, 0.06, 2);
      else if (s.kind === "breakdown") arp(c, c.at, until, 0.05, 4);
      else arp(c, c.at, until, 0.07);
      if (s.kind === "groove" || s.kind === "finale") groove(c, c.at, until);
    }
  }

  // Colour and space: a darker pad, the arpeggio's echoes, one shared reverb.
  for (const ch of [pad.L, pad.R]) biquad(ch, "lowpass", 2600, 0.6);
  pingPong(keys, (BEAT * 3) / 4, 0.34, 0.3);
  const send = new Bus(n);
  for (let i = 0; i < n; i++) {
    send.L[i] = pad.L[i] * 0.45 + keys.L[i] * 0.55 + hits.L[i] * 0.6;
    send.R[i] = pad.R[i] * 0.45 + keys.R[i] * 0.55 + hits.R[i] * 0.6;
  }
  const verb = freeverb(send);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = pad.L[i] + keys.L[i] + low.L[i] + hits.L[i] + 0.32 * verb.L[i];
    R[i] = pad.R[i] + keys.R[i] + low.R[i] + hits.R[i] + 0.32 * verb.R[i];
  }
  biquad(L, "highpass", 32);
  biquad(R, "highpass", 32);
  return { L, R };
}
