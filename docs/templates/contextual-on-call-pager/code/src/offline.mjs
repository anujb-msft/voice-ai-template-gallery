import { normalisePhone } from "./policy.mjs";
import { FINISHED_STORY, STORY } from "./flow.mjs";

/**
 * The offline agent: a small rule-based stand-in for the voice model, so the
 * whole pager runs with no Azure and no network. It plays the model's part —
 * ask short questions, pull fields out of what the caller says, call the same
 * flow methods the model's tools call — and nothing more. Severity, who is
 * paged, the brief and the voicemail prompt are decided by the server, exactly
 * as on a live call.
 */

export const DEFAULT_CALLER = "+12065550101";

const AFTER_HOURS =
  "The office is closed, so I can't put you through to a person — but this line pages the on-call technician for urgent problems, and they'll call you back.";
const GIVE_UP = "I didn't hear anything, so I'll end the call. If this is urgent, please call back.";
const GO_AHEAD = "I didn't hear anything, so I'll go ahead with what I have.";
const NOT_CAUGHT = "Sorry, I didn't catch that.";
const MENU = "Press 1 or say 'I've got it' to accept, 2 to decline, or 3 to talk to the tenant.";
export const WAITING_NOTE = "Nobody is on the line — the next page goes out when the countdown ends. Advance the clock to skip ahead.";
const ENDED_NOTE = "This call has ended — start a new call to continue.";
const KEYPAD_NOTE = "The keypad isn't used while the tenant describes the problem — say or type the answer, or press 0 to ask for a person.";
const VOICEMAIL_NOTE = "Voicemail can only pick up a page that is still ringing.";

const ACKS = {
  active_leak: "Understood — an active leak.",
  lockout: "Understood — you're locked out.",
  no_power: "Understood — no power.",
  no_heat: "Understood — no heat.",
  routine_maintenance: "Got it.",
  routine_other: "Got it.",
};

// ------------------------------------------------------------------ patterns

const PHONE = /(?<!\d)(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-]?)\d{3}[\s.-]?\d{4}(?!\d)/;
const TEMP = /\b(\d{2,3})\s*(?:°\s*f?|degrees?|deg|fahrenheit|f)(?![a-z])/i;
const UNIT = /(?:\b(?:unit|apartment|apt\.?|suite)\s*(?:number\s*|no\.?\s*)?#?\s*|#\s*)([a-z]?\d{1,4}[a-z]?)\b/i;
const BARE_UNIT =
  /\b([a-z]?\d{1,4}[a-z]?)\b(?!\s+(?:hours?|hrs?|minutes?|mins?|seconds?|days?|weeks?|months?|years?|am|pm|o clock|oclock|degrees?|deg|f|inches?|feet|foot|ft|times?|people|kids|children|floors?|percent))/g;

const YES =
  /^(?:yes|yeah|yep|yup|uh-huh|uh huh|affirmative|absolutely|definitely|correct)\b|^(?:sure|right|ok|okay|that's right|that is right|that's correct|that's it|it is|go ahead|exactly|please do)\s*(?:[.!,]|$)/i;
const NO = /^(?:no|nope|nah|negative|not really|that's not right|that is not right|that's wrong|wrong|not that one)\s*(?:[.!,]|$)/i;

const DENY = [
  /\b(?:please\s+)?(?:don'?t|do not)\s+(?:go|come|enter|let\s+(?:yourself|themselves|himself|herself|anyone|them|him|her)\s+in)\b/i,
  /\b(?:you|they|he|she|the tech(?:nician)?|nobody|no one)\s+(?:can'?t|cannot|can not|shouldn'?t|should not|may not|must not)\s+(?:go|come|enter|let)\b/i,
  /\bwait\s+(?:for me|until i)\b/i,
  /\bno permission\b/i,
  /\bnot\s+(?:ok|okay|fine|allowed)\s+(?:for\s+(?:them|you)\s+)?to\s+(?:go|come|enter)\b/i,
  /\bonly\s+(?:if|when|while)\s+i'?m\s+(?:home|there)\b/i,
];
const ALLOW = [
  /\b(?:you|they|he|she|the tech(?:nician)?|someone|somebody)\s+(?:can|may|could|are welcome to|is welcome to|are allowed to|is allowed to)\s+(?:just\s+)?(?:go|come|enter|let\s+(?:yourself|themselves|himself|herself)\s+in)\b/i,
  /\b(?:feel free to|go ahead and)\s+(?:go|come|enter|let yourself in)\b/i,
  /\b(?:it'?s|it is)\s+(?:ok|okay|fine)\s+(?:for\s+(?:them|you)\s+)?to\s+(?:go|come|enter)\b/i,
  /\blet\s+(?:yourself|themselves|himself|herself)\s+in\b/i,
  /\b(?:have|has|got)\s+(?:my\s+)?permission\b/i,
  /\bpermission to (?:enter|go in|come in)\b/i,
];

const SAME_NUMBER =
  /\b(?:this|that|the same|same)\s+(?:phone\s+|cell\s+|mobile\s+)?number\b|\bcalling (?:you )?from\b|\b(?:call|reach|ring)\s+me\s+(?:back\s+)?(?:on|at)\s+(?:this|that)\b/i;
const MY_PHONE = /\bmy\s+(?:cell|mobile|phone|number)\b|\b(?:this|that) one\b/i;
const CALLBACK_WORDS = /\bcall me\b|\bcall (?:me )?back\b|\bcallback\b|\breach me\b/i;

const PERSON =
  /\b(?:talk|speak|transfer|connect|put)\b[^.?!]{0,30}?\b(?:a person|a human|someone|somebody|a real person|representative|operator|an agent|a manager|the office|staff|live agent)\b|^(?:operator|representative|agent|human|person|a person|a human|real person)[.!?]?$/i;

const GENERIC_ISSUE =
  /\b(?:leak\w*|water|pour\w*|drip\w*|flood\w*|pipes?|heat|heater|heating|furnace|freezing|power|electric\w*|outage|sparks?|fire|smoke|gas|toilet|sink|drain|faucet|dishwasher|appliance|fridge|refrigerator|oven|stove|broken|not working|stopped working|stuck|smell\w*|mold|noise|noisy|ceiling|locked out|lockout|carbon monoxide)\b/i;
const ACCESS =
  /\b(?:keys?|lockbox|lock box|door|doors|gate|code|buzzer|intercom|dogs?|cats?|pets?|lobby|front desk|concierge|entrance|alarm|garage|home|waiting|wait|stairs|elevator|knock|doorbell|spare|neighbou?r)\b/i;
const YES_NO_ONLY = /^(?:yes|yeah|yep|yup|no|nope|nah|ok|okay|sure|right|correct|that's right|it is)$/i;
const GREETING = /^(?:hi|hello|hey|good (?:morning|evening|afternoon|night)|um+|uh+|hmm+)\b[\s\w]{0,12}$/i;

const WHERE_FILLER = new Set(
  "unit apartment apt suite number no it its s is at in the this that yes yeah yep correct right i m live we re on floor building about for of my our place sorry um uh so and".split(" "),
);

// Technician intents on a page leg, checked in this order.
const BRIDGE = /\b(?:connect me|put me through|patch me|(?:talk|speak) (?:to|with) (?:the )?(?:tenant|resident|caller)|call the (?:tenant|resident))\b/i;
const REPEAT = /\b(?:repeat|say (?:that|it) again|didn'?t catch|come again|one more time)\b/i;
const QUESTION = /\?\s*$|^(?:what|what's|whats|where|where's|when|who|which|how|is|are|does|do|did|can|could|should|may|will|has|have)\b/i;
const DECLINE = /\b(?:decline|declined|can'?t|cannot|can not|unavailable|not available|busy|pass|not tonight|no)\b(?!\s+(?:problem|worries))/i;
const ACCEPT =
  /\b(?:got it|on my way|on it|i'?ll take it|take it|accept|heading|head(?:ing)? (?:over|there|out)|be there|yes|yeah|yep|sure|ok|okay|will do|no problem|i have it)\b/i;

// ------------------------------------------------------------------- memory

const memories = new WeakMap();

function memoryFor(ctx) {
  let m = memories.get(ctx);
  if (!m) {
    m = { asked: "issue", silences: 0, unit: null, property: null, whereOpen: false, callbackRejected: false, notes: [], safetySaid: false, acked: false };
    memories.set(ctx, m);
  }
  return m;
}

function storyOf(flow, id) {
  const ctx = flow.intakes.get(id);
  if (!ctx) throw new Error(`unknown call ${id}`);
  return ctx;
}

// ------------------------------------------------------------------ the call

/** A simulated tenant call: the line answers and the agent says the opening. */
export function startOfflineIntake(flow, { fromPhone = DEFAULT_CALLER, interactive = false, callId } = {}) {
  const ctx = flow.createIntake({ callId, fromPhone: normalisePhone(fromPhone), simulated: true, interactive });
  flow.answered(ctx.id);
  memoryFor(ctx).asked = "issue";
  return ctx;
}

/**
 * One thing the caller said, typed or spoken — answered the way the agent
 * would answer it. During intake the tenant is speaking; once a page is
 * ringing or answered, the technician is.
 */
export async function converse(flow, id, text) {
  const ctx = storyOf(flow, id);
  if (FINISHED_STORY.has(ctx.state)) return { ok: true, ignored: true, note: ENDED_NOTE };
  const said = clean(text);
  if (!said) return { ok: true, ignored: true, note: "Nothing to say — type a line first." };
  if (ctx.state === STORY.INTAKE) {
    const m = memoryFor(ctx);
    m.silences = 0;
    const heard = handleTenantUtterance(flow, ctx.id, said);
    return respond(flow, ctx, m, heard);
  }
  if (ctx.phase === "ringing") {
    flow.heard(ctx.id, said);
    return { ok: true, phase: "briefed", result: flow.pageAnswered(ctx.id) };
  }
  if (ctx.phase === "briefed") {
    flow.heard(ctx.id, said);
    return technicianTurn(flow, ctx, techIntent(said), said);
  }
  return { ok: true, ignored: true, note: WAITING_NOTE };
}

/** A keypad press. On a page: 1 accept, 2 decline, 3 talk to the tenant, * repeat. During intake: 0 asks for a person. */
export async function pressKey(flow, id, digit) {
  const ctx = storyOf(flow, id);
  const key = String(digit ?? "").trim().slice(0, 1);
  if (!/^[0-9*#]$/.test(key)) return { ok: false, error: "digit must be 0-9, * or #" };
  if (FINISHED_STORY.has(ctx.state)) return { ok: true, ignored: true, note: ENDED_NOTE };
  if (ctx.state === STORY.INTAKE) {
    if (key !== "0") return { ok: true, ignored: true, note: KEYPAD_NOTE };
    const m = memoryFor(ctx);
    m.silences = 0;
    flow.heard(ctx.id, "Pressed 0");
    return respond(flow, ctx, m, { personRequest: true });
  }
  if (ctx.phase === "ringing") flow.pageAnswered(ctx.id);
  if (ctx.phase !== "briefed") return { ok: true, ignored: true, note: WAITING_NOTE };
  flow.heard(ctx.id, `Pressed ${key}`);
  const intent = { 1: "accept", 2: "decline", 3: "bridge", "*": "repeat" }[key] ?? null;
  return technicianTurn(flow, ctx, intent, `pressed ${key}`);
}

/** The caller (or the technician) says nothing. */
export async function stayQuiet(flow, id) {
  const ctx = storyOf(flow, id);
  if (FINISHED_STORY.has(ctx.state)) return { ok: true, ignored: true, note: ENDED_NOTE };
  if (ctx.state === STORY.INTAKE) {
    const m = memoryFor(ctx);
    m.silences += 1;
    if (m.silences === 1) {
      flow.note(ctx.id, "agent", "no_input", "No response — asked again");
      const key = m.asked ?? nextQuestion(flow, ctx, m) ?? "issue";
      m.asked = key;
      const line = `${NOT_CAUGHT} ${questionText(flow, ctx, m, key)}`;
      flow.say(ctx.id, line);
      return { ok: true, phase: "intake", asked: key, said: line };
    }
    const preview = ctx.fields.issue ? flow.policy.classify(ctx.fields) : null;
    const enough = ctx.propertyId && ctx.unit && ctx.fields.issue && (ctx.fields.callbackNumber || ctx.fromPhone) && !(m.whereOpen && !ctx.unitConfirmed);
    if (enough && (preview?.severity === "urgent" || preview?.severity === "emergency")) {
      flow.note(ctx.id, "agent", "no_input", "Silent again — enough to page, so the agent submits what it has");
      return submitIntake(flow, ctx, m, [GO_AHEAD]);
    }
    flow.note(ctx.id, "agent", "no_input", "Silent again — not enough to page, so the agent ends the call");
    flow.say(ctx.id, GIVE_UP);
    flow.hangup(ctx.id, { reason: "silence" });
    return { ok: true, phase: "done", ended: true, said: GIVE_UP };
  }
  if (ctx.phase === "ringing" || ctx.phase === "briefed") return { ok: true, result: flow.pageSilence(ctx.id) };
  return { ok: true, ignored: true, note: WAITING_NOTE };
}

/** The page rang through to voicemail. The flow decides what the box hears. */
export function leaveVoicemail(flow, id) {
  const ctx = storyOf(flow, id);
  if (FINISHED_STORY.has(ctx.state)) return { ok: true, ignored: true, note: ENDED_NOTE };
  if (ctx.phase !== "ringing") return { ok: true, ignored: true, note: VOICEMAIL_NOTE };
  return { ok: true, result: flow.pageVoicemail(ctx.id) };
}

export function hangUp(flow, id) {
  storyOf(flow, id);
  return { ok: true, result: flow.hangup(id, { reason: "hung up" }) };
}

/**
 * Pull fields out of one tenant line and record them through the same flow
 * methods the model's tools call. Synchronous; it never answers — `converse`
 * does that.
 */
export function handleTenantUtterance(flow, callId, text) {
  const ctx = flow.intakes.get(callId);
  if (!ctx) throw new Error(`unknown intake ${callId}`);
  const said = clean(text);
  if (!said) return { ok: true, ignored: true };
  const m = memoryFor(ctx);
  flow.heard(callId, said);
  const ex = extract(flow, m, said);
  const where = applyWhere(flow, ctx, m, ex);

  const patch = {};
  let issueCaptured = false;
  let issue = ex.quote;
  const nothingElse = !where && !ex.phone && ex.temp == null && !ex.allow && !ex.deny && !ex.notes.length && !ex.sameNumber && !ex.person && !ex.yes && !ex.no;
  if (!issue && m.asked === "issue" && !ctx.fields.issue && nothingElse && said.split(/\s+/).length >= 3 && !GREETING.test(said)) issue = capFirst(said);
  if (issue) {
    if (!ctx.fields.issue) {
      patch.issue = issue;
      issueCaptured = true;
    }
    patch.tenantSaid = issue;
  }
  if (ex.temp != null) patch.indoorTempF = ex.temp;
  if (ex.deny) patch.permissionToEnter = false;
  else if (ex.allow) patch.permissionToEnter = true;
  else if (m.asked === "access" && ex.yes) patch.permissionToEnter = true;
  else if (m.asked === "access" && ex.no) patch.permissionToEnter = false;
  if (ex.notes.length) {
    for (const note of ex.notes) if (!m.notes.includes(note)) m.notes.push(note);
    patch.accessNotes = m.notes.join(" ");
  }
  if (ex.phone) {
    patch.callbackNumber = ex.phone;
    m.callbackRejected = false;
  }
  const recorded = Object.keys(patch).length ? flow.recordIssue(callId, patch) : null;

  let callbackConfirmed = false;
  const sameNumber = ex.sameNumber || (m.asked === "callback" && (ex.yes || ex.myPhone));
  if (!ex.phone && sameNumber) callbackConfirmed = flow.confirmCallback(callId).ok;
  const callbackRejected = !ex.phone && !sameNumber && m.asked === "callback" && ex.no;
  if (callbackRejected) m.callbackRejected = true;

  const answeredYesNo = (m.asked === "access" || m.asked === "confirmUnit") && (ex.yes || ex.no);
  const ignored = !where && !recorded && !callbackConfirmed && !callbackRejected && !ex.person && !answeredYesNo;
  return { ok: true, where, recorded, callbackConfirmed, personRequest: ex.person, issueCaptured, ignored };
}

/** A whole tenant call from a list of lines, then submit — the original offline harness, kept for tests and scripts. */
export async function runTranscript(flow, { fromPhone = DEFAULT_CALLER, transcript = [], pageOutcomes = [] } = {}) {
  const call = startOfflineIntake(flow, { fromPhone });
  if (pageOutcomes.length) flow.setNextPageOutcomes(pageOutcomes);
  for (const line of transcript) handleTenantUtterance(flow, call.id, line);
  const submitted = flow.classifyAndSubmit(call.id);
  await flow.processDueJobs();
  return {
    callId: call.id,
    submitted,
    intake: flow.snapshotIntake(call.id),
    incident: submitted.incidentId ? flow.snapshotIncident(submitted.incidentId) : null,
  };
}

export async function simulatePageOutcome(flow, incidentId, outcome) {
  return flow.forceNextPage(incidentId, outcome);
}

// ------------------------------------------------------------------ answers

async function respond(flow, ctx, m, heard) {
  const lead = [];
  if (heard.personRequest) {
    flow.note(ctx.id, "agent", "person_requested", "After hours there is nobody to transfer to — the agent keeps taking the report");
    lead.push(AFTER_HOURS);
  }
  if (heard.issueCaptured && !m.acked) {
    m.acked = true;
    const preview = flow.policy.classify(ctx.fields);
    if (preview.severity !== "emergency" && ACKS[preview.issueType]) lead.push(ACKS[preview.issueType]);
  }
  if (heard.where?.message) lead.push(heard.where.message);
  const next = nextQuestion(flow, ctx, m);
  if (!next) return submitIntake(flow, ctx, m, lead);
  const preview = ctx.fields.issue ? flow.policy.classify(ctx.fields) : null;
  if (preview?.severity === "emergency" && !m.safetySaid) {
    lead.unshift(preview.safetyLine);
    m.safetySaid = true;
  }
  if (heard.ignored && !heard.personRequest) lead.unshift(NOT_CAUGHT);
  m.asked = next;
  const line = [...lead, questionText(flow, ctx, m, next)].join(" ");
  flow.say(ctx.id, line);
  return { ok: true, phase: "intake", asked: next, said: line, heard };
}

async function submitIntake(flow, ctx, m, lead = []) {
  const result = flow.classifyAndSubmit(ctx.id);
  if (!result.ok) {
    const missing = result.missing ?? [];
    const key = missing.includes("issue")
      ? "issue"
      : missing.includes("property") || missing.includes("unit")
        ? "unit"
        : missing.includes("indoorTempF")
          ? "temperature"
          : "callback";
    if (key === "unit") m.whereOpen = true;
    m.asked = key;
    const line = [...lead, questionText(flow, ctx, m, key)].join(" ");
    flow.say(ctx.id, line);
    return { ok: true, phase: "intake", asked: key, said: line, submitted: result };
  }
  let speak = result.speak ?? "";
  const safety = ctx.classification?.safetyLine;
  if (m.safetySaid && safety && speak.includes(safety)) speak = speak.replace(safety, "").replace(/\s+/g, " ").trim();
  const line = [...lead, speak].filter(Boolean).join(" ");
  if (line) flow.say(ctx.id, line);
  m.asked = null;
  await flow.processDueJobs();
  return { ok: true, phase: ctx.phase, submitted: result, said: line };
}

async function technicianTurn(flow, ctx, intent, said) {
  switch (intent) {
    case "bridge":
      return { ok: true, intent, result: await flow.bridgeToTenant(ctx.id) };
    case "repeat":
      return { ok: true, intent, result: flow.repeatBrief(ctx.id) };
    case "question":
      return { ok: true, intent, result: flow.getTicketDetail(ctx.id, said) };
    case "decline":
      return { ok: true, intent, result: await flow.decline(ctx.id, String(said).slice(0, 80)) };
    case "accept":
      return { ok: true, intent, result: await flow.acknowledge(ctx.id) };
    default:
      flow.say(ctx.id, MENU);
      return { ok: true, intent: "unclear", said: MENU };
  }
}

function techIntent(text) {
  if (BRIDGE.test(text)) return "bridge";
  if (REPEAT.test(text)) return "repeat";
  if (QUESTION.test(text)) return "question";
  if (DECLINE.test(text)) return "decline";
  if (ACCEPT.test(text)) return "accept";
  return null;
}

/** What the agent still needs, in the order a dispatcher would ask. `null` means submit. */
function nextQuestion(flow, ctx, m) {
  if (!ctx.fields.issue) return "issue";
  if (!ctx.propertyId || !ctx.unit || (m.whereOpen && !ctx.unitConfirmed)) return "unit";
  const preview = flow.policy.classify(ctx.fields);
  if (preview.severity === "emergency") return null;
  if (!ctx.unitConfirmed) return "confirmUnit";
  if (preview.missingSlots?.includes("indoorTempF")) return "temperature";
  if (!ctx.accessHeard) return "access";
  if (!ctx.callbackConfirmed) return "callback";
  return null;
}

function questionText(flow, ctx, m, key) {
  switch (key) {
    case "issue":
      return "What's the problem?";
    case "unit": {
      const roster = flow.policy.tenantByPhone(ctx.fromPhone);
      if (m.unit && !m.property && !roster) return `Which property is unit ${m.unit} in?`;
      if (m.property && !m.unit) return `What's the unit number at ${m.property.name}?`;
      return "Which property and unit is this?";
    }
    case "confirmUnit":
      return `Is this about unit ${ctx.unit} at ${flow.policy.property(ctx.propertyId)?.name ?? "your building"}?`;
    case "temperature":
      return "About how warm is it inside right now, in degrees?";
    case "access":
      return "Can the technician go in if you're not home, and is there anything they should know to get in?";
    case "callback":
    default: {
      const digits = String(ctx.fields.callbackNumber ?? "").replace(/\D+/g, "");
      return digits && !m.callbackRejected ? `Is the number ending ${digits.slice(-4)} the best one to call you back on?` : "What's the best number to call you back on?";
    }
  }
}

// --------------------------------------------------------------- extraction

/**
 * Which property and unit. A unit with a known caller validates against the
 * caller's building; a property alone waits for the unit; an unknown caller
 * with a unit alone is asked which building.
 */
function applyWhere(flow, ctx, m, ex) {
  const policy = flow.policy;
  const roster = policy.tenantByPhone(ctx.fromPhone);
  const rosterProp = roster ? policy.property(roster.propertyId) : null;
  if (m.asked === "confirmUnit" && !ex.unit && !ex.property) {
    if (ex.yes) {
      const result = flow.identifyUnit(ctx.id, { property: policy.property(ctx.propertyId)?.name ?? null, unit: ctx.unit });
      if (result.ok) m.whereOpen = false;
      return { ok: result.ok, message: result.ok ? null : result.message };
    }
    if (ex.no) {
      m.whereOpen = true;
      m.unit = null;
      m.property = null;
      return { ok: false, message: null };
    }
  }
  if (!ex.unit && !ex.property) return null;
  if (ex.property) m.property = ex.property;
  if (ex.unit) m.unit = ex.unit;
  if (!m.unit) {
    if (!(rosterProp && m.property?.id === rosterProp.id && !m.whereOpen)) m.whereOpen = true;
    return { ok: null, message: null };
  }
  if (!m.property && !rosterProp) {
    m.whereOpen = true;
    return { ok: null, message: null };
  }
  const result = flow.identifyUnit(ctx.id, { property: m.property?.name ?? null, unit: m.unit });
  if (result.ok) {
    m.whereOpen = false;
    m.property = result.property;
    m.unit = result.unit;
    return { ok: true, message: null };
  }
  m.whereOpen = true;
  m.unit = null;
  return { ok: false, message: result.message };
}

function extract(flow, m, said) {
  const out = { phone: null, temp: null, unit: null, property: null, yes: YES.test(said), no: NO.test(said), allow: false, deny: false, sameNumber: false, myPhone: false, person: PERSON.test(said), quote: null, notes: [] };
  let text = said;
  const phone = PHONE.exec(text);
  if (phone) {
    out.phone = normalisePhone(phone[0]);
    text = `${text.slice(0, phone.index)} ${text.slice(phone.index + phone[0].length)}`.replace(/\s+/g, " ").trim();
  }
  let withoutTemp = text;
  const temp = TEMP.exec(text);
  if (temp && Number(temp[1]) <= 130) {
    out.temp = Number(temp[1]);
    withoutTemp = `${text.slice(0, temp.index)} ${text.slice(temp.index + temp[0].length)}`;
  } else if (m.asked === "temperature") {
    const bare = /\b(\d{2,3})\b/.exec(text);
    if (bare && Number(bare[1]) >= 20 && Number(bare[1]) <= 130) {
      out.temp = Number(bare[1]);
      withoutTemp = `${text.slice(0, bare.index)} ${text.slice(bare.index + bare[0].length)}`;
    }
  }
  const unit = UNIT.exec(withoutTemp);
  if (unit) out.unit = unit[1].toUpperCase();
  const found = findProperty(flow.policy, withoutTemp);
  if (found) out.property = found.property;
  if (!out.unit && (m.asked === "unit" || m.asked === "confirmUnit")) {
    let normed = ` ${norm(withoutTemp)} `;
    if (found) normed = normed.replace(` ${found.term} `, " ");
    for (const match of normed.matchAll(BARE_UNIT)) {
      if (/\d/.test(match[1])) {
        out.unit = match[1].toUpperCase();
        break;
      }
    }
  }
  out.deny = DENY.some((re) => re.test(text));
  out.allow = !out.deny && ALLOW.some((re) => re.test(text));
  out.sameNumber = SAME_NUMBER.test(text);
  out.myPhone = MY_PHONE.test(text);

  const quote = [];
  for (const sentence of splitSentences(text)) {
    const end = /[.!?]$/.test(sentence) ? sentence.slice(-1) : "";
    const body = end ? sentence.slice(0, -1) : sentence;
    const clauses = body.split(/\s*,\s*/).map((c) => c.trim()).filter(Boolean);
    const kinds = clauses.map((c) => clauseKind(flow, m, c));
    if (kinds.some((k) => k.issue)) {
      const kept = clauses.filter((_, i) => keepInQuote(kinds[i]));
      const words = stripWhere(flow.policy, kept.join(", "));
      if (words) quote.push(`${capFirst(words)}${end || "."}`);
    }
    clauses.forEach((clause, i) => {
      const k = kinds[i];
      if (k.access && !k.issue && !k.callback && !k.person) out.notes.push(toNote(clause));
    });
  }
  out.quote = quote.length ? quote.join(" ") : null;
  return out;
}

function clauseKind(flow, m, clause) {
  return {
    yesNo: YES_NO_ONLY.test(clause),
    where: whereOnly(flow.policy, clause),
    permission: DENY.some((re) => re.test(clause)) || ALLOW.some((re) => re.test(clause)),
    callback: SAME_NUMBER.test(clause) || CALLBACK_WORDS.test(clause) || (m.asked === "callback" && MY_PHONE.test(clause)),
    person: PERSON.test(clause),
    issue: isIssueText(flow.policy, clause),
    access: ACCESS.test(clause),
  };
}

function keepInQuote(k) {
  return !(k.yesNo || k.where || k.permission || k.callback || k.person || (k.access && !k.issue));
}

function isIssueText(policy, text) {
  const n = norm(text);
  const t = policy.triage;
  const keywords = [...t.emergency.keywords, ...t.urgent.activeLeak, ...t.urgent.lockout, ...t.urgent.noPower, ...t.urgent.noHeat, ...t.routine.keywords];
  return keywords.some((k) => n.includes(norm(k))) || GENERIC_ISSUE.test(text);
}

/** "4B", "unit 11 at Pine Terrace", "yes, it's 2A" — nothing but where. */
function whereOnly(policy, clause) {
  let n = ` ${norm(clause)} `;
  let hasWhere = false;
  for (const { term } of propertyTerms(policy)) {
    if (n.includes(` ${term} `)) {
      n = n.replace(` ${term} `, " ");
      hasWhere = true;
    }
  }
  const rest = n.split(" ").filter(Boolean).filter((token) => {
    if (/^[a-z]?\d{1,4}[a-z]?$/.test(token) && /\d/.test(token)) {
      hasWhere = true;
      return false;
    }
    return !WHERE_FILLER.has(token);
  });
  return hasWhere && rest.length === 0;
}

/**
 * The tenant's words without "in unit 11 at Pine Terrace": the brief states
 * the validated unit already, and a misheard unit must not contradict it.
 */
function stripWhere(policy, text) {
  let t = String(text ?? "").replace(/\s*\b(?:in|at|for|of|from|inside)\s+(?:my\s+|the\s+)?(?:unit|apartment|apt\.?|suite)\s*(?:number\s*)?#?\s*[a-z]?\d{1,4}[a-z]?\b/gi, "");
  for (const { term } of propertyTerms(policy)) {
    const words = term.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    t = t.replace(new RegExp(`\\s*\\b(?:in|at|for|of|from)\\s+(?:the\\s+)?${words}\\b`, "gi"), "");
  }
  t = t.replace(/\s+([,.!?])/g, "$1").replace(/^[\s,]+|[\s,]+$/g, "").replace(/\s{2,}/g, " ").trim();
  return t.split(/\s+/).filter(Boolean).length >= 2 ? t : String(text ?? "").trim();
}

function propertyTerms(policy) {
  const terms = [];
  for (const p of policy.properties) {
    const names = new Set([p.name, p.id.replace(/-/g, " "), ...(p.aliases ?? [])].map(norm).filter(Boolean));
    for (const term of names) terms.push({ term, property: p });
  }
  return terms.sort((a, b) => b.term.length - a.term.length);
}

function findProperty(policy, text) {
  const n = ` ${norm(text)} `;
  return propertyTerms(policy).find(({ term }) => n.includes(` ${term} `)) ?? null;
}

/** Sentences, and the parts of a sentence a dash or semicolon separates. */
function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\s*[—–]\s*|\s+-{1,2}\s+|\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** An access note in the technician's terms: "I'm waiting in the lobby" → "The tenant is waiting in the lobby." */
function toNote(clause) {
  let t = clause.replace(/^(?:and|but|so|also|plus|oh|um|uh)\s+/i, "").trim();
  t = t
    .replace(/\bI'm\b|\bI am\b/gi, "the tenant is")
    .replace(/\bI'll\b|\bI will\b/gi, "the tenant will")
    .replace(/\bI've\b|\bI have\b/gi, "the tenant has")
    .replace(/\bI'd\b/gi, "the tenant would")
    .replace(/\bI don't\b/gi, "the tenant doesn't")
    .replace(/\bI was\b/gi, "the tenant was")
    .replace(/\bI\b/g, "the tenant")
    .replace(/\b(?:my|mine)\b/gi, "the tenant's")
    .replace(/\b(?:me|myself)\b/gi, "the tenant");
  t = capFirst(t);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function clean(text) {
  return String(text ?? "")
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const norm = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const capFirst = (value) => String(value ?? "").replace(/^\s*./, (c) => c.trim().toUpperCase());
