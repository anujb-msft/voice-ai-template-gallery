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
 * server answering real calls refuses the demo controls. No Azure resource and
 * no network; neither your .env nor your shell's settings reach the server.
 *
 * The engine is scripts/presenter-kit-rehearsal.mjs (vendored; edit it at the
 * repository root). This file mirrors what is this template's own: the
 * console's start body, step wrapper and demo actions in public/app.js, and
 * what each beat should leave on screen.
 *
 * Changed a beat, the schedule or the policy on purpose? The run prints the
 * outcomes it reached. Check each against DEMO-SCRIPT.md, then paste them over
 * EXPECTED below.
 */
import { rehearse, trail } from "./presenter-kit-rehearsal.mjs";

// The shipped settings, with the audit log in memory instead of
// ./data/scheduling-audit.db. Simulation already books into an in-memory copy
// of the seeded schedule; naming it keeps the live server below off
// ./data/schedule.db too.
const SIMULATION = { DB_PATH: ":memory:", SCHEDULE_DB_PATH: ":memory:" };

// Enough for /health to report a live server. Nothing is called: ACS and Voice
// Live clients are created on the first real call, and .invalid never resolves.
const LIVE = {
  ACS_ENDPOINT: "https://rehearsal.invalid",
  PUBLIC_BASE_URL: "https://rehearsal.invalid",
  VOICE_LIVE_ENDPOINT: "https://rehearsal.invalid",
  VOICE_LIVE_API_KEY: "rehearsal",
};

/** What each beat leaves on screen, call by call: no ids, no times. */
const EXPECTED = {
  "Booked in one call": [
    {
      state: "booked",
      caller: "Jordan R.",
      visit: "new-problem visit",
      checks: { identity: "pass", eligibility: "pass", proposal: "pass", consent: "pass" },
      refusals: 0,
      races: 0,
      booking: {
        kind: "book",
        with: "Dr. Patel",
        proposal: "P1",
        consent: "said yes",
        afterRace: false,
      },
      handoff: null,
      outcome: "booked",
      trail: [
        "call_created simulated call from +•••••••••42 · caller ID matches a patient (not proof of identity)",
        "identity_verified Jordan R. · name + date of birth · caller ID agrees (not used as proof)",
        "reason visit reason noted (kept out of the console)",
        "eligible new-problem visit · no referral needed",
        "search new-problem visit · usual doctor · mornings",
        "options_offered … or …",
        "proposal P1 · … · held until …",
        "consent P1 · said yes to …",
        "booked A-… · … · P1 confirmed by the caller",
      ],
    },
  ],
  "“Just book whatever”": [
    {
      state: "booked",
      caller: "Mia C.",
      visit: "follow-up visit",
      checks: { identity: "pass", eligibility: "pass", proposal: "pass", consent: "pass" },
      refusals: 2,
      races: 0,
      booking: {
        kind: "book",
        with: "Dr. Patel",
        proposal: "P1",
        consent: "said yes",
        afterRace: false,
      },
      handoff: null,
      outcome: "booked",
      trail: [
        "call_created simulated call from +•••••••••02 · caller ID matches a patient (not proof of identity)",
        "identity_verified Mia C. · name + date of birth · caller ID agrees (not used as proof)",
        "write_refused no active proposal · nothing written",
        "eligible follow-up visit · no referral needed",
        "search follow-up visit · Dr. Patel",
        "options_offered … or …",
        "write_refused the model has no booking tool · nothing written",
        "proposal P1 · … · held until …",
        "consent P1 · said yes to …",
        "booked A-… · … · P1 confirmed by the caller",
      ],
    },
  ],
  "Taken mid-call": [
    {
      state: "booked",
      caller: "Avery S.",
      visit: "follow-up visit",
      checks: { identity: "pass", eligibility: "pass", proposal: "pass", consent: "pass" },
      refusals: 1,
      races: 1,
      booking: {
        kind: "book",
        with: "Dr. Patel",
        proposal: "P2",
        consent: "said yes",
        afterRace: true,
      },
      handoff: null,
      outcome: "booked",
      trail: [
        "call_created simulated call from +•••••••••01 · caller ID matches a patient (not proof of identity)",
        "identity_verified Avery S. · name + date of birth · caller ID agrees (not used as proof)",
        "eligible follow-up visit · no referral needed",
        "search follow-up visit · Dr. Patel",
        "options_offered … or …",
        "proposal P1 · … · held until …",
        "taken_elsewhere … booked by the front desk · this caller isn't told until they say yes",
        "consent P1 · said yes to …",
        "write_refused P1 · slot_taken · nothing written",
        "slot_taken P1 void · … was booked by another channel",
        "options_offered … or …",
        "proposal P2 · … · held until …",
        "consent P2 · said yes to …",
        "booked A-… · … · P2 confirmed by the caller",
        "race_resolved A-… · fresh pick P2, fresh yes",
      ],
    },
  ],
  "Needs a referral": [
    {
      state: "transferred",
      caller: "Jordan R.",
      visit: "skin check",
      checks: { identity: "pass", eligibility: "fail", proposal: "pending", consent: "pending" },
      refusals: 0,
      races: 0,
      booking: null,
      handoff: {
        to: "Referral coordinator",
        reason: "referral_required",
        topic: "Scheduling – referral needed",
        context: {
          firstName: "Jordan",
          verified: "yes (name + date of birth)",
          visitType: "skin check",
          department: "Dermatology",
          ruleId: "REFERRAL_REQUIRED",
          summary: "Verified patient · skin check · blocked: REFERRAL_REQUIRED · nothing booked",
        },
      },
      outcome: "transferred:referral_coordinator",
      trail: [
        "call_created simulated call from +•••••••••42 · caller ID matches a patient (not proof of identity)",
        "identity_verified Jordan R. · name + date of birth · caller ID agrees (not used as proof)",
        "reason visit reason noted (kept out of the console)",
        "eligibility_blocked skin check · REFERRAL_REQUIRED",
        "handoff_requested Referral coordinator · referral required",
        "transfer_started Referral coordinator",
        "transfer_simulated Referral coordinator · Teams call topic and context attached",
      ],
    },
  ],
  "Identity fails": [
    {
      state: "transferred",
      caller: null,
      visit: null,
      checks: { identity: "fail", eligibility: "pending", proposal: "pending", consent: "pending" },
      refusals: 0,
      races: 0,
      booking: null,
      handoff: {
        to: "Scheduling team",
        reason: "verification_failed",
        topic: "Scheduling – identity not confirmed",
        context: {
          verified: "no",
          reason: "verification failed",
          summary: "Caller not verified after two attempts · nothing about appointments disclosed",
        },
      },
      outcome: "transferred:scheduling_team",
      trail: [
        "call_created simulated call from +•••••••••42 · caller ID matches a patient (not proof of identity)",
        "identity_failed attempt 1 of 2",
        "identity_not_confirmed two attempts · nothing about appointments disclosed",
        "handoff_requested Scheduling team · verification failed",
        "transfer_started Scheduling team",
        "transfer_simulated Scheduling team · Teams call topic and context attached",
      ],
    },
  ],
};

/** The metrics panel after all five beats, with outcomes counted without their confirmation numbers. */
const EXPECTED_STATS = {
  calls: 5,
  verified: 4,
  booked: 3,
  cancelled: 0,
  refusedWrites: 3,
  racesLost: 1,
  racesResolved: 1,
  takenElsewhere: 1,
  handoffs: 2,
  transfers: 2,
  callbacks: 0,
  advised: 0,
  failedTransfers: 0,
  eligibilityBlocks: 1,
  identityNotConfirmed: 1,
  safetyEscalations: 0,
  waitlisted: 0,
  byDestination: { referral_coordinator: 1, scheduling_team: 1 },
  schedule: {
    appointments: 34,
    upcomingOpen: 26,
    bookingsByVoice: 3,
    frontDeskBookings: 1,
    activeHolds: 0,
    releasedSlots: 0,
    waitlist: 0,
  },
  byOutcome: { booked: 3, "transferred:referral_coordinator": 1, "transferred:scheduling_team": 1 },
};

// public/app.js TERMINAL: the states that end a call on screen.
const TERMINAL = new Set(["booked", "rescheduled", "cancelled", "waitlisted", "callback_filed", "transferred", "ended"]);

// public/app.js perform() and showMetrics() wait this long for a handoff to land.
const landing = ({ health }) => (health?.scheduling?.transferDelayMs ?? 2500) + 3000;

// Out of order the times offered shift as earlier beats fill the schedule, and
// confirmation numbers and hold times change every run, so the trail keeps
// what was decided and drops when.
const SLOT = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [A-Z][a-z]{2} \d{1,2} · \d{1,2}:\d{2}\s[AP]M\b/g;
const scrub = (line) =>
  line
    .replace(SLOT, "…")
    .replace(/\bheld until \d{1,2}:\d{2}\s[AP]M\b/g, "held until …")
    .replace(/\bA-\d+\b/g, "A-…");

await rehearse({
  port: 8300,
  env: SIMULATION,
  liveEnv: LIVE,
  liveRefused: ["/api/demo/take-slot", "/api/demo/tool", ["/api/simulate", { fromPhone: "+12065550142" }]],
  // public/app.js startBody(): the beat's caller ID, or a withheld number.
  startBody: (step) => ({ fromPhone: ("fromPhone" in step ? (step.fromPhone ?? "") : "") || null }),
  // public/app.js perform(): a new call first lets a handoff in flight land.
  busy: (snapshot) => snapshot.state === "escalating",
  settleMs: landing,
  // public/app.js createCallSession(): only "state" frames carry the call's state.
  sessionOptions: { stateTargets: ["state"], stateOf: (payload) => payload?.state },
  isFinished: (state) => TERMINAL.has(state),
  // public/app.js resetDemo(): beat 1 starts from the seeded schedule.
  hooks: (ctx) => ({
    resetDemo: async () => {
      await ctx.post("/api/demo/reset");
      ctx.session.reset();
      return true;
    },
  }),
  // public/app.js takeSlot(), modelBook() and showMetrics(). On stage a 409
  // from take-slot is a warning toast instead of the race, so here it fails.
  actions: (ctx) => ({
    "take-slot": () => ctx.post("/api/demo/take-slot", { callId: ctx.session.id }),
    "model-book": () => ctx.post("/api/demo/tool", { callId: ctx.session.id, name: "book", args: {} }),
    metrics: async () => {
      const deadline = Date.now() + landing(ctx);
      while (!ctx.session.finished && Date.now() < deadline) await ctx.sleep(100);
      return ctx.get("/api/stats");
    },
  }),
  outcome: ({ calls }) =>
    calls.map(({ snapshot: s, events }) => ({
      state: s?.state ?? null,
      caller: s?.patient ? `${s.patient.firstName} ${s.patient.lastInitial}.` : null,
      visit: s?.visitType?.name ?? null,
      checks: Object.fromEntries((s?.checks ?? []).map((c) => [c.id, c.status])),
      refusals: s?.refusals ?? 0,
      races: s?.races ?? 0,
      booking: s?.booking
        ? { kind: s.booking.kind, with: s.booking.providerName, proposal: s.booking.proposalId, consent: s.booking.consent, afterRace: Boolean(s.booking.afterRace) }
        : null,
      handoff: s?.handoff ? { to: s.handoff.label, reason: s.handoff.reason, topic: s.handoff.callTopic, context: s.handoff.callContext } : null,
      outcome: s?.outcome?.replace(/:A-\d+$/, "") ?? null,
      trail: trail(events).map(scrub),
    })),
  expected: EXPECTED,
  stats: ({ byOutcome, ...counts }) => ({
    ...counts,
    byOutcome: Object.entries(byOutcome).reduce((all, [key, n]) => {
      const kind = key.replace(/:A-\d+$/, "");
      return { ...all, [kind]: (all[kind] ?? 0) + n };
    }, {}),
  }),
  expectedStats: EXPECTED_STATS,
});
