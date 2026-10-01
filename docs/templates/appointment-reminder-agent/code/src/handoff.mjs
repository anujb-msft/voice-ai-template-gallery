import { config } from "./config.mjs";

const LIMIT = 48;
export function clipTopic(text) { const s = String(text ?? "").replace(/\s+/g, " ").trim(); return s.length <= LIMIT ? s : `${s.slice(0, LIMIT - 1).trimEnd()}…`; }
export function teamsIdentifier(target) {
  if (!target?.objectId && !target?.teamsAppId && !target?.microsoftTeamsUserId) throw new Error("handoff target missing Teams id");
  if (target.microsoftTeamsUserId || target.type === "user") return { microsoftTeamsUserId: target.microsoftTeamsUserId ?? target.objectId };
  return { teamsAppId: target.teamsAppId ?? target.objectId, cloud: config.acs.teamsCloud };
}
export function buildCustomCallingContext({ sessionId, callTopic, callContext }) {
  const context = typeof callContext === "string" ? callContext : JSON.stringify(callContext ?? {});
  return [
    ["CallDetails.SessionId", sessionId],
    ["CallDetails.CallTopic", clipTopic(callTopic)],
    ["CallDetails.CallContext", context],
  ].filter(([, v]) => v != null && v !== "").map(([key, value]) => ({ kind: "voip", key, value: String(value).slice(0, 1024) }));
}
export function resourceAccountFrom(to) {
  const match = /^28:(?:orgid:)?([0-9a-f-]{36})$/i.exec(to?.rawId ?? "");
  return match ? match[1] : null;
}
export function reminderToSchedulingContext({ appointmentId, patientRef, verified = true, sessionId }) {
  return { intent: "reschedule", appointmentId, patientRef, verified, sessionId };
}
