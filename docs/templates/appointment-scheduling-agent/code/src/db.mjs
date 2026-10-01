import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.mjs";

/**
 * SQLite implementation of the audit sink.
 *
 * Same interface as `MemoryAudit`, so the state machine cannot tell the
 * difference and the tests never touch a database. What gets stored is the
 * routing decision — masked number, chosen route, topic, summary, outcome,
 * and every state transition. Utterance text is written only when
 * PERSIST_TRANSCRIPTS is explicitly turned on.
 */
export class SqliteAudit {
  name = "sqlite";

  constructor(path = config.dbPath) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.persistTranscripts = config.persistTranscripts;
  }

  startCall(call) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO calls
           (id, masked_phone, caller_name, caller_verified, state, started_at)
         VALUES (@id, @maskedPhone, @callerName, @callerVerified, @state, @startedAt)`,
      )
      .run({
        id: call.id,
        maskedPhone: call.maskedPhone ?? null,
        callerName: call.callerName ?? null,
        callerVerified: call.callerVerified ? 1 : 0,
        state: call.state,
        startedAt: call.startedAt,
      });
  }

  /** Only the columns present in the patch are touched. */
  updateCall(id, patch) {
    const columns = {
      state: "state",
      confirmedRouteId: "confirmed_route_id",
      outcome: "outcome",
      endedAt: "ended_at",
      durationMs: "duration_ms",
      topic: "topic",
      summary: "summary",
      sentiment: "sentiment",
      simulated: "simulated",
    };

    const sets = [];
    const values = {};
    for (const [key, column] of Object.entries(columns)) {
      if (patch[key] === undefined) continue;
      sets.push(`${column} = @${key}`);
      values[key] = typeof patch[key] === "boolean" ? Number(patch[key]) : patch[key];
    }
    if (!sets.length) return;

    this.db.prepare(`UPDATE calls SET ${sets.join(", ")} WHERE id = @id`).run({ ...values, id });
  }

  recordEvent(callId, source, kind, detail = null) {
    this.db
      .prepare(
        `INSERT INTO call_events (call_id, source, kind, detail, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(callId, source, kind, detail == null ? null : String(detail), new Date().toISOString());
  }

  recordTranscript(callId, role, text) {
    if (!this.persistTranscripts) return;
    this.db
      .prepare(
        `INSERT INTO transcripts (call_id, role, text, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(callId, role, text, new Date().toISOString());
  }

  eventsFor(callId) {
    return this.db
      .prepare(`SELECT source, kind, detail, created_at AS at FROM call_events WHERE call_id = ? ORDER BY id`)
      .all(callId);
  }

  /** What the presenter console shows on the metrics strip. */
  stats() {
    const tally = (column) =>
      Object.fromEntries(
        this.db
          .prepare(`SELECT COALESCE(${column}, 'none') AS k, COUNT(*) AS n FROM calls GROUP BY k`)
          .all()
          .map((r) => [r.k, r.n]),
      );

    const eventCount = (kind) =>
      this.db.prepare(`SELECT COUNT(*) AS n FROM call_events WHERE kind = ?`).get(kind).n;

    return {
      calls: this.db.prepare(`SELECT COUNT(*) AS n FROM calls`).get().n,
      byOutcome: tally("outcome"),
      byRoute: tally("confirmed_route_id"),
      clarifications: eventCount("clarification"),
      fallbacks: eventCount("fallback"),
      transfers: eventCount("transfer_succeeded") + eventCount("transfer_simulated"),
      failedTransfers: eventCount("transfer_failed"),
      messagesTaken: eventCount("message_taken"),
      medianSecondsToRoute: this.#medianSecondsToRoute(),
    };
  }

  /**
   * Answer to confirmed route, which is the number this template is actually
   * trying to move. Computed over completed calls only.
   */
  #medianSecondsToRoute() {
    const rows = this.db
      .prepare(`SELECT duration_ms FROM calls WHERE duration_ms IS NOT NULL ORDER BY duration_ms`)
      .all();
    if (!rows.length) return null;
    const mid = Math.floor(rows.length / 2);
    const ms =
      rows.length % 2 ? rows[mid].duration_ms : (rows[mid - 1].duration_ms + rows[mid].duration_ms) / 2;
    return Math.round(ms / 100) / 10;
  }

  close() {
    this.db.close();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  id                TEXT PRIMARY KEY,
  masked_phone      TEXT,
  caller_name       TEXT,
  caller_verified   INTEGER NOT NULL DEFAULT 0,
  state             TEXT NOT NULL,
  confirmed_route_id TEXT,
  topic             TEXT,
  summary           TEXT,
  sentiment         TEXT,
  outcome           TEXT,
  simulated         INTEGER NOT NULL DEFAULT 0,
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  duration_ms       INTEGER
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
