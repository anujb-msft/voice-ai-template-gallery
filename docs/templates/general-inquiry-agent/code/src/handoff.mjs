import { config } from "./config.mjs";

const VOIP_VALUE_LIMIT = 1024;
const TOPIC_LIMIT = 48;

export function clip(value, limit = TOPIC_LIMIT) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

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
  return [
    ["CallDetails.SessionId", context.sessionId],
    ["CallDetails.CallTopic", clip(context.callTopic, TOPIC_LIMIT)],
    ["CallDetails.CallContext", context.callContext],
    ["CallDetails.CallSentiment", context.callSentiment],
  ]
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => ({ kind: "voip", key, value: String(value).slice(0, VOIP_VALUE_LIMIT) }));
}
