import test from "node:test";
import assert from "node:assert/strict";
import { SCENARIOS, dialGreeting, runOfflineReminder } from "../src/offline.mjs";
import { detectVoicemail } from "../src/flow.mjs";
import { FLOW_OPTIONS, TWO_DAYS_BEFORE, TOO_LATE } from "./helpers.mjs";

const EXPECTED = {
  confirm: "confirmed",
  cancel: "cancelled",
  reschedule: "reschedule_handoff",
  "wrong-party": "wrong_party",
  voicemail: "voicemail_left",
  optout: "opted_out",
};

test("every offline scenario reaches the outcome its console beat shows", async () => {
  assert.deepEqual(Object.keys(SCENARIOS).sort(), Object.keys(EXPECTED).sort());
  for (const [scenario, outcome] of Object.entries(EXPECTED)) {
    const result = await runOfflineReminder({ scenario, at: TWO_DAYS_BEFORE, options: FLOW_OPTIONS });
    assert.equal(result.ok, true, scenario);
    assert.equal(result.call.outcome, outcome, scenario);
    assert.equal(result.clock, new Date(TWO_DAYS_BEFORE).toISOString());
  }
});

test("offline runs are isolated: each one starts from the seed", async () => {
  const first = await runOfflineReminder({ scenario: "cancel", at: TWO_DAYS_BEFORE, options: FLOW_OPTIONS });
  const second = await runOfflineReminder({ scenario: "cancel", at: TWO_DAYS_BEFORE, options: FLOW_OPTIONS });
  assert.equal(first.schedule.releasedSlots, second.schedule.releasedSlots);
  assert.equal(second.call.outcome, "cancelled");
});

test("an offline run at 8:30 PM is not placed and says when it may be", async () => {
  const result = await runOfflineReminder({ scenario: "confirm", at: TOO_LATE, options: FLOW_OPTIONS });
  assert.equal(result.call.outcome, "not_placed");
  assert.equal(result.call.reason, "calling_window");
  assert.match(result.call.why, /Next allowed/);
  assert.equal(result.call.transcript.length, 0);
});

test("unknown appointments are reported, not thrown", async () => {
  const result = await runOfflineReminder({ appointmentId: "A-99999", at: TWO_DAYS_BEFORE, options: FLOW_OPTIONS });
  assert.equal(result.ok, false);
  assert.match(result.error, /A-99999/);
});

test("the simulated phone: a person says hello, a voicemail greeting is long enough to detect", () => {
  const person = dialGreeting("answered");
  assert.equal(detectVoicemail({ text: person.greetingText, durationMs: person.greetingMs, thresholdMs: FLOW_OPTIONS.voicemailGreetingMs }).voicemail, false);
  const machine = dialGreeting("voicemail", "Avery");
  assert.match(machine.greetingText, /Avery/);
  assert.equal(detectVoicemail({ text: machine.greetingText, durationMs: machine.greetingMs, thresholdMs: FLOW_OPTIONS.voicemailGreetingMs }).voicemail, true);
  assert.deepEqual(dialGreeting("busy"), {});
});
