import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.mjs";
import { normaliseEmail, normalisePhone } from "./policy.mjs";

export class MemoryLeadStore {
  name = "memory";
  constructor({ reps, qualification, hours, dedupeWindowDays = config.dedupeWindowDays, now = () => new Date() } = {}) {
    this.reps = reps; this.qualification = qualification; this.hours = hours; this.dedupeWindowDays = dedupeWindowDays; this.now = now;
    this.calls = new Map(); this.events = []; this.transcripts = []; this.leads = new Map(); this.outbox = []; this.pointer = 0; this.nonSales = [];
  }
  startCall(call) { this.calls.set(call.id, { ...call }); }
  updateCall(id, patch) { const c = this.calls.get(id); if (c) this.calls.set(id, { ...c, ...patch }); }
  recordEvent(callId, source, kind, detail = null) { this.events.push({ callId, source, kind, detail: detail == null ? null : String(detail), created_at: this.now().toISOString() }); }
  recordTranscript(callId, role, text) { if (config.persistTranscripts) this.transcripts.push({ callId, role, text, created_at: this.now().toISOString() }); }
  eventsFor(callId) { return this.events.filter((e) => e.callId === callId); }
  outboxBacklog() { return this.outbox.filter((m) => ["pending", "failed"].includes(m.status)).length; }
  listLeads() { return [...this.leads.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)); }
  listOutbox() { return [...this.outbox]; }
  saveNonSales({ callId, kind, note }) { this.nonSales.push({ id: randomUUID(), callId, kind, note, createdAt: this.now().toISOString() }); return { ok: true }; }
  saveLead(fields, { callId, partial = false } = {}) {
    const normalizedPhone = normalisePhone(fields.callbackPhone);
    const normalizedEmail = normaliseEmail(fields.email);
    if (!normalizedPhone && !normalizedEmail) return { ok: false, reason: "contact_required" };
    const now = this.now();
    const duplicate = this.#findDuplicate(normalizedPhone, normalizedEmail, now);
    const scored = this.qualification.score(fields);
    const note = makeNote(fields, partial, duplicate);
    let lead;
    if (duplicate) {
      lead = { ...duplicate, notes: [...duplicate.notes, note], duplicateCount: (duplicate.duplicateCount ?? 0) + 1, updatedAt: now.toISOString() };
      this.leads.set(lead.id, lead);
    } else {
      const owner = this.#nextRep();
      lead = {
        id: `lead-${randomUUID().slice(0, 8)}`, callId, type: "sales", name: fields.name ?? null, company: fields.company ?? null,
        normalizedPhone, normalizedEmail, productInterest: fields.productInterest ?? null, productLine: scored.productLine,
        quantity: fields.quantity ? Number(fields.quantity) : null, timeline: fields.timeline ?? null, role: fields.role ?? null,
        location: fields.location ?? null, notes: [note], partial: Boolean(partial), score: scored.score, points: scored.points,
        scoreBreakdown: scored.breakdown, owner, slaDueAt: this.#slaDueAt(scored.score, now).toISOString(), contactedAt: null,
        createdAt: now.toISOString(), updatedAt: now.toISOString(), duplicateCount: 0,
      };
      this.leads.set(lead.id, lead);
      this.#enqueueNotifications(lead);
    }
    return { ok: true, lead, duplicateOf: duplicate?.id ?? null, slaPhrase: slaPhrase(scored.score) };
  }
  markContacted(leadId, at = this.now()) { const lead = this.leads.get(leadId); if (!lead) return null; lead.contactedAt = at.toISOString(); lead.metSla = at <= new Date(lead.slaDueAt); this.leads.set(leadId, lead); return lead; }
  #findDuplicate(phone, email, now) { const cutoff = now.getTime() - this.dedupeWindowDays * 86400000; return [...this.leads.values()].find((l) => new Date(l.createdAt).getTime() >= cutoff && ((phone && l.normalizedPhone === phone) || (email && l.normalizedEmail === email))) ?? null; }
  #nextRep() { const active = this.reps.activeReps(); if (!active.length) throw new Error("no active reps"); const rep = active[this.pointer % active.length]; this.pointer = (this.pointer + 1) % active.length; return rep; }
  #slaDueAt(score, now) { const h = score === "hot" ? 1 : score === "warm" ? 24 : 48; return new Date(now.getTime() + h * 3600000); }
  #enqueueNotifications(lead) {
    const managerMention = lead.score === "hot" ? this.reps.manager : null;
    this.outbox.push({ id: randomUUID(), leadId: lead.id, channel: "teams", status: "pending", to: lead.owner.teamsUserId, mentionManager: Boolean(managerMention), managerTeamsUserId: managerMention?.teamsUserId ?? null, body: notificationSummary(lead), createdAt: this.now().toISOString() });
    this.outbox.push({ id: randomUUID(), leadId: lead.id, channel: "email", status: "pending", to: lead.owner.email, body: notificationSummary(lead), createdAt: this.now().toISOString() });
  }
  failOutbox(id, reason = "delivery failed") { const m = this.outbox.find((x)=>x.id===id); if (m) { m.status="failed"; m.error=reason; } return m; }
  stats() { return computeStats([...this.calls.values()], this.listLeads(), this.nonSales, this.outbox); }
}

export class SqliteLeadStore extends MemoryLeadStore {
  name = "sqlite";
  constructor(opts = {}, path = config.dbPath) { super(opts); this.path = path; mkdirSync(dirname(path), { recursive: true }); this.db = new Database(path); this.db.pragma("journal_mode = WAL"); this.db.exec(SCHEMA); this.#loadPointer(); }
  #loadPointer() { const row = this.db.prepare("SELECT value FROM kv WHERE key = 'rep_pointer'").get(); this.pointer = row ? Number(row.value) : 0; }
  #savePointer() { this.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('rep_pointer', ?)").run(String(this.pointer)); }
  startCall(call) { super.startCall(call); this.db.prepare(`INSERT OR REPLACE INTO calls (id, state, masked_phone, started_at, simulated) VALUES (@id, @state, @maskedPhone, @startedAt, @simulated)`).run({ id: call.id, state: call.state, maskedPhone: call.maskedPhone ?? null, startedAt: call.startedAt, simulated: call.simulated ? 1 : 0 }); }
  updateCall(id, patch) { super.updateCall(id, patch); const c=this.calls.get(id); if (!c) return; this.db.prepare(`UPDATE calls SET state=@state, outcome=@outcome, ended_at=@endedAt, duration_ms=@durationMs WHERE id=@id`).run({ id, state:c.state, outcome:c.outcome??null, endedAt:c.endedAt??null, durationMs:c.durationMs??null }); }
  recordEvent(callId, source, kind, detail = null) { super.recordEvent(callId, source, kind, detail); this.db.prepare(`INSERT INTO call_events (call_id, source, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)`).run(callId, source, kind, detail == null ? null : String(detail), new Date().toISOString()); }
  recordTranscript(callId, role, text) { super.recordTranscript(callId, role, text); if (!config.persistTranscripts) return; this.db.prepare(`INSERT INTO transcripts (call_id, role, text, created_at) VALUES (?, ?, ?, ?)`).run(callId, role, text, new Date().toISOString()); }
  eventsFor(callId) { return this.db.prepare(`SELECT source, kind, detail, created_at FROM call_events WHERE call_id = ? ORDER BY id`).all(callId); }
  saveNonSales(input) { const r=super.saveNonSales(input); this.db.prepare(`INSERT INTO non_sales (id, call_id, kind, note, created_at) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), input.callId, input.kind, input.note ?? null, new Date().toISOString()); return r; }
  saveLead(fields, ctx = {}) { const result = super.saveLead(fields, ctx); if (!result.ok) return result; this.#persistAll(); this.#savePointer(); return result; }
  markContacted(leadId, at = new Date()) { const lead=super.markContacted(leadId, at); if (lead) this.#persistAll(); return lead; }
  failOutbox(id, reason) { const m=super.failOutbox(id, reason); if (m) this.#persistAll(); return m; }
  #persistAll() { const leadStmt=this.db.prepare(`INSERT OR REPLACE INTO leads (id, json, score, owner_id, created_at, contacted_at, met_sla) VALUES (@id, @json, @score, @ownerId, @createdAt, @contactedAt, @metSla)`); const outStmt=this.db.prepare(`INSERT OR REPLACE INTO outbox (id, lead_id, channel, status, json, created_at) VALUES (@id, @leadId, @channel, @status, @json, @createdAt)`); const tx=this.db.transaction(()=>{ for (const l of this.leads.values()) leadStmt.run({ id:l.id, json:JSON.stringify(l), score:l.score, ownerId:l.owner?.id, createdAt:l.createdAt, contactedAt:l.contactedAt, metSla:l.metSla==null?null:Number(l.metSla) }); for (const o of this.outbox) outStmt.run({ id:o.id, leadId:o.leadId, channel:o.channel, status:o.status, json:JSON.stringify(o), createdAt:o.createdAt }); }); tx(); }
  outboxBacklog() { const row=this.db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status IN ('pending','failed')`).get(); return row?.n ?? super.outboxBacklog(); }
  close() { this.db.close(); }
}

function makeNote(fields, partial, duplicate) { const bits = []; if (partial) bits.push("PARTIAL"); if (duplicate) bits.push(`Repeat contact merged into ${duplicate.id}`); if (fields.notes) bits.push(fields.notes); return bits.join(" — ") || "Captured by after-hours assistant"; }
export function slaPhrase(score) { return score === "hot" ? "within the hour" : score === "warm" ? "by the next business day" : "within two business days"; }
function notificationSummary(lead) { return `${lead.score.toUpperCase()} lead: ${lead.name ?? "Unknown"} at ${lead.company ?? "unknown company"} needs ${lead.productInterest ?? "sales follow-up"}. Contact ${lead.normalizedPhone ?? lead.normalizedEmail}.`; }
function computeStats(calls, leads, nonSales, outbox) { const tally=(items, key)=>items.reduce((a,x)=>{const k=typeof key==='function'?key(x):x[key]??'none'; a[k]=(a[k]??0)+1; return a;},{}); const contacted=leads.filter((l)=>l.contactedAt); const responseMs=contacted.map((l)=>new Date(l.contactedAt)-new Date(l.createdAt)).sort((a,b)=>a-b); const median=responseMs.length?responseMs[Math.floor(responseMs.length/2)]:null; return { calls:calls.length, leadsCaptured:leads.length, qualifiedLeadRate: leads.length ? (leads.filter((l)=>["hot","warm"].includes(l.score)).length / leads.length) : 0, leadsByScore:tally(leads,"score"), duplicatesMerged:leads.reduce((n,l)=>n+(l.duplicateCount??0),0), nonSalesByKind:tally(nonSales,"kind"), partialLeads:leads.filter((l)=>l.partial).length, medianTimeToFirstResponseMs:median, contactedWithinSlaShare: contacted.length ? contacted.filter((l)=>l.metSla).length/contacted.length : null, outboxBacklog:outbox.filter((o)=>["pending","failed"].includes(o.status)).length }; }

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
