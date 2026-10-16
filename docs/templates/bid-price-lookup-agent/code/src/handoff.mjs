import { config } from "./config.mjs";
const VOIP_VALUE_LIMIT = 1024;

export function teamsIdentifier(target) {
  if (!target?.objectId) throw new Error("merchandiser target has no objectId");
  if (target.type === "user") return { microsoftTeamsUserId: target.objectId };
  return { teamsAppId: target.objectId, cloud: config.acs.teamsCloud };
}

export function resourceAccountFrom(to) {
  const match = /^28:(?:orgid:)?([0-9a-f-]{36})$/i.exec(to?.rawId ?? "");
  return match ? match[1] : null;
}

/**
 * Teams Phone extensibility names its handoff fields CustomContext.CallDetails.*, but
 * Call Automation rejects a VoIP header key containing "." or "_" (400 "Invalid
 * CustomCallingContext in request, one or more provided voip headers with invalid key.")
 * and documents a 64-character key limit. Letters, digits and hyphens are accepted, so each
 * field name is sent with every other character replaced by a hyphen
 * ("CallDetails.CallTopic" -> "CallDetails-CallTopic"). The wire serialization Teams expects
 * is defined by the Teams Phone Unify integration program; if yours differs, this is the one
 * place to change — inbound reads go through readVoipHeader so both directions stay in step.
 */
export function voipKey(field) {
  return String(field).replace(/[^A-Za-z0-9-]/g, "-");
}

export function readVoipHeader(customContext, field) {
  return customContext?.voipHeaders?.[voipKey(field)] ?? null;
}

export function buildCustomCallingContext(context) {
  return [
    ["CallDetails.SessionId", context.sessionId],
    ["CallDetails.CallTopic", context.callTopic],
    ["CallDetails.CallContext", context.callContext],
    ["CallDetails.LocationId", context.locationId],
    ["CallDetails.TransferReason", context.reason],
  ]
    .filter(([, value]) => value != null && value !== "")
    .map(([field, value]) => ({ kind: "voip", key: voipKey(field), value: String(value).slice(0, VOIP_VALUE_LIMIT) }));
}

/** One line for the audit log from a rejected Call Automation request (RestError-shaped). */
export function describeTransferError(error) {
  const nested = error?.details?.error;
  const detail = Array.isArray(nested?.details)
    ? nested.details.map((d) => d?.message).filter(Boolean).join("; ")
    : "";
  const message = detail || nested?.message || error?.message || String(error);
  return error?.statusCode ? `${error.statusCode} ${message}` : message;
}

/** One line for the audit log from a CallTransferFailed event's resultInformation. */
export function describeTransferResult(info) {
  if (!info) return "transfer failed";
  const code = [info.code, info.subCode].filter((v) => v !== undefined && v !== null).join("/");
  return [code, info.message].filter(Boolean).join(" ") || "transfer failed";
}
