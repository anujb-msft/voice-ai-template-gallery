import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.mjs";

export class SqliteAudit {
  name = "sqlite";

  constructor(path = config.dbPath, { persistTranscripts = config.persistTranscripts } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.persistTranscripts = persistTranscripts;
  }

  createIncident(incident) {
    this.db.prepare(`INSERT OR REPLACE INTO incidents
      (id, state, severity, property_id, property_name, unit, issue_type, issue, tenant_said,
       access_notes, permission_to_enter, callback_masked, reported_at, acknowledged_at, closed_at,
       acknowledged_by, bridge_requested, duplicates_attached, safety_line, matched_rule, simulated)
       VALUES (@id, @state, @severity, @propertyId, @propertyName, @unit, @issueType, @issue,
       @tenantSaid, @accessNotes, @permissionToEnter, @callbackMasked, @reportedAt,
       @acknowledgedAt, @closedAt, @acknowledgedBy, @bridgeRequested, @duplicatesAttached,
       @safetyLine, @matchedRule, @simulated)`).run(rowForIncident(incident));
  }

  updateIncident(id, patch) {
    const allowed = {
      state: "state", severity: "severity", issueType: "issue_type", issue: "issue", tenantSaid: "tenant_said",
      accessNotes: "access_notes", permissionToEnter: "permission_to_enter", acknowledgedAt: "acknowledged_at",
      closedAt: "closed_at", acknowledgedBy: "acknowledged_by", bridgeRequested: "bridge_requested",
      duplicatesAttached: "duplicates_attached", safetyLine: "safety_line", matchedRule: "matched_rule",
    };
    const sets = [];
    const values = { id };
    for (const [key, col] of Object.entries(allowed)) {
      if (patch[key] === undefined) continue;
      sets.push(`${col} = @${key}`);
      values[key] = typeof patch[key] === "boolean" ? Number(patch[key]) : patch[key];
    }
    if (sets.length) this.db.prepare(`UPDATE incidents SET ${sets.join(", ")} WHERE id = @id`).run(values);
  }

  getIncident(id) {
    const row = this.db.prepare(`SELECT * FROM incidents WHERE id = ?`).get(id);
    return row ? incidentFromRow(row) : null;
  }

  listIncidents() {
    return this.db.prepare(`SELECT * FROM incidents ORDER BY reported_at`).all().map(incidentFromRow);
  }

  findDuplicate({ propertyId, unit, sinceMs, severities = ["emergency", "urgent"] }) {
    const rows = this.db.prepare(`SELECT * FROM incidents
      WHERE property_id = ? AND upper(unit) = upper(?) AND reported_at >= ?
      AND severity IN (${severities.map(() => "?").join(",")})
      AND state NOT IN ('closed','workOrderLogged')
      ORDER BY reported_at DESC LIMIT 1`).all(propertyId, unit, new Date(sinceMs).toISOString(), ...severities);
    return rows[0] ? incidentFromRow(rows[0]) : null;
  }

  recordEvent(incidentId, source, kind, detail = null) {
    this.db.prepare(`INSERT INTO incident_events (incident_id, source, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(incidentId, source, kind, detail == null ? null : String(detail), new Date().toISOString());
  }

  recordTranscript(callId, role, text) {
    if (!this.persistTranscripts) return;
    this.db.prepare(`INSERT INTO transcripts (call_id, role, text, created_at) VALUES (?, ?, ?, ?)`)
      .run(callId, role, text, new Date().toISOString());
  }

  eventsFor(incidentId) {
    return this.db.prepare(`SELECT source, kind, detail, created_at AS at FROM incident_events WHERE incident_id = ? ORDER BY id`).all(incidentId);
  }

  recordAttempt(attempt) {
    this.db.prepare(`INSERT OR REPLACE INTO page_attempts
      (id, incident_id, level, attempt, contact_id, contact_name, started_at, completed_at, outcome, escalated_from, voicemail_safe)
      VALUES (@id, @incidentId, @level, @attempt, @contactId, @contactName, @startedAt, @completedAt, @outcome, @escalatedFrom, @voicemailSafe)`)
      .run({ ...attempt, voicemailSafe: attempt.voicemailSafe ? 1 : 0 });
  }

  attemptsFor(incidentId) {
    return this.db.prepare(`SELECT * FROM page_attempts WHERE incident_id = ? ORDER BY started_at, id`).all(incidentId).map(attemptFromRow);
  }

  upsertJob(job) {
    this.db.prepare(`INSERT OR IGNORE INTO scheduler_jobs (id, incident_id, kind, level, attempt, due_at, status, created_at)
      VALUES (@id, @incidentId, @kind, @level, @attempt, @dueAt, @status, @createdAt)`).run(job);
  }

  claimDueJobs(nowMs) {
    const due = this.db.prepare(`SELECT * FROM scheduler_jobs WHERE status = 'pending' AND due_at <= ? ORDER BY due_at`).all(new Date(nowMs).toISOString());
    const mark = this.db.prepare(`UPDATE scheduler_jobs SET status = 'running' WHERE id = ? AND status = 'pending'`);
    return due.filter((job) => mark.run(job.id).changes === 1).map(jobFromRow);
  }

  completeJob(id, status = "done") {
    this.db.prepare(`UPDATE scheduler_jobs SET status = ? WHERE id = ?`).run(status, id);
  }

  cancelJobsForIncident(incidentId) {
    this.db.prepare(`UPDATE scheduler_jobs SET status = 'cancelled' WHERE incident_id = ? AND status = 'pending'`).run(incidentId);
  }

  pendingJobs() {
    return this.db.prepare(`SELECT * FROM scheduler_jobs WHERE status = 'pending' ORDER BY due_at`).all().map(jobFromRow);
  }

  stats() {
    const incidents = this.listIncidents();
    const attempts = this.db.prepare(`SELECT * FROM page_attempts`).all().map(attemptFromRow);
    const ackTimes = incidents.filter((i) => i.acknowledgedAt).map((i) => new Date(i.acknowledgedAt) - new Date(i.reportedAt));
    const paged = incidents.filter((i) => ["urgent", "emergency"].includes(i.severity));
    return {
      incidents: incidents.length,
      bySeverity: tally(incidents, "severity"),
      medianMsToAcknowledge: percentile(ackTimes, 0.5),
      p90MsToAcknowledge: percentile(ackTimes, 0.9),
      successfulContacts: paged.length ? incidents.filter((i) => i.acknowledgedAt).length / paged.length : 0,
      medianEscalationMs: percentile(attempts.filter((a) => a.escalatedFrom).map((a) => new Date(a.startedAt) - new Date(incidents.find((i) => i.id === a.incidentId)?.reportedAt ?? a.startedAt)), 0.5),
      pagesPerIncident: incidents.length ? attempts.length / incidents.length : 0,
      unacknowledgedIncidents: incidents.filter((i) => i.state === "unacknowledgedAlert").length,
      duplicatesAttached: incidents.reduce((n, i) => n + (i.duplicatesAttached ?? 0), 0),
      routineWorkOrdersLogged: incidents.filter((i) => i.state === "workOrderLogged").length,
      pendingJobs: this.pendingJobs().length,
      pageAttempts: attempts.length,
    };
  }

  close() { this.db.close(); }
}

function rowForIncident(i) {
  return {
    id: i.id, state: i.state, severity: i.severity, propertyId: i.propertyId, propertyName: i.propertyName,
    unit: i.unit, issueType: i.issueType, issue: i.issue, tenantSaid: i.tenantSaid, accessNotes: i.accessNotes,
    permissionToEnter: i.permissionToEnter ? 1 : 0, callbackMasked: i.callbackMasked, reportedAt: i.reportedAt,
    acknowledgedAt: i.acknowledgedAt ?? null, closedAt: i.closedAt ?? null, acknowledgedBy: i.acknowledgedBy ?? null,
    bridgeRequested: i.bridgeRequested ? 1 : 0, duplicatesAttached: i.duplicatesAttached ?? 0, safetyLine: i.safetyLine ?? null,
    matchedRule: i.matchedRule ?? null, simulated: i.simulated ? 1 : 0,
  };
}
function incidentFromRow(r) {
  return { id: r.id, state: r.state, severity: r.severity, propertyId: r.property_id, propertyName: r.property_name,
    unit: r.unit, issueType: r.issue_type, issue: r.issue, tenantSaid: r.tenant_said, accessNotes: r.access_notes,
    permissionToEnter: Boolean(r.permission_to_enter), callbackMasked: r.callback_masked, reportedAt: r.reported_at,
    acknowledgedAt: r.acknowledged_at, closedAt: r.closed_at, acknowledgedBy: r.acknowledged_by,
    bridgeRequested: Boolean(r.bridge_requested), duplicatesAttached: r.duplicates_attached, safetyLine: r.safety_line,
    matchedRule: r.matched_rule, simulated: Boolean(r.simulated) };
}
function attemptFromRow(r) { return { id: r.id, incidentId: r.incident_id, level: r.level, attempt: r.attempt, contactId: r.contact_id, contactName: r.contact_name, startedAt: r.started_at, completedAt: r.completed_at, outcome: r.outcome, escalatedFrom: r.escalated_from, voicemailSafe: Boolean(r.voicemail_safe) }; }
function jobFromRow(r) { return { id: r.id, incidentId: r.incident_id, kind: r.kind, level: r.level, attempt: r.attempt, dueAt: r.due_at, status: r.status, createdAt: r.created_at }; }
function tally(rows, key) { return rows.reduce((acc, row) => { const k = row[key] ?? "none"; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}); }
function percentile(values, p) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]; }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  severity TEXT NOT NULL,
  property_id TEXT NOT NULL,
  property_name TEXT NOT NULL,
  unit TEXT NOT NULL,
  issue_type TEXT,
  issue TEXT NOT NULL,
  tenant_said TEXT,
  access_notes TEXT,
  permission_to_enter INTEGER NOT NULL DEFAULT 0,
  callback_masked TEXT,
  reported_at TEXT NOT NULL,
  acknowledged_at TEXT,
  closed_at TEXT,
  acknowledged_by TEXT,
  bridge_requested INTEGER NOT NULL DEFAULT 0,
  duplicates_attached INTEGER NOT NULL DEFAULT 0,
  safety_line TEXT,
  matched_rule TEXT,
  simulated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS incident_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS page_attempts (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  level TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  contact_id TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  outcome TEXT,
  escalated_from TEXT,
  voicemail_safe INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS scheduler_jobs (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  level TEXT,
  attempt INTEGER,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incident_lookup ON incidents(property_id, unit, reported_at);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON scheduler_jobs(status, due_at);
`;
