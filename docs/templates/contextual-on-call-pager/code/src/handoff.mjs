const TOPIC_LIMIT = 48;
const clip = (value, limit = TOPIC_LIMIT) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);

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

export function businessHoursQueueHandoff(incident) {
  return {
    CallTopic: clip(`${incident.issueType ?? incident.issue} ${incident.propertyName}`),
    CallContext: `${incident.severity} maintenance request for ${incident.propertyName} unit ${incident.unit}. Incident ${incident.id}.`,
    SessionId: incident.id,
  };
}
