/**
 * Offline stand-in for the voice agent.
 *
 * This is NOT the conversation engine. On a real call, Voice Live talks to the
 * caller and calls `save_lead` / `classify_non_sales`. This keyword matcher
 * exists so the sample runs end to end with no Azure subscription: a typed
 * transcript drives the same state machine, the same business hours, the same
 * scoring, the same on-call decision and the same Teams handoff. Only the
 * language understanding and the audio path are stubs.
 *
 * It is deliberately plain and readable. If it were clever it would be mistaken
 * for the real thing.
 */

import { STATES } from "./flow.mjs";
import { classifyRole, maskPhone, normaliseEmail, normalisePhone, phoneGroups, stateFromText } from "./policy.mjs";

const TERMINAL = new Set([STATES.TRANSFERRED, STATES.ENDED]);
const HANDING_OFF = new Set([STATES.PAGING, STATES.TRANSFERRING]);

const PRICE_PREFACE = "I can't quote that, but I'll note it so your rep can give you an exact answer.";
const PERSON_LINE = "I'll check who's available as soon as I've confirmed your details.";
const HOLD_LINE = "I'm still ringing our on-call rep. Please stay on the line.";
const EMERGENCY_LINE = "If this is an emergency, please hang up and call emergency services now.";
const NO_CONTACT_LINE = "I don't have a way for our team to reach you, so please call us back anytime. Thanks for calling.";
// A question the caller doesn't answer is asked twice, then skipped.
const MAX_ASKS = 2;
const MAX_READ_BACKS = 3;
const FIELDS_FOR_ONE_SHOT = ["productInterest", "quantity", "timeline", "company", "role"];
// Set once: a later "from Seattle" must not overwrite the company the caller gave.
const KEEP_FIRST = new Set(["name", "company", "location"]);

// ------------------------------------------------------------------ classifiers

const EMERGENCY_RE =
  /\b(?:ambulance|police|injur(?:y|ed|ies)|bleeding|gas leak|on fire|fire department|someone(?:'s| is) hurt)\b|\bemergency\b(?!\s+(?:order|shipment|delivery|purchase|restock|supply|supplies))/i;
const SPAM_RE = /\b(?:robocall|recorded message|unsubscribe|(?:extended|car|your) warranty|seo services|crypto|press 1 to|spam)\b/i;
const EXISTING_CUSTOMER_RE =
  /\b(?:existing order|where is my order|order (?:status|number)|tracking number|(?:hasn't|has not|didn't|did not|never) arrived?|damaged (?:shipment|order|delivery)|return (?:an?|my|the) (?:order|item)|service issue|already (?:bought|ordered)|invoice (?:problem|issue)|billing)\b/i;
const JOB_SEEKER_RE =
  /\b(?:looking for (?:a )?(?:job|work)|job (?:opening|application|posting)s?|(?:are you )?hiring|r[eé]sum[eé]|apply (?:for|to) (?:a |the )?(?:job|position|role)|careers? page|employment|open positions?)\b/i;
// A bare "available" is not a price question: "is anyone available tonight?" asks for a person.
const PRICE_RE =
  /\b(?:prices?|pricing|quote|cost|how much|stock|availability|delivery date|(?:can|could|will) you (?:deliver|ship)|(?:is|are) (?:it|they|those|these)\b[^.?!]*\bavailable)\b/i;
const PERSON_RE =
  /\b(?:(?:talk|speak) (?:to|with) (?:someone|somebody|anyone|a person|a human|a real person|a (?:sales )?rep(?:resentative)?)|anyone there|is anyone|someone tonight|real person|live person)\b/i;
const AFFIRM_RE =
  /^\s*(?:yes|yeah|yep|yup|correct|right|sure|it is)\b|\b(?:that's right|that is right|that's correct|that's the (?:best|right) number|that's my (?:cell|number|mobile))\b/i;
const NEGATE_RE = /^\s*(?:no|nope|nah)\b|\b(?:wrong|not right|not correct|that's not|that isn't|incorrect)\b/i;

const isAffirmative = (text) => AFFIRM_RE.test(text) && !NEGATE_RE.test(text);
const isNegative = (text) => NEGATE_RE.test(text);

/**
 * What kind of thing the caller said: a non-sales kind the flow closes politely
 * ("emergency", "spam", "existing-customer", "job-seeker"), a "price" question
 * the agent must not answer, a request for a "person", or plain "sales" detail.
 */
export function classifyUtterance(text) {
  const t = String(text ?? "");
  if (EMERGENCY_RE.test(t)) return "emergency";
  if (SPAM_RE.test(t)) return "spam";
  if (EXISTING_CUSTOMER_RE.test(t)) return "existing-customer";
  if (JOB_SEEKER_RE.test(t)) return "job-seeker";
  if (PRICE_RE.test(t)) return "price";
  if (PERSON_RE.test(t)) return "person";
  return "sales";
}

function nonSalesKind(text) {
  const kind = classifyUtterance(text);
  return ["emergency", "spam", "existing-customer", "job-seeker"].includes(kind) ? kind : null;
}

// ------------------------------------------------------------------ extraction

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const NAME_RE = /(?:\b[Mm]y name is|\b[Tt]his is|\bI am|\bI'm|\bi'm|\bIt's)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/;
const COMPANY_RE = /\b(?:from|at|with)\s+([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*)*)/;
const AFTER_COMMA_RUN_RE = /,\s*([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*)*)/;
const OPENER_RE = /^\s*(?:(?:hi|hello|hey|yes|yeah|yep|sure|okay|ok|well|um|uh|so|oh|sorry)\b[,.!]?\s*)*/i;
const NOT_A_NAME = new Set([
  "I", "I'm", "It", "It's", "This", "That", "That's", "We", "We're", "Our", "My", "The", "A", "An", "And", "No",
  "Not", "Thanks", "Thank", "Please", "Just", "Can", "Is", "Are", "Do", "What", "How", "When", "Who", "Yes",
]);

const QUANTITY_RE =
  /\b(?:need|needs|needed|want|wants|about|around|roughly|approximately|ordering|order|buy|buying|get|getting|looking at|for)\s+(?:about\s+|around\s+|roughly\s+|approximately\s+)?(\d[\d,]*)(?![\d,]*\s*(?:days?|weeks?|months?|years?|hours?|minutes?|am|pm|percent|%|o'clock)\b)/i;
const QUANTITY_UNIT_RE =
  /\b(\d[\d,]*)\s+(?:units?|pieces?|pcs|bolts?|nuts?|screws?|washers?|cartons?|boxes|box|fittings?|couplers?|valves?|barbs?|mailers?|rolls?|pallets?|cases?|hex|lock|brass|stainless|flat|machine|corrugated|poly|hose|ball|packing|pallet)\b/i;
const BARE_NUMBER_RE = /\b(\d[\d,]*)\b/;

// Checked in order, so "by tomorrow morning" wins over "tomorrow".
const TIMELINES = [
  [/\b(?:by )?(?:the )?end of (?:the|this) month\b/i, "by the end of the month"],
  [/\b(?:by )?tomorrow morning\b/i, "by tomorrow morning"],
  [/\bfirst thing (?:tomorrow|in the morning)\b/i, "first thing tomorrow"],
  [/\btomorrow\b/i, "tomorrow"],
  [/\b(?:by|before|need(?:ed)?(?: (?:it|them))?) tonight\b/i, "tonight"],
  [/\b(?:by|before|need(?:ed)?(?: (?:it|them))?) today\b|\bend of (?:the )?day\b/i, "today"],
  [/\b(?:by )?(?:the )?end of (?:the|this) week\b/i, "by the end of this week"],
  [/\bthis week\b/i, "this week"],
  [/\bnext week\b/i, "next week"],
  [/\b(?:in|within) (?:two|2) weeks\b/i, "in two weeks"],
  [/\bnext month\b/i, "next month"],
  [/\bthis month\b/i, "this month"],
  [/\bnext quarter\b/i, "next quarter"],
  [/\bthis quarter\b/i, "this quarter"],
  [/\bin a (?:few|couple of) months\b/i, "in a few months"],
  [/\bwithin (?:30|thirty) days\b/i, "within 30 days"],
  [/\bwithin (?:60|sixty) days\b/i, "within 60 days"],
  [/\bwithin (?:90|ninety) days\b/i, "within 90 days"],
  [/\bnext year\b/i, "next year"],
  [/\basap\b|\bas soon as possible\b/i, "ASAP"],
  [/\bno rush\b/i, "no rush"],
  [/\bjust (?:exploring|looking|researching)\b/i, "just exploring"],
];

const TITLE = "(?:owner|founder|president|director|vp|buyer|manager|engineer|supervisor|specialist|planner|technician|coordinator|lead(?!\\s+time)|assistant|officer|purchaser|agent)";
// Up to two words before the title ("procurement director", "plant operations manager"),
// but never a word that starts a different phrase ("calling about…", "from…").
const TITLE_WORDS = `(?:(?!(?:calling|looking|about|from|with|for|at|in|and|so|but|it|is|the|a|an|our|my)\\b)[a-z][a-z-]*\\s+){0,2}${TITLE}`;
const ROLE_AFTER_SELF_RE = new RegExp(`\\b(?:i'm|i am|as)\\s+(?:(?:the|a|an|our)\\s+)?(${TITLE_WORDS})\\b`, "i");
const ROLE_AFTER_COMMA_RE = new RegExp(`,\\s*(?:(?:the|a|an|our)\\s+)?(${TITLE_WORDS})\\b`, "i");
const ROLE_ANYWHERE_RE = new RegExp(`\\b(${TITLE_WORDS})\\b`, "i");
const ROLE_DEFERS_RE =
  /\b(?:not me|not my call|not (?:the|my) decision|not the decision maker|i (?:just )?recommend|(?:my )?(?:boss|manager|director|owner|supervisor|someone else) (?:decides|signs off|approves|makes the (?:call|decision)))\b/i;
const ROLE_DECIDES_RE = /\b(?:yes|yeah|yep|that's me|it's me|that would be me|my call|i sign off|i decide|i approve|i make the (?:call|decision)|i do)\b/i;

const clip = (value, limit) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length <= limit ? s : `${s.slice(0, limit - 1).trimEnd()}…`;
};
const fmt = (n) => Number(n).toLocaleString("en-US");
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const firstName = (name) => (name ? String(name).trim().split(/\s+/)[0] : null);
const toNumber = (digits) => {
  const n = Number(String(digits ?? "").replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const withoutContacts = (text) =>
  String(text ?? "")
    .replace(new RegExp(PHONE_RE.source, "g"), " ")
    .replace(new RegExp(EMAIL_RE.source, "g"), " ");

/** A capitalized run at the start of an answer: "Dana Morgan, Northwind Traders." */
function leadingRun(text, maxWords = 4) {
  const m = String(text ?? "").replace(OPENER_RE, "").match(/^([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*)*)/);
  if (!m) return null;
  const words = m[1].split(/\s+/);
  return NOT_A_NAME.has(words[0]) ? null : words.slice(0, maxWords).join(" ");
}

function afterCommaRun(text) {
  const run = String(text ?? "").match(AFTER_COMMA_RUN_RE)?.[1];
  return run && !NOT_A_NAME.has(run.split(/\s+/)[0]) ? run : null;
}

function findQuantity(text, asked) {
  const m = text.match(QUANTITY_RE) ?? text.match(QUANTITY_UNIT_RE) ?? (asked === "quantity" ? text.match(BARE_NUMBER_RE) : null);
  const value = m ? toNumber(m[1]) : null;
  return value ? { value, index: m.index + m[0].length - m[1].length } : null;
}

/** The product named next to the quantity wins: "our packaging line is down and we need 6,000 lock nuts". */
function findProduct(text, catalog, quantity) {
  const near = quantity ? text.slice(quantity.index, quantity.index + 48) : null;
  const line = (near && catalog.findLine(near)) || catalog.findLine(text);
  if (!line) return null;
  return { line, family: (near && productNoun(near, line, catalog)) || productNoun(text, line, catalog) };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What the caller called it, when that is more specific than the line name: a
 * SKU family ("hex bolts") or a plural alias ("cartons"). Null for "packaging".
 */
function productNoun(text, line, catalog) {
  const said = String(text ?? "");
  const family = catalog.skuFamilyIn(said, line.id);
  if (family) return family;
  const lineName = line.name.toLowerCase();
  const aliases = catalog.lines.find((l) => l.id === line.id)?.aliases ?? [];
  let best = null;
  for (const alias of aliases) {
    if (!isPlural(alias) || lineName.includes(alias.toLowerCase())) continue;
    const at = said.search(new RegExp(`\\b${escapeRe(alias)}\\b`, "i"));
    if (at >= 0 && (!best || at < best.at)) best = { alias, at };
  }
  return best?.alias ?? null;
}

function findTimeline(text, asked) {
  for (const [re, phrase] of TIMELINES) if (re.test(text)) return phrase;
  if (asked !== "timeline") return null;
  const words = clip(text.replace(OPENER_RE, "").replace(/[.!?]+$/, ""), 60);
  return words.length > 1 ? words : null;
}

/**
 * The caller's title, and whether they make the call. "Not me, I'm the
 * maintenance engineer. I recommend what we buy." becomes "maintenance engineer
 * (recommends)", which the qualification rules score as an influencer.
 */
function findRole(text, asked) {
  const askedRole = asked === "role";
  const title = (
    text.match(ROLE_AFTER_SELF_RE)?.[1] ??
    text.match(ROLE_AFTER_COMMA_RE)?.[1] ??
    (askedRole ? text.match(ROLE_ANYWHERE_RE)?.[1] : null)
  )?.toLowerCase().replace(/^(?:the|a|an|our)\s+/, "") ?? null;
  if (!title && !askedRole) return null;
  if (ROLE_DEFERS_RE.test(text)) return title ? `${title} (recommends)` : "not the decision maker";
  if (askedRole && ROLE_DECIDES_RE.test(text)) {
    if (!title) return "decision maker";
    return classifyRole(title) === "decisionMaker" ? title : `${title} (decision maker)`;
  }
  return title;
}

/**
 * Pulls lead fields out of one utterance. `asked` is the question the caller is
 * answering, which lets a bare "Dana Morgan" or "5,000" count. Only fields the
 * caller actually said are returned.
 */
export function extractFields(text, catalog, { asked = null, draft = {} } = {}) {
  const said = String(text ?? "");
  const bare = withoutContacts(said);
  const out = {};

  const phone = said.match(PHONE_RE)?.[0];
  if (phone) out.callbackPhone = normalisePhone(phone);
  const email = said.match(EMAIL_RE)?.[0];
  if (email) out.email = normaliseEmail(email) ?? email.toLowerCase();

  const name = said.match(NAME_RE)?.[1] ?? (asked === "identity" && !draft.name ? leadingRun(said, 2) : null);
  if (name) out.name = name;
  const company =
    said.match(COMPANY_RE)?.[1] ??
    (asked === "identity" ? (draft.name || !name ? leadingRun(said) : afterCommaRun(said)) : null);
  if (company && company !== name) out.company = company;

  const quantity = findQuantity(bare, asked);
  if (quantity) out.quantity = quantity.value;
  const product = findProduct(bare, catalog, quantity);
  if (product) {
    out.productInterest = product.family ?? product.line.name;
    out.line = product.line;
  } else if (asked === "product" && !isAffirmative(said) && !isNegative(said)) {
    const words = clip(bare.replace(OPENER_RE, "").replace(/[.!?]+$/, ""), 60);
    if (words.length > 1) out.productInterest = words;
  }

  const timeline = findTimeline(bare, asked);
  if (timeline) out.timeline = timeline;
  const role = findRole(bare, asked);
  if (role) out.role = role;
  const location = stateFromText(bare);
  if (location) out.location = location;
  return out;
}

const hasConfirmedContact = (d) => Boolean((d.callbackPhone && d.phoneConfirmed) || (d.email && d.emailConfirmed));

/** What a one-shot transcript still needs before it can be saved. */
export function missingFields(draft = {}) {
  const missing = FIELDS_FOR_ONE_SHOT.filter((key) => !draft[key]);
  if (!hasConfirmedContact(draft)) missing.push("contact");
  return missing;
}
// ---------------------------------------------------------------- the stand-in

/**
 * Stands in for the Voice Live agent. It implements the same handle the real
 * bridge registers, `{ instruct, nudge }`, but instead of steering a model it
 * speaks the line the flow supplies with each instruction. The flow cannot tell
 * the difference, which is the point: every decision and every word the caller
 * hears comes from the same code path a real call takes.
 *
 * A registered call is a conversation: the stand-in asks for what is missing,
 * reads the callback number back, and only then saves.
 */
export function registerSimulatedAgent(flow, id) {
  flow.registerAgent(id, {
    instruct: (_prompt, spoken) => {
      if (spoken) flow.pushTranscript(id, "agent", spoken);
    },
    nudge: (_prompt, opts) => {
      if (opts?.spoken) flow.pushTranscript(id, "agent", opts.spoken);
    },
  });
  const call = flow.get(id);
  call.conversational = true;
  call.dialog = { asked: null, asks: {}, ackedProduct: false, ackedQuantity: false, thanked: false, personSaid: false, corrected: false };
  flow.expectReadBack(id);
}

/**
 * Feeds one caller utterance through the flow, as the model would. The
 * presenter types; everything downstream is the real state machine.
 */
export function handleUtterance(flow, id, text) {
  const call = flow.get(id);
  if (!call || TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
  const said = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!said) return flow.noInput(id);

  // A single key is a keypress, not speech. Only 0 ("a person, please") means anything.
  if (/^[0-9*#]$/.test(said)) {
    const result = flow.dtmf(id, said);
    if (result.askedForPerson && call.dialog) call.dialog.personSaid = true;
    return result;
  }

  const budget = flow.checkBudget(id);
  if (TERMINAL.has(call.state)) return budget;

  flow.pushTranscript(id, "caller", said);

  const kind = nonSalesKind(said);
  if (kind === "emergency" && HANDING_OFF.has(call.state)) return flow.say(id, EMERGENCY_LINE);
  // Mid-conversation, a sales caller who mentions billing is still a sales caller.
  if (kind && (kind === "emergency" || !call.conversational || !hasSalesDetail(flow, call, said))) {
    return flow.classifyNonSales(id, kind, clip(said, 200));
  }

  const priceAsked = PRICE_RE.test(said);
  if (priceAsked) {
    const note = `Caller asked: "${clip(said, 160)}" Agent did not quote price, stock, or delivery commitment.`;
    flow.updateFields(id, { notes: [call.draft.notes, note].filter(Boolean).join(" ") });
  }

  return call.conversational ? converse(flow, id, said, priceAsked) : oneShot(flow, id, said, priceAsked);
}

function hasSalesDetail(flow, call, said) {
  const d = call.draft;
  return Boolean(d.productInterest || d.quantity || d.timeline || flow.catalog.findLine(said));
}

/**
 * Feeds a whole typed transcript, line by line, stopping once the call is over.
 * Waits for any transfer in flight after each line.
 */
export async function runTranscript(flow, id, lines = []) {
  let result = null;
  for (const line of lines) {
    if (TERMINAL.has(flow.get(id)?.state)) break;
    result = handleUtterance(flow, id, line);
    await flow.settled(id);
  }
  return { result, snapshot: flow.snapshot(id) };
}

/**
 * Without a registered stand-in (the unit tests), each utterance is a complete
 * dictation: a number or email the caller states counts as confirmed, and the
 * lead is saved as soon as nothing is missing.
 */
function oneShot(flow, id, said, priceAsked) {
  const call = flow.get(id);
  if (priceAsked) flow.say(id, PRICE_PREFACE);
  const found = extractFields(said, flow.catalog, { draft: call.draft });
  const patch = mergeable(call.draft, found);
  if (patch.callbackPhone) patch.phoneConfirmed = true;
  if (patch.email) patch.emailConfirmed = true;
  if (Object.keys(patch).length) flow.updateFields(id, patch);
  const missing = missingFields(call.draft);
  if (!missing.length) return flow.saveLead(id, {});
  return { ok: true, draft: flow.publicDraft(call), awaiting: missing };
}

function mergeable(draft, found) {
  const patch = {};
  for (const [key, value] of Object.entries(found)) {
    if (key === "line" || value == null) continue;
    if (KEEP_FIRST.has(key) && draft[key]) continue;
    patch[key] = value;
  }
  return patch;
}
// ---------------------------------------------------------------- conversation

/**
 * One conversational turn: take what the caller said, acknowledge it, and ask
 * for the next thing that is missing. The callback number is always read back,
 * and the caller's answer decides which number is saved.
 */
function converse(flow, id, said, priceAsked) {
  const call = flow.get(id);
  const dialog = call.dialog;
  if (HANDING_OFF.has(call.state)) {
    flow.say(id, HOLD_LINE);
    return { ok: true, holding: true };
  }

  const asked = dialog.asked;
  const found = extractFields(said, flow.catalog, { asked, draft: call.draft });
  const { callbackPhone, email, ...details } = mergeable(call.draft, found);
  if (Object.keys(details).length) flow.updateFields(id, details);

  const parts = priceAsked ? [PRICE_PREFACE] : [];
  if (!dialog.thanked && call.draft.name) {
    parts.push(`Thanks, ${firstName(call.draft.name)}.`);
    dialog.thanked = true;
  }
  const ack = acknowledge(flow, call);
  if (ack) parts.push(ack);

  let personLine = null;
  if (PERSON_RE.test(said)) {
    flow.requestPerson(id);
    if (!dialog.personSaid) personLine = PERSON_LINE;
  }

  const directive = takeContact(flow, id, { asked, said, callbackPhone, email });
  return nextStep(flow, id, parts, { directive, personLine });
}

/** Applies a number or email the caller gave, and their answer to a read-back. */
function takeContact(flow, id, { asked, said, callbackPhone, email }) {
  const call = flow.get(id);
  const draft = call.draft;
  if (asked === "readBack") {
    if (callbackPhone && callbackPhone !== draft.callbackPhone) {
      flow.updateFields(id, { callbackPhone, phoneConfirmed: false });
      flow.logEvent(id, "caller", "phone_corrected", maskPhone(callbackPhone));
      call.dialog.corrected = true;
      return null;
    }
    if (callbackPhone || isAffirmative(said)) {
      flow.updateFields(id, { phoneConfirmed: true });
      flow.logEvent(id, "caller", "phone_confirmed", maskPhone(draft.callbackPhone));
      return null;
    }
    if (isNegative(said)) return "askPhone";
  }
  if (asked === "emailReadBack" && !callbackPhone) {
    if (isAffirmative(said) && !email) {
      flow.updateFields(id, { emailConfirmed: true });
      flow.logEvent(id, "caller", "email_confirmed", null);
      return null;
    }
    if (isNegative(said) && !email) return "askPhone";
  }
  if (callbackPhone && callbackPhone !== draft.callbackPhone) {
    flow.updateFields(id, { callbackPhone, phoneConfirmed: false });
    call.dialog.corrected = true;
  }
  if (email && email !== draft.email) flow.updateFields(id, { email, emailConfirmed: false });
  return null;
}

function nextField(call) {
  const d = call.draft;
  const tries = (field) => call.dialog.asks[field] ?? 0;
  if (!d.productInterest && tries("product") < MAX_ASKS) return "product";
  if (!d.quantity && tries("quantity") < MAX_ASKS) return "quantity";
  if ((!d.name || !d.company) && tries("identity") < MAX_ASKS) return "identity";
  if (!d.timeline && tries("timeline") < MAX_ASKS) return "timeline";
  if (!d.role && tries("role") < MAX_ASKS) return "role";
  if (d.callbackPhone && !d.phoneConfirmed) return tries("readBack") < MAX_READ_BACKS ? "readBack" : "partial";
  if (!d.callbackPhone && d.email && !d.emailConfirmed) return tries("emailReadBack") < MAX_READ_BACKS ? "emailReadBack" : "partial";
  if (!d.callbackPhone && !d.email) return tries("phone") < MAX_ASKS ? "phone" : "noContact";
  return "save";
}

function questionFor(field, call, catalog) {
  const d = call.draft;
  switch (field) {
    case "product":
      return "What product are you looking for?";
    case "quantity":
      return `About how many ${countNoun(d.productInterest, catalog)} do you need?`;
    case "identity":
      if (!d.name && !d.company) return "Who am I speaking with, and what company are you with?";
      return d.name ? "What company are you with?" : "And who am I speaking with?";
    case "timeline":
      return "When do you need them by?";
    case "role":
      return "Will you be the one signing off on this order?";
    case "readBack":
      return call.dialog.corrected
        ? `Got it: ${phoneGroups(d.callbackPhone)}. Did I get that right?`
        : `I have your number as ${phoneGroups(d.callbackPhone)}. Is that the best number for a callback?`;
    case "emailReadBack":
      return `I have your email as ${d.email}. Is that right?`;
    default:
      return "What's the best number to reach you?";
  }
}

function nextStep(flow, id, parts, { directive = null, personLine = null } = {}) {
  const call = flow.get(id);
  const field = directive === "askPhone" ? "phone" : nextField(call);

  if (field === "noContact") return flow.closeCall(id, [...parts, NO_CONTACT_LINE].join(" "), "no_contact");
  if (field === "save" || field === "partial") {
    if (parts.length) flow.say(id, parts.join(" "));
    const result = flow.saveLead(id, {}, { partial: field === "partial" });
    if (result.ok || !call.conversational || TERMINAL.has(call.state)) return result;
    // The server refused: read the number back, or ask for one.
    return ask(flow, id, [], result.reason === "contact_unconfirmed" ? "readBack" : "phone");
  }

  if (personLine) {
    parts.push(personLine);
    call.dialog.personSaid = true;
  }
  const question = directive === "askPhone" ? `Sorry about that. ${questionFor("phone", call, flow.catalog)}` : null;
  return ask(flow, id, parts, field, question);
}

function ask(flow, id, parts, field, override = null) {
  const call = flow.get(id);
  const question = override ?? questionFor(field, call, flow.catalog);
  call.dialog.asked = field;
  call.dialog.asks[field] = (call.dialog.asks[field] ?? 0) + 1;
  if (field === "readBack" || field === "emailReadBack") flow.awaitConfirmation(id);
  const spoken = [...parts, question].join(" ");
  const result = flow.ask(id, spoken, { question });
  return { ...result, asked: field, draft: flow.publicDraft(call) };
}

/**
 * Says what the caller's product is, from the catalog, once. Facts only: the
 * line and its minimum order. Never a price, stock level or delivery date.
 */
function acknowledge(flow, call) {
  const d = call.draft;
  const dialog = call.dialog;
  if (!d.productInterest) return null;
  const line = flow.catalog.findLine(d.productInterest);
  if (!dialog.ackedProduct) {
    dialog.ackedProduct = true;
    if (!line) return "I'll note that for your rep.";
    const family = productNoun(d.productInterest, line, flow.catalog);
    const lineName = line.name.toLowerCase();
    const opener = family ? `${cap(family)} ${isPlural(family) ? "are" : "is"} in our ${lineName} line` : `That's our ${lineName} line`;
    if (!d.quantity) return `${opener}.`;
    dialog.ackedQuantity = true;
    return `${opener}${quantityRemark(d.quantity, line, true)}`;
  }
  if (line && d.quantity && !dialog.ackedQuantity) {
    dialog.ackedQuantity = true;
    return quantityRemark(d.quantity, line, false);
  }
  return null;
}

function quantityRemark(quantity, line, joined) {
  const moq = line.minimumOrderQuantity;
  if (quantity >= moq) return `${joined ? ", and " : ""}${fmt(quantity)} meets the ${fmt(moq)} minimum order.`;
  return `${joined ? ". " : ""}The minimum order there is ${fmt(moq)}, and your rep can go over the options with you.`;
}

const isPlural = (noun) => /s$/i.test(String(noun ?? "").trim());

function countNoun(productInterest, catalog) {
  const line = productInterest ? catalog.findLine(productInterest) : null;
  const noun = line ? productNoun(productInterest, line, catalog) : null;
  return noun && isPlural(noun) ? noun : "units";
}