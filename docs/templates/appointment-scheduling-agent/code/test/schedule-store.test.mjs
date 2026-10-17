import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { ScheduleAdapter } from "../src/schedule-store.mjs";
import { FIRST_NEW_ID, FRI, POLICY, SEEDED_APPOINTMENTS, TUE, makeStore } from "./harness.mjs";

/**
 * The schedule store is the only writer. These tests drive it directly on an
 * in-memory copy of the shipped seed, with the clock pinned to the demo's
 * Tuesday morning unless a test says otherwise.
 */

const followUp = (schedule, extra = {}) =>
  schedule.searchSlots({ patientId: "P-1007", visitTypeCode: "FOLLOW_UP", preferences: { providerId: "prov-patel" }, limit: 2, ...extra });

const cellAt = (grid, dateKey, time) => grid.rows.find((r) => r.dateKey === dateKey)?.cells.find((c) => c.time === time);

// --------------------------------------------------------------- search

test("openings start after the lead time, keep the time of day asked for, and spread across days", async () => {
  const { schedule } = await makeStore();
  const result = schedule.searchSlots({
    patientId: "P-1007",
    visitTypeCode: "NEW_PROBLEM",
    preferences: { providerId: "prov-patel", timeOfDay: "morning" },
    limit: 2,
  });
  assert.equal(result.ok, true);
  // 9:50 plus the 60-minute lead time; 10:45 is Dr. Patel's break, so 11:00 is
  // first. Wednesday is an afternoon clinic, so a morning preference moves on to Thursday.
  assert.deepEqual(result.options.map((o) => o.start), ["2026-05-19T11:00:00-07:00", "2026-05-21T08:30:00-07:00"]);
  assert.deepEqual(result.options.map((o) => o.spoken), ["today at 11 a.m.", "Thursday, May 21st, at 8:30 a.m."]);
  assert.equal(result.moreAvailable, true);
  for (const option of result.options) {
    assert.ok(Date.parse(option.start) >= TUE + POLICY.minLeadMinutes * 60_000, "nothing inside the lead time");
    assert.equal(option.providerId, "prov-patel");
  }
  schedule.close();
});

test("the clinic holiday is skipped", async () => {
  const { schedule } = await makeStore({ at: FRI });
  const { options } = followUp(schedule);
  // Monday, May 25 is a clinic holiday, so Friday evening's first opening is Tuesday.
  assert.deepEqual(options.map((o) => o.start), ["2026-05-26T08:30:00-07:00", "2026-05-27T13:00:00-07:00"]);
  assert.ok(options.every((o) => !o.start.startsWith("2026-05-25")));
  schedule.close();
});

test("an unknown visit type finds nothing", async () => {
  const { schedule } = await makeStore();
  const result = schedule.searchSlots({ visitTypeCode: "TELEPORT", limit: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.error, "unknown_visit_type");
  assert.deepEqual(result.options, []);
  schedule.close();
});

// --------------------------------------------------------------- holds

test("a held time cannot be held again until it is released", async () => {
  const { schedule } = await makeStore();
  const [slot] = followUp(schedule).options;
  const hold = schedule.holdSlot(slot, { patientId: "P-1007", ttlMs: POLICY.holdTtlMs });
  assert.equal(hold.ok, true);
  assert.equal(hold.expiresAt, new Date(TUE + POLICY.holdTtlMs).toISOString());
  assert.deepEqual(schedule.holdSlot(slot, { patientId: "P-1001" }), { ok: false, error: "slot_taken" });
  assert.ok(!followUp(schedule).options.some((o) => o.start === slot.start), "a held time is not offered to anyone else");

  schedule.releaseHold(hold.holdId);
  assert.equal(schedule.holdSlot(slot, { patientId: "P-1001" }).ok, true);
  schedule.close();
});

test("an expired hold books nothing and frees the time", async () => {
  const { schedule, advance } = await makeStore();
  const [slot] = followUp(schedule).options;
  const hold = schedule.holdSlot(slot, { patientId: "P-1007", ttlMs: 1_000 });
  advance(2_000);
  assert.deepEqual(schedule.bookAppointment({ holdId: hold.holdId, patientId: "P-1007" }), { ok: false, error: "hold_expired" });
  assert.equal(schedule.stats().appointments, SEEDED_APPOINTMENTS);
  assert.ok(followUp(schedule).options.some((o) => o.start === slot.start), "the time is offered again");
  schedule.close();
});

// --------------------------------------------------------------- writes

test("booking is idempotent: a retry replays the same appointment and a used hold books nothing more", async () => {
  const { schedule } = await makeStore();
  const [slot] = followUp(schedule).options;
  const hold = schedule.holdSlot(slot, { patientId: "P-1007" });
  const booked = schedule.bookAppointment({ holdId: hold.holdId, patientId: "P-1007", idempotencyKey: "book-1" });
  assert.equal(booked.ok, true);
  assert.equal(booked.appointment.appointmentId, FIRST_NEW_ID);
  assert.equal(booked.appointment.source, "voice");
  assert.deepEqual(schedule.bookAppointment({ holdId: hold.holdId, patientId: "P-1007", idempotencyKey: "book-1" }), booked);
  assert.equal(schedule.bookAppointment({ holdId: hold.holdId, patientId: "P-1007", idempotencyKey: "book-2" }).ok, false);
  assert.equal(schedule.stats().appointments, SEEDED_APPOINTMENTS + 1);
  assert.equal(schedule.stats().bookingsByVoice, 1);
  schedule.close();
});

test("a hold books only for its own patient", async () => {
  const { schedule } = await makeStore();
  const [slot] = followUp(schedule).options;
  const hold = schedule.holdSlot(slot, { patientId: "P-1007" });
  assert.deepEqual(schedule.bookAppointment({ holdId: hold.holdId, patientId: "P-1001" }), { ok: false, error: "patient_mismatch" });
  assert.equal(schedule.stats().bookingsByVoice, 0);
  schedule.close();
});

test("slot_taken: a time the front desk took is refused, and no other time is booked instead", async () => {
  const { schedule } = await makeStore();
  const [slot] = followUp(schedule).options;
  const hold = schedule.holdSlot(slot, { patientId: "P-1007" });

  const taken = schedule.takeSlot({ holdId: hold.holdId });
  assert.equal(taken.ok, true);
  assert.equal(taken.source, "front_desk");
  assert.equal(taken.start, slot.start);

  assert.deepEqual(schedule.bookAppointment({ holdId: hold.holdId, patientId: "P-1007" }), { ok: false, error: "slot_taken" });
  // A failure is never cached, and never turns into a neighboring time.
  assert.deepEqual(schedule.bookAppointment({ holdId: hold.holdId, patientId: "P-1007" }), { ok: false, error: "slot_taken" });
  const stats = schedule.stats();
  assert.equal(stats.appointments, SEEDED_APPOINTMENTS + 1, "only the front desk's appointment exists");
  assert.equal(stats.frontDeskBookings, 1);
  assert.equal(stats.bookingsByVoice, 0);

  const grid = schedule.grid({ providerId: "prov-patel", days: 1 });
  assert.equal(cellAt(grid, "2026-05-19", "11:00").state, "booked");
  assert.equal(cellAt(grid, "2026-05-19", "11:00").source, "front_desk");
  assert.equal(cellAt(grid, "2026-05-19", "11:15").state, "free");
  schedule.close();
});

test("the front desk cannot take a time that is already booked", async () => {
  const { schedule } = await makeStore();
  const seeded = { providerId: "prov-patel", start: "2026-05-21T10:15:00-07:00", end: "2026-05-21T10:30:00-07:00" };
  assert.deepEqual(schedule.takeSlot({ option: seeded }), { ok: false, error: "slot_taken" });
  assert.deepEqual(schedule.takeSlot({}), { ok: false, error: "nothing_to_take" });
  assert.equal(schedule.stats().appointments, SEEDED_APPOINTMENTS);
  schedule.close();
});

// --------------------------------------------------------------- the console's grid

test("the grid shows free, booked, held, break, past and closed, and never who", async () => {
  const { schedule } = await makeStore();
  const grid = schedule.grid({ providerId: "prov-patel", days: 5 });
  assert.equal(grid.ok, true);
  assert.equal(grid.providerName, "Dr. Patel");
  assert.equal(grid.stepMinutes, 15);
  assert.equal(grid.earliest, new Date(TUE + POLICY.minLeadMinutes * 60_000).toISOString());
  assert.deepEqual(grid.rows.map((r) => r.dateKey), ["2026-05-19", "2026-05-20", "2026-05-21", "2026-05-25", "2026-05-26"]);
  assert.equal(grid.rows[0].today, true);
  assert.equal(grid.rows.find((r) => r.dateKey === "2026-05-25").holiday, true);

  assert.equal(cellAt(grid, "2026-05-19", "08:00").state, "closed");
  assert.equal(cellAt(grid, "2026-05-19", "10:30").state, "past", "inside the lead time");
  assert.equal(cellAt(grid, "2026-05-19", "10:45").state, "break");
  assert.equal(cellAt(grid, "2026-05-19", "11:00").state, "free");
  assert.deepEqual(
    { state: cellAt(grid, "2026-05-21", "10:15").state, source: cellAt(grid, "2026-05-21", "10:15").source },
    { state: "booked", source: "seed" },
  );
  assert.equal(cellAt(grid, "2026-05-25", "13:00").state, "holiday");

  const [slot] = followUp(schedule).options;
  schedule.holdSlot(slot, { patientId: "P-1007" });
  assert.equal(cellAt(schedule.grid({ providerId: "prov-patel", days: 1 }), "2026-05-19", "11:00").state, "held");

  for (const row of grid.rows) {
    for (const cell of row.cells) {
      for (const key of Object.keys(cell)) assert.ok(["start", "time", "state", "ref", "source"].includes(key), `cell field ${key}`);
    }
  }
  assert.deepEqual(schedule.grid({ providerId: "prov-nobody" }), { ok: false, error: "unknown_provider" });
  schedule.close();
});

// --------------------------------------------------------------- demo reset

test("reseed puts the seeded day back, confirmation numbers included", async () => {
  const { schedule } = await makeStore();
  const book = () => {
    const [slot] = followUp(schedule).options;
    const hold = schedule.holdSlot(slot, { patientId: "P-1007" });
    return schedule.bookAppointment({ holdId: hold.holdId, patientId: "P-1007" });
  };
  assert.equal(book().appointment.appointmentId, FIRST_NEW_ID);
  const [other] = followUp(schedule).options;
  schedule.holdSlot(other, { patientId: "P-1001" });

  schedule.reseed();
  assert.deepEqual(schedule.stats(), {
    appointments: SEEDED_APPOINTMENTS,
    upcomingOpen: 22,
    bookingsByVoice: 0,
    frontDeskBookings: 0,
    activeHolds: 0,
    releasedSlots: 0,
    waitlist: 0,
  });
  const again = book();
  assert.equal(again.appointment.appointmentId, FIRST_NEW_ID, "a rerun reads out the same confirmation number");
  assert.equal(again.appointment.start, "2026-05-19T11:00:00-07:00");
  schedule.close();
});

// --------------------------------------------------------------- reminder handoff tokens

test("reminder handoff tokens are single-use, bound to their call, and expire", async () => {
  const { schedule, advance } = await makeStore();
  assert.equal(schedule.redeemHandoffToken({ token: "made-up", correlationId: "call-1" }).reason, "invalid");
  const issued = schedule.issueHandoffToken({ appointmentId: "A-20418", patientId: "P-1007", correlationId: "call-1" });
  assert.equal(schedule.redeemHandoffToken({ token: issued.token, correlationId: "call-2" }).reason, "wrong_call");
  const redeemed = schedule.redeemHandoffToken({ token: issued.token, correlationId: "call-1" });
  assert.equal(redeemed.ok, true);
  assert.equal(redeemed.patient.patientId, "P-1007");
  assert.equal(schedule.redeemHandoffToken({ token: issued.token, correlationId: "call-1" }).reason, "used");

  const late = schedule.issueHandoffToken({ appointmentId: "A-20418", patientId: "P-1007", correlationId: "call-3" });
  advance(POLICY.tokenTtlMs + 1_000);
  assert.equal(schedule.redeemHandoffToken({ token: late.token, correlationId: "call-3" }).reason, "expired");
  assert.throws(() => schedule.issueHandoffToken({ appointmentId: "A-20418", patientId: "P-1001", correlationId: "x" }), /mismatch/);
  schedule.close();
});

// --------------------------------------------------------------- storage

test("a schedule file keeps its bookings across a restart", async () => {
  const dbPath = fileURLToPath(new URL(`../data/test-restart-${process.pid}.db`, import.meta.url));
  ScheduleAdapter.reset({ dbPath });
  try {
    let { schedule } = await makeStore({ dbPath });
    const [slot] = followUp(schedule).options;
    const hold = schedule.holdSlot(slot, { patientId: "P-1007" });
    const { appointment } = schedule.bookAppointment({ holdId: hold.holdId, patientId: "P-1007" });
    schedule.close();

    ({ schedule } = await makeStore({ dbPath }));
    assert.equal(schedule.getAppointment(appointment.appointmentId)?.start, slot.start);
    assert.equal(schedule.stats().appointments, SEEDED_APPOINTMENTS + 1, "an existing file is not reseeded");
    schedule.close();
  } finally {
    ScheduleAdapter.reset({ dbPath });
  }
});

test("the store will not start without a database", () => {
  assert.throws(() => new ScheduleAdapter({}), /needs a database/);
});
