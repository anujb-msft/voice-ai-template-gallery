// A film script describes one template's film: who speaks with which GPT
// Realtime voice, what the narrator says around each demo beat, and the
// HyperFrames scenes before and after the console footage. See films/README.md.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const FILMS_DIR = join(here, "..", "films");

export const DEFAULT_CAST = {
  narrator: {
    name: "Narrator",
    voice: "cedar",
    style:
      "The narrator of a polished Microsoft product demo film. Warm, confident, clear and conversational, like a " +
      "keynote voice-over walking an audience through a live demo. Measured pace with natural emphasis; never salesy, " +
      "never theatrical.",
  },
  agent: {
    name: "Agent",
    voice: "marin",
    style:
      "A voice agent answering a business phone line. Friendly, calm and efficient, like an excellent front-desk " +
      "professional: warm but not bubbly, clear, natural phone delivery at an unhurried pace.",
  },
  caller: {
    name: "Caller",
    voice: "verse",
    style: "A real person on a phone call. Natural and conversational, a little informal; not theatrical.",
  },
};

export async function loadFilm(id) {
  const file = join(FILMS_DIR, `${id}.mjs`);
  if (!existsSync(file)) throw new Error(`no film script for ${id} (expected ${file})`);
  const film = (await import(pathToFileURL(file).href)).default;
  if (film.id !== id) throw new Error(`${file} declares id ${film.id}`);
  return film;
}

const matches = (pattern, text) =>
  pattern instanceof RegExp ? pattern.test(text) : String(text).trim().toLowerCase().startsWith(String(pattern).trim().toLowerCase());

const firstName = (name) => String(name ?? "").split(/\s+/)[0] || name;

/** The narrator's voice for this film. */
export function narrator(film) {
  return { ...DEFAULT_CAST.narrator, ...(film.cast?.narrator ?? {}), role: "narrator", speaker: "Narrator" };
}

/**
 * Who performs a console line. Agent lines use the film's agent; caller lines
 * use a per-line override, then the beat's caller, then the film's default.
 */
export function castLine(film, { beat, role, text }) {
  if (role === "agent") {
    const agent = { ...DEFAULT_CAST.agent, ...(film.cast?.agent ?? {}) };
    return { ...agent, role, speaker: agent.name };
  }
  const callers = film.cast?.callers ?? {};
  const override = (film.lines ?? []).find((line) => matches(line.match, text));
  const key = override?.caller ?? film.beats?.[beat]?.caller ?? "default";
  const persona = { ...DEFAULT_CAST.caller, ...(callers.default ?? {}), ...(callers[key] ?? {}) };
  return { ...persona, role: "caller", key, speaker: persona.label ?? firstName(persona.name) };
}

/** Beat numbers (1-based, as on screen) that the film shows. */
export function filmedBeats(film, beats) {
  const wanted = film.edit?.beats ?? beats.map((b) => b.index + 1);
  return wanted.map((n) => {
    const beat = beats[n - 1];
    if (!beat) throw new Error(`${film.id}: the film asks for beat ${n}, but the script has ${beats.length}`);
    return beat;
  });
}

/** Narration the capture holds for: before a step (cues), after a step settles (post), and around the beat. */
export function beatNarration(film, number) {
  const b = film.beats?.[number] ?? {};
  return { intro: b.intro ?? "", cues: b.cues ?? {}, post: b.post ?? {}, after: b.after ?? "" };
}

/** Every narrator line in the film (capture holds and HyperFrames scenes). */
export function narrationLines(film, beats) {
  const lines = [];
  for (const beat of filmedBeats(film, beats)) {
    const { intro, cues, post, after } = beatNarration(film, beat.index + 1);
    lines.push(intro, ...Object.values(cues), ...Object.values(post), after);
  }
  for (const scene of Object.values(film.scenes ?? {})) lines.push(...(scene.narration ?? []));
  return lines.filter(Boolean);
}
