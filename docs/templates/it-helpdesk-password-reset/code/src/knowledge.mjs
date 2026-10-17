import { readFileSync, existsSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FAQ_PATH = process.env.KNOWLEDGE_FILE
  ? resolve(root, process.env.KNOWLEDGE_FILE)
  : resolve(root, "knowledge/password-reset-faq.md");

const log = (...a) => console.log(new Date().toISOString(), "[knowledge]", ...a);

/**
 * The agent's FAQ knowledge, authored as markdown so a partner can tailor the
 * answers to their own IT policy without touching code.
 *
 * The file is small enough to sit in the prompt verbatim, which is deliberate:
 * it keeps answers exact and auditable, with no retrieval step to go wrong
 * mid-call. If your FAQ grows past a few thousand words, swap the body of
 * `knowledgeBase()` for a retrieval call — nothing else needs to change.
 *
 * Only the Q&A sections are sent. The authoring guidance and the demo script at
 * the end of the file are stripped, so editors can keep notes to themselves.
 */
let cached = null;

function parse(markdown) {
  const entries = [];
  let section = null;
  let question = null;
  let buffer = [];

  const flush = () => {
    if (!question) return;
    const answer = buffer.join("\n").trim();
    if (answer) entries.push({ section, question, answer });
    question = null;
    buffer = [];
  };

  for (const line of markdown.split(/\r?\n/)) {
    const h2 = /^##\s+(.*)$/.exec(line);
    const h3 = /^###\s+(.*)$/.exec(line);
    if (h2) {
      flush();
      section = h2[1].trim();
      continue;
    }
    if (h3) {
      flush();
      question = h3[1].trim();
      continue;
    }
    if (question) buffer.push(line);
  }
  flush();

  // Sections that are instructions to the author or the demo operator, not
  // material the agent should read back to a caller.
  const excluded = new Set(["Handing off to a human", "Try these during the demo"]);
  return entries.filter((e) => !excluded.has(e.section));
}

function load() {
  if (!existsSync(FAQ_PATH)) {
    log("no knowledge file at", FAQ_PATH, "— agent will answer from instructions only");
    return { entries: [], text: "" };
  }

  const entries = parse(readFileSync(FAQ_PATH, "utf8"));
  const text = entries
    .map((e) => `Q: ${e.question}\nA: ${e.answer.replace(/\s+/g, " ").trim()}`)
    .join("\n\n");

  log(`loaded ${entries.length} answers from ${FAQ_PATH.replace(root + "/", "")}`);
  return { entries, text };
}

export function knowledgeBase() {
  if (!cached) cached = load();
  return cached;
}

/** Reload on save so FAQ wording can be tuned between demo calls. */
export function watchKnowledge() {
  if (!existsSync(FAQ_PATH)) return;
  let debounce;
  watch(FAQ_PATH, () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      cached = null;
      knowledgeBase();
    }, 200);
  });
}

const STOPWORDS = new Set(
  ("a an the i im me my mine you your we our us is are was were be been am to of in on at for and or but do does did " +
    "can cant could will would should just this that these those it its what whats why how when where who so if not " +
    "no yes have has had with about from up out again then there they them he she his her get got any some also " +
    "please ok okay oh um uh like really very " +
    "zero one two three four five six seven eight nine").split(" "),
);
const SYNONYMS = { rules: "requirements", policy: "requirements", requirement: "requirements" };

function tokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .map((w) => SYNONYMS[w] ?? w);
}

/**
 * The approved answer to a caller's question, or null when the knowledge base
 * does not cover it. A deliberately plain keyword match, weighted so rare words
 * ("VPN", "MFA") count for more than common ones ("password"): the agent may
 * only answer from here, and saying "I'm not sure" beats a confident wrong match.
 */
export function findAnswer(question, entries = knowledgeBase().entries, { threshold = 2.2 } = {}) {
  const asked = new Set(tokens(question));
  if (!asked.size || !entries.length) return null;
  const docs = entries.map((e) => ({
    entry: e,
    title: new Set([...tokens(e.question), ...tokens(e.section)]),
    body: new Set(tokens(e.answer)),
  }));
  const idf = (t) => {
    const df = docs.filter((d) => d.title.has(t) || d.body.has(t)).length;
    return Math.log((docs.length + 1) / (df + 0.5));
  };
  let best = null;
  for (const d of docs) {
    let score = 0;
    let titleHits = 0;
    for (const t of asked) {
      if (d.title.has(t)) {
        score += 2 * idf(t);
        titleHits += 1;
      } else if (d.body.has(t)) score += 0.5 * idf(t);
    }
    if (titleHits && score >= threshold && (!best || score > best.score)) best = { score, entry: d.entry };
  }
  return best ? { question: best.entry.question, answer: best.entry.answer.replace(/\s+/g, " ").trim(), section: best.entry.section } : null;
}
