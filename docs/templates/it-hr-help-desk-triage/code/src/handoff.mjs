import { config } from "./config.mjs";

const VOIP_VALUE_LIMIT = 1024;
export function teamsIdentifier(target) {
  if (!target?.objectId) throw new Error("route target has no objectId");
  return target.type === "user" ? { microsoftTeamsUserId: target.objectId } : { teamsAppId: target.objectId, cloud: config.acs.teamsCloud };
}
export function resourceAccountFrom(to) {
  const match = /^28:(?:orgid:)?([0-9a-f-]{36})$/i.exec(to?.rawId ?? "");
  return match ? match[1] : null;
}
export function buildCustomCallingContext(context) {
  const value = (v) => (typeof v === "object" && v !== null ? JSON.stringify(v) : v);
  const headers = [
    ["CallDetails.SessionId", context.sessionId],
    ["CallDetails.CallTopic", context.callTopic],
    ["CallDetails.CallContext", value(context.callContext)],
    ["CallDetails.DestinationId", context.destinationId],
    ["CallDetails.Confidential", context.confidential ? "true" : null],
  ];
  return headers.filter(([,v]) => v != null && v !== "").map(([key,v]) => ({ kind:"voip", key, value:String(v).slice(0, VOIP_VALUE_LIMIT) }));
}
