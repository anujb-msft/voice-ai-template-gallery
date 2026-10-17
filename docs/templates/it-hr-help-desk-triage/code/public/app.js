/**
 * The help desk console.
 *
 * A viewer of the server's triage policy, never a second copy of it. Every
 * decision on screen — who the caller is, what may be read out, the ticket
 * priority, the private HR route, the destination — is one the server made
 * and published over the hub; this file only explains it. The plumbing every
 * template shares (hub, call session, demo director, Teams toast, gauge,
 * trail) comes from the presenter kit, and the on-stage script lives in
 * beats.js. Simulated calls send nothing: one-time codes and new tickets land
 * in the mock employee chat instead.
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
  chip,
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

// Mirrors config/directory.json, so the presenter can choose who is calling.
// A Teams call arrives signed in; a phone call only has its caller ID.
const CALLERS = [
  { id: "sam", label: "Sam Rivera · Teams", body: { teamsUserId: "8:orgid:11111111-1111-1111-1111-111111111111" } },
  { id: "maria", label: "Maria Lopez · Teams", body: { teamsUserId: "8:orgid:22222222-2222-2222-2222-222222222222" } },
  { id: "sam-mobile", label: "Sam's mobile · phone call", body: { fromPhone: "+14255550101" } },
  { id: "unknown", label: "Unknown number · phone call", body: { fromPhone: "+14255550199" } },
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
  checks: $("checks"),
  otpWindow: $("otpWindow"),
  ticketCard: $("ticketCard"),
  privacy: $("privacy"),
  privacyChecks: $("privacyChecks"),
  facts: $("facts"),
  toast: $("toast"),
  toastEmpty: $("toastEmpty"),
  headers: $("headers"),
  inboxTitle: $("inboxTitle"),
  inbox: $("inbox"),
  inboxEmpty: $("inboxEmpty"),
  routes: $("routes"),
  metrics: $("metrics"),
};

const otp = createCountdown(els.otpWindow, { tickMs: 250 });

const TERMINAL = new Set(["transferred", "ended"]);
const INBOX_TITLES = {
  teams: "The employee's Teams chat",
  email: "The employee's inbox and Teams chat",
  sms: "The employee's phone and Teams chat",
};
const CHANNEL_NAMES = { teams: "Teams chat", email: "work inbox", sms: "mobile phone" };
const DOMAINS = { IT: "IT", HR: "HR", both: "IT and HR" };
// What the caller asked for when the identity gate stopped them.
const PENDING = {
  ticket_status: "a ticket's status",
  my_tickets: "their open tickets",
  personal: "their HR record",
  propose_ticket: "a new ticket",
  send_link: "a link",
};
// What a handoff's call context means to the person who picks up.
const CONTEXT_LABELS = [
  ["ticketNumber", "Ticket"],
  ["priority", "Priority"],
  ["matchedAsset", "Device"],
  ["tried", "Already tried"],
  ["articleCited", "Article"],
  ["intent", "Intent"],
];
// Hints for the typed line, by state.
const PROMPTS = {
  verifying: "The caller says their work email, or reads the code",
  confirming: "Yes or no?",
  clarifying: "The caller answers the question",
  after_hours_offer: "Yes or no to the callback?",
};
// Trail events that explain a call without being the decision the panel headlines.
const QUIET = new Set([
  "state",
  "call_created",
  "tool",
  "tool_rejected",
  "transfer",
  "classified",
  "keypad",
  "human_requested",
  "call_ended",
]);
// Server decisions the kit's stack strip doesn't animate on its own.
const DECIDES =
  /^(classified|low_confidence|clarified|still_unclear|answer|code_|unknown_email|confidential_hr|after_hours|outage_attached|link_sent|personal_|callback_|out_of_scope|password_reset|human_requested)/;
// Audit events that move a footer number. Several beats end with the caller
// still on the line, so the numbers follow these rather than wait for a hang-up.
const COUNTED = new Set([
  "call_created",
  "answered",
  "personal_answer",
  "ticket_status",
  "ticket_created",
  "outage_attached",
  "verified",
  "code_refused",
  "confidential_hr",
  "transfer_failed",
]);

// Defaults until /health answers; the server's config wins.
const triage = { confidenceMin: 0.7, timeBudgetMs: 360_000 };
let otpChannel = "teams";
let health = null;
let org = "Contoso";
let fallbackId = "it-service-desk";
let routesInfo = [];
let routeById = new Map();
let stack = null;
let routesSeq = 0;
let clockLocked = false;
let sending = false;
let view = blankView();

/** What the console has learned about the call on screen, beyond its snapshot. */
function blankView() {
  return {
    snap: null,
    last: null, // { kind, detail }: the latest decisive event
    clarified: null, // the topic one clarifying question settled on
    ticketWhy: null, // filed | status | attached: why the ticket card is showing
    articleLine: null, // { id, li }: the answer tool line, until the snapshot brings the article title
    handoff: null, // the hub's handoff frame, with the reason and the VoIP headers
    codeSentAt: null,
    callbackCase: null,
    transferFailed: null,
    ticketSig: null, // null, not "", so the first render after a clear hides the old card
    frozenMs: null,
    syncedAt: 0,
  };
}

const label = (id) => routeById.get(id)?.label ?? id ?? "";
const queueOf = (id) => routeById.get(id)?.queue ?? label(id);
const fmt = (v) => Number(v).toFixed(2);
const terminal = (snap) => TERMINAL.has(snap?.state);
const capitalize = (text) => (text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "");
const first = () => view.snap?.caller?.firstName ?? "the caller";
const First = () => capitalize(first());
const handedOver = (snap) => snap?.state === "transferring" || snap?.state === "transferred";
const callbackPath = (snap) =>
  snap?.state === "after_hours_offer" || /^(callback_requested|confidential_after_hours_declined)$/.test(snap?.outcome ?? "");

function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A time of day on the demo clock, in the zone the policy runs in. */
function clockTime(iso) {
  const time = new Date(iso ?? Date.now());
  if (Number.isNaN(time.getTime())) return "";
  const options = { hour: "numeric", minute: "2-digit" };
  try {
    return time.toLocaleTimeString([], { ...options, timeZone: clock.state?.timeZone || undefined });
  } catch {
    return time.toLocaleTimeString([], options); // unknown zone name
  }
}

const stackNodes = () =>
  voiceStack({
    caller: "Employee",
    callerLive: "Teams or any phone",
    voiceLive: health?.voiceLive?.model ?? "gpt-realtime",
    tools: "Triage policy",
    toolsSim: "real policy code",
    agent: "IT / HR queues",
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
  good: [
    "answered",
    "ticket_status",
    "outage_attached",
    "callback_requested",
    "personal_answer",
    "clarified",
    "link_sent",
    "transfer",
  ],
  warn: [
    "confidential_hr",
    "verification_required",
    "unknown_email",
    "ticket_not_found",
    "still_unclear",
    "awaiting_yes",
    "ticket_declined",
    "callback_declined",
    "wrap_up",
    "answer_unavailable",
    "personal_unavailable",
  ],
  timeZone: () => clock.state?.timeZone,
  empty: "Every classification, gate and handoff shows up here.",
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
  const caller = CALLERS.find((c) => c.id === (step.caller ?? els.callerSelect.value)) ?? CALLERS[0];
  els.callerSelect.value = caller.id;
  return { ...caller.body };
}

/** Director and button steps. A new call hangs up the one on screen first. */
async function perform(step) {
  if (step.type === "start") {
    // A quick Next shouldn't cut off a handoff that is about to land.
    const deadline = performance.now() + 4000;
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
      transcript.add(payload.role, payload.text, {
        label:
          payload.role === "agent"
            ? `${org} help desk`
            : payload.role === "caller"
              ? (view.snap?.caller?.firstName ?? "Caller")
              : undefined,
      });
      break;
    case "event":
      onEvent(payload);
      break;
    case "handoff":
      view.transferFailed = null;
      view.handoff = payload;
      renderHandoff();
      render();
      break;
    case "outbox":
      addInbox(payload);
      break;
  }
}

/**
 * Snapshots arrive twice — over the hub and in each simulate response — and
 * not always in order. Older ones, and anything after the call finished, are
 * ignored, unless a real transfer failed and the caller is back with the agent.
 */
function applySnapshot(snap) {
  if (!snap?.id) return;
  if (session.id && snap.id !== session.id) return;
  const prev = view.snap?.id === snap.id ? view.snap : null;
  if (prev && terminal(prev) && !terminal(snap) && !view.transferFailed) return;
  if (prev && (snap.elapsedMs ?? 0) < (prev.elapsedMs ?? 0)) return;

  view.snap = snap;
  view.syncedAt = performance.now();
  syncCode(snap);
  if (view.articleLine && snap.lastArticle?.id === view.articleLine.id) {
    const detail = view.articleLine.li?.querySelector(".muted");
    if (detail) detail.textContent = `“${snap.lastArticle.title}”`;
    view.articleLine = null;
  }
  if (terminal(snap) && !terminal(prev)) refreshStats({ highlight: true });
  render();
}

/** The code's life, from the snapshot. The digits themselves only ever appear in the mock chat. */
function syncCode(snap) {
  const v = snap.verification;
  if (!v?.sentAt) return;
  if (v.sentAt !== view.codeSentAt) {
    view.codeSentAt = v.sentAt;
    const ms = Math.max(0, Date.parse(v.expiresAt) - Date.parse(v.sentAt));
    otp.start(ms, (left, leftMs) => (leftMs > 0 ? `Code expires in ${mmss(leftMs)} — it works once` : "Code expired"));
  }
  if (snap.verified && v.lastResult === "verified") otp.finish("ok", "Code accepted — used once, then discarded");
  else if (v.lastResult === "expired") otp.finish("err", "Code expired — refused");
  else if (v.failures >= 2) otp.stop("err", "Two wrong codes — this code is void");
  else if (terminal(snap)) otp.stop("muted", "Call over — this code is void");
}

/** The trail gets every event; the transcript gets the tool the server ran, inline. */
function onEvent(e = {}) {
  const kind = e.kind ?? "";
  const detail = e.detail ?? "";
  trail.add(e);
  if (COUNTED.has(kind)) queueStats();
  if (!QUIET.has(kind)) view.last = { kind, detail };
  if (DECIDES.test(kind)) stack?.flow(["voice-live", "tools"]);
  const tool = (name, text, tone) => transcript.tool(name, text, tone);

  switch (kind) {
    case "classified":
      tool("classify", detail, "ok");
      break;
    case "low_confidence":
      tool("classify", `${detail} — below the ${fmt(triage.confidenceMin)} gate`, "warn");
      break;
    case "clarified":
      view.clarified = detail;
      tool("clarify", `settled: ${detail}`, "ok");
      break;
    case "still_unclear":
      tool("clarify", "still unclear — no second question", "warn");
      break;
    case "answered":
      view.articleLine = { id: detail, li: tool("answer_from_kb", detail, "ok") };
      break;
    case "answer_unavailable":
      tool("answer_from_kb", `${detail} — no approved answer`, "warn");
      break;
    case "ticket_proposed":
      tool("propose_ticket", `${detail} — waiting for a yes`, "warn");
      break;
    case "awaiting_yes":
      tool("create_ticket", "no yes yet — nothing filed", "warn");
      break;
    case "ticket_declined":
      tool("create_ticket", "the caller said no — nothing filed", "muted");
      break;
    case "ticket_created":
      view.ticketWhy = "filed";
      tool("create_ticket", detail, "ok");
      break;
    case "outage_attached":
      view.ticketWhy = "attached";
      tool("attach_to_incident", `${detail} — no duplicate ticket`, "ok");
      break;
    case "ticket_status":
      view.ticketWhy = "status";
      tool("ticket_status", detail, "ok");
      break;
    case "ticket_status_refused":
      tool("ticket_status", `${detail} — not theirs, refused`, "err");
      break;
    case "ticket_not_found":
      tool("ticket_status", `${detail} — not found`, "warn");
      break;
    case "verification_required":
      tool("identity_gate", `${PENDING[detail] ?? "something personal"} — prove it first`, "warn");
      break;
    case "unknown_email":
      tool("lookup_email", "not in the directory", "err");
      break;
    case "code_sent":
      tool(
        "send_code",
        `to the employee's ${CHANNEL_NAMES[otpChannel] ?? detail}${view.snap?.simulation ? " — simulated, shown on screen" : ""}`,
        "accent",
      );
      break;
    case "code_refused":
      tool("check_code", `${detail} — wrong code, refused`, "err");
      break;
    case "code_expired":
      tool("check_code", "expired — refused", "err");
      break;
    case "verified":
      tool("check_code", "matched — verified", "ok");
      break;
    case "confidential_hr":
      tool("sensitive_guard", "details not collected", "warn");
      break;
    case "after_hours":
      tool("hours_check", "Confidential HR is closed — offer a callback", "warn");
      break;
    case "callback_requested":
      view.callbackCase = detail;
      tool("request_callback", `${detail} — no details in the request`, "ok");
      break;
    case "callback_declined":
      transcript.system("No callback — the caller has the ethics hotline number.");
      break;
    case "human_requested":
      tool("request_person", `straight to ${queueOf(detail)}`, "accent");
      break;
    case "link_sent":
      tool("send_link", `${detail} — to the employee's Teams chat`, "ok");
      break;
    case "personal_answer":
      tool("hr_record", `${detail.replace(/_/g, " ")} — the caller's own record`, "ok");
      break;
    case "personal_unavailable":
      tool("hr_record", `${detail.replace(/_/g, " ")} — no record`, "warn");
      break;
    case "personal_refused":
      tool("hr_record", "refused — not theirs to hear", "err");
      break;
    case "password_reset_handoff":
      tool("password_reset_agent", `${detail.replace(/_/g, " ")} — agent to agent`, "accent");
      break;
    case "out_of_scope":
      tool("not_covered", detail, "warn");
      break;
    case "transfer":
      transcript.system(`↪ Handing over to ${queueOf(detail)} in Teams`);
      break;
    case "transfer_failed":
      view.transferFailed = detail || "transfer failed";
      transcript.system("✕ The transfer didn't connect — the caller is still on the line");
      renderHandoff();
      break;
    case "no_input":
      transcript.system("— the caller says nothing —");
      break;
    case "wrap_up":
      transcript.system("Nearly out of time — the agent offers a ticket or a person");
      break;
    case "budget_expired":
      transcript.system("Out of time — the call ends");
      break;
  }
  render();
}

/** Simulated calls send nothing; what would have reached the employee shows up here instead. */
function addInbox(m = {}) {
  const li = document.createElement("li");
  li.className = "chat-msg";
  li.dataset.kind = m.kind ?? "message";
  const code = m.kind === "otp" && m.code ? String(m.code).replace(/^(\d{3})(\d{3})$/, "$1 $2") : "";
  const sentTo = m.to ? `to ${m.to}` : "";
  const foot = m.kind === "otp" && m.expiresAt ? `${sentTo} · expires ${clockTime(m.expiresAt)}` : sentTo;
  li.innerHTML = `
    <div class="chat-head"><span><strong>${escapeHtml(org)} help desk</strong> → ${escapeHtml(
      m.toName ?? "the employee",
    )}</span><span>${escapeHtml(clockTime(m.at))}</span></div>
    <p class="chat-subject">${escapeHtml(m.subject ?? "")}</p>
    ${code ? `<p class="otp-code" aria-label="One-time code">${escapeHtml(code)}</p>` : ""}
    <p class="chat-body">${escapeHtml(m.body ?? "")}</p>
    <div class="chat-foot"><span>${escapeHtml(foot)}</span>${chip("simulated — not sent", "accent")}</div>`;
  els.inbox.append(li);
  els.inboxEmpty.hidden = true;
  els.inbox.scrollTop = els.inbox.scrollHeight;
  stack?.flow(["tools", "teams-agent"]);
}

// ----------------------------------------------------------------- render

function render() {
  const snap = view.snap;
  setStateChip(els.stateChip, snap?.state, stateTone(snap));
  renderControls();
  renderDecision(els.decision, { ...decision(snap), empty: "Answer a call to see how the server triages it." });
  renderConfidence(snap);
  renderIdentity(snap);
  renderTicket(snap);
  renderPrivacy(snap);
  renderCallFacts(snap);
  renderRoutes();
  if (!view.handoff) renderToastPlaceholder(snap);
  tickBudget();
}

function stateTone(snap) {
  const state = snap?.state;
  if (!state) return "idle";
  if (state === "filed") return "ok";
  if (state === "sensitive" || state === "after_hours_offer") return "warn";
  if (state === "ended") return snap.outcome === "callback_requested" ? "ok" : "muted";
  return toneOf(state);
}

/** The manual controls work only while the call on screen is ours and still open. */
function renderControls() {
  const snap = view.snap;
  const active = Boolean(session.id && !session.finished && !session.followed && snap && !terminal(snap));
  const open = active && snap.state !== "transferring";
  els.sayInput.disabled = !open;
  els.sayBtn.disabled = !open;
  els.silence.disabled = !open;
  els.hangup.disabled = !active;
  for (const key of els.keys.querySelectorAll("button[data-digit]")) key.disabled = !open;
  els.sayInput.placeholder = open ? (PROMPTS[snap.state] ?? "What does the caller say?") : "Answer a call first";
}

// --------------------------------------------------------------- decision

/** The headline: what the server just decided, why, and the rule behind it. */
function decision(snap) {
  if (!snap) return {};
  switch (snap.state) {
    case "transferring":
    case "transferred":
      return handoffDecision(snap);
    case "ended":
      return endedDecision(snap);
    case "after_hours_offer":
      return {
        headline: "Confidential HR is closed — offering a callback",
        why: "Still nothing collected. Confidential HR can call back next business day, and the request says only “Confidential HR”.",
        verdict: "after hours → callback offer",
        tone: "warn",
      };
    case "sensitive":
      return {
        headline: "Sensitive HR — collecting nothing",
        why: "The privacy guard matched before any classification ran. No questions, no ticket, no summary.",
        verdict: "sensitive → private",
        tone: "warn",
      };
    case "verifying":
      return verifyingDecision(snap);
    case "confirming":
      return confirmingDecision(snap) ?? listeningDecision(snap);
    case "clarifying":
      return clarifyingDecision(snap);
    case "filed":
      return filedDecision(snap);
    default:
      return listeningDecision(snap);
  }
}

function handoffDecision(snap) {
  const h = view.handoff ?? snap.handoff ?? {};
  const done = snap.state === "transferred";
  const dest = h.destinationId;
  const queue = h.queue ?? queueOf(dest);
  const headline = `${done ? "Handed to" : "Connecting to"} ${queue}`;
  const context = h.callContext && typeof h.callContext === "object" ? h.callContext : {};
  if (h.confidential || dest === "confidential-hr") {
    return {
      headline: "Routed privately to Confidential HR",
      why: "The privacy guard ran first, so the agent asked nothing and filed nothing. The person who picks up sees “Confidential HR” — no topic, no summary, no notes.",
      verdict: "sensitive → private handoff",
      tone: "ok",
    };
  }
  // An HR answer that still names no topic goes to HR shared services as a plain route; it is still the unclear path.
  const reason = view.last?.kind === "still_unclear" ? "still_unclear" : h.reason;
  switch (reason) {
    case "urgent_ticket": {
      const number = context.ticketNumber ?? snap.lastTicket?.number ?? "The ticket";
      return {
        headline: "P1 — straight to IT on-call",
        why: `Security incidents are always P1 by rule, whatever the caller says. ${number} is already in ${first()}'s Teams chat, and on-call sees the number before they answer.`,
        verdict: "P1 → on-call",
        tone: "warn",
      };
    }
    case "asked_for_person":
      return {
        headline,
        why: `${First()} asked for a person, so the agent stops asking questions. ${queue} sees the topic${
          context.tried ? ` and that “${context.tried}” didn't help` : ""
        }, so ${first()} won't have to repeat it.`,
        verdict: "asked for a person",
        tone: "accent",
      };
    case "keypad_0":
      return {
        headline,
        why: "0 on the keypad always reaches a person, at any point in the call. The queue that owns the topic so far picks up.",
        verdict: "keypad 0 → a person",
        tone: "accent",
      };
    case "unverified":
      return {
        headline: "Couldn't verify → a person",
        why: "Two wrong codes void the code. Nothing personal was read out; a person can verify the caller another way.",
        verdict: "2 wrong codes → a person",
        tone: "err",
      };
    case "still_unclear":
      return {
        headline,
        why: "One clarifying question didn't settle IT or HR, and the agent never asks twice. A person sorts it out.",
        verdict: "still unclear → a person",
        tone: "warn",
      };
    case "password_reset":
      return {
        headline,
        why: "Unlocks and MFA go to the password reset assistant — another agent — with the intent and a session ID. It verifies the caller itself.",
        verdict: "agent-to-agent handoff",
        tone: "accent",
      };
  }
  if (view.clarified) {
    return {
      headline: `${done ? "Routed" : "Routing"} to ${label(dest)} after one question`,
      why: `${capitalize(view.clarified)} belongs to ${queue}. One question settled IT or HR — the agent didn't guess.`,
      verdict: "asked once, then routed",
      tone: "ok",
    };
  }
  return {
    headline,
    why: `${capitalize(snap.topicLabel) || "This topic"} belongs to ${queue}, so the server routes it there with only the context that queue may see.`,
    verdict: "topic → queue",
    tone: "ok",
  };
}

function endedDecision(snap) {
  switch (snap.outcome) {
    case "callback_requested":
      return {
        headline: "Callback requested — no details",
        why: `Confidential HR calls back next business day. ${view.callbackCase ?? "The request"} says “Confidential HR” and nothing else.`,
        verdict: "after hours → callback",
        tone: "ok",
      };
    case "confidential_after_hours_declined":
      return {
        headline: "No callback — nothing recorded",
        why: "The caller declined the callback and heard the ethics hotline instead. Nothing about the matter was stored.",
        verdict: "the caller's choice",
        tone: "muted",
      };
    case "no_input":
      return {
        headline: "No answer — call ended",
        why: "Two silences in a row. The agent says goodbye rather than hold an open line.",
        verdict: "2 silences → end",
        tone: "muted",
      };
    case "time_budget_expired":
      return {
        headline: "Out of time",
        why: "Every call has a time limit in config. Near the end the agent offered a ticket or a person.",
        verdict: "time limit → end",
        tone: "warn",
      };
    default:
      return {
        headline: "Call ended",
        why: "The call ended before any handoff.",
        verdict: "no handoff",
        tone: "muted",
      };
  }
}

function verifyingDecision(snap) {
  const v = snap.verification;
  const channel = CHANNEL_NAMES[v?.channel ?? otpChannel] ?? "Teams chat";
  switch (view.last?.kind) {
    case "code_sent": {
      const minutes = v ? Math.round((Date.parse(v.expiresAt) - Date.parse(v.sentAt)) / 60_000) : null;
      return {
        headline: "Code sent — waiting for it",
        why: `A six-digit code went to the ${channel} of ${v?.email ?? "the employee"}${
          snap.simulation ? " — simulated, so it's in the panel on the right and nothing was sent" : ""
        }. It works once${minutes ? ` and expires in ${minutes} minutes` : ""}.`,
        verdict: "one-time code",
        tone: "warn",
      };
    }
    case "code_refused":
      return {
        headline: "Wrong code — refused",
        why: "The digits didn't match, so nothing personal is read out. One more miss and a person verifies the caller another way.",
        verdict: "no match → refused",
        tone: "err",
      };
    case "code_expired":
      return {
        headline: "Code expired — refused",
        why: "A code works once, for a few minutes. The caller says their work email again to get a new one.",
        verdict: "expired → refused",
        tone: "err",
      };
    case "unknown_email":
      return {
        headline: "No such work email",
        why: "That address isn't in the directory, so no code goes anywhere. The caller can try again, or press 0 for a person.",
        verdict: "unknown → no code",
        tone: "err",
      };
    default:
      return {
        headline: "Prove it first",
        why: `${First()} asked for ${PENDING[snap.pendingAction] ?? "something personal"}. Caller ID can be faked, so a one-time code goes to the employee's own ${channel} — only the real employee can read it back.`,
        verdict: "identity gate → one-time code",
        tone: "warn",
      };
  }
}

function confirmingDecision(snap) {
  const p = snap.pendingProposal;
  if (!p) return null;
  if (view.last?.kind === "awaiting_yes") {
    return {
      headline: "Still waiting for a yes",
      why: `Nothing is filed until ${first()} says yes. Anything else gets the question again.`,
      verdict: "no yes → nothing filed",
      tone: "warn",
    };
  }
  const reach = p.impact === "site" ? " and it hits the whole site" : p.impact === "team" ? " and it hits the team" : "";
  const because = p.securityCategory
    ? `Security incidents are always ${p.priority} by rule, whatever the caller says.`
    : `${First()} ${p.blocked ? "can't work" : "can still work"}${reach}, so the server's priority matrix says ${p.priority}.`;
  const device = p.asset ? ` The ${p.asset} comes from the directory, not from the caller.` : "";
  return {
    headline: `Drafting a ${p.priority} ticket`,
    why: `${because}${device} Nothing is filed until ${first()} says yes.`,
    verdict: "server matrix → waiting for a yes",
    tone: "warn",
  };
}

function clarifyingDecision(snap) {
  const c = snap.classification;
  const options = (snap.pendingClarification?.candidates ?? c?.candidates ?? [])
    .slice(0, 2)
    .map((x) => `${x.label} (${DOMAINS[x.domain] ?? x.domain})`);
  const score = c ? `The best match is ${fmt(c.confidence)}, below the ${fmt(triage.confidenceMin)} gate` : "The match is below the gate";
  return {
    headline: "IT or HR? Asking once",
    why: `${options.length === 2 ? `Two close matches: ${options.join(" or ")}. ` : ""}${score}, so the agent asks one question instead of guessing.`,
    verdict: "below the gate → ask, don't guess",
    tone: "warn",
  };
}

function filedDecision(snap) {
  const t = snap.lastTicket;
  return {
    headline: `Filed ${t?.number ?? "the ticket"} after a yes`,
    why: `${t?.priority ?? "The priority"} came from the server's matrix, not the model. ${First()} has the ticket in Teams chat${
      snap.simulation ? " — the mock chat on the right" : ""
    }.`,
    verdict: "yes → filed",
    tone: "ok",
  };
}

function listeningDecision(snap) {
  const { kind = "", detail = "" } = view.last ?? {};
  const t = snap.lastTicket;
  const words = (text) => String(text ?? "").replace(/_/g, " ");
  switch (kind) {
    case "answered": {
      const c = snap.classification;
      const match = view.clarified
        ? " One question settled the topic."
        : c && !c.needsClarification
          ? ` The match was ${fmt(c.confidence)}, over the ${fmt(triage.confidenceMin)} gate.`
          : "";
      return {
        headline: "Answered from approved content",
        why: `${snap.lastArticle?.title ? `“${snap.lastArticle.title}”. ` : ""}The words come from the article, not the model.${match}`,
        verdict: "approved article",
        tone: "ok",
      };
    }
    case "ticket_status": {
      if (detail === "none open") {
        return { headline: "No open tickets", why: `${First()} has nothing open right now.`, verdict: "own tickets only", tone: "ok" };
      }
      const major = t?.number === detail && /^major incident/i.test(t.summary ?? "");
      const why = major
        ? "A major incident is open to everyone, so anyone who calls may hear its status."
        : snap.verifiedBy === "code"
          ? `${First()} proved who they are with a one-time code, and it's their own ticket.`
          : `It's ${first()}'s own ticket, and the Teams sign-in already proved who's calling.`;
      return { headline: `Read out ${detail}`, why, verdict: major ? "major incident → anyone" : "own ticket → read out", tone: "ok" };
    }
    case "ticket_status_refused":
      return {
        headline: `Not ${first()}'s ticket`,
        why: `${detail} belongs to someone else, so not even its status is read out. ${First()} can hear their own tickets instead.`,
        verdict: "not theirs → refused",
        tone: "err",
      };
    case "ticket_not_found":
      return {
        headline: "No such ticket",
        why: `${detail} isn't in the ticket system. The agent asks the caller to check the number in their Teams chat.`,
        verdict: "not found",
        tone: "warn",
      };
    case "outage_attached": {
      const already = Boolean(t?.alreadyAffected);
      return {
        headline: already ? `Already on ${detail}` : `Added to ${detail} — no duplicate`,
        why: `It matches the known outage, so ${first()} ${already ? "stays on" : "goes onto"} the open major incident instead of getting a new ticket — and hears when it's fixed.`,
        verdict: "known outage → attach, don't file",
        tone: "ok",
      };
    }
    case "verified":
      return {
        headline: "Verified by one-time code",
        why: `${First()} read back the code sent to their own ${CHANNEL_NAMES[snap.verification?.channel] ?? "Teams chat"}. Personal details may now be read out — theirs only.`,
        verdict: "code matched → verified",
        tone: "ok",
      };
    case "personal_answer":
      return {
        headline: "Read from the HR record",
        why: `${First()}'s own ${words(detail)}: they're verified, and it's their record.`,
        verdict: "own record → read out",
        tone: "ok",
      };
    case "personal_unavailable":
      return {
        headline: "Nothing on record",
        why: `There's no ${words(detail)} on ${first()}'s record, so the agent says so instead of guessing.`,
        verdict: "no record → no guess",
        tone: "warn",
      };
    case "personal_refused":
      return {
        headline: "Not theirs to hear",
        why: "Personal HR details are only for the verified caller, and salaries are never read out.",
        verdict: "refused",
        tone: "err",
      };
    case "out_of_scope":
      return {
        headline: "Not something this line handles",
        why: `${capitalize(detail) || "That"} isn't on the help line, so the agent says where to go instead of improvising.`,
        verdict: "out of scope → redirect",
        tone: "warn",
      };
    case "link_sent":
      return {
        headline: "Link sent to Teams chat",
        why: `${detail} went to ${first()}'s Teams chat${snap.simulation ? " — simulated, it's in the panel on the right" : ""}.`,
        verdict: "link → Teams chat",
        tone: "ok",
      };
    case "ticket_declined":
      return { headline: "Not filed — the caller said no", why: "Nothing is filed without a yes.", verdict: "no → nothing filed", tone: "muted" };
    case "answer_unavailable":
      return {
        headline: "No approved answer",
        why: "The approved article isn't available for this caller, so the agent doesn't improvise one.",
        verdict: "no article → no guess",
        tone: "warn",
      };
    case "transfer_failed":
      return {
        headline: "Couldn't connect",
        why: "The transfer didn't complete, so the caller is still with the agent, who offers to try again or file a ticket.",
        verdict: "transfer failed → stay on the line",
        tone: "err",
      };
    case "no_input":
      return {
        headline: "Didn't catch that",
        why: "One silence gets a reprompt. Two in a row end the call politely.",
        verdict: "silence → reprompt",
        tone: "warn",
      };
    case "wrap_up":
      return {
        headline: "Almost out of time",
        why: "Near the time limit the agent offers to file a ticket or connect a person.",
        verdict: "wrap-up",
        tone: "warn",
      };
    case "clarified":
      return { headline: `Settled: ${view.clarified}`, why: "One question was enough.", verdict: "asked once", tone: "ok" };
  }
  if (snap.verified) {
    return {
      headline: "Listening…",
      why:
        snap.verifiedBy === "teams"
          ? `The Teams sign-in already proved this is ${snap.caller?.displayName ?? "an employee"}. The model proposes; the server decides what may be read out, the priority and the route.`
          : `${snap.caller?.displayName ?? "The caller"} is verified by one-time code. Personal details are theirs only.`,
      verdict: snap.verifiedBy === "teams" ? "verified by Teams" : "verified by code",
      tone: "accent",
    };
  }
  return {
    headline: "Listening…",
    why:
      snap.channel === "teams"
        ? "This Teams account isn't in the directory. General answers are fine; anything personal waits for a one-time code."
        : "A phone call: caller ID is a hint, not proof. General answers are fine; anything personal waits for a one-time code.",
    verdict: "not verified yet",
    tone: "warn",
  };
}

// -------------------------------------------------------- gauge, identity

function renderConfidence(snap) {
  const c = snap?.classification;
  els.gauge.hidden = !c || Boolean(snap.sensitive);
  if (els.gauge.hidden) return;
  const name =
    snap.state === "clarifying" ? "two close matches" : view.clarified ? "settled by one question" : (c.label ?? "best match");
  renderGauge(els.gauge, {
    value: c.confidence,
    gate: triage.confidenceMin,
    label: `${name} · gate`,
    passes: () => !c.needsClarification,
  });
}

/** Who may hear personal details: Teams sign-in, or a one-time code. */
function renderIdentity(snap) {
  if (!snap) {
    renderChecks(els.checks, [
      { label: "Who's calling?", detail: "Teams calls arrive signed in; phone callers prove it with a one-time code", tone: "idle" },
    ]);
    return;
  }
  if (snap.verifiedBy === "teams") {
    renderChecks(els.checks, [
      {
        label: "Signed in to Teams",
        detail: `${snap.caller?.displayName ?? "Employee"} · identity from the Teams sign-in, no security questions`,
        tone: "ok",
      },
      { label: "Personal details", detail: "their own tickets and HR records only", tone: "ok" },
    ]);
    return;
  }
  const opener =
    snap.channel === "teams"
      ? { label: "Teams account not in the directory", detail: "anything personal needs a one-time code", tone: "warn" }
      : {
          label: "Caller ID — a hint, not proof",
          detail: snap.callerIdMatch
            ? `${snap.maskedPhone} matches an employee's mobile, but caller ID is easy to fake`
            : `${snap.maskedPhone ?? "The number"} isn't in the directory`,
          tone: "warn",
        };
  renderChecks(els.checks, [opener, ...codeChecks(snap)]);
}

function codeChecks(snap) {
  const v = snap.verification;
  const waiting = snap.state === "verifying";
  const failures = v?.failures ?? 0;
  const email = v?.email
    ? { label: "Work email", detail: v.email, tone: "ok" }
    : view.last?.kind === "unknown_email"
      ? { label: "Work email", detail: "not in the directory — no code sent", tone: "err" }
      : waiting
        ? { label: "Work email", detail: "waiting for the caller to say it", tone: "accent" }
        : { label: "Work email", detail: "asked only when something personal comes up", tone: "idle" };
  const sent = v?.sentAt
    ? {
        label: `One-time code sent${snap.simulation ? " (simulated)" : ""}`,
        detail: `to the employee's ${CHANNEL_NAMES[v.channel] ?? v.channel}${snap.simulation ? " · shown in the panel on the right, never sent" : ""}`,
        tone: "ok",
      }
    : { label: "One-time code", detail: "goes to the employee on record, not to whoever is calling", tone: "idle" };
  const readBack =
    v?.lastResult === "verified"
      ? { label: "Code read back", detail: "matched — then discarded", tone: "ok" }
      : v?.lastResult === "expired"
        ? { label: "Code read back", detail: "too late — an expired code is refused", tone: "err" }
        : failures >= 2
          ? { label: "Code read back", detail: "two wrong codes — handed to a person", tone: "err" }
          : failures === 1
            ? { label: "Code read back", detail: `attempt ${v.attempts} didn't match — one more miss goes to a person`, tone: "err" }
            : v?.sentAt && waiting
              ? { label: "Code read back", detail: "waiting for the six digits", tone: "accent" }
              : { label: "Code read back", tone: "idle" };
  const verified = snap.verified
    ? { label: "Verified", detail: `${snap.caller?.displayName ?? "The employee"} — by one-time code`, tone: "ok" }
    : failures >= 2
      ? { label: "Not verified", detail: "nothing personal was read out", tone: "err" }
      : { label: "Verified", detail: "not yet — nothing personal is read out", tone: "idle" };
  return [email, sent, readBack, verified];
}

// ------------------------------------------------- ticket, privacy, facts

function priorityTone(p) {
  return p === "P1" ? "err" : p === "P2" ? "warn" : "accent";
}

/** The ticket on this call: a draft waiting for a yes, a new one, the outage it joined, or one read out. */
function renderTicket(snap) {
  const p = snap?.state === "confirming" ? snap.pendingProposal : null;
  const t = p ? null : snap?.lastTicket;
  const waiting = view.last?.kind === "awaiting_yes";
  const sig = p ? `draft:${p.proposalId}:${waiting}` : t ? `ticket:${t.number}:${t.status}:${view.ticketWhy}` : "";
  if (sig === view.ticketSig) return;
  view.ticketSig = sig;
  els.ticketCard.hidden = !sig;
  if (!sig) {
    els.ticketCard.innerHTML = "";
    return;
  }
  if (p) {
    const why = p.securityCategory ? "security — always P1" : p.blocked ? "can't work" : "can still work";
    const scope = p.impact === "site" ? " · whole site" : p.impact === "team" ? " · the team" : "";
    els.ticketCard.dataset.tone = "warn";
    els.ticketCard.innerHTML = `
      <p class="ticket-kicker">${waiting ? "Still a draft — only a yes files it" : "Draft — nothing is filed until the caller says yes"}</p>
      <div class="ticket-head"><span class="ticket-no">Draft</span>${chip(p.priority, priorityTone(p.priority))}${chip("waiting for a yes", "warn")}</div>
      <p class="ticket-summary">${escapeHtml(p.summary)}</p>
      <dl></dl>`;
    renderFacts(els.ticketCard.querySelector("dl"), [
      ["Category", p.category],
      ["Priority", `${p.priority} — ${why}${scope}`],
      p.asset && ["Device", `${p.asset} (from the directory)`],
    ]);
    return;
  }
  const why = view.ticketWhy ?? (t.parentIncident ? "attached" : "status");
  const major = /^major incident/i.test(t.summary ?? "");
  const [kicker, tone] = {
    filed: ["Filed after a yes — the number is in the Teams chat", "ok"],
    attached: [
      t.alreadyAffected ? "Already on the open incident — nothing new filed" : "Added to the open incident — no duplicate ticket",
      "ok",
    ],
    status: [major ? "Read out — a major incident anyone may hear" : `Read out — ${first()}'s own ticket`, "accent"],
  }[why] ?? ["Ticket", "accent"];
  els.ticketCard.dataset.tone = tone;
  els.ticketCard.innerHTML = `
    <p class="ticket-kicker">${escapeHtml(kicker)}</p>
    <div class="ticket-head"><span class="ticket-no">${escapeHtml(t.number)}</span>${t.priority ? chip(t.priority, priorityTone(t.priority)) : ""}${
      t.status ? chip(t.status, /^(resolved|closed)$/i.test(t.status) ? "ok" : "accent") : ""
    }${t.simulated && why === "filed" ? chip("simulated", "muted") : ""}</div>
    <p class="ticket-summary">${escapeHtml(t.summary ?? "")}</p>
    <dl></dl>`;
  renderFacts(els.ticketCard.querySelector("dl"), [
    t.category && ["Category", t.category],
    t.lastUpdate && ["Latest update", t.lastUpdate],
    t.asset && ["Device", `${t.asset} (from the directory)`],
  ]);
}

/** Sensitive HR: what the agent did not do, item by item. */
function renderPrivacy(snap) {
  els.privacy.hidden = !snap?.sensitive;
  if (els.privacy.hidden) return;
  const done = handedOver(snap) || snap.state === "ended";
  let last;
  if (snap.outcome === "callback_requested") {
    last = { label: "The callback request carries no details", detail: `${view.callbackCase ?? "The HR case"} says “Confidential HR” — nothing else`, tone: "ok" };
  } else if (snap.outcome === "confidential_after_hours_declined") {
    last = { label: "No callback — nothing recorded", detail: "the caller heard the ethics hotline instead", tone: "ok" };
  } else if (snap.state === "after_hours_offer") {
    last = { label: "Confidential HR is closed", detail: "a yes files a callback request that says “Confidential HR” — nothing else", tone: "warn" };
  } else {
    last = {
      label: "The handoff says “Confidential HR” — nothing else",
      detail: "no topic, no summary, no notes in the Teams toast or the headers",
      tone: done ? "ok" : "accent",
    };
  }
  renderChecks(els.privacyChecks, [
    { label: "The guard ran first", detail: "before any keyword, classifier or model", tone: "ok" },
    { label: "Nothing collected", detail: "no questions, no ticket, no summary", tone: "ok" },
    { label: "The words are not kept", detail: "the transcript and the audit hold a placeholder instead", tone: "ok" },
    last,
  ]);
}

function renderCallFacts(snap) {
  if (!snap) {
    renderFacts(els.facts, [
      ["Caller", ""],
      ["Topic", ""],
      ["Next", "answer a call"],
      ["Destination", ""],
    ]);
    return;
  }
  const h = view.handoff ?? snap.handoff;
  const how = snap.verifiedBy === "teams" ? "Teams sign-in" : snap.verifiedBy === "code" ? "one-time code" : "not verified";
  const caller = snap.caller?.displayName ? `${snap.caller.displayName} · ${how}` : `${snap.maskedPhone ?? "Unknown caller"} · not verified`;
  const topic = snap.sensitive
    ? "private — not collected"
    : snap.topicLabel
      ? `${DOMAINS[snap.domain] ?? snap.domain ?? ""} · ${snap.topicLabel}`
      : "";
  const destination = h ? (h.queue ?? queueOf(h.destinationId)) : callbackPath(snap) ? "Confidential HR, by callback" : "";
  renderFacts(els.facts, [
    ["Caller", caller],
    ["Topic", topic],
    ["Next", nextStep(snap)],
    ["Destination", destination],
  ]);
}

/** What happens next, in plain words. */
function nextStep(snap) {
  const h = view.handoff ?? snap.handoff;
  const queue = h?.queue ?? queueOf(h?.destinationId);
  switch (snap.state) {
    case "verifying":
      return snap.verification?.sentAt && snap.verification.lastResult !== "expired"
        ? "the caller reads back the six digits"
        : "the caller says their work email";
    case "confirming":
      return "the caller says yes or no — only a yes files it";
    case "clarifying":
      return "one answer, then the right queue";
    case "after_hours_offer":
      return "yes files a callback request with no details; no ends the call";
    case "sensitive":
      return "a private handoff";
    case "transferring":
      return `Teams rings ${queue}`;
    case "transferred":
      return h?.confidential ? `${queue} picks up, knowing only that it's private` : `${queue} picks up with the context`;
    case "ended":
      return "nothing — the call is over";
    case "filed":
      return "anything else, or goodbye";
    default:
      return "the caller says what they need";
  }
}

function renderRoutes() {
  const snap = view.snap;
  const activeId = (view.handoff ?? snap?.handoff)?.destinationId ?? (callbackPath(snap) ? "confidential-hr" : null);
  renderList(
    els.routes,
    routesInfo.map((r) => ({
      label: r.label,
      meta: [r.dtmf != null ? `key ${r.dtmf}` : "", r.hours, r.id === fallbackId ? "fallback" : "", r.confidential ? "private" : ""]
        .filter(Boolean)
        .join(" · "),
      status: r.open ? "open" : "closed",
      tone: r.open ? "ok" : "muted",
      active: r.id === activeId,
    })),
    { empty: "Loading the routes…" },
  );
}

function renderCallers() {
  els.callerSelect.innerHTML = CALLERS.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label)}</option>`).join("");
}

/** The call's time limit, frozen once the call is handed over or over. */
function tickBudget() {
  const snap = view.snap;
  if (!snap) {
    els.budget.hidden = true;
    return;
  }
  const stop = budgetStop(snap);
  if (stop) view.frozenMs ??= snap.elapsedMs ?? 0;
  else view.frozenMs = null;
  const elapsedMs = view.frozenMs ?? (snap.elapsedMs ?? 0) + (performance.now() - view.syncedAt);
  renderBudget(els.budget, { elapsedMs, budgetMs: snap.budgetMs ?? triage.timeBudgetMs });
  const parts = els.budget.pkBudget;
  if (stop && parts && !els.budget.hidden) {
    parts.label.textContent += ` · ${stop}`;
    parts.fill.dataset.tone = stop === "ended" ? "muted" : "ok";
  }
}

function budgetStop(snap) {
  if (handedOver(snap)) return "handed over";
  if (snap.outcome === "callback_requested") return "callback requested";
  return terminal(snap) ? "ended" : null;
}

// ------------------------------------------------------------ Teams side

/** The mock toast and the VoIP headers: exactly what the handoff carried, nothing more. */
function renderHandoff() {
  const h = view.handoff;
  if (!h) return;
  const snap = view.snap;
  const status = view.transferFailed ? "Didn't connect" : "Incoming call";
  const queue = h.queue ?? queueOf(h.destinationId);
  if (h.confidential || h.destinationId === "confidential-hr") {
    renderTeamsToast(els.toast, {
      queue,
      subtitle: "Private line · routed by the help desk assistant",
      topic: h.callTopic ?? "Confidential HR",
      callerHtml: `<strong>Private HR call</strong><div class="muted">Only “Confidential HR” travels with the call — no topic, no summary</div>`,
      avatar: label(h.destinationId),
      tags: [{ text: "private", tone: "warn" }],
      status,
    });
  } else {
    const context = h.callContext && typeof h.callContext === "object" ? h.callContext : {};
    const name = context.verifiedName ?? (snap?.verified ? snap.caller?.displayName : null);
    const how = snap?.verifiedBy === "code" ? "one-time code" : "Teams sign-in";
    const callerHtml = name
      ? `<strong>${escapeHtml(name)}</strong><span class="verified">Verified by ${how}</span>`
      : `<strong>Caller not verified</strong><div class="muted">${escapeHtml(snap?.maskedPhone ?? "Unknown number")}</div><span class="unverified">Not verified — nothing personal was shared</span>`;
    const tags = [
      h.reason === "urgent_ticket" ? { text: "urgent", tone: "err" } : null,
      h.reason === "password_reset" ? { text: "AI agent handoff", tone: "accent" } : null,
      view.clarified && h.reason === "topic" ? { text: "after one question", tone: "accent" } : null,
    ].filter(Boolean);
    renderTeamsToast(els.toast, {
      queue,
      subtitle:
        h.destinationId === "password-reset-agent"
          ? "Another agent · same call, nothing to repeat"
          : "Call queue · routed by the help desk assistant",
      topic: h.callTopic,
      context: contextLine(h),
      callerHtml,
      avatar: label(h.destinationId),
      tags,
      status,
    });
  }
  els.toastEmpty.hidden = true;
  // Built on the server by the same function the real transfer uses.
  renderHeaders(els.headers, (h.voipHeaders ?? []).map((x) => [x.key, x.value]));
}

/** The call context in words, minus anything the topic line already says. */
function contextLine(h) {
  const c = h.callContext;
  if (!c) return "";
  if (typeof c === "string") return sameWords(c, h.callTopic) ? "" : c;
  const topic = String(h.callTopic ?? "").toLowerCase();
  return CONTEXT_LABELS.map(([key, name]) => [name, String(c[key] ?? "").replace(/_/g, " ")])
    .filter(([, value]) => value && !topic.includes(value.toLowerCase()))
    .map(([name, value]) => `${name}: ${value}`)
    .join(" · ");
}

/** A one-line context can be the topic again. Say it once. */
function sameWords(summary, topic) {
  const plain = (s) =>
    String(s ?? "")
      .replace(/^caller said:\s*/i, "")
      .replace(/[“”"…,.!?\s]+/g, " ")
      .trim()
      .toLowerCase();
  return Boolean(summary) && plain(summary) === plain(topic);
}

/** Before any handoff, say why nothing has rung in Teams. */
function renderToastPlaceholder(snap) {
  els.toastEmpty.textContent = !snap
    ? "No call has been handed over yet."
    : callbackPath(snap)
      ? "No transfer — Confidential HR is closed. A callback request is the handoff, and it says only “Confidential HR”."
      : view.transferFailed
        ? "The transfer didn't connect — the caller is still with the agent."
        : snap.state === "ended"
          ? "The call ended before a handoff."
          : snap.lastArticle || snap.lastTicket
            ? "Nothing handed over — the agent is handling it."
            : "No call has been handed over yet.";
}

// ---------------------------------------------------------------- metrics

let shownStory = "";
let statsTimer = null;

/** Returns true when a number on screen changed. */
function renderStats(stats) {
  const s = stats?.story;
  if (!s) return false;
  const key = JSON.stringify(s);
  const changed = key !== shownStory;
  shownStory = key;
  renderMetrics(els.metrics, [
    ["Calls", s.calls],
    ["Answered", s.answered],
    ["Tickets filed", s.ticketsFiled],
    ["Duplicates avoided", s.duplicatesAvoided],
    ["Verified by code", s.verifiedByCode],
    ["Wrong codes refused", s.codesRefused],
    ["Sensitive, routed privately", s.sensitiveRouted],
    ["Handed off", s.handedOff],
  ]);
  return changed;
}

/** With `highlight`, the footer flashes only if a number moved. */
async function refreshStats({ highlight = false } = {}) {
  try {
    if (renderStats(await getJson("/api/stats")) && highlight) flash(els.metrics);
  } catch {
    // Keep the last numbers on screen.
  }
}

/** One stats read for a burst of events. */
function queueStats() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => refreshStats({ highlight: true }), 150);
}

/** The closing beat: wait for the transfer to land, then show the numbers. */
async function showMetrics() {
  for (let i = 0; i < 30 && !session.finished; i += 1) await sleep(100);
  await refreshStats();
  flash(els.metrics);
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
  for (const key of Object.keys(triage)) {
    const value = health.triage?.[key];
    if (typeof value === "number") triage[key] = value;
  }
  otpChannel = health.triage?.otpChannel ?? otpChannel;
  els.inboxTitle.textContent = INBOX_TITLES[otpChannel] ?? INBOX_TITLES.teams;
  const min = health.triage?.statsMinCount;
  if (min) els.metrics.title = `Private HR calls show as “<${min}” until there are ${min} or more, so nobody can be singled out.`;
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
  fallbackId = data.fallbackDestination ?? fallbackId;
  routesInfo = data.routes ?? [];
  routeById = new Map(routesInfo.map((r) => [r.id, r]));
  els.org.textContent = org;
  document.title = `${org} — Help desk`;
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
  otp.hide();
  els.inbox.innerHTML = "";
  els.inboxEmpty.hidden = false;
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
    await Promise.all([clock.refresh(), refreshRoutes()]);
    director.load(0);
    notify("Demo reset — no simulated calls, tickets or codes, the starting clock, beat 1.", "ok");
  } catch (error) {
    if (error.status === 403) notify("Reset is off while this server answers real calls.", "warn");
    else notify(error.message, "err");
  }
});
