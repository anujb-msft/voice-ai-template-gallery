#!/usr/bin/env node
/**
 * Copy every hosted film into the GitHub Pages artifact, so the site plays it
 * from its own origin.
 *
 * Demo films are too large to commit. Each lives on a GitHub Release, and its
 * manifest entry (`assets.expected` in template.json) names that download as
 * its `url`. GitHub serves a release download through a redirect, as an
 * attachment of type application/octet-stream, which Safari on iPhone and iPad
 * may refuse to play. GitHub Pages serves the same file as video/mp4 with range
 * requests, so the gallery's players try this copy, at the film's `path`,
 * first and fall back to the release.
 *
 * Runs in .github/workflows/pages.yml after the catalogue is generated. The
 * generator rejects a hosted film that is also on disk, so don't run this in a
 * checkout you commit from (or delete the copies afterwards).
 *
 *   node scripts/mirror-hosted-films.js [--dry-run]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const root = path.resolve(__dirname, "..");
const docsDir = path.join(root, "docs");
const catalogue = path.join(docsDir, "data", "templates.json");

// The overview reel on the gallery's front page belongs to no template, so no
// manifest names it. docs/index.html points at the same copy and release.
const galleryFilms = [
  {
    path: "overview/overview.mp4",
    url: "https://github.com/anujb-msft/voice-ai-template-gallery/releases/download/demo-films/overview.mp4",
  },
];

const ATTEMPTS = 4;
const PARALLEL = 4;
// GitHub Pages refuses sites over 1 GB, and the films are most of this one.
const BUDGET = 900 * 1000 * 1000;

function hostedFilms() {
  const templates = JSON.parse(fs.readFileSync(catalogue, "utf8"));
  const hosted = templates.flatMap((template) =>
    ((template.assets && template.assets.expected) || []).filter(
      (asset) => asset.status === "ready" && typeof asset.url === "string" && /\.mp4$/i.test(asset.path)
    )
  );
  return [...hosted, ...galleryFilms].map((film) => {
    const dest = path.resolve(docsDir, film.path);
    if (!dest.startsWith(docsDir + path.sep)) throw new Error(`${film.path} is outside docs/`);
    return { path: film.path, url: film.url, dest };
  });
}

async function fetchOnce(url, dest) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const expected = Number(response.headers.get("content-length")) || null;
  const part = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(part));
    const { size } = fs.statSync(part);
    if (expected !== null && size !== expected) throw new Error(`received ${size} of ${expected} bytes`);
    const head = Buffer.alloc(8);
    const fd = fs.openSync(part, "r");
    try {
      fs.readSync(fd, head, 0, 8, 0);
    } finally {
      fs.closeSync(fd);
    }
    // Every MP4 opens with its ftyp box.
    if (head.toString("latin1", 4, 8) !== "ftyp") throw new Error("the download is not an MP4");
    fs.renameSync(part, dest);
    return size;
  } catch (error) {
    fs.rmSync(part, { force: true });
    throw error;
  }
}

async function mirror(film) {
  fs.mkdirSync(path.dirname(film.dest), { recursive: true });
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await fetchOnce(film.url, film.dest);
    } catch (error) {
      last = error;
      if (attempt < ATTEMPTS) await new Promise((done) => setTimeout(done, 2000 * attempt));
    }
  }
  throw new Error(`${film.url}: ${last.message}`);
}

async function main() {
  const films = hostedFilms();
  if (process.argv.includes("--dry-run")) {
    for (const film of films) console.log(`${film.url} -> docs/${film.path}`);
    return;
  }
  const queue = films.slice();
  let total = 0;
  const worker = async () => {
    for (let film = queue.shift(); film; film = queue.shift()) {
      const size = await mirror(film);
      total += size;
      console.log(`docs/${film.path} (${(size / 1e6).toFixed(1)} MB)`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, films.length) }, worker));
  console.log(`Mirrored ${films.length} films (${(total / 1e6).toFixed(0)} MB) into docs/`);
  if (total > BUDGET) {
    console.log(`::warning::The mirrored films total ${(total / 1e6).toFixed(0)} MB; GitHub Pages refuses sites over 1 GB.`);
  }
}

main().catch((error) => {
  console.error(`Film mirror failed: ${error.message}`);
  process.exit(1);
});
