// Preloaded into a staged template server (node --import): randomUUID() and
// randomInt() come from fixed seeds, so a server makes the same ids and codes
// on every capture pass. Both can reach a spoken line (the on-call pager's
// voicemail reads out a reference derived from its incident id; the password
// reset reads out its one-time code), and a line that changes between passes
// is never in the voice cache, so the capture could never settle.
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

// mulberry32; one stream per function, so a template that starts drawing
// codes doesn't shift the ids another film already speaks.
function stream(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}
const ids = stream(0x5eed);
const ints = stream(0xc0de);

crypto.randomUUID = () => {
  const hex = Array.from({ length: 4 }, () => ids().toString(16).padStart(8, "0")).join("");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
};

// randomInt([min, ]max[, callback]), min inclusive and max exclusive, as node:crypto's.
crypto.randomInt = (a, b, c) => {
  const [min, max, callback] = typeof b === "number" ? [a, b, c] : [0, a, b];
  const n = min + Math.floor((ints() / 2 ** 32) * (max - min));
  if (typeof callback !== "function") return n;
  process.nextTick(callback, null, n);
};
syncBuiltinESMExports();
