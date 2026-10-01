import { randomUUID } from "node:crypto";
import { config, fixtures } from "./config.mjs";

export const STATES = Object.freeze({
  DIALING: "dialing", CONNECTED: "connected", DETECTING: "detecting", GREETING: "greeting", RIGHT_PARTY: "right_party", VERIFYING: "verifying", PRESENTING: "presenting", CONFIRMING: "confirming", CONFIRMED: "confirmed", CANCEL_REASON: "cancel_reason", CANCEL_CONFIRM: "cancel_confirm", CANCELLED: "cancelled", RESCHEDULE: "reschedule", TRANSFERRING: "transferring", OPT_OUT: "opt_out", CLINICAL: "clinical", DTMF_MENU: "dtmf_menu", WRAP_UP: "wrap_up", CLOSING: "closing", ENDED: "ended", VOICEMAIL: "voicemail", RETRY_SCHEDULED: "retry_scheduled", SKIPPED: "skipped"
});
const TERMINAL = new Set([STATES.ENDED, STATES.CONFIRMED, STATES.CANCELLED, STATES.TRANSFERRING, STATES.OPT_OUT]);

export class AppointmentReminderFlow {
  constructor({ schedule, audit, transfer = null, hub = null, now = () => new Date(config.demoNow), options = {} } = {}) {
    this.schedule = schedule;
    this.audit = audit;
    this.transfer = transfer;
    this.hub = hub;
    this.now = now;
    this.options = { callTimeBudgetMs: config.callTimeBudgetMs, ...options };
    this.calls = new Map();
    this.agents = new Map();
  }

  buildDialPlan({ now = this.now(), dryRun = true } = {}) {
    const c = fixtures.campaign;
    const candidates = this.schedule.listReminderCandidates({ now, leadTimeHours: c.leadTimeHours, leadWindowHours: c.leadWindowHours });
    return candidates.map((appointment) => {
      const gate = this.evaluateDialEligibility(appointment, { now, dryRun });
      return { appointmentId: appointment.appointmentId, patientName: maskName(appointment.patient), department: appointment.department, localTime: localDateTime(appointment.start, appointment.patient.timeZone), attempt: gate.attempt, state: gate.ok ? "scheduled" : "skipped", skipReason: gate.ok ? null : gate.reason, nextAttemptAt: gate.nextAttemptAt ?? null };
    });
  }

  evaluateDialEligibility(appointment, { now = this.now(), dryRun = true } = {}) {
    const patient = appointment.patient;
    const phone = primaryPhone(patient);
    if (!patient?.consent?.voice) return { ok: false, reason: "no_consent", attempt: 0 };
    if (patient.preferredChannel !== "voice") return { ok: false, reason: "channel", attempt: 0 };
    if (this.schedule.isSuppressed(patient.patientId)) return { ok: false, reason: "suppressed", attempt: 0 };
    if (patient.flags?.tty || /hearing/i.test(patient.flags?.communication ?? "")) return { ok: false, reason: "tty", attempt: 0 };
    if (!phone || phone.status === "bad") return { ok: false, reason: "bad_number", attempt: 0 };
    if (!dryRun && config.allowedTestNumbers.length && !config.allowedTestNumbers.includes(phone.number)) return { ok: false, reason: "not_allowlisted", attempt: 0 };
    const clinic = fixtures.clinics.locations[appointment.location];
    if (isHoliday(now, clinic?.holidays ?? [], patient.timeZone)) return { ok: false, reason: "holiday", attempt: 0 };
    if (!insideWindow(now, patient.timeZone, fixtures.campaign.callingWindow)) return { ok: false, reason: "calling_window", attempt: 0 };
    const hoursToStart = (new Date(appointment.start) - now) / 3600_000;
    if (hoursToStart <= fixtures.campaign.cutoffHoursBeforeAppointment) return { ok: false, reason: "cutoff", attempt: 0 };
    const attempts = this.schedule.attemptsFor(appointment.appointmentId);
    const attempt = attempts.length + 1;
    if (attempt > fixtures.campaign.maxAttempts) return { ok: false, reason: "attempts", attempt };
    const last = attempts.at(-1);
    if (last) {
      const since = (now - new Date(last.created_at)) / 3600_000;
      if (since < fixtures.campaign.minSpacingHours) return { ok: false, reason: "spacing", attempt, nextAttemptAt: new Date(new Date(last.created_at).getTime() + fixtures.campaign.minSpacingHours * 3600_000).toISOString() };
    }
    return { ok: true, reason: "eligible", attempt };
  }

  create({ appointmentId, direction = "outbound", callId = randomUUID(), attempt = null, sessionId = null } = {}) {
    const appointment = this.schedule.getAppointment(appointmentId);
    if (!appointment) throw new Error(`unknown appointment ${appointmentId}`);
    const patient = appointment.patient;
    const call = { id: callId, appointmentId, patientId: patient.patientId, appointment, patientFirstName: patient.firstName, direction, sessionId: sessionId ?? callId, state: direction === "outbound" ? STATES.DIALING : STATES.GREETING, attempt: attempt ?? this.schedule.attemptsFor(appointmentId).length + 1, verified: false, proxyName: null, dobAttempts: 0, noInputs: 0, startedAt: this.now().getTime(), answeredAt: null, endedAt: null, outcome: null, transcript: [], lastPhrase: null, cancelProposal: null, handoff: null };
    this.calls.set(call.id, call);
    this.audit.startCall?.(call);
    this.#event(call, "system", "call_created", direction);
    return call;
  }

  get(callId) { return this.calls.get(callId) ?? null; }
  registerAgent(callId, handle) { this.agents.set(callId, handle); }
  unregisterAgent(callId) { this.agents.delete(callId); }

  answered(callId) {
    const call = this.#require(callId);
    call.answeredAt = this.now().getTime();
    this.#setState(call, STATES.DETECTING);
    return call;
  }

  applyDialOutcome(callId, outcome, { greetingText = "", greetingMs = 0, beep = false } = {}) {
    const call = this.#require(callId);
    const appointment = call.appointment;
    const patient = appointment.patient;
    if (outcome === "busy" || outcome === "no_answer") return this.#retry(call, outcome);
    if (outcome === "bad_number") return this.#finish(call, STATES.ENDED, "bad_number", "bad number flagged for staff");
    if (outcome === "voicemail" || detectVoicemail({ text: greetingText, durationMs: greetingMs, beep, locale: patient.preferredLanguage }).voicemail) {
      return this.handleVoicemail(call.id, { text: greetingText, durationMs: greetingMs, beep });
    }
    this.#setState(call, STATES.GREETING);
    return this.#say(call, script(patient, "opening", { firstName: patient.firstName, callbackNumber: callbackNumber(appointment) }));
  }

  handleVoicemail(callId, signal = {}) {
    const call = this.#require(callId);
    const lastAttempt = call.attempt >= fixtures.campaign.maxAttempts;
    const decision = detectVoicemail({ ...signal, locale: call.appointment.patient.preferredLanguage });
    this.#setState(call, STATES.VOICEMAIL);
    if (!lastAttempt || !fixtures.campaign.voicemailOnLastAttempt) {
      this.schedule.recordAttempt({ appointmentId: call.appointmentId, patientId: call.patientId, state: "voicemail", outcome: "voicemail_hangup", attempt: call.attempt, detail: decision.reason });
      return this.#finish(call, STATES.ENDED, "voicemail_hangup", decision.reason);
    }
    const text = script(call.appointment.patient, "voicemail", { firstName: call.appointment.patient.firstName, callbackNumber: callbackNumber(call.appointment) });
    this.schedule.recordAttempt({ appointmentId: call.appointmentId, patientId: call.patientId, state: "voicemail", outcome: "voicemail_left", attempt: call.attempt, detail: decision.reason });
    this.#say(call, text);
    return this.#finish(call, STATES.ENDED, "voicemail_left", decision.reason);
  }

  confirmIdentity(callId, { isPatient = false, proxyName = null, text = "" } = {}) {
    const call = this.#require(callId);
    const patient = call.appointment.patient;
    if (!isPatient && /\b(no|not|wrong|brother|sister|friend|roommate)\b/i.test(text)) {
      const proxy = proxyName ? findProxy(patient, proxyName) : findProxyInText(patient, text);
      if (!proxy) return this.#wrongParty(call, "wrong_party");
    }
    if (isPatient || /\b(yes|speaking|this is|soy|sí|si)\b/i.test(text)) {
      this.#setState(call, STATES.VERIFYING);
      return this.#say(call, script(patient, "askDob", { firstName: patient.firstName, callbackNumber: callbackNumber(call.appointment) }), { action: "ask_dob" });
    }
    const proxy = proxyName ? findProxy(patient, proxyName) : findProxyInText(patient, text);
    if (proxy?.authorized) {
      call.proxyName = proxy.name;
      this.#setState(call, STATES.VERIFYING);
      return this.#say(call, script(patient, "askDob", { firstName: patient.firstName, callbackNumber: callbackNumber(call.appointment) }), { action: "proxy_ask_dob", proxyName: proxy.name });
    }
    if (proxy && !proxy.authorized) return this.#wrongParty(call, "unauthorized_proxy");
    return this.#wrongParty(call, "wrong_party");
  }

  checkDob(callId, { spokenOrDigits }) {
    const call = this.#require(callId);
    const ok = normalizeDob(spokenOrDigits) === normalizeDob(call.appointment.patient.dob);
    if (ok) {
      call.verified = true;
      this.audit.updateCall?.(call.id, { verified: true, proxyName: call.proxyName });
      this.#setState(call, STATES.PRESENTING);
      return { ok: true, status: "verified", say: this.presentAppointment(callId).say };
    }
    call.dobAttempts += 1;
    if (call.dobAttempts >= 2) return this.#finish(call, STATES.ENDED, "unverified", "dob_failed", script(call.appointment.patient, "unverified", { callbackNumber: callbackNumber(call.appointment) }));
    this.#say(call, "I'm sorry, that didn't match. Please try the date of birth one more time.");
    return { ok: false, status: "retry" };
  }

  presentAppointment(callId) {
    const call = this.#require(callId);
    if (!call.verified) return { ok: false, reason: "not_verified" };
    const say = appointmentSummary(call.appointment, call.appointment.patient.preferredLanguage) + " Will you be able to make it?";
    this.#say(call, say);
    return { ok: true, say };
  }

  confirmAppointment(callId, { confirmation, idempotencyKey = null } = {}) {
    const call = this.#require(callId);
    if (!call.verified) return { ok: false, reason: "not_verified" };
    if (!isAffirmative(confirmation)) return { ok: false, reason: "needs_explicit_yes" };
    const result = this.schedule.confirmAppointment(call.appointmentId, idempotencyKey ?? `call:${call.id}:confirm`);
    const prep = prepText(result.appointment.prepCode, call.appointment.patient.preferredLanguage);
    this.schedule.recordAttempt({ appointmentId: call.appointmentId, patientId: call.patientId, state: "confirmed", outcome: "confirmed", attempt: call.attempt });
    this.#say(call, locale(call) === "es" ? `Está confirmado. ${prep}` : `You're confirmed. ${prep}`);
    return this.#finish(call, STATES.CONFIRMED, "confirmed", "confirmed");
  }

  proposeCancel(callId, { reasonCode = "patient_requested" } = {}) {
    const call = this.#require(callId);
    if (!call.verified) return { ok: false, reason: "not_verified" };
    const late = hoursUntil(call.appointment.start, this.now()) < 24;
    const notice = late ? fixtures.clinics.locations[call.appointment.location]?.lateCancellation?.[locale(call)] : null;
    const phrase = `${notice ? `${notice} ` : ""}I can cancel your ${call.appointment.department.toLowerCase()} appointment on ${spokenDateTime(call.appointment.start, call.appointment.patient.timeZone, locale(call))} for reason ${reasonCode.replaceAll("_", " ")}. Should I cancel it?`;
    const proposalId = randomUUID();
    call.cancelProposal = { proposalId, reasonCode, phrase };
    this.#setState(call, STATES.CANCEL_CONFIRM);
    this.#say(call, phrase);
    return { ok: true, proposalId, say: phrase, lateCancellation: Boolean(late) };
  }

  cancelAppointment(callId, { proposalId, confirmation, idempotencyKey = null } = {}) {
    const call = this.#require(callId);
    if (!call.verified) return { ok: false, reason: "not_verified" };
    if (!call.cancelProposal || call.cancelProposal.proposalId !== proposalId) return { ok: false, reason: "missing_proposal" };
    if (!isAffirmative(confirmation)) return { ok: false, reason: "needs_explicit_yes" };
    const result = this.schedule.cancelAppointment(call.appointmentId, call.cancelProposal.reasonCode, idempotencyKey ?? `call:${call.id}:cancel:${proposalId}`);
    this.schedule.recordAttempt({ appointmentId: call.appointmentId, patientId: call.patientId, state: "cancelled", outcome: "cancelled", attempt: call.attempt });
    this.#say(call, locale(call) === "es" ? "Está cancelada. Gracias por avisarnos para que otra persona pueda usar ese horario." : "It's cancelled. Thanks for letting us know so someone else can use that time.");
    return this.#finish(call, STATES.CANCELLED, "cancelled", result.releasedSlot.reason);
  }

  requestReschedule(callId, { correlationId = null } = {}) {
    const call = this.#require(callId);
    if (!call.verified) return { ok: false, reason: "not_verified" };
    const req = this.schedule.requestReschedule(call.appointmentId, `call:${call.id}:reschedule`);
    let transfer = null;
    const schedulingTarget = process.env.SCHEDULING_AGENT_TARGET || config.schedulingAgentTarget || fixtures.routing.schedulingAgent.target;
    if (schedulingTarget) {
      const token = this.schedule.issueHandoffToken({ appointmentId: call.appointmentId, patientId: call.patientId, correlationId: correlationId ?? call.sessionId });
      transfer = {
        destination: "schedulingAgent",
        target: schedulingTarget,
        callTopic: clip(`Reschedule – ${call.appointment.department} ${call.appointmentId}`, 48),
        callContext: { intent: "reschedule", appointmentId: call.appointmentId, patientRef: token.token, verified: true, sessionId: call.sessionId },
      };
      call.handoff = transfer;
      this.schedule.recordAttempt({ appointmentId: call.appointmentId, patientId: call.patientId, state: "reschedule_handoff", outcome: "reschedule_handoff", attempt: call.attempt });
      this.#setState(call, STATES.TRANSFERRING);
      this.#say(call, "I'll connect you to our scheduling assistant, who can find you a new time. Your current appointment stays booked until you choose a new one.");
    } else {
      this.schedule.recordAttempt({ appointmentId: call.appointmentId, patientId: call.patientId, state: "reschedule_callback", outcome: "reschedule_callback", attempt: call.attempt });
      this.#say(call, "I've asked our scheduling team to call you back tomorrow to find a new time.");
      this.#finish(call, STATES.ENDED, "reschedule_callback", "no_target");
    }
    return { ok: true, request: req, transfer, callContext: transfer?.callContext ?? null };
  }

  optOut(callId) {
    const call = this.#require(callId);
    this.schedule.suppressPatient(call.patientId, "spoken_opt_out");
    this.schedule.recordAttempt({ appointmentId: call.appointmentId, patientId: call.patientId, state: "opted_out", outcome: "opted_out", attempt: call.attempt });
    this.#say(call, script(call.appointment.patient, "optOut", {}));
    return this.#finish(call, STATES.OPT_OUT, "opted_out", "suppressed");
  }

  nurseLine(callId) {
    const call = this.#require(callId);
    const clinic = fixtures.clinics.locations[call.appointment.location];
    const open = insideWindow(this.now(), call.appointment.patient.timeZone, clinic.nurseLine.hours);
    this.#setState(call, STATES.CLINICAL);
    if (open) return { ok: true, action: "transfer", target: clinic.nurseLine.target, say: script(call.appointment.patient, "clinical", {}) };
    return { ok: true, action: "advice_number", number: clinic.afterHoursNurseAdviceNumber, say: `Our nurse line is closed. You can call the after-hours nurse-advice number at ${clinic.afterHoursNurseAdviceNumber}.` };
  }

  dtmf(callId, digit) {
    const call = this.#require(callId);
    if (digit === "1") return this.confirmAppointment(callId, { confirmation: "yes by keypad" });
    if (digit === "2") { this.#setState(call, STATES.CANCEL_REASON); return this.#say(call, "Please say a short reason for cancelling: schedule conflict, feeling sick, transportation, or other.", { ok: true }); }
    if (digit === "3") return this.requestReschedule(callId);
    if (digit === "9") return this.optOut(callId);
    if (digit === "*") return this.repeatLast(callId);
    return { ok: false, reason: "unknown_digit" };
  }

  repeatLast(callId) { const call = this.#require(callId); if (call.lastPhrase) this.#say(call, call.lastPhrase); return { ok: true, repeated: Boolean(call.lastPhrase), say: call.lastPhrase }; }
  noInput(callId) { const call = this.#require(callId); call.noInputs += 1; if (call.noInputs >= 2) { this.#setState(call, STATES.DTMF_MENU); return this.#say(call, script(call.appointment.patient, "dtmfMenu", {}), { offerDtmf: true }); } return this.#say(call, "I'm sorry, I didn't catch that.", { retry: true }); }
  checkBudget(callId) { const call = this.get(callId); if (!call?.answeredAt || TERMINAL.has(call.state)) return { ok: true }; if (this.now().getTime() - call.answeredAt >= this.options.callTimeBudgetMs) return this.#finish(call, STATES.ENDED, "call_cap", "time_budget"); if (this.now().getTime() - call.answeredAt >= 200_000 && call.state !== STATES.WRAP_UP) { this.#setState(call, STATES.WRAP_UP); this.#say(call, "We have about a minute left, so I'll help with the main appointment choice now."); } return { ok: true }; }
  endCall(callId, outcome = "agent_ended") { const call = this.get(callId); if (!call || TERMINAL.has(call.state)) return { ok: true }; return this.#finish(call, STATES.ENDED, outcome, outcome); }
  pushTranscript(callId, role, text) { const call = this.get(callId); if (!call || !text) return; call.transcript.push({ role, text, at: this.now().toISOString() }); this.audit.recordTranscript?.(callId, role, text); this.#publish(call, "transcript", { role, text }); }
  recordAgentAction(callId, { tool, ok = true, detail = null }) { const call = this.get(callId); if (call) this.#event(call, "agent", ok ? "tool" : "tool_rejected", detail ? `${tool}: ${detail}` : tool); }
  snapshot(callId) { const call = this.get(callId); if (!call) return null; return { id: call.id, state: call.state, appointmentId: call.appointmentId, patient: maskName(call.appointment.patient), firstName: call.patientFirstName, verified: call.verified, proxyName: call.proxyName, outcome: call.outcome, attempt: call.attempt, lastPhrase: call.lastPhrase, handoff: call.handoff, transcript: call.transcript }; }

  #wrongParty(call, reason) { this.schedule.recordAttempt({ appointmentId: call.appointmentId, patientId: call.patientId, state: "wrong_party", outcome: reason, attempt: call.attempt }); return this.#finish(call, STATES.ENDED, reason, reason, script(call.appointment.patient, "wrongParty", { firstName: call.appointment.patient.firstName, callbackNumber: callbackNumber(call.appointment) })); }
  #retry(call, outcome) { const next = new Date(this.now().getTime() + fixtures.campaign.minSpacingHours * 3600_000).toISOString(); this.schedule.recordAttempt({ appointmentId: call.appointmentId, patientId: call.patientId, state: "retry_scheduled", outcome, attempt: call.attempt, nextAttemptAt: next }); return this.#finish(call, STATES.RETRY_SCHEDULED, outcome, `next ${next}`); }
  #require(id) { const call = this.calls.get(id); if (!call) throw new Error(`unknown call ${id}`); return call; }
  #setState(call, state) { if (call.state === state) return; const from = call.state; call.state = state; this.audit.updateCall?.(call.id, { state }); this.#event(call, "system", "state", `${from} → ${state}`); this.#publish(call, "state", this.snapshot(call.id)); }
  #say(call, text, extra = {}) { call.lastPhrase = text; this.pushTranscript(call.id, "agent", text); this.agents.get(call.id)?.instruct?.(text, text); return { ok: true, say: text, ...extra }; }
  #event(call, source, kind, detail = null) { this.audit.recordEvent?.(call.id, source, kind, detail); this.#publish(call, "event", { source, kind, detail, at: this.now().toISOString() }); }
  #publish(call, target, payload) { this.hub?.send?.(call.id, target, payload); }
  #finish(call, state, outcome, detail = null, spoken = null) { if (spoken) this.#say(call, spoken); call.outcome = outcome; call.endedAt = this.now().getTime(); this.#setState(call, state); this.audit.updateCall?.(call.id, { outcome, endedAt: new Date(call.endedAt).toISOString(), durationMs: call.endedAt - call.startedAt }); this.#event(call, "system", "outcome", detail ?? outcome); return { ok: true, outcome, state: call.state, say: spoken ?? call.lastPhrase }; }
}

export function handleUtterance(flow, callId, text) {
  const said = String(text ?? "").trim();
  const call = flow.get(callId);
  if (!call) return { ok: false, reason: "unknown_call" };
  if (!said) return flow.noInput(callId);
  flow.pushTranscript(callId, "caller", said);
  if (/^[1239*]$/.test(said)) return flow.dtmf(callId, said);
  if (containsAny(said, fixtures.detection.emergencyPhrases)) { flow.pushTranscript(callId, "agent", script(call.appointment.patient, "emergency", {})); return { ok: true, emergency: true, say: script(call.appointment.patient, "emergency", {}) }; }
  if (/\b(stop calling|opt out|no more calls|do not call)\b/i.test(said)) return flow.optOut(callId);
  if (call.state === STATES.GREETING) return flow.confirmIdentity(callId, { text: said });
  if (call.state === STATES.VERIFYING) return flow.checkDob(callId, { spokenOrDigits: said });
  if (call.state === STATES.PRESENTING || call.state === STATES.DTMF_MENU) {
    if (/\b(cancel|can't make|cannot make|need to cancel)\b/i.test(said)) { call.state = STATES.CANCEL_REASON; return flow.proposeCancel(callId, { reasonCode: "patient_requested" }); }
    if (/\b(reschedule|change|different time|next week)\b/i.test(said)) return flow.requestReschedule(callId);
    if (containsAny(said, fixtures.detection.clinicalQuestionPhrases)) return flow.nurseLine(callId);
    return flow.confirmAppointment(callId, { confirmation: said });
  }
  if (call.state === STATES.CANCEL_REASON) return flow.proposeCancel(callId, { reasonCode: reasonCode(said) });
  if (call.state === STATES.CANCEL_CONFIRM) return flow.cancelAppointment(callId, { proposalId: call.cancelProposal?.proposalId, confirmation: said });
  return flow.noInput(callId);
}

export function detectVoicemail({ text = "", durationMs = 0, beep = false, locale = "en" } = {}) {
  const phrases = fixtures.detection.voicemailPhrases[locale] ?? fixtures.detection.voicemailPhrases.en;
  const phrase = phrases.find((p) => text.toLowerCase().includes(p));
  if (beep || fixtures.detection.beepTokens.some((p) => text.toLowerCase().includes(p))) return { voicemail: true, reason: "beep" };
  if (phrase) return { voicemail: true, reason: `phrase:${phrase}` };
  if (durationMs >= config.voicemailGreetingMs) return { voicemail: true, reason: "long_greeting" };
  return { voicemail: false, reason: "human_or_unknown" };
}

export function isAffirmative(text) { const s = String(text).toLowerCase(); return /\b(yes|yeah|yep|correct|right|sure|please|ok|okay|confirm|sí|si)\b/.test(s) && !/\b(no|nope|not|maybe|don't|do not)\b/.test(s); }
export function normalizeDob(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 8 && /^(19|20)\d{6}$/.test(digits)) return `${digits.slice(0,4)}-${digits.slice(4,6)}-${digits.slice(6,8)}`;
  if (digits.length === 8) return `${digits.slice(4)}-${digits.slice(0,2)}-${digits.slice(2,4)}`;
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0,10);
  return s.replace(/[^a-z0-9]/g, "");
}
export function appointmentSummary(appt, language = "en") { const provider = appt.provider?.name ?? "your provider"; const place = fixtures.clinics.locations[appt.location]?.displayName ?? appt.location; const when = spokenDateTime(appt.start, appt.patient.timeZone, language); return language === "es" ? `Tiene una cita de ${appt.department} con ${provider} el ${when}, en ${place}.` : `You have a ${appt.department.toLowerCase()} appointment with ${provider} on ${when}, at ${place}.`; }
export function prepText(code, language = "en") { return fixtures.prep[code]?.[language] ?? fixtures.prep[code]?.en ?? "Please follow the instructions from your clinic."; }
function script(patient, key, values) { let text = fixtures.scripts[patient.preferredLanguage]?.[key] ?? fixtures.scripts.en[key]; for (const [k, v] of Object.entries(values)) text = text.replaceAll(`{${k}}`, v ?? ""); return text; }
function callbackNumber(appt) { return fixtures.clinics.locations[appt.location]?.callbackNumber ?? "206-555-0100"; }
function primaryPhone(patient) { return patient?.phones?.[0] ?? null; }
function findProxy(patient, name) { return patient.proxies?.find((p) => p.name.toLowerCase() === String(name).toLowerCase()) ?? null; }
function findProxyInText(patient, text) { return patient.proxies?.find((p) => String(text).toLowerCase().includes(p.name.split(" ")[0].toLowerCase())) ?? null; }
function maskName(patient) { return patient ? `${patient.firstName} ${patient.lastName?.[0] ?? ""}.` : "Unknown"; }
function locale(call) { return call.appointment.patient.preferredLanguage ?? "en"; }
function reasonCode(text) { const s = String(text).toLowerCase(); if (s.includes("sick")) return "feeling_sick"; if (s.includes("transport")) return "transportation"; if (s.includes("schedule")) return "schedule_conflict"; return "patient_requested"; }
function hoursUntil(iso, now) { return (new Date(iso) - now) / 3600_000; }
function containsAny(text, list) { const s = String(text).toLowerCase(); return list.some((p) => s.includes(p)); }
function clip(s, n) { s = String(s); return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…"; }
function isHoliday(date, holidays, timeZone) { return holidays.includes(localDate(date, timeZone)); }
function insideWindow(date, timeZone, window) { const { hour, minute } = localParts(date, timeZone); const mins = hour * 60 + minute; const [sh, sm] = window.start.split(":").map(Number); const [eh, em] = window.end.split(":").map(Number); return mins >= sh * 60 + sm && mins < eh * 60 + em; }
function localParts(date, timeZone) { const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date); const o = Object.fromEntries(parts.map((p) => [p.type, p.value])); return { hour: Number(o.hour), minute: Number(o.minute), date: `${o.year}-${o.month}-${o.day}` }; }
function localDate(date, timeZone) { return localParts(date, timeZone).date; }
function localDateTime(iso, timeZone) { return new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)); }
function spokenDateTime(iso, timeZone, language = "en") { return new Intl.DateTimeFormat(language === "es" ? "es-US" : "en-US", { timeZone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)); }
