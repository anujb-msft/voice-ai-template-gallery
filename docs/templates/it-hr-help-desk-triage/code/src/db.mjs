import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.mjs";

export class SqliteAudit {
  name = "sqlite";
  constructor(path = config.dbPath) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }
  startCall(call) { this.db.prepare(`INSERT OR REPLACE INTO calls (id, state, verified, domain, started_at, simulation) VALUES (@id, @state, @verified, @domain, @startedAt, @simulation)`).run({ id: call.id, state: call.state, verified: call.verified ? 1 : 0, domain: call.domain ?? null, startedAt: new Date(call.startedAt).toISOString(), simulation: call.simulation ? 1 : 0 }); }
  updateCall(id, patch) {
    const cols = { state:"state", verified:"verified", domain:"domain", topicId:"topic_id", outcome:"outcome", endedAt:"ended_at", durationMs:"duration_ms", simulation:"simulation" };
    const sets=[]; const vals={id};
    for (const [k,c] of Object.entries(cols)) if (patch[k] !== undefined) { sets.push(`${c}=@${k}`); vals[k]=typeof patch[k]==="boolean"?Number(patch[k]):patch[k]; }
    if (sets.length) this.db.prepare(`UPDATE calls SET ${sets.join(", ")} WHERE id=@id`).run(vals);
  }
  recordEvent(callId, source, kind, detail = null) { this.db.prepare(`INSERT INTO call_events (call_id, source, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)`).run(callId, source, kind, detail == null ? null : String(detail), new Date().toISOString()); }
  recordTranscript(callId, role, text, { sensitive = false } = {}) { if (!config.transcriptRetention || sensitive) return; this.db.prepare(`INSERT INTO transcripts (call_id, role, text, created_at) VALUES (?, ?, ?, ?)`).run(callId, role, text, new Date().toISOString()); }
  eventsFor(callId) { return this.db.prepare(`SELECT source, kind, detail, created_at AS at FROM call_events WHERE call_id=? ORDER BY id`).all(callId); }
  stats(ticketStats = {}) {
    const events = (kind) => this.db.prepare(`SELECT COUNT(*) AS n FROM call_events WHERE kind=?`).get(kind).n;
    const tallyEvent = (kind) => Object.fromEntries(this.db.prepare(`SELECT COALESCE(detail,'none') k, COUNT(*) n FROM call_events WHERE kind=? GROUP BY k`).all(kind).map(r=>[r.k,r.n]));
    const confidential = events("confidential_hr");
    return { calls: this.db.prepare(`SELECT COUNT(*) n FROM calls`).get().n, mix: Object.fromEntries(this.db.prepare(`SELECT COALESCE(domain,'none') k, COUNT(*) n FROM calls GROUP BY k`).all().map(r=>[r.k,r.n])), tier1Deflection: events("answered") + events("personal_answer"), routingAccuracy: null, averageTimeToResolutionMs: null, answersByArticle: tallyEvent("answered"), ticketsByCategory: ticketStats.byCategory ?? {}, ticketsByPriority: ticketStats.byPriority ?? {}, outageAttachments: events("outage_attached"), resetHandoffs: events("password_reset_handoff"), transfersByDestination: tallyEvent("transfer"), outOfScopeRedirects: events("out_of_scope"), verificationOutcomes: tallyEvent("verification"), confidentialHr: confidential < config.statsMinCount ? "<5" : confidential };
  }
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, state TEXT, verified INTEGER, domain TEXT, topic_id TEXT, outcome TEXT, simulation INTEGER DEFAULT 0, started_at TEXT, ended_at TEXT, duration_ms INTEGER);
CREATE TABLE IF NOT EXISTS call_events (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, source TEXT, kind TEXT, detail TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS transcripts (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, role TEXT, text TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_events_call ON call_events(call_id);
`;
