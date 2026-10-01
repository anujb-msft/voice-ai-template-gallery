import { config } from "./config.mjs";

const VOIP_VALUE_LIMIT = 1024;
const TOPIC_LIMIT = 48;

export function teamsIdentifier(target) {
  if (!target?.objectId) throw new Error("handoff target has no objectId");
  if (target.type === "user") return { microsoftTeamsUserId: target.objectId };
  return { teamsAppId: target.objectId, cloud: config.acs.teamsCloud };
}

export function resourceAccountFrom(to) {
  const match = /^28:(?:orgid:)?([0-9a-f-]{36})$/i.exec(to?.rawId ?? "");
  return match ? match[1] : null;
}

export function clipTopic(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim() || "311 request";
  return text.length <= TOPIC_LIMIT ? text : `${text.slice(0, TOPIC_LIMIT - 1).trimEnd()}…`;
}

export function buildHandoffContext(call, { department, reason = "transfer" } = {}) {
  const latest = call.lastCase;
  const callContext = {
    caseNumber: latest?.id ?? null,
    requestType: latest?.type ?? call.current?.typeId ?? null,
    location: latest?.location?.normalized ?? call.current?.location?.normalized ?? null,
    fields: latest?.fields ?? call.current?.fields ?? {},
    language: call.language,
    transferReason: reason,
  };
  if (latest?.contact?.wantsUpdates) callContext.reporterContact = latest.contact;
  return {
    sessionId: call.sessionId ?? call.id,
    callTopic: clipTopic(latest ? `${latest.priority ? "PRIORITY " : ""}${latest.type} – ${latest.id}` : reason),
    callContext: JSON.stringify(callContext),
    routeId: department?.id ?? call.transferDepartmentId ?? "311-live",
    afterHours: false,
  };
}

export function buildCustomCallingContext(context) {
  const headers = [
    ["CallDetails.SessionId", context.sessionId],
    ["CallDetails.CallTopic", context.callTopic],
    ["CallDetails.CallContext", context.callContext],
    ["CallDetails.RouteId", context.routeId],
    ["CallDetails.AfterHours", context.afterHours ? "true" : null],
  ];
  return headers.filter(([, value]) => value != null && value !== "").map(([key, value]) => ({ kind: "voip", key, value: String(value).slice(0, VOIP_VALUE_LIMIT) }));
}
