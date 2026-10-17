import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.mjs";
import { MemoryAudit } from "./store.mjs";

/**
 * SQLite storage for live calls.
 *
 * Loaded lazily: the offline simulation and the tests never open a database,
 * and when better-sqlite3 cannot load or the file cannot be opened, the server
 * logs one line and keeps everything in memory instead.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  phonetic_name TEXT,
  email         TEXT NOT NULL,
  phone         TEXT NOT NULL,
  department    TEXT,
  employee_id   TEXT,
  password_hash TEXT,
  locked        INTEGER NOT NULL DEFAULT 0,
  last_reset_at TEXT
);

CREATE TABLE IF NOT EXISTS reset_sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  state         TEXT NOT NULL,
  verify_code   TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  call_id       TEXT,
  outcome       TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES reset_sessions(id),
  source      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  detail      TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id            TEXT PRIMARY KEY,
  session_id    TEXT REFERENCES reset_sessions(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  category      TEXT NOT NULL,
  status        TEXT NOT NULL,
  deflected     INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  minutes_saved REAL NOT NULL DEFAULT 0,
  summary       TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id);
`;

let handle = null;
let opening = null;

/** Open (once) the SQLite database at `path`, creating the schema if needed. */
export async function openDb(path = config.dbPath) {
  if (handle) return handle;
  opening ??= (async () => {
    const { default: Database } = await import("better-sqlite3");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    if (path !== ":memory:") db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    // Lightweight migration for databases created before phonetic_name existed.
    const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
    if (!userCols.includes("phonetic_name")) db.exec("ALTER TABLE users ADD COLUMN phonetic_name TEXT");
    handle = db;
    return db;
  })();
  try {
    return await opening;
  } finally {
    opening = null;
  }
}

/** The open database. The SQLite providers call this per query. */
export function getDb() {
  if (!handle) throw new Error("The SQLite database is not open; call openDb() first.");
  return handle;
}

export const nowIso = () => new Date().toISOString();

/**
 * The audit trail for live calls: sessions and events are written through to
 * `reset_sessions` and `session_events`, and mirrored in memory for the console
 * and the metrics footer. Simulated sessions stay in the mirror only, and a
 * failed write is logged once rather than breaking a call. Verification codes
 * are never written (`verify_code` stays NULL).
 */
export class SqliteAudit {
  name = "sqlite";
  #mirror = new MemoryAudit();
  #persisted = new Set();
  #warned = false;

  constructor(db, { log = console.log } = {}) {
    this.db = db;
    this.log = log;
  }

  #write(fn) {
    try {
      fn();
    } catch (e) {
      if (!this.#warned) this.log(`[audit] SQLite write failed (${e.message}); the console keeps its in-memory copy`);
      this.#warned = true;
    }
  }

  reset() {
    this.#mirror.reset();
  }

  startSession(summary) {
    this.#mirror.startSession(summary);
    if (summary.simulated) return;
    this.#persisted.add(summary.id);
    const at = nowIso();
    this.#write(() =>
      this.db
        .prepare(
          `INSERT INTO reset_sessions (id, user_id, state, attempts, created_at, updated_at)
           VALUES (?, ?, ?, 0, ?, ?)`,
        )
        .run(summary.id, summary.userId, summary.state ?? "awaiting_call", at, at),
    );
  }

  updateSession(id, patch) {
    this.#mirror.updateSession(id, patch);
    if (!this.#persisted.has(id)) return;
    const row = this.#mirror.sessions.get(id);
    this.#write(() =>
      this.db
        .prepare(`UPDATE reset_sessions SET state = ?, attempts = ?, call_id = ?, outcome = ?, updated_at = ? WHERE id = ?`)
        .run(row.state ?? "unknown", row.attempts ?? 0, row.callConnectionId ?? null, row.outcome ?? null, nowIso(), id),
    );
  }

  recordEvent(sessionId, event) {
    const recorded = this.#mirror.recordEvent(sessionId, event);
    if (this.#persisted.has(sessionId)) {
      this.#write(() =>
        this.db
          .prepare(`INSERT INTO session_events (session_id, source, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(sessionId, recorded.source, recorded.kind, recorded.detail, recorded.at),
      );
    }
    return recorded;
  }

  eventsFor(sessionId) {
    return this.#mirror.eventsFor(sessionId);
  }

  stats() {
    return this.#mirror.stats();
  }
}
