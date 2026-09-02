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
 * Only VoIP headers are used here. SIP headers are a PSTN-side mechanism and do
 * not reach a Teams identifier, so putting the handoff context in them would
 * silently drop it — the caller would still be transferred, but the receiving
 * agent would answer blind, which is the entire failure this template exists to
 * prevent.
 *
 * Keys mirror the Teams Phone extensibility custom-context schema. Empty fields
 * are omitted rather than sent as nulls, so the receiving agent never has to
 * distinguish "unknown" from "absent".
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
    .map(([key, value]) => ({ kind: "voip", key, value: String(value).slice(0, VOIP_VALUE_LIMIT) }));
}
