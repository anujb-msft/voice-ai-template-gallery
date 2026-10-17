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
 * console's start body, step wrapper, demo clock and demo actions in
 * public/app.js, and what each beat should leave on screen.
 *
 * Changed a beat, the rotation or the paging policy on purpose? The run prints
 * the outcomes it reached. Check each against DEMO-SCRIPT.md, then paste them
 * over EXPECTED below.
 */
import { rehearse, trail } from "./presenter-kit-rehearsal.mjs";

// The shipped settings, with the audit log in memory instead of ./data/pager.db.
const SIMULATION = { DB_PATH: ":memory:" };

// Enough for /health to report a live server. Nothing is called: ACS and Voice
// Live clients are created on the first real call, .invalid never resolves,
// and with no incidents on file the scheduler has nobody to page.
const LIVE = {
  ACS_ENDPOINT: "https://rehearsal.invalid",
  ACS_OUTBOUND_CALLER_ID: "+15550100",
  PUBLIC_BASE_URL: "https://rehearsal.invalid",
  VOICE_LIVE_ENDPOINT: "https://rehearsal.invalid",
};

/** What each beat leaves on screen, call by call: no ids, no times. */
const EXPECTED = {
  "Leak at midnight": [
    {
      state: "closed",
      caller: "Alice Rivera",
      where: "Maple Court, unit 4B",
      severity: "urgent",
      rule: "urgent:active_leak:ceiling",
      onCall: {
        chain: "Morgan Lee → Priya Shah → Evelyn Park",
        why: "Central rotation since Mon, Sep 28",
      },
      pages: ["Morgan Lee · primary · attempt 1 · accept"],
      next: null,
      opsAlert: "canceled — acknowledged",
      acknowledgedBy: "Morgan Lee",
      bridged: false,
      followUp: null,
      cards: ["Active leak · Maple Court 4B — urgent, may enter"],
      voicemail: null,
      said: [
        "Contoso Property Management maintenance line. I'm an automated assistant. If anyone is in danger, or you smell gas or see fire, hang up and call 911 now. Otherwise, what's the problem?",
        "Understood — an active leak. Is this about unit 4B at Maple Court?",
        "Is the number ending 0101 the best one to call you back on?",
        "I'm contacting the on-call technician now. You'll get a call back when they have it. If you can do so safely, shut off the nearest water valve while we contact the technician.",
        "→ Morgan: This is the Contoso Property Management pager, an automated assistant, with an urgent page for Morgan Lee.",
        "→ Morgan: Urgent: active leak at Maple Court, unit 4B, reported …. Tenant said: Water is pouring through my kitchen ceiling and it's spreading fast. You may enter. Access: The spare key is in the lockbox by the back door. Press 1 or say 'I've got it' to accept.",
        "→ Morgan: Thanks, Morgan. I'll tell the tenant you have it. The access details are on your Teams card.",
        "→ Alice: A technician has your request and will call you shortly.",
      ],
      toasts: [],
      trail: [
        "call_answered Simulated tenant call",
        "caller_matched Caller ID •••-0101 is on the lease for Maple Court 4B",
        "context_captured what · tenant's words",
        "unit_confirmed Maple Court 4B (caller ID, confirmed)",
        "context_captured may enter · access notes",
        "callback_confirmed Callback •••-0101 — the number is never read aloud or shown",
        "incident_created urgent · urgent:active_leak:ceiling · reference ####",
        "page_scheduled Urgent — page the on-call primary now",
        "technician_card_sent Teams card to Morgan Lee — property, unit, issue and access; no phone numbers",
        "page_ringing Morgan Lee · primary · attempt 1 of 2",
        "page_answered Morgan Lee picked up — the brief is read aloud (≈18 s)",
        "page_accepted Morgan Lee has it — … after the report",
        "status_call_sent Acknowledged — tenant called back on •••-0101",
        "incident_closed Tenant told a technician has it",
      ],
    },
  ],
  "Nobody answers": [
    {
      state: "closed",
      caller: "Dee Nguyen",
      where: "Pine Terrace, unit 11",
      severity: "urgent",
      rule: "urgent:no_heat:52F",
      onCall: {
        chain: "Omar Diaz → Priya Shah → Sam Wilson",
        why: "North rotation since Mon, Sep 28",
      },
      pages: [
        "Omar Diaz · primary · attempt 1 · no-answer",
        "Omar Diaz · primary · attempt 2 · no-answer",
        "Priya Shah · secondary · attempt 1 · accept · escalated from primary",
      ],
      next: null,
      opsAlert: "canceled — acknowledged",
      acknowledgedBy: "Priya Shah",
      bridged: false,
      followUp: null,
      cards: [
        "No heat · Pine Terrace 11 — urgent, may enter",
        "No heat · Pine Terrace 11 — urgent, may enter, attempt 2 of 2 — No answer from Omar Diaz",
        "No heat · Pine Terrace 11 — urgent, may enter, escalated · secondary — Omar Diaz didn't answer 2 attempts",
      ],
      voicemail: null,
      said: [
        "Contoso Property Management maintenance line. I'm an automated assistant. If anyone is in danger, or you smell gas or see fire, hang up and call 911 now. Otherwise, what's the problem?",
        "Understood — no heat. Is the number ending 0103 the best one to call you back on?",
        "I'm contacting the on-call technician now. You'll get a call back when they have it. Please avoid unsafe heating sources such as ovens or outdoor heaters indoors.",
        "→ Priya: This is the Contoso Property Management pager, an automated assistant, with an urgent page for Priya Shah.",
        "→ Priya: Urgent: no heat at Pine Terrace, unit 11, 52 degrees inside, reported …. Tenant said: The heat is out and it's 52 degrees in here. You may enter. Press 1 or say 'I've got it' to accept.",
        "→ Priya: Thanks, Priya. I'll tell the tenant you have it. The access details are on your Teams card.",
        "→ Dee: A technician has your request and will call you shortly.",
      ],
      toasts: [],
      trail: [
        "call_answered Simulated tenant call",
        "caller_matched Caller ID •••-0103 is on the lease for Pine Terrace 11",
        "unit_confirmed Pine Terrace 11 (caller ID, confirmed)",
        "context_captured what · tenant's words · 52°F inside · may enter",
        "callback_confirmed Callback •••-0103 — the number is never read aloud or shown",
        "incident_created urgent · urgent:no_heat:52F · reference ####",
        "page_scheduled Urgent — page the on-call primary now",
        "technician_card_sent Teams card to Omar Diaz — property, unit, issue and access; no phone numbers",
        "page_ringing Omar Diaz · primary · attempt 1 of 2",
        "page_no_answer Omar Diaz · primary · attempt 1 of 2",
        "retry_pending No answer from Omar Diaz. Paging the primary again (attempt 2 of 2) in 3 min — the urgent gap.",
        "technician_card_sent Teams card to Omar Diaz — property, unit, issue and access; no phone numbers",
        "page_ringing Omar Diaz · primary · attempt 2 of 2",
        "page_no_answer Omar Diaz · primary · attempt 2 of 2",
        "escalation_pending Omar Diaz didn't answer 2 attempts. Escalating to the secondary, Priya Shah, in 3 min.",
        "technician_card_sent Teams card to Priya Shah — property, unit, issue and access; no phone numbers",
        "page_ringing Priya Shah · secondary · attempt 1 of 2",
        "page_answered Priya Shah picked up — the brief is read aloud (≈15 s)",
        "page_accepted Priya Shah has it — … after the report",
        "status_call_sent Acknowledged — tenant called back on •••-0103",
        "incident_closed Tenant told a technician has it",
      ],
    },
  ],
  "Voicemail keeps it private": [
    {
      state: "paging",
      caller: "Ben Carter",
      where: "Maple Court, unit 2A",
      severity: "urgent",
      rule: "urgent:lockout:locked out",
      onCall: {
        chain: "Priya Shah → Morgan Lee → Evelyn Park",
        why: "Swap override for Thu, Oct 1 — replaces the central rotation",
      },
      pages: ["Priya Shah · primary · attempt 1 · voicemail"],
      next: "Priya Shah · primary · attempt 2 of 2",
      opsAlert: "at … unless someone acknowledges",
      acknowledgedBy: null,
      bridged: false,
      followUp: null,
      cards: [
        "Lockout · Maple Court 2A — urgent, no entry — Covering: Swap override for Thu, Oct 1",
      ],
      voicemail: {
        to: "Priya Shah",
        heard: "Contoso maintenance has an urgent page for you. Please call the maintenance line. Reference # # # #.",
        check: "Left out: property, unit, problem, tenant's words, access details, phone numbers",
      },
      said: [
        "Contoso Property Management maintenance line. I'm an automated assistant. If anyone is in danger, or you smell gas or see fire, hang up and call 911 now. Otherwise, what's the problem?",
        "Understood — you're locked out. Is this about unit 2A at Maple Court?",
        "Is the number ending 0102 the best one to call you back on?",
        "I'm contacting the on-call technician now. You'll get a call back when they have it. Please wait in a safe, well-lit place while we contact the technician.",
        "→ voicemail: Contoso maintenance has an urgent page for you. Please call the maintenance line. Reference # # # #.",
      ],
      toasts: [],
      trail: [
        "call_answered Simulated tenant call",
        "caller_matched Caller ID •••-0102 is on the lease for Maple Court 2A",
        "context_captured what · tenant's words",
        "unit_confirmed Maple Court 2A (caller ID, confirmed)",
        "context_captured access notes",
        "callback_confirmed Callback •••-0102 — the number is never read aloud or shown",
        "incident_created urgent · urgent:lockout:locked out · reference ####",
        "page_scheduled Urgent — page the on-call primary now",
        "technician_card_sent Teams card to Priya Shah — property, unit, issue and access; no phone numbers",
        "page_ringing Priya Shah · primary · attempt 1 of 2",
        "voicemail_prompt Safe prompt only — reference ####; no property, unit, problem or tenant details",
        "retry_pending Priya Shah's voicemail got the safe prompt only. Paging the primary again (attempt 2 of 2) in 3 min — the urgent gap.",
      ],
    },
  ],
  "Not worth waking anyone": [
    {
      state: "work-order",
      caller: "Grace Kim",
      where: "Pine Terrace, unit 7",
      severity: "routine",
      rule: "routine:no_heat_above_threshold:64F",
      onCall: null,
      pages: [],
      next: null,
      opsAlert: null,
      acknowledgedBy: null,
      bridged: false,
      followUp: "the office, Monday morning",
      cards: [],
      voicemail: null,
      said: [
        "Contoso Property Management maintenance line. I'm an automated assistant. If anyone is in danger, or you smell gas or see fire, hang up and call 911 now. Otherwise, what's the problem?",
        "Understood — no heat. Is this about unit 7 at Pine Terrace?",
        "Is the number ending 0104 the best one to call you back on?",
        "This isn't urgent enough to page the on-call technician, so I've logged a work order for the office. They'll follow up Monday morning. If it drops to 55 degrees or below inside, call us back and we'll page the on-call technician.",
      ],
      toasts: [],
      trail: [
        "call_answered Simulated tenant call",
        "caller_matched Caller ID •••-0104 is on the lease for Pine Terrace 7",
        "context_captured what · tenant's words · 64°F inside",
        "unit_confirmed Pine Terrace 7 (caller ID, confirmed)",
        "context_captured may enter · access notes",
        "callback_confirmed Callback •••-0104 — the number is never read aloud or shown",
        "incident_created routine · routine:no_heat_above_threshold:64F · reference ####",
        "work_order_logged No page — 64°F inside is above the 55°F no-heat line — routine, a work order instead of a page.",
      ],
    },
  ],
  "Questions, not phone numbers": [
    {
      state: "closed",
      caller: "Ben Carter",
      where: "Maple Court, unit 2A",
      severity: "urgent",
      rule: "urgent:no_power:no power",
      onCall: {
        chain: "Morgan Lee → Priya Shah → Evelyn Park",
        why: "Central rotation since Mon, Sep 28",
      },
      pages: ["Morgan Lee · primary · attempt 1 · bridge"],
      next: null,
      opsAlert: "canceled — acknowledged",
      acknowledgedBy: "Morgan Lee",
      bridged: true,
      followUp: null,
      cards: ["No power · Maple Court 2A — urgent, may enter"],
      voicemail: null,
      said: [
        "Contoso Property Management maintenance line. I'm an automated assistant. If anyone is in danger, or you smell gas or see fire, hang up and call 911 now. Otherwise, what's the problem?",
        "Understood — no power. I'm contacting the on-call technician now. You'll get a call back when they have it. If you see sparks or smell smoke, call 911 immediately.",
        "→ Morgan: This is the Contoso Property Management pager, an automated assistant, with an urgent page for Morgan Lee.",
        "→ Morgan: Urgent: no power at Maple Court, unit 2A, reported …. Tenant said: No power since the storm. You may enter. Press 1 or say 'I've got it' to accept.",
        "→ Morgan: I can't share phone numbers. Press 3 and I'll connect you to the tenant.",
        "→ Morgan: Connecting you to Ben now — neither of you will see the other's number.",
      ],
      toasts: [],
      trail: [
        "call_answered Simulated tenant call",
        "caller_matched Caller ID •••-0102 is on the lease for Maple Court 2A",
        "unit_confirmed Maple Court 2A (caller ID, confirmed)",
        "context_captured what · tenant's words · may enter",
        "callback_confirmed Callback •••-0102 — the number is never read aloud or shown",
        "incident_created urgent · urgent:no_power:no power · reference ####",
        "page_scheduled Urgent — page the on-call primary now",
        "technician_card_sent Teams card to Morgan Lee — property, unit, issue and access; no phone numbers",
        "page_ringing Morgan Lee · primary · attempt 1 of 2",
        "page_answered Morgan Lee picked up — the brief is read aloud (≈12 s)",
        "number_request_guarded Phone numbers stay server-side — offered the bridge (press 3) instead",
        "bridge_created Tenant added to the technician's call — both numbers stay server-side",
        "page_accepted Morgan Lee has it — … after the report",
        "incident_closed Technician and tenant are talking",
      ],
    },
  ],
};

/**
 * The metrics panel after all five beats (how long acknowledgements and
 * escalations took depends on the pace, so those are left out).
 */
const EXPECTED_STATS = {
  incidents: 5,
  bySeverity: { urgent: 4, routine: 1 },
  pages: 6,
  acknowledgements: 3,
  escalations: 1,
  noAnswers: 2,
  voicemails: 1,
  declines: 0,
  workOrders: 1,
  successfulContacts: 0.75,
  pagesPerIncident: 1.2,
  pagesPerPagedIncident: 1.5,
  unacknowledgedIncidents: 0,
  duplicatesAttached: 0,
  routineWorkOrdersLogged: 1,
  pendingJobs: 0,
  pageAttempts: 6,
};

// public/app.js TERMINAL: the states that end a call on screen.
const TERMINAL = new Set(["closed", "work-order", "duplicate", "ended", "cancelled", "exhausted"]);

// public/app.js CALLERS: the caller picker starts on Alice Rivera.
const ALICE = "+12065550101";

// Incident references are random, and the time of the report and how long an
// acknowledgement took depend on the pace, so what the agent said, the
// voicemail and the trail keep the words and drop those. A reference keeps its
// shape: four digits, read one at a time on voicemail.
const scrub = (line) =>
  String(line ?? "")
    .replace(/\b(reference) (\d \d \d \d|\d{4})\b/gi, (_, word, digits) => `${word} ${digits.replace(/\d/g, "#")}`)
    .replace(/\b\d+:\d{2} after the report\b/g, "… after the report")
    .replace(/\breported \d{1,2}:\d{2}\s[AP]M\b/g, "reported …");

const lowerFirst = (text) => String(text ?? "").replace(/^./, (c) => c.toLowerCase());

/** public/app.js renderFactsPanel(): the ops alert row, without its time. */
function opsAlert(s) {
  if (!s.incident) return null;
  if (s.incident.acknowledgedAt) return "canceled — acknowledged";
  if (s.state === "cancelled") return "canceled — the demo call ended";
  return s.alertAt ? "at … unless someone acknowledges" : null;
}

/** public/app.js renderChecksPanel(): what voicemail was spared, unless something leaked. */
function voicemailCheck(vm) {
  const items = vm.withheld ?? [];
  const leaked = items.filter((w) => !w.withheld);
  return leaked.length
    ? `Included: ${leaked.map((w) => lowerFirst(w.label)).join(", ")}`
    : `Left out: ${items.map((w) => lowerFirst(w.label)).join(", ")}`;
}

/**
 * public/app.js renderHandoff(): the technician's card for each page, from the
 * hub — its topic, its tags and the line under them (not its reference).
 */
function cards(frames, levels) {
  const shown = [];
  let last = null;
  for (const { target, payload: h } of frames) {
    if (target !== "handoff") continue;
    const inc = h.incident ?? {};
    const key = `${inc.id}|${h.level}|${h.attempt}`;
    if (key === last) continue;
    last = key;
    const first = h.level === levels[0] && h.attempt === 1;
    const note = first
      ? /override/i.test(h.why ?? "")
        ? `Covering: ${String(h.why).split(" — ")[0]}`
        : ""
      : String(h.reason ?? "").split(". ")[0];
    const tags = [
      inc.severity,
      inc.permissionToEnter ? "may enter" : "no entry",
      !first && (h.attempt === 1 ? `escalated · ${h.levelLabel}` : `attempt ${h.attempt} of ${h.attemptsPerLevel}`),
    ].filter(Boolean);
    shown.push([h.topic, tags.join(", "), note].filter(Boolean).join(" — "));
  }
  return shown;
}

/**
 * public/app.js settleOpenCall(), before a new call and before a clock change:
 * a page due within 1.5 s goes out first (for up to 7 s, see `busy` and
 * `settleMs` below), then the call on screen is hung up, which cancels its
 * pending pages. A page minutes away on the demo clock is not waited for.
 */
async function settleOpenCall(ctx) {
  await ctx.settle();
  if (ctx.session.id && !ctx.session.finished && !ctx.session.followed) await ctx.sim.hangup().catch(() => {});
}

/** public/app.js applySnapshot(): a response that ends the call ends it on screen too. */
function applySnapshot(ctx, res) {
  if (res?.snapshot?.id === ctx.session.id && TERMINAL.has(res.snapshot.state)) ctx.session.end();
  return res;
}

await rehearse({
  port: 8295,
  env: SIMULATION,
  liveEnv: LIVE,
  liveRefused: [["/api/demo/clock/advance", { minutes: 3 }]],
  // public/app.js startBody(): the beat's caller ID (empty when withheld), else the caller picker.
  startBody: (step) => ({ fromPhone: ("fromPhone" in step ? (step.fromPhone ?? "") : ALICE) || null }),
  // public/app.js connectHub(): a page job with no call behind it publishes
  // under the incident id; the call's own frames already carry everything.
  hubFilter: (target, payload) => target !== "incident" && !String(payload?.callId ?? "").startsWith("inc_"),
  // public/app.js createCallSession(): a call the console didn't start (a real
  // one) is followed once nothing else is on screen.
  sessionOptions: { onFollow: () => {} },
  isFinished: (state) => TERMINAL.has(state),
  // public/app.js perform(): a new call first settles the one on screen.
  perform: async (step, ctx) => {
    if (step.type === "start") await settleOpenCall(ctx);
    return ctx.sim.perform(step);
  },
  busy: (snapshot) => !TERMINAL.has(snapshot.state) && snapshot.nextPage != null && snapshot.nextPage.dueInMs <= 1500,
  settleMs: 7000,
  // public/app.js pinClock(): each beat pins the demo clock, after settling the call on screen.
  hooks: (ctx) => ({
    setClock: async (preset) => {
      await settleOpenCall(ctx);
      await ctx.post("/api/demo/clock", { preset });
    },
  }),
  // public/app.js advanceClock(), leaveVoicemail() and showMetrics().
  actions: (ctx) => ({
    advance: async (step) =>
      applySnapshot(ctx, await ctx.post("/api/demo/clock/advance", { minutes: step.minutes ?? 3, callId: ctx.session.id ?? undefined })),
    voicemail: async () => {
      if (!ctx.session.id) throw new Error("Start a call first.");
      return applySnapshot(ctx, await ctx.post(`/api/simulate/${encodeURIComponent(ctx.session.id)}/voicemail`, {}));
    },
    metrics: async () => {
      for (let i = 0; i < 30 && !ctx.session.finished; i += 1) await ctx.sleep(100);
      return ctx.get("/api/stats");
    },
  }),
  // What each call leaves on screen: the decision and its facts (who is on call
  // and why, every page and how it ended, what comes next, the ops alert), the
  // technician's card for each page, the voicemail box, everything the agent
  // said (the brief included), any warning heed() toasts, and the decision trail.
  outcome: ({ calls, results, ctx }) =>
    calls.map(({ id, snapshot: s, events, frames }) => {
      const levels = ctx.health?.paging?.levels ?? [];
      const pages = Boolean(s?.classification) && s.classification.severity !== "routine" && s.state !== "duplicate";
      return {
        state: s?.state ?? null,
        caller: s?.caller?.name ?? null,
        where: s?.context?.where ?? null,
        severity: s?.classification?.severity ?? null,
        rule: s?.classification?.matchedRule ?? null,
        onCall:
          pages && s.onCall
            ? { chain: levels.map((level) => s.onCall[level]?.name).filter(Boolean).join(" → "), why: s.onCall.why }
            : null,
        pages: (s?.attempts ?? []).map((a) =>
          [a.contactName, a.levelLabel, `attempt ${a.attempt}`, a.outcome, a.escalatedFrom && `escalated from ${a.escalatedFrom}`]
            .filter(Boolean)
            .join(" · "),
        ),
        next: s?.nextPage
          ? `${s.nextPage.contactName} · ${s.nextPage.levelLabel} · attempt ${s.nextPage.attempt} of ${s.nextPage.attemptsPerLevel}`
          : null,
        opsAlert: pages ? opsAlert(s) : null,
        acknowledgedBy: s?.incident?.acknowledgedBy ?? null,
        bridged: Boolean(s?.incident?.bridgeRequested),
        followUp: s?.workOrder ? `the office, ${s.workOrder.followUp}` : null,
        cards: cards(frames, levels),
        voicemail: s?.voicemail
          ? { to: s.voicemail.contactName, heard: scrub(s.voicemail.prompt), check: voicemailCheck(s.voicemail) }
          : null,
        said: (s?.transcript ?? [])
          .filter((line) => line.role === "agent")
          .map((line) => `${line.label ? `${line.label.replace(/^Agent /, "")}: ` : ""}${scrub(line.text)}`),
        toasts: results.filter((r) => r?.snapshot?.id === id && r.result?.ignored && r.result.note).map((r) => r.result.note),
        trail: trail(events).map(scrub),
      };
    }),
  expected: EXPECTED,
  stats: ({ medianSecondsToAcknowledge, medianMsToAcknowledge, p90MsToAcknowledge, medianEscalationMs, ...counts }) => counts,
  expectedStats: EXPECTED_STATS,
});
