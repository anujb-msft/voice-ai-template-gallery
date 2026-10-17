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
 * console's start body and step wrapper in public/app.js, and what each beat
 * should leave on screen.
 *
 * Changed a beat, the routes or the policy on purpose? The run prints the
 * outcomes it reached. Check each against DEMO-SCRIPT.md, then paste them over
 * EXPECTED below.
 */
import { rehearse, trail } from "./presenter-kit-rehearsal.mjs";

// The shipped settings, with the audit log in memory instead of ./data/routing.db.
const SIMULATION = { DB_PATH: ":memory:" };

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
  "One question, no menu": [
    {
      state: "transferred",
      caller: "Dana Whitfield",
      route: "billing",
      to: "billing",
      afterHours: false,
      outcome: "transferred:billing",
      clarifications: 0,
      trail: [
        "call_created known caller Dana Whitfield",
        "route_proposed billing @ 0.95",
        "route_confirmed billing (confirmed)",
        "transfer_started billing",
        "transfer_simulated billing",
      ],
    },
  ],
  "Not sure? Ask": [
    {
      state: "transferred",
      caller: "Priya Raman",
      route: "billing",
      to: "billing",
      afterHours: false,
      outcome: "transferred:billing",
      clarifications: 1,
      trail: [
        "call_created known caller Priya Raman",
        "low_confidence sales @ 0.6",
        "clarification low_confidence (1)",
        "route_proposed billing @ 0.85",
        "route_confirmed billing (confirmed)",
        "transfer_started billing",
        "transfer_simulated billing",
      ],
    },
  ],
  "“A person, please”": [
    {
      state: "transferred",
      caller: null,
      route: "reception",
      to: "reception",
      afterHours: false,
      outcome: "transferred:reception",
      clarifications: 0,
      trail: [
        "call_created unknown caller",
        "human_requested explicit_request",
        "route_confirmed reception (human_requested)",
        "transfer_started reception",
        "transfer_simulated reception",
      ],
    },
  ],
  "Changed their mind": [
    {
      state: "transferred",
      caller: "Marcus Bell",
      route: "support",
      to: "support",
      afterHours: false,
      outcome: "transferred:support",
      clarifications: 0,
      trail: [
        "call_created known caller Marcus Bell",
        "route_proposed billing @ 0.85",
        "route_confirmed billing (confirmed)",
        "route_changed billing → support",
        "route_proposed support @ 0.85",
        "route_confirmed support (confirmed)",
        "transfer_started support",
        "transfer_simulated support",
      ],
    },
  ],
  "After hours: a message": [
    {
      state: "ended",
      caller: "Dana Whitfield",
      route: "billing",
      to: null,
      afterHours: false,
      outcome: "message_taken",
      clarifications: 0,
      trail: [
        "call_created known caller Dana Whitfield",
        "route_proposed billing @ 0.85",
        "route_confirmed billing (confirmed)",
        "message_taken Please call me back about the duplicate charge",
      ],
    },
  ],
  "After hours: diverted": [
    {
      state: "transferred",
      caller: "Marcus Bell",
      route: "sales",
      to: "reception",
      afterHours: true,
      outcome: "transferred:reception",
      clarifications: 0,
      trail: [
        "call_created known caller Marcus Bell",
        "route_proposed sales @ 0.95",
        "route_confirmed sales (confirmed)",
        "transfer_started reception",
        "transfer_simulated reception",
      ],
    },
  ],
  "Silence → keypad": [
    {
      state: "transferred",
      caller: null,
      route: "support",
      to: "support",
      afterHours: false,
      outcome: "transferred:support",
      clarifications: 2,
      trail: [
        "call_created unknown caller",
        "no_input",
        "clarification no_input (1)",
        "no_input",
        "clarification no_input (2)",
        "dtmf 2 → support",
        "route_confirmed support (dtmf)",
        "transfer_started support",
        "transfer_simulated support",
      ],
    },
  ],
};

/** The metrics panel after all seven beats (median seconds to route varies, so it is left out). */
const EXPECTED_STATS = {
  calls: 7,
  byOutcome: {
    message_taken: 1,
    "transferred:billing": 2,
    "transferred:reception": 2,
    "transferred:support": 2,
  },
  byRoute: { billing: 3, reception: 1, sales: 1, support: 2 },
  clarifications: 3,
  fallbacks: 0,
  transfers: 6,
  failedTransfers: 0,
  messagesTaken: 1,
  humanRequests: 1,
};

await rehearse({
  port: 8291,
  env: SIMULATION,
  liveEnv: LIVE,
  // public/app.js startBody(): the beat's caller ID, or a withheld number.
  startBody: (step) => ({ fromPhone: ("fromPhone" in step ? (step.fromPhone ?? "") : "") || null }),
  // public/app.js perform(): a new call first lets a transfer in flight land.
  busy: (snapshot) => snapshot.state === "transferring",
  settleMs: ({ health }) => (health?.routing?.transferDelayMs ?? 1200) + 3000,
  outcome: ({ calls }) =>
    calls.map(({ snapshot: s, events }) => ({
      state: s?.state ?? null,
      caller: s?.caller?.name ?? null,
      route: s?.confirmedRouteId ?? null,
      to: s?.destination?.routeId ?? null,
      afterHours: Boolean(s?.destination?.afterHours),
      outcome: s?.outcome ?? null,
      clarifications: s?.clarifications ?? 0,
      trail: trail(events),
    })),
  expected: EXPECTED,
  stats: ({ medianSecondsToRoute, ...counts }) => counts,
  expectedStats: EXPECTED_STATS,
});
