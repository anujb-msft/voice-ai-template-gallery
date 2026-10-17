import { pathToFileURL } from "node:url";
import { ScheduleAdapter } from "./schedule-store.mjs";
import { MemoryAudit } from "./audit.mjs";
import { AppointmentReminderFlow, handleUtterance } from "./flow.mjs";
import { config, demoNowDate } from "./config.mjs";

/**
 * Offline reminder calls: the same flow, gates, scripts and schedule writes as
 * a real call, on an in-memory copy of the seed with the clock pinned. Nothing
 * is dialed and the server's schedule database is never touched.
 *
 *   npm run offline
 *   node src/offline.mjs --transcript cancel --language es
 *   node src/offline.mjs --transcript voicemail
 *   node src/offline.mjs --appointment A-20418 --at 2026-05-19T20:30:00-07:00
 *   node src/offline.mjs --appointment A-20418 --transcript "Yes, this is Jordan.|March 12th, 1984.|Yes." --json
 */

/** The console's scripted beats, as offline runs. The beats speak English; pass --language es to hear Spanish. */
export const SCENARIOS = {
  confirm: { appointmentId: "A-20418", language: "en", lines: ["Yes, this is Jordan.", "March 12th, 1984.", "Yes, I'll be there."] },
  cancel: { appointmentId: "A-20419", language: "en", lines: ["Yes, speaking.", "June 9th, 1979.", "I need to cancel.", "Yes, please cancel it."] },
  reschedule: { appointmentId: "A-20423", language: "en", lines: ["Yes, this is Riley.", "August 14th, 2002.", "Can I come next week instead?"] },
  "wrong-party": { appointmentId: "A-20418", language: "en", lines: ["No, this is his brother."] },
  voicemail: { appointmentId: "A-20419", language: "en", outcome: "voicemail", attempt: 3, lines: [] },
  optout: { appointmentId: "A-20418", language: "en", lines: ["Stop calling me."] },
};

/** What the callee's phone does when the simulated call connects; the voicemail detector reads it. */
export function dialGreeting(outcome = "answered", firstName = "") {
  if (outcome === "voicemail") {
    return { greetingText: `Hi, you've reached ${firstName || "this number"}. Please leave a message after the tone.`, greetingMs: 5200, beep: false };
  }
  if (outcome === "answered") return { greetingText: "Hello?", greetingMs: 700, beep: false };
  return {};
}

export function createOfflineHarness({ dbPath = ":memory:", seedPath = config.schedule.seedPath, now = () => demoNowDate(), options = {} } = {}) {
  const schedule = new ScheduleAdapter({ dbPath, seedPath, now });
  const audit = new MemoryAudit();
  const flow = new AppointmentReminderFlow({ schedule, audit, now, options });
  return { schedule, audit, flow };
}

export async function runOfflineReminder({ scenario = null, appointmentId = null, transcript = null, outcome = null, attempt = null, language = null, at = null, options = {} } = {}) {
  const preset = SCENARIOS[scenario] ?? {};
  const pinned = demoNowDate(at || undefined);
  const { schedule, audit, flow } = createOfflineHarness({ now: () => new Date(pinned), options });
  const id = appointmentId ?? preset.appointmentId ?? "A-20418";
  const appointment = schedule.getAppointment(id);
  if (!appointment) return { ok: false, error: `Unknown appointment ${id}` };
  const dial = outcome ?? preset.outcome ?? "answered";
  const placed = flow.placeSimulatedCall({ appointmentId: id, language: language ?? preset.language ?? null, attempt: attempt ?? preset.attempt ?? null, outcome: dial, greeting: dialGreeting(dial, appointment.patient?.firstName) });
  const lines = transcript ?? preset.lines ?? [];
  if (!placed.refused) {
    for (const line of lines) {
      if (flow.snapshot(placed.callId)?.terminal) break;
      handleUtterance(flow, placed.callId, line);
      await flow.settled(placed.callId);
    }
  }
  return { ok: true, clock: pinned.toISOString(), call: flow.snapshot(placed.callId), events: audit.eventsFor(placed.callId), stats: audit.stats(), schedule: schedule.stats(pinned) };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const next = argv[i + 1];
    args[argv[i].slice(2)] = next && !next.startsWith("--") ? argv[(i += 1)] : true;
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const named = typeof args.transcript === "string" && SCENARIOS[args.transcript] ? args.transcript : null;
  const typed = typeof args.transcript === "string" && !named ? args.transcript.split("|").map((s) => s.trim()).filter(Boolean) : null;
  const result = await runOfflineReminder({
    scenario: named ?? (args.appointment ? null : "confirm"),
    appointmentId: typeof args.appointment === "string" ? args.appointment : null,
    transcript: typed,
    outcome: typeof args.outcome === "string" ? args.outcome : null,
    attempt: args.attempt ? Number(args.attempt) : null,
    language: typeof args.language === "string" ? args.language : null,
    at: typeof args.at === "string" ? args.at : null,
  });
  if (args.json || !result.ok) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const { call } = result;
    console.log(`Reminder call about ${call.appointmentId} (${call.patient}), demo clock ${result.clock}`);
    for (const line of call.transcript) console.log(`  ${line.role === "agent" ? "agent " : "callee"}  ${line.text}`);
    for (const e of result.events.filter((e) => e.source !== "system" || e.kind === "outcome")) console.log(`  · ${e.detail}`);
    console.log(`Outcome: ${call.outcome ?? call.state}${call.verified ? " (identity verified)" : ""}`);
  }
}
