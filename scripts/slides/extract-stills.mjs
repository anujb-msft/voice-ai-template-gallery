/**
 * Cuts each template's console still (stills/<id>.jpg) from a demo film at the
 * moment and crop box stills.json names: the overview reel, or the film a
 * still names for itself.
 *
 *   npm run stills [-- --reel=path/to/overview.mp4] [-- --only=<template-id>]
 *
 * Films are downloaded once into the OS temp folder; --reel uses a local copy
 * of the overview reel instead. ffmpeg must be on PATH, or named by the FFMPEG
 * environment variable.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const plan = JSON.parse(readFileSync(join(here, "stills.json"), "utf8"));
const ffmpeg = process.env.FFMPEG || "ffmpeg";

function option(name) {
  const arg = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
}

function sha256(file) {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => done(hash.digest("hex")))
      .on("error", fail);
  });
}

// The film a still is cut from: its own, if it names one, else the overview reel.
function sourceOf(still) {
  if (!still.film) return plan.source;
  if (!/^[0-9a-f]{64}$/.test(still.sha256 ?? "")) {
    throw new Error(`stills.json: ${still.id} names its own film, so it needs that film's sha256 too.`);
  }
  return { film: still.film, sha256: still.sha256 };
}

// Cached under the pinned sha256, so a film that is re-cut and re-pinned is
// downloaded afresh rather than mistaken for its old cut.
async function download(source) {
  const name = `${source.sha256.slice(0, 16)}-${basename(new URL(source.film).pathname)}`;
  const cached = join(tmpdir(), "voice-ai-template-slides", name);
  if (!existsSync(cached)) {
    mkdirSync(dirname(cached), { recursive: true });
    console.log(`Downloading ${source.film}`);
    const response = await fetch(source.film);
    if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status}): ${source.film}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(`${cached}.part`));
    renameSync(`${cached}.part`, cached);
  }
  return cached;
}

const verified = new Set();
async function filmFor(still) {
  const source = sourceOf(still);
  const given = source === plan.source ? option("reel") : null;
  const film = given ? resolve(given) : await download(source);
  if (!verified.has(film)) {
    const digest = await sha256(film);
    if (digest !== source.sha256) {
      if (!given) rmSync(film);
      console.error(
        `${given ? film : source.film} is not the film ${still.id}'s still was picked from: its sha256 is ${digest}.\n` +
          "If the film was re-cut, update its sha256 in stills.json, re-pick the `at` and `crop` of every still cut from it, then re-cut the stills and check them.",
      );
      process.exit(1);
    }
    verified.add(film);
  }
  return film;
}

const only = option("only");
const stills = plan.stills.filter((still) => !only || still.id === only);
if (!stills.length) throw new Error(`stills.json has no still for "${only}".`);

mkdirSync(join(here, "stills"), { recursive: true });
for (const still of stills) {
  const film = await filmFor(still);
  const [x, y, width, height] = still.crop;
  const out = join(here, "stills", `${still.id}.jpg`);
  // The films are BT.709 limited range; JPEG decoders expect full-range BT.601.
  const run = spawnSync(
    ffmpeg,
    [
      "-hide_banner", "-v", "error", "-y",
      "-ss", String(still.at), "-i", film,
      "-frames:v", "1", "-update", "1",
      "-vf", `crop=${width}:${height}:${x}:${y},scale=out_color_matrix=bt601:out_range=pc,format=yuvj420p`,
      "-q:v", "2", "-flags:v", "+bitexact", "-fflags", "+bitexact", "-map_metadata", "-1",
      out,
    ],
    { stdio: "inherit" },
  );
  if (run.error) throw new Error(`Could not run ffmpeg (${ffmpeg}): ${run.error.message}`);
  if (run.status !== 0) process.exit(run.status ?? 1);
  console.log(`${still.id}.jpg  ${width}x${height} at ${still.at}s  ${Math.round(statSync(out).size / 1024)} KB`);
}
