import { fileURLToPath } from "node:url";
import { ScheduleAdapter } from "../src/schedule-store.mjs";
import { MemoryAudit } from "../src/audit.mjs";
import { AppointmentReminderFlow, handleUtterance } from "../src/flow.mjs";

/**
 * Everything the tests depend on is pinned here: an in-memory copy of the
 * shipped seed, a fixed clock and explicit flow options. A developer's .env
 * (their own SCHEDULE_DB_PATH, DEMO_NOW, SCHEDULING_AGENT_TARGET, test numbers
 * or voicemail threshold) can then never turn an assertion red, and no test
 * writes a database file.
 */
export const SEED_PATH = fileURLToPath(new URL("../fixtures/appointments-seed.json", import.meta.url));

/** The console's clock presets: two days before Jordan's Thursday 9:30 AM visit, the day before, and 8:30 PM. */
export const TWO_DAYS_BEFORE = "2026-05-19T10:00:00-07:00";
export const DAY_BEFORE = "2026-05-20T10:00:00-07:00";
export const TOO_LATE = "2026-05-19T20:30:00-07:00";

export const FLOW_OPTIONS = Object.freeze({
  schedulingAgentTarget: "",
  allowedTestNumbers: [],
  voicemailGreetingMs: 4500,
  callTimeBudgetMs: 240_000,
  transferDelayMs: 0,
});

/** Content that may only be spoken after the date of birth matches. */
export const JORDAN_DETAILS = /Imaging|imagenolog|Dr\. Lee|9:30|Northgate/i;

const clockOf = (now) => (typeof now === "function" ? now : () => new Date(now));

export function store({ now = TWO_DAYS_BEFORE, ...options } = {}) {
  return new ScheduleAdapter({ dbPath: ":memory:", seedPath: SEED_PATH, now: clockOf(now), handoffTokenSecret: "test-secret", tokenTtlMs: 300_000, ...options });
}

/** transfer: the live ACS transfer, stubbed; absent by default like a simulation server. hub: captures console frames. */
export function harness({ now = TWO_DAYS_BEFORE, options = {}, transfer = null, hub = null } = {}) {
  const clock = clockOf(now);
  const schedule = store({ now: clock });
  const audit = new MemoryAudit();
  const flow = new AppointmentReminderFlow({ schedule, audit, transfer, hub, now: clock, options: { ...FLOW_OPTIONS, ...options } });
  return { schedule, audit, flow };
}

/** An outbound reminder a person picked up: the agent has asked whether it is speaking with the patient. */
export function answered(flow, appointmentId = "A-20418", { language = null, simulated = false, sessionId = null } = {}) {
  const call = flow.create({ appointmentId, language, simulated, sessionId });
  flow.answered(call.id);
  flow.applyDialOutcome(call.id, "answered");
  return call;
}

/** Answered, identity claimed, date of birth matched: the agent has just read the appointment. */
export function verified(flow, appointmentId = "A-20418", dob = "03/12/1984", options = {}) {
  const call = answered(flow, appointmentId, options);
  handleUtterance(flow, call.id, "yes");
  handleUtterance(flow, call.id, dob);
  return call;
}
