/**
 * How a handoff becomes something Teams can act on.
 *
 * Kept free of any Azure import so it can be tested, and read, without the
 * SDK. `voice/acs.mjs` uses it to transfer a live call; the simulation uses it
 * to show the presenter exactly what the service desk would receive.
 */

/** VoIP header value ceiling in Call Automation. */
export const VOIP_VALUE_LIMIT = 1024;

/** What each handoff reason means to the person who picks up. */
export const HANDOFF_REASONS = {
  identity_failed: { topic: "Password reset: identity not verified", sentiment: "Neutral" },
  other_account_request: { topic: "Password reset: asked to reset another employee's account", sentiment: "Insistent" },
  pressure_to_skip_verification: { topic: "Password reset: pressed to skip verification", sentiment: "Impatient" },
  caller_requested_person: { topic: "Password reset: caller asked for a person", sentiment: "Neutral" },
  did_not_request: {
    topic: "Password reset the employee says they did not request",
    sentiment: "Concerned",
    risk: "Employee says they did not request this reset",
  },
  mfa_locked_out: { topic: "Password reset: also locked out of MFA", sentiment: "Neutral" },
  too_many_codes: { topic: "Password reset: one-time code not accepted", sentiment: "Neutral" },
  user_requested: { topic: "Password reset: help requested from the reset page", sentiment: "Neutral" },
};

export function handoffTopic(reason) {
  return HANDOFF_REASONS[reason] ?? { topic: `Password reset: ${String(reason ?? "escalated").replace(/_/g, " ")}`, sentiment: "Neutral" };
}

/**
 * The service desk is a Teams call queue (a resource account, addressed as a
 * Teams app) or a named specialist (a Teams user). Both take a Microsoft Entra
 * object ID, never a phone number.
 */
export function serviceDeskIdentifier({ id, kind = "app", cloud = "public" } = {}) {
  if (!id) throw new Error("No service desk is configured; set SERVICE_DESK_TEAMS_ID");
  if (kind === "user") return { microsoftTeamsUserId: id };
  return { teamsAppId: id, cloud };
}

/**
 * Only VoIP headers are used. SIP headers are a PSTN-side mechanism and do not
 * reach a Teams identifier, so the specialist would answer blind.
 *
 * Empty fields are omitted rather than sent as nulls, and nothing secret is
 * ever included: no employee ID digits, no one-time code, no password.
 */
export function buildCustomCallingContext(context) {
  const headers = [
    ["CallDetails.SessionId", context.sessionId],
    ["CallDetails.CallTopic", context.callTopic],
    ["CallDetails.CallContext", context.callContext],
    ["CallDetails.CallSentiment", context.callSentiment],
    ["CallDetails.Risk", context.risk],
    ["CallDetails.TicketId", context.ticketId],
    // Serialized whole so the verified flag always travels with the name.
    ["CallerDetails", context.callerDetails ? JSON.stringify(context.callerDetails) : null],
  ];

  return headers
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => ({ kind: "voip", key, value: String(value).slice(0, VOIP_VALUE_LIMIT) }));
}
