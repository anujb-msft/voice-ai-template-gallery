/**
 * Offline intent classifier.
 *
 * This is NOT the intent engine. In a configured deployment, Voice Live decides
 * the route and calls `propose_route`. This keyword matcher exists so the sample
 * runs end to end with no Azure subscription: a typed transcript drives exactly
 * the same state machine, the same confidence gate, the same confirmation, the
 * same Teams handoff assembly. Only the classifier and the audio path are stubs.
 *
 * It is deliberately dumb and readable — if it were clever it would be mistaken
 * for the real thing.
 */

import { STATES } from "./flow.mjs";

const SIGNALS = {
  sales: [
    "buy", "purchase", "pricing", "price", "quote", "renew", "renewal", "upgrade",
    "subscription", "plan", "sales", "demo", "contract", "licence", "license", "order",
  ],
  support: [
    "broken", "error", "not working", "doesn't work", "does not work", "down", "outage",
    "fix", "install", "bug", "technical", "support", "crash", "slow", "offline", "reset",
    "login", "log in", "can't connect", "cannot connect",
  ],
  billing: [
    "invoice", "bill", "billing", "charge", "charged", "refund", "payment", "paid",
    "receipt", "overcharged", "credit card", "statement", "owe", "double charged",
  ],
  reception: [
    "person", "human", "someone", "somebody", "representative", "operator", "real agent",
    "speak to a", "talk to a",
  ],
};

/** Explicit asks for a human, which bypass classification entirely. */
export function wantsHuman(text) {
  const t = normalise(text);
  return SIGNALS.reception.some((k) => t.includes(k));
}

/**
 * Stands in for the Voice Live agent. It implements the same handle the real
 * bridge registers — `{ instruct, nudge }` — but instead of steering a model it
 * speaks the example line the flow supplies alongside each instruction. The
 * flow cannot tell the difference, which is the point: state transitions,
 * confirmations and wording all happen on the same code path a real call takes.
 */
export function registerSimulatedAgent(flow, callId) {
  flow.registerAgent(callId, {
    instruct: (_prompt, spoken) => {
      if (spoken) flow.pushTranscript(callId, "agent", spoken);
    },
    nudge: (_prompt, opts) => {
      if (opts?.spoken) flow.pushTranscript(callId, "agent", opts.spoken);
    },
  });
}

function normalise(text) {
  return ` ${String(text ?? "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ")} `;
}

/**
 * @returns {{routeId: string|null, confidence: number, matches: string[]}}
 */
export function classifyOffline(text, allowedIds = null) {
  const t = normalise(text);

  const scores = Object.entries(SIGNALS)
    .filter(([id]) => !allowedIds || allowedIds.includes(id))
    .map(([id, keywords]) => {
      const matches = keywords.filter((k) => t.includes(` ${k}`) || t.includes(`${k} `));
      return { id, matches, hits: matches.length };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  if (!scores.length) return { routeId: null, confidence: 0, matches: [] };

  const [best, runnerUp] = scores;

  // More than one category fired with comparable weight. Say so honestly and let
  // the flow ask a clarifying question rather than guessing between them.
  if (runnerUp) {
    const contest = runnerUp.hits / best.hits;
    if (contest === 1) return { routeId: best.id, confidence: 0.45, matches: best.matches };
    if (contest >= 0.5) return { routeId: best.id, confidence: 0.6, matches: best.matches };
    return { routeId: best.id, confidence: 0.8, matches: best.matches };
  }

  return { routeId: best.id, confidence: best.hits >= 2 ? 0.95 : 0.85, matches: best.matches };
}

/**
 * Feed one caller utterance through the flow exactly as the model would.
 * The presenter types; everything downstream is the real state machine.
 */
export function handleUtterance(flow, callId, text) {
  const said = String(text ?? "").trim();
  if (!said) return flow.noInput(callId);

  flow.pushTranscript(callId, "caller", said);
  const call = flow.get(callId);

  if (/^[0-9]$/.test(said)) return flow.dtmf(callId, said);
  if (wantsHuman(said)) return flow.requestHuman(callId, "explicit_request");

  // After hours the caller is dictating a message, not stating an intent.
  if (call?.state === STATES.MESSAGING) {
    return flow.takeMessage(callId, { callTopic: summarise(said), callSummary: said });
  }

  // A yes accepts the destination just offered. Anything else falls through to
  // classification again, which is how a caller changes their mind.
  if (call?.state === STATES.CONFIRMING && call.proposed && isAffirmative(said)) {
    return flow.confirmRoute(callId, call.proposed.routeId);
  }

  const { routeId, confidence } = classifyOffline(said, flow.routes.ids);
  if (!routeId) return flow.noInput(callId);

  return flow.proposeRoute(callId, {
    routeId,
    confidence,
    callTopic: summarise(said),
    callSummary: inTheirWords(call, said),
  });
}

const AFFIRMATIVE = /\b(yes|yeah|yep|correct|right|that's it|thats it|sure|please|ok|okay)\b/i;
const NEGATIVE = /\b(no|nope|not really|wrong|actually)\b/i;

export function isAffirmative(text) {
  return AFFIRMATIVE.test(String(text)) && !NEGATIVE.test(String(text));
}

// Spoken openers that say nothing about the topic: "no wait, …", "um, actually …".
// A bare "no" stays, so "no one can log in" keeps its meaning.
const OPENERS = /^(?:(?:no,?\s+(?=wait|actually|sorry)|wait|actually|sorry|um+|uh+|er+|so|well|oh|hi|hey)\b[\s,.!-]*)+/i;
// The flow's topic limit. Cutting here, at a word, keeps the Teams topic readable.
const TOPIC_CHARS = 48;

function summarise(text) {
  const said = String(text).trim();
  let topic = (said.replace(OPENERS, "") || said).replace(/[\s,.;:!?]+$/, "");
  if (topic.length > TOPIC_CHARS) {
    const cut = topic.slice(0, TOPIC_CHARS - 1);
    const space = cut.lastIndexOf(" ");
    topic = `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
  }
  return topic.charAt(0).toUpperCase() + topic.slice(1);
}

// The caller's own words so far, minus the bare yeses and keypresses, so the
// agent who picks up hears the whole story — a changed mind included.
function inTheirWords(call, said) {
  const lines = (call?.transcript ?? [])
    .filter((line) => line.role === "caller")
    .map((line) => String(line.text).trim())
    .filter((text) => text && !/^[0-9]$/.test(text) && !(isAffirmative(text) && text.split(/\s+/).length <= 3));
  const story = (lines.length ? lines : [said]).slice(-3).map((text) => `“${text.replace(/[\s.]+$/, "")}”`);
  return `Caller said: ${story.join(", then ")}`;
}
