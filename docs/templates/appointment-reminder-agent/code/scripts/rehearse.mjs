#!/usr/bin/env node
/**
 * Rehearse the on-stage demo before you give it.
 *
 *   npm run rehearse
 *
 * Plays every beat in public/beats.js against this server in simulation mode,
 * the way the presenter console's director plays them, and fails unless each
 * one lands where DEMO-SCRIPT.md says it does: in order, after a reset, last
 * beat first, at Auto-play's pace and at full speed. It also checks that
 * DEMO-SCRIPT.md matches the beat strip, that the console loads, and that a
 * server placing real calls refuses the demo controls. No Azure resource and
 * no network; neither your .env nor your shell's settings reach the server.
 *
 * The engine is scripts/presenter-kit-rehearsal.mjs (vendored; edit it at the
 * repository root). This file mirrors what is this template's own: the
 * console's start body and demo hooks in public/app.js, and what each beat
 * should leave on screen.
 *
 * Changed a beat, the seed or the reminder policy on purpose? The run prints
 * the outcomes it reached. Check each against DEMO-SCRIPT.md, then paste them
 * over EXPECTED below.
 */
import { rehearse, trail } from "./presenter-kit-rehearsal.mjs";

// The shipped settings, with the schedule and the audit log in memory instead
// of ./data/schedule.db and ./data/reminder-audit.db.
const SIMULATION = { SCHEDULE_DB_PATH: ":memory:", AUDIT_DB_PATH: ":memory:" };

// Enough for /health to report a server placing real calls. Nothing is called:
// the ACS client is created on the first real call, Voice Live is only reached
// from a call, and .invalid never resolves.
const LIVE = {
  ACS_ENDPOINT: "https://rehearsal.invalid",
  ACS_CALLER_ID: "+15550100",
  PUBLIC_BASE_URL: "https://rehearsal.invalid",
  VOICE_LIVE_ENDPOINT: "https://rehearsal.invalid",
  VOICE_LIVE_API_KEY: "rehearsal",
};

/**
 * What each beat leaves on screen, call by call: no call ids, no timestamps.
 * The times in it are the seed's and the demo clock's, which every beat sets,
 * so they read the same on any day.
 */
const EXPECTED = {
  "Confirmed in one call": [
    {
      state: "confirmed",
      patient: "Jordan R.",
      appointment: "A-20418",
      attempt: 1,
      language: "en",
      verified: true,
      disclosed: true,
      outcome: "confirmed",
      reason: null,
      said: [
        "Hi, this is Contoso Health's automated assistant, calling with an appointment reminder. Am I speaking with Jordan?",
        "Thanks, Jordan. To protect your privacy, please tell me your date of birth.",
        "You have an imaging appointment with Dr. Lee on Thursday, May 21 at 9:30 AM, at the Northgate clinic. Will you be able to make it?",
        "You're confirmed. Please do not eat or drink anything except water for 8 hours before your appointment, and arrive 15 minutes early. We'll see you then. Goodbye.",
      ],
      schedule: "confirmed",
      freed: [],
      handoff: null,
      trail: [
        "call_created Reminder call to Jordan R. about A-20418 (attempt 1 of 3)",
        "cleared_to_call Cleared to call: inside Jordan's reminder window and calling hours (8:00 AM–8:00 PM local time).",
        "minimum_necessary A person answered: no appointment details until identity is verified",
        "identity_claimed Right party claimed: asking for date of birth before any details",
        "identity_verified Date of birth matched: identity verified",
        "details_disclosed Verified: appointment details shared",
        "appointment_confirmed A-20418 marked confirmed in the schedule",
        "outcome Appointment confirmed by the patient",
      ],
    },
  ],
  "Cancel frees the slot": [
    {
      state: "cancelled",
      patient: "Avery S.",
      appointment: "A-20419",
      attempt: 1,
      language: "en",
      verified: true,
      disclosed: true,
      outcome: "cancelled",
      reason: null,
      said: [
        "Hi, this is Contoso Health's automated assistant, calling with an appointment reminder. Am I speaking with Avery?",
        "Thanks, Avery. To protect your privacy, please tell me your date of birth.",
        "You have a primary care appointment with Dr. Patel on Thursday, May 21 at 10:15 AM, at the Northgate clinic. Will you be able to make it?",
        "I can cancel your primary care appointment on Thursday, May 21 at 10:15 AM. Should I cancel it?",
        "Your appointment is cancelled, and the time is now open for another patient. To book a new visit, call us at 206-555-0100. Goodbye.",
      ],
      schedule: "cancelled",
      freed: ["Open slot · Dr. Patel · Primary Care · Thu, May 21, 10:15 AM PDT"],
      handoff: null,
      trail: [
        "call_created Reminder call to Avery S. about A-20419 (attempt 1 of 3)",
        "cleared_to_call Cleared to call: inside Avery's reminder window and calling hours (8:00 AM–8:00 PM local time).",
        "minimum_necessary A person answered: no appointment details until identity is verified",
        "identity_claimed Right party claimed: asking for date of birth before any details",
        "identity_verified Date of birth matched: identity verified",
        "details_disclosed Verified: appointment details shared",
        "cancel_read_back Cancellation read back before anything changes (reason: patient requested)",
        "slot_released Thu, May 21, 10:15 AM PDT with Dr. Patel is free again",
        "outcome Appointment cancelled; the slot is free again",
      ],
    },
  ],
  "New time → a person": [
    {
      state: "transferring",
      patient: "Riley D.",
      appointment: "A-20423",
      attempt: 1,
      language: "en",
      verified: true,
      disclosed: true,
      outcome: "reschedule_handoff",
      reason: null,
      said: [
        "Hi, this is Contoso Health's automated assistant, calling with an appointment reminder. Am I speaking with Riley?",
        "Thanks, Riley. To protect your privacy, please tell me your date of birth.",
        "You have a primary care appointment with Dr. Nguyen on Thursday, May 21 at 10:00 AM, at the Downtown Phoenix clinic. Will you be able to make it?",
        "I'll connect you with our scheduling team to find a new time. Your current appointment stays booked until you choose a new one. Please hold.",
      ],
      schedule: "new time requested",
      freed: [],
      handoff: {
        to: "Scheduling desk",
        topic: "Reschedule – Primary Care A-20423",
        context: "Riley D. (verified) wants a new time for Primary Care Follow-up on Thu, May 21, 10:00 AM MST. The current slot stays booked until a new one is chosen.",
        callerSaid: "Can I come next week instead?",
        wire: {
          intent: "reschedule",
          appointmentId: "A-20423",
          patientRef: "…",
          verified: true,
          sessionId: "…",
        },
        headers: ["CallDetails.SessionId", "CallDetails.CallTopic", "CallDetails.CallContext"],
      },
      trail: [
        "call_created Reminder call to Riley D. about A-20423 (attempt 1 of 3)",
        "cleared_to_call Cleared to call: inside Riley's reminder window and calling hours (8:00 AM–8:00 PM local time).",
        "minimum_necessary A person answered: no appointment details until identity is verified",
        "identity_claimed Right party claimed: asking for date of birth before any details",
        "identity_verified Date of birth matched: identity verified",
        "details_disclosed Verified: appointment details shared",
        "reschedule_handoff Handing off to the scheduling desk with context; the agent books nothing itself",
        "outcome Handed to the scheduling desk with context; nothing booked by the agent",
      ],
    },
  ],
  "Someone else answers": [
    {
      state: "ended",
      patient: "Camila L.",
      appointment: "A-20424",
      attempt: 1,
      language: "en",
      verified: false,
      disclosed: false,
      outcome: "wrong_party",
      reason: null,
      said: [
        "Hi, this is Contoso Health's automated assistant, calling with an appointment reminder. Am I speaking with Camila?",
        "Thanks. Could you please ask Camila to call Contoso Health at 602-555-0100? Have a good day.",
      ],
      schedule: "booked",
      freed: [],
      handoff: null,
      trail: [
        "call_created Reminder call to Camila L. about A-20424 (attempt 1 of 3)",
        "cleared_to_call Cleared to call: inside Camila's reminder window and calling hours (8:00 AM–8:00 PM local time).",
        "minimum_necessary A person answered: no appointment details until identity is verified",
        "minimum_necessary Someone other than the patient answered: callback request only, no appointment details",
        "outcome Someone other than the patient answered",
      ],
    },
  ],
  "Voicemail: callback only": [
    {
      state: "ended",
      patient: "Camila L.",
      appointment: "A-20424",
      attempt: 3,
      language: "en",
      verified: false,
      disclosed: false,
      outcome: "voicemail_left",
      reason: null,
      said: [
        "This is Contoso Health calling for Camila with an appointment reminder. Please call us back at 602-555-0100. Thank you.",
      ],
      schedule: "booked",
      freed: [],
      handoff: null,
      trail: [
        "call_created Reminder call to Camila L. about A-20424 (attempt 3 of 3)",
        "cleared_to_call Cleared to call: inside Camila's reminder window and calling hours (8:00 AM–8:00 PM local time).",
        "voicemail_detected Voicemail detected (greeting said “leave a message”)",
        "minimum_necessary Anyone could hear a voicemail: callback request only, no appointment details",
        "outcome Voicemail on the last attempt: callback request only, no details",
      ],
    },
  ],
  "Too late to call": [
    {
      state: "not_placed",
      patient: "Noah M.",
      appointment: "A-20425",
      attempt: 1,
      language: "en",
      verified: false,
      disclosed: false,
      outcome: "not_placed",
      reason: "calling_window",
      said: [],
      schedule: "booked",
      freed: [],
      handoff: null,
      trail: [
        "call_created Checking whether Noah M. may be called now",
        "not_placed Calling hours are 8:00 AM–8:00 PM in Noah's time zone; it's 8:30 PM there now. Next allowed: Wed, May 20, 8:00 AM PDT.",
        "outcome Call not placed (calling window)",
      ],
    },
  ],
};

/** The metrics strip after all six beats. */
const EXPECTED_STATS = {
  calls: 6,
  placed: 5,
  answered: 4,
  reached: 3,
  confirmed: 1,
  cancelled: 1,
  reschedulesHandedOff: 1,
  privacySafeVoicemails: 1,
  callbackOnly: 1,
  notPlaced: 1,
  optedOut: 0,
  nurseTransfers: 0,
  transfersFailed: 0,
  retriesScheduled: 0,
  byOutcome: {
    confirmed: 1,
    cancelled: 1,
    reschedule_handoff: 1,
    wrong_party: 1,
    voicemail_left: 1,
    not_placed: 1,
  },
  slotsReleased: 1,
  rescheduleRequests: 1,
  optOuts: 0,
  appointments: 30,
  byStatus: { booked: 20, cancelled: 1, completed: 5, confirmed: 1, no_show: 3 },
};

// public/app.js TERMINAL: the flow's terminal states.
const TERMINAL = new Set(["ended", "confirmed", "cancelled", "transferring", "opt_out", "retry_scheduled", "not_placed", "skipped"]);

// public/app.js PICKUPS: "who picks up" → what the simulated dial does.
const PICKUPS = {
  answered: { outcome: "answered", attempt: null },
  "voicemail-last": { outcome: "voicemail", attempt: 3 },
  voicemail: { outcome: "voicemail", attempt: 1 },
  busy: { outcome: "busy", attempt: null },
  no_answer: { outcome: "no_answer", attempt: null },
};

// public/app.js renderBoard(): an appointment's status as the schedule panel shows it.
const boardStatus = (row) =>
  row.rescheduleRequested && row.status !== "cancelled" ? "new time requested" : String(row.status ?? "").replace(/_/g, " ");

await rehearse({
  port: 8299,
  env: SIMULATION,
  liveEnv: LIVE,
  liveRefused: [
    ["/api/demo/restore", { appointmentIds: ["A-20418"] }],
    ["/api/simulate", { appointmentId: "A-20418", outcome: "answered" }],
  ],
  // public/app.js startBody(): the beat's patient, pickup and language. A
  // voicemail on the last attempt is the one that leaves a message.
  startBody: (step) => {
    const pickup = step.outcome === "voicemail" && (step.attempt ?? 1) >= 3 ? "voicemail-last" : (step.outcome ?? "answered");
    const dial = PICKUPS[pickup] ?? PICKUPS.answered;
    return {
      appointmentId: step.appointmentId,
      outcome: dial.outcome,
      attempt: step.attempt ?? dial.attempt,
      language: "language" in step ? step.language : null,
    };
  },
  // public/app.js perform() is the engine's default: a new call hangs up the one on screen first.
  isFinished: (state) => TERMINAL.has(state),
  // public/app.js restore(): each beat puts its patient back the way the seed has them.
  hooks: (ctx) => ({
    restore: async (appointmentIds) => {
      await ctx.post("/api/demo/restore", { appointmentIds });
      await ctx.get("/api/schedule");
    },
  }),
  // public/app.js showMetrics(): let the last call settle, then show the numbers.
  actions: (ctx) => ({
    metrics: async () => {
      for (let i = 0; i < 30 && !ctx.session.finished; i += 1) await ctx.sleep(100);
      return ctx.get("/api/stats");
    },
  }),
  outcome: async ({ calls, ctx }) => {
    const seen = [];
    for (const { snapshot: s, events } of calls) {
      const id = s?.appointmentId ?? "";
      const { body: clinic } = await ctx.request("GET", `/api/schedule?ids=${encodeURIComponent(id)}`);
      const row = clinic?.board?.find((r) => r.appointmentId === id);
      const h = s?.handoff;
      seen.push({
        state: s?.state ?? null,
        patient: s?.patient ?? null,
        appointment: s?.appointmentId ?? null,
        attempt: s?.attempt ?? null,
        language: s?.language ?? null,
        verified: Boolean(s?.verified),
        disclosed: Boolean(s?.disclosed),
        outcome: s?.outcome ?? null,
        reason: s?.reason ?? null,
        said: (s?.transcript ?? []).filter((t) => t.role === "agent").map((t) => t.text),
        schedule: row ? boardStatus(row) : null,
        freed: (clinic?.releasedSlots ?? [])
          .filter((slot) => slot.appointmentId === id)
          .map((slot) => `Open slot · ${slot.provider} · ${slot.department} · ${slot.localTime}`),
        // The patient reference and session id are fresh every call; the rest is what the desk sees.
        handoff: h
          ? {
              to: h.queue,
              topic: h.callTopic,
              context: h.summary,
              callerSaid: h.callerSaid,
              wire: { ...h.callContext, patientRef: "…", sessionId: "…" },
              headers: (h.voipHeaders ?? []).map((x) => x.key),
            }
          : null,
        trail: trail(events),
      });
    }
    return seen;
  },
  expected: EXPECTED,
  stats: (counts) => counts,
  expectedStats: EXPECTED_STATS,
});
