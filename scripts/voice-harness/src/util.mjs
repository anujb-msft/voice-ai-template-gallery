export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const d = { promise, settled: false };
  d.resolve = (v) => {
    if (!d.settled) {
      d.settled = true;
      resolve(v);
    }
  };
  d.reject = (e) => {
    if (!d.settled) {
      d.settled = true;
      reject(e);
    }
  };
  promise.catch(() => {});
  return d;
}

export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message ?? `timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// North American numbers in any common spelling: +14255550123, (425) 555-0123, 425.555.0123.
// Digit lookarounds, not \b: in "+14255550123" there is no word boundary after the "1".
const NANP = /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;

/** Keep only the last four digits of every phone number, so reports are safe to share. */
export function redactPhones(text) {
  return String(text ?? "").replace(NANP, (m) => `•••-•••-${m.replace(/\D/g, "").slice(-4)}`);
}

/** Deep copy with every string redacted. */
export function redactDeep(value) {
  if (typeof value === "string") return redactPhones(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}

/** Every digit as a word, e.g. "+14255550123" -> "one four two five five five five zero one two three". */
export function speakDigits(digits) {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  return String(digits)
    .replace(/\D/g, "")
    .split("")
    .map((d) => words[Number(d)])
    .join(" ");
}

export function nationalNumber(e164) {
  const d = String(e164 ?? "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

const DIGIT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const DIGIT_SEP = "[\\s,.;:\u2013\u2014-]*";
const OH_AS_ZERO = new RegExp(`\\boh\\b(?=${DIGIT_SEP}\\d)|(?<=\\d${DIGIT_SEP})\\boh\\b`, "g");
const DIGIT_RUN = new RegExp(`\\d(?:${DIGIT_SEP}\\d)*`, "g");

/**
 * The code an agent read aloud, from what speech-to-text made of it, or null.
 * Recognizers render "four eight two nine one seven" as words, digits, pairs or
 * any mix, so words become digits and runs broken only by spaces or punctuation
 * are joined: "four, eight, 2 9 17" -> "482917". "Oh" counts as zero only next
 * to another digit. A code read twice back to back joins into one double-length
 * run, which collapses to one copy.
 */
export function heardDigits(text, length = 6) {
  let t = String(text ?? "")
    .toLowerCase()
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/g, (w) => String(DIGIT_WORDS.indexOf(w)))
    .replace(/\b(double|triple)[\s-]+(\d)\b/g, (_, n, d) => d.repeat(n === "double" ? 2 : 3));
  for (let prev = ""; prev !== t; ) [prev, t] = [t, t.replace(OH_AS_ZERO, "0")];
  const runs = (t.match(DIGIT_RUN) ?? []).map((r) => r.replace(/\D/g, ""));
  const exact = runs.find((r) => r.length === length);
  if (exact) return exact;
  const twice = runs.find((r) => r.length === 2 * length && r.slice(0, length) === r.slice(length));
  if (twice) return twice.slice(0, length);
  return runs.find((r) => r.length > length)?.slice(0, length) ?? null;
}

/** Pick the first reply whose pattern matches what the agent just said. */
export function pickReply(replies, heard, used = new Map(), maxUses = 2) {
  for (const entry of replies) {
    const [pattern, reply, opts = {}] = entry;
    const limit = opts.maxUses ?? maxUses;
    if ((used.get(entry) ?? 0) >= limit) continue;
    if (pattern.test(heard)) {
      used.set(entry, (used.get(entry) ?? 0) + 1);
      return reply;
    }
  }
  return null;
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

export const listArg = (v) =>
  v === undefined || v === true
    ? null
    : new Set(
        String(v)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );

/**
 * Why a template's `/health` says it cannot take real calls (empty when it can).
 * Templates report this differently: `callReady`, `mode: "simulation"`,
 * `telephony.ready`, or `acs.ready`, with the missing settings alongside.
 */
export function templateReadiness(health) {
  if (!health || typeof health !== "object") return ["no /health response"];
  const notReady =
    health.callReady === false ||
    health.mode === "simulation" ||
    health.telephony?.ready === false ||
    health.acs?.ready === false;
  if (!notReady) return [];
  const missing = health.missingConfig ?? health.missingCallConfig ?? health.telephony?.missing ?? health.missing ?? [];
  return [`not ready for real calls${missing.length ? ` (missing ${missing.join(", ")})` : ""}`];
}

/** "fr-CA" -> "fr". Accents of one language (en-US, en-GB) count as the same language. */
export const languageOf = (locale) =>
  String(locale ?? "")
    .split("-")[0]
    .toLowerCase();

/**
 * The locale that most of the speech was in. Takes fast-transcription phrases
 * (each labelled with its own `locale`) or anything shaped like them; the
 * locale covering the most milliseconds wins, ties go to the first one heard.
 */
export function dominantLocale(phrases = []) {
  const total = new Map();
  for (const p of phrases ?? []) {
    if (!p?.locale || !String(p.text ?? "").trim()) continue;
    total.set(p.locale, (total.get(p.locale) ?? 0) + Math.max(1, p.durationMilliseconds ?? 0));
  }
  let best = null;
  for (const [locale, ms] of total) if (!best || ms > best[1]) best = [locale, ms];
  return best?.[0] ?? null;
}

/**
 * Utterances the agent spoke in a language the scenario does not allow. Only
 * utterances of a few words count: "okay" alone is too short to tell
 * languages apart reliably.
 */
export function offLanguageUtterances(utterances, allowed = ["en-US"], { minWords = 3 } = {}) {
  const ok = new Set(allowed.map(languageOf));
  return (utterances ?? []).filter(
    (u) =>
      u?.locale &&
      !ok.has(languageOf(u.locale)) &&
      String(u.text ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean).length >= minWords,
  );
}

/**
 * The error that ended a template, from what its process printed. Node starts
 * the fatal error's line at column 0 ("TypeError: ...") and follows it with
 * the stack, so this returns that line plus the first frame in the template's
 * own code, e.g. "TypeError: x is not a function (src/voice/call-bridge.mjs:167)".
 * Null when the output holds no such line (a signal, a deliberate exit).
 */
export function crashSummary(output) {
  const lines = String(output ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/^(?:Uncaught )?(?:[A-Z]\w*)?(?:Error|Exception)\b(?: \[[\w-]+\])?:/.test(lines[i])) continue;
    const frame = lines
      .slice(i + 1)
      .map((line) => /^\s+at .*?file:\/\/\S*\/code\/((?!node_modules\/)[^\s:()]+):(\d+)/.exec(line))
      .find(Boolean);
    const error = lines[i].trim().slice(0, 200);
    return frame ? `${error} (${frame[1]}:${frame[2]})` : error;
  }
  return null;
}
