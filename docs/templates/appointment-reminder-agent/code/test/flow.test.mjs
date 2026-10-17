import test from "node:test";
import assert from "node:assert/strict";
import { STATES, handleUtterance, detectVoicemail, normalizeDob } from "../src/flow.mjs";
import { dialGreeting } from "../src/offline.mjs";
import { harness, answered, verified, JORDAN_DETAILS, TOO_LATE } from "./helpers.mjs";

const agentLines = (snapshot) => snapshot.transcript.filter((t) => t.role === "agent").map((t) => t.text).join(" ");

test("voicemail detector covers phrase, beep, long greeting, and long human hello false positive guard", () => {
  assert.equal(detectVoicemail({ text: "please leave a message", durationMs: 500, thresholdMs: 4500 }).voicemail, true);
  assert.equal(detectVoicemail({ text: "beep", durationMs: 100, thresholdMs: 4500 }).reason, "beep");
  assert.equal(detectVoicemail({ text: "hello this is a long office greeting", durationMs: 4600, thresholdMs: 4500 }).voicemail, true);
  assert.equal(detectVoicemail({ text: "hello hello hello", durationMs: 1200, thresholdMs: 4500 }).voicemail, false);
});

test("voicemail detector names the greeting's words before any beep, so the trail can say why", () => {
  const detected = detectVoicemail({ text: "Please leave a message after the tone. Beep.", durationMs: 800, thresholdMs: 4500 });
  assert.equal(detected.voicemail, true);
  assert.match(detected.reason, /^phrase:/);
});

test("correct right-party and DOB confirm appointment with prep", () => {
  const { flow, schedule } = harness(); const call = answered(flow);
  handleUtterance(flow, call.id, "yes this is Jordan");
  assert.equal(flow.get(call.id).state, STATES.VERIFYING);
  assert.equal(flow.snapshot(call.id).disclosed, false);
  handleUtterance(flow, call.id, "03/12/1984");
  assert.equal(flow.get(call.id).verified, true);
  const r = handleUtterance(flow, call.id, "yes");
  assert.equal(r.outcome, "confirmed");
  assert.equal(schedule.getAppointment("A-20418").status, "confirmed");
  assert.match(flow.snapshot(call.id).lastPhrase, /8 hours|8 horas/);
});

test("a Spanish-speaking patient verifies and confirms in Spanish", () => {
  const { flow, schedule } = harness(); const call = answered(flow);
  assert.equal(flow.get(call.id).language, "es");
  handleUtterance(flow, call.id, "Sí, soy yo.");
  assert.equal(handleUtterance(flow, call.id, "12 de marzo de 1984").status, "verified");
  assert.equal(handleUtterance(flow, call.id, "Sí, ahí estaré.").outcome, "confirmed");
  assert.equal(schedule.getAppointment("A-20418").status, "confirmed");
  assert.match(flow.snapshot(call.id).lastPhrase, /8 horas/);
});

test("wrong party gets callback wording and no appointment details", () => {
  const { flow } = harness(); const call = answered(flow, "A-20418", { language: "en" });
  const r = handleUtterance(flow, call.id, "No, this is his brother");
  assert.equal(r.outcome, "wrong_party");
  assert.match(r.say, /206-555-0100/);
  assert.doesNotMatch(agentLines(flow.snapshot(call.id)), JORDAN_DETAILS);
  assert.equal(flow.snapshot(call.id).disclosed, false);
});

test("DOB one wrong then correct succeeds; two wrong ends unverified", () => {
  const h1 = harness(); const c1 = answered(h1.flow); handleUtterance(h1.flow, c1.id, "yes");
  assert.equal(handleUtterance(h1.flow, c1.id, "01/01/1984").status, "retry");
  assert.equal(handleUtterance(h1.flow, c1.id, "03121984").status, "verified");
  const h2 = harness(); const c2 = answered(h2.flow); handleUtterance(h2.flow, c2.id, "yes");
  handleUtterance(h2.flow, c2.id, "01/01/1984");
  const r = handleUtterance(h2.flow, c2.id, "02/02/1984");
  assert.equal(r.outcome, "unverified");
  assert.equal(h2.flow.get(c2.id).verified, false);
  assert.doesNotMatch(agentLines(h2.flow.snapshot(c2.id)), JORDAN_DETAILS);
});

test("a keyed date of birth is collected eight digits at a time and never written to the trail", () => {
  const { flow, audit } = harness(); const call = answered(flow, "A-20418", { language: "en" });
  handleUtterance(flow, call.id, "Yes, this is Jordan.");
  for (const key of "0312198") assert.equal(flow.dtmf(call.id, key).status, "collecting");
  assert.equal(flow.snapshot(call.id).verified, false);
  assert.equal(flow.dtmf(call.id, "4").status, "verified");
  const trail = audit.eventsFor(call.id).map((e) => e.detail ?? "").join(" ");
  assert.match(trail, /date of birth entered/);
  assert.doesNotMatch(trail, /0312|1984/);
});

test("DOB normalization accepts keypad digits and spoken month names in English or Spanish", () => {
  assert.equal(normalizeDob("03121984"), "1984-03-12");
  assert.equal(normalizeDob("March 12th, 1984."), "1984-03-12");
  assert.equal(normalizeDob("12 de marzo de 1984"), "1984-03-12");
  assert.equal(normalizeDob("sometime in spring"), "");
});

test("authorized proxy can act and unauthorized proxy is refused", () => {
  const h1 = harness(); const c1 = answered(h1.flow); handleUtterance(h1.flow, c1.id, "I'm his wife Alex"); handleUtterance(h1.flow, c1.id, "1984-03-12");
  assert.equal(h1.flow.get(c1.id).verified, true);
  assert.equal(h1.flow.get(c1.id).proxyName, "Alex Rivera");
  const h2 = harness(); const c2 = answered(h2.flow, "A-20427");
  const r = handleUtterance(h2.flow, c2.id, "I'm her son Luis");
  assert.equal(r.outcome, "unauthorized_proxy");
});

test("cancel with explicit yes releases slot; maybe is rejected", () => {
  const { flow, schedule } = harness(); const call = verified(flow);
  handleUtterance(flow, call.id, "I need to cancel");
  assert.equal(handleUtterance(flow, call.id, "maybe").reason, "needs_explicit_yes");
  const r = handleUtterance(flow, call.id, "yes cancel it");
  assert.equal(r.outcome, "cancelled");
  assert.equal(schedule.getAppointment("A-20418").status, "cancelled");
  assert.deepEqual(schedule.releasedSlots().map((s) => s.appointmentId), ["A-20418"]);
});

test("late cancellation notice appears inside 24 hours", () => {
  const { flow } = harness({ now: "2026-05-20T12:00:00-07:00" });
  const call = verified(flow);
  const r = handleUtterance(flow, call.id, "cancel");
  assert.equal(r.lateCancellation, true);
  assert.match(r.say, /less than 24 hours|menos de 24 horas/);
});

test("opt-out persists before call end and blocks future dial plan", () => {
  const { flow, schedule } = harness(); const call = answered(flow);
  const r = handleUtterance(flow, call.id, "stop calling me");
  assert.equal(r.outcome, "opted_out");
  assert.equal(schedule.isSuppressed("P-1007"), true);
  assert.equal(flow.evaluateDialEligibility(schedule.getAppointment("A-20418")).reason, "suppressed");
});

test("DTMF 1 confirms, 3 reschedules, 9 opts out, star repeats", () => {
  const h1 = harness(); const c1 = verified(h1.flow); assert.equal(h1.flow.dtmf(c1.id, "*").repeated, true); assert.equal(h1.flow.dtmf(c1.id, "1").outcome, "confirmed");
  const h2 = harness(); const c2 = verified(h2.flow); assert.equal(h2.flow.dtmf(c2.id, "3").ok, true);
  const h3 = harness(); const c3 = answered(h3.flow); assert.equal(h3.flow.dtmf(c3.id, "9").outcome, "opted_out");
});

test("keypad 1 before the date of birth matches is refused: nothing is confirmed unverified", () => {
  const { flow, schedule } = harness(); const call = answered(flow);
  assert.equal(flow.dtmf(call.id, "1").reason, "not_verified");
  assert.equal(schedule.getAppointment("A-20418").status, "booked");
});

test("clinical question and emergency phrase are server handled", () => {
  const { flow } = harness(); const call = verified(flow);
  const e = handleUtterance(flow, call.id, "I'm having chest pain right now");
  assert.equal(e.emergency, true);
  assert.match(e.say, /911/);
  const n = handleUtterance(flow, call.id, "Should I still come if I have a fever?");
  assert.ok(["transfer", "advice_number"].includes(n.action));
});

test("busy and no-answer retry, bad number, voicemail last attempt", () => {
  const h1 = harness(); const c1 = h1.flow.create({ appointmentId: "A-20418" }); h1.flow.answered(c1.id); assert.equal(h1.flow.applyDialOutcome(c1.id, "busy").state, STATES.RETRY_SCHEDULED);
  const h2 = harness(); const c2 = h2.flow.create({ appointmentId: "A-20418" }); h2.flow.answered(c2.id); assert.equal(h2.flow.applyDialOutcome(c2.id, "bad_number").outcome, "bad_number");
  const h3 = harness(); h3.schedule.recordAttempt({ appointmentId: "A-20418", patientId: "P-1007", state: "retry_scheduled", outcome: "no_answer", attempt: 1 }); h3.schedule.recordAttempt({ appointmentId: "A-20418", patientId: "P-1007", state: "retry_scheduled", outcome: "busy", attempt: 2 });
  const c3 = h3.flow.create({ appointmentId: "A-20418" }); h3.flow.answered(c3.id);
  const r = h3.flow.applyDialOutcome(c3.id, "voicemail", { greetingText: "leave a message beep", greetingMs: 5000, beep: true });
  assert.equal(r.outcome, "voicemail_left");
  assert.doesNotMatch(r.say, JORDAN_DETAILS);
});

test("placed voicemail: the last attempt leaves a callback request only; earlier attempts hang up and retry", () => {
  const greeting = dialGreeting("voicemail", "Avery");
  const last = harness();
  const placed = last.flow.placeSimulatedCall({ appointmentId: "A-20419", language: "en", attempt: 3, outcome: "voicemail", greeting });
  const snap = last.flow.snapshot(placed.callId);
  assert.equal(snap.outcome, "voicemail_left");
  assert.equal(snap.transcript[0].text, greeting.greetingText);
  assert.match(agentLines(snap), /206-555-0100/);
  assert.doesNotMatch(agentLines(snap), /primary care|Dr\. Patel|10:15|Northgate/i);
  assert.equal(last.audit.stats().privacySafeVoicemails, 1);

  const first = harness();
  const early = first.flow.snapshot(first.flow.placeSimulatedCall({ appointmentId: "A-20419", language: "en", attempt: 1, outcome: "voicemail", greeting }).callId);
  assert.equal(early.outcome, "voicemail_hangup");
  assert.equal(early.state, STATES.RETRY_SCHEDULED);
  assert.ok(early.nextAllowedAt);
  assert.equal(agentLines(early), "");
});

test("too late to call: nothing is dialed, and the reason and next allowed time are given", () => {
  const { flow, schedule, audit } = harness({ now: TOO_LATE });
  const placed = flow.placeSimulatedCall({ appointmentId: "A-20418", language: "en", greeting: dialGreeting("answered") });
  assert.equal(placed.refused, true);
  assert.equal(placed.gate.reason, "calling_window");
  const snap = flow.snapshot(placed.callId);
  assert.equal(snap.state, STATES.NOT_PLACED);
  assert.equal(snap.nextAllowedAt, "2026-05-20T15:00:00.000Z");
  assert.match(snap.why, /8:00 AM–8:00 PM/);
  assert.match(snap.why, /8:30 PM/);
  assert.match(snap.why, /Next allowed: Wed, May 20, 8:00 AM PDT/);
  assert.equal(snap.transcript.length, 0);
  assert.equal(schedule.attemptsFor("A-20418").length, 0);
  assert.equal(audit.stats().notPlaced, 1);
});

test("a simulated reschedule hands off to the scheduling desk with VoIP headers and books nothing", () => {
  const { flow, schedule } = harness();
  const placed = flow.placeSimulatedCall({ appointmentId: "A-20423", language: "en", greeting: dialGreeting("answered") });
  for (const line of ["Yes, this is Riley.", "August 14th, 2002.", "Can I come next week instead?"]) handleUtterance(flow, placed.callId, line);
  const snap = flow.snapshot(placed.callId);
  assert.equal(snap.outcome, "reschedule_handoff");
  assert.equal(snap.handoff.queue, "Scheduling desk");
  assert.deepEqual(snap.handoff.voipHeaders.map((h) => h.key), ["CallDetails.SessionId", "CallDetails.CallTopic", "CallDetails.CallContext"]);
  assert.equal(snap.handoff.callContext.verified, true);
  assert.equal(schedule.getAppointment("A-20423").status, "booked");
  assert.equal(schedule.hasOpenRescheduleRequest("A-20423"), true);
  assert.equal(flow.evaluateDialEligibility(schedule.getAppointment("A-20423")).reason, "reschedule_pending");
});

test("with no scheduling desk configured, a real call's reschedule request becomes a logged callback", () => {
  const { flow, schedule } = harness();
  const call = verified(flow, "A-20418", "03/12/1984", { language: "en" });
  const r = handleUtterance(flow, call.id, "can I come next week instead");
  assert.equal(r.outcome, "reschedule_callback");
  assert.equal(r.transfer, null);
  assert.equal(schedule.getAppointment("A-20418").status, "booked");
  assert.equal(schedule.hasOpenRescheduleRequest("A-20418"), true);
});

test("ending a call from outside the conversation speaks nothing new", () => {
  const { flow } = harness(); const call = answered(flow, "A-20418", { language: "en" });
  const r = flow.endCall(call.id, "caller_hung_up");
  assert.equal(r.outcome, "caller_hung_up");
  assert.equal(r.say, null);
  assert.equal(flow.endCall(call.id).outcome, "caller_hung_up");
});
