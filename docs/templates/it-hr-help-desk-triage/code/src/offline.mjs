import { STATES } from "./flow.mjs";
import { isAffirmative, isNegative, normalise } from "./util.mjs";

export function registerSimulatedAgent(flow, callId) {
  flow.registerAgent(callId, { instruct: () => {} });
}

export function handleUtterance(flow, callId, text) {
  const said = String(text ?? "").trim();
  const call = flow.get(callId);
  if (!call) return { ok:false, reason:"unknown_call" };
  if (!said) return flow.noInput(callId);
  if (/^[0-9*]$/.test(said)) return flow.dtmf(callId, said);
  const guard = flow.ingestUtterance(callId, said);
  if (guard.sensitive || guard.expired || guard.ended || guard.ok === false) return guard;

  if (call.state === STATES.AFTER_HOURS_OFFER) {
    if (isAffirmative(said)) return flow.requestCallback(callId, "confidential-hr");
    if (isNegative(said)) return flow.endCall(callId, "confidential_after_hours_declined");
  }
  if (call.state === STATES.VERIFYING) {
    if (!call.verification && /[\w.-]+@contoso\.com/i.test(said)) return flow.startVerification(callId, said.match(/[\w.-]+@contoso\.com/i)[0]);
    if (/\d{6}/.test(said)) {
      const checked = flow.checkCode(callId, said.match(/\d{6}/)[0]);
      if (checked.ok && call.pendingPersonalKind) return flow.getPersonalAnswer(callId, call.pendingPersonalKind);
      return checked;
    }
  }
  if (call.state === STATES.CONFIRMING && call.pendingProposal) return flow.fileTicket(callId, call.pendingProposal.proposalId, said);
  if (/\b(status|happening|my ticket|ticket status)\b/i.test(said)) return flow.getMyTickets(callId);
  if (/\b(send|link|teams chat)\b/i.test(said) && call.lastArticle) return flow.sendLink(callId, call.lastArticle);
  if (/\b(person|human|agent|representative)\b/i.test(said)) return flow.route(callId, call.domain === "HR" ? "hr-shared-services" : "it-service-desk", "caller_requested_person");
  if (/\b(salary|someone else's|colleague|other employee|another employee|ignore previous|system prompt)\b/i.test(said)) return flow.refusePersonal(callId, "forbidden_personal_data");

  const classification = flow.classify(said);
  call.domain = classification.domain; call.topicId = classification.topicId; flow.audit.updateCall(call.id, { domain: call.domain, topicId: call.topicId });
  if (classification.needsClarification) {
    call.pendingClarification = said;
    call.state = STATES.CLARIFYING;
    flow.pushTranscript(callId, "agent", "Is this about a device or account, or about pay, leave, or benefits?");
    return { ok:true, clarify:true, ...classification };
  }
  return handleTopic(flow, callId, classification.topicId, said);
}

export function handleTopic(flow, callId, topicId, said) {
  const call = flow.get(callId);
  const topic = flow.taxonomy.get(topicId);
  if (!topic) return flow.noInput(callId);
  call.domain = topic.domain === "both" ? "both" : topic.domain;
  call.topicId = topicId;
  const action = topic.action;
  switch (action.type) {
    case "answer": {
      const answer = flow.answerQuestion(callId, topicId, { locale: /español|espanol|spanish/i.test(said) ? "es" : "en" });
      if (!answer.available) return fallback(flow, callId, action.fallback, topicId, said);
      call.lastArticle = answer.article.id;
      return answer;
    }
    case "personal": {
      if (!call.verified) {
        flow.pushTranscript(callId, "agent", "I'll send a code to the mobile number on your employee record. What's your work email?");
        call.state = STATES.VERIFYING;
        call.pendingPersonalKind = action.kind;
        return { ok:true, needsVerification:true };
      }
      return flow.getPersonalAnswer(callId, action.kind);
    }
    case "ticket": return flow.proposeTicket(callId, { topicId, description: said, impact: action.impact ?? impactFrom(said), blocked: blocked(said) });
    case "handoff": return flow.handoffPasswordReset(callId, action.intent);
    case "queue": return flow.route(callId, action.destination, topic.id);
    case "out_of_scope": call.lastSpoken = action.channelText; flow.pushTranscript(callId, "agent", action.channelText); flow.audit.recordEvent(call.id,"system","out_of_scope",topic.id); return { ok:true, outOfScope:true };
    default: return flow.noInput(callId);
  }
}

export function resolveClarification(flow, callId, text) {
  const call = flow.get(callId);
  const t = normalise(`${call.pendingClarification ?? ""} ${text}`);
  if (/\b(account|device|system)\b/.test(t)) return handleTopic(flow, callId, "it-software-access", text);
  if (/\b(pay|leave|benefits|pto)\b/.test(t)) return handleTopic(flow, callId, /pay/.test(t) ? "hr-pay-calendar" : "hr-benefits-general", text);
  return flow.noInput(callId);
}

function fallback(flow, callId, fallbackAction, topicId, said) {
  if (!fallbackAction) return flow.noInput(callId);
  if (fallbackAction.type === "ticket") return flow.proposeTicket(callId, { topicId, description: said, impact: fallbackAction.impact ?? "me", blocked: blocked(said) });
  if (fallbackAction.type === "queue") return flow.route(callId, fallbackAction.destination, topicId);
  return flow.noInput(callId);
}
function impactFrom(text) { if (/\b(site|office|everyone|all users)\b/i.test(text)) return "site"; if (/\b(team|department)\b/i.test(text)) return "team"; return "me"; }
function blocked(text) { return /\b(can't work|cannot work|blocked|urgent|down|security|phishing|stolen|lost)\b/i.test(text); }

export function runTranscript(flow, { teamsUserId = null, fromPhone = null, utterances = [] } = {}) {
  const call = flow.create({ teamsUserId, fromPhone, simulation: true });
  flow.answered(call.id);
  const results = [];
  for (const u of utterances) {
    if (flow.get(call.id).state === STATES.CLARIFYING) results.push(resolveClarification(flow, call.id, u));
    else results.push(handleUtterance(flow, call.id, u));
  }
  return { callId: call.id, results, snapshot: flow.snapshot(call.id) };
}
