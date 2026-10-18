// Publish composed films into the gallery. A film is too large to commit, so its MP4 goes
// to a GitHub Release (one asset per template, <id>.mp4) and the gallery's Video button
// links it there. Its poster, captions, transcript and notes go to
// docs/templates/<id>/video/. Then the template's video and poster are marked ready in
// template.json, the catalogue is regenerated and the cache keys of the pages that read
// it are bumped.
//
//   node src/publish.mjs <template-id> [...more] [--from DIR] [--repo DIR]
//        [--github OWNER/NAME] [--release TAG] [--no-upload]
//
// --from: compose's output (default ~/cvp-video-work/films); --repo: this checkout;
// --github: the repository that hosts the release (default: the checkout's origin remote);
// --release: the release's tag (default demo-films, created on first use);
// --no-upload: point the docs at films that are already on the release.
// Uploading needs the GitHub CLI, signed in with write access to the repository.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const RELEASE = { tag: "demo-films", title: "Template demo films" };
/** Committed beside the template; the MP4 itself lives on the release. */
export const COMPANIONS = ["poster.webp", "captions.vtt", "transcript.md", "README.md"];
export const DELIVERABLES = ["demo.mp4", ...COMPANIONS];
/** The generator only accepts release downloads built from plain segments like these. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** m:ss, truncated like compose's runtime, so the gallery and the film's notes agree. */
const clock = (seconds) => {
  const s = Math.floor(Math.round(seconds * 1000) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
export const releaseUrl = (github, tag, id) => `https://github.com/${github}/releases/download/${tag}/${id}.mp4`;

function gh(args) {
  const run = spawnSync("gh", args, { encoding: "utf8" });
  if (run.error) throw new Error(`gh: ${run.error.message}; install the GitHub CLI and run gh auth login`);
  return run;
}

/** owner/name from the checkout's origin remote. */
function originRepo(repo) {
  const run = spawnSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8" });
  const m = run.status === 0 && run.stdout.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) throw new Error("can't read the checkout's origin remote; pass --github OWNER/NAME");
  return `${m[1]}/${m[2]}`;
}

/** Creates the release on first use; true when it did. */
export function ensureRelease(github, tag) {
  if (gh(["release", "view", tag, "-R", github, "--json", "tagName"]).status === 0) return false;
  const notes = [
    "Narrated demo films for the Voice AI template gallery, one per template (`<template-id>.mp4`). Each template's **Video** button in the gallery links its film here.",
    "",
    "Every voice is synthetic, performed by Azure OpenAI GPT Realtime through Azure AI Voice Live. Callers, companies and phone numbers are fictional, and each template's console runs in simulation mode.",
    "",
    "The films are made with `scripts/video`. Each template's `video/` folder holds the poster, captions, transcript and production notes.",
  ].join("\n");
  const run = gh(["release", "create", tag, "-R", github, "--title", RELEASE.title, "--notes", notes, "--latest=false"]);
  if (run.status !== 0) throw new Error(`gh release create ${tag}: ${run.stderr.trim()}`);
  return true;
}

/** Uploads the film as <id>.mp4, replacing an earlier cut. */
async function upload(github, tag, id, film) {
  const dir = await mkdtemp(join(tmpdir(), "film-"));
  try {
    const named = join(dir, `${id}.mp4`);
    await copyFile(film, named);
    const run = gh(["release", "upload", tag, named, "-R", github, "--clobber"]);
    if (run.status !== 0) throw new Error(`gh release upload ${id}.mp4: ${run.stderr.trim()}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The public URL must serve exactly the uploaded film, with the range requests players seek with. */
async function verify(url, bytes) {
  let last = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await new Promise((done) => setTimeout(done, 5000));
    try {
      const res = await fetch(url, { headers: { Range: "bytes=0-0" }, redirect: "follow" });
      await res.body?.cancel();
      const total = Number((res.headers.get("content-range") ?? "").split("/")[1] ?? res.headers.get("content-length"));
      if (res.status === 206 && total === bytes) return;
      last = `HTTP ${res.status}, ${total} bytes`;
    } catch (error) {
      last = error.message;
    }
  }
  throw new Error(`${url} does not serve the uploaded film (${last}; expected a 206 of ${bytes} bytes)`);
}

/** Uploads one film to the release, copies its companions into the template and marks both ready. */
export async function publish(id, { from, repo, github, tag = RELEASE.tag, upload: send = true }) {
  const src = join(from, id);
  const missing = DELIVERABLES.filter((f) => !existsSync(join(src, f)));
  if (missing.length) throw new Error(`${id}: ${src} is missing ${missing.join(", ")}; run compose first`);
  const { total } = JSON.parse(await readFile(join(src, "film.json"), "utf8"));
  const url = releaseUrl(github, tag, id);
  if (send) {
    const film = join(src, "demo.mp4");
    await upload(github, tag, id, film);
    await verify(url, (await stat(film)).size);
  }

  const video = join(repo, "docs", "templates", id, "video");
  for (const f of ["poster.webp", "captions.vtt", "transcript.md"]) await copyFile(join(src, f), join(video, f));
  const readme = await readFile(join(src, "README.md"), "utf8");
  const linked = readme.replace(
    /\[`demo\.mp4`\]\(\.\/demo\.mp4\) — narrated demo film \(([^)]+)\)/,
    (_, runtime) => `[\`${id}.mp4\`](${url}) — narrated demo film (${runtime}), on the [\`${tag}\`](https://github.com/${github}/releases/tag/${tag}) release`,
  );
  if (linked === readme) throw new Error(`${id}: README.md has no demo.mp4 line to point at the release`);
  await writeFile(join(video, "README.md"), linked);
  // The release holds the only copy: a committed one would go stale, and the generator rejects it.
  await rm(join(video, "demo.mp4"), { force: true });

  const file = join(repo, "docs", "templates", id, "template.json");
  const template = JSON.parse(await readFile(file, "utf8"));
  for (const asset of template.assets.expected) {
    if (asset.path === `templates/${id}/video/demo.mp4`) {
      asset.status = "ready";
      asset.description = `Narrated demo film (${clock(total)}), every voice performed by Azure OpenAI GPT Realtime (MP4, hosted on a GitHub Release).`;
      asset.url = url;
    } else if (asset.path === `templates/${id}/video/poster.webp`) {
      asset.status = "ready";
      asset.description = "Poster frame from the narrated demo film (WebP).";
    }
  }
  await writeFile(file, `${JSON.stringify(template, null, 2)}\n`);
  return { id, total, url };
}

/** A fresh `?v=` key for every page that loads data/templates.js. */
async function bumpCatalogueKeys(repo) {
  const docs = join(repo, "docs");
  const pages = [join(docs, "index.html"), ...readdirSync(join(docs, "templates")).map((d) => join(docs, "templates", d, "index.html"))].filter(existsSync);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const html = await Promise.all(pages.map((p) => readFile(p, "utf8")));
  // One key for all of them: today's date, numbered past any key already used today.
  const used = html.flatMap((h) => [...h.matchAll(/data\/templates\.js\?v=(\d{8})-(\d+)/g)]).filter((m) => m[1] === today).map((m) => Number(m[2]));
  const key = `${today}-${Math.max(0, ...used) + 1}`;
  await Promise.all(
    pages.map((p, i) => {
      const next = html[i].replace(/(data\/templates\.js)(\?v=[^"']*)?(["'])/g, `$1?v=${key}$3`);
      return next === html[i] ? null : writeFile(p, next);
    }),
  );
  return key;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opt = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const flags = new Set(["--from", "--repo", "--github", "--release"]);
  const ids = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !flags.has(all[i - 1]));
  if (!ids.length) {
    console.error("usage: node src/publish.mjs <template-id> [...more] [--from DIR] [--repo DIR] [--github OWNER/NAME] [--release TAG] [--no-upload]");
    process.exit(2);
  }
  const from = opt("from", join(homedir(), "cvp-video-work", "films"));
  const repo = opt("repo", resolve(here, "..", "..", ".."));
  const github = opt("github", null) ?? originRepo(repo);
  const tag = opt("release", RELEASE.tag);
  const send = !process.argv.includes("--no-upload");
  if (!github.split("/").every((s) => SEGMENT.test(s)) || github.split("/").length !== 2 || !SEGMENT.test(tag) || !ids.every((id) => SEGMENT.test(id))) {
    console.error("--github, --release and the template ids must be plain names (letters, digits, '.', '_', '-')");
    process.exit(2);
  }
  if (send && ensureRelease(github, tag)) console.log(`created the ${tag} release on ${github}`);
  for (const id of ids) {
    const { total, url } = await publish(id, { from, repo, github, tag, upload: send });
    console.log(`${id}: published (${clock(total)}) → ${url}`);
  }
  const index = spawnSync(process.execPath, [join(repo, "scripts", "generate-template-index.js")], { cwd: repo, stdio: "inherit" });
  if (index.status !== 0) process.exit(index.status ?? 1);
  console.log(`catalogue regenerated; data/templates.js?v=${await bumpCatalogueKeys(repo)}`);
}
