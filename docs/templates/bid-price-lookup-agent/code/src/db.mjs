import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.mjs";

/** The audit trail on disk. Caller utterances are stored only when PERSIST_TRANSCRIPTS is on. */
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
    this.db
      .prepare(`INSERT OR REPLACE INTO calls (id, masked_phone, state, started_at, simulated) VALUES (@id, @maskedPhone, @state, @startedAt, @simulated)`)
      .run({ id: call.id, maskedPhone: call.maskedPhone ?? null, state: call.state, startedAt: call.startedAt, simulated: call.simulated ? 1 : 0 });
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
  }
  recordTranscript(callId, role, text) {
    if (!this.persistTranscripts) return;
    this.db.prepare(`INSERT INTO transcripts (call_id, role, text, created_at) VALUES (?, ?, ?, ?)`).run(callId, role, text, new Date().toISOString());
  }
  eventsFor(callId) { return this.db.prepare(`SELECT source, kind, detail, created_at AS at FROM call_events WHERE call_id=? ORDER BY id`).all(callId); }

  /** Delete the simulated calls (the demo console's reset). Real calls stay. */
  reset() {
    const simulated = `SELECT id FROM calls WHERE simulated = 1`;
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM call_events WHERE call_id IN (${simulated})`).run();
      this.db.prepare(`DELETE FROM quotes WHERE call_id IN (${simulated})`).run();
      this.db.prepare(`DELETE FROM transcripts WHERE call_id IN (${simulated})`).run();
      this.db.prepare(`DELETE FROM calls WHERE simulated = 1`).run();
    })();
  }

  stats({ minutesPerAutomatedCall = config.pricing.minutesPerAutomatedCall } = {}) {
    const count = (sql) => this.db.prepare(sql).get().n;
    const countRows = (sql) => Object.fromEntries(this.db.prepare(sql).all().map((r) => [r.k, r.n]));
    const events = (...kinds) => count(`SELECT COUNT(*) AS n FROM call_events WHERE kind IN (${kinds.map((k) => `'${k}'`).join(", ")})`);
    const callsAutomated = count(`SELECT COUNT(*) AS n FROM calls WHERE outcome IS NOT NULL AND outcome NOT LIKE 'transferred:%' AND outcome NOT LIKE 'callback_requested:%'`);
    return {
      calls: count(`SELECT COUNT(*) AS n FROM calls`),
      callsAutomated,
      estimatedStaffMinutesSaved: callsAutomated * minutesPerAutomatedCall,
      quotesGiven: count(`SELECT COUNT(*) AS n FROM quotes`),
      quotesByCommodity: countRows(`SELECT commodity AS k, COUNT(*) AS n FROM quotes GROUP BY k`),
      quotesByLocation: countRows(`SELECT location_id AS k, COUNT(*) AS n FROM quotes GROUP BY k`),
      delayedQuotes: count(`SELECT COUNT(*) AS n FROM quotes WHERE freshness='delayed'`),
      closePriceQuotes: count(`SELECT COUNT(*) AS n FROM quotes WHERE freshness='close'`),
      clarifications: events("clarification"),
      feedOutages: events("feed_outage"),
      adviceDeclined: events("advice_guard"),
      contractsDeclined: events("contract_guard"),
      transfers: count(`SELECT COUNT(*) AS n FROM calls WHERE outcome LIKE 'transferred:%'`),
      callbacks: events("callback_requested"),
      transfersByReason: countRows(`SELECT substr(outcome, 13) AS k, COUNT(*) AS n FROM calls WHERE outcome LIKE 'transferred:%' GROUP BY k`),
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