import { randomUUID } from "node:crypto";
import { config, fixtures } from "./config.mjs";
import { hydratePatient } from "./schedule-store.mjs";

export const STATES = Object.freeze({
  RINGING: "ringing", GREETING: "greeting", HANDOFF_TOKEN: "handoff_token", VERIFYING: "verifying", VERIFIED: "verified", CHOOSE_ACTION: "choose_action", REASON: "reason", VISIT_TYPE: "visit_type", ELIGIBILITY: "eligibility", SEARCHING: "searching", OFFERING: "offering", HOLDING: "holding", READ_BACK: "read_back", BOOKED: "booked", PREP: "prep", CONFIRM_MESSAGE: "confirm_message", CANCELLING: "cancelling", CANCELLED: "cancelled", WAITLISTED: "waitlisted", ESCALATING: "escalating", CALLBACK_FILED: "callback_filed", WRAP_UP: "wrap_up", CLOSING: "closing", ENDED: "ended"
});
const TERMINAL = new Set([STATES.ENDED, STATES.BOOKED, STATES.CANCELLED, STATES.ESCALATING, STATES.CALLBACK_FILED, STATES.WAITLISTED]);

export class AppointmentSchedulingFlow {
  constructor({ schedule, audit, transfer = null, hub = null, now = () => new Date(config.demoNow), options = {} } = {}) {
    this.schedule = schedule;
    this.audit = audit;
    this.transferHandler = transfer;
    this.hub = hub;
    this.now = now;
    this.options = { callTimeBudgetMs: config.callTimeBudgetMs, optionsPerTurn: config.schedule.optionsPerTurn, ...options };
    this.calls = new Map();
    this.agents = new Map();
  }

  create({ callId = randomUUID(), fromPhone = null, callContext = null, sessionId = null } = {}) {
    const call = { id: callId, sessionId: sessionId ?? callContext?.sessionId ?? callId, fromPhone, state: STATES.RINGING, verified: false, patientId: null, patientFirstName: null, verificationAttempts: 0, noInputs: 0, startedAt: this.now().getTime(), answeredAt: null, endedAt: null, outcome: null, transcript: [], options: [], held: null, currentVisitType: null, action: "book", reasonNoted: false, reasonLocked: false, appointmentHandles: [], cancelProposal: null, handoff: null, lastPhrase: null, eligibility: null, selfPayAcknowledged: false, stats: { reminderHandoff: Boolean(callContext?.patientRef) } };
    this.calls.set(call.id, call);
    this.audit.startCall?.({ id: call.id, state: call.state, startedAt: new Date(call.startedAt).toISOString() });
    this.#event(call, "system", "call_created", callContext?.intent ?? "inbound");
    if (callContext?.patientRef) this.redeemHandoff(call.id, callContext);
    return call;
  }
  get(callId) { return this.calls.get(callId) ?? null; }
  registerAgent(callId, handle) { this.agents.set(callId, handle); }
  unregisterAgent(callId) { this.agents.delete(callId); }

  answered(callId) {
    const call = this.#require(callId);
    call.answeredAt = this.now().getTime();
    if (call.verified && call.action === "reschedule") {
      this.#setState(call, STATES.CHOOSE_ACTION);
      return this.#say(call, `Hi, ${call.patientFirstName}. I can help you find a new time for ${call.handoff.appointmentSummary}. What days work better?`);
    }
    this.#setState(call, STATES.GREETING);
    return this.#say(call, "Hi, you've reached Contoso Health scheduling. I'm an automated assistant. I can book, change, or cancel an appointment. What can I help you with?");
  }

  redeemHandoff(callId, context = {}) {
    const call = this.#require(callId);
    this.#setState(call, STATES.HANDOFF_TOKEN);
    const result = this.schedule.redeemHandoffToken({ token: context.patientRef, correlationId: context.sessionId ?? call.sessionId });
    if (!result.ok) {
      call.handoff = { ok: false, reason: result.reason };
      this.#event(call, "system", "handoff_invalid", result.reason);
      this.#setState(call, STATES.VERIFYING);
      return { ok: false, status: "invalid", reason: result.reason };
    }
    call.verified = true;
    call.patientId = result.patient.patientId;
    call.patientFirstName = result.patient.firstName;
    call.action = context.intent === "reschedule" ? "reschedule" : "book";
    call.appointmentHandles = [{ handle: result.appointment.appointmentId, appointmentId: result.appointment.appointmentId, spoken: appointmentSummary(result.appointment) }];
    call.handoff = { ok: true, appointmentId: result.appointment.appointmentId, appointmentSummary: appointmentSummary(result.appointment) };
    this.audit.updateCall?.(call.id, { verified: true });
    this.#event(call, "system", "handoff_redeemed", result.appointment.appointmentId);
    this.#setState(call, STATES.VERIFIED);
    return { ok: true, status: "redeemed", appointment: call.handoff.appointmentSummary };
  }

  verifyPatient(callId, { fullName, dob, proxyName = null } = {}) {
    const call = this.#require(callId);
    if (call.verified) return { ok: true, status: "verified", patientId: call.patientId, firstName: call.patientFirstName };
    this.#setState(call, STATES.VERIFYING);
    const wanted = normalizeName(fullName);
    const patients = this.schedule.db.prepare(`SELECT * FROM patients`).all().map(hydratePatient);
    const patient = patients.find((p) => normalizeName(`${p.firstName} ${p.lastName}`) === wanted && normalizeDob(dob) === normalizeDob(p.dob));
    if (!patient) {
      const byName = patients.find((p) => normalizeName(`${p.firstName} ${p.lastName}`) === wanted);
      const authorizedProxy = byName?.proxies?.find((p) => normalizeName(p.name) === wanted && p.authorized);
      call.verificationAttempts += 1;
      if (authorizedProxy) return { ok: false, status: "proxy_ask_dob" };
      if (!byName) return { ok: false, status: "not_found", say: "New patients are set up by our registration team. What's the best number and time for them to call you?" };
      if (call.verificationAttempts >= 2) return this.transfer(callId, "scheduling_team", "verification_failed");
      return { ok: false, status: "retry", say: "I'm sorry, that didn't match. Please try the patient's full name and date of birth one more time." };
    }
    if (proxyName) {
      const proxy = patient.proxies?.find((p) => normalizeName(p.name) === normalizeName(proxyName));
      if (!proxy?.authorized) return this.transfer(callId, "scheduling_team", "unauthorized_proxy");
    }
    call.verified = true;
    call.patientId = patient.patientId;
    call.patientFirstName = patient.firstName;
    this.audit.updateCall?.(call.id, { verified: true });
    this.#setState(call, STATES.VERIFIED);
    this.#say(call, `Thanks, ${patient.firstName}. What kind of visit do you need, and what's it for?`);
    return { ok: true, status: "verified", patientId: patient.patientId, firstName: patient.firstName };
  }

  listUpcoming(callId) {
    const call = this.#require(callId);
    if (!call.verified) return { ok: false, reason: "not_verified" };
    const appointments = this.schedule.listUpcoming({ patientId: call.patientId, from: this.now().toISOString() });
    call.appointmentHandles = appointments.map((a) => ({ handle: a.appointmentId, appointmentId: a.appointmentId, spoken: appointmentSummary(a) }));
    return { ok: true, appointments: call.appointmentHandles };
  }

  noteReason(callId, text) {
    const call = this.#require(callId);
    if (!call.verified) return { ok: false, reason: "not_verified" };
    call.reasonNoted = true;
    const s = String(text).toLowerCase();
    if (fixtures.safety.emergency.some((p) => s.includes(p))) {
      call.reasonLocked = true;
      this.#setState(call, STATES.ESCALATING);
      return { ok: true, status: "emergency", say: "If this is an emergency, please hang up and call 911.", transfer: this.transfer(callId, "nurse_line", "emergency_phrase") };
    }
    if (fixtures.safety.urgent.some((p) => s.includes(p))) {
      call.reasonLocked = true;
      const say = "I can't book that by voice until a nurse is involved. I can connect you to the nurse line.";
      this.#say(call, say);
      return { ok: true, status: "urgent", say, transfer: this.transfer(callId, "nurse_line", "urgent_phrase") };
    }
    this.#setState(call, STATES.VISIT_TYPE);
    return { ok: true, status: "ok" };
  }

  chooseVisitType(callId, code, { selfPayAcknowledged = false } = {}) {
    const call = this.#require(callId);
    if (!call.verified) return { ok: false, reason: "not_verified" };
    call.selfPayAcknowledged ||= selfPayAcknowledged;
    const result = evaluateEligibility({ schedule: this.schedule, patient: this.schedule.getPatient(call.patientId), visitTypeCode: code, now: this.now(), selfPayAcknowledged: call.selfPayAcknowledged });
    call.currentVisitType = code;
    call.eligibility = result;
    this.#setState(call, STATES.ELIGIBILITY);
    if (!result.eligible) {
      this.#say(call, result.say);
      return { ok: true, status: "blocked", ...result };
    }
    this.#say(call, "I can look for times. Do you prefer a location, provider, day, or time of day?");
    return { ok: true, status: "eligible", eligible: true };
  }

  searchSlots(callId, preferences = {}) {
    const call = this.#require(callId);
    if (!call.verified) return { ok: false, reason: "not_verified" };
    if (!call.currentVisitType) return { ok: false, reason: "missing_visit_type" };
    if (!call.eligibility?.eligible) return { ok: false, reason: "eligibility_blocked" };
    this.#setState(call, STATES.SEARCHING);
    const result = this.schedule.searchSlots({ patientId: call.patientId, visitTypeCode: call.currentVisitType, preferences, limit: this.options.optionsPerTurn });
    call.options = result.options;
    this.#setState(call, STATES.OFFERING);
    if (!result.options.length) return { ok: true, options: [], say: "I don't see anything in the access target. I can try another provider or add you to the waitlist." };
    const say = `${result.options.map((o, i) => `${i + 1}. ${o.spoken}`).join("; ")}. Would either of those work?`;
    this.#say(call, say);
    return { ok: true, ...result, say };
  }

  holdSlot(callId, optionId) {
    const call = this.#require(callId);
    if (!call.verified) return { ok: false, reason: "not_verified" };
    if (!call.eligibility?.eligible) return { ok: false, reason: "eligibility_blocked" };
    const option = call.options.find((o) => o.optionId === optionId) ?? (Number.isInteger(optionId) ? call.options[optionId] : null);
    if (!option) return { ok: false, reason: "unknown_option" };
    this.#setState(call, STATES.HOLDING);
    const result = this.schedule.holdSlot(option, { patientId: call.patientId, idempotencyKey: `call:${call.id}:hold:${option.optionId}` });
    if (!result.ok) {
      this.#event(call, "system", "slot_taken", option.optionId);
      this.#setState(call, STATES.OFFERING);
      return { ok: false, error: result.error, say: "Sorry, that time was just taken. I can offer the next options." };
    }
    call.held = result;
    this.#setState(call, STATES.READ_BACK);
    const say = `To confirm: ${result.readBack}. Shall I book it?`;
    this.#say(call, say);
    return { ok: true, status: "held", ...result, say };
  }

  book(callId, { holdId = null, confirmation, reason = null, idempotencyKey = null } = {}) {
    const call = this.#require(callId);
    if (!call.verified) return { ok: false, reason: "not_verified" };
    if (call.reasonLocked) return { ok: false, reason: "safety_locked" };
    if (!call.eligibility?.eligible) return { ok: false, reason: "eligibility_blocked" };
    if (!isAffirmative(confirmation)) return { ok: false, reason: "needs_explicit_yes" };
    const result = this.schedule.bookAppointment({ holdId: holdId ?? call.held?.holdId, patientId: call.patientId, reason, idempotencyKey: idempotencyKey ?? `call:${call.id}:book:${holdId ?? call.held?.holdId}` });
    if (!result.ok) return result;
    this.#setState(call, STATES.BOOKED);
    const prep = prepText(result.appointment.prepCode, this.schedule.getPatient(call.patientId).preferredLanguage);
    const channel = confirmationChannel(this.schedule.getPatient(call.patientId));
    this.#say(call, `You're booked. ${prep} ${channel.say}`);
    this.#finish(call, STATES.BOOKED, "booked");
    return { ok: true, appointment: result.appointment, prep, confirmation: channel };
  }

  reschedule(callId, { holdId = null, appointmentHandle = null, confirmation, reason = null, idempotencyKey = null } = {}) {
    const call = this.#require(callId);
    if (!call.verified) return { ok: false, reason: "not_verified" };
    if (!isAffirmative(confirmation)) return { ok: false, reason: "needs_explicit_yes" };
    const handle = appointmentHandle ?? call.appointmentHandles[0]?.handle;
    const result = this.schedule.rescheduleAppointment({ appointmentId: handle, holdId: holdId ?? call.held?.holdId, patientId: call.patientId, reason, idempotencyKey: idempotencyKey ?? `call:${call.id}:reschedule:${handle}:${holdId ?? call.held?.holdId}` });
    if (!result.ok) return result;
    this.#finish(call, STATES.BOOKED, "rescheduled");
    return result;
  }

  proposeCancel(callId, { appointmentHandle = null, reasonCode = "patient_requested" } = {}) {
    const call = this.#require(callId);
    if (!call.verified) return { ok: false, reason: "not_verified" };
    const handle = appointmentHandle ?? this.listUpcoming(callId).appointments[0]?.handle;
    const appt = this.schedule.getAppointment(handle);
    const late = (new Date(appt.start) - this.now()) / 3_600_000 < 24;
    const notice = late ? fixtures.clinics.locations[appt.location]?.lateCancellation?.en : null;
    const proposalId = randomUUID();
    const say = `${notice ? `${notice} ` : ""}I can cancel ${appointmentSummary(appt)}. Should I cancel it?`;
    call.cancelProposal = { proposalId, appointmentId: appt.appointmentId, reasonCode };
    this.#setState(call, STATES.CANCELLING);
    this.#say(call, say);
    return { ok: true, proposalId, lateCancellation: Boolean(late), say };
  }

  cancel(callId, { proposalId, confirmation, idempotencyKey = null } = {}) {
    const call = this.#require(callId);
    if (!call.verified) return { ok: false, reason: "not_verified" };
    if (!call.cancelProposal || call.cancelProposal.proposalId !== proposalId) return { ok: false, reason: "missing_proposal" };
    if (!isAffirmative(confirmation)) return { ok: false, reason: "needs_explicit_yes" };
    const result = this.schedule.cancelAppointment(call.cancelProposal.appointmentId, call.cancelProposal.reasonCode, idempotencyKey ?? `call:${call.id}:cancel:${proposalId}`);
    this.#finish(call, STATES.CANCELLED, "cancelled");
    return result;
  }

  addWaitlist(callId, preferences = {}) {
    const call = this.#require(callId);
    if (!call.verified) return { ok: false, reason: "not_verified" };
    const result = this.schedule.addWaitlist({ patientId: call.patientId, visitTypeCode: call.currentVisitType, preferences });
    this.#finish(call, STATES.WAITLISTED, "waitlisted");
    return result;
  }

  requestCallback(callId, queue = "scheduling_team") { const call = this.#require(callId); this.#finish(call, STATES.CALLBACK_FILED, `callback:${queue}`); return { ok: true, queue }; }
  transfer(callId, destination = "scheduling_team", reason = "caller_request") { const call = this.#require(callId); this.#setState(call, STATES.ESCALATING); this.#event(call, "system", "transfer", `${destination}:${reason}`); return { ok: true, action: this.transferHandler ? "transfer" : "simulated_transfer", destination, context: this.handoffContext(call, destination, reason) }; }
  repeatLast(callId) { const call = this.#require(callId); if (call.lastPhrase) this.#say(call, call.lastPhrase); return { ok: true, say: call.lastPhrase }; }
  dtmf(callId, digit) { const call = this.#require(callId); if (digit === "1") return this.holdSlot(callId, call.options[0]?.optionId); if (digit === "2") return this.holdSlot(callId, call.options[1]?.optionId); if (digit === "3") return this.searchSlots(callId, { skip: call.options.length }); if (digit === "0") return this.transfer(callId, "scheduling_team", "dtmf"); if (digit === "*") return this.repeatLast(callId); return { ok: false, reason: "unknown_digit" }; }
  noInput(callId) { const call = this.#require(callId); call.noInputs += 1; if (call.noInputs >= 2) return this.transfer(callId, "scheduling_team", "two_no_inputs"); return this.#say(call, "I'm sorry, I didn't catch that."); }
  checkBudget(callId) { const call = this.get(callId); if (!call?.answeredAt || TERMINAL.has(call.state)) return { ok: true }; const elapsed = this.now().getTime() - call.answeredAt; if (elapsed >= this.options.callTimeBudgetMs) { if (call.held?.holdId) this.schedule.releaseHold(call.held.holdId); return this.#finish(call, STATES.ENDED, "call_cap"); } if (elapsed >= this.options.callTimeBudgetMs - 60_000 && call.state !== STATES.WRAP_UP) { this.#setState(call, STATES.WRAP_UP); this.#say(call, "We have about a minute left, so I'll help with the main appointment choice now."); } return { ok: true }; }
  endCall(callId, outcome = "agent_ended") { const call = this.get(callId); if (!call || TERMINAL.has(call.state)) return { ok: true }; if (call.held?.holdId) this.schedule.releaseHold(call.held.holdId); return this.#finish(call, STATES.ENDED, outcome); }
  pushTranscript(callId, role, text) { const call = this.get(callId); if (!call || !text) return; const masked = maskTranscript(text); call.transcript.push({ role, text: masked, at: this.now().toISOString() }); this.audit.recordTranscript?.(callId, role, masked); this.#publish(call, "transcript", { role, text: masked }); }
  recordAgentAction(callId, { tool, ok = true, detail = null }) { const call = this.get(callId); if (call) this.#event(call, "agent", ok ? "tool" : "tool_rejected", detail ? `${tool}: ${detail}` : tool); }
  snapshot(callId) { const call = this.get(callId); if (!call) return null; return { id: call.id, state: call.state, verified: call.verified, patient: call.patientFirstName ? `${call.patientFirstName} ${this.schedule.getPatient(call.patientId)?.lastName?.[0] ?? ""}.` : null, action: call.action, currentVisitType: call.currentVisitType, eligibility: call.eligibility, options: call.options.map((o) => ({ optionId: o.optionId, spoken: o.spoken })), held: call.held ? { holdId: call.held.holdId, expiresAt: call.held.expiresAt, readBack: call.held.readBack } : null, outcome: call.outcome, lastPhrase: call.lastPhrase, handoff: call.handoff, transcript: call.transcript }; }
  handoffContext(call, destination = "scheduling_team", reason = null) { return { sessionId: call.sessionId, callTopic: fixtures.routing.destinations[destination]?.topic ?? "Scheduling", callContext: { firstName: call.patientFirstName, verified: call.verified, visitType: call.currentVisitType, eligibility: call.eligibility?.ruleId ?? "passed", heldSlot: call.held ? { readBack: call.held.readBack, expiresAt: call.held.expiresAt } : null, reason } }; }

  #require(id) { const call = this.calls.get(id); if (!call) throw new Error(`unknown call ${id}`); return call; }
  #setState(call, state) { if (call.state === state) return; const from = call.state; call.state = state; this.audit.updateCall?.(call.id, { state }); this.#event(call, "system", "state", `${from} → ${state}`); this.#publish(call, "state", this.snapshot(call.id)); }
  #say(call, text) { call.lastPhrase = text; this.pushTranscript(call.id, "agent", text); this.agents.get(call.id)?.instruct?.(text, text); return { ok: true, say: text }; }
  #event(call, source, kind, detail = null) { this.audit.recordEvent?.(call.id, source, kind, detail); this.#publish(call, "event", { source, kind, detail, at: this.now().toISOString() }); }
  #publish(call, target, payload) { this.hub?.send?.(call.id, target, payload); }
  #finish(call, state, outcome) { call.outcome = outcome; call.endedAt = this.now().getTime(); this.#setState(call, state); this.audit.updateCall?.(call.id, { outcome, endedAt: new Date(call.endedAt).toISOString(), durationMs: call.endedAt - call.startedAt }); this.#event(call, "system", "outcome", outcome); return { ok: true, outcome, state: call.state, say: call.lastPhrase }; }
}

export function handleUtterance(flow, callId, text) {
  const said = String(text ?? "").trim();
  const call = flow.get(callId);
  if (!call) return { ok: false, reason: "unknown_call" };
  if (!said) return flow.noInput(callId);
  flow.pushTranscript(callId, "caller", said);
  if (/^[0123*]$/.test(said)) return flow.dtmf(callId, said);
  if (/\b(person|human|representative|scheduler|someone)\b/i.test(said)) return flow.transfer(callId, "scheduling_team", "caller_request");
  if (!call.verified) {
    const parsed = parseIdentity(said);
    if (parsed) return flow.verifyPatient(callId, parsed);
    return { ok: true, say: "Can I have the patient's full name and date of birth?" };
  }
  if (/\b(cancel)\b/i.test(said)) { const upcoming = flow.listUpcoming(callId); return flow.proposeCancel(callId, { appointmentHandle: upcoming.appointments[0]?.handle }); }
  if (/\b(reschedule|change)\b/i.test(said)) { call.action = "reschedule"; flow.listUpcoming(callId); return { ok: true, say: "I can help find a new time. What kind of appointment should I search for?" }; }
  if (!call.reasonNoted) return flow.noteReason(callId, said);
  if (!call.currentVisitType || !call.eligibility?.eligible) {
    const code = chooseCode(said);
    return flow.chooseVisitType(callId, code, { selfPayAcknowledged: /self.?pay|pay myself/i.test(said) });
  }
  if (!call.options.length) return flow.searchSlots(callId, parsePreferences(said, flow.schedule.getPatient(call.patientId)));
  if (!call.held && /\b(first|1|one)\b/i.test(said)) return flow.holdSlot(callId, call.options[0]?.optionId);
  if (!call.held && /\b(second|2|two)\b/i.test(said)) return flow.holdSlot(callId, call.options[1]?.optionId);
  if (call.held) return call.action === "reschedule" ? flow.reschedule(callId, { confirmation: said }) : flow.book(callId, { confirmation: said, reason: "stored server-side" });
  return flow.searchSlots(callId, parsePreferences(said, flow.schedule.getPatient(call.patientId)));
}

export function evaluateEligibility({ schedule, patient, visitTypeCode, now = new Date(config.demoNow), selfPayAcknowledged = false }) {
  const visit = fixtures.visitTypes[visitTypeCode];
  const language = patient?.preferredLanguage ?? "en";
  if (!visit) return block("UNKNOWN_VISIT_TYPE", "I can't book that visit type by voice.", []);
  if (patient?.insurance?.status === "inactive" && !selfPayAcknowledged) return ruleBlock("INSURANCE_INACTIVE", language);
  if (visitTypeCode === "ANNUAL_PHYSICAL") {
    const last = schedule.listUpcoming({ patientId: patient.patientId, from: new Date(now.getTime() - 365 * 86_400_000).toISOString(), to: now.toISOString(), statuses: ["booked", "confirmed", "completed"] }).find((a) => normalizeVisit(a.visitType) === "annual physical");
    if (last) return ruleBlock("ANNUAL_TOO_SOON", language);
  }
  if (visit.requiresReferral) {
    const ok = fixtures.referrals.referrals.some((r) => r.patientId === patient.patientId && r.department === visit.department && r.status === "active" && new Date(`${r.expires}T23:59:59-07:00`) > now);
    if (!ok) return ruleBlock("REFERRAL_REQUIRED", language);
  }
  if (visit.requiresOrder) {
    const ok = fixtures.orders.orders.some((o) => o.patientId === patient.patientId && o.modality.toLowerCase() === visit.requiresOrder.toLowerCase() && o.status === "active" && new Date(`${o.expires}T23:59:59-07:00`) > now);
    if (!ok) return ruleBlock("ORDER_REQUIRED", language);
  }
  return { eligible: true, visitTypeCode, prepCode: visit.prepCode };
}

export function isAffirmative(text) { const s = String(text).toLowerCase(); return /\b(yes|yeah|yep|correct|right|sure|please|ok|okay|confirm|book it|sí|si)\b/.test(s) && !/\b(no|nope|not|maybe|don't|do not)\b/.test(s); }
export function normalizeDob(value) { const s = String(value ?? "").trim().toLowerCase(); if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; const digits = s.replace(/\D/g, ""); if (digits.length === 8 && /^(19|20)\d{6}$/.test(digits)) return `${digits.slice(0,4)}-${digits.slice(4,6)}-${digits.slice(6,8)}`; if (digits.length === 8) return `${digits.slice(4)}-${digits.slice(0,2)}-${digits.slice(2,4)}`; const parsed = new Date(s); return Number.isNaN(parsed.getTime()) ? s.replace(/[^a-z0-9]/g, "") : parsed.toISOString().slice(0,10); }
function normalizeName(value) { return String(value ?? "").toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim(); }
function ruleBlock(ruleId, language = "en") { const rule = fixtures.eligibility.rules.find((r) => r.id === ruleId); return { eligible: false, ruleId, say: rule?.explain?.[language] ?? rule?.explain?.en ?? ruleId, alternatives: rule?.alternatives ?? [] }; }
function block(ruleId, say, alternatives) { return { eligible: false, ruleId, say, alternatives }; }
function normalizeVisit(v) { return String(v).toLowerCase(); }
function prepText(code, language = "en") { return fixtures.prep[code]?.[language] ?? fixtures.prep[code]?.en ?? "Please follow the clinic instructions."; }
function confirmationChannel(patient) { return patient?.consent?.sms ? { channel: "sms", say: config.sms.enabled ? "I've sent a text with the details." : "In demo mode, the confirmation text is logged instead of sent." } : { channel: "spoken", say: `Your confirmation number is ${String(Math.floor(10000 + Math.random() * 90000)).split("").join("-")}.` }; }
function appointmentSummary(appt) { return `${appt.visitType ?? appt.department} with ${appt.provider?.name ?? "your provider"} on ${spokenDateTime(appt.start)} at ${fixtures.clinics.locations[appt.location]?.displayName ?? appt.location}`; }
function spokenDateTime(iso) { return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }).format(new Date(iso)); }
function parseIdentity(text) { const dob = String(text).match(/(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{8}|\d{4}-\d{2}-\d{2})/); if (!dob) return null; const fullName = String(text).replace(dob[0], "").replace(/\b(my name is|this is|patient is|dob|date of birth|born)\b/gi, " ").trim(); return fullName ? { fullName, dob: dob[0] } : null; }
function chooseCode(text) { const s = String(text).toLowerCase(); if (s.includes("skin") || s.includes("derm")) return "DERM_SKIN_CHECK"; if (s.includes("mri")) return "MRI"; if (s.includes("ultra")) return "ULTRASOUND"; if (s.includes("x-ray") || s.includes("xray")) return "XRAY"; if (s.includes("annual") || s.includes("physical")) return "ANNUAL_PHYSICAL"; if (s.includes("follow")) return "FOLLOW_UP"; return "NEW_PROBLEM"; }
function parsePreferences(text, patient) { const s = String(text).toLowerCase(); return { timeOfDay: s.includes("morning") ? "morning" : s.includes("afternoon") ? "afternoon" : undefined, usualDoctor: /usual|my doctor|primary/.test(s), providerId: s.includes("patel") ? "prov-patel" : s.includes("nguyen") ? "prov-nguyen" : undefined, location: s.includes("phoenix") ? "phoenix-downtown" : s.includes("northgate") || patient?.timeZone?.includes("Los_Angeles") ? "seattle-northgate" : undefined } ; }
function maskTranscript(text) { return String(text).replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, "[date]").replace(/\b\d{8}\b/g, "[date]").replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, "[name]"); }
