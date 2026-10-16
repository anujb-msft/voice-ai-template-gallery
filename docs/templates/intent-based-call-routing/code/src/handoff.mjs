import { config } from "./config.mjs";

/**
 * How a routing decision becomes something Teams can act on.
 *
 * Kept free of any Azure import so it can be tested — and read — without
 * installing the SDK. `src/voice/acs.mjs` is the only thing that calls it.
 */

/** VoIP header value ceiling in Call Automation. */
const VOIP_VALUE_LIMIT = 1024;

/**
 * Teams Call Queues and Auto Attendants are resource accounts, so they are
 * addressed as Teams *apps*; a named specialist is addressed as a Teams user.
 * Both take a Microsoft Entra object ID, which is why routes.json holds object
 * IDs and never phone numbers.
 */
export function teamsIdentifier(target) {
  if (!target?.objectId) throw new Error("route target has no objectId");
  if (target.type === "user") return { microsoftTeamsUserId: target.objectId };
  return { teamsAppId: target.objectId, cloud: config.acs.teamsCloud };
}

/**
 * Teams Phone extensibility delivers the dialled resource account in `to.rawId`
 * as `28:orgid:<object id>`, with `to.kind` documented as "unknown" rather than
 * "microsoftTeamsApp" — so match on the raw ID and do not trust `kind`.
 * A call straight to an ACS number has no resource account, which is the
 * difference between a TPE call and a plain Call Automation one.
 */
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

/**
 * Only VoIP headers are used here. SIP headers are a PSTN-side mechanism and do
 * not reach a Teams identifier, so putting the handoff context in them would
 * silently drop it — the caller would still be transferred, but the receiving
 * agent would answer blind, which is the entire failure this template exists to
 * prevent.
 *
 * Field names mirror the Teams Phone extensibility custom-context schema; each is
 * sent under its `voipKey` wire key. Empty fields are omitted rather than sent as
 * nulls, so the receiving agent never has to distinguish "unknown" from "absent".
 */
export function buildCustomCallingContext(context) {
  const headers = [
    ["CallDetails.SessionId", context.sessionId],
    ["CallDetails.CallTopic", context.callTopic],
    ["CallDetails.CallContext", context.callContext],
    ["CallDetails.CallSentiment", context.callSentiment],
    ["CallDetails.RouteId", context.routeId],
    ["CallDetails.AfterHours", context.afterHours ? "true" : null],
    // Serialised whole so the receiving agent gets the verified:false flag with
    // the name, rather than a name with no provenance attached to it.
    ["CallerDetails", context.callerDetails ? JSON.stringify(context.callerDetails) : null],
  ];

  return headers
    .filter(([, value]) => value != null && value !== "")
    .map(([field, value]) => ({ kind: "voip", key: voipKey(field), value: String(value).slice(0, VOIP_VALUE_LIMIT) }));
}
