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
 * console's start body, step wrapper and clock, feed and metrics steps in
 * public/app.js, and what each beat should leave on screen.
 *
 * Changed a beat, the bid sheet or the pricing policy on purpose? The run
 * prints the outcomes it reached. Check each against DEMO-SCRIPT.md, then
 * paste them over EXPECTED below.
 */
import { rehearse, trail } from "./presenter-kit-rehearsal.mjs";

// The shipped settings, with the audit log in memory instead of ./data/bid-price-lookup.db.
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
  "What's corn paying?": [
    {
      state: "ended",
      caller: "+•••••••••11",
      outcome: "caller_done",
      decision: "quote live",
      price: {
        said: "Soybeans at Riverside for November delivery are $10.11, that's 18 under November futures, as of 10:41 AM.",
        freshness: "live",
      },
      quotes: 2,
      clarifications: 0,
      handoff: null,
      callback: null,
      trail: [
        "call_created Simulated call from +•••••••••11",
        "quote Corn · Riverside · November — $4.12, live",
        "quote Soybeans · Riverside · November — $10.11, live",
      ],
    },
  ],
  "Not sure? Ask": [
    {
      state: "ended",
      caller: "anonymous",
      outcome: "caller_done",
      decision: "quote live",
      price: {
        said: "Corn at Riverbend for November delivery is $4.16, that's 31 under December futures, as of 10:42 AM.",
        freshness: "live",
      },
      quotes: 2,
      clarifications: 2,
      handoff: null,
      callback: null,
      trail: [
        "call_created Simulated call from anonymous",
        "clarification Asked which commodity at Fairview — none given",
        "quote Wheat · Fairview · September — $5.17, live",
        "clarification Asked which location — it matched Riverbend and Riverside",
        "quote Corn · Riverbend · November — $4.16, live",
      ],
    },
  ],
  "Stale price, honest caveat": [
    {
      state: "ended",
      caller: "anonymous",
      outcome: "caller_hung_up",
      decision: "quote close",
      price: {
        said: "As of the last close, soybeans at Riverside for November delivery were $10.05, that's 18 under November futures.",
        freshness: "close",
      },
      quotes: 3,
      clarifications: 0,
      handoff: null,
      callback: null,
      trail: [
        "call_created Simulated call from anonymous",
        "quote Soybeans · Riverside · November — $10.11, live",
        "requoted Re-checked before repeating — live → delayed",
        "quote Soybeans · Riverside · November — $10.11, delayed",
        "stale_caveat Futures are 39 min old — past the 20-minute window, so the agent must say the prices may be delayed.",
        "requoted Re-checked before repeating — delayed → close",
        "quote Soybeans · Riverside · November — $10.05, close",
        "close_price The futures market is closed, so the agent quotes the last settlement, not a live price.",
      ],
    },
  ],
  "Feed down: no number": [
    {
      state: "ended",
      caller: "+•••••••••12",
      outcome: "callback_requested:feed_outage",
      decision: "callback feed_outage",
      price: null,
      quotes: 0,
      clarifications: 0,
      handoff: null,
      callback: {
        to: "Lake Mills merchandiser",
        commodity: "wheat",
        reason: "feed_outage",
        whenOpen: false,
      },
      trail: [
        "call_created Simulated call from +•••••••••12",
        "feed_outage Price feed unavailable — no number quoted",
        "person_offered Offered the Lake Mills merchandiser now, or a callback",
        "callback_requested Lake Mills merchandiser · caller +•••••••••12 · Price feed was down — no price was quoted",
      ],
    },
  ],
  "Lock it in? A person": [
    {
      state: "transferred",
      caller: "+•••••••••11",
      outcome: "transferred:contract_request",
      decision: "transfer contract_request",
      price: {
        said: "Corn at Riverside for December delivery is $4.14, that's 33 under December futures, as of 10:42 AM.",
        freshness: "live",
      },
      quotes: 1,
      clarifications: 0,
      handoff: {
        to: "Riverside merchandiser",
        topic: "Lock a price: corn – Riverside",
        reason: "contract_request",
        context: "Last quote: Corn at Riverside for December delivery is $4.14, that's 33 under December futures, as of 10:42 AM. Caller said: “Corn at Riverside for December?”, then “Should I lock that in now, or wait?”, then “Okay, lock in 5,000 bushels at that price.” Reason: Caller wants to lock in or book a price.",
      },
      callback: null,
      trail: [
        "call_created Simulated call from +•••••••••11",
        "quote Corn · Riverside · December — $4.14, live",
        "advice_guard Asked for market advice — the agent never advises or predicts",
        "contract_guard Only a merchandiser can lock in or book a price — nothing was locked",
        "transfer_started To the Riverside merchandiser — Caller wants to lock in or book a price",
        "transfer_simulated Handed to Riverside merchandiser with the call context",
      ],
    },
  ],
};

/** The metrics panel after all five beats: every number in it is a count. */
const EXPECTED_STATS = {
  calls: 5,
  callsAutomated: 3,
  estimatedStaffMinutesSaved: 9,
  quotesGiven: 8,
  quotesByCommodity: { corn: 3, soybeans: 4, wheat: 1 },
  quotesByLocation: { fairview: 1, riverbend: 1, riverside: 6 },
  delayedQuotes: 1,
  closePriceQuotes: 1,
  clarifications: 2,
  feedOutages: 1,
  adviceDeclined: 1,
  contractsDeclined: 1,
  transfers: 1,
  callbacks: 1,
  transfersByReason: { contract_request: 1 },
  byOutcome: {
    "callback_requested:feed_outage": 1,
    caller_done: 2,
    caller_hung_up: 1,
    "transferred:contract_request": 1,
  },
};

await rehearse({
  port: 8294,
  env: SIMULATION,
  liveEnv: LIVE,
  // A server answering real calls prices on the real feed, too.
  liveRefused: [["/api/demo/feed", { up: false }]],
  // public/app.js startBody(): the beat's caller ID, or a withheld number.
  startBody: (step) => ({ fromPhone: ("fromPhone" in step ? (step.fromPhone ?? "") : "") || null }),
  // public/app.js perform(): a new call first lets a transfer in flight land, for up to 3 s.
  busy: (snapshot) => snapshot.state === "transferring",
  settleMs: 3000,
  // public/app.js setFeed(): every beat brings the price feed up before it answers.
  hooks: (ctx) => ({ setFeed: (up) => ctx.post("/api/demo/feed", { up }) }),
  actions: (ctx) => ({
    // public/app.js clockStep() and feedStep().
    clock: (step) => ctx.post("/api/demo/clock", { preset: step.preset }),
    feed: (step) => ctx.post("/api/demo/feed", { up: step.up !== false }),
    // public/app.js showMetrics(): the numbers once the call on screen has finished.
    metrics: async () => {
      for (let i = 0; i < 30 && !ctx.session.finished; i += 1) await ctx.sleep(100);
      return ctx.get("/api/stats");
    },
  }),
  outcome: ({ calls }) =>
    calls.map(({ snapshot: s, events }) => {
      const q = s?.lastQuote;
      const h = s?.handoff;
      const cb = s?.callback;
      return {
        state: s?.state ?? null,
        caller: s?.maskedPhone ?? null,
        outcome: s?.outcome ?? null,
        decision: s?.decision ? [s.decision.kind, s.decision.reason].filter(Boolean).join(" ") : null,
        // The price card: the sentence the agent read for the last quote, and its badge.
        price: q ? { said: q.phrase, freshness: q.freshness } : null,
        quotes: s?.quotes ?? 0,
        clarifications: s?.clarifications ?? 0,
        // The merchandiser's Teams toast, or the callback card.
        handoff: h ? { to: h.queue, topic: h.callTopic, reason: h.reason, context: h.callContext } : null,
        callback: cb ? { to: cb.queue, commodity: cb.commodity, reason: cb.reason, whenOpen: cb.whenOpen } : null,
        trail: trail(events),
      };
    }),
  expected: EXPECTED,
  stats: (counts) => counts,
  expectedStats: EXPECTED_STATS,
});
