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
 * console's callers, start body, step wrapper and record restore in
 * public/app.js, and what each beat should leave on screen.
 *
 * Changed a beat, the policy or the fixtures on purpose? The run prints the
 * outcomes it reached. Check each against DEMO-SCRIPT.md, then paste them over
 * EXPECTED below.
 */
import { rehearse, trail } from "./presenter-kit-rehearsal.mjs";

// The shipped settings, with the demo CRM in memory instead of ./data/crm.db.
const SIMULATION = { CRM_DB_PATH: ":memory:" };

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
  { id: "alex-teams", body: { repId: "rep-alex" } },
  { id: "alex-mobile", body: { fromPhone: "+14255550197" } },
  { id: "jordan-teams", body: { repId: "rep-jordan" } },
  { id: "unknown", body: { fromPhone: "+14255550188" } },
];

// public/app.js TERMINAL: a call in one of these states is over.
const TERMINAL = new Set(["refused", "transferred", "ended"]);

/** What each beat leaves on screen, call by call: no ids, no times. */
const EXPECTED = {
  "Verified before anything is read": [
    {
      state: "briefing",
      rep: "Alex Morgan · pstn-pin",
      checks: [
        "Caller: Registered mobile, number ending 0197 (ok)",
        "PIN: Correct (ok)",
        "Record access: Fabrikam — Alex's own account (ok)",
        "Contact details: Read out on request: Dana Ruiz · number (ok)",
      ],
      record: {
        account: "Fabrikam · Seattle · Strategic · Your account",
        contact: "Dana Ruiz, VP of Operations · 206 555 0120",
        deals: [
          "Enterprise renewal · Negotiation · 250000 · closes 2026-06-30 · Security questionnaire",
          "Renewal services add-on · Proposal · 42000 · closes 2026-07-10 · Scope services",
          "Analytics expansion · Proposal · 80000 · closes 2026-08-18 · Technical validation",
        ],
        lastTouch: "call · Pilot rollout · 2026-05-02",
        due: ["send the security questionnaire · 2026-06-10"],
        withheld: ["Credit limit and payment terms — Sales Operations only"],
      },
      proposal: null,
      write: null,
      refused: null,
      handoff: null,
      said: "Dana Ruiz's number is 206 555 0120.",
      outcome: null,
      trail: [
        "call_created simulation",
        "pin_requested number ending 0197",
        "verified mobile + PIN",
        "briefing Fabrikam",
        "contact_lookup Dana Ruiz · number",
      ],
    },
  ],
  "Read back, a yes, then the undo window": [
    {
      state: "committed",
      rep: "Alex Morgan · teams-user",
      checks: [
        "Caller: Teams sign-in — Alex Morgan (ok)",
        "PIN: Not needed — signed in to Teams (idle)",
        "Record access: Fabrikam — Alex's own account (ok)",
        "Contact details: Withheld until asked for (idle)",
      ],
      record: {
        account: "Fabrikam · Seattle · Strategic · Your account",
        contact: "Dana Ruiz, VP of Operations · phone withheld",
        deals: [
          "Enterprise renewal · Closed Won · 240000 · closes 2026-06-15 · Pending signature",
          "Renewal services add-on · Proposal · 42000 · closes 2026-07-10 · Scope services",
          "Analytics expansion · Proposal · 80000 · closes 2026-08-18 · Technical validation",
        ],
        lastTouch: "meeting · Fabrikam meeting · 2026-06-10",
        due: ["send the security questionnaire · 2026-06-10"],
        withheld: ["Credit limit and payment terms — Sales Operations only"],
      },
      proposal: null,
      write: {
        status: "committed",
        account: "Fabrikam",
        rows: [
          "New meeting: Fabrikam meeting · Wed, Jun 10",
          "Enterprise renewal · stage: Negotiation → Closed Won",
          "Enterprise renewal · amount: $250,000 → $240,000",
          "Enterprise renewal · close date: Tue, Jun 30 → Mon, Jun 15",
          "Enterprise renewal · next step: Security questionnaire → Pending signature",
          "New task: send the contract · due Fri, Jun 12",
        ],
        auditRows: 12,
      },
      refused: null,
      handoff: null,
      said: "Saved to Fabrikam's record.",
      outcome: null,
      trail: [
        "call_created simulation",
        "verified Teams sign-in",
        "proposal 6 changes",
        "commit_pending 6s undo window",
        "commit 12 audit rows",
      ],
    },
  ],
  "“Wait — keep the old number”": [
    {
      state: "listening",
      rep: "Alex Morgan · teams-user",
      checks: [
        "Caller: Teams sign-in — Alex Morgan (ok)",
        "PIN: Not needed — signed in to Teams (idle)",
        "Record access: Fabrikam — Alex's own account (ok)",
        "Contact details: Withheld until asked for (idle)",
      ],
      record: {
        account: "Fabrikam · Seattle · Strategic · Your account",
        contact: "Dana Ruiz, VP of Operations · phone withheld",
        deals: [
          "Enterprise renewal · Negotiation · 250000 · closes 2026-06-30 · Security questionnaire",
          "Renewal services add-on · Proposal · 42000 · closes 2026-07-10 · Scope services",
          "Analytics expansion · Proposal · 80000 · closes 2026-08-18 · Technical validation",
        ],
        lastTouch: "call · Pilot rollout · 2026-05-02",
        due: ["send the security questionnaire · 2026-06-10"],
        withheld: ["Credit limit and payment terms — Sales Operations only"],
      },
      proposal: null,
      write: {
        status: "cancelled",
        account: "Fabrikam",
        rows: ["Dana Ruiz · phone number: ending 0120 → 425 555 0143"],
        auditRows: 0,
      },
      refused: null,
      handoff: null,
      said: "Stopped. Nothing was written: Dana Ruiz's number is still the one ending 0120.",
      outcome: null,
      trail: [
        "call_created simulation",
        "verified Teams sign-in",
        "proposal 1 change",
        "commit_pending 6s undo window",
        "commit_cancelled nothing written",
      ],
    },
  ],
  "Not mine to change": [
    {
      state: "transferred",
      rep: "Alex Morgan · teams-user",
      checks: [
        "Caller: Teams sign-in — Alex Morgan (ok)",
        "PIN: Not needed — signed in to Teams (idle)",
        "Record access: Fabrikam — Alex's own account (ok)",
        "Contact details: Withheld until asked for (idle)",
      ],
      record: {
        account: "Fabrikam · Seattle · Strategic · Your account",
        contact: "Dana Ruiz, VP of Operations · phone withheld",
        deals: [
          "Enterprise renewal · Negotiation · 250000 · closes 2026-06-30 · Security questionnaire",
          "Renewal services add-on · Proposal · 42000 · closes 2026-07-10 · Scope services",
          "Analytics expansion · Proposal · 80000 · closes 2026-08-18 · Technical validation",
        ],
        lastTouch: "call · Pilot rollout · 2026-05-02",
        due: ["send the security questionnaire · 2026-06-10"],
        withheld: ["Credit limit and payment terms — Sales Operations only"],
      },
      proposal: null,
      write: null,
      refused: [
        "the credit limit: Not on the phone allow-list",
        "the payment terms: Not on the phone allow-list",
      ],
      handoff: {
        to: "Contoso Sales Operations",
        route: "sales-operations",
        reason: "refused_by_policy",
        topic: "Fabrikam – credit limit, payment terms",
        context: {
          rep: "Alex Morgan",
          verifiedBy: "Teams sign-in",
          account: "Fabrikam",
          reason: "refused_by_policy",
          request: "Raise Fabrikam's credit limit to 500k and move them to net 60 payment terms.",
          refusedRequests: ["credit limit", "payment terms"],
          proposal: null,
          lastWrite: null,
          draftId: null,
        },
        headers: [
          "CallDetails.SessionId",
          "CallDetails.CallTopic",
          "CallDetails.CallContext",
          "CallDetails.RouteId",
        ],
      },
      said: "Putting you through to Contoso Sales Operations with the details.",
      outcome: "transferred:refused_by_policy",
      trail: [
        "call_created simulation",
        "verified Teams sign-in",
        "refused_write account.creditLimit",
        "refused_write account.paymentTerms",
        "policy_refusal the credit limit and the payment terms",
        "transfer refused by policy → Contoso Sales Operations",
      ],
    },
  ],
  "Can't verify, won't disclose": [
    {
      state: "transferred",
      rep: null,
      checks: [
        "Caller: Registered mobile, number ending 0197 (ok)",
        "PIN: Wrong PIN — no records opened (err)",
        "Record access: Locked until verified (err)",
        "Contact details: Withheld (idle)",
      ],
      record: null,
      proposal: null,
      write: null,
      refused: null,
      handoff: {
        to: "Contoso Sales Operations",
        route: "sales-operations",
        reason: "verification_failed",
        topic: "Unverified caller – no records opened",
        context: {
          verified: false,
          reason: "verification_failed",
          callerId: "number ending 0197",
          check: "Caller ID matched Alex Morgan's registered mobile; PIN failed",
          note: "No records were opened or read out.",
        },
        headers: [
          "CallDetails.SessionId",
          "CallDetails.CallTopic",
          "CallDetails.CallContext",
          "CallDetails.RouteId",
        ],
      },
      said: "I couldn't verify you, so I can't open any records. I'll put you through to Contoso Sales Operations.",
      outcome: "transferred:verification_failed",
      trail: [
        "call_created simulation",
        "pin_requested number ending 0197",
        "verification_failed wrong PIN · no records opened",
        "transfer verification failed → Contoso Sales Operations",
      ],
    },
  ],
};

/** The metrics panel after all five beats (the average handle time varies, so it is left out). */
const EXPECTED_STATS = {
  calls: 5,
  lookups: 2,
  verifications: 4,
  verificationFailures: 1,
  confirmedWrites: 1,
  undoneWrites: 1,
  cancelledInWindow: 1,
  refusals: 1,
  handoffs: 2,
  failedTransfers: 0,
  briefings: 1,
  proposals: 2,
  confirmedCommits: 1,
  fieldsWrittenByEntity: {},
  undos: 0,
  draftsSaved: 0,
  draftsResumed: 0,
  refusedWritesByField: { "account.creditLimit": 1, "account.paymentTerms": 1 },
  transfers: 2,
};

/** The audit ID and the seconds left in the undo window change from run to run. */
const STABLE = {
  commit: (detail) => detail.replace(/ · \S+$/, ""),
  commit_cancelled: (detail) => detail.replace(/^\S+ left · /, ""),
  undo: () => "audit",
};
const stable = (events) => events.map((e) => (STABLE[e.kind] ? { ...e, detail: STABLE[e.kind](String(e.detail ?? "")) } : e));

/** A write-back row: "field: before → after", or just the new value. */
const change = (row) => `${row.label}: ${row.before == null ? "" : `${row.before} → `}${row.after}`;

/** The record card, row by row (public/app.js renderRecord()), with dates as dates. */
function card(r) {
  if (!r) return null;
  const c = r.contact;
  return {
    account: [r.account.name, r.account.city, r.account.tier, r.account.relationship].filter(Boolean).join(" · "),
    contact: c ? [c.title ? `${c.name}, ${c.title}` : c.name, c.phone ?? "phone withheld", c.email].filter(Boolean).join(" · ") : null,
    deals: r.deals.map((d) => [d.name, d.stage, d.amount, d.closeDate && `closes ${d.closeDate}`, d.nextStep].filter(Boolean).join(" · ")),
    lastTouch: r.lastTouch ? [r.lastTouch.type, r.lastTouch.subject, r.lastTouch.date].join(" · ") : null,
    due: r.dueTasks.map((t) => `${t.subject} · ${t.overdue ? "overdue since " : ""}${t.dueDate}`),
    withheld: r.withheld,
  };
}

/** The context the Teams toast reads, with a saved draft's ID reduced to "saved". */
function context(raw) {
  try {
    const value = JSON.parse(raw);
    return value?.draftId ? { ...value, draftId: "saved" } : value;
  } catch {
    return raw ?? null;
  }
}

/**
 * public/app.js endActiveCall(): an open undo window or a transfer closes
 * first, for up to the window plus 3 s, then the call on screen hangs up.
 */
async function endActiveCall(ctx) {
  await ctx.settle();
  if (ctx.session.id && !ctx.session.finished && !ctx.session.followed) await ctx.sim.hangup().catch(() => {});
}

await rehearse({
  port: 8297,
  env: SIMULATION,
  liveEnv: LIVE,
  liveRefused: ["/api/demo/records"],
  // public/app.js startBody(): the beat's caller from the caller picker.
  startBody: (step) => ({ ...(CALLERS.find((c) => c.id === step.caller) ?? CALLERS[0]).body }),
  // public/app.js createCallSession(): the kit's default doesn't know "refused".
  isFinished: (state) => TERMINAL.has(String(state)),
  busy: (snapshot) => !TERMINAL.has(snapshot.state) && (Boolean(snapshot.pendingCommit) || snapshot.state === "transferring"),
  settleMs: ({ health }) => (health?.policy?.commitUndoMs ?? 6000) + 3000,
  // public/app.js perform(): a new call ends the one on screen first.
  perform: async (step, ctx) => {
    if (step.type === "start") await endActiveCall(ctx);
    return ctx.sim.perform(step);
  },
  // public/app.js restoreRecords(): the seeded Fabrikam record back, once the call on screen has ended.
  hooks: (ctx) => ({
    restoreRecords: async () => {
      await endActiveCall(ctx);
      await ctx.post("/api/demo/records");
    },
  }),
  actions: (ctx) => ({
    // public/app.js watchWindow(): the undo window runs out on the server, then the numbers.
    window: async () => {
      const deadline = Date.now() + (ctx.health?.policy?.commitUndoMs ?? 6000) + 3000;
      for (;;) {
        const snapshot = await ctx.snapshot();
        if (!snapshot?.pendingCommit || TERMINAL.has(snapshot.state) || Date.now() >= deadline) break;
        await ctx.sleep(100);
      }
      await ctx.sleep(250);
      return ctx.get("/api/stats");
    },
    // public/app.js showMetrics(): up to 3 s for the handoff to land, then the numbers.
    metrics: async () => {
      for (let i = 0; i < 30 && !ctx.session.finished; i += 1) await ctx.sleep(100);
      return ctx.get("/api/stats");
    },
  }),
  outcome: ({ calls }) =>
    calls.map(({ snapshot: s, events }) => {
      const w = s?.lastWrite;
      const h = s?.handoff;
      return {
        state: s?.state ?? null,
        rep: s?.rep ? `${s.rep.displayName} · ${s.rep.verifiedBy}` : null,
        checks: (s?.identity ?? []).map((c) => `${c.label}: ${c.detail} (${c.tone})`),
        record: card(s?.record),
        proposal: s?.proposal ? s.proposal.rows.map(change) : null,
        write: w ? { status: w.status, account: w.accountName, rows: (w.rows ?? []).map(change), auditRows: w.auditRows } : null,
        refused: s?.lastRefusal ? s.lastRefusal.items.map((i) => `${i.label}: ${i.detail}`) : null,
        handoff: h
          ? {
              to: h.target,
              route: h.routeId,
              reason: h.reason,
              topic: h.callTopic,
              context: context(h.callContext),
              headers: (h.voipHeaders ?? []).map((x) => x.key),
            }
          : null,
        said: s?.lastPhrase ?? null,
        outcome: s?.outcome ?? null,
        trail: trail(stable(events)),
      };
    }),
  expected: EXPECTED,
  stats: ({ averageHandleTimeSeconds, ...counts }) => counts,
  expectedStats: EXPECTED_STATS,
});
