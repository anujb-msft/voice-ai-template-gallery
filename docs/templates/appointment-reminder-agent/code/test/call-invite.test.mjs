import test from "node:test";
import assert from "node:assert/strict";
import { buildCallInvite, describeCallError } from "../src/call-invite.mjs";

test("buildCallInvite puts the callee under targetParticipant and the caller id under sourceCallIdNumber", () => {
  const invite = buildCallInvite({ to: "+15555550100", from: "+15555550199" });
  assert.deepEqual(invite, { targetParticipant: { phoneNumber: "+15555550100" }, sourceCallIdNumber: { phoneNumber: "+15555550199" } });
  // createCall(callInvite, ...) reads callInvite.targetParticipant; a bare { phoneNumber } has none.
  assert.equal(invite.targetParticipant.phoneNumber, "+15555550100");
  assert.equal(Object.hasOwn(invite, "phoneNumber"), false);
});

test("buildCallInvite omits the caller id when none is configured", () => {
  for (const from of [undefined, null, ""]) {
    const invite = buildCallInvite({ to: "+15555550100", from });
    assert.deepEqual(invite, { targetParticipant: { phoneNumber: "+15555550100" } });
    assert.equal(Object.hasOwn(invite, "sourceCallIdNumber"), false);
  }
});

test("buildCallInvite rejects a missing target number", () => {
  assert.throws(() => buildCallInvite({ to: undefined, from: "+15555550199" }), /target phone number/);
  assert.throws(() => buildCallInvite({ to: "" }), /target phone number/);
});

test("describeCallError gives one audit line for a rejected request, an error or a string", () => {
  const withDetails = Object.assign(new Error("Bad Request"), { statusCode: 400, details: { error: { code: "BadRequest", message: "Invalid request.", details: [{ message: "Invalid target." }, { message: "Invalid caller id." }] } } });
  assert.equal(describeCallError(withDetails), "400 Invalid target.; Invalid caller id.");
  const withMessage = Object.assign(new Error("Forbidden"), { statusCode: 403, details: { error: { message: "Action is not allowed." } } });
  assert.equal(describeCallError(withMessage), "403 Action is not allowed.");
  assert.equal(describeCallError(new TypeError("Cannot read properties of undefined (reading 'communicationUserId')")), "Cannot read properties of undefined (reading 'communicationUserId')");
  assert.equal(describeCallError("socket hang up"), "socket hang up");
});
