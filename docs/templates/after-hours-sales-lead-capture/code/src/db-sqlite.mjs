// Durable lead store on better-sqlite3. server.mjs imports this lazily and
// falls back to the in-memory store when the native module can't load, so the
// tests and the policy layers never depend on it.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.mjs";
import { resolvePath } from "./policy.mjs";
import { MemoryLeadStore } from "./db.mjs";

const SIMULATED_CALLS = "SELECT id FROM calls WHERE simulated = 1";
const SIMULATED_LEADS = `SELECT id FROM leads WHERE json_extract(json, '$.simulated') = 1 OR json_extract(json, '$.callId') IN (${SIMULATED_CALLS})`;

export class SqliteLeadStore extends MemoryLeadStore {
  name = "sqlite";

  constructor(opts = {}, path = config.dbPath) {
    super(opts);
    this.path = path === ":memory:" ? path : resolvePath(path);
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.#ensureColumn("calls", "page", "TEXT");
    this.sql = this.#prepare();
    this.#load();
  }

  startCall(call) {
    super.startCall(call);
    this.sql.callInsert.run({
      id: call.id,
      state: call.state,
      maskedPhone: call.maskedPhone ?? null,
      startedAt: call.startedAt,
      simulated: call.simulated ? 1 : 0,
    });
  }

  updateCall(id, patch) {
    super.updateCall(id, patch);
    const c = this.calls.get(id);
    if (!c) return;
    this.sql.callUpdate.run({
      id,
      state: c.state,
      outcome: c.outcome ?? null,
      endedAt: c.endedAt ?? null,
      durationMs: c.durationMs ?? null,
      page: c.page ?? null,
    });
  }

  recordEvent(callId, source, kind, detail = null) {
    this.sql.event.run(callId, source, kind, detail == null ? null : String(detail), this.now().toISOString());
  }

  recordTranscript(callId, role, text) {
    if (!config.persistTranscripts) return;
    this.sql.transcript.run(callId, role, text, this.now().toISOString());
  }

  eventsFor(callId) {
    return this.sql.eventsFor.all(callId).map((row) => ({ callId, ...row }));
  }

  saveLead(fields, ctx = {}) {
    return this.db.transaction(() => super.saveLead(fields, ctx))();
  }

  persistLead(lead) {
    this.sql.lead.run({
      id: lead.id,
      json: JSON.stringify(lead),
      score: lead.score,
      ownerId: lead.owner?.id ?? null,
      createdAt: lead.createdAt,
      contactedAt: lead.contactedAt ?? null,
      metSla: lead.metSla == null ? null : Number(lead.metSla),
    });
  }

  persistOutbox(entry) {
    this.sql.outbox.run({
      id: entry.id,
      leadId: entry.leadId,
      channel: entry.channel,
      status: entry.status,
      json: JSON.stringify(entry),
      createdAt: entry.createdAt,
    });
  }

  persistNonSales(record) {
    this.sql.nonSales.run({
      id: record.id,
      callId: record.callId,
      kind: record.kind,
      note: record.note ?? null,
      createdAt: record.createdAt,
    });
  }

  persistPointers() {
    this.sql.kvSet.run("rep_pointer", String(this.pointer));
    this.sql.kvSet.run("sim_rep_pointer", String(this.simulatedPointer));
  }

  resetSimulated() {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM outbox WHERE json_extract(json, '$.simulated') = 1 OR lead_id IN (${SIMULATED_LEADS})`).run();
      this.db.prepare(`DELETE FROM leads WHERE id IN (${SIMULATED_LEADS})`).run();
      this.db.prepare(`DELETE FROM non_sales WHERE call_id IN (${SIMULATED_CALLS})`).run();
      this.db.prepare(`DELETE FROM call_events WHERE call_id IN (${SIMULATED_CALLS})`).run();
      this.db.prepare(`DELETE FROM transcripts WHERE call_id IN (${SIMULATED_CALLS})`).run();
      this.db.prepare("DELETE FROM calls WHERE simulated = 1").run();
    })();
    return super.resetSimulated();
  }

  close() {
    this.db.close();
  }

  #ensureColumn(table, column, type) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  #prepare() {
    const db = this.db;
    return {
      kvGet: db.prepare("SELECT value FROM kv WHERE key = ?"),
      kvSet: db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)"),
      callInsert: db.prepare("INSERT OR REPLACE INTO calls (id, state, masked_phone, started_at, simulated) VALUES (@id, @state, @maskedPhone, @startedAt, @simulated)"),
      callUpdate: db.prepare("UPDATE calls SET state = @state, outcome = @outcome, ended_at = @endedAt, duration_ms = @durationMs, page = @page WHERE id = @id"),
      event: db.prepare("INSERT INTO call_events (call_id, source, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)"),
      eventsFor: db.prepare("SELECT source, kind, detail, created_at FROM call_events WHERE call_id = ? ORDER BY id"),
      transcript: db.prepare("INSERT INTO transcripts (call_id, role, text, created_at) VALUES (?, ?, ?, ?)"),
      lead: db.prepare("INSERT OR REPLACE INTO leads (id, json, score, owner_id, created_at, contacted_at, met_sla) VALUES (@id, @json, @score, @ownerId, @createdAt, @contactedAt, @metSla)"),
      outbox: db.prepare("INSERT OR REPLACE INTO outbox (id, lead_id, channel, status, json, created_at) VALUES (@id, @leadId, @channel, @status, @json, @createdAt)"),
      nonSales: db.prepare("INSERT OR REPLACE INTO non_sales (id, call_id, kind, note, created_at) VALUES (@id, @callId, @kind, @note, @createdAt)"),
    };
  }

  // Loads earlier runs, so the round-robin, leads and outbox survive a restart.
  #load() {
    this.pointer = Number(this.sql.kvGet.get("rep_pointer")?.value ?? 0) || 0;
    this.simulatedPointer = Number(this.sql.kvGet.get("sim_rep_pointer")?.value ?? 0) || 0;
    for (const row of this.db.prepare("SELECT id, state, masked_phone, started_at, ended_at, outcome, duration_ms, simulated, page FROM calls").all()) {
      this.calls.set(row.id, {
        id: row.id,
        state: row.state,
        maskedPhone: row.masked_phone,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        outcome: row.outcome,
        durationMs: row.duration_ms,
        simulated: Boolean(row.simulated),
        page: row.page ?? null,
      });
    }
    for (const row of this.db.prepare("SELECT json FROM leads ORDER BY created_at").all()) {
      const lead = JSON.parse(row.json);
      if (lead.simulated === undefined) lead.simulated = Boolean(this.calls.get(lead.callId)?.simulated);
      this.leads.set(lead.id, lead);
    }
    for (const row of this.db.prepare("SELECT json FROM outbox ORDER BY created_at").all()) {
      const entry = JSON.parse(row.json);
      if (entry.simulated === undefined) entry.simulated = Boolean(this.leads.get(entry.leadId)?.simulated);
      this.outbox.push(entry);
    }
    const nonSales = this.db.prepare("SELECT n.id, n.call_id, n.kind, n.note, n.created_at, c.simulated FROM non_sales n LEFT JOIN calls c ON c.id = n.call_id ORDER BY n.created_at").all();
    for (const row of nonSales) {
      this.nonSales.push({ id: row.id, callId: row.call_id, kind: row.kind, note: row.note, simulated: Boolean(row.simulated), createdAt: row.created_at });
    }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, state TEXT NOT NULL, masked_phone TEXT, started_at TEXT NOT NULL, ended_at TEXT, outcome TEXT, duration_ms INTEGER, simulated INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS call_events (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS transcripts (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, json TEXT NOT NULL, score TEXT NOT NULL, owner_id TEXT, created_at TEXT NOT NULL, contacted_at TEXT, met_sla INTEGER);
CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS non_sales (id TEXT PRIMARY KEY, call_id TEXT NOT NULL, kind TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_events_call ON call_events(call_id);
CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);
`;
