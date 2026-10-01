import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ScheduleAdapter } from "../src/schedule-store.mjs";
import { MemoryAudit } from "../src/audit.mjs";
import { AppointmentSchedulingFlow, handleUtterance, evaluateEligibility } from "../src/flow.mjs";

let seq = 0;
function harness(opts = {}) {
  const dbPath = join(process.cwd(), "data", `test-flow-scheduling-${process.pid}-${seq++}.db`);
  ScheduleAdapter.reset({ dbPath });
  const schedule = new ScheduleAdapter({ dbPath, now: () => new Date("2026-05-19T10:00:00-07:00"), handoffTokenSecret: "test-secret", ...opts.schedule });
  const audit = new MemoryAudit();
  const flow = new AppointmentSchedulingFlow({ schedule, audit, now: () => new Date("2026-05-19T10:00:00-07:00"), ...opts.flow });
  const call = flow.create(opts.create ?? {});
  flow.answered(call.id);
  return { schedule, audit, flow, call };
}

test("flow happy path verifies, searches, holds, and books after explicit yes", () => {
  const { schedule, flow, call } = harness();
  assert.equal(handleUtterance(flow, call.id, "Jordan Rivera 03/12/1984").status, "verified");
  assert.equal(handleUtterance(flow, call.id, "rash on my arm").status, "ok");
  assert.equal(handleUtterance(flow, call.id, "primary care new problem").eligible, true);
  const search = handleUtterance(flow, call.id, "morning with my usual doctor");
  assert.ok(search.options.length > 0);
  assert.equal(handleUtterance(flow, call.id, "first").status, "held");
  assert.equal(handleUtterance(flow, call.id, "maybe").reason, "needs_explicit_yes");
  const booked = handleUtterance(flow, call.id, "yes");
  assert.equal(booked.ok, true);
  assert.equal(flow.snapshot(call.id).outcome, "booked");
  assert.equal(schedule.getAppointment(booked.appointment.appointmentId).status, "booked");
  schedule.close();
});

test("verification fallback allows one wrong then correct identity", () => {
  const { schedule, flow, call } = harness();
  assert.equal(handleUtterance(flow, call.id, "Jordan Rivera 01/01/1980").status, "retry");
  assert.equal(handleUtterance(flow, call.id, "Jordan Rivera 03/12/1984").status, "verified");
  assert.equal(flow.snapshot(call.id).verified, true);
  schedule.close();
});

test("valid reminder handoff skips verification and replay falls back", () => {
  const dbPath = join(process.cwd(), "data", `test-handoff-flow-${process.pid}-${seq++}.db`);
  ScheduleAdapter.reset({ dbPath });
  const schedule = new ScheduleAdapter({ dbPath, now: () => new Date("2026-05-19T10:00:00-07:00"), handoffTokenSecret: "test-secret" });
  const token = schedule.issueHandoffToken({ appointmentId: "A-20418", patientId: "P-1007", correlationId: "call-abc" }).token;
  const audit = new MemoryAudit();
  const flow = new AppointmentSchedulingFlow({ schedule, audit, now: () => new Date("2026-05-19T10:00:00-07:00") });
  const call = flow.create({ callContext: { intent: "reschedule", appointmentId: "A-20418", patientRef: token, verified: true, sessionId: "call-abc" }, sessionId: "call-abc" });
  flow.answered(call.id);
  assert.equal(flow.snapshot(call.id).verified, true);
  assert.equal(flow.snapshot(call.id).action, "reschedule");
  const replay = flow.create({ callContext: { intent: "reschedule", appointmentId: "A-20418", patientRef: token, verified: true, sessionId: "call-abc" }, sessionId: "call-abc" });
  assert.equal(flow.snapshot(replay.id).verified, false);
  assert.equal(flow.snapshot(replay.id).handoff.reason, "used");
  schedule.close();
});

test("invalid handoff falls back to normal verification", () => {
  const { schedule, flow, call } = harness({ create: { callContext: { intent: "reschedule", patientRef: "bad", sessionId: "bad-call" }, sessionId: "bad-call" } });
  assert.equal(flow.snapshot(call.id).verified, false);
  assert.equal(handleUtterance(flow, call.id, "Jordan Rivera 03/12/1984").status, "verified");
  schedule.close();
});

test("eligibility blocks dermatology without referral and allows with referral", () => {
  const { schedule } = harness();
  const jordan = schedule.getPatient("P-1007");
  const mia = schedule.getPatient("P-1002");
  assert.equal(evaluateEligibility({ schedule, patient: jordan, visitTypeCode: "DERM_SKIN_CHECK" }).ruleId, "REFERRAL_REQUIRED");
  assert.equal(evaluateEligibility({ schedule, patient: mia, visitTypeCode: "DERM_SKIN_CHECK" }).eligible, true);
  schedule.close();
});

test("race after offered option returns slot_taken in flow", () => {
  const { schedule, flow, call } = harness();
  handleUtterance(flow, call.id, "Jordan Rivera 03/12/1984");
  handleUtterance(flow, call.id, "rash");
  handleUtterance(flow, call.id, "primary care");
  handleUtterance(flow, call.id, "morning");
  const option = flow.snapshot(call.id).options[0];
  assert.equal(schedule.holdSlot(option.optionId, { patientId: "competing" }).ok, true);
  assert.equal(handleUtterance(flow, call.id, "first").error, "slot_taken");
  schedule.close();
});
