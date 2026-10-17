/**
 * What the paged technician sees, and what Teams can act on. No Azure import,
 * so it can be tested — and read — without the SDK. Phone numbers never appear
 * in any payload here: contact numbers stay in the server-side roster.
 */

const TOPIC_LIMIT = 48;
/** VoIP header value ceiling in Call Automation. */
const VOIP_VALUE_LIMIT = 1024;
const clip = (value, limit = TOPIC_LIMIT) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), limit - 12)).trimEnd()}…`;
};
const title = (value) => String(value ?? "").replace(/^./, (c) => c.toUpperCase());

export function technicianCardPayload(incident, contact) {
  return {
    type: "technicianPage",
    mentionUserId: contact.teamsUserId,
    incidentId: incident.id,
    severity: incident.severity,
    property: incident.propertyName,
    unit: incident.unit,
    issue: incident.issueType ?? incident.issue,
    accessNotes: incident.accessNotes ?? "None provided",
    tenantSaid: incident.tenantSaid ?? "",
    timeReported: incident.reportedAt,
  };
}

export function opsAlertPayload(incident, attempts) {
  return {
    type: "opsUnacknowledgedAlert",
    incidentId: incident.id,
    severity: incident.severity,
    property: incident.propertyName,
    unit: incident.unit,
    attempts: attempts.map((a) => ({ level: a.level, attempt: a.attempt, contactName: a.contactName, outcome: a.outcome, at: a.startedAt })),
  };
}

/** "Active leak · Maple Court 4B" — at most 48 characters, cut at a word. */
export function pageTopic(incident) {
  return clip(`${title(incident.issueTypeLabel ?? incident.issueType ?? incident.issue)} · ${incident.propertyName} ${incident.unit}`);
}

export function businessHoursQueueHandoff(incident) {
  return {
    CallTopic: clip(`${incident.issueType ?? incident.issue} ${incident.propertyName}`),
    CallContext: `${incident.severity} maintenance request for ${incident.propertyName} unit ${incident.unit}. Incident ${incident.id}.`,
    SessionId: incident.id,
  };
}

/**
 * The page as Teams Phone extensibility custom calling context (VoIP headers).
 *
 * Call Automation sends `customCallingContext` on `addParticipant` and on
 * transfers, which is how a deployment that rings the technician's Teams client
 * (instead of a mobile number) would hand over this context. `createCall` in
 * the ACS SDK 1.6.0 does not carry it, so the PSTN page in `voice/acs.mjs`
 * speaks the brief instead and the same facts go to Teams as the Workflows card.
 * The console renders these headers so the audience sees the literal handoff.
 */
export function buildCustomCallingContext({ incident, level, attempt, attemptsPerLevel, brief }) {
  const headers = [
    ["CallDetails.SessionId", incident.id],
    ["CallDetails.CallTopic", pageTopic(incident)],
    ["CallDetails.CallContext", String(brief ?? "").replace(/\s*Press 1\b.*$/, "")],
    ["CallDetails.Severity", incident.severity],
    ["CallDetails.Escalation", level ? `${levelLabel(level)} · attempt ${attempt} of ${attemptsPerLevel}` : null],
    ["CallDetails.PermissionToEnter", incident.permissionToEnter ? "true" : "false"],
  ];
  return headers
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => ({ kind: "voip", key, value: String(value).slice(0, VOIP_VALUE_LIMIT) }));
}

export function levelLabel(level) {
  return { primary: "primary", secondary: "secondary", propertyManager: "property manager" }[level] ?? level;
}
