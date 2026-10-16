import { config } from "./config.mjs";

const LIMIT = 48;
export function clipTopic(text) { const s = String(text ?? "").replace(/\s+/g, " ").trim(); return s.length <= LIMIT ? s : `${s.slice(0, LIMIT - 1).trimEnd()}…`; }
export function teamsIdentifier(target) {
  if (!target?.objectId && !target?.teamsAppId && !target?.microsoftTeamsUserId) throw new Error("handoff target missing Teams id");
  if (target.microsoftTeamsUserId || target.type === "user") return { microsoftTeamsUserId: target.microsoftTeamsUserId ?? target.objectId };
  return { teamsAppId: target.teamsAppId ?? target.objectId, cloud: config.acs.teamsCloud };
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

export function buildCustomCallingContext({ sessionId, callTopic, callContext }) {
  const context = typeof callContext === "string" ? callContext : JSON.stringify(callContext ?? {});
  return [
    ["CallDetails.SessionId", sessionId],
    ["CallDetails.CallTopic", clipTopic(callTopic)],
    ["CallDetails.CallContext", context],
  ].filter(([, v]) => v != null && v !== "").map(([field, value]) => ({ kind: "voip", key: voipKey(field), value: String(value).slice(0, 1024) }));
}
export function resourceAccountFrom(to) {
  const match = /^28:(?:orgid:)?([0-9a-f-]{36})$/i.exec(to?.rawId ?? "");
  return match ? match[1] : null;
}
export function reminderToSchedulingContext({ appointmentId, patientRef, verified = true, sessionId }) {
  return { intent: "reschedule", appointmentId, patientRef, verified, sessionId };
}
