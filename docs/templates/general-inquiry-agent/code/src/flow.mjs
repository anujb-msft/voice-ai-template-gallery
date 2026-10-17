import { randomUUID } from "node:crypto";
import { config, referenceNow } from "./config.mjs";
import { clip, topicFrom } from "./handoff.mjs";
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
const TRANSFER_FAILED_LINE = "I'm sorry — I can't connect you right now. Please call back during staffed hours or visit contoso.gov.";
const OFFER = "Would you like me to connect you?";
const DECLINED = "No problem. Is there anything else?";
const ELIGIBILITY_DISCLAIMER = "Staff make the final decision on eligibility.";
const PERSONAL_ELIGIBILITY = "I can't check your situation on this line, but staff can.";
const EXPIRED_LINE = "I found something on that, but it's past its review date and may be out of date, so I can't give it to you as an answer. I can't confirm the current rules, but staff can, or you can check contoso.gov.";
const MISS_LINE = "I don't have approved information on that, so I won't guess. Staff at the information desk can help.";
const SERVICE_LINE = "I can't file service requests on this line, and I don't have approved information on that. Staff at the information desk can help.";

/** Why a call is going to a person, in words for the Teams agent. */
const HANDOFF_WHY = Object.freeze({
  caller_requested: "the caller asked for a person",
  explicit_request: "the caller asked for a person",
  dtmf_0: "the caller pressed 0",
  no_input: "the caller could not be heard",
  time_budget_expired: "the call reached its time limit",
  expired_content: "the approved answer is out of date",
  retrieval_miss: "there is no approved answer",
  service_request: "this line can't file service requests",
  eligibility_review: "eligibility needs a staff decision",
});

/** A Teams toast topic for a call that never got to a subject of its own. */
const FALLBACK_SUBJECT = Object.freeze({
  caller_requested: "Asked for a person",
  explicit_request: "Asked for a person",
  dtmf_0: "Pressed 0 for a person",
  no_input: "Caller could not be heard",
  time_budget_expired: "Call time limit reached",
});

const SYSTEM_REASONS = new Set(["no_input", "time_budget_expired"]);

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

  create({ callId = randomUUID(), fromPhone = null, incomingCallContext = null, sessionId = null, resourceAccountId = null, simulated = false } = {}) {
    const call = {
      id: callId,
      fromPhone,
      maskedPhone: maskPhone(fromPhone),
      incomingCallContext,
      sessionId: sessionId ?? callId,
      resourceAccountId,
      arrival: resourceAccountId ? "teams-phone-extensibility" : "acs-direct",
      // A simulated call never reaches Teams, even on a server that could transfer.
      simulated: Boolean(simulated) || !this.transfer,
      callConnectionId: null,
      state: STATES.RINGING,
      startedAt: this.now().getTime(),
      answeredAt: null,
      endedAt: null,
      outcome: null,
      noInputs: 0,
      answers: [],
      searches: [],
      questions: [],
      withheld: [],
      refused: new Set(),
      lastSearch: null,
      lastAnswer: null,
      lastQuestion: null,
      lastTopic: null,
      subject: null,
      offeredTransfer: null,
      decision: null,
      humanRequested: false,
      destination: null,
      transferAttempts: 0,
      dispatched: false,
      transcript: [],
    };
    this.calls.set(call.id, call);
    this.audit.startCall({ id: call.id, maskedPhone: call.maskedPhone, state: call.state, startedAt: call.startedAt, sessionId: call.sessionId, simulated: call.simulated });
    this.#event(call, "system", "call_created", call.arrival);
    return call;
  }

  get(callId) { return this.calls.get(callId) ?? null; }
  registerAgent(callId, handle) { this.agents.set(callId, handle); }
  unregisterAgent(callId) { this.agents.delete(callId); }
  setCallConnection(callId, id) { const call = this.get(callId); if (call) call.callConnectionId = id; }

  /** Forget every call. The server only allows this on a simulation server (demo reset). */
  reset() {
    this.calls.clear();
    this.agents.clear();
  }

  /** The demo clock jumped by `deltaMs`: keep each open call's elapsed time and budget where they were. */
  rebaseClock(deltaMs) {
    if (!Number.isFinite(deltaMs) || !deltaMs) return;
    for (const call of this.calls.values()) {
      if (TERMINAL.has(call.state)) continue;
      call.startedAt += deltaMs;
      if (call.answeredAt != null) call.answeredAt += deltaMs;
    }
  }

  answered(callId) {
    const call = this.#require(callId);
    call.answeredAt = this.now().getTime();
    this.#setState(call, STATES.GREETING);
    this.#speak(call, GREETING);
    this.#setState(call, STATES.LISTENING);
    return call;
  }

  /**
   * The search_content tool. The model gets passages it may quote, or a miss.
   * Expired articles never leave the server: the model sees `expiredMatch`
   * only, and the refusal is recorded here, whatever the model says next.
   * Numbers the caller volunteered (an age, an income) are dropped from the
   * query first, whatever the model wrote, so they never reach the search.
   */
  searchContent(callId, { query, topic = null } = {}, { asked = query } = {}) {
    const call = this.#require(callId);
    if (this.#budgetExpired(call)) return this.#expire(call);
    const at = this.now();
    const searchable = withoutNumbers(query);
    const effectiveTopic = topic ?? inferTopic(searchable);
    const { withheld = [], ...result } = this.content.search(searchable, { topic: effectiveTopic, at });
    call.lastSearch = result;
    call.searches.push({ at: at.toISOString(), ...result, withheld: withheld.map((w) => w.articleId) });
    call.lastQuestion = sanitizeForAudit(asked);
    if (call.questions.at(-1) !== call.lastQuestion) call.questions.push(call.lastQuestion);
    call.withheld = withheld;
    call.lastTopic = result.topic ?? (effectiveTopic && effectiveTopic !== "any" ? effectiveTopic : "unknown");
    this.audit.updateCall(call.id, { lastTopic: call.lastTopic, lastQuestion: call.lastQuestion });
    this.#event(call, "tool", "search_content", call.lastQuestion, {
      query: call.lastQuestion,
      topic: call.lastTopic,
      miss: result.miss,
      expiredMatch: result.expiredMatch,
      passages: result.passages.map(({ text, ...p }) => p),
      withheld: withheld.map((w) => w.articleId),
    });
    this.#publish(call, "search", {
      topic: call.lastTopic,
      ...result,
      query: call.lastQuestion,
      withheld,
      passages: result.passages.map((p) => ({ ...p, text: p.text.slice(0, 240) })),
    });
    if (result.miss) this.#noAnswer(call, result, withheld);
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
    call.subject = passages[0].title;
    this.#event(call, "tool", "answer_recorded", ids.join(","), answer);
    if (answer.stale) this.#event(call, "policy", "stale_answer", ids.join(","), answer);
    const cited = passages.map(({ text, ...p }) => p);
    this.#publish(call, "citation", { articleIds: ids, topic: answer.topic, passages: cited, stale: answer.stale });
    this.#decide(call, {
      kind: "answer",
      query: call.lastQuestion,
      topic: answer.topic,
      stale: answer.stale,
      passage: cited[0],
      passages: cited,
      withheld: call.withheld,
      expiryGraceDays: this.content.expiryGraceDays,
      cited: false,
    });
    return { ok: true, ...answer };
  }

  /** The simulated agent: the same tools and policy, driven by typed caller lines. */
  answerFromSearch(callId, text) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state) || call.state === STATES.TRANSFERRING) return { ok: false, reason: "call_finished" };
    if (this.#budgetExpired(call)) return this.#expire(call);
    const said = String(text ?? "").replace(/[\u2018\u2019]/g, "'").trim();
    this.pushTranscript(callId, "caller", said);

    if (isDone(said)) return this.endCall(callId, "caller_done");
    if (isSlower(said)) return this.repeatLast(callId, { slower: true });
    if (isRepeat(said)) return this.repeatLast(callId, { slower: false });
    if (wantsCitation(said) && call.lastAnswer) return this.sayCitation(callId);

    const offered = call.offeredTransfer;
    if (offered && isAffirmative(said)) return this.requestHuman(callId, { reason: offered.reason });
    if (offered && isDecline(said)) {
      call.offeredTransfer = null;
      this.#event(call, "caller", "offer_declined", offered.reason);
      this.#speak(call, DECLINED);
      return { ok: true, declined: true, answer: DECLINED };
    }
    if (wantsHuman(said)) return this.requestHuman(callId, { reason: offered?.reason ?? "caller_requested" });
    call.offeredTransfer = null;
    if (isServiceRequest(said)) return this.#miss(call, said, "service_request");

    const personalEligibility = hasPersonalEligibilityDetails(said);
    const query = personalEligibility
      ? `${sanitizeForAudit(said).replace(/\[(?:number|amount)\]/g, "")} eligibility general criteria`
      : said;
    const search = this.searchContent(callId, { query, topic: personalEligibility ? "benefits-eligibility" : inferTopic(said) }, { asked: said });
    if (search.action) return search;
    if (search.expiredMatch && !search.passages.length) return this.#expired(call);
    if (search.miss) return this.#miss(call, said, "miss");
    const passage = search.passages[0];
    const record = this.recordAnswer(callId, { articleIds: [passage.articleId], topic: passage.topic });
    if (!record.ok) return record;

    const eligibility = passage.topic === "benefits-eligibility";
    const sentences = [firstSentence(passage.text)];
    if (passage.hoursNow) sentences.push(hoursSentence(passage.hoursNow));
    sentences.push(`That's from ${passage.source}.`);
    if (passage.freshness === "stale") sentences.push(`This information was due for review in ${monthName(passage.reviewBy)}, so please check ${passage.shortUrl} or ask staff before relying on it.`);
    if (eligibility) sentences.push(ELIGIBILITY_DISCLAIMER);
    let closing = AFTER_ANSWER;
    if (personalEligibility) {
      sentences.push(PERSONAL_ELIGIBILITY);
      call.subject = `${passage.title} — eligibility`;
      this.#decide(call, { ...call.decision, eligibility, personal: true });
      closing = this.#offer(call, "eligibility_review");
    } else if (eligibility) {
      this.#decide(call, { ...call.decision, eligibility, personal: false });
    }
    const answer = `${sentences.join(" ")} ${closing}`;
    call.lastAnswer = { text: answer, passages: [passage] };
    this.#setState(call, STATES.ANSWERING);
    this.#speak(call, answer);
    this.#setState(call, STATES.LISTENING);
    return { ok: true, answered: true, answer, citation: passage.articleId, personalEligibilityHandled: personalEligibility, offerTransfer: Boolean(call.offeredTransfer) };
  }

  /**
   * Hand the call to a person. Staffed: transfer to the Teams queue with the
   * context the agent needs. After hours: say when the desk opens and close,
   * never a transfer into an empty queue.
   */
  requestHuman(callId, { reason = "caller_requested", topic = null, sentiment = null } = {}) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    if (call.state === STATES.TRANSFERRING) return { ok: true, action: "transfer", pending: true, context: call.destination?.context ?? null };
    call.humanRequested = true;
    call.offeredTransfer = null;
    call.subject = humanTopic(topic) ?? call.subject ?? FALLBACK_SUBJECT[reason] ?? "General inquiry";
    if (sentiment) call.sentiment = sentiment;
    const why = HANDOFF_WHY[reason] ?? String(reason).replace(/_/g, " ");
    this.#event(call, SYSTEM_REASONS.has(reason) ? "system" : "caller", "human_requested", reason, { topic: call.lastTopic, subject: call.subject });
    const hours = this.hours.decision(this.now());
    this.#publish(call, "hours", hours);
    if (!hours.staffed) {
      this.#event(call, "policy", "after_hours_closed", hours.nextOpening ?? "closed", { reason, localTime: hours.localTime, nextOpening: hours.nextOpening });
      this.#decide(call, { kind: "after_hours", reason, why, subject: call.subject, hours });
      this.#speak(call, afterHoursLine(hours));
      this.#finish(call, STATES.CLOSED, `after_hours:${reason}`);
      return { ok: true, action: "closed", afterHours: true, message: hours.message, nextStaffed: hours.nextStaffed, nextOpening: hours.nextOpening };
    }
    const context = this.handoffContext(call, reason);
    call.destination = { target: this.hours.queue, context, reason };
    this.#decide(call, { kind: "handoff", reason, why, subject: call.subject, hours, queue: this.hours.queue?.displayName ?? null, context });
    this.#speak(call, connectingLine(this.hours.queue?.displayName));
    this.#setState(call, STATES.TRANSFERRING);
    call.dispatchPromise = this.dispatchTransfer(call.id);
    return { ok: true, action: "transfer", context };
  }

  dtmf(callId, digit) {
    const call = this.#require(callId);
    this.#event(call, "caller", "dtmf", String(digit));
    if (String(digit) === "0") return this.requestHuman(callId, { reason: call.offeredTransfer?.reason ?? "dtmf_0" });
    return { ok: false, reason: "unmapped_digit" };
  }

  noInput(callId) {
    const call = this.#require(callId);
    if (this.#budgetExpired(call)) return this.#expire(call);
    call.noInputs += 1;
    this.#event(call, "caller", "no_input", String(call.noInputs));
    if (call.noInputs >= this.options.maxNoInput) return this.requestHuman(callId, { reason: "no_input" });
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
    call.offeredTransfer = null;
    if (!p) {
      const line = `I didn't give you an approved answer for that, so there's no source to read. ${AFTER_ANSWER}`;
      this.#speak(call, line);
      return { ok: false, reason: "no_citation", spoken: line };
    }
    const line = `That came from ${p.source}. The short URL is ${p.shortUrl}. ${AFTER_ANSWER}`;
    this.#speak(call, line);
    this.#event(call, "agent", "citation_spoken", p.articleId, { articleId: p.articleId, shortUrl: p.shortUrl });
    if (call.decision?.kind === "answer") this.#decide(call, { ...call.decision, cited: true });
    return { ok: true, citation: p.articleId, spoken: line };
  }

  endCall(callId, reason = "caller_done") {
    const call = this.get(callId);
    if (!call || TERMINAL.has(call.state)) return { ok: true };
    // Nobody is left to hear a goodbye once the caller has hung up.
    if (reason !== "caller_hung_up") this.#speak(call, reason === "caller_done" ? "Thanks for calling the City of Contoso. Goodbye." : "Goodbye.");
    this.#finish(call, STATES.CLOSED, reason);
    return { ok: true, ended: true };
  }

  async dispatchTransfer(callId) {
    const call = this.#require(callId);
    if (call.dispatched || !call.destination) return { ok: false, reason: "nothing_to_dispatch" };
    call.dispatched = true;
    call.transferAttempts += 1;
    const queue = this.hours.queue?.displayName ?? "Teams queue";
    this.#event(call, "system", "transfer_started", call.destination.reason, call.destination.context);
    if (!this.transfer || call.simulated) {
      this.#event(call, "system", "transfer_simulated", queue, call.destination.context);
      this.#publish(call, "handoff", { ...call.destination.context, queue, simulated: true });
      this.#finish(call, STATES.TRANSFERRED, `transferred:${call.destination.reason}`, { simulated: true });
      return { ok: true, simulated: true, context: call.destination.context };
    }
    try {
      await this.transfer(call, call.destination);
      this.#event(call, "system", "transfer_succeeded", queue, call.destination.context);
      this.#publish(call, "handoff", { ...call.destination.context, queue, simulated: false });
      this.#finish(call, STATES.TRANSFERRED, `transferred:${call.destination.reason}`);
      return { ok: true, context: call.destination.context };
    } catch (error) {
      this.#event(call, "system", "transfer_failed", error.message);
      this.#speak(call, TRANSFER_FAILED_LINE);
      this.#finish(call, STATES.CLOSED, "transfer_failed");
      return { ok: false, reason: "transfer_failed", error: error.message };
    }
  }

  /**
   * ACS accepted the transfer request, then reported CallTransferFailed: nobody
   * picked up. The caller is still on the line, so close the call the way a
   * refused request does. Re-dispatching instead would loop for as long as the
   * queue kept failing.
   */
  transferFailed(callId, message = "transfer failed") {
    const call = this.get(callId);
    if (!call || call.simulated || call.state !== STATES.TRANSFERRED) return { ok: false, reason: "nothing_to_recover" };
    this.#event(call, "system", "transfer_failed", message, { accepted: true });
    this.#speak(call, TRANSFER_FAILED_LINE);
    this.#finish(call, STATES.CLOSED, "transfer_failed");
    return { ok: false, reason: "transfer_failed", error: message };
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

  /**
   * What the Teams agent sees. The topic is the call's subject; the context
   * adds what the topic does not already say: the caller's own words, what
   * was answered or withheld, and why the call is coming to a person.
   */
  handoffContext(call, reason = "caller_requested") {
    const subject = call.subject ?? "General inquiry";
    const questions = call.questions.filter((q) => topicFrom(q) !== subject).slice(-2);
    const answered = [...new Set(call.answers.flatMap((a) => a.articleIds))].slice(-3);
    const withheld = [...call.refused].filter((id) => id !== "*");
    const asked = questions.map((q) => `"${q}"`).join(" and ");
    const parts = [
      questions.length ? endSentence(`Caller asked: ${asked}`).replace(/([.!?])"\.$/, '$1"') : null,
      answered.length ? `Answered from ${answered.join(", ")}.` : "No approved answer was given.",
      withheld.length ? `Withheld as out of date: ${withheld.join(", ")}.` : null,
      `Transferring because ${HANDOFF_WHY[reason] ?? String(reason).replace(/_/g, " ")}.`,
    ];
    return {
      sessionId: call.sessionId ?? call.id,
      callTopic: clip(subject, 48),
      callContext: clip(parts.filter(Boolean).join(" "), 900),
      callSentiment: call.sentiment,
    };
  }

  snapshot(callId) {
    const call = this.get(callId);
    if (!call) return null;
    const hours = this.hours.decision(this.now());
    return {
      id: call.id,
      state: call.state,
      maskedPhone: call.maskedPhone,
      arrival: call.arrival,
      simulated: call.simulated,
      outcome: call.outcome,
      elapsedMs: (call.endedAt ?? this.now().getTime()) - call.startedAt,
      budgetMs: this.options.callTimeBudgetMs,
      lastTopic: call.lastTopic,
      lastQuestion: call.lastQuestion,
      subject: call.subject,
      questions: call.questions,
      answers: call.answers,
      searches: call.searches.map((s) => ({ ...s, passages: s.passages?.map(({ text, ...p }) => p) ?? [] })),
      withheld: call.withheld,
      noInputs: call.noInputs,
      offeredTransfer: call.offeredTransfer,
      decision: call.decision,
      hours: {
        open: hours.open,
        closesAt: hours.closesAt,
        nextOpening: hours.nextOpening,
        localTime: hours.localTime,
        timeZone: hours.timeZone,
        hoursText: hours.hoursText,
        queue: hours.queue,
      },
      destination: call.destination ? { displayName: call.destination.target?.displayName ?? null, context: call.destination.context } : null,
      transcript: call.transcript,
      handoff: call.destination?.context ?? null,
    };
  }

  /** No usable passage: refuse expired content, or record a plain miss. */
  #noAnswer(call, result, withheld) {
    if (result.expiredMatch) {
      const top = withheld[0];
      if (top) call.subject = top.title;
      const key = top?.articleId ?? "*";
      if (!call.refused.has(key)) {
        call.refused.add(key);
        this.#event(call, "policy", "expired_refusal", top?.articleId ?? "expired", {
          topic: call.lastTopic,
          query: call.lastQuestion,
          articleIds: withheld.map((w) => w.articleId),
          overdueDays: top?.overdueDays ?? null,
        });
      }
      this.#decide(call, { kind: "expired", query: call.lastQuestion, topic: call.lastTopic, withheld, expiryGraceDays: this.content.expiryGraceDays });
      return;
    }
    call.subject = topicFrom(call.lastQuestion) ?? call.subject;
    this.#event(call, "policy", "retrieval_miss", "miss", { topic: call.lastTopic, query: call.lastQuestion });
    this.#decide(call, { kind: "miss", reason: "miss", query: call.lastQuestion, topic: call.lastTopic, minScore: this.content.minScore });
  }

  #expired(call) {
    const line = `${EXPIRED_LINE} ${this.#offer(call, "expired_content")}`;
    this.#speak(call, line);
    call.lastAnswer = { text: line, passages: [] };
    return { ok: true, expired: true, offerTransfer: Boolean(call.offeredTransfer), answer: line };
  }

  #miss(call, text, reason) {
    if (reason === "service_request") {
      const asked = sanitizeForAudit(text);
      call.lastQuestion = asked;
      if (call.questions.at(-1) !== asked) call.questions.push(asked);
      call.lastTopic = inferTopic(text) ?? "unknown";
      call.subject = topicFrom(asked) ?? call.subject;
      this.audit.updateCall(call.id, { lastTopic: call.lastTopic, lastQuestion: asked });
      this.#event(call, "policy", "retrieval_miss", reason, { topic: call.lastTopic, query: asked });
      this.#decide(call, { kind: "miss", reason, query: asked, topic: call.lastTopic });
    }
    const lead = reason === "service_request" ? SERVICE_LINE : MISS_LINE;
    const line = `${lead} ${this.#offer(call, reason === "service_request" ? "service_request" : "retrieval_miss")}`;
    this.#speak(call, line);
    call.lastAnswer = { text: line, passages: [] };
    return { ok: true, miss: true, offerTransfer: Boolean(call.offeredTransfer), answer: lead };
  }

  /** Offer a person only when someone is there to take the call. */
  #offer(call, reason) {
    const hours = this.hours.decision(this.now());
    call.offeredTransfer = hours.staffed ? { reason } : null;
    // "human_offered", not "transfer_*": an offer the caller turns down is not a handoff.
    this.#event(call, "agent", hours.staffed ? "human_offered" : "desk_closed_noted", reason, { nextOpening: hours.nextOpening });
    if (call.decision) this.#decide(call, { ...call.decision, offer: { reason, staffed: hours.staffed, nextOpening: hours.nextOpening } });
    if (hours.staffed) return OFFER;
    return hours.nextOpening
      ? `The information desk is closed right now and opens again ${hours.nextOpening}, so please call back then or visit contoso.gov. ${AFTER_ANSWER}`
      : `The information desk is closed right now, so please visit contoso.gov. ${AFTER_ANSWER}`;
  }

  #budgetExpired(call) {
    return call.answeredAt != null && !TERMINAL.has(call.state) && this.now().getTime() - call.answeredAt >= this.options.callTimeBudgetMs;
  }

  #expire(call) {
    this.#event(call, "system", "budget_expired", `${this.options.callTimeBudgetMs}ms`);
    return this.requestHuman(call.id, { reason: "time_budget_expired" });
  }

  #speak(call, text) {
    const agent = this.agents.get(call.id);
    // A voiced agent's own transcript comes back from Voice Live; don't log the line twice.
    if (!agent?.voiced) this.pushTranscript(call.id, "agent", text);
    agent?.instruct?.(text, text);
  }

  #decide(call, decision) {
    call.decision = { ...decision, at: this.now().toISOString() };
    this.#publish(call, "decision", call.decision);
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

/** A short yes to "Would you like me to connect you?". */
function isAffirmative(text) {
  const t = shortReply(text);
  if (!t || /\b(no|not|nope|don't|dont)\b/.test(t)) return false;
  return /^(yes|yeah|yep|yup|sure|ok|okay|please|go ahead|connect me|sounds good|that would be great)\b/.test(t);
}

/** A short no to the same offer. */
function isDecline(text) {
  const t = shortReply(text);
  return Boolean(t) && /^(no|nope|nah|not now|not right now|i'm good|i'm ok|i'm okay|that's ok|that's okay)\b/.test(t);
}

function shortReply(text) {
  const raw = String(text ?? "");
  if (raw.includes("?")) return null;
  const t = raw.toLowerCase().replace(/[.!,]+/g, " ").replace(/\s+/g, " ").trim();
  return t && t.split(" ").length <= 6 ? t : null;
}

/** A model-supplied topic, unless it is only a topic id like "hours-locations". */
function humanTopic(topic) {
  const text = String(topic ?? "").trim();
  if (!text || /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(text)) return null;
  return topicFrom(text);
}

function hoursSentence({ place, open, closesAt, nextOpening }) {
  const who = place ?? "It";
  if (open) return endSentence(`${who} is open right now, until ${closesAt}`);
  return endSentence(nextOpening ? `${who} is closed right now and opens again ${nextOpening}` : `${who} is closed right now`);
}

function afterHoursLine(hours) {
  const reopen = hours.nextOpening ? ` and opens again ${hours.nextOpening}` : "";
  return `${endSentence(`I can't connect you right now — the information desk is closed${reopen}`)} ${hours.message} Goodbye.`;
}

/** Adds a period unless the text already ends in one (for example "5 p.m."). */
function endSentence(text) { return /[.!?]$/.test(text) ? text : `${text}.`; }

function connectingLine(queue) {
  return `Connecting you now${queue ? ` with the ${queue}` : ""}. I'll pass along what you asked so you don't have to repeat it.`;
}

// An age, an income or a house number is never a search term.
function withoutNumbers(text) {
  return String(text ?? "").replace(/\$\s?\d[\d,.]*/g, " ").replace(/\b\d{2,}\b/g, " ").replace(/\s+/g, " ").trim();
}
// Splits only before a capital letter, so "8:00 a.m. to 5:00 p.m." stays whole.
function firstSentence(text) { return String(text ?? "").split(/(?<=[.!?])\s+(?=[A-Z])/)[0] ?? String(text ?? ""); }
function monthName(date) { return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`)); }
