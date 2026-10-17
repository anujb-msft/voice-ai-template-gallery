import { randomUUID } from "node:crypto";
import { config, nowDate } from "./config.mjs";
import { clip, isAffirmative, maskPhone } from "./util.mjs";

export const STATES = Object.freeze({ RINGING:"ringing", GREETING:"greeting", LISTENING:"listening", CLASSIFYING:"classifying", CLARIFYING:"clarifying", ANSWERING:"answering", VERIFYING:"verifying", PERSONAL_ANSWER:"personal_answer", PROPOSING_TICKET:"proposing_ticket", CONFIRMING:"confirming", FILED:"filed", HANDOFF_RESET:"handoff_reset", SENSITIVE:"sensitive", AFTER_HOURS_OFFER:"after_hours_offer", TRANSFERRING:"transferring", TRANSFERRED:"transferred", WRAP_UP:"wrap_up", CLOSING:"closing", ENDED:"ended" });

const TERMINAL = new Set([STATES.TRANSFERRED, STATES.ENDED]);
/** Teams shows the call topic on a narrow incoming-call toast. */
const TOPIC_LIMIT = 48;
const MAX_CODE_FAILURES = 2;
/** What the transcript, audit and console get instead of a sensitive HR utterance. */
export const PRIVATE_ROW = "[private HR matter — not recorded]";
const STATUS_WORDS = { Monitoring: "being monitored", "In progress": "in progress", "Waiting approval": "waiting for approval", New: "new" };
const CHANNEL_PHRASE = { teams: "your Teams chat", email: "your work email", sms: "the mobile number on your employee record" };
const CODE_PATTERN = /(?<![\w-])\d(?: ?\d){5}(?![\w-])/g;
const SERIAL_PATTERN = /\b(ending in )\d{4}\b/gi;
const ASSET_PATTERN = /\b([A-Z]{2,5}-)\d{4}\b/g;
const DECLINE = /\b(no|nope|cancel|don['’]t|do not|never ?mind|not now)\b/i;

/** One-time codes never reach the audit, the model-facing snapshot, or a live console. */
export const redactCodes = (text) => String(text ?? "").replace(CODE_PATTERN, "••••••");
/** Device serial digits and asset tags stay out of anything the model can read back. */
export const redactSerials = (text) => String(text ?? "").replace(SERIAL_PATTERN, "$1••••").replace(ASSET_PATTERN, "$1••••");
const scrub = (text) => redactSerials(redactCodes(text));
function scrubDeep(value) {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v)]));
  return value;
}
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ""));

/** "INC-004821" → "I-N-C, 0-0-4-8-2-1", so a caller can write it down. */
export function spellTicket(number) {
  const [prefix, digits = ""] = String(number).split("-");
  return `${[...prefix].join("-")}, ${[...digits].join("-")}`;
}
function firstSentence(text) { return /^.*?[.!?](?=\s|$)/.exec(String(text))?.[0] ?? String(text); }
function statusText(status) { return STATUS_WORDS[status] ?? String(status ?? "open").toLowerCase(); }
function statusLine(t) { return `${t.number}, "${t.summary}", is ${statusText(t.status)}.${t.lastUpdate ? ` Latest update: ${t.lastUpdate}` : ""}`; }
function ticketView(t) {
  if (!t) return null;
  return {
    number: t.number, kind: t.kind, category: t.category, priority: t.priority, summary: t.summary,
    status: t.status, statusText: statusText(t.status), lastUpdate: t.lastUpdate ?? null, parentIncident: t.parentIncident ?? null,
    asset: t.asset?.type ?? null, alreadyAffected: Boolean(t.alreadyAffected), simulated: Boolean(t.simulated),
  };
}

/**
 * The deterministic help-desk policy. The voice model (or the offline router)
 * proposes; this class decides: who the caller is, what may be read out, which
 * ticket and priority, and where the call goes.
 */
export class TriageFlow {
  constructor({ taxonomy, guard, knowledge, directory, hris, tickets, priority, outages, routing, audit, transfer = null, hub = null, otp, now = () => nowDate(), options = {} }) {
    Object.assign(this, { taxonomy, guard, knowledge, directory, hris, tickets, priority, outages, routing, audit, transfer, hub, otp, now });
    this.options = { confidenceMin: config.classifierConfidenceMin, timeBudgetMs: config.callTimeBudgetMs, wrapUpMs: config.wrapUpMs, passwordResetTarget: config.passwordResetTarget, otpChannel: config.otpChannel, ...options };
    this.calls = new Map();
    this.agents = new Map();
  }

  create({ callId = randomUUID(), teamsUserId = null, fromPhone = null, simulation = true, sessionId = null, incomingCallContext = null, resourceAccountId = null } = {}) {
    const employee = teamsUserId ? this.directory.findByTeamsUserId(teamsUserId) : null;
    const phone = fromPhone ? String(fromPhone).replace(/[^\d+]/g, "") || null : null;
    const channel = teamsUserId ? "teams" : "pstn";
    // Caller ID is easy to spoof: a matching mobile number is shown to the
    // presenter, but it is never treated as proof of identity.
    const callerIdEmployee = channel === "pstn" && phone ? this.directory.findByMobile(phone) : null;
    const call = {
      id: callId, sessionId: sessionId ?? callId, state: STATES.RINGING, simulation, channel,
      arrival: resourceAccountId ? "teams-phone-extensibility" : simulation ? "simulated" : "acs-direct",
      incomingCallContext, resourceAccountId, callConnectionId: null, teamsUserId, fromPhone: phone, maskedPhone: maskPhone(phone),
      employee, callerIdEmployee, verified: Boolean(employee), verifiedBy: employee ? "teams" : null, verification: null, consentShareName: false,
      locale: config.locale, domain: null, topicId: null, classification: null, pendingClarification: null, pendingAction: null, pendingProposal: null,
      lastArticle: null, lastTicket: null, joinedIncidents: new Set(), sensitive: false, sensitiveLogged: false, handoff: null, outcome: null, dispatchPromise: null,
      lastSpoken: null, transcript: [], startedAt: this.now().getTime(), answeredAt: null, endedAt: null, noInputs: 0, wrapWarned: false,
    };
    this.calls.set(call.id, call);
    this.audit.startCall({ id: call.id, state: call.state, verified: call.verified, domain: null, startedAt: call.startedAt, simulation });
    const how = employee ? "teams_verified" : channel === "teams" ? "teams_unknown" : callerIdEmployee ? "caller_id_match_unverified" : "pstn_unverified";
    this.#event(call, "system", "call_created", how);
    this.#touch(call);
    return call;
  }

  get(id) { return this.calls.get(id) ?? null; }
  registerAgent(id, handle) { this.agents.set(id, handle); }
  unregisterAgent(id) { this.agents.delete(id); }
  recordAgentAction(id, { tool, ok = true, detail = null } = {}) {
    const call = this.get(id);
    if (call) this.#event(call, "agent", ok ? "tool" : "tool_rejected", detail ? `${tool}: ${clip(detail, 80)}` : tool);
  }
  setCallConnection(id, callConnectionId) { const call = this.get(id); if (call && callConnectionId) call.callConnectionId = callConnectionId; }

  /** Idempotent: the media bridge and the simulator may both report the answer. */
  answered(id) {
    const call = this.#require(id);
    if (call.answeredAt) return call;
    call.answeredAt = this.now().getTime();
    this.#setState(call, STATES.GREETING);
    const banner = this.outages.banner(this.now());
    const name = call.verified ? call.employee.firstName : "there";
    this.#speak(call, `Hi ${name}, this is the ${this.routing.organization} IT and HR help line. I'm an automated assistant.${banner ? ` ${banner}` : ""} What can I help you with?`);
    this.#setState(call, STATES.LISTENING);
    return call;
  }

  /** Every caller utterance passes through here first, so the sensitive-topic guard runs before any keyword or model logic. */
  ingestUtterance(id, text) {
    const call = this.#require(id);
    const said = String(text ?? "").trim();
    if (!said) return this.noInput(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    call.noInputs = 0;
    const guard = this.guard.check(said);
    if (guard.sensitive) return { ...this.#sensitivePath(call, guard), handled: true };
    this.pushTranscript(call.id, "caller", said);
    if (this.#budgetExpired(call)) return { ...this.#expire(call), handled: true };
    return { ok: true };
  }

  /** Sensitive HR: collect nothing, say little, and route privately. */
  #sensitivePath(call, guard) {
    this.pushTranscript(call.id, "caller", PRIVATE_ROW, { sensitive: true });
    call.sensitive = true; call.domain = "HR"; call.topicId = null;
    call.pendingAction = null; call.pendingProposal = null; call.pendingClarification = null;
    this.audit.updateCall(call.id, { domain: "HR", topicId: null });
    if (!call.sensitiveLogged) { call.sensitiveLogged = true; this.#event(call, "system", "confidential_hr", "details not collected"); }
    this.#setState(call, STATES.SENSITIVE);
    if (guard.riskOfHarm) this.#speak(call, guard.safetyText);
    if (this.routing.isOpen("confidential-hr", this.now())) {
      this.#speak(call, guard.acknowledgement);
      return this.#transfer(call, "confidential-hr", { reason: "sensitive" });
    }
    this.#event(call, "system", "after_hours", "confidential-hr");
    this.#speak(call, `${firstSentence(guard.acknowledgement)} ${guard.afterHours} Would you like that callback?`);
    this.#setState(call, STATES.AFTER_HOURS_OFFER);
    return { ok: true, sensitive: true, afterHours: true };
  }

  #transfer(call, destinationId, { reason = null, ticket = null, intent = null } = {}) {
    const target = this.routing.get(destinationId);
    if (!target) return { ok: false, reason: "unknown_destination" };
    const context = this.handoffContext(call, destinationId, { reason, ticket, intent });
    call.handoff = context;
    this.#event(call, "system", "transfer", destinationId);
    this.#setState(call, STATES.TRANSFERRING);
    // The console explains why the call moved. A confidential handoff carries nothing beyond its label, not even that.
    const why = context.confidential ? {} : { reason: reason ?? (ticket ? "urgent_ticket" : intent ? "password_reset" : "topic") };
    this.hub?.send(call.id, "handoff", { ...context, ...why, destinationLabel: target.label, queue: target.target?.displayName ?? target.label, simulated: call.simulation });
    if (call.simulation || !this.transfer) {
      this.#finish(call, STATES.TRANSFERRED, `transferred:${destinationId}`);
      return { ok: true, simulated: true, context };
    }
    call.dispatchPromise = Promise.resolve()
      .then(() => this.transfer(call, { target, context }))
      .then(() => { if (call.handoff === context && call.state === STATES.TRANSFERRING) this.#finish(call, STATES.TRANSFERRED, `transferred:${destinationId}`); })
      .catch((error) => this.#transferFailed(call, error?.message ?? String(error)));
    return { ok: true, pending: true, context };
  }

  /** Call Automation reported that the transfer did not complete; the caller is still with us. */
  transferFailed(id, detail = "transfer failed") {
    const call = this.get(id);
    if (!call) return { ok: false, reason: "unknown_call" };
    const inFlight = call.state === STATES.TRANSFERRING || (call.state === STATES.TRANSFERRED && String(call.outcome).startsWith("transferred:"));
    return inFlight ? this.#transferFailed(call, detail) : { ok: false, reason: "not_transferring" };
  }

  #transferFailed(call, detail) {
    this.#event(call, "system", "transfer_failed", clip(detail, 120));
    call.handoff = null; call.outcome = null; call.endedAt = null;
    this.audit.updateCall(call.id, { outcome: null, endedAt: null, durationMs: null });
    this.#speak(call, "I couldn't connect you just now. You can try again, or I can file a ticket so someone calls you back.");
    this.#setState(call, STATES.LISTENING);
    return { ok: false, reason: "transfer_failed" };
  }

  /**
   * What the person who picks up sees in Teams. Each destination gets an
   * allowlist: confidential HR learns nothing beyond "Confidential HR".
   */
  handoffContext(call, destinationId, { reason = null, ticket = null, intent = null } = {}) {
    const base = { sessionId: call.sessionId, destinationId };
    if (destinationId === "confidential-hr") return { ...base, callTopic: "Confidential HR", callContext: "Confidential HR", confidential: true };
    const callTopic = this.#topicLine(call, destinationId, { reason, ticket, intent });
    const verifiedName = call.verified ? call.employee.displayName : null;
    const article = call.lastArticle ? this.knowledge.byId.get(call.lastArticle)?.title ?? null : null;
    const topic = this.taxonomy.get(call.topicId)?.label ?? null;
    // routing.json lists the fields each destination may receive; anything else is dropped.
    const fields = this.routing.get(destinationId)?.callContextFields;
    const allow = (ctx) => (Array.isArray(fields) ? Object.fromEntries(Object.entries(ctx).filter(([k]) => fields.includes(k))) : ctx);
    if (destinationId === "password-reset-agent") {
      return { ...base, callTopic, callContext: allow(compact({ intent, employeeHint: call.verified ? call.employee.workEmail : null, sessionId: call.sessionId })) };
    }
    if (destinationId === "hr-shared-services" || destinationId === "payroll") {
      return { ...base, callTopic, callContext: allow(compact({ verifiedName, topic, articleCited: article })) };
    }
    const t = ticket ?? call.lastTicket;
    return { ...base, callTopic, callContext: allow(compact({ verifiedName, ticketNumber: t?.number, priority: t?.priority, topic, matchedAsset: t?.asset?.assetTag, tried: article })) };
  }

  #topicLine(call, destinationId, { reason = null, ticket = null, intent = null } = {}) {
    const label = this.taxonomy.get(call.topicId)?.label ?? null;
    const area = { IT: "IT", HR: "HR", both: "IT and HR" }[call.domain] ?? "IT";
    let line;
    if (reason === "unverified") line = "Couldn't verify caller";
    else if (reason === "keypad_0") line = label ? `Chose 0 on the keypad - ${label}` : "Chose 0 on the keypad";
    else if (reason === "asked_for_person") line = label ? `Asked for a person - ${label}` : "Asked for a person";
    else if (reason === "still_unclear") line = "IT or HR unclear after one question";
    else if (destinationId === "password-reset-agent") line = intent === "mfa_reregister" ? "IT - MFA re-registration" : "IT - account unlock";
    else if (ticket?.priority === "P1" && /^Security/.test(ticket.category ?? "")) line = `P1 security - ${label ?? ticket.category}, ${ticket.number}`;
    else if (ticket) line = `IT - ${label ?? ticket.category}, ${ticket.priority}, ${ticket.number}`;
    else if (label) line = `${area} - ${label}`;
    else line = this.routing.get(destinationId)?.label ?? destinationId;
    return clip(line, TOPIC_LIMIT);
  }

  /** Hand the caller to a person or another agent, saying so first. */
  route(id, destinationId, reason = null, extra = {}) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    const target = this.routing.get(destinationId);
    if (!target) return { ok: false, reason: "unknown_destination" };
    if (reason === "asked_for_person") this.#event(call, "caller", "human_requested", destinationId);
    const known = Boolean(call.topicId || call.lastTicket);
    this.#speak(call, `I'm connecting you to ${target.target?.displayName ?? target.label} now.${known ? " They'll see why you're calling, so you won't have to repeat yourself." : ""}`);
    return this.#transfer(call, destinationId, { reason, ...extra });
  }

  /** The people who own whatever the call is about so far. */
  personQueue(id) {
    const call = this.#require(id);
    const action = this.taxonomy.get(call.topicId)?.action ?? null;
    const known = [action?.destination, action?.fallback?.destination].find((d) => d && this.routing.get(d));
    if (known) return known;
    return call.domain === "HR" ? "hr-shared-services" : this.routing.fallbackDestination;
  }

  dtmf(id, digit) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    const key = String(digit ?? "").trim().slice(0, 1);
    this.pushTranscript(call.id, "caller", `Chose ${key || "?"} on the keypad`);
    this.#event(call, "caller", "keypad", key || "?");
    if (key === "*") return this.repeatLast(id);
    if (key === "0") {
      if (call.state !== STATES.AFTER_HOURS_OFFER) return this.route(id, this.personQueue(id), "keypad_0");
      this.#speak(call, `The confidential HR line is closed right now. ${this.#repromptText(call)}`);
      this.#touch(call);
      return { ok: true, reprompted: true };
    }
    this.#speak(call, "That key isn't on the menu. Press 0 for a person, or star to hear that again.");
    this.#touch(call);
    return { ok: false, reason: "unmapped_digit" };
  }

  noInput(id) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    call.noInputs += 1;
    this.#event(call, "system", "no_input", String(call.noInputs));
    if (call.noInputs >= 2) {
      this.#speak(call, "I'm not hearing anything, so I'll end the call for now. Please call back when you're ready.");
      this.#finish(call, STATES.ENDED, "no_input");
      return { ok: true, ended: true };
    }
    this.#speak(call, `Sorry, I didn't catch that. ${this.#repromptText(call)}`);
    this.#touch(call);
    return { ok: true, reprompted: true };
  }

  #repromptText(call) {
    switch (call.state) {
      case STATES.VERIFYING: return call.verification?.code ? "Please read me the six-digit code." : "What's your work email?";
      case STATES.CONFIRMING: return "Should I file the ticket?";
      case STATES.CLARIFYING: return call.pendingClarification?.question ?? "Is this about IT or HR?";
      case STATES.AFTER_HOURS_OFFER: return "Would you like confidential HR to call you back next business day? Please say yes or no.";
      default: return "How can I help?";
    }
  }

  /** Runs on a timer for every open call: warn at wrap-up, end at the cap. */
  checkBudget(id) {
    const call = this.get(id);
    if (!call || !call.answeredAt || TERMINAL.has(call.state) || call.state === STATES.TRANSFERRING) return { ok: true };
    if (this.#budgetExpired(call)) return this.#expire(call);
    const elapsed = this.now().getTime() - call.answeredAt;
    if (call.wrapWarned || elapsed < this.options.wrapUpMs) return { ok: true };
    call.wrapWarned = true;
    this.#event(call, "system", "wrap_up", `${Math.round(elapsed / 1000)}s`);
    this.#speak(call, "We're almost out of time. I can file a ticket for anything still open, or press 0 for a person.");
    this.#touch(call);
    return { ok: true, wrapUp: true };
  }

  #budgetExpired(call) {
    return Boolean(call.answeredAt) && !TERMINAL.has(call.state) && call.state !== STATES.TRANSFERRING && this.now().getTime() - call.answeredAt >= this.options.timeBudgetMs;
  }

  #expire(call) {
    this.#event(call, "system", "budget_expired", `${Math.round(this.options.timeBudgetMs / 1000)}s`);
    this.#speak(call, "We've reached the time limit for this call. Please call back if you still need help. Goodbye.");
    this.#finish(call, STATES.ENDED, "time_budget_expired");
    return { ok: true, expired: true };
  }

  /** Teams callers arrive verified. Phone callers prove who they are with a one-time code first. */
  #gate(call, pending) {
    return call.verified ? null : this.#askForIdentity(call, pending);
  }

  #askForIdentity(call, pending) {
    call.pendingAction = pending;
    this.#event(call, "system", "verification_required", pending?.type ?? "personal");
    const live = call.verification?.code && this.now().getTime() <= call.verification.expiresAt;
    this.#speak(call, live
      ? "I sent you a code a moment ago. Please read me the six digits."
      : `I can help with that once I've confirmed who you are. What's your work email? I'll send a one-time code to ${CHANNEL_PHRASE[this.options.otpChannel] ?? CHANNEL_PHRASE.teams}.`);
    this.#setState(call, STATES.VERIFYING);
    return { ok: false, needsVerification: true };
  }

  startVerification(id, email) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    if (call.verified) return { ok: true, alreadyVerified: true };
    const employee = this.directory.findByEmail(String(email ?? "").trim());
    if (!employee) {
      this.#event(call, "system", "unknown_email", null);
      this.#speak(call, "I couldn't find that work email. Please say it again, or press 0 to reach a person.");
      this.#setState(call, STATES.VERIFYING);
      return { ok: false, reason: "unknown_email" };
    }
    const channel = this.options.otpChannel;
    const sent = this.otp.send(employee, channel, { simulated: call.simulation });
    call.verification = {
      employee, email: employee.workEmail, channel, sentAt: sent.sentAt, expiresAt: sent.expiresAt, code: sent.code, attempts: 0,
      failures: call.verification?.failures ?? 0, lastResult: "sent",
      callerIdMatches: Boolean(call.callerIdEmployee && call.callerIdEmployee.workEmail === employee.workEmail),
    };
    this.#event(call, "system", "code_sent", { teams: "Teams chat", email: "work email", sms: "text message" }[channel] ?? channel);
    if (call.simulation) {
      // Simulated calls never send anything: the console shows the code in a mock inbox instead.
      const minutes = Math.round((sent.expiresAt - sent.sentAt) / 60_000);
      this.hub?.send(call.id, "outbox", {
        kind: "otp", channel, to: employee.workEmail, toName: employee.displayName, subject: `Your ${this.routing.organization} help line code`,
        body: `Your one-time code is ${sent.code}. It expires in ${minutes} minutes. If you didn't call the help line, ignore this message.`,
        code: sent.code, expiresAt: new Date(sent.expiresAt).toISOString(), at: new Date(sent.sentAt).toISOString(),
      });
    }
    this.#speak(call, `I sent a six-digit code to ${CHANNEL_PHRASE[channel] ?? "you"}. Please read it back to me.`);
    this.#setState(call, STATES.VERIFYING);
    return { ok: true, sent: true, channel, expiresInSeconds: Math.round((sent.expiresAt - sent.sentAt) / 1000) };
  }

  checkCode(id, code) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    if (call.verified) return { ok: true, alreadyVerified: true };
    const v = call.verification;
    if (!v?.code) {
      this.#speak(call, "I haven't sent you a code yet. What's your work email?");
      this.#setState(call, STATES.VERIFYING);
      return { ok: false, reason: "not_started" };
    }
    v.attempts += 1;
    if (this.now().getTime() > v.expiresAt) {
      v.code = null; v.lastResult = "expired";
      this.#event(call, "system", "code_expired", null);
      this.#speak(call, "That code has expired. Tell me your work email again and I'll send a new one.");
      this.#setState(call, STATES.VERIFYING);
      return { ok: false, reason: "expired" };
    }
    if (String(code ?? "").replace(/\D/g, "") !== v.code) {
      v.failures += 1; v.lastResult = "refused";
      this.#event(call, "system", "code_refused", `attempt ${v.attempts}`);
      if (v.failures >= MAX_CODE_FAILURES) {
        v.code = null;
        this.#speak(call, "That code didn't match again, so I'll connect you to someone who can verify you another way.");
        return { ...this.#transfer(call, this.personQueue(call.id), { reason: "unverified" }), ok: false, reason: "failed", transferred: true };
      }
      this.#speak(call, "That code didn't match. Please read the six digits again.");
      this.#setState(call, STATES.VERIFYING);
      return { ok: false, reason: "failed" };
    }
    call.verified = true; call.verifiedBy = "code"; call.employee = v.employee;
    v.code = null; v.lastResult = "verified";
    this.audit.updateCall(call.id, { verified: true });
    this.#event(call, "system", "verified", "one-time code");
    this.#speak(call, `Thanks, ${v.employee.firstName} — you're verified.`);
    return { ...this.#resumeAfterVerification(call), verified: true };
  }

  /** Pick up whatever the caller asked for before we had to verify them. */
  #resumeAfterVerification(call) {
    const pending = call.pendingAction;
    call.pendingAction = null;
    switch (pending?.type) {
      case "personal": return this.getPersonalAnswer(call.id, pending.kind);
      case "ticket_status": return this.getTicketStatus(call.id, pending.number);
      case "my_tickets": return this.getMyTickets(call.id);
      case "propose_ticket": return this.proposeTicket(call.id, pending.input);
      case "send_link": return this.sendLink(call.id, pending.target);
      default:
        this.#speak(call, "What can I help you with?");
        this.#setState(call, STATES.LISTENING);
        return { ok: true };
    }
  }

  /** A ticket is readable by its requester, anyone added to it, and everyone for a major incident. */
  #canSee(ticket, email) {
    return ticket.requester === email || ticket.requester === "system" || this.tickets.isAffected(ticket.number, email);
  }

  getTicketStatus(id, number) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    const wanted = String(number ?? "").trim().toUpperCase().replace(/^(INC|REQ)[\s-]?/, "$1-");
    if (!wanted) return this.getMyTickets(id);
    const gated = this.#gate(call, { type: "ticket_status", number: wanted });
    if (gated) return gated;
    const ticket = this.tickets.findByNumber(wanted);
    if (!ticket) {
      this.#event(call, "system", "ticket_not_found", wanted);
      this.#speak(call, `I can't find ${wanted}. Check the number in your Teams chat, or I can read out your own tickets.`);
      this.#setState(call, STATES.LISTENING);
      return { ok: false, reason: "not_found" };
    }
    if (!this.#canSee(ticket, call.employee.workEmail)) {
      this.#event(call, "system", "ticket_status_refused", ticket.number);
      this.#speak(call, `${ticket.number} isn't one of your tickets, so I can't read its details. I can read out your own tickets instead.`);
      this.#setState(call, STATES.LISTENING);
      return { ok: false, refused: true, reason: "not_yours" };
    }
    call.lastTicket = ticket;
    this.#event(call, "system", "ticket_status", ticket.number);
    const spoken = statusLine(ticket);
    this.#speak(call, spoken);
    this.#setState(call, STATES.LISTENING);
    return { ok: true, ticket: ticketView(ticket), spoken };
  }

  getMyTickets(id) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    const gated = this.#gate(call, { type: "my_tickets" });
    if (gated) return gated;
    const mine = this.tickets.getMyTickets(call.employee.workEmail).filter((t) => !/^(resolved|closed)$/i.test(t.status ?? ""));
    if (mine.length === 1) call.lastTicket = mine[0];
    this.#event(call, "system", "ticket_status", mine.length ? mine.map((t) => t.number).join(", ") : "none open");
    const spoken = mine.length ? mine.map(statusLine).join(" ") : "I don't see any open tickets for you.";
    this.#speak(call, spoken);
    this.#setState(call, STATES.LISTENING);
    return { ok: true, tickets: mine.map(ticketView), spoken };
  }

  sendLink(id, target) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    const gated = this.#gate(call, { type: "send_link", target });
    if (gated) return gated;
    const article = this.knowledge.byId.get(target) ?? null;
    const ticket = article ? null : this.tickets.findByNumber(target);
    if (!article && !(ticket && this.#canSee(ticket, call.employee.workEmail))) return { ok: false, reason: "unknown_target" };
    const title = article ? article.title : `${ticket.number}: ${ticket.summary}`;
    this.#event(call, "system", "link_sent", article ? article.id : ticket.number);
    if (call.simulation) {
      this.hub?.send(call.id, "outbox", {
        kind: "link", channel: "teams", to: call.employee.workEmail, toName: call.employee.displayName, subject: title,
        body: `Here's the ${article ? "article" : "ticket"} you asked about on the help line: ${title}.`, at: this.now().toISOString(),
      });
    }
    this.#speak(call, "I sent that link to your Teams chat. Anything else?");
    this.#setState(call, STATES.LISTENING);
    return { ok: true };
  }

  /** Approved content only: the answer is the article text, never the model's own words. */
  answerQuestion(id, topicId, { locale = null } = {}) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    const topic = this.taxonomy.get(topicId);
    if (!topic?.action?.articleId) return { ok: false, available: false, reason: "no_article", fallback: topic?.action?.fallback ?? null };
    this.#setTopic(call, topic);
    const articleId = topic.action.articleId;
    const result = this.knowledge.answer(articleId, { locale: locale ?? call.locale, caller: call.employee, at: this.now() });
    if (!result.available) {
      this.#event(call, "system", "answer_unavailable", `${articleId}: ${result.reason}`);
      return { ok: false, available: false, reason: result.reason, citation: articleId, fallback: topic.action.fallback ?? null };
    }
    call.lastArticle = result.article.id;
    this.#event(call, "system", "answered", result.article.id);
    this.#speak(call, result.text);
    this.#setState(call, STATES.LISTENING);
    const article = { id: result.article.id, title: result.article.title };
    return { ok: true, available: true, citation: article.id, title: article.title, text: result.text, englishOnly: Boolean(result.englishOnly), article };
  }

  getPersonalAnswer(id, kind) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    const topic = this.taxonomy.topics.find((t) => t.action?.type === "personal" && t.action.kind === kind);
    if (topic) this.#setTopic(call, topic);
    const gated = this.#gate(call, { type: "personal", kind });
    if (gated) return gated;
    const result = this.hris.answer(call.employee.workEmail, kind);
    if (!result.ok) {
      this.#event(call, "system", "personal_unavailable", kind);
      this.#speak(call, result.spoken);
      this.#setState(call, STATES.LISTENING);
      return { ok: false, reason: "no_record", spoken: result.spoken };
    }
    this.#event(call, "system", "personal_answer", kind);
    this.#speak(call, result.spoken);
    this.#setState(call, STATES.LISTENING);
    return { ok: true, kind, spoken: result.spoken };
  }

  refusePersonal(id, reason = "forbidden_personal_data") {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    this.#event(call, "system", "personal_refused", reason);
    this.#speak(call, "I can only share personal HR information about the verified caller, and never salary or another employee's data.");
    this.#setState(call, STATES.LISTENING);
    return { ok: false, refused: true, reason };
  }

  /** The server picks category and priority from the matrix; the caller only confirms. */
  proposeTicket(id, input = {}) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    const { topicId, description = "", impact = null, blocked = false } = input;
    const topic = this.taxonomy.get(topicId);
    if (!topic) return { ok: false, reason: "unknown_topic" };
    this.#setTopic(call, topic);
    const gated = this.#gate(call, { type: "propose_ticket", input: { topicId, description, impact, blocked } });
    if (gated) return gated;
    const action = topic.action ?? {};
    const category = action.category ?? action.fallback?.category ?? "General";
    const label = topic.label ?? topic.id;
    if (!category.startsWith("Security")) {
      const outage = this.outages.match(`${description} ${label}`, this.now());
      if (outage) return this.#attachToOutage(call, outage);
    }
    const securityCategory = action.securityCategory ?? null;
    const scope = impact ?? action.impact ?? action.fallback?.impact ?? "me";
    const priority = this.priority.priority({ impact: scope, blocked: Boolean(blocked), securityCategory });
    const device = /^(Hardware|Security)\//.test(category) ? this.directory.matchDevice(call.employee, description) : null;
    call.pendingProposal = {
      proposalId: randomUUID(), topicId: topic.id, label, category, priority, blocked: Boolean(blocked), impact: scope,
      summary: clip(description || `${capitalize(label)} needed`, 120),
      asset: device ? { type: device.type, assetTag: device.assetTag, serialLast4: device.serialLast4 } : null,
      securityCategory, requester: call.employee.workEmail,
    };
    this.#event(call, "system", "ticket_proposed", `${category} · ${priority}`);
    const readback = this.#readback(call.pendingProposal);
    this.#speak(call, readback);
    this.#setState(call, STATES.CONFIRMING);
    return { ok: true, proposal: this.#proposalView(call.pendingProposal), readback };
  }

  /** A known outage: add the caller to the parent incident instead of filing a duplicate. */
  #attachToOutage(call, outage) {
    const ticket = this.tickets.attachToIncident({ requester: call.employee.workEmail, parentIncident: outage.parentIncident, simulated: call.simulation });
    // Simulated sign-ups last until Reset demo. A demo call counts only its own, so a re-run of the beat hears "I've added you" again.
    if (call.simulation) ticket.alreadyAffected = call.joinedIncidents.has(outage.parentIncident);
    call.joinedIncidents.add(outage.parentIncident);
    call.lastTicket = ticket;
    this.#event(call, "system", "outage_attached", outage.parentIncident);
    this.#speak(call, ticket.alreadyAffected
      ? `That's the ${outage.service} outage I mentioned. You're already on ${outage.parentIncident}, so you'll get the update when it's fixed.`
      : `That's the ${outage.service} outage I mentioned. I've added you to ${outage.parentIncident}, so you'll get the update when it's fixed. No new ticket needed.`);
    this.#setState(call, STATES.LISTENING);
    return { ok: true, attachedToIncident: true, ticket: ticketView(ticket) };
  }

  #readback(p) {
    const device = p.asset ? `, on your ${p.asset.type} ending in ${p.asset.serialLast4}` : "";
    const why = p.securityCategory ? "It's a security incident" : p.blocked ? "You're blocked" : "You're not blocked";
    const reach = p.impact === "site" ? " and it affects the whole site" : p.impact === "team" ? " and it affects your team" : "";
    return `Here's the ticket: ${capitalize(p.label)}${device}. ${why}${reach}, so that's priority ${p.priority.slice(1)}. Should I file it?`;
  }

  #proposalView(p) {
    return { proposalId: p.proposalId, topicId: p.topicId, label: p.label, category: p.category, priority: p.priority, blocked: p.blocked, impact: p.impact, summary: p.summary, asset: p.asset?.type ?? null, securityCategory: p.securityCategory };
  }

  /** Nothing is filed without an explicit yes. */
  fileTicket(id, proposalId, confirmation = "") {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    const p = call.pendingProposal;
    if (!p || p.proposalId !== proposalId) return { ok: false, reason: "missing_proposal" };
    const said = String(confirmation ?? "");
    if (DECLINE.test(said) && !isAffirmative(said)) {
      call.pendingProposal = null;
      this.#event(call, "system", "ticket_declined", p.category);
      this.#speak(call, "Okay, I won't file it. What else can I help with?");
      this.#setState(call, STATES.LISTENING);
      return { ok: false, reason: "declined" };
    }
    if (!isAffirmative(said)) {
      this.#event(call, "system", "awaiting_yes", p.category);
      this.#speak(call, "I'll only file it if you say yes. Should I file it?");
      this.#setState(call, STATES.CONFIRMING);
      return { ok: false, reason: "not_confirmed" };
    }
    call.pendingProposal = null;
    const ticket = this.tickets.createTicket({
      kind: "incident", requester: p.requester, category: p.category, priority: p.priority, summary: p.summary,
      asset: p.asset ? { type: p.asset.type, assetTag: p.asset.assetTag } : null, simulated: call.simulation,
    });
    call.lastTicket = ticket;
    const view = ticketView(ticket);
    this.#event(call, "system", "ticket_created", `${ticket.number} · ${ticket.priority}`);
    if (call.simulation) {
      this.hub?.send(call.id, "outbox", {
        kind: "ticket", channel: "teams", to: call.employee.workEmail, toName: call.employee.displayName, subject: `${ticket.number}: ${ticket.summary}`,
        body: `${capitalize(p.label)}, priority ${ticket.priority.slice(1)}. You'll get updates in this chat.`, ticket: view, at: this.now().toISOString(),
      });
    }
    const urgent = ticket.priority === "P1";
    this.#speak(call, `Your ticket is ${ticket.number} — that's ${spellTicket(ticket.number)}. I'll send it to you in Teams chat.${urgent ? "" : " Anything else I can help with?"}`);
    if (!urgent) {
      this.#setState(call, STATES.FILED);
      return { ok: true, ticket: view };
    }
    this.#speak(call, `This is urgent, so I'm connecting you to IT on-call now.${p.securityCategory === "phishing_click" ? " Don't enter any passwords in the meantime." : ""}`);
    return { ok: true, ticket: view, handoff: this.#transfer(call, "it-on-call", { ticket }) };
  }

  handoffPasswordReset(id, intent = "unlock") {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    const topic = this.taxonomy.topics.find((t) => t.action?.type === "handoff" && t.action.intent === intent) ?? this.taxonomy.get("it-account-unlock");
    this.#setTopic(call, topic);
    if (!this.options.passwordResetTarget) return this.proposeTicket(id, { topicId: topic.id, description: `${capitalize(topic.label)} needed`, blocked: true });
    this.#event(call, "system", "password_reset_handoff", intent);
    this.#speak(call, `I'll connect you to our password reset assistant. It will verify you and ${intent === "mfa_reregister" ? "help you re-register MFA" : "unlock your account"}.`);
    return this.#transfer(call, "password-reset-agent", { intent: topic.action?.intent ?? intent });
  }

  /** After hours, confidential HR calls back. The case says "Confidential HR" and nothing else. */
  requestCallback(id) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    const hrCase = this.tickets.createHrCase({ requester: call.verified ? call.employee.workEmail : "anonymous", callback: true, consentShareName: false, simulated: call.simulation });
    this.#event(call, "system", "callback_requested", hrCase.number);
    this.#speak(call, "I've asked confidential HR to call you back next business day. Nothing you said is in the request. Take care.");
    this.#finish(call, STATES.ENDED, "callback_requested");
    return { ok: true, caseNumber: hrCase.number };
  }

  declineCallback(id) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    this.#event(call, "system", "callback_declined", null);
    this.#speak(call, "Okay. You can reach the ethics hotline any time. Take care.");
    this.#finish(call, STATES.ENDED, "confidential_after_hours_declined");
    return { ok: true, ended: true };
  }

  classify(utterance) { return this.taxonomy.classify(utterance, { confidenceMin: this.options.confidenceMin }); }

  /** Classify for a call and show the decision on the console. */
  classifyFor(id, utterance) {
    const call = this.#require(id);
    const c = this.classify(utterance);
    call.classification = c;
    const area = { IT: "IT", HR: "HR", both: "IT and HR" }[c.domain] ?? c.domain;
    if (c.needsClarification) this.#event(call, "system", "low_confidence", `${c.candidates.map((x) => x.label).join(" or ") || "no match"} · ${c.confidence.toFixed(2)}`);
    else this.#event(call, "system", "classified", `${area} · ${c.label} · ${c.confidence.toFixed(2)}`);
    this.#touch(call);
    return c;
  }

  /** One clarifying question, worded from the two closest topics. */
  askClarification(id, utterance, classification = this.classify(utterance)) {
    const call = this.#require(id);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    const candidates = classification.candidates ?? [];
    const question = this.#clarifyingQuestion(candidates);
    call.pendingClarification = { question, utterance: String(utterance ?? ""), candidates };
    this.#speak(call, question);
    this.#setState(call, STATES.CLARIFYING);
    return { ...classification, ok: true, clarify: true, question };
  }

  #clarifyingQuestion(candidates) {
    const it = candidates.find((c) => c.domain === "IT");
    const hr = candidates.find((c) => c.domain === "HR");
    if (!it || !hr) return "Is this about a device or account, or about pay, leave, or benefits?";
    const action = this.taxonomy.get(it.topicId)?.action ?? {};
    const category = action.category ?? action.fallback?.category ?? "";
    const itPart = /^(Access|Identity)\//.test(category) ? "a system account" : /^Hardware\//.test(category) ? "a device" : "an IT system";
    const hrPart = /pay/.test(hr.topicId) ? "your pay" : /pto|leave/.test(hr.topicId) ? "your time off" : /benefit/.test(hr.topicId) ? "your benefits" : "an HR policy";
    return `Is this about ${itPart}, or about ${hrPart}?`;
  }

  clarified(id, topicId) {
    const call = this.#require(id);
    call.pendingClarification = null;
    this.#event(call, "system", "clarified", this.taxonomy.get(topicId)?.label ?? topicId);
    this.#touch(call);
  }

  repeatLast(id) {
    const call = this.#require(id);
    if (call.lastSpoken) this.#speak(call, call.lastSpoken);
    this.#touch(call);
    return { ok: true, repeated: Boolean(call.lastSpoken) };
  }

  endCall(id, outcome = "caller_hung_up") {
    const call = this.get(id);
    if (!call) return { ok: false, reason: "unknown_call" };
    if (TERMINAL.has(call.state)) return { ok: true, alreadyFinished: true };
    if (call.state === STATES.TRANSFERRING && call.handoff) {
      this.#finish(call, STATES.TRANSFERRED, `transferred:${call.handoff.destinationId}`);
      return { ok: true, transferred: true };
    }
    this.#event(call, "system", "call_ended", outcome);
    this.#finish(call, STATES.ENDED, outcome);
    return { ok: true, ended: true };
  }

  say(id, text) { const call = this.#require(id); this.#speak(call, String(text ?? "")); this.#touch(call); return { ok: true }; }
  event(id, source, kind, detail = null) { const call = this.get(id); if (call) this.#event(call, source, kind, detail); }
  setState(id, state) { this.#setState(this.#require(id), state); }
  setTopic(id, topicId) { const call = this.#require(id); const topic = this.taxonomy.get(topicId); if (topic) this.#setTopic(call, topic); }

  /** Resolves once any live transfer for this call has been accepted or has failed. */
  async settled(id) {
    const pending = this.get(id)?.dispatchPromise;
    if (pending) await pending.catch(() => {});
  }

  /** Demo reset: forget simulated calls. Real calls are never touched. */
  reset() {
    const removed = [];
    for (const [id, call] of this.calls) {
      if (!call.simulation) continue;
      this.calls.delete(id);
      this.agents.delete(id);
      removed.push(id);
    }
    return removed;
  }

  /** The demo clock jumped: move open calls with it so budgets and code expiry still hold. */
  rebaseClock(deltaMs) {
    if (!deltaMs) return;
    for (const call of this.calls.values()) {
      if (TERMINAL.has(call.state)) continue;
      call.startedAt += deltaMs;
      if (call.answeredAt) call.answeredAt += deltaMs;
      if (call.verification) { call.verification.sentAt += deltaMs; call.verification.expiresAt += deltaMs; }
    }
  }

  /** What the model, the API and the console can see. No phone numbers, codes, IDs or serials. */
  snapshot(id) {
    const call = this.get(id);
    if (!call) return null;
    const v = call.verification;
    const article = call.lastArticle ? this.knowledge.byId.get(call.lastArticle) : null;
    return {
      id: call.id, callId: call.id, state: call.state, channel: call.channel, arrival: call.arrival, simulation: call.simulation,
      caller: this.directory.publicProfile(call.employee, { verified: call.verified }), maskedPhone: call.maskedPhone,
      callerIdMatch: Boolean(call.callerIdEmployee), verified: call.verified, verifiedBy: call.verifiedBy,
      verification: v ? {
        email: v.email, channel: v.channel, sentAt: new Date(v.sentAt).toISOString(), expiresAt: new Date(v.expiresAt).toISOString(),
        attempts: v.attempts, failures: v.failures, lastResult: v.lastResult, callerIdMatches: v.callerIdMatches,
      } : null,
      domain: call.domain, topicId: call.topicId, topicLabel: this.taxonomy.get(call.topicId)?.label ?? null, classification: call.classification,
      pendingClarification: call.pendingClarification ? { question: call.pendingClarification.question, candidates: call.pendingClarification.candidates } : null,
      pendingAction: call.pendingAction?.type ?? null, sensitive: call.sensitive,
      pendingProposal: call.pendingProposal ? this.#proposalView(call.pendingProposal) : null,
      lastTicket: ticketView(call.lastTicket), lastArticle: article ? { id: article.id, title: article.title } : null,
      lastSpoken: call.lastSpoken == null ? null : scrub(call.lastSpoken),
      transcript: call.transcript.map((t) => ({ ...t, text: scrub(t.text) })),
      handoff: scrubDeep(call.handoff), outcome: call.outcome,
      elapsedMs: call.answeredAt ? Math.max(0, (call.endedAt ?? this.now().getTime()) - call.answeredAt) : 0, budgetMs: this.options.timeBudgetMs,
    };
  }

  pushTranscript(id, role, text, { sensitive = false } = {}) {
    const call = this.#require(id);
    const raw = String(text ?? "");
    const at = this.now().toISOString();
    call.transcript.push({ role, text: raw, at });
    if (call.transcript.length > 200) call.transcript.shift();
    const safe = scrub(raw);
    this.audit.recordTranscript(call.id, role, safe, { sensitive });
    // A live console never receives a one-time code, even one the caller read out.
    this.hub?.send(call.id, "transcript", { role, text: call.simulation ? raw : safe, at });
  }

  #require(id) {
    const call = this.calls.get(id);
    if (!call) throw new Error(`unknown call ${id}`);
    return call;
  }

  #speak(call, text) {
    call.lastSpoken = text;
    const agent = this.agents.get(call.id);
    // Live calls get the agent's words from the voice transcript; only push them here when nothing else will.
    if (call.simulation || !agent?.say) this.pushTranscript(call.id, "agent", text);
    agent?.say?.(text);
  }

  #setTopic(call, topic) {
    call.topicId = topic.id;
    call.domain = topic.domain;
    this.audit.updateCall(call.id, { domain: topic.domain, topicId: topic.id });
  }

  #event(call, source, kind, detail = null) {
    const at = this.now().toISOString();
    const text = detail == null ? null : String(detail);
    this.audit.recordEvent(call.id, source, kind, text, at);
    this.hub?.send(call.id, "event", { source, kind, detail: text, at });
  }

  /** Always publishes a fresh snapshot, even when the state is unchanged. */
  #setState(call, state) {
    if (call.state !== state) {
      const from = call.state;
      call.state = state;
      this.audit.updateCall(call.id, { state });
      this.#event(call, "system", "state", `${from} → ${state}`);
    }
    this.#touch(call);
  }

  #touch(call) { this.hub?.send(call.id, "state", this.snapshot(call.id)); }

  #finish(call, state, outcome) {
    call.endedAt = this.now().getTime();
    call.outcome = outcome;
    this.audit.updateCall(call.id, { outcome, endedAt: new Date(call.endedAt).toISOString(), durationMs: call.endedAt - call.startedAt });
    this.#setState(call, state);
  }
}

function capitalize(text) { const s = String(text ?? ""); return s ? `${s[0].toUpperCase()}${s.slice(1)}` : s; }

/**
 * Text the server asks the voice model to speak. Serial digits are dropped so
 * the model never sees them; the simulated console still shows the full read-back.
 */
export function forModel(text) { return redactCodes(text).replace(/,? ending in \d{4}\b/gi, ""); }
