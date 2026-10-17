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
 * console's callers, start body and step wrapper in public/app.js, and what
 * each beat should leave on screen.
 *
 * Changed a beat, the policy or the fixtures on purpose? The run prints the
 * outcomes it reached. Check each against DEMO-SCRIPT.md, then paste them over
 * EXPECTED below.
 */
import { rehearse, trail } from "./presenter-kit-rehearsal.mjs";

// The shipped settings, with the audit log and the tickets in memory instead of ./data/triage.db.
const SIMULATION = { DB_PATH: ":memory:" };

// Enough for /health to report a live server. Nothing is called: ACS and Voice
// Live clients are created on the first real call, and .invalid never resolves.
const LIVE = {
  ACS_ENDPOINT: "https://rehearsal.invalid",
  PUBLIC_BASE_URL: "https://rehearsal.invalid",
  VOICE_LIVE_ENDPOINT: "https://rehearsal.invalid",
  VOICE_LIVE_API_KEY: "rehearsal",
};

// public/app.js CALLERS: who the console's caller picker puts on the line.
const CALLERS = [
  { id: "sam", body: { teamsUserId: "8:orgid:11111111-1111-1111-1111-111111111111" } },
  { id: "maria", body: { teamsUserId: "8:orgid:22222222-2222-2222-2222-222222222222" } },
  { id: "sam-mobile", body: { fromPhone: "+14255550101" } },
  { id: "unknown", body: { fromPhone: "+14255550199" } },
];

/** What each beat leaves on screen, call by call: no ids, no times. */
const EXPECTED = {
  "Teams: answer, then ticket": [
    {
      state: "filed",
      caller: "Sam Rivera",
      verifiedBy: "teams",
      topic: "laptop display",
      article: "it-vpn-001",
      ticket: {
        number: "INC-next",
        category: "Hardware/Laptop",
        priority: "P2",
        status: "New",
        asset: "Surface Laptop",
        alreadyAffected: false,
      },
      to: null,
      why: null,
      callTopic: null,
      callContext: null,
      outcome: null,
      trail: [
        "call_created teams_verified",
        "classified IT · VPN connection · 0.96",
        "answered it-vpn-001",
        "classified IT · laptop display · 0.98",
        "ticket_proposed Hardware/Laptop · P2",
        "ticket_created INC-next · P2",
      ],
    },
  ],
  "Only your own tickets": [
    {
      state: "listening",
      caller: "Maria Lopez",
      verifiedBy: "teams",
      topic: "Outlook",
      article: null,
      ticket: {
        number: "INC-004700",
        category: "Messaging/Outlook",
        priority: "P1",
        status: "Monitoring",
        asset: null,
        alreadyAffected: false,
      },
      to: null,
      why: null,
      callTopic: null,
      callContext: null,
      outcome: null,
      trail: [
        "call_created teams_verified",
        "ticket_status_refused INC-004610",
        "ticket_status INC-004700",
        "classified IT · Outlook · 0.84",
        "outage_attached INC-004700",
      ],
    },
  ],
  "Phone caller: prove it": [
    {
      state: "listening",
      caller: "Sam Rivera",
      verifiedBy: "code",
      topic: null,
      article: null,
      ticket: {
        number: "INC-004610",
        category: "Hardware/Printer",
        priority: "P3",
        status: "In progress",
        asset: null,
        alreadyAffected: false,
      },
      to: null,
      why: null,
      callTopic: null,
      callContext: null,
      outcome: null,
      trail: [
        "call_created caller_id_match_unverified",
        "verification_required ticket_status",
        "code_sent Teams chat",
        "code_refused attempt 1",
        "verified one-time code",
        "ticket_status INC-004610",
      ],
    },
  ],
  "Sensitive HR stays private": [
    {
      state: "transferred",
      caller: "Sam Rivera",
      verifiedBy: "teams",
      topic: null,
      article: null,
      ticket: null,
      to: "confidential-hr",
      why: null,
      callTopic: "Confidential HR",
      callContext: "Confidential HR",
      outcome: "transferred:confidential-hr",
      trail: [
        "call_created teams_verified",
        "confidential_hr details not collected",
        "transfer confidential-hr",
      ],
    },
  ],
  "IT or HR? Ask once": [
    {
      state: "transferred",
      caller: "Maria Lopez",
      verifiedBy: "teams",
      topic: "paycheck amount",
      article: null,
      ticket: null,
      to: "payroll",
      why: "topic",
      callTopic: "HR - paycheck amount",
      callContext: { verifiedName: "Maria Lopez", topic: "paycheck amount" },
      outcome: "transferred:payroll",
      trail: [
        "call_created teams_verified",
        "low_confidence application access or paycheck amount · 0.45",
        "clarified paycheck amount",
        "transfer payroll",
      ],
    },
  ],
  "Still stuck? A person": [
    {
      state: "transferred",
      caller: "Maria Lopez",
      verifiedBy: "teams",
      topic: "printer",
      article: "it-printer-001",
      ticket: null,
      to: "it-service-desk",
      why: "asked_for_person",
      callTopic: "Asked for a person - printer",
      callContext: {
        verifiedName: "Maria Lopez",
        topic: "printer",
        tried: "Printer troubleshooting",
      },
      outcome: "transferred:it-service-desk",
      trail: [
        "call_created teams_verified",
        "classified IT · printer · 0.96",
        "answered it-printer-001",
        "human_requested it-service-desk",
        "transfer it-service-desk",
      ],
    },
  ],
  "Phishing: P1 to on-call": [
    {
      state: "transferred",
      caller: "Sam Rivera",
      verifiedBy: "teams",
      topic: "phishing click",
      article: null,
      ticket: {
        number: "INC-next",
        category: "Security/phishing_click",
        priority: "P1",
        status: "New",
        asset: "Surface Laptop",
        alreadyAffected: false,
      },
      to: "it-on-call",
      why: "urgent_ticket",
      callTopic: "P1 security - phishing click, INC-next",
      callContext: {
        verifiedName: "Sam Rivera",
        ticketNumber: "INC-next",
        priority: "P1",
        topic: "phishing click",
        matchedAsset: "LAP-••••",
      },
      outcome: "transferred:it-on-call",
      trail: [
        "call_created teams_verified",
        "classified IT · phishing click · 0.84",
        "ticket_proposed Security/phishing_click · P1",
        "ticket_created INC-next · P1",
        "transfer it-on-call",
      ],
    },
  ],
};

/** The metrics panel after all seven beats (the average time to resolution varies, so it is left out). */
const EXPECTED_STATS = {
  calls: 7,
  mix: { HR: 2, IT: 4, none: 1 },
  tier1Deflection: 2,
  routingAccuracy: null,
  answersByArticle: { "it-printer-001": 1, "it-vpn-001": 1 },
  ticketsByCategory: {
    "Hardware/Printer": 1,
    "Messaging/Outlook": 1,
    "Access/Application": 1,
    "Hardware/Laptop": 1,
    "Security/phishing_click": 1,
  },
  ticketsByPriority: { P3: 1, P1: 2, P4: 1, P2: 1 },
  outageAttachments: 1,
  resetHandoffs: 0,
  transfersByDestination: { "it-on-call": 1, "it-service-desk": 1, payroll: 1 },
  outOfScopeRedirects: 0,
  verificationOutcomes: {
    required: 1,
    sent: 1,
    verified: 1,
    refused: 1,
    expired: 0,
    unknownEmail: 0,
  },
  confidentialHr: "<5",
  story: {
    calls: 7,
    answered: 4,
    ticketsFiled: 2,
    duplicatesAvoided: 1,
    verifiedByCode: 1,
    codesRefused: 1,
    sensitiveRouted: "<5",
    handedOff: 3,
  },
};

/**
 * Ticket numbers only restart on a reset, so a re-run of a beat files the next
 * one. A number the call filed is pinned as INC-next; the seeded ones as they are.
 */
function renumber(value, events) {
  let json = JSON.stringify(value);
  for (const { kind, detail } of events) {
    const filed = kind === "ticket_created" ? /^([A-Z]+)-\d+/.exec(detail ?? "") : null;
    if (filed) json = json.replaceAll(filed[0], `${filed[1]}-next`);
  }
  return JSON.parse(json);
}

await rehearse({
  port: 8298,
  env: SIMULATION,
  liveEnv: LIVE,
  // public/app.js startBody(): the beat's caller from the caller picker.
  startBody: (step) => ({ ...(CALLERS.find((c) => c.id === step.caller) ?? CALLERS[0]).body }),
  // public/app.js perform(): a new call first lets a handoff in flight land, for up to 4 s.
  busy: (snapshot) => snapshot.state === "transferring",
  settleMs: 4000,
  outcome: ({ calls }) =>
    calls.map(({ snapshot: s, events, frames }) => {
      const t = s?.lastTicket;
      return renumber(
        {
          state: s?.state ?? null,
          caller: s?.caller?.displayName ?? null,
          verifiedBy: s?.verifiedBy ?? null,
          topic: s?.topicLabel ?? null,
          article: s?.lastArticle?.id ?? null,
          ticket: t
            ? {
                number: t.number,
                category: t.category,
                priority: t.priority,
                status: t.status,
                asset: t.asset,
                alreadyAffected: t.alreadyAffected,
              }
            : null,
          to: s?.handoff?.destinationId ?? null,
          // Why the Teams toast says the call moved: its urgent and "after one question" tags.
          why: frames.findLast((f) => f.target === "handoff")?.payload.reason ?? null,
          callTopic: s?.handoff?.callTopic ?? null,
          callContext: s?.handoff?.callContext ?? null,
          outcome: s?.outcome ?? null,
          trail: trail(events),
        },
        events,
      );
    }),
  expected: EXPECTED,
  stats: ({ averageTimeToResolutionMs, ...counts }) => counts,
  expectedStats: EXPECTED_STATS,
});
