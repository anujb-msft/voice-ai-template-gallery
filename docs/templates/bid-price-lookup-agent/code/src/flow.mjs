import { randomUUID } from "node:crypto";
import { config } from "./config.mjs";
import { andList, orList } from "./pricing.mjs";

export const STATES = Object.freeze({
  RINGING: "ringing",
  GREETING: "greeting",
  LISTENING: "listening",
  QUOTING: "quoting",
  TRANSFERRING: "transferring",
  TRANSFERRED: "transferred",
  CLOSING: "closing",
  ENDED: "ended",
});
const TERMINAL = new Set([STATES.TRANSFERRED, STATES.ENDED]);
const TOPIC_LIMIT = 48;
const CONTEXT_LIMIT = 1024;
const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const capitalize = (s) => String(s ?? "").charAt(0).toUpperCase() + String(s ?? "").slice(1);
const money = (v) => `$${Number(v).toFixed(2)}`;
const FILLER = /^(yes|yeah|yep|no|nope|ok(ay)?|sure|thanks?|thank you|please|[0-9*#])[.!?]*$/i;

export const GREETING = "Contoso Grain Co-op bid line. I'm an automated assistant. Bids are subject to change without notice. Confirm with the merchandiser before selling. Which commodity and location?";
export const ADVICE_PHRASE = "I can't advise on that, but the merchandiser can talk it through with you.";
export const GOODBYE = "Thanks for calling Contoso Grain Co-op. Goodbye.";
const CONTRACT_PREFACE = "I can't lock in or book a price on this line — only a merchandiser can.";
const OPENING_QUESTION = "Which commodity and location? For example, corn at Riverside.";
const DEFAULT_REPROMPT = "Sorry, I didn't catch that. Please say the commodity and location, or press 0 for a merchandiser.";

export const REASON_LABELS = Object.freeze({
  sell_request: "Caller wants to sell",
  contract_request: "Caller wants to lock in or book a price",
  feed_outage: "Price feed was down — no price was quoted",
  dtmf_0: "Caller pressed 0 for a merchandiser",
  caller_requested: "Caller asked for a merchandiser",
  advice_request: "Caller wanted advice on selling",
});
// A generic "get me a person" keeps the more specific reason an earlier offer already established.
const GENERIC_REASONS = new Set(["caller_requested", "dtmf_0"]);
const callEnded = () => ({ ok: false, reason: "call_ended", message: "This call has already ended." });

export function maskPhone(phone) {
  if (!phone) return "anonymous";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length <= 2) return "•".repeat(digits.length) || "anonymous";
  return `${String(phone).trim().startsWith("+") ? "+" : ""}${"•".repeat(digits.length - 2)}${digits.slice(-2)}`;
}

function quoteLabel(q) {
  return `${capitalize(q.commodity)} · ${q.locationName} · ${q.deliveryMonth} — ${money(q.cashBid)}, ${q.freshness}`;
}

function clarifyDetail(result) {
  switch (result.reason) {
    case "ambiguous": return `Asked which location — it matched ${andList(result.candidates ?? [])}`;
    case "unknown_location": return "Asked which location — none by that name";
    case "missing_location": return "Asked which location — none given";
    case "missing_commodity": return `Asked which commodity${result.locationName ? ` at ${result.locationName}` : ""} — none given`;
    case "unknown_commodity": return "Asked which commodity — not one the co-op posts";
    case "unposted_month": return `Asked which delivery month — that month isn't posted at ${result.locationName}`;
    default: return `Asked a clarifying question (${result.reason})`;
  }
}

export class BidLookupFlow {
  constructor({ priceBook, audit, transfer = null, hub = null, now = () => Date.now(), options = {} }) {
    this.priceBook = priceBook;
    this.audit = audit;
    this.transfer = transfer;
    this.hub = hub;
    this.now = now;
    this.options = { callTimeBudgetMs: config.pricing.callTimeBudgetMs, maxNoInputs: 2, ...options };
    this.calls = new Map();
    this.agents = new Map();
  }

  create({ callId = randomUUID(), fromPhone = null, incomingCallContext = null, sessionId = null, resourceAccountId = null, simulated = false } = {}) {
    const call = {
      id: callId,
      fromPhone,
      maskedPhone: maskPhone(fromPhone),
      incomingCallContext,
      sessionId,
      resourceAccountId,
      simulated: Boolean(simulated),
      arrival: simulated ? "simulated" : resourceAccountId ? "teams-phone-extensibility" : "acs-direct",
      callConnectionId: null,
      state: STATES.RINGING,
      disclaimerSpoken: false,
      lastLocationId: null,
      lastQuote: null,
      lastPhrase: null,
      lastRequest: null,
      lastQuestion: null,
      pending: null,
      clarifications: 0,
      quotes: 0,
      decision: null,
      callback: null,
      noInputs: 0,
      outcome: null,
      startedAt: this.now(),
      answeredAt: null,
      endedAt: null,
      transcript: [],
      pendingTransfer: null,
      lastTransfer: null,
      dispatchPromise: null,
    };
    this.calls.set(call.id, call);
    this.audit.startCall({ id: call.id, maskedPhone: call.maskedPhone, state: call.state, startedAt: new Date(call.startedAt).toISOString(), simulated: call.simulated });
    const via = call.simulated ? "Simulated call" : call.arrival === "teams-phone-extensibility" ? "Teams Phone call" : "Phone call";
    this.#event(call, "system", "call_created", `${via} from ${call.maskedPhone}`);
    return call;
  }

  get(callId) { return this.calls.get(callId) ?? null; }
  registerAgent(callId, handle) { this.agents.set(callId, handle); }
  unregisterAgent(callId) { this.agents.delete(callId); }
  setCallConnection(callId, callConnectionId) { const c = this.get(callId); if (c) c.callConnectionId = callConnectionId; }

  /** Forget every call. The demo console's reset between run-throughs. */
  reset() {
    this.calls.clear();
    this.agents.clear();
  }

  answered(callId) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state) || call.answeredAt != null) return call;
    call.answeredAt = this.now();
    this.#setState(call, STATES.GREETING);
    call.disclaimerSpoken = true;
    call.lastQuestion = OPENING_QUESTION;
    this.#say(call, GREETING, "Open with exactly this disclosure and disclaimer, then ask for commodity and location.");
    this.#setState(call, STATES.LISTENING);
    return call;
  }

  getBid(callId, { commodity = null, location = null, month = null } = {}) {
    const call = this.#active(callId);
    if (!call) return callEnded();
    if (this.#budgetExpired(call)) return this.#expire(call);
    // An answer to a clarifying question fills only the gap that was asked about.
    const p = call.pending?.kind === "quote" ? call.pending : null;
    const ask = {
      commodity: commodity || (p ? p.commodity : call.lastQuote?.commodity) || null,
      location: location || p?.location || null,
      month: month || p?.month || null,
    };
    this.#setState(call, STATES.QUOTING);
    const result = this.priceBook.quote({ ...ask, lastLocationId: call.lastLocationId });
    return this.#settleQuote(call, result, { kind: "quote", month: ask.month });
  }

  listBids(callId, { commodity = null, month = null } = {}) {
    const call = this.#active(callId);
    if (!call) return callEnded();
    if (this.#budgetExpired(call)) return this.#expire(call);
    const p = call.pending?.kind === "list" ? call.pending : null;
    const ask = { commodity: commodity || p?.commodity || null, month: month || p?.month || null };
    this.#setState(call, STATES.QUOTING);
    const result = this.priceBook.list(ask);
    return this.#settleQuote(call, result, { kind: "list", month: ask.month });
  }

  adviceBoundary(callId) {
    const call = this.#active(callId);
    if (!call) return callEnded();
    this.#event(call, "system", "advice_guard", "Asked for market advice — the agent never advises or predicts");
    call.pending = { kind: "offer", reason: "advice_request", locationId: call.lastLocationId, commodity: call.lastQuote?.commodity ?? null, callback: false, accept: "transfer" };
    call.lastQuestion = ADVICE_PHRASE;
    this.#decide(call, "advice", "advice_request", "Market advice is out of scope — the agent never advises or predicts.");
    this.#say(call, ADVICE_PHRASE, "Do not advise, predict, or compare markets. If they want the merchandiser, call transfer_to_merchandiser.");
    return { ok: true, phrase: ADVICE_PHRASE };
  }

  /** The caller said yes to the person (or callback) the agent just offered. */
  acceptOffer(callId) {
    const call = this.#active(callId);
    if (!call) return callEnded();
    if (call.pending?.kind === "offer" && call.pending.accept === "callback") return this.requestCallback(callId);
    return this.transferToMerchandiser(callId);
  }

  transferToMerchandiser(callId, { location = null, reason = null } = {}) {
    const call = this.#active(callId);
    if (!call) return callEnded();
    if (call.state === STATES.TRANSFERRING && call.pendingTransfer) {
      return { ok: true, action: "transfer", locationId: call.pendingTransfer.location.id, reason: call.pendingTransfer.reason, duplicate: true };
    }
    const pending = call.pending;
    const carried = pending?.kind === "offer" ? pending.reason : pending?.kind === "transfer" ? pending.transferReason : null;
    const why = carried && (!reason || GENERIC_REASONS.has(reason)) ? carried : reason ?? "caller_requested";
    const commodity = (pending?.kind === "offer" ? pending.commodity : null) ?? call.lastQuote?.commodity ?? null;
    const fallbackId = (pending?.kind === "offer" ? pending.locationId : null) ?? call.lastLocationId;
    const directory = this.priceBook.locations;
    const match = location
      ? directory.match(location)
      : fallbackId && directory.get(fallbackId)
        ? { ok: true, location: directory.get(fallbackId) }
        : { ok: false, reason: "missing_location" };

    if (!match.ok) {
      const names = match.reason === "ambiguous" ? match.candidates.map((l) => l.displayName) : null;
      const message = names ? `Did you mean ${orList(names)}?` : `Which location's merchandiser would you like — ${orList(directory.names())}?`;
      const detail = names ? `Asked which merchandiser — it matched ${andList(names)}` : "Asked which location's merchandiser to connect";
      call.clarifications += 1;
      call.pending = { kind: "transfer", reason: match.reason, transferReason: why, candidates: names };
      call.lastQuestion = message;
      this.#event(call, "system", "clarification", detail);
      this.#decide(call, "clarify", match.reason, detail, { candidates: names, question: message });
      this.#say(call, message, "Ask which location to connect. Do not transfer yet.");
      return { ok: false, clarify: true, reason: match.reason, message, ...(names ? { ambiguous: true, candidates: names } : {}) };
    }

    const loc = match.location;
    call.lastLocationId = loc.id;
    call.pending = null;
    if (why === "contract_request") {
      this.#event(call, "system", "contract_guard", "Only a merchandiser can lock in or book a price — nothing was locked");
    } else if (why !== "feed_outage" && why !== "advice_request") {
      this.#event(call, "system", "human_requested", REASON_LABELS[why] ?? why);
    }

    if (!directory.isMerchandiserOpen(loc.id, this.#businessNow())) {
      const preface = why === "contract_request" ? `${CONTRACT_PREFACE} ` : "";
      const phrase = `${preface}${directory.hoursPhrase(loc.id)} Please call back during those hours. Goodbye.`;
      this.#event(call, "system", "after_hours", `${loc.displayName} merchandiser is closed — no transfer`);
      this.#decide(call, "after_hours", why, `${loc.displayName} merchandiser is closed, so the agent gives the hours instead of transferring.`);
      this.#say(call, phrase, "After hours: do not transfer; close politely.");
      this.#finish(call, STATES.ENDED, `closed_after_hours:${why}`);
      return { ok: true, action: "closed", afterHours: true, phrase };
    }

    this.#setState(call, STATES.TRANSFERRING);
    const connect = `Connecting you with the ${loc.displayName} merchandiser now.`;
    const phrase = why === "contract_request" ? `${CONTRACT_PREFACE} ${connect}` : connect;
    call.pendingTransfer = { target: loc.merchandiser, location: loc, reason: why, commodity };
    this.#decide(call, "transfer", why, REASON_LABELS[why] ?? why);
    this.#say(call, phrase, "Say this once, then stop talking while the blind transfer starts.");
    call.dispatchPromise = this.dispatchTransfer(call.id);
    return { ok: true, action: "transfer", locationId: loc.id, reason: why, phrase };
  }

  async dispatchTransfer(callId) {
    const call = this.get(callId);
    if (!call?.pendingTransfer || TERMINAL.has(call.state)) return { ok: false, reason: "nothing_to_transfer" };
    const destination = call.pendingTransfer;
    const context = this.handoffContext(call, destination);
    this.#event(call, "system", "transfer_started", `To the ${destination.location.displayName} merchandiser — ${context.reasonLabel}`);
    if (!this.transfer || call.simulated) {
      this.#event(call, "system", "transfer_simulated", `Handed to ${context.queue ?? "the merchandiser"} with the call context`);
      this.#publish(call, "handoff", context);
      this.#finish(call, STATES.TRANSFERRED, `transferred:${destination.reason}`, { simulated: true });
      return { ok: true, simulated: true, context };
    }
    try {
      await this.transfer(call, { target: destination.target, context, reason: destination.reason });
    } catch (error) {
      return this.#transferFailed(call, destination, error);
    }
    this.#event(call, "system", "transfer_succeeded", `Handed to ${context.queue ?? "the merchandiser"}`);
    this.#publish(call, "handoff", context);
    call.lastTransfer = destination;
    this.#finish(call, STATES.TRANSFERRED, `transferred:${destination.reason}`);
    return { ok: true, context };
  }

  /**
   * ACS accepted the transfer request, then reported that the transfer failed (CallTransferFailed): nobody
   * picked up. The caller is still on the line with the agent, so reopen the call and offer a callback
   * rather than leave them in silence.
   */
  transferFailed(callId, message = "The merchandiser could not be reached") {
    const call = this.get(callId);
    const destination = call?.lastTransfer;
    if (!destination || call.simulated || call.state !== STATES.TRANSFERRED) return { ok: false, reason: "nothing_to_recover" };
    call.lastTransfer = null;
    call.outcome = null;
    call.endedAt = null;
    call.state = STATES.TRANSFERRING;
    this.audit.updateCall(call.id, { state: call.state, outcome: null, endedAt: null });
    return this.#transferFailed(call, destination, new Error(message));
  }

  /**
   * Log a callback request for the merchandiser and end the call. The request is recorded in the audit
   * trail and pushed to the console; delivering it to a person (a Teams message, a CRM task) is yours to wire up.
   */
  requestCallback(callId, { location = null, reason = null } = {}) {
    const call = this.#active(callId);
    if (!call) return callEnded();
    if (call.state === STATES.TRANSFERRING) return { ok: false, reason: "transfer_in_progress" };
    const pending = call.pending?.kind === "offer" ? call.pending : null;
    const why = pending?.reason && (!reason || GENERIC_REASONS.has(reason)) ? pending.reason : reason ?? "caller_requested";
    if (!call.fromPhone) {
      this.#event(call, "system", "callback_unavailable", "No caller ID — a callback can't be set up");
      this.#say(call, "I can't see the number you're calling from, so I can't set up a callback.", "Explain once, then transfer.");
      return this.transferToMerchandiser(callId, { location, reason: why });
    }
    const directory = this.priceBook.locations;
    const fallbackId = pending?.locationId ?? call.lastLocationId;
    const match = location ? directory.match(location) : { ok: Boolean(fallbackId && directory.get(fallbackId)), location: directory.get(fallbackId) };
    const loc = match.ok ? match.location : null;
    const open = loc ? directory.isMerchandiserOpen(loc.id, this.#businessNow()) : true;
    const who = loc ? `the ${loc.displayName} merchandiser` : "a merchandiser";
    const ending = String(call.fromPhone).replace(/\D/g, "").slice(-2);
    const phrase = `I've asked ${who} to call you back${open ? "" : " during business hours"} at the number ending ${ending}. ${GOODBYE}`;
    const commodity = pending?.commodity ?? call.lastQuote?.commodity ?? null;
    call.callback = {
      locationId: loc?.id ?? null,
      locationName: loc?.displayName ?? null,
      queue: loc?.merchandiser?.displayName ?? null,
      reason: why,
      reasonLabel: REASON_LABELS[why] ?? why,
      commodity,
      maskedPhone: call.maskedPhone,
      whenOpen: !open,
      at: this.#businessNow().toISOString(),
    };
    this.#event(call, "system", "callback_requested", `${loc ? `${loc.displayName} merchandiser` : "Merchandiser"} · caller ${call.maskedPhone} · ${call.callback.reasonLabel}`);
    this.#publish(call, "callback", { ...call.callback, callContext: this.handoffContext(call, { location: loc, reason: why, commodity }).callContext });
    this.#decide(call, "callback", why, `Callback logged for ${who}${why === "feed_outage" ? " — no number was quoted" : ""}.`);
    this.#say(call, phrase, "Confirm the callback once, then end the call.");
    this.#finish(call, STATES.ENDED, `callback_requested:${why}`);
    return { ok: true, action: "callback", ending: true, phrase, locationId: loc?.id ?? null };
  }

  /** Repeat what was said last. A price is re-checked first, so a repeat never replays a number that has since gone stale. */
  repeatLast(callId) {
    const call = this.#active(callId);
    if (!call) return callEnded();
    if (this.#budgetExpired(call)) return this.#expire(call);
    const pending = call.pending;
    if (pending?.kind === "offer" && pending.reason === "feed_outage" && call.lastRequest) return this.#recheck(call);
    if (pending && call.lastQuestion) {
      this.#say(call, call.lastQuestion, "Repeat the question verbatim.");
      return { ok: true, phrase: call.lastQuestion, repeated: true };
    }
    if (call.lastRequest) return this.#recheck(call);
    const phrase = call.lastQuestion ?? OPENING_QUESTION;
    this.#say(call, phrase, "Repeat the question verbatim.");
    return { ok: true, phrase, repeated: true };
  }

  noInput(callId) {
    const call = this.#active(callId);
    if (!call) return callEnded();
    call.noInputs += 1;
    this.#event(call, "caller", "no_input", `Silence ${call.noInputs} of ${this.options.maxNoInputs}`);
    if (call.noInputs >= this.options.maxNoInputs) return this.endCall(callId, "no_input");
    const phrase = call.pending && call.lastQuestion ? `Sorry, I didn't catch that. ${call.lastQuestion}` : DEFAULT_REPROMPT;
    this.#say(call, phrase, "One no-input reprompt.");
    return { ok: true, reprompt: true, phrase };
  }

  dtmf(callId, digit) {
    const call = this.#active(callId);
    if (!call) return callEnded();
    const key = String(digit);
    if (key === "*") {
      this.#event(call, "caller", "dtmf", "Pressed * — repeat");
      return this.repeatLast(callId);
    }
    if (key === "0") {
      this.#event(call, "caller", "dtmf", "Pressed 0 — merchandiser");
      return this.transferToMerchandiser(callId, { reason: "dtmf_0" });
    }
    this.#event(call, "caller", "dtmf", `Pressed ${key} — not mapped`);
    const phrase = "Press star to hear that again, or 0 for a merchandiser.";
    this.#say(call, phrase, "Explain the keypad once.");
    return { ok: false, reason: "unmapped_digit", phrase };
  }

  pushTranscript(callId, role, text) {
    const call = this.get(callId);
    if (!call || !text) return;
    call.transcript.push({ role, text, at: this.now() });
    this.audit.recordTranscript?.(callId, role, text);
    this.#publish(call, "transcript", { role, text });
  }

  checkBudget(callId) {
    const call = this.get(callId);
    return !call || !this.#budgetExpired(call) ? { ok: true } : this.#expire(call);
  }

  endCall(callId, reason = "caller_ended") {
    const call = this.get(callId);
    if (!call || TERMINAL.has(call.state)) return { ok: true };
    if (reason !== "caller_hung_up") this.#say(call, GOODBYE, "Close politely, then stop.");
    this.#finish(call, STATES.ENDED, reason);
    return { ok: true, ending: true };
  }

  settled(callId) {
    return Promise.resolve(this.get(callId)?.dispatchPromise).then(() => this.snapshot(callId));
  }

  /**
   * What the merchandiser sees before answering. `sessionId`, `callTopic`, `callContext`, `locationId`
   * and `reason` become VoIP headers; the rest is for the console. Never a Teams object id.
   */
  handoffContext(call, destination = call.pendingTransfer) {
    const loc = destination?.location ?? this.priceBook.locations.get(call.lastLocationId);
    const reason = destination?.reason ?? null;
    const commodity = destination?.commodity ?? call.lastQuote?.commodity ?? null;
    const quote = call.lastQuote;
    const callerWords = call.transcript
      .filter((t) => t.role === "caller" && !FILLER.test(String(t.text).trim()))
      .slice(-3)
      .map((t) => clip(t.text, 160));
    const reasonLabel = REASON_LABELS[reason] ?? reason ?? "Merchandiser request";
    // The caller's own punctuation ends the sentence: “…call me back.” not “…call me back.”.
    const said = callerWords.map((w) => `“${w}”`).join(", then ");
    const parts = [
      quote
        ? `Last quote: ${quote.phrase}`
        : `No price quoted${commodity ? ` (asked about ${commodity}${loc ? ` at ${loc.displayName}` : ""})` : ""}.`,
      callerWords.length ? `Caller said: ${said}${/[.?!…]$/.test(callerWords.at(-1)) ? "" : "."}` : null,
      `Reason: ${reasonLabel}.`,
    ].filter(Boolean);
    return {
      sessionId: call.sessionId ?? call.id,
      callTopic: this.#topic(reason, commodity, loc?.displayName),
      callContext: clip(parts.join(" "), CONTEXT_LIMIT),
      locationId: loc?.id ?? call.lastLocationId ?? null,
      reason,
      locationName: loc?.displayName ?? null,
      queue: loc?.merchandiser?.displayName ?? null,
      reasonLabel,
      commodity,
      callerWords,
      maskedPhone: call.maskedPhone,
      lastQuote: quote
        ? { phrase: quote.phrase, commodity: quote.commodity, locationName: quote.locationName, deliveryMonth: quote.deliveryMonth, cashBid: quote.cashBid, freshness: quote.freshness, asOfLocal: quote.asOfLocal }
        : null,
    };
  }

  snapshot(callId) {
    const call = this.get(callId);
    if (!call) return null;
    const p = call.pending;
    return {
      id: call.id,
      state: call.state,
      simulated: call.simulated,
      maskedPhone: call.maskedPhone,
      arrival: call.arrival,
      disclaimerSpoken: call.disclaimerSpoken,
      lastLocationId: call.lastLocationId,
      lastQuote: call.lastQuote,
      lastPhrase: call.lastPhrase,
      pending: p
        ? { kind: p.kind, reason: p.reason, candidates: p.candidates ?? null, callback: p.callback ?? null, commodity: p.commodity ?? null, locationId: p.locationId ?? p.location ?? null }
        : null,
      clarifications: call.clarifications,
      quotes: call.quotes,
      decision: call.decision,
      callback: call.callback,
      outcome: call.outcome,
      elapsedMs: (call.endedAt ?? this.now()) - call.startedAt,
      // A simulated call is not held to the cap (see #budgetExpired), so it has no budget to show.
      budgetMs: call.simulated ? null : this.options.callTimeBudgetMs,
      transcript: call.transcript,
      handoff: call.pendingTransfer ? this.handoffContext(call) : null,
    };
  }

  recordAgentAction(callId, { tool, ok = true, detail = null }) {
    const c = this.get(callId);
    if (c) this.#event(c, "agent", ok ? "tool" : "tool_rejected", detail ? `${tool}: ${detail}` : tool);
  }

  #settleQuote(call, result, { kind, month }) {
    if (result.clarify) return this.#clarify(call, result, { kind, month });
    const request = {
      kind,
      commodity: result.commodity ?? null,
      location: kind === "quote" ? result.locationId ?? null : null,
      month: kind === "quote" ? result.delivery ?? month : month,
    };
    if (!result.ok) {
      if (result.reason === "feed_unavailable" || result.reason === "missing_futures") {
        call.lastRequest = request;
        return this.#feedDown(call, result);
      }
      call.pending = null;
      this.#decide(call, "no_quote", result.reason, result.message);
      this.#say(call, `${result.message} Anything else?`, "Read this fixed phrase. Do not make up a price.");
      this.#setState(call, STATES.LISTENING);
      return result;
    }
    call.lastRequest = request;
    return kind === "list" ? this.#listed(call, result) : this.#quoted(call, result);
  }

  #clarify(call, result, { kind = "quote", month = null } = {}) {
    call.clarifications += 1;
    const commodityProblem = result.reason === "unknown_commodity" || result.reason === "missing_commodity";
    const locationProblem = ["ambiguous", "unknown_location", "missing_location"].includes(result.reason);
    call.pending = {
      kind,
      reason: result.reason,
      commodity: commodityProblem ? null : result.commodity ?? null,
      location: locationProblem ? null : result.locationId ?? null,
      month: result.reason === "unposted_month" ? null : month,
      candidates: result.candidates ?? null,
      suggestMonth: result.reason === "unposted_month" && result.months?.length === 1 ? result.months[0] : null,
    };
    call.lastQuestion = result.message;
    const detail = clarifyDetail(result);
    this.#event(call, "system", "clarification", detail);
    this.#decide(call, "clarify", result.reason, detail, { candidates: result.candidates ?? null, question: result.message });
    this.#say(call, result.message, "Ask exactly this one question. Do not quote a price or guess.");
    this.#setState(call, STATES.LISTENING);
    return result;
  }

  #quoted(call, result) {
    call.pending = null;
    call.lastLocationId = result.locationId;
    call.lastQuote = result;
    call.lastPhrase = `${result.phrase} Anything else?`;
    call.quotes += 1;
    this.audit.recordQuote(call.id, result);
    this.audit.updateCall(call.id, { lastLocationId: call.lastLocationId, lastQuote: result.phrase });
    this.#event(call, "system", "quote", quoteLabel(result));
    this.#freshnessEvent(call, result);
    this.#decide(call, "quote", result.freshness, result.freshnessWhy);
    this.#say(call, call.lastPhrase, "Read the phrase verbatim. Do not add or change numbers.");
    this.#setState(call, STATES.LISTENING);
    return result;
  }

  #listed(call, result) {
    call.pending = null;
    const top = result.quotes[0] ?? null;
    call.lastQuote = top;
    call.lastLocationId = top?.locationId ?? call.lastLocationId;
    call.lastPhrase = `${result.phrase} Anything else?`;
    call.quotes += result.quotes.length;
    for (const quote of result.quotes) this.audit.recordQuote(call.id, quote);
    this.#event(call, "system", "quote", `${capitalize(result.commodity)} · all locations — top ${result.quotes.length}, highest first`);
    if (top) this.#freshnessEvent(call, top);
    this.#decide(call, "quote", top?.freshness ?? null, top?.freshnessWhy ?? null, {
      list: result.quotes.map((q) => ({ locationName: q.locationName, deliveryMonth: q.deliveryMonth, cashBid: q.cashBid })),
    });
    this.#say(call, call.lastPhrase, "Read these fixed phrases verbatim, in order.");
    this.#setState(call, STATES.LISTENING);
    return result;
  }

  #freshnessEvent(call, quote) {
    if (quote.freshness === "delayed") this.#event(call, "system", "stale_caveat", quote.freshnessWhy);
    else if (quote.freshness === "close") this.#event(call, "system", "close_price", quote.freshnessWhy);
  }

  /** Ask the feed again before repeating a price; say the new phrase if its freshness (or number) changed. */
  #recheck(call) {
    const req = call.lastRequest;
    const before = call.lastQuote;
    this.#setState(call, STATES.QUOTING);
    const result = req.kind === "list"
      ? this.priceBook.list({ commodity: req.commodity, month: req.month })
      : this.priceBook.quote({ commodity: req.commodity, location: req.location, month: req.month });
    if (!result.ok) return this.#settleQuote(call, result, { kind: req.kind, month: req.month });
    if (`${result.phrase} Anything else?` === call.lastPhrase) {
      call.pending = null;
      this.#say(call, call.lastPhrase, "Repeat the last server phrase verbatim.");
      this.#setState(call, STATES.LISTENING);
      return { ok: true, phrase: call.lastPhrase, repeated: true };
    }
    const fresh = req.kind === "list" ? result.quotes[0] : result;
    const change = before && fresh && before.freshness !== fresh.freshness ? `${before.freshness} → ${fresh.freshness}` : "the price changed";
    this.#event(call, "system", "requoted", `Re-checked before repeating — ${change}`);
    return req.kind === "list" ? this.#listed(call, result) : this.#quoted(call, result);
  }

  #feedDown(call, result) {
    const directory = this.priceBook.locations;
    const loc = directory.get(result.locationId ?? call.lastLocationId) ?? null;
    this.#event(call, "system", "feed_outage", "Price feed unavailable — no number quoted");
    const lead = "Pricing data is unavailable right now, so I can't give you a price.";
    if (loc && !directory.isMerchandiserOpen(loc.id, this.#businessNow())) {
      const phrase = `${lead} ${directory.hoursPhrase(loc.id)} Please call back during those hours. Goodbye.`;
      this.#decide(call, "feed_down", result.reason, `The price feed is unavailable and the ${loc.displayName} merchandiser is closed — no number quoted.`);
      this.#say(call, phrase, "After hours: no price and no transfer; close politely.");
      this.#finish(call, STATES.ENDED, "closed_after_hours:feed_outage");
      return { ok: true, action: "closed", afterHours: true, phrase, reason: result.reason };
    }
    const who = loc ? `the ${loc.displayName} merchandiser` : "a merchandiser";
    const canCallBack = Boolean(call.fromPhone);
    const phrase = canCallBack
      ? `${lead} I can connect you with ${who} now, or have them call you back. Which would you like?`
      : `${lead} I can connect you with ${who} now. Would you like that?`;
    call.pending = { kind: "offer", reason: "feed_outage", locationId: loc?.id ?? null, commodity: result.commodity ?? null, callback: canCallBack, accept: "transfer" };
    call.lastQuestion = phrase;
    this.#event(call, "system", "person_offered", canCallBack ? `Offered ${who} now, or a callback` : `Offered ${who} now`);
    this.#decide(call, "feed_down", result.reason, "The price feed is unavailable, so no number was quoted.");
    this.#say(call, phrase, "Say this, then wait. A person: transfer_to_merchandiser. A callback: request_callback. Never give a price.");
    this.#setState(call, STATES.LISTENING);
    return { ok: false, reason: result.reason, action: "offer", message: phrase, locationId: loc?.id ?? null, locationName: loc?.displayName ?? null, commodity: result.commodity ?? null, callback: canCallBack };
  }

  #transferFailed(call, destination, error) {
    if (TERMINAL.has(call.state)) return { ok: false, reason: "transfer_failed" };
    const loc = destination.location;
    call.pendingTransfer = null;
    this.#event(call, "system", "transfer_failed", clip(error?.message ?? "The transfer request failed", 200));
    this.#setState(call, STATES.LISTENING);
    if (call.fromPhone) {
      const phrase = `I couldn't reach the ${loc.displayName} merchandiser. I can have them call you back at the number you're calling from. Would you like that?`;
      call.pending = { kind: "offer", reason: destination.reason, locationId: loc.id, commodity: destination.commodity ?? null, callback: true, accept: "callback" };
      call.lastQuestion = phrase;
      this.#decide(call, "transfer_failed", destination.reason, "The transfer did not go through, so the agent offers a callback.");
      this.#say(call, phrase, "Offer the callback once. If they agree, call request_callback.");
      return { ok: false, reason: "transfer_failed", action: "offer", message: phrase };
    }
    const phrase = `I couldn't reach the ${loc.displayName} merchandiser. ${this.priceBook.locations.hoursPhrase(loc.id)} Please call back during those hours. ${GOODBYE}`;
    this.#decide(call, "transfer_failed", destination.reason, "The transfer did not go through and there is no caller ID for a callback.");
    this.#say(call, phrase, "Apologize once and close.");
    this.#finish(call, STATES.ENDED, `transfer_failed:${destination.reason}`);
    return { ok: false, reason: "transfer_failed", ending: true, message: phrase };
  }

  #topic(reason, commodity, locationName) {
    const where = locationName ?? "location";
    const what = commodity ?? "grain";
    const full = {
      sell_request: `Sell ${what} – ${where}`,
      contract_request: `Lock a price: ${what} – ${where}`,
      feed_outage: `Price feed down: ${what} – ${where}`,
      dtmf_0: `Pressed 0 for a merchandiser – ${where}`,
    }[reason] ?? `Merchandiser request: ${what} – ${where}`;
    return full.length <= TOPIC_LIMIT ? full : clip(full.replace(`${what} – `, ""), TOPIC_LIMIT);
  }

  #require(id) {
    const c = this.get(id);
    if (!c) throw new Error(`unknown call ${id}`);
    return c;
  }
  /** The call, or null when it is unknown or already over: nothing may speak on a finished call. */
  #active(id) {
    const c = this.get(id);
    return c && !TERMINAL.has(c.state) ? c : null;
  }
  /**
   * The call cap. A simulated call is exempt: between its lines the presenter is talking to the room, and
   * that is not time the caller spent on the line.
   */
  #budgetExpired(call) {
    if (call.simulated || call.answeredAt == null || TERMINAL.has(call.state)) return false;
    return this.now() - call.answeredAt >= this.options.callTimeBudgetMs;
  }
  /** The time the policy runs on: market hours, freshness, merchandiser hours. The demo clock, when one is set. */
  #businessNow() {
    const at = this.priceBook.now?.();
    return at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date(this.now());
  }
  #expire(call) {
    this.#event(call, "system", "budget_expired", `Call reached its ${Math.round(this.options.callTimeBudgetMs / 1000)}-second budget`);
    return this.endCall(call.id, "time_budget_expired");
  }
  #finish(call, state, outcome, extra = {}) {
    call.outcome = outcome;
    call.endedAt = this.now();
    call.pending = null;
    this.#setState(call, state);
    this.audit.updateCall(call.id, { outcome, endedAt: new Date(call.endedAt).toISOString(), durationMs: call.endedAt - call.startedAt, ...extra });
  }
  #decide(call, kind, reason, detail, extra = {}) {
    call.decision = { kind, reason: reason ?? null, detail: detail ?? null, at: this.#businessNow().toISOString(), ...extra };
    this.#publish(call, "state", this.snapshot(call.id));
  }
  #say(call, spoken, instruction) {
    this.agents.get(call.id)?.instruct?.(instruction, spoken);
    this.pushTranscript(call.id, "agent", spoken);
  }
  #setState(call, state) {
    if (call.state === state) return;
    const from = call.state;
    call.state = state;
    this.audit.updateCall(call.id, { state });
    this.#event(call, "system", "state", `${from} → ${state}`);
    this.#publish(call, "state", this.snapshot(call.id));
  }
  #event(call, source, kind, detail) {
    this.audit.recordEvent(call.id, source, kind, detail);
    this.#publish(call, "event", { source, kind, detail, at: this.#businessNow().toISOString() });
  }
  #publish(call, target, payload) { this.hub?.send?.(call.id, target, payload); }
}
