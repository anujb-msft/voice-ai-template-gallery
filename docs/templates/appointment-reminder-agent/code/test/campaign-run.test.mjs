import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAudit } from "../src/audit.mjs";
import { AppointmentReminderFlow, STATES } from "../src/flow.mjs";
import { launchReminderCalls } from "../src/campaign.mjs";
import { buildCallInvite } from "../src/call-invite.mjs";

const NOW = "2026-05-19T10:00:00-07:00";
function appointment(appointmentId, number) {
  return { appointmentId, location: "Main campus", start: "2026-05-20T09:00:00-07:00", patient: { patientId: `P-${appointmentId}`, firstName: "Sam", lastName: "Rivera", phones: number ? [{ number }] : [] } };
}
function harness(appointments) {
  const byId = new Map(appointments.map((a) => [a.appointmentId, a]));
  const attempts = [];
  const schedule = { getAppointment: (id) => byId.get(id) ?? null, attemptsFor: () => [], recordAttempt: (a) => attempts.push(a) };
  const audit = new MemoryAudit();
  const flow = new AppointmentReminderFlow({ schedule, audit, now: () => new Date(NOW) });
  return { flow, audit, attempts };
}
const scheduled = (...ids) => ids.map((appointmentId) => ({ appointmentId, state: "scheduled" }));
const rejected = (statusCode, message) => Object.assign(new Error(message), { statusCode, details: { error: { code: "BadRequest", message } } });

test("a failed placement ends that call as create_call_failed and the run continues", async () => {
  const { flow, audit, attempts } = harness([appointment("A-1", "+15555550101"), appointment("A-2", "+15555550102"), appointment("A-3", "+15555550103")]);
  const dialPlan = [...scheduled("A-1", "A-2"), { appointmentId: "A-3", state: "skipped" }];
  const inFlight = new Set();
  const dialled = [];
  const placeCall = async ({ to, callId }) => {
    dialled.push(to);
    if (to === "+15555550101") throw rejected(400, "Invalid request.");
    return { callConnectionId: `conn-${callId}` };
  };

  const { launched, failed } = await launchReminderCalls({ flow, dialPlan, maxConcurrent: 5, placeCall, inFlight });

  assert.deepEqual(dialled, ["+15555550101", "+15555550102"]);
  assert.equal(launched.length, 1);
  assert.equal(flow.get(launched[0]).appointmentId, "A-2");
  assert.deepEqual([...inFlight], launched);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].appointmentId, "A-1");
  assert.equal(failed[0].error, "400 Invalid request.");
  const call = flow.get(failed[0].callId);
  assert.equal(call.state, STATES.ENDED);
  assert.equal(call.outcome, "create_call_failed");
  assert.equal(audit.calls.get(call.id).outcome, "create_call_failed");
  assert.equal(audit.eventsFor(call.id).find((e) => e.kind === "outcome").detail, "create_call_failed: 400 Invalid request.");
  assert.equal(attempts.length, 0, "a call that was never placed does not use up a reminder attempt");
});

test("when every placement fails the run resolves and nothing stays in flight", async () => {
  const { flow } = harness([appointment("A-1", "+15555550101"), appointment("A-2", "+15555550102")]);
  const inFlight = new Set();
  const placeCall = async () => { throw new TypeError("Cannot read properties of undefined (reading 'communicationUserId')"); };

  const { launched, failed } = await launchReminderCalls({ flow, dialPlan: scheduled("A-1", "A-2"), maxConcurrent: 5, placeCall, inFlight });

  assert.equal(inFlight.size, 0);
  assert.deepEqual(launched, []);
  assert.deepEqual(failed.map((f) => f.appointmentId), ["A-1", "A-2"]);
  assert.match(failed[0].error, /communicationUserId/);
  for (const f of failed) assert.equal(flow.get(f.callId).outcome, "create_call_failed");
});

test("rows that cannot be dialled are reported and later rows are still placed", async () => {
  const { flow } = harness([appointment("A-2", "+15555550102"), appointment("A-5", null)]);
  const inFlight = new Set();
  const placeCall = async ({ to }) => { buildCallInvite({ to, from: "+15555550199" }); return {}; };

  const { launched, failed } = await launchReminderCalls({ flow, dialPlan: scheduled("A-404", "A-5", "A-2"), maxConcurrent: 5, placeCall, inFlight });

  assert.deepEqual(failed[0], { callId: null, appointmentId: "A-404", error: "unknown appointment A-404" });
  assert.equal(failed[1].appointmentId, "A-5");
  assert.match(failed[1].error, /target phone number/);
  assert.equal(flow.get(failed[1].callId).outcome, "create_call_failed");
  assert.equal(launched.length, 1);
  assert.deepEqual([...inFlight], launched);
});

test("placements are capped at maxConcurrent", async () => {
  const { flow } = harness([appointment("A-1", "+15555550101"), appointment("A-2", "+15555550102"), appointment("A-3", "+15555550103")]);
  const inFlight = new Set();
  let placed = 0;
  const { launched, failed } = await launchReminderCalls({ flow, dialPlan: scheduled("A-1", "A-2", "A-3"), maxConcurrent: 2, placeCall: async () => { placed += 1; return {}; }, inFlight });
  assert.equal(placed, 2);
  assert.equal(launched.length, 2);
  assert.deepEqual(failed, []);
  assert.equal(inFlight.size, 2);
});
