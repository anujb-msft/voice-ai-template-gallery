import assert from "node:assert/strict";
import { test } from "node:test";
import { BYTES_PER_MS, FRAME_BYTES, FRAME_MS, Segmenter, durationMs, rms, silence, toFrames, wav } from "../src/audio.mjs";

/** A square wave whose RMS is exactly `amp`. */
function tone(ms, amp = 3000) {
  const pcm = Buffer.alloc(ms * BYTES_PER_MS);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(i % 2 ? amp : -amp, i * 2);
  return pcm;
}

const feed = (seg, pcm, opts) => toFrames(pcm).map((f) => seg.push(f, opts)).filter(Boolean);

test("pcm helpers", () => {
  assert.equal(FRAME_BYTES, FRAME_MS * BYTES_PER_MS);
  assert.equal(rms(tone(20, 1234)), 1234);
  assert.equal(rms(silence(20)), 0);
  assert.equal(rms(Buffer.alloc(0)), 0);
  assert.equal(durationMs(silence(100)), 100);
  assert.equal(silence(100).length % 2, 0);
  const frames = toFrames(silence(50));
  assert.equal(frames.length, 3);
  assert.ok(frames.every((f) => f.length === FRAME_BYTES), "the last frame is padded");
});

test("wav wraps 16-bit mono pcm in a RIFF header", () => {
  const pcm = tone(10);
  const out = wav(pcm);
  assert.equal(out.length, 44 + pcm.length);
  assert.equal(out.toString("ascii", 0, 4), "RIFF");
  assert.equal(out.readUInt32LE(4), 36 + pcm.length);
  assert.equal(out.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(out.readUInt16LE(22), 1, "mono");
  assert.equal(out.readUInt32LE(24), 24000);
  assert.equal(out.readUInt16LE(34), 16, "bits per sample");
  assert.equal(out.toString("ascii", 36, 40), "data");
  assert.equal(out.readUInt32LE(40), pcm.length);
  assert.ok(out.subarray(44).equals(pcm));
});

test("Segmenter returns one utterance, with pre-roll, after the far end goes quiet", () => {
  const seg = new Segmenter();
  assert.deepEqual(feed(seg, silence(500)), []);
  const started = feed(seg, tone(1000));
  assert.equal(started.length, 1);
  // Speech began at 500 ms; the utterance keeps 200 ms of pre-roll before it.
  assert.deepEqual(started[0], { type: "start", at: 300 });
  const ended = feed(seg, silence(1000));
  assert.equal(ended.length, 1);
  const [u] = ended;
  assert.equal(u.type, "end");
  assert.equal(u.startAt, 300);
  assert.equal(u.endAt, 1500, "ends where the speech stopped, not where silence was detected");
  assert.equal(durationMs(u.pcm), 1500 + 700 - 300);
  assert.equal(seg.flush(), null, "nothing left open");
});

test("Segmenter ignores clicks, quiet noise, and audio marked silent", () => {
  const seg = new Segmenter();
  assert.deepEqual(feed(seg, tone(40)), [], "shorter than startMs");
  assert.deepEqual(feed(seg, silence(100)), []);
  assert.deepEqual(feed(seg, tone(1000, 200)), [], "below the threshold");
  assert.deepEqual(feed(seg, tone(1000), { silent: true }), [], "e.g. while the harness itself is talking");
  assert.equal(seg.lastLoud, false);
  assert.equal(seg.active, false);
});

test("Segmenter ends a pause-free monologue at maxMs, and flush closes an open utterance", () => {
  const seg = new Segmenter({ maxMs: 1000 });
  const out = feed(seg, tone(1500));
  assert.deepEqual(
    out.map((e) => e.type),
    ["start", "end", "start"],
  );
  assert.equal(out[1].endAt - out[1].startAt, 1000);
  assert.equal(seg.lastLoud, true);
  const last = seg.flush();
  assert.equal(last.type, "end");
  assert.ok(durationMs(last.pcm) > 0);
  assert.equal(seg.flush(), null);
});
