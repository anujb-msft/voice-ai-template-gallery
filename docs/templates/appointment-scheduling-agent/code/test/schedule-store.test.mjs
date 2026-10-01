import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ScheduleAdapter } from "../src/schedule-store.mjs";

let seq = 0;
function fresh(opts = {}) {
  const dbPath = join(process.cwd(), "data", `test-scheduling-${process.pid}-${seq++}.db`);
  ScheduleAdapter.reset({ dbPath });
  return new ScheduleAdapter({ dbPath, now: () => new Date("2026-05-19T10:00:00-07:00"), handoffTokenSecret: "test-secret", ...opts });
}

test("searchSlots generates provider template openings minus occupancy", () => {
  const s = fresh();
  const result = s.searchSlots({ patientId: "P-1007", visitTypeCode: "NEW_PROBLEM", preferences: { providerId: "prov-patel", timeOfDay: "morning" }, limit: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.options.length, 3);
  assert.equal(result.options[0].providerId, "prov-patel");
  assert.equal(result.options[0].start, "2026-05-19T10:00:00-07:00");
  s.close();
});

test("holdSlot creates expiring five-minute occupancy and release frees it", () => {
  const s = fresh();
  const [slot] = s.searchSlots({ patientId: "P-1007", visitTypeCode: "NEW_PROBLEM", preferences: { providerId: "prov-patel" }, limit: 1 }).options;
  const hold = s.holdSlot(slot, { patientId: "P-1007" });
  assert.equal(hold.ok, true);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM occupancy WHERE ref=?").get(hold.holdId).n, 6);
  s.releaseHold(hold.holdId);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM occupancy WHERE ref=?").get(hold.holdId).n, 0);
  s.close();
});

test("lost race on unique occupancy returns slot_taken", () => {
  const s = fresh();
  const [slot] = s.searchSlots({ patientId: "P-1007", visitTypeCode: "NEW_PROBLEM", preferences: { providerId: "prov-patel" }, limit: 1 }).options;
  assert.equal(s.holdSlot(slot, { patientId: "P-1007" }).ok, true);
  assert.deepEqual(s.holdSlot(slot, { patientId: "P-1001" }), { ok: false, error: "slot_taken" });
  s.close();
});

test("expired hold cannot book and slot becomes available", () => {
  let now = new Date("2026-05-19T10:00:00-07:00");
  const s = fresh({ now: () => now });
  const [slot] = s.searchSlots({ patientId: "P-1007", visitTypeCode: "FOLLOW_UP", preferences: { providerId: "prov-patel" }, limit: 1 }).options;
  const hold = s.holdSlot(slot, { patientId: "P-1007", ttlMs: 1000 });
  now = new Date("2026-05-19T10:05:01-07:00");
  assert.equal(s.bookAppointment({ holdId: hold.holdId, patientId: "P-1007" }).error, "hold_not_found");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM occupancy WHERE ref=?").get(hold.holdId).n, 0);
  s.close();
});

test("book, reschedule, and cancel are idempotent and preserve occupancy", () => {
  const s = fresh();
  const first = s.searchSlots({ patientId: "P-1007", visitTypeCode: "FOLLOW_UP", preferences: { providerId: "prov-patel" }, limit: 1 }).options[0];
  const hold = s.holdSlot(first, { patientId: "P-1007" });
  const booked = s.bookAppointment({ holdId: hold.holdId, patientId: "P-1007", idempotencyKey: "book-1" });
  assert.deepEqual(s.bookAppointment({ holdId: hold.holdId, patientId: "P-1007", idempotencyKey: "book-1" }), booked);
  assert.equal(booked.appointment.status, "booked");

  const next = s.searchSlots({ patientId: "P-1007", visitTypeCode: "FOLLOW_UP", preferences: { providerId: "prov-patel" }, limit: 1 }).options[0];
  const hold2 = s.holdSlot(next, { patientId: "P-1007" });
  const rescheduled = s.rescheduleAppointment({ appointmentId: booked.appointment.appointmentId, holdId: hold2.holdId, idempotencyKey: "resched-1" });
  assert.deepEqual(s.rescheduleAppointment({ appointmentId: booked.appointment.appointmentId, holdId: hold2.holdId, idempotencyKey: "resched-1" }), rescheduled);
  assert.equal(s.getAppointment(booked.appointment.appointmentId).status, "cancelled");
  assert.equal(rescheduled.appointment.status, "booked");

  const cancelled = s.cancelAppointment(rescheduled.appointment.appointmentId, "patient_requested", "cancel-1");
  assert.deepEqual(s.cancelAppointment(rescheduled.appointment.appointmentId, "patient_requested", "cancel-1"), cancelled);
  assert.equal(cancelled.appointment.status, "cancelled");
  s.close();
});

test("handoff redemption covers success, failure, replay, expiry, and call binding", () => {
  const s = fresh();
  assert.equal(s.redeemHandoffToken({ token: "bad", correlationId: "call-1" }).reason, "invalid");
  const issued = s.issueHandoffToken({ appointmentId: "A-20418", patientId: "P-1007", correlationId: "call-1" });
  assert.equal(s.redeemHandoffToken({ token: issued.token, correlationId: "call-2" }).reason, "wrong_call");
  assert.equal(s.redeemHandoffToken({ token: issued.token, correlationId: "call-1" }).ok, true);
  assert.equal(s.redeemHandoffToken({ token: issued.token, correlationId: "call-1" }).reason, "used");
  s.close();
  const expired = fresh({ tokenTtlMs: -1 });
  const token = expired.issueHandoffToken({ appointmentId: "A-20418", patientId: "P-1007", correlationId: "call-x" }).token;
  assert.equal(expired.redeemHandoffToken({ token, correlationId: "call-x" }).reason, "expired");
  expired.close();
});

test("restart persistence keeps booked appointments", () => {
  const dbPath = join(process.cwd(), "data", `test-persist-${process.pid}-${seq++}.db`);
  ScheduleAdapter.reset({ dbPath });
  let s = new ScheduleAdapter({ dbPath, now: () => new Date("2026-05-19T10:00:00-07:00") });
  const slot = s.searchSlots({ patientId: "P-1007", visitTypeCode: "FOLLOW_UP", preferences: { providerId: "prov-patel" }, limit: 1 }).options[0];
  const hold = s.holdSlot(slot, { patientId: "P-1007" });
  const appt = s.bookAppointment({ holdId: hold.holdId, patientId: "P-1007" }).appointment;
  s.close();
  s = new ScheduleAdapter({ dbPath, now: () => new Date("2026-05-19T10:00:00-07:00") });
  assert.equal(s.getAppointment(appt.appointmentId).appointmentId, appt.appointmentId);
  s.close();
});
