/**
 * Appointment reminder call flow: the policy engine behind every reminder call.
 *
 * - The server owns policy; the realtime model is only the voice. Who may hear
 *   appointment details, whether a call may be placed right now, what counts as
 *   an explicit "yes", and every handoff are decided here in plain code. The
 *   model is told what to say through registerAgent(...).instruct(text).
 * - The clock is injected (`now`), so the console's demo clock, the tests and a
 *   live deployment all run the same rules.
 * - Standard library only (plus the template's config and handoff helpers), so
 *   the tests and the offline runner need no native modules or Azure SDKs.
 */
import { randomUUID } from "node:crypto";
import { config, demoNowDate, fixtures } from "./config.mjs";
import { buildCustomCallingContext, clipTopic, reminderToSchedulingContext } from "./handoff.mjs";

export const STATES = Object.freeze({
  CHECKING: "checking",
  DIALING: "dialing",
  CONNECTED: "connected",
  DETECTING: "detecting",
  GREETING: "greeting",
  RIGHT_PARTY: "right_party",
  VERIFYING: "verifying",
  PRESENTING: "presenting",
  CONFIRMING: "confirming",
  CONFIRMED: "confirmed",
  CANCEL_REASON: "cancel_reason",
  CANCEL_CONFIRM: "cancel_confirm",
  CANCELLED: "cancelled",
  RESCHEDULE: "reschedule",
  TRANSFERRING: "transferring",
  OPT_OUT: "opt_out",
  CLINICAL: "clinical",
  DTMF_MENU: "dtmf_menu",
  WRAP_UP: "wrap_up",
  CLOSING: "closing",
  ENDED: "ended",
  VOICEMAIL: "voicemail",
  RETRY_SCHEDULED: "retry_scheduled",
  NOT_PLACED: "not_placed",
  SKIPPED: "skipped",
});

const TERMINAL = new Set([
  STATES.ENDED,
  STATES.CONFIRMED,
  STATES.CANCELLED,
  STATES.TRANSFERRING,
  STATES.OPT_OUT,
  STATES.RETRY_SCHEDULED,
  STATES.NOT_PLACED,
  STATES.SKIPPED,
]);

export function isTerminal(state) {
  return TERMINAL.has(state);
}

/** Plain-English outcome lines for the audit trail and the console. */
const OUTCOME_TEXT = {
  confirmed: "Appointment confirmed by the patient",
  cancelled: "Appointment cancelled; the slot is free again",
  reschedule_handoff: "Handed to the scheduling desk with context; nothing booked by the agent",
  reschedule_callback: "Reschedule request logged for a callback; nothing booked by the agent",
  nurse_transfer: "Connected to the nurse line; no medical advice given",
  transfer_failed: "The transfer didn't connect: the patient heard what happens next, and the call ended",
  wrong_party: "Someone else answered: callback request only",
  unauthorized_proxy: "Not an authorized proxy: callback request only",
  unverified: "Identity not verified: no details shared",
  voicemail_left: "Voicemail on the last attempt: callback request only, no details",
  voicemail_hangup: "Voicemail on an early attempt: no message left",
  opted_out: "Opted out: no more reminder calls",
  busy: "Line busy",
  no_answer: "No answer",
  bad_number: "Number not in service",
  no_response: "No response: call ended",
  call_cap: "Call time cap reached",
  not_placed: "Call not placed",
  caller_hung_up: "Caller hung up",
  agent_ended: "Call ended",
};

// ---------------------------------------------------------------------------
// Text matching: whole words only, English and Spanish.
// ---------------------------------------------------------------------------

export function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, whitespace-tolerant matcher for a phrase list (longest phrase first). */
export function phraseMatcher(list) {
  const phrases = [...new Set((list ?? []).map((p) => normalizeText(p)).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!phrases.length) return () => false;
  const body = phrases.map((p) => escapeRegex(p).replace(/ /g, "\\s+")).join("|");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "u");
  return (text) => re.test(normalizeText(text));
}

const LISTS = {
  identityYes: [
    "yes", "yeah", "yep", "yup", "speaking", "it's me", "that's me", "this is me", "correct", "that's right", "right", "sure",
    "sí", "si", "soy yo", "hablando", "ella habla", "él habla", "el habla",
  ],
  identityNo: [
    "no", "nope", "not", "wrong number", "wrong person", "not here", "isn't here", "is not here", "not home", "isn't home",
    "at work", "not available", "isn't available", "not in", "away", "asleep", "take a message",
    "brother", "sister", "mother", "father", "mom", "dad", "wife", "husband", "son", "daughter", "friend", "roommate",
    "neighbor", "partner", "caregiver",
    "no está", "no es", "equivocado", "equivocada", "hermano", "hermana", "esposa", "esposo", "hijo", "hija", "madre", "padre",
    "mamá", "papá", "amigo", "amiga", "vecino", "vecina",
  ],
  yes: [
    "yes", "yeah", "yep", "yup", "correct", "right", "sure", "please", "ok", "okay", "confirm", "confirmed",
    "i'll be there", "i will be there", "we'll be there", "sounds good", "absolutely", "of course",
    "sí", "si", "claro", "correcto", "de acuerdo", "ahí estaré", "allí estaré", "por favor", "confirmo", "está bien", "vale",
  ],
  notYes: [
    "no", "nope", "not", "maybe", "don't", "do not", "can't", "cannot", "won't", "never", "i guess", "probably",
    "quizás", "quizá", "tal vez", "a lo mejor", "no sé",
  ],
  keep: ["keep it", "keep the appointment", "don't cancel", "do not cancel", "never mind", "nevermind", "no la cancele", "déjela", "dejela", "mejor no"],
  decline: ["no", "nope", "no thanks", "no thank you", "no gracias"],
  cancel: [
    "cancel", "cancelled", "canceled", "canceling", "cancelling", "cancellation", "can't make it", "cannot make it", "can't come",
    "cannot come", "can't go", "won't make it", "won't be able", "not able to make it",
    "cancelar", "cancele", "cancela", "cancelarla", "no puedo ir", "no voy a poder", "no podré ir", "no podre ir",
  ],
  reschedule: [
    "reschedule", "re-schedule", "rescheduling", "change", "different time", "different day", "another time", "another day",
    "new time", "next week", "later date", "move it", "move my appointment",
    "cambiar", "cambiarla", "reprogramar", "otro día", "otra hora", "otra fecha", "la próxima semana", "la semana que viene",
  ],
  optOut: [
    "stop calling", "opt out", "opt-out", "no more calls", "do not call", "don't call", "unsubscribe", "remove me", "take me off",
    "no me llame", "no me llamen", "dejen de llamar", "deje de llamar", "no más llamadas", "no mas llamadas",
  ],
  repeat: ["repeat", "say that again", "say again", "one more time", "come again", "repita", "repítalo", "repetir", "puede repetir"],
};

const match = Object.fromEntries(Object.entries(LISTS).map(([key, list]) => [key, phraseMatcher(list)]));
const emergencyMatch = phraseMatcher(fixtures.detection.emergencyPhrases);
const clinicalMatch = phraseMatcher(fixtures.detection.clinicalQuestionPhrases);

/** An explicit yes: a yes word and no hedge or negation anywhere in the turn. */
export function isAffirmative(text) {
  return match.yes(text) && !match.notYes(text);
}

/** "No" / "keep it" without an explicit yes. */
export function isDecline(text) {
  return (match.decline(text) || match.keep(text)) && !isAffirmative(text);
}

export function wantsCancel(text) {
  return match.cancel(text) && !match.keep(text);
}

export function wantsReschedule(text) {
  return match.reschedule(text);
}

export function cancelReasonCode(text) {
  const s = normalizeText(text);
  if (/\b(sick|ill|unwell|flu|enferm[oa])\b/.test(s)) return "feeling_sick";
  if (/\b(transport\w*|ride|bus|car|transporte)\b/.test(s)) return "transportation";
  if (/\b(schedule|work|conflict|trabajo|horario)\b/.test(s)) return "schedule_conflict";
  return "patient_requested";
}

/** "es-MX" -> "es" when a script set exists for it; otherwise null. */
export function normalizeLanguage(value) {
  const code = String(value ?? "").toLowerCase().split(/[-_]/)[0];
  return code && Object.hasOwn(fixtures.scripts, code) ? code : null;
}

export function callLocale(call) {
  return call?.language === "es" ? "es-US" : "en-US";
}

// ---------------------------------------------------------------------------
// Time: calling hours are judged on the patient's wall clock, never the server's.
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");
const clean = (text) => String(text).replace(/[\u202f\u00a0]/g, " ");
const formatters = new Map();

function formatter(locale, timeZone, options) {
  const key = `${locale}|${timeZone}|${JSON.stringify(options)}`;
  if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat(locale, { timeZone, ...options }));
  return formatters.get(key);
}

/** Wall-clock parts of an instant in a time zone. */
export function localParts(date, timeZone) {
  const parts = {};
  const options = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };
  for (const part of formatter("en-US", timeZone, options).formatToParts(new Date(date))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return { ...parts, ymd: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`, minutes: parts.hour * 60 + parts.minute };
}

function tzOffsetMs(instantMs, timeZone) {
  const p = localParts(new Date(instantMs), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instantMs / 1000) * 1000;
}

/** The instant at which the wall clock in `timeZone` reads `hhmm` on the given local day. */
function zonedInstant({ year, month, day }, hhmm, timeZone) {
  const [h, m] = String(hhmm).split(":").map(Number);
  const guess = Date.UTC(year, month - 1, day, h, m);
  const first = guess - tzOffsetMs(guess, timeZone);
  return new Date(guess - tzOffsetMs(first, timeZone));
}

const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
};

/**
 * Earliest instant at or after `from` inside the calling window on the patient's
 * wall clock, skipping clinic holidays. Null when that is at or after `notAfter`
 * (the reminder cutoff) or more than `maxDays` away.
 */
export function nextAllowedCallTime(from, { timeZone, window = fixtures.campaign.callingWindow, holidays = [], notAfter = null, maxDays = 14 } = {}) {
  const start = new Date(from);
  const today = localParts(start, timeZone);
  for (let i = 0; i <= maxDays; i += 1) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    const day = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    if (holidays.includes(`${day.year}-${pad(day.month)}-${pad(day.day)}`)) continue;
    const open = zonedInstant(day, window.start, timeZone);
    const close = zonedInstant(day, window.end, timeZone);
    const candidate = start < open ? open : start < close ? start : null;
    if (!candidate) continue;
    if (notAfter && candidate >= new Date(notAfter)) return null;
    return candidate;
  }
  return null;
}

/** The clinic's time zone for the appointment itself; calling hours use the patient's. */
export function timeZoneOf(appointment) {
  return fixtures.clinics.locations[appointment?.location]?.timeZone ?? appointment?.patient?.timeZone ?? "America/Los_Angeles";
}

function patientTimeZone(appointment) {
  return appointment?.patient?.timeZone ?? timeZoneOf(appointment);
}

/** "Wed, May 20, 8:00 AM PDT" */
export function formatShort(value, timeZone) {
  const options = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" };
  return clean(formatter("en-US", timeZone, options).format(new Date(value)));
}

/** "Thursday, May 21 at 9:30 AM" / "jueves, 21 de mayo a las 9:30 a. m." */
export function spokenDateTime(value, timeZone, language = "en") {
  const date = new Date(value);
  const locale = language === "es" ? "es-US" : "en-US";
  const day = formatter(locale, timeZone, { weekday: "long", month: "long", day: "numeric" }).format(date);
  const time = formatter(locale, timeZone, { hour: "numeric", minute: "2-digit" }).format(date);
  return clean(language === "es" ? `${day} a las ${time}` : `${day} at ${time}`);
}

const clockTime = (date, timeZone) => clean(formatter("en-US", timeZone, { hour: "numeric", minute: "2-digit" }).format(new Date(date)));

// ---------------------------------------------------------------------------
// Speech helpers: dates of birth, voicemail, and what may be said aloud.
// ---------------------------------------------------------------------------

const MONTHS = {
  january: 1, jan: 1, enero: 1, ene: 1,
  february: 2, feb: 2, febrero: 2,
  march: 3, mar: 3, marzo: 3,
  april: 4, apr: 4, abril: 4, abr: 4,
  may: 5, mayo: 5,
  june: 6, jun: 6, junio: 6,
  july: 7, jul: 7, julio: 7,
  august: 8, aug: 8, agosto: 8, ago: 8,
  september: 9, sep: 9, sept: 9, septiembre: 9, setiembre: 9,
  october: 10, oct: 10, octubre: 10,
  november: 11, nov: 11, noviembre: 11,
  december: 12, dec: 12, diciembre: 12, dic: 12,
};

function isoDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!(y >= 1900 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return "";
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return "";
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Date of birth from speech or keypad: "03/12/1984", "1984-03-12", "03121984",
 * "March 12th, 1984", "12 de marzo de 1984". Returns YYYY-MM-DD or "".
 */
export function normalizeDob(value) {
  const text = normalizeText(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (!text) return "";
  let m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(text);
  if (m) return isoDate(m[1], m[2], m[3]);
  m = /\b(\d{1,2})[/.\- ](\d{1,2})[/.\- ](\d{4})\b/.exec(text);
  if (m) return isoDate(m[3], m[1], m[2]);
  if (/^[\d\s#*]+$/.test(text)) {
    const digits = text.replace(/\D/g, "");
    if (digits.length === 8) {
      return /^(19|20)/.test(digits)
        ? isoDate(digits.slice(0, 4), digits.slice(4, 6), digits.slice(6))
        : isoDate(digits.slice(4), digits.slice(0, 2), digits.slice(2, 4));
    }
  }
  const tokens = text.match(/[a-z]+|\d+/g) ?? [];
  const year = tokens.find((t) => /^\d{4}$/.test(t) && Number(t) >= 1900 && Number(t) <= 2099);
  const isDay = (t) => /^\d{1,2}$/.test(t ?? "") && Number(t) >= 1 && Number(t) <= 31;
  let month = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const candidate = MONTHS[tokens[i]];
    if (!candidate) continue;
    const nearDay = isDay(tokens[i - 1]) || isDay(tokens[i + 1]) || (tokens[i - 1] === "de" && isDay(tokens[i - 2]));
    if (nearDay || month == null) month = candidate;
    if (nearDay) break;
  }
  const day = tokens.find(isDay);
  return year && month && day ? isoDate(year, month, day) : "";
}

const beepMatch = phraseMatcher(fixtures.detection.beepTokens);
const voicemailMatchers = Object.values(fixtures.detection.voicemailPhrases ?? {}).flat().map((phrase) => [phrase, phraseMatcher([phrase])]);

/** Answering-machine heuristics on the first greeting. ACS has no built-in machine detection; on a live call the greeting is the first transcribed turn. */
export function detectVoicemail({ text = "", durationMs = 0, beep = false, thresholdMs = config.voicemailGreetingMs } = {}) {
  if (beep) return { voicemail: true, reason: "beep" };
  const hit = voicemailMatchers.find(([, test]) => test(text));
  if (hit) return { voicemail: true, reason: `phrase:${hit[0]}` };
  if (beepMatch(text)) return { voicemail: true, reason: "beep" };
  if (Number(durationMs) >= thresholdMs) return { voicemail: true, reason: "long_greeting" };
  return { voicemail: false, reason: "human_or_unknown" };
}

export function prepText(code, language = "en") {
  const entry = fixtures.prep[code];
  return entry?.[language] ?? entry?.en ?? (language === "es" ? "Siga las indicaciones de su clínica." : "Please follow the instructions from your clinic.");
}

const DEPARTMENT_ES = { Imaging: "imagenología", "Primary Care": "atención primaria", Dermatology: "dermatología" };

function departmentName(department, language = "en") {
  if (language === "es") return DEPARTMENT_ES[department] ?? String(department ?? "").toLowerCase();
  return String(department ?? "").toLowerCase();
}

/** Spoken only after identity is verified. */
export function appointmentSummary(appointment, language = "en") {
  const clinic = fixtures.clinics.locations[appointment.location];
  const place = clinic?.displayName ?? appointment.location ?? "";
  const when = spokenDateTime(appointment.start, timeZoneOf(appointment), language);
  const department = departmentName(appointment.department, language);
  if (language === "es") {
    const provider = appointment.provider?.name ?? "su proveedor";
    return `Tiene una cita de ${department} con ${provider} el ${when}, en la clínica ${place.replace(/\s*clinic$/i, "")}.`;
  }
  const provider = appointment.provider?.name ?? "your provider";
  const article = /^[aeiou]/.test(department) ? "an" : "a";
  return `You have ${article} ${department} appointment with ${provider} on ${when}, at the ${place}.`;
}

export function maskName(patient) {
  if (!patient) return "the patient";
  return `${patient.firstName ?? "Patient"}${patient.lastName ? ` ${patient.lastName[0]}.` : ""}`;
}

const firstWord = (name) => String(name ?? "").trim().split(/\s+/)[0] ?? "";
const sameFirstName = (a, b) => Boolean(firstWord(a)) && normalizeText(firstWord(a)) === normalizeText(firstWord(b));
/** True when the caller's words include this person's first name as a whole word. */
const nameIn = (said, name) => Boolean(firstWord(name)) && phraseMatcher([firstWord(name)])(said);
const CHANNEL_TEXT = { sms: "text-message", email: "email", portal: "patient-portal" };

/** One plain sentence explaining a dial decision, plus the next allowed time when there is one. */
export function explainGate(gate, appointment, now = new Date()) {
  if (!gate) return "";
  const patient = appointment?.patient ?? {};
  const first = patient.firstName ?? "the patient";
  const timeZone = gate.timeZone ?? patientTimeZone(appointment);
  const campaign = fixtures.campaign;
  const window = campaign.callingWindow;
  const today = localParts(now, timeZone);
  const hours = `${clockTime(zonedInstant(today, window.start, timeZone), timeZone)}–${clockTime(zonedInstant(today, window.end, timeZone), timeZone)}`;
  const reasons = {
    ok: `Cleared to call: inside ${first}'s reminder window and calling hours (${hours} local time).`,
    no_consent: `${first} has not consented to automated voice calls.`,
    channel: `${first} prefers ${CHANNEL_TEXT[patient.preferredChannel] ?? patient.preferredChannel} reminders, so no call is placed.`,
    suppressed: `${first} opted out of reminder calls.`,
    tty: `${first} uses TTY or relay, so the clinic sends a text-based reminder instead of a voice call.`,
    bad_number: `The phone number on file for ${first} is not in service.`,
    not_allowlisted: "Live calls are limited to the allow-listed test numbers.",
    already_confirmed: `${first} already confirmed this appointment.`,
    appointment_closed: `This appointment is ${appointment?.status ?? "closed"}, so there is nothing to remind.`,
    reschedule_pending: `${first} asked for a new time; the scheduling desk owns this appointment now.`,
    in_progress: `A reminder call to ${first} is already in progress.`,
    holiday: "The clinic is closed for a holiday today, so no reminder calls go out.",
    calling_window: `Calling hours are ${hours} in ${first}'s time zone; it's ${clockTime(now, timeZone)} there now.`,
    cutoff: `The appointment is less than ${campaign.cutoffHoursBeforeAppointment} hours away, so automated reminders stop and the front desk follows up.`,
    not_due: `Reminder calls start ${campaign.leadTimeHours + campaign.leadWindowHours / 2} hours before the appointment.`,
    attempts: `All ${campaign.maxAttempts} reminder attempts have been used.`,
    spacing: `The last attempt was less than ${campaign.minSpacingHours} hours ago.`,
  };
  let text = reasons[gate.reason] ?? `Not placed: ${gate.reason}.`;
  if (!gate.ok && gate.nextAllowedAt) text += ` Next allowed: ${formatShort(gate.nextAllowedAt, timeZone)}.`;
  return text;
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

export class AppointmentReminderFlow {
  /**
   * @param {object} deps
   * @param {object} deps.schedule  ScheduleAdapter (schedule-store.mjs)
   * @param {object} deps.audit     MemoryAudit or SqliteAudit
   * @param {Function} [deps.transfer] async (call, handoff) => void; live transfers only
   * @param {object} [deps.hub]     realtime hub; send(callId, kind, payload)
   * @param {Function} [deps.now]   injected clock
   */
  constructor({ schedule, audit, transfer = null, hub = null, now = () => demoNowDate(), options = {} } = {}) {
    this.schedule = schedule;
    this.audit = audit;
    this.transfer = transfer;
    this.hub = hub;
    this.now = now;
    this.options = {
      callTimeBudgetMs: config.callTimeBudgetMs,
      schedulingAgentTarget: process.env.SCHEDULING_AGENT_TARGET || config.schedulingAgentTarget || fixtures.routing.schedulingAgent?.target || "",
      allowedTestNumbers: config.allowedTestNumbers,
      voicemailGreetingMs: config.voicemailGreetingMs,
      transferDelayMs: 3500,
      ...options,
    };
    this.calls = new Map();
    this.agents = new Map();
    this.timers = new Set();
  }

  /** Every step is synchronous today; the server awaits this so the HTTP contract survives an async step later. */
  async settled(callId) {
    return this.snapshot(callId);
  }

  get(callId) {
    return this.calls.get(callId) ?? null;
  }

  list() {
    return [...this.calls.keys()].map((id) => this.snapshot(id));
  }

  registerAgent(callId, agent) {
    this.agents.set(callId, agent);
  }

  unregisterAgent(callId) {
    this.agents.delete(callId);
  }

  /** Demo reset: forget every call and pending timer. Returns the forgotten call ids. */
  reset() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    const ids = [...this.calls.keys()];
    this.calls.clear();
    this.agents.clear();
    return ids;
  }

  /** The demo clock jumped by deltaMs: shift call timestamps so durations and the time budget stay sane. */
  rebaseClock(deltaMs) {
    if (!deltaMs) return;
    for (const call of this.calls.values()) {
      for (const key of ["startedAt", "answeredAt", "endedAt"]) if (call[key] != null) call[key] += deltaMs;
    }
  }

  // ---- Who may be called, and when -------------------------------------------------

  /**
   * Every gate a reminder call must pass, in order. Returns
   * { ok, reason, timeZone, attempt, nextAllowedAt, nextAttemptAt? }.
   */
  evaluateDialEligibility(appointment, { now = this.now(), dryRun = true } = {}) {
    const campaign = fixtures.campaign;
    const patient = appointment?.patient ?? {};
    const clinic = fixtures.clinics.locations[appointment?.location] ?? {};
    const timeZone = patientTimeZone(appointment);
    const phone = (patient.phones ?? [])[0] ?? {};
    const attempts = this.schedule.attemptsFor(appointment.appointmentId);
    const result = (reason, extra = {}) => ({ ok: reason === "ok", reason, timeZone, attempt: attempts.length + 1, nextAllowedAt: null, ...extra });

    if (!patient.consent?.voice) return result("no_consent");
    if ((patient.preferredChannel ?? "voice") !== "voice") return result("channel");
    if (this.schedule.isSuppressed(appointment.patientId)) return result("suppressed");
    if (patient.flags?.tty || /hearing/i.test(String(patient.flags?.note ?? ""))) return result("tty");
    if (!phone.number || phone.status === "bad") return result("bad_number");
    const allowlist = this.options.allowedTestNumbers ?? [];
    if (!dryRun && allowlist.length && !allowlist.includes(phone.number)) return result("not_allowlisted");
    if (appointment.status === "confirmed") return result("already_confirmed");
    if (appointment.status !== "booked") return result("appointment_closed");
    if (this.schedule.hasOpenRescheduleRequest?.(appointment.appointmentId)) return result("reschedule_pending");
    // A real call's attempt is recorded when it ends, so until then the call itself holds the appointment.
    if (this.#liveCallInProgress(appointment.appointmentId)) return result("in_progress");

    const start = new Date(appointment.start).getTime();
    const cutoffAt = new Date(start - campaign.cutoffHoursBeforeAppointment * 3_600_000);
    const dueFrom = new Date(start - (campaign.leadTimeHours + campaign.leadWindowHours / 2) * 3_600_000);
    const last = attempts.at(-1);
    const spacedUntil = last ? new Date(new Date(last.created_at).getTime() + campaign.minSpacingHours * 3_600_000) : null;
    const holidays = clinic.holidays ?? [];
    const nextAllowed = () => {
      const from = new Date(Math.max(now.getTime(), dueFrom.getTime(), spacedUntil?.getTime() ?? 0));
      return nextAllowedCallTime(from, { timeZone, window: campaign.callingWindow, holidays, notAfter: cutoffAt })?.toISOString() ?? null;
    };
    const local = localParts(now, timeZone);

    if (holidays.includes(local.ymd)) return result("holiday", { nextAllowedAt: nextAllowed() });
    if (local.minutes < minutesOf(campaign.callingWindow.start) || local.minutes >= minutesOf(campaign.callingWindow.end)) {
      return result("calling_window", { nextAllowedAt: nextAllowed() });
    }
    if (now >= cutoffAt) return result("cutoff");
    if (now < dueFrom) return result("not_due", { nextAllowedAt: nextAllowed() });
    if (attempts.length >= campaign.maxAttempts) return result("attempts");
    if (spacedUntil && now < spacedUntil) {
      const next = nextAllowed();
      return result("spacing", { nextAllowedAt: next, nextAttemptAt: next });
    }
    return result("ok");
  }

  /** A second campaign run must not dial a patient whose real call hasn't ended. Simulated calls never hold one. */
  #liveCallInProgress(appointmentId) {
    for (const call of this.calls.values()) {
      if (call.appointmentId === appointmentId && !call.simulated && !isTerminal(call.state)) return true;
    }
    return false;
  }

  /** Tonight's reminder run: every appointment in the lead window and whether it will be called. */
  buildDialPlan({ now = this.now(), dryRun = config.campaign.dryRun } = {}) {
    const { leadTimeHours, leadWindowHours } = fixtures.campaign;
    return this.schedule.listReminderCandidates({ now, leadTimeHours, leadWindowHours }).map((appointment) => {
      const gate = this.evaluateDialEligibility(appointment, { now, dryRun });
      return {
        appointmentId: appointment.appointmentId,
        patientName: maskName(appointment.patient),
        department: appointment.department,
        localTime: formatShort(appointment.start, timeZoneOf(appointment)),
        attempt: gate.attempt,
        state: gate.ok ? "scheduled" : "skipped",
        skipReason: gate.ok ? null : gate.reason,
        nextAttemptAt: gate.nextAttemptAt ?? null,
        nextAllowedAt: gate.nextAllowedAt,
        why: explainGate(gate, appointment, now),
      };
    });
  }

  /** One schedule-panel row: the appointment, its status, and whether it may be called right now. */
  describe(appointment, { now = this.now(), dryRun = true } = {}) {
    const gate = this.evaluateDialEligibility(appointment, { now, dryRun });
    const timeZone = timeZoneOf(appointment);
    return {
      appointmentId: appointment.appointmentId,
      patient: maskName(appointment.patient),
      firstName: appointment.patient?.firstName ?? null,
      language: appointment.patient?.preferredLanguage ?? "en",
      department: appointment.department,
      visitType: appointment.visitType,
      provider: appointment.provider?.name ?? null,
      location: fixtures.clinics.locations[appointment.location]?.displayName ?? appointment.location,
      timeZone,
      start: appointment.start,
      end: appointment.end,
      localTime: formatShort(appointment.start, timeZone),
      status: appointment.status,
      cancelReason: appointment.cancelReason ?? null,
      slotFree: appointment.status === "cancelled",
      rescheduleRequested: Boolean(this.schedule.hasOpenRescheduleRequest?.(appointment.appointmentId)),
      callable: gate.ok,
      reason: gate.reason,
      nextAllowedAt: gate.nextAllowedAt,
      why: explainGate(gate, appointment, now),
    };
  }

  board({ now = this.now(), appointmentIds = null } = {}) {
    const { leadTimeHours, leadWindowHours } = fixtures.campaign;
    const appointments = appointmentIds
      ? appointmentIds.map((id) => this.schedule.getAppointment(id)).filter(Boolean)
      : this.schedule.listReminderCandidates({ now, leadTimeHours, leadWindowHours });
    return appointments.map((appointment) => this.describe(appointment, { now }));
  }

  // ---- Call lifecycle -----------------------------------------------------------------

  create({ appointmentId, direction = "outbound", callId = null, attempt = null, sessionId = null, simulated = false, language = null, state = null } = {}) {
    const appointment = this.schedule.getAppointment(appointmentId);
    if (!appointment) throw new Error(`unknown appointment ${appointmentId}`);
    const id = callId ?? `${simulated ? "sim-" : ""}${randomUUID()}`;
    const startedAt = this.now().getTime();
    const call = {
      id,
      sessionId: sessionId ?? id,
      appointmentId,
      patientId: appointment.patientId,
      appointment,
      direction,
      simulated: Boolean(simulated),
      language: normalizeLanguage(language) ?? normalizeLanguage(appointment.patient?.preferredLanguage) ?? "en",
      state: state ?? (direction === "outbound" ? STATES.DIALING : STATES.GREETING),
      attempt: attempt ?? this.schedule.attemptsFor(appointmentId).length + 1,
      verified: false,
      proxyName: null,
      identityAsks: 0,
      dobAttempts: 0,
      dobTurns: 0,
      noInputs: 0,
      resumeState: null,
      reason: null,
      nextAllowedAt: null,
      callConnectionId: null,
      disclosed: false,
      wrapUpSent: false,
      startedAt,
      answeredAt: null,
      endedAt: null,
      outcome: null,
      transcript: [],
      lastPhrase: null,
      cancelProposal: null,
      handoff: null,
    };
    this.calls.set(id, call);
    this.audit.startCall({ id, appointmentId, patientId: call.patientId, state: call.state, direction, startedAt, simulated: call.simulated });
    const who = maskName(appointment.patient);
    const text = call.state === STATES.CHECKING
      ? `Checking whether ${who} may be called now`
      : direction === "outbound"
        ? `Reminder call to ${who} about ${appointmentId} (attempt ${call.attempt} of ${fixtures.campaign.maxAttempts})`
        : `Inbound call about ${appointmentId}`;
    this.#event(call, "system", "call_created", text);
    this.#publish(call, "state", this.snapshot(id));
    return call;
  }

  /** Record a call the policy would not place (calling hours, cutoff, consent...). Nothing is dialed. */
  refuse({ appointmentId, gate, simulated = false, language = null, sessionId = null }) {
    const call = this.create({ appointmentId, simulated, language, sessionId, state: STATES.CHECKING, attempt: gate.attempt });
    call.reason = gate.reason;
    call.nextAllowedAt = gate.nextAllowedAt ?? null;
    const why = explainGate(gate, call.appointment, this.now());
    call.why = why;
    this.#event(call, "policy", "not_placed", why, { reason: gate.reason, nextAllowedAt: call.nextAllowedAt });
    const finished = this.#finish(call, STATES.NOT_PLACED, "not_placed", { reason: gate.reason, detail: `Call not placed (${gate.reason.replace(/_/g, " ")})` });
    return { ...finished, callId: call.id, reason: gate.reason, nextAllowedAt: call.nextAllowedAt, why };
  }

  /**
   * The console's "Place the call": run every gate, then either record a refusal
   * or simulate the dial (answered by default; "voicemail", "busy", "no_answer").
   */
  placeSimulatedCall({ appointmentId, language = null, attempt = null, outcome = "answered", greeting = {}, sessionId = null } = {}) {
    const appointment = this.schedule.getAppointment(appointmentId);
    if (!appointment) return { ok: false, reason: "unknown_appointment" };
    const gate = this.evaluateDialEligibility(appointment, { dryRun: true });
    if (!gate.ok) {
      const result = this.refuse({ appointmentId, gate, simulated: true, language, sessionId });
      return { ok: true, refused: true, callId: result.callId, gate, result };
    }
    const max = fixtures.campaign.maxAttempts;
    const forced = attempt == null ? null : Math.min(max, Math.max(1, Math.round(Number(attempt)) || 1));
    const call = this.create({ appointmentId, simulated: true, language, sessionId, attempt: forced });
    this.#event(call, "policy", "cleared_to_call", explainGate(gate, appointment, this.now()), { reason: "ok" });
    this.answered(call.id);
    if (greeting?.greetingText) this.pushTranscript(call.id, "caller", greeting.greetingText);
    const result = this.applyDialOutcome(call.id, outcome, greeting);
    return { ok: true, refused: false, callId: call.id, gate, result };
  }

  answered(callId) {
    const call = this.#require(callId);
    if (isTerminal(call.state)) return { ok: false, reason: "call_ended", state: call.state };
    if (!call.answeredAt) call.answeredAt = this.now().getTime();
    if (call.direction === "outbound" && [STATES.DIALING, STATES.CONNECTED].includes(call.state)) this.#setState(call, STATES.DETECTING);
    return { ok: true, state: call.state };
  }

  /** What the dial produced: answered by a person, voicemail, busy, no answer, or a bad number. */
  applyDialOutcome(callId, outcome = "answered", { greetingText = "", greetingMs = 0, beep = false } = {}) {
    const call = this.#require(callId);
    if (isTerminal(call.state)) return { ok: false, reason: "call_ended", state: call.state };
    if (outcome === "busy" || outcome === "no_answer") return this.#retry(call, outcome);
    if (outcome === "bad_number") return this.#finish(call, STATES.ENDED, "bad_number", { detail: OUTCOME_TEXT.bad_number });
    let detected = detectVoicemail({ text: greetingText, durationMs: greetingMs, beep, thresholdMs: this.options.voicemailGreetingMs });
    if (outcome === "voicemail" && !detected.voicemail) detected = { voicemail: true, reason: "answering_machine" };
    if (detected.voicemail) return this.handleVoicemail(callId, detected);
    if (!call.answeredAt) call.answeredAt = this.now().getTime();
    this.#setState(call, STATES.GREETING);
    this.#event(call, "policy", "minimum_necessary", "A person answered: no appointment details until identity is verified");
    return this.#say(call, this.#script(call, "opening"), { state: call.state });
  }

  #retry(call, outcome) {
    const campaign = fixtures.campaign;
    const appointment = call.appointment;
    const timeZone = patientTimeZone(appointment);
    const cutoffAt = new Date(new Date(appointment.start).getTime() - campaign.cutoffHoursBeforeAppointment * 3_600_000);
    const holidays = fixtures.clinics.locations[appointment.location]?.holidays ?? [];
    const lastAttempt = call.attempt >= campaign.maxAttempts;
    const from = new Date(this.now().getTime() + campaign.minSpacingHours * 3_600_000);
    const next = lastAttempt ? null : nextAllowedCallTime(from, { timeZone, window: campaign.callingWindow, holidays, notAfter: cutoffAt });
    call.nextAllowedAt = next?.toISOString() ?? null;
    const label = OUTCOME_TEXT[outcome] ?? outcome;
    const detail = next ? `${label}: next try ${formatShort(next, timeZone)}` : `${label}: no attempts left before the cutoff`;
    return this.#finish(call, next ? STATES.RETRY_SCHEDULED : STATES.ENDED, outcome, { detail, nextAttemptAt: call.nextAllowedAt });
  }

  /** Voicemail: anyone could hear it, so at most a callback request on the last attempt. */
  handleVoicemail(callId, detected = { reason: "detected" }) {
    const call = this.#require(callId);
    if (isTerminal(call.state)) return { ok: false, reason: "call_ended", state: call.state };
    this.#setState(call, STATES.VOICEMAIL);
    const reason = String(detected.reason ?? "detected");
    const how = reason.startsWith("phrase:") ? `greeting said “${reason.slice(7)}”` : reason.replace(/_/g, " ");
    this.#event(call, "policy", "voicemail_detected", `Voicemail detected (${how})`);
    const last = call.attempt >= fixtures.campaign.maxAttempts && fixtures.campaign.voicemailOnLastAttempt !== false;
    if (!last) return this.#retry(call, "voicemail_hangup");
    this.#event(call, "policy", "minimum_necessary", "Anyone could hear a voicemail: callback request only, no appointment details");
    return this.#finish(call, STATES.ENDED, "voicemail_left", { spoken: this.#script(call, "voicemail") });
  }

  // ---- Identity first ------------------------------------------------------------------

  confirmIdentity(callId, { isPatient = null, proxyName = null, text = "" } = {}) {
    const { call, refusal } = this.#guard(callId);
    if (refusal) return refusal;
    const patient = call.appointment.patient ?? {};
    const said = normalizeText(text);
    const proxy = (patient.proxies ?? []).find((p) => (proxyName && sameFirstName(p.name, proxyName)) || (said && nameIn(said, p.name)));
    if (proxy) {
      if (!proxy.authorized) return this.#wrongParty(call, "unauthorized_proxy", `${firstWord(proxy.name)} is not an authorized proxy`);
      call.proxyName = proxy.name;
      this.#setState(call, STATES.VERIFYING);
      this.#event(call, "policy", "proxy_identified", `${firstWord(proxy.name)} is an authorized proxy (${proxy.relationship}); date of birth still required`);
      return this.#say(call, this.#script(call, "proxyAskDob"), { action: "proxy_ask_dob", proxyName: proxy.name });
    }
    const claimsPatient = isPatient === true || ((match.identityYes(said) || nameIn(said, patient.firstName)) && !match.identityNo(said));
    if (claimsPatient) {
      this.#setState(call, STATES.VERIFYING);
      this.#event(call, "policy", "identity_claimed", "Right party claimed: asking for date of birth before any details");
      return this.#say(call, this.#script(call, "askDob"), { action: "ask_dob" });
    }
    if (match.identityNo(said) || proxyName || (isPatient === false && !said)) {
      return this.#wrongParty(call, "wrong_party", "Someone other than the patient answered");
    }
    call.identityAsks += 1;
    if (call.identityAsks >= 2) return this.#wrongParty(call, "wrong_party", "Could not confirm who answered");
    return this.#say(call, this.#script(call, "identityRetry"), { status: "retry" });
  }

  #wrongParty(call, outcome, detail) {
    this.#event(call, "policy", "minimum_necessary", `${detail}: callback request only, no appointment details`);
    return this.#finish(call, STATES.ENDED, outcome, { spoken: this.#script(call, "wrongParty"), detail });
  }

  checkDob(callId, { spokenOrDigits = "", dob = null } = {}) {
    const { call, refusal } = this.#guard(callId);
    if (refusal) return refusal;
    if (call.state !== STATES.VERIFYING) return { ok: false, reason: "confirm_identity_first" };
    call.dobTurns += 1;
    const heard = normalizeDob(spokenOrDigits || dob || "");
    if (heard && heard === call.appointment.patient?.dob) {
      call.verified = true;
      this.audit.updateCall(call.id, { verified: true, proxyName: call.proxyName });
      const who = call.proxyName ? `${firstWord(call.proxyName)} verified as an authorized proxy` : "identity verified";
      this.#event(call, "policy", "identity_verified", `Date of birth matched: ${who}`);
      this.#setState(call, STATES.PRESENTING);
      return { ...this.presentAppointment(call.id), ok: true, status: "verified" };
    }
    if (!heard) {
      if (call.dobTurns >= 3) return this.#unverified(call);
      return this.#say(call, this.#script(call, "dobExplain"), { ok: false, status: "retry", reason: "no_date_heard" });
    }
    call.dobAttempts += 1;
    this.#event(call, "policy", "dob_mismatch", `Date of birth did not match (try ${call.dobAttempts} of 2)`);
    if (call.dobAttempts >= 2 || call.dobTurns >= 3) return this.#unverified(call);
    return this.#say(call, this.#script(call, "dobRetry"), { ok: false, status: "retry" });
  }

  #unverified(call) {
    this.#event(call, "policy", "minimum_necessary", "Identity not verified: no appointment details shared");
    return this.#finish(call, STATES.ENDED, "unverified", { spoken: this.#script(call, "unverified") });
  }

  /** Details are disclosed only here, and only after verification. */
  presentAppointment(callId) {
    const { call, refusal } = this.#guard(callId, { verified: true });
    if (refusal) return refusal;
    if (!call.disclosed) {
      call.disclosed = true;
      this.#event(call, "policy", "details_disclosed", "Verified: appointment details shared");
    }
    if (![STATES.PRESENTING, STATES.DTMF_MENU, STATES.WRAP_UP].includes(call.state)) this.#setState(call, STATES.PRESENTING);
    const say = `${appointmentSummary(call.appointment, call.language)} ${this.#script(call, "presentAsk")}`;
    return this.#say(call, say, { action: "present" });
  }

  // ---- Confirm, cancel, reschedule -----------------------------------------------------

  confirmAppointment(callId, { confirmation = "", idempotencyKey = null } = {}) {
    const { call, refusal } = this.#guard(callId, { verified: true });
    if (refusal) return refusal;
    if (!isAffirmative(confirmation)) return this.#say(call, this.#script(call, "needYesConfirm"), { ok: false, reason: "needs_explicit_yes" });
    this.schedule.confirmAppointment(call.appointmentId, idempotencyKey ?? `${call.appointmentId}:call:${call.id}:confirm`);
    call.appointment = this.schedule.getAppointment(call.appointmentId) ?? call.appointment;
    this.#event(call, "schedule", "appointment_confirmed", `${call.appointmentId} marked confirmed in the schedule`);
    this.#publish(call, "schedule", { appointmentId: call.appointmentId, status: call.appointment.status });
    const spoken = this.#script(call, "confirmed", { prep: prepText(call.appointment.prepCode, call.language) });
    return this.#finish(call, STATES.CONFIRMED, "confirmed", { spoken });
  }

  /** Read the cancellation back first; nothing changes until an explicit yes. */
  proposeCancel(callId, { reasonCode = "patient_requested" } = {}) {
    const { call, refusal } = this.#guard(callId, { verified: true });
    if (refusal) return refusal;
    const appointment = call.appointment;
    const clinic = fixtures.clinics.locations[appointment.location] ?? {};
    const hoursAway = (new Date(appointment.start).getTime() - this.now().getTime()) / 3_600_000;
    const late = hoursAway < fixtures.campaign.cutoffHoursBeforeAppointment;
    const notice = late ? `${clinic.lateCancellation?.[call.language] ?? clinic.lateCancellation?.en ?? ""} ` : "";
    const proposalId = randomUUID().slice(0, 8);
    call.cancelProposal = { proposalId, reasonCode, late };
    this.#setState(call, STATES.CANCEL_CONFIRM);
    const why = String(reasonCode).replace(/_/g, " ");
    this.#event(call, "policy", "cancel_read_back", `Cancellation read back before anything changes (reason: ${why})${late ? "; late-cancellation notice given" : ""}`);
    const say = this.#script(call, "cancelProposal", {
      notice,
      department: departmentName(appointment.department, call.language),
      when: spokenDateTime(appointment.start, timeZoneOf(appointment), call.language),
    });
    return this.#say(call, say, { proposalId, lateCancellation: late });
  }

  cancelAppointment(callId, { proposalId = null, confirmation = "" } = {}) {
    const { call, refusal } = this.#guard(callId, { verified: true });
    if (refusal) return refusal;
    const proposal = call.cancelProposal;
    if (!proposal || (proposalId && proposalId !== proposal.proposalId)) return { ok: false, reason: "missing_proposal" };
    if (!isAffirmative(confirmation)) return this.#say(call, this.#script(call, "needYesCancel"), { ok: false, reason: "needs_explicit_yes" });
    const result = this.schedule.cancelAppointment(call.appointmentId, proposal.reasonCode, `${call.appointmentId}:call:${call.id}:cancel:${proposal.proposalId}`);
    call.appointment = this.schedule.getAppointment(call.appointmentId) ?? call.appointment;
    const slot = result.releasedSlot ?? null;
    const when = formatShort(slot?.start ?? call.appointment.start, timeZoneOf(call.appointment));
    this.#event(call, "schedule", "slot_released", `${when} with ${call.appointment.provider?.name ?? "the provider"} is free again`, { releasedSlot: slot });
    this.#publish(call, "schedule", { appointmentId: call.appointmentId, status: call.appointment.status, releasedSlot: slot });
    return this.#finish(call, STATES.CANCELLED, "cancelled", { spoken: this.#script(call, "cancelled") });
  }

  keepAppointment(callId) {
    const { call, refusal } = this.#guard(callId, { verified: true });
    if (refusal) return refusal;
    call.cancelProposal = null;
    this.#event(call, "policy", "cancel_withdrawn", "Caller kept the appointment: nothing changed");
    this.#setState(call, STATES.PRESENTING);
    return this.#say(call, this.#script(call, "cancelKept"), { action: "kept" });
  }

  offerChoices(callId) {
    const { call, refusal } = this.#guard(callId, { verified: true });
    if (refusal) return refusal;
    return this.#say(call, this.#script(call, "cancelOrChange"), { ok: false, reason: "needs_explicit_choice" });
  }

  leaveClinical(callId) {
    const call = this.#require(callId);
    if (call.state === STATES.CLINICAL) this.#setState(call, call.resumeState ?? STATES.PRESENTING);
    call.resumeState = null;
    return { ok: true, state: call.state };
  }

  /** The agent never books: it hands the verified caller to scheduling staff with context. */
  requestReschedule(callId, { correlationId = null } = {}) {
    const { call, refusal } = this.#guard(callId, { verified: true });
    if (refusal) return refusal;
    const appointment = call.appointment;
    const request = this.schedule.requestReschedule(call.appointmentId, `${call.appointmentId}:call:${call.id}:reschedule`);
    const target = this.options.schedulingAgentTarget || "";
    if (!target && !call.simulated) {
      this.#event(call, "handoff", "reschedule_callback", "No scheduling desk configured: request logged for a callback; nothing booked");
      const finished = this.#finish(call, STATES.ENDED, "reschedule_callback", { spoken: this.#script(call, "rescheduleCallback") });
      return { ...finished, ok: true, request, transfer: null, callContext: null };
    }
    const issued = this.schedule.issueHandoffToken({ appointmentId: call.appointmentId, patientId: call.patientId, correlationId: correlationId ?? call.sessionId });
    const callContext = reminderToSchedulingContext({ appointmentId: call.appointmentId, patientRef: issued.token, verified: true, sessionId: call.sessionId });
    const routing = fixtures.routing.schedulingAgent ?? {};
    const timeZone = timeZoneOf(appointment);
    const callTopic = clipTopic(`Reschedule – ${appointment.department} ${call.appointmentId}`);
    const callerSaid = [...call.transcript].reverse().find((t) => t.role === "caller")?.text ?? "";
    const handoff = {
      destination: "schedulingAgent",
      queue: routing.queue ?? "Scheduling desk",
      displayName: routing.displayName ?? "Appointment scheduling agent",
      target: target || null,
      simulated: call.simulated,
      sessionId: call.sessionId,
      callTopic,
      callContext,
      voipHeaders: buildCustomCallingContext({ sessionId: call.sessionId, callTopic, callContext }),
      summary: `${maskName(appointment.patient)} (verified${call.proxyName ? ` via ${firstWord(call.proxyName)}, authorized proxy` : ""}) wants a new time for ${appointment.department} ${appointment.visitType} on ${formatShort(appointment.start, timeZone)}. The current slot stays booked until a new one is chosen.`,
      callerSaid: callerSaid.slice(0, 120),
      patientRefExpiresAt: issued.expiresAt,
      appointment: {
        appointmentId: call.appointmentId,
        department: appointment.department,
        visitType: appointment.visitType,
        provider: appointment.provider?.name ?? null,
        localTime: formatShort(appointment.start, timeZone),
      },
    };
    call.handoff = handoff;
    this.#event(call, "handoff", "reschedule_handoff", `Handing off to the ${handoff.queue.toLowerCase()} with context; the agent books nothing itself`, { callTopic });
    this.#publish(call, "handoff", handoff);
    const finished = this.#finish(call, STATES.TRANSFERRING, "reschedule_handoff", { spoken: this.#script(call, "rescheduleTransfer") });
    this.#startTransfer(call, handoff);
    return { ...finished, ok: true, request, transfer: handoff, callContext };
  }

  /** Live calls only: wait for the agent to finish its line, then ask ACS to transfer. Dispatched once per handoff. */
  #startTransfer(call, handoff) {
    if (!this.transfer || !handoff.target || call.simulated) return;
    const timer = setTimeout(async () => {
      this.timers.delete(timer);
      try {
        await this.transfer(call, handoff);
        this.#event(call, "handoff", "transfer_started", `Transfer to ${handoff.displayName} started`);
      } catch (error) {
        const message = String(error?.message ?? error);
        if (call.state === STATES.TRANSFERRING) this.#closeFailedTransfer(call, message, { accepted: false });
        else this.#event(call, "handoff", "transfer_failed", `Transfer failed: ${message}`, { accepted: false });
      }
    }, this.options.transferDelayMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  /**
   * ACS accepted the transfer, then reported CallTransferFailed: nobody at the
   * queue picked up, and the patient is still on the line with the agent. The
   * transfer is not sent again (a queue that keeps failing would loop the
   * patient); the agent says what happens next and the call ends. The call
   * leaves the transferring state, so a repeated failure finds nothing to do.
   */
  transferFailed(callId, message = "transfer failed") {
    const call = this.get(callId);
    if (!call || call.simulated || call.state !== STATES.TRANSFERRING) return { ok: false, reason: "nothing_to_recover" };
    return this.#closeFailedTransfer(call, String(message ?? "transfer failed"), { accepted: true });
  }

  /**
   * One honest line, then the end of the call. A reschedule request stays on
   * file (the scheduling desk calls back and the slot stays booked); a nurse
   * question gets the clinic's number and the 911 line, never advice. The
   * outcome becomes transfer_failed, so the metrics never count it as handed off.
   */
  #closeFailedTransfer(call, message, { accepted }) {
    const nurse = call.handoff?.destination === "nurseLine";
    const queue = call.handoff?.queue ?? (nurse ? "Nurse line" : "Scheduling desk");
    const handedOff = call.outcome;
    this.#event(call, "handoff", "transfer_failed", `${queue} didn't pick up: ${message}`, { accepted, destination: call.handoff?.destination ?? null });
    // One dial, one attempt: the handoff already logged this call's attempt, so correct it rather than add another.
    if (call.direction === "outbound") {
      this.schedule.amendAttempt?.({ appointmentId: call.appointmentId, attempt: call.attempt, fromOutcome: handedOff, state: STATES.ENDED, outcome: "transfer_failed", detail: message });
    }
    const finished = this.#finish(call, STATES.ENDED, "transfer_failed", {
      spoken: this.#script(call, nurse ? "nurseTransferFailed" : "rescheduleTransferFailed"),
      recordAttempt: false,
    });
    return { ...finished, ok: false, reason: "transfer_failed", recovered: true, error: message };
  }

  // ---- Safety: clinical questions, emergencies, opt-out --------------------------------

  /** No medical advice: offer the nurse line while it is open, else the after-hours advice number. */
  nurseLine(callId, { connect = false } = {}) {
    const { call, refusal } = this.#guard(callId);
    if (refusal) return refusal;
    const clinic = fixtures.clinics.locations[call.appointment.location] ?? {};
    const nurse = clinic.nurseLine ?? {};
    const target = nurse.target || fixtures.routing.nurseLine?.target || "";
    const local = localParts(this.now(), clinic.timeZone ?? timeZoneOf(call.appointment));
    const open = Boolean(target)
      && !(clinic.holidays ?? []).includes(local.ymd)
      && local.minutes >= minutesOf(nurse.hours?.start ?? "08:00")
      && local.minutes < minutesOf(nurse.hours?.end ?? "17:00");
    if (!open) {
      this.#event(call, "safety", "clinical_question", "Clinical question: no medical advice; nurse line closed, after-hours advice number given");
      const tail = call.verified ? ` ${this.#script(call, "presentAsk")}` : "";
      const number = clinic.afterHoursNurseAdviceNumber ?? "";
      return this.#say(call, `${this.#script(call, "nurseClosed", { number })}${tail}`, { action: "advice_number", number: number || null });
    }
    if (connect && call.state === STATES.CLINICAL) return this.#nurseTransfer(call, target);
    if (call.state !== STATES.CLINICAL) call.resumeState = call.state;
    this.#setState(call, STATES.CLINICAL);
    this.#event(call, "safety", "clinical_question", "Clinical question: no medical advice; offering the nurse line");
    return this.#say(call, this.#script(call, "clinical"), { action: "transfer", target });
  }

  #nurseTransfer(call, target) {
    const name = fixtures.routing.nurseLine?.displayName ?? "Nurse line";
    const handoff = {
      destination: "nurseLine",
      queue: name,
      displayName: name,
      target,
      simulated: call.simulated,
      sessionId: call.sessionId,
      callTopic: clipTopic(`Nurse question – ${call.appointment.department} ${call.appointmentId}`),
      callContext: null,
      summary: "Caller has a clinical question about their visit. No medical advice was given.",
      callerSaid: ([...call.transcript].reverse().find((t) => t.role === "caller")?.text ?? "").slice(0, 120),
    };
    call.handoff = handoff;
    this.#event(call, "handoff", "nurse_transfer", "Connecting to the nurse line; no medical advice given");
    this.#publish(call, "handoff", handoff);
    const finished = this.#finish(call, STATES.TRANSFERRING, "nurse_transfer", { spoken: this.#script(call, "nurseTransfer") });
    this.#startTransfer(call, handoff);
    return { ...finished, action: "transfer", target, transfer: handoff };
  }

  declineNurse(callId) {
    const call = this.#require(callId);
    if (call.state === STATES.CLINICAL) this.#setState(call, call.resumeState ?? STATES.PRESENTING);
    call.resumeState = null;
    const tail = call.verified ? ` ${this.#script(call, "presentAsk")}` : "";
    return this.#say(call, `${this.#script(call, "nurseDeclined")}${tail}`, { action: "nurse_declined" });
  }

  emergency(callId) {
    const call = this.#require(callId);
    this.#event(call, "safety", "emergency_phrase", "Possible emergency: caller told to hang up and call 911");
    return this.#say(call, this.#script(call, "emergency"), { emergency: true });
  }

  /** Saved before the call ends, so a dropped call still honors it. */
  optOut(callId) {
    const { call, refusal } = this.#guard(callId);
    if (refusal) return refusal;
    this.schedule.suppressPatient(call.patientId, "opt_out");
    this.#event(call, "policy", "opt_out_saved", "Opt-out saved: no more automated reminder calls");
    return this.#finish(call, STATES.OPT_OUT, "opted_out", { spoken: this.#script(call, "optOut") });
  }

  /** Checks that run on every caller turn, in any state. */
  screen(callId, text) {
    if (emergencyMatch(text)) return this.emergency(callId);
    if (match.optOut(text)) return this.optOut(callId);
    return null;
  }

  dtmf(callId, digit) {
    const { call, refusal } = this.#guard(callId);
    if (refusal) return refusal;
    const key = String(digit ?? "").trim();
    // While verifying, digits are the date of birth (MMDDYYYY): collect eight and never log them.
    if (call.state === STATES.VERIFYING && /^[0-9]$/.test(key)) {
      call.dobKeys = `${call.dobKeys ?? ""}${key}`;
      if (call.dobKeys.length < 8) return { ok: true, status: "collecting", keys: call.dobKeys.length };
      const keyed = call.dobKeys;
      call.dobKeys = "";
      this.#event(call, "caller", "dtmf", "Keypad: date of birth entered (8 digits)");
      return this.checkDob(callId, { spokenOrDigits: keyed });
    }
    this.#event(call, "caller", "dtmf", `Keypad: ${key}`);
    switch (key) {
      case "9":
        return this.optOut(callId);
      case "*":
        return this.repeatLast(callId);
      case "1":
        return this.confirmAppointment(callId, { confirmation: "yes by keypad" });
      case "2":
        if (!call.verified) return { ok: false, reason: "not_verified" };
        this.#setState(call, STATES.CANCEL_REASON);
        return this.#say(call, this.#script(call, "cancelReasonPrompt"), { action: "cancel_reason" });
      case "3":
        return this.requestReschedule(callId);
      default:
        return { ok: false, reason: "unknown_digit" };
    }
  }

  // ---- Turn plumbing ----------------------------------------------------------------

  noInput(callId) {
    const { call, refusal } = this.#guard(callId);
    if (refusal) return refusal;
    call.noInputs += 1;
    if (call.noInputs >= 3) return this.#finish(call, STATES.ENDED, "no_response", { spoken: this.#script(call, "noResponse") });
    if (call.verified && call.noInputs >= 2 && [STATES.PRESENTING, STATES.DTMF_MENU, STATES.WRAP_UP].includes(call.state)) {
      this.#setState(call, STATES.DTMF_MENU);
      return this.#say(call, this.#script(call, "dtmfMenu"), { offerDtmf: true });
    }
    return this.#say(call, this.#script(call, "didntCatch"), { retry: true });
  }

  /** Calls are capped (CALL_TIME_BUDGET_MS); the agent starts wrapping up 40 seconds before the cap. */
  checkBudget(callId) {
    const call = this.get(callId);
    if (!call?.answeredAt || isTerminal(call.state)) return { ok: true };
    const elapsed = this.now().getTime() - call.answeredAt;
    const budget = this.options.callTimeBudgetMs;
    if (elapsed >= budget) return this.#finish(call, STATES.ENDED, "call_cap", { spoken: this.#script(call, "timeUp") });
    if (elapsed >= budget - 40_000 && !call.wrapUpSent) {
      call.wrapUpSent = true;
      this.#event(call, "policy", "wrap_up", "Close to the call time cap: wrapping up");
      return this.#say(call, this.#script(call, "wrapUp"), { wrapUp: true });
    }
    return { ok: true };
  }

  endCall(callId, outcome = "agent_ended") {
    const call = this.get(callId);
    if (!call) return { ok: false, reason: "unknown_call" };
    if (isTerminal(call.state)) return { ok: true, outcome: call.outcome, state: call.state };
    // Nothing new is spoken when a call is ended from outside the conversation.
    return { ...this.#finish(call, STATES.ENDED, outcome, { detail: OUTCOME_TEXT[outcome] ?? outcome.replace(/_/g, " ") }), say: null };
  }

  repeatLast(callId) {
    const call = this.#require(callId);
    const text = call.lastPhrase;
    if (text) this.#say(call, text);
    return { ok: true, repeated: Boolean(text), say: text };
  }

  pushTranscript(callId, role, text) {
    const call = this.get(callId);
    const line = String(text ?? "").trim();
    if (!call || !line) return;
    const at = this.now().toISOString();
    call.transcript.push({ role, text: line, at });
    if (call.transcript.length > 200) call.transcript.shift();
    this.audit.recordTranscript?.(call.id, role, line, at);
    this.#publish(call, "transcript", { role, text: line, at });
  }

  recordAgentAction(callId, { tool, ok = true, detail = null } = {}) {
    const call = this.get(callId);
    if (call) this.#event(call, "agent", ok ? "tool" : "tool_rejected", detail ? `${tool}: ${detail}` : tool);
  }

  /** What the console and the audit see. Never includes the date of birth. */
  snapshot(callId) {
    const call = this.get(callId);
    if (!call) return null;
    const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
    const appointment = call.appointment;
    return {
      id: call.id,
      callId: call.id,
      sessionId: call.sessionId,
      state: call.state,
      terminal: isTerminal(call.state),
      appointmentId: call.appointmentId,
      patient: maskName(appointment.patient),
      firstName: appointment.patient?.firstName ?? null,
      language: call.language,
      simulated: call.simulated,
      direction: call.direction,
      attempt: call.attempt,
      verified: call.verified,
      disclosed: call.disclosed,
      proxyName: call.proxyName,
      outcome: call.outcome,
      outcomeText: call.outcome ? OUTCOME_TEXT[call.outcome] ?? call.outcome : null,
      reason: call.reason,
      why: call.why ?? null,
      nextAllowedAt: call.nextAllowedAt,
      lastPhrase: call.lastPhrase,
      handoff: call.handoff,
      transcript: call.transcript,
      startedAt: iso(call.startedAt),
      answeredAt: iso(call.answeredAt),
      endedAt: iso(call.endedAt),
      appointment: {
        appointmentId: call.appointmentId,
        department: appointment.department,
        visitType: appointment.visitType,
        status: appointment.status,
        localTime: formatShort(appointment.start, timeZoneOf(appointment)),
      },
    };
  }

  // ---- Private helpers ----------------------------------------------------------------

  /** Live calls: the voice agent speaks the line and its transcript comes back from Voice Live. */
  #say(call, text, extra = {}) {
    const line = String(text ?? "").replace(/\s+/g, " ").trim();
    call.lastPhrase = line;
    const agent = this.agents.get(call.id);
    if (agent?.instruct) agent.instruct(line);
    else this.pushTranscript(call.id, "agent", line);
    return { ok: true, say: line, ...extra };
  }

  #event(call, source, kind, detail = null, data = null) {
    const at = this.now().toISOString();
    this.audit.recordEvent?.(call.id, source, kind, detail, at);
    this.#publish(call, "event", { source, kind, detail, at, ...(data ? { data } : {}) });
  }

  #publish(call, target, payload) {
    try {
      this.hub?.send?.(call.id, target, payload);
    } catch {
      // The console fan-out must never break a call.
    }
  }

  #setState(call, state) {
    if (call.state === state) return;
    const from = call.state;
    call.state = state;
    this.audit.updateCall?.(call.id, { state });
    this.#event(call, "system", "state", `${from} → ${state}`, { from, to: state });
    this.#publish(call, "state", this.snapshot(call.id));
  }

  #finish(call, state, outcome, { spoken = null, detail = null, reason = null, nextAttemptAt = null, recordAttempt = true } = {}) {
    if (spoken) this.#say(call, spoken);
    call.outcome = outcome;
    if (reason) call.reason = reason;
    call.endedAt = this.now().getTime();
    if (recordAttempt && call.direction === "outbound" && state !== STATES.NOT_PLACED) {
      this.schedule.recordAttempt({ appointmentId: call.appointmentId, patientId: call.patientId, state, outcome, attempt: call.attempt, nextAttemptAt, detail });
    }
    this.audit.updateCall?.(call.id, {
      outcome,
      verified: call.verified,
      proxyName: call.proxyName,
      endedAt: new Date(call.endedAt).toISOString(),
      durationMs: call.endedAt - call.startedAt,
    });
    this.#setState(call, state);
    this.#event(call, "system", "outcome", detail ?? OUTCOME_TEXT[outcome] ?? outcome, { outcome });
    return { ok: true, outcome, state: call.state, say: spoken ?? call.lastPhrase };
  }

  #script(call, key, values = {}) {
    const set = fixtures.scripts[call.language] ?? fixtures.scripts.en;
    const template = set[key] ?? fixtures.scripts.en[key] ?? "";
    const appointment = call.appointment;
    const clinic = fixtures.clinics.locations[appointment.location] ?? {};
    const fill = {
      firstName: appointment.patient?.firstName ?? "",
      callbackNumber: clinic.callbackNumber ?? "",
      proxyFirstName: firstWord(call.proxyName),
      clinic: clinic.displayName ?? "",
      ...values,
    };
    return template.replace(/\{(\w+)\}/g, (_, name) => String(fill[name] ?? ""));
  }

  #require(callId) {
    const call = this.calls.get(callId);
    if (!call) throw new Error(`unknown call ${callId}`);
    return call;
  }

  #guard(callId, { verified = false } = {}) {
    const call = this.#require(callId);
    if (isTerminal(call.state)) return { call, refusal: { ok: false, reason: "call_ended", state: call.state } };
    if (verified && !call.verified) {
      this.#event(call, "policy", "blocked_until_verified", "Blocked: identity not verified yet");
      return { call, refusal: { ok: false, reason: "not_verified" } };
    }
    return { call, refusal: null };
  }
}

// ---------------------------------------------------------------------------
// One caller turn, in simulation or from the live transcript.
// ---------------------------------------------------------------------------

const nurseRequest = phraseMatcher(["nurse", "enfermera", "enfermero", "enfermería"]);

function presentingTurn(flow, callId, said) {
  if (wantsReschedule(said)) return flow.requestReschedule(callId);
  if (wantsCancel(said)) return flow.proposeCancel(callId, { reasonCode: cancelReasonCode(said) });
  if (clinicalMatch(said) || nurseRequest(said)) return flow.nurseLine(callId);
  if (isDecline(said)) return flow.offerChoices(callId);
  return flow.confirmAppointment(callId, { confirmation: said });
}

export function handleUtterance(flow, callId, text) {
  const call = flow.get(callId);
  if (!call) return { ok: false, reason: "unknown_call" };
  if (isTerminal(call.state)) return { ok: false, reason: "call_ended", state: call.state };
  const said = String(text ?? "").trim();
  if (!said) return flow.noInput(callId);
  flow.pushTranscript(callId, "caller", said);
  call.noInputs = 0;
  const budget = flow.checkBudget(callId);
  if (budget.outcome === "call_cap") return budget;
  if (/^[0-9*#]$/.test(said)) return flow.dtmf(callId, said);
  const screened = flow.screen(callId, said);
  if (screened) return screened;
  if (match.repeat(said)) return flow.repeatLast(callId);
  switch (call.state) {
    case STATES.DIALING:
    case STATES.CONNECTED:
    case STATES.DETECTING:
      flow.answered(callId);
      return flow.applyDialOutcome(callId, "answered", { greetingText: said });
    case STATES.GREETING:
      return flow.confirmIdentity(callId, { text: said });
    case STATES.VERIFYING:
      return flow.checkDob(callId, { spokenOrDigits: said });
    case STATES.PRESENTING:
    case STATES.DTMF_MENU:
    case STATES.WRAP_UP:
      return presentingTurn(flow, callId, said);
    case STATES.CLINICAL:
      if (wantsReschedule(said) || wantsCancel(said)) {
        flow.leaveClinical(callId);
        return presentingTurn(flow, callId, said);
      }
      return isAffirmative(said) ? flow.nurseLine(callId, { connect: true }) : flow.declineNurse(callId);
    case STATES.CANCEL_REASON:
      if (wantsReschedule(said)) return flow.requestReschedule(callId);
      if (isDecline(said)) return flow.keepAppointment(callId);
      return flow.proposeCancel(callId, { reasonCode: cancelReasonCode(said) });
    case STATES.CANCEL_CONFIRM:
      if (wantsReschedule(said)) return flow.requestReschedule(callId);
      if (isDecline(said)) return flow.keepAppointment(callId);
      return flow.cancelAppointment(callId, { proposalId: call.cancelProposal?.proposalId, confirmation: said });
    default:
      return flow.noInput(callId);
  }
}
