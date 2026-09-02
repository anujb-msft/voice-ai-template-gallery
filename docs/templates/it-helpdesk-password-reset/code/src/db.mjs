import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.mjs";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
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
`);

// Lightweight migration for databases created before phonetic_name existed.
const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userCols.includes("phonetic_name")) db.exec("ALTER TABLE users ADD COLUMN phonetic_name TEXT");

export const nowIso = () => new Date().toISOString();

export function recordEvent(sessionId, source, kind, detail) {
  db.prepare(
    `INSERT INTO session_events (session_id, source, kind, detail, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, source, kind, detail == null ? null : String(detail), nowIso());
}
