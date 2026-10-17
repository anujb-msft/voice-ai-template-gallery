/**
 * The after-hours lead-capture console.
 *
 * A viewer of the server's lead-capture state machine, never a second copy of
 * it. Every decision on screen — sales open or closed, the lead score, the
 * read-back, the owner and the callback deadline, whether anyone is paged — is
 * one the server made and published over the hub; this file only explains it.
 * Both sides of the transcript come from the server too: a typed caller line
 * is posted, and it appears when the hub sends it back, never before.
 *
 * The plumbing every template shares (hub, call session, demo director, Teams
 * toast, gauge, trail) comes from the presenter kit, and the on-stage script
 * lives in beats.js.
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
  renderChecks,
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

// The demo callers from beats.js. The server sees only the number; the name is
// for the presenter, and the caller says who they are on the call.
const CALLERS = [
  { phone: "+14255550193", name: "Dana Morgan" },
  { phone: "+14255550175", name: "Pat Kim" },
  { phone: "+14255550128", name: "Casey Quinn" },
  { phone: "+14255550111", name: "Lee Park" },
  { phone: "+14255550162", name: "Sam Rivera" },
  { phone: "+14255550184", name: "Robin Diaz" },
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
  noAnswer: $("noAnswer"),
  checks: $("checks"),
  facts: $("facts"),
  rules: $("rules"),
  toast: $("toast"),
  toastEmpty: $("toastEmpty"),
  headers: $("headers"),
  metrics: $("metrics"),
};
// The paging window: the on-call rep's Teams rings while the caller holds.
const win = createCountdown(els.win);

const TERMINAL = new Set(["transferred", "ended"]);
const HANDING_OFF = new Set(["paging", "transferring"]);
const CONVERSING = new Set(["greeting", "discovery", "qualifying", "confirming"]);

// Defaults until /health answers; the server's numbers win.
const capture = { pageWindowMs: 6000, callTimeBudgetMs: 360_000 };

// Calls the server classified as not sales: no lead, a pointer instead.
const NON_SALES = {
  "existing-customer": {
    label: "an existing customer",
    headline: "A support call, not a lead",
    verdict: "existing order → support line",
  },
  "job-seeker": { label: "a job seeker", headline: "A job inquiry, not a lead", verdict: "job seeker → careers page" },
  spam: { label: "spam", headline: "Spam, not a lead", verdict: "spam → polite goodbye" },
  emergency: { label: "an emergency", headline: "An emergency, not a lead", verdict: "emergency → emergency services" },
};

let health = null;
let policy = null;
let org = "Contoso Industrial Supply";
let stack = null;
let clockLocked = false;
let sending = false;
let toastSig = "";
let view = blankView();

/** What the console has learned about the call on screen, beyond its snapshot. */
function blankView() {
  return {
    snap: null,
    handoff: null, // the last handoff frame: paging, then transferred
    corrected: null, // { from, to }: the caller corrected the callback number
    refused: false, // the server refused to save a number nobody had confirmed
    callerId: null, // the caller-ID number the call arrived with
    frozenMs: null,
    syncedAt: 0,
  };
}

const terminal = (snap) => TERMINAL.has(snap?.state);
const handingOff = (snap) => HANDING_OFF.has(snap?.state);
const blank = (value) => value == null || String(value).trim() === "";
const cap = (text) => (text ? String(text).charAt(0).toUpperCase() + String(text).slice(1) : "");
const lower = (text) => (text ? String(text).charAt(0).toLowerCase() + String(text).slice(1) : "");
const count = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString("en-US") : String(n));
const firstName = (name) => String(name ?? "").trim().split(/\s+/)[0] ?? "";
const agentLabel = () => `${org.split(" ")[0]} assistant`;
const repName = (snap) => snap?.onCallRep?.displayName ?? policy?.onCall?.repName ?? "the on-call rep";
const salesQueue = () => policy?.salesQueue ?? `${org} Sales Queue`;
const maxPoints = () => view.snap?.qualification?.maxPoints ?? policy?.scoring?.maxPoints ?? 8;
const hotAt = () => view.snap?.qualification?.thresholds?.hot ?? policy?.scoring?.thresholds?.hot ?? 6;
const warmAt = () => view.snap?.qualification?.thresholds?.warm ?? policy?.scoring?.thresholds?.warm ?? 3;
const hasLeadDetail = (draft) => Boolean(draft && (draft.productInterest || draft.quantity || draft.timeline || draft.role));
// In hours the server sends the caller straight to sales; 0 does too when the queue is full.
const toSales = (snap) => snap?.transferKind === "sales";
const inHours = (snap) => snap?.routeDecision?.action === "transfer";

/** +14255550193 → 425-555-0193, the way the agent reads it back. */
function groups(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return ten.length === 10 ? `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}` : String(phone ?? "");
}

const stackNodes = () =>
  voiceStack({
    voiceLive: health?.voiceLive?.model ?? "gpt-realtime",
    tools: "Lead policy",
    toolsSim: "real policy code",
    agent: "Sales team in Teams",
    agentSim: "mock toast",
  });

// ------------------------------------------------------------------ wiring

const voice = createVoice($("voice"), { lang: "en-US" });
// Sales hours and on-call cover follow the demo clock, so the rules list does too.
const clock = mountClock($("clock"), { onChange: () => render() });
const transcript = createTranscript($("transcript"), {
  voice,
  empty: "Answer a call, or press Next ▶ to run the demo script.",
});
const trail = createTrail($("events"), {
  good: ["lead_saved", "lead_merged", "phone_confirmed", "email_confirmed", "page_accepted", "page_connected"],
  warn: ["phone_corrected", "page_started", "asked_for_person", "non_sales", "save_refused", "page_cancelled"],
  bad: ["page_failed", "transfer_failed", "budget_expired"],
  timeZone: () => clock.state?.timeZone,
  empty: "Every field, score and routing decision shows up here.",
});
const session = createCallSession({ voice, onMessage, onFollow: () => clearPanels() });
connectHub((target, payload) => session.handle(target, payload), {
  onOpen: ({ reconnected }) => reconnected && refreshAll(),
});
const sim = createSimulator({
  session,
  startBody,
  onSnapshot: applySnapshot,
  actions: { metrics: showMetrics, awaitHandoff },
});
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
// Open or closed, and who is on call, follow the clock: keep the rules honest.
setInterval(() => clock.refresh(), 60_000);
boot();

async function boot() {
  renderCallers();
  renderHeaders(els.headers, []);
  render();
  await Promise.all([loadHealth(), loadPolicy(), refreshStats()]);
  stack ??= mountStack($("stack"), { nodes: stackNodes() });
  render();
}

// ------------------------------------------------------------- call steps

function startBody(step) {
  const phone = "fromPhone" in step ? (step.fromPhone ?? "") : els.callerSelect.value;
  els.callerSelect.value = phone;
  return step.scenario ? { fromPhone: phone || null, scenario: step.scenario } : { fromPhone: phone || null };
}

/** Director and button steps. A new call hangs up the one on screen first. */
async function perform(step) {
  if (step.type === "start") {
    // A quick Next shouldn't cancel a page or a transfer that is about to land.
    const deadline = performance.now() + capture.pageWindowMs + 3000;
    while (handingOff(view.snap) && performance.now() < deadline) await sleep(100);
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

/** The paging beat: the rep's Teams rings for the page window, then the call is handed over. */
async function awaitHandoff() {
  const deadline = performance.now() + capture.pageWindowMs + 4000;
  while (handingOff(view.snap) && performance.now() < deadline) await sleep(100);
  if (!session.id || terminal(view.snap)) return;
  try {
    applySnapshot(await getJson(`/api/calls/${encodeURIComponent(session.id)}`));
  } catch {
    // The hub catches up on its own.
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
      // Both sides arrive here: the console never adds a line of its own.
      transcript.add(payload.role, payload.text, { label: payload.role === "agent" ? agentLabel() : "Caller" });
      break;
    case "event":
      onEvent(payload);
      break;
    case "handoff":
      view.handoff = payload;
      render();
      break;
  }
}

/**
 * Snapshots arrive twice — over the hub and in each simulate response — and
 * not always in order. Older ones are ignored, and so is anything after the
 * call finished, unless the page changed: a page nobody answers reopens a
 * transferred call just long enough to close it politely.
 */
function applySnapshot(snap) {
  if (!snap?.id) return;
  if (session.id && snap.id !== session.id) return;
  const prev = view.snap?.id === snap.id ? view.snap : null;
  if (prev && terminal(prev) && !terminal(snap) && prev.page === snap.page) return;
  if (prev && (snap.elapsedMs ?? 0) < (prev.elapsedMs ?? 0)) return;

  if (!prev) view.callerId ??= snap.draft?.callbackPhone ?? null;
  const before = prev?.draft?.callbackPhone;
  const after = snap.draft?.callbackPhone;
  if (before && after && before !== after) {
    view.corrected = { from: view.corrected?.from ?? before, to: after };
    transcript.system(`Callback number corrected: ${groups(before)} → ${groups(after)}`);
  }

  view.snap = snap;
  view.syncedAt = performance.now();
  updateWindow(prev, snap);
  if (terminal(snap) && !terminal(prev)) refreshStats({ highlight: true });
  render();
}

/** The paging window drains while the rep's Teams rings, then says how it ended. */
function updateWindow(prev, snap) {
  const rep = repName(snap);
  if (snap.state === "paging") {
    if (prev?.state !== "paging") {
      const ms = snap.pageRemainingMs ?? snap.pageWindowMs ?? capture.pageWindowMs;
      win.start(ms, (left, leftMs) =>
        leftMs > 0 ? `Paging ${rep} in Teams · ${left} — the caller stays on the line` : `Paging ${rep}…`,
      );
    }
    return;
  }
  if (snap.page === "failed" && prev?.page !== "failed") {
    win.stop("warn", `No answer from ${rep} — the lead waits for the morning`);
    return;
  }
  if (snap.page === "cancelled" && prev?.page !== "cancelled") {
    win.stop("muted", "Page cancelled — the caller hung up");
    return;
  }
  if (snap.transferKind !== "on-call" || snap.page === "failed" || snap.page === "cancelled") return;
  if (snap.state === "transferring" && prev?.state !== "transferring") {
    win.finish("accent", `Connecting the caller to ${rep} in Teams…`);
  } else if (snap.state === "transferred" && (prev?.state !== "transferred" || prev?.page !== snap.page)) {
    win.finish(
      "ok",
      snap.page === "connected" ? `${rep} picked up — the call is handed over in Teams` : `Handed over to ${rep} in Teams`,
    );
  }
}

function onEvent(e) {
  trail.add(e);
  const detail = String(e.detail ?? "");
  const snap = view.snap;
  switch (e.kind) {
    case "route_decision":
      transcript.system(detail);
      break;
    case "lookup_catalog":
      transcript.tool("lookup_catalog", `“${detail}”`, "accent");
      break;
    case "asked_for_person":
      transcript.system("Asked for a person — the server decides who, if anyone, once the lead is saved");
      stack?.flow(["voice-live", "tools"]);
      break;
    case "dtmf":
      transcript.tool("keypad", detail === "0" ? "0 · a person, please" : detail, "accent");
      break;
    case "save_refused":
      view.refused = true;
      transcript.tool(
        "save_lead",
        detail === "contact_unconfirmed"
          ? "refused — the callback number hasn't been read back yet"
          : `refused — ${detail.replace(/_/g, " ")}`,
        "err",
      );
      break;
    case "lead_saved": {
      const q = snap?.qualification;
      transcript.tool("save_lead", q ? `${detail} created · ${q.score}, ${q.points} of ${q.maxPoints} points` : `${detail} created`, "ok");
      break;
    }
    case "lead_merged":
      transcript.tool("save_lead", `merged into ${detail} — a repeat call from the same number`, "ok");
      break;
    case "page_decision": {
      const m = /^(\w+): (.*)$/.exec(detail);
      if (!m || m[1] === "sales_open") break;
      const [, code, reason] = m;
      const paged = code === "hot_urgent" || code === "asked_for_person";
      transcript.system(paged ? `Paging the on-call rep: ${lower(reason)}` : `Not paged: ${lower(reason)}`);
      break;
    }
    case "non_sales":
      transcript.tool("classify_non_sales", `${NON_SALES[detail]?.label ?? detail} — no lead created`, "warn");
      stack?.flow(["voice-live", "tools"]);
      break;
    case "transfer_simulated":
    case "transfer_succeeded":
      transcript.system(`↪ Handed over to ${detail === "on-call" ? repName(snap) : salesQueue()} in Teams`);
      break;
    case "transfer_failed":
      transcript.system(`Transfer failed: ${detail}`);
      break;
    case "page_failed":
      transcript.system(`No answer from ${repName(snap)} — the lead waits for the morning`);
      break;
    case "page_cancelled":
      transcript.system("The caller hung up while the rep's Teams was ringing — page cancelled");
      break;
    case "no_input":
      transcript.system("— the caller says nothing —");
      break;
    case "budget_expired":
      transcript.system("Out of time — the assistant saves what it has");
      break;
  }
  render();
}

// ----------------------------------------------------------------- render

function render() {
  const snap = view.snap;
  setStateChip(els.stateChip, snap?.state ?? null, chipTone(snap));
  renderControls();
  renderDecision(els.decision, { ...decision(snap), empty: "Answer a call to see what the server decides." });
  renderGaugePanel();
  renderChecksPanel();
  renderFactsPanel();
  renderRules();
  renderTeams();
  tickBudget();
}

function chipTone(snap) {
  const state = snap?.state;
  if (state === "ended") return snap.savedLeadId || snap.nonSales ? "ok" : "muted";
  if (state === "confirming" || state === "paging") return "warn";
  if (CONVERSING.has(state) || state === "saving") return "accent";
  return toneOf(state);
}

function renderControls() {
  const active = Boolean(session.id && !session.finished && !session.followed && view.snap && !terminal(view.snap));
  for (const el of [els.sayInput, els.sayBtn, els.silence, els.hangup]) el.disabled = !active;
  for (const button of els.keys.querySelectorAll("button")) button.disabled = !active;
  const paging = active && view.snap.state === "paging";
  els.noAnswer.hidden = !paging;
  els.noAnswer.disabled = !paging;
}

/** The headline: what the server decided, and why, in plain English. */
function decision(snap) {
  if (!snap) return {};
  if (toSales(snap)) return salesDecision(snap);
  if (snap.nonSales) return nonSalesDecision(snap.nonSales);
  if (snap.transferKind === "on-call") return pageDecision(snap);
  if (snap.savedLeadId) return leadDecision(snap);

  const draft = snap.draft ?? {};
  const route = snap.routeDecision;
  if (snap.state === "confirming") {
    const fromCallerId = view.callerId && draft.callbackPhone === view.callerId;
    return {
      headline: view.corrected ? "Reading back the corrected number" : "Reading back the callback number",
      why: view.corrected
        ? `The caller corrected the number to ${groups(view.corrected.to)}, so the new number is read back too. Nothing is saved until the caller confirms it.`
        : view.refused
          ? "The server refused to save a callback number nobody had confirmed, so the assistant reads it back first."
          : `${fromCallerId ? "The number came from caller ID, and caller ID isn't always the best number to call back." : "The caller gave a number."} The server won't save it until the caller confirms it.`,
      verdict: "nothing saved until it's confirmed",
      tone: "warn",
    };
  }
  if (terminal(snap) || snap.state === "closing") return endedDecision(snap);
  if (snap.state === "ringing" || snap.state === "routing") {
    return {
      headline: "Checking the sales hours…",
      why: "The server checks the clock and the sales queue before the assistant says a word.",
    };
  }
  if (snap.state === "saving") {
    return { headline: "Saving the lead…", why: "The server scores the lead, picks the owner and sets the callback deadline." };
  }

  const q = snap.qualification;
  const detail = hasLeadDetail(draft);
  const missing = stillToAsk(draft);
  const why = [
    detail && q
      ? `${q.points} of ${q.maxPoints} points so far — hot starts at ${q.thresholds?.hot ?? hotAt()}.`
      : route?.reason
        ? `${route.reason}.`
        : "",
    missing.length ? `Still to ask: ${listOf(missing)}.` : "",
    snap.askedForPerson ? "The caller asked for a person: the server decides who, if anyone, once the lead is saved." : "",
  ];
  return {
    headline: detail
      ? `Qualifying ${firstName(draft.name) || "the caller"}`
      : route?.overflow
        ? "Sales is busy — taking the details"
        : "Sales is closed — taking the details",
    why: why.filter(Boolean).join(" "),
    verdict: route?.overflow ? "sales queue full → capture" : "sales closed → capture",
    tone: "accent",
  };
}

function salesDecision(snap) {
  const queue = salesQueue();
  if (String(snap.outcome ?? "").startsWith("transfer_failed")) {
    return {
      headline: "Couldn't reach the sales queue",
      why: "The transfer to the sales queue failed, so the call ended. The failure is in the trail.",
      verdict: "transfer failed",
      tone: "err",
    };
  }
  const headline = `${snap.state === "transferred" ? "Handed to" : "Connecting to"} ${queue}`;
  if (inHours(snap)) {
    return {
      headline,
      why: `${snap.routeDecision.reason}. The server checked the clock, not the model, and the assistant stayed out of the way.`,
      verdict: "sales open → sales queue",
      tone: "ok",
    };
  }
  return {
    headline,
    why: `${snap.routeDecision?.overflow ? "The sales queue was full, so the assistant was taking the details. " : ""}The caller pressed 0 while sales was open, so the assistant put them in the sales queue, and what was captured so far goes with the call.`,
    verdict: "keypad 0 → sales queue",
    tone: "ok",
  };
}

function nonSalesDecision(nonSales) {
  const kind = NON_SALES[nonSales.kind] ?? NON_SALES["existing-customer"];
  const support = policy?.support;
  const why = {
    "existing-customer": `The caller has a question about an existing order, so the assistant pointed them to support${
      support?.phone ? ` at ${support.phone}${support.hours ? `, ${support.hours}` : ""}` : ""
    }.`,
    "job-seeker": "The caller is looking for a job, so the assistant pointed them to the careers page.",
    spam: "It's spam, so the assistant ended the call politely.",
    emergency: "The caller described an emergency, so the assistant told them to hang up and call emergency services.",
  }[nonSales.kind] ?? "It isn't a sales call, so the assistant pointed the caller to the right place.";
  return {
    headline: kind.headline,
    why: `${why} No lead was created, so the sales pipeline stays clean.`,
    verdict: kind.verdict,
    tone: "warn",
  };
}

function pageDecision(snap) {
  const rep = repName(snap);
  const reason = snap.pageDecision?.reason;
  if (snap.page === "failed") {
    return {
      headline: `No answer from ${rep}`,
      why: `${rep} didn't pick up in Teams, so the assistant apologized and told the caller when to expect a call. The lead is saved, and the follow-up message says the page wasn't answered.`,
      verdict: "page unanswered → morning queue",
      tone: "warn",
    };
  }
  if (snap.page === "cancelled") {
    return {
      headline: "Page cancelled",
      why: `The caller hung up while ${rep}'s Teams was ringing. The lead is saved for the morning.`,
      verdict: "caller hung up → morning queue",
      tone: "muted",
    };
  }
  const connected = snap.state === "transferred";
  return {
    headline: connected ? `Handed to ${rep}` : `Paging ${rep}`,
    why: `${reason ? `${reason}.` : "The policy decided to page."} ${
      connected
        ? "The handoff carries the lead, the urgency and the reason for the page."
        : "The caller stays on the line while Teams rings."
    }`,
    verdict: snap.pageDecision?.code === "asked_for_person" ? "asked for a person → page on call" : "hot and urgent → page on call",
    tone: connected ? "ok" : "warn",
  };
}

function leadDecision(snap) {
  const lead = snap.lead ?? {};
  const follow = snap.followUp ?? {};
  const score = String(lead.score ?? snap.score ?? "");
  const owner = follow.ownerName ?? lead.ownerName ?? "A sales rep";
  const pd = snap.pageDecision;
  const merged = Boolean(snap.duplicateOf);
  const why = [
    merged ? "The same number called before, so this call was added to the earlier lead instead of creating a second one." : "",
    lead.partial ? "The call ended before everything was confirmed, so this is a partial lead." : "",
    `${owner} owns it and calls back by ${follow.dueLabel ?? "the deadline"}.`,
    pd?.reason && pd.code !== "sales_open" && (pd.hot || pd.urgent || pd.askedForPerson) ? `Not paged: ${lower(pd.reason)}.` : "",
  ];
  let verdict = `${score} → callback ${follow.phrase ?? "soon"}`;
  let tone = "ok";
  if (lead.partial) [verdict, tone] = ["partial lead → follow-up", "warn"];
  else if (pd?.code === "no_cover") [verdict, tone] = ["no on-call cover → morning queue", "warn"];
  else if (pd?.code === "warm_waits") [verdict, tone] = ["warm, not paged → morning queue", "warn"];
  else if (pd?.code === "not_qualified") [verdict, tone] = ["not qualified → morning queue", "warn"];
  else if (pd?.code === "not_needed" && pd.hot) verdict = "hot, not urgent → morning queue";
  else if (merged) verdict = "repeat call → merged";
  return {
    headline: merged ? `Repeat call — merged into ${snap.savedLeadId}` : `Lead saved — ${score.toUpperCase()}`,
    why: why.filter(Boolean).join(" "),
    verdict,
    tone,
  };
}

function endedDecision(snap) {
  const reasons = {
    caller_hung_up: ["Caller hung up", "The caller hung up before a callback number was confirmed, so nothing was saved."],
    no_input: ["The caller went quiet", "The caller stopped responding before leaving enough to save a lead."],
    no_contact: ["No way to call back", "The caller didn't leave a number or an email, so there was nothing to follow up on."],
    time_budget: ["Out of time", "The time budget ran out before there was enough to save a lead."],
  };
  const [headline, why] = reasons[snap.outcome] ?? [
    snap.state === "closing" ? "Wrapping up" : "Call ended",
    "The call ended without a lead.",
  ];
  return { headline, why, verdict: "no lead", tone: "muted" };
}

/** What the agent still needs, in the order it asks. */
function stillToAsk(draft) {
  const missing = [];
  if (!draft.productInterest) missing.push("the product");
  if (!draft.quantity) missing.push("the quantity");
  if (!draft.name || !draft.company) missing.push("name and company");
  if (!draft.timeline) missing.push("the timeline");
  if (!draft.role) missing.push("who decides");
  if (draft.callbackPhone ? !draft.phoneConfirmed : !(draft.email && draft.emailConfirmed)) {
    missing.push(draft.callbackPhone ? "the callback number read-back" : "a callback number");
  }
  return missing;
}

const listOf = (items) =>
  items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

function renderGaugePanel() {
  const snap = view.snap;
  if (toSales(snap)) {
    renderGauge(els.gauge, {
      value: null,
      gate: null,
      label: inHours(snap) ? "sales is open — no scoring needed" : "sent to the sales queue — not scored",
    });
    return;
  }
  if (snap?.nonSales) {
    renderGauge(els.gauge, { value: null, gate: null, label: "not a sales call — not scored" });
    return;
  }
  const q = snap?.qualification;
  const max = maxPoints();
  const scored = Boolean(q && hasLeadDetail(snap.draft));
  renderGauge(els.gauge, {
    value: scored ? q.points : null,
    gate: hotAt(),
    min: 0,
    max,
    format: (v) => `${v} of ${max}`,
    label: scored ? `${cap(q.score)} lead · hot starts at` : "Lead score · hot starts at",
  });
}

/** Each scoring rule, in plain English, as the server explains it. */
function renderChecksPanel() {
  const snap = view.snap;
  const rows = snap?.qualification?.rows ?? [];
  const placeholder = !snap
    ? "Each answer is scored here, in plain English."
    : toSales(snap)
      ? "Not scored — a sales rep takes the call."
      : snap.nonSales
        ? "Not scored — not a sales call."
        : rows.length
          ? null
          : "Waiting for the server's score.";
  if (placeholder) {
    renderChecks(els.checks, [{ label: placeholder, tone: "idle" }]);
    return;
  }
  renderChecks(
    els.checks,
    rows.map((r) => ({
      label: `${r.label} · ${r.points} of ${r.max}`,
      detail: r.detail,
      tone: blank(snap.draft?.[r.rule]) ? "idle" : r.points >= r.max ? "ok" : r.points === 0 ? "err" : "warn",
    })),
  );
}

function renderFactsPanel() {
  const snap = view.snap;
  if (!snap) {
    renderFacts(els.facts, []);
    return;
  }
  const d = snap.draft ?? {};
  const lead = snap.lead;
  const salesCall = toSales(snap);

  const who = [d.name, d.role, d.company].filter(Boolean).join(" · ");
  const caller = who
    ? `${escapeHtml(who)} <span class="muted">· as the caller said</span>`
    : salesCall
      ? "not asked — a sales rep takes the call"
      : "not given yet";

  const product = d.productInterest ?? "";
  const needs = [
    d.quantity ? `${count(d.quantity)} ${product || "units"}` : product,
    d.timeline,
  ].filter(Boolean).join(" · ");

  let callback = ["Callback", ""];
  if (d.callbackPhone) {
    const number = groups(d.callbackPhone);
    if (salesCall && inHours(snap)) {
      callback = ["Callback", `${number} · caller ID, not verified`];
    } else if (d.phoneConfirmed) {
      callback = [
        "Callback",
        view.corrected ? `${number} · corrected from ${groups(view.corrected.from)}, then read back and confirmed` : `${number} · read back and confirmed`,
        { tone: "ok" },
      ];
    } else {
      callback = [
        "Callback",
        view.corrected
          ? `${number} · corrected from ${groups(view.corrected.from)}, not read back yet`
          : d.callbackPhone === view.callerId
            ? `${number} · caller ID, not read back yet`
            : `${number} · not read back yet`,
        { tone: "warn" },
      ];
    }
  } else if (!salesCall && !snap.nonSales) {
    callback = ["Callback", "no number yet — caller ID withheld"];
  }

  const leadRow = lead
    ? `${lead.id} · ${String(lead.score).toUpperCase()}${lead.partial ? " (partial)" : ""} · ${lead.ownerName ?? "unassigned"}`
    : snap.nonSales
      ? "not created — not a sales call"
      : salesCall
        ? "none — a sales rep takes the call"
        : terminal(snap)
          ? "not saved"
          : "not saved yet";

  const follow = snap.followUp;
  const followUp = follow ? `${follow.ownerName ?? lead?.ownerName ?? "A sales rep"} calls back by ${follow.dueLabel ?? follow.dueAt}` : "";

  const messages = lead?.messages ?? [];
  const teams = messages.find((m) => m.channel === "teams") ?? messages[0];
  const channels = [...new Set(messages.map((m) => (m.channel === "teams" ? "Teams" : "email")))];
  const outbox = teams
    ? `${channels.join(" and ")} to ${teams.toName}${teams.mentionManager && teams.managerName ? `, @${teams.managerName}` : ""} · queued in the outbox`
    : "";

  renderFacts(els.facts, [
    ["Caller", caller, { html: Boolean(who) }],
    !salesCall && ["Needs", needs],
    callback,
    d.email && ["Email", `${d.email} · ${d.emailConfirmed ? "read back and confirmed" : "not read back yet"}`],
    ["Lead", leadRow, lead ? { tone: lead.partial ? "warn" : "ok" } : {}],
    followUp && ["Follow-up", followUp],
    pageRow(snap),
    outbox && ["Messages", outbox],
  ]);
}

/** Whether anyone was paged, and why not when it mattered. */
function pageRow(snap) {
  const rep = repName(snap);
  switch (snap.page) {
    case "started":
      return ["On call", `${rep} · ringing in Teams`, { tone: "warn" }];
    case "connected":
      return ["On call", `${rep} · picked up`, { tone: "ok" }];
    case "failed":
      return ["On call", `${rep} · no answer — the lead waits for the morning`, { tone: "warn" }];
    case "cancelled":
      return ["On call", `${rep} · page cancelled — the caller hung up`];
  }
  const pd = snap.pageDecision;
  if (!pd || pd.code === "sales_open" || !(pd.hot || pd.urgent || pd.askedForPerson)) return null;
  return ["On call", `not paged — ${lower(pd.reason)}`, pd.code === "no_cover" ? { tone: "warn" } : {}];
}

/** The rules the server applies, and which one is deciding this call. */
function renderRules() {
  if (!policy) {
    renderList(els.rules, [], { empty: "Loading the rules…" });
    return;
  }
  const c = clock.state;
  const active = activeRule(view.snap);
  const onCall = policy.onCall;
  const weekdays = String(onCall?.days ?? []) === "1,2,3,4,5";
  const snap = view.snap;
  const score = snap?.score ?? (snap && !toSales(snap) && !snap.nonSales && hasLeadDetail(snap.draft) ? snap.qualification?.score : null);
  const items = [
    {
      id: "hours",
      label: "Sales hours",
      meta: [policy.salesHours, "in hours, callers go straight to the sales queue"].filter(Boolean).join(" · "),
      status: c ? (c.salesOpen ? "open" : "closed") : "",
      tone: c?.salesOpen ? "ok" : "muted",
    },
    {
      id: "onCall",
      label: onCall?.repName ? `On call: ${onCall.repName}` : "On call",
      meta: onCall
        ? `${weekdays ? "weekdays" : "set days"} until ${onCall.until} · paged for hot and urgent, or a person on request`
        : "no on-call cover is configured",
      status: c?.salesOpen ? "not needed" : c?.onCall?.covered ? "on call" : c ? "no cover" : "",
      tone: !c?.salesOpen && c?.onCall?.covered ? "ok" : "muted",
    },
    {
      id: "score",
      label: "Lead score",
      meta: `hot at ${hotAt()}+ of ${maxPoints()}, warm at ${warmAt()}+ · product, quantity, timeline, decision role`,
      status: score ?? "",
      tone: score === "hot" ? "ok" : score === "warm" ? "warn" : "muted",
    },
    {
      id: "nonSales",
      label: "Not a sales call",
      meta: "support, job seekers and spam get a pointer, not a lead",
      status: "no lead",
      tone: "muted",
    },
  ];
  renderList(
    els.rules,
    items.map(({ id, ...item }) => ({ ...item, active: id === active })),
    { empty: "Loading the rules…" },
  );
}

function activeRule(snap) {
  if (!snap) return null;
  if (snap.nonSales) return "nonSales";
  if (toSales(snap) || ["ringing", "routing", "greeting"].includes(snap.state)) return "hours";
  const pd = snap.pageDecision;
  if (snap.transferKind === "on-call" || (pd && pd.code !== "sales_open" && (pd.urgent || pd.askedForPerson))) return "onCall";
  if (snap.askedForPerson && !snap.savedLeadId) return "onCall";
  if (snap.savedLeadId || hasLeadDetail(snap.draft)) return "score";
  return "hours";
}

function renderCallers() {
  // Names only, so the picker never truncates. The company shows on the lead
  // record and the Teams toast once the caller says it.
  els.callerSelect.innerHTML = CALLERS.map(
    (c) => `<option value="${escapeHtml(c.phone)}">${escapeHtml(c.name)}</option>`,
  ).join("");
}

// ------------------------------------------------------------ Teams side

/**
 * What the sales team sees: a call ringing a rep or the sales queue, or, when
 * nobody needs to pick up tonight, the follow-up message waiting for the
 * lead's owner. Rendered only when something changed, so a toast doesn't
 * re-arrive on every snapshot.
 */
function renderTeams() {
  const snap = view.snap;
  const toast = callToast(snap) ?? messageToast(snap);
  if (!toast) {
    if (toastSig) {
      toastSig = "";
      clearTeamsToast(els.toast, els.toastEmpty);
      renderHeaders(els.headers, []);
    }
    els.toastEmpty.textContent = toastPlaceholder(snap);
    return;
  }
  const sig = JSON.stringify(toast);
  if (sig === toastSig) return;
  toastSig = sig;
  const { kind, ringing, missed, headers, ...card } = toast;
  renderTeamsToast(els.toast, card);
  els.toast.dataset.kind = kind;
  els.toast.dataset.ringing = String(ringing);
  els.toast.dataset.missed = String(missed);
  els.toastEmpty.hidden = true;
  // Built on the server by the same function the real transfer uses.
  renderHeaders(els.headers, headers);
}

/** The call ringing in Teams: the on-call rep's phone, or the sales queue. */
function callToast(snap) {
  const h = view.handoff ?? snap?.handoff;
  if (!snap || !h || snap.page === "failed" || snap.page === "cancelled") return null;
  const d = snap.draft ?? {};
  const onCall = snap.transferKind === "on-call" || h.routeId === "on-call";
  const connected = snap.state === "transferred";
  const failed = String(snap.outcome ?? "").startsWith("transfer_failed");
  const headers = (view.handoff?.voipHeaders ?? []).map((x) => [x.key, x.value]);

  if (onCall) {
    const rep = h.target?.displayName ?? repName(snap);
    const q = snap.qualification;
    return {
      kind: "call",
      ringing: !connected,
      missed: false,
      queue: rep,
      subtitle: "On-call sales rep · paged by the after-hours assistant",
      topic: h.callTopic ?? "",
      context: h.callContext ?? "",
      callerHtml: callerCard(d, { confirmed: d.phoneConfirmed }),
      avatar: rep,
      tags: [
        snap.score && q ? { text: `${snap.score} · ${snap.lead?.points ?? q.points} of ${q.maxPoints}`, tone: "accent" } : null,
        { text: "after hours", tone: "warn" },
        snap.urgency?.urgent ? { text: "urgent", tone: "err" } : null,
        snap.askedForPerson ? { text: "asked for a person", tone: "accent" } : null,
      ].filter(Boolean),
      status: connected ? "Connected" : "Paging…",
      headers,
    };
  }

  const queue = h.target?.displayName ?? salesQueue();
  return {
    kind: "call",
    ringing: !connected && !failed,
    missed: failed,
    queue,
    subtitle: inHours(snap) ? "Call queue · sent straight through in sales hours" : "Call queue · the caller pressed 0",
    topic: h.callTopic ?? "Sales inquiry",
    context: h.callContext ?? "",
    // In hours nobody reads the number back: it is caller ID, whatever the draft says.
    callerHtml: callerCard(d, { confirmed: !inHours(snap) && d.phoneConfirmed }),
    avatar: "Sales",
    tags: [
      { text: "sales", tone: "teams" },
      inHours(snap) ? { text: "in sales hours", tone: "ok" } : { text: "keypad 0", tone: "accent" },
    ],
    status: failed ? "Missed" : connected ? "Connected" : "Incoming call",
    headers,
  };
}

/** The follow-up waiting for the lead's owner when nobody is paged. */
function messageToast(snap) {
  const lead = snap?.lead;
  const teams = lead?.messages?.find((m) => m.channel === "teams");
  if (!snap?.savedLeadId || !teams) return null;
  const d = snap.draft ?? {};
  const score = String(lead.score ?? snap.score ?? "");
  const pd = snap.pageDecision;
  const notPaged = !snap.page && pd && pd.code !== "sales_open" && (pd.hot || pd.urgent || pd.askedForPerson);
  const subject = [d.productInterest ? cap(d.productInterest) : "Sales inquiry", d.company].filter(Boolean).join(" — ");
  return {
    kind: "message",
    ringing: false,
    missed: false,
    queue: teams.toName ?? "Sales",
    subtitle: snap.routeDecision?.overflow ? "Teams message from the overflow assistant" : "Teams message from the after-hours assistant",
    topic: snap.duplicateOf ? `Repeat call · merged into ${snap.savedLeadId}` : `${score.toUpperCase()} lead · ${subject}`,
    context: teams.body,
    callerHtml: callerCard(d, { confirmed: d.phoneConfirmed }),
    avatar: teams.toName ?? "Sales",
    tags: [
      { text: `${score} · ${lead.points} of ${maxPoints()}`, tone: "accent" },
      teams.mentionManager && teams.managerName ? { text: `@${teams.managerName}`, tone: "teams" } : null,
      snap.followUp?.dueLabel ? { text: `due ${snap.followUp.dueLabel}`, tone: "muted" } : null,
      snap.page === "failed" ? { text: "page not answered", tone: "warn" } : null,
      snap.page === "cancelled" ? { text: "page cancelled", tone: "muted" } : null,
      notPaged ? { text: "not paged", tone: "warn" } : null,
      lead.partial ? { text: "partial", tone: "warn" } : null,
    ].filter(Boolean),
    status: "Queued",
    headers: [],
  };
}

/** Who is calling, as the caller said it, and whether the callback number was read back. */
function callerCard(d, { confirmed }) {
  const number = d.callbackPhone ? groups(d.callbackPhone) : "";
  const about = [d.role, d.company].filter(Boolean).join(" · ");
  const head = d.name
    ? `<strong>${escapeHtml(d.name)}</strong>${about ? `<div class="muted">${escapeHtml(about)}</div>` : ""}`
    : `<strong>${escapeHtml(number || "Unknown caller")}</strong>${about ? `<div class="muted">${escapeHtml(about)}</div>` : ""}`;
  if (!number) return `${head}<span class="unverified">No callback number</span>`;
  if (confirmed) return `${head}<span class="verified">Callback ${escapeHtml(number)} · read back and confirmed</span>`;
  const how = d.callbackPhone === view.callerId ? "Caller ID only — not verified" : "Not read back — not verified";
  return `${head}<span class="unverified">${d.name ? `${escapeHtml(number)} · ` : ""}${how}</span>`;
}

function toastPlaceholder(snap) {
  if (!snap) return "Nothing has reached the sales team yet.";
  if (snap.nonSales) return "Nothing — it isn't a sales call, so the caller got a pointer and the sales team isn't bothered.";
  if (snap.state === "saving") return "Saving the lead…";
  if (terminal(snap) || snap.state === "closing") return "Nothing reached the sales team: no lead was saved.";
  if (CONVERSING.has(snap.state)) {
    return "Nothing yet. The lead goes to the sales team once the caller confirms the callback number.";
  }
  return "Nothing has reached the sales team yet.";
}

// ----------------------------------------------------------------- budget

/** The per-call time budget stops once the lead is safe or the call has gone somewhere. */
function budgetStop(snap) {
  if (snap.state === "transferred" || (toSales(snap) && snap.state === "transferring")) return "handed over";
  if (snap.savedLeadId) return "lead saved";
  if (snap.nonSales) return "not a sales call";
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
  renderBudget(els.budget, { elapsedMs, budgetMs: snap.budgetMs ?? capture.callTimeBudgetMs });
  const parts = els.budget.pkBudget;
  if (stop && parts && !els.budget.hidden) {
    parts.label.textContent += ` · ${stop}`;
    parts.fill.dataset.tone = stop === "handed over" || stop === "lead saved" ? "ok" : "muted";
  }
}

// ---------------------------------------------------------------- metrics

function renderStats(stats) {
  if (!stats) return;
  renderMetrics(els.metrics, [
    ["Calls", stats.calls],
    ["Leads captured", stats.leadsCaptured],
    ["Qualified (hot or warm)", stats.qualifiedLeads],
    ["Routed for follow-up", stats.routedLeads],
    ["Live transfers", stats.liveTransfers],
    ["On-call pages answered", `${stats.pagesConnected ?? 0} of ${stats.pagesStarted ?? 0}`],
    ["Not sales calls", stats.nonSalesCalls],
    ["Repeat calls merged", stats.duplicatesMerged],
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

/** The closing beat: wait for the call to finish, then show the numbers. */
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
  for (const key of Object.keys(capture)) {
    const value = health.leadCapture?.[key];
    if (typeof value === "number") capture[key] = value;
  }
  if (stack) stack.setLive(live);
  else stack = mountStack($("stack"), { live, nodes: stackNodes() });
}

async function loadPolicy() {
  try {
    policy = await getJson("/api/policy");
  } catch {
    return;
  }
  org = policy.organization ?? org;
  els.org.textContent = org;
  document.title = `${org} — After-hours lead capture`;
  render();
}

/** After a hub reconnect: catch up on anything missed while it was down. */
async function refreshAll() {
  await Promise.all([loadHealth(), loadPolicy(), clock.refresh(), refreshStats()]);
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
  toastSig = "";
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
  // The line shows in the transcript when the server sends it back over the hub.
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

// The on-call rep doesn't pick up: the server apologizes and the lead waits for the morning.
els.noAnswer.addEventListener("click", () =>
  act(async () => {
    if (!session.id || els.noAnswer.disabled) return;
    els.noAnswer.disabled = true;
    const result = await postJson(`/api/simulate/${encodeURIComponent(session.id)}/no-answer`, {});
    if (result?.snapshot) applySnapshot(result.snapshot);
  }),
);

els.reset.addEventListener("click", async () => {
  director.stop();
  try {
    const result = await postJson("/api/demo/reset");
    session.reset();
    clearPanels();
    renderStats(result.stats);
    await clock.refresh();
    director.load(0);
    notify("Demo reset — no simulated calls or leads, starting clock, beat 1.", "ok");
  } catch (error) {
    if (error.status === 403) notify("Reset is off while this server answers real calls.", "warn");
    else notify(error.message, "err");
  }
});
