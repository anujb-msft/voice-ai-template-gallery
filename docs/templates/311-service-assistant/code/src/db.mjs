import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.mjs";
import { haversineMeters } from "./geocoder.mjs";
import { MemoryAudit } from "./audit.mjs";

export class SqliteAudit extends MemoryAudit {
  name = "sqlite";
  constructor(path = config.dbPath) {
    super();
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(AUDIT_SCHEMA);
    this.persistTranscripts = config.persistTranscripts;
  }
  startCall(call) {
    super.startCall(call);
    this.db.prepare(`INSERT OR REPLACE INTO calls (id, state, language, started_at) VALUES (?, ?, ?, ?)`).run(call.id, call.state, call.language ?? "en-US", call.startedAt);
  }
  updateCall(id, patch) {
    super.updateCall(id, patch);
    const columns = { state: "state", language: "language", outcome: "outcome", endedAt: "ended_at", durationMs: "duration_ms" };
    const sets = [];
    const values = { id };
    for (const [key, column] of Object.entries(columns)) if (patch[key] !== undefined) { sets.push(`${column}=@${key}`); values[key] = patch[key]; }
    if (sets.length) this.db.prepare(`UPDATE calls SET ${sets.join(", ")} WHERE id=@id`).run(values);
  }
  recordEvent(callId, source, kind, detail = null) {
    super.recordEvent(callId, source, kind, detail);
    this.db.prepare(`INSERT INTO call_events (call_id, source, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)`).run(callId, source, kind, detail == null ? null : String(detail), new Date().toISOString());
  }
  recordTranscript(callId, role, text) {
    super.recordTranscript(callId, role, text);
    if (this.persistTranscripts) this.db.prepare(`INSERT INTO transcripts (call_id, role, text, created_at) VALUES (?, ?, ?, ?)`).run(callId, role, text, new Date().toISOString());
  }
  eventsFor(callId) {
    return this.db.prepare(`SELECT source, kind, detail, created_at AS at FROM call_events WHERE call_id=? ORDER BY id`).all(callId);
  }
  close() { this.db.close(); }
}

export class MemoryCaseStore {
  name = "memory";
  constructor({ now = () => Date.now(), startSequence = 193 } = {}) {
    this.now = now;
    this.next = startSequence;
    this.cases = [];
  }
  create(input) {
    const now = new Date(this.now()).toISOString();
    const row = { id: input.caseNumber ?? this.#nextCaseNumber(), status: "open", meToo: 1, createdAt: now, updatedAt: now, ...input };
    this.cases.push(row);
    return row;
  }
  attach(existing, note = null) {
    existing.meToo = (existing.meToo ?? 1) + 1;
    existing.updatedAt = new Date(this.now()).toISOString();
    if (note) existing.attachments = [...(existing.attachments ?? []), note];
    return existing;
  }
  findDuplicates({ type, location, radiusM, windowDays }) {
    const min = this.now() - windowDays * 86400000;
    return this.cases.filter((c) => c.type === type && c.status === "open" && c.lat != null && location?.lat != null && Date.parse(c.createdAt) >= min && haversineMeters(c, location) <= radiusM);
  }
  getStatus(caseNumber) { return this.cases.find((c) => c.id.toUpperCase() === String(caseNumber).toUpperCase()) ?? null; }
  updateContact(caseNumber, contact) { const c = this.getStatus(caseNumber); if (c) c.contact = contact; return c; }
  close(caseNumber) { const c = this.getStatus(caseNumber); if (c) { c.status = "closed"; c.updatedAt = new Date(this.now()).toISOString(); } return c; }
  all() { return [...this.cases]; }
  #nextCaseNumber() { return `SR-${String(new Date(this.now()).getFullYear()).slice(2)}-${String(this.next++).padStart(4, "0")}`; }
}

export class SqliteCaseStore extends MemoryCaseStore {
  name = "sqlite";
  constructor({ path = config.dbPath, now = () => Date.now() } = {}) {
    super({ now });
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(CASE_SCHEMA);
    this.cases = this.db.prepare(`SELECT * FROM service_cases ORDER BY created_at`).all().map(fromDb);
    const max = this.cases.map((c) => Number(String(c.id).split("-").pop())).filter(Number.isFinite).sort((a, b) => b - a)[0];
    if (max) this.next = max + 1;
  }
  create(input) {
    const row = super.create(input);
    this.db.prepare(`INSERT INTO service_cases (id, type, department, status, location, lat, lon, zone, fields_json, contact_json, me_too, created_at, updated_at, priority) VALUES (@id, @type, @department, @status, @location, @lat, @lon, @zone, @fieldsJson, @contactJson, @meToo, @createdAt, @updatedAt, @priority)`).run(toDb(row));
    return row;
  }
  attach(existing, note = null) {
    const row = super.attach(existing, note);
    this.db.prepare(`UPDATE service_cases SET me_too=?, updated_at=? WHERE id=?`).run(row.meToo, row.updatedAt, row.id);
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
}

function toDb(row) {
  return { ...row, location: row.location?.normalized ?? row.locationText ?? null, lat: row.lat ?? row.location?.lat ?? null, lon: row.lon ?? row.location?.lon ?? null, zone: row.zone ?? row.location?.zone ?? null, fieldsJson: JSON.stringify(row.fields ?? {}), contactJson: row.contact ? JSON.stringify(row.contact) : null, priority: row.priority ? 1 : 0 };
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
  };
}

const AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, state TEXT NOT NULL, language TEXT, outcome TEXT, started_at INTEGER, ended_at INTEGER, duration_ms INTEGER);
CREATE TABLE IF NOT EXISTS call_events (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, source TEXT, kind TEXT, detail TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS transcripts (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, role TEXT, text TEXT, created_at TEXT);
`;
const CASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS service_cases (id TEXT PRIMARY KEY, type TEXT, department TEXT, status TEXT, location TEXT, lat REAL, lon REAL, zone TEXT, fields_json TEXT, contact_json TEXT, me_too INTEGER, created_at TEXT, updated_at TEXT, priority INTEGER);
`;
