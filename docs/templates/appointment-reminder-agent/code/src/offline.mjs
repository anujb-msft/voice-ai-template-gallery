import { ScheduleAdapter } from "./schedule-store.mjs";
import { MemoryAudit } from "./audit.mjs";
import { AppointmentReminderFlow, handleUtterance } from "./flow.mjs";
import { config } from "./config.mjs";

export const TRANSCRIPTS = {
  confirm: ["yes, this is Jordan", "03/12/1984", "yes"],
  cancel: ["yes, this is Jordan", "03/12/1984", "I need to cancel", "yes"],
  reschedule: ["yes, this is Jordan", "03/12/1984", "can I come next week instead"],
  optout: ["stop calling me"],
};

export function createOfflineHarness({ dbPath = config.schedule.dbPath, now = () => new Date(config.demoNow) } = {}) {
  const schedule = new ScheduleAdapter({ dbPath, now });
  const audit = new MemoryAudit();
  const flow = new AppointmentReminderFlow({ schedule, audit, now });
  return { schedule, audit, flow };
}

export async function runOfflineReminder({ appointmentId = "A-20418", transcript = TRANSCRIPTS.confirm, outcome = "answered", now = () => new Date(config.demoNow), dbPath = config.schedule.dbPath } = {}) {
  const { schedule, audit, flow } = createOfflineHarness({ dbPath, now });
  const call = flow.create({ appointmentId });
  flow.answered(call.id);
  flow.applyDialOutcome(call.id, outcome, { greetingText: outcome === "voicemail" ? "Please leave a message after the tone beep" : "hello", greetingMs: 800, beep: outcome === "voicemail" });
  if (outcome === "answered") for (const line of transcript) handleUtterance(flow, call.id, line);
  return { call: flow.snapshot(call.id), events: audit.eventsFor(call.id), stats: schedule.stats() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = Object.fromEntries(process.argv.slice(2).map((v, i, a) => v.startsWith("--") ? [v.slice(2), a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : true] : null).filter(Boolean));
  const transcript = TRANSCRIPTS[args.transcript] ?? String(args.transcript ?? "").split("|").filter(Boolean);
  const result = await runOfflineReminder({ appointmentId: args.appointment ?? "A-20418", transcript, outcome: args.outcome ?? "answered" });
  console.log(JSON.stringify(result, null, 2));
}
