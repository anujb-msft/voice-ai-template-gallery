import { config } from "./config.mjs";

const VOIP_VALUE_LIMIT = 1024;

export function teamsIdentifier(target) {
  if (!target?.objectId) throw new Error("handoff target has no objectId");
  if (target.type === "user") return { microsoftTeamsUserId: target.objectId };
  return { teamsAppId: target.objectId, cloud: config.acs.teamsCloud };
}

export function resourceAccountFrom(to) {
  const match = /^28:(?:orgid:)?([0-9a-f-]{36})$/i.exec(to?.rawId ?? "");
  return match ? match[1] : null;
}

export function buildCustomCallingContext(context) {
  const headers = [
    ["CallDetails.SessionId", context.sessionId],
    ["CallDetails.CallTopic", context.callTopic],
    ["CallDetails.CallContext", context.callContext],
    ["CallDetails.RouteId", context.routeId],
  ];
  return headers
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => ({ kind: "voip", key, value: String(value).slice(0, VOIP_VALUE_LIMIT) }));
}
