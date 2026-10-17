/**
 * The IT help desk console.
 *
 * A viewer: the server's reset state machine (src/flow.mjs) decides
 * everything — the identity check, the one-time code and its expiry, the
 * password policy, the refusals and the handoff — and this page shows its
 * state, its audit trail and its handoff as they happen. On a simulated
 * callback the console also plays the employee: their phone on the left (what
 * they say, the keypad, a noisy line, hanging up) and their browser in the
 * middle (a mock of the reset page, driven by the same server state as the
 * call), so the room sees the call and the page move together.
 *
 * The presenter kit (presenter-kit.js, vendored) does the generic work: the
 * hub connection, the call session, the simulate routes, the director, the
 * room voice and the panels. The demo script is beats.js.
 */
import {
  $,
  clearTeamsToast,
  connectHub,
  createCallSession,
  createDirector,
  createSimulator,
  createTrail,
  createTranscript,
  createVoice,
  escapeHtml,
  flash,
  getJson,
  mountClock,
  mountStack,
  notify,
  postJson,
  renderChecks,
  renderDecision,
  renderFacts,
  renderHeaders,
  renderMetrics,
  renderMode,
  renderTeamsToast,
  setStateChip,
  sleep,
  voiceStack,
} from "/presenter-kit.js";
import { createBeats } from "/beats.js";

// ---------------------------------------------------------------- constants

/** The fictional employees in the fixtures (src/store.mjs). */
const EMPLOYEES = [
  ["alex.morgan", "Alex Morgan (locked out)"],
  ["jordan.patel", "Jordan Patel"],
];

/** The rules in the order the assistant reads them, keyed by the server's failure strings (src/store.mjs). */
const POLICY_RULES = [
  ["At least 12 characters", "It needs to be at least 12 characters long."],
  ["An uppercase letter", "It needs at least one capital letter."],
  ["A lowercase letter", "It needs at least one lowercase letter."],
  ["A number", "It needs at least one number."],
  ["A symbol", "It needs at least one symbol."],
  ["Not a common password", "That password is on the commonly-used blocklist."],
  ["Not your username", "It can't contain your username."],
  ["Not your name", "It can't contain part of your name."],
];

/** Where a dropped call can pick up again: "Call me again" on the reset page. */
const RESUMABLE = new Set(["calling", "verify_identity", "voice_code", "choose_password"]);
const FINISHED_STATES = new Set(["completed", "verification_failed", "escalated"]);

const STATE_CHIPS = {
  calling: ["calling", "accent"],
  verify_identity: ["verifying", "warn"],
  voice_code: ["one-time code", "accent"],
  choose_password: ["new password", "accent"],
  completed: ["reset complete", "ok"],
  verification_failed: ["not verified", "err"],
  escalated: ["to the service desk", "teams"],
};

/** Handoff reasons (src/handoff.mjs), in the words the service desk reads. */
const REASONS = {
  identity_failed: "Identity not verified",
  other_account_request: "Asked to reset another employee's password",
  pressure_to_skip_verification: "Pressed to skip verification",
  caller_requested_person: "Asked for a person",
  did_not_request: "Says they didn't ask for this reset",
  mfa_locked_out: "Also locked out of MFA",
  too_many_codes: "One-time code not accepted",
  user_requested: "Asked for help on the reset page",
};

const REFUSALS = {
  skip_verification: "skipping verification",
  other_account: "another employee's account",
};

const els = {
  mode: $("mode"),
  reset: $("reset"),
  stateChip: $("stateChip"),
  employeeSelect: $("employeeSelect"),
  newCall: $("newCall"),
  handset: $("handset"),
  handsetWho: $("handsetWho"),
  handsetCode: $("handsetCode"),
  handsetWhen: $("handsetWhen"),
  transcript: $("transcript"),
  sayForm: $("sayForm"),
  sayInput: $("sayInput"),
  sayBtn: $("sayBtn"),
  keys: $("keys"),
  keyed: $("keyed"),
  silence: $("silence"),
  hangup: $("hangup"),
  portalLink: $("portalLink"),
  portalSteps: $("portalSteps"),
  portalStatus: $("portalStatus"),
  portalSpinner: $("portalSpinner"),
  portalLabel: $("portalLabel"),
  portalHint: $("portalHint"),
  paneSignin: $("paneSignin"),
  portalUser: $("portalUser"),
  forgot: $("forgot"),
  paneCode: $("paneCode"),
  portalCode: $("portalCode"),
  portalCodeBtn: $("portalCodeBtn"),
  codeNote: $("codeNote"),
  panePassword: $("panePassword"),
  portalPassword: $("portalPassword"),
  portalSave: $("portalSave"),
  policy: $("policy"),
  paneResult: $("paneResult"),
  resultIcon: $("resultIcon"),
  resultText: $("resultText"),
  paneRecall: $("paneRecall"),
  recall: $("recall"),
  decision: $("decision"),
  facts: $("facts"),
  toast: $("toast"),
  toastEmpty: $("toastEmpty"),
  headers: $("headers"),
  events: $("events"),
  metrics: $("metrics"),
};

const RESET_TITLE = els.reset.title;

/** Everything the panels show about the current call. */
const blankView = () => ({
  snap: null, // the server's snapshot (src/flow.mjs)
  handset: null, // what the employee's phone heard: { code, readAt, expiresAt } (simulation only)
  handoff: null, // the handoff frame, once the call goes to the service desk
  keyed: 0, // keypad digits pressed on the identity step (never their values)
  keypadTurn: false, // the identity answer came from the keypad
  policy: null, // the server's verdict on the password being typed: { ok, failures }
  portalNote: null, // what the reset page says after a code was turned down
  checkedAt: 0,
});

let view = blankView();
let speech = Promise.resolve();
let clockSync = null;
let checking = null;
let recheck = false;
let health = null;
let stack = null;
let clockLocked = false;
let sending = false;

// ------------------------------------------------------------------ helpers

const humanReason = (reason) => REASONS[reason] ?? String(reason ?? "").replace(/_/g, " ");
const spaced = (digits) => String(digits ?? "").split("").join(", ");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const demoNow = () => (clockSync ? clockSync.now + (performance.now() - clockSync.at) : Date.now());

/** A time of day on the demo clock, in the zone the policy runs in. */
function fmtTime(value) {
  if (value == null) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const options = { hour: "numeric", minute: "2-digit" };
  try {
    return date.toLocaleTimeString("en-US", { ...options, timeZone: clock.state?.timeZone || undefined });
  } catch {
    return date.toLocaleTimeString("en-US", options);
  }
}

function setTone(el, tone) {
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function chipFor(snap) {
  if (!snap) return ["", "idle"];
  if (snap.escalation?.transferFailed) return ["transfer didn't go through", "warn"];
  if (snap.callEnded) {
    if (snap.endReason === "transferred" || snap.state === "escalated") return ["with the service desk", "teams"];
    if (snap.state === "completed") return ["reset complete", "ok"];
    if (snap.state === "verification_failed") return ["not verified", "err"];
    if (snap.endReason === "hung_up") return ["hung up", "muted"];
    return ["call ended", "muted"];
  }
  return STATE_CHIPS[snap.state] ?? [snap.state, "muted"];
}

const stackNodes = () =>
  voiceStack({
    caller: "Employee",
    callerLive: "employee's phone",
    callerSim: "played in this console",
    voiceLive: health?.voiceModel ?? "gpt-realtime",
    tools: "Reset policy",
    toolsSim: "real policy code",
    agent: "IT service desk",
    agentLive: "context in VoIP headers",
    agentSim: "mock toast",
  });

// ------------------------------------------------------------------- wiring

const voice = createVoice($("voice"), { lang: "en-US" });

const clock = mountClock($("clock"), {
  onChange: (state) => {
    clockSync = { now: state.now, at: performance.now() };
    render();
  },
});

const transcript = createTranscript(els.transcript, {
  labels: { agent: "IT assistant" },
  empty: "Place a callback, or press Next ▶ to run the demo script.",
});

const trail = createTrail(els.events, {
  good: ["reset_completed", "code_verified", "identity_verified", "kb_answer"],
  bad: ["verification_failed", "code_expired", "refused", "tool_rejected", "call_failed", "transfer_failed"],
  warn: [
    "password_rejected",
    "code_rejected",
    "code_cancelled",
    "identity_retry",
    "identity_clarify",
    "handoff",
    "human_requested",
    "kb_miss",
    "silence",
    "keypad_ignored",
  ],
  empty: "Every check, refusal and handoff shows up here.",
  timeZone: () => clock.state?.timeZone,
});

const session = createCallSession({
  onMessage,
  // A real call arriving while the console is idle: follow it, read-only.
  onFollow: (id) => {
    clearPanels();
    getJson(`/api/calls/${encodeURIComponent(id)}`)
      .then(applySnapshot)
      .catch(() => {});
  },
  voice,
  stateTargets: ["state"],
  // "completed" still has a live call (questions after the reset), so a call
  // is finished only once the server says the line is down.
  stateOf: (snap) => (snap?.callEnded ? (snap.endReason ?? "ended") : snap?.state),
  isFinished: (state) => /^(ended|transferred|hung_up)$/.test(String(state ?? "")),
});

connectHub((target, payload) => session.handle(target, payload), {
  onOpen: ({ reconnected }) => {
    if (reconnected) refreshAll();
  },
});

const sim = createSimulator({
  session,
  startBody,
  onSnapshot: applySnapshot,
  actions: {
    portalCode,
    portalPassword,
    clock: (step) => setClock(step.preset),
    metrics: showMetrics,
  },
});

const director = createDirector($("director"), {
  beats: createBeats({ setClock }),
  perform,
  voice,
  sayInput: els.sayInput,
  onBeat: () => window.scrollTo({ top: 0, behavior: "smooth" }),
});

// The handset shows "expired" as soon as the demo clock passes the code's expiry.
setInterval(renderHandset, 5000);

boot();

async function boot() {
  els.employeeSelect.innerHTML = EMPLOYEES.map(
    ([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`,
  ).join("");
  els.keys.innerHTML = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]
    .map((digit) => `<button type="button" data-digit="${digit}" disabled>${digit}</button>`)
    .join("");
  els.portalUser.value = els.employeeSelect.value;
  renderHeaders(els.headers, []);
  renderPolicy();
  render();
  await Promise.all([loadHealth(), refreshStats()]);
  render();
}

// ---------------------------------------------------------- director steps

function startBody(step = {}) {
  return { username: step.username ?? els.employeeSelect.value };
}

/** One step on the employee's side: their phone, or (actions) their browser. */
async function perform(step) {
  if (step.type === "start") {
    if (session.id && !session.finished && !session.followed) await sim.hangup().catch(() => {});
    session.reset();
    clearPanels();
    const username = step.username ?? els.employeeSelect.value;
    els.employeeSelect.value = username;
    els.portalUser.value = username;
    // The employee clicks "Forgot password?" on the sign-in page.
    flash(els.forgot);
    await sleep(450);
  } else if (step.type === "dtmf") {
    if (view.snap?.state === "verify_identity" && !view.snap.callEnded) {
      view.keyed = Math.min(4, view.keyed + 1);
      renderKeyed();
    }
    flash(els.keys.querySelector(`[data-digit="${step.digit}"]`));
  }
  const result = applyResult(await sim.perform(step));
  if (step.type === "dtmf") await sleep(200);
  return result;
}

/** Simulate routes answer with the snapshot and what the phone heard. */
function applyResult(result) {
  if (!result || typeof result !== "object") return result;
  if (result.snapshot) applySnapshot(result.snapshot);
  if ("handset" in result && result.snapshot?.callId && result.snapshot.callId === session.id) {
    const onCode = view.snap?.state === "voice_code" && !view.snap.callEnded;
    view.handset = onCode ? (result.handset ?? null) : null;
    renderHandset();
  }
  return result;
}

async function setClock(preset) {
  try {
    await clock.set({ preset });
  } catch (error) {
    if (error?.status !== 403) throw error;
    if (!clockLocked) notify("This server answers real calls, so the demo clock stays on real time.", "warn", 6000);
    clockLocked = true;
  }
}

async function showMetrics() {
  for (let i = 0; i < 30 && !session.finished; i += 1) await sleep(100);
  await refreshStats({ highlight: true });
  els.metrics.scrollIntoView({ behavior: "smooth", block: "end" });
}

// --------------------------------------------------------------- hub frames

function onMessage(target, payload) {
  stack?.onHub(target, payload);
  switch (target) {
    case "state":
      applySnapshot(payload);
      break;
    case "transcript":
      onTranscript(payload);
      break;
    case "event":
      onEvent(payload);
      break;
    case "policy":
      // The real reset page, typing in another tab. The console's own checks answer directly.
      if (payload?.callId === session.id && performance.now() - view.checkedAt > 1500) {
        view.policy = { ok: Boolean(payload.ok), failures: payload.failures ?? [] };
        renderPolicy();
      }
      break;
    case "handoff":
      view.handoff = payload;
      renderHandoff();
      break;
    case "stats":
      if (renderStats(payload)) flash(els.metrics);
      break;
    default:
      break;
  }
}

function onTranscript(line) {
  if (!line?.text) return;
  if (line.role === "caller") {
    view.keyed = 0;
    view.keypadTurn = /on the keypad\.$/i.test(line.text);
    transcript.add("caller", line.text, { label: view.snap?.user?.firstName ?? "Employee" });
    renderKeyed();
  } else if (line.role === "agent") {
    transcript.add("agent", line.text);
    speakAgent(line.text);
  } else {
    transcript.system(line.text);
  }
}

/**
 * The transcript never holds the one-time code: the server writes "[code
 * withheld]". The room should still hear what the employee's phone heard, so
 * on a simulated call the voice reads the code from the handset instead.
 */
function speakAgent(text) {
  const id = session.id;
  speech = speech
    .then(async () => {
      let spoken = text;
      if (spoken.includes("[code withheld]") && id && view.snap?.callId === id && view.snap.simulated) {
        const handset = await fetchHandset(id);
        if (handset?.code) spoken = spoken.replaceAll("[code withheld]", spaced(handset.code));
      }
      spoken = spoken.replace(/\s*\[[^\]]*withheld\]/g, "").trim();
      if (spoken) voice.speak("agent", spoken);
    })
    .catch(() => {});
}

async function fetchHandset(id) {
  try {
    const { handset } = await getJson(`/api/simulate/${encodeURIComponent(id)}/handset`);
    if (session.id === id && view.snap?.state === "voice_code" && !view.snap.callEnded) {
      view.handset = handset ?? null;
      renderHandset();
    }
    return handset ?? null;
  } catch {
    return null;
  }
}

function onEvent(event) {
  if (!event?.kind) return;
  trail.add(event.kind === "handoff" ? { ...event, detail: humanReason(event.detail) } : event);
  narrate(event);
}

/** The audit events worth a line in the transcript: tool calls, the reset page, the line. */
function narrate({ kind, detail }) {
  const snap = view.snap;
  const first = snap?.user?.firstName ?? "The employee";
  const idTool = view.keypadTurn ? "keypad" : "confirm_identity";
  const text = detail ?? "";
  switch (kind) {
    case "ticket_created":
      if (text && text !== "no ticket") transcript.system(`🎫 Ticket ${text} opened for the reset`);
      break;
    case "callback_simulated":
    case "callback_placed":
      transcript.system(
        `📞 Calling ${first} back on ${snap?.phone ?? "the number on file"} through Teams Phone extensibility${
          kind === "callback_simulated" ? " (simulated)" : ""
        }`,
      );
      break;
    case "call_answered":
      transcript.system(`${first} picks up.`);
      break;
    case "identity_verified":
      transcript.tool(idTool, "matched the directory", "ok");
      break;
    case "identity_retry": {
      const miss = /miss (\d+) of (\d+)/.exec(text);
      transcript.tool(idTool, miss ? `no match · miss ${miss[1]} of ${miss[2]}` : "no match", "warn");
      break;
    }
    case "identity_clarify":
      transcript.tool(idTool, "fewer than four digits heard · not counted", "warn");
      break;
    case "verification_failed":
      transcript.tool(idTool, "no match twice · verification closed", "err");
      break;
    case "code_issued":
    case "code_repeated":
      transcript.tool("issue_verification_code", text, "accent");
      break;
    case "code_verified":
      transcript.system("🖥 Reset page: the code matched.");
      break;
    case "code_rejected":
      transcript.system(`🖥 Reset page: wrong code (${text}).`);
      break;
    case "code_cancelled":
      transcript.system(`🖥 Reset page: ${text || "too many wrong entries"}, so the code is cancelled.`);
      break;
    case "code_expired":
      transcript.system(`🖥 Reset page: that code had expired (${text}).`);
      break;
    case "password_rejected":
      transcript.system("🖥 Reset page: the password policy turned that one down.");
      break;
    case "reset_completed":
      transcript.system(`🖥 Reset page: password updated${text ? ` · ${text}` : ""}.`);
      break;
    case "refused":
      transcript.tool("refuse_request", text, "err");
      break;
    case "human_requested":
      transcript.tool("request_human", "to the IT service desk, with the context", "teams");
      break;
    case "kb_answer":
      transcript.tool("answer_question", text ? `matched “${text}”` : "matched an approved answer", "ok");
      break;
    case "kb_miss":
      transcript.tool("answer_question", "no approved answer", "warn");
      break;
    case "tool_rejected": {
      const [name, ...rest] = text.split(": ");
      transcript.tool(name || "tool", rest.join(": ") || "turned down by the server", "err");
      break;
    }
    case "silence":
      transcript.system("— nothing heard —");
      break;
    case "handoff_simulated":
      transcript.system("↪ Handed to the IT service desk in Teams (simulated — nobody was called)");
      break;
    case "transfer_requested":
      transcript.system("↪ Transferring to the IT service desk in Teams…");
      break;
    case "transfer_skipped":
      transcript.system(`↪ ${text}`);
      break;
    case "transfer_failed":
      transcript.system(`⚠ The transfer didn't complete: ${text}`);
      break;
    case "call_ended":
      if (text === "transferred") {
        if (!snap?.simulated) transcript.system("☎ Transferred to the IT service desk.");
      } else if (/hung up/.test(text)) {
        transcript.system(`☎ ${first} hung up.`);
      } else {
        transcript.system("☎ Call ended.");
      }
      break;
    case "call_failed":
      transcript.system(`⚠ ${text || "The call could not be placed."}`);
      break;
    default:
      break;
  }
}

function applySnapshot(snap) {
  if (!snap?.callId) return;
  if (session.id && snap.callId !== session.id) return;
  const prev = view.snap;
  const same = prev?.callId === snap.callId;
  // Snapshots carry a sequence number; a late one never rolls the panels back.
  if (same && (snap.seq ?? 0) < (prev.seq ?? 0)) return;
  if (!same || prev.state !== snap.state) {
    view.keyed = 0;
    view.portalNote = null;
    view.policy = null;
  }
  view.snap = snap;
  if (snap.state !== "voice_code" || snap.callEnded) view.handset = null;
  render();
}

// ------------------------------------------------------------------- render

function render() {
  const [text, tone] = chipFor(view.snap);
  setStateChip(els.stateChip, text, tone);
  renderControls();
  renderDecisionCard();
  renderFactsCard();
  renderPortal();
  renderKeyed();
  renderHandset();
  if (!view.handoff) els.toastEmpty.textContent = toastPlaceholder(view.snap);
}

/** The console can play the employee only on its own simulated call, while the line is up. */
function callActive() {
  const snap = view.snap;
  return Boolean(session.id && !session.finished && snap && !snap.callEnded && (!session.followed || snap.simulated));
}

function renderControls() {
  const active = callActive();
  const portal = active && Boolean(view.snap?.simulated);
  els.sayInput.disabled = !active;
  els.sayBtn.disabled = !active || sending;
  els.silence.disabled = !active;
  els.hangup.disabled = !active;
  for (const key of els.keys.querySelectorAll("button")) key.disabled = !active;
  for (const el of [els.portalCode, els.portalCodeBtn, els.portalPassword, els.portalSave]) el.disabled = !portal;
}

function renderKeyed() {
  const show = view.keyed > 0 && view.snap?.state === "verify_identity" && !view.snap.callEnded;
  els.keyed.hidden = !show;
  if (show) els.keyed.textContent = `${"●".repeat(view.keyed)}${"○".repeat(4 - view.keyed)} ${view.keyed} of 4`;
}

/** What the employee's phone heard. Only the console's own simulated call has one. */
function renderHandset() {
  const handset = view.handset;
  els.handset.hidden = !handset;
  if (!handset) return;
  const first = view.snap?.user?.firstName;
  els.handsetWho.textContent = first ? `On ${first}'s phone` : "On the phone";
  els.handsetCode.textContent = String(handset.code ?? "").split("").join(" ");
  const expired = demoNow() > Date.parse(handset.expiresAt);
  els.handset.dataset.expired = String(expired);
  els.handsetWhen.textContent = `read ${fmtTime(handset.readAt)} · ${expired ? "expired" : "expires"} ${fmtTime(handset.expiresAt)}`;
}

/** The mock reset page: the same server state the call runs on. */
function renderPortal() {
  const snap = view.snap;
  const finished = Boolean(snap && FINISHED_STATES.has(snap.state));
  const resumable = Boolean(snap?.callEnded && RESUMABLE.has(snap.state));
  const live = Boolean(snap && !snap.callEnded && !finished);

  // The three steps the page walks through.
  const done = snap ? [snap.verified, snap.codeVerified, snap.outcome === "reset_completed"] : [false, false, false];
  const open = done.indexOf(false);
  const stopped = Boolean(snap && (snap.state === "verification_failed" || snap.state === "escalated"));
  for (const li of els.portalSteps.querySelectorAll("li[data-step]")) {
    const i = Number(li.dataset.step) - 1;
    const state = done[i] ? "done" : i === open ? (stopped ? "stopped" : live ? "current" : "") : "";
    if (state) li.dataset.state = state;
    else delete li.dataset.state;
  }

  // The status line above the form.
  let label = "";
  let hint = "";
  if (!snap) {
    label = "Sign in to Contoso";
    hint = "Locked out, or forgot it? “Forgot password?” asks the IT help desk to call you back.";
  } else if (resumable) {
    label = "The call ended";
  } else if (live) {
    label = snap.label;
    hint = snap.hint;
  }
  els.portalStatus.hidden = !label;
  els.portalLabel.textContent = label;
  els.portalHint.textContent = hint;
  els.portalHint.hidden = !hint;
  els.portalSpinner.hidden = !(live && (snap.state === "calling" || snap.state === "verify_identity"));

  // One pane at a time.
  const pane = !snap
    ? "signin"
    : resumable
      ? "recall"
      : finished
        ? "result"
        : live && snap.ui === "code"
          ? "code"
          : live && snap.ui === "password"
            ? "password"
            : null;
  els.paneSignin.hidden = pane !== "signin";
  els.paneCode.hidden = pane !== "code";
  els.panePassword.hidden = pane !== "password";
  els.paneResult.hidden = pane !== "result";
  els.paneRecall.hidden = pane !== "recall";

  if (!snap) els.portalUser.value = els.employeeSelect.value;
  if (pane !== "code") els.portalCode.value = "";
  if (pane !== "password") els.portalPassword.value = "";

  if (pane === "code") {
    const expires = snap.code?.issued && snap.code.expiresAt ? ` Expires ${fmtTime(snap.code.expiresAt)}.` : "";
    els.codeNote.textContent = view.portalNote ?? `Listen for the code on the call — it is never sent to this page.${expires}`;
    setTone(els.codeNote, view.portalNote ? "warn" : null);
  }
  if (pane === "password") renderPolicy();
  if (pane === "result") {
    const [icon, tone] =
      snap.state === "completed" ? ["✓", "ok"] : snap.state === "verification_failed" ? ["✕", "err"] : ["↪", "teams"];
    els.resultIcon.textContent = icon;
    setTone(els.paneResult, tone);
    els.resultText.innerHTML = `<strong>${escapeHtml(snap.label)}</strong>${escapeHtml(snap.hint ?? "")}`;
  }

  els.portalLink.href = snap ? `/portal.html?session=${encodeURIComponent(snap.callId)}` : "/portal.html";
}

/** The password rules, ticked off by the server as the employee types. */
function renderPolicy() {
  const policy = view.policy;
  renderChecks(
    els.policy,
    POLICY_RULES.map(([label, failure]) => ({
      label,
      tone: !policy ? "idle" : policy.failures.includes(failure) ? "err" : "ok",
    })),
  );
}

function renderDecisionCard() {
  const snap = view.snap;
  if (!snap) {
    renderDecision(els.decision, { empty: "Place a callback to see what the server decides." });
    return;
  }
  if (snap.callEnded && RESUMABLE.has(snap.state)) {
    renderDecision(els.decision, {
      headline: "The call dropped",
      why: "Nothing is lost: the reset page can ask for the call again, and the reset picks up where it left off.",
      verdict: "resumable",
      tone: "warn",
    });
    return;
  }
  if (snap.decision?.headline) {
    renderDecision(els.decision, snap.decision);
    return;
  }
  const first = snap.user?.firstName ?? "the employee";
  if (snap.state === "calling") {
    renderDecision(els.decision, {
      headline: `Calling ${first} back`,
      why: `To the number on file in the directory (${snap.phone ?? "masked"}), through Teams Phone extensibility — never a number typed on the page.`,
      verdict: "callback",
      tone: "accent",
    });
  } else if (snap.state === "verify_identity") {
    renderDecision(els.decision, {
      headline: "Waiting for the employee ID digits",
      why: "The agent asks for the last four digits; the server compares them with the directory. The model never sees the employee ID.",
      verdict: "verifying",
      tone: "accent",
    });
  } else {
    renderDecision(els.decision, { empty: "Nothing decided yet." });
  }
}

function renderFactsCard() {
  const snap = view.snap;
  if (!snap) {
    renderFacts(els.facts, [
      ["Employee", ""],
      ["Callback", ""],
      ["Ticket", ""],
      ["Identity", ""],
      ["One-time code", ""],
    ]);
    return;
  }
  const user = snap.user ?? {};
  const reset = snap.outcome === "reset_completed";
  const lock = user.locked ? (reset ? "unlocked by the reset" : "locked out") : "";
  const code = snap.code ?? {};
  const max = snap.maxAttempts ?? 2;

  const identity = snap.verified
    ? ["Verified · the last four digits matched", "ok"]
    : snap.state === "verification_failed"
      ? [`Not verified · ${snap.attempts} of ${max} missed`, "err"]
      : snap.attempts
        ? [`${snap.attempts} of ${max} missed · asking again`, "warn"]
        : snap.state === "calling"
          ? ["", null]
          : ["Waiting for the last four digits", null];

  const expiredNote = code.expired ? ` · ${code.expired} expired` : "";
  const oneTime = snap.codeVerified
    ? ["Typed on the reset page and matched", "ok"]
    : code.issued
      ? [`${plural(code.codesIssued, "code")} read aloud${expiredNote} · expires ${fmtTime(code.expiresAt)}`, "accent"]
      : code.codesIssued
        ? [`${plural(code.codesIssued, "code")} read aloud${expiredNote}`, "warn"]
        : ["", null];

  const ticket = !snap.ticketId
    ? ""
    : reset
      ? `${snap.ticketId} · closed by the reset`
      : String(snap.outcome ?? "").startsWith("escalated:")
        ? `${snap.ticketId} · handed to the service desk`
        : String(snap.outcome ?? "").startsWith("transfer_failed:")
          ? `${snap.ticketId} · the service desk follows up`
          : `${snap.ticketId} · open`;

  renderFacts(els.facts, [
    ["Employee", [user.displayName, user.department, lock].filter(Boolean).join(" · "), { tone: lock ? (reset ? "ok" : "warn") : null }],
    ["Callback", [snap.phone, snap.via].filter(Boolean).join(" · ")],
    ["Ticket", ticket, { tone: reset ? "ok" : null }],
    ["Identity", identity[0], { tone: identity[1] }],
    ["One-time code", oneTime[0], { tone: oneTime[1] }],
    snap.refusals?.length > 0 && ["Refused", snap.refusals.map((r) => REFUSALS[r] ?? r).join(" · "), { tone: "err" }],
    snap.answers > 0 && ["Knowledge answers", `${snap.answers} from the approved knowledge base`, { tone: "ok" }],
    snap.outcome && snap.outcome !== "incomplete" && ["Outcome", outcomeText(snap.outcome), { tone: outcomeTone(snap.outcome) }],
  ]);
}

function outcomeText(outcome) {
  if (outcome === "reset_completed") return "Password reset, account unlocked, ticket closed";
  if (outcome === "verification_failed") return "Not verified; nothing on the account changed";
  if (outcome.startsWith("escalated:")) return `Handed to the IT service desk: ${humanReason(outcome.slice(10)).toLowerCase()}`;
  if (outcome.startsWith("transfer_failed:"))
    return `The transfer didn't go through, so the service desk follows up: ${humanReason(outcome.slice(16)).toLowerCase()}`;
  return outcome.replace(/_/g, " ");
}

function outcomeTone(outcome) {
  if (outcome === "reset_completed") return "ok";
  if (outcome === "verification_failed") return "err";
  if (outcome.startsWith("transfer_failed:")) return "warn";
  return outcome.startsWith("escalated:") ? "teams" : null;
}

function toastPlaceholder(snap) {
  if (!snap) return "No call has been handed over yet.";
  if (snap.state === "escalated") return "Handing the call to the IT service desk…";
  return "Not handed over. A failed verification, a refused request or a request for a person sends the call to the IT service desk, with the context.";
}

// ------------------------------------------------------------------ handoff

/** The Teams toast the service desk sees, built from the real handoff context. */
function renderHandoff() {
  const handoff = view.handoff;
  if (!handoff) {
    clearTeamsToast(els.toast, els.toastEmpty);
    renderHeaders(els.headers, []);
    return;
  }
  els.toastEmpty.hidden = true;
  const caller = handoff.caller ?? {};
  const callerHtml = `<strong>${escapeHtml(caller.name ?? "Unknown caller")}</strong>${
    caller.department ? ` · ${escapeHtml(caller.department)}` : ""
  } <span class="muted">${escapeHtml(caller.username ?? "")}</span>${
    caller.verified
      ? '<span class="verified">✓ Verified on this call</span>'
      : '<span class="unverified">Not verified on this call</span>'
  }`;
  const topic = handoff.topic ?? `Password reset: ${humanReason(handoff.reason).toLowerCase()}`;
  renderTeamsToast(els.toast, {
    queue: "Contoso IT service desk",
    subtitle: "Teams call queue · handed over by the reset assistant",
    topic,
    context: sameWords(handoff.context, topic) ? "" : handoff.context,
    sentiment: handoff.sentiment ? `Caller sounds ${String(handoff.sentiment).toLowerCase()}` : "",
    callerHtml,
    avatar: "IT",
    // The topic already names the reason, and the caller card says whether they were verified.
    tags: [
      handoff.ticketId && { text: handoff.ticketId, tone: "teams" },
      handoff.risk && { text: "risk flagged", tone: "err" },
    ].filter(Boolean),
    status: handoff.simulated ? "Incoming call · simulated" : "Incoming call",
  });
  renderHeaders(
    els.headers,
    (handoff.voipHeaders ?? []).map((header) => [header.key, header.value]),
  );
  els.toast.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** A one-line summary can be the topic again. Say it once. */
function sameWords(summary, topic) {
  const plain = (s) =>
    String(s ?? "")
      .replace(/^caller said:\s*/i, "")
      .replace(/[“”"…,.:!?\s]+/g, " ")
      .trim()
      .toLowerCase();
  return Boolean(summary) && plain(summary) === plain(topic);
}

// -------------------------------------------------------------------- stats

async function refreshStats({ highlight = false } = {}) {
  try {
    renderStats(await getJson("/api/stats"));
    if (highlight) flash(els.metrics);
  } catch {
    // The footer keeps its last numbers.
  }
}

let shownStats = null;

/** Draws the footer and says whether any number changed, so a repeated push doesn't flash. */
function renderStats(stats = {}) {
  const rows = [
    ["Callbacks", stats?.callbacks ?? 0],
    ["Verified", stats?.verified ?? 0],
    ["Resets completed", stats?.resetsCompleted ?? 0],
    ["Refused", stats?.refused ?? 0],
    ["Handed off", stats?.handedOff ?? 0],
    ["Knowledge answers", stats?.kbAnswers ?? 0],
    ["Median seconds to reset", stats?.medianSecondsToReset ?? "—"],
  ];
  renderMetrics(els.metrics, rows);
  const key = JSON.stringify(rows);
  const changed = key !== shownStats;
  shownStats = key;
  return changed;
}

// ------------------------------------------------------------ health, reset

async function loadHealth() {
  try {
    health = await getJson("/health");
  } catch {
    health = null;
  }
  const acsNumber = health?.telephonyMode === "acs-direct";
  const live = renderMode(els.mode, health, { liveLabel: acsNumber ? "live · ACS number" : "live · Teams Phone" });
  if (live && acsNumber) els.mode.title = "Answering real calls on an Azure Communication Services number (TELEPHONY_MODE=acs-direct).";
  els.reset.disabled = live;
  els.reset.title = live ? "Demo controls are off while this server answers real calls." : RESET_TITLE;
  if (stack) stack.setLive(live);
  else stack = mountStack($("stack"), { live, nodes: stackNodes() });
  return live;
}

/** After the hub reconnects: catch up on whatever happened while it was down. */
async function refreshAll() {
  await Promise.all([loadHealth(), clock.refresh(), refreshStats()]);
  const id = session.id;
  if (!id) return;
  try {
    applySnapshot(await getJson(`/api/calls/${encodeURIComponent(id)}`));
  } catch {
    session.end();
    transcript.system("The demo server restarted — place a new callback.");
    render();
  }
}

function clearPanels() {
  view = blankView();
  transcript.clear();
  trail.clear();
  clearTeamsToast(els.toast, els.toastEmpty);
  renderHeaders(els.headers, []);
  els.sayInput.value = "";
  els.portalCode.value = "";
  els.portalPassword.value = "";
  renderPolicy();
  render();
}

/** A manual action: take over from the director, and say what went wrong. */
async function act(fn) {
  if (director.running) director.stop();
  try {
    return await fn();
  } catch (error) {
    notify(error?.message ?? String(error), "err", 6000);
    return null;
  }
}

// --------------------------------------------------------- the reset page

/** Wait for the page to reach a step: the state frames can trail the HTTP reply. */
async function waitForUi(ui, id, what) {
  for (let i = 0; i < 40; i += 1) {
    if (session.id !== id) return false;
    const snap = view.snap;
    if (snap?.callId === id && snap.ui === ui && !snap.callEnded) return true;
    await sleep(100);
  }
  throw new Error(`The reset page isn't asking for ${what} right now.`);
}

/** Director action: the employee types the code they just heard into the page. */
async function portalCode(step = {}) {
  const id = session.id;
  if (!id) throw new Error("Place a callback first.");
  if (!(await waitForUi("code", id, "a code"))) return null;
  let code = step.code ?? view.handset?.code ?? null;
  for (let i = 0; !code && i < 15; i += 1) {
    code = (await fetchHandset(id))?.code ?? null;
    if (!code) await sleep(200);
  }
  if (!code) throw new Error("No code has been read on the call yet.");
  els.portalCode.value = "";
  for (const digit of String(code)) {
    if (session.id !== id) return null;
    els.portalCode.value += digit;
    await sleep(80);
  }
  await sleep(250);
  return submitCode(code);
}

async function submitCode(code = els.portalCode.value) {
  const id = session.id;
  if (!id) throw new Error("Place a callback first.");
  const digits = String(code ?? "").replace(/\D/g, "");
  if (!digits) throw new Error("Type the code from the call first.");
  const result = await postJson(`/api/simulate/${encodeURIComponent(id)}/portal/code`, { code: digits });
  if (session.id !== id) return result;
  const outcome = result?.result;
  view.portalNote = outcome?.ok ? null : codeNote(outcome);
  if (!outcome?.ok) els.portalCode.value = "";
  applyResult(result);
  render();
  return result;
}

function codeNote(outcome) {
  const ttl = view.snap?.code?.ttlMinutes ?? 5;
  switch (outcome?.reason) {
    case "mismatch": {
      const left = outcome.attemptsLeft ?? 0;
      return `That code didn't match. ${left} ${left === 1 ? "try" : "tries"} left.`;
    }
    case "expired":
      return `That code had expired — codes last ${ttl} minutes. Listen for the fresh one.`;
    case "cancelled":
      return "Too many wrong tries, so that code is cancelled. Listen for a new one.";
    case "wrong_state":
      return "The page isn't asking for a code right now.";
    case "no_code":
      return "No code has been read on the call yet.";
    default:
      return "That code wasn't accepted.";
  }
}

/** Director action: the employee types a new password; the server checks it as they type. */
async function portalPassword(step = {}) {
  const id = session.id;
  if (!id) throw new Error("Place a callback first.");
  if (!(await waitForUi("password", id, "a new password"))) return null;
  const password = String(step.password ?? "");
  els.portalPassword.value = "";
  view.policy = null;
  renderPolicy();
  for (const ch of password) {
    if (session.id !== id) return null;
    els.portalPassword.value += ch;
    els.portalPassword.dispatchEvent(new Event("input"));
    await sleep(45);
  }
  await checkNow();
  await sleep(700);
  if (session.id !== id) return null;
  return submitPassword(password);
}

async function submitPassword(password = els.portalPassword.value) {
  const id = session.id;
  if (!id) throw new Error("Place a callback first.");
  const result = await postJson(`/api/simulate/${encodeURIComponent(id)}/portal/password`, { password });
  if (session.id !== id) return result;
  const outcome = result?.result;
  if (outcome && !outcome.ok && Array.isArray(outcome.failures)) view.policy = { ok: false, failures: outcome.failures };
  applyResult(result);
  renderPolicy();
  return result;
}

/** One policy check in flight at a time; the newest text always gets checked. */
function queueCheck() {
  if (checking) {
    recheck = true;
    return checking;
  }
  checking = (async () => {
    try {
      do {
        recheck = false;
        await runCheck();
      } while (recheck);
    } finally {
      checking = null;
    }
  })();
  return checking;
}

async function checkNow() {
  await (checking ?? queueCheck());
}

async function runCheck() {
  const id = session.id;
  const password = els.portalPassword.value;
  if (!id || view.snap?.ui !== "password" || view.snap.callEnded) return;
  if (!password) {
    view.policy = null;
    renderPolicy();
    return;
  }
  view.checkedAt = performance.now();
  try {
    const reply = await postJson(`/api/simulate/${encodeURIComponent(id)}/portal/check`, { password });
    view.checkedAt = performance.now();
    if (session.id !== id || els.portalPassword.value !== password) return;
    const result = reply?.result;
    if (!result || result.reason === "wrong_state") return;
    view.policy = { ok: Boolean(result.ok), failures: result.failures ?? [] };
    renderPolicy();
  } catch {
    // The checklist is a convenience; the server checks again when the password is submitted.
  }
}

// ----------------------------------------------------------------- handlers

const placeCallback = () => act(() => perform({ type: "start" }));
els.newCall.addEventListener("click", placeCallback);
els.forgot.addEventListener("click", placeCallback);

els.employeeSelect.addEventListener("change", () => {
  if (!view.snap) els.portalUser.value = els.employeeSelect.value;
});

els.sayForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = els.sayInput.value.trim();
  if (!text || sending) return;
  sending = true;
  renderControls();
  await act(async () => {
    await voice.speak("caller", text);
    applyResult(await sim.say(text));
    els.sayInput.value = "";
  });
  sending = false;
  renderControls();
});

els.keys.addEventListener("click", (event) => {
  const key = event.target.closest("button[data-digit]");
  if (key) act(() => perform({ type: "dtmf", digit: key.dataset.digit }));
});

els.silence.addEventListener("click", () => act(() => perform({ type: "silence" })));
els.hangup.addEventListener("click", () => act(() => perform({ type: "hangup" })));

els.paneCode.addEventListener("submit", (event) => {
  event.preventDefault();
  act(() => submitCode(els.portalCode.value));
});

els.portalCode.addEventListener("input", () => {
  const digits = els.portalCode.value.replace(/\D/g, "").slice(0, 6);
  if (digits !== els.portalCode.value) els.portalCode.value = digits;
});

els.panePassword.addEventListener("submit", (event) => {
  event.preventDefault();
  if (els.portalPassword.value) act(() => submitPassword(els.portalPassword.value));
});

els.portalPassword.addEventListener("input", () => queueCheck());

els.recall.addEventListener("click", () =>
  act(async () => {
    const id = view.snap?.callId;
    if (!id) return;
    await postJson(`/api/reset/${encodeURIComponent(id)}/recall`, {});
    applySnapshot(await getJson(`/api/calls/${encodeURIComponent(id)}`));
  }),
);

els.reset.addEventListener("click", async () => {
  director.stop();
  voice.cancel?.();
  try {
    const result = await postJson("/api/demo/reset", {});
    session.reset();
    clearPanels();
    renderStats(result?.stats);
    await clock.refresh();
    director.load(0);
    notify("Demo reset — clean audit, starting clock, beat 1.", "ok");
  } catch (error) {
    if (error?.status === 403) notify("Reset is off while this server answers real calls.", "warn");
    else notify(error?.message ?? String(error), "err");
  }
});
