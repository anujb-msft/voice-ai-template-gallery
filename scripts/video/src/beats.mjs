// Load a template's demo script (public/beats.js) outside the browser.
//
// createBeats(hooks) only builds data: steps, narration and a few prepare()
// callbacks. Hooks and browser globals are inert stand-ins, which is enough to
// read titles, steps and chain flags.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const noop = new Proxy(function () {}, { get: (_, k) => (k === "then" ? undefined : noop), apply: () => undefined });
globalThis.window ??= globalThis;
globalThis.document ??= noop;
globalThis.localStorage ??= { getItem: () => null, setItem() {} };
globalThis.location ??= { search: "" };

export async function loadBeats(repo, id) {
  const file = join(repo, "docs", "templates", id, "code", "public", "beats.js");
  if (!existsSync(file)) throw new Error(`${id} has no public/beats.js`);
  const mod = await import(pathToFileURL(file).href);
  const make = mod.createBeats ?? mod.default ?? Object.values(mod).find((v) => typeof v === "function");
  const hooks = new Proxy({}, { get: (_, k) => (k === "then" ? undefined : noop) });
  const beats = typeof make === "function" ? make(hooks) : mod.beats;
  return beats.map((beat, index) => ({
    index,
    title: beat.title,
    talk: beat.talk ?? "",
    after: beat.after ?? "",
    steps: beat.steps.map((step, i) => ({ i, ...step })),
  }));
}

/** Step indexes that need a press of Next (chained steps run on their own). */
export const clickPoints = (beat) => beat.steps.filter((s) => !s.chain).map((s) => s.i);

/** A short description of a step, for logs. */
export function describe(step) {
  switch (step.type) {
    case "say":
      return `say "${step.text}"`;
    case "dtmf":
      return `dtmf ${step.digit}`;
    case "action":
      return `action ${step.action}`;
    default:
      return step.label ? `${step.type} (${step.label})` : step.type;
  }
}
