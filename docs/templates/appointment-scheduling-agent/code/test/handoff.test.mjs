import test from "node:test";
import assert from "node:assert/strict";
import { buildCustomCallingContext, readVoipHeader, reminderToSchedulingContext, voipKey } from "../src/handoff.mjs";

// Call Automation accepts letters, digits and hyphens, up to 64 characters.
const VOIP_KEY = /^[A-Za-z0-9-]{1,64}$/;

test("handoff context is sent under VoIP header keys Call Automation accepts", () => {
  const headers = buildCustomCallingContext({
    sessionId: "session-1",
    callTopic: "Scheduling – Derm referral needed",
    callContext: { firstName: "Jordan", verified: true, department: "dermatology" },
  });
  assert.deepEqual(headers.map((h) => h.key), ["CallDetails-SessionId", "CallDetails-CallTopic", "CallDetails-CallContext"]);
  for (const header of headers) {
    assert.equal(header.kind, "voip");
    assert.match(header.key, VOIP_KEY);
    assert.ok(header.value.length <= 1024);
  }
});

test("voipKey replaces dots and underscores with hyphens", () => {
  assert.equal(voipKey("CallDetails.SessionId"), "CallDetails-SessionId");
  assert.equal(voipKey("CallDetails.CallContext"), "CallDetails-CallContext");
  assert.equal(voipKey("CallDetails_CallTopic"), "CallDetails-CallTopic");
  assert.equal(voipKey("CallDetails-CallTopic"), "CallDetails-CallTopic");
});

test("readVoipHeader reads what buildCustomCallingContext writes, including a reminder handoff", () => {
  const context = reminderToSchedulingContext({ appointmentId: "appt-1", patientRef: "ref-1", sessionId: "session-1" });
  const voipHeaders = Object.fromEntries(
    buildCustomCallingContext({ sessionId: "session-1", callTopic: "Reschedule", callContext: context }).map((h) => [h.key, h.value]),
  );
  assert.equal(readVoipHeader({ voipHeaders }, "CallDetails.SessionId"), "session-1");
  assert.equal(readVoipHeader({ voipHeaders }, "CallDetails.CallTopic"), "Reschedule");
  assert.deepEqual(JSON.parse(readVoipHeader({ voipHeaders }, "CallDetails.CallContext")), context);

  // The reminder sample sends the same hyphenated keys.
  assert.equal(readVoipHeader({ voipHeaders: { "CallDetails-CallContext": "{}" } }, "CallDetails.CallContext"), "{}");
  // A dotted key is never on the wire (Call Automation refuses it), so it is not read.
  assert.equal(readVoipHeader({ voipHeaders: { "CallDetails.CallContext": "{}" } }, "CallDetails.CallContext"), null);
  assert.equal(readVoipHeader(undefined, "CallDetails.SessionId"), null);
  assert.equal(readVoipHeader({}, "CallDetails.SessionId"), null);
});
