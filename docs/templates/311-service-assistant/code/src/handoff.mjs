import { config } from "./config.mjs";

const VOIP_VALUE_LIMIT = 1024;
const TOPIC_LIMIT = 48;
const COMPLAINT_LIMIT = 240;

export function teamsIdentifier(target) {
  if (!target?.objectId) throw new Error("handoff target has no objectId");
  if (target.type === "user") return { microsoftTeamsUserId: target.objectId };
  return { teamsAppId: target.objectId, cloud: config.acs.teamsCloud };
}

export function resourceAccountFrom(to) {
  const match = /^28:(?:orgid:)?([0-9a-f-]{36})$/i.exec(to?.rawId ?? "");
  return match ? match[1] : null;
}

/** The Teams toast shows about 48 characters, so cut at a word and say so with an ellipsis. */
export function clipTopic(value, limit = TOPIC_LIMIT) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim() || "311 request";
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  if (space > limit / 2) cut = cut.slice(0, space);
  return `${cut.replace(/[\s.,;:!?–-]+$/u, "")}…`;
}

/**
 * What the person who picks up sees: a short topic for the toast and a small
 * JSON context. Built on the server from the call record, never by the model.
 */
export function buildHandoffContext(call, { department, reason = "transfer", topic = null, summary = null } = {}) {
  const latest = call.lastCase;
  const callContext = {
    caseNumber: latest?.id ?? null,
    requestType: latest?.type ?? call.current?.typeId ?? null,
    location: latest?.location?.normalized ?? call.current?.location?.normalized ?? null,
    fields: latest?.fields ?? call.current?.fields ?? {},
    language: call.language,
    transferReason: reason,
  };
  if (summary) callContext.summary = summary;
  if (call.complaint?.text) callContext.complaint = clipTopic(call.complaint.text, COMPLAINT_LIMIT);
  if (call.sentiment && call.sentiment !== "neutral") callContext.sentiment = call.sentiment;
  if (latest?.contact?.wantsUpdates) callContext.reporterContact = latest.contact;
  const fallbackTopic = latest ? `${latest.priority ? "PRIORITY " : ""}${String(latest.type).replaceAll("-", " ")} – ${latest.id}` : reason;
  return {
    sessionId: call.sessionId ?? call.id,
    callTopic: clipTopic(topic ?? fallbackTopic),
    callContext: fitContext(callContext),
    routeId: department?.id ?? call.transferDepartmentId ?? "311-live",
    afterHours: false,
  };
}

// Each VoIP header value is capped, so drop the bulkiest optional parts rather than cut the JSON.
function fitContext(context) {
  const ctx = { ...context };
  for (const key of ["complaint", "fields", "reporterContact", "summary"]) {
    if (JSON.stringify(ctx).length <= VOIP_VALUE_LIMIT) break;
    delete ctx[key];
  }
  return JSON.stringify(ctx);
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
