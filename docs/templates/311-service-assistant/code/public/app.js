/**
 * The 311 console.
 *
 * A viewer of the server's 311 policy, never a second copy of it. Every
 * decision on screen — the emergency rule, the verified location, the approved
 * answer, the text with consent, the handoff — is one the server made and
 * published over the hub; this file only explains it. The plumbing every
 * template shares (hub, call session, demo director, Teams toast, trail) comes
 * from the presenter kit, and the on-stage script lives in beats.js.
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

// The fictional callers in beats.js, so the presenter can choose who is calling.
// The server never learns their names; the console uses them as labels only.
const CALLERS = [
  { phone: "+12065550142", name: "Alex Chen" },
  { phone: "+12065550187", name: "Lucía Ortega", lang: "es-US" },
  { phone: "+12065550118", name: "Sam Rivera" },
  { phone: "", name: "Number withheld" },
];

// Mirrors the display names in config/departments.json.
const DEPARTMENTS = {
  "public-works": "Public Works",
  sanitation: "Sanitation",
  "parking-enforcement": "Parking Enforcement",
  "code-enforcement": "Code Enforcement",
  clerk: "City Clerk",
  "311-live": "311 Live Agent",
  relay: "Relay Services",
};

const els = {
  mode: $("mode"),
  reset: $("reset"),
  langChip: $("langChip"),
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
  recordBlock: $("recordBlock"),
  caseHead: $("caseHead"),
  caseNote: $("caseNote"),
  caseFacts: $("caseFacts"),
  faqBlock: $("faqBlock"),
  sources: $("sources"),
  phone: $("phone"),
  phoneNote: $("phoneNote"),
  toast: $("toast"),
  toastEmpty: $("toastEmpty"),
  headers: $("headers"),
  metrics: $("metrics"),
};

const TERMINAL = new Set(["transferred", "ended"]);
const AGENT = "311 assistant";
// The server's decision tones, in the kit's words.
const TONES = { info: "accent", good: "ok", warn: "warn", bad: "err" };
const TEXT_STATUS = {
  simulated: "Simulated — not sent",
  sending: "Sending…",
  sent: "Sent",
  failed: "Not sent — failed",
};

// Defaults until /health answers; the server's numbers win.
const settings = { callTimeBudgetMs: 300_000, maxRequestsPerCall: 3, transferDelayMs: 0 };

let health = null;
let stack = null;
let clockLocked = false;
let resetLocked = false;
let sending = false;
let roomLang = "en-US";
let phoneSig = "";
let view = blankView();

/** What the console has learned about the call on screen, beyond its snapshot. */
function blankView() {
  return {
    snap: null,
    callerName: null, // a label from CALLERS; the server only has the number
    callerLang: "en-US", // the language the caller speaks, for the room voice
    events: new Set(), // event kinds seen on this call
    faqs: [], // every search on this call; the snapshot keeps only the last
    texts: new Map(), // id → text, from snapshots and sms frames
    shownTexts: new Set(), // texts already on the phone, so only new ones animate
    emergency: null,
    handoff: null,
    missed: false, // the transfer request was accepted, then nobody answered
    closed: null, // the department that was closed when the caller asked for it
    frozenMs: null,
    syncedAt: 0,
  };
}

const terminal = (snap) => TERMINAL.has(snap?.state);
const isEmergency = (snap) => Boolean(view.emergency ?? snap?.emergency) || String(snap?.outcome ?? "").startsWith("emergency");
const isSpanish = (lang) => String(lang ?? "").startsWith("es");
const words = (id) => String(id ?? "").replace(/[-_]/g, " ");
const deptName = (id) => DEPARTMENTS[id] ?? words(id);
const callerLabel = () => view.callerName?.split(" ")[0] ?? "Caller";
const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

const stackNodes = () =>
  voiceStack({
    voiceLive: health?.voiceLive?.model ?? "gpt-realtime",
    tools: "311 policy",
    toolsSim: "real policy code",
    agent: "311 staff in Teams",
    agentSim: "mock toast",
  });

// ------------------------------------------------------------------ wiring

const voice = createVoice($("voice"), { lang: "en-US" });

/**
 * The room voice follows the caller's language, so Lucía's lines are read in
 * a Spanish voice. The switch waits for the agent to finish its line first.
 */
const roomVoice = {
  async speak(role, text) {
    if (role === "caller") await useLang(view.callerLang);
    return voice.speak(role, text);
  },
  idle: () => voice.idle(),
  cancel: () => voice.cancel(),
};

const clock = mountClock($("clock"), { onChange: () => render() });
const transcript = createTranscript($("transcript"), {
  voice,
  empty: "Answer a call, or press Next ▶ to run the demo script.",
});
const trail = createTrail($("events"), {
  good: ["faq_answered", "duplicate_attached", "location_confirmed", "guided_completed"],
  warn: ["faq_refused", "complaint", "failed_attempt", "location_rejected", "location_unresolved", "budget_wrap_up"],
  timeZone: () => clock.state?.timeZone,
  empty: "Every tool call, rule and handoff shows up here.",
});
const session = createCallSession({ voice, onMessage, onFollow: () => clearPanels() });
connectHub((target, payload) => session.handle(target, payload), {
  onOpen: ({ reconnected }) => reconnected && refreshAll(),
});
const sim = createSimulator({ session, startBody, onSnapshot: applySnapshot, actions: { metrics: showMetrics } });
const director = createDirector($("director"), {
  beats: createBeats({ setClock, resetDemo }),
  perform,
  voice: roomVoice,
  sayInput: els.sayInput,
  onBeat: () => {
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: "smooth" });
  },
});

setInterval(tickBudget, 500);
boot();

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
  const phone = "fromPhone" in step ? (step.fromPhone ?? "") : els.callerSelect.value;
  els.callerSelect.value = phone;
  return { fromPhone: phone || null };
}

/** Director and button steps. A new call hangs up the one on screen first. */
async function perform(step) {
  if (step.type === "start") {
    // A quick Next shouldn't cancel a handoff that is about to land.
    const deadline = performance.now() + settings.transferDelayMs + 3000;
    while (view.snap?.state === "transferring" && performance.now() < deadline) await sleep(100);
    if (session.id && !session.finished && !session.followed) await sim.hangup().catch(() => {});
    clearPanels();
    const phone = "fromPhone" in step ? (step.fromPhone ?? "") : els.callerSelect.value;
    const caller = phone ? CALLERS.find((c) => c.phone === phone) : null;
    view.callerName = caller?.name ?? null;
    view.callerLang = step.lang ?? caller?.lang ?? "en-US";
    // Every call is answered in English; the caller's first line may switch it.
    await useLang("en-US");
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

/** Beat 1 starts from a clean stage, so Alex's pothole is filed fresh every time. */
async function resetDemo() {
  let result;
  try {
    result = await postJson("/api/demo/reset");
  } catch (error) {
    if (error.status !== 403) throw error;
    if (!resetLocked) {
      resetLocked = true;
      notify("This server answers real calls, so the demo isn't reset.", "warn", 6000);
    }
    return false;
  }
  session.reset();
  clearPanels();
  setRoomLang("en-US");
  renderStats(result.stats);
  await clock.refresh();
  return true;
}

/** Before a caller line or a new call: let the current line finish, then switch. */
async function useLang(lang) {
  if (!lang || lang === roomLang) return;
  await voice.idle();
  setRoomLang(lang);
}

function setRoomLang(lang) {
  if (!lang || lang === roomLang) return;
  roomLang = lang;
  voice.setLang(lang);
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
        label: payload.role === "agent" ? AGENT : payload.role === "caller" ? callerLabel() : undefined,
      });
      break;
    case "event":
      onEvent(payload);
      break;
    case "decision":
      if (view.snap) {
        view.snap = { ...view.snap, decision: payload };
        render();
      }
      break;
    case "language":
      setRoomLang(payload.language);
      transcript.system(
        `Caller switched to ${isSpanish(payload.language) ? "Spanish" : "English"} — agent locale ${payload.agentLocale}, voice ${payload.voice}`,
      );
      if (view.snap) view.snap = { ...view.snap, language: payload.language };
      render();
      break;
    case "emergency":
      view.emergency = payload;
      transcript.system(`⚠ Emergency rule fired on “${payload.matched ?? payload.label}” — no report, no questions`);
      render();
      break;
    case "faq":
      onFaq(payload);
      break;
    case "location":
      onLocation(payload);
      break;
    case "case":
      onCase(payload);
      break;
    case "bulk":
      if (payload.items?.length) transcript.tool("bulk_pickup", `${payload.items.map(words).join(", ")} · on the accepted list`, "ok");
      break;
    case "complaint":
      transcript.tool("log_complaint", [payload.topic, payload.sentiment].filter(Boolean).join(" · "), "warn");
      break;
    case "sms":
      onText(payload);
      render();
      break;
    case "handoff":
      onHandoff(payload);
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
  // Anything the hub missed (a reconnect, a response that beat its frames).
  for (const text of snap.texts ?? []) onText(text);
  if (snap.emergency && !view.emergency) view.emergency = snap.emergency;
  if (snap.faq && !view.faqs.some((f) => f.at === snap.faq.at)) view.faqs.push(snap.faq);
  if (snap.handoff && !view.handoff) onHandoff(snap.handoff);
  // ACS accepted the transfer request, then nobody answered: the toast stops ringing.
  if (snap.outcome === "transfer_failed" && view.handoff && !view.missed) {
    view.missed = true;
    renderHandoff();
  }

  if (terminal(snap) && (!terminal(prev) || prev.outcome !== snap.outcome)) refreshStats({ highlight: true });
  render();
}

function onEvent(e) {
  trail.add(e);
  view.events.add(e.kind);
  const detail = String(e.detail ?? "");
  switch (e.kind) {
    case "request_started":
      transcript.tool("start_request", words(detail), "accent");
      break;
    case "field_set":
      transcript.tool("set_field", words(detail), "accent");
      break;
    case "location_confirmed":
      transcript.tool("confirm_location", "caller said yes", "ok");
      break;
    case "location_rejected":
      transcript.tool("confirm_location", "caller said no — ask again", "warn");
      break;
    case "contact_set":
      transcript.tool("set_contact", detail === "updates" ? "text updates, with consent" : "no texts", detail === "updates" ? "ok" : "accent");
      break;
    case "case_status":
      transcript.tool("get_case_status", detail, detail.startsWith("not found") ? "warn" : "ok");
      break;
    case "sms_link_sent":
      transcript.tool("send_form_link", words(detail), "ok");
      break;
    case "repeat":
      transcript.tool("repeat_last", "the caller asked to hear it again", "accent");
      break;
    case "transfer_after_hours":
      view.closed = detail;
      transcript.system(`${deptName(detail)} is closed — no transfer into an empty queue`);
      break;
    case "priority_after_hours":
      transcript.system(`After hours — flagged for ${deptName(detail)} first thing on the next business day`);
      break;
    case "no_input":
      transcript.system("— the caller says nothing —");
      break;
    case "failed_attempt":
      transcript.system("— not understood —");
      break;
    case "dtmf_ignored":
      transcript.system(`Key ${detail} isn't on the menu — ignored`);
      break;
    case "budget_wrap_up":
      transcript.system("Time is nearly up — the agent wraps up");
      break;
    case "transfer_succeeded":
      transcript.system(`↪ Transfer to ${deptName(detail)} accepted`);
      break;
    case "transfer_failed": {
      // "public-works: No answer" — the department, then what ACS reported.
      const [dept, ...why] = detail.split(": ");
      const reason = why.join(": ") || "no reason given";
      transcript.system(
        e.meta?.accepted
          ? `Nobody at ${deptName(dept)} picked up (${reason}) — the agent apologizes and ends the call`
          : `Transfer to ${deptName(dept)} failed: ${reason}`,
      );
      break;
    }
    case "sms_failed":
      transcript.system(`Text not sent: ${detail}`);
      break;
    case "error":
      transcript.system(`Error: ${detail}`);
      break;
  }
  render();
}

function onFaq(found) {
  if (!view.faqs.some((f) => f.at === found.at)) view.faqs.push(found);
  const p = found.passages?.[0];
  if (p) transcript.tool("search_faq", `${p.title} · ${p.source}`, p.freshness === "stale" ? "warn" : "ok");
  else transcript.tool("search_faq", found.withheld?.length ? "no approved match — expired content withheld" : "no approved match", "warn");
  render();
}

function onLocation(l) {
  if (l.ok) transcript.tool("resolve_location", `${l.normalized}${l.zone ? ` · zone ${l.zone}` : ""}`, "ok");
  else if (l.ambiguous) transcript.tool("resolve_location", "more than one match — ask again", "warn");
  else transcript.tool("resolve_location", "not found — no guessing", "warn");
}

function onCase(card) {
  if (card.type === "bulk-pickup") transcript.tool("confirm_bulk_pickup", `${card.id} · ${when(card.due)}`, "ok");
  else if (card.duplicate && card.escalated) transcript.tool("submit_request", `already reported — added to ${card.id} · raised to priority`, "warn");
  else if (card.duplicate) transcript.tool("submit_request", `already reported — added to ${card.id}`, "ok");
  else transcript.tool("submit_request", `${card.id} · ${card.priority ? "priority" : "standard"}`, "ok");
}

/** A text the server sent — or, in simulation, pretended to send. */
function onText(text) {
  const known = view.texts.get(text.id);
  view.texts.set(text.id, { ...known, ...text });
  if (!known) {
    transcript.system(
      `✉ Text to ${text.to ?? "the caller"} — ${text.simulated ? "simulated, not sent" : "sending through Azure Communication Services"}`,
    );
  }
}

function onHandoff(h) {
  const first = !view.handoff;
  const same = view.handoff?.at === h.at;
  view.handoff = h;
  if (first) {
    transcript.tool("transfer", `${h.departmentName} · ${h.reasonLabel}`, "accent");
    transcript.system(`↪ Handing off to ${h.departmentName} in Teams — the context travels with the call`);
  }
  if (!same) renderHandoff();
}

// ----------------------------------------------------------------- render

function render() {
  const snap = view.snap;
  setStateChip(els.stateChip, snap?.state ?? null, stateTone(snap));
  renderLangChip(snap);
  renderControls();
  renderDecision(els.decision, { ...decision(snap), empty: "Answer a call to see what the server decides." });
  renderChecks(els.checks, checks(snap));
  renderRecord(snap);
  renderSources();
  renderPhone();
  renderToastPlaceholder();
  tickBudget();
}

function stateTone(snap) {
  const state = snap?.state;
  if (!state) return "idle";
  if (state === "emergency_redirect" || (state === "ended" && isEmergency(snap))) return "err";
  if (state === "filed" || state === "transferred") return "ok";
  if (state === "guided") return "accent";
  if (state === "ended" && snap.outcome === "transfer_failed") return "err";
  if (state === "ended") return snap.outcome === "completed" ? "ok" : "muted";
  return toneOf(state);
}

function renderLangChip(snap) {
  const spanish = isSpanish(snap?.language);
  els.langChip.hidden = !spanish;
  els.langChip.innerHTML = spanish ? chip(`Español · ${snap.agentLocale ?? "es-US"}`, "accent") : "";
}

function renderControls() {
  const active = Boolean(session.id && !session.finished && !session.followed && view.snap && !terminal(view.snap));
  for (const el of [els.sayInput, els.sayBtn, els.silence, els.hangup]) el.disabled = !active;
  for (const button of els.keys.querySelectorAll("button")) button.disabled = !active;
}

function renderCallers() {
  els.callerSelect.innerHTML = CALLERS.map(
    (c) => `<option value="${escapeHtml(c.phone)}">${escapeHtml(c.name)}</option>`,
  ).join("");
}

/** The headline: what the server decided, and why, in plain English. */
function decision(snap) {
  if (!snap) return {};
  if (snap.state === "ended") {
    if (snap.outcome === "caller_hung_up") {
      return {
        headline: "The caller hung up",
        why: snap.lastCase ? `${snap.lastCase.id} stays filed.` : "Nothing was filed for this call.",
        verdict: "call ended",
        tone: "muted",
      };
    }
    if (snap.outcome === "two_no_inputs") {
      return {
        headline: "Nothing heard twice",
        why: "The agent asked once, offered a person, then said goodbye instead of holding an open line.",
        verdict: "two silences → polite close",
        tone: "warn",
      };
    }
    if (snap.outcome === "time_budget_expired") {
      return {
        headline: "Out of time",
        why: "The call reached its time budget, so the agent closed it politely.",
        verdict: "time budget → polite close",
        tone: "warn",
      };
    }
  }
  const d = snap.decision;
  if (!d) {
    return {
      headline: "Listening…",
      why: "Every caller turn is checked for an emergency before the model gets a turn.",
      verdict: "nothing to decide yet",
      tone: "accent",
    };
  }
  return { headline: d.title, why: d.detail, verdict: d.verdict, tone: TONES[d.tone] ?? "muted" };
}

// ------------------------------------------------------- the rules on the call

function checks(snap) {
  return [emergencyCheck(snap), locationCheck(snap), answerCheck(), textCheck(snap), personCheck(snap)];
}

function emergencyCheck(snap) {
  const em = view.emergency ?? snap?.emergency;
  if (em) {
    return {
      label: "Emergency rule fired — normal service stopped",
      detail: `Heard “${em.matched ?? em.label}” → safety guidance, then ${em.redirect}. No report, no questions.`,
      tone: "err",
    };
  }
  return { label: "Emergency rule armed", detail: "Checked on every caller turn, before the model replies", tone: "idle" };
}

function locationCheck(snap) {
  const cur = snap?.current;
  const card = snap?.lastCase;
  const loc = cur?.location;
  if (snap?.pending === "confirm-location" && loc) {
    return { label: "Reading the location back", detail: `${loc.normalized} — nothing is filed until the caller says yes`, tone: "warn" };
  }
  if (cur?.locationHint && !loc) {
    return { label: "More than one match — asking which one", detail: `“${cur.locationHint}” — no guessing`, tone: "warn" };
  }
  if (cur && !loc && view.events.has("location_unresolved")) {
    return { label: "Location not verified — asking again", detail: "Nothing is filed against a guessed address", tone: "warn" };
  }
  if (cur && !loc && view.events.has("location_rejected")) {
    return { label: "The caller said no — asking again", detail: "The read-back caught it before anything was filed", tone: "warn" };
  }
  if (cur && loc && cur.confirmedLocation) {
    return { label: "Location confirmed by the caller", detail: `${loc.normalized}${loc.zone ? ` · zone ${loc.zone}` : ""}`, tone: "ok" };
  }
  if (card?.location) {
    const place = `${card.location}${card.zone && !/^Zone /.test(card.location) ? ` · zone ${card.zone}` : ""}`;
    if (card.type === "bulk-pickup" && /^Zone [A-Z]$/.test(card.location)) {
      return { label: "No verified address — zone calendar used", detail: place, tone: "warn" };
    }
    return {
      label: card.type === "bulk-pickup" ? "Pickup address verified" : "Filed against a verified location",
      detail: card.type === "bulk-pickup" ? `${place} — the zone sets the pickup date` : `${place} — read back and confirmed`,
      tone: "ok",
    };
  }
  return { label: "No request without a verified location", detail: "The geocoder resolves it; the caller confirms it", tone: "idle" };
}

function answerCheck() {
  const last = view.faqs.at(-1);
  if (!last) return { label: "Answers only from approved content", detail: "Reviewed, unexpired articles, with the source named", tone: "idle" };
  const p = last.passages?.[0];
  if (p && p.freshness === "stale") {
    return { label: "Answered with a caveat", detail: `${p.title} · reviewed ${p.lastReviewed} — may need confirmation`, tone: "warn" };
  }
  if (p) return { label: "Answered from approved content", detail: `${p.title} · ${p.source} · reviewed ${p.lastReviewed}`, tone: "ok" };
  return {
    label: "No approved answer — no guess",
    detail: last.withheld?.length
      ? `Withheld as expired: ${last.withheld.map((w) => w.title).join(", ")}`
      : "Nothing approved matches, so 311 staff are offered",
    tone: "warn",
  };
}

function textCheck(snap) {
  const texts = [...view.texts.values()];
  if (texts.length) {
    const simulated = texts.every((t) => t.simulated);
    return {
      label: `${texts.length === 1 ? "A text" : `${texts.length} texts`}, with consent`,
      detail: `To ${texts[0].to ?? "the caller"} — ${simulated ? "simulated, never sent" : "sent by SMS"}`,
      tone: "ok",
    };
  }
  if (snap?.pending === "updates") return { label: "Asking before texting", detail: "A text goes out only if the caller says yes", tone: "warn" };
  if (snap && view.events.has("contact_set") && !snap.maskedPhone) {
    return { label: "No texts — number withheld", detail: "Nothing to text, nothing stored", tone: "idle" };
  }
  if (view.events.has("contact_set")) {
    return { label: "No texts — the caller said no", detail: "The number stays on the server", tone: "ok" };
  }
  if (snap && !snap.maskedPhone) return { label: "No texts — number withheld", detail: "Nothing to text, nothing stored", tone: "idle" };
  return { label: "Texts only with consent", detail: "The number stays on the server; the model never sees it", tone: "idle" };
}

function personCheck(snap) {
  const h = view.handoff;
  if (h && snap?.outcome === "transfer_failed") {
    return { label: `Nobody at ${h.departmentName} picked up`, detail: "An apology and what still stands, then goodbye — the queue isn't dialed again", tone: "warn" };
  }
  if (h) return { label: `Handed to ${h.departmentName}`, detail: `${h.reasonLabel} — topic, summary and language travel with the call`, tone: "ok" };
  if (view.closed) {
    return { label: `${deptName(view.closed)} is closed`, detail: "No transfer into an empty queue; the caller can still report or ask", tone: "warn" };
  }
  if (snap?.pending === "complaint" || snap?.pending === "offer-person") {
    return { label: "Offering a person", detail: "Say yes, or press 0", tone: "accent" };
  }
  return { label: "A person, whenever asked", detail: "Say “a person”, or press 0", tone: "idle" };
}

// ------------------------------------------------------------- the record

/** The service request as it takes shape: intake, then the filed case. */
function renderRecord(snap) {
  const em = view.emergency ?? snap?.emergency;
  const card = snap?.lastCase;
  const cur = snap?.current;
  const bulk = snap?.bulk;
  const complaint = snap?.complaint;
  const faqOnly = view.faqs.length && !em && !card && !cur && !bulk && !complaint;
  els.recordBlock.hidden = Boolean(faqOnly);
  if (faqOnly) return;

  let head = "Service request";
  let note = "nothing filed yet";
  let rows;

  if (em) {
    head = "Emergency";
    note = "no report, by rule";
    rows = [
      ["Heard", `“${em.matched ?? em.label}”`, { tone: "err" }],
      ["Category", em.label, { tone: "err" }],
      ["Sent to", em.redirect],
      ["Service request", "none — the emergency rule skips intake"],
      em.cancelledIntake && ["Intake stopped", words(em.cancelledIntake)],
    ];
  } else if (cur) {
    const loc = cur.location;
    note = "in progress — not filed yet";
    rows = [
      ["Request", cur.label],
      [
        "Location",
        loc ? `${loc.normalized}${loc.zone ? ` · zone ${loc.zone}` : ""}` : cur.locationHint ? `“${cur.locationHint}” — which one?` : "",
        { tone: loc ? (cur.confirmedLocation ? "ok" : "warn") : cur.locationHint ? "warn" : undefined },
      ],
      [
        "Location check",
        cur.confirmedLocation ? "confirmed by the caller" : loc ? "read back — waiting for a yes" : cur.locationHint ? "more than one match" : "not verified yet",
      ],
      ["Still needed", cur.missing?.length ? cur.missing.map(words).join(", ") : "nothing — ready to file"],
      ["Status", "not filed yet"],
    ];
  } else if (bulk && !card) {
    head = "Bulk pickup";
    note = "scheduling";
    rows = [
      ["Items", bulk.items?.length ? bulk.items.map(words).join(", ") : "", { tone: bulk.items?.length ? "ok" : undefined }],
      ["Check", bulk.items?.length ? "every item is on the accepted list" : "waiting for the items"],
      ["Address", "not given yet"],
      ["Pickup date", "not scheduled yet"],
    ];
  } else if (card) {
    const isBulk = card.type === "bulk-pickup";
    head = isBulk ? "Bulk pickup" : "Service request";
    note = snap.cases?.length > 1 ? `${snap.cases.length} requests on this call` : card.simulated ? "filed — simulated" : "filed";
    const place = [card.location, card.zone && !/^Zone /.test(card.location ?? "") ? `zone ${card.zone}` : null].filter(Boolean).join(" · ");
    rows = [
      ["Request", `${card.id}${card.meToo > 1 ? ` · ${card.meToo} callers` : ""}`, { tone: "ok" }],
      ["Category", capitalize(card.label)],
      ["Department", card.departmentName],
      ["Location", place],
      isBulk
        ? ["Items", (card.fields?.items ?? []).map(words).join(", ")]
        : ["Priority", card.priority ? (card.escalatedAt ? "Priority hazard · raised by a later report" : "Priority hazard") : "Standard", { tone: card.priority ? "warn" : undefined }],
      isBulk
        ? ["Pickup date", when(card.due), { tone: "ok" }]
        : ["Response target", card.due ? `${card.slaText} · due ${when(card.due)}` : card.slaText],
      ["Status", `${words(card.status)}${card.simulated ? " · simulated" : ""}`],
    ];
  } else if (complaint) {
    head = "Complaint";
    note = "not filed as a request";
    rows = [
      ["About", complaint.topic],
      ["Sentiment", snap.sentiment, { tone: snap.sentiment && snap.sentiment !== "neutral" ? "warn" : undefined }],
      ["Next step", "a report or a person — no promises made"],
    ];
  } else {
    rows = [
      ["Request", ""],
      ["Location", ""],
      ["Response target", ""],
    ];
  }

  els.caseHead.textContent = head;
  els.caseNote.textContent = note;
  renderFacts(els.caseFacts, rows);
}

/** "2026-10-07" is a calendar date; anything longer is an instant, shown on the demo clock's zone. */
function when(value) {
  if (!value) return "";
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(`${s}T12:00:00Z`).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  }
  return inZone(s, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function inZone(iso, options) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return String(iso);
  try {
    return t.toLocaleString("en-US", { ...options, timeZone: clock.state?.timeZone });
  } catch {
    return t.toLocaleString("en-US", options); // unknown zone name
  }
}

/** Every article the call touched: what was read out, and what was withheld. */
function renderSources() {
  els.faqBlock.hidden = !view.faqs.length;
  if (!view.faqs.length) return;
  const items = [];
  const seen = new Set();
  for (const f of view.faqs) {
    (f.passages ?? []).forEach((p, i) => {
      if (seen.has(p.id)) return;
      seen.add(p.id);
      const stale = p.freshness === "stale";
      items.push({
        label: p.title,
        meta: `${p.source} · reviewed ${p.lastReviewed}`,
        status: i ? "approved · not needed" : stale ? "approved · caveat" : "approved · read out",
        tone: i ? "muted" : stale ? "warn" : "ok",
      });
    });
    for (const w of f.withheld ?? []) {
      if (seen.has(w.id)) continue;
      seen.add(w.id);
      items.push({ label: w.title, meta: `${w.source} · reviewed ${w.lastReviewed}`, status: "expired · withheld", tone: "err", withheld: true });
    }
    if (!f.passages?.length && !f.withheld?.length) {
      items.push({ label: `“${f.query}”`, meta: "no approved article", status: "not answered", tone: "warn" });
    }
  }
  renderList(els.sources, items, { empty: "No question asked yet." });
  [...els.sources.children].forEach((li, i) => li.classList.toggle("withheld", Boolean(items[i]?.withheld)));
}

// ------------------------------------------------------- the caller's phone

function renderPhone() {
  const snap = view.snap;
  const texts = [...view.texts.values()];
  const to = snap ? (snap.maskedPhone ? `to ${snap.maskedPhone}` : "number withheld") : "text messages";
  const sig = JSON.stringify([to, texts.map((t) => [t.id, t.status]), Boolean(snap)]);
  if (sig === phoneSig) return;
  phoneSig = sig;

  let body;
  if (texts.length) {
    body = texts
      .map((t) => {
        const fresh = !view.shownTexts.has(t.id);
        view.shownTexts.add(t.id);
        return `<div class="sms"${fresh ? ' data-fresh="true"' : ""}>${smsHtml(t)}<span class="sms-meta">${escapeHtml(
          TEXT_STATUS[t.status] ?? words(t.status),
        )} · ${escapeHtml(inZone(t.at, { hour: "numeric", minute: "2-digit" }))}</span></div>`;
      })
      .join("");
  } else {
    const message = !snap
      ? "Texts appear here. In simulation they are never sent."
      : !snap.maskedPhone
        ? "Number withheld — no texts on this call."
        : "No texts on this call. A text goes out only when the caller says yes.";
    body = `<p class="phone-empty">${escapeHtml(message)}</p>`;
  }
  els.phone.innerHTML = `
    <div class="phone-head"><span class="phone-avatar" aria-hidden="true">311</span>
      <div><strong>City of Contoso 311</strong><span class="muted">${escapeHtml(to)}</span></div></div>
    <div class="phone-body">${body}</div>`;
}

/** The text, with its link shown — but not clickable: the case page is fictional. */
function smsHtml(t) {
  const text = escapeHtml(t.text ?? "");
  if (!t.link) return `<p>${text}</p>`;
  const link = escapeHtml(t.link);
  return `<p>${text.split(link).join(`<span class="sms-link">${link}</span>`)}</p>`;
}

// ----------------------------------------------------------------- budget

function budgetStop(snap) {
  if (snap.state === "transferred") return { text: "handed off", tone: "ok" };
  if (snap.state === "ended") return isEmergency(snap) ? { text: "emergency", tone: "err" } : { text: "ended", tone: "muted" };
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
  renderBudget(els.budget, { elapsedMs, budgetMs: snap.budgetMs ?? settings.callTimeBudgetMs });
  const parts = els.budget.pkBudget;
  if (stop && parts && !els.budget.hidden) {
    parts.label.textContent += ` · ${stop.text}`;
    parts.fill.dataset.tone = stop.tone;
  }
}

// ------------------------------------------------------------ Teams side

function renderHandoff() {
  const h = view.handoff;
  if (!h) return;
  const mood = capitalize(h.sentiment);
  // The summary names the sentiment too; the toast shows it on its own line.
  const context = String(h.summary ?? "")
    .split(/(?<=\.)\s+/)
    .filter((s) => s && !/^Caller sounds /i.test(s) && !sameWords(s, h.callTopic) && !sameWords(s, h.reasonLabel))
    .join(" ");
  const tags = (h.tags ?? [])
    .filter((t) => t !== mood)
    .map((t) => ({
      text: t,
      tone: t === h.reasonLabel ? "teams" : t === "Priority" ? "warn" : t === "Español" ? "accent" : "muted",
    }));
  if (h.afterHours) tags.push({ text: "after hours", tone: "warn" });
  const language = isSpanish(h.language) ? "Spanish · es-US" : `English · ${h.language ?? "en-US"}`;
  const callerHtml = `<strong>${escapeHtml(h.maskedPhone ? `Caller ${h.maskedPhone}` : "Number withheld")}</strong><div class="muted">${escapeHtml(
    h.caseNumber ? `Case ${h.caseNumber}` : "No case on this call",
  )} · ${escapeHtml(language)}</div>`;

  renderTeamsToast(els.toast, {
    queue: h.queue,
    subtitle: `${h.departmentName} · handed off by the 311 assistant`,
    topic: h.callTopic,
    context,
    sentiment: h.sentiment && h.sentiment !== "neutral" ? `Caller sounds ${h.sentiment}` : "",
    callerHtml,
    avatar: h.departmentName,
    tags,
    status: view.missed ? "Not answered" : "Incoming call",
  });
  els.toast.classList.toggle("missed", view.missed);
  els.toastEmpty.hidden = true;
  // Built on the server by the same function the real transfer uses.
  renderHeaders(els.headers, (h.voipHeaders ?? []).map((x) => [x.key, x.value]));
}

/** A short summary can be the topic again. Say it once. */
function sameWords(a, b) {
  const plain = (s) =>
    String(s ?? "")
      .replace(/[“”"…,.!?:\s]+/g, " ")
      .trim()
      .toLowerCase();
  return Boolean(a) && plain(a) === plain(b);
}

function renderToastPlaceholder() {
  if (view.handoff) return;
  const snap = view.snap;
  const em = view.emergency ?? snap?.emergency;
  els.toastEmpty.textContent = !snap
    ? "No call has been handed to a person yet."
    : em
      ? `No handoff to 311 staff — the emergency rule sends the caller to ${em.redirect}.`
      : view.closed
        ? `${deptName(view.closed)} is closed — no transfer into an empty queue.`
        : snap.state === "ended" && snap.lastCase
          ? `Resolved by the assistant — ${snap.lastCase.id} filed, no person needed.`
          : snap.state === "ended" && view.faqs.some((f) => f.answered)
            ? "Answered by the assistant — no person needed."
            : snap.state === "ended"
              ? "The call ended without a handoff."
              : "No call has been handed to a person yet.";
}

// ---------------------------------------------------------------- metrics

function renderStats(stats) {
  if (!stats) return;
  renderMetrics(els.metrics, [
    ["Calls", stats.calls],
    ["Requests created", stats.requestsCreated],
    ["Emergencies escalated", stats.emergenciesEscalated],
    ["Answered from approved content", stats.answered],
    ["Handed to a person", stats.handedOff],
    ["Texts with consent", stats.texts],
    ["Calls in Spanish", stats.spanishCalls],
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
  const live = renderMode(els.mode, health);
  els.reset.disabled = live;
  if (live) els.reset.title = "Demo controls are off while this server answers real calls.";
  for (const key of Object.keys(settings)) {
    const value = health.settings?.[key];
    if (typeof value === "number") settings[key] = value;
  }
  els.phoneNote.textContent = live ? "real texts, only with consent" : "simulated — never sent";
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
  phoneSig = "";
  transcript.clear();
  trail.clear();
  clearTeamsToast(els.toast, els.toastEmpty);
  els.toast.classList.remove("missed");
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
    await roomVoice.speak("caller", text);
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
    if (!(await resetDemo())) return;
    director.load(0);
    notify("Demo reset — no calls, requests or texts; starting clock; beat 1.", "ok");
  } catch (error) {
    notify(error.message, "err");
  }
});
