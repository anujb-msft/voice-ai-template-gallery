import { config } from "./config.mjs";
import { openDatabase } from "./sqlite.mjs";
import { summarize } from "./audit.mjs";

/**
 * SQLite implementation of the audit sink.
 *
 * Same interface as `MemoryAudit`, so the scheduling flow cannot tell the
 * difference and the tests never need a database file. What gets stored is
 * the decision trail: the masked number, whether identity was confirmed, the
 * outcome and the appointment written, and every event. Caller text (already
 * masked by the flow) is written only when TRANSCRIPT_RETENTION is on.
 *
 * Opened with `await SqliteAudit.open(path)`, which prefers better-sqlite3
 * and falls back to Node's built-in node:sqlite.
 */
export class SqliteAudit {
  name = "sqlite";

  static async open(path = config.dbPath, { driver = "auto", persistTranscripts = config.persistTranscripts } = {}) {
    const db = await openDatabase(path, { driver });
    return new SqliteAudit(db, { persistTranscripts });
  }

  constructor(db, { persistTranscripts = false } = {}) {
    this.db = db;
    try {
      this.db.pragma("journal_mode = WAL");
    } catch {}
    this.db.exec(SCHEMA);
    this.#migrate();
    this.persistTranscripts = persistTranscripts;
  }

  /** An audit file from an earlier version of this sample gains the new columns; nothing is dropped. */
  #migrate() {
    const have = new Set(this.db.prepare(`PRAGMA table_info(calls)`).all().map((c) => c.name));
    for (const [column, type] of Object.entries(ADDED_COLUMNS)) {
      if (!have.has(column)) this.db.exec(`ALTER TABLE calls ADD COLUMN ${column} ${type}`);
    }
  }

  startCall(call) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO calls (id, masked_phone, arrival, state, simulated, started_at)
         VALUES (@id, @maskedPhone, @arrival, @state, @simulated, @startedAt)`,
      )
      .run({
        id: call.id,
        maskedPhone: call.maskedPhone ?? null,
        arrival: call.arrival ?? null,
        state: call.state,
        simulated: call.simulated ? 1 : 0,
        startedAt: call.startedAt,
      });
  }

  /** Only the columns present in the patch are touched. */
  updateCall(id, patch) {
    const columns = {
      state: "state",
      verified: "verified",
      patientRef: "patient_ref",
      outcome: "outcome",
      appointmentId: "appointment_id",
      answeredAt: "answered_at",
      endedAt: "ended_at",
      durationMs: "duration_ms",
      simulated: "simulated",
    };

    const sets = [];
    const values = { id };
    for (const [key, column] of Object.entries(columns)) {
      if (patch[key] === undefined) continue;
      sets.push(`${column} = @${key}`);
      values[key] = typeof patch[key] === "boolean" ? Number(patch[key]) : patch[key];
    }
    if (!sets.length) return;

    this.db.prepare(`UPDATE calls SET ${sets.join(", ")} WHERE id = @id`).run(values);
  }

  recordEvent(callId, source, kind, detail = null) {
    this.db
      .prepare(`INSERT INTO call_events (call_id, source, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(callId, source, kind, detail == null ? null : String(detail), new Date().toISOString());
  }

  recordTranscript(callId, role, text) {
    if (!this.persistTranscripts) return;
    this.db
      .prepare(`INSERT INTO transcripts (call_id, role, text, created_at) VALUES (?, ?, ?, ?)`)
      .run(callId, role, text, new Date().toISOString());
  }

  eventsFor(callId) {
    return this.db
      .prepare(`SELECT source, kind, detail, created_at AS at FROM call_events WHERE call_id = ? ORDER BY id`)
      .all(callId)
      .map((r) => ({ ...r }));
  }

  /**
   * Delete simulated calls and everything recorded about them: the demo
   * console's reset between run-throughs. Calls from a real phone stay.
   */
  reset() {
    const simulated = `SELECT id FROM calls WHERE simulated = 1`;
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM call_events WHERE call_id IN (${simulated})`).run();
      this.db.prepare(`DELETE FROM transcripts WHERE call_id IN (${simulated})`).run();
      this.db.prepare(`DELETE FROM calls WHERE simulated = 1`).run();
    })();
  }

  /** What the presenter console shows on the metrics strip. */
  stats() {
    const byOutcome = Object.fromEntries(
      this.db
        .prepare(`SELECT COALESCE(outcome, 'in_progress') AS k, COUNT(*) AS n FROM calls GROUP BY k`)
        .all()
        .map((r) => [r.k, Number(r.n)]),
    );
    const counts = Object.fromEntries(
      this.db
        .prepare(`SELECT kind, COUNT(*) AS n FROM call_events GROUP BY kind`)
        .all()
        .map((r) => [r.kind, Number(r.n)]),
    );
    return summarize({
      calls: Number(this.db.prepare(`SELECT COUNT(*) AS n FROM calls`).get().n),
      verified: Number(this.db.prepare(`SELECT COUNT(*) AS n FROM calls WHERE verified = 1`).get().n),
      byOutcome,
      count: (kind) => counts[kind] ?? 0,
    });
  }

  close() {
    this.db.close();
  }
}

const ADDED_COLUMNS = {
  arrival: "TEXT",
  verified: "INTEGER NOT NULL DEFAULT 0",
  patient_ref: "TEXT",
  appointment_id: "TEXT",
  answered_at: "TEXT",
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  id             TEXT PRIMARY KEY,
  masked_phone   TEXT,
  arrival        TEXT,
  state          TEXT NOT NULL,
  simulated      INTEGER NOT NULL DEFAULT 0,
  verified       INTEGER NOT NULL DEFAULT 0,
  patient_ref    TEXT,
  outcome        TEXT,
  appointment_id TEXT,
  started_at     TEXT NOT NULL,
  answered_at    TEXT,
  ended_at       TEXT,
  duration_ms    INTEGER
);

CREATE TABLE IF NOT EXISTS call_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id    TEXT NOT NULL REFERENCES calls(id),
  source     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transcripts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id    TEXT NOT NULL REFERENCES calls(id),
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_call ON call_events(call_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_call ON transcripts(call_id);
`;
