/**
 * The appointment reminder console.
 *
 * A viewer of the server's reminder policy, never a second copy of it. Every
 * decision on screen — whether a call may be placed, what may be said before
 * identity is verified, what changes in the schedule, the handoff — is one the
 * server made and published over the hub; this file only explains it. The
 * plumbing every template shares (hub, call session, demo director, Teams
 * toast, trail) comes from the presenter kit, and the on-stage script lives in
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
  connectHub,
  createCallSession,
  createSimulator,
  renderMode,
  toneOf,
  setStateChip,
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

const els = {
  mode: $("mode"),
  reset: $("reset"),
  voice: $("voice"),
  stateChip: $("stateChip"),
  patientSelect: $("patientSelect"),
  placeCall: $("placeCall"),
  outcomeSelect: $("outcomeSelect"),
  languageSelect: $("languageSelect"),
  pickHint: $("pickHint"),
  sayForm: $("sayForm"),
  sayInput: $("sayInput"),
  sayBtn: $("sayBtn"),
  keys: $("keys"),
  silence: $("silence"),
  hangup: $("hangup"),
  decision: $("decision"),
  checks: $("checks"),
  facts: $("facts"),
  board: $("board"),
  toast: $("toast"),
  toastEmpty: $("toastEmpty"),
  headers: $("headers"),
  metrics: $("metrics"),
};

/** The flow's terminal states (src/flow.mjs). The kit's default matcher misses most of them. */
const TERMINAL = new Set(["ended", "confirmed", "cancelled", "transferring", "opt_out", "retry_scheduled", "not_placed", "skipped"]);

/** "Who picks up" → what the simulated dial does. Messages are left on the last attempt only. */
const PICKUPS = {
  answered: { outcome: "answered", attempt: null },
  "voicemail-last": { outcome: "voicemail", attempt: 3 },
  voicemail: { outcome: "voicemail", attempt: 1 },
  busy: { outcome: "busy", attempt: null },
  no_answer: { outcome: "no_answer", attempt: null },
};

/** The keypad menu the agent offers once the patient is verified (flow.dtmf). */
const MENU = { 1: "confirm", 2: "cancel", 3: "ask for a new time", 9: "stop reminder calls", "*": "repeat that" };
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

/** Short reasons for a refused dial, keyed by the server's gate reason (flow.explainGate). */
const REFUSALS = {
  calling_window: "outside calling hours",
  cutoff: "too close to the appointment",
  not_due: "too early for a reminder",
  no_consent: "no consent to reminder calls",
  channel: "the patient prefers another channel",
  suppressed: "the patient opted out",
  tty: "a TTY line",
  bad_number: "no working number",
  not_allowlisted: "not on the demo allowlist",
  already_confirmed: "already confirmed",
  appointment_closed: "the appointment isn't booked",
  reschedule_pending: "the scheduling desk has it",
  in_progress: "a call is already in progress",
  holiday: "a clinic holiday",
  attempts: "no attempts left",
  spacing: "too soon after the last try",
};

const LANGUAGES = { en: "English", es: "Spanish" };
const CALLBACK_ONLY = new Set(["wrong_party", "unauthorized_proxy", "unverified"]);
const NOBODY = new Set(["busy", "no_answer", "bad_number"]);

let health = null;
let live = false;
let stack = null;
let clockLocked = false;
let sending = false;
let schedule = null;
let rowById = new Map();
let patientsSig = "";
let scheduleSeq = 0;
let boardFlash = false;
/** Lines this console sent; the server echoes them, and they have been spoken already. */
let typed = [];
let view = blankView();

/** What the console has learned about the call on screen, beyond its snapshot. */
function blankView() {
  return {
    snap: null,
    attempts: null, // "1 of 3", from the call_created event
    cleared: null, // the dial gate's "cleared to call" sentence
    voicemail: false,
    party: null, // who answered, once it's known not to be (only) the patient
    callerLines: [],
    dobMismatch: 0,
    dobKeys: 0, // date-of-birth digits keyed so far
    dobLine: null, // the masked transcript line for them
    released: null, // "Thu, May 21, 10:15 AM PDT with Dr. Patel is free again"
    handoff: null,
    lang: null,
  };
}

const terminal = (snap) => TERMINAL.has(snap?.state);
const refused = (snap) => snap?.state === "not_placed" || snap?.state === "skipped";
const firstOf = (snap) => snap?.firstName ?? "the patient";
const agentLabel = () => "Contoso Health assistant";

/** Who is on the line, as far as the agent knows. A name is a claim until the date of birth matches. */
function callerLabel() {
  const party = partyLabel();
  if (party) return party;
  const first = view.snap?.firstName ?? "Patient";
  return view.snap?.verified ? `${first} ✓` : `${first}?`;
}

function partyLabel() {
  const snap = view.snap;
  if (view.voicemail) return "Voicemail";
  if (snap?.outcome === "wrong_party" || snap?.outcome === "unauthorized_proxy") return "Someone else";
  if (snap?.proxyName) return `${snap.proxyName.split(" ")[0]} · proxy`;
  return null;
}

/** Once the server knows who answered, every caller line on this call was theirs. */
function syncParty() {
  const party = partyLabel();
  if (party === view.party) return;
  view.party = party;
  if (!party) return;
  for (const li of view.callerLines) {
    const who = li.querySelector(".who");
    if (who) who.textContent = party;
  }
}

function fmtTime(iso, timeZone) {
  if (!iso) return "";
  const zone = timeZone ?? clock.state?.timeZone;
  const options = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: zone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-US", options).format(new Date(iso));
  }
}

const stackNodes = () =>
  voiceStack({
    caller: "Patient",
    callerLive: "PSTN · the patient's phone",
    callerSim: "typed in this console",
    voiceLive: health?.voiceLive?.model ?? "gpt-realtime",
    tools: "Reminder policy",
    toolsSim: "real policy code",
    agent: "Scheduling desk",
    agentSim: "mock toast",
  });

// ------------------------------------------------------------------ wiring

const voice = createVoice(els.voice, { lang: "en-US" });
const clock = mountClock($("clock"), { onChange: () => refreshSchedule() });
const transcript = createTranscript($("transcript"), {
  voice,
  empty: "Pick a patient and place the call, or press Next ▶ to run the demo script.",
});
const trail = createTrail($("events"), {
  good: ["cleared_to_call", "identity_verified", "details_disclosed", "appointment_confirmed", "slot_released", "reschedule_handoff", "nurse_transfer", "opt_out_saved"],
  bad: ["dob_mismatch", "emergency_phrase", "transfer_failed", "tool_rejected", "blocked_until_verified"],
  warn: ["not_placed", "minimum_necessary", "voicemail_detected", "identity_claimed", "proxy_identified", "cancel_read_back", "cancel_withdrawn", "wrap_up", "clinical_question", "reschedule_callback"],
  timeZone: () => clock.state?.timeZone,
  empty: "Every dial decision, privacy rule and schedule change shows up here.",
});
const session = createCallSession({
  voice,
  onMessage,
  onFollow: () => clearPanels(),
  isFinished: (state) => TERMINAL.has(state),
});
connectHub((target, payload) => session.handle(target, payload), {
  onOpen: ({ reconnected }) => reconnected && refreshAll(),
});
const sim = createSimulator({ session, startBody, onSnapshot: applySnapshot, actions: { metrics: showMetrics } });
const director = createDirector($("director"), {
  beats: createBeats({ setClock, restore }),
  perform,
  voice,
  sayInput: els.sayInput,
  onBeat: () => {
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: "smooth" });
  },
});

// ------------------------------------------------------------- call steps

/** The beat's patient and pickup, or the pickers'. The pickers follow the beat. */
function startBody(step) {
  const appointmentId = step.appointmentId ?? els.patientSelect.value;
  const pickup = step.outcome
    ? step.outcome === "voicemail"
      ? (step.attempt ?? 1) >= 3
        ? "voicemail-last"
        : "voicemail"
      : step.outcome
    : els.outcomeSelect.value;
  const language = "language" in step ? step.language : els.languageSelect.value || null;
  if (rowById.has(appointmentId)) els.patientSelect.value = appointmentId;
  if (PICKUPS[pickup]) els.outcomeSelect.value = pickup;
  els.languageSelect.value = language ?? "";
  renderHint();
  const dial = PICKUPS[pickup] ?? PICKUPS.answered;
  return { appointmentId, outcome: dial.outcome, attempt: step.attempt ?? dial.attempt, language };
}

/** Director and button steps. A new call hangs up the one on screen first. */
async function perform(step) {
  if (step.type === "start") {
    if (session.id && !session.finished && !session.followed) await sim.hangup().catch(() => {});
    clearPanels();
  } else if (step.type === "say") {
    typed.push(String(step.text ?? "").trim());
  }
  return sim.perform(step);
}

/** Beats pin the demo clock. A server placing real calls keeps real time. */
async function setClock(preset) {
  try {
    await clock.set({ preset });
  } catch (error) {
    if (error.status !== 403) throw error;
    if (!clockLocked) {
      clockLocked = true;
      notify("This server places real calls, so the demo clock stays on real time.", "warn", 6000);
    }
  }
}

/** Beats put their own appointments back the way the seed has them, so they run in any order. */
async function restore(appointmentIds) {
  try {
    await postJson("/api/demo/restore", { appointmentIds });
  } catch (error) {
    if (error.status !== 403) throw error;
  }
  await refreshSchedule();
}

// -------------------------------------------------------------------- hub

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
    case "handoff":
      view.handoff = payload;
      renderHandoff();
      refreshSchedule();
      break;
    case "schedule":
      refreshSchedule({ highlight: true });
      break;
  }
}

/**
 * Snapshots arrive twice — over the hub and in each simulate response. Anything
 * after the call finished is ignored.
 */
function applySnapshot(snap) {
  if (!snap?.id) return;
  if (session.id && snap.id !== session.id) return;
  const prev = view.snap?.id === snap.id ? view.snap : null;
  if (prev && terminal(prev) && !terminal(snap)) return;

  view.snap = snap;
  syncParty();
  const lang = snap.language === "es" ? "es-US" : "en-US";
  if (lang !== view.lang) {
    view.lang = lang;
    voice.setLang(lang);
  }
  if (snap.state !== "verifying") {
    view.dobKeys = 0;
    view.dobLine = null;
  }
  // A live transfer that failed moves one terminal state to another: the metrics move with it.
  const ended = terminal(snap) && (!terminal(prev) || prev.outcome !== snap.outcome);
  // The footer moves with the story: a call placed, a patient verified, a call settled.
  if (!prev || (snap.verified && !prev.verified) || ended) refreshStats({ highlight: true });
  if (ended) {
    refreshSchedule();
    if (view.handoff && prev) renderHandoff();
  }
  render();
}

function onTranscript({ role, text }) {
  if (role === "caller") {
    // The server's own lines for the phone ("Hello?", a voicemail greeting) haven't been heard yet.
    const i = typed.indexOf(text);
    if (i >= 0) typed.splice(i, 1);
    else voice.speak("caller", text);
    const li = transcript.add("caller", text, { label: callerLabel() });
    if (li) view.callerLines.push(li);
  } else {
    transcript.add(role, text, { label: role === "agent" ? agentLabel() : undefined });
  }
}

/**
 * Policy events, as the tool calls and rules a viewer can follow. In
 * simulation the offline stand-in calls the flow directly, so the chips are
 * built from the server's events rather than from the model's tool calls.
 */
function onEvent(e) {
  trail.add(e);
  const detail = String(e.detail ?? "");
  const snap = view.snap;
  switch (e.kind) {
    case "call_created": {
      const m = /attempt (\d+ of \d+)/.exec(detail);
      if (m) view.attempts = m[1];
      break;
    }
    case "cleared_to_call":
      view.cleared = detail;
      transcript.system(`Calling ${snap?.patient ?? "the patient"}…`);
      break;
    case "not_placed":
      transcript.system(`Not dialed. ${detail}`);
      break;
    case "minimum_necessary":
      transcript.system(`Privacy rule: ${detail}`);
      break;
    case "voicemail_detected":
      view.voicemail = true;
      syncParty();
      transcript.system(detail);
      break;
    case "proxy_identified":
    case "cancel_withdrawn":
    case "clinical_question":
    case "emergency_phrase":
    case "wrap_up":
    case "transfer_started":
    case "transfer_failed":
      transcript.system(detail);
      break;
    case "identity_verified":
      transcript.tool("check_dob", "match · identity verified", "ok");
      break;
    case "dob_mismatch":
      view.dobMismatch += 1;
      transcript.tool("check_dob", `no match (try ${view.dobMismatch} of 2)`, "warn");
      break;
    case "appointment_confirmed":
      transcript.tool("confirm_appointment", `${snap?.appointmentId ?? ""} confirmed`.trim(), "ok");
      break;
    case "cancel_read_back":
      transcript.tool("propose_cancel", "read back first · nothing changed yet", "warn");
      break;
    case "slot_released":
      view.released = detail;
      transcript.tool("cancel_appointment", `slot released · ${detail}`, "ok");
      break;
    case "reschedule_handoff":
      transcript.tool("request_reschedule", "→ Scheduling desk · nothing booked", "accent");
      break;
    case "reschedule_callback":
      transcript.tool("request_reschedule", "callback logged · nothing booked", "warn");
      break;
    case "nurse_transfer":
      transcript.tool("nurse_line", "→ Nurse line · no medical advice", "accent");
      break;
    case "opt_out_saved":
      transcript.tool("opt_out", "saved · no more reminder calls", "ok");
      break;
    case "tool_rejected":
      transcript.tool(detail.split(":")[0] || "tool", "refused by the server", "err");
      break;
    case "blocked_until_verified":
      transcript.system("Blocked: identity not verified yet");
      break;
    case "dtmf": {
      if (/date of birth/i.test(detail)) {
        const text = "Keypad: •••••••• (date of birth sent)";
        if (view.dobLine?.isConnected) view.dobLine.textContent = text;
        else transcript.system(text);
        view.dobKeys = 0;
        view.dobLine = null;
        break;
      }
      const key = detail.replace(/^Keypad:\s*/, "");
      transcript.tool("keypad", MENU[key] ? `${key} → ${MENU[key]}` : key, "accent");
      break;
    }
  }
  render();
}

/** Date-of-birth digits stay on the patient's side of the call: one masked line. */
function showDobKey() {
  view.dobKeys += 1;
  const text = `Keypad: ${"•".repeat(Math.min(view.dobKeys, 8))} (date of birth, ${Math.min(view.dobKeys, 8)} of 8)`;
  if (view.dobLine?.isConnected) view.dobLine.textContent = text;
  else view.dobLine = transcript.system(text);
}

// ----------------------------------------------------------------- render

const STATE_TONES = {
  checking: "accent",
  dialing: "accent",
  connected: "accent",
  detecting: "accent",
  greeting: "accent",
  right_party: "warn",
  verifying: "warn",
  presenting: "ok",
  confirming: "accent",
  dtmf_menu: "accent",
  cancel_reason: "warn",
  cancel_confirm: "warn",
  reschedule: "accent",
  clinical: "warn",
  wrap_up: "warn",
  voicemail: "warn",
  closing: "muted",
};

/** The chip says how the call ended, not just that it did. */
function chipFor(snap) {
  if (!snap) return [null];
  const o = snap.outcome;
  switch (snap.state) {
    case "not_placed":
    case "skipped":
      return ["not placed", "warn"];
    case "confirmed":
      return ["confirmed", "ok"];
    case "cancelled":
      return ["cancelled · slot free", "ok"];
    case "transferring":
      return [o === "nurse_transfer" ? "with the nurse line" : "with the scheduling desk", "accent"];
    case "opt_out":
      return ["opted out", "ok"];
    case "retry_scheduled":
      return ["retry scheduled", "warn"];
    case "ended":
      if (o === "voicemail_left" || o === "wrong_party" || o === "unauthorized_proxy") return ["callback only", "ok"];
      if (o === "unverified") return ["not verified", "warn"];
      if (o === "reschedule_callback") return ["callback logged", "accent"];
      if (o === "transfer_failed") return ["transfer didn't connect", "warn"];
      if (o === "opted_out") return ["opted out", "ok"];
      return ["ended", "muted"];
    default:
      return [snap.state, STATE_TONES[snap.state] ?? toneOf(snap.state)];
  }
}

function render() {
  const snap = view.snap;
  const [text, tone] = chipFor(snap);
  setStateChip(els.stateChip, text, tone);
  renderControls();
  renderDecision(els.decision, { ...decision(snap), empty: "Place a reminder call to see what the server allows." });
  renderChecks(els.checks, checks(snap));
  renderFactsPanel();
  renderBoard();
  renderToastPlaceholder();
}

function renderControls() {
  const active = Boolean(session.id && !session.finished && !session.followed && view.snap && !terminal(view.snap));
  for (const el of [els.sayInput, els.sayBtn, els.silence, els.hangup]) el.disabled = !active;
  for (const button of els.keys.querySelectorAll("button")) button.disabled = !active;
  for (const el of [els.placeCall, els.patientSelect, els.outcomeSelect, els.languageSelect]) el.disabled = live;
}

function renderKeys() {
  els.keys.innerHTML = KEYS.map((key) => {
    const menu = MENU[key];
    return `<button type="button" data-digit="${escapeHtml(key)}"${menu ? " data-menu" : ""} title="${escapeHtml(
      menu ? `Press ${key}: ${menu}` : `Press ${key}`,
    )}">${escapeHtml(key)}</button>`;
  }).join("");
}

/** The headline: what the server decided, and why, in plain English. */
function decision(snap) {
  if (!snap) return {};
  const first = firstOf(snap);
  const o = snap.outcome;

  if (refused(snap)) {
    return {
      headline: `Not placed: ${REFUSALS[snap.reason] ?? "not allowed right now"}`,
      why: snap.why ?? "The server's dial policy refused this call.",
      verdict: "nothing dialed",
      tone: "warn",
    };
  }

  switch (snap.state) {
    case "checking":
      return {
        headline: `May we call ${first} now?`,
        why: "Consent, calling hours in the patient's time zone, the reminder window and attempts. The server checks; the agent can't dial around it.",
      };
    case "dialing":
    case "connected":
    case "detecting":
      return { headline: `Calling ${snap.patient ?? first}`, why: view.cleared ?? "Cleared to call.", verdict: "cleared to call", tone: "ok" };
    case "greeting":
      return {
        headline: `Asking for ${first}`,
        why: `Someone picked up. Until it's ${first} with a matching date of birth, the agent says who is calling and nothing about the appointment.`,
        verdict: "minimum necessary",
        tone: "accent",
      };
    case "right_party":
    case "verifying":
      return view.dobMismatch
        ? {
            headline: "The date of birth didn't match",
            why: "One more try. If it still doesn't match, the call ends without any appointment details.",
            verdict: "identity first",
            tone: "warn",
          }
        : {
            headline: "Checking identity",
            why: `They say they're ${first}. A claim isn't proof, so the agent asks for a date of birth before it says why it's calling.`,
            verdict: "identity first",
            tone: "warn",
          };
    case "presenting":
    case "dtmf_menu":
    case "confirming":
      return {
        headline: "Verified: reading out the appointment",
        why: "The date of birth matched, so now, and only now, the agent shares the appointment and asks: keep it, cancel it, or find a new time?",
        verdict: "verified → details",
        tone: "ok",
      };
    case "cancel_reason":
    case "cancel_confirm":
      return {
        headline: "Cancel? Read it back first",
        why: "Nothing changes in the schedule until the patient gives a clear yes to the read-back.",
        verdict: "read back, then a clear yes",
        tone: "warn",
      };
    case "confirmed":
      return {
        headline: `Confirmed: ${snap.appointmentId}`,
        why: `${first} said yes. The server marked the appointment confirmed in the clinic's schedule, and the agent read out the prep instructions.`,
        verdict: "schedule updated",
        tone: "ok",
      };
    case "cancelled": {
      const slot = view.released ? view.released.replace(/\s+is free again$/, "") : "The time";
      return {
        headline: "Cancelled: the slot is free again",
        why: `${slot} is back in the schedule for another patient. ${first} got the number to book a new visit.`,
        verdict: "slot released",
        tone: "ok",
      };
    }
    case "reschedule":
      return {
        headline: "A new time? A person books it",
        why: "Finding a new time means options and trade-offs, so the agent hands over to the scheduling desk instead of booking anything itself.",
        verdict: "handing over",
        tone: "accent",
      };
    case "transferring":
      return o === "nurse_transfer"
        ? {
            headline: "Handed to the nurse line",
            why: "A clinical question. The agent gives no medical advice; a nurse takes the call in Teams with the context.",
            verdict: "no medical advice",
            tone: "accent",
          }
        : {
            headline: "Handed to the scheduling desk",
            why: `${first} asked for a new time. The agent books nothing itself: a scheduler takes the call in Teams with the context, and the current slot stays booked until a new one is chosen.`,
            verdict: "a person books the new time",
            tone: "accent",
          };
    case "clinical":
      return {
        headline: "A clinical question",
        why: "The agent gives no medical advice. It offers the nurse line, or the after-hours number when the nurse line is closed.",
        verdict: "no medical advice",
        tone: "warn",
      };
    case "voicemail":
      return {
        headline: "Voicemail picked up",
        why: "Anyone could play a voicemail back, so it gets a callback request at most.",
        verdict: "minimum necessary",
        tone: "warn",
      };
    case "opt_out":
      return optedOut(first);
    case "wrap_up":
      return { headline: "Wrapping up", why: "The call is close to its time cap, so the agent wraps up.", verdict: "time cap", tone: "warn" };
  }

  const next = snap.nextAllowedAt ? ` Next try: ${fmtTime(snap.nextAllowedAt, rowById.get(snap.appointmentId)?.timeZone)}.` : "";
  switch (o) {
    case "voicemail_left":
      return {
        headline: "Voicemail: a callback request only",
        why: `It's the last attempt, so the agent left a message: who is calling, ${first}'s first name and a callback number. No department, no provider, no time.`,
        verdict: "minimum necessary",
        tone: "ok",
      };
    case "voicemail_hangup":
      return {
        headline: "Voicemail: no message this time",
        why: `Messages are left on the last attempt only, and even then carry a callback number and nothing else.${next}`,
        verdict: snap.state === "retry_scheduled" ? "retry scheduled" : "no attempts left",
        tone: "warn",
      };
    case "wrong_party":
      return {
        headline: "Someone else answered",
        why: `It isn't ${first}, so the agent asked them to pass on a callback number and said nothing about the appointment: not the department, the provider or the time.`,
        verdict: "minimum necessary",
        tone: "ok",
      };
    case "unauthorized_proxy":
      return {
        headline: "Not an authorized proxy",
        why: `They aren't on ${first}'s list of authorized proxies, so they got a callback request and nothing about the appointment.`,
        verdict: "minimum necessary",
        tone: "ok",
      };
    case "unverified":
      return {
        headline: "Identity not verified",
        why: "The date of birth didn't match twice, so the call ended without any appointment details. The patient can call the clinic back.",
        verdict: "no details shared",
        tone: "warn",
      };
    case "reschedule_callback":
      return {
        headline: "New time requested: callback logged",
        why: "No scheduling desk is configured, so the request is logged for staff to call back. Nothing was booked.",
        verdict: "a person books the new time",
        tone: "accent",
      };
    case "transfer_failed":
      return snap.handoff?.destination === "nurseLine"
        ? {
            headline: "The nurse line didn't pick up",
            why: `${first} was still on the line, so the agent said so, gave the clinic's number and the 911 line, and ended the call. Still no medical advice, and no second transfer, so the call can't loop.`,
            verdict: "honest close · no loop",
            tone: "warn",
          }
        : {
            headline: "The scheduling desk didn't pick up",
            why: `${first} was still on the line, so the agent said so: the request for a new time stands, the desk calls back, and the current slot stays booked. No second transfer, so a busy desk can't loop the call.`,
            verdict: "request stands · callback",
            tone: "warn",
          };
    case "opted_out":
      return optedOut(first);
    case "busy":
    case "no_answer":
      return {
        headline: `${o === "busy" ? "Line busy" : "No answer"}: try again later`,
        why: snap.state === "retry_scheduled"
          ? `The next try keeps to calling hours, spacing between attempts and the cutoff before the visit.${next}`
          : "No attempts left before the cutoff, so the patient isn't called again.",
        verdict: snap.state === "retry_scheduled" ? "retry scheduled" : "no attempts left",
        tone: "warn",
      };
  }
  if (terminal(snap)) {
    return {
      headline: snap.outcomeText ?? "Call ended",
      why: snap.disclosed ? "The appointment was discussed after identity was verified." : "No appointment details were shared.",
      verdict: "call ended",
      tone: "muted",
    };
  }
  return { headline: "On the call", why: "The agent talks; the server decides what may be said and what changes." };
}

function optedOut(first) {
  return {
    headline: "Opted out",
    why: `${first} asked for no more reminder calls. The opt-out is saved, and future reminder runs skip this patient.`,
    verdict: "no more calls",
    tone: "ok",
  };
}

/** The four rules a reminder call meets, in the order it meets them. */
function checks(snap) {
  if (!snap) {
    return [
      { label: "May we call now?", detail: "Consent, calling hours in the patient's time zone, the reminder window, attempts left" },
      { label: "Right person?", detail: "A date of birth that matches the record" },
      { label: "Minimum necessary", detail: "Nothing about the appointment until identity is verified" },
      { label: "Schedule change", detail: "Only after a clear yes. A new time goes to a person." },
    ];
  }
  return [dialCheck(snap), identityCheck(snap), privacyCheck(snap), scheduleCheck(snap)];
}

function dialCheck(snap) {
  if (refused(snap)) {
    return { label: `Not placed: ${REFUSALS[snap.reason] ?? "not allowed right now"}`, detail: snap.why ?? "", tone: "err" };
  }
  if (snap.state === "checking") return { label: "May we call now?", detail: "Checking consent, calling hours and the reminder window", tone: "accent" };
  return { label: "Cleared to call", detail: view.cleared ?? "", tone: "ok" };
}

function identityCheck(snap) {
  const first = firstOf(snap);
  const o = snap.outcome;
  if (snap.verified) {
    const proxy = snap.proxyName ? `${snap.proxyName.split(" ")[0]}, an authorized proxy, gave ${first}'s date of birth` : "";
    return { label: "Identity verified", detail: proxy || "The date of birth matches the record", tone: "ok" };
  }
  if (refused(snap)) return { label: "Right person?", detail: "Nobody was called" };
  if (view.voicemail || o === "voicemail_left" || o === "voicemail_hangup") {
    return { label: "Voicemail, not a person", detail: "Nobody to verify", tone: "warn" };
  }
  if (o === "wrong_party") return { label: `Not ${first}`, detail: "Someone else answered", tone: "warn" };
  if (o === "unauthorized_proxy") return { label: "Not an authorized proxy", detail: `Not on ${first}'s list of proxies`, tone: "warn" };
  if (o === "unverified") return { label: "Identity not verified", detail: "The date of birth didn't match twice", tone: "err" };
  if (NOBODY.has(o)) return { label: "Right person?", detail: "Nobody answered" };
  if (view.dobMismatch) return { label: "The date of birth didn't match", detail: `Try ${view.dobMismatch} of 2`, tone: "warn" };
  if (snap.state === "verifying" || snap.state === "right_party") {
    return { label: "Verifying identity", detail: `Says they're ${first}; asking for a date of birth`, tone: "accent" };
  }
  if (terminal(snap)) return { label: "Identity not verified", detail: "The call ended first" };
  return { label: "Right person?", detail: `Asking for ${first} by first name`, tone: "accent" };
}

function privacyCheck(snap) {
  const o = snap.outcome;
  if (snap.disclosed) return { label: "Details after verification", detail: "The appointment was shared only once the date of birth matched", tone: "ok" };
  if (refused(snap) || NOBODY.has(o)) return { label: "Minimum necessary", detail: "Nobody reached, nothing said" };
  if (o === "voicemail_left") {
    return { label: "Callback request only", detail: "The message gives the clinic and a callback number: no department, provider or time", tone: "ok" };
  }
  if (o === "voicemail_hangup") return { label: "No message left", detail: "Messages are left on the last attempt only", tone: "ok" };
  if (CALLBACK_ONLY.has(o)) return { label: "Callback request only", detail: "Nothing about the appointment was said", tone: "ok" };
  if (terminal(snap)) return { label: "Minimum necessary", detail: "Nothing about the appointment was said", tone: "ok" };
  return { label: "Details held back", detail: "Nothing about the appointment until identity is verified", tone: "accent" };
}

function scheduleCheck(snap) {
  const o = snap.outcome;
  switch (snap.state) {
    case "confirmed":
      return { label: "Confirmed in the schedule", detail: `${snap.appointmentId}, after a clear yes`, tone: "ok" };
    case "cancelled":
      return { label: "Cancelled, slot released", detail: view.released ?? "The time is open for another patient", tone: "ok" };
    case "cancel_reason":
    case "cancel_confirm":
      return { label: "Cancel pending", detail: "Nothing changes until a clear yes to the read-back", tone: "warn" };
  }
  if (o === "reschedule_handoff" || o === "reschedule_callback") {
    return { label: "Nothing booked by the agent", detail: "A person picks the new time; the current slot stays booked", tone: "ok" };
  }
  if (o === "transfer_failed" && snap.handoff?.destination !== "nurseLine") {
    return { label: "Nothing booked by the agent", detail: "The request for a new time stands; the current slot stays booked", tone: "ok" };
  }
  if (o === "opted_out") return { label: "Opt-out saved", detail: "No more reminder calls for this patient", tone: "ok" };
  if (terminal(snap)) return { label: "No schedule change", detail: refused(snap) ? "Nothing was dialed" : "The appointment stays as it was" };
  return { label: "Schedule change", detail: "Only after a clear yes. A new time goes to a person." };
}

function renderFactsPanel() {
  const snap = view.snap;
  if (!snap) {
    renderFacts(els.facts, []);
    return;
  }
  const row = rowById.get(snap.appointmentId);
  const a = snap.appointment ?? {};
  const ids = [snap.appointmentId, view.attempts && `attempt ${view.attempts}`].filter(Boolean).join(" · ");
  const lang = LANGUAGES[snap.language] ?? snap.language;
  const pref = row?.language;
  const visit = [[a.department, a.visitType].filter(Boolean).join(" "), a.localTime].filter(Boolean).join(" · ");
  renderFacts(els.facts, [
    ["Patient", `${escapeHtml(snap.patient ?? "—")} <span class="muted">${escapeHtml(ids)}</span>`, { html: true }],
    ["Appointment", visit],
    lang && ["Call language", pref && pref !== snap.language ? `${lang} · prefers ${LANGUAGES[pref] ?? pref}` : lang],
    !refused(snap) && saidRow(snap),
    snap.nextAllowedAt && [
      snap.state === "retry_scheduled" ? "Next try" : "Next allowed call",
      fmtTime(snap.nextAllowedAt, row?.timeZone),
      { tone: "warn" },
    ],
    terminal(snap) && ["Outcome", snap.outcomeText],
  ]);
}

/** What the call said about the appointment: the minimum-necessary rule, made visible. */
function saidRow(snap) {
  const o = snap.outcome;
  if (snap.disclosed) return ["Said about the visit", "Department, provider and time, after verification", { tone: "ok" }];
  if (!terminal(snap)) return ["Said about the visit", "Nothing yet"];
  if (NOBODY.has(o)) return ["Said about the visit", "Nothing: nobody answered"];
  if (o === "voicemail_hangup") return ["Said about the visit", "Nothing: no message left", { tone: "ok" }];
  return ["Said about the visit", "Nothing: a callback number at most", { tone: "ok" }];
}

const STATUS = {
  booked: ["booked", "muted"],
  confirmed: ["confirmed", "ok"],
  cancelled: ["cancelled", "muted"],
};

/** The clinic's side: what the calls changed, and the slots they gave back. */
function renderBoard() {
  if (!schedule) return;
  const activeId = view.snap?.appointmentId;
  const rows = [...(schedule.board ?? [])];
  if (activeId && !rows.some((r) => r.appointmentId === activeId) && rowById.has(activeId)) rows.push(rowById.get(activeId));
  const items = rows.map((row) => {
    const [status, tone] =
      row.rescheduleRequested && row.status !== "cancelled"
        ? ["new time requested", "warn"]
        : (STATUS[row.status] ?? [String(row.status ?? "").replace(/_/g, " "), "muted"]);
    return {
      label: `${row.patient} · ${row.appointmentId}`,
      meta: [[row.department, row.visitType].filter(Boolean).join(" "), row.localTime, row.provider].filter(Boolean).join(" · "),
      status,
      tone,
      active: row.appointmentId === activeId,
    };
  });
  for (const slot of schedule.releasedSlots ?? []) {
    items.push({
      label: `Open slot · ${slot.provider ?? "provider"}`,
      meta: [slot.department, slot.localTime].filter(Boolean).join(" · "),
      status: "free again",
      tone: "ok",
    });
  }
  renderList(els.board, items, { empty: "The schedule isn't loaded yet." });
}

// ----------------------------------------------------------------- Teams

function renderHandoff() {
  const h = view.handoff;
  if (!h) return;
  const snap = view.snap;
  const nurse = h.destination === "nurseLine";
  const a = h.appointment ?? snap?.appointment ?? {};
  const visit = [[a.department, a.visitType].filter(Boolean).join(" "), a.localTime, a.provider].filter(Boolean).join(" · ");
  const proxy = snap?.proxyName ? `, via ${snap.proxyName.split(" ")[0]} (authorized proxy)` : "";
  const callerHtml = `<strong>${escapeHtml(snap?.patient ?? "Patient")}</strong>${
    a.appointmentId ? ` · ${escapeHtml(a.appointmentId)}` : ""
  }${visit ? `<div class="muted">${escapeHtml(visit)}</div>` : ""}${
    snap?.verified
      ? `<span class="verified">Identity verified by date of birth${escapeHtml(proxy)}</span>`
      : `<span class="unverified">Identity not verified</span>`
  }`;
  const missed = snap?.outcome === "transfer_failed" ? { text: "didn't connect", tone: "err" } : null;
  const tags = nurse
    ? [{ text: "clinical question", tone: "teams" }, { text: "no medical advice given", tone: "accent" }, missed]
    : [
        { text: "new time", tone: "teams" },
        snap?.verified ? { text: "verified", tone: "ok" } : null,
        { text: "nothing booked", tone: "accent" },
        missed,
      ];
  renderTeamsToast(els.toast, {
    queue: h.queue ?? h.displayName ?? "Scheduling desk",
    subtitle: "Call queue · handed over by the reminder agent",
    topic: h.callTopic,
    context: h.summary,
    sentiment: h.callerSaid ? `Patient said “${h.callerSaid}”` : "",
    callerHtml,
    avatar: h.queue,
    tags: tags.filter(Boolean),
  });
  els.toastEmpty.hidden = true;
  // Built on the server by the same function the real transfer uses.
  renderHeaders(els.headers, (h.voipHeaders ?? []).map((x) => [x.key, x.value]));
}

function renderToastPlaceholder() {
  if (view.handoff) return;
  const snap = view.snap;
  const o = snap?.outcome;
  els.toastEmpty.textContent = !snap
    ? "No call has been handed over yet. When a patient asks for a new time, the scheduling desk's Teams client rings here."
    : refused(snap)
      ? "Nothing to hand over: the call was never placed."
      : o === "reschedule_callback"
        ? "No scheduling desk is configured, so the request is logged for a callback. Nothing was booked."
        : !terminal(snap)
          ? "Nothing handed over yet. A request for a new time goes to the scheduling desk."
          : view.voicemail || CALLBACK_ONLY.has(o)
            ? "No handoff: the call ended with a callback request, and nothing about the appointment was said."
            : NOBODY.has(o)
              ? "No handoff: nobody answered."
              : "No handoff needed: the agent settled this call on its own.";
}

// ---------------------------------------------------------------- metrics

let shownStats = null;
let statsRequest = 0;

/** Draws the footer and says whether any number changed, so a refresh that moves nothing doesn't flash. */
function renderStats(stats) {
  if (!stats) return false;
  statsRequest += 1; // a refresh still in flight must not paint older numbers over these
  const rows = [
    ["Calls placed", stats.placed],
    ["Patients reached", stats.reached],
    ["Confirmed", stats.confirmed],
    ["Cancelled · slot freed", stats.cancelled],
    ["Reschedules handed off", stats.reschedulesHandedOff],
    ["Privacy-safe voicemails", stats.privacySafeVoicemails],
    ["Callback only", stats.callbackOnly],
    ["Not placed", stats.notPlaced],
  ];
  renderMetrics(els.metrics, rows);
  const key = JSON.stringify(rows);
  const changed = key !== shownStats;
  shownStats = key;
  return changed;
}

async function refreshStats({ highlight = false } = {}) {
  const request = ++statsRequest;
  try {
    const stats = await getJson("/api/stats");
    if (request !== statsRequest) return;
    if (renderStats(stats) && highlight) flash(els.metrics);
  } catch {
    // Keep the last numbers on screen.
  }
}

/** The closing beat: let the last call settle, then show the numbers. */
async function showMetrics() {
  for (let i = 0; i < 30 && !session.finished; i += 1) await sleep(100);
  await refreshStats();
  flash(els.metrics);
  els.metrics.scrollIntoView({ behavior: "smooth", block: "end" });
}

// ----------------------------------------------------------- server state

/** The schedule as the server judges it on the demo clock: who may be called now, and why. */
async function refreshSchedule({ highlight = false } = {}) {
  if (highlight) boardFlash = true;
  const seq = ++scheduleSeq;
  try {
    const data = await getJson("/api/schedule");
    if (seq !== scheduleSeq) return;
    schedule = data;
    rowById = new Map((data.appointments ?? []).map((row) => [row.appointmentId, row]));
    for (const row of data.board ?? []) rowById.set(row.appointmentId, row);
    renderPatients();
    renderBoard();
    renderFactsPanel();
    if (boardFlash) {
      boardFlash = false;
      flash(els.board);
    }
  } catch {
    // Keep the last good schedule.
  }
}

/** The beat patients first, then every other upcoming appointment. Rebuilt only when it changes. */
function renderPatients() {
  const board = schedule?.board ?? [];
  const onBoard = new Set(board.map((row) => row.appointmentId));
  const more = (schedule?.appointments ?? []).filter((row) => !onBoard.has(row.appointmentId));
  const option = (row) => `<option value="${escapeHtml(row.appointmentId)}">${escapeHtml(pickLabel(row))}</option>`;
  const html = `<optgroup label="In the demo script">${board.map(option).join("")}</optgroup>${
    more.length ? `<optgroup label="More upcoming appointments">${more.map(option).join("")}</optgroup>` : ""
  }`;
  if (html !== patientsSig) {
    const keep = els.patientSelect.value;
    els.patientSelect.innerHTML = html;
    patientsSig = html;
    const options = [...els.patientSelect.options].map((o) => o.value);
    els.patientSelect.value = options.includes(keep) ? keep : (options[0] ?? "");
  }
  renderHint();
}

function pickLabel(row) {
  const prefers = row.language && row.language !== "en" ? ` · prefers ${LANGUAGES[row.language] ?? row.language}` : "";
  return `${row.patient} · ${row.appointmentId} · ${row.department}${prefers}`;
}

/** Whether the picked patient may be called right now, in the server's words. */
function renderHint() {
  const row = rowById.get(els.patientSelect.value);
  els.pickHint.textContent = row?.why ?? "";
  if (row) els.pickHint.dataset.tone = row.callable ? "ok" : "warn";
  else delete els.pickHint.dataset.tone;
}

async function loadHealth() {
  try {
    health = await getJson("/health");
  } catch {
    return;
  }
  live = renderMode(els.mode, health);
  const missing = health.missingConfig ?? [];
  els.mode.title = live
    ? "Placing real reminder calls with Azure Communication Services Call Automation; handoffs ring Teams through Teams Phone extensibility."
    : `Typed patient replies, the real reminder policy and a mock Teams client. Set ${
        missing.length ? missing.join(", ") : "the Azure settings"
      } to place real calls.`;
  els.reset.disabled = live;
  if (live) els.reset.title = "Demo controls are off while this server places real calls.";
  if (stack) stack.setLive(live);
  else stack = mountStack($("stack"), { live, nodes: stackNodes() });
  render();
}

/** After a hub reconnect: catch up on anything missed while it was down. */
async function refreshAll() {
  await Promise.all([loadHealth(), clock.refresh(), refreshSchedule(), refreshStats()]);
  if (!session.id || session.finished) return;
  try {
    applySnapshot(await getJson(`/api/calls/${encodeURIComponent(session.id)}`));
  } catch {
    session.end();
    transcript.system("The demo server restarted. Place the call again.");
    render();
  }
}

function clearPanels() {
  view = blankView();
  typed = [];
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

els.placeCall.addEventListener("click", () => act(() => perform({ type: "start" })));

els.sayForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = els.sayInput.value.trim();
  if (!text || sending || els.sayInput.disabled) return;
  sending = true;
  act(async () => {
    await voice.speak("caller", text);
    typed.push(text);
    await sim.say(text);
    els.sayInput.value = "";
  }).finally(() => {
    sending = false;
  });
});

els.keys.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-digit]");
  if (!button || button.disabled) return;
  const digit = button.dataset.digit;
  if (view.snap?.state === "verifying" && /^\d$/.test(digit)) showDobKey();
  act(() => sim.dtmf(digit));
});

els.silence.addEventListener("click", () => act(() => sim.silence()));
els.hangup.addEventListener("click", () => act(() => sim.hangup()));

// The director ignores its keys while a select has focus, so hand focus back after a pick.
for (const select of [els.patientSelect, els.outcomeSelect, els.languageSelect, els.voice]) {
  select.addEventListener("change", () => {
    if (select === els.patientSelect) renderHint();
    select.blur();
  });
}

els.reset.addEventListener("click", async () => {
  director.stop();
  try {
    const result = await postJson("/api/demo/reset");
    session.reset();
    clearPanels();
    renderStats(result.stats);
    await Promise.all([clock.refresh(), refreshSchedule()]);
    director.load(0);
    notify("Demo reset: the seeded schedule, clean metrics, the starting clock, beat 1.", "ok");
  } catch (error) {
    if (error.status === 403) notify("Reset is off while this server places real calls.", "warn");
    else notify(error.message, "err");
  }
});

async function boot() {
  renderKeys();
  renderHeaders(els.headers, []);
  render();
  await Promise.all([loadHealth(), refreshSchedule(), refreshStats()]);
  stack ??= mountStack($("stack"), { nodes: stackNodes() });
}

// Who may be called changes with the clock, so keep the schedule honest.
setInterval(() => refreshSchedule(), 60_000);
boot();
