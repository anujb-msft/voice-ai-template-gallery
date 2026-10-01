import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.mjs";
import { readJson } from "../util.mjs";

export class MemoryTicketAdapter {
  constructor(seed = readJson(config.paths.itsmSeed)) {
    this.tickets = seed.tickets.map((t) => ({ ...t }));
    this.hrCases = seed.hrCases.map((c) => ({ ...c }));
    this.nextIncident = 4821;
    this.nextRequest = 2100;
    this.nextHrCase = 800;
  }
  createTicket({ kind = "incident", requester, category, priority, summary, asset = null, parentIncident = null }) {
    const prefix = kind === "request" ? "REQ" : "INC";
    const n = prefix === "INC" ? this.nextIncident++ : this.nextRequest++;
    const number = `${prefix}-${String(n).padStart(6, "0")}`;
    const ticket = { number, kind, requester, category, priority, summary, asset, parentIncident, status: "New", lastUpdate: "Created by the IT/HR triage demo." };
    this.tickets.push(ticket);
    return ticket;
  }
  attachToIncident({ requester, parentIncident, summary }) { return this.createTicket({ requester, category: "Major Incident", priority: "P1", summary, parentIncident }); }
  getMyTickets(requester) { return this.tickets.filter((t) => t.requester === requester); }
  createHrCase({ requester, callback = false, consentShareName = false }) { const number = `HRC-${String(this.nextHrCase++).padStart(6, "0")}`; const c = { number, requester, callback, consentShareName, summary: "Confidential HR", status: "Restricted" }; this.hrCases.push(c); return c; }
  stats() { const tally = (field) => this.tickets.reduce((a,t)=>{ const k=t[field]??"none"; a[k]=(a[k]??0)+1; return a; },{}); return { byCategory: tally("category"), byPriority: tally("priority") }; }
}

export class SqliteTicketAdapter extends MemoryTicketAdapter {
  constructor(path = config.dbPath, seed = readJson(config.paths.itsmSeed)) {
    super({ tickets: [], hrCases: [] });
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(SCHEMA);
    if (this.db.prepare(`SELECT COUNT(*) n FROM tickets`).get().n === 0) {
      const ins = this.db.prepare(`INSERT INTO tickets (number, kind, requester, category, priority, summary, asset, parent_incident, status, last_update) VALUES (@number,@kind,@requester,@category,@priority,@summary,@asset,@parentIncident,@status,@lastUpdate)`);
      for (const t of seed.tickets) ins.run({ ...t, asset: t.asset ? JSON.stringify(t.asset) : null, parentIncident: t.parentIncident ?? null });
    }
  }
  createTicket(input) { const t = super.createTicket(input); this.db.prepare(`INSERT INTO tickets (number, kind, requester, category, priority, summary, asset, parent_incident, status, last_update) VALUES (@number,@kind,@requester,@category,@priority,@summary,@asset,@parentIncident,@status,@lastUpdate)`).run({ ...t, asset: t.asset ? JSON.stringify(t.asset) : null, parentIncident: t.parentIncident ?? null }); return t; }
  getMyTickets(requester) { return this.db.prepare(`SELECT number, kind, requester, category, priority, summary, status, last_update AS lastUpdate FROM tickets WHERE requester=? ORDER BY number`).all(requester); }
  createHrCase(input) { const c = super.createHrCase(input); this.db.prepare(`INSERT INTO hr_cases (number, requester, callback, consent_share_name, summary, status) VALUES (@number,@requester,@callback,@consentShareName,@summary,@status)`).run({ ...c, callback: c.callback ? 1 : 0, consentShareName: c.consentShareName ? 1 : 0 }); return c; }
  stats() { const tally = (field) => Object.fromEntries(this.db.prepare(`SELECT COALESCE(${field},'none') k, COUNT(*) n FROM tickets GROUP BY k`).all().map(r=>[r.k,r.n])); return { byCategory: tally("category"), byPriority: tally("priority") }; }
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (number TEXT PRIMARY KEY, kind TEXT, requester TEXT, category TEXT, priority TEXT, summary TEXT, asset TEXT, parent_incident TEXT, status TEXT, last_update TEXT);
CREATE TABLE IF NOT EXISTS hr_cases (number TEXT PRIMARY KEY, requester TEXT, callback INTEGER, consent_share_name INTEGER, summary TEXT, status TEXT);
`;
