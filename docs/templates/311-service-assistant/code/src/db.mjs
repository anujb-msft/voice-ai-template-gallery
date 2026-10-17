import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.mjs";
import { MemoryAudit } from "./audit.mjs";
import { MemoryCaseStore } from "./cases.mjs";

// The in-memory store lives in cases.mjs so nothing has to load this native
// module to use it. Re-exported for code that imported it from here.
export { MemoryCaseStore };

function open(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  return db;
}

/** Older databases predate newer columns (`simulated`, `escalated_at`); add them in place. */
function ensureColumn(db, table, column, type) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export class SqliteAudit extends MemoryAudit {
  name = "sqlite";
  constructor(path = config.dbPath) {
    super();
    this.db = open(path);
    this.db.exec(AUDIT_SCHEMA);
    ensureColumn(this.db, "calls", "simulated", "INTEGER NOT NULL DEFAULT 0");
    this.persistTranscripts = config.persistTranscripts;
  }
  startCall(call) {
    super.startCall(call);
    this.db.prepare(`INSERT OR REPLACE INTO calls (id, state, language, started_at, simulated) VALUES (?, ?, ?, ?, ?)`).run(call.id, call.state, call.language ?? "en-US", call.startedAt, call.simulated ? 1 : 0);
  }
  updateCall(id, patch) {
    super.updateCall(id, patch);
    const columns = { state: "state", language: "language", outcome: "outcome", endedAt: "ended_at", durationMs: "duration_ms" };
    const sets = [];
    const values = { id };
    for (const [key, column] of Object.entries(columns)) if (patch[key] !== undefined) { sets.push(`${column}=@${key}`); values[key] = patch[key]; }
    if (sets.length) this.db.prepare(`UPDATE calls SET ${sets.join(", ")} WHERE id=@id`).run(values);
  }
  recordEvent(callId, source, kind, detail = null, meta = null) {
    super.recordEvent(callId, source, kind, detail, meta);
    this.db.prepare(`INSERT INTO call_events (call_id, source, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)`).run(callId, source, kind, detail == null ? null : String(detail), new Date().toISOString());
  }
  recordTranscript(callId, role, text) {
    super.recordTranscript(callId, role, text);
    if (this.persistTranscripts) this.db.prepare(`INSERT INTO transcripts (call_id, role, text, created_at) VALUES (?, ?, ?, ?)`).run(callId, role, text, new Date().toISOString());
  }
  eventsFor(callId) {
    return this.db.prepare(`SELECT source, kind, detail, created_at AS at FROM call_events WHERE call_id=? ORDER BY id`).all(callId);
  }
  /** Demo reset: forget simulated calls and everything recorded about them; real calls stay. */
  reset() {
    super.reset();
    const simulated = `SELECT id FROM calls WHERE simulated=1`;
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM call_events WHERE call_id IN (${simulated})`).run();
      this.db.prepare(`DELETE FROM transcripts WHERE call_id IN (${simulated})`).run();
      this.db.prepare(`DELETE FROM calls WHERE simulated=1`).run();
    })();
  }
  close() { this.db.close(); }
}

export class SqliteCaseStore extends MemoryCaseStore {
  name = "sqlite";
  constructor({ path = config.dbPath, now = () => Date.now() } = {}) {
    super({ now });
    this.db = open(path);
    this.db.exec(CASE_SCHEMA);
    ensureColumn(this.db, "service_cases", "simulated", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(this.db, "service_cases", "escalated_at", "TEXT");
    this.cases = this.db.prepare(`SELECT * FROM service_cases ORDER BY created_at`).all().map(fromDb);
    this.renumber();
  }
  create(input) {
    const row = super.create(input);
    this.db.prepare(`INSERT INTO service_cases (id, type, department, status, location, lat, lon, zone, fields_json, contact_json, me_too, created_at, updated_at, priority, simulated) VALUES (@id, @type, @department, @status, @location, @lat, @lon, @zone, @fieldsJson, @contactJson, @meToo, @createdAt, @updatedAt, @priority, @simulated)`).run(toDb(row));
    return row;
  }
  attach(existing, note = null, escalation = {}) {
    const row = super.attach(existing, note, escalation);
    this.db.prepare(`UPDATE service_cases SET me_too=?, updated_at=?, priority=?, escalated_at=?, fields_json=? WHERE id=?`).run(row.meToo, row.updatedAt, row.priority ? 1 : 0, row.escalatedAt ?? null, JSON.stringify(row.fields ?? {}), row.id);
    return row;
  }
  updateContact(caseNumber, contact) {
    const row = super.updateContact(caseNumber, contact);
    if (row) this.db.prepare(`UPDATE service_cases SET contact_json=? WHERE id=?`).run(JSON.stringify(contact), row.id);
    return row;
  }
  close(caseNumber) {
    const row = super.close(caseNumber);
    if (row) this.db.prepare(`UPDATE service_cases SET status=?, updated_at=? WHERE id=?`).run(row.status, row.updatedAt, row.id);
    return row;
  }
  reset() {
    const removed = super.reset();
    this.db.prepare(`DELETE FROM service_cases WHERE simulated=1`).run();
    return removed;
  }
}

function toDb(row) {
  return { ...row, location: row.location?.normalized ?? row.locationText ?? null, lat: row.lat ?? row.location?.lat ?? null, lon: row.lon ?? row.location?.lon ?? null, zone: row.zone ?? row.location?.zone ?? null, fieldsJson: JSON.stringify(row.fields ?? {}), contactJson: row.contact ? JSON.stringify(row.contact) : null, priority: row.priority ? 1 : 0, simulated: row.simulated ? 1 : 0 };
}

function fromDb(row) {
  return {
    id: row.id,
    type: row.type,
    department: row.department,
    status: row.status,
    location: { normalized: row.location, lat: row.lat, lon: row.lon, zone: row.zone },
    lat: row.lat,
    lon: row.lon,
    zone: row.zone,
    fields: row.fields_json ? JSON.parse(row.fields_json) : {},
    contact: row.contact_json ? JSON.parse(row.contact_json) : null,
    meToo: row.me_too,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    priority: Boolean(row.priority),
    escalatedAt: row.escalated_at ?? null,
    simulated: Boolean(row.simulated),
  };
}

const AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, state TEXT NOT NULL, language TEXT, outcome TEXT, started_at INTEGER, ended_at INTEGER, duration_ms INTEGER, simulated INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS call_events (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, source TEXT, kind TEXT, detail TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS transcripts (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, role TEXT, text TEXT, created_at TEXT);
`;
const CASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS service_cases (id TEXT PRIMARY KEY, type TEXT, department TEXT, status TEXT, location TEXT, lat REAL, lon REAL, zone TEXT, fields_json TEXT, contact_json TEXT, me_too INTEGER, created_at TEXT, updated_at TEXT, priority INTEGER, simulated INTEGER NOT NULL DEFAULT 0, escalated_at TEXT);
`;
