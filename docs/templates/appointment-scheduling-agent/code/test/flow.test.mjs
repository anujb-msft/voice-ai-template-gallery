import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateEligibility, demandsBooking, isAffirmative, maskTranscript, normalizeDob, parseIdentity } from "../src/flow.mjs";
import { reminderToSchedulingContext } from "../src/handoff.mjs";
import { handleUtterance } from "../src/offline.mjs";
import {
  FIRST_NEW_ID, FRI, JORDAN, MIA, POLICY, SEEDED_APPOINTMENTS, TUE,
  agentLines, answer, lastAgentLine, makeFlow, toOffering, tool, trail,
} from "./harness.mjs";

/**
 * The booking invariant, end to end through the flow:
 *
 *   - the model's tools can find, hold and read back a time, but never write;
 *   - only the caller's own yes to the ACTIVE proposal books;
 *   - when that time was taken in the meantime (slot_taken), nothing is
 *     written, and only a fresh pick and a fresh yes can book.
 *
 * The tests drive the flow the way a live call does: model turns go through
 * the tool dispatcher, caller turns through the server's gate (callerSaid).
 */

const checkStatus = (snapshot) => Object.fromEntries(snapshot.checks.map((c) => [c.id, c.status]));

// --------------------------------------------------------------- the invariant

test("only the caller's yes to the active proposal books, and the model's own write is refused", async () => {
  const { flow, audit, schedule } = await makeFlow();
  const id = answer(flow);

  const { verified, chosen, search } = toOffering(flow, id);
  assert.equal(verified.result, "verified");
  assert.equal(verified.firstName, "Jordan");
  assert.equal(chosen.result, "eligible");
  assert.deepEqual(search.options.map((o) => o.spoken), ["today at 11 a.m.", "tomorrow at 1 p.m."]);

  const held = tool(flow, id, "hold_slot", { optionIndex: 1 });
  assert.equal(held.ok, true);
  assert.equal(flow.snapshot(id).proposal.id, "P1");
  assert.match(lastAgentLine(flow, id), /follow-up visit with Dr\. Patel on Tuesday, May 19th, at 11 a\.m\., at the Northgate clinic/);

  // The model reaches for a booking tool it does not have.
  const attempt = tool(flow, id, "book", { optionIndex: 1, confirmed: true });
  assert.deepEqual(
    { ok: attempt.ok, refused: attempt.refused, reason: attempt.reason, booked: attempt.booked },
    { ok: false, refused: true, reason: "model_cannot_book", booked: false },
  );
  assert.equal(schedule.stats().appointments, SEEDED_APPOINTMENTS, "nothing written");
  assert.equal(flow.snapshot(id).proposal.status, "active", "the proposal still waits for the caller");

  const yes = flow.callerSaid(id, "Yes, please.");
  assert.equal(yes.handled, true);
  assert.equal(yes.result, "booked");
  assert.equal(yes.appointmentId, FIRST_NEW_ID);
  assert.equal(yes.confirmation, "A-2-0-4-4-0");

  const snapshot = flow.snapshot(id);
  assert.equal(snapshot.state, "booked");
  assert.deepEqual(
    { proposalId: snapshot.booking.proposalId, consent: snapshot.booking.consent, afterRace: snapshot.booking.afterRace, label: snapshot.booking.label },
    { proposalId: "P1", consent: "said yes", afterRace: false, label: "Tue, May 19 · 11:00 AM" },
  );
  assert.deepEqual(checkStatus(snapshot), { identity: "pass", eligibility: "pass", proposal: "pass", consent: "pass" });
  assert.equal(snapshot.checks.find((c) => c.id === "consent").detail, "said yes to P1");
  assert.ok(trail(audit, id).includes("agent write_refused the model has no booking tool · nothing written"));
  assert.ok(trail(audit, id).some((line) => line.startsWith(`system booked ${FIRST_NEW_ID}`)));
  assert.match(lastAgentLine(flow, id), /You're booked with Dr\. Patel today at 11 a\.m\., at the Northgate clinic\. Please arrive 15 minutes early\. Your confirmation number is A-2-0-4-4-0\./);

  assert.equal(schedule.stats().bookingsByVoice, 1);
  assert.equal(audit.stats().booked, 1);
  assert.equal(audit.stats().refusedWrites, 1);
});

test("book, reschedule and cancel are refused by name, whatever arguments the model invents", async () => {
  const { flow, schedule } = await makeFlow();
  const id = answer(flow);
  toOffering(flow, id);
  tool(flow, id, "hold_slot", { optionIndex: 1 });
  for (const [name, args] of [["book", { confirmed: true }], ["reschedule", { appointmentId: "A-20432" }], ["cancel", { appointmentId: "A-20432" }]]) {
    const result = tool(flow, id, name, args);
    assert.equal(result.refused, true, name);
    assert.equal(result.reason, "model_cannot_book", name);
    assert.equal(result.tool, name);
  }
  assert.equal(flow.snapshot(id).refusals, 3);
  assert.equal(schedule.stats().appointments, SEEDED_APPOINTMENTS);
  assert.equal(schedule.getAppointment("A-20432").status, "booked", "the existing appointment is untouched");
});

test("\"just book whatever\" before any time is proposed writes nothing", async () => {
  const { flow, audit, schedule } = await makeFlow();
  const id = answer(flow, MIA.phone);
  handleUtterance(flow, id, "Mia Chen, 02/18/1991");
  assert.equal(flow.get(id).state, "verified");

  const gate = flow.callerSaid(id, "Just book me whatever you have.");
  assert.equal(gate.refused, true);
  assert.equal(gate.reason, "no_active_proposal");
  assert.equal(gate.say, "I can't book anything until you've heard a specific time and said yes to it. What kind of visit do you need?");
  assert.ok(trail(audit, id).includes("caller write_refused no active proposal · nothing written"));
  assert.deepEqual(checkStatus(flow.snapshot(id)), { identity: "pass", eligibility: "pending", proposal: "pending", consent: "pending" });
  assert.equal(schedule.stats().appointments, SEEDED_APPOINTMENTS);
});

test("a yes counts only when a time has been read back, and only if it does not change the choice", async () => {
  const { flow, schedule } = await makeFlow();
  const id = answer(flow);
  toOffering(flow, id);

  // Two options offered, nothing read back yet: a yes is just conversation.
  assert.equal(flow.get(id).state, "offering");
  assert.equal(flow.callerSaid(id, "Yes.").handled, false);
  assert.equal(schedule.stats().appointments, SEEDED_APPOINTMENTS);

  tool(flow, id, "hold_slot", { optionIndex: 1 });
  // "Yes, but the second one" is a new pick, not consent to P1.
  assert.equal(flow.callerSaid(id, "Yes, but the second one.").handled, false);
  assert.equal(flow.snapshot(id).proposal.status, "active");
  assert.equal(schedule.stats().appointments, SEEDED_APPOINTMENTS);
});

test("slot_taken: the yes is refused, the time is not offered again, and only a fresh pick and a fresh yes book", async () => {
  const { flow, audit, schedule } = await makeFlow();
  const id = answer(flow);
  toOffering(flow, id);
  tool(flow, id, "hold_slot", { optionIndex: 1 });

  // The front desk books the read-back time. The caller is not told yet.
  const taken = flow.takeSlotForDemo(id);
  assert.deepEqual(
    { ok: taken.ok, result: taken.result, appointmentId: taken.appointmentId, proposalId: taken.proposalId },
    { ok: true, result: "taken", appointmentId: FIRST_NEW_ID, proposalId: "P1" },
  );

  const yes = flow.callerSaid(id, "Yes, book it.");
  assert.equal(yes.handled, true);
  assert.equal(yes.result, "options");
  assert.equal(yes.booked, false);
  assert.equal(
    lastAgentLine(flow, id),
    "Sorry, that time was just taken, so I haven't booked anything. Dr. Patel still has today at 11:15 a.m., or tomorrow at 1 p.m. Would either of those work?",
  );

  let snapshot = flow.snapshot(id);
  assert.equal(snapshot.proposal, null, "the proposal is void");
  assert.equal(snapshot.raceLost.proposalId, "P1");
  assert.equal(snapshot.races, 1);
  assert.equal(snapshot.consent.refused, "slot_taken");
  assert.equal(checkStatus(snapshot).proposal, "fail");
  assert.ok(!snapshot.options.some((o) => o.start === "2026-05-19T11:00:00-07:00"), "the lost time is not offered again");
  assert.equal(schedule.stats().bookingsByVoice, 0, "the server did not book a neighboring time");

  // The old yes does not carry over: with nothing read back, yes books nothing.
  assert.equal(flow.callerSaid(id, "Yes.").handled, false);
  assert.equal(schedule.stats().bookingsByVoice, 0);

  tool(flow, id, "hold_slot", { optionIndex: 1 });
  assert.equal(flow.snapshot(id).proposal.id, "P2");
  const fresh = flow.callerSaid(id, "Yes.");
  assert.equal(fresh.result, "booked");
  assert.equal(fresh.appointmentId, "A-20441");

  snapshot = flow.snapshot(id);
  assert.equal(snapshot.booking.proposalId, "P2");
  assert.equal(snapshot.booking.start, "2026-05-19T11:15:00-07:00");
  assert.equal(snapshot.booking.afterRace, true);
  const events = trail(audit, id);
  assert.ok(events.some((line) => line.startsWith("system taken_elsewhere Tue, May 19 · 11:00 AM booked by the front desk")));
  assert.ok(events.includes("system write_refused P1 · slot_taken · nothing written"));
  assert.ok(events.some((line) => line.startsWith("system slot_taken P1 void")));
  assert.ok(events.includes("system race_resolved A-20441 · fresh pick P2, fresh yes"));

  const stats = audit.stats();
  assert.deepEqual(
    { booked: stats.booked, refusedWrites: stats.refusedWrites, racesLost: stats.racesLost, racesResolved: stats.racesResolved, takenElsewhere: stats.takenElsewhere },
    { booked: 1, refusedWrites: 1, racesLost: 1, racesResolved: 1, takenElsewhere: 1 },
  );
  assert.equal(schedule.stats().frontDeskBookings, 1);
  assert.equal(schedule.stats().bookingsByVoice, 1);
});

test("the front desk can only take a time that has been offered", async () => {
  const { flow } = await makeFlow();
  const id = answer(flow);
  assert.equal(flow.takeSlotForDemo(id).error, "nothing_to_take");
  assert.equal(flow.takeSlotForDemo("no-such-call").error, "unknown_call");
});

test("a hold that ran out books nothing, and the caller hears fresh options", async () => {
  const { flow, advance, schedule } = await makeFlow();
  const id = answer(flow);
  toOffering(flow, id);
  tool(flow, id, "hold_slot", { optionIndex: 1 });
  advance(POLICY.holdTtlMs + 1_000);

  const yes = flow.callerSaid(id, "Yes.");
  assert.equal(yes.handled, true);
  assert.equal(yes.result, "options");
  assert.equal(yes.booked, false);
  assert.match(lastAgentLine(flow, id), /^Sorry, I held that time as long as I could and it was released, so I haven't booked anything\./);
  assert.equal(flow.snapshot(id).proposal, null);
  assert.equal(schedule.stats().bookingsByVoice, 0);
  assert.equal(schedule.stats().activeHolds, 0);
});

test("the keypad: 2 declines, 1 confirms the active proposal, and neither means anything without one", async () => {
  const { flow, schedule } = await makeFlow();
  const id = answer(flow);
  toOffering(flow, id);
  assert.equal(flow.dtmf(id, "1").handled, false, "nothing read back yet");

  tool(flow, id, "hold_slot", { optionIndex: 2 });
  const declined = flow.dtmf(id, "2");
  assert.equal(declined.result, "declined");
  assert.equal(flow.get(id).state, "offering");
  assert.equal(schedule.stats().activeHolds, 0, "a declined time is released");

  tool(flow, id, "hold_slot", { optionIndex: 1 });
  const confirmed = flow.dtmf(id, "1");
  assert.equal(confirmed.result, "booked");
  assert.equal(flow.snapshot(id).booking.proposalId, "P2");
  assert.equal(flow.snapshot(id).booking.consent, "pressed 1");
  assert.equal(flow.snapshot(id).consent.via, "keypad");
});

test("0 on the keypad asks for a person at any point, with what was decided so far", async () => {
  const { flow, schedule } = await makeFlow();
  const id = answer(flow);
  toOffering(flow, id);
  assert.equal(handleUtterance(flow, id, "0").result, "transferring");
  const snapshot = await flow.settled(id);
  assert.equal(snapshot.outcome, "transferred:scheduling_team");
  assert.equal(snapshot.handoff.callTopic, "Scheduling – caller request");
  assert.deepEqual(snapshot.handoff.callContext, {
    firstName: "Jordan",
    verified: "yes (name + date of birth)",
    visitType: "follow-up visit",
    eligibility: "eligible (no referral needed)",
    reason: "caller request",
    summary: "Verified patient · follow-up visit · nothing booked",
  });
  assert.equal(schedule.stats().appointments, SEEDED_APPOINTMENTS);
});

// --------------------------------------------------------------- identity

test("identity: caller ID is not proof, two misses disclose nothing, and a person takes over", async () => {
  const { flow, audit } = await makeFlow();
  const id = answer(flow, JORDAN.phone);
  assert.equal(flow.snapshot(id).callerIdMatch, true);
  assert.equal(flow.snapshot(id).patient, null, "a matching caller ID verifies nobody");

  const first = tool(flow, id, "verify_patient", { fullName: "Jordan Rivera", dob: "1984-03-21" });
  assert.deepEqual({ ok: first.ok, result: first.result, attempt: first.attempt }, { ok: false, result: "not_verified", attempt: 1 });
  assert.equal(tool(flow, id, "list_upcoming").error, "not_verified");
  assert.equal(tool(flow, id, "search_slots", { providerPreference: "Dr. Patel" }).error, "not_verified");
  assert.equal(flow.snapshot(id).checks[0].status, "warn");

  const second = tool(flow, id, "verify_patient", { fullName: "Jordan Rivera", dob: "1984-12-03" });
  assert.deepEqual(
    { result: second.result, destination: second.destination, booked: second.booked, verified: second.verified },
    { result: "transferring", destination: "scheduling_team", booked: false, verified: false },
  );
  const snapshot = await flow.settled(id);
  assert.equal(snapshot.outcome, "transferred:scheduling_team");
  assert.equal(snapshot.destination.reason, "verification_failed");
  assert.equal(snapshot.checks[0].status, "fail");
  assert.equal(snapshot.handoff.callTopic, "Scheduling – identity not confirmed");
  assert.deepEqual(snapshot.handoff.callContext, {
    verified: "no",
    reason: "verification failed",
    summary: "Caller not verified after two attempts · nothing about appointments disclosed",
  });
  for (const line of agentLines(flow, id)) {
    assert.doesNotMatch(line, /Dr\.|\bMay\b|\d{1,2}(?::\d{2})? [ap]\.m\.|Jordan/, `disclosed: ${line}`);
  }
  assert.ok(trail(audit, id).includes("system identity_failed attempt 1 of 2"));
  assert.equal(audit.stats().identityNotConfirmed, 1);
});

test("a miss reads the same whether or not the patient exists", async () => {
  const { flow } = await makeFlow();
  const real = answer(flow);
  const unknown = answer(flow, "+12065550199");
  const strip = ({ next, ...rest }) => rest;
  assert.deepEqual(
    strip(tool(flow, real, "verify_patient", { fullName: "Jordan Rivera", dob: "1990-01-01" })),
    strip(tool(flow, unknown, "verify_patient", { fullName: "Pat Nobody", dob: "1990-01-01" })),
  );
});

test("a reminder handoff verifies once by its one-time token, and a reused token verifies nobody", async () => {
  const { flow, schedule, audit } = await makeFlow();
  const issued = schedule.issueHandoffToken({ appointmentId: "A-20432", patientId: JORDAN.patientId, correlationId: "session-1" });
  // The CallContext the appointment reminder agent sends: its token travels as patientRef.
  const handoff = reminderToSchedulingContext({ appointmentId: "A-20432", patientRef: issued.token, sessionId: "session-1" });

  const first = answer(flow, JORDAN.phone, { sessionId: "session-1", handoff });
  assert.equal(flow.get(first).state, "verified");
  assert.equal(flow.snapshot(first).checks[0].detail, "Jordan R. · one-time reminder token");
  assert.match(lastAgentLine(flow, first), /^Hi Jordan, .* new time for your X-ray with Dr\. Lee on Saturday, May 23rd, at 9:30 a\.m\./);

  const again = answer(flow, JORDAN.phone, { sessionId: "session-2", handoff: { ...handoff, sessionId: "session-2" } });
  assert.equal(flow.get(again).state, "verifying");
  assert.equal(flow.snapshot(again).patient, null);
  assert.ok(trail(audit, again).includes("system handoff_rejected used · verifying by name and date of birth instead"));
});

// --------------------------------------------------------------- eligibility and people

test("a referral-only visit is not offered, and the referral coordinator sees why", async () => {
  const { flow, schedule } = await makeFlow();
  const id = answer(flow);
  tool(flow, id, "verify_patient", { fullName: JORDAN.fullName, dob: JORDAN.dob });
  const chosen = tool(flow, id, "choose_visit_type", { code: "DERM_SKIN_CHECK" });
  assert.deepEqual(
    { ok: chosen.ok, result: chosen.result, ruleId: chosen.ruleId, alternatives: chosen.alternatives },
    { ok: true, result: "not_eligible", ruleId: "REFERRAL_REQUIRED", alternatives: ["book_pcp_visit", "referral_coordinator_callback"] },
  );
  assert.equal(flow.snapshot(id).checks[1].status, "fail");
  const search = tool(flow, id, "search_slots", {});
  assert.equal(search.result, "not_eligible", "asking again gets the same answer");
  assert.ok(!search.options?.length, "no times for a blocked visit");

  tool(flow, id, "transfer", { destination: "referral_coordinator" });
  const snapshot = await flow.settled(id);
  assert.equal(snapshot.outcome, "transferred:referral_coordinator");
  assert.equal(snapshot.handoff.callTopic, "Scheduling – referral needed");
  assert.deepEqual(snapshot.handoff.callContext, {
    firstName: "Jordan",
    verified: "yes (name + date of birth)",
    visitType: "skin check",
    department: "Dermatology",
    ruleId: "REFERRAL_REQUIRED",
    summary: "Verified patient · skin check · blocked: REFERRAL_REQUIRED · nothing booked",
  });
  assert.ok(snapshot.handoff.voipHeaders.every((h) => h.kind === "voip"));
  assert.deepEqual(snapshot.handoff.voipHeaders.map((h) => h.key).sort(), ["CallDetails.CallContext", "CallDetails.CallTopic", "CallDetails.SessionId"]);
  assert.ok(!JSON.stringify(snapshot.handoff).includes(JORDAN.dob), "no date of birth in the handoff");
  assert.equal(schedule.stats().appointments, SEEDED_APPOINTMENTS);
});

test("eligibility is the server's decision: referral, order and visit-frequency rules", () => {
  const at = new Date(TUE);
  const patient = (patientId) => ({ patientId });
  const cases = [
    [patient("P-1007"), "DERM_SKIN_CHECK", [], { eligible: false, ruleId: "REFERRAL_REQUIRED" }],
    [patient("P-1002"), "DERM_SKIN_CHECK", [], { eligible: true, basis: "active referral on file" }],
    [patient("P-1001"), "MRI", [], { eligible: false, ruleId: "ORDER_REQUIRED" }],
    [patient("P-1007"), "MRI", [], { eligible: true, basis: "active MRI order on file" }],
    [patient("P-1003"), "ANNUAL_PHYSICAL", [{ appointmentId: "A-20421", status: "booked", visitType: "annual physical", start: "2026-05-21T12:00:00-07:00" }], { eligible: false, ruleId: "ANNUAL_TOO_SOON" }],
    [patient("P-1001"), "ANNUAL_PHYSICAL", [], { eligible: true, basis: "no annual physical within 12 months" }],
    [patient("P-1007"), "FOLLOW_UP", [], { eligible: true, basis: "no referral needed" }],
    [patient("P-1007"), "TELEPORT", [], { eligible: false, ruleId: "UNKNOWN_VISIT_TYPE" }],
  ];
  for (const [who, visitTypeCode, appointments, expected] of cases) {
    const result = evaluateEligibility({ patient: who, visitTypeCode, appointments, now: at });
    for (const [key, value] of Object.entries(expected)) assert.equal(result[key], value, `${who.patientId} ${visitTypeCode} ${key}`);
  }
  // Moving the visit being rescheduled does not count against itself.
  const own = [{ appointmentId: "A-20421", status: "booked", visitType: "annual physical", start: "2026-05-21T12:00:00-07:00" }];
  assert.equal(evaluateEligibility({ patient: patient("P-1003"), visitTypeCode: "ANNUAL_PHYSICAL", appointments: own, now: at, excludeAppointmentId: "A-20421" }).eligible, true);
});

test("emergency words outrank an open proposal: nothing is booked and the nurse line hears it", async () => {
  for (const [at, outcome, line] of [
    [TUE, "transferred:nurse_line", "If this is an emergency, please hang up and call 911 now. I'm connecting you with our nurse line now."],
    [FRI, "advised:nurse_line", "If this is an emergency, please hang up and call 911 now. Our nurse line is closed right now. For advice now, please call the after-hours nurse line at 206-555-0199. Thanks for calling Contoso Health."],
  ]) {
    const { flow, schedule } = await makeFlow({ at });
    const id = answer(flow);
    toOffering(flow, id);
    tool(flow, id, "hold_slot", { optionIndex: 1 });
    const gate = flow.callerSaid(id, "Actually, I have chest pain and trouble breathing.");
    assert.equal(gate.handled, true);
    assert.equal(gate.booked, false);
    const snapshot = await flow.settled(id);
    assert.equal(snapshot.outcome, outcome);
    assert.equal(lastAgentLine(flow, id), line);
    assert.equal(snapshot.handoff.callTopic, "Nurse line – emergency words heard");
    assert.equal(schedule.stats().appointments, SEEDED_APPOINTMENTS);
    assert.equal(schedule.stats().activeHolds, 0, "the held time is released, not booked");
  }
});

test("after hours, a person becomes a callback to the caller ID, or the number to call when there is none", async () => {
  const withCallerId = await makeFlow({ at: FRI });
  const a = answer(withCallerId.flow, JORDAN.phone);
  assert.equal(handleUtterance(withCallerId.flow, a, "Can I talk to a person?").result, "callback_filed");
  assert.equal(withCallerId.flow.get(a).outcome, "callback:scheduling_team");
  assert.equal(withCallerId.flow.snapshot(a).handoff.kind, "callback");
  assert.equal(withCallerId.flow.snapshot(a).handoff.callContext.summary, "Caller not verified · nothing disclosed");

  const withheld = await makeFlow({ at: FRI });
  const b = answer(withheld.flow, "anonymous");
  assert.equal(handleUtterance(withheld.flow, b, "Can I talk to a person?").result, "advised");
  assert.equal(withheld.flow.get(b).outcome, "advised:scheduling_team");
  assert.equal(lastAgentLine(withheld.flow, b), "Our scheduling team is closed right now. Please call us back at 206-555-0100 during business hours. Thanks for calling Contoso Health.");
});

test("silence: asked once, then a person (or, after hours, the number to call back)", async () => {
  const open = await makeFlow();
  const a = answer(open.flow);
  assert.equal(open.flow.noInput(a).result, "reprompted");
  assert.equal(open.flow.noInput(a).result, "transferring");
  const snapshot = await open.flow.settled(a);
  assert.equal(snapshot.destination.reason, "two_no_inputs");
  assert.equal(snapshot.handoff.callTopic, "Scheduling – caller not heard");

  const closed = await makeFlow({ at: FRI });
  const b = answer(closed.flow);
  closed.flow.noInput(b);
  assert.equal(closed.flow.noInput(b).result, "advised");
  assert.equal(closed.flow.get(b).outcome, "advised:scheduling_team");
  assert.equal(lastAgentLine(closed.flow, b), "I'm having trouble hearing you. Please call us back at 206-555-0100 when you're ready. Thanks for calling Contoso Health.");
});

test("a call that runs past its time budget goes to a person, with nothing booked", async () => {
  const { flow, advance } = await makeFlow();
  const id = answer(flow);
  toOffering(flow, id);
  tool(flow, id, "hold_slot", { optionIndex: 1 });
  assert.deepEqual(flow.checkBudget(id), { ok: true });
  advance(POLICY.callTimeBudgetMs);
  assert.equal(flow.checkBudget(id).result, "transferring");
  const snapshot = await flow.settled(id);
  assert.equal(snapshot.destination.reason, "time_budget");
  assert.equal(snapshot.handoff.callTopic, "Scheduling – call ran long");
  assert.equal(snapshot.handoff.callContext.summary, "Verified patient · follow-up visit · nothing booked");
});

test("end_call can't drop a caller on the way to a person, but the caller hanging up still ends the call", async () => {
  // A long pause before the handoff leaves the call escalating.
  const pending = await makeFlow({ options: { transferDelayMs: 60_000 } });
  const a = answer(pending.flow);
  assert.equal(tool(pending.flow, a, "transfer", { destination: "scheduling_team" }).result, "transferring");
  const refused = tool(pending.flow, a, "end_call", { reason: "said goodbye" });
  assert.deepEqual([refused.ok, refused.reason], [false, "transfer_in_progress"]);
  assert.equal(pending.flow.get(a).state, "escalating", "the transfer still goes ahead");
  pending.flow.endCall(a, "caller_hung_up");
  assert.equal(pending.flow.get(a).outcome, "caller_hung_up");
  assert.equal(pending.flow.get(a).pendingDispatch, null, "nothing goes to Teams for a caller who has gone");

  // Teams has the call, but ACS can still report the transfer as failed, and then the caller needs the apology.
  const handed = await makeFlow();
  const b = answer(handed.flow);
  tool(handed.flow, b, "transfer", { destination: "scheduling_team" });
  assert.equal((await handed.flow.settled(b)).state, "transferred");
  assert.equal(tool(handed.flow, b, "end_call").reason, "transfer_in_progress");
});

test("a transfer that won't go through: one retry, then an apology with the number, and ACS's words stay in the server log", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const FIXED = "system transfer_failed Scheduling team (the reason is in the server log)";
  const tried = [];
  const failing = await makeFlow({
    transfer: async (_call, destination) => {
      tried.push(destination.id);
      throw new Error("Transfer to 8:acs:0000 failed: +12065550111 is not reachable");
    },
  });
  const a = answer(failing.flow, JORDAN.phone, { simulated: false });
  tool(failing.flow, a, "transfer", { destination: "scheduling_team" });
  assert.equal((await failing.flow.settled(a)).outcome, "transfer_failed");
  assert.deepEqual(tried, ["scheduling_team", "scheduling_team"]);
  assert.equal(lastAgentLine(failing.flow, a), "I'm sorry, I can't connect you right now. Please call us back at 206-555-0100.");
  assert.deepEqual(trail(failing.audit, a).filter((line) => line.includes("transfer_failed")), [FIXED, FIXED]);
  assert.doesNotMatch(JSON.stringify(failing.audit.eventsFor(a)), /8:acs|5550111/, "the console and the audit never see ACS's words");
  assert.equal(logged.mock.callCount(), 2);
  assert.match(logged.mock.calls[0].arguments.join(" "), /\+12065550111 is not reachable/);

  // ACS accepted, then reported CallTransferFailed. server.mjs logs the reason; the flow retries once.
  const accepted = await makeFlow({ transfer: async () => {} });
  const b = answer(accepted.flow, JORDAN.phone, { simulated: false });
  tool(accepted.flow, b, "transfer", { destination: "scheduling_team" });
  assert.equal((await accepted.flow.settled(b)).state, "transferred");
  await accepted.flow.transferFailed(b, "Call transfer failed: +12065550111 did not answer");
  assert.equal(accepted.flow.get(b).state, "transferred", "the retry went through");
  assert.ok(trail(accepted.audit, b).includes(FIXED));
  assert.doesNotMatch(JSON.stringify(accepted.audit.eventsFor(b)), /5550111/);
});

test("a write the store fails books nothing, a person takes over, and the store's error stays in the server log", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const { flow, audit, schedule } = await makeFlow();
  t.mock.method(schedule, "bookAppointment", () => {
    throw new Error("SQLITE_BUSY: database is locked (P-1007, Jordan Rivera)");
  });
  const id = answer(flow);
  toOffering(flow, id);
  tool(flow, id, "hold_slot", { optionIndex: 1 });
  const yes = flow.callerSaid(id, "Yes, please.");
  assert.equal(yes.result, "transferring");
  assert.equal(lastAgentLine(flow, id), "Sorry, something went wrong on our side, so I haven't booked anything. I'm connecting you with our scheduling team now.");
  assert.ok(trail(audit, id).includes("system write_refused P1 · write_failed · nothing written"));
  assert.doesNotMatch(JSON.stringify(audit.eventsFor(id)), /SQLITE_BUSY/);
  assert.equal(logged.mock.callCount(), 1);
  assert.match(logged.mock.calls[0].arguments.join(" "), /book P1 was not written: SQLITE_BUSY/);
  const snapshot = await flow.settled(id);
  assert.equal(snapshot.destination.reason, "write_failed");
  assert.equal(schedule.stats().appointments, SEEDED_APPOINTMENTS);
  assert.equal(schedule.stats().activeHolds, 0, "the held time is released");
});

// --------------------------------------------------------------- what is kept, and what the console hears

test("dates of birth and phone numbers are masked before a caller line is kept", async () => {
  assert.equal(maskTranscript("Jordan Rivera, 03/12/1984"), "Jordan Rivera, [date]");
  assert.equal(maskTranscript("Call me on 206-555-0142."), "Call me on [number ending 42].");
  assert.equal(maskTranscript("born March 12th, 1984"), "born [date]");

  const { flow, audit } = await makeFlow();
  const id = answer(flow);
  handleUtterance(flow, id, "Jordan Rivera, 03/12/1984");
  const kept = flow.get(id).transcript.filter((t) => t.role === "caller").map((t) => t.text);
  assert.deepEqual(kept, ["Jordan Rivera, [date]"]);
  assert.ok(!JSON.stringify(audit.eventsFor(id)).includes("1984"));
});

test("the gate's reading of a caller line", () => {
  for (const yes of ["Yes.", "Yes, please.", "Yeah, book it.", "That works.", "Sounds good"]) assert.equal(isAffirmative(yes), true, yes);
  for (const notYes of ["No.", "Yes, but the second one.", "Wait, actually, a different day.", "Not that one."]) assert.equal(isAffirmative(notYes), false, notYes);
  for (const demand of ["Just book me whatever you have.", "Book anything.", "Just put me in."]) assert.equal(demandsBooking(demand), true, demand);
  assert.equal(demandsBooking("I'd like to book a follow-up."), false);

  assert.deepEqual(parseIdentity("Jordan Rivera, 03/12/1984"), { proxyName: null, fullName: "Jordan Rivera", dob: "1984-03-12" });
  assert.deepEqual(parseIdentity("This is Alex Rivera calling for Jordan Rivera, March 12th, 1984"), { proxyName: "Alex Rivera", fullName: "Jordan Rivera", dob: "1984-03-12" });
  assert.equal(normalizeDob("12 March 1984"), "1984-03-12");
  assert.equal(normalizeDob("1984-13-01"), null);
});

test("the console hears every change, including the grid refreshes the race needs", async () => {
  const frames = [];
  const hub = { send: (callId, target, payload) => frames.push({ callId, target, payload }) };
  const { flow } = await makeFlow({ hub });
  const id = answer(flow);
  toOffering(flow, id);
  tool(flow, id, "hold_slot", { optionIndex: 1 });
  flow.takeSlotForDemo(id);
  flow.callerSaid(id, "Yes.");
  tool(flow, id, "hold_slot", { optionIndex: 1 });
  flow.callerSaid(id, "Yes.");

  const targets = new Set(frames.map((f) => f.target));
  for (const target of ["state", "event", "transcript", "schedule"]) assert.ok(targets.has(target), target);
  assert.ok(frames.every((f) => f.callId === id));
  const reasons = frames.filter((f) => f.target === "schedule").map((f) => f.payload.reason);
  for (const reason of ["taken_elsewhere", "slot_taken", "booked"]) assert.ok(reasons.includes(reason), reason);
});
