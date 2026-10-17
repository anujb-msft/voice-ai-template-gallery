/**
 * The bid line console.
 *
 * A viewer of the server's pricing policy, never a second copy of it. Every
 * number and every decision on screen — the cash bid, the freshness window,
 * the clarifying question, the refusal, the handoff — is one the server made
 * and published over the hub; this file only explains it. The plumbing every
 * template shares (hub, call session, demo director, Teams toast, gauge,
 * trail) comes from the presenter kit, and the on-stage script lives in
 * beats.js.
 */

import {
  $,
  escapeHtml,
  getJson,
  postJson,
  notify,
  flash,
  sleep,
  chip,
  connectHub,
  createCallSession,
  createSimulator,
  renderMode,
  toneOf,
  setStateChip,
  renderBudget,
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

// Fictional growers for the caller picker. The server never learns the names:
// it sees a number, and only ever shows it masked.
const CALLERS = [
  { phone: "+14255550111", name: "Dale Meyer" },
  { phone: "+14255550112", name: "Rosa Alvarez" },
  { phone: "", name: "Unknown number" },
];

const els = {
  org: $("org"),
  clock: $("clock"),
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
  priceCard: $("priceCard"),
  facts: $("facts"),
  feedStatus: $("feedStatus"),
  feedToggle: $("feedToggle"),
  toast: $("toast"),
  toastEmpty: $("toastEmpty"),
  headers: $("headers"),
  headersNote: $("headersNote"),
  locations: $("locations"),
  metrics: $("metrics"),
};

const TERMINAL = new Set(["transferred", "ended"]);

// What the caller heard about a price's freshness, in the words the agent used.
const FRESHNESS = {
  live: { text: "live", tone: "ok" },
  delayed: { text: "may be delayed", tone: "warn" },
  close: { text: "last close", tone: "warn" },
};

const CLOSED_LABELS = {
  market_closed: "market closed — last settlement only",
  holiday: "exchange holiday — last settlement only",
  hard_limit: "past the hard limit — last settlement only",
};

// Short tags for the Teams toast; the full reason travels in the call context.
const REASON_TAGS = {
  contract_request: "lock / book a price",
  sell_request: "wants to sell",
  feed_outage: "feed down",
  advice_request: "wants advice",
  dtmf_0: "pressed 0",
  caller_requested: "asked for a person",
};

const ENDINGS = {
  caller_hung_up: "The caller hung up before asking for a price.",
  no_input: "Two silences in a row, so the agent said goodbye.",
  time_budget_expired: "The call reached its time budget, so the agent closed politely.",
};

// Defaults until /health answers; the server's numbers win.
const policy = { futuresStaleMinutes: 20 };

let health = null;
let live = false;
let org = "Contoso Grain Co-op";
let locationsInfo = [];
let locationById = new Map();
let stack = null;
let locationsSeq = 0;
let feed = null; // { up, adjustable, health }: the price feed, as the server reports it
let lockedShown = false;
let clockKey = "";
let cardKey = "";
let sending = false;
let view = blankView();

/** What the console has learned about the call on screen, beyond its snapshot. */
function blankView() {
  return {
    snap: null,
    callerName: null, // the grower picked for a call started here; never sent to the server
    handoff: null,
    callback: null,
    offer: null, // "Offered the Lake Mills merchandiser now, or a callback"
    requoted: null, // "live → delayed": the price on screen came from a re-check
    skipQuoteChip: false,
    transferFailed: false,
    reopened: false, // a failed live transfer put the caller back with the agent
    syncedAt: 0,
  };
}

const money = (v) => `$${Number(v).toFixed(2)}`;
const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : "");
const count = (n, word) => `${n ?? 0} ${word}${n === 1 ? "" : "s"}`;
const terminal = (snap) => TERMINAL.has(snap?.state);
const noFeed = (d) => d?.kind === "feed_down" || d?.reason === "feed_outage";
const hasCallerId = (masked) => Boolean(masked && masked !== "anonymous");
const agentLabel = () => "Bid line";
const callerLabel = () => view.callerName?.split(" ")[0] ?? "Caller";
const signedCents = (c) => (c < 0 ? `−${Math.abs(c)}¢` : c > 0 ? `+${c}¢` : "0¢");
// The price on screen is the last one quoted, unless the latest decision is about something else.
const shownQuote = (snap) => {
  const d = snap?.decision;
  return d && !noFeed(d) && d.kind !== "clarify" && d.kind !== "no_quote" ? snap.lastQuote : null;
};

const stackNodes = () =>
  voiceStack({
    voiceLive: health?.voiceLive?.model ?? "gpt-realtime",
    tools: "Pricing policy",
    toolsSim: "real policy code",
    agent: "Teams merchandiser",
    agentSim: "mock toast",
  });

// ------------------------------------------------------------------ wiring

const voice = createVoice($("voice"), { lang: "en-US" });
const clock = mountClock(els.clock, { onChange: onClock });
const transcript = createTranscript($("transcript"), {
  voice,
  empty: "Answer a call, or press Next ▶ to run the demo script.",
});
const trail = createTrail($("events"), {
  good: ["quote", "callback_requested", "transfer_simulated", "transfer_succeeded"],
  bad: ["feed_outage", "transfer_failed", "budget_expired"],
  warn: [
    "stale_caveat",
    "close_price",
    "clarification",
    "person_offered",
    "advice_guard",
    "contract_guard",
    "human_requested",
    "after_hours",
    "no_input",
    "callback_unavailable",
    "tool_rejected",
  ],
  timeZone: () => clock.state?.timeZone,
  empty: "Every quote, caveat, question, refusal and handoff shows up here.",
});
const session = createCallSession({ voice, onMessage, onFollow: () => clearPanels() });
connectHub((target, payload) => session.handle(target, payload), {
  onOpen: ({ reconnected }) => reconnected && refreshAll(),
});
const sim = createSimulator({
  session,
  startBody,
  onSnapshot: applySnapshot,
  actions: { clock: clockStep, feed: feedStep, metrics: showMetrics },
});
const director = createDirector($("director"), {
  beats: createBeats({ setClock, setFeed }),
  perform,
  voice,
  sayInput: els.sayInput,
  onBeat: () => {
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: "smooth" });
  },
});

setInterval(tickBudget, 500);
// The demo clock is pinned, but the header keeps counting between reads; re-read it.
setInterval(() => clock.refresh(), 15_000);
// Open and closed follow the clock, so keep the merchandiser list honest.
setInterval(refreshLocations, 60_000);
boot();

async function boot() {
  renderCallers();
  renderHeaders(els.headers, []);
  render();
  await Promise.all([loadHealth(), refreshLocations(), refreshStats(), refreshFeed()]);
  stack ??= mountStack($("stack"), { nodes: stackNodes() });
  render();
}

// ------------------------------------------------------------- call steps

function startBody(step) {
  const phone = "fromPhone" in step ? (step.fromPhone ?? "") : els.callerSelect.value;
  els.callerSelect.value = phone;
  view.callerName = CALLERS.find((c) => c.phone && c.phone === phone)?.name ?? null;
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

/** A server answering real calls keeps the real clock and the real feed. Say so once. */
function demoControlsLocked() {
  if (lockedShown) return;
  lockedShown = true;
  notify("This server answers real calls, so the demo clock and the price feed stay real.", "warn", 6000);
}

/** Beats pin the demo clock. */
async function setClock(preset) {
  try {
    return await clock.set({ preset });
  } catch (error) {
    if (error.status !== 403) throw error;
    demoControlsLocked();
    return null;
  }
}

/** Beats bring the price feed up, or take it down. Simulation only. */
async function setFeed(up) {
  const was = feed?.up;
  try {
    applyFeed(await postJson("/api/demo/feed", { up }));
  } catch (error) {
    if (error.status !== 403) throw error;
    demoControlsLocked();
    return;
  }
  if (was !== undefined && was !== up) {
    notify(up ? "The price feed is back up." : "The price feed is down — every read from it now fails.", up ? "ok" : "warn");
  }
}

async function clockStep(step) {
  const state = await setClock(step.preset);
  if (!state) return;
  flash(els.clock);
  const label = state.presets?.find((p) => p.id === state.preset)?.label ?? state.preset;
  notify(`Demo clock: ${label} — ${timeOf(state)}`, "info");
}

async function feedStep(step) {
  await setFeed(step.up !== false);
  flash(els.feedStatus);
}

function timeOf(state) {
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: state.timeZone }).format(state.now);
  } catch {
    return new Date(state.now).toLocaleTimeString();
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
    case "callback":
      view.callback = payload;
      renderCallback();
      break;
  }
}

/**
 * Snapshots arrive twice — over the hub and in each simulate response — and
 * not always in order. Older ones, and anything after the call finished, are
 * ignored; a failed live transfer is the one way back from finished.
 */
function applySnapshot(snap) {
  if (!snap?.id) return;
  if (session.id && snap.id !== session.id) return;
  const prev = view.snap?.id === snap.id ? view.snap : null;
  if (prev && terminal(prev) && !terminal(snap) && !view.reopened) return;
  if (prev && (snap.elapsedMs ?? 0) < (prev.elapsedMs ?? 0)) return;

  view.snap = snap;
  view.syncedAt = performance.now();
  if (terminal(snap) && !terminal(prev)) refreshStats({ highlight: true });
  render();
}

/**
 * On a real call the model's own tool calls arrive as `tool` events. The
 * offline stand-in doesn't report them, so in simulation the console shows
 * the tool call each server event implies.
 */
function implied(name, detail, tone) {
  if (view.snap?.simulated !== false) transcript.tool(name, detail, tone);
}

function onEvent(e) {
  trail.add(e);
  const detail = String(e.detail ?? "");
  switch (e.kind) {
    case "quote": {
      if (view.skipQuoteChip) {
        view.skipQuoteChip = false;
        break;
      }
      view.requoted = null;
      const m = /^(.*) — (\$[\d.]+), (live|delayed|close)$/.exec(detail);
      const fresh = m ? FRESHNESS[m[3]] : null;
      implied(
        /all locations/.test(detail) ? "list_bids" : "get_bid",
        m ? `${m[1]} → ${m[2]} · ${fresh.text}` : detail.replace(" — ", " → "),
        fresh?.tone ?? "ok",
      );
      break;
    }
    case "requoted":
      view.requoted = detail.replace(/^Re-checked before repeating — /, "");
      view.skipQuoteChip = true;
      implied("repeat_last", `re-checked first — ${view.requoted}`, "warn");
      break;
    case "clarification": {
      implied(/merchandiser/.test(detail) ? "transfer_to_merchandiser" : "get_bid", clarifyChip(detail), "warn");
      stack?.flow(["voice-live", "tools"]);
      break;
    }
    case "feed_outage":
      implied("get_bid", "feed unavailable — no number", "err");
      stack?.flow(["voice-live", "tools"]);
      break;
    case "person_offered":
      view.offer = detail;
      break;
    case "callback_requested":
      implied("request_callback", detail.split(" · ")[0], "ok");
      stack?.flow(["voice-live", "tools"]);
      break;
    case "transfer_started":
      implied("transfer_to_merchandiser", detail.replace(/^To the /, ""), "accent");
      break;
    case "advice_guard":
      transcript.system("No advice — the agent never advises or predicts");
      stack?.flow(["voice-live", "tools"]);
      break;
    case "contract_guard":
      transcript.system("Nothing locked — only a merchandiser can lock in or book a price");
      stack?.flow(["voice-live", "tools"]);
      break;
    case "dtmf":
      transcript.tool("keypad", detail.replace(/^Pressed /, ""), "accent");
      break;
    case "tool":
    case "tool_rejected": {
      const [name, ...rest] = detail.split(": ");
      transcript.tool(name, rest.join(": "), e.kind === "tool" ? "ok" : "warn");
      break;
    }
    case "no_input":
      transcript.system("— the caller says nothing —");
      break;
    case "transfer_simulated":
    case "transfer_succeeded": {
      const where = view.snap?.handoff?.locationName;
      const to = where ? `the ${where} merchandiser` : /^Handed to (.+?)(?: with the call context)?$/.exec(detail)?.[1] ?? "the merchandiser";
      transcript.system(`↪ Handed to ${to} in Teams, with the call context`);
      break;
    }
    case "transfer_failed":
      view.transferFailed = true;
      view.reopened = true;
      transcript.system(`Transfer failed: ${detail}`);
      renderHandoff();
      break;
    case "after_hours":
      transcript.system(`${detail} — the agent gives the hours`);
      break;
    case "callback_unavailable":
      transcript.system("No caller ID, so no callback — offering a person instead");
      break;
    case "budget_expired":
      transcript.system("Out of time — the agent closes politely");
      break;
  }
  render();
}

/** "Asked which location — it matched Riverbend and Riverside" → "ambiguous — Riverbend or Riverside → ask" */
function clarifyChip(detail) {
  const matched = /it matched (.+)$/.exec(detail);
  if (matched) return `ambiguous — ${matched[1].replace(/,? and /, " or ")} → ask`;
  if (/commodity/.test(detail)) return /not one/.test(detail) ? "not a posted commodity → ask" : "no commodity → ask";
  if (/month/.test(detail)) return "month not posted → ask";
  if (/none by that name/.test(detail)) return "unknown location → ask";
  return "no location → ask";
}

// ----------------------------------------------------------------- render

function render() {
  const snap = view.snap;
  setStateChip(els.stateChip, snap?.state ?? null, stateTone(snap));
  renderControls();
  renderDecision(els.decision, { ...decision(snap), empty: "Answer a call to see how the server prices it." });
  renderPriceCard();
  renderGaugePanel();
  renderFactsPanel();
  renderLocations();
  renderToastPlaceholder();
  tickBudget();
}

function stateTone(snap) {
  if (!snap) return "idle";
  if (snap.state === "ended") return /^callback_requested/.test(snap.outcome ?? "") ? "ok" : "muted";
  if (snap.state === "quoting") return "accent";
  return toneOf(snap.state);
}

function renderControls() {
  const active = Boolean(session.id && !session.finished && !session.followed && view.snap && !terminal(view.snap));
  for (const el of [els.sayInput, els.sayBtn, els.silence, els.hangup]) el.disabled = !active;
  for (const button of els.keys.querySelectorAll("button")) button.disabled = !active;
}

/** The headline: what the server decided, and why, in plain English. */
function decision(snap) {
  if (!snap) return {};
  const d = snap.decision;
  if (!d) {
    if (snap.state === "ended") {
      return {
        headline: "Call ended",
        why: ENDINGS[snap.outcome] ?? "The call ended before a price was asked for.",
        verdict: "no quote",
        tone: "muted",
      };
    }
    return {
      headline: snap.disclaimerSpoken ? "Disclaimer first, then listening" : "Greeting the caller",
      why: "Every call opens with the same disclosure and the co-op's disclaimer: bids change without notice, so confirm with the merchandiser before selling. Then the model listens for a commodity and a location; the price itself comes from the server.",
      verdict: "disclaimer before any price",
      tone: "accent",
    };
  }

  switch (d.kind) {
    case "quote":
      return quoteDecision(d);
    case "clarify":
      return clarifyDecision(d);
    case "feed_down": {
      const offer = snap.pending?.kind === "offer" ? snap.pending : null;
      return {
        headline: "No number — the price feed didn't answer",
        why: offer
          ? `${d.detail} The agent offers ${offer.callback ? "a merchandiser now, or a callback" : "a merchandiser now — with no caller ID, a callback isn't possible"}.`
          : d.detail,
        verdict: "no data → no number",
        tone: "err",
      };
    }
    case "no_quote":
      return {
        headline: "No price for that",
        why: `${d.detail} The agent says so instead of guessing.`,
        verdict: "nothing posted → say so",
        tone: "muted",
      };
    case "advice":
      return {
        headline: "Can't advise — a merchandiser can",
        why: "Whether to sell, lock in or wait is advice. The agent reads posted bids; it never advises or predicts, so it offers the merchandiser instead.",
        verdict: "advice → decline, offer a person",
        tone: "warn",
      };
    case "transfer":
      return transferDecision(snap, d);
    case "after_hours": {
      const where = /^(.+?) merchandiser is closed/.exec(d.detail ?? "")?.[1];
      return {
        headline: where ? `${where} merchandiser is closed` : "The merchandiser is closed",
        why: `${d.detail} The hours are in config, checked by the server on the demo clock.${
          d.reason === "contract_request" ? " Nothing was locked." : ""
        }`,
        verdict: "closed → give the hours",
        tone: "warn",
      };
    }
    case "callback": {
      const cb = view.callback ?? snap.callback;
      return {
        headline:
          d.reason === "feed_outage"
            ? "No number — a callback instead"
            : cb?.locationName
              ? `Callback requested for ${cb.locationName}`
              : "Callback requested",
        why: `${d.detail}${cb?.whenOpen ? " The merchandiser is closed now, so it asks for a call during business hours." : ""} The request is in the audit log, and the agent promised no time.`,
        verdict: "callback → audit log",
        tone: "ok",
      };
    }
    case "transfer_failed":
      return { headline: "The transfer didn't go through", why: d.detail, verdict: "transfer failed", tone: "err" };
    default:
      return { headline: cap(String(d.kind).replace(/_/g, " ")), why: d.detail ?? "", tone: "muted" };
  }
}

function quoteDecision(d) {
  const rechecked = view.requoted ? "The server re-checked before repeating. " : "";
  const why = `${rechecked}${d.detail ?? ""}`.trim();
  if (d.list?.length) {
    return {
      headline: `Bid board — ${count(d.list.length, "location")}, highest first`,
      why: `The server sorted the posted bids. ${why}`,
      verdict: d.reason === "live" ? "fresh → quote them as current" : "not fresh → caveat",
      tone: FRESHNESS[d.reason]?.tone ?? "ok",
    };
  }
  switch (d.reason) {
    case "delayed":
      return { headline: "Delayed — quoted with a caveat", why, verdict: "stale → “may be delayed”", tone: "warn" };
    case "close":
      return { headline: "Market closed — last settlement only", why, verdict: "closed → last close, never “current”", tone: "warn" };
    default:
      return { headline: "Live price — quoted as current", why, verdict: "fresh → quote it as current", tone: "ok" };
  }
}

const CLARIFY_HEADLINES = {
  unknown_location: "No location by that name",
  missing_location: "Which location?",
  missing_commodity: "No commodity given",
  unknown_commodity: "Not a commodity the co-op posts",
  unposted_month: "That month isn't posted",
};

function clarifyDecision(d) {
  const n = d.candidates?.length ?? 0;
  const headline =
    d.reason === "ambiguous" ? (n === 2 ? "Two locations match" : "More than one location matches") : CLARIFY_HEADLINES[d.reason] ?? "Not clear yet";
  const transfer = /merchandiser/.test(d.detail ?? "");
  return {
    headline,
    why: `${d.detail}. One short question instead of a guess — ${transfer ? "no transfer" : "no number"} until it's clear.`,
    verdict: "unclear → ask, don't guess",
    tone: "warn",
  };
}

const TRANSFER_WHY = {
  contract_request: (who) =>
    `Locking in or booking a price is a contract. The agent reads bids; it never locks one. Nothing was locked, and the call goes to the ${who} with the last quote and the caller's words.`,
  sell_request: (who) => `Selling grain is a conversation with a person, so the call goes to the ${who} with what the caller asked.`,
  feed_outage: (who) => `The price feed was down and the caller chose a person. The ${who} knows no price was quoted.`,
  advice_request: (who) => `The caller wanted advice, which only a person gives. The ${who} gets the last quote and the question.`,
  dtmf_0: () => "The caller pressed 0. A keypress is unambiguous, so there's no question and no confirmation.",
  caller_requested: () => "The caller asked for a person, so the agent connects them. Nobody should have to argue with a bot.",
};

const TRANSFER_VERDICTS = {
  contract_request: "lock / book → a person, nothing locked",
  sell_request: "sell → a person",
  feed_outage: "no price → a person",
  advice_request: "advice → a person",
  dtmf_0: "keypad 0 → a person",
  caller_requested: "asked for a person",
};

function transferDecision(snap, d) {
  const h = view.handoff ?? snap.handoff;
  const where = h?.locationName ?? locationById.get(snap.lastLocationId)?.displayName;
  const who = where ? `${where} merchandiser` : "merchandiser";
  const headline =
    d.reason === "contract_request"
      ? "Only a merchandiser can lock a price"
      : `${snap.state === "transferred" ? "Handed to" : "Connecting to"} the ${who}`;
  return {
    headline,
    why: TRANSFER_WHY[d.reason]?.(who) ?? d.detail ?? "",
    verdict: TRANSFER_VERDICTS[d.reason] ?? "handoff",
    tone: "accent",
  };
}

// ------------------------------------------------------------- price card

/** What the caller was asking about when there is no number to show. */
function askedAbout(snap) {
  const p = snap?.pending;
  const cb = view.callback ?? snap?.callback;
  const h = view.handoff ?? snap?.handoff;
  const commodity = p?.commodity ?? cb?.commodity ?? h?.commodity ?? null;
  const id = p?.locationId ?? cb?.locationId ?? h?.locationId ?? null;
  const where = locationById.get(id)?.displayName ?? cb?.locationName ?? h?.locationName ?? null;
  return [cap(commodity), where].filter(Boolean).join(" · ");
}

function priceCard(snap) {
  const d = snap?.decision;
  if (!d) return null;
  if (noFeed(d)) {
    return {
      mode: "nofeed",
      tone: "err",
      what: askedAbout(snap) || "Price request",
      badge: { text: "feed down", tone: "err" },
      big: "No price",
      unit: "nothing was quoted",
      note: "The feed didn't answer, so there is no number to read — and the agent never makes one up.",
    };
  }
  if (d.kind === "clarify") {
    return {
      mode: "ask",
      tone: "warn",
      what: askedAbout(snap) || "Price request",
      badge: { text: "clarifying", tone: "warn" },
      big: "No number yet",
      note: d.question ? `Asked: “${d.question}”` : "",
      tags: (d.candidates ?? []).map((name) => ({ text: name, tone: "warn" })),
    };
  }
  if (d.kind === "no_quote") {
    return { mode: "none", tone: "muted", what: askedAbout(snap) || "Price request", big: "Not posted", note: d.detail ?? "" };
  }
  const q = snap.lastQuote;
  if (!q) return null;
  const fresh = FRESHNESS[q.freshness] ?? { text: q.freshness, tone: "muted" };
  if (d.kind === "quote" && d.list?.length) {
    return {
      mode: "list",
      tone: fresh.tone,
      what: `${cap(q.commodity)} · every location`,
      badge: fresh,
      big: money(q.cashBid),
      unit: `top bid · ${q.locationName}`,
      rows: d.list.map((r) => ({ label: `${r.locationName} · ${r.deliveryMonth}`, value: money(r.cashBid) })),
    };
  }
  return {
    mode: "quote",
    tone: fresh.tone,
    what: `${cap(q.commodity)} · ${q.locationName}`,
    badge: fresh,
    big: money(q.cashBid),
    unit: `per bushel · ${q.deliveryMonth} delivery`,
    tags: [
      d.kind === "advice" && { text: "no advice given", tone: "warn" },
      d.kind === "transfer" && d.reason === "contract_request" && { text: "nothing locked", tone: "accent" },
    ].filter(Boolean),
  };
}

function renderPriceCard() {
  const el = els.priceCard;
  const card = priceCard(view.snap);
  if (!card) {
    el.hidden = true;
    el.innerHTML = "";
    cardKey = "";
    return;
  }
  const key = [card.mode, card.what, card.big, card.badge?.text].join("|");
  el.dataset.mode = card.mode;
  el.dataset.tone = card.tone;
  el.innerHTML = `
    <div class="price-head"><span class="price-what">${escapeHtml(card.what)}</span>${
      card.badge ? chip(card.badge.text, card.badge.tone) : ""
    }</div>
    <div class="price-bid"><b>${escapeHtml(card.big)}</b>${card.unit ? `<span>${escapeHtml(card.unit)}</span>` : ""}</div>
    ${
      card.rows?.length
        ? `<ul class="price-list">${card.rows
            .map((r) => `<li><span>${escapeHtml(r.label)}</span><b>${escapeHtml(r.value)}</b></li>`)
            .join("")}</ul>`
        : ""
    }
    ${card.note ? `<p class="price-note">${escapeHtml(card.note)}</p>` : ""}
    ${card.tags?.length ? `<div class="price-tags">${card.tags.map((t) => chip(t.text, t.tone)).join("")}</div>` : ""}`;
  const wasShown = !el.hidden;
  el.hidden = false;
  if (wasShown && key !== cardKey) replay(el);
  cardKey = key;
}

/** Run the card's arrival animation again: a new answer replaced the old one. */
function replay(el) {
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";
}

function renderGaugePanel() {
  const snap = view.snap;
  if (noFeed(snap?.decision)) {
    renderGauge(els.gauge, { value: null, gate: null, label: "no data — the price feed didn't answer" });
    return;
  }
  const q = shownQuote(snap);
  if (q?.freshness === "close") {
    renderGauge(els.gauge, { value: null, gate: null, label: CLOSED_LABELS[q.freshnessReason] ?? CLOSED_LABELS.market_closed });
    return;
  }
  if (q?.freshnessReason === "stale_bid_sheet") {
    renderGauge(els.gauge, { value: null, gate: null, label: `bid sheet last posted ${q.bidSheetLocal} — caveat` });
    return;
  }
  renderGauge(els.gauge, {
    value: q ? q.ageMinutes : null,
    gate: q?.staleGateMinutes ?? policy.futuresStaleMinutes,
    min: 0,
    max: 60,
    format: (v) => `${Math.round(v)} min`,
    passes: (v, g) => v <= g,
    label: "futures age vs the fresh window",
  });
}

function renderFactsPanel() {
  const snap = view.snap;
  if (!snap) {
    renderFacts(els.facts, []);
    return;
  }
  const q = shownQuote(snap);
  const down = noFeed(snap.decision);
  const callerId = hasCallerId(snap.maskedPhone);
  renderFacts(els.facts, [
    q && ["Basis", `${q.basisText} (${signedCents(q.basisCents)})`],
    q && ["Futures", `${q.futuresSymbol} · ${money(q.futuresPrice)} ${q.futuresBasis === "settle" ? "settlement" : "last trade"}`],
    q && [
      "As of",
      q.freshness === "close" ? "the last close" : `${q.asOfLocal} · ${count(q.ageMinutes, "minute")} old`,
      { tone: q.freshness === "live" ? "ok" : "warn" },
    ],
    q && ["Source", q.source],
    down && ["Source", `${health?.pricing?.source ?? "fixture"} feed — didn't answer`, { tone: "err" }],
    ["Caller ID", callerId ? `${snap.maskedPhone} · not verified` : "withheld — no callback possible", callerId ? {} : { tone: "warn" }],
    ["This call", `${count(snap.quotes, "quote")} · ${count(snap.clarifications, "clarifying question")}`],
  ]);
}

function renderLocations() {
  const snap = view.snap;
  const d = snap?.decision;
  const h = view.handoff ?? snap?.handoff;
  const cb = view.callback ?? snap?.callback;
  const active = new Set();
  if (h?.locationId) active.add(h.locationId);
  else if (cb?.locationId) active.add(cb.locationId);
  else if (d?.kind === "clarify" && d.candidates?.length) {
    for (const l of locationsInfo) if (d.candidates.includes(l.displayName)) active.add(l.id);
  } else if (snap?.pending?.locationId) active.add(snap.pending.locationId);
  else if (snap?.lastLocationId) active.add(snap.lastLocationId);
  renderList(
    els.locations,
    locationsInfo.map((l) => ({
      label: l.displayName,
      meta: [l.merchandiser?.type === "callQueue" ? "call queue" : "merchandiser", l.hours].filter(Boolean).join(" · "),
      status: l.open ? "open" : "closed",
      tone: l.open ? "ok" : "muted",
      active: active.has(l.id),
    })),
    { empty: "Loading the locations…" },
  );
}

function renderCallers() {
  els.callerSelect.innerHTML = CALLERS.map(
    (c) => `<option value="${escapeHtml(c.phone)}">${escapeHtml(c.name)}</option>`,
  ).join("");
}

/** The per-call time budget. Simulated calls are exempt, so it only shows on a real call. */
function tickBudget() {
  const snap = view.snap;
  if (!snap?.budgetMs) {
    els.budget.hidden = true;
    return;
  }
  const elapsedMs = terminal(snap) ? snap.elapsedMs : snap.elapsedMs + (performance.now() - view.syncedAt);
  renderBudget(els.budget, { elapsedMs, budgetMs: snap.budgetMs });
}

// ------------------------------------------------------------ Teams side

function renderHandoff() {
  const h = view.handoff;
  if (!h) return;
  const q = h.lastQuote;
  const queueKind = locationById.get(h.locationId)?.merchandiser?.type === "callQueue" ? "Call queue" : "Merchandiser";
  const phone = hasCallerId(h.maskedPhone) ? h.maskedPhone : null;
  const tags = [
    { text: REASON_TAGS[h.reason] ?? h.reasonLabel ?? "merchandiser request", tone: "teams" },
    q && { text: `${money(q.cashBid)} · ${FRESHNESS[q.freshness]?.text ?? q.freshness}`, tone: FRESHNESS[q.freshness]?.tone ?? "muted" },
    h.reason === "contract_request" && { text: "nothing locked", tone: "accent" },
    h.reason === "feed_outage" && { text: "no price quoted", tone: "err" },
    view.transferFailed && { text: "transfer failed", tone: "err" },
  ].filter(Boolean);

  renderTeamsToast(els.toast, {
    queue: h.queue ?? `${h.locationName ?? "The"} merchandiser`,
    subtitle: `${queueKind} · handed over by the bid line`,
    topic: h.callTopic,
    context: h.callContext,
    callerHtml: phone
      ? `<strong>${escapeHtml(phone)}</strong><span class="unverified">Caller ID only — not verified</span>`
      : `<strong>Number withheld</strong><div class="muted">No caller ID, so no callback</div>`,
    avatar: h.locationName ?? h.queue,
    tags,
    status: view.transferFailed ? "Not answered" : "Incoming call",
  });
  els.toastEmpty.hidden = true;
  // Built on the server by the same function the real transfer uses.
  renderHeaders(els.headers, (h.voipHeaders ?? []).map((x) => [x.key, x.value]));
  els.headersNote.hidden = true;
}

/** A callback is a logged request, not a ringing call: a card, not an incoming-call toast. */
function renderCallback() {
  const cb = view.callback;
  if (!cb) return;
  const where = cb.locationName ?? "Merchandiser";
  const tags = [
    chip(REASON_TAGS[cb.reason] ?? cb.reasonLabel ?? "callback", "teams"),
    cb.reason === "feed_outage" ? chip("no price quoted", "err") : "",
    cb.whenOpen ? chip("during business hours", "warn") : "",
  ].join("");
  const el = els.toast;
  el.hidden = false;
  el.classList.add("pk-toast");
  el.innerHTML = `
    <div class="pk-toast-head">
      <span class="pk-avatar">${escapeHtml(where.charAt(0).toUpperCase())}</span>
      <div><strong>${escapeHtml(cb.queue ?? `${where} merchandiser`)}</strong><span class="muted">Callback request · logged by the bid line</span></div>
      ${chip("callback", "warn")}
    </div>
    <p class="pk-topic">${escapeHtml(`Call back: ${cb.commodity ?? "grain"} – ${where}`)}</p>
    ${cb.callContext ? `<p class="pk-context">${escapeHtml(cb.callContext)}</p>` : ""}
    <div class="pk-tags">${tags}</div>
    <div class="pk-caller-card"><strong>${escapeHtml(cb.maskedPhone ?? "")}</strong><span class="unverified">Caller ID only — not verified</span></div>
    <p class="callback-note">Logged in the audit trail, not a live call. How it reaches the merchandiser — a Teams message, a task — is up to your deployment.</p>`;
  el.classList.remove("pk-arrive");
  void el.offsetWidth;
  el.classList.add("pk-arrive");
  els.toastEmpty.hidden = true;
  renderHeaders(els.headers, []);
  els.headersNote.textContent = "No transfer, so no VoIP headers — the callback request is in the audit log.";
  els.headersNote.hidden = false;
}

function renderToastPlaceholder() {
  if (view.handoff || view.callback) return;
  const snap = view.snap;
  const d = snap?.decision;
  els.toastEmpty.textContent = !snap
    ? "No call has been handed over yet."
    : snap.state === "transferring"
      ? "Transferring — the merchandiser's Teams client is about to ring."
      : snap.pending?.kind === "offer"
        ? `${view.offer ?? "Offered the merchandiser"} — waiting for the caller's answer.`
        : d?.kind === "after_hours"
          ? `${String(d.detail).replace(/, so .*$/, "")} — no transfer; the agent gave the hours.`
          : snap.state === "ended"
            ? "No handoff on this call."
            : "No call has been handed over yet.";
}

// --------------------------------------------------------------- the feed

async function refreshFeed() {
  try {
    applyFeed(await getJson("/api/demo/feed"));
  } catch {
    // Keep the last state on screen.
  }
}

function applyFeed(data) {
  if (!data?.feed) return;
  feed = { up: Boolean(data.feed.up), adjustable: data.adjustable !== false, health: data.health ?? null };
  renderFeed();
}

function renderFeed() {
  if (!feed) return;
  const h = feed.health;
  if (feed.up) {
    const open = (h?.marketSessionState ?? "open") === "open";
    const stale = open && h?.futuresAgeMinutes > (h?.staleAfterMinutes ?? policy.futuresStaleMinutes);
    const age = !open
      ? h?.marketSessionState === "holiday"
        ? "exchange holiday"
        : "market closed"
      : typeof h?.futuresAgeMinutes === "number"
        ? `futures up to ${count(h.futuresAgeMinutes, "minute")} old`
        : "";
    els.feedStatus.dataset.tone = stale ? "warn" : "ok";
    els.feedStatus.innerHTML = `Up · ${escapeHtml(h?.source ?? "fixture")} feed${age ? ` <small>· ${escapeHtml(age)}</small>` : ""}`;
  } else {
    els.feedStatus.dataset.tone = "err";
    els.feedStatus.innerHTML = "Down <small>— no price can be quoted</small>";
  }
  els.feedToggle.textContent = feed.up ? "Take the feed down" : "Bring the feed back";
  els.feedToggle.disabled = live || !feed.adjustable;
  if (live) els.feedToggle.title = "Demo controls are off while this server answers real calls.";
}

// ---------------------------------------------------------------- metrics

function renderStats(stats) {
  if (!stats) return;
  renderMetrics(els.metrics, [
    ["Calls", stats.calls],
    ["Quotes given", stats.quotesGiven],
    ["Clarifying questions", stats.clarifications],
    ["Delayed-price caveats", stats.delayedQuotes],
    ["Last-close quotes", stats.closePriceQuotes],
    ["Feed-down refusals", stats.feedOutages],
    ["Advice declined", stats.adviceDeclined],
    ["Lock / book declined", stats.contractsDeclined],
    ["Handoffs", stats.transfers],
    ["Callbacks", stats.callbacks],
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
  const stale = health.pricing?.futuresStaleMinutes;
  if (typeof stale === "number") policy.futuresStaleMinutes = stale;
  renderFeed();
  if (stack) stack.setLive(live);
  else stack = mountStack($("stack"), { live, nodes: stackNodes() });
}

/** Open and closed, and the feed's age, follow the demo clock. */
function onClock(state) {
  const key = `${state?.preset}|${Math.floor((state?.now ?? 0) / 60_000)}`;
  if (key === clockKey) return;
  clockKey = key;
  refreshLocations();
  refreshFeed();
}

async function refreshLocations() {
  const seq = ++locationsSeq;
  try {
    const data = await getJson("/api/locations");
    if (seq === locationsSeq) applyLocations(data);
  } catch {
    // Keep the last good list.
  }
}

function applyLocations(data) {
  org = data.organization ?? org;
  locationsInfo = data.locations ?? [];
  locationById = new Map(locationsInfo.map((l) => [l.id, l]));
  els.org.textContent = org;
  document.title = `${org} — Bid line`;
  render();
}

/** After a hub reconnect: catch up on anything missed while it was down. */
async function refreshAll() {
  await Promise.all([loadHealth(), refreshLocations(), clock.refresh(), refreshStats(), refreshFeed()]);
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
  cardKey = "";
  transcript.clear();
  trail.clear();
  clearTeamsToast(els.toast, els.toastEmpty);
  renderHeaders(els.headers, []);
  els.headersNote.hidden = true;
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
els.feedToggle.addEventListener("click", () =>
  act(async () => {
    await setFeed(!(feed?.up ?? true));
    flash(els.feedStatus);
  }),
);

els.reset.addEventListener("click", async () => {
  director.stop();
  try {
    const result = await postJson("/api/demo/reset");
    session.reset();
    clearPanels();
    renderStats(result.stats);
    const [state] = await Promise.all([clock.refresh(), refreshFeed(), refreshLocations()]);
    director.load(0);
    const label = state?.presets?.find((p) => p.id === state.preset)?.label;
    notify(`Demo reset — clean audit, ${label ? `clock on “${label}”` : "starting clock"}, feed up, beat 1.`, "ok");
  } catch (error) {
    if (error.status === 403) notify("Reset is off while this server answers real calls.", "warn");
    else notify(error.message, "err");
  }
});
