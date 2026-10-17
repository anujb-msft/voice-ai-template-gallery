/**
 * The switchboard console.
 *
 * A viewer of the server's routing state machine, never a second copy of it.
 * Every decision on screen — the confidence gate, the business hours, the
 * destination, the handoff — is one the server made and published over the
 * hub; this file only explains it. The plumbing every template shares (hub,
 * call session, demo director, Teams toast, gauge, trail) comes from the
 * presenter kit, and the on-stage script lives in beats.js.
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
  createCountdown,
  renderDecision,
  renderGauge,
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

// Mirrors config/callers.json, so the presenter can choose who is calling.
const CALLERS = [
  { phone: "+14255550101", name: "Dana Whitfield", company: "Northwind Traders" },
  { phone: "+14255550102", name: "Marcus Bell", company: "Fabrikam" },
  { phone: "+14255550103", name: "Priya Raman", company: "Tailwind Logistics" },
  { phone: "", name: "Unknown number" },
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
  silence: $("silence"),
  hangup: $("hangup"),
  decision: $("decision"),
  gauge: $("gauge"),
  win: $("window"),
  facts: $("facts"),
  routes: $("routes"),
  toast: $("toast"),
  toastEmpty: $("toastEmpty"),
  headers: $("headers"),
  metrics: $("metrics"),
};
// The mind-change window: the transfer waits transferDelayMs before it dispatches.
const win = createCountdown(els.win);

const TERMINAL = new Set(["transferred", "ended"]);

const REASONS = {
  unresolved_intent: "Still unclear after the clarifying questions",
  time_budget_expired: "Out of time",
  repeated_out_of_scope: "Nothing we route covers it",
};

// Defaults until /health answers; the server's numbers win.
const routing = { confidenceThreshold: 0.75, maxClarifications: 2, transferDelayMs: 1200, timeBudgetMs: 90_000 };

let health = null;
let org = "Contoso";
let fallbackId = "reception";
let routesInfo = [];
let routeById = new Map();
let stack = null;
let routesSeq = 0;
let clockLocked = false;
let keysSig = "";
let sending = false;
let view = blankView();

/** What the console has learned about the call on screen, beyond its snapshot. */
function blankView() {
  return {
    snap: null,
    score: null, // { routeId, value, passes }: the last proposal the gate judged
    how: null, // why the route was committed: confirmed | dtmf | human_requested | fallback
    digit: null,
    changed: null, // { from, to }: the caller changed their mind
    fallback: null,
    transferFailed: false,
    handoff: null,
    message: null,
    lastClarify: null, // { reason, n }
    callerSpoke: false, // the caller's last turn was words, not silence
    frozenMs: null,
    syncedAt: 0,
  };
}

const label = (id) => routeById.get(id)?.label ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : "");
const fmt = (v) => Number(v).toFixed(2);
const terminal = (snap) => TERMINAL.has(snap?.state);
const humanReason = (reason) => REASONS[reason] ?? String(reason ?? "unknown").replace(/_/g, " ");
const agentLabel = () => `${org} assistant`;
const callerLabel = () => view.snap?.caller?.name?.split(" ")[0] ?? "Caller";
const destName = (dest) => dest?.displayName ?? `${org} ${label(dest?.routeId)}`;
// A proposal is only on the table while the agent waits for a yes; a later
// low-confidence turn leaves the old one in the snapshot.
const liveProposal = (snap) => (snap?.state === "confirming" ? snap.proposed : null);
const isDiverted = (snap) =>
  Boolean(snap?.destination?.afterHours && snap.confirmedRouteId && snap.confirmedRouteId !== snap.destination.routeId);
const withheld = (snap) => (snap?.maskedPhone && snap.maskedPhone !== "anonymous" ? snap.maskedPhone : "number withheld");

const stackNodes = () =>
  voiceStack({
    voiceLive: health?.voiceLive?.model ?? "gpt-realtime",
    tools: "Routing policy",
    toolsSim: "real policy code",
    agent: "Teams call queue",
    agentSim: "mock toast",
  });

// ------------------------------------------------------------------ wiring

const voice = createVoice($("voice"), { lang: "en-US" });
const clock = mountClock($("clock"), { onChange: () => refreshRoutes() });
const transcript = createTranscript($("transcript"), {
  voice,
  empty: "Answer a call, or press Next ▶ to run the demo script.",
});
const trail = createTrail($("events"), {
  good: ["message_taken"],
  timeZone: () => clock.state?.timeZone,
  empty: "Every proposal, gate and transfer shows up here.",
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
// Open and closed follow the clock, so keep the routes list honest.
setInterval(refreshRoutes, 60_000);
boot();

async function boot() {
  renderCallers();
  renderHeaders(els.headers, []);
  render();
  await Promise.all([loadHealth(), refreshRoutes(), refreshStats()]);
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
    // A quick Next shouldn't cancel a handoff that is about to land.
    const deadline = performance.now() + routing.transferDelayMs + 3000;
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
      view.callerSpoke = payload.role === "caller";
      transcript.add(payload.role, payload.text, {
        label: payload.role === "agent" ? agentLabel() : callerLabel(),
      });
      break;
    case "event":
      onEvent(payload);
      break;
    case "handoff":
      view.handoff = payload;
      renderHandoff();
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
  const proposal = liveProposal(snap);
  if (proposal) {
    const value = Number(proposal.confidence);
    view.score = { routeId: proposal.routeId, value, passes: value >= routing.confidenceThreshold };
  }

  if (snap.state === "transferring") {
    if (prev?.state !== "transferring" || prev?.destination?.routeId !== snap.destination?.routeId) startWindow(snap);
  } else if (snap.state === "transferred") {
    endWindow("ok", `Handed over to ${destName(snap.destination)} in Teams`);
  } else if (snap.state === "messaging") {
    win.hide();
  } else if (snap.state === "ended" && win.running) {
    win.stop("warn", "Cancelled — the caller hung up");
  }

  if (terminal(snap) && !terminal(prev)) refreshStats({ highlight: true });
  render();
}

function onEvent(e) {
  trail.add(e);
  const detail = String(e.detail ?? "");
  switch (e.kind) {
    case "route_proposed": {
      const m = /^(\S+) @ ([\d.]+)$/.exec(detail);
      if (m) view.score = { routeId: m[1], value: Number(m[2]), passes: true };
      transcript.tool("propose_route", m ? `${label(m[1])} · ${fmt(m[2])}` : detail, "ok");
      break;
    }
    case "low_confidence": {
      const m = /^(\S+) @ ([\d.]+)$/.exec(detail);
      if (m) view.score = { routeId: m[1], value: Number(m[2]), passes: false };
      transcript.tool(
        "propose_route",
        m ? `${label(m[1])} · ${fmt(m[2])} < gate ${fmt(routing.confidenceThreshold)}` : detail,
        "warn",
      );
      stack?.flow(["voice-live", "tools"]);
      break;
    }
    case "route_rejected":
      transcript.tool("propose_route", `“${detail}” is not on the allowlist — rejected`, "err");
      break;
    case "route_confirmed": {
      const m = /^(\S+) \((.+)\)$/.exec(detail);
      if (!m) break;
      const [, routeId, why] = m;
      if (why.startsWith("fallback:")) {
        view.how = "fallback";
        view.fallback = why.slice("fallback:".length);
      } else {
        view.how = why;
      }
      if (why === "confirmed") transcript.tool("confirm_route", label(routeId), "ok");
      break;
    }
    case "human_requested":
      transcript.tool("request_human", `straight to ${label(fallbackId)}`, "accent");
      stack?.flow(["voice-live", "tools"]);
      break;
    case "dtmf": {
      const m = /^(\S+) → (\S+)$/.exec(detail);
      if (m) view.digit = m[1];
      transcript.tool("keypad", m ? `${m[1]} → ${label(m[2])}` : detail, "accent");
      break;
    }
    case "dtmf_ignored":
      transcript.system(`Key ${detail} isn't on the keypad menu — ignored`);
      break;
    case "message_taken":
      view.message = detail || null;
      transcript.tool("take_message", detail, "ok");
      stack?.flow(["voice-live", "tools"]);
      break;
    case "route_changed": {
      const [from, to] = detail.split(" → ");
      view.changed = { from, to };
      view.how = null;
      transcript.system(`↺ ${label(from)} transfer cancelled — the caller changed their mind`);
      win.stop("warn", `Cancelled — the caller changed their mind (${label(from)} → ${label(to)})`);
      break;
    }
    case "no_input":
      // The server counts silence and an unusable answer the same way.
      transcript.system(view.callerSpoke ? "— not enough to route on —" : "— the caller says nothing —");
      break;
    case "clarification": {
      const m = /^(\S+) \((\d+)\)$/.exec(detail);
      if (!m) break;
      view.lastClarify = { reason: m[1], n: Number(m[2]) };
      if (view.snap) view.snap = { ...view.snap, clarifications: Number(m[2]) };
      break;
    }
    case "out_of_scope":
      transcript.tool("not_covered", detail || "no route covers that", "warn");
      break;
    case "transfer_started":
      win.stop("accent", "Dispatched — transferring in Teams…");
      break;
    case "transfer_simulated":
    case "transfer_succeeded":
      transcript.system(`↪ Handed over to ${destName(view.snap?.destination ?? { routeId: detail })} in Teams`);
      break;
    case "transfer_failed":
      view.transferFailed = true;
      transcript.system(`Transfer failed: ${detail}`);
      break;
    case "transfer_retry":
      transcript.system(`Retrying the transfer to ${label(detail)}…`);
      break;
    case "transfer_diverted":
      transcript.system(`Couldn't get through — trying ${label(detail)} instead`);
      break;
    case "budget_expired":
      transcript.system("Out of time — sending the caller to a person");
      break;
    case "fallback":
      view.fallback = detail;
      transcript.system(`${humanReason(detail)} — sending the caller to ${label(fallbackId)}`);
      break;
  }
  render();
}

// ----------------------------------------------------------------- render

function render() {
  const snap = view.snap;
  const state = snap?.state ?? null;
  const tone = state === "ended" ? (snap.outcome === "message_taken" ? "ok" : "muted") : toneOf(state);
  setStateChip(els.stateChip, state, tone);
  renderControls();
  renderDecision(els.decision, { ...decision(snap), empty: "Answer a call to see how the server routes it." });
  renderGaugePanel();
  renderFactsPanel();
  renderRoutes();
  renderToastPlaceholder();
  tickBudget();
}

function renderControls() {
  const active = Boolean(session.id && !session.finished && !session.followed && view.snap && !terminal(view.snap));
  for (const el of [els.sayInput, els.sayBtn, els.silence, els.hangup]) el.disabled = !active;
  for (const button of els.keys.querySelectorAll("button")) button.disabled = !active;
}

/** The headline: what the server decided, and why, in plain English. */
function decision(snap) {
  if (!snap) return {};
  const gate = fmt(routing.confidenceThreshold);
  const asked = label(snap.confirmedRouteId);

  if (snap.state === "messaging") {
    return {
      headline: `${asked} is closed`,
      why: `The server checked the hours, not the model. ${asked}'s after-hours rule is to take a message.`,
      verdict: "after hours → take a message",
      tone: "warn",
    };
  }
  if (snap.outcome === "message_taken") {
    return {
      headline: `Message taken for ${asked}`,
      why: `“${view.message ?? snap.topic ?? "The message"}” is in the audit log for ${asked}. No callback time was promised.`,
      verdict: "message recorded",
      tone: "ok",
    };
  }
  if (snap.state === "fallback") {
    return {
      headline: "Couldn't connect",
      why: "The transfer failed, and so did the fallback queue. The agent apologized and asked the caller to try again shortly.",
      verdict: "transfer unavailable",
      tone: "err",
    };
  }
  // Before the destination: a caller can hang up inside the transfer window.
  if (snap.state === "ended") {
    return {
      headline: "Call ended",
      why: view.transferFailed
        ? "The transfer couldn't be completed, so the agent apologized and ended the call."
        : snap.destination
          ? "The caller hung up before the transfer dispatched."
          : "The caller hung up before a handoff.",
      verdict: "no handoff",
      tone: "muted",
    };
  }
  if (snap.destination) return destinationDecision(snap);

  const proposal = liveProposal(snap);
  if (proposal) {
    const offered = label(proposal.routeId);
    const score = fmt(proposal.confidence);
    return {
      headline: `Offering ${offered}`,
      why: view.changed
        ? `The caller changed their mind, so the pending ${label(view.changed.from)} transfer was cancelled. ${score} clears the ${gate} gate, so the agent offers ${offered} instead and waits for a yes.`
        : `${score} clears the ${gate} gate, so the agent offers ${offered} and waits for a yes.`,
      verdict: "above the gate — offer, then confirm",
      tone: "ok",
    };
  }

  const lastTry = snap.clarifications >= routing.maxClarifications;
  if (view.lastClarify?.reason === "low_confidence" && view.score && !view.score.passes) {
    return {
      headline: "Not sure yet",
      why: `${label(view.score.routeId)} scored ${fmt(view.score.value)}, below the ${gate} gate, so the agent asks one question instead of guessing.${
        lastTry ? " It's the last try, so it offers the keypad too." : ""
      }`,
      verdict: "below the gate — ask, don't guess",
      tone: "warn",
    };
  }
  if (snap.clarifications > 0) {
    return {
      headline: "Didn't catch that",
      why: lastTry
        ? `Still nothing usable, so the agent offers the keypad too. One more miss and the caller goes to ${label(fallbackId)}.`
        : "Nothing usable yet, so the agent asks one short question rather than reading out a menu.",
      verdict: `clarifying ${snap.clarifications} of ${routing.maxClarifications}`,
      tone: "warn",
    };
  }
  return {
    headline: "Listening…",
    why: "The model proposes a route; the server checks it against the gate, the allowlist and the hours.",
  };
}

function destinationDecision(snap) {
  const dest = snap.destination;
  const headline = snap.state === "transferred" ? `Handed to ${destName(dest)}` : `Connecting to ${destName(dest)}`;
  const asked = label(snap.confirmedRouteId);
  const to = label(dest.routeId);

  if (isDiverted(snap)) {
    return {
      headline,
      why: `${asked} is closed on the demo clock, and its after-hours rule sends callers to ${to}. The server decided that, not the model.`,
      verdict: `${asked} closed → ${to}`,
      tone: "warn",
    };
  }
  if (view.transferFailed && dest.routeId !== snap.confirmedRouteId) {
    return {
      headline,
      why: `The transfer to ${asked} failed twice, so the call went to the ${to} queue instead of being dropped.`,
      verdict: `transfer failed → ${to}`,
      tone: "err",
    };
  }
  if (view.how === "human_requested") {
    return {
      headline,
      why: "The caller asked for a person, so the agent skipped classification and confirmation. Nobody should have to argue with a bot.",
      verdict: "asked for a person",
      tone: "accent",
    };
  }
  if (view.how === "dtmf") {
    return {
      headline,
      why: `The caller pressed ${view.digit ?? "a key"}. A keypress is unambiguous, so there's no gate and no spoken confirmation.`,
      verdict: "keypad — unambiguous",
      tone: "accent",
    };
  }
  if (view.how === "fallback") {
    return {
      headline,
      why: `${humanReason(view.fallback)}, so the caller goes to a person instead of going round in circles.`,
      verdict: `fallback → ${to}`,
      tone: "err",
    };
  }
  if (view.changed) {
    return {
      headline,
      why: `The caller changed their mind inside the transfer window: ${label(view.changed.from)} was cancelled before it dispatched, then ${label(view.changed.to)} was offered and confirmed.`,
      verdict: "re-proposed, re-confirmed",
      tone: "ok",
    };
  }
  const score = view.score?.routeId === snap.confirmedRouteId ? view.score : null;
  const asking = snap.clarifications === 1 ? "one clarifying question" : `${snap.clarifications} clarifying questions`;
  const cleared = score
    ? `${fmt(score.value)} cleared the ${fmt(routing.confidenceThreshold)} gate, the agent offered ${asked}, and the caller said yes.`
    : `The agent offered ${asked}, and the caller said yes.`;
  return {
    headline,
    why: snap.clarifications > 0 ? `After ${asking}, ${cleared.charAt(0).toLowerCase()}${cleared.slice(1)}` : cleared,
    verdict: snap.clarifications > 0 ? "asked, then confirmed" : "offered, then confirmed",
    tone: "ok",
  };
}

function renderGaugePanel() {
  if (view.how === "dtmf" || view.how === "human_requested") {
    renderGauge(els.gauge, {
      value: null,
      gate: null,
      label: view.how === "dtmf" ? "keypad — no confidence gate needed" : "asked for a person — no gate",
    });
    return;
  }
  renderGauge(els.gauge, {
    value: view.score?.value ?? null,
    gate: routing.confidenceThreshold,
    label: view.score ? `${label(view.score.routeId)} vs the gate` : "confidence gate",
  });
}

function renderFactsPanel() {
  const snap = view.snap;
  if (!snap) {
    renderFacts(els.facts, []);
    return;
  }
  const messaging = snap.state === "messaging" || snap.outcome === "message_taken";
  const dest = snap.destination;

  const caller = snap.caller
    ? `${escapeHtml([snap.caller.name, snap.caller.company].filter(Boolean).join(" · "))} <span class="muted">· caller ID, unverified</span>`
    : `Unknown caller <span class="muted">· ${escapeHtml(withheld(snap))}</span>`;

  const proposed =
    view.how === "dtmf"
      ? "not needed — keypad"
      : view.how === "human_requested"
        ? "not needed — asked for a person"
        : view.score
          ? `${label(view.score.routeId)} · ${fmt(view.score.value)}${view.score.passes ? "" : " (below the gate)"}`
          : "nothing yet";

  const decidedBy = messaging
    ? `after-hours rule — ${label(snap.confirmedRouteId)} takes messages`
    : isDiverted(snap)
      ? `after-hours rule — ${label(snap.confirmedRouteId)} is closed`
      : view.how === "confirmed"
        ? view.changed
          ? "caller confirmed the second offer"
          : "caller confirmed the offer"
        : view.how === "dtmf"
          ? `keypad ${view.digit ?? ""}`.trim()
          : view.how === "human_requested"
            ? "caller asked for a person"
            : view.how === "fallback"
              ? `fallback — ${humanReason(view.fallback).toLowerCase()}`
              : snap.state === "confirming"
                ? "waiting for the caller's yes"
                : "not decided yet";

  const destination = messaging
    ? "none — taking a message"
    : dest
      ? `${destName(dest)}${dest.afterHours ? " · after hours" : ""}${snap.state === "ended" ? " · not dispatched" : ""}`
      : "";

  const hours = routeById.get(snap.confirmedRouteId ?? dest?.routeId ?? liveProposal(snap)?.routeId ?? view.score?.routeId);
  const always = hours && /^(always open|24\/7)$/i.test(hours.hours ?? "");

  renderFacts(els.facts, [
    ["Caller", caller, { html: true }],
    ["Model proposed", proposed, view.score && !view.score.passes && !view.how ? { tone: "warn" } : {}],
    ["Decided by", decidedBy],
    ["Destination", destination],
    hours && [
      "Business hours",
      `${hours.label} · ${hours.hours}${always ? "" : hours.open ? " · open now" : " · closed now"}`,
      { tone: hours.open ? "ok" : "warn" },
    ],
    ["Clarifications", `${snap.clarifications} of ${routing.maxClarifications}`, snap.clarifications ? { tone: "warn" } : {}],
  ]);
}

function renderRoutes() {
  const snap = view.snap;
  const active = snap
    ? (snap.destination?.routeId ?? snap.confirmedRouteId ?? liveProposal(snap)?.routeId ?? view.score?.routeId)
    : null;
  renderList(
    els.routes,
    routesInfo.map((r) => ({
      label: r.label,
      meta: [r.dtmf && `key ${r.dtmf}`, r.hours, r.whenClosed && `after hours ${r.whenClosed}`].filter(Boolean).join(" · "),
      status: r.open ? "open" : "closed",
      tone: r.open ? "ok" : "muted",
      active: r.id === active,
    })),
    { empty: "Loading the routes…" },
  );
}

function renderKeys() {
  const keys = routesInfo.filter((r) => r.dtmf).sort((a, b) => String(a.dtmf).localeCompare(String(b.dtmf)));
  const sig = keys.map((r) => `${r.dtmf}:${r.label}`).join("|");
  if (sig === keysSig) return;
  keysSig = sig;
  els.keys.innerHTML = keys
    .map(
      (r) =>
        `<button type="button" data-digit="${escapeHtml(r.dtmf)}" title="Press ${escapeHtml(r.dtmf)} for ${escapeHtml(
          r.label,
        )}">${escapeHtml(r.dtmf)} <small>${escapeHtml(r.label)}</small></button>`,
    )
    .join("");
  renderControls();
}

function renderCallers() {
  // Names only, so the picker never truncates. The company shows on the caller
  // card and the Teams toast once the call is answered.
  els.callerSelect.innerHTML = CALLERS.map(
    (c) => `<option value="${escapeHtml(c.phone)}">${escapeHtml(c.name)}</option>`,
  ).join("");
}

// ----------------------------------------------------------------- budget

/** The answer-to-route budget stops once a route is settled. */
function budgetStop(snap) {
  if (snap.outcome === "message_taken") return "message taken";
  if (snap.state === "messaging") return "taking a message";
  if (snap.confirmedRouteId || snap.state === "transferred") return "routed";
  if (terminal(snap) || snap.state === "fallback") return "ended";
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
  renderBudget(els.budget, { elapsedMs, budgetMs: snap.budgetMs ?? routing.timeBudgetMs });
  const parts = els.budget.pkBudget;
  if (stop && parts && !els.budget.hidden) {
    parts.label.textContent += ` · ${stop}`;
    parts.fill.dataset.tone = stop === "ended" ? "muted" : "ok";
  }
}

// ------------------------------------------------- the mind-change window

/** The bar drains while the caller can still change their mind. */
function startWindow(snap) {
  const delay = routing.transferDelayMs;
  if (!delay) {
    win.hide();
    return;
  }
  const to = destName(snap.destination);
  win.start(delay, (left, leftMs) =>
    leftMs > 0 ? `Dispatching to ${to} in ${left} — the caller can still change their mind` : `Dispatching to ${to}…`,
  );
}

function endWindow(tone, text) {
  if (!routing.transferDelayMs) {
    win.hide();
    return;
  }
  win.finish(tone, text);
}

// ------------------------------------------------------------ Teams side

function renderHandoff() {
  const h = view.handoff;
  if (!h) return;
  const snap = view.snap;
  const routeName = label(h.routeId);
  const meantFor = snap?.confirmedRouteId && snap.confirmedRouteId !== h.routeId ? label(snap.confirmedRouteId) : null;
  const diverted = Boolean(h.afterHours && meantFor);
  const d = h.callerDetails;
  const account = d ? [d.accountId && `Account ${d.accountId}`, d.relationship].filter(Boolean).join(" · ") : "";

  const callerHtml = d
    ? `<strong>${escapeHtml(d.name)}</strong>${d.company ? ` · ${escapeHtml(d.company)}` : ""}${
        account ? `<div class="muted">${escapeHtml(account)}</div>` : ""
      }<span class="unverified">Matched on caller ID — not verified</span>`
    : `<strong>Unknown caller</strong><div class="muted">${escapeHtml(withheld(snap))}</div>`;

  const tags = [
    { text: routeName, tone: "teams" },
    h.afterHours ? { text: diverted ? `after hours · meant for ${meantFor}` : "after hours", tone: "warn" } : null,
    view.how === "dtmf" ? { text: `keypad ${view.digit ?? ""}`.trim(), tone: "accent" } : null,
    view.how === "human_requested" && !sameWords("asked for a person", h.callTopic)
      ? { text: "asked for a person", tone: "accent" }
      : null,
    view.how === "fallback" ? { text: "fallback", tone: "err" } : null,
  ].filter(Boolean);

  renderTeamsToast(els.toast, {
    queue: snap?.destination?.displayName ?? `${org} ${routeName}`,
    subtitle: diverted ? `After hours — ${meantFor} is closed` : "Call queue · routed by the AI switchboard",
    topic: h.callTopic,
    context: sameWords(h.callContext, h.callTopic) ? "" : h.callContext,
    sentiment: h.callSentiment ? `Caller sounds ${h.callSentiment}` : "",
    callerHtml,
    avatar: routeName,
    tags,
  });
  els.toastEmpty.hidden = true;
  // Built on the server by the same function the real transfer uses.
  renderHeaders(els.headers, (h.voipHeaders ?? []).map((x) => [x.key, x.value]));
}

/** A one-line call's summary can be the topic again, in quotes. Say it once. */
function sameWords(summary, topic) {
  const plain = (s) =>
    String(s ?? "")
      .replace(/^caller said:\s*/i, "")
      .replace(/[“”"…,.!?\s]+/g, " ")
      .trim()
      .toLowerCase();
  return Boolean(summary) && plain(summary) === plain(topic);
}

function renderToastPlaceholder() {
  if (view.handoff) return;
  const snap = view.snap;
  const asked = label(snap?.confirmedRouteId);
  els.toastEmpty.textContent = !snap
    ? "No call has been handed over yet."
    : snap.outcome === "message_taken"
      ? `No transfer — ${asked} is closed. The message is in the audit log for the team: “${view.message ?? snap.topic ?? ""}”.`
      : snap.state === "messaging"
        ? `${asked} is closed — the agent is taking a message instead of transferring.`
        : snap.state === "transferring"
          ? "Transfer pending — the caller can still change their mind."
          : snap.state === "ended"
            ? "The caller hung up before a handoff."
            : "No call has been handed over yet.";
}

// ---------------------------------------------------------------- metrics

function renderStats(stats) {
  if (!stats) return;
  renderMetrics(els.metrics, [
    ["Calls", stats.calls],
    ["Transferred", stats.transfers],
    ["Clarifying questions", stats.clarifications],
    ["Asked for a person", stats.humanRequests],
    ["Fallbacks", stats.fallbacks],
    ["Messages taken", stats.messagesTaken],
    ["Median seconds to route", stats.medianSecondsToRoute],
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

/** The closing beat: wait for the transfer to land, then show the numbers. */
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
  const live = renderMode(els.mode, health);
  els.reset.disabled = live;
  if (live) els.reset.title = "Demo controls are off while this server answers real calls.";
  for (const key of Object.keys(routing)) {
    const value = health.routing?.[key];
    if (typeof value === "number") routing[key] = value;
  }
  if (stack) stack.setLive(live);
  else stack = mountStack($("stack"), { live, nodes: stackNodes() });
}

async function refreshRoutes() {
  const seq = ++routesSeq;
  try {
    const data = await getJson("/api/routes");
    if (seq === routesSeq) applyRoutes(data);
  } catch {
    // Keep the last good list.
  }
}

function applyRoutes(data) {
  org = data.organization ?? org;
  fallbackId = data.fallbackRouteId ?? fallbackId;
  routesInfo = data.routes ?? [];
  routeById = new Map(routesInfo.map((r) => [r.id, r]));
  els.org.textContent = org;
  document.title = `${org} — Switchboard`;
  renderKeys();
  render();
}

/** After a hub reconnect: catch up on anything missed while it was down. */
async function refreshAll() {
  await Promise.all([loadHealth(), refreshRoutes(), clock.refresh(), refreshStats()]);
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
    await clock.refresh();
    director.load(0);
    notify("Demo reset — clean audit, starting clock, beat 1.", "ok");
  } catch (error) {
    if (error.status === 403) notify("Reset is off while this server answers real calls.", "warn");
    else notify(error.message, "err");
  }
});
