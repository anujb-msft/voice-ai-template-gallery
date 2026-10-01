import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.mjs";
import { computeStats } from "./audit.mjs";

export class SqliteAudit {
  name = "sqlite";

  constructor(path = config.dbPath) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.persistTranscripts = config.persistTranscripts;
  }

  startCall(call) {
    this.db.prepare(`INSERT OR REPLACE INTO calls
      (id, masked_phone, state, started_at, session_id)
      VALUES (@id, @maskedPhone, @state, @startedAt, @sessionId)`).run({
      id: call.id,
      maskedPhone: call.maskedPhone ?? null,
      state: call.state,
      startedAt: new Date(call.startedAt).toISOString(),
      sessionId: call.sessionId ?? null,
    });
  }

  updateCall(id, patch) {
    const columns = {
      state: "state",
      outcome: "outcome",
      endedAt: "ended_at",
      durationMs: "duration_ms",
      lastTopic: "last_topic",
      lastQuestion: "last_question",
      simulated: "simulated",
    };
    const sets = [];
    const values = { id };
    for (const [key, column] of Object.entries(columns)) {
      if (patch[key] === undefined) continue;
      sets.push(`${column} = @${key}`);
      values[key] = typeof patch[key] === "boolean" ? Number(patch[key]) : patch[key];
    }
    if (sets.length) this.db.prepare(`UPDATE calls SET ${sets.join(", ")} WHERE id = @id`).run(values);
  }

  recordEvent(callId, source, kind, detail = null, meta = null) {
    this.db.prepare(`INSERT INTO call_events (call_id, source, kind, detail, meta_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
        callId,
        source,
        kind,
        detail == null ? null : String(detail),
        meta == null ? null : JSON.stringify(meta),
        new Date().toISOString(),
      );
  }

  recordTranscript(callId, role, text) {
    if (!this.persistTranscripts) return;
    this.db.prepare(`INSERT INTO transcripts (call_id, role, text, created_at) VALUES (?, ?, ?, ?)`)
      .run(callId, role, text, new Date().toISOString());
  }

  eventsFor(callId) {
    return this.db.prepare(`SELECT source, kind, detail, meta_json AS metaJson, created_at AS at FROM call_events WHERE call_id = ? ORDER BY id`).all(callId)
      .map((e) => ({ ...e, meta: e.metaJson ? JSON.parse(e.metaJson) : null, metaJson: undefined }));
  }

  stats() {
    const calls = this.db.prepare(`SELECT id, outcome FROM calls`).all();
    const events = this.db.prepare(`SELECT call_id AS callId, kind, meta_json AS metaJson FROM call_events`).all()
      .map((e) => ({ ...e, meta: e.metaJson ? JSON.parse(e.metaJson) : null }));
    return computeStats(calls, events);
  }

  close() {
    this.db.close();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  masked_phone TEXT,
  session_id TEXT,
  state TEXT NOT NULL,
  outcome TEXT,
  last_topic TEXT,
  last_question TEXT,
  simulated INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS call_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL REFERENCES calls(id),
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL REFERENCES calls(id),
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_general_events_call ON call_events(call_id);
CREATE INDEX IF NOT EXISTS idx_general_transcripts_call ON transcripts(call_id);
`;
