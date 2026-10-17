/**
 * The information line console.
 *
 * A viewer of the server's grounding policy, never a second copy of it. Every
 * decision on screen — which article the agent may use, whether it needs a
 * caveat, whether it is withheld as out of date, whether a person can take the
 * call — is one the server made and published over the hub; this file only
 * explains it. The plumbing every template shares (hub, call session, demo
 * director, Teams toast, checks, trail) comes from the presenter kit, and the
 * on-stage script lives in beats.js.
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
  toneOf,
  setStateChip,
  renderBudget,
  renderDecision,
  renderChecks,
  renderFacts,
  renderList,
  renderMetrics,
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

// Fictional caller IDs. The information line looks nobody up, so a caller is
// only ever a masked number.
const CALLERS = [
  { phone: "+14255550123", label: "(425) 555-0123" },
  { phone: "+14255550145", label: "(425) 555-0145" },
  { phone: "+14255550167", label: "(425) 555-0167" },
  { phone: "", label: "Number withheld" },
];

const els = {
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
  silence: $("silence"),
  hangup: $("hangup"),
  decision: $("decision"),
  checks: $("checks"),
  facts: $("facts"),
  library: $("library"),
  toast: $("toast"),
  toastEmpty: $("toastEmpty"),
  headers: $("headers"),
  metrics: $("metrics"),
};

const TERMINAL = new Set(["transferred", "closed", "ended"]);
const AGENT = "Contoso assistant";
const CALLER = "Caller";
const DESK = "Contoso information desk";

/** Why the agent asked for a person, as the request_human tool line shows it. */
const ASKED_BECAUSE = {
  caller_requested: "the caller asked",
  explicit_request: "the caller asked",
  dtmf_0: "pressed 0",
  no_input: "the caller couldn't be heard",
  time_budget_expired: "out of time",
  expired_content: "the answer is out of date",
  retrieval_miss: "no approved answer",
  service_request: "a service request",
  eligibility_review: "eligibility is a staff decision",
};

/** A handoff, explained. Policy handoffs are the guardrail working, so they read as ok. */
const HANDOFF = {
  eligibility_review: {
    why: "Whether someone qualifies is a staff decision. The agent read out the published criteria and offered a person to decide.",
    verdict: "eligibility → a person decides",
    tone: "ok",
  },
  expired_content: {
    why: "The only matching article is out of date, so the agent couldn't answer from it. It offered a person who can confirm the current rules.",
    verdict: "out of date → a person",
    tone: "ok",
  },
  service_request: {
    why: "This line answers questions from approved content; it can't file service requests. The agent said so and offered a person.",
    verdict: "service request → a person",
    tone: "ok",
  },
  retrieval_miss: {
    why: "Nothing approved matched well enough to answer from, so the agent didn't guess. It offered a person instead.",
    verdict: "no approved answer → a person",
    tone: "ok",
  },
  caller_requested: {
    why: "The caller asked for a person. That always works while the desk is staffed, with no questions first.",
    verdict: "asked for a person",
    tone: "accent",
  },
  dtmf_0: {
    why: "The caller pressed 0. A keypress is unambiguous, so there's nothing to confirm.",
    verdict: "keypad 0 → a person",
    tone: "accent",
  },
  no_input: {
    why: "The agent couldn't hear the caller twice, so it handed over rather than hang up on them.",
    verdict: "couldn't hear → a person",
    tone: "warn",
  },
  time_budget_expired: {
    why: "The call reached its time limit, so the caller goes to a person instead of going around in circles.",
    verdict: "out of time → a person",
    tone: "warn",
  },
};
HANDOFF.explicit_request = HANDOFF.caller_requested;

// Defaults until /health and /api/content answer; the server's numbers win.
const policy = { minScore: 2.5, expiryGraceDays: 90, timeBudgetMs: 300_000 };

let health = null;
let live = false;
let library = { articles: [], desk: null };
let librarySeq = 0;
let stack = null;
let clockLocked = false;
let sending = false;
let view = blankView();

/** What the console has learned about the call on screen, beyond its snapshot. */
function blankView() {
  return {
    snap: null,
    decision: null, // the server's latest decision for this call
    grounding: null, // the latest answer, expired or miss decision: what the source panel explains
    handoff: null,
    transferFailed: false,
    declined: false, // the caller turned down the last offer of a person
    frozenMs: null,
    syncedAt: 0,
  };
}

const terminal = (snap) => TERMINAL.has(snap?.state);
const masked = (snap) => (snap?.maskedPhone && snap.maskedPhone !== "anonymous" ? snap.maskedPhone : "Number withheld");
const dayCount = (n) => `${n} day${Number(n) === 1 ? "" : "s"}`;
const upperFirst = (s) => (s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : "");
const lowerFirst = (s) => (s ? `${s.charAt(0).toLowerCase()}${s.slice(1)}` : "");
/** Adds a period unless the text already ends in one ("…until 5 p.m."). */
const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
// The policy runs on the demo clock in simulation; a live server keeps real time.
const onClock = () => (live ? "" : " on the demo clock");

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
/** Review dates are calendar dates: "2027-02-15" → "Feb 15, 2027". */
function fmtDate(iso) {
  if (!iso) return "";
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? DATE.format(t) : String(iso);
}

const stackNodes = () =>
  voiceStack({
    voiceLive: health?.voiceLive?.model ?? "gpt-realtime",
    tools: "Grounding policy",
    toolsSim: "real policy code",
    agent: "Teams call queue",
    agentSim: "mock toast",
  });

// ------------------------------------------------------------------ wiring

const voice = createVoice($("voice"), { lang: "en-US" });
// Freshness and open or closed follow the clock, so the library does too.
const clock = mountClock($("clock"), { onChange: () => refreshLibrary() });
const transcript = createTranscript($("transcript"), {
  voice,
  empty: "Answer a call, or press Next ▶ to run the demo script.",
});
const trail = createTrail($("events"), {
  good: ["answer_recorded", "citation_spoken"],
  warn: ["retrieval_miss", "desk_closed_noted", "offer_declined"],
  timeZone: () => clock.state?.timeZone,
  empty: "Every search, answer, refusal and handoff shows up here.",
});
const session = createCallSession({ voice, onMessage, onFollow: () => clearPanels() });
connectHub((target, payload) => session.handle(target, payload), {
  onOpen: ({ reconnected }) => reconnected && refreshAll(),
});
const sim = createSimulator({ session, startBody, onSnapshot: applySnapshot, actions: { metrics: showMetrics } });
const director = createDirector($("director"), {
  beats: createBeats({ setClock }),
  perform,
  voice,
  sayInput: els.sayInput,
  onBeat: () => {
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: "smooth" });
  },
});

setInterval(tickBudget, 500);
// Review dates and the desk's hours follow the clock, so keep the list honest.
setInterval(refreshLibrary, 60_000);
boot();

async function boot() {
  renderCallers();
  renderHeaders(els.headers, []);
  render();
  await Promise.all([loadHealth(), refreshLibrary(), refreshStats()]);
  stack ??= mountStack($("stack"), { nodes: stackNodes() });
  render();
}

// ------------------------------------------------------------- call steps

function startBody(step) {
  const phone = "fromPhone" in step ? (step.fromPhone ?? "") : els.callerSelect.value;
  els.callerSelect.value = phone;
  return { fromPhone: phone || null };
}

/** Director and button steps. A new call hangs up the one on screen first. */
async function perform(step) {
  if (step.type === "start") {
    // A quick Next shouldn't cut off a handoff that is about to land.
    const deadline = performance.now() + 3000;
    while (view.snap?.state === "transferring" && performance.now() < deadline) await sleep(100);
    if (session.id && !session.finished && !session.followed) await sim.hangup().catch(() => {});
    clearPanels();
  }
  return sim.perform(step);
}

/** Beats pin the demo clock. A server answering real calls keeps real time. */
async function setClock(preset) {
  try {
    await clock.set({ preset });
  } catch (error) {
    if (error.status !== 403) throw error;
    if (!clockLocked) {
      clockLocked = true;
      notify("This server answers real calls, so the demo clock stays on real time.", "warn", 6000);
    }
  }
}

// -------------------------------------------------------------------- hub

function onMessage(target, payload) {
  stack?.onHub(target, payload);
  switch (target) {
    case "state":
      applySnapshot(payload);
      break;
    case "transcript":
      transcript.add(payload.role, payload.text, { label: payload.role === "agent" ? AGENT : CALLER });
      break;
    case "event":
      onEvent(payload);
      break;
    case "search":
      onSearch(payload);
      break;
    case "decision":
      acceptDecision(payload);
      render();
      break;
    case "handoff":
      view.handoff = payload;
      renderHandoff();
      render();
      break;
  }
}

/**
 * Snapshots arrive twice — over the hub and in each simulate response — and
 * not always in order. Older ones, and anything after the call finished, are
 * ignored.
 */
function applySnapshot(snap) {
  if (!snap?.id) return;
  if (session.id && snap.id !== session.id) return;
  const prev = view.snap?.id === snap.id ? view.snap : null;
  if (prev && terminal(prev) && !terminal(snap)) return;
  if (prev && (snap.elapsedMs ?? 0) < (prev.elapsedMs ?? 0)) return;

  view.snap = snap;
  view.syncedAt = performance.now();
  if (snap.decision) acceptDecision(snap.decision);

  if (terminal(snap) && !terminal(prev)) refreshStats({ highlight: true });
  render();
}

/** The server re-decides as a call goes on (cited, offer made); keep the newest. */
function acceptDecision(d) {
  if (!d?.kind) return;
  const at = Date.parse(d.at ?? "");
  const seen = Date.parse(view.decision?.at ?? "");
  if (Number.isFinite(at) && Number.isFinite(seen) && at < seen) return;
  view.decision = d;
  if (d.kind === "answer" || d.kind === "expired" || d.kind === "miss") view.grounding = d;
}

/** What the search tool handed back — or held back — shown inline. */
function onSearch(s) {
  const top = s.passages?.[0];
  if (top) {
    const stale = top.freshness === "stale";
    transcript.tool(
      "search_content",
      `${top.articleId} · score ${top.score} · ${
        stale ? `${dayCount(top.overdueDays)} past review — answer with a caveat` : "within its review date"
      }`,
      stale ? "warn" : "ok",
    );
  } else if (s.expiredMatch) {
    const w = s.withheld?.[0];
    transcript.tool(
      "search_content",
      w ? `${w.articleId} · ${dayCount(w.overdueDays)} past review — withheld` : "an out-of-date match — withheld",
      "err",
    );
  } else {
    transcript.tool("search_content", `nothing above the bar (${policy.minScore})`, "warn");
  }
}

function onEvent(e) {
  trail.add(e);
  const detail = String(e.detail ?? "");
  const meta = e.meta ?? {};
  switch (e.kind) {
    case "answer_recorded":
      transcript.tool(
        "record_answer",
        meta.stale ? `${detail} · due for review — caveat required` : `${detail} · source named`,
        meta.stale ? "warn" : "ok",
      );
      stack?.flow(["voice-live", "tools"]);
      break;
    case "citation_spoken":
      transcript.system(`Source read out: ${meta.shortUrl ?? ""} · ${detail}`);
      stack?.flow(["voice-live", "tools"]);
      break;
    case "human_requested":
      transcript.tool("request_human", ASKED_BECAUSE[detail] ?? detail.replace(/_/g, " "), "accent");
      stack?.flow(["voice-live", "tools"]);
      break;
    case "human_offered":
      view.declined = false;
      break;
    case "offer_declined":
      view.declined = true;
      break;
    case "after_hours_closed":
      transcript.system(
        detail && detail !== "closed"
          ? `Desk closed${onClock()} — no transfer. It opens again ${detail.replace(/\.?$/, ".")}`
          : `Desk closed${onClock()} — no transfer.`,
      );
      break;
    case "retrieval_miss":
      if (detail === "service_request") transcript.system("A service request — this line can't file one");
      break;
    case "dtmf":
      transcript.tool("keypad", detail === "0" ? "0 → a person" : `${detail} — not on the menu`, "accent");
      break;
    case "no_input":
      transcript.system("— the caller says nothing —");
      break;
    case "transfer_simulated":
    case "transfer_succeeded":
      transcript.system(`↪ Handed over to the ${detail || DESK} in Teams`);
      break;
    case "transfer_failed":
      view.transferFailed = true;
      transcript.system(`Transfer failed: ${detail}`);
      break;
    case "budget_expired":
      transcript.system("Out of time — sending the caller to a person");
      break;
    case "tool_rejected":
      transcript.tool("rejected", detail, "err");
      break;
  }
  render();
}

// ----------------------------------------------------------------- render

function render() {
  const snap = view.snap;
  setStateChip(els.stateChip, snap?.state ?? null, chipTone(snap));
  renderControls();
  renderDecision(els.decision, { ...headline(snap), empty: "Answer a call to see what the server lets the agent say." });
  renderChecks(els.checks, checks(snap));
  renderSource();
  renderLibrary();
  renderToastPlaceholder();
  tickBudget();
}

function chipTone(snap) {
  if (!snap) return "idle";
  if (snap.state !== "closed") return toneOf(snap.state);
  const outcome = String(snap.outcome ?? "");
  if (outcome.startsWith("after_hours")) return "warn";
  if (outcome === "transfer_failed") return "err";
  return outcome === "caller_done" ? "ok" : "muted";
}

function renderControls() {
  const snap = view.snap;
  const active = Boolean(
    session.id && !session.finished && !session.followed && snap && !terminal(snap) && snap.state !== "transferring",
  );
  for (const el of [els.sayInput, els.sayBtn, els.silence, els.hangup]) el.disabled = !active;
  for (const button of els.keys.querySelectorAll("button")) button.disabled = !active;
}

/** The headline: what the server decided, and why, in plain English. */
function headline(snap) {
  if (!snap) return {};
  const d = view.decision;

  if (view.transferFailed) {
    return {
      headline: "Couldn't connect",
      why: "The transfer to the information desk failed, so the agent apologized, gave the staffed hours and contoso.gov, and ended the call rather than leave the caller on hold.",
      verdict: "transfer failed",
      tone: "err",
    };
  }
  if (d?.kind === "after_hours") {
    const h = d.hours ?? {};
    const when = h.localTime ? `it's ${h.localTime}${onClock()}` : `the desk is closed${onClock()}`;
    const staffed = h.hoursText ? `, and the desk is staffed ${lowerFirst(h.hoursText)}` : "";
    return {
      headline: "The information desk is closed",
      why: `${sentence(`${upperFirst(d.why ?? "the caller asked for a person")}, but ${when}${staffed}`)} The server checked the hours, not the model, and it won't transfer a caller into an empty queue. The agent gave the next opening${
        h.nextOpening ? `, ${h.nextOpening},` : ""
      } and pointed to contoso.gov.`,
      verdict: "after hours → next opening, no transfer",
      tone: "warn",
    };
  }
  if (d?.kind === "handoff") return handoffDecision(snap, d);
  if (view.grounding) return groundingDecision(snap, view.grounding);
  if (terminal(snap)) {
    return {
      headline: "Call ended",
      why: snap.outcome === "caller_hung_up" ? "The caller hung up before asking anything." : "The caller finished before asking anything.",
      verdict: "nothing to answer",
      tone: "muted",
    };
  }
  return {
    headline: "Listening…",
    why: "The model searches approved city content. The server decides which articles it may use, when it must add a caveat, and whether a person can take the call.",
  };
}

function handoffDecision(snap, d) {
  const queue = d.queue ?? DESK;
  const copy = HANDOFF[d.reason] ?? { why: sentence(upperFirst(d.why ?? "the call needs a person")), verdict: "a person", tone: "accent" };
  const closes = d.hours?.closesAt;
  return {
    headline: snap.state === "transferred" ? `Handed to the ${queue}` : `Connecting to the ${queue}`,
    why: `${copy.why} ${closes ? `The desk is staffed until ${closes}, so the server transfers.` : "The desk is staffed, so the server transfers."}`,
    verdict: copy.verdict,
    tone: copy.tone,
  };
}

function groundingDecision(snap, g) {
  const offer = offerText(snap, g);
  if (g.kind === "answer") {
    const p = g.passage ?? {};
    if (g.personal) {
      return {
        headline: "Criteria only — staff decide",
        why: `The caller described their own situation. The agent read out the published criteria from ${p.title}, but it doesn't rule on whether someone qualifies: that's a staff decision. Numbers the caller said were masked before the search and the audit log.${offer}`,
        verdict: "criteria read out · staff decide",
        tone: "accent",
      };
    }
    if (g.stale) {
      const expires = p.expiresInDays ? ` In ${dayCount(p.expiresInDays)}, it stops being read out at all.` : "";
      return {
        headline: "Answered — with a caveat",
        why: `${p.title} was due for review by ${fmtDate(p.reviewBy)}, ${dayCount(p.overdueDays)} ago. That's inside the ${
          g.expiryGraceDays ?? policy.expiryGraceDays
        }-day grace period, so the server let the agent use it, but only with a caveat and the short URL ${p.shortUrl}.${expires}${offer}`,
        verdict: "due for review → caveat",
        tone: "warn",
      };
    }
    const place = p.hoursNow ? ` Whether ${p.hoursNow.place ?? "it"} is open right now came from the server's clock, not the model.` : "";
    const staff = g.eligibility ? " Eligibility itself is a staff decision, and the agent says so." : "";
    return {
      headline: `Answered from ${p.title}`,
      why: `The agent may only answer from approved content. ${p.title} was reviewed ${fmtDate(p.lastReviewed)} and is good until ${fmtDate(
        p.reviewBy,
      )}.${place}${staff}${offer}`,
      verdict: g.cited ? "grounded · source read out" : "grounded · source named",
      tone: "ok",
    };
  }
  if (g.kind === "expired") {
    const w = g.withheld?.[0];
    return {
      headline: "Out of date — not read out",
      why: `The search found ${w?.title ?? "a match"}, but it's ${w ? `${dayCount(w.overdueDays)} ` : ""}past its review date, beyond the ${
        g.expiryGraceDays ?? policy.expiryGraceDays
      }-day grace period. The server withheld it: the model was told only that an out-of-date match exists, so it can't read the old rules out as fact.${offer}`,
      verdict: "expired → withheld",
      tone: "err",
    };
  }
  if (g.reason === "service_request") {
    return {
      headline: "Not something this line can do",
      why: `It's a service request, and this line only answers questions from approved content. The agent didn't pretend to file it.${offer}`,
      verdict: "service request → offer a person",
      tone: "warn",
    };
  }
  return {
    headline: "No approved answer",
    why: `Nothing in the approved content scored ${g.minScore ?? policy.minScore} or more, so the agent didn't guess.${offer}`,
    verdict: "no match → don't guess",
    tone: "warn",
  };
}

/** What the agent offered next: a person, or the desk's next opening. */
function offerText(snap, g) {
  const o = g.offer;
  if (!o) return "";
  if (!o.staffed) {
    return ` The desk is closed${onClock()}, so instead of a transfer the agent gave the next opening${o.nextOpening ? `, ${o.nextOpening}` : ""}.`;
  }
  // Ending the call with the offer still open is a no, too.
  const no = view.declined || (snap.outcome === "caller_done" && snap.offeredTransfer);
  return no ? " It offered a person; the caller didn't need one." : " It offered a person.";
}

// ------------------------------------------------------------------ checks

function checks(snap) {
  if (!snap) return [];
  const g = view.grounding;
  const items = [];
  if (g?.kind === "miss" && g.reason === "service_request") {
    items.push({ label: "A question this line can answer", detail: "a service request — this line answers from approved content only", tone: "warn" });
  } else if (g?.kind === "miss") {
    items.push({
      label: "Approved content matches",
      detail: `nothing scored ${g.minScore ?? policy.minScore} or more — the agent won't guess`,
      tone: "warn",
    });
  } else if (g?.kind === "expired") {
    const w = g.withheld?.[0];
    const grace = g.expiryGraceDays ?? policy.expiryGraceDays;
    items.push({
      label: "Approved content matches",
      detail: w ? `${w.articleId} · score ${w.score} — the bar is ${policy.minScore}` : "an article matched",
      tone: "ok",
    });
    items.push({
      label: "Within its review date",
      detail: `${w ? `${dayCount(w.overdueDays)} past review` : "past review"}, beyond the ${grace}-day grace — withheld from the model`,
      tone: "err",
    });
  } else if (g?.kind === "answer") {
    const p = g.passage ?? {};
    const grace = g.expiryGraceDays ?? policy.expiryGraceDays;
    items.push({ label: "Approved content matches", detail: `${p.articleId} · score ${p.score} — the bar is ${policy.minScore}`, tone: "ok" });
    items.push(
      p.freshness === "stale"
        ? {
            label: "Within its review date",
            detail: `${dayCount(p.overdueDays)} past review, inside the ${grace}-day grace — caveat required`,
            tone: "warn",
          }
        : { label: "Within its review date", detail: `good until ${fmtDate(p.reviewBy)}`, tone: "ok" },
    );
    items.push({ label: "Source named", detail: g.cited ? `${p.source} · read out: ${p.shortUrl}` : p.source, tone: "ok" });
    if (p.hoursNow) {
      const h = p.hoursNow;
      items.push({
        label: `${h.place ?? "Open"} open now`,
        detail: h.open
          ? `open until ${h.closesAt}${onClock()}`
          : `closed${onClock()}${h.nextOpening ? ` — opens again ${h.nextOpening}` : ""}`,
        tone: h.open ? "ok" : "warn",
      });
    }
    if (g.eligibility) {
      items.push({
        label: "Eligibility decided by staff",
        detail: g.personal ? "the caller's own situation — criteria only, staff decide" : "the agent reads out the criteria; staff decide",
        tone: "accent",
      });
    }
  } else {
    items.push({
      label: "Approved content matches",
      detail: `the agent may only answer from city articles that score ${policy.minScore} or more`,
      tone: "idle",
    });
    items.push({
      label: "Within its review date",
      detail: `past review: a caveat; more than ${policy.expiryGraceDays} days past: not read out`,
      tone: "idle",
    });
    items.push({ label: "Source named", detail: "every answer names its source", tone: "idle" });
  }
  items.push(deskCheck(snap));
  return items;
}

/** Shown once a person comes into it: an offer, a handoff, or after hours. */
function deskCheck(snap) {
  const d = view.decision;
  const g = view.grounding;
  let h = null;
  if (d?.kind === "handoff" || d?.kind === "after_hours") h = d.hours ?? {};
  else if (g?.offer) h = { staffed: g.offer.staffed, nextOpening: g.offer.nextOpening, closesAt: snap.hours?.closesAt };
  if (!h) return null;
  const staffed = h.staffed ?? h.open;
  return staffed
    ? {
        label: "A person is available",
        detail: h.closesAt ? `the information desk is staffed until ${h.closesAt}` : "the information desk is staffed",
        tone: "ok",
      }
    : {
        label: "A person is available",
        detail: `not now — the desk is closed${onClock()}${h.nextOpening ? ` and opens again ${h.nextOpening}` : ""}`,
        tone: "warn",
      };
}

// ------------------------------------------------------------------ source

const mono = (text) => `<span class="mono">${escapeHtml(text ?? "")}</span>`;

function renderSource() {
  const g = view.grounding;
  if (!view.snap) {
    renderFacts(els.facts, []);
    return;
  }
  if (g?.kind === "answer") {
    const p = g.passage ?? {};
    const stale = p.freshness === "stale";
    const grace = g.expiryGraceDays ?? policy.expiryGraceDays;
    renderFacts(els.facts, [
      ["Content id", mono(p.articleId), { html: true }],
      ["Article", p.section ? `${p.title} · ${p.section}` : p.title],
      ["Source", p.source],
      ["Owner", p.owner],
      ["Last reviewed", fmtDate(p.lastReviewed)],
      ["Review by", stale ? `${fmtDate(p.reviewBy)} · ${dayCount(p.overdueDays)} ago` : fmtDate(p.reviewBy), stale ? { tone: "warn" } : {}],
      [
        "Freshness",
        stale ? `due for review — inside the ${grace}-day grace, caveat required` : "within its review date",
        { tone: stale ? "warn" : "ok" },
      ],
      ["Short URL", g.cited ? `${p.shortUrl} · read out to the caller` : p.shortUrl],
    ]);
    return;
  }
  if (g?.kind === "expired") {
    const w = g.withheld?.[0] ?? {};
    renderFacts(els.facts, [
      ["Content id", mono(w.articleId), { html: true }],
      ["Article", w.title],
      ["Source", w.source],
      ["Owner", w.owner],
      ["Last reviewed", fmtDate(w.lastReviewed)],
      ["Review by", `${fmtDate(w.reviewBy)} · ${dayCount(w.overdueDays)} ago`, { tone: "err" }],
      ["Freshness", `expired — more than ${g.expiryGraceDays ?? policy.expiryGraceDays} days past review`, { tone: "err" }],
      ["Shown to the model", "only that an out-of-date match exists", { tone: "err" }],
    ]);
    return;
  }
  const none =
    g?.kind === "miss"
      ? g.reason === "service_request"
        ? "none — a service request isn't answered from content"
        : "none — nothing approved matched, so nothing was read out"
      : "none yet — the agent hasn't answered from content";
  renderFacts(els.facts, [["Source", none, { tone: "muted" }]]);
}

// ---------------------------------------------------------------- library

function activeArticleId() {
  const g = view.grounding;
  if (g?.kind === "answer") return g.passage?.articleId ?? null;
  if (g?.kind === "expired") return g.withheld?.[0]?.articleId ?? null;
  return null;
}

/** The desk, plus every article that isn't simply current — judged on the clock. */
function renderLibrary() {
  const items = [];
  const desk = library.desk;
  if (desk) {
    const kind = view.decision?.kind;
    items.push({
      label: "Information desk",
      meta: [desk.hoursText, desk.queue].filter(Boolean).join(" · "),
      status: desk.staffed ? "staffed" : "closed",
      tone: desk.staffed ? "ok" : "muted",
      active: kind === "handoff" || kind === "after_hours",
    });
  }
  const activeId = activeArticleId();
  let current = 0;
  for (const a of library.articles) {
    const active = a.id === activeId;
    if (a.status === "stale") {
      items.push({
        label: a.title,
        meta: `${dayCount(a.overdueDays)} past review${a.expiresInDays ? ` · read out with a caveat for ${dayCount(a.expiresInDays)} more` : ""}`,
        status: "caveat",
        tone: "warn",
        active,
      });
    } else if (a.status === "expired") {
      items.push({ label: a.title, meta: `${dayCount(a.overdueDays)} past review`, status: "withheld", tone: "err", active });
    } else if (active) {
      items.push({ label: a.title, meta: `review by ${fmtDate(a.reviewBy)}`, status: "current", tone: "ok", active });
    } else {
      current += 1;
    }
  }
  if (current) items.push({ label: `${current} more article${current === 1 ? "" : "s"} within their review dates`, status: "current", tone: "ok" });
  renderList(els.library, items, { empty: "Loading the content index…" });
}

function renderCallers() {
  els.callerSelect.innerHTML = CALLERS.map(
    (c) => `<option value="${escapeHtml(c.phone)}">${escapeHtml(c.label)}</option>`,
  ).join("");
}

// ----------------------------------------------------------------- budget

/** The call's time budget stops once the call is handed over or over. */
function budgetStop(snap) {
  if (snap.state === "transferred") return "handed over";
  if (snap.state === "transferring") return "connecting";
  if (terminal(snap)) return "ended";
  return null;
}

function tickBudget() {
  const snap = view.snap;
  if (!snap) {
    els.budget.hidden = true;
    return;
  }
  const stop = budgetStop(snap);
  if (stop) view.frozenMs ??= snap.elapsedMs;
  else view.frozenMs = null;
  const elapsedMs = view.frozenMs ?? snap.elapsedMs + (performance.now() - view.syncedAt);
  renderBudget(els.budget, { elapsedMs, budgetMs: snap.budgetMs ?? policy.timeBudgetMs });
  const parts = els.budget.pkBudget;
  if (stop && parts && !els.budget.hidden) {
    parts.label.textContent += ` · ${stop}`;
    parts.fill.dataset.tone = stop === "ended" ? "muted" : "ok";
  }
}

// ------------------------------------------------------------ Teams side

function renderHandoff() {
  const h = view.handoff;
  if (!h) return;
  const g = view.grounding;
  const tags = g?.kind === "answer" && g.stale ? [{ text: "answer was due for review", tone: "warn" }] : [];
  renderTeamsToast(els.toast, {
    queue: h.queue ?? DESK,
    subtitle: "Call queue · handed over by the information line",
    topic: h.callTopic,
    context: sameWords(h.callContext, h.callTopic) ? "" : h.callContext,
    sentiment: h.callSentiment ? `Caller sounds ${h.callSentiment}` : "",
    callerHtml: `<strong>${escapeHtml(masked(view.snap))}</strong><div class="muted">Not identified — this line looks nobody up</div>`,
    avatar: h.queue ?? DESK,
    tags,
    status: h.simulated ? "Simulated — Teams not called" : "Incoming call",
  });
  els.toastEmpty.hidden = true;
  // Built on the server by the same function the real transfer uses.
  renderHeaders(els.headers, (h.voipHeaders ?? []).map((x) => [x.key, x.value]));
}

/** A one-line call's summary can be the topic again, in quotes. Say it once. */
function sameWords(summary, topic) {
  const plain = (s) =>
    String(s ?? "")
      .replace(/^caller (said|asked):\s*/i, "")
      .replace(/[“”"…,.!?\s]+/g, " ")
      .trim()
      .toLowerCase();
  return Boolean(summary) && plain(summary) === plain(topic);
}

function renderToastPlaceholder() {
  if (view.handoff) return;
  const snap = view.snap;
  els.toastEmpty.textContent = !snap
    ? "No call has been handed over yet."
    : view.transferFailed
      ? "The transfer failed — nothing reached Teams."
      : view.decision?.kind === "after_hours"
        ? `No transfer — the desk is closed${onClock()}, so nobody's Teams client rings.`
        : snap.state === "transferring"
          ? `Connecting to the ${DESK}…`
          : snap.offeredTransfer && !terminal(snap)
            ? "A person was offered — waiting for the caller's answer."
            : terminal(snap)
              ? "The call ended without a handoff."
              : "No call has been handed over yet.";
}

// ---------------------------------------------------------------- metrics

function renderStats(stats) {
  if (!stats) return;
  renderMetrics(els.metrics, [
    ["Calls", stats.calls],
    ["Answered & grounded", stats.answers],
    ["With a caveat", stats.staleAnswerCount],
    ["Refused as out of date", stats.expiredRefusals],
    ["Handed to a person", stats.transfers],
    ["Closed after hours", stats.afterHoursClosures],
    ["No approved answer", stats.misses],
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

/** The closing beat: wait for the handoff to land, then show the numbers. */
async function showMetrics() {
  for (let i = 0; i < 30 && !session.finished; i += 1) await sleep(100);
  await refreshStats({ highlight: true });
  els.metrics.scrollIntoView({ behavior: "smooth", block: "end" });
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
  if (typeof health.retrievalMinScore === "number") policy.minScore = health.retrievalMinScore;
  if (typeof health.callTimeBudgetMs === "number") policy.timeBudgetMs = health.callTimeBudgetMs;
  if (stack) stack.setLive(live);
  else stack = mountStack($("stack"), { live, nodes: stackNodes() });
}

async function refreshLibrary() {
  const seq = ++librarySeq;
  try {
    const data = await getJson("/api/content");
    if (seq !== librarySeq) return;
    library = { articles: data.articles ?? [], desk: data.desk ?? null };
    if (typeof data.minScore === "number") policy.minScore = data.minScore;
    if (typeof data.expiryGraceDays === "number") policy.expiryGraceDays = data.expiryGraceDays;
    render();
  } catch {
    // Keep the last good list.
  }
}

/** After a hub reconnect: catch up on anything missed while it was down. */
async function refreshAll() {
  await Promise.all([loadHealth(), refreshLibrary(), clock.refresh(), refreshStats()]);
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
  clearTeamsToast(els.toast, els.toastEmpty);
  renderHeaders(els.headers, []);
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
    await sim.say(text);
    els.sayInput.value = "";
  }).finally(() => {
    sending = false;
  });
});

els.keys.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-digit]");
  if (button && !button.disabled) act(() => sim.dtmf(button.dataset.digit));
});

els.silence.addEventListener("click", () => act(() => sim.silence()));
els.hangup.addEventListener("click", () => act(() => sim.hangup()));

els.reset.addEventListener("click", async () => {
  director.stop();
  try {
    const result = await postJson("/api/demo/reset");
    session.reset();
    clearPanels();
    renderStats(result.stats);
    // The clock's onChange refreshes the library on the starting clock.
    await clock.refresh();
    director.load(0);
    notify("Demo reset — clean audit, starting clock, beat 1.", "ok");
  } catch (error) {
    if (error.status === 403) notify("Reset is off while this server answers real calls.", "warn");
    else notify(error.message, "err");
  }
});
