/**
 * PCM helpers for ACS bidirectional media streaming with `audioFormat: "pcm24KMono"`:
 * 16-bit little-endian mono at 24 kHz, delivered in 20 ms frames.
 */
export const SAMPLE_RATE = 24000;
export const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
export const FRAME_MS = 20;
export const FRAME_BYTES = FRAME_MS * BYTES_PER_MS;

export function rms(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

export const durationMs = (pcm) => pcm.length / BYTES_PER_MS;

export const silence = (ms) => Buffer.alloc(Math.round((ms * BYTES_PER_MS) / 2) * 2);

export function toFrames(pcm, frameBytes = FRAME_BYTES) {
  const out = [];
  for (let i = 0; i < pcm.length; i += frameBytes) {
    const f = pcm.subarray(i, i + frameBytes);
    out.push(f.length === frameBytes ? f : Buffer.concat([f, Buffer.alloc(frameBytes - f.length)]));
  }
  return out;
}

export function wav(pcm, sampleRate = SAMPLE_RATE) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * Energy-based segmenter for the far end of a call. Feed it one media frame at a
 * time. It reports when speech starts, and returns the whole utterance, with a
 * little pre-roll, once the far end has been quiet for `endSilenceMs`.
 *
 * Time is measured in audio, not wall-clock, so tests are deterministic.
 */
export class Segmenter {
  constructor({ threshold = 300, startMs = 60, endSilenceMs = 700, preRollMs = 200, maxMs = 30000 } = {}) {
    Object.assign(this, { threshold, startMs, endSilenceMs, preRollMs, maxMs });
    this.clock = 0;
    this.lastLoud = false;
    this.#reset();
  }

  #reset() {
    this.active = false;
    this.voiced = 0;
    this.quiet = 0;
    this.chunks = [];
    this.pre = [];
    this.preBytes = 0;
    this.startedAt = 0;
  }

  /** @returns {{type:"start",at:number}|{type:"end",pcm:Buffer,startAt:number,endAt:number}|null} */
  push(frame, { silent = false } = {}) {
    const ms = durationMs(frame);
    this.clock += ms;
    const loud = !silent && frame.length > 0 && rms(frame) >= this.threshold;
    this.lastLoud = loud;

    if (!this.active) {
      this.pre.push(frame);
      this.preBytes += frame.length;
      const keep = (this.preRollMs + this.startMs) * BYTES_PER_MS;
      while (this.preBytes > keep && this.pre.length > 1) this.preBytes -= this.pre.shift().length;
      this.voiced = loud ? this.voiced + ms : 0;
      if (this.voiced < this.startMs) return null;
      this.active = true;
      this.quiet = 0;
      this.chunks = this.pre.splice(0);
      this.preBytes = 0;
      this.startedAt = this.clock - this.chunks.reduce((n, c) => n + c.length, 0) / BYTES_PER_MS;
      return { type: "start", at: this.startedAt };
    }

    this.chunks.push(frame);
    this.quiet = loud ? 0 : this.quiet + ms;
    if (this.quiet >= this.endSilenceMs || this.clock - this.startedAt >= this.maxMs) return this.flush();
    return null;
  }

  /** Close the open utterance, if any, e.g. when the call ends. */
  flush() {
    if (!this.active) return null;
    const out = {
      type: "end",
      pcm: Buffer.concat(this.chunks),
      startAt: this.startedAt,
      endAt: this.clock - this.quiet,
    };
    this.#reset();
    return out;
  }
}
