import { config } from "./config.mjs";

const VOIP_VALUE_LIMIT = 1024;
const TOPIC_LIMIT = 48;

export function clip(value, limit = TOPIC_LIMIT) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

const OPENERS = /^(?:(?:um+|uh+|er+|so|well|oh|hi|hey|hello|okay|ok|yes|yeah)\b[\s,.!-]*|(?:i(?:\s+(?:want|need|would like)\s+to|'d like to|\s+wanna)|can you|could you|please)\s+)+/i;

/**
 * A caller's words as a Teams toast topic: filler and "I want to" dropped,
 * trailing punctuation removed, cut on a word boundary, first letter capped.
 * "I want to report a pothole on Elm Street." → "Report a pothole on Elm Street"
 */
export function topicFrom(text, limit = TOPIC_LIMIT) {
  let topic = String(text ?? "").replace(/\s+/g, " ").trim().replace(OPENERS, "").replace(/[\s.,;:!?…-]+$/, "");
  if (!topic) return null;
  if (topic.length > limit) {
    const cut = topic.slice(0, limit - 1);
    const space = cut.lastIndexOf(" ");
    topic = `${(space > limit / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, "")}…`;
  }
  return topic.charAt(0).toUpperCase() + topic.slice(1);
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
