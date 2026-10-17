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
 * console's start body, step wrapper, beat restore, and handoff and metrics
 * steps in public/app.js, and what each beat should leave on screen.
 *
 * Changed a beat, the sales hours or the lead policy on purpose? The run
 * prints the outcomes it reached. Check each against DEMO-SCRIPT.md, then
 * paste them over EXPECTED below.
 */
import { rehearse, trail } from "./presenter-kit-rehearsal.mjs";

// The shipped settings, with the lead store in memory instead of ./data/after-hours-sales.db.
const SIMULATION = { DB_PATH: ":memory:" };

// Enough for /health to report a live server. Nothing is called: the ACS client
// and the Voice Live session are created on the first real call, and .invalid
// never resolves.
const LIVE = {
  ACS_ENDPOINT: "https://rehearsal.invalid",
  PUBLIC_BASE_URL: "https://rehearsal.invalid",
  VOICE_LIVE_ENDPOINT: "https://rehearsal.invalid",
};

/** What each beat leaves on screen, call by call: no ids, no times. */
const EXPECTED = {
  "After hours: capture": [
    {
      state: "ended",
      caller: "+•••••••••93",
      outcome: "lead_captured",
      route: "capture: Sales is closed until 8 AM tomorrow, so the assistant takes the details",
      lead: {
        who: "Dana Morgan, purchasing manager, Northwind Traders",
        wants: "12000, hex bolts, by the end of the month",
        callback: "+14255550193",
        score: "hot 8 of 8",
        partial: false,
        merged: false,
        owner: "Ava Chen",
        due: "Thursday 9 AM",
      },
      page: "not_needed: Hot, but nothing needs a person tonight, so it goes to the morning queue",
      paged: null,
      nonSales: null,
      teams: [
        "new → Ava Chen, @Jordan Lee: HOT lead: Dana Morgan at Northwind Traders needs hex bolts (12,000, by the end of the month). Call back 425-555-0193 by Thursday 9 AM.",
      ],
      handoff: null,
      trail: [
        "call_created +•••••••••93",
        "route_decision Sales is closed until 8 AM tomorrow, so the assistant takes the details",
        "phone_confirmed +•••••••••93",
        "lead_saved lead-…",
        "page_decision not_needed: Hot, but nothing needs a person tonight, so it goes to the morning queue",
      ],
    },
  ],
  "Business hours: straight to sales": [
    {
      state: "transferred",
      caller: "+•••••••••75",
      outcome: "transferred:sales",
      route: "transfer: Sales is open, so the caller goes straight to the sales queue",
      lead: null,
      page: null,
      paged: null,
      nonSales: null,
      teams: [],
      handoff: {
        topic: "Sales inquiry",
        routeId: "sales",
        context: "Sales inquiry during business hours. The caller went straight to the sales queue, so nothing was captured yet.",
      },
      trail: [
        "call_created +•••••••••75",
        "route_decision Sales is open, so the caller goes straight to the sales queue",
        "transfer_started Contoso Industrial Supply Sales Queue",
        "transfer_simulated sales",
      ],
    },
  ],
  "Read back, corrected": [
    {
      state: "ended",
      caller: "+•••••••••28",
      outcome: "lead_captured",
      route: "capture: Sales is closed until 8 AM tomorrow, so the assistant takes the details",
      lead: {
        who: "Casey Quinn, maintenance engineer (recommends), Fabrikam",
        wants: "200, brass fittings, next quarter",
        callback: "+14255550147",
        score: "warm 4 of 8",
        partial: false,
        merged: false,
        owner: "Ben Ortiz",
        due: "Thursday 6 PM",
      },
      page: "not_needed: Nothing needs a person tonight, so it goes to the morning queue",
      paged: null,
      nonSales: null,
      teams: [
        "new → Ben Ortiz: WARM lead: Casey Quinn at Fabrikam needs brass fittings (200, next quarter). Call back 425-555-0147 by Thursday 6 PM.",
      ],
      handoff: null,
      trail: [
        "call_created +•••••••••28",
        "route_decision Sales is closed until 8 AM tomorrow, so the assistant takes the details",
        "phone_corrected +•••••••••47",
        "phone_confirmed +•••••••••47",
        "lead_saved lead-…",
        "page_decision not_needed: Nothing needs a person tonight, so it goes to the morning queue",
      ],
    },
  ],
  "Not a sales call": [
    {
      state: "ended",
      caller: "+•••••••••11",
      outcome: "non-sales:existing-customer",
      route: "capture: Sales is closed until 8 AM tomorrow, so the assistant takes the details",
      lead: null,
      page: null,
      paged: null,
      nonSales: "existing-customer",
      teams: [],
      handoff: null,
      trail: [
        "call_created +•••••••••11",
        "route_decision Sales is closed until 8 AM tomorrow, so the assistant takes the details",
        "non_sales existing-customer",
      ],
    },
  ],
  "Hot and urgent: page on call": [
    {
      state: "transferred",
      caller: "+•••••••••62",
      outcome: "transferred:on-call",
      route: "capture: Sales is closed until 8 AM tomorrow, so the assistant takes the details",
      lead: {
        who: "Sam Rivera, operations director, Tailwind Traders",
        wants: "2000, cartons, by tomorrow morning",
        callback: "+14255550162",
        score: "hot 8 of 8",
        partial: false,
        merged: false,
        owner: "Ben Ortiz",
        due: "Thursday 9 AM",
      },
      page: "hot_urgent: Hot and urgent, and Ben Ortiz is on call until 9 PM",
      paged: "Ben Ortiz connected",
      nonSales: null,
      teams: [
        "new → Ben Ortiz, @Jordan Lee: HOT lead: Sam Rivera at Tailwind Traders needs cartons (2,000, by tomorrow morning). Call back 425-555-0162 by Thursday 9 AM. Paged on call: Hot and urgent, and Ben Ortiz is on call until 9 PM.",
      ],
      handoff: {
        topic: "Cartons — Tailwind Traders",
        routeId: "on-call",
        context: "HOT lead (8 of 8). Sam Rivera, operations director, Tailwind Traders. Cartons, 2,000 units, needed by tomorrow morning. Urgent: \"line is down\". Callback 425-555-0162 (confirmed). Paged because: Hot and urgent, and Ben Ortiz is on call until 9 PM",
      },
      trail: [
        "call_created +•••••••••62",
        "route_decision Sales is closed until 8 AM tomorrow, so the assistant takes the details",
        "asked_for_person caller",
        "phone_confirmed +•••••••••62",
        "lead_saved lead-…",
        "page_decision hot_urgent: Hot and urgent, and Ben Ortiz is on call until 9 PM",
        "page_started Ben Ortiz",
        "page_accepted Ben Ortiz",
        "transfer_started Ben Ortiz",
        "transfer_simulated on-call",
        "page_connected Ben Ortiz",
      ],
    },
  ],
  "After cover ends: morning queue": [
    {
      state: "ended",
      caller: "+•••••••••84",
      outcome: "lead_captured",
      route: "capture: Sales is closed until 8 AM tomorrow, so the assistant takes the details",
      lead: {
        who: "Robin Diaz, maintenance supervisor, Wide World Importers",
        wants: "6000, lock nuts, first thing tomorrow",
        callback: "+14255550184",
        score: "hot 7 of 8",
        partial: false,
        merged: false,
        owner: "Dana Brooks",
        due: "Thursday 9 AM",
      },
      page: "no_cover: On-call cover ends at 9 PM, so it goes to the morning queue",
      paged: null,
      nonSales: null,
      teams: [
        "new → Dana Brooks, @Jordan Lee: HOT lead: Robin Diaz at Wide World Importers needs lock nuts (6,000, first thing tomorrow). Call back 425-555-0184 by Thursday 9 AM. Not paged: On-call cover ends at 9 PM, so it goes to the morning queue.",
      ],
      handoff: null,
      trail: [
        "call_created +•••••••••84",
        "route_decision Sales is closed until 8 AM tomorrow, so the assistant takes the details",
        "asked_for_person caller",
        "phone_confirmed +•••••••••84",
        "lead_saved lead-…",
        "page_decision no_cover: On-call cover ends at 9 PM, so it goes to the morning queue",
      ],
    },
  ],
};

/** The metrics panel after all six beats (the response-time median and SLA share are left out). */
const EXPECTED_STATS = {
  calls: 6,
  leadsCaptured: 4,
  qualifiedLeads: 4,
  qualifiedLeadRate: 1,
  routedLeads: 4,
  liveTransfers: 2,
  pagesStarted: 1,
  pagesConnected: 1,
  nonSalesCalls: 1,
  leadsByScore: { hot: 3, warm: 1 },
  duplicatesMerged: 0,
  nonSalesByKind: { "existing-customer": 1 },
  partialLeads: 0,
  outboxBacklog: 8,
};

const HANDING_OFF = new Set(["paging", "transferring"]);
const pageWindowMs = (ctx) => ctx.health?.leadCapture?.pageWindowMs ?? 6000;
// Lead ids are new on every run.
const noIds = (text) => (text == null ? null : String(text).replace(/\blead-[0-9a-f]{8}\b/g, "lead-…"));

await rehearse({
  port: 8293,
  env: SIMULATION,
  liveEnv: LIVE,
  // A server answering real calls never forgets a lead or reorders the rotation, either.
  liveRefused: [["/api/demo/restore", { phones: ["+14255550193"] }]],
  // public/app.js startBody(): the beat's caller ID, or a withheld number.
  startBody: (step) => {
    const phone = "fromPhone" in step ? (step.fromPhone ?? "") : "";
    return step.scenario ? { fromPhone: phone || null, scenario: step.scenario } : { fromPhone: phone || null };
  },
  // public/app.js restore(): a beat forgets its caller's earlier lead and lines up its rep.
  hooks: (ctx) => ({ restore: (caller) => ctx.post("/api/demo/restore", caller) }),
  // public/app.js perform(): a new call first lets a page or a transfer in flight land.
  busy: (snapshot) => HANDING_OFF.has(snapshot.state),
  settleMs: (ctx) => pageWindowMs(ctx) + 3000,
  actions: (ctx) => ({
    // awaitHandoff(): the on-call rep's Teams rings for the page window, then the call is handed over.
    awaitHandoff: () => ctx.settle({ ms: pageWindowMs(ctx) + 4000 }),
    // showMetrics(): the call finishes, then the numbers.
    metrics: async () => {
      for (let i = 0; i < 30 && !ctx.session.finished; i += 1) await ctx.sleep(100);
      return ctx.get("/api/stats");
    },
  }),
  outcome: ({ calls }) =>
    calls.map(({ snapshot: s, events }) => ({
      state: s?.state ?? null,
      caller: s?.maskedPhone ?? null,
      outcome: s?.outcome ?? null,
      route: s?.routeDecision ? `${s.routeDecision.action}: ${s.routeDecision.reason}` : null,
      lead: s?.lead
        ? {
            who: [s.draft?.name, s.draft?.role, s.draft?.company].filter(Boolean).join(", "),
            wants: [s.draft?.quantity, s.draft?.productInterest, s.draft?.timeline].filter(Boolean).join(", "),
            callback: s.draft?.callbackPhone ?? null,
            score: `${s.lead.score} ${s.lead.points} of ${s.qualification?.maxPoints ?? "?"}`,
            partial: Boolean(s.lead.partial),
            merged: Boolean(s.duplicateOf),
            owner: s.lead.ownerName ?? null,
            due: s.followUp?.dueLabel ?? null,
          }
        : null,
      page: s?.pageDecision ? `${s.pageDecision.code}: ${s.pageDecision.reason}` : null,
      paged: s?.page ? `${s.onCallRep?.displayName ?? "?"} ${s.page}` : null,
      nonSales: s?.nonSales?.kind ?? null,
      teams: (s?.lead?.messages ?? [])
        .filter((m) => m.channel === "teams")
        .map((m) => `${m.kind} → ${m.toName}${m.mentionManager ? `, @${m.managerName}` : ""}: ${noIds(m.body)}`),
      handoff: s?.handoff ? { topic: s.handoff.callTopic, routeId: s.handoff.routeId, context: noIds(s.handoff.callContext) } : null,
      trail: trail(events).map(noIds),
    })),
  expected: EXPECTED,
  stats: ({ medianTimeToFirstResponseMs, contactedWithinSlaShare, ...counts }) => counts,
  expectedStats: EXPECTED_STATS,
});
