/**
 * In-memory audit store, with the same shape as `SqliteAudit` in db.mjs. Used
 * by the tests, and by the server when SQLite is unavailable. Times come from
 * the caller (the flow's demo clock), never from the wall clock here.
 */
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
      .filter((i) => severities.includes(i.severity) && !CLOSED_STATES.includes(i.state))
      .filter((i) => new Date(i.reportedAt).getTime() >= sinceMs)
      .sort((a, b) => new Date(b.reportedAt) - new Date(a.reportedAt))[0] ?? null;
  }

  recordEvent(incidentId, source, kind, detail = null, at = new Date().toISOString()) {
    this.events.push({ incidentId, source, kind, detail: detail == null ? null : String(detail), at });
  }

  recordTranscript(callId, role, text, at = new Date().toISOString()) {
    this.transcripts.push({ callId, role, text, at });
  }

  eventsFor(incidentId) {
    return this.events.filter((e) => e.incidentId === incidentId).map((e) => ({ ...e }));
  }

  /** Upsert by id: an attempt is recorded when it rings and again with its outcome. */
  recordAttempt(attempt) {
    const index = this.attempts.findIndex((a) => a.id === attempt.id);
    if (index === -1) this.attempts.push(structuredClone(attempt));
    else this.attempts[index] = { ...this.attempts[index], ...structuredClone(attempt) };
  }

  attemptsFor(incidentId) {
    return this.attempts.filter((a) => a.incidentId === incidentId).map((a) => structuredClone(a));
  }

  /** Insert-or-ignore, like SQLite: a job id is scheduled once. */
  upsertJob(job) {
    if (!this.jobs.has(job.id)) this.jobs.set(job.id, structuredClone(job));
  }

  rescheduleJob(id, dueAt) {
    const job = this.jobs.get(id);
    if (job?.status === "pending") this.jobs.set(id, { ...job, dueAt });
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
    return [...this.jobs.values()]
      .filter((j) => j.status === "pending")
      .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
      .map((j) => structuredClone(j));
  }

  /** Demo reset: forget every simulated incident, its pages, events and jobs. Real calls stay. */
  reset() {
    const simulated = new Set([...this.incidents.values()].filter((i) => i.simulated).map((i) => i.id));
    for (const id of simulated) this.incidents.delete(id);
    this.events = this.events.filter((e) => !simulated.has(e.incidentId));
    this.attempts = this.attempts.filter((a) => !simulated.has(a.incidentId));
    for (const [id, job] of this.jobs) if (simulated.has(job.incidentId)) this.jobs.delete(id);
    return simulated.size;
  }

  stats() {
    return summarize(this.listIncidents(), this.attempts, this.pendingJobs().length);
  }
}

/** Incident states that are finished: a new report for the same unit is a new incident. */
export const CLOSED_STATES = ["closed", "workOrderLogged", "cancelled"];

/** The numbers both stores report. `attempts` are page attempts (one per ring). */
export function summarize(incidents, attempts, pendingJobs) {
  const paged = incidents.filter((i) => ["urgent", "emergency"].includes(i.severity));
  const acknowledged = incidents.filter((i) => i.acknowledgedAt);
  const ackTimes = acknowledged.map((i) => new Date(i.acknowledgedAt) - new Date(i.reportedAt));
  const reportedAt = new Map(incidents.map((i) => [i.id, i.reportedAt]));
  const escalations = attempts.filter((a) => a.escalatedFrom);
  const perIncident = new Map();
  for (const a of attempts) perIncident.set(a.incidentId, (perIncident.get(a.incidentId) ?? 0) + 1);
  const counts = [...perIncident.values()];
  const medianMs = percentile(ackTimes, 0.5);
  return {
    incidents: incidents.length,
    bySeverity: tally(incidents, "severity"),
    pages: attempts.length,
    acknowledgements: acknowledged.length,
    escalations: escalations.length,
    noAnswers: attempts.filter((a) => a.outcome === "no-answer").length,
    voicemails: attempts.filter((a) => a.outcome === "voicemail").length,
    declines: attempts.filter((a) => a.outcome === "decline").length,
    workOrders: incidents.filter((i) => i.state === "workOrderLogged").length,
    medianSecondsToAcknowledge: medianMs == null ? null : Math.round(medianMs / 1000),
    medianMsToAcknowledge: medianMs,
    p90MsToAcknowledge: percentile(ackTimes, 0.9),
    successfulContacts: paged.length ? acknowledged.length / paged.length : 0,
    medianEscalationMs: percentile(
      escalations.map((a) => new Date(a.startedAt) - new Date(reportedAt.get(a.incidentId) ?? a.startedAt)),
      0.5,
    ),
    pagesPerIncident: incidents.length ? attempts.length / incidents.length : 0,
    pagesPerPagedIncident: counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0,
    unacknowledgedIncidents: incidents.filter((i) => i.state === "unacknowledgedAlert").length,
    duplicatesAttached: incidents.reduce((n, i) => n + (i.duplicatesAttached ?? 0), 0),
    routineWorkOrdersLogged: incidents.filter((i) => i.state === "workOrderLogged").length,
    pendingJobs,
    pageAttempts: attempts.length,
  };
}

function tally(rows, key) {
  return rows.reduce((acc, row) => {
    const value = row[key] ?? "none";
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index];
}
