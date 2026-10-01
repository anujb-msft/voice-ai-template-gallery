import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.mjs";

export class SqliteAudit {
  name = "sqlite";
  constructor(path = config.schedule.dbPath.replace(/schedule\.db$/, "reminder-audit.db")) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.persistTranscripts = config.retention.transcripts;
    this.db.exec(SCHEMA);
  }
  startCall(call) {
    this.db.prepare(`INSERT OR REPLACE INTO calls (id, appointment_id, patient_id, state, direction, started_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(call.id, call.appointmentId ?? null, call.patientId ?? null, call.state, call.direction ?? "outbound", new Date(call.startedAt ?? Date.now()).toISOString());
  }
  updateCall(id, patch) {
    const map = { state: "state", outcome: "outcome", verified: "verified", proxyName: "proxy_name", endedAt: "ended_at", durationMs: "duration_ms" };
    const sets = [], values = { id };
    for (const [k, col] of Object.entries(map)) if (patch[k] !== undefined) { sets.push(`${col}=@${k}`); values[k] = typeof patch[k] === "boolean" ? Number(patch[k]) : patch[k]; }
    if (sets.length) this.db.prepare(`UPDATE calls SET ${sets.join(", ")} WHERE id=@id`).run(values);
  }
  recordEvent(callId, source, kind, detail = null) { this.db.prepare(`INSERT INTO call_events (call_id, source, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(callId, source, kind, detail == null ? null : String(detail), new Date().toISOString()); }
  recordTranscript(callId, role, text) { if (!this.persistTranscripts) return; this.db.prepare(`INSERT INTO transcripts (call_id, role, text, created_at) VALUES (?, ?, ?, ?)`)
    .run(callId, role, maskTranscript(text), new Date().toISOString()); }
  eventsFor(callId) { return this.db.prepare(`SELECT source, kind, detail, created_at AS at FROM call_events WHERE call_id=? ORDER BY id`).all(callId); }
  stats() {
    const grouped = (col) => Object.fromEntries(this.db.prepare(`SELECT COALESCE(${col}, 'none') k, COUNT(*) n FROM calls GROUP BY k`).all().map((r) => [r.k, r.n]));
    return { calls: this.db.prepare(`SELECT COUNT(*) n FROM calls`).get().n, byState: grouped("state"), byOutcome: grouped("outcome"), verified: this.db.prepare(`SELECT COUNT(*) n FROM calls WHERE verified=1`).get().n };
  }
  close() { this.db.close(); }
}

export function maskTranscript(text) {
  return String(text).replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, "[date]").replace(/\b(?:Jordan|Avery|Mia|Sam|Taylor|Riley|Camila|Noah|Harper|Elena|Quinn|Logan)\b/gi, "[name]");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, appointment_id TEXT, patient_id TEXT, state TEXT NOT NULL, direction TEXT, outcome TEXT, verified INTEGER DEFAULT 0, proxy_name TEXT, started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER);
CREATE TABLE IF NOT EXISTS call_events (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS transcripts (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
`;
