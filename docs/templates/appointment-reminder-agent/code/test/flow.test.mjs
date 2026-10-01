import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ScheduleAdapter } from "../src/schedule-store.mjs";
import { MemoryAudit } from "../src/audit.mjs";
import { AppointmentReminderFlow, STATES, handleUtterance, detectVoicemail, normalizeDob } from "../src/flow.mjs";

let seq = 0;
function harness(opts = {}) {
  const dbPath = join(process.cwd(), "data", `test-flow-${process.pid}-${seq++}.db`);
  ScheduleAdapter.reset({ dbPath });
  const schedule = new ScheduleAdapter({ dbPath, now: () => new Date(opts.now ?? "2026-05-19T10:00:00-07:00"), handoffTokenSecret: "test-secret" });
  const audit = new MemoryAudit();
  const flow = new AppointmentReminderFlow({ schedule, audit, now: () => new Date(opts.now ?? "2026-05-19T10:00:00-07:00") });
  return { schedule, audit, flow };
}
function answered(flow, appointmentId="A-20418") { const call = flow.create({ appointmentId }); flow.answered(call.id); flow.applyDialOutcome(call.id, "answered"); return call; }

test("voicemail detector covers phrase, beep, long greeting, and long human hello false positive guard", () => {
  assert.equal(detectVoicemail({ text: "please leave a message", durationMs: 500 }).voicemail, true);
  assert.equal(detectVoicemail({ text: "beep", durationMs: 100 }).reason, "beep");
  assert.equal(detectVoicemail({ text: "hello this is a long office greeting", durationMs: 4600 }).voicemail, true);
  assert.equal(detectVoicemail({ text: "hello hello hello", durationMs: 1200 }).voicemail, false);
});

test("correct right-party and DOB confirm appointment with prep", () => {
  const { flow, schedule } = harness(); const call = answered(flow);
  handleUtterance(flow, call.id, "yes this is Jordan");
  assert.equal(flow.get(call.id).state, STATES.VERIFYING);
  handleUtterance(flow, call.id, "03/12/1984");
  assert.equal(flow.get(call.id).verified, true);
  const r = handleUtterance(flow, call.id, "yes");
  assert.equal(r.outcome, "confirmed");
  assert.equal(schedule.getAppointment("A-20418").status, "confirmed");
  assert.match(flow.snapshot(call.id).lastPhrase, /8 hours|8 horas/);
  schedule.close();
});

test("wrong party gets callback wording and no appointment details", () => {
  const { flow, schedule } = harness(); const call = answered(flow);
  const r = handleUtterance(flow, call.id, "No, this is his brother");
  assert.equal(r.outcome, "wrong_party");
  assert.doesNotMatch(r.say, /Imaging|Dr\. Lee|9:30/);
  schedule.close();
});

test("DOB one wrong then correct succeeds; two wrong ends unverified", () => {
  const h1 = harness(); const c1 = answered(h1.flow); handleUtterance(h1.flow, c1.id, "yes");
  assert.equal(handleUtterance(h1.flow, c1.id, "01/01/1984").status, "retry");
  assert.equal(handleUtterance(h1.flow, c1.id, "03121984").status, "verified");
  h1.schedule.close();
  const h2 = harness(); const c2 = answered(h2.flow); handleUtterance(h2.flow, c2.id, "yes");
  handleUtterance(h2.flow, c2.id, "01/01/1984");
  const r = handleUtterance(h2.flow, c2.id, "02/02/1984");
  assert.equal(r.outcome, "unverified");
  assert.equal(h2.flow.get(c2.id).verified, false);
  h2.schedule.close();
});

test("authorized proxy can act and unauthorized proxy is refused", () => {
  const h1 = harness(); const c1 = answered(h1.flow); handleUtterance(h1.flow, c1.id, "I'm his wife Alex"); handleUtterance(h1.flow, c1.id, "1984-03-12");
  assert.equal(h1.flow.get(c1.id).verified, true);
  assert.equal(h1.flow.get(c1.id).proxyName, "Alex Rivera"); h1.schedule.close();
  const h2 = harness(); const c2 = answered(h2.flow, "A-20427");
  const r = handleUtterance(h2.flow, c2.id, "I'm her son Luis");
  assert.equal(r.outcome, "unauthorized_proxy"); h2.schedule.close();
});

test("cancel with explicit yes releases slot; maybe is rejected", () => {
  const { flow, schedule } = harness(); const call = answered(flow); handleUtterance(flow, call.id, "yes"); handleUtterance(flow, call.id, "03/12/1984");
  const proposal = handleUtterance(flow, call.id, "I need to cancel");
  assert.equal(handleUtterance(flow, call.id, "maybe").reason, "needs_explicit_yes");
  const r = handleUtterance(flow, call.id, "yes cancel it");
  assert.equal(r.outcome, "cancelled");
  assert.equal(schedule.getAppointment("A-20418").status, "cancelled");
  assert.equal(schedule.db.prepare("SELECT COUNT(*) n FROM released_slots WHERE appointment_id='A-20418'").get().n, 1);
  schedule.close();
});

test("late cancellation notice appears inside 24 hours", () => {
  const { flow, schedule } = harness({ now: "2026-05-20T12:00:00-07:00" });
  const call = answered(flow, "A-20418"); handleUtterance(flow, call.id, "yes"); handleUtterance(flow, call.id, "03/12/1984");
  const r = handleUtterance(flow, call.id, "cancel");
  assert.equal(r.lateCancellation, true);
  assert.match(r.say, /less than 24 hours|menos de 24 horas/);
  schedule.close();
});

test("opt-out persists before call end and blocks future dial plan", () => {
  const { flow, schedule } = harness(); const call = answered(flow);
  const r = handleUtterance(flow, call.id, "stop calling me");
  assert.equal(r.outcome, "opted_out");
  assert.equal(schedule.isSuppressed("P-1007"), true);
  assert.equal(flow.evaluateDialEligibility(schedule.getAppointment("A-20418")).reason, "suppressed");
  schedule.close();
});

test("DTMF 1 confirms, 3 reschedules, 9 opts out, star repeats", () => {
  const h1 = harness(); const c1 = answered(h1.flow); handleUtterance(h1.flow, c1.id, "yes"); handleUtterance(h1.flow, c1.id, "03/12/1984"); assert.equal(h1.flow.dtmf(c1.id, "*").repeated, true); assert.equal(h1.flow.dtmf(c1.id, "1").outcome, "confirmed"); h1.schedule.close();
  const h2 = harness(); const c2 = answered(h2.flow); handleUtterance(h2.flow, c2.id, "yes"); handleUtterance(h2.flow, c2.id, "03/12/1984"); assert.equal(h2.flow.dtmf(c2.id, "3").ok, true); h2.schedule.close();
  const h3 = harness(); const c3 = answered(h3.flow); assert.equal(h3.flow.dtmf(c3.id, "9").outcome, "opted_out"); h3.schedule.close();
});

test("clinical question and emergency phrase are server handled", () => {
  const { flow, schedule } = harness(); const call = answered(flow); handleUtterance(flow, call.id, "yes"); handleUtterance(flow, call.id, "03/12/1984");
  const e = handleUtterance(flow, call.id, "I'm having chest pain right now");
  assert.equal(e.emergency, true);
  assert.match(e.say, /911/);
  const n = handleUtterance(flow, call.id, "Should I still come if I have a fever?");
  assert.ok(["transfer", "advice_number"].includes(n.action));
  schedule.close();
});

test("busy and no-answer retry, bad number, voicemail last attempt", () => {
  const h1 = harness(); const c1 = h1.flow.create({ appointmentId: "A-20418" }); h1.flow.answered(c1.id); assert.equal(h1.flow.applyDialOutcome(c1.id, "busy").state, STATES.RETRY_SCHEDULED); h1.schedule.close();
  const h2 = harness(); const c2 = h2.flow.create({ appointmentId: "A-20418" }); h2.flow.answered(c2.id); assert.equal(h2.flow.applyDialOutcome(c2.id, "bad_number").outcome, "bad_number"); h2.schedule.close();
  const h3 = harness(); h3.schedule.recordAttempt({ appointmentId:"A-20418", patientId:"P-1007", state:"retry_scheduled", outcome:"no_answer", attempt:1 }); h3.schedule.recordAttempt({ appointmentId:"A-20418", patientId:"P-1007", state:"retry_scheduled", outcome:"busy", attempt:2 }); const c3 = h3.flow.create({ appointmentId: "A-20418" }); h3.flow.answered(c3.id); const r = h3.flow.applyDialOutcome(c3.id, "voicemail", { greetingText:"leave a message beep", greetingMs:5000, beep:true }); assert.equal(r.outcome, "voicemail_left"); assert.doesNotMatch(r.say, /Imaging|Dr\. Lee|9:30/); h3.schedule.close();
});

test("DOB normalization accepts keypad", () => {
  assert.equal(normalizeDob("03121984"), "1984-03-12");
});
