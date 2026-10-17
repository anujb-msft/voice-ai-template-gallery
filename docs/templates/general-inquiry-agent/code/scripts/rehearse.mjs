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
 * Changed a beat, an article or the policy on purpose? The run prints the
 * outcomes it reached. Check each against DEMO-SCRIPT.md, then paste them over
 * EXPECTED below.
 */
import { rehearse, trail } from "./presenter-kit-rehearsal.mjs";

// The shipped settings, with the audit log in memory instead of ./data/general-inquiry.db.
const SIMULATION = { DB_PATH: ":memory:" };

// Enough for /health to report a live server. Nothing is called: ACS and Voice
// Live clients are created on the first real call, and .invalid never resolves.
const LIVE = {
  ACS_ENDPOINT: "https://rehearsal.invalid",
  PUBLIC_BASE_URL: "https://rehearsal.invalid",
  VOICE_LIVE_ENDPOINT: "https://rehearsal.invalid",
};

/** What each beat leaves on screen, call by call: no ids, no times. */
const EXPECTED = {
  "Hours, with the source": [
    {
      state: "closed",
      caller: "+•••••••••23",
      outcome: "caller_done",
      decision: "answer",
      sources: ["city-hall-hours · open until 5 p.m."],
      topic: null,
      context: null,
      trail: [
        "call_created acs-direct",
        "search_content What are City Hall's hours?",
        "answer_recorded city-hall-hours",
        "citation_spoken city-hall-hours",
      ],
    },
  ],
  "Due for review: a caveat": [
    {
      state: "listening",
      caller: "+•••••••••45",
      outcome: null,
      decision: "answer",
      sources: ["waste-bulky-pickup · 77 days past review, caveat for 14 days more"],
      topic: null,
      context: null,
      trail: [
        "call_created acs-direct",
        "search_content Can the city pick up an old sofa?",
        "answer_recorded waste-bulky-pickup",
        "stale_answer waste-bulky-pickup",
      ],
    },
  ],
  "Out of date: not read out": [
    {
      state: "closed",
      caller: "+•••••••••67",
      outcome: "caller_done",
      decision: "expired",
      sources: ["yard-sale-permit · 182 days past review, withheld"],
      topic: null,
      context: null,
      trail: [
        "call_created acs-direct",
        "search_content Do I need a permit for a yard sale?",
        "expired_refusal yard-sale-permit",
        "human_offered expired_content",
      ],
    },
  ],
  "After hours": [
    {
      state: "closed",
      caller: "+•••••••••23",
      outcome: "after_hours:caller_requested",
      decision: "after_hours",
      sources: ["city-hall-hours · closed, opens Thursday at 8 a.m."],
      topic: null,
      context: null,
      trail: [
        "call_created acs-direct",
        "search_content What are City Hall's hours?",
        "answer_recorded city-hall-hours",
        "human_requested caller_requested",
        "after_hours_closed Thursday at 8 a.m.",
      ],
    },
  ],
  "Eligibility: a person decides": [
    {
      state: "transferred",
      caller: "+•••••••••45",
      outcome: "transferred:eligibility_review",
      decision: "handoff",
      sources: ["senior-utility-discount"],
      topic: "Senior utility discount — eligibility",
      context: "Caller asked: \"I'm [number] — do I qualify for the senior utility discount?\" Answered from senior-utility-discount. Transferring because eligibility needs a staff decision.",
      trail: [
        "call_created acs-direct",
        "search_content I'm [number] — do I qualify for the senior utility discount?",
        "answer_recorded senior-utility-discount",
        "human_offered eligibility_review",
        "human_requested eligibility_review",
        "transfer_started eligibility_review",
        "transfer_simulated Contoso information desk",
      ],
    },
  ],
  "Not on this line: a person": [
    {
      state: "transferred",
      caller: "anonymous",
      outcome: "transferred:service_request",
      decision: "handoff",
      sources: [],
      topic: "Report a pothole on Elm Street",
      context: "No approved answer was given. Transferring because this line can't file service requests.",
      trail: [
        "call_created acs-direct",
        "retrieval_miss service_request",
        "human_offered service_request",
        "human_requested service_request",
        "transfer_started service_request",
        "transfer_simulated Contoso information desk",
      ],
    },
  ],
};

/** The metrics panel after all six beats. */
const EXPECTED_STATS = {
  calls: 6,
  answers: 4,
  groundedAnswerRate: 1,
  staleAnswerCount: 1,
  expiredRefusals: 1,
  misses: 1,
  transfers: 2,
  failedTransfers: 0,
  humanRequests: 3,
  afterHoursClosures: 1,
  offersDeclined: 0,
  escalationRate: 0.5,
  deflectionRate: 0.333,
  perTopicCounts: {
    "hours-locations": 2,
    "waste-recycling": 1,
    "permits-licences": 1,
    "benefits-eligibility": 1,
    unknown: 1,
  },
};

/**
 * The source panel, judged on the demo clock: each article read out or withheld,
 * how far past its review date, and whether the place is open right now.
 */
function sources(s) {
  const answered = new Set((s?.answers ?? []).flatMap((a) => a.articleIds));
  const read = new Map();
  for (const p of (s?.searches ?? []).flatMap((q) => q.passages ?? [])) if (answered.has(p.articleId)) read.set(p.articleId, p);
  const caveat = (p) => p.freshness === "stale" && `${p.overdueDays} days past review, caveat for ${p.expiresInDays} days more`;
  const hours = ({ hoursNow: h }) => h && (h.open ? `open until ${h.closesAt}` : `closed, opens ${h.nextOpening}`);
  return [
    ...[...read.values()].map((p) => [p.articleId, caveat(p), hours(p)].filter(Boolean).join(" · ")),
    ...(s?.withheld ?? []).map((w) => `${w.articleId} · ${w.overdueDays} days past review, withheld`),
  ];
}

await rehearse({
  port: 8292,
  env: SIMULATION,
  liveEnv: LIVE,
  // public/app.js startBody(): the beat's caller ID, or a withheld number.
  startBody: (step) => ({ fromPhone: ("fromPhone" in step ? (step.fromPhone ?? "") : "") || null }),
  // public/app.js perform(): a new call first lets a transfer in flight land.
  busy: (snapshot) => snapshot.state === "transferring",
  settleMs: 3000,
  outcome: ({ calls }) =>
    calls.map(({ snapshot: s, events }) => ({
      state: s?.state ?? null,
      caller: s?.maskedPhone ?? null,
      outcome: s?.outcome ?? null,
      decision: s?.decision?.kind ?? null,
      sources: sources(s),
      topic: s?.handoff?.callTopic ?? null,
      context: s?.handoff?.callContext ?? null,
      trail: trail(events),
    })),
  expected: EXPECTED,
  // Counts and rates only: nothing in the metrics depends on timing.
  stats: (metrics) => metrics,
  expectedStats: EXPECTED_STATS,
});
