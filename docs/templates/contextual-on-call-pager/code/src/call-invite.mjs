/**
 * Call Automation's createCall(callInvite, callbackUrl, options) takes a CallInvite: the callee
 * goes under targetParticipant and the PSTN caller id under sourceCallIdNumber. A bare
 * { phoneNumber } leaves targetParticipant undefined and the SDK throws "Cannot read properties
 * of undefined (reading 'communicationUserId')" before any request is sent, and
 * CreateCallOptions.sourceCallIdNumber is ignored by createCall.
 */
export function buildCallInvite({ to, from = null }) {
  if (!to) throw new Error("buildCallInvite requires a target phone number");
  const invite = { targetParticipant: { phoneNumber: String(to) } };
  if (from) invite.sourceCallIdNumber = { phoneNumber: String(from) };
  return invite;
}

/** One line for the audit log from a rejected Call Automation request (RestError-shaped) or any other error. */
export function describeCallError(error) {
  const nested = error?.details?.error;
  const detail = Array.isArray(nested?.details)
    ? nested.details.map((d) => d?.message).filter(Boolean).join("; ")
    : "";
  const message = detail || nested?.message || error?.message || String(error);
  return error?.statusCode ? `${error.statusCode} ${message}` : message;
}
