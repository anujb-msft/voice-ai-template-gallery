import test from "node:test";
import assert from "node:assert/strict";
import { store } from "./helpers.mjs";

test("seeds shared providers, patients, appointments, and occupancy", () => {
  const s = store();
  assert.equal(s.inMemory, true);
  assert.equal(s.getAppointment("A-20418").patient.firstName, "Jordan");
  assert.equal(s.getAppointment("A-20418").provider.name, "Dr. Lee");
  assert.ok(s.db.prepare("SELECT COUNT(*) n FROM occupancy WHERE ref='A-20418'").get().n > 1);
  s.close();
});

test("confirmAppointment is idempotent", () => {
  const s = store();
  const a = s.confirmAppointment("A-20418", "idem-confirm");
  const b = s.confirmAppointment("A-20418", "idem-confirm");
  assert.equal(a.appointment.status, "confirmed");
  assert.deepEqual(b, a);
  s.close();
});

test("cancelAppointment releases slot and frees occupancy idempotently", () => {
  const s = store();
  assert.ok(s.db.prepare("SELECT COUNT(*) n FROM occupancy WHERE ref='A-20418'").get().n > 0);
  const a = s.cancelAppointment("A-20418", "schedule_conflict", "idem-cancel");
  const b = s.cancelAppointment("A-20418", "schedule_conflict", "idem-cancel");
  assert.equal(a.appointment.status, "cancelled");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM occupancy WHERE ref='A-20418'").get().n, 0);
  assert.deepEqual(s.releasedSlots().map((r) => [r.appointmentId, r.reason]), [["A-20418", "schedule_conflict"]]);
  assert.deepEqual(b, a);
  s.close();
});

test("requestReschedule records request without cancelling current appointment", () => {
  const s = store();
  const r = s.requestReschedule("A-20418", "idem-resched");
  assert.equal(r.appointment.status, "booked");
  assert.equal(s.getAppointment("A-20418").status, "booked");
  assert.deepEqual(s.rescheduleRequests().map((q) => [q.appointmentId, q.status]), [["A-20418", "requested"]]);
  assert.equal(s.hasOpenRescheduleRequest("A-20418"), true);
  s.close();
});

test("handoff token redeem supports success, single use, expiry, and call binding", () => {
  const s = store();
  const issued = s.issueHandoffToken({ appointmentId: "A-20418", patientId: "P-1007", correlationId: "call-1" });
  assert.equal(s.redeemHandoffToken({ token: issued.token, correlationId: "call-2" }).reason, "wrong_call");
  const ok = s.redeemHandoffToken({ token: issued.token, correlationId: "call-1" });
  assert.equal(ok.ok, true);
  assert.equal(ok.appointment.appointmentId, "A-20418");
  assert.equal(s.redeemHandoffToken({ token: issued.token, correlationId: "call-1" }).reason, "used");
  s.close();

  const expired = store({ tokenTtlMs: -1 });
  const token = expired.issueHandoffToken({ appointmentId: "A-20418", patientId: "P-1007", correlationId: "call-x" }).token;
  assert.equal(expired.redeemHandoffToken({ token, correlationId: "call-x" }).reason, "expired");
  expired.close();
});

test("restoreAppointment puts one appointment back exactly as the seed has it and leaves the rest alone", () => {
  const s = store();
  const avery = s.getAppointment("A-20419");
  s.cancelAppointment("A-20419", "patient_requested", "idem-avery");
  s.recordAttempt({ appointmentId: "A-20419", patientId: avery.patientId, state: "ended", outcome: "cancelled", attempt: 1 });
  s.suppressPatient(avery.patientId);
  s.confirmAppointment("A-20418", "idem-jordan");

  const restored = s.restoreAppointment("A-20419");
  assert.equal(restored.ok, true);
  assert.equal(restored.appointment.status, "booked");
  assert.deepEqual(s.releasedSlots(), []);
  assert.deepEqual(s.attemptsFor("A-20419"), []);
  assert.equal(s.isSuppressed(avery.patientId), false);
  assert.ok(s.db.prepare("SELECT COUNT(*) n FROM occupancy WHERE ref='A-20419'").get().n > 0);
  assert.equal(s.getAppointment("A-20418").status, "confirmed");
  assert.equal(s.restoreAppointment("A-99999").reason, "unknown_appointment");
  s.close();
});

test("reseed wipes every change and loads the seed again, so each demo run starts identical", () => {
  const s = store();
  const seeded = s.stats();
  s.confirmAppointment("A-20418", "idem-1");
  s.cancelAppointment("A-20419", "patient_requested", "idem-2");
  s.requestReschedule("A-20423", "idem-3");
  s.suppressPatient("P-1007");
  s.recordAttempt({ appointmentId: "A-20418", patientId: "P-1007", state: "ended", outcome: "confirmed", attempt: 1 });
  const changed = s.stats();
  assert.equal(changed.releasedSlots, seeded.releasedSlots + 1);
  assert.equal(changed.rescheduleRequests, seeded.rescheduleRequests + 1);
  assert.equal(changed.optOuts, seeded.optOuts + 1);
  assert.equal(changed.attempts, seeded.attempts + 1);

  s.reseed();
  assert.deepEqual(s.stats(), seeded);
  assert.equal(s.getAppointment("A-20418").status, "booked");
  assert.equal(s.getAppointment("A-20419").status, "booked");
  s.close();
});
