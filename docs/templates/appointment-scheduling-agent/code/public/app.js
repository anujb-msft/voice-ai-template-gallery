/**
 * The scheduling console.
 *
 * A viewer of the server's booking state machine, never a second copy of it.
 * Every decision on screen (who the caller is, whether the visit can be booked
 * by voice, which time is held, whether anything may be written) is one the
 * server made and published over the hub; this file only explains it. The
 * model finds and proposes times. Only the caller's own yes to the active
 * proposal writes, and the panels are laid out to make that visible: the four
 * checks, the hold, the refusals and the grid. The plumbing every template
 * shares (hub, call session, demo director, Teams toast, trail) comes from the
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
  chip,
  connectHub,
  createCallSession,
  createSimulator,
  renderMode,
  setStateChip,
  renderBudget,
  createCountdown,
  renderDecision,
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

// Three of the seeded patients (fixtures/appointments-seed.json), so the
// presenter can choose who is calling. Caller ID alone never verifies anyone.
const CALLERS = [
  { phone: "+12065550142", name: "Jordan Rivera" },
  { phone: "+12065550102", name: "Mia Chen" },
  { phone: "+12065550101", name: "Avery Stone" },
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
  takeSlot: $("takeSlot"),
  modelBook: $("modelBook"),
  decision: $("decision"),
  checks: $("checks"),
  hold: $("hold"),
  facts: $("facts"),
  toast: $("toast"),
  toastEmpty: $("toastEmpty"),
  wire: $("wire"),
  headers: $("headers"),
  gridWho: $("gridWho"),
  grid: $("grid"),
  optionsHead: $("optionsHead"),
  options: $("options"),
  booking: $("booking"),
  metrics: $("metrics"),
};
// The hold on the active proposal, then the short wait before a transfer dispatches.
const hold = createCountdown(els.hold);

const TERMINAL = new Set(["booked", "rescheduled", "cancelled", "waitlisted", "callback_filed", "transferred", "ended"]);
// The hub's handoff frame rings the toast; a snapshot carries the same context if that frame was missed.
const HANDED = new Set(["transferred", "callback_filed"]);

const STATE_TONES = {
  ringing: "accent",
  verifying: "warn",
  verified: "ok",
  registering: "accent",
  offering: "accent",
  confirming: "warn",
  escalating: "warn",
  booked: "ok",
  rescheduled: "ok",
  cancelled: "ok",
  waitlisted: "ok",
  callback_filed: "ok",
  transferred: "ok",
  ended: "muted",
};

const VERBS = { book: "Booked", reschedule: "Moved", cancel: "Cancelled" };

const REASONS = {
  caller_request: "The caller asked for a person.",
  no_availability: "Nothing on the schedule fits what the caller needs.",
  not_understood: "The agent couldn't make out the request.",
  time_budget: "The call ran out of time.",
  two_no_inputs: "The caller went quiet twice.",
  write_failed: "The booking couldn't be written.",
  verification_failed: "The name and date of birth didn't match a patient after two tries.",
  referral_required: "The visit needs a referral on file before it can be booked.",
  eligibility: "The visit can't be booked by voice.",
  emergency: "The caller described an emergency.",
  urgent: "The caller needs to be seen urgently.",
  unauthorized_proxy: "The caller isn't on file as authorized for this patient.",
  new_patient: "A new patient registers before anything is booked.",
};

// Why each rule in config/eligibility.json blocks a voice booking.
const RULES = {
  REFERRAL_REQUIRED: "Dermatology needs a referral from primary care on file, and there isn't one.",
  ORDER_REQUIRED: "Imaging needs an active order on file for that kind of scan, and there isn't one.",
  ANNUAL_TOO_SOON: "There's already an annual physical within the last 12 months.",
  INSURANCE_INACTIVE: "The insurance on file isn't active.",
};

// The refusal the server spoke, from the start of its trail entry.
const REFUSALS = [
  [/^the model has no booking tool/, "model"],
  [/^no active proposal/, "no_proposal"],
  [/^caller not verified/, "not_verified"],
  [/^already confirmed/, "locked"],
];

const CHECK_TONES = { pass: "ok", fail: "err", warn: "warn", pending: "idle" };

const BLANK_CHECKS = [
  { label: "Identity", detail: "a name and date of birth that match a patient", tone: "idle" },
  { label: "Eligibility", detail: "the rules in config/eligibility.json", tone: "idle" },
  { label: "Active proposal", detail: "one time, held and read back", tone: "idle" },
  { label: "Caller consent", detail: "the caller's own yes to that time", tone: "idle" },
];

const STATE_WORDS = {
  free: "open",
  booked: "booked",
  held: "held",
  break: "break",
  past: "past",
  lead: "inside the lead time",
  closed: "closed",
  holiday: "clinic holiday",
};
const MARK_WORDS = {
  mine: "booked on this call",
  taken: "booked by the front desk mid-call",
  hold: "held for this caller",
  offer: "offered to this caller",
};

// Defaults until /health answers; the server's numbers win.
const scheduling = { holdTtlMs: 300_000, transferDelayMs: 2500, callTimeBudgetMs: 420_000, minLeadMinutes: 60 };

const org = els.org.textContent.trim() || "Contoso Health";

let health = null;
let live = false;
let stack = null;
let clockLocked = false;
let resetLocked = false;
let sending = false;
let grid = null; // the last /api/schedule/grid answer
let gridFor = null; // the provider it was asked for
let gridSeq = 0;
let gridHtml = "";
let bookingSig = "";
let clockNow = null;
let view = blankView();

/** What the console has learned about the call on screen, beyond its snapshot. */
function blankView() {
  return {
    snap: null,
    flag: null, // the latest refused write that wasn't a race: model | no_proposal | not_verified | locked
    taken: null, // { label, appointmentId, proposalId }: what the front desk booked mid-call
    handoff: null,
    holdFor: null, // the proposal the hold bar is counting down
    frozenMs: null,
    syncedAt: 0,
    skipAgeCheck: false, // the demo clock moved back, so the call's elapsed time can too
  };
}

const terminal = (snap) => TERMINAL.has(snap?.state);
// Only an active proposal can be confirmed; a written, released or void one stays in the snapshot.
const activeProposal = (snap) => (snap?.proposal?.status === "active" ? snap.proposal : null);
const agentLabel = () => `${org} assistant`;
const callerLabel = () => view.snap?.patient?.firstName ?? "Caller";
const withheld = (snap) => (snap?.maskedPhone && snap.maskedPhone !== "anonymous" ? snap.maskedPhone : "number withheld");
const reasonWords = (reason) => REASONS[reason] ?? (reason ? `${capital(String(reason).replace(/_/g, " "))}.` : "");
const say = (...parts) => parts.filter(Boolean).join(" ");
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const hourLabel = (h) => `${((h + 11) % 12) + 1}${h < 12 ? "a" : "p"}`;
// The grid follows the provider this call is about.
const gridProvider = (snap) =>
  snap?.booking?.providerId ?? snap?.proposal?.providerId ?? snap?.options?.find((o) => o.providerId)?.providerId ?? "prov-patel";

/** "Referral coordinator" → "the referral coordinator", for a sentence. */
function destName(dest) {
  const label = String(dest?.label ?? "").trim();
  if (!label) return "a person";
  return /\b(team|line|coordinator|desk)\b/i.test(label) ? `the ${label.charAt(0).toLowerCase()}${label.slice(1)}` : label;
}

function mmss(ms) {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "13:15" → "1:15 PM". */
function time12(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

const stackNodes = () =>
  voiceStack({
    voiceLive: health?.voiceLive?.model ?? "gpt-realtime",
    tools: "Scheduling policy",
    toolsSim: "real policy code",
    agent: "Teams call queue",
    agentSim: "mock toast",
  });

// ------------------------------------------------------------------ wiring

const voice = createVoice($("voice"), { lang: "en-US" });
const clock = mountClock($("clock"), {
  onChange: (state) => {
    if (clockNow !== null && state?.now < clockNow) view.skipAgeCheck = true;
    clockNow = state?.now ?? null;
    // The past and the lead time follow the clock.
    refreshGrid();
  },
});
const transcript = createTranscript($("transcript"), {
  voice,
  empty: "Answer a call, or press Next ▶ to run the demo script.",
});
const trail = createTrail($("events"), {
  good: ["identity_verified", "eligible", "consent", "race_resolved", "booked", "rescheduled", "cancelled", "callback_filed", "waitlisted"],
  bad: [
    "identity_not_confirmed",
    "identity_failed",
    "slot_taken",
    "taken_elsewhere",
    "eligibility_blocked",
    "write_refused",
    "safety",
    "transfer_failed",
    "budget_expired",
  ],
  warn: [
    "proposal",
    "options_offered",
    "proposal_released",
    "handoff_requested",
    "no_input",
    "not_understood",
    "advised",
    "declined",
    "no_openings",
    "no_more",
  ],
  timeZone: () => clock.state?.timeZone,
  empty: "Every check, proposal, refusal and write shows up here.",
});
const session = createCallSession({
  voice,
  onMessage,
  onFollow: () => clearPanels(),
  stateTargets: ["state"],
  stateOf: (payload) => payload?.state,
  isFinished: (state) => TERMINAL.has(state),
});
connectHub((target, payload) => session.handle(target, payload), {
  onOpen: ({ reconnected }) => reconnected && refreshAll(),
});
const sim = createSimulator({
  session,
  startBody,
  onSnapshot: applySnapshot,
  actions: { "take-slot": () => takeSlot(), "model-book": () => modelBook(), metrics: showMetrics },
});
const director = createDirector($("director"), {
  beats: createBeats({ setClock, resetDemo }),
  perform,
  voice,
  sayInput: els.sayInput,
  onBeat: () => {
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: "smooth" });
  },
});

setInterval(tickBudget, 500);
// The past and the lead time move with the clock, so keep the grid honest.
setInterval(refreshGrid, 60_000);
boot();

async function boot() {
  renderCallers();
  renderHeaders(els.headers, []);
  render();
  await Promise.all([loadHealth(), refreshGrid(), refreshStats()]);
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
    const deadline = performance.now() + scheduling.transferDelayMs + 3000;
    while (view.snap?.state === "escalating" && performance.now() < deadline) await sleep(100);
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

/** Beat 1 starts from the seeded schedule, so every run offers the same times. */
async function resetDemo() {
  let result;
  try {
    result = await postJson("/api/demo/reset");
  } catch (error) {
    if (error.status !== 403) throw error;
    if (!resetLocked) {
      resetLocked = true;
      notify("This server answers real calls, so the demo schedule isn't reset.", "warn", 6000);
    }
    return false;
  }
  session.reset();
  clearPanels();
  renderStats(result.stats);
  await Promise.all([clock.refresh(), refreshGrid()]);
  return true;
}

/** Demo action: the front desk books the time this caller is about to accept. */
async function takeSlot() {
  if (!session.id) throw new Error("Answer a call first.");
  try {
    const result = await postJson("/api/demo/take-slot", { callId: session.id });
    view.taken = { ...view.taken, label: result.label, appointmentId: result.appointmentId, proposalId: result.proposalId };
    if (result.snapshot) applySnapshot(result.snapshot);
    render();
    refreshGrid();
    return result;
  } catch (error) {
    if (error.status === 409) {
      notify(error.message, "warn");
      if (error.body?.snapshot) applySnapshot(error.body.snapshot);
      return null;
    }
    if (error.status === 403) {
      notify("Demo actions are off while this server answers real calls.", "warn");
      return null;
    }
    throw error;
  }
}

/** Demo action: the model reaches for a "book" tool, through the same dispatcher a live call uses. */
async function modelBook() {
  if (!session.id) throw new Error("Answer a call first.");
  try {
    const result = await postJson("/api/demo/tool", { callId: session.id, name: "book", args: {} });
    if (result.snapshot) applySnapshot(result.snapshot);
    return result;
  } catch (error) {
    if (error.status === 403) {
      notify("Demo actions are off while this server answers real calls.", "warn");
      return null;
    }
    throw error;
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
    case "schedule":
      if (payload?.reason === "taken_elsewhere" && payload.appointmentId) {
        view.taken = { ...view.taken, appointmentId: payload.appointmentId };
      }
      refreshGrid();
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
  if (prev && !view.skipAgeCheck && (snap.elapsedMs ?? 0) < (prev.elapsedMs ?? 0)) return;
  view.skipAgeCheck = false;

  view.snap = snap;
  view.syncedAt = performance.now();
  updateHold(snap, prev);
  if (!view.handoff && snap.handoff && HANDED.has(snap.state)) {
    view.handoff = snap.handoff;
    renderHandoff();
  }
  if (terminal(snap) && !terminal(prev)) refreshStats({ highlight: true });
  if (gridProvider(snap) !== gridFor) refreshGrid();
  render();
}

function onEvent(e) {
  trail.add(e);
  const detail = String(e.detail ?? "");
  switch (e.kind) {
    case "identity_verified":
      transcript.tool("verify_patient", detail.split(" · ").slice(0, 2).join(" · "), "ok");
      break;
    case "identity_failed":
      transcript.tool("verify_patient", `no match · ${detail}`, "err");
      break;
    case "identity_not_confirmed":
      transcript.system("Identity not confirmed after two tries — nothing about appointments was said.");
      break;
    case "eligible":
      transcript.tool("choose_visit_type", detail, "ok");
      break;
    case "eligibility_blocked":
      view.flag = null;
      transcript.tool("choose_visit_type", `${detail} · no times offered`, "err");
      break;
    case "reason":
      transcript.tool("note_reason", "kept out of the console", "muted");
      break;
    case "search":
      transcript.tool("search_slots", detail, "accent");
      break;
    case "options_offered":
    case "proposal_released":
    case "declined":
      view.flag = null;
      break;
    case "proposal":
      view.flag = null;
      transcript.tool(detail.includes(" · cancel ") ? "propose_cancel" : "hold_slot", detail, "warn");
      break;
    case "keypad":
      transcript.system(`Keypad · ${detail}`);
      break;
    case "consent":
      transcript.system(`✓ Consent — ${detail}`);
      break;
    case "write_refused":
      // A failed write is explained by the event that follows it (slot_taken).
      if (e.source === "system") {
        if (!detail.includes("slot_taken")) transcript.system(`✕ Write refused — ${detail}`);
        break;
      }
      view.flag = REFUSALS.find(([pattern]) => pattern.test(detail))?.[1] ?? "no_proposal";
      if (e.source === "agent") transcript.tool("book", "refused — the model has no booking tool · nothing written", "err");
      else transcript.system(`✕ Write refused — ${detail}`);
      break;
    case "taken_elsewhere": {
      const label = detail.split(" booked by")[0];
      view.taken = { ...view.taken, label };
      transcript.system(`Meanwhile, the front desk books ${label}. The caller hasn't been told.`);
      break;
    }
    case "slot_taken": {
      view.flag = null;
      const label = detail.replace(/^P\d+ void · /, "").replace(/ was booked by another channel$/, "");
      transcript.system(`✕ ${label} was taken before the yes reached the server — nothing written`);
      break;
    }
    case "booked":
    case "rescheduled":
    case "cancelled": {
      const match = /^(\S+) · .* · (P\d+) confirmed by the caller$/.exec(detail);
      const verb = { booked: "booked", rescheduled: "moved the visit to", cancelled: "cancelled" }[e.kind];
      transcript.system(
        match ? `✓ The server ${verb} ${match[1]} on the caller's yes to ${match[2]}` : `✓ ${capital(e.kind)} — ${detail}`,
      );
      break;
    }
    case "transfer_simulated":
    case "transfer_succeeded":
      transcript.system(`↪ Handed over to ${destName({ label: detail.split(" · ")[0] })} in Teams`);
      break;
    case "transfer_failed":
      transcript.system(`✕ Transfer failed — ${detail}`);
      break;
    case "transfer_retry":
      transcript.system(`Retrying the transfer to ${detail}`);
      break;
    case "transfer_diverted":
      transcript.system(`↪ Diverted to ${detail}`);
      break;
    case "callback_filed":
      transcript.system(`✓ Callback filed — ${detail}`);
      break;
    case "advised":
      transcript.system(`ℹ ${detail}`);
      break;
    case "waitlisted":
      transcript.system(`✓ Waitlisted — ${detail}`);
      break;
    case "no_input":
      transcript.system("— the caller says nothing —");
      break;
    case "not_understood":
      transcript.system(`— not understood (${detail}) —`);
      break;
    case "safety":
      transcript.system(`⚠ ${detail}`);
      break;
    case "budget_expired":
      transcript.system("Out of time — handing the caller to a person.");
      break;
  }
  render();
}

// ----------------------------------------------------------------- render

function render() {
  const snap = view.snap;
  const state = snap?.state ?? null;
  const tone = state === "ended" && snap.outcome === "transfer_failed" ? "err" : (STATE_TONES[state] ?? "muted");
  setStateChip(els.stateChip, state, tone);
  renderControls();
  renderDecision(els.decision, { ...decision(snap), empty: "Answer a call to see what the server allows." });
  renderChecks(
    els.checks,
    snap?.checks?.length
      ? snap.checks.map((c) => ({ label: c.label, detail: c.detail, tone: CHECK_TONES[c.status] ?? "idle" }))
      : BLANK_CHECKS,
  );
  renderFactsPanel();
  renderGrid();
  renderOptions();
  renderToastPlaceholder();
  tickBudget();
}

function renderControls() {
  const snap = view.snap;
  const active = Boolean(session.id && !session.finished && !session.followed && snap && !terminal(snap));
  for (const el of [els.sayInput, els.sayBtn, els.silence, els.hangup]) el.disabled = !active;
  for (const button of els.keys.querySelectorAll("button")) button.disabled = !active;
  // Demo actions are simulation-only; the server refuses them on a live line.
  const demo = active && !live && snap.simulated && snap.state !== "escalating";
  els.takeSlot.disabled = !(demo && (activeProposal(snap) || snap.options?.some((o) => !o.released)));
  els.modelBook.disabled = !demo;
}

/** The headline: what the server decided, and why, in plain English. */
function decision(snap) {
  if (!snap) return {};
  const who = callerLabel();
  const dest = snap.destination;
  const booking = snap.booking;
  const active = activeProposal(snap);
  const nothing = booking ? "" : "Nothing was booked on this call.";

  if (snap.state === "escalating") {
    return {
      headline: `Connecting to ${destName(dest)}`,
      why: say(reasonWords(dest?.reason), "A person takes it from here, with the call topic and what's already been checked.", nothing),
      verdict: "handoff pending",
      tone: "warn",
    };
  }
  if (snap.state === "transferred") {
    return {
      headline: `Handed over to ${destName(dest)}`,
      why: say(reasonWords(dest?.reason), "Their Teams client rang with the call topic and context, so nobody starts over.", nothing),
      verdict: snap.simulated ? "transferred · simulated" : "transferred",
      tone: "ok",
    };
  }
  if (snap.state === "callback_filed") {
    const cb = snap.callback;
    return {
      headline: `Callback filed — ${cb?.label ?? "scheduling"}`,
      why: say(
        reasonWords(dest?.reason ?? view.handoff?.reason),
        `${cb?.label ?? "The team"} calls back on ${cb?.number ?? "the number on file"}${cb?.preferredTime ? `, ${cb.preferredTime}` : ""}.`,
        nothing,
      ),
      verdict: "callback filed",
      tone: "ok",
    };
  }
  if (booking) {
    return {
      headline: `${VERBS[booking.kind] ?? "Booked"} — ${booking.appointmentId}`,
      why: say(
        `Written only when ${who} said yes to ${booking.proposalId}: ${booking.label}.`,
        booking.afterRace ? "The first time was taken mid-call, so this was a fresh pick with a fresh yes." : "",
        "The model has no booking tool.",
      ),
      verdict: `written on ${who}'s yes`,
      tone: "ok",
    };
  }
  if (snap.state === "waitlisted") {
    return {
      headline: "On the waitlist",
      why: "Nothing on the schedule fit, so the caller is on the waitlist for the first opening. Nothing was booked.",
      verdict: "waitlisted",
      tone: "ok",
    };
  }
  if (snap.state === "ended") {
    if (String(snap.outcome ?? "").startsWith("advised:")) {
      return {
        headline: `${dest?.label ?? "The team"} is closed`,
        why: "There was no callback number to leave, so the agent told the caller who to call and when. Nothing was booked.",
        verdict: "caller advised",
        tone: "warn",
      };
    }
    if (snap.outcome === "transfer_failed") {
      return {
        headline: "The transfer didn't go through",
        why: say(`The call couldn't be handed to ${destName(dest)}.`, nothing),
        verdict: "transfer failed",
        tone: "err",
      };
    }
    return {
      headline: "Call ended",
      why: "Nothing was written on this call. A held time is let go without the caller's yes, never booked.",
      verdict: "nothing written",
      tone: "muted",
    };
  }
  if (snap.state === "registering") {
    return {
      headline: "New patient — registration first",
      why: "There's no patient record to book against, so the agent takes a callback number for the registration team. Nothing is booked by voice.",
      verdict: "registration callback",
      tone: "accent",
    };
  }
  if (snap.state === "ringing" || snap.state === "verifying") {
    if (!snap.attempts) {
      return {
        headline: "Who's calling?",
        why: say(
          snap.callerIdMatch ? "Caller ID matches a patient, but that isn't proof." : "Caller ID doesn't match a patient.",
          "Nothing about appointments is said until a name and date of birth match.",
        ),
        verdict: "identity first",
        tone: "accent",
      };
    }
    return {
      headline: "No match — one more try",
      why: "The name and date of birth didn't match a patient. A second miss goes to a person, and nothing about appointments is said either way.",
      verdict: `attempt ${snap.attempts} of 2`,
      tone: "err",
    };
  }
  if (view.flag) return refusal(view.flag, who, active);
  if (snap.blocked) {
    const rule = snap.blocked.ruleId;
    return {
      headline: `Not bookable by voice — ${snap.visitType?.name ?? "this visit"}`,
      why: say(RULES[rule] ?? "An eligibility rule blocks it.", "A rule in config/eligibility.json decides this, not the model."),
      verdict: `${rule} · no times offered`,
      tone: "err",
    };
  }
  if (snap.raceLost && !active) {
    const lost = snap.raceLost;
    return {
      headline: "Taken mid-call — fresh pick, fresh yes",
      why: say(
        `${lost.label} was booked elsewhere before ${who}'s yes reached the server, so ${lost.proposalId ?? "that time"} is void and nothing was written.`,
        `The server never moves a yes to a different time: ${who} picks again and says yes again.`,
      ),
      verdict: "nothing written",
      tone: "err",
    };
  }
  if (active) {
    if (view.taken?.proposalId === active.id) {
      return {
        headline: `${active.id} held — but the front desk just booked it`,
        why: say(
          `${who} hasn't been told.`,
          "When the yes comes in, the server checks the time again at the write, so it is never double-booked or swapped for another.",
        ),
        verdict: "checked again at the write",
        tone: "warn",
      };
    }
    const cancel = active.kind === "cancel";
    return {
      headline: `${active.id} ${cancel ? "read back" : "held"} — waiting for ${who}'s yes`,
      why: say(
        cancel
          ? `Cancelling ${active.label}.`
          : `${active.label}${active.providerName ? ` with ${active.providerName}` : ""} is held until ${active.heldUntil} and read back.`,
        `Only ${who}'s own yes to ${active.id} writes it; the model can't.`,
        snap.raceLost
          ? `${snap.raceLost.proposalId ?? "The first time"} was taken mid-call, so this is a fresh pick that needs a fresh yes.`
          : "",
      ),
      verdict: "nothing written yet",
      tone: "warn",
    };
  }
  if (snap.state === "offering") {
    const open = (snap.options ?? []).filter((o) => !o.released).length;
    return {
      headline: open ? `${open === 1 ? "One time" : open === 2 ? "Two times" : `${open} times`} offered — nothing held` : "Looking for times",
      why: say(
        open ? "The server found times that fit and the agent read them out." : "",
        `Nothing is held, and nothing is written, until ${who} picks one.`,
      ),
      verdict: "nothing held",
      tone: "accent",
    };
  }
  if (snap.state === "verified") {
    return {
      headline: `Verified — ${who}`,
      why: "The name and date of birth matched a patient on the server. Next: what the visit is for, then times that fit.",
      verdict: "identity confirmed",
      tone: "ok",
    };
  }
  return { headline: capital(String(snap.state).replace(/_/g, " ")), why: "", verdict: "", tone: "muted" };
}

/** A write the server refused, and why. */
function refusal(flag, who, active) {
  const still = active ? `${active.id} is still held; only ${who}'s own yes to it writes.` : "";
  switch (flag) {
    case "model":
      return {
        headline: "Refused — the model has no booking tool",
        why: say(
          "The model asked to book. Booking isn't one of its tools, so the server refused and wrote nothing.",
          still || `Only ${who}'s own yes to a time that's held and read back can write.`,
        ),
        verdict: "nothing written",
        tone: "err",
      };
    case "not_verified":
      return {
        headline: "Refused — identity not confirmed",
        why: "Nothing is written, or said about appointments, until a name and date of birth match.",
        verdict: "nothing written",
        tone: "err",
      };
    case "locked":
      return {
        headline: "Already confirmed",
        why: `${who} already said yes to that time, and a second yes doesn't write twice.`,
        verdict: "nothing written",
        tone: "warn",
      };
    default:
      return {
        headline: "Refused — nothing to say yes to",
        why: say(
          `${who} asked to book before any time was held and read back.`,
          "A yes counts only for the active proposal, so the server wrote nothing.",
          still,
        ),
        verdict: "nothing written",
        tone: "err",
      };
  }
}

function renderFactsPanel() {
  const snap = view.snap;
  if (!snap) {
    renderFacts(els.facts, [
      ["Caller ID", ""],
      ["Visit", ""],
      ["Looking for", ""],
      ["Refused writes", ""],
      ["Slot races", ""],
      ["Handoff", ""],
    ]);
    return;
  }
  const rule = snap.blocked?.ruleId;
  const handoff = snap.destination ?? (snap.callback ? { label: snap.callback.label, reason: "callback" } : null);
  renderFacts(els.facts, [
    [
      "Caller ID",
      `${escapeHtml(withheld(snap))} <small class="muted">${
        snap.callerIdMatch ? "matches a patient — not proof" : "no patient match"
      }</small>`,
      { html: true },
    ],
    ["Visit", [snap.visitType?.name, rule].filter(Boolean).join(" · "), rule ? { tone: "err" } : {}],
    ["Looking for", snap.preferences ?? ""],
    ["Refused writes", String(snap.refusals ?? 0), snap.refusals ? { tone: "err" } : {}],
    ["Slot races", String(snap.races ?? 0), snap.races ? { tone: "warn" } : {}],
    ["Handoff", handoff ? `${handoff.label} · ${String(handoff.reason ?? "").replace(/_/g, " ")}` : ""],
  ]);
}

function renderCallers() {
  // Names only, so the picker never truncates.
  els.callerSelect.innerHTML = CALLERS.map(
    (c) => `<option value="${escapeHtml(c.phone)}">${escapeHtml(c.name)}</option>`,
  ).join("");
}

// ------------------------------------------------------------------- hold

/** The hold bar: the active proposal's minutes, then the short wait before a transfer dispatches. */
function updateHold(snap, prev) {
  if (snap.state === "escalating") {
    view.holdFor = null;
    if (prev?.state === "escalating") return;
    const to = destName(snap.destination);
    if (!scheduling.transferDelayMs) hold.hide();
    else hold.start(scheduling.transferDelayMs, (left, leftMs) => (leftMs > 0 ? `Connecting to ${to} in ${left}` : `Connecting to ${to}…`), { tone: "warn" });
    return;
  }
  if (snap.state === "transferred") {
    view.holdFor = null;
    if (prev?.state === "transferred") return;
    if (scheduling.transferDelayMs) hold.finish("ok", `Handed over to ${destName(snap.destination)} in Teams`);
    else hold.hide();
    return;
  }

  const active = activeProposal(snap);
  if (view.holdFor && active?.id !== view.holdFor) {
    const id = view.holdFor;
    view.holdFor = null;
    if (snap.booking?.proposalId === id) hold.finish("ok", `${id} written as ${snap.booking.appointmentId} on the caller's yes`);
    else if (snap.raceLost?.proposalId === id) hold.stop("err", `${id} void — the time was taken before the yes reached the server`);
    else hold.stop("warn", `${id} released — nothing written`);
  }
  if (active && active.id !== view.holdFor) {
    view.holdFor = active.id;
    const ttl = active.holdTtlMs ?? scheduling.holdTtlMs;
    const left = Math.min(active.holdLeftMs ?? ttl, ttl);
    hold.start(
      left,
      (_, leftMs) =>
        leftMs > 0
          ? `${active.id} held until ${active.heldUntil} · ${mmss(leftMs)} left · nothing is written until the caller says yes`
          : `${active.id} hold expired — nothing written`,
      { tone: "accent" },
    );
  }
  if (terminal(snap) && hold.running) hold.stop("warn", "Call ended — nothing held");
}

// ----------------------------------------------------------------- budget

/** The call's time budget stops once the call is settled. */
function budgetStop(snap) {
  if (snap.booking) return (VERBS[snap.booking.kind] ?? "Booked").toLowerCase();
  if (snap.state === "escalating" || snap.state === "transferred") return "handed over";
  if (snap.state === "callback_filed") return "callback filed";
  if (snap.state === "waitlisted") return "waitlisted";
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
  const elapsedMs = Math.max(0, view.frozenMs ?? snap.elapsedMs + (performance.now() - view.syncedAt));
  renderBudget(els.budget, { elapsedMs, budgetMs: snap.budgetMs ?? scheduling.callTimeBudgetMs });
  const parts = els.budget.pkBudget;
  if (stop && parts && !els.budget.hidden) {
    parts.label.textContent += ` · ${stop}`;
    parts.fill.dataset.tone = stop === "ended" ? "muted" : "ok";
  }
}

// ----------------------------------------------------------- availability

async function refreshGrid() {
  const provider = gridProvider(view.snap);
  gridFor = provider;
  const seq = ++gridSeq;
  try {
    const data = await getJson(`/api/schedule/grid?provider=${encodeURIComponent(provider)}&days=5`);
    if (seq !== gridSeq) return;
    grid = data;
    renderGrid();
  } catch {
    // Keep the last good grid on screen.
  }
}

/** This call's marks over the schedule: what it booked, what was taken from it, what it holds and offers. */
function gridMarks(snap) {
  const here = (x) => x?.providerId === grid.providerId;
  const span = (start, minutes) => {
    const from = Date.parse(start);
    return [from, from + (minutes || grid.stepMinutes || 15) * 60_000];
  };
  const options = snap?.options ?? [];
  const active = activeProposal(snap);
  const minutes = active ? options.find((o) => o.start === active.start && here(o))?.durationMinutes : null;
  return {
    bookingId: snap?.booking && snap.booking.kind !== "cancel" ? snap.booking.appointmentId : null,
    takenId: view.taken?.appointmentId ?? null,
    hold: active?.start && here(active) ? span(active.start, minutes) : null,
    offers: terminal(snap) ? [] : options.filter((o) => !o.released && here(o)).map((o) => span(o.start, o.durationMinutes)),
  };
}

function markOf(cell, startMs, marks) {
  if (cell.ref && cell.ref === marks.bookingId) return "mine";
  if (cell.ref && cell.ref === marks.takenId) return "taken";
  if (marks.hold && startMs >= marks.hold[0] && startMs < marks.hold[1]) return "hold";
  if (marks.offers.some(([from, to]) => startMs >= from && startMs < to)) return "offer";
  return null;
}

function renderGrid() {
  if (!grid?.rows?.length) return;
  els.gridWho.textContent = [grid.providerName, grid.locationName].filter(Boolean).join(" · ");
  const marks = gridMarks(view.snap);
  const nowMs = Date.parse(grid.now);
  const perHour = Math.round(60 / (grid.stepMinutes || 15));
  const hours = [];
  for (let h = grid.startHour; h < grid.endHour; h += 1) {
    hours.push(`<span style="grid-column: span ${perHour}">${hourLabel(h)}</span>`);
  }
  const rows = grid.rows.map((row) => {
    const cells = row.cells.map((cell, i) => {
      const startMs = Date.parse(cell.start);
      // "past" covers both before now and inside the lead time; tell them apart.
      const state = cell.state === "past" && startMs >= nowMs ? "lead" : cell.state;
      const mark = markOf(cell, startMs, marks);
      const title = `${row.label}, ${time12(cell.time)} — ${mark ? MARK_WORDS[mark] : (STATE_WORDS[state] ?? state)}`;
      return `<span class="slot" data-state="${escapeHtml(state)}"${mark ? ` data-mark="${mark}"` : ""}${
        i > 0 && cell.time.endsWith(":00") ? ' data-hour="true"' : ""
      } title="${escapeHtml(title)}"></span>`;
    });
    return `<div class="slots-row"${row.today ? ' data-today="true"' : ""}><span class="slots-day" title="${escapeHtml(
      row.holiday ? `${row.label} — clinic holiday` : row.label,
    )}">${escapeHtml(row.label)}</span><div class="slots-cells">${cells.join("")}</div></div>`;
  });
  const legend = [
    ["free", null, "open"],
    ["booked", null, "booked"],
    ["held", null, "held"],
    ["free", "offer", "offered"],
    ["held", "hold", "held for this caller"],
    ["booked", "mine", "booked on this call"],
    ["booked", "taken", "taken mid-call"],
    ["lead", null, `${grid.minLeadMinutes ?? scheduling.minLeadMinutes}-minute lead time`],
    ["closed", null, "closed or past"],
    grid.rows.some((r) => r.holiday) ? ["holiday", null, "clinic holiday"] : null,
  ]
    .filter(Boolean)
    .map(
      ([state, mark, text]) =>
        `<span><i class="slot" data-state="${state}"${mark ? ` data-mark="${mark}"` : ""}></i>${escapeHtml(text)}</span>`,
    );
  const html = `<div class="slots-row slots-axis" aria-hidden="true"><span></span><div class="slots-cells">${hours.join(
    "",
  )}</div></div>${rows.join("")}<div class="slots-legend">${legend.join("")}</div>`;
  // Only touch the DOM when something changed, so the held cell's pulse keeps its rhythm.
  if (html === gridHtml) return;
  gridHtml = html;
  els.grid.style.setProperty("--cells", String(grid.rows[0].cells.length));
  els.grid.innerHTML = html;
}

function renderOptions() {
  const snap = view.snap;
  const booking = snap?.booking ?? null;
  els.options.hidden = Boolean(booking);
  els.optionsHead.hidden = Boolean(booking);
  if (booking) {
    renderBooking(booking);
    return;
  }
  els.booking.hidden = true;
  bookingSig = "";

  const active = activeProposal(snap);
  const items = [];
  if (snap?.raceLost) {
    items.push({
      label: snap.raceLost.label,
      meta: "booked elsewhere before the yes",
      status: `taken · ${snap.raceLost.proposalId ?? "void"}`,
      tone: "err",
    });
  }
  for (const o of snap?.options ?? []) {
    const held = Boolean(active && active.start === o.start && active.providerId === o.providerId);
    const taken = held && view.taken?.proposalId === active.id;
    items.push({
      label: o.label,
      meta: say(`${o.providerName} · ${o.locationName} · ${o.durationMinutes} min`, taken ? "· the front desk just booked it" : ""),
      status: held ? `held · ${active.id}` : o.released ? "released" : "offered",
      tone: taken ? "warn" : held ? "accent" : "muted",
      active: held,
    });
  }
  const empty = !snap
    ? "The times the agent offers show up here."
    : snap.blocked
      ? "No times offered — the visit isn't bookable by voice."
      : terminal(snap)
        ? "Nothing was offered on this call."
        : "Nothing offered yet.";
  renderList(els.options, items, { empty });
}

/** The confirmation: what the server wrote, and the yes that wrote it. */
function renderBooking(b) {
  const sig = JSON.stringify(b);
  if (sig === bookingSig && !els.booking.hidden) return;
  bookingSig = sig;
  const minutes = Math.round((Date.parse(b.end) - Date.parse(b.start)) / 60_000);
  els.booking.dataset.kind = b.kind ?? "book";
  els.booking.innerHTML = `
    <div class="booking-head"><strong>${escapeHtml(VERBS[b.kind] ?? "Booked")}</strong><span class="booking-id">${escapeHtml(
      b.appointmentId,
    )}</span></div>
    <p class="booking-when">${escapeHtml(b.label)}</p>
    <dl></dl>
    ${b.afterRace ? chip("after a race — fresh pick, fresh yes", "warn") : ""}`;
  renderFacts(els.booking.querySelector("dl"), [
    ["Visit", b.visitName ? `${b.visitName}${minutes > 0 ? ` · ${minutes} min` : ""}` : ""],
    ["With", b.providerName],
    ["Where", b.locationName],
    ["Confirmed by", `${b.proposalId} · ${b.consent ?? "said yes"}`],
    b.previousAppointmentId ? ["Replaces", b.previousAppointmentId] : null,
    b.prep ? ["Prep", b.prep] : null,
  ]);
  els.booking.hidden = false;
}

// ------------------------------------------------------------ Teams side

function renderHandoff() {
  const h = view.handoff;
  if (!h) return;
  const ctx = h.callContext ?? {};
  const callback = h.kind === "callback";
  const verified = Boolean(ctx.verified && ctx.verified !== "no");
  const callbackLine = ctx.callbackNumber
    ? `Call back on ${ctx.callbackNumber}${ctx.preferredTime ? ` · ${ctx.preferredTime}` : ""}`
    : "";
  const how = String(ctx.verified ?? "").replace(/^yes \((.*)\)$/, "$1");

  const callerHtml = verified
    ? `<strong>${escapeHtml(ctx.firstName ?? "Patient")}</strong>${
        callbackLine ? `<div class="muted">${escapeHtml(callbackLine)}</div>` : ""
      }<span class="verified">Verified: ${escapeHtml(how)}</span>`
    : `<strong>Caller not verified</strong><div class="muted">${escapeHtml(
        callbackLine || withheld(view.snap),
      )}</div><span class="unverified">Not verified — no patient details shared</span>`;

  const tags = [
    ctx.visitType ? { text: ctx.visitType, tone: "accent" } : null,
    ctx.department ? { text: ctx.department, tone: "teams" } : null,
    ctx.ruleId ? { text: ctx.ruleId, tone: "err" } : null,
    ctx.heldSlot ? { text: `held: ${ctx.heldSlot}`, tone: "warn" } : null,
    ctx.safety ? { text: ctx.safety, tone: "err" } : null,
    h.afterHours ? { text: "after hours", tone: "warn" } : null,
    callback ? { text: "callback", tone: "teams" } : null,
  ].filter(Boolean);

  renderTeamsToast(els.toast, {
    queue: h.label ?? "Scheduling team",
    subtitle: callback ? "Callback request · filed by the scheduling agent" : "Call queue · handed over by the scheduling agent",
    topic: h.callTopic,
    context: sameWords(ctx.summary, h.callTopic) ? "" : ctx.summary,
    callerHtml,
    avatar: h.label,
    tags,
    status: callback ? "Callback request" : "Incoming call",
  });
  els.toastEmpty.hidden = true;
  // Built on the server by the same function the real transfer uses.
  const headers = (h.voipHeaders ?? []).map((x) => [x.key, x.value]);
  renderHeaders(els.headers, headers);
  els.wire.hidden = !headers.length;
}

/** A one-line call's summary can be the topic again, in other punctuation. Say it once. */
function sameWords(summary, topic) {
  const plain = (s) =>
    String(s ?? "")
      .replace(/^caller said:\s*/i, "")
      .replace(/[“”"…,.!?·\s]+/g, " ")
      .trim()
      .toLowerCase();
  return Boolean(summary) && plain(summary) === plain(topic);
}

function renderToastPlaceholder() {
  if (view.handoff) return;
  const snap = view.snap;
  els.toastEmpty.textContent = !snap
    ? "No call has been handed over yet."
    : snap.state === "escalating"
      ? `Connecting to ${destName(snap.destination)} — their Teams client rings when the transfer lands.`
      : snap.booking
        ? "No handoff needed — handled by voice, start to finish."
        : String(snap.outcome ?? "").startsWith("advised:")
          ? `No handoff — ${snap.destination?.label ?? "the team"} is closed, so the caller was told who to call.`
          : terminal(snap)
            ? "The call ended without a handoff."
            : "No call has been handed over yet.";
}

// ---------------------------------------------------------------- metrics

function renderStats(stats) {
  if (!stats) return;
  renderMetrics(els.metrics, [
    ["Calls", stats.calls],
    ["Booked", stats.booked],
    ["Refused writes", stats.refusedWrites],
    ["Races resolved", stats.racesResolved],
    ["Handoffs to a person", stats.handoffs],
    ["Eligibility blocks", stats.eligibilityBlocks],
    ["Identity not confirmed", stats.identityNotConfirmed],
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
  const deadline = performance.now() + scheduling.transferDelayMs + 3000;
  while (!session.finished && performance.now() < deadline) await sleep(100);
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
  for (const key of Object.keys(scheduling)) {
    const value = health.scheduling?.[key];
    if (typeof value === "number") scheduling[key] = value;
  }
  if (stack) stack.setLive(live);
  else stack = mountStack($("stack"), { live, nodes: stackNodes() });
  render();
}

/** After a hub reconnect: catch up on anything missed while it was down. */
async function refreshAll() {
  await Promise.all([loadHealth(), clock.refresh(), refreshGrid(), refreshStats()]);
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
  els.wire.hidden = true;
  hold.hide();
  if (gridFor !== gridProvider(null)) refreshGrid();
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
els.takeSlot.addEventListener("click", () => act(() => takeSlot()));
els.modelBook.addEventListener("click", () => act(() => modelBook()));

els.reset.addEventListener("click", async () => {
  director.stop();
  try {
    if (!(await resetDemo())) return;
    director.load(0);
    notify("Demo reset — seeded schedule, clean audit, starting clock, beat 1.", "ok");
  } catch (error) {
    notify(error.message, "err");
  }
});
