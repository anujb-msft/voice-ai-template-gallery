import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.mjs";
import { readJson } from "../util.mjs";
import { MemoryTicketAdapter } from "./tickets.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (number TEXT PRIMARY KEY, kind TEXT, requester TEXT, category TEXT, priority TEXT, summary TEXT, asset TEXT, parent_incident TEXT, status TEXT, last_update TEXT);
CREATE TABLE IF NOT EXISTS hr_cases (number TEXT PRIMARY KEY, requester TEXT, callback INTEGER, consent_share_name INTEGER, summary TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS incident_affected (parent_incident TEXT, requester TEXT, simulated INTEGER DEFAULT 0, UNIQUE (parent_incident, requester));
`;

const INSERT_TICKET = `INSERT INTO tickets (number, kind, requester, category, priority, summary, asset, parent_incident, status, last_update, simulated)
  VALUES (@number, @kind, @requester, @category, @priority, @summary, @asset, @parentIncident, @status, @lastUpdate, @simulated)`;

/**
 * A write-through cache: rows are loaded once at start, every change is
 * written straight to SQLite, and reads come from memory.
 */
export class SqliteTicketAdapter extends MemoryTicketAdapter {
  name = "sqlite";

  constructor(path = config.dbPath, seed = readJson(config.paths.itsmSeed)) {
    const db = open(path, seed);
    super(load(db));
    this.db = db;
  }

  createTicket(input) {
    const ticket = super.createTicket(input);
    this.db.prepare(INSERT_TICKET).run(ticketRow(ticket));
    return ticket;
  }

  attachToIncident(input) {
    const result = super.attachToIncident(input);
    this.db.prepare(`INSERT OR IGNORE INTO incident_affected (parent_incident, requester, simulated) VALUES (?, ?, ?)`)
      .run(result.parentIncident, result.requester, result.simulated ? 1 : 0);
    return result;
  }

  createHrCase(input) {
    const c = super.createHrCase(input);
    this.db.prepare(`INSERT INTO hr_cases (number, requester, callback, consent_share_name, summary, status, simulated) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(c.number, c.requester, c.callback ? 1 : 0, c.consentShareName ? 1 : 0, c.summary, c.status, c.simulated ? 1 : 0);
    return c;
  }

  reset() {
    this.db.exec(`DELETE FROM tickets WHERE simulated = 1; DELETE FROM hr_cases WHERE simulated = 1; DELETE FROM incident_affected WHERE simulated = 1;`);
    super.reset();
  }
}

function open(path, seed) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(SCHEMA);
  for (const table of ["tickets", "hr_cases"]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!columns.includes("simulated")) db.exec(`ALTER TABLE ${table} ADD COLUMN simulated INTEGER DEFAULT 0`);
  }
  if (db.prepare(`SELECT COUNT(*) AS n FROM tickets`).get().n === 0) {
    const insert = db.prepare(INSERT_TICKET);
    for (const t of seed.tickets ?? []) insert.run(ticketRow({ ...t, simulated: false }));
  }
  return db;
}

function load(db) {
  return {
    tickets: db.prepare(`SELECT * FROM tickets ORDER BY number`).all().map((r) => ({
      number: r.number, kind: r.kind, requester: r.requester, category: r.category, priority: r.priority, summary: r.summary,
      asset: r.asset ? JSON.parse(r.asset) : null, parentIncident: r.parent_incident ?? null, status: r.status, lastUpdate: r.last_update,
      simulated: Boolean(r.simulated),
    })),
    hrCases: db.prepare(`SELECT * FROM hr_cases ORDER BY number`).all().map((r) => ({
      number: r.number, requester: r.requester, callback: Boolean(r.callback), consentShareName: Boolean(r.consent_share_name),
      summary: r.summary, status: r.status, simulated: Boolean(r.simulated),
    })),
    affected: db.prepare(`SELECT * FROM incident_affected`).all().map((r) => ({
      parentIncident: r.parent_incident, requester: r.requester, simulated: Boolean(r.simulated),
    })),
  };
}

function ticketRow(t) {
  return {
    number: t.number, kind: t.kind ?? "incident", requester: t.requester, category: t.category ?? null, priority: t.priority ?? null,
    summary: t.summary ?? null, asset: t.asset ? JSON.stringify(t.asset) : null, parentIncident: t.parentIncident ?? null,
    status: t.status ?? "New", lastUpdate: t.lastUpdate ?? null, simulated: t.simulated ? 1 : 0,
  };
}
