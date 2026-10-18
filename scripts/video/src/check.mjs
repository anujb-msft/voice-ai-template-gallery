// Check a film script before spending a capture on it: every narration cue
// lands on a real step, every voice is a GPT Realtime voice, the scenes are
// complete, the brand rules hold, and roughly how long the film will run.
//
//   node src/check.mjs <template-id> [...more]     check films
//   node src/check.mjs --all                       every film in films/
//
// Env: REPO  checkout holding docs/templates/<id>/code (default: this repo)
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clickPoints, describe, loadBeats } from "./beats.mjs";
import { beatNarration, castLine, DEFAULT_CAST, FILMS_DIR, filmedBeats, loadFilm, narrator } from "./film.mjs";
import { TIMING } from "./compose.mjs";
import { skipLabel, skipSteps } from "./edit.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** GPT Realtime's native voices. */
export const VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"];

// Measured from rendered films: the narrator reads about 2.75 words a second, the agent 3.5, callers 2.2.
const RATE = { narrator: 2.75, agent: 3.5, caller: 2.2 };
const PER_NARRATION = 0.75; // the capture's lead before and gap after each narrator line
const words = (s) => String(s ?? "").trim().split(/\s+/).filter(Boolean).length;
const say = (s, role = "narrator") => words(s) / RATE[role];
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}`;
const quote = (s, n = 70) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return `"${t.length > n ? `${t.slice(0, n - 1)}…` : t}"`;
};

/** A rough runtime for a step: the caller's line, the agent's reply, and the console settling. */
function stepSeconds(step) {
  switch (step.type) {
    case "start":
      return 5.5; // the call connects and the agent greets
    case "say":
      return 0.6 + say(step.text, "caller") + 4.2;
    case "wait":
      return (step.ms ?? 600) / 1000;
    default:
      return 3.5; // a keypress, silence or console action, and the reply
  }
}

function sceneSeconds(name, lines) {
  const t = TIMING.scenes[name];
  const spoken = lines.reduce((s, l) => s + say(l), 0) + Math.max(0, lines.length - 1) * TIMING.gap;
  return Math.max(t.min, t.lead + spoken + t.tail) - TIMING.overlap;
}

export async function check(id, { repo, ports = new Map() } = {}) {
  const problems = [];
  const notes = [];
  const fail = (m) => problems.push(m);
  const warn = (m) => notes.push(m);
  const report = [];

  const film = await loadFilm(id);
  const beats = await loadBeats(repo, id);

  // Where it runs, and who speaks.
  if (!Number.isInteger(film.port) || film.port < 18000 || film.port > 18999) fail(`port ${film.port} should be an unused 18xxx port`);
  else if (ports.has(film.port) && ports.get(film.port) !== id) fail(`port ${film.port} is also used by ${ports.get(film.port)}`);
  if (!film.lang) warn("lang is not set; en-US is assumed");
  const voiceOk = (who, voice) => {
    if (!VOICES.includes(voice)) fail(`${who} uses "${voice}", which is not a GPT Realtime voice (${VOICES.join(", ")})`);
  };
  const narr = narrator(film);
  const agentVoice = film.cast?.agent?.voice ?? DEFAULT_CAST.agent.voice;
  voiceOk("the narrator", narr.voice);
  voiceOk("the agent", agentVoice);
  const callers = film.cast?.callers ?? {};
  for (const [key, c] of Object.entries(callers)) {
    voiceOk(`caller ${key}`, c.voice ?? DEFAULT_CAST.caller.voice);
    if ([narr.voice, agentVoice].includes(c.voice)) warn(`caller ${key} shares the ${c.voice} voice with the narrator or agent`);
    if (!c.style) warn(`caller ${key} has no style; it will sound generic`);
    if (!c.name) warn(`caller ${key} has no name`);
  }

  // Beats: numbers, callers and where each narration line lands.
  for (const key of Object.keys(film.beats ?? {})) {
    const n = Number(key);
    if (!Number.isInteger(n) || n < 1 || n > beats.length) fail(`beats.${key} does not exist (the console has ${beats.length} beats)`);
  }
  let filmed = [];
  try {
    filmed = filmedBeats(film, beats);
  } catch (e) {
    fail(e.message);
  }
  const edit = film.edit?.beats;
  if (edit && edit.some((n, i) => i && n <= edit[i - 1])) fail("edit.beats should be ascending, without repeats");

  let consoleSeconds = 2.4 + 2.0; // establishing shot and the pull-back
  for (const beat of filmed) {
    const number = beat.index + 1;
    const b = film.beats?.[number] ?? {};
    const { intro, cues, post, after } = beatNarration(film, number);
    const says = beat.steps.filter((s) => s.type === "say" && s.text);
    if (says.length && !b.caller && !callers.default) warn(`beat ${number} has caller lines but no caller; the default voice will play them`);
    if (b.caller && !callers[b.caller]) fail(`beat ${number} uses caller "${b.caller}", which is not in cast.callers`);
    if (b.lang && !/^[a-z]{2}-[A-Z]{2}$/.test(b.lang)) fail(`beat ${number} lang "${b.lang}" should look like es-US`);
    for (const [kind, map] of [["cues", cues], ["post", post]]) {
      for (const key of Object.keys(map)) {
        const s = Number(key);
        if (!Number.isInteger(s) || s < 1 || s > beat.steps.length) fail(`beat ${number} ${kind}.${key}: the beat has steps 1–${beat.steps.length}`);
      }
    }
    for (const key of Object.keys(b.shots ?? {})) {
      if (!/^(intro|after|done|(cue|post|step) \d+)$/.test(key)) fail(`beat ${number} shots key "${key}" should be intro, after, done, "cue N", "post N" or "step N"`);
    }

    // A skip jumps past whole presses (a step and the steps chained to it); only the first press's
    // cues and the last press's posts are heard, since everything between them is cut.
    const skipList = skipSteps(b.skip);
    const presses = clickPoints(beat).map((first, p, all) => ({ first: first + 1, last: all[p + 1] ?? beat.steps.length }));
    skipList.forEach(({ from, to }, n) => {
      const head = presses.find((p) => p.first === from);
      const tail = presses.find((p) => p.last === to);
      if (![from, to].every(Number.isInteger) || from < 1 || to < from || to > beat.steps.length) {
        fail(`beat ${number} skip should be N (steps 1–N), [from, to], or a list of [from, to] within steps 1–${beat.steps.length}`);
      } else if (!head || !tail) {
        fail(`beat ${number} skip ${from}–${to} splits a press; presses are ${presses.map((p) => (p.first === p.last ? p.first : `${p.first}–${p.last}`)).join(", ")}`);
      } else if (n > 0 && from <= skipList[n - 1].to + 1) {
        fail(`beat ${number} skips ${skipList[n - 1].from}–${skipList[n - 1].to} and ${from}–${to} touch or are out of order; merge them or list them in step order`);
      } else {
        for (const k of Object.keys(cues).map(Number)) if (k > head.last && k <= to) fail(`beat ${number} cue ${k} is inside the skip, so it would go unheard`);
        for (const k of Object.keys(post).map(Number)) if (k >= from && k < tail.first) fail(`beat ${number} post ${k} is inside the skip, so it would go unheard`);
        // The skip card shows a second before the cut; the chapter slate holds from the beat's start.
        const lead = [intro, ...Object.entries(cues).filter(([k]) => Number(k) <= head.last).map(([, line]) => line)]
          .filter(Boolean)
          .reduce((s, line) => s + say(line) + PER_NARRATION, 0);
        const hold = film.console?.chapterHold ?? 4.8;
        if (from === 1 && lead < hold + 1.5) warn(`beat ${number}: about ${lead.toFixed(1)} s is said before its skip, so the skip card would land on the chapter slate; lengthen the intro`);
      }
      if ((skipLabel(b, n)?.length ?? 0) > 40) warn(`beat ${number} skipLabel "${skipLabel(b, n)}" is long; keep it to a few words`);
    });
    if (!skipList.length && b.skipLabel) warn(`beat ${number} has a skipLabel but no skip`);
    if (Array.isArray(b.skipLabel) && b.skipLabel.length !== skipList.length) warn(`beat ${number} has ${b.skipLabel.length} skip labels for ${skipList.length} skips`);
    const skips = (k) => skipList.some((s) => k >= s.from && k <= s.to);

    const who = says.length ? castLine(film, { beat: number, role: "caller", text: says[0].text }) : null;
    report.push(`  beat ${number} · ${beat.title}${who ? ` (${who.speaker}, ${who.voice}${b.lang ? `, ${b.lang}` : ""})` : ""}`);
    let seconds = 2.5;
    const spoken = [intro, ...Object.values(cues), ...Object.values(post), after].filter(Boolean);
    for (const line of spoken) seconds += say(line) + PER_NARRATION;
    if (intro) report.push(`    intro   ${quote(intro)}`);
    const starts = new Set(clickPoints(beat));
    for (const step of beat.steps) {
      const k = step.i + 1;
      if (cues[k]) report.push(`      cue ${k} ${quote(cues[k])}`);
      report.push(`    ${String(k).padStart(2)}${step.chain ? " ⤷" : starts.has(step.i) ? " ▸" : "  "}${skips(k) ? " (skipped)" : ""} ${describe(step)}`);
      if (post[k]) report.push(`     post ${k} ${quote(post[k])}`);
      if (!skips(k)) seconds += stepSeconds(step);
    }
    if (after) report.push(`    after   ${quote(after)}`);
    report.push(`    ≈ ${seconds.toFixed(0)} s`);
    consoleSeconds += seconds;
    for (const line of spoken) if (words(line) > 40) warn(`beat ${number}: a ${words(line)}-word narrator line; split or trim it (${quote(line, 50)})`);
  }

  const hits = (pattern, text) =>
    pattern instanceof RegExp ? pattern.test(text) : String(text).trim().toLowerCase().startsWith(String(pattern).trim().toLowerCase());
  for (const line of film.lines ?? []) {
    const hit = filmed.some((beat) => beat.steps.some((s) => s.type === "say" && hits(line.match, s.text)));
    if (!hit) warn(`lines override ${quote(String(line.match), 40)} matches no filmed caller line`);
    if (line.caller && !callers[line.caller]) fail(`lines override uses caller "${line.caller}", which is not in cast.callers`);
  }

  // Scenes.
  const sc = film.scenes ?? {};
  const need = (cond, msg) => cond || fail(msg);
  need(sc.open?.call?.name, "scenes.open.call.name is required");
  need(sc.open?.narration?.length, "scenes.open.narration is required");
  if ((sc.open?.narration?.length ?? 0) > 2) warn("scenes.open.narration: only the first two lines drive the menu and bubble timing");
  need(sc.title?.title, "scenes.title.title is required");
  need(sc.title?.promise, "scenes.title.promise is required");
  need(sc.how?.stages?.length >= 3, "scenes.how.stages needs 3–7 stages");
  if ((sc.how?.stages?.length ?? 0) > 7) fail("scenes.how.stages has more than 7 stages; they will not fit");
  need(sc.how?.narration?.length, "scenes.how.narration is required");
  need(sc.hood?.title, "scenes.hood.title is required");
  need(sc.hood?.points?.length, "scenes.hood.points is required");
  if ((sc.hood?.points?.length ?? 0) > 6) fail("scenes.hood.points has more than 6 rows; they will not fit");
  need(sc.hood?.narration?.length, "scenes.hood.narration is required");
  need(sc.yours?.files?.length, "scenes.yours.files is required");
  if ((sc.yours?.files?.length ?? 0) > 6) fail("scenes.yours.files has more than 6 files; they will not fit");
  need(sc.yours?.prompt, "scenes.yours.prompt is required");
  need(sc.yours?.narration?.length, "scenes.yours.narration is required");
  need(sc.close?.narration?.length, "scenes.close.narration is required");
  need(sc.close?.run, "scenes.close.run is required");
  if ((sc.yours?.prompt?.length ?? 0) > 140) warn(`scenes.yours.prompt is ${sc.yours.prompt.length} characters; it types out on screen, so keep it under 140`);
  if ((sc.title?.title?.length ?? 0) > 40) warn("scenes.title.title is long; the title shrinks to fit");
  for (const name of ["how", "hood", "yours"]) {
    const title = sc[name]?.title ?? "";
    if (title.length > 52) warn(`scenes.${name}.title is ${title.length} characters; past about 52 it wraps to two lines and crowds what sits below`);
  }
  for (const p of sc.hood?.points ?? []) if (`${p.v}`.length > 84) warn(`scenes.hood point "${p.k}" is ${`${p.v}`.length} characters; past about 84 the row wraps`);

  // Brand: Teams Phone extensibility is the phone channel; Call Automation is only its media bridge.
  const headline = [sc.title?.title, sc.title?.promise, sc.title?.eyebrow, sc.open?.call?.label, ...(sc.title?.chips ?? [])].join(" ");
  if (/Azure Communication Services|\bACS\b|Call Automation/i.test(headline)) fail("the title scene names ACS/Call Automation; Teams Phone extensibility is the channel, ACS is only the media bridge");
  const stages = sc.how?.stages ?? [];
  if (stages.length && !stages.some((s) => s.brand)) warn("no how-stage is marked brand: true (the Teams surfaces)");
  const acs = stages.findIndex((s) => /Call Automation|Communication Services/i.test(`${s.label} ${s.detail}`));
  const teams = stages.findIndex((s) => /Teams/i.test(s.label));
  if (acs >= 0 && teams >= 0 && acs < teams) warn("the how-pipeline shows Call Automation before Teams Phone");
  const allText = JSON.stringify(film);
  if (/gpt-realtime-2|GPT-4o/i.test(allText)) warn("the script mentions a model other than GPT Realtime");

  // Runtime.
  const before = ["open", "title", "how"].reduce((s, n) => s + sceneSeconds(n, sc[n]?.narration ?? []), 0);
  const after = ["hood", "yours", "close"].reduce((s, n) => s + sceneSeconds(n, sc[n]?.narration ?? []), 0);
  const total = before + consoleSeconds + after;

  return { id, film, problems, notes, report, estimate: { before, console: consoleSeconds, after, total } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repo = process.env.REPO ?? resolve(here, "..", "..", "..");
  const all = readdirSync(FILMS_DIR).filter((f) => f.endsWith(".mjs")).map((f) => f.replace(/\.mjs$/, ""));
  const ids = process.argv.includes("--all") ? all : process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!ids.length) {
    console.error("usage: node src/check.mjs <template-id> [...] | --all");
    process.exit(2);
  }
  // Ports must be unique across every film, not just the ones checked.
  const ports = new Map();
  for (const other of all) {
    try {
      const f = await loadFilm(other);
      if (ports.has(f.port)) ports.set(f.port, `${ports.get(f.port)} and ${other}`);
      else ports.set(f.port, other);
    } catch {}
  }
  let failed = 0;
  for (const id of ids) {
    let r;
    try {
      r = await check(id, { repo, ports });
    } catch (e) {
      console.log(`✗ ${id}: ${e.message}`);
      failed++;
      continue;
    }
    const e = r.estimate;
    console.log(`${r.problems.length ? "✗" : "✓"} ${id}  ≈ ${clock(e.total)} (scenes ${clock(e.before)} + console ${clock(e.console)} + scenes ${clock(e.after)})`);
    if (process.argv.includes("--steps") || ids.length === 1) console.log(r.report.join("\n"));
    for (const p of r.problems) console.log(`  ERROR ${p}`);
    for (const n of r.notes) console.log(`  note  ${n}`);
    if (r.problems.length) failed++;
  }
  process.exit(failed ? 1 : 0);
}
