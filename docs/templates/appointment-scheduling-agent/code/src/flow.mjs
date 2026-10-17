import { randomUUID } from "node:crypto";
import { config, fixtures } from "./config.mjs";
import { SchedulingRoutes, maskPhone } from "./routes.mjs";
import { buildCustomCallingContext, clipTopic } from "./handoff.mjs";
import { clinicName, clinicTimeZone, spokenDateTime, spokenWhen, withArticle } from "./schedule-store.mjs";
import { localeLanguage } from "./agent.mjs";

/**
 * The scheduling state machine.
 *
 *   ringing → verifying → verified → offering → confirming → booked | rescheduled | cancelled
 *                ↘ escalating → transferred      ↑_______________|  slot_taken: fresh options
 *
 * The server, not the model, owns every write. The model can verify, search,
 * hold and propose, but it has no booking tool. A booking, a reschedule or a
 * cancellation is written only in #commit(), which runs only from callerSaid()
 * or dtmf(): the caller's own yes to the ACTIVE proposal. If the held time was
 * taken in the meantime, the write is refused, the caller hears fresh options,
 * and nothing is written until they pick one and say yes again. The flow never
 * books a different time on its own.
 *
 * No Azure, Express or SQLite imports: the schedule store, the transfer, the
 * audit sink and the clock are injected, so the whole flow runs offline from a
 * typed transcript and under plain `node --test`.
 */

export const STATES = Object.freeze({
  RINGING: "ringing",
  VERIFYING: "verifying",
  VERIFIED: "verified",
  REGISTERING: "registering",
  OFFERING: "offering",
  CONFIRMING: "confirming",
  ESCALATING: "escalating",
  BOOKED: "booked",
  RESCHEDULED: "rescheduled",
  CANCELLED: "cancelled",
  WAITLISTED: "waitlisted",
  CALLBACK_FILED: "callback_filed",
  TRANSFERRED: "transferred",
  ENDED: "ended",
});

export const TERMINAL = new Set([
  STATES.BOOKED, STATES.RESCHEDULED, STATES.CANCELLED, STATES.WAITLISTED,
  STATES.CALLBACK_FILED, STATES.TRANSFERRED, STATES.ENDED,
]);

const ORG = "Contoso Health";
const MAIN_NUMBER = Object.values(fixtures.clinics.locations)[0]?.callbackNumber ?? "206-555-0100";
const DAY_MS = 86_400_000;
const NULL_AUDIT = { startCall() {}, updateCall() {}, recordEvent() {}, recordTranscript() {} };
const PROVIDERS = fixtures.providers.providers ?? [];
const RULES = Object.fromEntries((fixtures.eligibility.rules ?? []).map((rule) => [rule.id, rule]));
const iso = (ms) => new Date(ms).toISOString();

// ------------------------------------------------------------ what the caller said

const YES = /\b(yes|yeah|yep|yup|correct|sure|ok|okay|confirm|book it|go ahead|sounds good|that works|perfect|please do|that's right)\b/i;
const NO_WORDS = /\b(no|nope|not|don't|do not|wait|hold on|actually|instead|different|other|another|second|first|more)\b/i;
const NEGATIVE = /\b(no|nope|not|don't|do not|neither|never mind|nevermind)\b/i;
const PICK_WORDS = /\b(first|second|other|different|another|more|later|earlier)\b/i;
const DEMANDS_BOOKING = /\bjust book\b|\bbook (?:it|anything|whatever|something|any)\b|\bbook me (?:in )?(?:for )?(?:anything|whatever|something|any)|whatever you have|just put me (?:in|down)|any time is fine|anything is fine/i;

const clean = (text) => String(text ?? "").replace(/[’]/g, "'");

/** A plain yes, with nothing in it that changes the choice. */
export const isAffirmative = (text) => YES.test(clean(text)) && !NO_WORDS.test(clean(text));
export const isNegative = (text) => NEGATIVE.test(clean(text)) && !isAffirmative(text);
/** "Just book whatever": a demand to write before any time has been proposed. */
export const demandsBooking = (text) => DEMANDS_BOOKING.test(clean(text));

export function classifySafety(text) {
  const said = clean(text).toLowerCase();
  for (const level of ["emergency", "urgent"]) {
    const phrase = (fixtures.safety[level] ?? []).find((p) => said.includes(String(p).toLowerCase()));
    if (phrase) return { level, phrase };
  }
  return null;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DATE_PATTERNS = [
  /\b\d{4}-\d{1,2}-\d{1,2}\b/g,
  /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*,?\s+\d{4}\b/gi,
];

function isoDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!(y > 1900 && y < 2100) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const monthIndex = (word) => MONTHS.findIndex((m) => m.startsWith(String(word).toLowerCase().slice(0, 3))) + 1;

/** A spoken or typed date of birth as YYYY-MM-DD, or null. Numeric dates are read month first. */
export function normalizeDob(value) {
  const text = clean(value).trim().toLowerCase();
  if (!text) return null;
  let m = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return isoDate(m[1], m[2], m[3]);
  m = text.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/);
  if (m) return isoDate(m[3], m[1], m[2]);
  m = text.match(/\b([a-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (m && monthIndex(m[1]) > 0) return isoDate(m[3], monthIndex(m[1]), m[2]);
  m = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,}),?\s+(\d{4})\b/);
  if (m && monthIndex(m[2]) > 0) return isoDate(m[3], monthIndex(m[2]), m[1]);
  return null;
}

export const normalizeName = (value) => clean(value).toLowerCase().normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z' -]/g, " ").replace(/\s+/g, " ").trim();

const titleCase = (text) => text.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** "This is Alex Rivera calling for Jordan Rivera, 03/12/1984" → { proxyName, fullName, dob }. */
export function parseIdentity(text) {
  const raw = clean(text);
  const dob = normalizeDob(raw);
  let rest = raw;
  for (const pattern of DATE_PATTERNS) rest = rest.replace(pattern, " ");
  const proxy = rest.match(/\b(?:this is|i'm|i am|my name is)\s+([a-z' -]+?)\s+(?:calling|on behalf)\s+(?:for|of)\s+(?:my\s+[a-z]+\s*,?\s+)?([a-z' -]+)/i);
  const tidy = (s) => titleCase(normalizeName(String(s ?? "")
    .replace(/\b(my name is|this is|it's|it is|i'm|i am|my|full|name|born(?: on)?|date of birth|birthday|dob|and|the|patient|is|hi|hello)\b/gi, " ")));
  if (proxy) return { proxyName: tidy(proxy[1]) || null, fullName: tidy(proxy[2]) || null, dob };
  return { proxyName: null, fullName: tidy(rest) || null, dob };
}

const CODE_WORDS = [
  ["DERM_SKIN_CHECK", /\bskin check|\bmole\b/i],
  ["DERM_NEW_PROBLEM", /\bdermatolog|\brash\b|\beczema\b/i],
  ["ANNUAL_PHYSICAL", /\bannual\b|\bphysical\b|\bcheck-?up\b/i],
  ["FOLLOW_UP", /\bfollow[- ]?up\b/i],
  ["MRI", /\bmri\b/i],
  ["XRAY", /\bx-?ray\b/i],
  ["ULTRASOUND", /\bultrasound\b/i],
  ["NEW_PROBLEM", /\bnew problem\b|\bsick\b|\bcough\b|\bsore throat\b|\bheadache\b|\bappointment\b|\bsee (?:a|the|my) doctor\b|\bvisit\b/i],
];

/** The visit type a typed request names, for the offline driver. */
export function chooseCode(text) {
  const said = clean(text);
  return CODE_WORDS.find(([, pattern]) => pattern.test(said))?.[0] ?? null;
}

const SURNAMES = PROVIDERS.map((p) => ({ providerId: p.providerId, surname: normalizeName(String(p.spokenName).replace(/^dr\.?\s+/i, "")) }));

/** search_slots arguments from what a caller typed, for the offline driver. */
export function prefArgs(text) {
  const said = clean(text).toLowerCase();
  const args = {};
  const named = SURNAMES.find(({ surname }) => new RegExp(`\\b${surname}\\b`).test(said));
  if (/\b(usual|regular|primary|my doctor|own doctor)\b/.test(said)) args.providerPreference = "my usual doctor";
  else if (named) args.providerPreference = PROVIDERS.find((p) => p.providerId === named.providerId).spokenName;
  if (/\bmorning/.test(said)) args.dayPart = "morning";
  else if (/\bafternoon/.test(said)) args.dayPart = "afternoon";
  const weekday = said.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (weekday) args.weekday = weekday[1];
  if (/\b(more|other times|anything else|later|different)\b/.test(said)) args.more = true;
  return args;
}

/** Dates of birth and phone numbers never reach the transcript store or the console. */
export function maskTranscript(text) {
  let masked = String(text ?? "");
  for (const pattern of DATE_PATTERNS) masked = masked.replace(pattern, "[date]");
  return masked.replace(/\+?\d[\d\s().-]{8,}\d/g, (m) => `[number ending ${m.replace(/\D/g, "").slice(-2)}]`);
}

const SEED_VISIT_NAMES = {
  "mri": "MRI", "follow-up": "FOLLOW_UP", "skin check": "DERM_SKIN_CHECK", "annual physical": "ANNUAL_PHYSICAL",
  "new problem": "NEW_PROBLEM", "ultrasound": "ULTRASOUND", "x-ray": "XRAY",
};

/** An appointment's visit type as a code, whether it was seeded by name or booked by code. */
export function visitCodeOf(visitType) {
  const value = String(visitType ?? "");
  if (fixtures.visitTypes[value]) return value;
  const key = value.trim().toLowerCase();
  return SEED_VISIT_NAMES[key]
    ?? Object.keys(fixtures.visitTypes).find((code) => fixtures.visitTypes[code].spokenName?.en?.toLowerCase() === key)
    ?? null;
}

const visitName = (code) => fixtures.visitTypes[code]?.spokenName?.en ?? String(code ?? "visit").toLowerCase();

const isActive = (record, at) => record.status === "active" && Date.parse(`${record.expires}T23:59:59-07:00`) > at;

/**
 * The server's eligibility decision for one visit type, in a fixed order:
 * insurance, visit frequency, referral, order. The model is told the outcome;
 * it never makes it.
 */
export function evaluateEligibility({
  patient, visitTypeCode, appointments = [], now = new Date(), selfPayAcknowledged = false, excludeAppointmentId = null,
} = {}) {
  const visit = fixtures.visitTypes[visitTypeCode];
  if (!visit) return { eligible: false, ruleId: "UNKNOWN_VISIT_TYPE", explanation: null, alternatives: [] };
  const at = now instanceof Date ? now.getTime() : Number(now);
  const block = (ruleId) => ({
    eligible: false, ruleId, explanation: RULES[ruleId]?.explain?.en ?? null, alternatives: RULES[ruleId]?.alternatives ?? [],
  });
  const insurance = patient?.insurance;
  if (!selfPayAcknowledged && insurance
    && (insurance.active === false || /inactive|expired|terminated/i.test(String(insurance.status ?? "")))) {
    return block("INSURANCE_INACTIVE");
  }
  if (visit.frequencyMonths) {
    const span = visit.frequencyMonths * 30.4375 * DAY_MS;
    const recent = appointments.find((a) => a.appointmentId !== excludeAppointmentId
      && ["booked", "confirmed", "completed"].includes(a.status)
      && visitCodeOf(a.visitType) === visitTypeCode
      && Math.abs(Date.parse(a.start) - at) < span);
    if (recent) return block("ANNUAL_TOO_SOON");
  }
  if (visit.requiresReferral) {
    const ok = (fixtures.referrals.referrals ?? [])
      .some((r) => r.patientId === patient?.patientId && r.department === visit.department && isActive(r, at));
    return ok ? { eligible: true, basis: "active referral on file" } : block("REFERRAL_REQUIRED");
  }
  if (visit.requiresOrder) {
    const ok = (fixtures.orders.orders ?? [])
      .some((o) => o.patientId === patient?.patientId && o.modality === visit.requiresOrder && isActive(o, at));
    return ok ? { eligible: true, basis: `active ${visit.requiresOrder} order on file` } : block("ORDER_REQUIRED");
  }
  if (visit.frequencyMonths) return { eligible: true, basis: `no ${visitName(visitTypeCode)} within ${visit.frequencyMonths} months` };
  return { eligible: true, basis: "no referral needed" };
}

// ------------------------------------------------------------ small formatting helpers

const providerServes = (providerId, code) => Boolean(PROVIDERS.find((p) => p.providerId === providerId)
  ?.weeklyTemplate?.some((block) => block.visitTypes.includes(code)));

function providerByName(name) {
  const said = normalizeName(String(name ?? "").replace(/\b(?:dr|doctor)\b\.?/gi, " "));
  if (!said) return null;
  const hit = SURNAMES.find(({ surname }) => said === surname || said.split(" ").includes(surname));
  return hit ? PROVIDERS.find((p) => p.providerId === hit.providerId) : null;
}

const clockTime = (value, timeZone) => new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(value));

function shortLabel(value, timeZone) {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(new Date(value));
  return `${day} · ${clockTime(value, timeZone)}`;
}

/** "A-20440" read out one character at a time: "A-2-0-4-4-0". */
const spellId = (id) => String(id).replace(/-/g, "").split("").join("-");
const onWhen = (when) => (/^(today|tomorrow)\b/.test(when) ? when : `on ${when}`);

/** Ends a spoken sentence without doubling the period after "a.m." or "p.m.". */
function sentence(text) {
  return /[.?!]$/.test(text) ? text : `${text}.`;
}

function joinOr(items) {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]}, or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`;
}

function describePrefs(prefs = {}) {
  const parts = [];
  if (prefs.providerId) parts.push(PROVIDERS.find((p) => p.providerId === prefs.providerId)?.spokenName ?? prefs.providerId);
  if (prefs.usualDoctor) parts.push("usual doctor");
  if (prefs.location) parts.push(clinicName(prefs.location));
  if (prefs.timeOfDay) parts.push(`${prefs.timeOfDay}s`);
  if (prefs.weekday != null) parts.push(["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"][prefs.weekday]);
  if (prefs.date) parts.push(prefs.date);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

export class SchedulingFlow {
  /**
   * @param {object} deps
   * @param {import("./schedule-store.mjs").ScheduleAdapter} deps.schedule the only writer
   * @param {SchedulingRoutes} [deps.routes] the Teams handoff targets and their hours
   * @param {object} [deps.audit] startCall / updateCall / recordEvent / recordTranscript
   * @param {(call: object, destination: object) => Promise<void>} [deps.transfer] live Teams transfer
   * @param {{send: (id: string, target: string, payload: object) => any}} [deps.hub] console fan-out
   * @param {() => number} [deps.now] the demo clock, shared with the schedule store
   */
  constructor({ schedule, routes = new SchedulingRoutes(), audit = NULL_AUDIT, transfer = null, hub = null, now = Date.now, options = {} } = {}) {
    if (!schedule) throw new Error("SchedulingFlow needs a schedule store");
    this.schedule = schedule;
    this.routes = routes;
    this.audit = audit ?? NULL_AUDIT;
    this.transfer = transfer;
    this.hub = hub;
    this.now = now;
    this.options = {
      callTimeBudgetMs: config.callTimeBudgetMs,
      optionsPerTurn: config.schedule.optionsPerTurn,
      transferDelayMs: config.transferDelayMs,
      holdTtlMs: config.schedule.holdTtlMs,
      locale: config.locale,
      ...options,
    };
    this.language = localeLanguage(this.options.locale);
    /** @type {Map<string, object>} */
    this.calls = new Map();
    /** @type {Map<string, object>} agent handles keyed by call id */
    this.agents = new Map();
  }

  #nowDate() {
    return new Date(this.now());
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * An inbound call has arrived. `simulated` marks a console or offline call:
   * its handoff is recorded but never dispatched to Teams. `handoff` is the
   * parsed CallContext of a call transferred in by the reminder agent; only a
   * one-time token in it can stand in for name and date of birth.
   */
  create({ callId = randomUUID(), fromPhone = null, incomingCallContext = null, sessionId = null, resourceAccountId = null, simulated = false, handoff = null } = {}) {
    const match = this.#patientByPhone(fromPhone);
    const call = {
      id: callId,
      fromPhone,
      maskedPhone: maskPhone(fromPhone),
      sessionId,
      incomingCallContext,
      resourceAccountId,
      arrival: resourceAccountId ? "teams-phone-extensibility" : "acs-direct",
      simulated: Boolean(simulated) || !this.transfer,
      callConnectionId: null,
      state: STATES.RINGING,
      callerIdMatch: match ? { patientId: match.patientId, firstName: match.firstName } : null,
      inbound: handoff && typeof handoff === "object" ? handoff : null,
      handoffRejected: null,
      reminder: null,
      patient: null,
      verifiedBy: null,
      proxy: null,
      attempts: 0,
      identityFailure: null,
      handles: new Map(),
      upcoming: [],
      reason: null,
      visitTypeCode: null,
      selfPay: false,
      eligibility: null,
      blocked: null,
      preferences: {},
      rescheduleOf: null,
      options: [],
      offered: [],
      excluded: [],
      moreAvailable: false,
      proposal: null,
      proposalSeq: 0,
      consent: null,
      raceLost: null,
      races: 0,
      refusals: 0,
      booking: null,
      callback: null,
      safety: null,
      destination: null,
      handoffKind: null,
      handoff: null,
      noInputs: 0,
      misheard: 0,
      lastSpoken: null,
      lastInstruction: null,
      transferAttempts: 0,
      dispatched: false,
      pendingDispatch: null,
      dispatchPromise: null,
      outcome: null,
      startedAt: this.now(),
      answeredAt: null,
      endedAt: null,
      transcript: [],
    };
    this.calls.set(callId, call);
    this.audit.startCall({
      id: callId,
      maskedPhone: call.maskedPhone,
      state: call.state,
      startedAt: iso(call.startedAt),
      simulated: call.simulated,
      arrival: call.arrival,
    });
    this.#event(call, "system", "call_created", `${call.simulated ? "simulated" : "live"} call from ${call.maskedPhone}${match ? " · caller ID matches a patient (not proof of identity)" : ""}`);
    return call;
  }

  get(callId) {
    return this.calls.get(callId) ?? null;
  }

  /** Forget every call, cancelling any handoff still waiting to dispatch. The console's reset. */
  reset() {
    for (const call of this.calls.values()) this.#cancelPendingDispatch(call);
    this.calls.clear();
    this.agents.clear();
  }

  /**
   * The demo clock jumped by `deltaMs`. Calls in progress shift with it, so
   * their time budgets keep measuring time that actually passed.
   */
  rebaseClock(deltaMs) {
    if (!Number.isFinite(deltaMs) || deltaMs === 0) return;
    for (const call of this.calls.values()) {
      if (TERMINAL.has(call.state)) continue;
      call.startedAt += deltaMs;
      if (call.answeredAt != null) call.answeredAt += deltaMs;
    }
  }

  /** The live (or simulated) agent: instruct(text, spoken, opts) speaks now; nudge(text) only informs. */
  registerAgent(callId, handle) {
    this.agents.set(callId, handle);
  }

  unregisterAgent(callId) {
    this.agents.delete(callId);
  }

  setCallConnection(callId, callConnectionId) {
    const call = this.get(callId);
    if (call) call.callConnectionId = callConnectionId;
  }

  /** Every tool the model reached for, accepted or not. */
  recordAgentAction(callId, { tool, ok = true, detail = null }) {
    const call = this.get(callId);
    if (!call) return;
    this.#event(call, "agent", ok ? "tool" : "tool_rejected", detail ? `${tool}: ${detail}` : tool);
  }

  /** The call is up: disclose the automation and ask for identity, or redeem a reminder handoff. */
  answered(callId) {
    const call = this.#require(callId);
    if (call.answeredAt != null) return { ok: true, state: call.state };
    call.answeredAt = this.now();
    this.audit.updateCall(call.id, { answeredAt: iso(call.answeredAt) });
    const redeemed = call.inbound ? this.#redeemHandoff(call) : null;
    if (redeemed) return redeemed;
    this.#setState(call, STATES.VERIFYING);
    const spoken = `Thanks for calling ${ORG}. I'm an automated scheduling assistant. To get started, what's the patient's full name and date of birth?`;
    const next = this.#say(call, "The call is connected. Say you are an automated assistant and ask for the patient's full name and date of birth. Caller ID is not proof of identity, so greet no one by name.", spoken);
    return { ok: true, state: call.state, next };
  }

  #redeemHandoff(call) {
    const ctx = call.inbound;
    const reject = (reason) => {
      call.handoffRejected = reason;
      this.#event(call, "system", "handoff_rejected", `${reason} · verifying by name and date of birth instead`);
      return null;
    };
    // The reminder agent sends its one-time token as `patientRef` (reminderToSchedulingContext).
    const token = ctx.patientRef ?? ctx.handoffToken ?? ctx.token ?? null;
    if (!token) return reject("no_token");
    const redeemed = this.schedule.redeemHandoffToken({ token, correlationId: ctx.sessionId ?? null });
    if (!redeemed.ok) return reject(redeemed.reason);
    if (!redeemed.patient || !redeemed.appointment) return reject("invalid");
    if (ctx.appointmentId && redeemed.appointment.appointmentId !== ctx.appointmentId) return reject("wrong_appointment");

    call.patient = redeemed.patient;
    call.verifiedBy = "handoff";
    const entry = this.#apptEntry(redeemed.appointment, this.#handleFor(call, redeemed.appointment.appointmentId));
    call.upcoming = [entry];
    call.reminder = { handle: entry.handle, appointmentId: entry.appointmentId };
    this.audit.updateCall(call.id, { patientRef: call.patient.patientId, verified: true });
    this.#event(call, "system", "identity_verified", `${call.patient.firstName} ${call.patient.lastName[0]}. · one-time reminder token redeemed`);
    this.#setState(call, STATES.VERIFIED);
    const spoken = `Hi ${call.patient.firstName}, this is ${ORG}'s automated scheduling assistant. I can help you find a new time for your ${sentence(entry.phrase)} What day or time works better?`;
    const next = this.#say(call, `The caller was verified by a one-time reminder token. To find new times, call search_slots with appointmentHandle "${entry.handle}".`, spoken);
    return { ok: true, state: call.state, redeemed: true, next };
  }

  /** The redeem_handoff tool: what the server already decided about a reminder handoff. */
  handoffStatus(callId) {
    const { call, error } = this.#active(callId);
    if (error) return error;
    if (call.reminder) {
      const entry = this.#entry(call, call.reminder.handle);
      return { ok: true, result: "redeemed", firstName: call.patient.firstName, appointmentHandle: call.reminder.handle, appointment: entry ? publicEntry(entry) : null, next: `Offer to find a new time; call search_slots with appointmentHandle "${call.reminder.handle}".` };
    }
    if (call.handoffRejected) return { ok: false, result: "handoff_rejected", reason: call.handoffRejected, next: "Verify the caller with the patient's full name and date of birth." };
    return { ok: false, result: "no_handoff", next: "There is no reminder handoff on this call. Verify the caller with the patient's full name and date of birth." };
  }

  // ------------------------------------------------------------------ identity

  /**
   * The server matches name and date of birth against the record; the model
   * only passes on what it heard. A miss never says whether a patient exists,
   * and a second miss hands off without disclosing anything.
   */
  verifyPatient(callId, { fullName = null, firstName = null, lastName = null, dob = null, proxyName = null } = {}) {
    const { call, error } = this.#active(callId);
    if (error) return error;
    if (call.state === STATES.ESCALATING) return { ok: false, error: "escalating" };
    if (call.patient) return { ok: true, result: "already_verified", firstName: call.patient.firstName, next: "The caller is already verified. Continue." };
    const name = normalizeName(fullName ?? [firstName, lastName].filter(Boolean).join(" "));
    const birth = normalizeDob(dob);
    if (!name || !birth) {
      return { ok: false, error: "need_name_and_dob", next: "Ask for the patient's full name and date of birth, then call verify_patient again." };
    }
    call.attempts += 1;
    const matches = this.schedule.listPatients().filter((p) => {
      const full = normalizeName(`${p.firstName} ${p.lastName}`);
      return p.dob === birth && (name === full || name.endsWith(` ${full}`));
    });
    const patient = matches.length === 1 ? matches[0] : null;
    if (!patient) return this.#identityFailed(call, "verification_failed");

    let proxy = null;
    if (proxyName) {
      const said = normalizeName(proxyName);
      proxy = (patient.proxies ?? []).find((x) => {
        const listed = normalizeName(x.name);
        return said && (listed === said || said.endsWith(` ${listed}`) || listed.split(" ")[0] === said);
      }) ?? null;
      if (!proxy?.authorized) return this.#identityFailed(call, "unauthorized_proxy");
    }

    call.patient = patient;
    call.verifiedBy = proxy ? "proxy" : "name_dob";
    call.proxy = proxy ? { name: proxy.name, relationship: proxy.relationship } : null;
    call.identityFailure = null;
    this.audit.updateCall(call.id, { patientRef: patient.patientId, verified: true });
    const agrees = call.callerIdMatch?.patientId === patient.patientId ? " · caller ID agrees (not used as proof)" : "";
    this.#event(call, "system", "identity_verified", `${patient.firstName} ${patient.lastName[0]}. · name + date of birth${proxy ? ` · ${proxy.relationship} on file as authorized` : ""}${agrees}`);
    this.#setState(call, STATES.VERIFIED);
    const spoken = proxy
      ? `Thanks, ${proxy.name.split(" ")[0]}. What kind of visit does ${patient.firstName} need, and what's it for?`
      : `Thanks, ${patient.firstName}. What kind of visit do you need, and what's it for?`;
    const next = this.#say(call, "The server verified the caller. Ask what kind of visit they need and why. Never read back the date of birth.", spoken);
    return { ok: true, result: "verified", firstName: patient.firstName, proxy: Boolean(proxy), next };
  }

  #identityFailed(call, reason) {
    call.identityFailure = reason;
    if (call.attempts < 2) {
      this.#event(call, "system", "identity_failed", `attempt ${call.attempts} of 2`);
      const spoken = "I'm sorry, I couldn't confirm that. Could you tell me the patient's full name and date of birth again?";
      const next = this.#say(call, "Verification did not match. Do not say whether a patient or an appointment exists. Ask once more for the full name and date of birth.", spoken);
      return { ok: false, result: "not_verified", attempt: call.attempts, next };
    }
    this.#event(call, "system", "identity_not_confirmed", "two attempts · nothing about appointments disclosed");
    const handoff = this.requestTransfer(call.id, "scheduling_team", reason, "agent", {
      lead: "I'm sorry, I'm not able to confirm that, so I can't discuss appointments on this call.",
      afterHours: "advise",
      adviseLine: `Our scheduling team is closed right now. Please call us back at ${MAIN_NUMBER} during business hours.`,
      by: "system",
    });
    return { ...handoff, verified: false };
  }

  #patientByPhone(phone) {
    const digits = String(phone ?? "").replace(/\D/g, "").slice(-10);
    if (digits.length < 10) return null;
    return this.schedule.listPatients()
      .find((p) => (p.phones ?? []).some((x) => String(x.number ?? "").replace(/\D/g, "").slice(-10) === digits)) ?? null;
  }

  // ------------------------------------------------------------------ what the caller wants

  listUpcoming(callId) {
    const { call, error } = this.#verifiedCall(callId);
    if (error) return error;
    const appointments = this.schedule.listUpcoming({ patientId: call.patient.patientId, from: this.#nowDate().toISOString() });
    call.upcoming = appointments.map((a) => this.#apptEntry(a, this.#handleFor(call, a.appointmentId)));
    this.#event(call, "agent", "upcoming", `${call.upcoming.length} upcoming`);
    const spoken = call.upcoming.length === 1
      ? `I see ${sentence(withArticle(call.upcoming[0].phrase))} Is that the one?`
      : call.upcoming.length
        ? `I see ${sentence(joinOr(call.upcoming.map((e) => withArticle(e.phrase))))} Which one is this about?`
        : "I don't see any upcoming appointments. Would you like to book one?";
    const next = this.#say(call, "Read the upcoming appointments back as listed. Refer to them by appointmentHandle in tool calls.", spoken);
    return { ok: true, result: "upcoming", appointments: call.upcoming.map(publicEntry), next };
  }

  #handleFor(call, appointmentId) {
    if (!call.handles.has(appointmentId)) call.handles.set(appointmentId, `appt-${call.handles.size + 1}`);
    return call.handles.get(appointmentId);
  }

  #entry(call, handle) {
    const found = call.upcoming.find((e) => e.handle === handle);
    if (found) return found;
    const id = [...call.handles].find(([, h]) => h === handle)?.[0];
    const appt = id ? this.schedule.getAppointment(id) : null;
    if (!appt || appt.patientId !== call.patient?.patientId || !["booked", "confirmed"].includes(appt.status)) return null;
    return this.#apptEntry(appt, handle);
  }

  #apptEntry(appt, handle) {
    const timeZone = clinicTimeZone(appt.location);
    const code = visitCodeOf(appt.visitType);
    const name = code ? visitName(code) : String(appt.visitType).toLowerCase();
    const provider = appt.provider?.name ?? "your provider";
    const when = spokenDateTime(appt.start, timeZone);
    return {
      handle,
      appointmentId: appt.appointmentId,
      visitTypeCode: code,
      visitName: name,
      providerId: appt.providerId,
      providerName: provider,
      location: appt.location,
      locationName: clinicName(appt.location),
      start: appt.start,
      label: shortLabel(appt.start, timeZone),
      when,
      phrase: `${name} with ${provider} on ${when}`,
    };
  }

  noteReason(callId, text) {
    const { call, error } = this.#verifiedCall(callId);
    if (error) return error;
    const reason = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!reason) return { ok: false, error: "empty_reason" };
    call.reason = reason;
    if (!call.safety) {
      const safety = classifySafety(reason);
      if (safety) return this.#safetyEscalation(call, safety);
    }
    this.#event(call, "agent", "reason", "visit reason noted (kept out of the console)");
    return { ok: true, result: "noted", next: "If you know the visit type, call choose_visit_type." };
  }

  /** The visit type, and the server's eligibility decision for it. */
  chooseVisitType(callId, code, { selfPayAcknowledged = false } = {}) {
    const { call, error } = this.#verifiedCall(callId);
    if (error) return error;
    const visitTypeCode = String(code ?? "").trim().toUpperCase();
    if (!fixtures.visitTypes[visitTypeCode]) {
      return { ok: false, error: "unknown_visit_type", next: `Use one of: ${Object.keys(fixtures.visitTypes).join(", ")}.` };
    }
    if (selfPayAcknowledged) call.selfPay = true;
    if (visitTypeCode !== call.visitTypeCode) {
      this.#releaseProposal(call);
      call.options = [];
      call.offered = [];
      call.rescheduleOf = null;
      if (call.state === STATES.OFFERING || call.state === STATES.CONFIRMING) this.#setState(call, STATES.VERIFIED);
    }
    call.visitTypeCode = visitTypeCode;
    const eligibility = this.#eligibility(call, visitTypeCode);
    if (!eligibility.eligible) return this.#blocked(call, eligibility);
    call.eligibility = { ok: true, visitTypeCode, basis: eligibility.basis };
    call.blocked = null;
    this.#event(call, "system", "eligible", `${visitName(visitTypeCode)} · ${eligibility.basis}`);
    this.#publish(call, "state", this.snapshot(call.id));
    return {
      ok: true, result: "eligible", visitTypeCode, visitName: visitName(visitTypeCode), basis: eligibility.basis, booked: false,
      next: "Eligible. If they haven't said, ask which doctor, day or time of day they prefer, then call search_slots.",
    };
  }

  #eligibility(call, code) {
    const now = this.#nowDate();
    const visit = fixtures.visitTypes[code];
    let appointments = [];
    if (visit?.frequencyMonths) {
      const span = visit.frequencyMonths * 30.4375 * DAY_MS;
      appointments = this.schedule.listUpcoming({
        patientId: call.patient.patientId,
        from: iso(now.getTime() - span),
        to: iso(now.getTime() + span),
        statuses: ["booked", "confirmed", "completed"],
      });
    }
    return evaluateEligibility({
      patient: call.patient,
      visitTypeCode: code,
      appointments,
      now,
      selfPayAcknowledged: call.selfPay,
      excludeAppointmentId: call.rescheduleOf?.appointmentId ?? null,
    });
  }

  #blocked(call, eligibility) {
    this.#releaseProposal(call);
    call.options = [];
    call.blocked = { ruleId: eligibility.ruleId, visitTypeCode: call.visitTypeCode, explanation: eligibility.explanation, alternatives: eligibility.alternatives };
    call.eligibility = { ok: false, visitTypeCode: call.visitTypeCode, ruleId: eligibility.ruleId };
    if (call.state === STATES.OFFERING || call.state === STATES.CONFIRMING) this.#setState(call, STATES.VERIFIED);
    this.#event(call, "system", "eligibility_blocked", `${visitName(call.visitTypeCode)} · ${eligibility.ruleId}`);
    this.#publish(call, "state", this.snapshot(call.id));
    const spoken = this.#blockedLine(call, eligibility);
    const next = this.#say(call, `The server's eligibility check blocked this visit type (${eligibility.ruleId}). Explain it once and offer only the alternatives below. Do not search or hold anything for this visit type.`, spoken);
    return { ok: true, result: "not_eligible", ruleId: eligibility.ruleId, explanation: eligibility.explanation, alternatives: eligibility.alternatives, booked: false, next };
  }

  #blockedLine(call, eligibility) {
    const pcp = PROVIDERS.find((p) => p.providerId === call.patient?.pcpProviderId);
    const first = call.patient?.firstName;
    const pcpOffer = !pcp
      ? "I can book a primary care visit"
      : call.proxy
        ? `I can book ${first} a visit with ${pcp.spokenName}, ${first}'s primary care doctor`
        : `I can book you a visit with ${pcp.spokenName}, your primary care doctor`;
    const explain = eligibility.explanation ?? "";
    switch (eligibility.ruleId) {
      case "REFERRAL_REQUIRED": return `${explain} ${pcpOffer}, or connect you with our referral coordinator. Which would you prefer?`;
      case "ORDER_REQUIRED": return `${explain} ${pcpOffer}, or connect you with our scheduling team. Which would you prefer?`;
      case "ANNUAL_TOO_SOON": return `${explain} I can book a follow-up visit instead, or connect you with our scheduling team. Which would you prefer?`;
      case "INSURANCE_INACTIVE": return `${explain} Which would you prefer?`;
      default: return "I can't book that kind of visit by phone, but our scheduling team can help. Would you like me to connect you?";
    }
  }

  // ------------------------------------------------------------------ finding a time

  /**
   * Fresh options from the store. With `more`, the caller's new wishes add to
   * the old ones and the times already offered are skipped. With an
   * appointment handle, this is a reschedule of that appointment.
   */
  searchSlots(callId, { preferences = {}, more = false, appointmentHandle = null } = {}) {
    const { call, error } = this.#verifiedCall(callId);
    if (error) return error;
    if (appointmentHandle) {
      const entry = this.#entry(call, appointmentHandle);
      if (!entry) return { ok: false, error: "unknown_appointment_handle", next: "Call list_upcoming and use one of its handles." };
      if (call.rescheduleOf?.appointmentId !== entry.appointmentId) call.offered = [];
      call.rescheduleOf = entry;
      call.visitTypeCode = entry.visitTypeCode;
    }
    if (!call.visitTypeCode) return { ok: false, error: "visit_type_needed", next: "Ask what kind of visit they need, then call choose_visit_type." };
    const eligibility = this.#eligibility(call, call.visitTypeCode);
    if (!eligibility.eligible) return this.#blocked(call, eligibility);
    if (!call.eligibility?.ok || call.eligibility.visitTypeCode !== call.visitTypeCode) {
      call.eligibility = { ok: true, visitTypeCode: call.visitTypeCode, basis: eligibility.basis };
      this.#event(call, "system", "eligible", `${visitName(call.visitTypeCode)} · ${eligibility.basis}`);
    }
    const prefs = this.#resolvePreferences(preferences);
    if (more) {
      call.preferences = { ...call.preferences, ...prefs };
      call.offered.push(...call.options.map((o) => o.slotKey));
    } else {
      call.preferences = prefs;
      call.offered = [];
    }
    this.#releaseProposal(call);
    this.#event(call, "agent", "search", `${visitName(call.visitTypeCode)}${describePrefs(call.preferences)}${more ? " · more" : ""}${call.rescheduleOf ? ` · moving ${call.rescheduleOf.appointmentId}` : ""}`);
    return this.#offer(call, { more });
  }

  #resolvePreferences(raw = {}) {
    const prefs = {};
    if (raw.providerId && PROVIDERS.some((p) => p.providerId === raw.providerId)) prefs.providerId = raw.providerId;
    else if (raw.providerName) {
      const named = providerByName(raw.providerName);
      if (named) prefs.providerId = named.providerId;
    }
    if (!prefs.providerId && raw.usualDoctor) prefs.usualDoctor = true;
    if (raw.location && fixtures.clinics.locations[raw.location]) prefs.location = raw.location;
    if (raw.timeOfDay === "morning" || raw.timeOfDay === "afternoon") prefs.timeOfDay = raw.timeOfDay;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(raw.date ?? ""))) prefs.date = raw.date;
    if (Number.isInteger(raw.weekday) && raw.weekday >= 0 && raw.weekday <= 6) prefs.weekday = raw.weekday;
    return prefs;
  }

  /**
   * The caller's wishes plus a sensible default: a reschedule stays with the
   * same provider and anything else starts at the patient's home clinic. If
   * the default finds nothing, the search runs again on the caller's wishes alone.
   */
  #searchPrefs(call) {
    const prefs = { ...call.preferences };
    const code = call.visitTypeCode;
    const pcp = call.patient?.pcpProviderId;
    if (prefs.usualDoctor && !providerServes(pcp, code)) delete prefs.usualDoctor;
    let defaulted = false;
    if (!prefs.providerId && !prefs.usualDoctor && !prefs.location) {
      if (call.rescheduleOf && providerServes(call.rescheduleOf.providerId, code)) prefs.providerId = call.rescheduleOf.providerId;
      else {
        const home = PROVIDERS.find((p) => p.providerId === pcp)?.locations?.[0];
        if (home) prefs.location = home;
      }
      defaulted = true;
    }
    return { prefs, defaulted };
  }

  #runSearch(call) {
    const { prefs, defaulted } = this.#searchPrefs(call);
    const args = {
      patientId: call.patient.patientId,
      visitTypeCode: call.visitTypeCode,
      exclude: [...call.offered, ...call.excluded],
      limit: this.options.optionsPerTurn,
    };
    let result = this.schedule.searchSlots({ ...args, preferences: prefs });
    if (result.ok && !result.options.length && defaulted) result = this.schedule.searchSlots({ ...args, preferences: call.preferences });
    return result;
  }

  #offer(call, { lead = null, verb = null, more = false, fresh = false } = {}) {
    if (fresh) call.offered = [];
    const result = this.#runSearch(call);
    if (!result.ok) return { ok: false, error: result.error ?? "search_failed" };
    const prefix = lead ? `${lead} ` : "";

    if (!result.options.length) {
      if (more && call.options.length) {
        call.moreAvailable = false;
        this.#event(call, "system", "no_more", "nothing else fits · the same options stand");
        this.#setState(call, STATES.OFFERING);
        const spoken = `${prefix}That's everything I have that fits. ${this.#offerSentence(call.options, "still")} ${call.options.length > 1 ? "Would either of those work?" : "Would that work?"}`;
        const next = this.#say(call, `Nothing else fits. The same options stand: ${optionList(call.options)}. When the caller picks one, call hold_slot.`, spoken);
        return { ok: true, result: "no_more", options: call.options.map(publicOption), moreAvailable: false, booked: false, next };
      }
      call.options = [];
      if (Object.keys(call.preferences).length) {
        this.#event(call, "system", "no_openings", `nothing fits${describePrefs(call.preferences)}`);
        this.#setState(call, STATES.VERIFIED);
        this.#touch(call);
        const spoken = `${prefix}I don't see an opening that fits that. Would a different day or time work, or another doctor?`;
        const next = this.#say(call, "Nothing fits those wishes. Ask what else would work, then call search_slots again, or offer the waitlist (add_waitlist).", spoken);
        return { ok: true, result: "no_openings", options: [], booked: false, next };
      }
      return this.requestTransfer(call.id, "scheduling_team", "no_availability", "agent", {
        lead: `${prefix}I don't see any openings for that in the next few months.`, by: "system",
      });
    }

    call.options = result.options.map((o, i) => ({ ...o, index: i + 1 }));
    call.moreAvailable = Boolean(result.moreAvailable);
    this.#setState(call, STATES.OFFERING);
    this.#touch(call);
    this.#event(call, "system", "options_offered", call.options.map((o) => o.label).join(" or "));
    this.#publish(call, "schedule", { reason: "options" });
    const question = call.options.length > 1 ? "Would either of those work?" : "Would that work?";
    const spoken = `${prefix}${this.#offerSentence(call.options, verb ?? (more ? "also" : null))} ${question}`;
    const next = this.#say(call, `Offer exactly these options, in this order, and nothing else: ${optionList(call.options)}. When the caller picks one, call hold_slot with its optionIndex. Nothing is booked yet; never say it is.`, spoken);
    return { ok: true, result: "options", options: call.options.map(publicOption), moreAvailable: call.moreAvailable, booked: false, next };
  }

  #offerSentence(options, verb = null) {
    if (options.every((o) => o.providerId === options[0].providerId)) {
      const has = verb === "still" ? "still has" : verb === "also" ? "also has" : "has";
      return sentence(`${options[0].providerName} ${has} ${joinOr(options.map((o) => o.spoken))}`);
    }
    const have = verb === "still" ? "I still have" : verb === "also" ? "I also have" : "I have";
    return sentence(`${have} ${joinOr(options.map((o) => `${o.spoken} with ${o.providerName}`))}`);
  }

  /**
   * Hold the time the caller picked and make it the ACTIVE proposal. A hold
   * is not a booking: it only keeps the time while the caller hears the
   * read-back. Picking another option releases this one.
   */
  holdSlot(callId, { optionId = null, optionIndex = null } = {}) {
    const { call, error } = this.#verifiedCall(callId);
    if (error) return error;
    const option = call.options.find((o) => (optionId && o.optionId === optionId) || (optionIndex != null && o.index === Number(optionIndex)));
    if (!option) {
      return { ok: false, error: "unknown_option", next: call.options.length ? `Use one of the offered options: ${optionList(call.options)}.` : "Call search_slots first." };
    }
    if (call.proposal?.status === "active" && call.proposal.optionId === option.optionId) {
      const spoken = this.#confirmQuestion(call, call.proposal);
      const next = this.#say(call, `${call.proposal.id} is already held. Ask again and wait for the caller's own answer.`, spoken);
      return { ok: true, result: "held", proposalId: call.proposal.id, booked: false, next };
    }
    const eligibility = this.#eligibility(call, call.visitTypeCode);
    if (!eligibility.eligible) return this.#blocked(call, eligibility);
    this.#releaseProposal(call);

    const held = this.schedule.holdSlot(option, {
      patientId: call.patient.patientId,
      ttlMs: this.options.holdTtlMs,
      idempotencyKey: `call:${call.id}:hold:${option.optionId}`,
    });
    if (!held.ok) {
      if (held.error === "slot_taken") {
        return this.#raceLost(call, { id: null, label: option.label, slotKey: option.slotKey }, "Sorry, that time was just taken by someone else.");
      }
      return { ok: false, error: held.error ?? "hold_failed", next: "Offer to search again." };
    }

    call.proposalSeq += 1;
    const timeZone = option.timeZone ?? clinicTimeZone(option.location);
    call.proposal = {
      id: `P${call.proposalSeq}`,
      kind: call.rescheduleOf ? "reschedule" : "book",
      status: "active",
      holdId: held.holdId,
      expiresAt: held.expiresAt,
      heldUntil: clockTime(held.expiresAt, timeZone),
      option,
      optionId: option.optionId,
      slotKey: option.slotKey,
      readBack: held.readBack,
      appointmentId: call.rescheduleOf?.appointmentId ?? null,
      label: option.label,
      handedOff: false,
      at: iso(this.now()),
    };
    call.consent = null;
    this.#setState(call, STATES.CONFIRMING);
    this.#touch(call);
    this.#event(call, "system", "proposal", `${call.proposal.id} · ${option.label} · held until ${call.proposal.heldUntil}`);
    this.#publish(call, "schedule", { reason: "hold" });
    const spoken = this.#confirmQuestion(call, call.proposal);
    const next = this.#say(call, `${call.proposal.id} is held, not booked. Read the confirmation back exactly and wait. When the caller answers, say only "One moment." and call no tool: the server books only on the caller's own yes.`, spoken);
    return { ok: true, result: "held", proposalId: call.proposal.id, readBack: held.readBack, booked: false, next };
  }

  proposeCancel(callId, { appointmentHandle = null, reasonCode = "patient_requested" } = {}) {
    const { call, error } = this.#verifiedCall(callId);
    if (error) return error;
    const entry = appointmentHandle ? this.#entry(call, appointmentHandle) : null;
    if (!entry) return { ok: false, error: "unknown_appointment_handle", next: "Call list_upcoming and use one of its handles." };
    this.#releaseProposal(call);
    call.options = [];
    const hoursAway = (Date.parse(entry.start) - this.now()) / 3_600_000;
    const late = hoursAway < 24 ? (fixtures.clinics.locations[entry.location]?.lateCancellation?.en ?? null) : null;
    call.proposalSeq += 1;
    call.proposal = {
      id: `P${call.proposalSeq}`,
      kind: "cancel",
      status: "active",
      holdId: null,
      appointmentId: entry.appointmentId,
      reasonCode: /^[a-z_]{1,40}$/.test(String(reasonCode ?? "")) ? reasonCode : "patient_requested",
      phrase: entry.phrase,
      late,
      label: entry.label,
      handedOff: false,
      at: iso(this.now()),
    };
    call.consent = null;
    this.#setState(call, STATES.CONFIRMING);
    this.#touch(call);
    this.#event(call, "system", "proposal", `${call.proposal.id} · cancel ${entry.appointmentId} · ${entry.label}`);
    const spoken = this.#confirmQuestion(call, call.proposal);
    const next = this.#say(call, `${call.proposal.id} is a proposed cancellation; nothing has changed yet. Read it back and wait. When the caller answers, say only "One moment." and call no tool.`, spoken);
    return { ok: true, result: "proposed", proposalId: call.proposal.id, booked: false, next };
  }

  #confirmQuestion(call, proposal) {
    if (proposal.kind === "cancel") return `To confirm: you'd like to cancel your ${sentence(proposal.phrase)}${proposal.late ? ` ${proposal.late}` : ""} Shall I cancel it?`;
    if (proposal.kind === "reschedule") {
      const o = proposal.option;
      return `To confirm: I'll move your ${call.rescheduleOf.visitName} from ${call.rescheduleOf.when} to ${o.spoken} with ${o.providerName}, at the ${o.locationName}. Shall I make that change?`;
    }
    return `To confirm: ${proposal.readBack}. Shall I book it?`;
  }

  #releaseProposal(call) {
    const proposal = call.proposal;
    if (!proposal || proposal.status !== "active") return;
    if (proposal.holdId) this.schedule.releaseHold(proposal.holdId);
    proposal.status = "released";
    call.proposal = null;
    call.consent = null;
    this.#event(call, "system", "proposal_released", `${proposal.id} released · nothing written`);
    this.#publish(call, "schedule", { reason: "release" });
  }

  // ------------------------------------------------------------------ THE GATE

  /**
   * Every caller utterance passes through here before the model acts on it.
   * Returns { handled: true } when the server took the turn itself (a safety
   * escalation, or the caller's answer to the ACTIVE proposal); the bridge
   * then cancels the model's own reply. This is the only place a yes counts.
   */
  callerSaid(callId, text, via = "speech") {
    const call = this.get(callId);
    const said = String(text ?? "").trim();
    if (!call || TERMINAL.has(call.state) || call.state === STATES.ESCALATING || !said) return { handled: false };
    call.noInputs = 0;
    return this.#callerTurn(call, () => {
      if (!call.safety) {
        const safety = classifySafety(said);
        if (safety) return { handled: true, ...this.#safetyEscalation(call, safety) };
      }
      if (call.state === STATES.CONFIRMING && call.proposal?.status === "active") {
        if (isAffirmative(said)) return { handled: true, ...this.#commit(call, via) };
        if (PICK_WORDS.test(said)) return { handled: false };
        if (isNegative(said)) return { handled: true, ...this.#decline(call) };
        return { handled: false };
      }
      if (demandsBooking(said) && !PICK_WORDS.test(said)) {
        return { handled: false, ...this.#refuse(call, "no_active_proposal", via) };
      }
      return { handled: false };
    });
  }

  /** Lines the server speaks on the caller's own turn cut off whatever the model had started to say. */
  #callerTurn(call, handle) {
    call.callerTurn = true;
    try {
      return handle();
    } finally {
      call.callerTurn = false;
    }
  }

  /** Keypad: 1 confirms and 2 declines the ACTIVE proposal; 0 asks for a person at any time. */
  dtmf(callId, digit) {
    const call = this.get(callId);
    const key = String(digit ?? "").trim();
    if (!call || TERMINAL.has(call.state) || call.state === STATES.ESCALATING || !key) return { handled: false };
    call.noInputs = 0;
    this.#event(call, "caller", "keypad", `pressed ${key}`);
    return this.#callerTurn(call, () => {
      if (key === "0") return { handled: true, ...this.requestTransfer(call.id, "scheduling_team", "caller_request", "keypad") };
      if (call.state === STATES.CONFIRMING && call.proposal?.status === "active") {
        if (key === "1") return { handled: true, ...this.#commit(call, "keypad") };
        if (key === "2") return { handled: true, ...this.#decline(call) };
      }
      return { handled: false };
    });
  }

  /** The only write path: the caller's own yes to the ACTIVE proposal. */
  #commit(call, via) {
    const proposal = call.proposal;
    if (!proposal || proposal.status !== "active") return this.#refuse(call, "no_active_proposal", via);
    if (!call.patient) return this.#refuse(call, "not_verified", via);
    if (call.consent?.proposalId === proposal.id && !call.consent.refused) return this.#refuse(call, "booking_locked", via);
    if (proposal.kind !== "cancel") {
      const eligibility = this.#eligibility(call, call.visitTypeCode);
      if (!eligibility.eligible) return this.#blocked(call, eligibility);
    }
    call.consent = { proposalId: proposal.id, via, detail: via === "keypad" ? "pressed 1" : "said yes", refused: null, at: iso(this.now()) };
    this.#event(call, "caller", "consent", `${proposal.id} · ${call.consent.detail} to ${proposal.label}`);
    this.#touch(call);
    const key = `call:${call.id}:${proposal.kind}:${proposal.holdId ?? proposal.appointmentId}`;
    let result;
    try {
      if (proposal.kind === "cancel") {
        result = this.schedule.cancelAppointment(proposal.appointmentId, proposal.reasonCode, key);
      } else if (proposal.kind === "reschedule") {
        result = this.schedule.rescheduleAppointment({ appointmentId: proposal.appointmentId, holdId: proposal.holdId, patientId: call.patient.patientId, reason: call.reason, idempotencyKey: key });
      } else {
        result = this.schedule.bookAppointment({ holdId: proposal.holdId, patientId: call.patient.patientId, reason: call.reason, idempotencyKey: key });
      }
    } catch (error) {
      // The store's own error stays in the server log; the caller hears that nothing was written.
      console.error(`[scheduling] ${proposal.kind} ${proposal.id} was not written:`, error.message);
      result = { ok: false, error: "write_failed" };
    }
    return result?.ok ? this.#written(call, proposal, result) : this.#writeFailed(call, proposal, result ?? { ok: false, error: "write_failed" });
  }

  #written(call, proposal, result) {
    const appt = result.appointment;
    const timeZone = clinicTimeZone(appt.location);
    const provider = appt.provider?.name ?? "your provider";
    const clinic = clinicName(appt.location);
    const code = visitCodeOf(appt.visitType);
    const visit = code ? visitName(code) : String(appt.visitType).toLowerCase();
    const prep = fixtures.prep[appt.prepCode]?.en ?? null;
    const when = spokenWhen(appt.start, timeZone, this.#nowDate());
    const confirmation = spellId(appt.appointmentId);
    proposal.status = "written";
    proposal.appointmentId = appt.appointmentId;
    call.booking = {
      kind: proposal.kind,
      appointmentId: appt.appointmentId,
      previousAppointmentId: proposal.kind === "reschedule" ? result.oldAppointment?.appointmentId ?? null : null,
      visitName: visit,
      providerId: appt.providerId ?? proposal.option?.providerId ?? null,
      providerName: provider,
      locationName: clinic,
      start: appt.start,
      end: appt.end,
      label: shortLabel(appt.start, timeZone),
      prep,
      proposalId: proposal.id,
      consent: call.consent?.detail ?? null,
      afterRace: call.races > 0,
    };
    const kind = proposal.kind === "cancel" ? "cancelled" : proposal.kind === "reschedule" ? "rescheduled" : "booked";
    const prepLine = prep ? `${prep} ` : "";
    const spoken = kind === "cancelled"
      ? `Your ${proposal.phrase} is cancelled. Thanks for calling ${ORG}.`
      : kind === "rescheduled"
        ? `Done. Your ${visit} is now ${when} with ${provider}, at the ${clinic}. ${prepLine}Your confirmation number is ${confirmation}. Thanks for calling ${ORG}.`
        : `You're booked with ${provider} ${onWhen(when)}, at the ${clinic}. ${prepLine}Your confirmation number is ${confirmation}. Thanks for calling ${ORG}.`;
    this.#event(call, "system", kind, `${appt.appointmentId} · ${call.booking.label} · ${proposal.id} confirmed by the caller`);
    if (call.races > 0 && kind !== "cancelled") this.#event(call, "system", "race_resolved", `${appt.appointmentId} · fresh pick ${proposal.id}, fresh yes`);
    this.#publish(call, "schedule", { reason: kind, appointmentId: appt.appointmentId });
    const next = this.#say(call, `The server wrote ${appt.appointmentId}. Say this once, then call end_call.`, spoken, { interrupt: true });
    this.#finish(call, kind === "cancelled" ? STATES.CANCELLED : kind === "rescheduled" ? STATES.RESCHEDULED : STATES.BOOKED, `${kind}:${appt.appointmentId}`, { appointmentId: appt.appointmentId });
    return { ok: true, result: kind, appointmentId: appt.appointmentId, booked: kind !== "cancelled", confirmation, next };
  }

  #writeFailed(call, proposal, result) {
    call.refusals += 1;
    if (call.consent) call.consent.refused = result.error;
    this.#event(call, "system", "write_refused", `${proposal.id} · ${result.error} · nothing written`);
    if (result.error === "slot_taken") {
      return this.#raceLost(call, proposal, "Sorry, that time was just taken, so I haven't booked anything.");
    }
    if (result.error === "hold_expired" || result.error === "hold_not_found") {
      proposal.status = "expired";
      call.proposal = null;
      return this.#offer(call, { lead: "Sorry, I held that time as long as I could and it was released, so I haven't booked anything.", verb: "still", fresh: true });
    }
    proposal.status = "failed";
    call.proposal = null;
    if (proposal.holdId) this.schedule.releaseHold(proposal.holdId);
    return this.requestTransfer(call.id, "scheduling_team", "write_failed", "agent", { lead: "Sorry, something went wrong on our side, so I haven't booked anything.", by: "system" });
  }

  /**
   * Someone else got the time first. The proposal is void, the time is never
   * offered again on this call, and the caller hears fresh options: the
   * server never moves a yes onto a different time.
   */
  #raceLost(call, lost, lead) {
    call.races += 1;
    call.raceLost = { proposalId: lost.id ?? null, label: lost.label, at: iso(this.now()) };
    if (lost.slotKey) call.excluded.push(lost.slotKey);
    if (lost.holdId) this.schedule.releaseHold(lost.holdId);
    if (lost.id && call.proposal?.id === lost.id) {
      call.proposal.status = "void";
      call.proposal = null;
    }
    this.#event(call, "system", "slot_taken", `${lost.id ? `${lost.id} void · ` : ""}${lost.label} was booked by another channel`);
    this.#publish(call, "schedule", { reason: "slot_taken" });
    return this.#offer(call, { lead, verb: "still", fresh: true });
  }

  #decline(call) {
    const proposal = call.proposal;
    this.#event(call, "caller", "declined", `${proposal.id} · nothing written`);
    this.#releaseProposal(call);
    if (proposal.kind === "cancel") {
      this.#setState(call, STATES.VERIFIED);
      const spoken = "Okay, I've left it as it is. Is there anything else I can help with?";
      const next = this.#say(call, "The caller kept the appointment; nothing changed.", spoken, { interrupt: true });
      return { ok: true, result: "declined", booked: false, next };
    }
    const others = call.options.filter((o) => o.optionId !== proposal.optionId);
    this.#setState(call, call.options.length ? STATES.OFFERING : STATES.VERIFIED);
    this.#touch(call);
    const spoken = others.length
      ? `No problem, I haven't booked anything. ${this.#offerSentence(others, "also")} Would that work, or would you like a different day or time?`
      : "No problem, I haven't booked anything. Would a different day or time work better?";
    const next = this.#say(call, `The caller said no to ${proposal.id}; it is released and nothing was booked. Ask what would work, then search_slots or hold_slot.`, spoken, { interrupt: true });
    return { ok: true, result: "declined", booked: false, next };
  }

  /** A write the server will not make. Logged, explained, and nothing changes. */
  #refuse(call, reason, via) {
    call.refusals += 1;
    const detail = {
      no_active_proposal: "no active proposal",
      model_cannot_book: "the model has no booking tool",
      not_verified: "caller not verified",
      booking_locked: "already confirmed",
    }[reason] ?? reason;
    this.#event(call, via === "agent" ? "agent" : "caller", "write_refused", `${detail} · nothing written`);
    this.#touch(call);
    const spoken = this.#refusalLine(call, reason);
    const next = this.#say(call, `The server refused to write (${reason}). Only the caller's own yes to a read-back proposal books anything. Nothing was booked; never say it was.`, spoken, { quiet: via !== "agent" });
    return { ok: false, refused: true, reason, booked: false, say: spoken, next };
  }

  #refusalLine(call, reason) {
    if (reason === "booking_locked") return "That's already confirmed.";
    if (!call.patient) return "I can't book anything until I've confirmed who I'm speaking with. What's the patient's full name and date of birth?";
    const lead = "I can't book anything until you've heard a specific time and said yes to it.";
    if (call.state === STATES.OFFERING && call.options.length) return `${lead} ${this.#offerSentence(call.options)} Which would you like?`;
    if (call.state === STATES.CONFIRMING && call.proposal) return `${lead} ${this.#confirmQuestion(call, call.proposal)}`;
    if (call.visitTypeCode) return `${lead} Which doctor, day or time of day would you like?`;
    return `${lead} What kind of visit do you need?`;
  }

  /** book, reschedule and cancel are not tools. A model that names one anyway lands here. */
  refuseModelWrite(callId, name) {
    const call = this.get(callId);
    if (!call) return { ok: false, error: "unknown_call" };
    if (TERMINAL.has(call.state)) return { ok: false, refused: true, reason: "model_cannot_book", tool: name, booked: false };
    return { ...this.#refuse(call, "model_cannot_book", "agent"), tool: name };
  }

  /**
   * Demo control only (the server answers 403 on a live call): someone else,
   * say the front desk, books the time this caller is about to accept. The
   * call itself is not told. The race surfaces where it would in production:
   * when the caller says yes, the write is refused and fresh options follow.
   */
  takeSlotForDemo(callId) {
    const call = this.get(callId);
    if (!call) return { ok: false, error: "unknown_call" };
    if (TERMINAL.has(call.state)) return { ok: false, error: "call_finished" };
    const proposal = call.proposal?.status === "active" && call.proposal.kind !== "cancel" ? call.proposal : null;
    const option = proposal ? null : call.options[0] ?? null;
    if (!proposal?.holdId && !option) return { ok: false, error: "nothing_to_take", next: "Wait until a time has been offered or read back." };
    const taken = this.schedule.takeSlot(proposal ? { holdId: proposal.holdId } : { option });
    if (!taken.ok) return taken;
    const label = proposal?.label ?? option.label;
    this.#event(call, "system", "taken_elsewhere", `${label} booked by the front desk · this caller isn't told until they say yes`);
    this.#publish(call, "schedule", { reason: "taken_elsewhere", appointmentId: taken.appointmentId });
    return { ok: true, result: "taken", label, appointmentId: taken.appointmentId, proposalId: proposal?.id ?? null };
  }

  // ------------------------------------------------------------------ everything else the caller can do

  /** Safety words outrank everything, including an open proposal: nothing is booked, and a nurse hears it. */
  #safetyEscalation(call, safety) {
    call.safety = safety;
    this.#event(call, "system", "safety", `${safety.level} words heard · nothing booked · nurse line`);
    const lead = safety.level === "emergency"
      ? "If this is an emergency, please hang up and call 911 now."
      : "That sounds like something a nurse should hear about today.";
    return this.requestTransfer(call.id, "nurse_line", safety.level, "agent", { lead, by: "system" });
  }

  addWaitlist(callId) {
    const { call, error } = this.#verifiedCall(callId);
    if (error) return error;
    if (!call.visitTypeCode) return { ok: false, error: "visit_type_needed", next: "Ask what kind of visit they need, then call choose_visit_type." };
    const eligibility = this.#eligibility(call, call.visitTypeCode);
    if (!eligibility.eligible) return this.#blocked(call, eligibility);
    this.#releaseProposal(call);
    const entry = this.schedule.addWaitlist({ patientId: call.patient.patientId, visitTypeCode: call.visitTypeCode, preferences: call.preferences });
    this.#event(call, "system", "waitlisted", `${visitName(call.visitTypeCode)}${describePrefs(call.preferences)} · nothing booked`);
    const spoken = `I've added you to the waitlist for ${withArticle(visitName(call.visitTypeCode))}, and we'll call you if something opens up. Thanks for calling ${ORG}.`;
    const next = this.#say(call, "The caller is on the waitlist; nothing is booked. Say this once, then call end_call.", spoken);
    this.#finish(call, STATES.WAITLISTED, `waitlisted:${entry.waitlistId}`);
    return { ok: true, result: "waitlisted", booked: false, next };
  }

  repeatLast(callId) {
    const { call, error } = this.#active(callId);
    if (error) return error;
    const next = this.#say(call, "Repeat your last message exactly, then wait.", call.lastSpoken ?? this.#reprompt(call));
    return { ok: true, result: "repeated", next };
  }

  /** The offline driver's turn when nothing it heard was actionable: say the server's line, or re-ask. */
  askAgain(callId, spoken = null) {
    const { call, error } = this.#active(callId);
    if (error) return error;
    const next = this.#say(call, "Say this, then wait for the caller.", spoken ?? this.#reprompt(call));
    return { ok: true, result: "asked", next };
  }

  notUnderstood(callId) {
    const { call, error } = this.#active(callId);
    if (error) return error;
    if (call.state === STATES.ESCALATING) return { ok: false, error: "escalating" };
    call.misheard += 1;
    this.#event(call, "caller", "not_understood", `${call.misheard} of 3`);
    if (call.misheard >= 3) {
      return this.requestTransfer(call.id, "scheduling_team", "not_understood", "agent", { lead: "I'm sorry, I'm having trouble with this.", by: "system" });
    }
    const next = this.#say(call, "You didn't catch that. Say so and ask again.", `Sorry, I didn't catch that. ${this.#reprompt(call)}`);
    return { ok: true, result: "reprompted", next };
  }

  /** Silence. Once: are you still there? Twice: a person, or the number to call back. */
  noInput(callId) {
    const { call, error } = this.#active(callId);
    if (error) return error;
    if (call.state === STATES.ESCALATING) return { ok: false, error: "escalating" };
    call.noInputs += 1;
    this.#event(call, "caller", "no_input", `${call.noInputs} of 2`);
    if (call.noInputs >= 2) {
      return this.requestTransfer(call.id, "scheduling_team", "two_no_inputs", "agent", {
        lead: "I'm having trouble hearing you.",
        afterHours: "advise",
        adviseLine: `Please call us back at ${MAIN_NUMBER} when you're ready.`,
        by: "system",
      });
    }
    const next = this.#say(call, "The caller is silent. Check they are there and ask again.", `Are you still there? ${this.#reprompt(call)}`);
    return { ok: true, result: "reprompted", next };
  }

  #reprompt(call) {
    switch (call.state) {
      case STATES.RINGING:
      case STATES.VERIFYING: return "What's the patient's full name and date of birth?";
      case STATES.REGISTERING: return "What's the best number for our registration team to call you on?";
      case STATES.OFFERING: return call.options.length ? `${this.#offerSentence(call.options)} Which would you like?` : "What day or time works for you?";
      case STATES.CONFIRMING: return call.proposal ? this.#confirmQuestion(call, call.proposal) : "Shall I go ahead?";
      default: return call.visitTypeCode ? "Which doctor, day or time of day works for you?" : "What kind of visit do you need?";
    }
  }

  endCall(callId, outcome = "caller_ended", reason = null) {
    const call = this.get(callId);
    if (!call || TERMINAL.has(call.state)) return { ok: true };
    if (reason) this.#event(call, "agent", "end_call", String(reason).slice(0, 80));
    this.#finish(call, STATES.ENDED, outcome);
    return { ok: true };
  }

  /**
   * The model's end_call. A call on its way to a person, or already with one,
   * is not the model's to end: hanging up would drop the caller mid-transfer,
   * and a transfer ACS later reports as failed still needs its apology. The
   * caller hanging up (endCall, on CallDisconnected) still ends it.
   */
  agentEndCall(callId, reason = null) {
    const state = this.get(callId)?.state;
    if (state === STATES.ESCALATING || state === STATES.TRANSFERRED) {
      return { ok: false, reason: "transfer_in_progress", next: "The call is being handed to a person. Say nothing more." };
    }
    return this.endCall(callId, "agent_ended", reason);
  }

  /** The whole call has a time budget. Past it, a person takes over. Safe to call on a timer. */
  checkBudget(callId) {
    const call = this.get(callId);
    if (!call || call.answeredAt == null || TERMINAL.has(call.state) || call.state === STATES.ESCALATING) return { ok: true };
    if (this.now() - call.answeredAt < this.options.callTimeBudgetMs) return { ok: true };
    this.#event(call, "system", "budget_expired", `${Math.round(this.options.callTimeBudgetMs / 60_000)} minutes`);
    return this.requestTransfer(call.id, "scheduling_team", "time_budget", "agent", { lead: "I'm sorry this is taking so long.", by: "system" });
  }

  /** Caller lines lose dates of birth and phone numbers before they are kept or shown. */
  pushTranscript(callId, role, text) {
    const call = this.get(callId);
    const said = String(text ?? "").trim();
    if (!call || !said) return null;
    const entry = { role, text: role === "caller" ? maskTranscript(said) : said, at: iso(this.now()) };
    call.transcript.push(entry);
    if (call.transcript.length > 200) call.transcript.shift();
    this.audit.recordTranscript?.(call.id, role, entry.text);
    this.#publish(call, "transcript", entry);
    return entry;
  }

  // ------------------------------------------------------------------ people

  /**
   * Hand the call to a person. Open: a Teams transfer with context. Closed: a
   * callback ticket, or (for identity and nurse questions) advice on who to
   * call. A held time goes along only to an open scheduling team.
   */
  requestTransfer(callId, destination, reason = "caller_request", via = "agent", { lead = null, afterHours = null, adviseLine = null, by = null } = {}) {
    const { call, error } = this.#active(callId);
    if (error) return error;
    if (call.state === STATES.ESCALATING) return { ok: false, error: "already_transferring", next: "A handoff is already under way. Say nothing more." };
    const route = this.routes.get(destination);
    if (!route) {
      const allowed = Object.keys(this.routes.doc.destinations ?? {}).filter((id) => this.routes.get(id).target !== "callback");
      return { ok: false, error: "unknown_destination", next: `Use one of: ${allowed.join(", ")}.` };
    }
    if (route.target === "callback") return this.requestCallback(callId, { queue: destination });

    const open = this.routes.isOpen(destination, this.#nowDate());
    const proposal = call.proposal?.status === "active" ? call.proposal : null;
    if (proposal?.holdId && open && destination === "scheduling_team") {
      const extended = this.schedule.extendHold(proposal.holdId, this.options.holdTtlMs);
      if (extended.ok) {
        proposal.handedOff = true;
        proposal.expiresAt = extended.expiresAt;
        proposal.heldUntil = clockTime(extended.expiresAt, proposal.option?.timeZone ?? clinicTimeZone(proposal.option?.location));
      } else this.#releaseProposal(call);
    } else if (proposal) this.#releaseProposal(call);

    let mode = open ? "transfer" : (afterHours ?? route.afterHours ?? "callback");
    let line = adviseLine ?? route.afterHoursLine;
    if (mode === "callback" && !callerDigits(call)) {
      mode = "advise";
      line = `Our ${route.label.toLowerCase()} is closed right now. Please call us back at ${MAIN_NUMBER} during business hours.`;
    }
    call.destination = {
      id: destination,
      label: route.label,
      reason,
      topic: this.routes.topicFor(destination, reason),
      afterHours: !open,
      target: route.target,
      type: route.type ?? "callQueue",
      mode,
      by: by ?? via,
    };
    const source = by === "system" ? "system" : via === "agent" ? "agent" : "caller";
    this.#event(call, source, "handoff_requested", `${route.label} · ${reason.replace(/_/g, " ")}${open ? "" : ` · closed, ${mode}`}`);
    const prefix = lead ? `${lead} ` : "";

    if (mode === "transfer") {
      this.#setState(call, STATES.ESCALATING);
      const spoken = `${prefix}I'm connecting you with our ${route.label.toLowerCase()} now.`;
      const next = this.#say(call, `The server is transferring the call to the ${route.label}. Say this once and then nothing more.`, spoken, { interrupt: true });
      this.#scheduleDispatch(call);
      return { ok: true, result: "transferring", destination, booked: false, next };
    }
    if (mode === "advise") {
      const spoken = `${prefix}${line} Thanks for calling ${ORG}.`;
      const next = this.#say(call, `The ${route.label} is closed. Say this once, then call end_call.`, spoken, { interrupt: true });
      this.#event(call, "system", "advised", `${route.label} closed · caller told who to call`);
      this.#finish(call, STATES.ENDED, `advised:${destination}`);
      return { ok: true, result: "advised", destination, booked: false, next };
    }
    call.callback = { queue: destination, label: route.label, number: callerDigits(call), preferredTime: null, reason, at: iso(this.now()) };
    call.handoffKind = "callback";
    call.handoff = this.handoffContext(call);
    this.#event(call, "system", "callback_filed", `${route.label} · ${maskPhone(call.callback.number)} · after hours`);
    this.#publish(call, "handoff", call.handoff);
    const spoken = `${prefix}${line} Thanks for calling ${ORG}.`;
    const next = this.#say(call, `The ${route.label} is closed, so the server filed a callback. Say this once, then call end_call.`, spoken, { interrupt: true });
    this.#finish(call, STATES.CALLBACK_FILED, `callback:${destination}`);
    return { ok: true, result: "callback_filed", destination, booked: false, next };
  }

  /** A callback ticket: registration for new patients, or a staffed queue. Nothing is booked. */
  requestCallback(callId, { queue = "scheduling_team", preferredTime = null, callbackNumber = null } = {}) {
    const { call, error } = this.#active(callId);
    if (error) return error;
    if (call.state === STATES.ESCALATING) return { ok: false, error: "already_transferring" };
    const route = this.routes.get(queue);
    if (!route) return { ok: false, error: "unknown_queue", next: `Use one of: ${Object.keys(this.routes.doc.destinations ?? {}).join(", ")}.` };
    const time = String(preferredTime ?? "").replace(/[^\w ,:'-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || null;
    const given = String(callbackNumber ?? "").replace(/\D/g, "");
    const registration = route.target === "callback";
    const number = given.length >= 10 ? given : registration ? null : callerDigits(call);

    if (!number) {
      if (registration && call.state !== STATES.REGISTERING) {
        this.#releaseProposal(call);
        this.#setState(call, STATES.REGISTERING);
        this.#event(call, "agent", "registration", "new patient · registration callback offered");
      }
      const spoken = registration
        ? "Welcome. New patients are set up by our registration team, so I can't book by phone yet. What's the best number and time for them to call you?"
        : "What's the best number for them to call you back on?";
      const next = this.#say(call, "Ask for a callback number and a preferred time, then call request_callback again with them.", spoken);
      return { ok: true, result: "number_needed", booked: false, next };
    }

    this.#releaseProposal(call);
    call.callback = { queue, label: route.label, number, preferredTime: time, reason: registration ? "new_patient" : "caller_request", at: iso(this.now()) };
    call.handoffKind = "callback";
    call.handoff = this.handoffContext(call);
    this.#event(call, "system", "callback_filed", `${route.label} · ${maskPhone(number)}${time ? ` · ${time}` : ""}`);
    this.#publish(call, "handoff", call.handoff);
    const noted = time ? `, and I've noted your preferred time: ${time}` : "";
    const spoken = registration
      ? `Thanks. Our registration team will call you back to get you set up${noted}. Goodbye for now.`
      : `I've asked our ${route.label.toLowerCase()} to call you back${time ? noted : " as soon as they can"}. Thanks for calling ${ORG}.`;
    const next = this.#say(call, "The callback is filed; nothing is booked. Say this once, then call end_call.", spoken);
    this.#finish(call, STATES.CALLBACK_FILED, `callback:${queue}`);
    return { ok: true, result: "callback_filed", booked: false, next };
  }

  #scheduleDispatch(call) {
    // A second request inside the window replaces the pending transfer instead of racing it.
    this.#cancelPendingDispatch(call);
    const delay = this.options.transferDelayMs;
    if (delay <= 0) {
      call.dispatchPromise = this.dispatchTransfer(call.id);
      return;
    }
    call.pendingDispatch = setTimeout(() => {
      call.pendingDispatch = null;
      call.dispatchPromise = this.dispatchTransfer(call.id);
    }, delay);
    call.pendingDispatch.unref?.();
  }

  /** Resolves once any in-flight transfer has settled. Used by tests and the console. */
  async settled(callId) {
    await this.get(callId)?.dispatchPromise;
    return this.snapshot(callId);
  }

  #cancelPendingDispatch(call) {
    if (call.pendingDispatch) {
      clearTimeout(call.pendingDispatch);
      call.pendingDispatch = null;
    }
  }

  /** Hand the call to Teams: one retry, then the scheduling team, then an honest apology. */
  async dispatchTransfer(callId) {
    const call = this.#require(callId);
    if (call.dispatched || call.destination?.mode !== "transfer" || TERMINAL.has(call.state)) return { ok: false, reason: "nothing_to_dispatch" };
    call.dispatched = true;
    call.transferAttempts += 1;
    const context = this.handoffContext(call);
    call.handoffKind = "transfer";
    call.handoff = context;
    this.#event(call, "system", "transfer_started", call.destination.label);
    if (!this.transfer || call.simulated) {
      this.#event(call, "system", "transfer_simulated", `${call.destination.label} · Teams call topic and context attached`);
      this.#publish(call, "handoff", context);
      this.#finish(call, STATES.TRANSFERRED, `transferred:${call.destination.id}`);
      return { ok: true, simulated: true, context };
    }
    try {
      await this.transfer(call, { ...call.destination, context });
      this.#event(call, "system", "transfer_succeeded", call.destination.label);
      this.#publish(call, "handoff", context);
      this.#finish(call, STATES.TRANSFERRED, `transferred:${call.destination.id}`);
      return { ok: true, context };
    } catch (error) {
      // ACS's reason can name the number or the Teams target it dialed, so it stays in the server log.
      console.error(`[scheduling] transfer to ${call.destination.label} failed:`, error.message);
      this.#event(call, "system", "transfer_failed", `${call.destination.label} (the reason is in the server log)`);
      return this.#handleTransferFailure(call, error);
    }
  }

  /** ACS accepted the transfer, then reported CallTransferFailed: the caller is still with us. */
  async transferFailed(callId, message = "transfer failed") {
    const call = this.get(callId);
    if (!call || call.simulated || call.state !== STATES.TRANSFERRED || !call.destination) return { ok: false, reason: "nothing_to_recover" };
    call.outcome = null;
    call.endedAt = null;
    call.dispatched = false;
    this.audit.updateCall(call.id, { outcome: null, endedAt: null, durationMs: null });
    this.#setState(call, STATES.ESCALATING);
    // server.mjs logged ACS's reason with the callback; the console and the audit get a fixed one.
    this.#event(call, "system", "transfer_failed", `${call.destination.label} (the reason is in the server log)`);
    return this.#handleTransferFailure(call, new Error(message));
  }

  async #handleTransferFailure(call, error) {
    if (call.transferAttempts < 2) {
      this.#event(call, "system", "transfer_retry", call.destination.label);
      call.dispatched = false;
      return this.dispatchTransfer(call.id);
    }
    if (call.destination.id !== "scheduling_team" && this.routes.isOpen("scheduling_team", this.#nowDate())) {
      const route = this.routes.get("scheduling_team");
      this.#event(call, "system", "transfer_diverted", route.label);
      call.destination = { ...call.destination, id: "scheduling_team", label: route.label, target: route.target, type: route.type ?? "callQueue", topic: this.routes.topicFor("scheduling_team", call.destination.reason) };
      call.dispatched = false;
      call.transferAttempts = 1;
      return this.dispatchTransfer(call.id);
    }
    this.#say(call, "The transfer did not go through. Apologize once and give the number to call back. Then call end_call.", `I'm sorry, I can't connect you right now. Please call us back at ${MAIN_NUMBER}.`, { interrupt: true });
    this.#finish(call, STATES.ENDED, "transfer_failed");
    return { ok: false, reason: "transfer_unavailable", error: error.message };
  }

  /**
   * What the person picking up sees: the Teams call topic, and a CallContext
   * with only the fields routing.json allows for that destination. A caller
   * who was not verified carries no patient details at all.
   */
  handoffContext(call) {
    const id = call.destination?.id ?? call.callback?.queue ?? null;
    if (!id) return null;
    const route = this.routes.get(id);
    const reason = call.destination?.id === id ? call.destination.reason : call.callback?.reason ?? null;
    const sessionId = call.sessionId ?? call.id;
    const callTopic = clipTopic(this.routes.topicFor(id, reason));
    const callContext = this.routes.context(id, this.#contextValues(call, reason));
    return {
      destination: id,
      label: route?.label ?? id,
      reason,
      kind: call.callback?.queue === id ? "callback" : "transfer",
      mode: call.destination?.id === id ? call.destination.mode : "callback",
      afterHours: Boolean(call.destination?.afterHours),
      target: route?.target ?? null,
      sessionId,
      callTopic,
      callContext,
      voipHeaders: buildCustomCallingContext({ sessionId, callTopic, callContext }),
    };
  }

  #contextValues(call, reason) {
    const verified = !call.patient ? "no"
      : call.verifiedBy === "handoff" ? "yes (one-time reminder token)"
        : call.proxy ? `yes (${call.proxy.relationship} on file as authorized)` : "yes (name + date of birth)";
    const held = call.proposal?.status === "active" && call.proposal.handedOff ? call.proposal : null;
    const visit = call.patient && call.visitTypeCode ? visitName(call.visitTypeCode) : null;
    return {
      firstName: call.patient?.firstName ?? null,
      verified,
      visitType: visit,
      eligibility: !call.patient ? null : call.blocked ? `not bookable by voice (${call.blocked.ruleId})` : call.eligibility?.ok ? `eligible (${call.eligibility.basis})` : null,
      heldSlot: held ? `${held.label} (held until ${held.heldUntil})` : null,
      reason: reason ? reason.replace(/_/g, " ") : null,
      department: call.blocked ? fixtures.visitTypes[call.blocked.visitTypeCode]?.department ?? null : null,
      ruleId: call.blocked?.ruleId ?? null,
      safety: call.safety ? `${call.safety.level}: "${call.safety.phrase}"` : null,
      callbackNumber: call.callback?.number ? maskPhone(call.callback.number) : null,
      preferredTime: call.callback?.preferredTime ?? null,
      summary: this.#summary(call),
    };
  }

  /** One line for the person picking up. Never a name, a date of birth or a phone number. */
  #summary(call) {
    if (!call.patient) {
      if (call.callback?.reason === "new_patient") return "New patient · asked to be registered · nothing booked";
      return call.attempts >= 2 ? "Caller not verified after two attempts · nothing about appointments disclosed" : "Caller not verified · nothing disclosed";
    }
    const parts = [call.proxy ? `Verified ${call.proxy.relationship} calling for the patient` : "Verified patient"];
    if (call.visitTypeCode) parts.push(visitName(call.visitTypeCode));
    if (call.blocked) parts.push(`blocked: ${call.blocked.ruleId}`);
    if (call.rescheduleOf) parts.push(`moving ${call.rescheduleOf.label}`);
    if (call.raceLost) parts.push(`${call.raceLost.label} was taken by another channel`);
    if (call.safety) parts.push(`${call.safety.level} words heard`);
    parts.push(call.booking ? `booked ${call.booking.appointmentId}` : "nothing booked");
    return parts.join(" · ");
  }

  // ------------------------------------------------------------------ internals

  #finish(call, state, outcome, extra = {}) {
    this.#cancelPendingDispatch(call);
    if (call.proposal?.status === "active" && !call.proposal.handedOff) this.#releaseProposal(call);
    call.outcome = outcome;
    call.endedAt = this.now();
    this.#setState(call, state);
    this.audit.updateCall(call.id, {
      outcome,
      endedAt: iso(call.endedAt),
      durationMs: call.endedAt - call.startedAt,
      ...extra,
    });
  }

  #setState(call, state) {
    if (call.state === state) return;
    const from = call.state;
    call.state = state;
    this.audit.updateCall(call.id, { state });
    this.#event(call, "system", "state", `${from} → ${state}`);
    this.#publish(call, "state", this.snapshot(call.id));
  }

  /**
   * One line for the agent to say now (instruct) or, when `quiet`, only to
   * know (nudge). Returns the text, which tools hand back as `next`.
   */
  #say(call, instruction, spoken, { quiet = false, interrupt = null } = {}) {
    const say = this.language.code === "en" ? "Say:" : `Say this in ${this.language.label}, keeping every fact:`;
    const text = spoken ? `${instruction}\n${say} "${spoken}"` : instruction;
    const agent = this.agents.get(call.id);
    if (quiet) {
      agent?.nudge?.(text, { spoken });
      return text;
    }
    call.lastSpoken = spoken ?? call.lastSpoken;
    call.lastInstruction = instruction;
    agent?.instruct?.(text, spoken, { interrupt: interrupt ?? Boolean(call.callerTurn) });
    return text;
  }

  #touch(call) {
    call.touchedAt = this.now();
  }

  #event(call, source, kind, detail) {
    this.audit.recordEvent(call.id, source, kind, detail);
    this.#publish(call, "event", { source, kind, detail, at: iso(this.now()) });
  }

  #publish(call, target, payload) {
    this.hub?.send?.(call.id, target, payload);
  }

  #require(callId) {
    const call = this.calls.get(callId);
    if (!call) throw new Error(`unknown call ${callId}`);
    return call;
  }

  #active(callId) {
    const call = this.get(callId);
    if (!call) return { error: { ok: false, error: "unknown_call" } };
    if (TERMINAL.has(call.state)) return { error: { ok: false, error: "call_finished", next: "The call is finished. Say nothing more." } };
    return { call };
  }

  #verifiedCall(callId) {
    const { call, error } = this.#active(callId);
    if (error) return { error };
    if (call.state === STATES.ESCALATING) return { error: { ok: false, error: "escalating", next: "A handoff is under way. Say nothing more." } };
    if (!call.patient) {
      return { error: { ok: false, error: "not_verified", next: "Nothing about appointments can be shared or changed yet. Ask for the patient's full name and date of birth, then call verify_patient." } };
    }
    return { call };
  }

  /** The console's view of one call: the state, the four checks a write needs, and nothing private. */
  snapshot(callId) {
    const call = this.get(callId);
    if (!call) return null;
    const proposal = call.proposal;
    return {
      id: call.id,
      state: call.state,
      simulated: call.simulated,
      arrival: call.arrival,
      maskedPhone: call.maskedPhone,
      callerIdMatch: Boolean(call.callerIdMatch),
      patient: call.patient ? { firstName: call.patient.firstName, lastInitial: call.patient.lastName?.[0] ?? null, verifiedBy: call.verifiedBy, proxy: call.proxy?.relationship ?? null } : null,
      attempts: call.attempts,
      visitType: call.visitTypeCode ? { code: call.visitTypeCode, name: visitName(call.visitTypeCode) } : null,
      eligibility: call.eligibility,
      blocked: call.blocked ? { ruleId: call.blocked.ruleId, visitTypeCode: call.blocked.visitTypeCode } : null,
      preferences: describePrefs(call.preferences).replace(/^ · /, ""),
      rescheduleOf: call.rescheduleOf ? publicEntry(call.rescheduleOf) : null,
      options: call.options.map(publicOption),
      proposal: proposal ? {
        id: proposal.id, kind: proposal.kind, status: proposal.status, label: proposal.label, slotKey: proposal.slotKey ?? null,
        heldUntil: proposal.heldUntil ?? null, handedOff: proposal.handedOff, providerName: proposal.option?.providerName ?? null,
        holdLeftMs: proposal.status === "active" && proposal.expiresAt ? Math.max(0, Date.parse(proposal.expiresAt) - this.now()) : null,
        holdTtlMs: proposal.expiresAt ? this.options.holdTtlMs : null,
        providerId: proposal.option?.providerId ?? null, start: proposal.option?.start ?? null,
      } : null,
      consent: call.consent,
      raceLost: call.raceLost,
      races: call.races,
      refusals: call.refusals,
      booking: call.booking,
      destination: call.destination ? { id: call.destination.id, label: call.destination.label, reason: call.destination.reason, mode: call.destination.mode, afterHours: call.destination.afterHours } : null,
      callback: call.callback ? { queue: call.callback.queue, label: call.callback.label, number: maskPhone(call.callback.number), preferredTime: call.callback.preferredTime } : null,
      safety: call.safety ? { level: call.safety.level } : null,
      outcome: call.outcome,
      elapsedMs: (call.endedAt ?? this.now()) - call.startedAt,
      budgetMs: this.options.callTimeBudgetMs,
      transcript: call.transcript,
      handoff: call.handoff ?? (call.destination ? this.handoffContext(call) : null),
      checks: this.#checks(call),
    };
  }

  /** Identity, eligibility, an active proposal and the caller's own yes: all four, or nothing is written. */
  #checks(call) {
    const p = call.patient;
    const identity = p
      ? { status: "pass", detail: `${p.firstName} ${p.lastName?.[0] ?? ""}. · ${call.verifiedBy === "handoff" ? "one-time reminder token" : call.proxy ? `${call.proxy.relationship} on file as authorized` : "name + date of birth"}` }
      : call.identityFailure && call.attempts >= 2 ? { status: "fail", detail: "not confirmed after two attempts · nothing disclosed" }
        : call.identityFailure ? { status: "warn", detail: `no match · attempt ${call.attempts} of 2` }
          : { status: "pending", detail: "full name + date of birth" };
    const eligibility = call.blocked
      ? { status: "fail", detail: `${visitName(call.blocked.visitTypeCode)} · ${call.blocked.ruleId}` }
      : call.eligibility?.ok ? { status: "pass", detail: `${visitName(call.eligibility.visitTypeCode)} · ${call.eligibility.basis}` }
        : { status: "pending", detail: p ? "visit type needed" : "needs identity first" };
    const active = call.proposal?.status === "active" ? call.proposal : null;
    const proposal = call.booking
      ? { status: "pass", detail: `${call.booking.proposalId} · written as ${call.booking.appointmentId}` }
      : active ? { status: "pass", detail: active.kind === "cancel" ? `${active.id} · cancel ${active.label}` : `${active.id} · ${active.label} · held until ${active.heldUntil}` }
        : call.raceLost ? { status: "fail", detail: call.raceLost.proposalId ? `${call.raceLost.proposalId} void · ${call.raceLost.label} was taken · fresh pick needed` : `${call.raceLost.label} was taken before it could be held · fresh pick needed` }
          : { status: "pending", detail: call.options.length ? "options offered · nothing held" : "no proposal · nothing can be written" };
    const consent = call.booking
      ? { status: "pass", detail: `${call.booking.consent ?? "said yes"} to ${call.booking.proposalId}` }
      : call.consent?.refused ? { status: "fail", detail: `${call.consent.detail} to ${call.consent.proposalId} · write refused (${call.consent.refused})` }
        : active ? { status: "pending", detail: `waiting for the caller's own yes to ${active.id}` }
          : { status: "pending", detail: "only the caller's yes to an active proposal" };
    return [
      { id: "identity", label: "Identity", ...identity },
      { id: "eligibility", label: "Eligibility", ...eligibility },
      { id: "proposal", label: "Active proposal", ...proposal },
      { id: "consent", label: "Caller consent", ...consent },
    ];
  }
}

function publicEntry(entry) {
  if (!entry) return null;
  const { appointmentId, ...rest } = entry;
  return rest;
}

function publicOption(o) {
  return {
    optionId: o.optionId, index: o.index ?? null, spoken: o.spoken, label: o.label, providerId: o.providerId ?? null, providerName: o.providerName,
    locationName: o.locationName, visitName: o.visitName, durationMinutes: o.durationMinutes, start: o.start, released: Boolean(o.released),
  };
}

const optionList = (options) => options.map((o) => `${o.index}=${o.optionId} (${o.label}, ${o.providerName})`).join("; ");

function callerDigits(call) {
  const digits = String(call.fromPhone ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits : null;
}
