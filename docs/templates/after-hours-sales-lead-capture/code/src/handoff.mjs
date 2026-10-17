// Teams Phone handoff helpers: who the call goes to, and the context the person
// who answers in Teams sees. Context travels as VoIP headers on the transfer.
import { config } from "./config.mjs";

const VOIP_VALUE_LIMIT = 1024;
const CALL_TOPIC_LIMIT = 48;

/**
 * The ACS identifier for a Teams target: a call queue or auto attendant is a
 * Teams app (its resource account's object id); an on-call rep is a Teams user.
 */
export function teamsIdentifier(target) {
  if (!target?.objectId) throw new Error("sales queue target has no objectId");
  return target.type === "user"
    ? { microsoftTeamsUserId: target.objectId }
    : { teamsAppId: target.objectId, cloud: config.acs.teamsCloud };
}

/** The Teams Phone resource account the call was placed to, from its raw id ("28:orgid:<guid>"). */
export function resourceAccountFrom(to) {
  const match = /^28:(?:orgid:)?([0-9a-f-]{36})$/i.exec(to?.rawId ?? "");
  return match ? match[1] : null;
}

/** The handoff context as VoIP headers. Empty fields are left out; AfterHours is sent only when true. */
export function buildCustomCallingContext(context) {
  const headers = [
    ["CallDetails.SessionId", context.sessionId],
    ["CallDetails.CallTopic", context.callTopic],
    ["CallDetails.CallContext", context.callContext],
    ["CallDetails.RouteId", context.routeId],
    ["CallDetails.AfterHours", context.afterHours ? "true" : null],
  ];
  return headers
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => ({
      kind: "voip",
      key,
      value: String(value).slice(0, key === "CallDetails.CallTopic" ? CALL_TOPIC_LIMIT : VOIP_VALUE_LIMIT),
    }));
}
