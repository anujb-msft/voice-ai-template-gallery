import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.mjs";
import { summarizeCalls } from "./audit.mjs";

/**
 * SQLite implementation of the audit sink.
 *
 * Same interface as `MemoryAudit`, so the flow cannot tell the difference and
 * the tests never touch a database. What gets stored is the decision trail:
 * appointment, outcome, whether identity was verified, and every policy event.
 * Utterance text is written only when TRANSCRIPT_RETENTION is turned on, and
 * then masked.
 */
export class SqliteAudit {
  name = "sqlite";

  constructor(path = config.audit.dbPath) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    const columns = this.db.prepare(`PRAGMA table_info(calls)`).all().map((c) => c.name);
    if (!columns.includes("simulated")) this.db.exec(`ALTER TABLE calls ADD COLUMN simulated INTEGER NOT NULL DEFAULT 0`);
    this.persistTranscripts = config.retention.transcripts;
  }

  startCall(call) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO calls (id, appointment_id, patient_id, state, direction, simulated, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        call.id,
        call.appointmentId ?? null,
        call.patientId ?? null,
        call.state,
        call.direction ?? "outbound",
        call.simulated ? 1 : 0,
        new Date(call.startedAt ?? Date.now()).toISOString(),
      );
  }

  /** Only the columns present in the patch are touched. */
  updateCall(id, patch) {
    const columns = { state: "state", outcome: "outcome", verified: "verified", proxyName: "proxy_name", endedAt: "ended_at", durationMs: "duration_ms" };
    const sets = [];
    const values = { id };
    for (const [key, column] of Object.entries(columns)) {
      if (patch[key] === undefined) continue;
      sets.push(`${column} = @${key}`);
      values[key] = typeof patch[key] === "boolean" ? Number(patch[key]) : patch[key];
    }
    if (sets.length) this.db.prepare(`UPDATE calls SET ${sets.join(", ")} WHERE id = @id`).run(values);
  }

  recordEvent(callId, source, kind, detail = null, at = new Date().toISOString()) {
    this.db
      .prepare(`INSERT INTO call_events (call_id, source, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(callId, source, kind, detail == null ? null : String(detail), at);
  }

  recordTranscript(callId, role, text, at = new Date().toISOString()) {
    if (!this.persistTranscripts) return;
    this.db
      .prepare(`INSERT INTO transcripts (call_id, role, text, created_at) VALUES (?, ?, ?, ?)`)
      .run(callId, role, maskTranscript(text), at);
  }

  eventsFor(callId) {
    return this.db.prepare(`SELECT source, kind, detail, created_at AS at FROM call_events WHERE call_id = ? ORDER BY id`).all(callId);
  }

  /** Delete simulated calls and everything recorded about them. Calls from a real phone stay. */
  reset() {
    const simulated = `SELECT id FROM calls WHERE simulated = 1`;
    let removed = 0;
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM call_events WHERE call_id IN (${simulated})`).run();
      this.db.prepare(`DELETE FROM transcripts WHERE call_id IN (${simulated})`).run();
      removed = this.db.prepare(`DELETE FROM calls WHERE simulated = 1`).run().changes;
    })();
    return removed;
  }

  stats() {
    return summarizeCalls(this.db.prepare(`SELECT outcome, verified FROM calls`).all());
  }

  close() {
    this.db.close();
  }
}

/** Dates and the seed's fictional first names are masked before a transcript line is stored. */
export function maskTranscript(text) {
  return String(text)
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, "[date]")
    .replace(/\b\d{8}\b/g, "[date]")
    .replace(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi, "[date]")
    .replace(/\b(?:Jordan|Avery|Mia|Sam|Taylor|Riley|Camila|Noah|Harper|Elena|Quinn|Logan)\b/gi, "[name]");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  id             TEXT PRIMARY KEY,
  appointment_id TEXT,
  patient_id     TEXT,
  state          TEXT NOT NULL,
  direction      TEXT,
  outcome        TEXT,
  verified       INTEGER DEFAULT 0,
  proxy_name     TEXT,
  simulated      INTEGER NOT NULL DEFAULT 0,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  duration_ms    INTEGER
);
CREATE TABLE IF NOT EXISTS call_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id    TEXT NOT NULL,
  source     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transcripts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id    TEXT NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_call ON call_events(call_id);
`;
