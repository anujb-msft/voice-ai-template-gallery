import { randomUUID } from "node:crypto";
import { config, referenceNow } from "./config.mjs";
import { clip } from "./handoff.mjs";
import { hasPersonalEligibilityDetails, inferTopic, isServiceRequest, sanitizeForAudit } from "./content.mjs";

export const STATES = Object.freeze({
  RINGING: "ringing",
  GREETING: "greeting",
  LISTENING: "listening",
  ANSWERING: "answering",
  TRANSFERRING: "transferring",
  TRANSFERRED: "transferred",
  CLOSED: "closed",
  ENDED: "ended",
});

const TERMINAL = new Set([STATES.TRANSFERRED, STATES.CLOSED, STATES.ENDED]);
const GREETING = "Thanks for calling the City of Contoso. I'm an automated assistant and can answer questions about city services, hours, and programs. What can I help you find?";
const AFTER_ANSWER = "Is there anything else?";
const ELIGIBILITY_DISCLAIMER = "Staff make the final decision on eligibility.";

export class InquiryFlow {
  constructor({ content, hours, audit, transfer = null, hub = null, now = () => referenceNow(), options = {} }) {
    this.content = content;
    this.hours = hours;
    this.audit = audit;
    this.transfer = transfer;
    this.hub = hub;
    this.now = now;
    this.options = { callTimeBudgetMs: config.callTimeBudgetMs, maxNoInput: 2, ...options };
    this.calls = new Map();
    this.agents = new Map();
  }

  create({ callId = randomUUID(), fromPhone = null, incomingCallContext = null, sessionId = null, resourceAccountId = null } = {}) {
    const call = {
      id: callId,
      fromPhone,
      maskedPhone: maskPhone(fromPhone),
      incomingCallContext,
      sessionId: sessionId ?? callId,
      resourceAccountId,
      arrival: resourceAccountId ? "teams-phone-extensibility" : "acs-direct",
      callConnectionId: null,
      state: STATES.RINGING,
      startedAt: this.now().getTime(),
      answeredAt: null,
      endedAt: null,
      outcome: null,
      noInputs: 0,
      answers: [],
      searches: [],
      lastSearch: null,
      lastAnswer: null,
      lastQuestion: null,
      lastTopic: null,
      humanRequested: false,
      destination: null,
      transferAttempts: 0,
      dispatched: false,
      transcript: [],
    };
    this.calls.set(call.id, call);
    this.audit.startCall({ id: call.id, maskedPhone: call.maskedPhone, state: call.state, startedAt: call.startedAt, sessionId: call.sessionId });
    this.#event(call, "system", "call_created", call.arrival);
    return call;
  }

  get(callId) { return this.calls.get(callId) ?? null; }
  registerAgent(callId, handle) { this.agents.set(callId, handle); }
  unregisterAgent(callId) { this.agents.delete(callId); }
  setCallConnection(callId, id) { const call = this.get(callId); if (call) call.callConnectionId = id; }

  answered(callId) {
    const call = this.#require(callId);
    call.answeredAt = this.now().getTime();
    this.#setState(call, STATES.GREETING);
    this.#speak(call, GREETING);
    this.#setState(call, STATES.LISTENING);
    return call;
  }

  searchContent(callId, { query, topic = null } = {}) {
    const call = this.#require(callId);
    if (this.#budgetExpired(call)) return this.#expire(call);
    const effectiveTopic = topic ?? inferTopic(query);
    const result = this.content.search(query, { topic: effectiveTopic, at: this.now() });
    call.lastSearch = result;
    call.searches.push({ at: this.now().toISOString(), ...result });
    call.lastQuestion = sanitizeForAudit(query);
    call.lastTopic = result.topic ?? effectiveTopic ?? call.lastTopic;
    this.audit.updateCall(call.id, { lastTopic: call.lastTopic, lastQuestion: call.lastQuestion });
    this.#event(call, "tool", "search_content", call.lastQuestion, {
      query: call.lastQuestion,
      topic: call.lastTopic,
      miss: result.miss,
      expiredMatch: result.expiredMatch,
      passages: result.passages.map(({ text, ...p }) => p),
    });
    this.#publish(call, "search", { query: call.lastQuestion, topic: call.lastTopic, ...result, passages: result.passages.map((p) => ({ ...p, text: p.text.slice(0, 240) })) });
    return result;
  }

  recordAnswer(callId, { articleIds = [], topic = null } = {}) {
    const call = this.#require(callId);
    const allowed = new Set(call.lastSearch?.passages?.map((p) => p.articleId) ?? []);
    const ids = [...new Set(articleIds)].filter(Boolean);
    if (!ids.length) return { ok: false, reason: "articleIds_required" };
    for (const id of ids) if (!allowed.has(id)) return { ok: false, reason: "article_not_retrieved", articleId: id };
    const passages = call.lastSearch.passages.filter((p) => ids.includes(p.articleId));
    const answer = { articleIds: ids, topic: topic ?? call.lastSearch.topic ?? "unknown", stale: passages.some((p) => p.freshness === "stale") };
    call.answers.push(answer);
    this.#event(call, "tool", "answer_recorded", ids.join(","), answer);
    if (answer.stale) this.#event(call, "policy", "stale_answer", ids.join(","), answer);
    this.#publish(call, "citation", { articleIds: ids, topic: answer.topic, passages: passages.map(({ text, ...p }) => p), stale: answer.stale });
    return { ok: true, ...answer };
  }

  answerFromSearch(callId, text) {
    const call = this.#require(callId);
    if (this.#budgetExpired(call)) return this.#expire(call);
    const said = String(text ?? "").trim();
    this.pushTranscript(callId, "caller", said);

    if (isDone(said)) return this.endCall(callId, "caller_done");
    if (isRepeat(said)) return this.repeatLast(callId, { slower: false });
    if (isSlower(said)) return this.repeatLast(callId, { slower: true });
    if (wantsCitation(said) && call.lastAnswer) return this.sayCitation(callId);
    if (wantsHuman(said)) return this.requestHuman(callId, { reason: "caller_requested", topic: call.lastTopic });
    if (isServiceRequest(said)) return this.#miss(call, said, "service_request");

    const personalEligibility = hasPersonalEligibilityDetails(said);
    const query = personalEligibility
      ? `${sanitizeForAudit(said).replace(/\[(?:number|amount)\]/g, "")} eligibility general criteria`
      : said;
    const search = this.searchContent(callId, { query, topic: personalEligibility ? "benefits-eligibility" : inferTopic(said) });
    if (search.action) return search;
    if (search.expiredMatch && !search.passages.length) return this.#expired(call, said, search.topic);
    if (search.miss) return this.#miss(call, said, search.expiredMatch ? "expired_or_low_score" : "miss");
    const passage = search.passages[0];
    const record = this.recordAnswer(callId, { articleIds: [passage.articleId], topic: passage.topic });
    if (!record.ok) return record;

    const sentences = [firstSentence(passage.text), `That's from ${passage.source}.`];
    if (passage.freshness === "stale") sentences.push(`This information was due for review in ${monthName(passage.reviewBy)}, so please check ${passage.shortUrl} or ask staff before relying on it.`);
    if (passage.topic === "benefits-eligibility") sentences.push(ELIGIBILITY_DISCLAIMER);
    const answer = `${sentences.join(" ")} ${AFTER_ANSWER}`;
    call.lastAnswer = { text: answer, passages: [passage] };
    this.#setState(call, STATES.ANSWERING);
    this.#speak(call, answer);
    this.#setState(call, STATES.LISTENING);
    return { ok: true, answered: true, answer, citation: passage.articleId, personalEligibilityHandled: personalEligibility };
  }

  requestHuman(callId, { reason = "caller_requested", topic = null, sentiment = null } = {}) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    call.humanRequested = true;
    call.lastTopic = topic ?? call.lastTopic ?? "General inquiry";
    if (sentiment) call.sentiment = sentiment;
    this.#event(call, "caller", "human_requested", reason, { topic: call.lastTopic });
    const decision = this.hours.decision(this.now());
    this.#publish(call, "hours", decision);
    if (!decision.staffed) {
      this.#speak(call, decision.message);
      this.#finish(call, STATES.CLOSED, `after_hours:${reason}`);
      return { ok: true, action: "closed", afterHours: true, message: decision.message, nextStaffed: decision.nextStaffed };
    }
    this.#speak(call, "Connecting you now");
    call.destination = { target: this.hours.queue, context: this.handoffContext(call, reason), reason };
    this.#setState(call, STATES.TRANSFERRING);
    call.dispatchPromise = this.dispatchTransfer(call.id);
    return { ok: true, action: "transfer", context: call.destination.context };
  }

  dtmf(callId, digit) {
    const call = this.#require(callId);
    this.#event(call, "caller", "dtmf", String(digit));
    if (String(digit) === "0") return this.requestHuman(callId, { reason: "dtmf_0", topic: call.lastTopic ?? "Asked for a person" });
    return { ok: false, reason: "unmapped_digit" };
  }

  noInput(callId) {
    const call = this.#require(callId);
    if (this.#budgetExpired(call)) return this.#expire(call);
    call.noInputs += 1;
    this.#event(call, "caller", "no_input", String(call.noInputs));
    if (call.noInputs >= this.options.maxNoInput) return this.requestHuman(callId, { reason: "no_input", topic: "No input" });
    const line = "I'm sorry, I didn't catch that. You can ask about city services, hours, programs, or press 0 for a person.";
    this.#speak(call, line);
    return { ok: true, reprompt: true, remaining: this.options.maxNoInput - call.noInputs };
  }

  repeatLast(callId, { slower = false } = {}) {
    const call = this.#require(callId);
    const text = call.lastAnswer?.text ?? GREETING;
    const line = slower ? `Sure — I'll say it more slowly. ${text}` : text;
    this.#speak(call, line);
    this.#event(call, "caller", slower ? "slower" : "repeat", null);
    return { ok: true, repeated: true, slower };
  }

  sayCitation(callId) {
    const call = this.#require(callId);
    const p = call.lastAnswer?.passages?.[0];
    if (!p) return { ok: false, reason: "no_citation" };
    const line = `That came from ${p.source}. The short URL is ${p.shortUrl}.`;
    this.#speak(call, line);
    this.#event(call, "agent", "citation_spoken", p.articleId, { articleId: p.articleId, shortUrl: p.shortUrl });
    return { ok: true, citation: p.articleId, spoken: line };
  }

  endCall(callId, reason = "caller_done") {
    const call = this.get(callId);
    if (!call || TERMINAL.has(call.state)) return { ok: true };
    const line = reason === "caller_done" ? "Thanks for calling the City of Contoso. Goodbye." : "Goodbye.";
    this.#speak(call, line);
    this.#finish(call, STATES.CLOSED, reason);
    return { ok: true, ended: true };
  }

  async dispatchTransfer(callId) {
    const call = this.#require(callId);
    if (call.dispatched || !call.destination) return { ok: false, reason: "nothing_to_dispatch" };
    call.dispatched = true;
    call.transferAttempts += 1;
    this.#event(call, "system", "transfer_started", call.destination.reason, call.destination.context);
    if (!this.transfer) {
      this.#event(call, "system", "transfer_simulated", this.hours.queue.displayName, call.destination.context);
      this.#publish(call, "handoff", call.destination.context);
      this.#finish(call, STATES.TRANSFERRED, `transferred:${call.destination.reason}`, { simulated: true });
      return { ok: true, simulated: true, context: call.destination.context };
    }
    try {
      await this.transfer(call, call.destination);
      this.#event(call, "system", "transfer_succeeded", this.hours.queue.displayName, call.destination.context);
      this.#publish(call, "handoff", call.destination.context);
      this.#finish(call, STATES.TRANSFERRED, `transferred:${call.destination.reason}`);
      return { ok: true, context: call.destination.context };
    } catch (error) {
      this.#event(call, "system", "transfer_failed", error.message);
      const line = "I'm sorry — I can't connect you right now. Please call back during staffed hours or visit contoso.gov.";
      this.#speak(call, line);
      this.#finish(call, STATES.CLOSED, "transfer_failed");
      return { ok: false, reason: "transfer_failed", error: error.message };
    }
  }

  async settled(callId) { await this.get(callId)?.dispatchPromise; return this.snapshot(callId); }

  checkBudget(callId) {
    const call = this.get(callId);
    if (!call) return { ok: true };
    return this.#budgetExpired(call) ? this.#expire(call) : { ok: true };
  }

  pushTranscript(callId, role, text) {
    const call = this.get(callId);
    if (!call || !text) return;
    call.transcript.push({ role, text, at: this.now().toISOString() });
    this.audit.recordTranscript(callId, role, text);
    this.#publish(call, "transcript", { role, text });
  }

  recordAgentAction(callId, { tool, ok = true, detail = null }) {
    const call = this.get(callId);
    if (call) this.#event(call, "agent", ok ? "tool" : "tool_rejected", detail ? `${tool}: ${detail}` : tool);
  }

  handoffContext(call, reason = "caller_requested") {
    const articleIds = call.answers.flatMap((a) => a.articleIds).slice(-3);
    const answered = articleIds.length ? `Answered with ${articleIds.join(", ")}.` : "No approved answer was completed.";
    const asked = call.lastQuestion ? `Caller asked about ${call.lastQuestion}.` : "Caller asked for city information.";
    return {
      sessionId: call.sessionId ?? call.id,
      callTopic: clip(call.lastTopic ?? "General inquiry", 48),
      callContext: clip(`${asked} ${answered} Transferring because ${reason.replace(/_/g, " ")}.`, 900),
      callSentiment: call.sentiment,
    };
  }

  snapshot(callId) {
    const call = this.get(callId);
    if (!call) return null;
    return {
      id: call.id,
      state: call.state,
      maskedPhone: call.maskedPhone,
      arrival: call.arrival,
      outcome: call.outcome,
      elapsedMs: (call.endedAt ?? this.now().getTime()) - call.startedAt,
      budgetMs: this.options.callTimeBudgetMs,
      lastTopic: call.lastTopic,
      lastQuestion: call.lastQuestion,
      answers: call.answers,
      searches: call.searches.map((s) => ({ ...s, passages: s.passages?.map(({ text, ...p }) => p) ?? [] })),
      noInputs: call.noInputs,
      destination: call.destination ? { displayName: call.destination.target.displayName, context: call.destination.context } : null,
      transcript: call.transcript,
      handoff: call.destination?.context ?? null,
    };
  }

  #expired(call, text, topic) {
    call.lastTopic = topic ?? inferTopic(text) ?? "unknown";
    this.#event(call, "policy", "expired_refusal", sanitizeForAudit(text), { topic: call.lastTopic });
    const line = "The information I found may be out of date, so I can't use it as an approved answer. I can connect you with staff for help.";
    this.#speak(call, line);
    call.lastAnswer = { text: line, passages: [] };
    return { ok: true, expired: true, offerTransfer: true, answer: line };
  }

  #miss(call, text, reason) {
    call.lastTopic = inferTopic(text) ?? "unknown";
    this.#event(call, "policy", "retrieval_miss", reason, { topic: call.lastTopic, query: sanitizeForAudit(text) });
    const line = reason === "service_request"
      ? "I can't file service requests on this line. I don't have approved information on that, but I can connect you with staff."
      : "I don't have approved information on that. I can connect you with staff if you'd like.";
    this.#speak(call, `${line} ${AFTER_ANSWER}`);
    call.lastAnswer = { text: line, passages: [] };
    return { ok: true, miss: true, offerTransfer: true, answer: line };
  }

  #budgetExpired(call) {
    return call.answeredAt != null && !TERMINAL.has(call.state) && this.now().getTime() - call.answeredAt >= this.options.callTimeBudgetMs;
  }

  #expire(call) {
    this.#event(call, "system", "budget_expired", `${this.options.callTimeBudgetMs}ms`);
    return this.requestHuman(call.id, { reason: "time_budget_expired", topic: call.lastTopic ?? "Call time limit" });
  }

  #speak(call, text) {
    this.pushTranscript(call.id, "agent", text);
    this.agents.get(call.id)?.instruct?.(text, text);
  }

  #setState(call, state) {
    if (call.state === state) return;
    const from = call.state;
    call.state = state;
    this.audit.updateCall(call.id, { state });
    this.#event(call, "system", "state", `${from} → ${state}`);
    this.#publish(call, "state", this.snapshot(call.id));
  }

  #finish(call, state, outcome, extra = {}) {
    call.outcome = outcome;
    call.endedAt = this.now().getTime();
    this.#setState(call, state);
    this.audit.updateCall(call.id, { outcome, endedAt: new Date(call.endedAt).toISOString(), durationMs: call.endedAt - call.startedAt, ...extra });
    this.#publish(call, "state", this.snapshot(call.id));
  }

  #event(call, source, kind, detail, meta = null) {
    this.audit.recordEvent(call.id, source, kind, detail, meta);
    this.#publish(call, "event", { source, kind, detail, meta, at: this.now().toISOString() });
  }

  #publish(call, target, payload) { this.hub?.send?.(call.id, target, payload); }
  #require(callId) { const call = this.get(callId); if (!call) throw new Error(`unknown call ${callId}`); return call; }
}

export function maskPhone(phone) {
  if (!phone) return "anonymous";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length <= 2) return "•".repeat(digits.length) || "anonymous";
  const plus = String(phone).trim().startsWith("+") ? "+" : "";
  return `${plus}${"•".repeat(digits.length - 2)}${digits.slice(-2)}`;
}

export function wantsHuman(text) { return /\b(person|human|representative|operator|staff|someone|agent)\b/i.test(String(text ?? "")); }
function isDone(text) { return /\b(done|that's all|that is all|no thanks|goodbye|bye)\b/i.test(String(text ?? "")); }
function isRepeat(text) { return /\b(repeat|say that again)\b/i.test(String(text ?? "")); }
function isSlower(text) { return /\b(slower|slow down|more slowly)\b/i.test(String(text ?? "")); }
function wantsCitation(text) { return /\b(where.*(from|source)|source|citation|short url|link)\b/i.test(String(text ?? "")); }
function firstSentence(text) { return String(text ?? "").split(/(?<=[.!?])\s+/)[0] ?? String(text ?? ""); }
function monthName(date) { return new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date(`${date}T00:00:00Z`)); }
