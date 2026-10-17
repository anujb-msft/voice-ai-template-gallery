/**
 * The on-call pager console.
 *
 * A viewer of the server's paging state machine, never a second copy of it.
 * Every decision on screen — the severity, who is on call, the escalation
 * timer, what voicemail may hear — is one the server made and published over
 * the hub; this file only explains it. The plumbing every template shares
 * (hub, call session, demo director, Teams toast, gauge, countdown, trail)
 * comes from the presenter kit, and the on-stage script lives in beats.js.
 */

import {
  $,
  escapeHtml,
  getJson,
  postJson,
  notify,
  flash,
  sleep,
  connectHub,
  createCallSession,
  createSimulator,
  renderMode,
  setStateChip,
  renderBudget,
  createCountdown,
  renderDecision,
  renderGauge,
  renderFacts,
  renderChecks,
  renderList,
  renderMetrics,
  chip,
  createTranscript,
  createTrail,
  renderTeamsToast,
  clearTeamsToast,
  renderHeaders,
  voiceStack,
  mountStack,
  mountClock,
  createVoice,
  createDirector,
} from "/presenter-kit.js";
import { createBeats } from "/beats.js";

// Mirrors config/tenants.json, so the presenter can choose who is calling.
const CALLERS = [
  { phone: "+12065550101", name: "Alice Rivera", where: "Maple Court 4B" },
  { phone: "+12065550102", name: "Ben Carter", where: "Maple Court 2A" },
  { phone: "+12065550103", name: "Dee Nguyen", where: "Pine Terrace 11" },
  { phone: "+12065550104", name: "Grace Kim", where: "Pine Terrace 7" },
  { phone: "+12065550199", name: "Unknown number", where: "Not on a lease — the agent asks for the building and unit" },
  { phone: "", name: "Number withheld", where: "No caller ID" },
];

// The keypad. The tenant has one key; a technician on a page has four.
const KEYS = [
  { digit: "1", hint: "accept", who: "tech", title: "Technician: accept the page" },
  { digit: "2", hint: "decline", who: "tech", title: "Technician: decline — the page escalates" },
  { digit: "3", hint: "tenant", who: "tech", title: "Technician: talk to the tenant — the server connects them, no numbers shared" },
  { digit: "*", hint: "repeat", who: "tech", title: "Technician: hear the brief again" },
  { digit: "0", hint: "person", who: "tenant", title: "Tenant: ask for a person" },
];

const els = {
  org: $("org"),
  mode: $("mode"),
  reset: $("reset"),
  stateChip: $("stateChip"),
  callerSelect: $("callerSelect"),
  newCall: $("newCall"),
  budget: $("budget"),
  sayForm: $("sayForm"),
  sayInput: $("sayInput"),
  sayBtn: $("sayBtn"),
  keys: $("keys"),
  voicemail: $("voicemail"),
  skip: $("skip"),
  silence: $("silence"),
  hangup: $("hangup"),
  context: $("context"),
  rotation: $("rotation"),
  decision: $("decision"),
  gauge: $("gauge"),
  win: $("window"),
  facts: $("facts"),
  pageCard: $("pageCard"),
  pageTitle: $("pageTitle"),
  pageTag: $("pageTag"),
  draft: $("draft"),
  draftNote: $("draftNote"),
  paged: $("paged"),
  toast: $("toast"),
  voicemailBox: $("voicemailBox"),
  vmNote: $("vmNote"),
  vmPrompt: $("vmPrompt"),
  vmLeftOut: $("vmLeftOut"),
  headers: $("headers"),
  checks: $("checks"),
  metrics: $("metrics"),
};
// The escalation window: when the next page goes out, on the server's timer.
const win = createCountdown(els.win);

// Story states the server never leaves.
const TERMINAL = new Set(["closed", "work-order", "duplicate", "ended", "cancelled", "exhausted"]);

// The state chip, [text, tone]. A paging story reads by its phase.
const CHIP = {
  intake: ["intake", "accent"],
  ringing: ["paging · ringing", "warn"],
  briefed: ["paging · on the line", "accent"],
  waiting: ["paging · waiting", "warn"],
  closed: ["acknowledged", "ok"],
  "work-order": ["work order", "ok"],
  duplicate: ["duplicate", "accent"],
  ended: ["ended", "muted"],
  cancelled: ["canceled", "muted"],
  exhausted: ["all levels paged", "err"],
};

const VERDICTS = {
  emergency: ["emergency — 911 line, then page", "err"],
  urgent: ["urgent — page now", "warn"],
  routine: ["routine — work order", "ok"],
};

// A page attempt as the technician's phone shows it, [status, tone].
const OUTCOMES = {
  ringing: ["Incoming page", "ok"],
  calling: ["Calling…", "ok"],
  answered: ["On the call", "accent"],
  accept: ["Accepted", "ok"],
  bridge: ["Connected to the tenant", "ok"],
  "no-answer": ["Missed", "warn"],
  voicemail: ["Went to voicemail", "warn"],
  decline: ["Declined", "err"],
  cancelled: ["Canceled", "muted"],
  failed: ["Didn't connect", "err"],
};
// ...and in the list of pages.
const OUTCOME_SHORT = {
  ringing: "ringing",
  calling: "calling",
  answered: "on the line",
  accept: "accepted",
  bridge: "connected",
  "no-answer": "missed",
  voicemail: "voicemail",
  decline: "declined",
  cancelled: "canceled",
  failed: "failed",
};
// Why the previous page didn't stick.
const MISSED = {
  "no-answer": "didn't answer",
  voicemail: "went to voicemail",
  decline: "declined",
  failed: "couldn't be reached",
  cancelled: "was canceled",
};

// Where the clock stops on the budget bar, and what it says.
const STOPS = {
  closed: "acknowledged",
  "work-order": "work order",
  duplicate: "attached",
  ended: "ended",
  cancelled: "ended",
  exhausted: "all levels paged",
};

// Defaults until /health answers; the server's numbers win.
const paging = {
  levels: ["primary", "secondary", "propertyManager"],
  attemptsPerLevel: 2,
  gapMinutes: { urgent: 3, emergency: 1 },
  unacknowledgedAlertMinutes: 20,
  duplicateWindowMinutes: null,
  noHeatThresholdF: 55,
};

let health = null;
let live = false;
let org = "Contoso Property Management";
let stack = null;
let clockState = null;
let clockLocked = false;
let clockQueue = Promise.resolve();
let quietLoad = false;
let sending = false;
let view = blankView();

/** What the console has learned about the call on screen, beyond its snapshot. */
function blankView() {
  return {
    snap: null,
    handoff: null, // the page the technician's phone shows
    toastKey: "",
    windowJob: null, // the scheduled page the countdown is drawing
    windowEndsAt: 0,
    guarded: false, // the technician asked for a phone number and was refused
    refusedLast: false,
    bridged: false,
    personRequested: false,
    statusSent: false,
    frozenMs: null,
    syncedAt: 0,
    statsSig: "",
  };
}

const terminal = (snap) => TERMINAL.has(snap?.state);
const cap = (s) => String(s ?? "").replace(/^./, (c) => c.toUpperCase());
const lowerFirst = (s) => String(s ?? "").replace(/^./, (c) => c.toLowerCase());
const firstOf = (name) => String(name ?? "").trim().split(/\s+/)[0] ?? "";
const tenantName = (snap = view.snap) => snap?.caller?.firstName ?? "the tenant";
const gapFor = (snap) => paging.gapMinutes?.[snap?.classification?.severity] ?? paging.gapMinutes?.urgent ?? 3;

/** "6:05" — minutes and seconds. */
function mmss(ms, round = Math.round) {
  const total = Math.max(0, round(Number(ms ?? 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** A time on the demo clock, in the zone the policy runs in. */
function clockTime(at) {
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return "";
  const options = { hour: "numeric", minute: "2-digit" };
  try {
    return time.toLocaleTimeString("en-US", { ...options, timeZone: clockState?.timeZone ?? health?.clock?.timeZone });
  } catch {
    return time.toLocaleTimeString("en-US", options);
  }
}

/** Milliseconds until a scheduled page, from the last snapshot and the time since. */
const dueInNow = (next) => next.dueInMs - (performance.now() - view.syncedAt);
const isEscalation = (next) => next.attempt === 1 && next.level !== paging.levels[0];

const stackNodes = () =>
  voiceStack({
    caller: "Tenant",
    voiceLive: health?.voiceLive?.model ?? "gpt-realtime",
    tools: "Paging policy",
    toolsSim: "real policy code",
    agent: "Technician",
    agentLive: "Teams Phone page + card",
    agentSim: "mock toast",
  });

// ------------------------------------------------------------------ wiring

const voice = createVoice($("voice"), { lang: "en-US" });
const clock = mountClock($("clock"), {
  onChange: (state) => {
    clockState = state;
    renderRotation();
  },
});
const transcript = createTranscript($("transcript"), {
  voice,
  labels: { caller: "Tenant" },
  empty: "Answer a call, or press Next ▶ to run the demo script.",
});
const trail = createTrail($("events"), {
  good: [
    "caller_matched",
    "unit_confirmed",
    "context_captured",
    "callback_confirmed",
    "incident_created",
    "work_order_logged",
    "page_answered",
    "page_accepted",
    "bridge_created",
    "incident_closed",
    "status_call_sent",
    "technician_card_sent",
  ],
  bad: [
    "page_declined",
    "page_failed",
    "page_exhausted",
    "ops_alert_sent",
    "ops_alert_failed",
    "bridge_failed",
    "status_call_failed",
    "technician_card_failed",
  ],
  warn: [
    "caller_unknown",
    "unit_clarify",
    "no_input",
    "reprompt",
    "person_requested",
    "page_no_answer",
    "page_voicemail",
    "voicemail_prompt",
    "retry_pending",
    "escalation_pending",
    "safety_net_pending",
    "number_request_guarded",
    "duplicate_attached",
    "duplicate_severity_increased",
    "bridge_unavailable",
    "status_call_skipped",
  ],
  timeZone: () => clockState?.timeZone ?? health?.clock?.timeZone,
  empty: "Every capture, page and escalation shows up here, on the demo clock.",
});
const session = createCallSession({
  voice,
  onMessage,
  onFollow: () => clearPanels(),
  isFinished: (state) => TERMINAL.has(state),
});
connectHub(
  (target, payload) => {
    // A page job with no call behind it publishes under the incident id; the
    // call's own frames already carry everything this console shows.
    if (target === "incident" || String(payload?.callId ?? "").startsWith("inc_")) return;
    session.handle(target, payload);
  },
  { onOpen: ({ reconnected }) => reconnected && refreshAll() },
);
const sim = createSimulator({
  session,
  startBody,
  onSnapshot: applySnapshot,
  actions: {
    advance: (step) => advanceClock(step.minutes ?? 3),
    voicemail: () => leaveVoicemail(),
    metrics: showMetrics,
  },
});
const director = createDirector($("director"), {
  beats: createBeats({ setClock }),
  perform,
  voice,
  sayInput: els.sayInput,
  onBeat: (beat) => {
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: "smooth" });
    // Set the beat's clock now, so the rotation on screen matches the talk
    // before the first Next. Reset keeps the starting clock instead.
    if (!quietLoad) beat?.prepare?.().catch((error) => notify(error.message, "err"));
  },
});

setInterval(tickBudget, 500);
// Who is on call follows the clock, so keep the rotation honest.
setInterval(() => clock.refresh(), 60_000);
boot();

async function boot() {
  renderCallers();
  renderKeys();
  renderHeaders(els.headers, []);
  render();
  await Promise.all([loadHealth(), refreshStats()]);
  stack ??= mountStack($("stack"), { nodes: stackNodes() });
  render();
}

// ------------------------------------------------------------- call steps

function startBody(step) {
  const phone = "fromPhone" in step ? (step.fromPhone ?? "") : els.callerSelect.value;
  els.callerSelect.value = phone;
  return { fromPhone: phone || null };
}

/** Director and button steps. A new call first settles the one on screen. */
async function perform(step) {
  if (step.type === "start") {
    await settleOpenCall();
    clearPanels();
  }
  return heed(await sim.perform(step));
}

/**
 * Before a new call or a clock change. A page that is due any moment goes
 * out first (bounded), so a quick Next never cancels it mid-flight; then the
 * call on screen is hung up, which cancels its pending pages. A page minutes
 * away on the demo clock is not worth waiting for.
 */
async function settleOpenCall() {
  const deadline = performance.now() + 7000;
  while (performance.now() < deadline) {
    const snap = view.snap;
    if (!snap || terminal(snap) || !snap.nextPage || dueInNow(snap.nextPage) > 1500) break;
    await sleep(150);
  }
  if (session.id && !session.finished && !session.followed) await sim.hangup().catch(() => {});
}

/**
 * Beats pin the demo clock. A server answering real calls keeps real time.
 * Calls are queued, so a beat's own prepare never races the one its arrival
 * started.
 */
function setClock(preset) {
  const run = clockQueue.then(() => pinClock(preset));
  clockQueue = run.catch(() => {});
  return run;
}

async function pinClock(preset) {
  await settleOpenCall();
  try {
    await clock.set({ preset });
  } catch (error) {
    if (error.status !== 403) throw error;
    if (!clockLocked) {
      clockLocked = true;
      notify("This server answers real calls, so the demo clock stays on real time.", "warn", 6000);
    }
    return;
  }
  // The last beat's call gives way to the rotation on the new clock.
  if (!session.followed) clearPanels();
}

/** The server says why it ignored a step — nobody on the line, the call has ended. Show it. */
function heed(res) {
  const note = res?.result?.ignored ? res.result.note : null;
  if (note) notify(note, "warn", 5000);
  return res;
}

// -------------------------------------------------------------------- hub

function onMessage(target, payload) {
  switch (target) {
    case "state":
      applySnapshot(payload);
      break;
    case "transcript":
      onTranscript(payload);
      break;
    case "event":
      stack?.onHub(target, payload);
      onEvent(payload);
      break;
    case "handoff":
      stack?.onHub(target, payload);
      view.handoff = payload;
      renderHandoff();
      render();
      break;
  }
}

function onTranscript(payload) {
  const { role, text, label } = payload;
  if (role === "system") {
    transcript.system(text);
    return;
  }
  // The same agent talks to the tenant and to the technician's phone; the
  // strip lights the leg the line went down.
  const party = partyOf(role, label);
  if (party === "page") stack?.flow(["voice-live", "acs", "teams-phone", "teams-agent"]);
  else if (party === "tech") stack?.flow(["teams-agent", "teams-phone", "acs", "voice-live"]);
  else stack?.onHub("transcript", payload);
  const li = transcript.add(role, text, { label: label ?? undefined });
  if (li) li.dataset.party = party;
}

/** Who a line is between: the tenant's call, or the page to the technician. */
function partyOf(role, label) {
  if (!label) return "tenant";
  const tenant = view.snap?.caller?.firstName;
  if (role === "agent") {
    const to = String(label).replace(/^Agent → /, "");
    return to === "tenant" || (tenant && to === tenant) ? "tenant" : "page";
  }
  return label === "Caller" || label === tenant ? "tenant" : "tech";
}

/**
 * Snapshots arrive twice — over the hub and in each simulate response — and
 * not always in order. Older ones, and anything after the story finished,
 * are ignored.
 */
function applySnapshot(snap) {
  if (!snap?.id) return;
  if (session.id && snap.id !== session.id) return;
  const prev = view.snap?.id === snap.id ? view.snap : null;
  if (prev && terminal(prev) && !terminal(snap)) return;
  if (prev && (snap.seq ?? 0) < (prev.seq ?? 0)) return;

  view.snap = snap;
  view.syncedAt = performance.now();
  // Simulate responses don't pass through the session, so it learns the end here.
  if (terminal(snap) && snap.id === session.id) session.end();
  syncWindow(snap);

  const sig = [
    snap.id,
    snap.state,
    snap.incident?.reference,
    (snap.attempts ?? []).map((a) => a.outcome).join(","),
    snap.workOrder?.reference,
  ].join("|");
  if (sig !== view.statsSig) {
    view.statsSig = sig;
    refreshStats({ highlight: terminal(snap) && !terminal(prev) });
  }
  render();
}

function onEvent(e) {
  trail.add(e);
  const detail = String(e.detail ?? "");
  switch (e.kind) {
    case "caller_matched":
      transcript.tool("lookup_caller", detail.replace(/^Caller ID \S+ is /, ""), "ok");
      break;
    case "caller_unknown":
      transcript.tool(
        "lookup_caller",
        /withheld/.test(detail) ? "number withheld — the agent asks for the building and unit" : "not on a lease — the agent asks for the building and unit",
        "warn",
      );
      break;
    case "unit_confirmed":
      transcript.tool("identify_unit", detail, "ok");
      break;
    case "unit_clarify":
      transcript.tool("identify_unit", detail, "warn");
      break;
    case "context_captured":
      transcript.tool("record_issue", detail, "accent");
      break;
    case "callback_confirmed": {
      const masked = /•••-\d{4}/.exec(detail)?.[0];
      transcript.tool("confirm_callback", masked ? `${masked} — never read aloud` : "confirmed", "ok");
      break;
    }
    case "incident_created": {
      const severity = detail.split(" · ")[0];
      transcript.tool("classify_and_submit", detail, severity === "emergency" ? "err" : severity === "urgent" ? "warn" : "ok");
      break;
    }
    case "work_order_logged":
      transcript.tool("log_work_order", "no page — the office follows up", "ok");
      break;
    case "number_request_guarded":
      view.guarded = true;
      view.refusedLast = true;
      transcript.tool("get_ticket_detail", "phone number — refused, offered to connect instead", "warn");
      break;
    case "ticket_detail":
      view.refusedLast = false;
      transcript.tool("get_ticket_detail", detail, "accent");
      break;
    case "page_accepted":
      transcript.tool("acknowledge", detail, "ok");
      break;
    case "page_declined":
      transcript.tool("decline", detail ? `${detail} — escalating` : "escalating", "err");
      break;
    case "bridge_created":
      view.bridged = true;
      view.refusedLast = false;
      transcript.tool("bridge_to_tenant", "both numbers stay on the server", "ok");
      break;
    case "bridge_failed":
      view.bridged = false;
      transcript.tool("bridge_to_tenant", "the tenant's line didn't join — they get a status call instead", "err");
      break;
    case "brief_repeated":
      view.refusedLast = false;
      transcript.tool("repeat_brief", "", "accent");
      break;
    case "person_requested":
      view.personRequested = true;
      break;
    case "status_call_sent":
      view.statusSent = true;
      break;
  }
  render();
}

// ----------------------------------------------------------------- render

function render() {
  const snap = view.snap;
  const [text, tone] = !snap ? [null, "idle"] : (CHIP[snap.state === "paging" ? snap.phase : snap.state] ?? [snap.state, "muted"]);
  setStateChip(els.stateChip, text, tone);
  renderControls();
  renderDecision(els.decision, { ...decision(snap), empty: "Answer a call to see what the server decides." });
  renderGaugePanel();
  renderFactsPanel();
  renderContext();
  renderRotation();
  renderPageCard();
  renderChecksPanel();
  renderToastStatus();
  tickBudget();
}

function renderControls() {
  const snap = view.snap;
  const active = Boolean(session.id && !session.finished && !session.followed && snap && !terminal(snap));
  const phase = active ? snap.phase : null;
  const onPage = phase === "ringing" || phase === "briefed";
  const talking = phase === "intake" || onPage;
  for (const el of [els.sayInput, els.sayBtn, els.silence]) el.disabled = !talking;
  els.hangup.disabled = !active;
  els.voicemail.disabled = phase !== "ringing";
  els.skip.disabled = !(active && snap.nextPage && !live);
  for (const button of els.keys.querySelectorAll("button[data-digit]")) {
    button.disabled = button.dataset.who === "tenant" ? phase !== "intake" : !onPage;
  }
  els.sayInput.placeholder = onPage
    ? `Type what ${snap.leg?.contact?.name ?? "the technician"} says`
    : phase === "waiting"
      ? "Nobody is on the line — the next page is on a timer"
      : "Type what the tenant says";
}

/** The headline: what the server decided, and why, in plain English. */
function decision(snap) {
  if (!snap) return {};
  const cls = snap.classification;
  const tenant = tenantName(snap);
  const leg = snap.leg;
  const tech = leg?.contact?.name ?? "the technician";
  const attempts = snap.attempts ?? [];
  const last = attempts.at(-1);

  switch (snap.state) {
    case "intake": {
      if (!cls) {
        return view.personRequested
          ? {
              headline: "Asked for a person",
              why: "After hours there is nobody to transfer to, so the agent keeps taking the report. If the policy says it's urgent, the on-call technician is paged with it.",
              verdict: "after hours → keep the report",
              tone: "accent",
            }
          : {
              headline: "Listening…",
              why: "The agent captures what, where, the impact and a callback number as fields. The server's paging policy decides what happens with them.",
              verdict: "intake",
              tone: "muted",
            };
      }
      const pending = cls.gate && cls.gate.indoorTempF == null;
      const missing = stillToCapture(snap);
      const [verdict, tone] = pending
        ? ["no heat — waiting on the temperature", "accent"]
        : (VERDICTS[cls.severity] ?? [cls.severity, "muted"]);
      return {
        headline: `${cap(cls.issueTypeLabel)} — ${pending ? "it depends on the temperature" : cls.severity}`,
        why: `${cls.reason}${missing.length ? ` Still to capture: ${missing.join(", ")}.` : ""}`,
        verdict,
        tone,
      };
    }

    case "paging": {
      if (snap.phase === "ringing" && leg) {
        const first = leg.level === paging.levels[0] && leg.attempt === 1 && attempts.length <= 1;
        const onCall = snap.onCall?.why ? ` ${tech} is on call: ${lowerFirst(snap.onCall.why)}.` : "";
        return {
          headline: `Paging ${tech}`,
          why: first ? `${cls?.reason ?? ""}${onCall}`.trim() : (whyThisPage(snap) ?? view.handoff?.reason ?? ""),
          verdict: `ringing · ${leg.levelLabel} · attempt ${leg.attempt} of ${leg.attemptsPerLevel}`,
          tone: "warn",
        };
      }
      if (snap.phase === "briefed" && leg) {
        if (view.refusedLast && !view.bridged) {
          return {
            headline: "Phone numbers stay on the server",
            why: `${tech} asked for ${tenant === "the tenant" ? "the tenant's" : `${tenant}'s`} number. The agent may read back any captured field except a phone number, so it offered to connect them instead — press 3.`,
            verdict: "refused — offered the bridge",
            tone: "warn",
          };
        }
        return {
          headline: `${tech} is hearing the brief`,
          why: `About ${snap.briefSeconds ?? "?"} seconds, written by the server from the captured fields — not by the model. 1 accepts, 2 declines and escalates, 3 connects ${tenant}.`,
          verdict: `on the line · ${leg.levelLabel}`,
          tone: "accent",
        };
      }
      const next = snap.nextPage;
      if (last?.outcome === "voicemail" && snap.voicemail) {
        return {
          headline: "Voicemail — callback prompt only",
          why: `Anyone near ${snap.voicemail.contactName}'s phone can hear a voicemail, so it got a callback prompt and reference ${snap.voicemail.reference} — nothing about the building, the unit or the problem. ${next ? nextText(next) : ""}`.trim(),
          verdict: "nothing private on voicemail",
          tone: "warn",
        };
      }
      if (next) {
        const escalation = isEscalation(next);
        return {
          headline: escalation ? `Escalating to ${next.contactName}` : `Paging ${next.contactName} again`,
          why: next.reason ?? nextText(next),
          verdict: escalation ? `escalation · ${next.levelLabel}` : `retry · attempt ${next.attempt} of ${next.attemptsPerLevel}`,
          tone: "warn",
        };
      }
      return { headline: "Paging the on-call technician", why: cls?.reason ?? "", verdict: "paging", tone: "warn" };
    }

    case "closed": {
      const inc = snap.incident;
      const by = inc?.acknowledgedBy ?? last?.contactName ?? "The technician";
      const bridged = view.bridged || Boolean(inc?.bridgeRequested);
      const tta = inc?.timeToAcknowledgeMs != null ? ` ${mmss(inc.timeToAcknowledgeMs)} after the report` : "";
      const pageNo = attempts.length > 1 ? `, on page ${attempts.length}` : "";
      const tail = bridged
        ? ", and the server bridged the call — neither of them saw the other's number."
        : view.statusSent
          ? `, and the agent called ${tenant} back to say so.`
          : ".";
      return {
        headline: bridged ? `${by} is talking to ${tenant}` : `${by} has it`,
        why: `Acknowledged${tta}${pageNo}. The retries and the ops alert are canceled${tail}`,
        verdict: bridged ? "acknowledged · connected through the server" : "acknowledged",
        tone: "ok",
      };
    }

    case "work-order": {
      const wo = snap.workOrder;
      return {
        headline: "A work order, not a page",
        why: wo ? `${wo.reason} The office follows up ${wo.followUp}.` : (cls?.reason ?? ""),
        verdict: "routine — nobody woken",
        tone: "ok",
      };
    }

    case "duplicate": {
      const within = paging.duplicateWindowMinutes ? ` within ${paging.duplicateWindowMinutes} minutes` : "";
      return {
        headline: "Already reported",
        why: `The same unit was reported${within}, so this call is attached to reference ${snap.incident?.reference ?? "on file"} — nobody is paged twice.`,
        verdict: "duplicate — no second page",
        tone: "accent",
      };
    }

    case "ended":
      return {
        headline: "Call ended — nothing paged",
        why: view.personRequested
          ? `${cap(tenant)} asked for a person and the report was never finished. After hours, nobody is woken without one.`
          : "The call ended before the report was complete, so nothing was paged.",
        verdict: "no page",
        tone: "muted",
      };

    case "cancelled":
      return {
        headline: "Pages canceled",
        why: "The demo call ended, and its pending pages with it. On a real call, paging carries on after the tenant hangs up.",
        verdict: "demo call ended",
        tone: "muted",
      };

    case "exhausted":
      return {
        headline: "Nobody acknowledged",
        why: `Every level has been paged.${snap.alertAt ? ` The ops alert goes out at ${clockTime(snap.alertAt)} unless someone acknowledges first.` : ""}`,
        verdict: "all levels paged",
        tone: "err",
      };

    default:
      return { headline: cap(snap.state), why: "", verdict: "", tone: "muted" };
  }
}

/** The fields the page still needs, in words. */
function stillToCapture(snap) {
  const c = snap.context ?? {};
  return [
    !c.where && "the building and unit",
    c.where && !c.whereConfirmed && "a confirmed unit",
    snap.classification?.gate && snap.classification.gate.indoorTempF == null && "the inside temperature",
    c.access == null && "access",
    !c.callbackConfirmed && "a callback number",
  ].filter(Boolean);
}

/** Why a page that isn't the first went out: what happened to the one before. */
function whyThisPage(snap) {
  const leg = snap.leg;
  const prior = (snap.attempts ?? []).filter((a) => !(a.level === leg.level && a.attempt === leg.attempt)).at(-1);
  if (!prior) return null;
  const what = `${prior.contactName} ${MISSED[prior.outcome] ?? prior.outcome}`;
  if (leg.attempt > 1) {
    return `${what} on attempt ${prior.attempt}, so the policy pages the ${leg.levelLabel} again after the ${gapFor(snap)}-minute gap — attempt ${leg.attempt} of ${leg.attemptsPerLevel}.`;
  }
  const tries = prior.outcome === "decline" ? "" : ` on attempt ${prior.attempt} of ${paging.attemptsPerLevel}`;
  return `${what}${tries}, so the policy escalates to the ${leg.levelLabel}.`;
}

function renderGaugePanel() {
  const gate = view.snap?.classification?.gate;
  els.gauge.hidden = !gate;
  if (!gate) return;
  renderGauge(els.gauge, {
    value: gate.indoorTempF,
    gate: gate.thresholdF,
    min: 40,
    max: 80,
    label: "inside vs the no-heat line",
    format: (v) => `${v}°F`,
    // Above the line is routine: nobody needs waking.
    passes: (v, g) => v > g,
  });
}

function renderFactsPanel() {
  const snap = view.snap;
  const cls = snap?.classification;
  if (!cls) {
    renderFacts(els.facts, []);
    return;
  }
  const inc = snap.incident;
  const attempts = snap.attempts ?? [];
  const chain = snap.onCall;
  const pages = cls.severity !== "routine" && snap.state !== "duplicate";
  const current = snap.leg?.level ?? snap.nextPage?.level ?? attempts.at(-1)?.level ?? null;
  const chainHtml = chain
    ? paging.levels
        .map((level) => {
          const name = chain[level]?.name;
          if (!name) return null;
          return level === current ? `<b>${escapeHtml(name)}</b>` : escapeHtml(name);
        })
        .filter(Boolean)
        .join(" → ")
    : "";
  const alert = !pages || !inc
    ? null
    : inc.acknowledgedAt
      ? ["canceled — acknowledged", "ok"]
      : snap.state === "cancelled"
        ? ["canceled — the demo call ended", "muted"]
        : snap.alertAt
          ? [`at ${clockTime(snap.alertAt)} unless someone acknowledges`, "warn"]
          : null;

  renderFacts(els.facts, [
    // <wbr> lets a long rule wrap at its colons instead of mid-word.
    ["Matched rule", `<code>${escapeHtml(cls.matchedRule ?? "—").replaceAll(":", ":<wbr>")}</code>`, { html: true }],
    pages && chainHtml && ["Escalation chain", chainHtml, { html: true }],
    attempts.length > 0 && [
      "Pages",
      attempts.map((a) => `${firstOf(a.contactName)} ${OUTCOME_SHORT[a.outcome] ?? a.outcome}`).join(" · "),
    ],
    alert && ["Ops alert", alert[0], { tone: alert[1] }],
    snap.workOrder && ["Follow-up", `the office, ${snap.workOrder.followUp}`],
    // A page carries its reference on the toast; without one, it goes here.
    inc && !view.handoff && ["Reference", inc.reference],
    inc?.timeToAcknowledgeMs != null && ["Time to acknowledge", mmss(inc.timeToAcknowledgeMs), { tone: "ok" }],
  ]);
}

/** What the agent captured: fields, never a transcript. The page is built from these. */
function renderContext() {
  const snap = view.snap;
  const c = snap?.context ?? {};
  const muted = (text) => ` <span class="muted">${escapeHtml(text)}</span>`;
  const caller = !snap
    ? ""
    : snap.caller?.known
      ? `${snap.caller.name} · ${snap.caller.maskedPhone}`
      : snap.caller?.maskedPhone
        ? `Unknown number · ${snap.caller.maskedPhone}`
        : "Number withheld";
  renderFacts(els.context, [
    ["Caller", caller],
    ["What", cap(c.what)],
    [
      "Where",
      c.where ? `${escapeHtml(c.where)}${muted(c.whereConfirmed ? "✓ confirmed" : "from caller ID — not confirmed yet")}` : "",
      { html: true },
    ],
    ["Tenant said", c.impact ? `“${c.impact}”` : ""],
    c.indoorTempF != null && ["Inside", `${c.indoorTempF}°F`],
    ["Access", c.access ?? ""],
    [
      "Callback",
      c.callback ? `${escapeHtml(c.callback)}${muted(c.callbackConfirmed ? "✓ confirmed — never read aloud" : "not confirmed yet")}` : "",
      { html: true },
    ],
  ]);
}

/** Who is on call right now, and why — from the demo clock, not a spreadsheet. */
function renderRotation() {
  const groups = clockState?.onCall ?? [];
  const active = view.snap?.onCall?.group ?? null;
  renderList(
    els.rotation,
    groups.map((g) => ({
      label: (g.properties ?? []).join(" · ") || g.group,
      meta: `${g.why}${g.secondary?.name ? ` · then ${g.secondary.name}` : ""}`,
      status: g.primary?.name ?? "—",
      tone: String(g.source ?? "").startsWith("override:") ? "warn" : "ok",
      active: Boolean(active && g.group === active),
    })),
    { empty: "Loading the rotation…" },
  );
}

function renderKeys() {
  els.keys.innerHTML = KEYS.map(
    (k) =>
      `<button type="button" data-digit="${escapeHtml(k.digit)}" data-who="${k.who}" title="${escapeHtml(k.title)}">${escapeHtml(
        k.digit,
      )} <small>${escapeHtml(k.hint)}</small></button>`,
  ).join("");
}

function renderCallers() {
  // Names only, so the picker never truncates. The unit shows in the tooltip
  // and, once the call is answered, in what the agent captured.
  els.callerSelect.innerHTML = CALLERS.map(
    (c) => `<option value="${escapeHtml(c.phone)}" title="${escapeHtml(c.where)}">${escapeHtml(c.name)}</option>`,
  ).join("");
}

// ----------------------------------------------------------------- budget

/** Intake has a budget; once paging, the clock is the time to acknowledge, against the ops alert. */
function tickBudget() {
  const snap = view.snap;
  if (!snap) {
    els.budget.hidden = true;
    return;
  }
  const stop = STOPS[snap.state] ?? null;
  if (stop) view.frozenMs ??= snap.elapsedMs;
  else view.frozenMs = null;
  const elapsedMs = view.frozenMs ?? snap.elapsedMs + (performance.now() - view.syncedAt);
  const budgetMs = snap.budgetMs ?? 0;
  renderBudget(els.budget, { elapsedMs, budgetMs });
  const parts = els.budget.pkBudget;
  if (!parts || els.budget.hidden) return;
  const what = snap.budgetLabel === "intake" ? "for intake" : (snap.budgetLabel ?? "");
  parts.label.textContent = `${mmss(elapsedMs)} of ${mmss(budgetMs)} ${what}${stop ? ` · ${stop}` : ""}`;
  if (stop) parts.fill.dataset.tone = stop === "ended" ? "muted" : snap.state === "exhausted" ? "err" : "ok";
}

// --------------------------------------------------- the escalation window

/**
 * The bar drains until the next page goes out. It is drawn from the server's
 * schedule (`nextPage.dueInMs`), never a CSS animation, so a jump of the demo
 * clock redraws it and a page the server sends early or late shows as such.
 */
function syncWindow(snap) {
  const next = terminal(snap) ? null : snap.nextPage;
  if (next) {
    const endsAt = performance.now() + next.dueInMs;
    const moved = next.jobId !== view.windowJob || Math.abs(endsAt - view.windowEndsAt) > 1500;
    if (next.dueInMs > 1500 && moved) {
      view.windowJob = next.jobId;
      view.windowEndsAt = endsAt;
      win.start(next.dueInMs, (_left, leftMs) => windowWords(next, leftMs), { tone: isEscalation(next) ? "warn" : "accent" });
    }
    return;
  }
  view.windowJob = null;
  if (els.win.hidden) return;
  const leg = snap.leg;
  if (snap.state === "closed") {
    win.finish("ok", `${snap.incident?.acknowledgedBy ?? "The technician"} has it — the retries and the ops alert are canceled`);
  } else if (snap.state === "exhausted") {
    win.finish("err", "Every level has been paged — the ops alert is still scheduled");
  } else if (snap.state === "cancelled" || snap.state === "ended") {
    win.finish("warn", "Canceled — the demo call ended, and its pending pages with it");
  } else if (leg) {
    win.finish("accent", `Paging ${leg.contact?.name ?? "the technician"} now`);
  }
}

function windowWords(next, leftMs) {
  const escalation = isEscalation(next);
  const lead = escalation
    ? `Escalating to the ${next.levelLabel}, ${next.contactName}`
    : `Paging ${next.contactName} again (attempt ${next.attempt} of ${next.attemptsPerLevel})`;
  if (leftMs <= 0) return `${lead} — due now`;
  return `${lead}${escalation ? "," : ""} at ${clockTime(next.dueAt)} — ${mmss(leftMs, Math.ceil)} left on the server's timer`;
}

/** The next page in a sentence, at a demo-clock time that doesn't tick. */
function nextText(next) {
  const at = clockTime(next.dueAt);
  return isEscalation(next)
    ? `Escalating to the ${next.levelLabel}, ${next.contactName}, at ${at}.`
    : `${next.contactName} gets attempt ${next.attempt} of ${next.attemptsPerLevel} at ${at}.`;
}

// ------------------------------------------------------------ Teams side

/** The page as the technician's phone shows it. Redrawn only for a new page. */
function renderHandoff() {
  const h = view.handoff;
  if (!h) return;
  const key = `${h.incident?.id}|${h.level}|${h.attempt}`;
  if (key !== view.toastKey) {
    view.toastKey = key;
    const inc = h.incident ?? {};
    const first = h.level === paging.levels[0] && h.attempt === 1;
    const said = inc.tenantSaid ? `Tenant said: “${inc.tenantSaid}”` : "";
    const access = `${inc.permissionToEnter ? "May enter" : "No permission to enter"}${
      inc.accessNotes && inc.accessNotes !== "none" ? ` · ${inc.accessNotes}` : ""
    }`;
    // The first page explains itself only when the rotation was overridden;
    // a later one says what happened to the page before it.
    const sentiment = first
      ? /override/i.test(h.why ?? "")
        ? `Covering: ${String(h.why).split(" — ")[0]}`
        : ""
      : String(h.reason ?? "").split(". ")[0];

    renderTeamsToast(els.toast, {
      queue: org,
      subtitle: `After-hours page for ${h.contactName} · ${h.levelLabel}, attempt ${h.attempt} of ${h.attemptsPerLevel}`,
      topic: h.topic,
      context: sameWords(said, h.topic) ? "" : said,
      sentiment,
      callerHtml: `<strong>${escapeHtml(inc.propertyName ?? "")}, unit ${escapeHtml(inc.unit ?? "")}</strong><div>${escapeHtml(
        access,
      )}</div><span class="muted">Callback ${escapeHtml(inc.callbackMasked ?? "on file")} — the number stays on the server</span>`,
      avatar: org,
      tags: [
        inc.severity && { text: inc.severity, tone: inc.severity === "emergency" ? "err" : inc.severity === "urgent" ? "warn" : "ok" },
        { text: inc.permissionToEnter ? "may enter" : "no entry", tone: inc.permissionToEnter ? "ok" : "muted" },
        !first && {
          text: h.attempt === 1 ? `escalated · ${h.levelLabel}` : `attempt ${h.attempt} of ${h.attemptsPerLevel}`,
          tone: "warn",
        },
        inc.reference && { text: `ref ${inc.reference}`, tone: "teams" },
      ].filter(Boolean),
    });
    // Built on the server by the same function the real page uses.
    renderHeaders(els.headers, (h.voipHeaders ?? []).map((x) => [x.key, x.value]));
  }
  renderToastStatus();
}

/** The status pill follows the page: ringing, on the call, accepted, missed, voicemail. */
function renderToastStatus() {
  const pill = els.toast.querySelector(".pk-ringing");
  const h = view.handoff;
  if (!pill || !h) return;
  const last = view.snap?.attempts?.at(-1);
  const same = last && last.level === h.level && last.attempt === h.attempt;
  const outcome = same ? last.outcome : "ringing";
  const [text, tone] = OUTCOMES[outcome] ?? OUTCOMES.ringing;
  pill.textContent = text;
  els.toast.dataset.outcome = outcome;
  if (outcome === "ringing" || outcome === "calling") delete pill.dataset.tone;
  else pill.dataset.tone = tone;
}

/** A one-line report can be the topic again, in quotes. Say it once. */
function sameWords(summary, topic) {
  const plain = (s) =>
    String(s ?? "")
      .replace(/^(tenant|caller) said:\s*/i, "")
      .replace(/[“”"…,.!?·\s]+/g, " ")
      .trim()
      .toLowerCase();
  return Boolean(summary) && plain(summary) === plain(topic);
}

/**
 * The right-hand card follows the story: the fields the agent captured until
 * a page goes out, then the page as the technician's phone shows it.
 */
function renderPageCard() {
  const paged = Boolean(view.handoff);
  els.pageCard.dataset.paged = String(paged);
  els.draft.hidden = paged;
  els.paged.hidden = !paged;
  els.pageTitle.textContent = paged ? "What the technician sees" : "What the agent captured";
  els.pageTag.textContent = paged ? "mock Teams" : "structured";
  els.pageTag.title = paged
    ? "A stand-in for the Teams client, built from the same fields and headers a real page carries"
    : "Structured fields, not a transcript — the page is built from these";
  if (paged) renderVoicemail();
  else renderDraftNote();
}

/** Before a page: where the captured fields stand, or where they went instead. */
function renderDraftNote() {
  const snap = view.snap;
  const wo = snap?.workOrder;
  els.draftNote.textContent = !snap
    ? "Nobody has been paged yet."
    : snap.state === "work-order"
      ? `Nobody was paged — it's routine, so these fields went to the office as work order ${wo?.reference ?? ""}.`.replace(" .", ".")
      : snap.state === "duplicate"
        ? "No second page — this unit was already reported."
        : snap.state === "ended"
          ? "Nothing was paged — the call ended before the report was complete."
          : snap.state === "cancelled"
            ? "The demo call ended before anyone was paged."
            : snap.state === "paging"
              ? "Paging the on-call technician with these fields…"
              : "Nobody has been paged yet — the agent is still taking the report.";
}

/** What voicemail heard instead of the brief, and everything that was left out. */
function renderVoicemail() {
  const snap = view.snap;
  const vm = snap?.voicemail;
  const show = Boolean(vm && snap.attempts?.at(-1)?.outcome === "voicemail");
  els.voicemailBox.hidden = !show;
  if (!show) return;
  els.vmNote.textContent = `for ${vm.contactName} · reference ${vm.reference}`;
  els.vmPrompt.textContent = vm.prompt;
  const items = vm.withheld ?? [];
  const leaked = items.filter((w) => !w.withheld);
  const list = leaked.length ? leaked : items;
  els.vmLeftOut.dataset.tone = leaked.length ? "err" : "ok";
  els.vmLeftOut.innerHTML = `<span>${leaked.length ? "Included:" : "Left out:"}</span>${list
    .map((w) => chip(lowerFirst(w.label), leaked.length ? "err" : "ok"))
    .join("")}`;
}

// ------------------------------------------------------------ the policy

/** What the page may say, and when: four rules, checked against what happened. */
function renderChecksPanel() {
  const snap = view.snap;
  const cls = snap?.classification;
  const vm = snap?.voicemail;
  const attempts = snap?.attempts ?? [];
  const tenant = tenantName(snap);
  const whose = tenant === "the tenant" ? "the tenant's" : `${tenant}'s`;

  const severity = !cls?.final
    ? {
        detail: `Severity comes from rules in config — emergency keywords, urgent issues, the ${paging.noHeatThresholdF}°F no-heat line — not from the model.`,
        tone: "idle",
      }
    : snap.state === "work-order"
      ? { detail: `Routine (${cls.matchedRule}) — a work order, nobody woken`, tone: "ok" }
      : snap.state === "duplicate"
        ? { detail: "Already reported — attached, no second page", tone: "ok" }
        : {
            detail: `${cap(cls.severity)} (${cls.matchedRule}) — ${cls.severity === "emergency" ? "the 911 line first, then paged" : "paged"}`,
            tone: "ok",
          };

  const numbers = view.bridged
    ? {
        detail: view.guarded
          ? `Asked for ${whose} number, refused — connected through the server instead`
          : "Connected through the server — neither saw the other's number",
        tone: "ok",
      }
    : view.guarded
      ? { detail: `Asked for ${whose} number — refused, offered to connect them instead`, tone: "warn" }
      : snap?.brief
        ? { detail: "The brief, the card and the headers carry a masked callback only", tone: "ok" }
        : { detail: "The server dials; a page carries a masked callback only", tone: "idle" };

  const leaked = (vm?.withheld ?? []).filter((w) => !w.withheld);
  const kept = (vm?.withheld ?? []).filter((w) => w.withheld).map((w) => lowerFirst(w.label));
  const voicemail = !vm
    ? { detail: "Voicemail would get a callback prompt and a reference — nothing else", tone: "idle" }
    : leaked.length
      ? { detail: `Included: ${leaked.map((w) => lowerFirst(w.label)).join(", ")}`, tone: "err" }
      : { detail: `Left out: ${kept.join(", ")}`, tone: "ok" };

  const timer = {
    detail: `${paging.attemptsPerLevel} tries per level, ${gapFor(snap)} min apart · ops alert at ${paging.unacknowledgedAlertMinutes} min`,
    tone:
      snap?.nextPage && !terminal(snap)
        ? "accent"
        : attempts.some((a) => a.escalatedFrom) || attempts.length > 1
          ? "ok"
          : "idle",
  };

  renderChecks(els.checks, [
    { label: "Wake someone only when the policy says so", ...severity },
    { label: "No phone numbers on a page", ...numbers },
    { label: "Voicemail hears a callback prompt only", ...voicemail },
    { label: "Escalate on a timer, not a hunch", ...timer },
  ]);
}

// ---------------------------------------------------------------- metrics

function renderStats(stats) {
  if (!stats) return;
  renderMetrics(els.metrics, [
    ["Incidents", stats.incidents],
    ["Pages", stats.pages],
    ["Acknowledged", stats.acknowledgements],
    ["Escalations", stats.escalations],
    ["Voicemails", stats.voicemails],
    ["Work orders", stats.workOrders],
    ["Median time to acknowledge", stats.medianMsToAcknowledge == null ? "—" : mmss(stats.medianMsToAcknowledge)],
  ]);
}

async function refreshStats({ highlight = false } = {}) {
  try {
    renderStats(await getJson("/api/stats"));
    if (highlight) flash(els.metrics);
  } catch {
    // Keep the last numbers on screen.
  }
}

/** The closing beat: wait for the story to finish, then show the numbers. */
async function showMetrics() {
  for (let i = 0; i < 30 && !session.finished; i += 1) await sleep(100);
  await refreshStats({ highlight: true });
  els.metrics.scrollIntoView({ behavior: "smooth", block: "end" });
}

// ------------------------------------------------------------- demo clock

/** Moves the demo clock forward; the server runs whatever falls due on the way. */
async function advanceClock(minutes) {
  try {
    const res = await postJson("/api/demo/clock/advance", { minutes, callId: session.id ?? undefined });
    applySnapshot(res.snapshot);
    await clock.refresh();
    return res;
  } catch (error) {
    if (error.status !== 403) throw error;
    notify("This server answers real calls, so the demo clock stays on real time.", "warn", 6000);
    return null;
  }
}

/** The technician's phone rings through to voicemail (simulation only). */
async function leaveVoicemail() {
  if (!session.id) throw new Error("Start a call first.");
  const res = await postJson(`/api/simulate/${encodeURIComponent(session.id)}/voicemail`, {});
  applySnapshot(res.snapshot);
  return res;
}

// ----------------------------------------------------------- server state

async function loadHealth() {
  try {
    health = await getJson("/health");
  } catch {
    return;
  }
  live = renderMode(els.mode, health);
  els.reset.disabled = live;
  if (live) els.reset.title = "Demo controls are off while this server answers real calls.";
  const name = typeof health.organization === "string" ? health.organization : health.organization?.name;
  if (name) org = name;
  els.org.textContent = org;
  document.title = `${org} — On-call pager`;
  Object.assign(paging, health.paging ?? {});
  if (stack) stack.setLive(live);
  else stack = mountStack($("stack"), { live, nodes: stackNodes() });
  render();
}

/** After a hub reconnect: catch up on anything missed while it was down. */
async function refreshAll() {
  await Promise.all([loadHealth(), clock.refresh(), refreshStats()]);
  if (!session.id || session.finished) return;
  try {
    applySnapshot(await getJson(`/api/calls/${encodeURIComponent(session.id)}`));
  } catch {
    session.end();
    transcript.system("The demo server restarted — answer a new call.");
    render();
  }
}

function clearPanels() {
  view = blankView();
  transcript.clear();
  trail.clear();
  clearTeamsToast(els.toast);
  delete els.toast.dataset.outcome;
  renderHeaders(els.headers, []);
  win.hide();
  render();
}

// ------------------------------------------------------- manual controls

/** A manual control takes over from the director. */
async function act(fn) {
  if (director.running) director.stop();
  try {
    await fn();
  } catch (error) {
    notify(error.message, "err");
  }
}

els.newCall.addEventListener("click", () => act(() => perform({ type: "start" })));

els.sayForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.sayInput.value.trim();
  if (!text || sending || els.sayInput.disabled) return;
  sending = true;
  act(async () => {
    await voice.speak("caller", text);
    await perform({ type: "say", text });
    els.sayInput.value = "";
  }).finally(() => {
    sending = false;
  });
});

els.keys.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-digit]");
  if (button && !button.disabled) act(() => perform({ type: "dtmf", digit: button.dataset.digit }));
});

els.voicemail.addEventListener("click", () => act(() => perform({ type: "action", action: "voicemail" })));

els.skip.addEventListener("click", () =>
  act(async () => {
    const next = view.snap?.nextPage;
    if (next) await advanceClock(Math.max(0.1, dueInNow(next) / 60_000 + 0.02));
  }),
);

els.silence.addEventListener("click", () => act(() => perform({ type: "silence" })));
els.hangup.addEventListener("click", () => act(() => perform({ type: "hangup" })));

els.reset.addEventListener("click", async () => {
  director.stop();
  try {
    const result = await postJson("/api/demo/reset");
    session.reset();
    clearPanels();
    els.callerSelect.selectedIndex = 0;
    renderStats(result.stats);
    await clock.refresh();
    quietLoad = true;
    try {
      director.load(0);
    } finally {
      quietLoad = false;
    }
    notify("Demo reset — clean audit, starting clock, beat 1.", "ok");
  } catch (error) {
    if (error.status === 403) notify("Reset is off while this server answers real calls.", "warn");
    else notify(error.message, "err");
  }
});
