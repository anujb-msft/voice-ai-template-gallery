// The console's edit, from a capture's timeline.json (src/capture.mjs) to film
// seconds: which stretches of footage to keep, when every line is heard, where
// the camera looks, and the captions. Pure functions, no I/O.

export const FPS = 30;

export const EDIT = {
  maxGap: 0.8, // stillness longer than this is cut down...
  keep: 0.35, // ...to this much either side of the cut
  lead: 0.5, // footage before the first beat
  tail: 1.2, // footage after the last beat ends
  pad: {
    speak: [0.25, 0.35],
    narrate: [0.3, 0.35],
    content: [0.1, 0.6],
    state: [0.05, 0.3],
    beat: [0.2, 1.2],
    step: [0.25, 0.5],
  },
  skip: [0.2, 0.35], // a skip starts this long before its first step, and ends this long before what follows
};

export const CAMERA = {
  aspect: 9 / 16,
  close: 960, // CSS px across a close-up: one footage pixel per film pixel at DPR 2
  pad: 28,
  safe: 0.83, // share of the frame (from the top) kept clear of the subtitles
  band: 110, // CSS px above the console where each chapter's title sits
  side: 60, // CSS px of margin either side of the console in the "top" shot
  minHold: 2.2, // seconds a shot holds before the camera moves again
  move: 1.0, // seconds per camera move
  wideMove: 1.6, // ...to or from a wide shot
  lead: 0.35, // a move starts this long before what it shows
  opening: 2.4, // the establishing shot holds this long
  drift: 1.025, // slow push-in over a long hold
};

const round = (t) => Math.round(t * FPS) / FPS;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Every line heard in the console (agent, caller, narrator), with the beat it belongs to. */
export function spokenLines(timeline) {
  const cuts = timeline.events.filter((e) => e.kind === "cut");
  const lines = [];
  let beat = 0;
  for (const e of timeline.events) {
    if (e.kind === "beat") beat = e.beat;
    if (e.kind !== "speak" && e.kind !== "narrate") continue;
    let end = e.t + e.ms / 1000;
    const cut = cuts.find((c) => c.key === e.key && c.t >= e.t && c.t < end);
    if (cut) end = cut.t;
    lines.push({
      kind: e.kind,
      role: e.role,
      speaker: e.speaker,
      voice: e.voice,
      lang: e.lang ?? "en-US",
      text: e.text,
      key: e.key,
      start: e.t,
      end,
      ms: e.ms,
      cut: Boolean(cut),
      beat: e.beat ?? beat,
      part: e.part ?? null,
    });
  }
  return lines;
}

/**
 * A beat's `skip` as inclusive step ranges: `2` is steps 1–2, `[3, 4]` steps 3–4,
 * and a list such as `[[1, 1], [8, 8]]` makes one jump per range. Empty when it skips nothing.
 */
export function skipSteps(spec) {
  if (spec == null || spec === false) return [];
  const list = Array.isArray(spec) && spec.some(Array.isArray) ? spec : [spec];
  return list.map((s) => {
    const [from, to] = Array.isArray(s) ? s : [1, s];
    return { from, to };
  });
}

/** The card for a beat's nth jump: `skipLabel` is one label for every jump, or one per jump. */
export function skipLabel(beat, n) {
  const label = Array.isArray(beat?.skipLabel) ? beat.skipLabel[n] : beat?.skipLabel;
  return label ?? null;
}

/**
 * Footage a film jumps past (a later call's greeting, say): for each range in a
 * filmed beat's `skip`, from just before its first skipped step to just before
 * whatever follows the last (the next narration, step or the beat's end). The
 * skipped steps still run, so the console shows their result after the jump.
 * Returns [{from, to, beat, label}] in footage seconds.
 */
export function skipRanges(timeline, film, opts = EDIT) {
  const pad = opts.skip ?? EDIT.skip;
  const ev = timeline.events;
  const out = [];
  ev.forEach((e, i) => {
    if (e.kind !== "beat") return;
    const beat = film.beats?.[e.beat];
    const ranges = skipSteps(beat?.skip);
    if (!ranges.length) return;
    let end = ev.findIndex((x, j) => j > i && x.kind === "beat-end");
    if (end < 0) end = ev.length;
    const body = ev.slice(i + 1, end);
    ranges.forEach((skip, n) => {
      const first = body.find((x) => x.kind === "step" && x.step === skip.from);
      const last = body.findLast((x) => x.kind === "step" && x.step <= skip.to);
      if (!first || !last || (last.through ?? last.step) !== skip.to) {
        throw new Error(`${film.id}: beat ${e.beat} skips steps ${skip.from}–${skip.to}, which must start and end on whole presses (check.mjs prints them)`);
      }
      const next = body.slice(body.indexOf(last) + 1).find((x) => x.kind === "narrate" || x.kind === "step" || x.kind === "beat-done") ?? ev[end];
      const from = Math.max(first.t - pad[0], e.t);
      const to = (next?.t ?? timeline.duration) - pad[1];
      if (to - from > 1) out.push({ from, to, beat: e.beat, label: skipLabel(beat, n) });
    });
  });
  return out;
}

const skipped = (skips, t) => skips.some((s) => t >= s.from && t < s.to);

/** Segments [[a, b]] minus holes [{from, to}]. */
function subtract(segments, holes) {
  let out = segments;
  for (const { from: ha, to: hb } of holes) {
    out = out.flatMap(([a, b]) => {
      if (hb <= a || ha >= b) return [[a, b]];
      return [ha > a ? [a, ha] : null, hb < b ? [hb, b] : null].filter(Boolean);
    });
  }
  return out;
}

function merge(intervals) {
  const sorted = intervals.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * The footage the film keeps: everything where something is heard or changes,
 * with long stillness (the console settling, the narrator's breath) cut down,
 * and any `skips` (from skipRanges) jumped past.
 * Returns frame-aligned segments [{from, to, at}] in footage seconds, `at` being
 * where each starts in the edited console.
 */
export function keepSegments(timeline, opts = EDIT) {
  const { maxGap, keep, lead, tail, pad, skips = [] } = { ...EDIT, ...opts };
  const ev = timeline.events;
  const first = ev.find((e) => e.kind === "beat");
  const last = ev.findLast((e) => e.kind === "beat-end") ?? ev.findLast((e) => e.kind === "end");
  if (!first || !last) throw new Error("timeline has no beats");
  const from = Math.max(0, first.t - lead);
  const to = Math.min(timeline.duration - 0.05, last.t + tail);

  const busy = [];
  for (const line of spokenLines(timeline)) busy.push([line.start - pad[line.kind][0], line.end + pad[line.kind][1]]);
  for (const e of ev) {
    if (e.kind === "activity") {
      const p = e.change === "content" ? pad.content : pad.state;
      busy.push([e.t - p[0], e.t + p[1]]);
    } else if (pad[e.kind] && (e.kind === "beat" || e.kind === "step")) busy.push([e.t - pad[e.kind][0], e.t + pad[e.kind][1]]);
  }
  const spans = merge(busy.map(([a, b]) => [Math.max(a, from), Math.min(b, to)]));

  // Keep [from, to] minus the middle of every long gap between busy spans.
  const cuts = [];
  let cursor = from;
  for (const [a, b] of [...spans, [to, to]]) {
    if (a - cursor > maxGap) cuts.push([cursor + keep, a - keep]);
    cursor = Math.max(cursor, b);
  }
  const segments = [];
  let start = from;
  for (const [a, b] of cuts) {
    segments.push([start, a]);
    start = b;
  }
  segments.push([start, to]);

  let at = 0;
  return subtract(segments, skips)
    .map(([a, b]) => [round(a), round(b)])
    .filter(([a, b]) => b - a >= 1 / FPS)
    .map(([a, b]) => {
      const seg = { from: a, to: b, at: round(at) };
      at += b - a;
      return seg;
    });
}

/** Footage seconds to edited-console seconds (a moment inside a cut lands on the cut). */
export function timeMap(segments) {
  const length = segments.length ? segments.at(-1).at + (segments.at(-1).to - segments.at(-1).from) : 0;
  const map = (t) => {
    for (const s of segments) {
      if (t < s.from) return s.at;
      if (t <= s.to) return s.at + (t - s.from);
    }
    return length;
  };
  return map;
}

export const editedLength = (segments) => (segments.length ? round(segments.at(-1).at + segments.at(-1).to - segments.at(-1).from) : 0);

/** ffmpeg select expression (by frame) that keeps the segments. */
export function selectExpression(segments) {
  return segments.map((s) => `between(n\\,${Math.round(s.from * FPS)}\\,${Math.round(s.to * FPS) - 1})`).join("+");
}

/** Chapter marks: one per filmed beat, in edited-console seconds. */
export function chapters(timeline, map) {
  const total = timeline.beats.length;
  return timeline.events
    .filter((e) => e.kind === "beat")
    .map((e, i) => ({ number: e.beat, index: i + 1, total, title: e.title, at: map(e.t) }));
}

// ---------------------------------------------------------------- the camera

/** Where each console region is at a moment: its last measured box, grown by any content seen in it since. */
function regionTracker(timeline) {
  const snaps = [{ t: -Infinity, regions: timeline.layout?.regions ?? {} }];
  for (const l of timeline.layouts ?? []) {
    const end = timeline.events.find((e) => e.kind === "beat-end" && e.beat === l.beat);
    snaps.push({ t: end ? end.t : Infinity, regions: l.layout.regions });
  }
  const content = timeline.events.filter((e) => e.kind === "activity" && e.change === "content" && e.rect);
  const beatStart = (t) => timeline.events.findLast((e) => e.kind === "beat" && e.t <= t)?.t ?? -Infinity;

  return {
    names: () => Object.keys(Object.assign({}, ...snaps.map((s) => s.regions))),
    at(name, t) {
      const snap = snaps.findLast((s) => s.t <= t && s.regions[name]) ?? snaps.find((s) => s.regions[name]);
      let box = snap ? { ...snap.regions[name] } : null;
      for (const e of content) {
        if (e.region !== name || e.t > t || (snap && e.t < snap.t)) continue;
        const r = e.rect;
        if (!box) box = { x: r.x - 20, y: r.y - 20, w: r.w + 40, h: r.h + 40 };
        const bottom = Math.max(box.y + box.h, r.y + r.h + 20);
        box.h = bottom - box.y;
      }
      return box;
    },
    /** The newest content in a region this beat: the line just spoken, the row just added. */
    latest(name, t) {
      const since = beatStart(t);
      return content.findLast((e) => e.region === name && e.t <= t && e.t >= since)?.rect ?? null;
    },
  };
}

const union = (boxes) => {
  const list = boxes.filter(Boolean);
  if (!list.length) return null;
  const x = Math.min(...list.map((b) => b.x));
  const y = Math.min(...list.map((b) => b.y));
  return { x, y, w: Math.max(...list.map((b) => b.x + b.w)) - x, h: Math.max(...list.map((b) => b.y + b.h)) - y };
};

/**
 * The camera's plan for the edited console: moves [{at, dur, shot, why}] in
 * edited seconds, where a shot is the console box in view {x, y, w} (CSS px,
 * 16:9, y down from the page top; it may extend past the page).
 *
 * Defaults: an establishing shot of the whole console, the top of the console
 * (with the chapter title above it) as each beat starts, and the call grid
 * whenever someone speaks out of view. A film steers the rest per beat with
 * `beats[n].shots`, keyed by the narration part or step it accompanies:
 *   shots: { "post 2": "decision", "cue 3": "teams", after: "call@bottom", "step 4": "grid" }
 * A shot is "full" | "top" | "grid" | "trail" | "metrics" | a card name
 * ("call", "decision", "teams", ...) framed from its top, "<card>@bottom"
 * framed down to its newest content, "a+b" (both cards), or {x, y, w}.
 * A trailing "!" (or `hold: true` on a box) holds the shot while people speak,
 * until the film's next shot: for a long reply read off a card in view.
 *
 * Close-ups keep their subject in the top `safe` share of the frame, clear of
 * the subtitles.
 */
export function cameraPlan({ timeline, film, map, length, skips = [], opts = {} }) {
  const o = { ...CAMERA, ...opts };
  const W = timeline.viewport.width;
  const H = timeline.viewport.height;
  const A = o.aspect;
  const S = o.safe;
  const regions = regionTracker(timeline);
  const grid = timeline.layout?.regions?.grid ?? { x: 20, y: 270, w: W - 40, h: 800 };

  // A wide shot of the whole console, centred or (for the opening) set right of a caption.
  const wide = (name, right = 0) => {
    const margin = 70;
    const w = Math.max(W * 1.2, (H + margin * 2) / A);
    const x = right ? W - (w * (1920 - right)) / 1920 : (W - w) / 2;
    return { x, y: (H - w * A) / 2, w, name };
  };
  const named = {
    establish: () => wide("establish", 120),
    full: () => wide("full"),
    top: () => ({ x: -o.side, y: -o.band, w: W + o.side * 2, name: "top" }),
  };
  const clampShot = (s) => ({ ...s, x: clamp(s.x, 0, Math.max(0, W - s.w)), y: clamp(s.y, 0, Math.max(0, H - s.w * A)) });

  // A close-up: as wide as the subject (at least o.close), on the side of the console it lives on.
  function frame(box, { align = "top", side = null, newest = null } = {}) {
    const w = clamp(Math.max(o.close, box.w + o.pad * 2), o.close, W);
    const hs = w * A * S;
    let x;
    if (w >= W - 1) x = 0;
    else {
      const inLeft = box.x + box.w <= w - 4;
      const inRight = box.x >= W - w + 4;
      if (inLeft && inRight) x = side === "right" ? W - w : side === "left" ? 0 : box.x + box.w / 2 < W / 2 ? 0 : W - w;
      else if (inLeft) x = 0;
      else if (inRight) x = W - w;
      else x = box.x + box.w / 2 - w / 2;
    }
    let y;
    if (box.h + o.pad * 2 <= hs) y = box.y + box.h / 2 - hs / 2;
    else if (align === "bottom" && newest) y = Math.max(box.y - o.pad, newest.y + newest.h + o.pad - hs);
    else if (align === "bottom") y = box.y + box.h + o.pad - hs;
    else y = box.y - o.pad;
    return clampShot({ x, y, w });
  }

  function resolve(spec, t, current) {
    if (spec && typeof spec === "object") return { ...clampShot(spec), name: spec.name ?? "custom" };
    const name = String(spec).replace(/!$/, "");
    if (named[name]) return named[name]();
    if (name === "grid") return { ...clampShot({ x: 0, y: grid.y - 16, w: W }), name };
    const side = current && current.x >= 0 && current.w < W - 1 ? (current.x <= 1 ? "left" : "right") : null;
    if (name === "trail" || name === "metrics") {
      const r = regions.at(name, t);
      const newest = regions.latest(name, t);
      if (!r && !newest) return null;
      const bottom = Math.max(r ? r.y + r.h : 0, newest ? newest.y + newest.h : 0) + 24;
      // These sit at the foot of the page, so the frame may run past it (into the subtitle band) to keep them clear.
      const y = clamp(bottom - W * A * S, 0, Math.max(0, H - W * A) + W * A * (1 - S));
      return { x: 0, y, w: W, name };
    }
    const [cards, align = "top"] = name.split("@");
    const list = cards.split("+");
    const card = union(list.map((c) => regions.at(c, t)));
    if (!card) return null;
    if (align === "bottom") {
      const newest = union(list.map((c) => regions.latest(c, t)));
      const box = newest ? { ...card, h: Math.max(card.h, newest.y + newest.h - card.y) } : card;
      return { ...frame(box, { align: "bottom", side, newest }), name };
    }
    return { ...frame(card, { align, side }), name };
  }

  // Whether a shot shows a box (inside the subtitle-safe part of the frame).
  const sees = (shot, box) =>
    Boolean(box && shot) &&
    box.x >= shot.x - 2 &&
    box.x + box.w <= shot.x + shot.w + 2 &&
    box.y >= shot.y - 2 &&
    box.y + box.h <= shot.y + shot.w * A * S + 2;
  const same = (a, b) =>
    a && b && Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) < 0.04 * a.w && Math.abs(a.y - b.y) < 0.04 * a.w && Math.abs(a.w - b.w) / a.w < 0.06;

  // What the film asks for, moment by moment (footage seconds); nothing is framed in footage the film skips.
  const wants = [];
  const want = (t, spec, why, priority = 1) => (priority < 3 && skipped(skips, t)) || wants.push({ t, spec, why, priority });
  let beat = 0;
  let firstStep = false;
  for (const e of timeline.events) {
    const shots = film.beats?.[beat]?.shots ?? {};
    if (e.kind === "beat") {
      beat = e.beat;
      firstStep = true;
      want(e.t, film.beats?.[beat]?.shots?.intro ?? "top", `beat ${beat}`, 3);
    } else if (e.kind === "step") {
      const key = `step ${e.step}`;
      if (shots[key]) want(e.t, shots[key], key, 2);
      else if (firstStep) want(e.t, "grid", key, 1);
      firstStep = false;
    } else if (e.kind === "speak") {
      want(e.t, "speech", `${e.role} speaks`, 1);
    } else if (e.kind === "narrate" && e.part && e.part !== "intro" && shots[e.part]) {
      want(e.t, shots[e.part], e.part, 2);
    } else if (e.kind === "beat-done" && shots.done) {
      want(e.t, shots.done, "done", 2);
    }
  }

  const moves = [{ at: 0, dur: 0, shot: named.establish(), why: "establishing" }];
  let current = moves[0].shot;
  let readyAt = o.opening;
  let hold = false;
  for (const w of wants) {
    const at = map(w.t);
    let shot;
    if (w.spec === "speech") {
      if (hold) continue;
      const call = regions.latest("call", w.t) ?? regions.at("call", w.t);
      if (current.name !== "establish" && current.name !== "top" && sees(current, call)) continue;
      shot = resolve("grid", w.t, current);
    } else {
      shot = resolve(w.spec, w.t, current);
      hold = Boolean(shot) && (typeof w.spec === "string" ? w.spec.endsWith("!") : Boolean(w.spec?.hold));
    }
    if (!shot || same(shot, current)) continue;
    const isWide = (s) => s.name === "establish" || s.name === "full";
    const dur = isWide(shot) || isWide(current) ? o.wideMove : o.move;
    let start = Math.max(at - o.lead, readyAt);
    if (start > at + 3 && w.priority < 2) continue; // the moment has passed
    const prev = moves.at(-1);
    start = Math.max(start, prev.at + prev.dur);
    moves.push({ at: round(start), dur, shot, why: w.why });
    current = shot;
    readyAt = start + dur + o.minHold;
  }
  // Pull back out as the console ends.
  const endStart = Math.max(length - o.wideMove - 0.4, moves.at(-1).at + moves.at(-1).dur + 0.5);
  if (endStart + o.wideMove <= length + 0.01) moves.push({ at: round(endStart), dur: o.wideMove, shot: named.full(), why: "closing" });
  return moves.map((m) => ({ ...m, shot: { x: Math.round(m.shot.x), y: Math.round(m.shot.y), w: Math.round(m.shot.w), name: m.shot.name } }));
}

// --------------------------------------------------------------- captions

const CLAUSE = /(?<=[,;:—–])\s+|\s+(?=—)|\s+(?=(?:and|but|so|or|because|then|which|where|while)\s)/g;

function splitLong(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const mid = text.length / 2;
  let best = -1;
  for (const m of text.matchAll(CLAUSE)) {
    if (m.index < 12 || text.length - m.index < 12) continue;
    if (best < 0 || Math.abs(m.index - mid) < Math.abs(best - mid)) best = m.index;
  }
  if (best < 0) {
    for (const m of text.matchAll(/\s+/g)) {
      if (best < 0 || Math.abs(m.index - mid) < Math.abs(best - mid)) best = m.index;
    }
  }
  if (best < 0) return [text];
  return [...splitLong(text.slice(0, best).trim(), maxChars), ...splitLong(text.slice(best).trim(), maxChars)];
}

/** A line as caption-sized chunks: sentences, split at clauses when long. */
export function chunkText(text, maxChars = 84) {
  // A sentence ends at . ! ? … followed by a space, so "0.75" and "7:30" stay whole.
  const sentences = String(text).match(/.+?(?:[.!?…]+["”’)]*(?=\s|$)|$)/gs) ?? [String(text)];
  const chunks = [];
  for (const s of sentences.map((x) => x.trim()).filter(Boolean)) {
    const prev = chunks.at(-1);
    if (prev && prev.length + s.length + 1 <= maxChars && (prev.length < 26 || s.length < 26)) chunks[chunks.length - 1] = `${prev} ${s}`;
    else chunks.push(...splitLong(s, maxChars));
  }
  return chunks;
}

/**
 * Caption cues for heard lines [{at, end, text, speaker, role}] (film seconds):
 * each line's chunks share its duration in proportion to their length.
 */
export function captionCues(lines, { gap = 0.08, minDur = 0.9 } = {}) {
  const cues = [];
  for (const line of lines) {
    const chunks = chunkText(line.text);
    const total = chunks.reduce((n, c) => n + c.length + 8, 0);
    let t = line.at;
    const span = Math.max(line.end - line.at, minDur);
    chunks.forEach((text, i) => {
      const d = (span * (text.length + 8)) / total;
      cues.push({ at: t, end: i === chunks.length - 1 ? line.at + span : t + d, text, speaker: line.speaker, role: line.role });
      t += d;
    });
  }
  cues.sort((a, b) => a.at - b.at);
  for (let i = 0; i < cues.length - 1; i++) {
    const next = cues[i + 1];
    if (cues[i].end > next.at - gap) cues[i].end = Math.max(cues[i].at + 0.3, next.at - gap);
    // Hold a short cue on screen a little longer when nothing follows at once.
    if (cues[i].end - cues[i].at < minDur && next.at - cues[i].at > minDur + gap) cues[i].end = cues[i].at + minDur;
  }
  return cues;
}

const stamp = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = String(Math.floor(ms / 3_600_000)).padStart(2, "0");
  const m = String(Math.floor(ms / 60_000) % 60).padStart(2, "0");
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, "0");
  return `${h}:${m}:${s}.${String(ms % 1000).padStart(3, "0")}`;
};

export function webvtt(cues) {
  const body = cues.map((c, i) => {
    const who = c.role === "narrator" ? "Narrator" : c.speaker;
    return `${i + 1}\n${stamp(c.at)} --> ${stamp(c.end)}\n<v ${who}>${c.text}`;
  });
  return `WEBVTT\n\n${body.join("\n\n")}\n`;
}
