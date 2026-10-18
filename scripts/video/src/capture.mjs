#!/usr/bin/env node
/**
 * Film capture: play a template's demo script in its own console (simulation
 * mode), screen-record it, and log when every line is spoken.
 *
 *   node src/capture.mjs <template-id> [--out DIR] [--dpr 2] [--max-passes 4] [--keep-frames]
 *
 * Env: REPO      checkout holding docs/templates/<id>/code with npm ci done (default: this one)
 *      CHROME    browser binary (default: the HyperFrames headless shell)
 *      VOICE_LIVE_ENDPOINT  Azure AI Services endpoint for GPT Realtime voices
 *
 * Every console line is spoken by the browser through src/shim.js, which plays
 * the line's GPT Realtime recording for exactly as long as it lasts. The
 * narrator speaks between steps: the console holds still while it does. A pass
 * that had to perform a new line (a pause the audience would see) is thrown
 * away and the script is played again until every line comes from the cache.
 *
 * Output (<out>/<id>/): footage.mp4 (CFR 30 fps), timeline.json, capture.log
 */
import { mkdir, rm, writeFile, readFile, readdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";
import { stage } from "./stage.mjs";
import { VoiceBank } from "./voices.mjs";
import { loadBeats, clickPoints, describe } from "./beats.mjs";
import { loadFilm, castLine, narrator, filmedBeats, beatNarration } from "./film.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PACE = {
  settleIn: 500, // after a beat loads
  lead: 300, // quiet before the narrator speaks
  gap: 450, // after the narrator, before the console moves
  dwell: 700, // after a step settles
  quietMs: 650, // the console's settle: the hub goes quiet...
  quietMax: 8000,
  voiceStable: 300, // ...and speech stays idle this long
  beatTail: 700, // after a beat's closing narration
  head: 1200, // footage before the first beat
  tail: 1500, // footage after the last beat
};

export const VIEWPORT_WIDTH = 1400; // the console's 1360 px page plus its padding

// The timecode src/shim.js paints along the bottom of the viewport (CSS px):
// a white and a black marker block, 24 bits of milliseconds, a parity bit.
export const CLOCK = { bits: 27, block: 14, height: 10 };

export async function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), ".cache", "hyperframes", "chrome", "chrome-headless-shell");
  const builds = existsSync(base) ? (await readdir(base)).sort().reverse() : [];
  for (const build of builds) {
    const bin = join(base, build, "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (existsSync(bin)) return bin;
  }
  throw new Error("No Chrome found: run `npx hyperframes browser ensure` or set CHROME");
}

export function run(cmd, args, { quiet = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stdout.on("data", (d) => quiet || process.stderr.write(d));
    child.stderr.on("data", (d) => (err = (err + d).slice(-8000)));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err}`))));
  });
}

function runOut(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    let err = "";
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} exited ${code}: ${err}`))));
  });
}

/**
 * Route the presenter kit's speech through the film voice (src/shim.js): each
 * whole line goes to window.__filmUtter instead of being read sentence by
 * sentence by browser speech. Every template vendors the same kit.
 */
export function hookKit(source) {
  const at = /(const speakNow = async \(role, text, gen\) => \{\r?\n)/;
  if (!at.test(source)) throw new Error("presenter-kit.js changed: cannot find speakNow() to hook");
  return source.replace(
    at,
    "$1    if (globalThis.__filmUtter) {\n" +
      "      if (gen === generation) await globalThis.__filmUtter(role, String(text).trim(), (voices[role] ?? voices.agent)?.lang ?? language);\n" +
      "      return;\n" +
      "    }\n",
  );
}

/** Where the console's regions are, in page CSS pixels (every console shares these landmarks). */
async function layout(page) {
  return page.evaluate(() => {
    const regions = {};
    const add = (name, el) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        regions[name] = { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
      }
    };
    add("top", document.querySelector("header.top"));
    add("stack", document.querySelector("#stack"));
    add("director", document.querySelector("#director"));
    add("grid", document.querySelector("main.grid"));
    add("metrics", document.querySelector("#metrics"));
    for (const card of document.querySelectorAll("main.grid section.card")) {
      const name = [...card.classList].find((c) => c !== "card");
      if (name) add(name, card);
    }
    return { page: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }, regions };
  });
}

async function capturePass({ film, beats, repo, port, dpr, dir, bank, log, chrome }) {
  const events = [];
  const mark = (kind, data = {}) => events.push({ kind, at: Date.now(), ...data });
  const state = { beat: 0 };
  const server = await stage({ repo, id: film.id, port, env: film.capture?.env ?? {} });
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: [
      "--no-sandbox",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
      "--autoplay-policy=no-user-gesture-required",
      // Consoles may play voice audio; the film's soundtrack is built separately, so keep captures silent.
      "--mute-audio",
      // Without this, headless screencast frames arrive at CSS size whatever the emulated DPR.
      `--force-device-scale-factor=${dpr}`,
      // SwiftShader GL reads back 2x frames ~50% faster than the default path under WSL.
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  const framesDir = join(dir, "frames");
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });
  const frames = [];
  let writing = Promise.resolve();
  let cdp = null;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: VIEWPORT_WIDTH, height: 1000, deviceScaleFactor: dpr });
    let hooked = 0;
    let hookError = null;
    await page.setRequestInterception(true);
    page.on("request", async (req) => {
      if (req.isInterceptResolutionHandled()) return;
      if (!new URL(req.url()).pathname.endsWith("/presenter-kit.js")) return req.continue();
      try {
        const res = await fetch(req.url());
        const body = hookKit(await res.text());
        hooked += 1;
        await req.respond({ status: 200, contentType: "text/javascript; charset=utf-8", body });
      } catch (e) {
        hookError = e;
        await req.abort().catch(() => {});
      }
    });
    await page.exposeFunction("__filmLog", (json) => {
      try {
        events.push(JSON.parse(json));
      } catch {
        /* ignore */
      }
    });
    await page.exposeFunction("__filmSpeak", async (json) => {
      const { role, lang, text } = JSON.parse(json);
      const who = castLine(film, { beat: state.beat, role, text });
      const clip = await bank.get({ voice: who.voice, style: who.style, lang, text });
      if (!clip.cached) log(`    new line (${who.voice}): ${text}`);
      return JSON.stringify({ ms: clip.ms, cached: clip.cached, key: clip.key, speaker: who.speaker, voice: who.voice });
    });
    await page.evaluateOnNewDocument(`window.__FILM_NOTES__ = ${JSON.stringify(film.capture?.notes ?? "off")};`);
    await page.evaluateOnNewDocument(`window.__FILM_CLOCK__ = ${JSON.stringify(CLOCK)};`);
    await page.evaluateOnNewDocument(await readFile(join(here, "shim.js"), "utf8"));
    page.on("pageerror", (e) => log(`    pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") log(`    console: ${m.text()}`);
    });
    await page.goto(server.origin + (film.capture?.path ?? "/"), { waitUntil: "networkidle0", timeout: 60_000 });
    await page.waitForSelector(".pk-director .pk-next", { timeout: 30_000 });
    if (hookError) throw hookError;
    if (!hooked) throw new Error("the page never loaded presenter-kit.js, so its speech was not hooked");
    await sleep(400);
    const measured = await page.evaluate(() => document.documentElement.scrollHeight);
    const viewport = {
      width: VIEWPORT_WIDTH,
      height: Math.min(2600, Math.ceil(measured + (film.capture?.extraHeight ?? 260))),
    };
    // `viewport` is what the film sees; the browser is CLOCK.height taller for the timecode.
    await page.setViewport({ width: viewport.width, height: viewport.height + CLOCK.height, deviceScaleFactor: dpr });
    await sleep(600);
    const startLayout = await layout(page);

    cdp = await page.createCDPSession();
    cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
      cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      const file = join(framesDir, `${String(frames.length + 1).padStart(6, "0")}.jpg`);
      frames.push({ file, t: metadata?.timestamp ? metadata.timestamp * 1000 : Date.now() });
      const bytes = Buffer.from(data, "base64");
      writing = writing.then(() => writeFile(file, bytes));
    });
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 85,
      maxWidth: viewport.width * dpr,
      maxHeight: (viewport.height + CLOCK.height) * dpr,
      everyNthFrame: 1,
    });
    // Nudge a repaint so the first frame arrives now, not at the first change.
    await page.evaluate(() => {
      document.body.style.outline = "0px solid transparent";
      requestAnimationFrame(() => (document.body.style.outline = ""));
    });
    await sleep(PACE.head);
    mark("rolling");

    const ctx = { page, film, bank, mark, log, state };
    const layouts = [];
    for (const beat of filmedBeats(film, beats)) {
      await playBeat(beat, ctx);
      layouts.push({ beat: beat.index + 1, layout: await layout(page) });
    }
    await sleep(PACE.tail);
    mark("end");
    await sleep(300);
    await cdp.send("Page.stopScreencast");
    await writing;
    return { events, frames, viewport, dpr, startLayout, layouts };
  } finally {
    await writing.catch(() => {});
    await browser.close().catch(() => {});
    await server.stop();
  }
}

async function waitIdle(page, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  let since = 0;
  while (Date.now() < deadline) {
    const idle = await page.evaluate(
      () => window.__filmVoiceIdle?.() && document.querySelector(".pk-director")?.dataset.busy !== "true",
    );
    if (idle) {
      since ||= Date.now();
      if (Date.now() - since >= PACE.voiceStable) return;
    } else since = 0;
    await sleep(80);
  }
  throw new Error("the console never went idle");
}

async function settle(page) {
  await page.waitForFunction(() => document.querySelector(".pk-director")?.dataset.busy !== "true", {
    timeout: 180_000,
    polling: 50,
  });
  await page.evaluate((q, m) => window.__filmHubQuiet(q, m), PACE.quietMs, PACE.quietMax);
  await waitIdle(page);
  await sleep(PACE.dwell);
  await page.evaluate((q, m) => window.__filmHubQuiet(q, m), PACE.quietMs, PACE.quietMax);
  await waitIdle(page);
}

async function narrate(ctx, text, meta) {
  const who = narrator(ctx.film);
  const clip = await ctx.bank.get({ voice: who.voice, style: who.style, lang: "en-US", text });
  await sleep(PACE.lead);
  ctx.mark("narrate", { role: "narrator", speaker: who.speaker, voice: who.voice, text, key: clip.key, ms: clip.ms, cached: true, ...meta });
  await sleep(clip.ms + PACE.gap);
}

async function playBeat(beat, ctx) {
  const { page, film, mark, log } = ctx;
  const number = beat.index + 1;
  const { intro, cues, post, after } = beatNarration(film, number);
  ctx.state.beat = number;
  log(`  beat ${number}: ${beat.title}`);
  await waitIdle(page);
  mark("beat", { beat: number, title: beat.title });
  await page.evaluate((i) => document.querySelector(`.pk-beats button[data-beat="${i}"]`)?.click(), beat.index);
  await sleep(PACE.settleIn);
  if (intro) await narrate(ctx, intro, { beat: number, part: "intro" });
  const points = clickPoints(beat);
  for (let p = 0; p < points.length; p++) {
    const first = points[p];
    const last = (points[p + 1] ?? beat.steps.length) - 1;
    for (let k = first; k <= last; k++) {
      const cue = cues[k + 1];
      if (cue) await narrate(ctx, cue, { beat: number, part: `cue ${k + 1}` });
    }
    await waitIdle(page);
    const steps = beat.steps.slice(first, last + 1);
    log(`    step ${first + 1}${last > first ? `-${last + 1}` : ""}: ${steps.map(describe).join(" → ")}`);
    mark("step", { beat: number, step: first + 1, through: last + 1, steps: steps.map(describe) });
    await page.evaluate(() => document.querySelector(".pk-director .pk-next")?.click());
    await settle(page);
    for (let k = first; k <= last; k++) {
      const note = post[k + 1];
      if (note) await narrate(ctx, note, { beat: number, part: `post ${k + 1}` });
    }
  }
  const label = await page.evaluate(() => document.querySelector(".pk-director .pk-next")?.textContent ?? "");
  if (!/Next beat|Script complete/.test(label)) log(`    WARNING beat ${number} ended with Next reading "${label}"`);
  mark("beat-done", { beat: number });
  if (after) await narrate(ctx, after, { beat: number, part: "after" });
  await sleep(PACE.beatTail);
  mark("beat-end", { beat: number });
}

/**
 * When each frame's content was current, read from the timecode shim.js paints
 * into the page (CLOCK). The screencast's own timestamps run late, and by more
 * when the page is busy, so they would put every voice ahead of the screen.
 * A frame whose strip can't be read borrows the delay of its nearest readable
 * neighbours; content only moves forward, so the longest strictly increasing
 * run is kept, which drops repeats (compositor-only frames) and any misread.
 */
async function retime(frames, { y, dpr }) {
  const w = CLOCK.bits * CLOCK.block * dpr;
  const h = CLOCK.height * dpr;
  const folder = dirname(frames[0].file);
  const per = Math.max(120, Math.ceil(frames.length / 24));
  const jobs = [];
  for (let s = 0; s < frames.length; s += per) {
    jobs.push(
      runOut("ffmpeg", [
        "-v", "error", "-f", "image2", "-start_number", String(s + 1), "-i", join(folder, "%06d.jpg"),
        "-frames:v", String(Math.min(per, frames.length - s)),
        "-vf", `crop=${w}:${h - 6}:0:${y + 3},scale=${CLOCK.bits}:1:flags=area,format=gray`,
        "-f", "rawvideo", "-",
      ]),
    );
  }
  const bytes = Buffer.concat(await Promise.all(jobs));
  const M = 2 ** 24;
  const code = (i) => {
    const v = bytes.subarray(i * CLOCK.bits, (i + 1) * CLOCK.bits);
    if (v.length < CLOCK.bits || v[0] - v[1] < 100) return null;
    const mid = (v[0] + v[1]) / 2;
    let value = 0;
    let parity = 0;
    for (let k = 2; k < CLOCK.bits - 1; k++) {
      const b = v[k] > mid ? 1 : 0;
      value = value * 2 + b;
      parity ^= b;
    }
    return (v[CLOCK.bits - 1] > mid ? 1 : 0) === parity ? value : null;
  };
  // How late each frame's screencast timestamp is: the 24-bit clock unwrapped near it.
  const late = frames.map((f, i) => {
    const c = code(i);
    if (c == null) return null;
    const d = (((f.t - c) % M) + M) % M;
    const v = d > M / 2 ? d - M : d;
    return v > -150 && v < 15000 ? v : null;
  });
  const good = late.flatMap((d, i) => (d == null ? [] : [i]));
  if (!good.length) throw new Error("the film clock was unreadable on every frame");
  let g = -1;
  const timed = frames.map((f, i) => {
    while (g + 1 < good.length && good[g + 1] <= i) g++;
    let d = late[i];
    if (d == null) {
      const a = good[g];
      const b = good[g + 1];
      if (a == null) d = late[b];
      else if (b == null) d = late[a];
      else d = late[a] + ((late[b] - late[a]) * (f.t - frames[a].t)) / Math.max(1, frames[b].t - frames[a].t);
    }
    return { ...f, t: f.t - d };
  });
  const kept = increasingRun(timed.map((f) => f.t)).map((i) => timed[i]);
  const delays = good.map((i) => late[i]).sort((a, b) => a - b);
  return {
    frames: kept,
    read: good.length,
    unread: spans(late.flatMap((d, i) => (d == null ? [i + 1] : []))),
    median: delays[Math.floor(delays.length / 2)],
    min: delays[0],
    max: delays.at(-1),
    dropped: frames.length - kept.length,
  };
}

/** Indices of the longest strictly increasing subsequence of `values`. */
function increasingRun(values) {
  const tails = [];
  const prev = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < values[i]) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const out = [];
  for (let i = tails.at(-1); i >= 0; i = prev[i]) out.push(i);
  return out.reverse();
}

/** "1–24, 530" from [1, 2, …, 24, 530]. */
function spans(numbers) {
  const out = [];
  for (const n of numbers) {
    const last = out.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  const text = out.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`));
  return text.length > 8 ? `${text.slice(0, 8).join(", ")}, …` : text.join(", ");
}

/** Constant 30 fps footage from the screencast's variable-rate frames, without the timecode strip. */
async function buildFootage(frames, endAt, dir, height) {
  const list = ["ffconcat version 1.0"];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : endAt;
    list.push(`file '${f.file}'`, `duration ${(Math.max(1, next - f.t) / 1000).toFixed(6)}`);
  });
  list.push(`file '${frames.at(-1).file}'`);
  const listFile = join(dir, "frames.ffconcat");
  await writeFile(listFile, list.join("\n") + "\n");
  const out = join(dir, "footage.mp4");
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-f", "concat", "-safe", "0", "-i", listFile,
    "-vf", `crop=iw:${height}:0:0,fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "12", "-tune", "animation",
    "-movflags", "+faststart", out,
  ]);
  return out;
}

export async function capture(id, { out, repo = process.env.REPO ?? resolve(here, "..", "..", ".."), dpr = 2, maxPasses = 4, keepFrames = false, only = null } = {}) {
  if (!existsSync(join(repo, "docs", "templates", id, "code", "node_modules"))) {
    throw new Error(`run npm ci in ${join(repo, "docs", "templates", id, "code")} first (or set REPO to a checkout where you have)`);
  }
  const film = await loadFilm(id);
  if (only?.length) film.edit = { ...film.edit, beats: only };
  const beats = await loadBeats(repo, id);
  const dir = join(out, id);
  await mkdir(dir, { recursive: true });
  const logFile = join(dir, "capture.log");
  await writeFile(logFile, "");
  const log = (line) => {
    console.error(`[${id}] ${line}`);
    appendFile(logFile, `${line}\n`).catch(() => {});
  };
  const bank = new VoiceBank({ log });
  const chrome = await findChrome();
  const port = film.port;

  // Perform what we can before the first pass: narration and the scripted caller lines.
  const work = [];
  const voiceOf = narrator(film);
  for (const beat of filmedBeats(film, beats)) {
    const number = beat.index + 1;
    const { intro, cues, post, after } = beatNarration(film, number);
    for (const text of [intro, ...Object.values(cues), ...Object.values(post), after].filter(Boolean)) {
      work.push(bank.get({ voice: voiceOf.voice, style: voiceOf.style, lang: "en-US", text }));
    }
    for (const step of beat.steps.filter((s) => s.type === "say" && s.text)) {
      const who = castLine(film, { beat: number, role: "caller", text: step.text });
      const lang = film.beats?.[number]?.lang ?? step.lang ?? film.lang ?? "en-US";
      work.push(bank.get({ voice: who.voice, style: who.style, lang, text: step.text }));
    }
  }
  log(`performing ${work.length} known lines`);
  await Promise.all(work);

  let result = null;
  for (let n = 1; n <= maxPasses; n++) {
    log(`pass ${n}`);
    const started = Date.now();
    result = await capturePass({ film, beats, repo, port, dpr, dir, bank, log, chrome });
    const speaks = result.events.filter((e) => e.kind === "speak");
    const fresh = speaks.filter((e) => !e.cached);
    const unhooked = result.events.filter((e) => e.kind === "unhooked");
    if (unhooked.length) throw new Error(`${unhooked.length} lines bypassed the film voice, e.g. "${unhooked[0].text}"`);
    const span = result.frames.length ? (result.frames.at(-1).t - result.frames[0].t) / 1000 : 0;
    log(`pass ${n}: ${(Date.now() - started) / 1000}s, ${result.frames.length} frames (${(result.frames.length / Math.max(span, 1)).toFixed(1)} fps), ${speaks.length} lines, ${fresh.length} new`);
    if (!fresh.length) break;
    if (n === maxPasses) log(`WARNING ${fresh.length} lines were still new after ${maxPasses} passes`);
  }

  const { events, viewport, startLayout, layouts } = result;
  const pixels = { w: Math.round((viewport.width * dpr) / 2) * 2, h: Math.round((viewport.height * dpr) / 2) * 2 };
  const timed = await retime(result.frames, { y: viewport.height * dpr, dpr });
  const { frames } = timed;
  log(
    `clock read on ${timed.read}/${result.frames.length} frames: the screencast ran ${Math.round(timed.median)} ms late ` +
      `(${Math.round(timed.min)}–${Math.round(timed.max)}), ${timed.dropped} repeated frames dropped`,
  );
  if (timed.unread) log(`  no clock on frames ${timed.unread}`);
  if (timed.read < result.frames.length * 0.9) log(`WARNING the timecode was unreadable on ${result.frames.length - timed.read} frames`);
  const endAt = events.find((e) => e.kind === "end")?.at ?? frames.at(-1).t + 1000;
  const footage = await buildFootage(frames, endAt + 300, dir, pixels.h);
  const timeline = {
    id,
    captured: new Date().toISOString(),
    t0: frames[0].t,
    duration: (endAt + 300 - frames[0].t) / 1000,
    viewport,
    dpr,
    pixels,
    layout: startLayout,
    layouts,
    beats: filmedBeats(film, beats).map((b) => ({ number: b.index + 1, title: b.title })),
    events: events
      .map((e) => ({ ...e, t: (e.at - frames[0].t) / 1000 }))
      .sort((a, b) => a.t - b.t),
  };
  await writeFile(join(dir, "timeline.json"), JSON.stringify(timeline, null, 2));
  if (!keepFrames) await rm(join(dir, "frames"), { recursive: true, force: true });
  log(`footage ${footage} (${timeline.duration.toFixed(1)} s)`);
  return { dir, footage, timeline };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const id = process.argv[2];
  const opt = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  if (!id) {
    console.error("usage: node src/capture.mjs <template-id> [--out DIR] [--dpr 2] [--max-passes 4] [--beats 1,2] [--keep-frames]");
    process.exit(2);
  }
  await capture(id, {
    out: opt("out", join(homedir(), "cvp-video-work", "captures")),
    dpr: Number(opt("dpr", 2)),
    maxPasses: Number(opt("max-passes", 4)),
    keepFrames: process.argv.includes("--keep-frames"),
    only: opt("beats", "")
      .split(",")
      .filter(Boolean)
      .map(Number),
  });
}
