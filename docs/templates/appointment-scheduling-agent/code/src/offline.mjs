import { ScheduleAdapter } from "./schedule-store.mjs";
import { MemoryAudit } from "./audit.mjs";
import { AppointmentSchedulingFlow, handleUtterance } from "./flow.mjs";
import { config } from "./config.mjs";

export const TRANSCRIPTS = {
  book: ["Jordan Rivera 03/12/1984", "rash on my arm", "primary care new problem", "morning with my usual doctor", "first", "yes"],
  rescheduleHandoff: ["mornings at Northgate", "first", "yes"],
  fallbackVerification: ["Jordan Rivera 01/01/1980", "Jordan Rivera 03/12/1984", "rash", "primary care", "morning", "first", "yes"],
};

export function createOfflineHarness({ dbPath = config.schedule.dbPath, now = () => new Date(config.demoNow), callContext = null } = {}) {
  const schedule = new ScheduleAdapter({ dbPath, now });
  const audit = new MemoryAudit();
  const flow = new AppointmentSchedulingFlow({ schedule, audit, now });
  const call = flow.create({ callContext, sessionId: callContext?.sessionId });
  flow.answered(call.id);
  return { schedule, audit, flow, call };
}

export async function runOfflineScheduling({ transcript = TRANSCRIPTS.book, dbPath = config.schedule.dbPath, callContext = null, now = () => new Date(config.demoNow) } = {}) {
  const harness = createOfflineHarness({ dbPath, now, callContext });
  for (const line of transcript) handleUtterance(harness.flow, harness.call.id, line);
  return { call: harness.flow.snapshot(harness.call.id), events: harness.audit.eventsFor(harness.call.id), stats: harness.schedule.stats() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = Object.fromEntries(process.argv.slice(2).map((v, i, a) => v.startsWith("--") ? [v.slice(2), a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : true] : null).filter(Boolean));
  const transcript = TRANSCRIPTS[args.transcript] ?? String(args.transcript ?? "").split("|").filter(Boolean);
  console.log(JSON.stringify(await runOfflineScheduling({ transcript }), null, 2));
}
