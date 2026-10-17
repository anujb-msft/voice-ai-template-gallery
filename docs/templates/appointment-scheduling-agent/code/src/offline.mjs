/**
 * Offline stand-in for the Voice Live model.
 *
 * This is NOT the conversation engine. On a configured call, Voice Live
 * listens, picks the tool and speaks. This keyword driver exists so the sample
 * runs end to end with no Azure subscription: each typed line passes the same
 * server gate (flow.callerSaid) and the same tool dispatcher (dispatchTool) a
 * live call uses, so identity, eligibility, holds, the caller's yes and every
 * handoff run on the real code path. Only the language understanding and the
 * audio are stubs, and it is deliberately simple so nobody mistakes it for the
 * real thing.
 *
 * It has exactly the model's tools, so it cannot book either. The only write
 * is the caller's own yes to the active proposal, which the server takes.
 *
 *   npm run offline -- --script race
 *   npm run offline -- --say "Jordan Rivera, 03/12/1984|I need a follow-up with Dr. Patel|the second one|yes"
 */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { CLOCK_PRESETS, DEFAULT_DEMO_NOW } from "./config.mjs";
import { STATES, SchedulingFlow, TERMINAL, chooseCode, isAffirmative, parseIdentity, prefArgs } from "./flow.mjs";
import { dispatchTool } from "./tools.mjs";

const REFERRAL = /\breferral coordinator\b|\b(?:connect|transfer|put) me (?:through )?(?:to|with) (?:the |a )?referral/i;
const NURSE = /\b(?:talk|speak) (?:to|with) (?:a |the )?nurse\b|\bnurse line\b/i;
const HUMAN = /\b(?:person|human|somebody|someone|representative|operator|scheduler|front desk|receptionist|real agent|live agent)\b/i;
const NEW_PATIENT = /\bnew patient\b|\bnever been (?:seen|there|here)\b/i;
const CALLBACK = /\bcall (?:me )?back\b|\bcallback\b/i;
const REPEAT = /\b(?:repeat that|say that again|come again|what was that|pardon)\b/i;
const GOODBYE = /\b(?:goodbye|bye|that's all|nothing else|hang up)\b/i;
const CANCEL = /\bcancel\b/i;
const RESCHEDULE = /\breschedul|\bmove (?:my|the|it)\b|\bchange (?:my|the) (?:appointment|time)\b/i;
const UPCOMING = /\b(?:my appointments|upcoming|what do i have|when is my)\b/i;
const WAITLIST = /\bwait ?list\b/i;
const DAY_PART = /\b(morning|afternoon|evening)s?\b/i;
const SYMPTOM_VISITS = new Set(["NEW_PROBLEM", "DERM_NEW_PROBLEM", "DERM_SKIN_CHECK"]);

/** What the driver remembers between turns, as a model's context would: half an identity, a pending cancel or reschedule. */
const memory = new Map();
const memo = (callId) => memory.get(callId) ?? memory.set(callId, {}).get(callId);

/**
 * Stands in for the Voice Live agent handle the real bridge registers. It
 * speaks the line the flow supplies with each instruction. A quiet nudge is a
 * note to the model only, so it is not spoken here either.
 */
export function registerSimulatedAgent(flow, callId) {
  memory.delete(callId);
  flow.registerAgent(callId, {
    instruct: (_instruction, spoken) => {
      if (spoken) flow.pushTranscript(callId, "agent", spoken);
    },
    nudge: () => {},
  });
}

/**
 * One typed caller line, taken exactly as a live call takes it: the server
 * gate first (safety words, the caller's yes or no to an active proposal, a
 * "just book it" with nothing proposed), then the model's turn.
 */
export function handleUtterance(flow, callId, text) {
  const said = String(text ?? "").trim();
  const call = flow.get(callId);
  if (!call) return { ok: false, error: "unknown_call" };
  if (TERMINAL.has(call.state)) {
    memory.delete(callId);
    return { ok: false, error: "call_finished" };
  }
  if (!said) return flow.noInput(callId);
  flow.pushTranscript(callId, "caller", said);
  if (/^[0-9*#]$/.test(said)) {
    const keyed = flow.dtmf(callId, said);
    return keyed.handled ? keyed : flow.notUnderstood(callId);
  }
  const gate = flow.callerSaid(callId, said);
  if (gate.handled) return gate;
  // The server refused to write. The model was told why; here the driver says it.
  if (gate.refused) return flow.askAgain(callId, gate.say);
  if (call.state === STATES.ESCALATING) return gate;
  return modelTurn(flow, call, said);
}

function modelTurn(flow, call, said) {
  const tool = (name, args = {}) => dispatchTool(flow, call.id, name, args);
  const mem = memo(call.id);

  if (REFERRAL.test(said)) return tool("transfer", { destination: "referral_coordinator", reason: "referral_required" });
  if (NURSE.test(said)) return tool("transfer", { destination: "nurse_line", reason: "caller_request" });
  if (HUMAN.test(said)) return tool("transfer", { destination: "scheduling_team", reason: "caller_request" });
  if (REPEAT.test(said)) return tool("repeat_last");
  if (GOODBYE.test(said)) return tool("end_call", { reason: "caller_said_goodbye" });

  if (call.state === STATES.REGISTERING || (NEW_PATIENT.test(said) && !call.patient)) {
    const digits = said.replace(/\D/g, "");
    return tool("request_callback", {
      queue: "registration_callback",
      callbackNumber: digits.length >= 10 ? digits : undefined,
      preferredTime: timeOfDay(said),
    });
  }
  if (CALLBACK.test(said)) return tool("request_callback", { queue: "scheduling_team", preferredTime: timeOfDay(said) });
  if (!call.patient) return identify(flow, call, said, mem);
  return schedule(flow, call, said, mem, tool);
}

/** Name and date of birth, possibly over two turns. The server decides whether they match. */
function identify(flow, call, said, mem) {
  const heard = parseIdentity(said);
  const name = heard.fullName && heard.fullName.split(" ").length >= 2 ? heard.fullName : null;
  if (!name && !heard.dob) return flow.notUnderstood(call.id);
  const fullName = name ?? mem.fullName ?? null;
  const dob = heard.dob ?? mem.dob ?? null;
  if (!fullName || !dob) {
    Object.assign(mem, { fullName, dob });
    return flow.askAgain(call.id, fullName ? "Thanks. And the patient's date of birth?" : "Thanks. And the patient's full name?");
  }
  delete mem.fullName;
  delete mem.dob;
  return dispatchTool(flow, call.id, "verify_patient", { fullName, dob, proxyName: heard.proxyName ?? undefined });
}

function schedule(flow, call, said, mem, tool) {
  if (CANCEL.test(said)) mem.pending = "cancel";
  else if (RESCHEDULE.test(said)) mem.pending = "reschedule";
  if (mem.pending) {
    const handled = existingAppointment(call, said, mem, tool);
    if (handled) return handled;
  }
  if (UPCOMING.test(said)) return tool("list_upcoming");
  if (WAITLIST.test(said)) return tool("add_waitlist");

  if (call.state === STATES.OFFERING || call.state === STATES.CONFIRMING) {
    const optionIndex = pickIndex(call.options, said);
    if (optionIndex) return tool("hold_slot", { optionIndex });
  }

  const prefs = prefArgs(said);
  let code = chooseCode(said);
  // After a referral or order block, a named or usual doctor means a primary care visit instead.
  if (!code && call.blocked && prefs.providerPreference) code = "NEW_PROBLEM";
  if (code && code !== call.visitTypeCode) {
    if (SYMPTOM_VISITS.has(code) && !call.reason) {
      const noted = tool("note_reason", { text: said });
      if (noted.result !== "noted") return noted;
    }
    const chosen = tool("choose_visit_type", { code });
    if (chosen.result !== "eligible") return chosen;
    return tool("search_slots", prefs);
  }
  if (call.visitTypeCode && !call.blocked && Object.keys(prefs).length) return tool("search_slots", prefs);
  return flow.notUnderstood(call.id);
}

/** Cancel or reschedule: read the upcoming visits back first, then act on the one the caller names. */
function existingAppointment(call, said, mem, tool) {
  if (!mem.listed) {
    mem.listed = true;
    const listed = tool("list_upcoming");
    if (!listed.appointments?.length) delete mem.pending;
    return listed;
  }
  const entry = matchUpcoming(call.upcoming, said);
  if (!entry) return null;
  const action = mem.pending;
  delete mem.pending;
  delete mem.listed;
  return action === "cancel"
    ? tool("propose_cancel", { appointmentHandle: entry.handle })
    : tool("search_slots", { ...prefArgs(said), appointmentHandle: entry.handle });
}

function matchUpcoming(entries = [], said) {
  if (!entries.length) return null;
  const code = chooseCode(said);
  const byCode = code ? entries.filter((e) => e.visitTypeCode === code) : [];
  if (byCode.length === 1) return byCode[0];
  const index = pickIndex(entries, said);
  if (index) return entries[index - 1];
  return entries.length === 1 && (isAffirmative(said) || code) ? entries[0] : null;
}

/** "The second one", "the 11:45", "Thursday", "today": a 1-based pick from what was just read out, or null. */
function pickIndex(items = [], said) {
  if (!items.length) return null;
  const text = said.toLowerCase();
  const clock = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b/) ?? text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (clock) {
    const time = ` ${Number(clock[1])}:${clock[2] ?? "00"}${clock[3] ? ` ${clock[3].toUpperCase()}M` : ""}`;
    const hits = items.flatMap((item, i) => (String(item.label).includes(time) ? [i + 1] : []));
    if (hits.length === 1) return hits[0];
  }
  const day = text.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|today|tomorrow)\b/);
  if (day) {
    const hits = items.flatMap((item, i) => (dayMatches(item, day[1]) ? [i + 1] : []));
    if (hits.length === 1) return hits[0];
  }
  if (/\b(?:third|3rd)\b/.test(text)) return items.length >= 3 ? 3 : null;
  if (/\b(?:second|2nd|other one|the other|latter|last one|later one)\b/.test(text)) return items.length >= 2 ? 2 : null;
  if (/\b(?:first|1st|earlier one|earliest|former)\b/.test(text)) return 1;
  return items.length === 1 && (isAffirmative(said) || /\bthat one\b/.test(text)) ? 1 : null;
}

const dayMatches = (item, word) => (word === "today" || word === "tomorrow"
  ? String(item.spoken ?? "").toLowerCase().startsWith(word)
  : String(item.label).toLowerCase().startsWith(word.slice(0, 3)));

const timeOfDay = (said) => said.match(DAY_PART)?.[1]?.toLowerCase();

// ------------------------------------------------------------------ scripted runs

/**
 * The console's beats as typed scripts. `@take-slot` is the demo action that
 * books the read-back time out from under the caller; `@tool book` is a model
 * that tries to call a booking tool it does not have.
 */
export const SCRIPTS = {
  book: {
    phone: "+12065550142",
    lines: ["Jordan Rivera, 03/12/1984", "I've had a cough for a week and I'd like to see my usual doctor, mornings if possible.", "The first one.", "Yes, please."],
  },
  "book-whatever": {
    phone: "+12065550102",
    lines: ["Mia Chen, 02/18/1991", "Just book me whatever you have.", "A follow-up with Dr. Patel.", "@tool book", "The second one.", "Yes."],
  },
  race: {
    phone: "+12065550101",
    lines: ["Avery Stone, 06/09/1979", "A follow-up with Dr. Patel, please.", "The first one.", "@take-slot", "Yes, book it.", "The first one.", "Yes."],
  },
  referral: {
    phone: "+12065550142",
    lines: ["Jordan Rivera, 03/12/1984", "I'd like a skin check for a mole.", "Connect me with the referral coordinator."],
  },
  "identity-fails": {
    phone: "+12065550142",
    lines: ["Jordan Rivera, 03/21/1984", "Jordan Rivera, 12/03/1984"],
  },
};

/** One call against a fresh in-memory copy of the seeded schedule, on a pinned clock. */
export async function runOffline({ lines = SCRIPTS.book.lines, phone = SCRIPTS.book.phone, at = DEFAULT_DEMO_NOW, driver = "auto" } = {}) {
  const { ScheduleAdapter } = await import("./schedule-store.mjs");
  let clock = at ? Date.parse(at) : Date.now();
  if (!Number.isFinite(clock)) throw new Error(`Not an ISO 8601 timestamp: ${at}`);
  const schedule = await ScheduleAdapter.open({ dbPath: ":memory:", driver, now: () => new Date(clock) });
  try {
    const flow = new SchedulingFlow({ schedule, now: () => clock, options: { transferDelayMs: 0 } });
    const call = flow.create({ fromPhone: phone, simulated: true });
    registerSimulatedAgent(flow, call.id);
    flow.answered(call.id);
    const steps = [];
    for (const line of lines) {
      clock += 4_000;
      const step = String(line).trim();
      if (step === "@take-slot" || step.startsWith("@tool ")) {
        const after = flow.snapshot(call.id).transcript.length;
        const result = step === "@take-slot"
          ? flow.takeSlotForDemo(call.id)
          : dispatchTool(flow, call.id, step.slice(6).trim(), {});
        steps.push({ after, step, result });
      } else handleUtterance(flow, call.id, step);
    }
    await flow.settled(call.id);
    memory.delete(call.id);
    return { call: flow.snapshot(call.id), steps, schedule: schedule.stats() };
  } finally {
    schedule.close();
  }
}

function describeStep({ step, result }) {
  if (step === "@take-slot") {
    return result?.ok
      ? `(demo: the front desk books ${result.label} as ${result.appointmentId})`
      : `(demo: take-slot refused · ${result?.error ?? "unknown"})`;
  }
  const name = step.slice(6).trim();
  if (result?.refused) return `(model calls ${name} → refused · ${result.reason} · nothing written)`;
  return `(model calls ${name} → ${result?.ok === false ? result.error ?? "refused" : "ok"})`;
}

async function main(argv) {
  const { values: args } = parseArgs({
    args: argv,
    options: {
      script: { type: "string" },
      say: { type: "string" },
      phone: { type: "string" },
      preset: { type: "string" },
      at: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (args.help) {
    console.log(`Usage: npm run offline -- [--script ${Object.keys(SCRIPTS).join("|")}] [--say "line|line"] [--phone +1...] [--preset ${CLOCK_PRESETS.map((p) => p.id).join("|")}] [--at ISO] [--json]`);
    return;
  }
  const script = SCRIPTS[args.script ?? "book"];
  if (!script && !args.say) throw new Error(`Unknown script "${args.script}". Use one of: ${Object.keys(SCRIPTS).join(", ")}, or --say "line|line".`);
  const preset = args.preset ? CLOCK_PRESETS.find((p) => p.id === args.preset) : null;
  if (args.preset && !preset) throw new Error(`Unknown clock preset "${args.preset}". Use one of: ${CLOCK_PRESETS.map((p) => p.id).join(", ")}.`);
  const result = await runOffline({
    lines: args.say ? args.say.split("|") : script.lines,
    phone: args.phone ?? (args.say ? null : script.phone),
    at: args.at ?? (preset ? preset.at : DEFAULT_DEMO_NOW),
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const transcript = result.call.transcript;
  const stepsAt = (i) => result.steps.filter((s) => s.after === i).forEach((s) => console.log(`        ${describeStep(s)}`));
  transcript.forEach((line, i) => {
    stepsAt(i);
    console.log(`${line.role === "caller" ? "Caller" : "Agent "}: ${line.text}`);
  });
  stepsAt(transcript.length);
  console.log("");
  for (const check of result.call.checks) console.log(`[${check.status.padEnd(7)}] ${check.label}: ${check.detail}`);
  console.log(`\nOutcome: ${result.call.outcome ?? result.call.state} · refused writes ${result.call.refusals} · races ${result.call.races}`);
  if (result.call.handoff) console.log(`Handoff: ${result.call.handoff.callTopic} · ${JSON.stringify(result.call.handoff.callContext)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
