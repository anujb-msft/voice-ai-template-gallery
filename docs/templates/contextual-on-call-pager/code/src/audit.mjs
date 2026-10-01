export class MemoryAudit {
  name = "memory";

  constructor() {
    this.incidents = new Map();
    this.events = [];
    this.attempts = [];
    this.jobs = new Map();
    this.transcripts = [];
  }

  createIncident(incident) {
    this.incidents.set(incident.id, structuredClone(incident));
  }

  updateIncident(id, patch) {
    const existing = this.incidents.get(id);
    if (existing) this.incidents.set(id, { ...existing, ...structuredClone(patch) });
  }

  getIncident(id) {
    const incident = this.incidents.get(id);
    return incident ? structuredClone(incident) : null;
  }

  listIncidents() {
    return [...this.incidents.values()].map((i) => structuredClone(i));
  }

  findDuplicate({ propertyId, unit, sinceMs, severities = ["emergency", "urgent"] }) {
    const normUnit = String(unit ?? "").toUpperCase();
    return this.listIncidents()
      .filter((i) => i.propertyId === propertyId && String(i.unit).toUpperCase() === normUnit)
      .filter((i) => severities.includes(i.severity) && !["closed", "workOrderLogged"].includes(i.state))
      .filter((i) => new Date(i.reportedAt).getTime() >= sinceMs)
      .sort((a, b) => new Date(b.reportedAt) - new Date(a.reportedAt))[0] ?? null;
  }

  recordEvent(incidentId, source, kind, detail = null) {
    this.events.push({ incidentId, source, kind, detail: detail == null ? null : String(detail), at: new Date().toISOString() });
  }

  recordTranscript(callId, role, text) {
    this.transcripts.push({ callId, role, text, at: new Date().toISOString() });
  }

  eventsFor(incidentId) {
    return this.events.filter((e) => e.incidentId === incidentId);
  }

  recordAttempt(attempt) {
    this.attempts.push(structuredClone(attempt));
  }

  attemptsFor(incidentId) {
    return this.attempts.filter((a) => a.incidentId === incidentId).map((a) => structuredClone(a));
  }

  upsertJob(job) {
    if (!this.jobs.has(job.id)) this.jobs.set(job.id, structuredClone(job));
    else this.jobs.set(job.id, { ...this.jobs.get(job.id), ...structuredClone(job) });
  }

  claimDueJobs(nowMs) {
    const due = [...this.jobs.values()]
      .filter((j) => j.status === "pending" && new Date(j.dueAt).getTime() <= nowMs)
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    for (const job of due) this.jobs.set(job.id, { ...job, status: "running" });
    return due.map((j) => structuredClone(j));
  }

  completeJob(id, status = "done") {
    const job = this.jobs.get(id);
    if (job) this.jobs.set(id, { ...job, status });
  }

  cancelJobsForIncident(incidentId) {
    for (const [id, job] of this.jobs) {
      if (job.incidentId === incidentId && job.status === "pending") this.jobs.set(id, { ...job, status: "cancelled" });
    }
  }

  pendingJobs() {
    return [...this.jobs.values()].filter((j) => j.status === "pending").map((j) => structuredClone(j));
  }

  stats() {
    const incidents = this.listIncidents();
    const urgentPaged = incidents.filter((i) => ["urgent", "emergency"].includes(i.severity));
    const ackTimes = incidents.filter((i) => i.acknowledgedAt).map((i) => new Date(i.acknowledgedAt) - new Date(i.reportedAt));
    const attemptsByIncident = new Map();
    for (const a of this.attempts) attemptsByIncident.set(a.incidentId, (attemptsByIncident.get(a.incidentId) ?? 0) + 1);
    const values = [...attemptsByIncident.values()];
    return {
      incidents: incidents.length,
      bySeverity: tally(incidents, "severity"),
      medianMsToAcknowledge: percentile(ackTimes, 0.5),
      p90MsToAcknowledge: percentile(ackTimes, 0.9),
      successfulContacts: urgentPaged.length ? incidents.filter((i) => i.acknowledgedAt).length / urgentPaged.length : 0,
      medianEscalationMs: median(this.attempts.filter((a) => a.escalatedFrom).map((a) => new Date(a.startedAt) - new Date(incidents.find((i) => i.id === a.incidentId)?.reportedAt ?? a.startedAt))),
      pagesPerIncident: incidents.length ? this.attempts.length / incidents.length : 0,
      unacknowledgedIncidents: incidents.filter((i) => i.state === "unacknowledgedAlert").length,
      duplicatesAttached: incidents.reduce((n, i) => n + (i.duplicatesAttached ?? 0), 0),
      routineWorkOrdersLogged: incidents.filter((i) => i.state === "workOrderLogged").length,
      pendingJobs: this.pendingJobs().length,
      pageAttempts: this.attempts.length,
      pagesPerPagedIncident: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
    };
  }
}

function tally(rows, key) {
  return rows.reduce((acc, row) => {
    const value = row[key] ?? "none";
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}
function median(values) { return percentile(values, 0.5); }
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index];
}
