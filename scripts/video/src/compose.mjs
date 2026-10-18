// Composes one template's demo film from its film script (films/<id>.mjs), the
// template's template.json and a console capture (src/capture.mjs):
//
//   1. performs the scenes' narration with GPT Realtime (the cached voice bank);
//   2. lays the scenes and the edited console end to end on one film clock;
//   3. writes the HyperFrames project (index.html, GSAP, the edited footage),
//      lints it and renders it silently;
//   4. mixes every voice at its film time, masters the mix and muxes demo.mp4;
//   5. writes poster.webp, captions.vtt, transcript.md and README.md beside it.
//
// usage: node src/compose.mjs <template-id> [--captures DIR] [--out DIR] [--repo DIR]
//          [--snap t1,t2,...] [--no-render] [--draft] [--crf N] [--workers N] [--force]
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadFilm, narrator } from "./film.mjs";
import { VoiceBank } from "./voices.mjs";
import { MODEL, API_VERSION } from "./realtime.mjs";
import { CAMERA, cameraPlan, captionCues, chapters, editedLength, keepSegments, selectExpression, skipRanges, spokenLines, timeMap, webvtt } from "./edit.mjs";
import { buildComposition, isLight } from "./scenes.mjs";
import { LOUDNESS, master, mix, prepareClip, ringBurst } from "./soundtrack.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const HYPERFRAMES = join(ROOT, "node_modules", ".bin", "hyperframes");
const GSAP = join(ROOT, "node_modules", "gsap", "dist", "gsap.min.js");
const WORK = join(homedir(), "cvp-video-work");

/** Seconds. Each scene: narration starts `lead` in, holds `tail` after the last line, lasts at least `min`. */
export const TIMING = {
  overlap: 0.5, // scenes cross-fade into each other (and into the console)
  gap: 0.45, // between a scene's lines
  ring: [0.25, 1.85], // the phone rings twice before the narrator speaks
  scenes: {
    open: { lead: 3.0, tail: 2.4, min: 9 },
    title: { lead: 0.9, tail: 1.2, min: 4.2 },
    how: { lead: 1.1, tail: 1.6, min: 7 },
    hood: { lead: 1.1, tail: 1.6, min: 7 },
    yours: { lead: 1.1, tail: 2.0, min: 8 },
    close: { lead: 1.1, tail: 3.8, min: 8 },
  },
};
const BEFORE = ["open", "title", "how"];
const AFTER = ["hood", "yours", "close"];

/**
 * The final encode: H.264 High. CRF 28 at veryslow keeps the console text crisp, even mid-pan,
 * at about half of CRF 23's bitrate; aq-mode 3 guards the dark gradients from banding.
 */
export const ENCODE = { crf: 28, preset: "veryslow", x264: "aq-mode=3", audio: "128k" };

const r3 = (n) => Math.round(n * 1000) / 1000;
const sha = (value) => createHash("sha1").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

function sh(cmd, args, { log = null, echo = false } = {}) {
  return new Promise((done, fail) => {
    // HyperFrames' default frame cache lives in os.tmpdir() and keeps each film's ~4–5 GB of extracted
    // footage for an hour, which fills a RAM-backed /tmp during batch renders. Uncached, the frames go
    // to the render's own work dir beside the output and are deleted with it.
    const env = { ...process.env, HYPERFRAMES_TELEMETRY: "0", DO_NOT_TRACK: "1", HYPERFRAMES_EXTRACT_CACHE_DIR: process.env.HYPERFRAMES_EXTRACT_CACHE_DIR ?? "off" };
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env });
    const sink = log ? createWriteStream(log, { flags: "a" }) : null;
    let tail = "";
    let out = "";
    const take = (d) => {
      tail = (tail + d).slice(-8000);
      sink?.write(d);
      if (echo) process.stderr.write(d);
    };
    child.stdout.on("data", (d) => {
      out = (out + d).slice(-200_000);
      take(d);
    });
    child.stderr.on("data", take);
    child.on("error", fail);
    child.on("exit", (code) => {
      sink?.end();
      if (code === 0) done({ out, tail });
      else fail(Object.assign(new Error(`${cmd.split("/").pop()} ${args[0]} exited ${code}:\n${tail}`), { out, tail }));
    });
  });
}

const clock = (t, ms = true) => {
  const total = Math.max(0, Math.round(t * 1000));
  const m = String(Math.floor(total / 60_000)).padStart(2, "0");
  const s = String(Math.floor(total / 1000) % 60).padStart(2, "0");
  return ms ? `${m}:${s}.${String(total % 1000).padStart(3, "0")}` : `${Number(m)}:${s}`;
};

// ------------------------------------------------------------------- plan

/** Lay one scene's narration from `start`: [{at, end, text, file, key}]. */
function layScene(name, start, clips, override = {}) {
  const t = { ...TIMING.scenes[name], ...override };
  let at = start + t.lead;
  const lines = clips.map((clip) => {
    const line = { at: r3(at), end: r3(at + clip.ms / 1000), text: clip.text, file: clip.file, key: clip.key };
    at = line.end + (t.gap ?? TIMING.gap);
    return line;
  });
  const last = lines.at(-1)?.end ?? start;
  return { start: r3(start), end: r3(Math.max(start + t.min, last + t.tail)), lines };
}

/**
 * The film on one clock: scene times and lines, the console's edit and camera,
 * every heard line and the caption cues. Pure apart from the voice bank.
 */
export async function planFilm({ film, template, timeline, bank, log = console.error }) {
  const voice = narrator(film);
  const sceneClips = {};
  await Promise.all(
    [...BEFORE, ...AFTER]
      .filter((name) => film.scenes?.[name])
      .map(async (name) => {
        const texts = film.scenes[name].narration ?? [];
        sceneClips[name] = await Promise.all(
          texts.map(async (text) => ({ text, ...(await bank.get({ voice: voice.voice, style: voice.style, lang: "en-US", text })) })),
        );
      }),
  );
  for (const [name, clips] of Object.entries(sceneClips)) {
    for (const c of clips) if (c.fidelity < 0.8) log(`  note: ${name} line read at fidelity ${c.fidelity.toFixed(2)}: "${c.transcript}"`);
  }

  // The console's edit and camera (edited-console seconds).
  const skips = skipRanges(timeline, film);
  const segments = keepSegments(timeline, { ...film.edit?.timing, skips });
  const map = timeMap(segments);
  const length = editedLength(segments);
  const moves = cameraPlan({ timeline, film, map, length, skips, opts: film.camera });
  const marks = chapters(timeline, map);
  for (const s of skips) log(`  beat ${s.beat}: skipping ${(s.to - s.from).toFixed(1)} s of footage`);

  // Scenes, the console, scenes: each starts as the last begins to fade.
  const scenes = {};
  let t = 0;
  for (const name of BEFORE) {
    if (!sceneClips[name]) continue;
    scenes[name] = layScene(name, t, sceneClips[name], film.scenes[name].timing);
    t = scenes[name].end - TIMING.overlap;
  }
  const consoleStart = r3(t);
  t = consoleStart + length - TIMING.overlap;
  for (const name of AFTER) {
    if (!sceneClips[name]) continue;
    scenes[name] = layScene(name, t, sceneClips[name], film.scenes[name].timing);
    t = scenes[name].end - TIMING.overlap;
  }
  const total = r3(t + TIMING.overlap);

  // Every line heard in the console, on the film clock: lines in skipped footage go unheard, and one running into a skip stops at it.
  const inSkip = (t) => skips.find((s) => t >= s.from && t < s.to);
  const heard = spokenLines(timeline)
    .filter((l) => {
      const s = inSkip(l.start);
      if (s && l.end > s.to + 0.05) log(`  note: beat ${s.beat}'s skip cuts "${l.text.slice(0, 50)}" mid-line; end the skip a step later or earlier`);
      return !s;
    })
    .map((l) => {
      const s = skips.find((x) => l.start < x.from && l.end > x.from);
      return s ? { ...l, end: s.from, cut: true } : l;
    })
    .map((l) => ({ ...l, at: r3(consoleStart + map(l.start)), end: r3(consoleStart + map(l.end)) }));
  const narration = Object.values(scenes).flatMap((s) => s.lines.map((l) => ({ ...l, speaker: "Narrator", role: "narrator", kind: "scene" })));
  const lines = [...narration, ...heard].sort((a, b) => a.at - b.at);
  const cues = captionCues(lines.map(({ at, end, text, speaker, role }) => ({ at, end, text, speaker, role })));

  const firstCaller = timeline.events.find((e) => e.kind === "speak" && e.role === "caller");
  const closing = moves.find((m) => m.why === "closing");
  return {
    total,
    light: isLight(template),
    reason: film.scenes?.open?.bubble === false ? "" : (film.scenes?.open?.bubble?.text ?? firstCaller?.text ?? ""),
    scenes: Object.fromEntries(Object.entries(scenes).map(([k, s]) => [k, { start: s.start, end: s.end, lines: s.lines.map(({ at, end, text }) => ({ at, end, text })) }])),
    console: {
      start: consoleStart,
      length,
      video: "edited.mp4",
      width: timeline.pixels.w,
      height: timeline.pixels.h,
      dpr: timeline.dpr,
      moves,
      chapters: marks,
      skips: skips.map((s) => ({ at: r3(map(s.to)), beat: s.beat, label: s.label })),
      closingAt: closing?.at ?? null,
      drift: film.camera?.drift ?? CAMERA.drift,
      establish: film.console?.establish ?? null,
    },
    cues,
    // Not part of the composition: the soundtrack and the deliverables use these.
    audio: { narration, heard, segments },
  };
}

// --------------------------------------------------------------- footage

/** The console footage with the plan's cuts applied (cached by its edit). */
async function editFootage(capture, segments, project) {
  const src = join(capture, "footage.mp4");
  const info = await stat(src);
  const expr = selectExpression(segments);
  const key = sha([1, info.size, Math.round(info.mtimeMs), expr]).slice(0, 16);
  const out = join(project, "edited.mp4");
  const keyFile = join(project, "edited.key");
  if (existsSync(out) && (await readFile(keyFile, "utf8").catch(() => "")) === key) return key;
  const tmp = join(project, "edited.tmp.mp4");
  await sh("ffmpeg", [
    "-hide_banner", "-nostdin", "-y", "-v", "error", "-i", src,
    "-vf", `select='${expr}',setpts=N/FRAME_RATE/TB`,
    "-an", "-c:v", "libx264", "-preset", "faster", "-crf", "10", "-tune", "animation", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", tmp,
  ]);
  await rename(tmp, out);
  await writeFile(keyFile, key);
  return key;
}

// ------------------------------------------------------------ soundtrack

async function soundtrack(plan, film, bank, file) {
  const clips = [];
  if (film.scenes?.open?.ring !== false && plan.scenes.open) for (const at of TIMING.ring) clips.push({ samples: ringBurst(), at });
  for (const line of plan.audio.narration) clips.push({ samples: await prepareClip(line.file), at: line.at });
  for (const line of plan.audio.heard) {
    const source = bank.file(line.key);
    if (!existsSync(source)) throw new Error(`voice clip ${line.key} is missing for "${line.text}": capture again`);
    const call = line.role !== "narrator";
    clips.push({ samples: await prepareClip(source, { band: call, gainDb: call ? -1 : 0 }), at: line.at, until: line.cut ? line.end : undefined });
  }
  return master(mix(clips, plan.total), file);
}

// ----------------------------------------------------------- deliverables

function speakerOf(line) {
  return line.role === "narrator" ? "Narrator" : line.speaker;
}

function transcript({ template, plan, lines }) {
  const rows = lines.map((l) => `| ${clock(l.at)} | ${speakerOf(l)} | ${l.text.replace(/\|/g, "\\|")} |`);
  return `# Transcript — ${template.name}

**Runtime:** ${clock(plan.total, false)} (${Math.round(plan.total)} seconds)

**Production disclosure:** Every voice in this film is synthetic, performed by Azure
OpenAI GPT Realtime through Azure AI Voice Live. Callers, companies and phone numbers are
fictional. The console footage is the template's own demo console running in simulation
mode; it is not a recording of a production deployment.

This transcript matches [\`captions.vtt\`](./captions.vtt), which splits long lines into
shorter cues. Timestamps are global (\`mm:ss.mmm\`) from the start of the film.

| Timecode | Speaker | Line |
|---|---|---|
${rows.join("\n")}
`;
}

function videoReadme({ id, template, plan, lines, film, loudness }) {
  const voices = new Map();
  voices.set("Narrator", narrator(film).voice);
  for (const l of plan.audio.heard) if (l.role !== "narrator" && !voices.has(l.speaker)) voices.set(l.speaker, l.voice);
  const cast = [...voices].map(([who, v]) => `\`${v}\` (${who})`);
  const beats = plan.console.chapters.length;
  return `# Video deliverables

- [\`demo.mp4\`](./demo.mp4) — narrated demo film (${clock(plan.total, false)})
- [\`poster.webp\`](./poster.webp) — poster image
- [\`captions.vtt\`](./captions.vtt) — captions for every spoken line
- [\`transcript.md\`](./transcript.md) — transcript with timecodes

The film opens on the caller's problem and how the template is built, then runs the
template's own demo console through ${beats === 1 ? "its scripted call" : `${beats} scripted calls`}, and closes on what is under the
hood and how to make it yours. Subtitles are burned in; the same lines are in
\`captions.vtt\`.

## Production details

- **Runtime:** ${plan.total.toFixed(1)} seconds (${clock(plan.total, false)}), 1920×1080, 30 fps, H.264 High with 48 kHz
  stereo AAC-LC audio.
- **Voices:** all ${lines.length} lines are performed by Azure OpenAI GPT Realtime
  (\`${MODEL}\`) through Azure AI Voice Live (api-version \`${API_VERSION}\`): ${cast.join(", ")}.
- **Console:** the template's demo console from [\`code/\`](../code/), running in
  simulation mode and driven by its presenter script (\`code/public/beats.js\`). Pauses
  while the narrator speaks are trimmed; the console is filmed as it runs, not recreated.
- **Motion graphics:** a HyperFrames composition generated by
  [\`scripts/video\`](../../../../scripts/video/) from [\`films/${id}.mjs\`](../../../../scripts/video/films/${id}.mjs).
- **Mix:** voices only, at ${loudness.lufs.toFixed(1)} LUFS integrated (target ${LOUDNESS.film}); a soft ring opens
  the film. No music or noise bed.

Callers, companies and phone numbers are fictional, and every voice is synthetic. The film
demonstrates a reference implementation in simulation mode; it is not a recording of a
production deployment.
`;
}

// -------------------------------------------------------------------- main

export async function compose(id, opts = {}) {
  const {
    captures = join(WORK, "captures"),
    out = join(WORK, "films"),
    repo = resolve(ROOT, "..", ".."),
    snap = null,
    render = true,
    draft = false,
    crf = ENCODE.crf,
    workers = "auto",
    force = false,
    log = (line) => console.error(`[${id}] ${line}`),
  } = opts;
  const film = await loadFilm(id);
  const template = JSON.parse(await readFile(join(repo, "docs", "templates", id, "template.json"), "utf8"));
  const capture = join(captures, id);
  const timeline = JSON.parse(await readFile(join(capture, "timeline.json"), "utf8"));
  const dir = join(out, id);
  const project = join(dir, "project");
  await mkdir(project, { recursive: true });

  const bank = new VoiceBank({ log });
  const plan = await planFilm({ film, template, timeline, bank, log });
  const { html, ops } = buildComposition({ film, template, plan });
  const lines = [...plan.audio.narration, ...plan.audio.heard].sort((a, b) => a.at - b.at);
  log(
    `film ${clock(plan.total, false)} (${plan.total}s): console ${plan.console.length.toFixed(1)}s from ${plan.console.start}s, ` +
      `${plan.console.moves.length} camera moves, ${lines.length} lines, ${plan.cues.length} cues, ${ops} animation ops`,
  );
  for (const [name, s] of Object.entries(plan.scenes)) log(`  ${name.padEnd(6)} ${s.start.toFixed(1).padStart(6)} → ${s.end.toFixed(1).padStart(6)}`);

  const { audio, ...rest } = plan;
  await writeFile(join(dir, "film.json"), JSON.stringify({ ...rest, lines: lines.map(({ at, end, text, speaker, role, cut }) => ({ at, end, speaker, role, cut, text })) }, null, 1));
  await writeFile(join(project, "index.html"), html);
  await copyFile(GSAP, join(project, "gsap.min.js"));
  const editKey = await editFootage(capture, audio.segments, project);

  const lint = await sh(HYPERFRAMES, ["lint", project]).catch((e) => e);
  const lintText = `${lint.out ?? ""}${lint.tail ?? ""}`;
  if (lint instanceof Error) throw new Error(`lint failed:\n${lintText.trim()}`);
  // The root composition is one file by design, so the per-element subcomposition advice is expected.
  const rules = {};
  for (const m of lintText.matchAll(/⚠ \[[^\]]*\] ([a-z_]+)/g)) rules[m[1]] = (rules[m[1]] ?? 0) + 1;
  delete rules.nested_structure_needs_subcomposition;
  if (Object.keys(rules).length) log(`lint warnings: ${Object.entries(rules).map(([k, n]) => `${k} ×${n}`).join(", ")}`);

  if (snap?.length) {
    const shots = join(dir, "snaps");
    await rm(shots, { recursive: true, force: true });
    await sh(HYPERFRAMES, ["snapshot", project, "--at", snap.join(","), "--no-end", "-o", shots]);
    log(`snapshots in ${shots}`);
  }
  if (!render) return { dir, plan };

  // The silent picture (skipped when nothing it depends on has changed).
  const silent = join(dir, draft ? "silent-draft.mp4" : "silent.mp4");
  const key = sha([html, editKey, draft, 14]);
  if (force || !existsSync(silent) || (await readFile(`${silent}.key`, "utf8").catch(() => "")) !== key) {
    const started = Date.now();
    const renderLog = join(dir, "render.log");
    await writeFile(renderLog, "");
    log(`rendering ${Math.round(plan.total * 30)} frames${draft ? " (draft)" : ""}…`);
    const tmp = silent.replace(/\.mp4$/, ".tmp.mp4");
    await sh(HYPERFRAMES, ["render", project, "-f", "30", "-q", draft ? "draft" : "delivery", "--crf", draft ? "24" : "14", "--video-frame-format", "jpg", "-w", String(workers), "-o", tmp], { log: renderLog });
    await rename(tmp, silent);
    await writeFile(`${silent}.key`, key);
    log(`rendered in ${((Date.now() - started) / 60000).toFixed(1)} min`);
  } else log("picture unchanged: reusing the render");

  const wav = join(dir, "soundtrack.wav");
  const loudness = await soundtrack(plan, film, bank, wav);
  log(`soundtrack ${loudness.lufs.toFixed(1)} LUFS, true peak ${loudness.truePeak.toFixed(1)} dBTP`);

  const demo = join(dir, "demo.mp4");
  await sh("ffmpeg", [
    "-hide_banner", "-nostdin", "-y", "-v", "error", "-i", silent, "-i", wav, "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", ENCODE.preset, "-crf", String(crf), "-x264-params", ENCODE.x264, "-pix_fmt", "yuv420p", "-profile:v", "high",
    "-c:a", "aac", "-b:a", ENCODE.audio, "-ar", "48000",
    "-metadata", `title=${template.name} — Voice AI template demo`, "-metadata", "comment=Synthetic voices: Azure OpenAI GPT Realtime. Simulation mode.",
    "-movflags", "+faststart", "-shortest", demo,
  ]);
  const title = plan.scenes.title;
  const posterAt = film.poster ?? (title ? Math.min(title.end - 0.6, title.start + 2.9) : 3);
  await sh("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-v", "error", "-ss", String(posterAt), "-i", silent, "-frames:v", "1", "-c:v", "libwebp", "-quality", "86", join(dir, "poster.webp")]);
  await writeFile(join(dir, "captions.vtt"), webvtt(plan.cues));
  await writeFile(join(dir, "transcript.md"), transcript({ template, plan, lines }));
  await writeFile(join(dir, "README.md"), videoReadme({ id, template, plan, lines, film, loudness }));
  const size = (await stat(demo)).size;
  log(`demo.mp4 ${(size / 1e6).toFixed(1)} MB, ${clock(plan.total, false)} → ${dir}`);
  return { dir, plan, size, loudness };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const id = process.argv[2];
  const opt = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  if (!id || id.startsWith("--")) {
    console.error("usage: node src/compose.mjs <template-id> [--captures DIR] [--out DIR] [--repo DIR] [--snap t1,t2] [--no-render] [--draft] [--crf N] [--workers N] [--force]");
    process.exit(2);
  }
  const snap = opt("snap", "");
  await compose(id, {
    captures: opt("captures", undefined),
    out: opt("out", undefined),
    repo: opt("repo", undefined),
    snap: snap ? snap.split(",").map(Number) : null,
    render: !process.argv.includes("--no-render"),
    draft: process.argv.includes("--draft"),
    crf: Number(opt("crf", ENCODE.crf)),
    workers: opt("workers", process.env.RENDER_WORKERS || "auto"),
    force: process.argv.includes("--force"),
  });
}
