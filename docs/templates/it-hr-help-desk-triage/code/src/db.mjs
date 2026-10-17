import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.mjs";
import { buildStats } from "./audit.mjs";

export class SqliteAudit {
  name = "sqlite";
  constructor(path = config.dbPath, { statsMinCount = config.statsMinCount } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.statsMinCount = statsMinCount;
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }
  startCall(call) {
    this.db.prepare(`INSERT OR REPLACE INTO calls (id, state, verified, domain, started_at, simulation) VALUES (@id, @state, @verified, @domain, @startedAt, @simulation)`)
      .run({ id: call.id, state: call.state, verified: call.verified ? 1 : 0, domain: call.domain ?? null, startedAt: new Date(call.startedAt).toISOString(), simulation: call.simulation ? 1 : 0 });
  }
  updateCall(id, patch) {
    const cols = { state: "state", verified: "verified", domain: "domain", topicId: "topic_id", outcome: "outcome", endedAt: "ended_at", durationMs: "duration_ms", simulation: "simulation" };
    const sets = [];
    const vals = { id };
    for (const [k, c] of Object.entries(cols)) {
      if (patch[k] === undefined) continue;
      sets.push(`${c}=@${k}`);
      vals[k] = typeof patch[k] === "boolean" ? Number(patch[k]) : patch[k];
    }
    if (sets.length) this.db.prepare(`UPDATE calls SET ${sets.join(", ")} WHERE id=@id`).run(vals);
  }
  recordEvent(callId, source, kind, detail = null, at = new Date().toISOString()) {
    this.db.prepare(`INSERT INTO call_events (call_id, source, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(callId, source, kind, detail == null ? null : String(detail), at);
  }
  recordTranscript(callId, role, text, { sensitive = false } = {}) {
    if (!config.transcriptRetention || sensitive) return;
    this.db.prepare(`INSERT INTO transcripts (call_id, role, text, created_at) VALUES (?, ?, ?, ?)`).run(callId, role, text, new Date().toISOString());
  }
  eventsFor(callId) {
    return this.db.prepare(`SELECT source, kind, detail, created_at AS at FROM call_events WHERE call_id=? ORDER BY id`).all(callId);
  }
  stats(ticketStats = {}) {
    const count = (kind) => this.db.prepare(`SELECT COUNT(*) AS n FROM call_events WHERE kind=?`).get(kind).n;
    const tally = (kind) => Object.fromEntries(this.db.prepare(`SELECT COALESCE(detail,'none') k, COUNT(*) n FROM call_events WHERE kind=? GROUP BY k`).all(kind).map((r) => [r.k, r.n]));
    const mix = Object.fromEntries(this.db.prepare(`SELECT COALESCE(domain,'none') k, COUNT(*) n FROM calls GROUP BY k`).all().map((r) => [r.k, r.n]));
    const durations = this.db.prepare(`SELECT duration_ms AS d FROM calls WHERE duration_ms > 0`).all().map((r) => r.d);
    const calls = this.db.prepare(`SELECT COUNT(*) n FROM calls`).get().n;
    const transferred = Object.fromEntries(this.db.prepare(`SELECT substr(outcome, 13) k, COUNT(*) n FROM calls WHERE outcome LIKE 'transferred:%' GROUP BY k`).all().map((r) => [r.k, r.n]));
    return buildStats({ calls, mix, durations, count, tally, transferred, ticketStats, statsMinCount: this.statsMinCount });
  }
  /** Demo reset: drop simulated calls and everything recorded about them. */
  reset() {
    const removed = this.db.prepare(`SELECT COUNT(*) n FROM calls WHERE simulation=1`).get().n;
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM call_events WHERE call_id IN (SELECT id FROM calls WHERE simulation=1)`).run();
      this.db.prepare(`DELETE FROM transcripts WHERE call_id IN (SELECT id FROM calls WHERE simulation=1)`).run();
      this.db.prepare(`DELETE FROM calls WHERE simulation=1`).run();
    })();
    return { removed };
  }
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, state TEXT, verified INTEGER, domain TEXT, topic_id TEXT, outcome TEXT, simulation INTEGER DEFAULT 0, started_at TEXT, ended_at TEXT, duration_ms INTEGER);
CREATE TABLE IF NOT EXISTS call_events (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, source TEXT, kind TEXT, detail TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS transcripts (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, role TEXT, text TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_events_call ON call_events(call_id);
`;
