// The call flow. It owns every decision the caller can't talk the model out of:
// whether sales is open, when a lead is complete enough to save, who gets it,
// whether the on-call rep is paged, and what the rep sees in Teams. The voice
// agent (or the offline simulator) collects what the caller says and speaks the
// lines this flow gives it.
import { randomUUID } from "node:crypto";
import { config } from "./config.mjs";
import { classifyUrgency, decidePage, maskPhone, normaliseEmail, normalisePhone, phoneGroups } from "./policy.mjs";

export const STATES = Object.freeze({
  RINGING: "ringing",
  ROUTING: "routing",
  TRANSFERRING: "transferring",
  TRANSFERRED: "transferred",
  GREETING: "greeting",
  DISCOVERY: "discovery",
  QUALIFYING: "qualifying",
  CONFIRMING: "confirming",
  SAVING: "saving",
  PAGING: "paging",
  CLOSING: "closing",
  ENDED: "ended",
});

const TERMINAL = new Set([STATES.TRANSFERRED, STATES.ENDED]);
// States the flow itself is driving: a field update must not move the call back to QUALIFYING.
const HOLD = new Set([STATES.CONFIRMING, STATES.SAVING, STATES.PAGING, STATES.CLOSING, STATES.TRANSFERRING]);
const CONVERSING = new Set([STATES.GREETING, STATES.DISCOVERY, STATES.QUALIFYING, STATES.CONFIRMING]);
const HANDING_OFF = new Set([STATES.PAGING, STATES.TRANSFERRING]);

const TOPIC_LIMIT = 48;
const CONTEXT_LIMIT = 400;
const FIELD_LIMIT = 300;
const NOTES_LIMIT = 1200;
const DRAFT_KEYS = ["name", "company", "callbackPhone", "phoneConfirmed", "email", "emailConfirmed", "productInterest", "quantity", "timeline", "role", "location", "notes"];
export const NON_SALES_KINDS = Object.freeze(["existing-customer", "spam", "emergency", "job-seeker"]);
const PAGE_UNANSWERED = "The page was not answered, so this lead waits for the morning.";

const clip = (value, limit) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length <= limit ? s : `${s.slice(0, limit - 1).trimEnd()}…`;
};
const firstName = (name) => (name ? String(name).trim().split(/\s+/)[0] : null);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const appendNote = (existing, note) => [existing, note].filter(Boolean).join(" ");
const fmt = (n) => Number(n).toLocaleString("en-US");

// Live prompts are appended to the standing instructions, so each one says what
// to do now and then hands back to them; otherwise the model repeats the line.
const step = (what) => `Next step: ${what} Then carry on as described above.`;
const sayStep = (spoken) => step(`say this to the caller in your own words, keeping every fact: "${spoken}"`);
const finalStep = (spoken) =>
  `Final step: say this to the caller in your own words, keeping every fact: "${spoken}" Then say goodbye. Don't ask anything else and don't call any tools; the call ends after you speak.`;

export class LeadCaptureFlow {
  /**
   * `transfer(call, { target, context })` performs the real Teams transfer; leave
   * it null (or mark the call simulated) to simulate it. `options.pageWindowMs`
   * is how long the caller waits on the line before the page connects.
   */
  constructor({ hours, catalog, store, transfer = null, hub = null, now = () => new Date(), reps = null, qualification = null, options = {} }) {
    this.hours = hours;
    this.catalog = catalog;
    this.store = store;
    this.reps = reps ?? store.reps;
    this.qualification = qualification ?? store.qualification;
    this.transfer = transfer;
    this.hub = hub;
    this.now = () => new Date(now());
    this.options = { callTimeBudgetMs: config.callTimeBudgetMs, maxNoInputs: 2, ...options };
    this.options.pageWindowMs = Math.max(0, Number(options.pageWindowMs ?? 0) || 0);
    this.calls = new Map();
    this.agents = new Map();
  }

  // ------------------------------------------------------------------ lifecycle

  create({ callId = randomUUID(), fromPhone = null, incomingCallContext = null, sessionId = null, overflow = false, resourceAccountId = null, simulated = false } = {}) {
    const phone = normalisePhone(fromPhone);
    const call = {
      id: callId,
      fromPhone: phone,
      maskedPhone: maskPhone(phone),
      incomingCallContext,
      sessionId: sessionId ?? callId,
      resourceAccountId,
      overflow: Boolean(overflow),
      simulated: Boolean(simulated),
      callConnectionId: null,
      state: STATES.RINGING,
      startedAt: this.now().toISOString(),
      answeredAt: null,
      endedAt: null,
      durationMs: null,
      outcome: null,
      draft: { callbackPhone: phone, phoneConfirmed: Boolean(phone), emailConfirmed: false, notes: "" },
      noInputs: 0,
      transcript: [],
      savedLead: null,
      nonSales: null,
      routeDecision: null,
      followUp: null,
      transferKind: null,
      onCallRep: null,
      page: null,
      pageDecision: null,
      pageTimer: null,
      pageStartedAtMs: null,
      askedForPerson: false,
      urgency: null,
      conversational: false,
      lastQuestion: null,
      messages: [],
      dispatched: false,
      dispatchPromise: null,
    };
    this.calls.set(call.id, call);
    this.store.startCall({ id: call.id, state: call.state, maskedPhone: call.maskedPhone, startedAt: call.startedAt, simulated: call.simulated });
    this.#event(call, "system", "call_created", call.maskedPhone);
    return call;
  }

  get(id) {
    return this.calls.get(id) ?? null;
  }

  /** The live bridge or the simulator registers `{ instruct, nudge, end? }` for a call. */
  registerAgent(id, handle) {
    this.agents.set(id, handle);
  }

  unregisterAgent(id) {
    this.agents.delete(id);
  }

  setCallConnection(id, callConnectionId) {
    const call = this.get(id);
    if (call) call.callConnectionId = callConnectionId;
  }

  /** Decides once, from the clock and the queue, whether the call goes to sales or to capture. */
  planRoute(id) {
    const call = this.#require(id);
    if (call.routeDecision) return call.routeDecision;
    const now = this.now();
    const open = this.hours.isSalesOpen(now);
    const holiday = this.hours.isHoliday(now);
    const opening = this.hours.openingPhrase(now);
    let action = "capture";
    let reason;
    if (open && !call.overflow) {
      action = "transfer";
      reason = "Sales is open, so the caller goes straight to the sales queue";
    } else if (open) {
      reason = "The sales queue is full, so the assistant takes the details";
    } else if (!opening) {
      reason = "Sales is closed, so the assistant takes the details";
    } else if (holiday) {
      reason = `Sales is closed for the holiday until ${opening}, so the assistant takes the details`;
    } else {
      reason = `Sales is closed until ${opening}, so the assistant takes the details`;
    }
    call.routeDecision = { open, holiday, overflow: call.overflow, action, reason, opening, at: now.toISOString() };
    this.#event(call, "system", "route_decision", reason);
    return call.routeDecision;
  }

  /**
   * Sends an in-hours caller straight to the sales queue, or starts capture.
   * Live calls pass `answer: false` and let the media bridge call `answered`
   * once Voice Live is connected.
   */
  routeIncoming(id, { answer = true } = {}) {
    const call = this.#require(id);
    const decision = this.planRoute(id);
    this.#setState(call, STATES.ROUTING);
    if (decision.action === "transfer") return this.#transferToSales(call);
    this.#setState(call, STATES.GREETING);
    if (answer) this.answered(id);
    return { ok: true, action: "capture", reason: decision.reason };
  }

  answered(id) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return call;
    call.answeredAt = this.now().toISOString();
    this.#setState(call, STATES.DISCOVERY);
    const org = this.hours.organization ?? "our company";
    const busy = call.overflow && this.hours.isSalesOpen(this.now());
    const unavailable = busy ? "Everyone on our sales team is with other callers right now" : "Our sales team isn't available right now";
    const question = "What are you looking for today?";
    call.lastQuestion = question;
    this.#say(
      call,
      `Thanks for calling ${org}. I'm an automated assistant. ${unavailable}, but I can take your details and have the right person call you back. ${question}`,
      step(`greet the caller. Say you are an automated assistant for ${org}, that ${busy ? "everyone on the sales team is with other callers" : "the sales team isn't available right now"}, and that you can take their details so the right person calls them back. Then ask what they are looking for.`),
    );
    return call;
  }

  // ------------------------------------------------------------- conversation

  /** Speaks a line through the registered agent (live or simulated). */
  say(id, spoken, prompt = null) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    this.#say(call, spoken, prompt);
    return { ok: true };
  }

  /** Like `say`, and remembers the question so a reprompt can repeat it. */
  ask(id, spoken, { question = spoken, prompt = null } = {}) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    call.lastQuestion = question;
    this.#say(call, spoken, prompt);
    return { ok: true };
  }

  /** With an agent on the line, the caller-ID number counts only after it is read back. */
  expectReadBack(id) {
    const call = this.#require(id);
    if (call.draft.callbackPhone && !call.savedLead) call.draft.phoneConfirmed = false;
    return { ok: true };
  }

  awaitConfirmation(id) {
    const call = this.#require(id);
    if ([STATES.GREETING, STATES.DISCOVERY, STATES.QUALIFYING].includes(call.state)) this.#setState(call, STATES.CONFIRMING);
    return { ok: true };
  }

  /** Records an event from the agent or the simulator, such as a corrected callback number. */
  logEvent(id, source, kind, detail = null) {
    const call = this.#require(id);
    this.#event(call, source, kind, detail);
    return { ok: true };
  }

  /** Says a last line and ends a call that has nothing to save. */
  closeCall(id, line, outcome) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: true };
    if (HANDING_OFF.has(call.state)) return { ok: false, reason: "transfer_in_progress" };
    this.#closeWith(call, line, outcome);
    return { ok: true };
  }

  lookupCatalog(id, query) {
    const call = this.#require(id);
    const matches = this.catalog.lookup(query);
    this.#event(call, "agent", "lookup_catalog", clip(query, 80));
    return { ok: true, matches };
  }

  /** Merges whitelisted fields into the draft. Score and owner are never fields. */
  updateFields(id, patch = {}) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    const clean = sanitisePatch(patch);
    const before = { phone: call.draft.callbackPhone, email: call.draft.email };
    Object.assign(call.draft, clean);
    if (clean.callbackPhone !== undefined && clean.callbackPhone !== before.phone && clean.phoneConfirmed === undefined) call.draft.phoneConfirmed = false;
    if (clean.email !== undefined && clean.email !== before.email && clean.emailConfirmed === undefined) call.draft.emailConfirmed = false;
    if (!HOLD.has(call.state) && call.state !== STATES.QUALIFYING) this.#setState(call, STATES.QUALIFYING);
    else this.#publish(call, "state", this.snapshot(id));
    return { ok: true, draft: this.publicDraft(call) };
  }

  /** The caller asked for a person. Whether anyone is paged is decided at save time. */
  requestPerson(id, { source = "caller" } = {}) {
    const call = this.#require(id);
    if (!call.askedForPerson) {
      call.askedForPerson = true;
      this.#event(call, source === "agent" ? "agent" : "caller", "asked_for_person", source);
      this.#publish(call, "state", this.snapshot(id));
    }
    return { ok: true, askedForPerson: true, coverage: this.hours.onCallCoverage(this.now()) };
  }

  /** Keypad input. Only 0 ("a person, please") means anything, and only mid-conversation. */
  dtmf(id, digit) {
    const call = this.get(id);
    if (!call) return { ok: false, reason: "unknown_call" };
    const d = String(digit ?? "").trim();
    if (d !== "0" || !CONVERSING.has(call.state)) return { ok: true, ignored: true };
    this.#event(call, "caller", "dtmf", d);
    if (this.hours.isSalesOpen(this.now())) {
      this.#say(call, "Sure, I'll put you in the queue for the next available sales rep.");
      return this.#transferToSales(call);
    }
    this.requestPerson(id, { source: "keypad" });
    const question = call.lastQuestion ?? "What are you looking for today?";
    this.#say(
      call,
      `Got it, you'd like to speak with a person. Let me get a few details first, and then I'll check who's available. ${question}`,
      step(`the caller pressed 0 to reach a person. Say you'll take a few details first and then check who's available, then ask again: "${question}"`),
    );
    return { ok: true, askedForPerson: true };
  }

  // ------------------------------------------------------------------- saving

  /**
   * Saves the lead with the server's score and owner, then either pages the
   * on-call rep (the caller stays on the line) or closes the call with the
   * follow-up promise. The model sees only the lead id and the follow-up phrase.
   */
  saveLead(id, fields = {}, { partial = false, closing = null } = {}) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    if (call.savedLead) return { ok: false, reason: "already_saved" };
    const { wantsPerson, ...rest } = fields ?? {};
    if (wantsPerson === true || wantsPerson === "true") this.requestPerson(id, { source: "agent" });
    this.updateFields(id, rest);
    const draft = call.draft;
    const email = normaliseEmail(draft.email);
    const hasContact = Boolean(draft.callbackPhone || email);
    const confirmed = Boolean((draft.callbackPhone && draft.phoneConfirmed) || (email && draft.emailConfirmed));
    if (!partial && hasContact && !confirmed) {
      this.#event(call, "system", "save_refused", "contact_unconfirmed");
      this.#setState(call, STATES.CONFIRMING);
      return { ok: false, reason: "contact_unconfirmed", readBack: phoneGroups(draft.callbackPhone) ?? email };
    }
    if (partial && hasContact && !confirmed) {
      draft.notes = appendNote(draft.notes, draft.callbackPhone ? "Callback number was not read back." : "Email address was not read back.");
    }
    this.#setState(call, STATES.SAVING);

    // A partial save (silence or the time budget) never pages: there is no one left on the line.
    let urgency = null;
    let decision = null;
    let pageRep = null;
    if (!partial) {
      const score = this.qualification.score(draft).score;
      const callerLines = call.transcript.filter((t) => t.role === "caller").map((t) => t.text);
      urgency = classifyUrgency(callerLines, draft.timeline, draft.notes);
      const coverage = this.hours.onCallCoverage(this.now());
      const rep = coverage.repId ? this.reps.find(coverage.repId) : null;
      decision = decidePage({ score, urgent: urgency.urgent, askedForPerson: call.askedForPerson, coverage, repName: rep?.displayName ?? "the on-call rep" });
      if (decision.page && (!rep || rep.active === false)) {
        decision = { ...decision, page: false, code: "no_cover", reason: "The on-call rep isn't available, so it goes to the morning queue" };
      }
      if (decision.page) pageRep = rep;
    }
    let notice = null;
    if (decision?.page) notice = `Paged on call: ${decision.reason}.`;
    else if (decision && (decision.urgent || decision.askedForPerson)) notice = `Not paged: ${decision.reason}.`;

    const outboxBefore = this.store.listOutbox().length;
    const result = this.store.saveLead(draft, { callId: id, partial, simulated: call.simulated, assignTo: pageRep, notice });
    if (!result.ok) {
      this.#event(call, "system", "save_refused", result.reason);
      this.#setState(call, STATES.CONFIRMING);
      return result;
    }
    const lead = result.lead;
    call.savedLead = lead;
    call.urgency = urgency;
    call.pageDecision = decision;
    call.messages = this.store.listOutbox().slice(outboxBefore);
    call.followUp = {
      phrase: result.slaPhrase,
      dueAt: lead.slaDueAt,
      dueLabel: this.hours.dueLabel?.(lead.slaDueAt) ?? lead.slaDueAt,
      ownerName: lead.owner?.displayName ?? null,
      duplicateOf: result.duplicateOf,
      score: lead.score,
    };
    this.#event(call, "system", result.duplicateOf ? "lead_merged" : "lead_saved", lead.id);
    if (decision) this.#event(call, "system", "page_decision", `${decision.code}: ${decision.reason}`);
    const publicResult = { ok: true, leadId: lead.id, duplicateOf: result.duplicateOf, slaPhrase: result.slaPhrase };
    if (pageRep) {
      this.#startPage(call, pageRep);
      return { ...publicResult, stayOnLine: true };
    }
    this.#setState(call, STATES.CLOSING);
    const line = closing ?? this.#closingLine(call, { partial, decision });
    this.#say(call, line, finalStep(line));
    this.endCall(id, result.duplicateOf ? "duplicate_merged" : "lead_captured");
    return publicResult;
  }

  classifyNonSales(id, kind, note = "") {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    if (HANDING_OFF.has(call.state)) return { ok: false, reason: "transfer_in_progress" };
    const clean = NON_SALES_KINDS.includes(kind) ? kind : "existing-customer";
    call.nonSales = { kind: clean, note: clip(note, FIELD_LIMIT) };
    this.store.saveNonSales({ callId: id, kind: clean, note: call.nonSales.note });
    this.#event(call, "system", "non_sales", clean);
    this.#setState(call, STATES.CLOSING);
    const text = this.#nonSalesLine(clean);
    this.#say(call, text, finalStep(text));
    this.endCall(id, `non-sales:${clean}`);
    return { ok: true, kind: clean, text };
  }

  // ------------------------------------------------------- silence and budget

  noInput(id) {
    const call = this.get(id);
    if (!call || TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    if (this.#budgetExpired(call)) return this.expire(id);
    if (HANDING_OFF.has(call.state)) return { ok: true, ignored: true };
    call.noInputs += 1;
    this.#event(call, "caller", "no_input", call.noInputs);
    if (call.noInputs > this.options.maxNoInputs) {
      const result = this.saveLead(
        id,
        { notes: appendNote(call.draft.notes, "Caller stopped responding; saved partial lead.") },
        { partial: true, closing: "I still can't hear you, so I've saved what I have and someone from our sales team will follow up. Goodbye." },
      );
      if (result.ok) return result;
      this.#closeWith(call, "I still can't hear you, so I'll end the call now. Please call us back anytime. Goodbye.", "no_input");
      return { ok: true, ended: true, reason: result.reason };
    }
    const question = call.lastQuestion ?? "What product are you looking for, and how can our sales team reach you?";
    this.#say(call, `Sorry, I didn't catch that. ${question}`, step(`you didn't hear the caller. Apologize briefly and ask again: "${question}"`));
    return { ok: true, reprompt: true, attempt: call.noInputs };
  }

  /** Enforces the per-call time budget. Safe to call on a timer; it fires once. */
  checkBudget(id) {
    const call = this.get(id);
    if (!call || TERMINAL.has(call.state)) return { ok: true };
    if (this.#budgetExpired(call)) return this.expire(id);
    return { ok: true };
  }

  expire(id) {
    const call = this.#require(id);
    this.#event(call, "system", "budget_expired", this.options.callTimeBudgetMs);
    const result = this.saveLead(
      id,
      { notes: appendNote(call.draft.notes, "Call time budget expired; saved partial lead.") },
      { partial: true, closing: "We're out of time, so I've saved what I have, and someone from our sales team will follow up. Thanks for calling." },
    );
    if (result.ok) return result;
    this.#closeWith(call, "We're out of time for this call. Please call us back anytime. Thanks for calling.", "time_budget");
    return { ok: true, ended: true, reason: result.reason };
  }

  endCall(id, outcome = "agent_ended") {
    const call = this.get(id);
    if (!call || TERMINAL.has(call.state)) return { ok: true };
    if (call.state === STATES.TRANSFERRING) return { ok: false, reason: "transfer_in_progress" };
    if (call.state === STATES.PAGING) {
      if (outcome === "agent_ended") return { ok: false, reason: "paging_on_call" };
      this.#clearPageTimer(call);
      call.page = "cancelled";
      this.store.updateCall(call.id, { page: "cancelled" });
      this.#event(call, "system", "page_cancelled", outcome);
    }
    this.#finish(call, STATES.ENDED, outcome);
    return { ok: true };
  }

  // ----------------------------------------------------------------- transfer

  /**
   * Hands the call to Teams: the sales queue in hours, or the on-call rep's
   * Teams user after a page. The rep sees the captured context as VoIP headers.
   */
  async dispatchTransfer(id) {
    const call = this.#require(id);
    if (call.dispatched) return { ok: false, reason: "already_dispatched" };
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    call.dispatched = true;
    const kind = call.transferKind ?? "sales";
    const target = kind === "on-call" ? this.#onCallTarget(call) : this.hours.salesQueue;
    const context = this.handoffContext(call);
    const simulated = !this.transfer || call.simulated;
    this.#event(call, "system", "transfer_started", target?.displayName ?? kind);
    try {
      if (simulated) this.#event(call, "system", "transfer_simulated", kind);
      else {
        await this.transfer(call, { target, context });
        this.#event(call, "system", "transfer_succeeded", kind);
      }
    } catch (e) {
      this.transferFailed(id, e.message);
      return { ok: false, reason: "transfer_failed", error: e.message };
    }
    this.#publish(call, "handoff", { ...context, target: { displayName: target?.displayName ?? null, kind }, stage: "transferred" });
    if (kind === "on-call" && simulated) this.#markPageConnected(call);
    this.#finish(call, STATES.TRANSFERRED, `transferred:${kind}`);
    return { ok: true, simulated, context };
  }

  /** ACS reported that the transfer target answered. */
  transferAccepted(id) {
    const call = this.get(id);
    if (!call) return { ok: false, reason: "unknown_call" };
    this.#event(call, "system", "transfer_accepted", call.transferKind ?? "sales");
    if (call.transferKind === "on-call" && call.page !== "connected") this.#markPageConnected(call);
    this.#publish(call, "state", this.snapshot(id));
    return { ok: true };
  }

  /**
   * The transfer failed or the on-call rep didn't answer. A paged caller hears
   * that the lead is saved for the morning; the rep's message says so too.
   */
  transferFailed(id, reason = "transfer_failed") {
    const call = this.get(id);
    if (!call) return { ok: false, reason: "unknown_call" };
    const handingOff = HANDING_OFF.has(call.state) || (call.state === STATES.TRANSFERRED && String(call.outcome ?? "").startsWith("transferred:"));
    if (!handingOff) return { ok: false, reason: "not_transferring" };
    this.#clearPageTimer(call);
    if (call.transferKind !== "on-call") {
      this.#event(call, "system", "transfer_failed", reason);
      // An overflow caller who pressed 0 still has the agent on the line, so it
      // apologizes before hanging up. A direct in-hours transfer has no agent.
      if (this.agents.has(call.id)) {
        call.outcome = null;
        this.#closeWith(call, "I'm sorry, I couldn't connect you to our sales team just now. Please try again in a few minutes.", "transfer_failed:sales");
      } else {
        this.#finish(call, STATES.ENDED, "transfer_failed:sales");
      }
      return { ok: true, kind: "sales" };
    }
    call.page = "failed";
    this.store.updateCall(call.id, { page: "failed" });
    this.#event(call, "system", "page_failed", reason);
    for (const m of call.messages) {
      if (!String(m.body ?? "").includes(PAGE_UNANSWERED)) m.body = appendNote(m.body, PAGE_UNANSWERED);
      this.store.persistOutbox?.(m);
    }
    call.outcome = null;
    call.endedAt = null;
    call.durationMs = null;
    const opening = this.hours.openingPhrase(this.now());
    const when = call.savedLead?.score === "hot" && opening ? `within an hour of opening at ${opening}` : call.followUp?.phrase ?? "as soon as we can";
    this.#closeWith(call, `I'm sorry, our on-call rep didn't pick up. Your details are saved, and someone will call you ${when}.`, "lead_captured");
    return { ok: true, kind: "on-call" };
  }

  /** Waits for any transfer in flight, then returns the snapshot. */
  async settled(id) {
    const call = this.get(id);
    if (call?.dispatchPromise) await call.dispatchPromise.catch(() => {});
    return this.snapshot(id);
  }

  /** What the person who answers in Teams sees, sent as VoIP headers. */
  handoffContext(call) {
    const d = call.draft;
    const sessionId = call.sessionId ?? call.id;
    if (call.transferKind === "on-call") {
      const lead = call.savedLead;
      const product = d.productInterest ?? "Sales inquiry";
      const need = [cap(product), d.quantity ? `${fmt(d.quantity)} units` : null, d.timeline ? `needed ${d.timeline}` : null].filter(Boolean).join(", ");
      const parts = [
        lead ? `${String(lead.score).toUpperCase()} lead (${lead.points} of ${this.qualification.maxPoints})` : null,
        [d.name, d.role, d.company].filter(Boolean).join(", ") || null,
        need,
        call.urgency?.cue ? `Urgent: "${call.urgency.cue}"` : null,
        d.callbackPhone ? `Callback ${phoneGroups(d.callbackPhone)}${d.phoneConfirmed ? " (confirmed)" : ""}` : null,
        call.pageDecision?.reason ? `Paged because: ${call.pageDecision.reason}` : null,
      ].filter(Boolean);
      return {
        sessionId,
        callTopic: clip(`${cap(product)} — ${d.company ?? "after-hours lead"}`, TOPIC_LIMIT),
        callContext: clip(parts.join(". "), CONTEXT_LIMIT),
        routeId: "on-call",
        afterHours: true,
        leadId: lead?.id ?? null,
      };
    }
    const captured = [d.name, d.company, d.productInterest, d.quantity ? `${fmt(d.quantity)} units` : null, d.timeline].filter(Boolean).join(", ");
    const straight = call.routeDecision?.action === "transfer";
    return {
      sessionId,
      callTopic: clip(d.productInterest ? `Sales inquiry: ${d.productInterest}` : "Sales inquiry", TOPIC_LIMIT),
      callContext: clip(
        straight
          ? "Sales inquiry during business hours. The caller went straight to the sales queue, so nothing was captured yet."
          : `Sales inquiry. The caller pressed 0 to wait for the next sales rep${captured ? `. Captured so far: ${captured}.` : " before giving any details."}`,
        CONTEXT_LIMIT,
      ),
      routeId: "sales",
      afterHours: false,
    };
  }

  // --------------------------------------------------------------- transcript

  pushTranscript(id, role, text) {
    const call = this.get(id);
    const said = String(text ?? "").trim();
    if (!call || !said) return;
    if (role === "caller") call.noInputs = 0;
    const at = this.now().toISOString();
    call.transcript.push({ role, text: said, at });
    this.store.recordTranscript(id, role, said);
    this.#publish(call, "transcript", { role, text: said, at });
  }

  publicDraft(call) {
    const { name, company, callbackPhone, phoneConfirmed, email, emailConfirmed, productInterest, quantity, timeline, role, location, notes } = call.draft;
    return { name, company, callbackPhone, phoneConfirmed, email, emailConfirmed, productInterest, quantity, timeline, role, location, notes };
  }

  snapshot(id) {
    const call = this.get(id);
    if (!call) return null;
    const lead = call.savedLead;
    const end = call.endedAt ? new Date(call.endedAt) : this.now();
    const paging = call.state === STATES.PAGING && call.pageStartedAtMs != null;
    return {
      id: call.id,
      state: call.state,
      simulated: call.simulated,
      maskedPhone: call.maskedPhone,
      routeDecision: call.routeDecision,
      draft: this.publicDraft(call),
      qualification: this.qualification.explain(call.draft),
      scoreBreakdown: lead?.scoreBreakdown ?? null,
      score: lead?.score ?? null,
      owner: lead?.owner ? { id: lead.owner.id, displayName: lead.owner.displayName } : null,
      savedLeadId: lead?.id ?? null,
      duplicateOf: call.followUp?.duplicateOf ?? null,
      lead: lead
        ? {
            id: lead.id,
            score: lead.score,
            points: lead.points,
            partial: lead.partial,
            ownerName: lead.owner?.displayName ?? null,
            slaDueAt: lead.slaDueAt,
            duplicateCount: lead.duplicateCount ?? 0,
            messages: call.messages.map((m) => ({
              id: m.id,
              channel: m.channel,
              kind: m.kind,
              status: m.status,
              toName: m.toName,
              mentionManager: Boolean(m.mentionManager),
              managerName: m.managerName ?? null,
              body: m.body,
              simulated: Boolean(m.simulated),
            })),
          }
        : null,
      followUp: call.followUp,
      askedForPerson: call.askedForPerson,
      urgency: call.urgency,
      pageDecision: call.pageDecision,
      page: call.page,
      onCallRep: call.onCallRep,
      transferKind: call.transferKind,
      pageWindowMs: this.options.pageWindowMs,
      pageRemainingMs: paging ? Math.max(0, this.options.pageWindowMs - (Date.now() - call.pageStartedAtMs)) : null,
      nonSales: call.nonSales,
      outcome: call.outcome,
      elapsedMs: end - new Date(call.startedAt),
      budgetMs: this.options.callTimeBudgetMs,
      transcript: call.transcript,
      handoff: call.transferKind && (HANDING_OFF.has(call.state) || call.state === STATES.TRANSFERRED) ? this.handoffContext(call) : null,
    };
  }

  // -------------------------------------------------------------- demo hooks

  /** Forgets every simulated call and returns their ids. Live calls are left alone. */
  reset() {
    const removed = [];
    for (const [id, call] of this.calls) {
      if (!call.simulated) continue;
      this.#clearPageTimer(call);
      this.calls.delete(id);
      this.agents.delete(id);
      removed.push(id);
    }
    return removed;
  }

  /** The demo clock moved by `deltaMs`: shift in-flight calls so their timers don't jump. */
  rebaseClock(deltaMs) {
    if (!deltaMs) return;
    const shift = (iso) => (iso ? new Date(new Date(iso).getTime() + deltaMs).toISOString() : iso);
    for (const call of this.calls.values()) {
      if (TERMINAL.has(call.state)) continue;
      call.startedAt = shift(call.startedAt);
      call.answeredAt = shift(call.answeredAt);
    }
  }

  // ---------------------------------------------------------------- internals

  #transferToSales(call) {
    call.transferKind = "sales";
    this.#setState(call, STATES.TRANSFERRING);
    call.dispatchPromise = this.dispatchTransfer(call.id);
    return { ok: true, action: "transfer", routeId: "sales" };
  }

  #startPage(call, rep) {
    call.transferKind = "on-call";
    call.onCallRep = { id: rep.id, displayName: rep.displayName };
    call.page = "started";
    call.pageStartedAtMs = Date.now();
    this.store.updateCall(call.id, { page: "started" });
    this.#setState(call, STATES.PAGING);
    this.#event(call, "system", "page_started", rep.displayName);
    const first = firstName(call.draft.name);
    const spoken = `${first ? `Thanks, ${first}. ` : ""}I'm paging our on-call sales rep now, so please stay on the line.`;
    this.#say(
      call,
      spoken,
      `Next step: say this to the caller in your own words: "${spoken}" If they speak while they wait, reassure them briefly. Don't call end_call or save_lead; the system connects the call to the on-call rep.`,
    );
    this.#publish(call, "handoff", { ...this.handoffContext(call), target: { displayName: rep.displayName, kind: "on-call" }, stage: "paging" });
    const accept = () => {
      call.pageTimer = null;
      if (call.state !== STATES.PAGING) return;
      if (!this.transfer || call.simulated) this.#event(call, "system", "page_accepted", rep.displayName);
      this.#setState(call, STATES.TRANSFERRING);
      call.dispatchPromise = this.dispatchTransfer(call.id);
    };
    if (this.options.pageWindowMs > 0) {
      call.pageTimer = setTimeout(accept, this.options.pageWindowMs);
      call.pageTimer.unref?.();
    } else {
      accept();
    }
  }

  #markPageConnected(call) {
    call.page = "connected";
    this.store.updateCall(call.id, { page: "connected" });
    this.#event(call, "system", "page_connected", call.onCallRep?.displayName ?? null);
  }

  #onCallTarget(call) {
    const rep = call.onCallRep ? this.reps.find(call.onCallRep.id) : null;
    return { type: "user", objectId: rep?.teamsUserId ?? null, displayName: rep?.displayName ?? call.onCallRep?.displayName ?? "On-call sales rep" };
  }

  #closingLine(call, { partial, decision }) {
    const parts = [];
    if (call.askedForPerson && !decision?.page) {
      if (decision?.code === "sales_open") parts.push("Everyone on our sales team is with other callers right now.");
      else if (decision?.covered) parts.push("I can't put you through to a person tonight, but I've passed everything on.");
      else parts.push("There's no one on call right now, so I can't put you through to a person.");
    }
    const first = firstName(call.draft.name);
    parts.push(first ? `Thanks, ${first}.` : "Thanks for calling.");
    if (call.followUp?.duplicateOf) parts.push("I've added this to your earlier request.");
    const opening = this.hours.openingPhrase(this.now());
    if (call.savedLead?.score === "hot" && !partial && opening) {
      parts.push(`Our sales team opens at ${opening}, and someone will call you within an hour of opening.`);
    } else {
      parts.push(`Someone from our sales team will call you ${call.followUp?.phrase ?? "soon"}.`);
    }
    return parts.join(" ");
  }

  #nonSalesLine(kind) {
    switch (kind) {
      case "emergency":
        return "If this is an emergency, please hang up and call emergency services now.";
      case "spam":
        return "Thanks for calling. I'm going to end the call now.";
      case "job-seeker":
        return "Thanks for your interest in working with us. This line is for sales inquiries only, so please apply through the careers page on our website.";
      default: {
        const support = this.hours.support ?? {};
        const where = support.phone ? ` Please call support at ${support.phone}${support.hours ? `, ${support.hours}` : ""}.` : "";
        return `Sorry for the trouble. I can only help with new sales inquiries here, but our support team can help with orders.${where}`;
      }
    }
  }

  #closeWith(call, line, outcome) {
    this.#setState(call, STATES.CLOSING);
    this.#say(call, line, finalStep(line));
    this.#finish(call, STATES.ENDED, outcome);
  }

  #budgetExpired(call) {
    if (!call.answeredAt || TERMINAL.has(call.state) || HANDING_OFF.has(call.state) || call.savedLead) return false;
    return this.now() - new Date(call.answeredAt) >= this.options.callTimeBudgetMs;
  }

  #finish(call, state, outcome) {
    this.#clearPageTimer(call);
    call.outcome = outcome;
    call.endedAt = this.now().toISOString();
    call.durationMs = new Date(call.endedAt) - new Date(call.startedAt);
    this.#setState(call, state);
    this.store.updateCall(call.id, { outcome, endedAt: call.endedAt, durationMs: call.durationMs });
    if (state === STATES.ENDED && outcome !== "caller_hung_up") this.agents.get(call.id)?.end?.(outcome);
  }

  #clearPageTimer(call) {
    if (call.pageTimer) clearTimeout(call.pageTimer);
    call.pageTimer = null;
  }

  #require(id) {
    const call = this.calls.get(id);
    if (!call) throw new Error(`unknown call ${id}`);
    return call;
  }

  #setState(call, state) {
    if (call.state === state) return;
    const from = call.state;
    call.state = state;
    this.store.updateCall(call.id, { state });
    this.#event(call, "system", "state", `${from} → ${state}`);
    this.#publish(call, "state", this.snapshot(call.id));
  }

  #say(call, spoken, prompt = null) {
    const agent = this.agents.get(call.id);
    if (agent?.instruct) agent.instruct(prompt ?? sayStep(spoken), spoken);
    else this.pushTranscript(call.id, "agent", spoken);
  }

  #event(call, source, kind, detail = null) {
    this.store.recordEvent(call.id, source, kind, detail);
    this.#publish(call, "event", { source, kind, detail: detail == null ? null : String(detail), at: this.now().toISOString() });
  }

  #publish(call, target, payload) {
    this.hub?.send?.(call.id, target, payload);
  }
}

function sanitisePatch(patch = {}) {
  const out = {};
  for (const key of DRAFT_KEYS) {
    if (!Object.hasOwn(patch ?? {}, key) || patch[key] === undefined) continue;
    const value = patch[key];
    switch (key) {
      case "callbackPhone":
        out.callbackPhone = normalisePhone(value);
        break;
      case "email": {
        const raw = String(value ?? "").trim();
        out.email = raw ? normaliseEmail(raw) ?? clip(raw.toLowerCase(), FIELD_LIMIT) : null;
        break;
      }
      case "quantity": {
        const m = String(value ?? "").replace(/,/g, "").match(/\d+/);
        out.quantity = m ? Number(m[0]) : null;
        break;
      }
      case "phoneConfirmed":
      case "emailConfirmed":
        out[key] = value === true || value === "true";
        break;
      case "notes":
        out.notes = clip(value, NOTES_LIMIT);
        break;
      default:
        out[key] = value == null ? null : clip(value, FIELD_LIMIT) || null;
    }
  }
  return out;
}
