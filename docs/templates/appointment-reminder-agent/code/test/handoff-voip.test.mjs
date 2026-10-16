import test from "node:test";
import assert from "node:assert/strict";
import { buildCustomCallingContext, readVoipHeader, voipKey } from "../src/handoff.mjs";

test("VoIP header keys are sent with hyphens because Call Automation rejects '.' and '_'", () => {
  const ctx = buildCustomCallingContext({ sessionId: "session-1", callTopic: "Reschedule – Imaging follow-up", callContext: { intent: "reschedule", appointmentId: "A-20418" } });
  assert.deepEqual(ctx.map((h) => h.key), ["CallDetails-SessionId", "CallDetails-CallTopic", "CallDetails-CallContext"]);
  for (const header of ctx) {
    assert.equal(header.kind, "voip");
    assert.match(header.key, /^[A-Za-z0-9-]{1,64}$/);
  }
  assert.equal(voipKey("CallDetails.CallContext"), "CallDetails-CallContext");
  assert.equal(voipKey("Call_Details.Topic"), "Call-Details-Topic");
});

test("readVoipHeader reads back what buildCustomCallingContext writes", () => {
  const callContext = { intent: "reschedule", appointmentId: "A-20418", verified: true, sessionId: "session-1" };
  const ctx = buildCustomCallingContext({ sessionId: "session-1", callTopic: "Reschedule", callContext });
  const customContext = { voipHeaders: Object.fromEntries(ctx.map((h) => [h.key, h.value])) };
  assert.equal(readVoipHeader(customContext, "CallDetails.SessionId"), "session-1");
  assert.equal(readVoipHeader(customContext, "CallDetails.CallTopic"), "Reschedule");
  assert.deepEqual(JSON.parse(readVoipHeader(customContext, "CallDetails.CallContext")), callContext);
  assert.equal(readVoipHeader({ voipHeaders: { "CallDetails.SessionId": "dotted" } }, "CallDetails.SessionId"), null);
  assert.equal(readVoipHeader(undefined, "CallDetails.SessionId"), null);
});
