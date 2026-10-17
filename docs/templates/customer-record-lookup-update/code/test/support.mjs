// Shared test setup: the in-memory CRM, so the tests need no database, no Azure and no network.
import { MemoryCrmAdapter } from "../src/crm-memory.mjs";
import { MemoryAudit } from "../src/audit.mjs";
import { CustomerRecordFlow } from "../src/flow.mjs";
import { RepDirectory } from "../src/providers/crm.mjs";

export const TIME_ZONE = "America/Los_Angeles";
// The demo-day preset: Wednesday, June 10, 2026, noon in Redmond.
export const DEMO_DAY = Date.parse("2026-06-10T19:00:00Z");

export const DEBRIEF =
  "Log the Fabrikam meeting. Dana agreed to the renewal at 240k, moving to Closed Won pending signature, close date June 15th. Remind me to send the contract Friday.";
export const NEW_MOBILE = "Update Fabrikam: Dana has a new mobile, 425 555 0143.";
export const CREDIT_LIMIT = "Raise Fabrikam's credit limit to 500k and move them to net 60 payment terms.";

export function makeFlow({ now = DEMO_DAY, commitUndoMs = 0, transfer = null, hub = null } = {}) {
  const clock = typeof now === "function" ? now : () => now;
  const crm = new MemoryCrmAdapter({ seedPath: "./config/crm-seed.json", now: clock, timeZone: TIME_ZONE });
  const audit = new MemoryAudit({ persistTranscripts: false, now: clock });
  const reps = RepDirectory.load("./config/reps.json");
  const flow = new CustomerRecordFlow({
    crm,
    reps,
    audit,
    transfer,
    hub,
    now: clock,
    timeZone: TIME_ZONE,
    options: { callTimeBudgetMs: 480000, wrapUpMs: 420000, commitUndoMs, persistTranscripts: false },
  });
  return { flow, crm, audit, reps };
}

/** Alex, signed in to Teams: verified without a PIN. */
export function startTeams(flow) {
  return flow.startSimulation({ repId: "rep-alex" }).id;
}

/** Alex's registered mobile: the PIN comes next. */
export function startMobile(flow) {
  return flow.startSimulation({ repId: "rep-alex", fromPhone: "+14255550197" }).id;
}

export function lastAgentLine(flow, callId) {
  return flow.snapshot(callId).transcript.filter((t) => t.role === "agent").at(-1)?.text ?? "";
}

export function danaPhone(flow, crm, callId) {
  return crm.getContact(flow.get(callId).rep, "contact-dana").phone;
}
