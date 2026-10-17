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
 * Changed a beat, a city rule or an article on purpose? The run prints the
 * outcomes it reached. Check each against DEMO-SCRIPT.md, then paste them over
 * EXPECTED below.
 */
import { rehearse, trail } from "./presenter-kit-rehearsal.mjs";

// The shipped settings, with service requests and the audit log in memory
// instead of ./data/311-service.db.
const SIMULATION = { DB_PATH: ":memory:" };

// Enough for /health to report a live server. Nothing is called: ACS and Voice
// Live clients are created on the first real call, there is no SMS sender
// without ACS_SMS_FROM, and .invalid never resolves.
const LIVE = {
  ACS_ENDPOINT: "https://rehearsal.invalid",
  PUBLIC_BASE_URL: "https://rehearsal.invalid",
  VOICE_LIVE_ENDPOINT: "https://rehearsal.invalid",
};

/** What each beat leaves on screen, call by call: no ids, no times. */
const EXPECTED = {
  "Report a pothole": [
    {
      state: "ended",
      outcome: "completed",
      caller: "***-0142",
      language: "en-US · en-US-Ava:DragonHDLatestNeural",
      decisions: [
        "Location verified, reading it back — read back, waiting for a yes",
        "Service request SR-26-0193 created — filed after a confirmed location",
        "Confirmation text (simulated, not sent) — with consent · simulated",
      ],
      emergency: null,
      request: {
        case: "SR-26-0193",
        category: "pothole",
        department: "Public Works",
        location: "Oak Avenue at 5th Street",
        zone: "B",
        priority: "standard",
        target: "5 business days",
        due: "2026-10-07",
        status: "open",
        callers: 1,
        language: "en-US",
        onThisCall: 1,
      },
      complaint: null,
      sources: [],
      texts: [
        "simulated · en-US · City of Contoso 311: your pothole report at Oak Avenue and 5th Street is case SR-26-0193. Track it at https://contoso.example/311/SR-26-0193. Reply STOP to opt out.",
      ],
      handoff: null,
      trail: [
        "call_created simulated",
        "request_started pothole",
        "field_set size",
        "location_resolved Oak Avenue at 5th Street",
        "location_confirmed Oak Avenue at 5th Street",
        "case_created SR-26-0193",
        "contact_set updates",
        "sms_simulated case SR-26-0193",
        "call_ended completed",
      ],
    },
  ],
  "I smell gas": [
    {
      state: "ended",
      outcome: "emergency:gas",
      caller: "***-0118",
      language: "en-US · en-US-Ava:DragonHDLatestNeural",
      decisions: ["Emergency rule fired — emergency → no report, no questions"],
      emergency: { heard: "smell gas", category: "Gas leak", sentTo: "gas utility at 555-0109" },
      request: null,
      complaint: null,
      sources: [],
      texts: [],
      handoff: null,
      trail: ["call_created simulated", "emergency_redirect gas", "call_ended emergency:gas"],
    },
  ],
  "Same service in Spanish": [
    {
      state: "ended",
      outcome: "completed",
      caller: "***-0187",
      language: "es-US · es-US-PalomaNeural",
      decisions: [
        "Caller switched to Spanish — same rules, in Spanish",
        "Bulk pickup SR-… scheduled — scheduled from the zone calendar",
        "Confirmation text (simulated, not sent) — with consent · simulated",
      ],
      emergency: null,
      request: {
        case: "SR-…",
        category: "bulk pickup",
        department: "Sanitation",
        location: "1200 Maple Street",
        zone: "A",
        items: ["mattress", "sofa"],
        target: "Scheduled pickup",
        due: "2026-10-03",
        status: "open",
        callers: 1,
        language: "es-US",
        onThisCall: 1,
      },
      complaint: null,
      sources: [],
      texts: [
        "simulated · es-US · 311 de la Ciudad de Contoso: la recogida de un colchón y un sofá en 1200 Maple Street está programada para el sábado 3 de octubre. Caso SR-…. Responda STOP para cancelar.",
      ],
      handoff: null,
      trail: [
        "call_created simulated",
        "language es-US",
        "agent_locale es-US · es-US-PalomaNeural",
        "guided_started bulk-pickup",
        "guided_completed bulk-pickup",
        "contact_set updates",
        "sms_simulated case SR-…",
        "call_ended completed",
      ],
    },
  ],
  "A civic question": [
    {
      state: "ended",
      outcome: "completed",
      caller: "***-0118",
      language: "en-US · en-US-Ava:DragonHDLatestNeural",
      decisions: [
        "Answered from approved content — grounded answer, source named",
        "No approved answer, so no guess — no guess → 311 staff offered",
      ],
      emergency: null,
      request: null,
      complaint: null,
      sources: [
        "Trash pickup schedule · Sanitation service guide · read out",
        "Counter hours old notice · Archived counter hours notice · expired, withheld",
      ],
      texts: [],
      handoff: null,
      trail: [
        "call_created simulated",
        "search_faq When is trash pickup on Maple Street?",
        "faq_answered trash-schedule-en",
        "search_faq And what are the counter hours at City Hall?",
        "faq_refused And what are the counter hours at City Hall?",
        "call_ended completed",
      ],
    },
  ],
  "A complaint, to a person": [
    {
      state: "transferred",
      outcome: "transferred:311-live",
      caller: null,
      language: "en-US · en-US-Ava:DragonHDLatestNeural",
      decisions: [
        "Complaint heard, offering a person — complaint → offer a person",
        "Handing off to 311 Live Agent — warm handoff with context",
      ],
      emergency: null,
      request: null,
      complaint: {
        about: "Complaint: trash trucks have skipped my street…",
        sentiment: "frustrated",
      },
      sources: [],
      texts: [],
      handoff: {
        to: "311 Live Agent",
        queue: "311 Live Agent Queue",
        reason: "Complaint",
        topic: "Complaint: trash trucks have skipped my street…",
        summary: "Complaint. About missed trash pickup. Caller sounds frustrated.",
        sentiment: "frustrated",
        language: "en-US",
        tags: ["Complaint", "Frustrated"],
        case: null,
        headers: [
          "CallDetails.SessionId",
          "CallDetails.CallTopic",
          "CallDetails.CallContext",
          "CallDetails.RouteId",
        ],
        route: "311-live",
        context: {
          caseNumber: null,
          requestType: null,
          location: null,
          fields: {},
          language: "en-US",
          transferReason: "complaint",
          summary: "Complaint. About missed trash pickup. Caller sounds frustrated.",
          complaint: "I want to make a complaint. The trash trucks have skipped my street three weeks in a row and nobody has called me back.",
          sentiment: "frustrated",
        },
      },
      trail: [
        "call_created simulated",
        "complaint Complaint: trash trucks have skipped my street…",
        "transfer_started complaint",
        "transfer_simulated 311-live",
        "call_ended transferred:311-live",
      ],
    },
  ],
};

const EXPECTED_STATS = {
  calls: 5,
  requestsCreated: 2,
  duplicates: 0,
  emergenciesEscalated: 1,
  answered: 1,
  handedOff: 1,
  texts: 2,
  spanishCalls: 1,
  containment: 0.8,
  requestsByType: { pothole: 1, "bulk-pickup": 1 },
  requestsByDepartment: { "public-works": 1, sanitation: 1 },
  duplicatesMerged: 0,
  emergencyRedirects: { gas: 1 },
  transfersByReason: { complaint: 1 },
  failedTransfers: 0,
  callsByLanguage: { "en-US": 4, "es-US": 1 },
  guidedFlowStarts: 1,
  guidedFlowCompletions: 1,
  smsLinksSent: 0,
};

// Out of order, case numbers follow the order the beats ran in, so they're
// dropped wherever they show: the case card, the decisions, the texts, the
// handoff and the trail. Except from the top: beat 1 resets the demo first, so
// Alex's pothole is always SR-26-0193, and that's pinned.
let resetBy = null;
let fromTheTop = false;
const scrub = (text) => (text == null || fromTheTop ? text : String(text).replace(/\bSR-\d{2}-\d{4}\b/g, "SR-…"));

/** The record panel's case card: the request as filed, without its times. */
function request(s) {
  const c = s?.lastCase;
  if (!c) return null;
  const bulk = c.type === "bulk-pickup";
  return {
    case: scrub(c.id),
    category: c.label,
    department: c.departmentName,
    location: c.location,
    zone: c.zone,
    ...(bulk
      ? { items: c.fields?.items ?? [] }
      : { priority: c.priority ? (c.escalatedAt ? "priority hazard, raised by a later report" : "priority hazard") : "standard" }),
    target: c.slaText,
    due: c.due ? String(c.due).slice(0, 10) : null,
    status: c.status,
    callers: c.meToo,
    language: c.language,
    onThisCall: s.cases?.length ?? 0,
  };
}

/**
 * public/app.js renderSources(): every article the call touched. The snapshot
 * keeps only the last search, so the console collects them from the hub.
 */
function sources(s, frames) {
  const faqs = [];
  for (const found of [...frames.filter((f) => f.target === "faq").map((f) => f.payload), s?.faq].filter(Boolean)) {
    if (!faqs.some((f) => f.at === found.at)) faqs.push(found);
  }
  const seen = new Set();
  const items = [];
  for (const f of faqs) {
    (f.passages ?? []).forEach((p, i) => {
      if (seen.has(p.id)) return;
      seen.add(p.id);
      items.push(`${p.title} · ${p.source} · ${i ? "not needed" : p.freshness === "stale" ? "read out, with a caveat" : "read out"}`);
    });
    for (const w of f.withheld ?? []) {
      if (seen.has(w.id)) continue;
      seen.add(w.id);
      items.push(`${w.title} · ${w.source} · expired, withheld`);
    }
    if (!f.passages?.length && !f.withheld?.length) items.push(`“${f.query}” · not answered`);
  }
  return items;
}

/** The Teams toast and its VoIP headers: who picks up, and what travels with the call. */
function handoff(s) {
  const h = s?.handoff;
  if (!h) return null;
  return {
    to: h.departmentName,
    queue: h.queue,
    reason: h.reasonLabel,
    topic: scrub(h.callTopic),
    summary: scrub(h.summary),
    sentiment: h.sentiment,
    language: h.language,
    tags: h.tags,
    case: scrub(h.caseNumber),
    // The session id header carries the call's own id, so only which headers travel.
    headers: (h.voipHeaders ?? []).map((x) => x.key),
    route: h.routeId,
    context: JSON.parse(scrub(h.callContext ?? "{}")),
  };
}

await rehearse({
  port: 8296,
  env: SIMULATION,
  liveEnv: LIVE,
  // The third demo control: closing a case for a status-check demo.
  liveRefused: ["/api/cases/SR-26-0193/close"],
  // public/app.js startBody(): the beat's caller ID, or a withheld number.
  startBody: (step) => ({ fromPhone: ("fromPhone" in step ? (step.fromPhone ?? "") : "") || null }),
  // public/app.js perform(): a new call first lets a handoff in flight land.
  busy: (snapshot) => snapshot.state === "transferring",
  settleMs: ({ health }) => (health?.settings?.transferDelayMs ?? 0) + 3000,
  // public/app.js resetDemo(): beat 1 starts from a clean stage.
  hooks: (ctx) => ({
    resetDemo: async () => {
      await ctx.post("/api/demo/reset");
      ctx.session.reset();
      resetBy = ctx.beat;
      return true;
    },
  }),
  // public/app.js showMetrics(): wait for the handoff to land, then the numbers.
  actions: (ctx) => ({
    metrics: async () => {
      for (let i = 0; i < 30 && !ctx.session.finished; i += 1) await ctx.sleep(100);
      return ctx.get("/api/stats");
    },
  }),
  outcome: ({ beat, calls }) => {
    fromTheTop = resetBy === beat;
    resetBy = null;
    return calls.map(({ snapshot: s, events, frames }) => ({
      state: s?.state ?? null,
      outcome: s?.outcome ?? null,
      caller: s?.maskedPhone ?? null,
      language: s ? `${s.language} · ${s.voice}` : null,
      // public/app.js decision(): the headline the panel shows, turn by turn.
      decisions: (s?.decisions ?? []).map((d) => `${scrub(d.title)} — ${d.verdict}`),
      emergency: s?.emergency ? { heard: s.emergency.matched ?? s.emergency.label, category: s.emergency.label, sentTo: s.emergency.redirect } : null,
      request: request(s),
      complaint: s?.complaint ? { about: s.complaint.topic, sentiment: s.sentiment } : null,
      sources: sources(s, frames),
      texts: (s?.texts ?? []).map((t) => `${t.status} · ${t.locale} · ${scrub(t.text)}`),
      handoff: handoff(s),
      trail: trail(events).map(scrub),
    }));
  },
  expected: EXPECTED,
  // Everything but the average handle time, which is how long the calls took.
  stats: ({ averageHandleTimeMs, ...counts }) => counts,
  expectedStats: EXPECTED_STATS,
});
