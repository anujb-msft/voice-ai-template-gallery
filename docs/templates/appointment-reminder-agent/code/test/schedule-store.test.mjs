import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ScheduleAdapter } from "../src/schedule-store.mjs";

let seq = 0;
function fresh(opts = {}) {
  const dbPath = join(process.cwd(), "data", `test-schedule-${process.pid}-${seq++}.db`);
  ScheduleAdapter.reset({ dbPath });
  return new ScheduleAdapter({ dbPath, now: () => new Date("2026-05-19T10:00:00-07:00"), handoffTokenSecret: "test-secret", ...opts });
}

test("seeds shared providers, patients, appointments, and occupancy", () => {
  const s = fresh();
  assert.equal(s.getAppointment("A-20418").patient.firstName, "Jordan");
  assert.equal(s.getAppointment("A-20418").provider.name, "Dr. Lee");
  assert.ok(s.db.prepare("SELECT COUNT(*) n FROM occupancy WHERE ref='A-20418'").get().n > 1);
  s.close();
});

test("confirmAppointment is idempotent", () => {
  const s = fresh();
  const a = s.confirmAppointment("A-20418", "idem-confirm");
  const b = s.confirmAppointment("A-20418", "idem-confirm");
  assert.equal(a.appointment.status, "confirmed");
  assert.deepEqual(b, a);
  s.close();
});

test("cancelAppointment releases slot and frees occupancy idempotently", () => {
  const s = fresh();
  assert.ok(s.db.prepare("SELECT COUNT(*) n FROM occupancy WHERE ref='A-20418'").get().n > 0);
  const a = s.cancelAppointment("A-20418", "schedule_conflict", "idem-cancel");
  const b = s.cancelAppointment("A-20418", "schedule_conflict", "idem-cancel");
  assert.equal(a.appointment.status, "cancelled");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM occupancy WHERE ref='A-20418'").get().n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM released_slots WHERE appointment_id='A-20418'").get().n, 1);
  assert.deepEqual(b, a);
  s.close();
});

test("requestReschedule records request without cancelling current appointment", () => {
  const s = fresh();
  const r = s.requestReschedule("A-20418", "idem-resched");
  assert.equal(r.appointment.status, "booked");
  assert.equal(s.getAppointment("A-20418").status, "booked");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM reschedule_requests WHERE appointment_id='A-20418'").get().n, 1);
  s.close();
});

test("handoff token redeem supports success, single use, expiry, and call binding", () => {
  const s = fresh();
  const issued = s.issueHandoffToken({ appointmentId: "A-20418", patientId: "P-1007", correlationId: "call-1" });
  assert.equal(s.redeemHandoffToken({ token: issued.token, correlationId: "call-2" }).reason, "wrong_call");
  const ok = s.redeemHandoffToken({ token: issued.token, correlationId: "call-1" });
  assert.equal(ok.ok, true);
  assert.equal(ok.appointment.appointmentId, "A-20418");
  assert.equal(s.redeemHandoffToken({ token: issued.token, correlationId: "call-1" }).reason, "used");
  s.close();

  const expired = fresh({ tokenTtlMs: -1 });
  const token = expired.issueHandoffToken({ appointmentId: "A-20418", patientId: "P-1007", correlationId: "call-x" }).token;
  assert.equal(expired.redeemHandoffToken({ token, correlationId: "call-x" }).reason, "expired");
  expired.close();
});
