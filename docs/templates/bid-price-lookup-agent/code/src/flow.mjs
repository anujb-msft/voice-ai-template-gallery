import { randomUUID } from "node:crypto";
import { config } from "./config.mjs";

export const STATES = Object.freeze({ RINGING: "ringing", GREETING: "greeting", LISTENING: "listening", QUOTING: "quoting", TRANSFERRING: "transferring", TRANSFERRED: "transferred", CLOSING: "closing", ENDED: "ended" });
const TERMINAL = new Set([STATES.TRANSFERRED, STATES.ENDED]);
const TOPIC_LIMIT = 48;
const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function maskPhone(phone) {
  if (!phone) return "anonymous";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length <= 2) return "•".repeat(digits.length) || "anonymous";
  return `${String(phone).trim().startsWith("+") ? "+" : ""}${"•".repeat(digits.length - 2)}${digits.slice(-2)}`;
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

  create({ callId = randomUUID(), fromPhone = null, incomingCallContext = null, sessionId = null, resourceAccountId = null } = {}) {
    const call = {
      id: callId, fromPhone, maskedPhone: maskPhone(fromPhone), incomingCallContext, sessionId, resourceAccountId,
      arrival: resourceAccountId ? "teams-phone-extensibility" : "acs-direct", callConnectionId: null, state: STATES.RINGING,
      disclaimerSpoken: false, lastLocationId: null, lastQuote: null, lastPhrase: null, noInputs: 0, outcome: null,
      startedAt: this.now(), answeredAt: null, endedAt: null, transcript: [], pendingTransfer: null,
    };
    this.calls.set(call.id, call);
    this.audit.startCall({ id: call.id, maskedPhone: call.maskedPhone, state: call.state, startedAt: new Date(call.startedAt).toISOString() });
    this.#event(call, "system", "call_created", call.arrival);
    return call;
  }

  get(callId) { return this.calls.get(callId) ?? null; }
  registerAgent(callId, handle) { this.agents.set(callId, handle); }
  unregisterAgent(callId) { this.agents.delete(callId); }
  setCallConnection(callId, callConnectionId) { const c = this.get(callId); if (c) c.callConnectionId = callConnectionId; }

  answered(callId) {
    const call = this.#require(callId);
    call.answeredAt = this.now();
    this.#setState(call, STATES.GREETING);
    const greeting = "Contoso Grain Co-op bid line. I'm an automated assistant. Bids are subject to change without notice. Confirm with the merchandiser before selling. Which commodity and location?";
    call.disclaimerSpoken = true;
    this.#speak(call, greeting, "Open with exactly this disclosure and disclaimer, then ask for commodity and location.");
    this.#setState(call, STATES.LISTENING);
    return call;
  }

  getBid(callId, { commodity, location = null, month = null } = {}) {
    const call = this.#active(callId);
    if (this.#budgetExpired(call)) return this.#expire(call);
    this.#setState(call, STATES.QUOTING);
    const result = this.priceBook.quote({ commodity, location, month, lastLocationId: call.lastLocationId });
    if (result.ambiguous) {
      this.#speak(call, result.message, "Ask the caller to choose one of these locations; do not quote yet.");
      this.#setState(call, STATES.LISTENING);
      return result;
    }
    if (!result.ok) {
      if (result.reason === "feed_unavailable") {
        this.#event(call, "system", "feed_outage", result.error ?? "unavailable");
        this.#setState(call, STATES.LISTENING);
        return this.transferToMerchandiser(callId, { location: location ?? call.lastLocationId, reason: "feed_outage" });
      }
      this.#speak(call, `${result.message} Anything else?`, "Read this fixed error phrase; do not make up prices.");
      this.#setState(call, STATES.LISTENING);
      return result;
    }
    call.lastLocationId = result.locationId;
    call.lastQuote = result;
    call.lastPhrase = `${result.phrase} Anything else?`;
    this.audit.recordQuote(call.id, result);
    this.audit.updateCall(call.id, { lastLocationId: call.lastLocationId, lastQuote: result.phrase });
    this.#speak(call, call.lastPhrase, "Read the phrase verbatim. Do not add or change numbers.");
    this.#setState(call, STATES.LISTENING);
    return result;
  }

  listBids(callId, { commodity, month = null } = {}) {
    const call = this.#active(callId);
    if (this.#budgetExpired(call)) return this.#expire(call);
    this.#setState(call, STATES.QUOTING);
    const result = this.priceBook.list({ commodity, month });
    if (!result.ok) {
      if (result.reason === "feed_unavailable") {
        this.#event(call, "system", "feed_outage", result.error ?? "unavailable");
        this.#setState(call, STATES.LISTENING);
        return this.transferToMerchandiser(callId, { location: call.lastLocationId, reason: "feed_outage" });
      }
      this.#speak(call, `${result.message} Anything else?`, "Read this fixed error phrase.");
      this.#setState(call, STATES.LISTENING);
      return result;
    }
    for (const quote of result.quotes) this.audit.recordQuote(call.id, quote);
    call.lastPhrase = `${result.phrase} Anything else?`;
    call.lastQuote = result.quotes[0] ?? null;
    call.lastLocationId = result.quotes[0]?.locationId ?? call.lastLocationId;
    this.#speak(call, call.lastPhrase, "Read these fixed phrases verbatim in order.");
    this.#setState(call, STATES.LISTENING);
    return result;
  }

  transferToMerchandiser(callId, { location = null, reason = "caller_requested" } = {}) {
    const call = this.#active(callId);
    const locMatch = this.priceBook.locations.match(location, { lastLocationId: call.lastLocationId });
    if (!locMatch.ok) {
      const message = locMatch.ambiguous ? `Did you mean ${locMatch.candidates.map((l) => l.displayName).join(" or ")}?` : "Which location should I connect you with?";
      this.#speak(call, message, "Ask which location to use for transfer.");
      return { ok: false, reason: locMatch.reason, message };
    }
    const loc = locMatch.location;
    call.lastLocationId = loc.id;
    if (!this.priceBook.locations.isMerchandiserOpen(loc.id, new Date(this.now()))) {
      const phrase = `${this.priceBook.locations.hoursPhrase(loc.id)} Please call back during those hours. Goodbye.`;
      this.#speak(call, phrase, "After hours: do not transfer; close politely.");
      this.#finish(call, STATES.ENDED, `closed_after_hours:${reason}`);
      return { ok: true, action: "closed", afterHours: true, phrase };
    }
    this.#setState(call, STATES.TRANSFERRING);
    const phrase = `Connecting you with the ${loc.displayName} merchandiser now`;
    this.#speak(call, phrase, "Say this once, then stop talking while the blind transfer starts.");
    call.pendingTransfer = { target: loc.merchandiser, location: loc, reason };
    call.dispatchPromise = this.dispatchTransfer(call.id);
    return { ok: true, action: "transfer", locationId: loc.id, reason };
  }

  async dispatchTransfer(callId) {
    const call = this.#require(callId);
    if (!call.pendingTransfer || TERMINAL.has(call.state)) return { ok: false, reason: "nothing_to_transfer" };
    const destination = call.pendingTransfer;
    const context = this.handoffContext(call, destination);
    this.#event(call, "system", "transfer_started", destination.reason);
    if (!this.transfer) {
      this.#event(call, "system", "transfer_simulated", destination.location.id);
      this.#publish(call, "handoff", context);
      this.#finish(call, STATES.TRANSFERRED, `transferred:${destination.reason}`, { simulated: true });
      return { ok: true, simulated: true, context };
    }
    await this.transfer(call, { target: destination.target, context, reason: destination.reason });
    this.#event(call, "system", "transfer_succeeded", destination.location.id);
    this.#publish(call, "handoff", context);
    this.#finish(call, STATES.TRANSFERRED, `transferred:${destination.reason}`);
    return { ok: true, context };
  }

  repeatLast(callId) {
    const call = this.#active(callId);
    if (!call.lastPhrase) return this.noInput(callId);
    this.#speak(call, call.lastPhrase, "Repeat the last server phrase verbatim.");
    return { ok: true, phrase: call.lastPhrase };
  }

  noInput(callId) {
    const call = this.#active(callId);
    call.noInputs += 1;
    this.#event(call, "caller", "no_input", String(call.noInputs));
    if (call.noInputs >= this.options.maxNoInputs) return this.endCall(callId, "no_input");
    const phrase = "Sorry, I didn't catch that. Please say the commodity and location, or press 0 for a merchandiser.";
    this.#speak(call, phrase, "One no-input reprompt.");
    return { ok: true, reprompt: true };
  }

  dtmf(callId, digit) {
    if (String(digit) === "*") return this.repeatLast(callId);
    if (String(digit) === "0") return this.transferToMerchandiser(callId, { reason: "dtmf_0" });
    return { ok: false, reason: "unmapped_digit" };
  }

  adviceBoundary(callId) {
    const call = this.#active(callId);
    const phrase = "I can't advise on that, but the merchandiser can talk it through with you.";
    this.#speak(call, phrase, "Do not advise, predict, or compare markets. Offer transfer only if asked.");
    return { ok: true, phrase };
  }

  pushTranscript(callId, role, text) {
    const call = this.get(callId);
    if (!call || !text) return;
    call.transcript.push({ role, text, at: this.now() });
    this.audit.recordTranscript?.(callId, role, text);
    this.#publish(call, "transcript", { role, text });
  }

  checkBudget(callId) { const call = this.get(callId); return !call || !this.#budgetExpired(call) ? { ok: true } : this.#expire(call); }
  endCall(callId, reason = "caller_ended") { const call = this.get(callId); if (!call || TERMINAL.has(call.state)) return { ok: true }; this.#speak(call, "Thanks for calling Contoso Grain Co-op. Goodbye.", "Close politely."); this.#finish(call, STATES.ENDED, reason); return { ok: true, ending: true }; }
  settled(callId) { return Promise.resolve(this.get(callId)?.dispatchPromise).then(() => this.snapshot(callId)); }

  handoffContext(call, destination = call.pendingTransfer) {
    const loc = destination?.location;
    const quote = call.lastQuote;
    return {
      sessionId: call.sessionId ?? call.id,
      callTopic: clip(`${destination?.reason === "feed_outage" ? "Bid feed issue" : "Sell"}${quote?.commodity ? ` ${quote.commodity}` : " grain"} – ${loc?.displayName ?? "location"}`, TOPIC_LIMIT),
      callContext: clip([quote?.phrase ? `Last quote: ${quote.phrase}` : null, `Reason: ${destination?.reason ?? "unknown"}`].filter(Boolean).join(" "), 1024),
      locationId: loc?.id ?? call.lastLocationId,
      reason: destination?.reason ?? null,
    };
  }

  snapshot(callId) {
    const call = this.get(callId);
    if (!call) return null;
    return { id: call.id, state: call.state, maskedPhone: call.maskedPhone, arrival: call.arrival, disclaimerSpoken: call.disclaimerSpoken, lastLocationId: call.lastLocationId, lastQuote: call.lastQuote, lastPhrase: call.lastPhrase, outcome: call.outcome, elapsedMs: (call.endedAt ?? this.now()) - call.startedAt, budgetMs: this.options.callTimeBudgetMs, transcript: call.transcript, handoff: call.pendingTransfer ? this.handoffContext(call) : null };
  }

  recordAgentAction(callId, { tool, ok = true, detail = null }) { const c = this.get(callId); if (c) this.#event(c, "agent", ok ? "tool" : "tool_rejected", detail ? `${tool}: ${detail}` : tool); }
  #require(id) { const c = this.get(id); if (!c) throw new Error(`unknown call ${id}`); return c; }
  #active(id) { const c = this.#require(id); if (TERMINAL.has(c.state)) return c; return c; }
  #budgetExpired(call) { return call.answeredAt != null && !TERMINAL.has(call.state) && this.now() - call.answeredAt >= this.options.callTimeBudgetMs; }
  #expire(call) { this.#event(call, "system", "budget_expired", `${this.options.callTimeBudgetMs}ms`); return this.endCall(call.id, "time_budget_expired"); }
  #finish(call, state, outcome, extra = {}) { call.outcome = outcome; call.endedAt = this.now(); this.#setState(call, state); this.audit.updateCall(call.id, { outcome, endedAt: new Date(call.endedAt).toISOString(), durationMs: call.endedAt - call.startedAt, ...extra }); }
  #speak(call, spoken, instruction) { this.agents.get(call.id)?.instruct?.(instruction, spoken); this.pushTranscript(call.id, "agent", spoken); }
  #setState(call, state) { if (call.state === state) return; const from = call.state; call.state = state; this.audit.updateCall(call.id, { state }); this.#event(call, "system", "state", `${from} → ${state}`); this.#publish(call, "state", this.snapshot(call.id)); }
  #event(call, source, kind, detail) { this.audit.recordEvent(call.id, source, kind, detail); this.#publish(call, "event", { source, kind, detail, at: new Date(this.now()).toISOString() }); }
  #publish(call, target, payload) { this.hub?.send?.(call.id, target, payload); }
}
