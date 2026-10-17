import { STATES } from "./flow.mjs";
import { isAffirmative, isNegative } from "./util.mjs";

/**
 * The offline stand-in for the voice model: plain keyword rules that call the
 * same TriageFlow tools the model would. Every decision that matters (who the
 * caller is, what may be read out, the priority, where the call goes) is made
 * by the flow, so simulated and live calls follow the same policy.
 */
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/i;
const CODE = /(?<![\w-])\d(?: ?\d){5}(?![\w-])/;
const TICKET = /\b(INC|REQ)[-\s]?(\d{6})\b/i;
const STATUS = /\b(status|happening|update|updates|news)\b/i;
const TICKET_WORD = /\b(ticket|tickets|incident|request|case)\b/i;
const MY_TICKETS = /\bmy (?:open )?tickets\b/i;
const LINK = /\b(?:send|text|share) (?:me )?(?:it|that|this|the link|a link|the article|the guide)\b/i;
const PERSON = /\b(?:(?:talk|speak) (?:to|with) (?:a |an |the )?(?:person|human|someone|somebody|agent|representative|technician)|(?:a|an|real|live) (?:person|human|agent)|operator)\b/i;
const FORBIDDEN = /\b(salary|salaries|someone else's|colleague's|other employee|another employee|ignore (?:all |previous |your )?instructions|system prompt)\b/i;
const DECLINE = /\b(no|nope|no thanks|don['’]t|do not|not now|never ?mind)\b/i;
const SPANISH = /español|espanol|spanish/i;
const IT_WORDS = /\b(account|device|system|laptop|login|log in|sign in|access|password|software|computer|app|application|screen|network|vpn|email)\b/i;
const HR_WORDS = /\b(pay|paycheck|payslip|leave|benefits?|pto|vacation|time off|holiday)\b/i;
const PAY_PROBLEM = /\b(wrong|amount|short|missing|incorrect|underpaid|overpaid)\b/i;

/** The simulated "voice": nothing to play, the flow pushes the words to the console. */
export function registerSimulatedAgent(flow, callId) {
  flow.registerAgent(callId, { say() {} });
}

/** One caller turn on a simulated call, typed or read from a beat. */
export function handleUtterance(flow, id, text) {
  const call = flow.get(id);
  if (!call) return { ok: false, reason: "unknown_call" };
  const said = String(text ?? "").trim();
  if (!said) return flow.noInput(id);
  if (/^[0-9*#]$/.test(said)) return flow.dtmf(id, said);
  if (call.state === STATES.CLARIFYING && call.pendingClarification) return resolveClarification(flow, id, said);
  const ingest = flow.ingestUtterance(id, said);
  if (ingest.handled || ingest.ok === false) return ingest;

  if (call.state === STATES.AFTER_HOURS_OFFER) return handleCallbackOffer(flow, id, said);
  if (call.state === STATES.VERIFYING) {
    const email = EMAIL.exec(spokenEmail(said))?.[0];
    if (email) return flow.startVerification(id, email);
    const code = CODE.exec(said)?.[0];
    if (code) return flow.checkCode(id, code);
  }
  if (PERSON.test(said)) return flow.route(id, flow.personQueue(id), "asked_for_person");
  if (call.state === STATES.CONFIRMING && call.pendingProposal) return flow.fileTicket(id, call.pendingProposal.proposalId, said);

  const ticket = TICKET.exec(said);
  if (ticket) return flow.getTicketStatus(id, `${ticket[1].toUpperCase()}-${ticket[2]}`);
  if ((STATUS.test(said) && TICKET_WORD.test(said)) || MY_TICKETS.test(said)) return flow.getMyTickets(id);
  if (LINK.test(said) && (call.lastArticle || call.lastTicket)) return flow.sendLink(id, call.lastArticle ?? call.lastTicket.number);
  if (FORBIDDEN.test(said)) return flow.refusePersonal(id, "forbidden_personal_data");

  const classification = flow.classifyFor(id, said);
  if (classification.needsClarification) return flow.askClarification(id, said, classification);
  return handleTopic(flow, id, classification.topicId, said);
}

/** Run the taxonomy action for a topic. `context` adds words that count for priority but not the summary. */
export function handleTopic(flow, id, topicId, said = "", { context = "" } = {}) {
  const topic = flow.taxonomy.get(topicId);
  if (!flow.get(id) || !topic) return { ok: false, reason: "unknown_topic" };
  const action = topic.action ?? {};
  const words = `${said} ${context}`;
  switch (action.type) {
    case "answer": {
      const answer = flow.answerQuestion(id, topicId, { locale: SPANISH.test(said) ? "es" : null });
      return answer.ok ? answer : fallback(flow, id, topic, answer, said, words);
    }
    case "personal": return flow.getPersonalAnswer(id, action.kind);
    case "ticket": return flow.proposeTicket(id, { topicId, description: said, impact: impactFrom(words), blocked: blocked(words) });
    case "handoff": return flow.handoffPasswordReset(id, action.intent);
    case "queue":
      flow.setTopic(id, topicId);
      return flow.route(id, action.destination, null);
    case "out_of_scope":
      flow.setTopic(id, topicId);
      flow.event(id, "system", "out_of_scope", topic.label);
      flow.say(id, action.channelText);
      flow.setState(id, STATES.LISTENING);
      return { ok: true, outOfScope: true };
    default:
      return flow.route(id, flow.personQueue(id), "asked_for_person");
  }
}

/** The caller's answer to the one clarifying question. A second miss goes to a person. */
export function resolveClarification(flow, id, answer) {
  const call = flow.get(id);
  if (!call) return { ok: false, reason: "unknown_call" };
  if (call.state !== STATES.CLARIFYING || !call.pendingClarification) return handleUtterance(flow, id, answer);
  const said = String(answer ?? "").trim();
  if (!said) return flow.noInput(id);
  if (/^[0-9*#]$/.test(said)) return flow.dtmf(id, said);
  const pending = call.pendingClarification;
  const ingest = flow.ingestUtterance(id, said);
  if (ingest.handled || ingest.ok === false) return ingest;
  if (PERSON.test(said)) return flow.route(id, flow.personQueue(id), "asked_for_person");
  const settled = settleClarification(flow, id, said);
  if (!settled.clarified) return settled;
  return handleTopic(flow, id, settled.topicId, pending.utterance, { context: said });
}

/**
 * Turn the answer to the clarifying question into a topic, without acting on
 * it. There is no second question: an answer that still names neither IT nor
 * HR goes to a person. The voice bridge uses this too.
 */
export function settleClarification(flow, id, answer) {
  const pending = flow.get(id)?.pendingClarification;
  if (!pending) return { ok: false, reason: "no_clarification" };
  const said = String(answer ?? "");
  const domain = domainOf(said);
  const topicId = domain ? pickTopic(flow, pending, said, domain) : null;
  if (topicId) {
    flow.clarified(id, topicId);
    return { ok: true, clarified: true, topicId, utterance: pending.utterance };
  }
  flow.event(id, "system", "still_unclear", null);
  if (domain === "HR") return flow.route(id, "hr-shared-services", null);
  return flow.route(id, flow.personQueue(id), "still_unclear");
}

/** After hours, a sensitive caller only ever answers one question: callback, yes or no. */
export function handleCallbackOffer(flow, id, said) {
  if (isAffirmative(said)) return flow.requestCallback(id);
  if (isNegative(said) || DECLINE.test(said)) return flow.declineCallback(id);
  flow.say(id, `${PERSON.test(said) ? "The confidential HR line is closed right now. " : ""}Would you like confidential HR to call you back next business day? Please say yes or no.`);
  return { ok: true, reprompted: true };
}

/** Scripted calls for tests and `/api/offline-call`. */
export function runTranscript(flow, { teamsUserId = null, fromPhone = null, utterances = [] } = {}) {
  const call = flow.create({ teamsUserId, fromPhone, simulation: true });
  registerSimulatedAgent(flow, call.id);
  flow.answered(call.id);
  const results = utterances.map((u) => handleUtterance(flow, call.id, u));
  return { callId: call.id, results, snapshot: flow.snapshot(call.id) };
}

function fallback(flow, id, topic, answer, said, words) {
  const next = answer.fallback ?? topic.action?.fallback ?? null;
  flow.say(id, answer.reason === "out_of_audience" ? "That guide is only for people managers." : "I don't have an approved answer for that right now.");
  if (next?.type === "ticket") return flow.proposeTicket(id, { topicId: topic.id, description: said, impact: next.impact ?? impactFrom(words), blocked: blocked(words) });
  if (next?.type === "queue") return flow.route(id, next.destination, null);
  return flow.route(id, flow.personQueue(id), null);
}

function domainOf(text) {
  const it = IT_WORDS.test(text) || /\bIT\b/.test(text);
  const hr = HR_WORDS.test(text) || /\bHR\b/i.test(text);
  if (it && hr) return text.search(IT_WORDS) <= text.search(HR_WORDS) ? "IT" : "HR";
  return it ? "IT" : hr ? "HR" : null;
}

/** The answer's own topic if it names one, else the matching original candidate, else a sensible default. */
function pickTopic(flow, pending, said, domain) {
  const own = flow.classify(said);
  if (!own.needsClarification && flow.taxonomy.get(own.topicId)?.domain === domain) return own.topicId;
  if (domain === "HR" && PAY_PROBLEM.test(said)) return "hr-payroll-issue";
  const candidate = (pending.candidates ?? []).find((c) => c.domain === domain);
  if (candidate) return candidate.topicId;
  if (domain === "IT") return /\b(laptop|screen|device|computer|monitor)\b/i.test(said) ? "it-laptop-display" : "it-software-access";
  if (/\b(pto|leave|vacation|time off)\b/i.test(said)) return "hr-pto-policy";
  if (/\bbenefits?\b/i.test(said)) return "hr-benefits-general";
  if (/\bpay\b/i.test(said)) return "hr-pay-calendar";
  return null;
}

/** "sam dot rivera at contoso dot com" → "sam.rivera@contoso.com". */
function spokenEmail(text) {
  return /@/.test(text) ? text : text.replace(/\s+at\s+/i, "@").replace(/\s+dot\s+/gi, ".");
}
function impactFrom(text) {
  if (/\b(whole (?:site|office|building|floor)|everyone (?:in|at) the (?:office|building|site)|entire (?:site|office|building|floor)|all users)\b/i.test(text)) return "site";
  if (/\b(my team|whole team|our team|department|everyone on my team)\b/i.test(text)) return "team";
  return null;
}
function blocked(text) { return /\b(can['’]?t work|cannot work|blocked|urgent|down|security|phishing|stolen|lost)\b/i.test(text); }
