import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.mjs";

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
    this.db.prepare(`INSERT OR REPLACE INTO calls (id, masked_phone, state, started_at) VALUES (@id, @maskedPhone, @state, @startedAt)`).run(call);
  }
  updateCall(id, patch) {
    const map = { state: "state", outcome: "outcome", endedAt: "ended_at", durationMs: "duration_ms", lastLocationId: "last_location_id", lastQuote: "last_quote", simulated: "simulated" };
    const sets = [];
    const values = { id };
    for (const [k, col] of Object.entries(map)) if (patch[k] !== undefined) { sets.push(`${col}=@${k}`); values[k] = typeof patch[k] === "boolean" ? Number(patch[k]) : patch[k]; }
    if (sets.length) this.db.prepare(`UPDATE calls SET ${sets.join(", ")} WHERE id=@id`).run(values);
  }
  recordEvent(callId, source, kind, detail = null) {
    this.db.prepare(`INSERT INTO call_events (call_id, source, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)`).run(callId, source, kind, detail == null ? null : String(detail), new Date().toISOString());
  }
  recordQuote(callId, quote) {
    this.db.prepare(`INSERT INTO quotes (call_id, commodity, location_id, freshness, phrase, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(callId, quote.commodity, quote.locationId, quote.freshness, quote.phrase, new Date().toISOString());
    this.recordEvent(callId, "system", "quote", JSON.stringify({ commodity: quote.commodity, locationId: quote.locationId, freshness: quote.freshness }));
  }
  recordTranscript(callId, role, text) {
    if (!this.persistTranscripts) return;
    this.db.prepare(`INSERT INTO transcripts (call_id, role, text, created_at) VALUES (?, ?, ?, ?)`).run(callId, role, text, new Date().toISOString());
  }
  eventsFor(callId) { return this.db.prepare(`SELECT source, kind, detail, created_at AS at FROM call_events WHERE call_id=? ORDER BY id`).all(callId); }
  stats({ minutesPerAutomatedCall = config.pricing.minutesPerAutomatedCall } = {}) {
    const countRows = (sql) => Object.fromEntries(this.db.prepare(sql).all().map((r) => [r.k, r.n]));
    const callsAutomated = this.db.prepare(`SELECT COUNT(*) AS n FROM calls WHERE outcome IS NOT NULL AND outcome NOT LIKE 'transferred:%'`).get().n;
    return {
      calls: this.db.prepare(`SELECT COUNT(*) AS n FROM calls`).get().n,
      callsAutomated,
      estimatedStaffMinutesSaved: callsAutomated * minutesPerAutomatedCall,
      quotesByCommodity: countRows(`SELECT commodity AS k, COUNT(*) AS n FROM quotes GROUP BY k`),
      quotesByLocation: countRows(`SELECT location_id AS k, COUNT(*) AS n FROM quotes GROUP BY k`),
      delayedQuotes: this.db.prepare(`SELECT COUNT(*) AS n FROM quotes WHERE freshness='delayed'`).get().n,
      closePriceQuotes: this.db.prepare(`SELECT COUNT(*) AS n FROM quotes WHERE freshness='close'`).get().n,
      feedOutages: this.db.prepare(`SELECT COUNT(*) AS n FROM call_events WHERE kind='feed_outage'`).get().n,
      transfersByReason: countRows(`SELECT COALESCE(detail, 'none') AS k, COUNT(*) AS n FROM call_events WHERE kind='transfer_started' GROUP BY k`),
      byOutcome: countRows(`SELECT COALESCE(outcome, 'none') AS k, COUNT(*) AS n FROM calls GROUP BY k`),
    };
  }
  close() { this.db.close(); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  masked_phone TEXT,
  state TEXT NOT NULL,
  outcome TEXT,
  simulated INTEGER NOT NULL DEFAULT 0,
  last_location_id TEXT,
  last_quote TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER
);
CREATE TABLE IF NOT EXISTS call_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL,
  commodity TEXT NOT NULL,
  location_id TEXT NOT NULL,
  freshness TEXT NOT NULL,
  phrase TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_call ON call_events(call_id);
CREATE INDEX IF NOT EXISTS idx_quotes_call ON quotes(call_id);
`;
