// Publish films into the gallery. A film is too large to commit, so its MP4 goes to a
// GitHub Release (one asset per template, <id>.mp4); the Pages build copies it into the
// site, and the gallery plays that copy first and the release second. Its poster,
// captions, transcript and notes go to docs/templates/<id>/video/. Then the template's
// video and poster are marked ready in template.json, the catalogue is regenerated and the
// cache keys of the pages that read it are bumped.
//
// A template's film is the short one src/reel.mjs cuts (reel/<id>/, with its reel.json)
// when there is one, else the walkthrough compose made (films/<id>/demo.mp4). With a short
// film, the walkthrough goes to the release too, as <id>-walkthrough.mp4, and its
// transcript beside the film's as walkthrough-transcript.md; the film's notes link both.
// With --reel, the ids name the gallery's own reels (the overview) instead: each goes to
// the same release as <id>.mp4, and its companions to docs/<id>/, where the gallery's
// front page plays it. Either way, the site plays a new upload only after Pages deploys
// again. An upload is skipped when the release already holds the same bytes.
//
//   node src/publish.mjs <template-id> [...more] [--from DIR] [--films DIR] [--repo DIR]
//        [--github OWNER/NAME] [--release TAG] [--no-upload]
//   node src/publish.mjs --reel overview [--from DIR] [...]
//
// --from: where the films were built (default: ~/cvp-video-work/reel for a template with a
//   short film, else ~/cvp-video-work/films; with --reel, ~/cvp-video-work/reel);
// --films: compose's output, where the walkthroughs are (default ~/cvp-video-work/films);
// --repo: this checkout;
// --github: the repository that hosts the release (default: the checkout's origin remote);
// --release: the release's tag (default demo-films, created on first use);
// --no-upload: point the docs at films that are already on the release.
// Uploading needs the GitHub CLI, signed in with write access to the repository.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const RELEASE = { tag: "demo-films", title: "Template demo films" };
const WORK = join(homedir(), "cvp-video-work");
/** Committed beside the template; the MP4 itself lives on the release. */
export const COMPANIONS = ["poster.webp", "captions.vtt", "transcript.md", "README.md"];
/** A reel's companions, committed in docs/<id>/; share.jpg is the page's link preview, hero.webp its front-page still. */
export const REEL_COMPANIONS = ["poster.webp", "share.jpg", "hero.webp", "captions.vtt", "transcript.md", "README.md"];
/** The generator only accepts release downloads built from plain segments like these. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** m:ss, truncated like compose's runtime, so the gallery and the film's notes agree. */
const clock = (seconds) => {
  const s = Math.floor(Math.round(seconds * 1000) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
export const releaseUrl = (github, tag, id) => `https://github.com/${github}/releases/download/${tag}/${id}.mp4`;

export const RELEASE_NOTES = [
  "Demo films for the Voice AI template gallery. Each template has two:",
  "",
  "- `<template-id>.mp4`, a short narrated film of the template at work. Its tile in the gallery and its template page play it.",
  "- `<template-id>-walkthrough.mp4`, the template's full narrated walkthrough, where every scripted call plays out from start to finish.",
  "",
  "`overview.mp4` is the overview reel on the gallery's front page, cut from all of them.",
  "",
  "Every voice is synthetic, performed by Azure OpenAI GPT Realtime through Azure AI Voice Live. Callers, companies and phone numbers are fictional, and each template's console runs in simulation mode.",
  "",
  "The films are made with `scripts/video`. Each template's `video/` folder holds the poster, captions, transcripts and production notes; `docs/overview/` holds the reel's.",
].join("\n");

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

/** Creates the release on first use (true when it did) and keeps its notes current. */
export function ensureRelease(github, tag) {
  const view = gh(["release", "view", tag, "-R", github, "--json", "body", "-q", ".body"]);
  if (view.status === 0) {
    if (view.stdout.replace(/\r\n/g, "\n").trim() !== RELEASE_NOTES) {
      const edit = gh(["release", "edit", tag, "-R", github, "--notes", RELEASE_NOTES]);
      if (edit.status !== 0) throw new Error(`gh release edit ${tag}: ${edit.stderr.trim()}`);
    }
    return false;
  }
  const run = gh(["release", "create", tag, "-R", github, "--title", RELEASE.title, "--notes", RELEASE_NOTES, "--latest=false"]);
  if (run.status !== 0) throw new Error(`gh release create ${tag}: ${run.stderr.trim()}`);
  return true;
}

/** The release's assets by name, with the SHA-256 GitHub computed for each. */
export function releaseAssets(github, tag) {
  const release = gh(["api", `repos/${github}/releases/tags/${tag}`, "-q", ".id"]);
  if (release.status !== 0) throw new Error(`gh api releases/tags/${tag}: ${release.stderr.trim()}`);
  const run = gh(["api", "--paginate", `repos/${github}/releases/${release.stdout.trim()}/assets?per_page=100`, "-q", '.[] | [.name, (.digest // "")] | @tsv']);
  if (run.status !== 0) throw new Error(`gh api releases/${release.stdout.trim()}/assets: ${run.stderr.trim()}`);
  return new Map(run.stdout.split("\n").filter(Boolean).map((row) => row.split("\t")));
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

/** Uploads the file as `name`, replacing an earlier cut; false when the release already holds these bytes. */
async function upload(github, tag, name, file, assets) {
  if (assets?.get(name) === (await sha256(file))) return false;
  const dir = await mkdtemp(join(tmpdir(), "film-"));
  try {
    const named = join(dir, name);
    await copyFile(file, named);
    const run = gh(["release", "upload", tag, named, "-R", github, "--clobber"]);
    if (run.status !== 0) throw new Error(`gh release upload ${name}: ${run.stderr.trim()}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return true;
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

/** Points the README's ``[`<file>`](./<file>) — <what> (<runtime>)`` line at the release. */
function pointAt(readme, { id, file, what, name, url, release }) {
  const line = new RegExp(`\\[\`${literal(file)}\`\\]\\(\\./${literal(file)}\\) — ${literal(what)} \\(([^)]+)\\)`);
  const linked = readme.replace(line, (_, runtime) => `[\`${name}\`](${url}) — ${what} (${runtime}), on the ${release}`);
  if (linked === readme) throw new Error(`${id}: README.md has no ${file} line to point at the release`);
  return linked;
}

/** The walkthrough's transcript, retitled; its subtitles are burned into the walkthrough, so no captions file comes with it. */
function walkthroughTranscript(md, id) {
  const titled = md.replace(/^# Transcript — (.+)$/m, "# Transcript — $1: full walkthrough");
  const noted = titled.replace(
    /This transcript matches \[`captions\.vtt`\]\(\.\/captions\.vtt\), which splits long lines into\s+shorter cues\. Timestamps are global \(`mm:ss\.mmm`\) from the start of the film\./,
    "The walkthrough's subtitles are burned in. Timestamps are global (`mm:ss.mmm`) from the\nstart of the walkthrough.",
  );
  if (titled === md || noted === titled) throw new Error(`${id}: the walkthrough's transcript.md has no title or captions note to rewrite`);
  return noted;
}

/**
 * Uploads one template's film to the release, copies its companions into the template and
 * marks both ready. With a short film (from src/reel.mjs), the walkthrough goes up beside it.
 */
export async function publish(id, { from, films = join(WORK, "films"), repo, github, tag = RELEASE.tag, upload: send = true, assets }) {
  const src = join(from ?? join(WORK, existsSync(join(WORK, "reel", id, "reel.json")) ? "reel" : "films"), id);
  const short = existsSync(join(src, "reel.json"));
  const film = join(src, short ? `${id}.mp4` : "demo.mp4");
  const walk = short ? { film: join(films, id, "demo.mp4"), transcript: join(films, id, "transcript.md") } : null;
  const missing = [film, ...COMPANIONS.map((f) => join(src, f)), ...(walk ? [walk.film, walk.transcript] : [])].filter((f) => !existsSync(f));
  if (missing.length) throw new Error(`${id}: missing ${missing.join(", ")}; run ${short ? `compose, then npm run reel -- ${id}` : "compose"} first`);
  const { total } = JSON.parse(await readFile(join(src, short ? "reel.json" : "film.json"), "utf8"));
  const url = releaseUrl(github, tag, id);
  const walkUrl = releaseUrl(github, tag, `${id}-walkthrough`);
  const sent = [];
  if (send) {
    // The walkthrough first: on a first publish it is still the release's only copy, as <id>.mp4.
    for (const [name, file, at] of [...(walk ? [[`${id}-walkthrough.mp4`, walk.film, walkUrl]] : []), [`${id}.mp4`, film, url]]) {
      if (await upload(github, tag, name, file, assets)) sent.push(name);
      await verify(at, (await stat(file)).size);
    }
  }

  const video = join(repo, "docs", "templates", id, "video");
  for (const f of ["poster.webp", "captions.vtt", "transcript.md"]) await copyFile(join(src, f), join(video, f));
  const release = `[\`${tag}\`](https://github.com/${github}/releases/tag/${tag}) release`;
  let readme = await readFile(join(src, "README.md"), "utf8");
  readme = pointAt(readme, { id, file: short ? `${id}.mp4` : "demo.mp4", what: "narrated demo film", name: `${id}.mp4`, url, release });
  if (walk) readme = pointAt(readme, { id, file: `${id}-walkthrough.mp4`, what: "the full narrated walkthrough", name: `${id}-walkthrough.mp4`, url: walkUrl, release: "same release" });
  await writeFile(join(video, "README.md"), readme);
  if (walk) await writeFile(join(video, "walkthrough-transcript.md"), walkthroughTranscript(await readFile(walk.transcript, "utf8"), id));
  else await rm(join(video, "walkthrough-transcript.md"), { force: true });
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
  return { id, total, url, walkthrough: walk ? walkUrl : null, sent };
}

/**
 * Uploads a reel to the release as <id>.mp4 and copies its companions into docs/<id>/.
 * No manifest names the reel: the gallery's front page (docs/index.html) and the Pages
 * mirror (scripts/mirror-hosted-films.js) point at it directly.
 */
export async function publishReel(id, { from, repo, github, tag = RELEASE.tag, upload: send = true, assets }) {
  const src = join(from, id);
  const missing = [`${id}.mp4`, "reel.json", ...REEL_COMPANIONS].filter((f) => !existsSync(join(src, f)));
  if (missing.length) throw new Error(`${id}: ${src} is missing ${missing.join(", ")}; run npm run reel -- ${id} first`);
  const { total } = JSON.parse(await readFile(join(src, "reel.json"), "utf8"));
  const url = releaseUrl(github, tag, id);
  const sent = [];
  if (send) {
    const film = join(src, `${id}.mp4`);
    if (await upload(github, tag, `${id}.mp4`, film, assets)) sent.push(`${id}.mp4`);
    await verify(url, (await stat(film)).size);
  }

  const docs = join(repo, "docs", id);
  await mkdir(docs, { recursive: true });
  for (const f of REEL_COMPANIONS.filter((f) => f !== "README.md")) await copyFile(join(src, f), join(docs, f));
  const readme = await readFile(join(src, "README.md"), "utf8");
  const release = `[\`${tag}\`](https://github.com/${github}/releases/tag/${tag}) release`;
  await writeFile(join(docs, "README.md"), pointAt(readme, { id, file: `${id}.mp4`, what: "the overview reel", name: `${id}.mp4`, url, release }));
  return { id, total, url, sent };
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

/**
 * The site plays its own copy of each film (scripts/mirror-hosted-films.js), which only
 * the Pages workflow refreshes. A re-mix can leave nothing to commit, so say how to deploy.
 */
const redeployNote = (github) =>
  "The gallery plays its own copy of each film, refreshed when GitHub Pages deploys: push these docs changes to main, " +
  `or, with nothing to push, run: gh workflow run pages.yml -R ${github}`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const opt = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const flags = new Set(["--from", "--films", "--repo", "--github", "--release"]);
  const ids = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !flags.has(all[i - 1]));
  const reel = process.argv.includes("--reel");
  if (!ids.length) {
    console.error("usage: node src/publish.mjs [--reel] <id> [...more] [--from DIR] [--films DIR] [--repo DIR] [--github OWNER/NAME] [--release TAG] [--no-upload]");
    process.exit(2);
  }
  const from = opt("from", reel ? join(WORK, "reel") : undefined);
  const films = opt("films", join(WORK, "films"));
  const repo = opt("repo", resolve(here, "..", "..", ".."));
  const github = opt("github", null) ?? originRepo(repo);
  const tag = opt("release", RELEASE.tag);
  const send = !process.argv.includes("--no-upload");
  if (!github.split("/").every((s) => SEGMENT.test(s)) || github.split("/").length !== 2 || !SEGMENT.test(tag) || !ids.every((id) => SEGMENT.test(id))) {
    console.error("--github, --release and the template ids must be plain names (letters, digits, '.', '_', '-')");
    process.exit(2);
  }
  if (send && ensureRelease(github, tag)) console.log(`created the ${tag} release on ${github}`);
  const assets = send ? releaseAssets(github, tag) : null;
  const uploaded = (sent) => (sent.length ? `uploaded ${sent.join(", ")}` : send ? "already on the release" : "not uploaded");
  if (reel) {
    for (const id of ids) {
      const { total, url, sent } = await publishReel(id, { from, repo, github, tag, upload: send, assets });
      console.log(`${id}: reel published (${clock(total)}, ${uploaded(sent)}) → ${url}; companions in docs/${id}/`);
    }
    if (send) console.log(redeployNote(github));
    process.exit(0);
  }
  for (const id of ids) {
    const { total, url, walkthrough, sent } = await publish(id, { from, films, repo, github, tag, upload: send, assets });
    console.log(`${id}: published (${clock(total)}, ${uploaded(sent)}) → ${url}${walkthrough ? `; walkthrough → ${walkthrough}` : ""}`);
  }
  const index = spawnSync(process.execPath, [join(repo, "scripts", "generate-template-index.js")], { cwd: repo, stdio: "inherit" });
  if (index.status !== 0) process.exit(index.status ?? 1);
  console.log(`catalogue regenerated; data/templates.js?v=${await bumpCatalogueKeys(repo)}`);
  if (send) console.log(redeployNote(github));
}
