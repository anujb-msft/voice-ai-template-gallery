import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAudit, summarizeCalls } from "../src/audit.mjs";

test("the metrics strip counts reached patients, outcomes and privacy-safe voicemails", () => {
  const stats = summarizeCalls([
    { outcome: "confirmed", verified: true },
    { outcome: "cancelled", verified: 1 },
    { outcome: "reschedule_handoff", verified: true },
    { outcome: "wrong_party", verified: false },
    { outcome: "voicemail_left", verified: false },
    { outcome: "not_placed", verified: false },
  ]);
  assert.equal(stats.calls, 6);
  assert.equal(stats.placed, 5);
  assert.equal(stats.answered, 4);
  assert.equal(stats.reached, 3);
  assert.equal(stats.confirmed, 1);
  assert.equal(stats.cancelled, 1);
  assert.equal(stats.reschedulesHandedOff, 1);
  assert.equal(stats.privacySafeVoicemails, 1);
  assert.equal(stats.callbackOnly, 1);
  assert.equal(stats.notPlaced, 1);
  assert.deepEqual(stats.byOutcome, { confirmed: 1, cancelled: 1, reschedule_handoff: 1, wrong_party: 1, voicemail_left: 1, not_placed: 1 });
});

test("a call someone else answered is not a reached patient", () => {
  const stats = summarizeCalls([{ outcome: "wrong_party", verified: false }, { outcome: "unauthorized_proxy", verified: false }]);
  assert.equal(stats.reached, 0);
  assert.equal(stats.callbackOnly, 2);
});

test("demo reset forgets simulated calls and keeps calls from a real phone", () => {
  const audit = new MemoryAudit();
  audit.startCall({ id: "sim-1", simulated: true });
  audit.startCall({ id: "real-1", simulated: false });
  audit.recordEvent("sim-1", "system", "call_created", "simulated");
  audit.recordEvent("real-1", "system", "call_created", "real");
  audit.recordTranscript("sim-1", "agent", "Hello");
  audit.updateCall("real-1", { outcome: "confirmed", verified: true });
  assert.equal(audit.reset(), 1);
  assert.deepEqual([...audit.calls.keys()], ["real-1"]);
  assert.deepEqual(audit.eventsFor("sim-1"), []);
  assert.equal(audit.eventsFor("real-1").length, 1);
  assert.equal(audit.transcripts.length, 0);
  assert.equal(audit.stats().confirmed, 1);
});
