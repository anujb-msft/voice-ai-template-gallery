// The overview reel (reel/<id>.mjs): one short film across the templates, cut from
// the console footage their own films recorded. A product-film look: a black stage,
// each console in a floating device, kinetic type, and an original score under the voices.
//
//   1. loads each clip's composed film (films/<id>/film.json and its edited footage)
//      and finds its segments' lines, trimmed at the pauses between sentences;
//   2. lays every take, card and narrator line on one clock, and the score's sections on it;
//   3. cuts each take from the edited footage, cropped to what the film's camera sees;
//   4. writes the HyperFrames page, lints it and renders it silently;
//   5. mixes the call lines, the narrator and the score, masters it and muxes <id>.mp4;
//   6. writes poster.webp, share.jpg, hero.webp, captions.vtt, transcript.md, README.md
//      and reel.json.
//
// Every film must be composed first (npm run compose -- <id> --no-render is enough).
//
// usage: node src/reel.mjs [id] [--films DIR] [--captures DIR] [--repo DIR] [--out DIR]
//          [--snap t1,t2|auto] [--no-render] [--draft] [--no-music] [--crf N] [--force] [--workers N]
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GSAP, HYPERFRAMES, WORK, clock, planFilm, r3, sh, sha } from "./compose.mjs";
import { chunkText, selectExpression, webvtt } from "./edit.mjs";
import { loadFilm } from "./film.mjs";
import { API_VERSION, MODEL } from "./realtime.mjs";
import { Ops, SITE, TEAMS, esc } from "./scenes.mjs";
import { BAR, score } from "./score.mjs";
import { LOUDNESS, RATE, master, mix, prepareClip, ringBurst } from "./soundtrack.mjs";
import { VoiceBank } from "./voices.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");

const FPS = 30;
const fr = (t) => Math.round(t * FPS) / FPS;
const frameUp = (t) => Math.ceil(t * FPS - 1e-6) / FPS;
const frameDown = (t) => Math.floor(t * FPS + 1e-6) / FPS;
const even = (n) => 2 * Math.round(n / 2);
/** Element starts and tween times both floor to the millisecond, so nothing shows a frame before its fade. */
const at3 = (t) => Math.floor(t * 1000 + 1e-6) / 1000;
const timed = (from, to) => `data-start="${at3(from)}" data-duration="${r3(at3(to) - at3(from))}"`;

/** The device's screen; K scales the films' 1920-wide framing into it. */
const VIEW = { w: 1312, h: 738 };
const K = VIEW.w / 1920;
/** Seconds: cross-fades between clips and between one clip's segments, footage before and after the lines. */
const XFADE = { clip: 0.3, segment: 0.2 };
const LEAD = { first: 1.0, other: 0.5 };
const TAIL = 0.6;
const RING = [0.25, 1.85];
const OPEN_AT = 0.4;
/** The score sits well under the voices and ducks further while anyone speaks. */
const BED = { lufs: -22, duck: { call: -12, vo: -10 }, merge: 1.2, attack: 0.15, release: 0.6 };
/** CRF 26 (not the films' 28): the console is smaller in the frame, so its text needs the extra bits. */
const ENCODE = { crf: 26, preset: "veryslow", x264: "aq-mode=3", audio: "192k" };
const CLIP_VERSION = 1;

/** The films' ops, with times floored like the element starts (see at3). */
class ReelOps extends Ops {
  set(target, vars, at) {
    super.set(target, vars, at3(at));
  }
  tween(target, from, to, at) {
    super.tween(target, from, to, at3(at));
  }
}

/**
 * Type arrives soft and rises into focus; it leaves the same way, quicker. The blur is
 * cleared as each move ends: the runtime only hides timed elements (visibility), and a
 * page with dozens of filtered elements can capture black frames.
 */
function arrive(ops, target, at, { dur = 0.7, y = 24 } = {}) {
  ops.tween(target, { opacity: 0, y, filter: "blur(12px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: dur, ease: "power3.out" }, at);
  ops.set(target, { filter: "none" }, at + dur);
}
function depart(ops, target, at, { dur = 0.4 } = {}) {
  ops.tween(target, { opacity: 1, y: 0, filter: "blur(0px)" }, { opacity: 0, y: -12, filter: "blur(8px)", duration: dur, ease: "power2.in" }, at);
  ops.set(target, { filter: "none" }, at + dur);
}

/** Segoe UI Variable, bundled into the page when this machine has it (the films resolve it through fontconfig). */
const FONT = "SegUIVar.ttf";
function findFont() {
  const home = homedir();
  return [
    process.env.REEL_FONT,
    join(home, ".local", "share", "fonts", "windows", FONT),
    join(home, ".local", "share", "fonts", FONT),
    join(home, "Library", "Fonts", FONT),
    join("/Library", "Fonts", FONT),
    join("/mnt", "c", "Windows", "Fonts", FONT),
    process.env.WINDIR && join(process.env.WINDIR, "Fonts", FONT),
  ].find((p) => p && existsSync(p));
}

// ------------------------------------------------------------------ sources

/** A composed film's footage, camera and heard lines (edited-console seconds). */
async function loadSource(id, { films, captures, repo, bank }) {
  const film = await loadFilm(id);
  const template = JSON.parse(await readFile(join(repo, "docs", "templates", id, "template.json"), "utf8"));
  const timeline = JSON.parse(await readFile(join(captures, id, "timeline.json"), "utf8"));
  const dir = join(films, id);
  const again = `compose it again (npm run compose -- ${id} --no-render)`;
  const saved = JSON.parse(
    await readFile(join(dir, "film.json"), "utf8").catch(() => {
      throw new Error(`${id}: no composed film in ${dir}: ${again}`);
    }),
  );
  const plan = await planFilm({ film, template, timeline, bank, log: () => {} });
  const c = plan.console;
  const video = join(dir, "project", "edited.mp4");
  const footage = await stat(join(captures, id, "footage.mp4"));
  const key = sha([1, footage.size, Math.round(footage.mtimeMs), selectExpression(plan.audio.segments)]).slice(0, 16);
  const edited = await readFile(join(dir, "project", "edited.key"), "utf8").catch(() => "");
  if (!existsSync(video) || edited !== key || Math.abs(saved.console.start - c.start) > 1e-3 || Math.abs(saved.console.length - c.length) > 1e-3)
    throw new Error(`${id}: the composed film is out of date with its script or capture: ${again}`);
  const probe = JSON.parse((await sh("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", video])).out);
  const v = probe.streams?.[0] ?? {};
  if (v.width !== c.width || v.height !== c.height || v.r_frame_rate !== "30/1")
    throw new Error(`${id}: edited.mp4 is ${v.width}×${v.height} at ${v.r_frame_rate}; expected ${c.width}×${c.height} at 30/1: ${again}`);
  const lines = plan.audio.heard.map((l) => ({ ...l, from: r3(l.at - c.start), to: r3(l.end - c.start) })).sort((a, b) => a.from - b.from);
  return {
    id,
    film,
    template,
    c,
    video,
    info: await stat(video),
    name: template.name,
    accent: template.colors.accent,
    bg: template.colors.bg,
    lines,
    calls: lines.filter((l) => l.role !== "narrator"),
    bank,
  };
}

const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The first call line at or after index `after` that starts with `opening`. */
function findLine(src, opening, after, tag) {
  const want = norm(opening);
  const i = src.calls.findIndex((l, k) => k >= after && norm(l.text).startsWith(want));
  if (i >= 0) return i;
  const near = src.calls
    .slice(after)
    .map((l) => `    "${l.text.slice(0, 70)}"`)
    .join("\n");
  throw new Error(`${tag}: no line from #${after} of ${src.id}'s call starts "${opening}". Its lines:\n${near}`);
}

const ABBREVIATION = /\b(?:Dr|Mr|Mrs|Ms|St)$/;
/** A line's sentences as character spans [{ text, from, to }]; "0.75", "a.m. on" and "Dr. Lee" stay whole. */
function sentences(text) {
  const out = [];
  let start = 0;
  for (const m of text.matchAll(/[.!?…]+["”’)]*(?=\s|$)/g)) {
    const end = m.index + m[0].length;
    const rest = text.slice(end).trimStart();
    if (rest && !/^[\p{Lu}¿¡"“'‘]/u.test(rest)) continue;
    if (ABBREVIATION.test(text.slice(start, m.index))) continue;
    out.push({ text: text.slice(start, end).trim(), from: start, to: end });
    start = end;
    while (start < text.length && /\s/.test(text[start])) start++;
  }
  if (text.slice(start).trim()) out.push({ text: text.slice(start).trim(), from: start, to: text.length });
  return out;
}

// ------------------------------------------------------------------ speech

/** Where a clip's speech starts and ends, and its pauses (≥ 120 ms, 34 dB under its peak), in seconds. */
function speechMap(samples) {
  const hop = Math.round(RATE * 0.01);
  const frames = Math.floor(samples.length / hop);
  const db = new Float32Array(frames);
  let peak = -Infinity;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) sum += samples[i] * samples[i];
    db[f] = 10 * Math.log10(sum / hop + 1e-12);
    peak = Math.max(peak, db[f]);
  }
  const loud = (f) => db[f] > peak - 34;
  let first = 0;
  while (first < frames - 1 && !loud(first)) first++;
  let last = frames - 1;
  while (last > first && !loud(last)) last--;
  const pauses = [];
  for (let f = first; f <= last; ) {
    if (loud(f)) {
      f++;
      continue;
    }
    let g = f;
    while (g <= last && !loud(g)) g++;
    if (g - f >= 12) pauses.push({ from: r3(f * 0.01), to: r3(g * 0.01) });
    f = g;
  }
  return { from: r3(first * 0.01), to: r3((last + 1) * 0.01), pauses };
}

const clipCache = new Map();
/** A call line's samples, phone-coloured as the films mix them, with its speech map. */
function callClip(file) {
  if (!clipCache.has(file))
    clipCache.set(
      file,
      prepareClip(file, { band: true, gainDb: -1 }).then((samples) => ({ samples, map: speechMap(samples) })),
    );
  return clipCache.get(file);
}

/** Lines ready to cut: their audio, where their speech is (edited seconds) and their caption. */
function pick(src, lines) {
  return Promise.all(
    lines.map(async (l) => {
      const file = src.bank.file(l.key);
      if (!existsSync(file)) throw new Error(`${src.id}: voice clip ${l.key} for "${l.text.slice(0, 50)}" is missing: capture it again`);
      const { samples, map } = await callClip(file);
      return {
        ...l,
        file,
        samples,
        map,
        offset: 0,
        fadeIn: 0,
        until: l.cut ? r3(l.to - l.from) : null,
        speechFrom: r3(l.from + map.from),
        speechTo: r3(Math.min(l.to, l.from + map.to)),
        caption: l.text,
      };
    }),
  );
}

/**
 * Cut a line in the pause between two sentences: `head` skips its first sentences,
 * `drop` keeps only its first. The pause chosen is the one nearest where the text
 * places the break (speech is assumed to run evenly through the characters).
 */
function trimLine(line, { head = 0, drop = 0 }, tag, log) {
  const parts = sentences(line.text);
  const n = parts.length;
  if (head && head >= n) throw new Error(`${tag}: head ${head} leaves nothing of "${line.text}" (${n} sentence(s))`);
  if (drop && (drop <= head || drop >= n)) throw new Error(`${tag}: drop ${drop} must fall between ${head} and ${n} sentences of "${line.text}"`);
  const { map } = line;
  const pause = (k) => {
    if (!map.pauses.length) throw new Error(`${tag}: no pause in "${line.text.slice(0, 60)}" to cut at`);
    const mid = (parts[k - 1].to + parts[k].from) / 2;
    const est = map.from + (mid / line.text.length) * (map.to - map.from);
    let best = null;
    for (const p of map.pauses) {
      const score = Math.abs((p.from + p.to) / 2 - est) - 0.5 * Math.min(p.to - p.from, 0.5);
      if (!best || score < best.score) best = { ...p, score };
    }
    const miss = Math.abs((best.from + best.to) / 2 - est);
    log(`  ${tag}: cut after "…${parts[k - 1].text.slice(-36)}" in the pause at ${best.from.toFixed(2)}–${best.to.toFixed(2)} s (text puts it near ${est.toFixed(2)} s)`);
    if (miss > 0.8) log(`  WARNING ${tag}: that pause is ${miss.toFixed(1)} s from where the text puts the break; check the cut`);
    return best;
  };
  const out = { ...line };
  if (head) {
    const p = pause(head);
    out.offset = Math.max(0, r3(p.to - 0.06));
    out.fadeIn = 0.02;
    out.speechFrom = r3(line.from + p.to);
  }
  if (drop) {
    const p = pause(drop);
    out.until = r3(Math.min(out.until ?? Infinity, p.from + 0.12, p.to));
    out.speechTo = r3(line.from + p.from);
  }
  out.caption = parts
    .slice(head, drop || n)
    .map((p) => p.text)
    .join(" ");
  return out;
}

// ------------------------------------------------------------------- takes

/**
 * The footage a take shows (edited seconds): `lead` before its first word to `tail`
 * after its last, clear of the film's skips and of the lines either side. When the
 * footage runs out before the lead, the take holds its first frame (`hold`).
 */
function windowOf({ src, lines, lead, tail, prev, next, tag, log }) {
  const c = src.c;
  const speechStart = lines[0].speechFrom;
  const speechEnd = lines.at(-1).speechTo;
  const want = speechStart - lead;
  let a = want;
  let b = speechEnd + tail;
  for (const s of c.skips ?? []) {
    if (s.at >= a && s.at < speechStart) a = s.at + 0.05;
    else if (s.at >= speechEnd - 0.01 && s.at <= b) b = Math.min(b, s.at - 0.04);
    else if (s.at >= speechStart && s.at < speechEnd - 0.01)
      throw new Error(`${tag}: ${src.id}'s skip at ${s.at} s (${s.label ?? `beat ${s.beat}`}) falls inside the segment: split it into two segments`);
  }
  a = Math.max(a, prev ? prev.to + 0.05 : 0, 0);
  b = Math.min(b, next ? next.from - 0.1 : Infinity, c.length);
  if (a > speechStart || b < speechEnd)
    throw new Error(`${tag}: no clean footage around the lines (${a.toFixed(2)}–${b.toFixed(2)} s for speech at ${speechStart}–${speechEnd} s)`);
  const e0 = frameUp(a);
  const end = frameDown(b);
  if (end - e0 < 0.5) throw new Error(`${tag}: only ${(end - e0).toFixed(2)} s of footage`);
  const hold = e0 - want > 0.05 ? fr(e0 - want) : 0;
  const len = fr(hold + end - e0);
  for (const l of src.lines) {
    if (l.role !== "narrator") continue;
    const overlap = Math.min(end, l.to) - Math.max(e0, l.from);
    if (overlap > 0.3) log(`  note: ${tag} shows ${overlap.toFixed(1)} s the film's narrator spoke over ("${l.text.slice(0, 40)}")`);
  }
  return { e0, end, hold, len, speechStart, speechEnd };
}

/** Reel time at which a take shows edited time t. */
const tau = (take, t) => take.R + take.w.hold + (t - take.w.e0);

/** The film camera's transforms for a shot (scenes.mjs rig): scale, and the pan to its centre in footage px. */
function rigOf(shot, c) {
  return { scale: 1920 / (shot.w * c.dpr), x: -(shot.x + shot.w / 2) * c.dpr, y: -(shot.y + (shot.w * 9) / 32) * c.dpr };
}
const lerp = (a, b, p) => a + (b - a) * p;
const between = (a, b, p) => ({ scale: lerp(a.scale, b.scale, p), x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p) });
const EASES = {
  "power2.inOut": (p) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2),
  "power2.out": (p) => 1 - (1 - p) ** 3,
};

/** Where the film's camera is at edited time t: its moves, without the slow drift of long holds. */
function cameraAt(moves, c, t) {
  let state = rigOf(moves[0].shot, c);
  for (const m of moves.slice(1)) {
    if (t <= m.at) break;
    const target = rigOf(m.shot, c);
    const p = Math.min(1, (t - m.at) / m.dur);
    if (p < 1) return between(state, target, EASES["power2.inOut"](p));
    state = target;
  }
  return state;
}

/** One of the film's named shots, or an explicit { x, y, w } region of the console (CSS px). */
function shotOf(src, ref, tag) {
  if (ref && typeof ref === "object") {
    if (![ref.x, ref.y, ref.w].every(Number.isFinite) || ref.w <= 0) throw new Error(`${tag}: a focus region needs numeric x, y and w > 0`);
    return { name: `${ref.x},${ref.y} w${ref.w}`, x: ref.x, y: ref.y, w: ref.w };
  }
  const m = src.c.moves.find((x) => x.shot.name === ref);
  if (!m) throw new Error(`${tag}: ${src.id} has no shot named "${ref}"; its shots are ${[...new Set(src.c.moves.map((x) => x.shot.name))].join(", ")}`);
  return m.shot;
}
const sameRig = (a, b) => Math.abs(a.scale - b.scale) < 1e-6 && Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3;
/** Seconds: a clip opens wide and leans into its focus; a later segment glides on from where the last settled. */
const PUSH = { at: 0.8, dur: 2.6, glide: { at: 0.3, dur: 2.2 } };

/**
 * A take's camera (take seconds). With a focus, the clip's first take opens on `shot`
 * (default "grid", the whole console) and eases into the focus; later takes start where
 * the previous one settled (`prev`) and glide on if their focus differs. Without one: one
 * named shot held still, or the film's moves over its footage.
 */
function takeCamera(src, def, seg, w, prev, tag) {
  const { c } = src;
  const focus = seg.focus ?? def.focus;
  if (focus) {
    const shot = shotOf(src, focus, tag);
    const to = rigOf(shot, c);
    const from = prev ?? rigOf(shotOf(src, def.shot ?? "grid", tag), c);
    if (sameRig(from, to)) return { start: to, tweens: [], end: to, focus: shot.name };
    const at = prev ? PUSH.glide.at : (seg.push ?? PUSH.at);
    const dur = Math.min(prev ? PUSH.glide.dur : PUSH.dur, r3(w.len - at - 0.5));
    if (dur < 1) throw new Error(`${tag}: too short (${w.len.toFixed(2)} s) to ease into its focus from ${at} s`);
    return { start: from, tweens: [{ at, dur, from, to, ease: "power2.inOut" }], end: to, focus: shot.name };
  }
  if (def.shot) return { start: rigOf(shotOf(src, def.shot, tag), c), tweens: [] };
  const start = cameraAt(c.moves, c, w.e0);
  const tweens = [];
  let state = start;
  for (const m of c.moves.slice(1)) {
    const to = rigOf(m.shot, c);
    if (m.at < w.e0 && m.at + m.dur > w.e0) {
      // In flight at the cut: it finishes from where it is, easing out.
      tweens.push({ at: w.hold, dur: r3(m.at + m.dur - w.e0), from: state, to, ease: "power2.out" });
      state = to;
    } else if (m.at >= w.e0 && m.at < w.end) {
      tweens.push({ at: r3(w.hold + m.at - w.e0), dur: m.dur, from: state, to, ease: "power2.inOut" });
      state = to;
    }
  }
  return { start, tweens };
}

function takeCameraAt(cam, t) {
  let state = cam.start;
  for (const tw of cam.tweens) {
    if (t <= tw.at) break;
    const p = Math.min(1, (t - tw.at) / tw.dur);
    state = between(tw.from, tw.to, EASES[tw.ease](p));
    if (p < 1) break;
  }
  return state;
}

/**
 * The footage the take's camera ever sees, plus a margin (even footage px), and the
 * scale `f` it is cut at: enough pixels for the closest framing, with 15% to spare.
 */
function cropOf(cam, c, len) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let sMax = 0;
  for (let t = 0; t <= len + 1e-6; t += 1 / 15) {
    const r = takeCameraAt(cam, t);
    x0 = Math.min(x0, -r.x - 960 / r.scale);
    x1 = Math.max(x1, -r.x + 960 / r.scale);
    y0 = Math.min(y0, -r.y - 540 / r.scale);
    y1 = Math.max(y1, -r.y + 540 / r.scale);
    sMax = Math.max(sMax, r.scale);
  }
  const W = Math.floor(c.width / 2) * 2;
  const H = Math.floor(c.height / 2) * 2;
  const left = Math.max(0, Math.floor((x0 - 48) / 2) * 2);
  const top = Math.max(0, Math.floor((y0 - 48) / 2) * 2);
  const w = Math.min(W, Math.ceil((x1 + 48) / 2) * 2) - left;
  const h = Math.min(H, Math.ceil((y1 + 48) / 2) * 2) - top;
  const f = Math.min(1, Math.ceil(1.15 * K * sMax * 1000) / 1000);
  return { x0: left, y0: top, w, h, f, Wf: even(w * f), Hf: even(h * f) };
}

/** Cut one take from its film's edited footage (cached by what it depends on). */
async function cutTake(take, dir) {
  const { src, w, crop } = take;
  const file = join(dir, take.file);
  const key = sha([CLIP_VERSION, src.id, src.info.size, Math.round(src.info.mtimeMs), w.e0, w.len, w.hold, crop]).slice(0, 16);
  if (existsSync(file) && (await readFile(`${file}.key`, "utf8").catch(() => "")) === key) return key;
  const vf = [`crop=${crop.w}:${crop.h}:${crop.x0}:${crop.y0}`];
  if (crop.f < 1) vf.push(`scale=${crop.Wf}:${crop.Hf}:flags=lanczos`);
  if (w.hold > 0) vf.push(`tpad=start_mode=clone:start_duration=${w.hold}`);
  const tmp = file.replace(/\.mp4$/, ".tmp.mp4");
  await sh("ffmpeg", [
    "-hide_banner", "-nostdin", "-y", "-v", "error", "-ss", String(Math.max(0, r3(w.e0 - 0.001))), "-i", src.video,
    "-t", String(r3(w.len + 0.25)), "-an", "-vf", vf.join(","),
    "-c:v", "libx264", "-preset", "fast", "-crf", "14", "-tune", "animation", "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", tmp,
  ]);
  const dur = Number((await sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", tmp])).out.trim());
  if (!(dur >= w.len - 1 / FPS)) throw new Error(`${take.tag}: cut ${dur} s of footage; the take needs ${w.len} s`);
  await rename(tmp, file);
  await writeFile(`${file}.key`, key);
  return key;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

/** Every clip's takes: their lines, footage window, camera and crop. */
async function resolveReel(reel, ctx, log) {
  const sources = new Map();
  const source = (id) => {
    if (!sources.has(id)) sources.set(id, loadSource(id, ctx));
    return sources.get(id);
  };
  const defs = [
    { def: reel.open, chapter: -1, first: false },
    ...reel.chapters.flatMap((ch, k) => ch.clips.map((def, i) => ({ def, chapter: k, first: i === 0 }))),
  ];
  const clips = [];
  let n = 0;
  for (const { def, chapter, first } of defs) {
    const src = await source(def.film);
    const takes = [];
    let after = 0;
    let settled = null;
    for (const [s, seg] of def.segments.entries()) {
      const tag = `${def.film}#${s + 1}`;
      const i = findLine(src, seg.from, after, tag);
      const j = seg.to ? findLine(src, seg.to, i, tag) : i;
      after = j + 1;
      let lines = await pick(src, src.calls.slice(i, j + 1));
      if (lines.length === 1) {
        if (seg.head || seg.drop) lines = [trimLine(lines[0], seg, tag, log)];
      } else {
        if (seg.head) lines[0] = trimLine(lines[0], { head: seg.head }, tag, log);
        if (seg.drop) lines[lines.length - 1] = trimLine(lines.at(-1), { drop: seg.drop }, tag, log);
      }
      const lead = seg.lead ?? (first && s === 0 ? LEAD.first : LEAD.other);
      const w = windowOf({ src, lines, lead, tail: seg.tail ?? TAIL, prev: src.calls[i - 1], next: src.calls[j + 1], tag, log });
      const cam = takeCamera(src, def, seg, w, settled, tag);
      settled = cam.end ?? null;
      const crop = cropOf(cam, src.c, w.len);
      n++;
      takes.push({ n, tag, src, seg, lines, w, cam, crop, file: `t${String(n).padStart(2, "0")}.mp4` });
      log(
        `  ${tag.padEnd(36)} ${lines.length} line(s) "${lines[0].caption.slice(0, 28)}…" footage ${w.e0.toFixed(2)}–${w.end.toFixed(2)} s` +
          `${w.hold ? `, holds ${w.hold.toFixed(2)} s` : ""}, crop ${crop.w}×${crop.h} at ×${crop.f}${cam.focus ? `, focus ${cam.focus}` : ""}`,
      );
    }
    clips.push({ def, chapter, first, src, takes });
  }
  return clips;
}

/** Chain one appearance of the device: its clips' takes, each starting as the last begins to fade. */
function appear(list, at) {
  const flat = list.flatMap((clip) => clip.takes.map((take) => ({ clip, take })));
  let t = at;
  flat.forEach(({ clip, take }, k) => {
    take.R = fr(t);
    take.fadeIn = k === 0 ? 0 : flat[k - 1].clip === clip ? XFADE.segment : XFADE.clip;
    t = take.R + take.w.len - (flat[k + 1]?.clip === clip ? XFADE.segment : XFADE.clip);
  });
  const appearance = { from: fr(at), clips: list };
  for (const clip of list) {
    clip.R = clip.takes[0].R;
    const last = clip.takes.at(-1);
    clip.end = r3(last.R + last.w.len);
    clip.appearance = appearance;
  }
  appearance.to = list.at(-1).end;
  return appearance;
}

/**
 * The reel's clock: the cold open, then title, chapters, trust and end on a grid of
 * half bars from the title (so the score's sections start on its beat), and the
 * narrator's lines in each.
 */
async function layout(reel, clips, bank, log) {
  const voice = (text) =>
    bank.get({ voice: reel.narrator.voice, style: reel.narrator.style, lang: "en-US", text }).then((v) => {
      if (v.fidelity < 0.8) log(`  note: narration read at fidelity ${v.fidelity.toFixed(2)}: "${v.transcript}"`);
      return { text, file: v.file, key: v.key, dur: v.ms / 1000 };
    });
  const [titleVO, trustVO, endVO] = await Promise.all([reel.title, reel.trust, reel.end].map((s) => Promise.all(s.narration.map(voice))));
  const lay = (vos, at) => {
    let t = at;
    return vos.map((v) => {
      const line = { ...v, at: fr(t), end: r3(fr(t) + v.dur) };
      t = line.end + 0.45;
      return line;
    });
  };

  const open = appear(
    clips.filter((c) => c.chapter === -1),
    OPEN_AT,
  );
  const T0 = fr(open.to + 0.1);
  const snap = (t) => fr(T0 + Math.ceil((t - T0) / (BAR / 2) - 1e-6) * (BAR / 2));
  const titleLines = lay(titleVO, T0 + 0.6);
  const title = { at: T0, end: snap(titleLines.at(-1).end + 1), lines: titleLines };
  const chapters = [];
  let C = title.end;
  for (const [k, ch] of reel.chapters.entries()) {
    const list = clips.filter((c) => c.chapter === k);
    const a = appear(list, C + 1.5);
    chapters.push({ k, card: ch.card, at: C, appearance: a });
    C = snap(a.to + 0.1);
  }
  const trustLines = lay(trustVO, C + 0.5);
  const trust = { at: C, end: snap(trustLines.at(-1).end + 2.4), lines: trustLines };
  const E = trust.end;
  const endLines = lay(endVO, E + 0.9);
  const chord = fr(E + Math.ceil((endLines.at(-1).end + 0.2 - E) / BAR - 1e-6) * BAR);
  const total = fr(chord + 6);
  const end = { at: E, chord, lines: endLines };
  const sections = [
    { kind: "riser", at: r3(T0 - BAR), end: T0 },
    { kind: "intro", at: T0, end: chapters[0].at },
    ...chapters.map((ch, i) => ({ kind: "groove", at: ch.at, end: chapters[i + 1]?.at ?? trust.at, accents: [ch.at] })),
    { kind: "breakdown", at: trust.at, end: E },
    { kind: "finale", at: E, end: total, groove: Math.round((chord - E) / BAR) },
  ];
  return { open, T0, title, chapters, trust, end, total, sections };
}

// -------------------------------------------------------------------- page

const r2 = (n) => Math.round(n * 100) / 100;
const r5 = (n) => Math.round(n * 1e5) / 1e5;
const rgbOf = (hex) =>
  String(hex)
    .replace("#", "")
    .match(/\w\w/g)
    .map((h) => parseInt(h, 16));
const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** A template's accent, lifted toward white until it reads on black. */
function bright(hex) {
  const rgb = rgbOf(hex);
  for (let p = 0; p <= 1.001; p += 0.1) {
    const c = rgb.map((v) => Math.round(v + (255 - v) * p));
    if (lum(c) >= 0.2) return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }
  return "#ffffff";
}
const rgba = (hex, a) => `rgba(${rgbOf(hex).join(",")},${a})`;

/** Caption cues for every call line (reel seconds); translations ride under foreign lines. */
function reelCues(clips) {
  const cues = [];
  for (const clip of clips) {
    const translations = Object.entries(clip.def.translations ?? {}).map(([k, v]) => [norm(k), v]);
    for (const take of clip.takes) {
      for (const line of take.lines) {
        const from = tau(take, line.speechFrom);
        const to = tau(take, line.speechTo);
        const chunks = chunkText(line.caption, 66);
        const weight = chunks.reduce((n, c) => n + c.length + 8, 0);
        const tr = translations.find(([k]) => norm(line.text).startsWith(k))?.[1] ?? null;
        const trParts = tr ? sentences(tr).map((p) => p.text) : [];
        let t = from;
        chunks.forEach((text, i) => {
          const d = ((to - from) * (text.length + 8)) / weight;
          cues.push({
            at: r3(t),
            end: r3(t + Math.max(d, 0.9)),
            text,
            tr: tr ? (trParts.length === chunks.length ? trParts[i] : tr) : null,
            speaker: line.speaker,
            role: line.role,
            who: line.role === "agent" ? "AI agent" : line.speaker,
            template: clip.src.name,
            accent: clip.src.accent,
          });
          t += d;
        });
      }
    }
  }
  cues.sort((a, b) => a.at - b.at);
  for (let i = 0; i < cues.length - 1; i++) {
    const next = cues[i + 1];
    if (cues[i].end > next.at - 0.08) cues[i].end = r3(Math.max(cues[i].at + 0.3, next.at - 0.08));
  }
  return cues;
}

function styles(font) {
  const src = [font && `url("fonts/${FONT}") format("truetype")`, `local("Segoe UI Variable")`].filter(Boolean).join(", ");
  return `
  @font-face { font-family: "Segoe UI Variable"; src: ${src}; font-weight: 300 700; font-style: normal; font-display: block; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { margin: 0; background: #000; }
  #root { position: relative; width: 1920px; height: 1080px; overflow: hidden; background: #000; color: #f5f5f7;
    font-family: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif; font-optical-sizing: auto; -webkit-font-smoothing: antialiased; }
  .clip { position: absolute; inset: 0; }
  .glow { position: absolute; inset: 0; z-index: 1; opacity: 0; background: radial-gradient(64% 76% at 50% 52%, var(--g, transparent), transparent 70%); }
  #stage { position: absolute; inset: 0; z-index: 2; }
  #push { position: absolute; inset: 0; perspective: 1800px; transform-origin: 960px 543px; }
  #device { position: absolute; left: 292px; top: 162px; width: 1336px; height: 762px; padding: 12px; border-radius: 30px; opacity: 0;
    transform-origin: 50% 100%; background: linear-gradient(180deg, #3a3a3e, #1c1c1f 40%, #141416);
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.14), inset 0 1px 0 rgba(255,255,255,.22), 0 0 0 1px rgba(0,0,0,.9), 0 50px 120px rgba(0,0,0,.75); }
  #screen { position: relative; width: ${VIEW.w}px; height: ${VIEW.h}px; border-radius: 18px; overflow: hidden; background: #000; }
  .take { position: absolute; inset: 0; opacity: 0; }
  .cam { position: absolute; left: ${VIEW.w / 2}px; top: ${VIEW.h / 2}px; transform-origin: 0 0; }
  .pan { position: absolute; left: 0; top: 0; }
  .footage.clip { right: auto; bottom: auto; display: block; object-fit: fill; }
  .label.clip { z-index: 3; }
  .label .eb { position: absolute; left: 0; right: 0; top: 46px; text-align: center; font-size: 24px; font-weight: 600; color: var(--a); opacity: 0; }
  .label .hl { position: absolute; left: 0; right: 0; top: 80px; text-align: center; font-size: 54px; font-weight: 700; letter-spacing: -0.022em;
    white-space: nowrap; opacity: 0; }
  .sim { display: inline-flex; align-items: center; gap: 8px; margin-left: 16px; padding: 3px 12px 4px; border-radius: 999px; font-size: 16px;
    font-weight: 600; color: #c5c9ff; background: rgba(123,131,235,.16); border: 1px solid rgba(123,131,235,.42); vertical-align: 3px; }
  .sim i { width: 8px; height: 8px; border-radius: 50%; background: ${TEAMS}; }
  .scene.clip { z-index: 4; display: flex; align-items: center; justify-content: center; text-align: center; }
  .scene .w { display: flex; flex-direction: column; align-items: center; }
  .k { font-size: 112px; font-weight: 700; letter-spacing: -0.035em; line-height: 1.06; opacity: 0; }
  .card .k { font-size: 150px; letter-spacing: -0.04em; }
  .grad { background: linear-gradient(90deg, #4f8bff, #8a6cff 40%, #d16ce0 70%, #ff8a65); -webkit-background-clip: text; background-clip: text;
    color: transparent; padding-bottom: 0.12em; }
  .scene .sub { margin-top: 34px; font-size: 40px; font-weight: 500; letter-spacing: -0.01em; color: #86868b; opacity: 0; }
  .scene .sub.split { opacity: 1; }
  .scene .sub.split span { display: inline-block; opacity: 0; }
  .chips { margin-top: 56px; display: flex; flex-wrap: wrap; justify-content: center; gap: 14px; max-width: 1560px; }
  .chip { display: inline-flex; align-items: center; gap: 10px; padding: 9px 20px 10px; border-radius: 999px; font-size: 22px; font-weight: 500;
    color: #d2d2d7; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); opacity: 0; }
  .chip i { width: 10px; height: 10px; border-radius: 50%; background: var(--a); }
  .points { margin-top: 64px; display: flex; }
  .points div { padding: 0 40px; font-size: 30px; font-weight: 500; color: #a1a1a6; opacity: 0; }
  .points div + div { border-left: 1px solid rgba(255,255,255,.18); }
  .stack { margin-top: 52px; font-size: 24px; color: #86868b; opacity: 0; }
  .url { margin-top: 14px; font-size: 28px; font-weight: 600; color: #2997ff; opacity: 0; }
  .disc { position: absolute; left: 260px; right: 260px; bottom: 60px; font-size: 19px; line-height: 1.45; color: #6e6e73; text-align: center; opacity: 0; }
  .fine.clip { inset: auto 0 20px 0; z-index: 5; text-align: center; font-size: 15px; letter-spacing: 0.01em; color: #6e6e73; opacity: 0; }
  .cap.clip { inset: auto 0 56px 0; z-index: 6; display: flex; justify-content: center; }
  .cap .line { max-width: 1560px; text-align: center; font-size: 34px; font-weight: 500; line-height: 1.25; color: #f5f5f7;
    text-shadow: 0 2px 14px rgba(0,0,0,.7); }
  .cap b { margin-right: 14px; font-size: 19px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--a); vertical-align: 5px; }
  .cap .tr { display: block; margin-top: 4px; font-size: 26px; font-style: italic; color: #a1a1a6; }
  #black { position: absolute; inset: 0; z-index: 100; background: #000; }
  `;
}

/** The reel as a HyperFrames composition: one paused GSAP timeline at absolute reel seconds. */
function page(reel, clips, L, { font = null } = {}) {
  const ops = new ReelOps();
  const appearances = [L.open, ...L.chapters.map((ch) => ch.appearance)];
  const takesHtml = [];
  const glows = [];
  const labels = [];

  // The device rises in for each appearance, pushes in slowly, and settles out; its takes cross-fade inside.
  appearances.forEach((a) => {
    ops.tween("#device", { opacity: 0, y: 60, rotationX: 12, scale: 0.96 }, { opacity: 1, y: 0, rotationX: 0, scale: 1, duration: 0.9, ease: "power3.out" }, a.from);
    ops.tween("#device", { opacity: 1, y: 0, scale: 1 }, { opacity: 0, y: -20, scale: 0.985, duration: 0.5, ease: "power2.in" }, a.to - 0.5);
    ops.tween("#push", { scale: 1 }, { scale: 1.03, duration: r3(a.to - a.from), ease: "sine.inOut" }, a.from);
    const takes = a.clips.flatMap((c) => c.takes);
    takes.forEach((take, k) => {
      if (k === 0) ops.set(`#take-${take.n}`, { opacity: 1 }, a.from);
      else {
        ops.tween(`#take-${take.n}`, { opacity: 0 }, { opacity: 1, duration: take.fadeIn, ease: "power1.inOut" }, take.R);
        ops.set(`#take-${takes[k - 1].n}`, { opacity: 0 }, take.R + take.fadeIn + 1 / 60);
      }
    });
    ops.set(`#take-${takes.at(-1).n}`, { opacity: 0 }, a.to + 0.01);
  });

  for (const clip of clips) {
    for (const take of clip.takes) {
      const { cam, crop } = take;
      const sel = `#take-${take.n}`;
      const scale = (s) => r5((s * K) / crop.f);
      ops.set(`${sel} .cam`, { scale: scale(cam.start.scale) }, 0);
      ops.set(`${sel} .pan`, { x: r2(cam.start.x * crop.f), y: r2(cam.start.y * crop.f) }, 0);
      for (const tw of cam.tweens) {
        const at = take.R + tw.at;
        ops.tween(`${sel} .cam`, { scale: scale(tw.from.scale) }, { scale: scale(tw.to.scale), duration: tw.dur, ease: tw.ease }, at);
        ops.tween(`${sel} .pan`, { x: r2(tw.from.x * crop.f), y: r2(tw.from.y * crop.f) }, { x: r2(tw.to.x * crop.f), y: r2(tw.to.y * crop.f), duration: tw.dur, ease: tw.ease }, at);
      }
      const box = `left:${r2(crop.x0 * crop.f)}px;top:${r2(crop.y0 * crop.f)}px;width:${r2(crop.w * crop.f)}px;height:${r2(crop.h * crop.f)}px`;
      takesHtml.push(
        `<div class="take" id="take-${take.n}" style="background:${esc(take.src.bg)}"><div class="cam"><div class="pan">` +
          `<video id="v-${take.n}" class="clip footage" src="clips/${take.file}" muted playsinline ${timed(take.R, take.R + take.w.len)} data-media-start="0" style="${box}"></video>` +
          `</div></div></div>`,
      );
    }

    // Behind the device, a glow in the template's colour (two layers, alternating, so neighbours cross-fade);
    // above it, which template and what it shows.
    const a = clip.appearance;
    const n = clip.takes[0].n;
    const accent = bright(clip.src.accent);
    const out = Math.min(clip.end - 0.3, a.to - 0.5);
    const g = glows.length % 2;
    const prior = glows[glows.length - 2];
    if (prior && prior.free > clip.R) throw new Error(`glow ${g}: clip ${clip.src.id} starts at ${clip.R} before the glow two clips back fades out (${prior.free})`);
    glows.push({ free: out + 0.6 });
    ops.set(`#glow-${g}`, { "--g": rgba(accent, 0.36) }, clip.R);
    ops.fade(`#glow-${g}`, 0, 1, clip.R, 0.6);
    ops.fade(`#glow-${g}`, 1, 0, out, 0.6);
    const open = clip.chapter === -1;
    const leave = Math.min(clip.end - 0.7, a.to - 0.5);
    const sim = clip.def.teams ? `<span class="sim"><i></i>Teams panel simulated</span>` : "";
    labels.push(
      `<div class="label clip" id="label-${n}" style="--a:${accent}" ${timed(clip.R, leave + 0.4)}><div class="eb">${esc(clip.src.name)}${sim}</div><div class="hl">${esc(clip.def.headline)}</div></div>`,
    );
    ops.fadeIn(`#label-${n} .eb`, open ? 1.2 : clip.R + 0.15, { dur: 0.6, y: 10 });
    arrive(ops, `#label-${n} .hl`, open ? 1.45 : clip.R + 0.3);
    depart(ops, `#label-${n}`, leave);
  }

  // The title, after the cold open: the lockup lands on the score's downbeat; the templates follow.
  const T = L.title;
  const tv = T.lines.at(-1);
  const chips = clips.map((c, i) => `<div class="chip" id="chip-${i}" style="--a:${bright(c.src.accent)}"><i></i>${esc(c.src.name)}</div>`).join("");
  const titleHtml =
    `<section id="title" class="scene clip" ${timed(T.at, T.end)}><div class="w">` +
    `<div class="k" id="title-1">${esc(reel.title.lines[0])}</div><div class="k" id="title-2"><span class="grad">${esc(reel.title.lines[1])}</span></div>` +
    `<div class="sub" id="title-sub">${esc(reel.title.sub)}</div><div class="chips">${chips}</div></div></section>`;
  arrive(ops, "#title-1", T.at + 0.1);
  arrive(ops, "#title-2", T.at + 0.35);
  ops.fadeIn("#title-sub", tv.at, { dur: 0.7, y: 14 });
  clips.forEach((_, i) => ops.fadeIn(`#chip-${i}`, tv.at + 0.3 + i * 0.06, { dur: 0.5, y: 12 }));
  depart(ops, "#title .w", T.end - 0.45);

  // A card opens each chapter, on the score's accent, before the device rises.
  const cards = L.chapters.map((ch) => {
    const [first, ...rest] = ch.card.split(" ");
    arrive(ops, `#card-${ch.k} .k`, ch.at, { dur: 0.6 });
    depart(ops, `#card-${ch.k} .w`, ch.at + 1.45);
    return `<section id="card-${ch.k}" class="scene clip card" ${timed(ch.at, ch.at + 1.85)}><div class="w"><div class="k">${esc(first)} <span class="grad">${esc(rest.join(" "))}</span></div></div></section>`;
  });

  // Trust: the line the templates are built on, and what it means.
  const Tr = L.trust;
  const points = reel.trust.points.map((p, i) => `<div id="point-${i}">${esc(p)}</div>`).join("");
  const trustHtml =
    `<section id="trust" class="scene clip" ${timed(Tr.at, Tr.end)}><div class="w">` +
    `<div class="k" id="trust-1">${esc(reel.trust.lines[0])}</div><div class="k" id="trust-2"><span class="grad">${esc(reel.trust.lines[1])}</span></div>` +
    `<div class="points">${points}</div></div></section>`;
  arrive(ops, "#trust-1", Tr.at + 0.1);
  arrive(ops, "#trust-2", Tr.lines.at(-1).at - 0.1);
  reel.trust.points.forEach((_, i) => ops.fadeIn(`#point-${i}`, Tr.lines.at(-1).end + 0.2 + i * 0.25, { dur: 0.6, y: 12 }));
  depart(ops, "#trust .w", Tr.end - 0.45);

  // The end card: the lockup again, the call to action, where to find them, and the disclosure.
  const En = L.end;
  const subParts = sentences(reel.end.sub);
  const split = subParts.length === En.lines.length;
  const sub = split ? subParts.map((p, i) => `<span id="end-sub-${i}">${esc(p.text)}</span>`).join(" ") : esc(reel.end.sub);
  const endHtml =
    `<section id="end" class="scene clip" ${timed(En.at, L.total)}><div class="w">` +
    `<div class="k" id="end-1">${esc(reel.end.lines[0])}</div><div class="k" id="end-2"><span class="grad">${esc(reel.end.lines[1])}</span></div>` +
    `<div class="sub${split ? " split" : ""}" id="end-sub">${sub}</div>` +
    `<div class="stack" id="end-stack">${esc(reel.end.stack)}</div><div class="url" id="end-url">${esc(SITE)}</div></div>` +
    `<div class="disc" id="end-disc">${esc(reel.disclosure)}</div></section>`;
  arrive(ops, "#end-1", En.at + 0.2);
  arrive(ops, "#end-2", En.at + 0.55);
  if (split) En.lines.forEach((l, i) => ops.fadeIn(`#end-sub-${i}`, l.at - 0.05, { dur: 0.6, y: 12 }));
  else ops.fadeIn("#end-sub", En.lines[0].at, { dur: 0.7, y: 14 });
  const said = En.lines.at(-1).end;
  ops.fadeIn("#end-stack", said + 0.6, { dur: 0.6, y: 10 });
  ops.fadeIn("#end-url", said + 0.85, { dur: 0.6, y: 10 });
  ops.fadeIn("#end-disc", said + 1.1, { dur: 0.8, y: 0 });

  // Captions for the calls (the narrator's lines are on screen as type), and the fine print under each appearance.
  const cues = reelCues(clips);
  const caps = cues.map((cue, i) => {
    const f = Math.min(0.15, (cue.end - cue.at) / 4);
    if (i === 0 || cue.at - cues[i - 1].end > 0.2) ops.fade(`#cap-${i}`, 0, 1, cue.at, f, "none");
    if (i === cues.length - 1 || cues[i + 1].at - cue.end > 0.2) ops.fade(`#cap-${i}`, 1, 0, cue.end - f, f, "none");
    const tr = cue.tr ? `<span class="tr">${esc(cue.tr)}</span>` : "";
    return `<div class="cap clip" id="cap-${i}" style="--a:${bright(cue.accent)}" ${timed(cue.at, cue.end)}><div class="line"><b>${esc(cue.who)}</b>${esc(cue.text)}${tr}</div></div>`;
  });
  const fine = appearances.map((a, i) => {
    ops.fade(`#fine-${i}`, 0, 1, a.from + 0.3, 0.6);
    ops.fade(`#fine-${i}`, 1, 0, a.to - 0.5, 0.4);
    return `<div class="fine clip" id="fine-${i}" ${timed(a.from, a.to)}>${esc(reel.fine)}</div>`;
  });

  ops.fade("#black", 1, 0, 0, 0.6, "power1.out");
  ops.fade("#black", 0, 1, L.total - 0.8, 0.8, "power1.in");

  const html = `<!doctype html>
<html lang="en-US">
<head>
<meta charset="utf-8" />
<title>${esc(reel.name)} · overview</title>
<style>${styles(font)}</style>
</head>
<body>
<div id="root" data-composition-id="root" data-width="1920" data-height="1080" data-start="0" data-duration="${r3(L.total)}">
  <div class="glow" id="glow-0"></div>
  <div class="glow" id="glow-1"></div>
  <div id="stage"><div id="push"><div id="device"><div id="screen">
    ${takesHtml.join("\n    ")}
  </div></div></div></div>
  ${labels.join("\n  ")}
  ${titleHtml}
  ${cards.join("\n  ")}
  ${trustHtml}
  ${endHtml}
  ${caps.join("\n  ")}
  ${fine.join("\n  ")}
  <div id="black"></div>
</div>
<script src="gsap.min.js"></script>
<script>
  const OPS = ${JSON.stringify(ops.list)};
  const tl = gsap.timeline({ paused: true });
  for (const [method, target, a, b, at] of OPS) {
    if (method === "set") tl.set(target, { ...a, immediateRender: at === 0 }, at);
    else tl.fromTo(target, a, { ...b, immediateRender: at === 0 }, at);
  }
  window.__timelines = window.__timelines || {};
  window.__timelines["root"] = tl;
</script>
</body>
</html>
`;
  return { html, ops: ops.list.length, cues };
}

// -------------------------------------------------------------- soundtrack

const dbOf = (x) => 20 * Math.log10(Math.max(x, 1e-9));
function rms(track, from, to) {
  const a = Math.max(0, Math.round(from * RATE));
  const b = Math.min(track.length, Math.round(to * RATE));
  let sum = 0;
  for (let i = a; i < b; i++) sum += track[i] * track[i];
  return b > a ? Math.sqrt(sum / (b - a)) : 0;
}

/** Integrated loudness (LUFS) of a stereo { L, R } track. */
async function loudnessOf({ L, R }, scratch) {
  const n = Math.min(L.length, R.length);
  const raw = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    raw[2 * i] = L[i];
    raw[2 * i + 1] = R[i];
  }
  await writeFile(scratch, Buffer.from(raw.buffer));
  try {
    const { tail } = await sh("ffmpeg", ["-hide_banner", "-nostdin", "-nostats", "-f", "f32le", "-ar", String(RATE), "-ac", "2", "-i", scratch, "-af", "loudnorm=print_format=json", "-f", "null", "-"]);
    const m = tail.match(/\{[^{}]*"input_i"[^{}]*\}/s);
    if (!m) throw new Error(`no loudness measurement for the score: ${tail.slice(-300)}`);
    return Number(JSON.parse(m[0]).input_i);
  } finally {
    await rm(scratch, { force: true });
  }
}

/**
 * The bed's gain (linear) at any time: down by a span's dB while anyone speaks, held
 * down across gaps shorter than BED.merge, with raised-cosine attack and release.
 */
function duckCurve(spans, total) {
  const merged = [];
  for (const s of spans.filter((x) => x.to > x.from).sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last && s.from - last.to < BED.merge) {
      last.to = Math.max(last.to, s.to);
      last.db = Math.min(last.db, s.db);
    } else merged.push({ ...s });
  }
  const step = 0.005;
  const n = Math.ceil(total / step) + 2;
  const db = new Float32Array(n);
  for (const s of merged) {
    const a = s.from - BED.attack;
    const b = s.to + BED.release;
    for (let i = Math.max(0, Math.floor(a / step)); i <= Math.min(n - 1, Math.ceil(b / step)); i++) {
      const t = i * step;
      const p =
        t < s.from ? 0.5 - 0.5 * Math.cos((Math.PI * Math.max(0, t - a)) / BED.attack) : t <= s.to ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * Math.min(BED.release, t - s.to)) / BED.release);
      db[i] = Math.min(db[i], s.db * p);
    }
  }
  const gain = db.map((d) => 10 ** (d / 20));
  const at = (t) => {
    const x = Math.max(0, t / step);
    const i = Math.min(n - 2, Math.floor(x));
    return gain[i] + (gain[i + 1] - gain[i]) * Math.min(1, x - i);
  };
  return { merged, at };
}

/** The mix's five loudest half-second windows (sample peak), and whether the voices or the score made each. */
function loudest(track, voice, c, bed) {
  const w = Math.round(0.5 * RATE);
  const out = [];
  for (let a = 0; a < track.L.length; a += w) {
    let peak = 0;
    let at = a;
    for (let i = a; i < Math.min(a + w, track.L.length); i++) {
      const x = Math.max(Math.abs(track.L[i]), Math.abs(track.R[i]));
      if (x > peak) [peak, at] = [x, i];
    }
    const v = Math.abs(voice[at] * c);
    const b = bed ? Math.max(Math.abs(bed.L[at]), Math.abs(bed.R[at])) : 0;
    out.push({ t: at / RATE, db: dbOf(peak), what: v >= b ? `voice ${dbOf(v).toFixed(1)}` : `score ${dbOf(b).toFixed(1)}` });
  }
  return out.sort((x, y) => y.db - x.db).slice(0, 5);
}

/** The reel's mix: the calls as their films recorded them, the narrator, and the score ducked under both. */
async function reelSoundtrack(clips, L, file, { music = true, log }) {
  const voices = RING.map((at) => ({ samples: ringBurst(), at }));
  const spans = [];
  for (const clip of clips)
    for (const take of clip.takes) {
      const stop = take.R + take.w.len;
      for (const line of take.lines) {
        let offset = line.offset;
        let at = tau(take, line.from + offset);
        if (at < take.R) {
          offset += take.R - at;
          at = take.R;
        }
        const skip = Math.round(offset * RATE);
        const samples = line.samples.slice(skip);
        if (skip > 0) {
          const ramp = Math.min(samples.length, Math.round(0.02 * RATE));
          for (let i = 0; i < ramp; i++) samples[i] *= i / ramp;
        }
        const until = Math.min(line.until != null ? tau(take, line.from + line.until) : Infinity, stop);
        voices.push({ samples, at, until });
        spans.push({ from: tau(take, line.speechFrom), to: Math.min(tau(take, line.speechTo), stop), db: BED.duck.call });
      }
    }
  for (const v of narrationOf(L)) {
    voices.push({ samples: await prepareClip(v.file), at: v.at });
    spans.push({ from: v.at, to: v.end, db: BED.duck.vo });
  }
  const voice = mix(voices, L.total);
  const n = voice.length;
  let bed = null;
  if (music) {
    const raw = score({ total: L.total, sections: L.sections });
    const lufs = await loudnessOf(raw, `${file}.score.f32`);
    const gain = 10 ** ((BED.lufs - lufs) / 20);
    const duck = duckCurve(spans, L.total);
    bed = { L: new Float32Array(n), R: new Float32Array(n) };
    for (let i = 0; i < n; i++) {
      const g = gain * duck.at(i / RATE);
      bed.L[i] = (raw.L[i] ?? 0) * g;
      bed.R[i] = (raw.R[i] ?? 0) * g;
    }
    log(`score measured ${lufs.toFixed(1)} LUFS, set to ${BED.lufs} LUFS (${dbOf(gain).toFixed(1)} dB), ducked over ${duck.merged.length} spans`);
  }
  // The voices sit in the centre: −3 dB a side keeps their stereo loudness equal to the mono clips'.
  const c = Math.SQRT1_2;
  const track = { L: new Float32Array(n), R: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    track.L[i] = voice[i] * c + (bed ? bed.L[i] : 0);
    track.R[i] = voice[i] * c + (bed ? bed.R[i] : 0);
  }
  for (const s of L.sections) {
    const v = dbOf(rms(voice, s.at, s.end) * c);
    const b = bed ? dbOf(Math.hypot(rms(bed.L, s.at, s.end), rms(bed.R, s.at, s.end)) / Math.SQRT2) : -Infinity;
    log(`  ${s.kind.padEnd(9)} ${s.at.toFixed(1).padStart(6)}–${s.end.toFixed(1).padStart(6)} s: voices ${v.toFixed(1)} dBFS rms, score ${b.toFixed(1)} dBFS rms`);
  }
  log(`loudest moments: ${loudest(track, voice, c, bed).map((p) => `${p.t.toFixed(2)} s ${p.db.toFixed(1)} dBFS (${p.what})`).join(", ")}`);
  const loudness = await master(track, file, { limit: true });
  const pre = loudness.measured;
  log(`mix before mastering: ${pre.lufs.toFixed(1)} LUFS, true peak ${pre.truePeak.toFixed(1)} dBTP, LRA ${pre.lra.toFixed(1)} LU${loudness.limited ? "; peaks limited" : ""}`);
  if (loudness.mode === "dynamic") log("WARNING the mix needed dynamic loudness normalisation; check its peaks");
  await sh("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-v", "error", "-i", file, "-lavfi", "showspectrumpic=s=1600x600:legend=1", join(dirname(file), "spectrum.png")]);
  return loudness;
}

// ------------------------------------------------------------ deliverables

const pipe = (s) => String(s).replace(/\|/g, "\\|");
const narrationOf = (L) => [...L.title.lines, ...L.trust.lines, ...L.end.lines];
const translationOf = (clip, text) => Object.entries(clip.def.translations ?? {}).find(([k]) => norm(text).startsWith(norm(k)))?.[1] ?? null;

/** captions.vtt: the burned-in call captions (translations in brackets) and the narrator's lines. */
function vttCues(cues, L) {
  return [
    ...cues.map((c) => ({ at: c.at, end: c.end, text: c.tr ? `${c.text} [${c.tr}]` : c.text, speaker: c.who, role: c.role })),
    ...narrationOf(L).map((v) => ({ at: v.at, end: v.end, text: v.text, speaker: "Narrator", role: "narrator" })),
  ].sort((a, b) => a.at - b.at);
}

function reelTranscript(reel, clips, L) {
  const rows = [];
  for (const clip of clips)
    for (const take of clip.takes)
      for (const line of take.lines) {
        const tr = translationOf(clip, line.text);
        const who = line.role === "agent" ? "AI agent" : line.speaker;
        rows.push({ at: tau(take, line.speechFrom), template: clip.src.name, who, text: tr ? `${line.caption} *(${tr})*` : line.caption });
      }
  for (const v of narrationOf(L)) rows.push({ at: v.at, template: "—", who: "Narrator", text: v.text });
  rows.sort((a, b) => a.at - b.at);
  return `# Transcript — ${reel.name}: overview

**Runtime:** ${clock(L.total, false)} (${Math.round(L.total)} seconds)

**Production disclosure:** ${reel.disclosure} The calls are shortened: each clip is a
moment from that template's own demo film.

This transcript matches [\`captions.vtt\`](./captions.vtt), which splits long lines into
shorter cues. Timestamps are global (\`mm:ss.mmm\`) from the start of the reel.

| Timecode | Template | Speaker | Line |
|---|---|---|---|
${rows.map((r) => `| ${clock(r.at)} | ${pipe(r.template)} | ${pipe(r.who)} | ${pipe(r.text)} |`).join("\n")}
`;
}

function reelReadme(reel, clips, L, loudness, music) {
  const rows = clips.map((clip) => {
    const { c } = clip.src;
    const film = clip.takes.map((t) => `${clock(c.start + t.w.e0, false)}–${clock(c.start + t.w.end, false)}`).join(", ");
    return `| ${clock(clip.R, false)} | [${pipe(clip.src.name)}](../templates/${clip.src.id}/) | ${pipe(clip.def.headline)} | ${film} |`;
  });
  const lines = clips.reduce((n, clip) => n + clip.takes.reduce((m, t) => m + t.lines.length, 0), 0) + narrationOf(L).length;
  const cards = reel.chapters.map((ch) => ch.card.replace(/\.$/, "")).join(", ");
  return `# Overview reel

- [\`${reel.id}.mp4\`](./${reel.id}.mp4) — the overview reel (${clock(L.total, false)})
- [\`poster.webp\`](./poster.webp) — poster image
- [\`share.jpg\`](./share.jpg) — link-preview image (1200×675)
- [\`hero.webp\`](./hero.webp) — the still on the gallery's front page
- [\`captions.vtt\`](./captions.vtt) — captions for every spoken line
- [\`transcript.md\`](./transcript.md) — transcript with timecodes

One short film across all ${clips.length} templates. It opens cold on a call, then shows
each template's own demo console at the moment that says what it does, in three
chapters (${cards}),
and closes on the rule they are all built on: the model talks, your server
decides. Every clip is cut from that template's demo film, where the whole call
plays out.

| Reel time | Template | Shows | Film time |
|---|---|---|---|
${rows.join("\n")}

## Production details

- **Runtime:** ${L.total.toFixed(1)} seconds (${clock(L.total, false)}), 1920×1080, 30 fps, H.264 High with
  48 kHz stereo AAC-LC audio.
- **Voices:** all ${lines} lines are performed by Azure OpenAI GPT Realtime
  (\`${MODEL}\`) through Azure AI Voice Live (api-version \`${API_VERSION}\`).
  The narrator is \`${reel.narrator.voice}\`; the callers and agents are the
  recordings each template's film was made with.
- **Footage:** each template's demo console from its \`code/\` folder, running in simulation
  mode, as its film recorded it. Clips labelled "Teams panel simulated" show the console's
  simulation of the Teams call panel.
- **Motion graphics:** a HyperFrames composition generated by
  [\`scripts/video\`](../../scripts/video/) (\`npm run reel\`) from
  [\`reel/${reel.id}.mjs\`](../../scripts/video/reel/${reel.id}.mjs).
- **Music:** ${
    music
      ? `an original score synthesised in code by
  [\`score.mjs\`](../../scripts/video/src/score.mjs), with no samples and no
  licensed music. It ducks under every voice.`
      : "none; voices only."
  }
- **Mix:** ${loudness.lufs.toFixed(1)} LUFS integrated (target ${LOUDNESS.film}), true peak ${loudness.truePeak.toFixed(1)} dBTP.

${reel.disclosure}

The reel demonstrates reference implementations in simulation mode; it is not a
recording of a production deployment.
`;
}

function summary(reel, clips, L, { ops, cues, loudness }) {
  return {
    id: reel.id,
    name: reel.name,
    total: L.total,
    sections: L.sections,
    open: { from: L.open.from, to: L.open.to },
    title: { at: L.title.at, end: L.title.end },
    chapters: L.chapters.map((ch) => ({ card: ch.card, at: ch.at, from: ch.appearance.from, to: ch.appearance.to })),
    trust: { at: L.trust.at, end: L.trust.end },
    end: { at: L.end.at, chord: L.end.chord },
    clips: clips.map((clip) => ({
      film: clip.src.id,
      headline: clip.def.headline,
      at: clip.R,
      end: clip.end,
      takes: clip.takes.map((t) => ({
        file: t.file,
        at: t.R,
        len: t.w.len,
        film: { from: r3(clip.src.c.start + t.w.e0), to: r3(clip.src.c.start + t.w.end), hold: t.w.hold },
        crop: t.crop,
        lines: t.lines.map((l) => ({ at: r3(tau(t, l.speechFrom)), end: r3(tau(t, l.speechTo)), speaker: l.speaker, role: l.role, text: l.caption })),
      })),
    })),
    narration: narrationOf(L).map(({ text, at, end, key }) => ({ text, at, end, key })),
    ops,
    cues: cues.length,
    loudness,
  };
}

/** Review frames: the open, the title, every card and take, trust and the end. */
function autoSnaps(clips, L) {
  const first = clips[0].takes[0];
  const times = [
    2,
    tau(first, first.lines[0].speechFrom) + 2,
    L.T0 - 1,
    L.T0 + 1.5,
    L.title.lines.at(-1).at + 1.5,
    ...L.chapters.map((ch) => ch.at + 0.6),
    ...clips.flatMap((clip) => clip.takes.map((t) => t.R + t.w.len / 2)),
    L.trust.at + 3,
    L.end.at + 3,
    L.total - 2,
  ];
  return [...new Set(times.map((t) => r3(Math.min(L.total - 0.05, Math.max(0, t)))))].sort((a, b) => a - b);
}

// -------------------------------------------------------------------- main

export async function buildReel(id = "overview", opts = {}) {
  const {
    films = join(WORK, "films"),
    captures = join(WORK, "captures"),
    repo = resolve(ROOT, "..", ".."),
    out = join(WORK, "reel"),
    snap = null,
    render = true,
    draft = false,
    music = true,
    crf = ENCODE.crf,
    workers = "auto",
    force = false,
    log = (line) => console.error(`[${id}] ${line}`),
  } = opts;
  const reel = (await import(pathToFileURL(join(ROOT, "reel", `${id}.mjs`)).href)).default;
  if (reel?.id !== id) throw new Error(`reel/${id}.mjs must export default { id: "${id}", … }`);
  const dir = join(out, id);
  const project = join(dir, "project");
  const clipsDir = join(project, "clips");
  await mkdir(clipsDir, { recursive: true });

  const bank = new VoiceBank({ log });
  const clips = await resolveReel(reel, { films, captures, repo, bank }, log);
  const L = await layout(reel, clips, bank, log);
  log(`reel ${clock(L.total, false)} (${L.total} s): open ${L.open.from}–${L.open.to}, title ${L.title.at}–${L.title.end}`);
  for (const ch of L.chapters)
    log(`  "${ch.card}" at ${ch.at}: ${ch.appearance.clips.map((c) => `${c.src.id} ${c.R.toFixed(1)}–${c.end.toFixed(1)}`).join(", ")}`);
  log(`  trust ${L.trust.at}–${L.trust.end}, end ${L.end.at} (chord ${L.end.chord}) → ${L.total}`);

  const takes = clips.flatMap((c) => c.takes);
  const cutAt = Date.now();
  const keys = await pool(takes, 4, (take) => cutTake(take, clipsDir));
  const wanted = new Set(takes.flatMap((t) => [t.file, `${t.file}.key`]));
  for (const f of await readdir(clipsDir)) if (!wanted.has(f)) await rm(join(clipsDir, f), { force: true });
  log(`${takes.length} takes cut in ${((Date.now() - cutAt) / 1000).toFixed(0)} s`);

  const font = findFont();
  if (font) {
    const dest = join(project, "fonts", FONT);
    await mkdir(dirname(dest), { recursive: true });
    await rm(dest, { force: true });
    await copyFile(font, dest);
  } else log(`note: ${FONT} not found (set REEL_FONT); the page falls back to Segoe UI / system-ui`);
  const { html, ops, cues } = page(reel, clips, L, { font });
  await writeFile(join(project, "index.html"), html);
  await copyFile(GSAP, join(project, "gsap.min.js"));
  log(`page: ${ops} animation ops, ${cues.length} caption cues`);

  const lint = await sh(HYPERFRAMES, ["lint", project]).catch((e) => e);
  const lintText = `${lint.out ?? ""}${lint.tail ?? ""}`;
  if (lint instanceof Error) throw new Error(`lint failed:\n${lintText.trim()}`);
  const rules = {};
  for (const m of lintText.matchAll(/⚠ \[[^\]]*\] ([a-z_]+)/g)) rules[m[1]] = (rules[m[1]] ?? 0) + 1;
  delete rules.nested_structure_needs_subcomposition;
  if (Object.keys(rules).length) log(`lint warnings: ${Object.entries(rules).map(([k, n]) => `${k} ×${n}`).join(", ")}`);

  if (snap) {
    const times = snap === "auto" ? autoSnaps(clips, L) : snap;
    const shots = join(dir, "snaps");
    await rm(shots, { recursive: true, force: true });
    await sh(HYPERFRAMES, ["snapshot", project, "--at", times.join(","), "--no-end", "-o", shots]);
    log(`${times.length} snapshots in ${shots}`);
  }

  const wav = join(dir, "soundtrack.wav");
  const loudness = await reelSoundtrack(clips, L, wav, { music, log });
  log(`soundtrack ${loudness.lufs.toFixed(1)} LUFS, true peak ${loudness.truePeak.toFixed(1)} dBTP (${loudness.mode})`);
  await writeFile(join(dir, "captions.vtt"), webvtt(vttCues(cues, L)));
  await writeFile(join(dir, "transcript.md"), reelTranscript(reel, clips, L));
  await writeFile(join(dir, "README.md"), reelReadme(reel, clips, L, loudness, music));
  await writeFile(join(dir, "reel.json"), JSON.stringify(summary(reel, clips, L, { ops, cues, loudness }), null, 1));
  if (!render) return { dir, L, loudness };

  // The silent picture (skipped when nothing it depends on has changed).
  const silent = join(dir, draft ? "silent-draft.mp4" : "silent.mp4");
  const key = sha([html, keys, draft, 14]);
  if (force || !existsSync(silent) || (await readFile(`${silent}.key`, "utf8").catch(() => "")) !== key) {
    const started = Date.now();
    const renderLog = join(dir, "render.log");
    await writeFile(renderLog, "");
    log(`rendering ${Math.round(L.total * FPS)} frames${draft ? " (draft)" : ""}…`);
    const tmp = silent.replace(/\.mp4$/, ".tmp.mp4");
    await sh(HYPERFRAMES, ["render", project, "-f", String(FPS), "-q", draft ? "draft" : "delivery", "--crf", draft ? "24" : "14", "--video-frame-format", "jpg", "-w", String(workers), "-o", tmp], { log: renderLog });
    await rename(tmp, silent);
    await writeFile(`${silent}.key`, key);
    log(`rendered in ${((Date.now() - started) / 60000).toFixed(1)} min`);
  } else log("picture unchanged: reusing the render");

  const mp4 = join(dir, `${id}.mp4`);
  await sh("ffmpeg", [
    "-hide_banner", "-nostdin", "-y", "-v", "error", "-i", silent, "-i", wav, "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", ENCODE.preset, "-crf", String(crf), "-x264-params", ENCODE.x264, "-pix_fmt", "yuv420p", "-profile:v", "high",
    "-c:a", "aac", "-b:a", ENCODE.audio, "-ar", "48000",
    "-metadata", `title=${reel.name} — overview`,
    "-metadata", `comment=Synthetic voices: Azure OpenAI GPT Realtime. Simulation mode.${music ? " Original score." : ""}`,
    "-movflags", "+faststart", "-shortest", mp4,
  ]);
  const posterAt = r3(Math.min(L.title.end - 0.6, L.title.lines.at(-1).at + 1.8));
  await sh("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-v", "error", "-ss", String(posterAt), "-i", silent, "-frames:v", "1", "-c:v", "libwebp", "-quality", "86", join(dir, "poster.webp")]);
  // Link previews (Teams, Slack, LinkedIn) take a JPEG more reliably than WebP.
  await sh("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-v", "error", "-ss", String(posterAt), "-i", silent, "-frames:v", "1", "-vf", "scale=1200:675:flags=lanczos", "-q:v", "3", join(dir, "share.jpg")]);
  // The gallery's front page shows a console at work rather than the title card.
  const heroAt = r3(frameDown(L.open.to - (reel.hero?.before ?? 1.8)));
  await sh("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-v", "error", "-ss", String(heroAt), "-i", silent, "-frames:v", "1", "-vf", "scale=1600:900:flags=lanczos", "-c:v", "libwebp", "-quality", "84", join(dir, "hero.webp")]);
  const size = (await stat(mp4)).size;
  log(`${id}.mp4 ${(size / 1e6).toFixed(1)} MB, ${clock(L.total, false)} → ${dir}`);
  return { dir, L, loudness, size };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  if (args.includes("--help")) {
    console.error("usage: node src/reel.mjs [id] [--films DIR] [--captures DIR] [--repo DIR] [--out DIR] [--snap t1,t2|auto] [--no-render] [--draft] [--no-music] [--crf N] [--force] [--workers N]");
    process.exit(2);
  }
  const id = args[0] && !args[0].startsWith("--") ? args[0] : "overview";
  const snap = opt("snap", "");
  await buildReel(id, {
    films: opt("films", undefined),
    captures: opt("captures", undefined),
    repo: opt("repo", undefined),
    out: opt("out", undefined),
    snap: snap === "auto" ? "auto" : snap ? snap.split(",").map(Number) : null,
    render: !args.includes("--no-render"),
    draft: args.includes("--draft"),
    music: !args.includes("--no-music"),
    crf: Number(opt("crf", ENCODE.crf)),
    workers: opt("workers", process.env.RENDER_WORKERS || "auto"),
    force: args.includes("--force"),
  });
}
