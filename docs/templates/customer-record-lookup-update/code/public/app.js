/**
 * The record desk console.
 *
 * A viewer of the server's record policy, never a second copy of it. Every
 * decision on screen — who is verified, what the record card may show, the
 * read-back, the undo window and its timing, the allow-list refusal, the
 * handoff — is one the server made and published over the hub; this file only
 * explains it. The plumbing every template shares (hub, call session, demo
 * director, countdown, checklist, Teams toast, trail) comes from the presenter
 * kit, and the on-stage script lives in beats.js.
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
  renderChecks,
  renderFacts,
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
import { createBeats, DEMO_PIN, WRONG_PIN } from "/beats.js";

// Mirrors config/reps.json, so the presenter can choose who is calling and how.
const CALLERS = [
  { id: "alex-teams", name: "Alex (Teams)", title: "Alex Morgan, signed in to Teams", body: { repId: "rep-alex" } },
  { id: "alex-mobile", name: "Alex (mobile)", title: "Alex Morgan's registered mobile: a PIN is required", body: { fromPhone: "+14255550197" } },
  { id: "jordan-teams", name: "Jordan (Teams)", title: "Jordan Lee, signed in to Teams", body: { repId: "rep-jordan" } },
  { id: "unknown", name: "Unknown number", title: "A number that is not on the rep list", body: { fromPhone: "+14255550188" } },
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
  win: $("window"),
  checks: $("checks"),
  facts: $("facts"),
  toast: $("toast"),
  toastEmpty: $("toastEmpty"),
  headers: $("headers"),
  writeback: $("writeback"),
  diffNote: $("diffNote"),
  diff: $("diff"),
  metrics: $("metrics"),
};
// The undo window: a confirmed write waits commitUndoMs on the server before it commits.
const win = createCountdown(els.win);

const TERMINAL = new Set(["refused", "transferred", "ended"]);

const REASONS = {
  refused_by_policy: "refused by policy",
  verification_failed: "not verified",
  dtmf_zero: "pressed 0",
  explicit_request: "asked for a person",
  two_failures: "two misses in a row",
};

const IDLE_CHECKS = [
  { label: "Caller", detail: "Teams sign-in, or a registered mobile", tone: "idle" },
  { label: "PIN", detail: "Required on a mobile", tone: "idle" },
  { label: "Record access", detail: "Locked until verified", tone: "idle" },
  { label: "Contact details", detail: "Withheld until asked for", tone: "idle" },
];

// Defaults until /health answers; the server's numbers win.
const policy = { commitUndoMs: 6000, callBudgetMs: 480_000 };

let health = null;
let org = "Contoso";
let stack = null;
let clockLocked = false;
let keysSig = "";
let sending = false;
let view = blankView();

/** What the console has learned about the call on screen, beyond its snapshot. */
function blankView() {
  return {
    snap: null,
    handoff: null,
    windowFor: null, // the proposal whose undo window the bar is showing
    transferFailed: false,
    frozenMs: null,
    syncedAt: 0,
  };
}

const terminal = (snap) => TERMINAL.has(snap?.state);
const agentLabel = () => `${org} assistant`;
const callerLabel = () => view.snap?.rep?.firstName ?? "Caller";
const checkOf = (snap, id) => snap?.identity?.find((c) => c.id === id) ?? null;
const pinPending = (snap) => snap?.state === "identifying" && checkOf(snap, "pin")?.tone === "warn";
const upper = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : "");
const seconds = (ms) => `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)}s`;
const wholeSeconds = (ms) => `${Math.round((Number(ms) || 0) / 1000)} seconds`;
const andList = (items) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const withoutArticle = (s) => String(s ?? "").replace(/^the /i, "");
const money = (n) => (Number.isFinite(Number(n)) ? `$${Math.round(Number(n) / 1000)}K` : "");

const stackNodes = () =>
  voiceStack({
    caller: "Sales rep",
    callerLive: "Teams or a mobile",
    voiceLive: health?.voiceLive?.model ?? "gpt-realtime",
    tools: "Record policy",
    toolsSim: "real policy code",
    agent: "Sales Operations",
    agentSim: "mock toast",
  });

// ------------------------------------------------------------------ wiring

const voice = createVoice($("voice"), { lang: "en-US" });
const clock = mountClock($("clock"), { onChange: () => render() });
const transcript = createTranscript($("transcript"), {
  voice,
  empty: "Answer a call, or press Next ▶ to run the demo script.",
});
const trail = createTrail($("events"), {
  good: ["verified", "briefing", "lookup", "contact_lookup", "commit"],
  bad: ["refused_caller", "verification_failed", "refused_write", "policy_refusal", "commit_failed", "undo_failed", "transfer_failed"],
  warn: ["pin_requested", "commit_pending", "commit_cancelled", "undo", "draft_saved", "no_input"],
  timeZone: () => clock.state?.timeZone,
  empty: "Every check, lookup, write and refusal shows up here.",
});
// The kit's default finished-matcher doesn't know "refused".
const session = createCallSession({
  voice,
  onMessage,
  onFollow: () => clearPanels(),
  isFinished: (state) => TERMINAL.has(String(state)),
});
connectHub((target, payload) => session.handle(target, payload), {
  onOpen: ({ reconnected }) => reconnected && refreshAll(),
});
const sim = createSimulator({
  session,
  startBody,
  onSnapshot: applySnapshot,
  actions: { window: watchWindow, metrics: showMetrics },
});
const director = createDirector($("director"), {
  beats: createBeats({ setClock, restoreRecords }),
  perform,
  voice,
  sayInput: els.sayInput,
  onBeat: () => {
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: "smooth" });
  },
});

async function boot() {
  renderCallers();
  renderHeaders(els.headers, []);
  render();
  await Promise.all([loadHealth(), refreshStats()]);
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
    await endActiveCall();
    clearPanels();
  }
  return sim.perform(step);
}

/**
 * Hanging up inside an undo window would cut it short, so a quick Next waits
 * for the window (and any transfer) to close first. The wait is bounded.
 */
async function endActiveCall() {
  const deadline = performance.now() + policy.commitUndoMs + 3000;
  const open = () => {
    const snap = view.snap;
    return Boolean(snap && !terminal(snap) && (snap.pendingCommit || snap.state === "transferring"));
  };
  while (open() && performance.now() < deadline) await sleep(100);
  if (session.id && !session.finished && !session.followed) await sim.hangup().catch(() => {});
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

/**
 * Each beat starts from the seeded Fabrikam record. The call on screen ends
 * first, so nothing it does lands after the restore; the metrics keep counting.
 */
async function restoreRecords() {
  await endActiveCall();
  try {
    await postJson("/api/demo/records");
  } catch (error) {
    if (error.status !== 403) throw error;
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
  syncWindow(snap, prev);
  if (snap.handoff && !view.handoff) {
    view.handoff = snap.handoff;
    renderHandoff();
  }
  if (terminal(snap) && !terminal(prev)) refreshStats({ highlight: true });
  render();
}

function onEvent(e) {
  trail.add(e);
  if (COUNTED.has(e.kind)) statsSoon();
  const detail = String(e.detail ?? "");
  switch (e.kind) {
    case "pin_requested":
      transcript.tool("verify_caller", `${detail} is a registered mobile — PIN required`, "warn");
      break;
    case "verified":
      transcript.tool("verify_caller", detail, "ok");
      break;
    case "verification_failed":
      transcript.tool("verify_caller", detail, "err");
      break;
    case "refused_caller":
      transcript.tool("verify_caller", "not on the rep list — no records opened", "err");
      break;
    case "briefing":
      transcript.tool("get_briefing", `${detail} — scoped to the rep`, "ok");
      stack?.flow(["voice-live", "tools"]);
      break;
    case "lookup":
      transcript.tool("lookup", detail, "ok");
      break;
    case "contact_lookup":
      transcript.tool("get_contact", `${detail} — read out on request`, "ok");
      break;
    case "proposal":
      transcript.tool("propose_update", `${detail} — read back, waiting for a yes`, "accent");
      break;
    case "proposal_amended":
      transcript.tool("propose_update", `amended: ${detail}`, "accent");
      break;
    case "policy_refusal":
      transcript.tool("propose_update", `${detail}: not on the phone allow-list — nothing written`, "err");
      stack?.flow(["voice-live", "tools"]);
      break;
    case "commit_pending":
      transcript.tool("commit_update", `confirmed · ${detail}`, "warn");
      break;
    case "commit":
      transcript.tool("commit_update", `written · ${detail}`, "ok");
      break;
    case "commit_failed":
      transcript.tool("commit_update", detail || "the write failed — nothing changed", "err");
      break;
    case "commit_cancelled":
      transcript.system(`↺ Stopped inside the undo window — ${detail}`);
      break;
    case "undo":
      transcript.tool("undo_update", detail, "warn");
      if (!els.win.hidden) win.finish("warn", "Undone — the record is back to how it was");
      break;
    case "draft_saved":
      transcript.tool("save_draft", `${detail} — kept as a draft, not written`, "accent");
      break;
    case "transfer":
      transcript.system(`↪ Putting the call through to ${detail.split(" → ")[1] ?? "Sales Operations"} in Teams`);
      break;
    case "transfer_failed":
      view.transferFailed = true;
      transcript.system(`Transfer not completed: ${detail}`);
      renderHandoff();
      break;
    case "no_input":
      transcript.system("— the caller says nothing —");
      break;
  }
  render();
}

// ----------------------------------------------------------------- render

function render() {
  const snap = view.snap;
  setStateChip(els.stateChip, snap?.state ?? null, stateTone(snap));
  renderKeys();
  renderControls();
  renderDecision(els.decision, {
    ...decision(snap),
    empty: "Answer a call to see what the server checks before anything is read out.",
  });
  renderChecks(els.checks, snap?.identity?.length ? snap.identity : IDLE_CHECKS);
  renderRecord();
  renderDiff();
  renderToastPlaceholder();
  tickBudget();
}

function stateTone(snap) {
  if (!snap) return "idle";
  if (snap.state === "refused") return "err";
  if (snap.state === "ended") return snap.outcome === "transfer_failed" ? "err" : "muted";
  if (snap.state === "transferred") return snap.rep ? "ok" : "warn";
  if (snap.state === "committing" || snap.state === "identifying") return "warn";
  if (snap.state === "committed") return "ok";
  return toneOf(snap.state);
}

function renderControls() {
  const active = Boolean(session.id && !session.finished && !session.followed && view.snap && !terminal(view.snap));
  for (const el of [els.sayInput, els.sayBtn, els.silence, els.hangup]) el.disabled = !active;
  for (const button of els.keys.querySelectorAll("button")) button.disabled = !active;
}

/** While the agent waits for a PIN the keypad offers one; otherwise 0 and *. */
function renderKeys() {
  const keys = pinPending(view.snap)
    ? [
        [DEMO_PIN, "PIN", "Alex's", "Key in Alex Morgan's demo PIN"],
        [WRONG_PIN, "PIN", "wrong", "Key in a wrong PIN"],
        ["*", "*", "clear", "Start the PIN again"],
      ]
    : [
        ["0", "0", "person", "Press 0 for a person in Sales Operations"],
        ["*", "*", "repeat", "Hear the last answer again"],
      ];
  const sig = keys.map(([digit]) => digit).join("|");
  if (sig === keysSig) return;
  keysSig = sig;
  els.keys.innerHTML = keys
    .map(
      ([digit, face, note, title]) =>
        `<button type="button" data-digit="${escapeHtml(digit)}" title="${escapeHtml(title)}">${escapeHtml(face)} <small>${escapeHtml(note)}</small></button>`,
    )
    .join("");
}

function renderCallers() {
  // Short names, so the picker never truncates. The full name shows on the
  // checklist and the Teams toast once the caller is verified.
  els.callerSelect.innerHTML = CALLERS.map(
    (c) => `<option value="${escapeHtml(c.id)}" title="${escapeHtml(c.title)}">${escapeHtml(c.name)}</option>`,
  ).join("");
}

// --------------------------------------------------------------- decision

/** The newer of the last refusal and the last write, if either. */
function latestOutcome(snap) {
  const refusal = snap?.lastRefusal;
  const write = snap?.lastWrite;
  if (refusal && (!write || Date.parse(refusal.at) >= Date.parse(write.at))) return { kind: "refusal", refusal };
  return write ? { kind: "write", write } : null;
}

const refusedLabels = (snap) => snap?.lastRefusal?.items?.map((i) => i.label) ?? snap?.offeredHandoff?.labels ?? [];
const handoffReason = (snap) =>
  snap?.handoff?.reason ??
  view.handoff?.reason ??
  (String(snap?.outcome ?? "").startsWith("transferred:") ? snap.outcome.slice("transferred:".length) : null);

/** The headline: what the server decided, and why, in plain English. */
function decision(snap) {
  if (!snap) return {};
  const rep = snap.rep;

  if (snap.state === "refused") {
    return {
      headline: "Not a rep on the list",
      why: "The number isn't a registered rep mobile and there's no Teams sign-in, so no PIN is offered and no record is opened. The agent ends the call politely.",
      verdict: "no records opened",
      tone: "err",
    };
  }
  if (snap.state === "ended") return endedDecision(snap);
  if (!rep && (snap.state === "transferring" || snap.state === "transferred")) {
    return {
      headline: "Couldn't verify — nothing disclosed",
      why: "The PIN was wrong, so no record was opened and nothing was read out. Sales Operations gets the call with only what is safe to share: the number it came from and the failed check.",
      verdict: "safe handoff",
      tone: "err",
    };
  }
  if (snap.state === "transferring" || snap.state === "transferred") return handoffDecision(snap);
  if (!rep && snap.state === "identifying") {
    return {
      headline: "Checking who's calling",
      why: "The number is a registered rep mobile. Caller ID is a hint, not proof, so nothing is read out until the PIN is right.",
      verdict: "caller ID + PIN",
      tone: "warn",
    };
  }
  if (!rep) {
    return { headline: "Answering…", why: "Checking who is calling before anything else.", verdict: "not verified yet", tone: "muted" };
  }

  const account = snap.proposal?.accountName ?? snap.account?.name ?? "the record";
  if (snap.pendingCommit) {
    return {
      headline: "Yes — the undo window is open",
      why: `The write waits ${wholeSeconds(policy.commitUndoMs)} on the server before it commits, so “wait” or “no” still stops it. Nothing has reached ${account}'s record yet.`,
      verdict: "confirmed, not yet written",
      tone: "warn",
    };
  }
  if (snap.state === "confirming" && snap.proposal) {
    const n = snap.proposal.rows?.length ?? 0;
    return {
      headline: "Read back — waiting for a yes",
      why: `The agent read back ${n === 1 ? "the change" : `all ${n} changes`} for ${account}. Nothing is written on the model's say-so: only an explicit yes opens the undo window.`,
      verdict: `${n} ${n === 1 ? "change" : "changes"} proposed`,
      tone: "accent",
    };
  }

  const latest = latestOutcome(snap);
  if (latest?.kind === "refusal") {
    const labels = latest.refusal.items?.map((i) => i.label) ?? [];
    return {
      headline: "Not mine to change",
      why: `${upper(andList(labels))} ${labels.length > 1 ? "aren't" : "isn't"} on the phone allow-list, so nothing was written. The server checks the list, not the model.${
        snap.offeredHandoff ? " The agent offers Sales Operations, who can change it." : ""
      }`,
      verdict: "refused by policy",
      tone: "err",
    };
  }
  if (latest?.kind === "write") {
    const w = latest.write;
    const n = w.rows?.length ?? 0;
    if (w.status === "committed") {
      return {
        headline: `Written to ${w.accountName ?? account}'s record`,
        why: `${n === 1 ? "One change" : `${n} changes`} after a read-back, an explicit yes and the undo window: ${w.auditRows} audit rows, audit ${w.auditId}. “Undo that” still reverses it on this call.`,
        verdict: "committed",
        tone: "ok",
      };
    }
    if (w.status === "cancelled") {
      return {
        headline: "Stopped — nothing written",
        why: `The caller changed their mind with ${seconds(w.remainingMs)} left in the undo window, so the write never reached the record.`,
        verdict: "stopped in the window",
        tone: "warn",
      };
    }
    if (w.status === "undone") {
      return {
        headline: "Undone — the record is back",
        why: "The caller said undo after the commit. The server reversed every field, and the trail keeps both the write and the undo.",
        verdict: "undone",
        tone: "warn",
      };
    }
  }
  if (snap.record) {
    return {
      headline: `Briefing ${rep.firstName} on ${snap.record.account.name}`,
      why: `Read from the record, scoped to accounts on ${rep.firstName}'s list. Phone numbers and email stay withheld until asked for; credit terms never leave Sales Operations.`,
      verdict: "read-only lookup",
      tone: "ok",
    };
  }
  return {
    headline: `Verified — ${rep.displayName}`,
    why:
      rep.verifiedBy === "teams-user"
        ? "Signed in to Teams, so no PIN is needed. Records open only for accounts on the rep's list."
        : "A registered mobile and the right PIN. Records open only for accounts on the rep's list.",
    verdict: rep.verifiedBy === "teams-user" ? "Teams sign-in" : "mobile + PIN",
    tone: "ok",
  };
}

function handoffDecision(snap) {
  const to = view.handoff?.target ?? snap.handoff?.target ?? `${org} Sales Operations`;
  const headline = snap.state === "transferred" ? `Handed to ${to}` : `Connecting to ${to}`;
  switch (handoffReason(snap)) {
    case "refused_by_policy":
      return {
        headline,
        why: `Only Sales Operations can change ${andList(refusedLabels(snap)) || "that"}, so the call goes there with the account and the request. Nobody has to ask ${snap.rep?.firstName ?? "the rep"} again.`,
        verdict: "refused by policy → a person",
        tone: "accent",
      };
    case "dtmf_zero":
      return { headline, why: "The caller pressed 0. A person is always one key away, and the context goes with the call.", verdict: "keypad 0 → a person", tone: "accent" };
    case "explicit_request":
      return { headline, why: "The caller asked for a person, so the agent put them straight through, with the context.", verdict: "asked for a person", tone: "accent" };
    case "two_failures":
      return { headline, why: "Two misses in a row, so the agent hands over instead of going round in circles.", verdict: "two misses → a person", tone: "warn" };
    default:
      return { headline, why: "The call goes to a person, with the context.", verdict: "handoff", tone: "accent" };
  }
}

function endedDecision(snap) {
  switch (snap.outcome) {
    case "transfer_failed":
      return {
        headline: "Nobody picked up",
        why: "Teams accepted the transfer, but nobody in Sales Operations answered. The agent said so and ended the call. It doesn't dial again, and nothing unconfirmed was written.",
        verdict: "transfer not answered",
        tone: "err",
      };
    case "two_no_inputs":
      return { headline: "Call ended", why: "Two silences in a row, so the agent ended the call. Anything unconfirmed is kept as a draft, never written.", verdict: "no input", tone: "muted" };
    case "call_time_cap":
      return { headline: "Out of time", why: "The call reached its time cap. Anything unconfirmed is kept as a draft, never written.", verdict: "time cap", tone: "warn" };
    default:
      return {
        headline: "Call ended",
        why: snap.lastWrite?.status === "committed" ? "The call ended after a confirmed write. It stays in the record and the audit trail." : "The call ended. Nothing unconfirmed was written.",
        verdict: "call ended",
        tone: "muted",
      };
  }
}

// ------------------------------------------------------------ record card

function renderRecord() {
  const snap = view.snap;
  const r = snap?.record;
  if (!r) {
    const ended = terminal(snap);
    const unverified = Boolean(snap && !snap.rep && ended);
    const text = !snap?.rep
      ? unverified
        ? "Nothing opened — the caller wasn't verified"
        : "Locked until the caller is verified"
      : ended
        ? "No record was opened on this call"
        : "Opens when the caller names an account";
    renderFacts(els.facts, [["Record", text, unverified ? { tone: "err" } : {}]]);
    return;
  }
  const a = r.account;
  const c = r.contact;
  const today = localDate(r.updatedAt);
  const due = (t) =>
    `${upper(t.subject)} · ${t.overdue ? `overdue since ${shortDate(t.dueDate)}` : t.dueDate === today ? "today" : shortDate(t.dueDate)}`;
  renderFacts(els.facts, [
    [
      "Account",
      `${escapeHtml([a.name, a.city, a.tier].filter(Boolean).join(" · "))} <span class="muted">· ${escapeHtml(a.relationship)}</span>`,
      { html: true },
    ],
    c && [
      "Contact",
      `${escapeHtml(c.title ? `${c.name}, ${c.title}` : c.name)}<span class="line muted">${
        c.phone ? `${escapeHtml(c.phone)} · read out on request` : "phone withheld until asked for"
      }${c.email ? ` · ${escapeHtml(c.email)}` : ""}</span>`,
      { html: true },
    ],
    [
      "Open deals",
      r.deals.length
        ? r.deals
            .map((d) => `<span class="line">${escapeHtml([d.name, d.stage, money(d.amount)].filter(Boolean).join(" · "))}</span>`)
            .join("")
        : "None",
      { html: true },
    ],
    r.lastTouch && ["Last touch", `${upper(r.lastTouch.type)} · ${r.lastTouch.subject} · ${shortDate(r.lastTouch.date)}`],
    r.dueTasks.length
      ? [
          "Due",
          r.dueTasks.map((t) => `<span class="line">${escapeHtml(due(t))}</span>`).join(""),
          { html: true, ...(r.dueTasks.some((t) => t.overdue) ? { tone: "warn" } : {}) },
        ]
      : null,
    ["Withheld", r.withheld.join("; "), { tone: "warn" }],
  ]);
}

function shortDate(iso) {
  const d = new Date(`${String(iso ?? "").slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(iso ?? "") : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The server's calendar date, so "today" means today on the demo clock. */
function localDate(iso) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: clock.state?.timeZone || undefined, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  } catch {
    return String(iso ?? "").slice(0, 10);
  }
}

// ------------------------------------------------------------- write-back

const IDLE_NOTE = "Nothing proposed yet. Every change is read back, confirmed and given an undo window before it's written.";

function renderDiff() {
  const { note, tone = "", rows = [] } = diffView(view.snap);
  els.diffNote.textContent = note;
  if (tone) els.diffNote.dataset.tone = tone;
  else delete els.diffNote.dataset.tone;
  els.diff.innerHTML = diffRows(rows);
}

function diffView(snap) {
  if (!snap) return { note: IDLE_NOTE };
  const proposal = snap.proposal;
  const tagged = (rows, tone, verb = "") => (rows ?? []).map((r) => ({ ...r, tone, verb }));
  const refused = (items) =>
    (items ?? []).map((i) => ({ refused: true, label: upper(withoutArticle(i.label)), detail: i.detail ?? "Not changed by phone" }));
  if (snap.pendingCommit && proposal) {
    return { note: "Confirmed. Writing when the undo window closes.", tone: "warn", rows: [...tagged(proposal.rows, "warn"), ...refused(proposal.refused)] };
  }
  if (snap.state === "confirming" && proposal) {
    return { note: "Read back to the caller. Nothing is written without a yes.", tone: "accent", rows: [...tagged(proposal.rows, "accent"), ...refused(proposal.refused)] };
  }
  const latest = latestOutcome(snap);
  if (latest?.kind === "refusal") return { note: "Refused by policy. Nothing was written.", tone: "err", rows: refused(latest.refusal.items) };
  if (latest?.kind === "write") {
    const w = latest.write;
    if (w.status === "committed") return { note: `Written · ${w.auditRows} audit rows · audit ${w.auditId}`, tone: "ok", rows: tagged(w.rows, "ok") };
    if (w.status === "cancelled") return { note: "Stopped inside the undo window. Nothing was written.", tone: "warn", rows: tagged(w.rows, "muted", "not written") };
    if (w.status === "undone") return { note: "Undone after the commit. The record is back to how it was.", tone: "warn", rows: tagged(w.rows, "muted", "undone") };
  }
  if (!snap.rep && terminal(snap)) return { note: "No record was opened, so nothing could be written." };
  return { note: IDLE_NOTE };
}

/** Rows grouped by what they change: "Enterprise renewal · stage" files under Enterprise renewal. */
function diffRows(rows) {
  let group = null;
  const out = [];
  for (const row of rows) {
    if (row.refused) {
      group = null;
      out.push(`<li data-tone="err"><span class="diff-label">${escapeHtml(row.label)}</span><span>${escapeHtml(row.detail)}</span></li>`);
      continue;
    }
    const cut = String(row.label).indexOf(" · ");
    const head = cut < 0 ? row.label : row.label.slice(0, cut);
    const field = cut < 0 ? null : row.label.slice(cut + 3);
    if (field && head !== group) out.push(`<li class="diff-group">${escapeHtml(head)}</li>`);
    group = field ? head : null;
    out.push(
      `<li data-tone="${escapeHtml(row.tone)}"><span class="diff-label">${escapeHtml(field ?? row.label)}</span><span>${change(row)}</span></li>`,
    );
  }
  return out.join("");
}

function change(row) {
  const before = row.before == null ? "" : escapeHtml(row.before);
  const after = escapeHtml(row.after ?? "");
  if (row.verb) return `${before ? `<b>${before}</b> · ` : ""}<s>${after}</s> <span class="muted">${escapeHtml(row.verb)}</span>`;
  return before ? `<s>${before}</s> → <b>${after}</b>` : `<b>${after}</b>`;
}

/** Beat 2: let the undo window run out on the server, then point at the write-back. */
async function watchWindow() {
  const deadline = performance.now() + policy.commitUndoMs + 3000;
  while (view.snap?.pendingCommit && !terminal(view.snap) && performance.now() < deadline) await sleep(100);
  await sleep(250);
  flash(els.writeback);
  await refreshStats({ highlight: true });
}

// ----------------------------------------------------------------- budget

function budgetStop(snap) {
  if (snap.state === "transferred") return "handed over";
  if (snap.state === "refused") return "refused";
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
  renderBudget(els.budget, { elapsedMs, budgetMs: snap.budgetMs ?? policy.callBudgetMs });
  const parts = els.budget.pkBudget;
  if (stop && parts && !els.budget.hidden) {
    parts.label.textContent += ` · ${stop}`;
    parts.fill.dataset.tone = stop === "handed over" ? "ok" : "muted";
  }
}

// ------------------------------------------------------- the undo window

/** The bar shows the server's window: it starts, stops and finishes on what the server reports. */
function syncWindow(snap, prev) {
  const pending = snap.pendingCommit;
  if (pending && !terminal(snap)) {
    if (view.windowFor === pending.proposalId) return;
    view.windowFor = pending.proposalId;
    const to = snap.proposal?.accountName ?? snap.account?.name ?? "the record";
    win.start(
      pending.remainingMs ?? pending.windowMs ?? policy.commitUndoMs,
      (left, leftMs) => (leftMs > 0 ? `Writing to ${to} in ${left} — “wait” or “no” still stops it` : `Writing to ${to}…`),
      { tone: "warn" },
    );
    return;
  }
  if (!view.windowFor) return;
  view.windowFor = null;
  const write = snap.lastWrite;
  if (write?.status === "committed") {
    win.finish(
      "ok",
      terminal(snap) && prev?.pendingCommit
        ? "Written — the call ended inside the window"
        : `Written · ${write.auditRows} audit rows · audit ${write.auditId}`,
    );
  } else if (write?.status === "cancelled") {
    win.stop("warn", `Stopped with ${seconds(write.remainingMs)} left — nothing written`);
  } else {
    win.stop("muted", "The window closed without a write");
  }
}

// ------------------------------------------------------------ Teams side

function renderHandoff() {
  const h = view.handoff;
  if (!h) return;
  const ctx = parseContext(h.callContext);
  const reason = h.reason ?? ctx?.reason;
  const verified = Boolean(ctx?.rep) && ctx?.verified !== false;

  const callerHtml = verified
    ? `<strong>${escapeHtml(ctx.rep)}</strong>${ctx.account ? ` · ${escapeHtml(ctx.account)}` : ""}<div class="muted">${escapeHtml(
        org,
      )} sales rep</div><span class="verified">Verified · ${escapeHtml(ctx.verifiedBy ?? "")}</span>`
    : `<strong>Unverified caller</strong><div class="muted">${escapeHtml(ctx?.callerId ?? "caller ID withheld")}</div><span class="unverified">Not verified — no records opened</span>`;

  const reasonText = REASONS[reason];
  const tags = [
    { text: "Sales Operations", tone: "teams" },
    reasonText && !sameWords(reasonText, h.callTopic)
      ? { text: reasonText, tone: reason === "refused_by_policy" || reason === "verification_failed" ? "err" : "accent" }
      : null,
    ctx?.lastWrite ? { text: "earlier write on this call", tone: "ok" } : null,
    ctx?.draftId ? { text: "draft saved", tone: "accent" } : null,
  ].filter(Boolean);

  renderTeamsToast(els.toast, {
    queue: h.target ?? `${org} Sales Operations`,
    subtitle: "Call queue · handed over by the record desk agent",
    topic: h.callTopic,
    context: contextSentence(h, ctx),
    callerHtml,
    avatar: "Sales Operations",
    tags,
    status: view.transferFailed ? "Not answered" : "Incoming call",
  });
  els.toastEmpty.hidden = true;
  // Built on the server by the same function the real transfer uses.
  renderHeaders(els.headers, (h.voipHeaders ?? []).map((x) => [x.key, x.value]));
}

function parseContext(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

const sentence = (s) => {
  const text = String(s ?? "").trim();
  if (!text) return "";
  return /[.!?…”]$/.test(text) ? upper(text) : `${upper(text)}.`;
};

/** The context travels as JSON for the receiving app; the toast says it in a sentence. */
function contextSentence(h, ctx) {
  if (!ctx) return sameWords(h.callContext, h.callTopic) ? "" : String(h.callContext ?? "");
  if (ctx.verified === false) return [ctx.check, ctx.note].map(sentence).filter(Boolean).join(" ");
  const parts = [];
  if (ctx.request) parts.push(`Asked: “${ctx.request}”`);
  if (ctx.refusedRequests?.length) {
    parts.push(`${upper(andList(ctx.refusedRequests))} can't be changed by phone, so nothing was written.`);
  }
  if (ctx.proposal) parts.push(`Not yet confirmed: ${sentence(ctx.proposal)}`);
  if (ctx.lastWrite) parts.push(`Earlier on this call: ${sentence(ctx.lastWrite)}`);
  if (ctx.draftId) parts.push("An unconfirmed update is saved as a draft.");
  return parts.join(" ");
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

function renderToastPlaceholder() {
  if (view.handoff) return;
  const snap = view.snap;
  els.toastEmpty.textContent = !snap
    ? "No call has been handed over yet."
    : snap.offeredHandoff
      ? "Sales Operations offered — waiting for the caller's answer."
      : snap.state === "refused"
        ? "No handoff: the caller isn't on the rep list, so the call ended politely."
        : snap.state === "ended"
          ? "The call ended without a handoff."
          : "No call has been handed over yet.";
}

// ---------------------------------------------------------------- metrics

function renderStats(stats) {
  if (!stats) return;
  renderMetrics(els.metrics, [
    ["Calls", stats.calls],
    ["Lookups", stats.lookups],
    ["Confirmed writes", stats.confirmedWrites],
    ["Undone writes", stats.undoneWrites],
    ["Refusals", stats.refusals],
    ["Handoffs", stats.handoffs],
    ["Verification failures", stats.verificationFailures],
    stats.failedTransfers > 0 ? ["Transfers not answered", stats.failedTransfers] : null,
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

// Events that move a metric mid-call, so the footer keeps up without a flash.
const COUNTED = new Set([
  "briefing",
  "lookup",
  "contact_lookup",
  "commit",
  "commit_cancelled",
  "undo",
  "policy_refusal",
  "refused_write",
  "verification_failed",
]);
let statsTimer = null;
function statsSoon() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => refreshStats(), 300);
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
  const live = renderMode(els.mode, health);
  els.reset.disabled = live;
  if (live) els.reset.title = "Demo controls are off while this server answers real calls.";
  org = health.organization ?? org;
  els.org.textContent = org;
  document.title = `${org} — Record desk`;
  for (const key of Object.keys(policy)) {
    const value = health.policy?.[key];
    if (typeof value === "number") policy[key] = value;
  }
  if (stack) stack.setLive(live);
  else stack = mountStack($("stack"), { live, nodes: stackNodes() });
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
    notify("Demo reset — clean audit, seeded records, starting clock, beat 1.", "ok");
  } catch (error) {
    if (error.status === 403) notify("Reset is off while this server answers real calls.", "warn");
    else notify(error.message, "err");
  }
});

// Last, so every declaration above is initialized before the first render.
setInterval(tickBudget, 500);
boot();
