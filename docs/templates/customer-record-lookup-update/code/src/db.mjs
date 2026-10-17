/**
 * The CRM in SQLite (better-sqlite3), seeded from config/crm-seed.json on first
 * run. CRM_ADAPTER=sqlite, the default, keeps records between restarts; the
 * unit tests and the smoke run use the in-memory twin in crm-memory.mjs. Both
 * adapters phrase records through crm-shared.mjs, so a caller hears the same
 * words from either.
 */
import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config, resolvePath } from "./config.mjs";
import {
  CONTACT_COLUMNS,
  OPPORTUNITY_COLUMNS,
  buildBriefing,
  canSee,
  contactInfoPhrase,
  contactPhrase,
  maskContact,
  matchAccounts,
  opportunityPhrase,
  parseStored,
  taskPhrase,
  todayIn,
  valueString,
} from "./crm-shared.mjs";

export class SqliteCrmAdapter {
  name = "sqlite";

  constructor({ path = config.crm.dbPath, seedPath = config.crm.seedPath, now = Date.now, timeZone = "UTC" } = {}) {
    this.path = path;
    this.seedPath = seedPath;
    this.now = now;
    this.timeZone = timeZone;
    if (path !== ":memory:") mkdirSync(dirname(resolvePath(path)), { recursive: true });
    this.db = new Database(path === ":memory:" ? path : resolvePath(path));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    if (this.counts().accounts === 0) this.reset();
  }

  today() {
    return todayIn(this.now(), this.timeZone);
  }

  #stamp() {
    return new Date(this.now()).toISOString();
  }

  reset() {
    const seed = JSON.parse(readFileSync(resolvePath(this.seedPath), "utf8"));
    const tx = this.db.transaction(() => {
      this.db.exec(`DELETE FROM audit_fields; DELETE FROM commits; DELETE FROM drafts; DELETE FROM tasks; DELETE FROM activities; DELETE FROM opportunities; DELETE FROM contacts; DELETE FROM accounts;`);
      const account = this.db.prepare(`INSERT INTO accounts (id,name,aliases,phonetic_key,city,tier,owner_id,team_owner_ids,key_contact_id) VALUES (@id,@name,@aliases,@phoneticKey,@city,@tier,@ownerId,@teamOwnerIds,@keyContactId)`);
      for (const a of seed.accounts ?? []) account.run({ ...a, aliases: JSON.stringify(a.aliases ?? []), teamOwnerIds: JSON.stringify(a.teamOwnerIds ?? []) });
      const contact = this.db.prepare(`INSERT INTO contacts (id,account_id,name,title,phone,email,is_key) VALUES (@id,@accountId,@name,@title,@phone,@email,@isKey)`);
      for (const c of seed.contacts ?? []) contact.run({ ...c, isKey: c.isKey ? 1 : 0 });
      const opp = this.db.prepare(`INSERT INTO opportunities (id,account_id,name,aliases,stage,amount,close_date,next_step,is_open) VALUES (@id,@accountId,@name,@aliases,@stage,@amount,@closeDate,@nextStep,@isOpen)`);
      for (const o of seed.opportunities ?? []) opp.run({ ...o, aliases: JSON.stringify(o.aliases ?? []), isOpen: o.isOpen ? 1 : 0 });
      const act = this.db.prepare(`INSERT INTO activities (id,account_id,type,subject,notes,date,contact_ids,created_by,tags) VALUES (@id,@accountId,@type,@subject,@notes,@date,@contactIds,@createdBy,@tags)`);
      for (const a of seed.activities ?? []) act.run({ ...a, contactIds: JSON.stringify(a.contactIds ?? []), tags: JSON.stringify(a.tags ?? []) });
      const task = this.db.prepare(`INSERT INTO tasks (id,account_id,subject,due_date,owner_id,status) VALUES (@id,@accountId,@subject,@dueDate,@ownerId,@status)`);
      for (const t of seed.tasks ?? []) task.run(t);
      const draft = this.db.prepare(`INSERT INTO drafts (id,account_id,owner_id,proposal_json,summary,created_at) VALUES (@id,@accountId,@ownerId,@proposalJson,@summary,@createdAt)`);
      for (const d of seed.drafts ?? []) draft.run({ ...d, proposalJson: JSON.stringify(d.proposal ?? {}), createdAt: d.createdAt ?? this.#stamp() });
    });
    tx();
    return this.counts();
  }

  counts() {
    const one = (table) => this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    return { accounts: one("accounts"), contacts: one("contacts"), opportunities: one("opportunities"), activities: one("activities"), tasks: one("tasks"), drafts: one("drafts") };
  }

  accountById(id) {
    return inflateAccount(this.db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id)) ?? null;
  }

  visibleAccount(rep, accountId) {
    const account = this.accountById(accountId);
    return account && canSee(rep, account) ? account : null;
  }

  findAccounts(rep, utterance) {
    return matchAccounts(this.db.prepare(`SELECT * FROM accounts`).all().map(inflateAccount), rep, utterance);
  }

  getBriefing(rep, accountId) {
    const account = this.visibleAccount(rep, accountId);
    if (!account) return { ok: false, reason: "not_found" };
    const lastActivity = rowToActivity(this.db.prepare(`SELECT * FROM activities WHERE account_id = ? ORDER BY date DESC, rowid DESC LIMIT 1`).get(accountId)) ?? null;
    const opportunities = this.db.prepare(`SELECT * FROM opportunities WHERE account_id = ? AND is_open = 1 ORDER BY close_date LIMIT 3`).all(accountId).map(inflateOpportunity);
    const today = this.today();
    const dueTasks = this.db
      .prepare(`SELECT * FROM tasks WHERE account_id = ? AND owner_id = ? AND status = 'open' AND due_date <= ? ORDER BY due_date`)
      .all(accountId, rep.ownerId, today)
      .map(rowToTask);
    return buildBriefing({ rep, account, contacts: this.contacts(accountId), lastActivity, opportunities, dueTasks, today });
  }

  getDetail(rep, handle) {
    const [kind, id] = String(handle ?? "").split(":");
    if (kind === "opportunity") {
      const opp = this.getOpportunity(rep, id);
      return opp ? { ok: true, phrase: opportunityPhrase(opp), opportunity: opp } : { ok: false, reason: "not_found" };
    }
    if (kind === "contact") {
      const contact = this.getContact(rep, id);
      return contact ? { ok: true, phrase: contactPhrase(contact), contact: maskContact(contact) } : { ok: false, reason: "not_found" };
    }
    if (kind === "task") {
      const task = rowToTask(this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id));
      if (!task || !this.visibleAccount(rep, task.accountId)) return { ok: false, reason: "not_found" };
      return { ok: true, phrase: taskPhrase(task), task };
    }
    return { ok: false, reason: "unknown_handle" };
  }

  getContact(rep, contactId) {
    const contact = rowToContact(this.db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(contactId));
    return contact && this.visibleAccount(rep, contact.accountId) ? contact : null;
  }

  getContactInfo(rep, contactId, field) {
    const contact = this.getContact(rep, contactId);
    if (!contact) return { ok: false, reason: "not_found" };
    if (!Object.hasOwn(CONTACT_COLUMNS, field)) return { ok: false, reason: "field_not_allowed" };
    return { ok: true, contactId, field, value: contact[field], phrase: contactInfoPhrase(contact, field) };
  }

  contacts(accountId) {
    return this.db.prepare(`SELECT * FROM contacts WHERE account_id = ? ORDER BY is_key DESC, name`).all(accountId).map(rowToContact);
  }

  opportunities(accountId) {
    return this.db.prepare(`SELECT * FROM opportunities WHERE account_id = ? ORDER BY close_date`).all(accountId).map(inflateOpportunity);
  }

  getOpportunity(rep, opportunityId) {
    const opp = inflateOpportunity(this.db.prepare(`SELECT * FROM opportunities WHERE id = ?`).get(opportunityId));
    return opp && this.visibleAccount(rep, opp.accountId) ? opp : null;
  }

  /** One commit, all or nothing, one audit row per field written. */
  applyChangeSet(rep, callId, proposal) {
    const account = this.visibleAccount(rep, proposal.accountId);
    if (!account) return { ok: false, reason: "not_found" };
    const commitId = randomUUID();
    const at = this.#stamp();
    const tx = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO commits (id,call_id,account_id,owner_id,summary,created_at,reverted_at) VALUES (?,?,?,?,?,?,NULL)`).run(commitId, callId, account.id, rep.ownerId, proposal.readBack ?? null, at);
      for (const u of proposal.opportunityUpdates ?? []) {
        const opp = this.getOpportunity(rep, u.id);
        if (!opp) throw new Error(`opportunity ${u.id} not visible`);
        for (const diff of u.diffs) {
          if (!Object.hasOwn(OPPORTUNITY_COLUMNS, diff.field)) throw new Error(`unsupported opportunity field ${diff.field}`);
          this.db.prepare(`UPDATE opportunities SET ${OPPORTUNITY_COLUMNS[diff.field]} = ? WHERE id = ?`).run(diff.after, u.id);
          this.#audit({ commitId, callId, rep, entity: "opportunity", recordId: u.id, field: diff.field, before: opp[diff.field], after: diff.after, operation: "update", at });
        }
      }
      for (const u of proposal.contactUpdates ?? []) {
        const contact = this.getContact(rep, u.id);
        if (!contact) throw new Error(`contact ${u.id} not visible`);
        for (const diff of u.diffs) {
          if (!Object.hasOwn(CONTACT_COLUMNS, diff.field)) throw new Error(`unsupported contact field ${diff.field}`);
          this.db.prepare(`UPDATE contacts SET ${CONTACT_COLUMNS[diff.field]} = ? WHERE id = ?`).run(diff.after, u.id);
          this.#audit({ commitId, callId, rep, entity: "contact", recordId: u.id, field: diff.field, before: contact[diff.field], after: diff.after, operation: "update", at });
        }
      }
      if (proposal.activity) {
        const a = proposal.activity;
        const id = a.id ?? randomUUID();
        this.db
          .prepare(`INSERT INTO activities (id,account_id,type,subject,notes,date,contact_ids,created_by,tags) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(id, account.id, a.type, a.subject, a.notes, a.date, JSON.stringify(a.contactIds ?? []), rep.ownerId, JSON.stringify(["Logged by voice agent", `call:${callId}`]));
        for (const [field, after] of Object.entries({ subject: a.subject, type: a.type, notes: a.notes, date: a.date, contacts: (a.contactIds ?? []).join(",") })) {
          this.#audit({ commitId, callId, rep, entity: "activity", recordId: id, field, before: null, after, operation: "create", at });
        }
      }
      if (proposal.task) {
        const t = proposal.task;
        const id = t.id ?? randomUUID();
        this.db.prepare(`INSERT INTO tasks (id,account_id,subject,due_date,owner_id,status) VALUES (?,?,?,?,?,?)`).run(id, account.id, t.subject, t.dueDate, rep.ownerId, "open");
        for (const [field, after] of Object.entries({ subject: t.subject, dueDate: t.dueDate, owner: rep.ownerId })) {
          this.#audit({ commitId, callId, rep, entity: "task", recordId: id, field, before: null, after, operation: "create", at });
        }
      }
      this.db.prepare(`DELETE FROM drafts WHERE account_id = ? AND owner_id = ?`).run(account.id, rep.ownerId);
    });
    tx();
    return { ok: true, commitId };
  }

  #audit({ commitId, callId, rep, entity, recordId, field, before, after, operation, at }) {
    this.db
      .prepare(`INSERT INTO audit_fields (commit_id,call_id,owner_id,entity,record_id,field,before_value,after_value,operation,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(commitId, callId, rep.ownerId, entity, recordId, field, valueString(before), valueString(after), operation, at);
  }

  /** Undo a commit, unless someone has changed one of its fields since. */
  revertCommit(rep, commitId) {
    const commit = this.db.prepare(`SELECT * FROM commits WHERE id = ?`).get(commitId);
    if (!commit || commit.owner_id !== rep.ownerId) return { ok: false, reason: "not_found" };
    if (commit.reverted_at) return { ok: false, reason: "already_reverted" };
    const rows = this.db.prepare(`SELECT * FROM audit_fields WHERE commit_id = ? ORDER BY id DESC`).all(commitId);
    for (const r of rows) {
      const current = valueString(this.#currentValue(r));
      if (r.operation === "update" && current !== r.after_value) return { ok: false, reason: "conflict", field: r.field, current, expected: r.after_value };
    }
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        if (r.operation === "update" && r.entity === "opportunity") {
          this.db.prepare(`UPDATE opportunities SET ${OPPORTUNITY_COLUMNS[r.field]} = ? WHERE id = ?`).run(parseStored(r.before_value), r.record_id);
        } else if (r.operation === "update" && r.entity === "contact") {
          this.db.prepare(`UPDATE contacts SET ${CONTACT_COLUMNS[r.field]} = ? WHERE id = ?`).run(r.before_value, r.record_id);
        } else if (r.operation === "create" && r.entity === "activity") {
          this.db.prepare(`DELETE FROM activities WHERE id = ?`).run(r.record_id);
        } else if (r.operation === "create" && r.entity === "task") {
          this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(r.record_id);
        }
      }
      this.db.prepare(`UPDATE commits SET reverted_at = ? WHERE id = ?`).run(this.#stamp(), commitId);
    });
    tx();
    return { ok: true, commitId };
  }

  #currentValue(row) {
    const [table, columns] = row.entity === "opportunity" ? ["opportunities", OPPORTUNITY_COLUMNS] : row.entity === "contact" ? ["contacts", CONTACT_COLUMNS] : [];
    if (!table) return row.after_value;
    if (!Object.hasOwn(columns, row.field)) return undefined;
    return this.db.prepare(`SELECT ${columns[row.field]} AS value FROM ${table} WHERE id = ?`).get(row.record_id)?.value;
  }

  /** A change made outside the agent, as a colleague editing the CRM would. Tests use it for conflicts. */
  editRecord(entity, id, field, value) {
    const [table, columns] = entity === "opportunity" ? ["opportunities", OPPORTUNITY_COLUMNS] : entity === "contact" ? ["contacts", CONTACT_COLUMNS] : [];
    if (!table || !Object.hasOwn(columns, field)) return { ok: false, reason: "not_found" };
    const { changes } = this.db.prepare(`UPDATE ${table} SET ${columns[field]} = ? WHERE id = ?`).run(value, id);
    return changes ? { ok: true } : { ok: false, reason: "not_found" };
  }

  saveDraft(rep, proposal) {
    if (!proposal?.accountId) return { ok: false, reason: "no_proposal" };
    const account = this.visibleAccount(rep, proposal.accountId);
    if (!account) return { ok: false, reason: "not_found" };
    const id = randomUUID();
    this.db.prepare(`DELETE FROM drafts WHERE account_id = ? AND owner_id = ?`).run(account.id, rep.ownerId);
    this.db.prepare(`INSERT INTO drafts (id,account_id,owner_id,proposal_json,summary,created_at) VALUES (?,?,?,?,?,?)`).run(id, account.id, rep.ownerId, JSON.stringify(proposal), proposal.readBack ?? "Voice update draft", this.#stamp());
    return { ok: true, draftId: id, accountName: account.name };
  }

  resumeDraft(rep, accountId = null) {
    const row = accountId
      ? this.db.prepare(`SELECT * FROM drafts WHERE owner_id = ? AND account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(rep.ownerId, accountId)
      : this.db.prepare(`SELECT * FROM drafts WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(rep.ownerId);
    if (!row) return { ok: false, reason: "no_draft" };
    const account = this.visibleAccount(rep, row.account_id);
    if (!account) return { ok: false, reason: "not_found" };
    return { ok: true, draftId: row.id, account, proposal: JSON.parse(row.proposal_json), summary: row.summary };
  }

  latestDraftHint(rep) {
    const row = this.db.prepare(`SELECT d.*, a.name FROM drafts d JOIN accounts a ON a.id = d.account_id WHERE d.owner_id = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1`).get(rep.ownerId);
    return row ? { draftId: row.id, accountId: row.account_id, accountName: row.name, summary: row.summary } : null;
  }

  auditRows(commitId = null) {
    const sql = `SELECT * FROM audit_fields${commitId ? " WHERE commit_id = ?" : ""} ORDER BY id`;
    return commitId ? this.db.prepare(sql).all(commitId) : this.db.prepare(sql).all();
  }

  fieldsWrittenByEntity() {
    const rows = this.db.prepare(`SELECT entity, COUNT(*) AS n FROM audit_fields GROUP BY entity`).all();
    return Object.fromEntries(rows.map((r) => [r.entity, r.n]));
  }

  committedActivityCount() {
    return this.db.prepare(`SELECT COUNT(DISTINCT commit_id) AS n FROM audit_fields WHERE entity = 'activity'`).get().n;
  }

  close() {
    this.db.close();
  }
}

function inflateAccount(row) {
  return row && { id: row.id, name: row.name, aliases: JSON.parse(row.aliases ?? "[]"), phoneticKey: row.phonetic_key, city: row.city, tier: row.tier, ownerId: row.owner_id, teamOwnerIds: JSON.parse(row.team_owner_ids ?? "[]"), keyContactId: row.key_contact_id };
}

function inflateOpportunity(row) {
  return row && { id: row.id, accountId: row.account_id, name: row.name, aliases: JSON.parse(row.aliases ?? "[]"), stage: row.stage, amount: row.amount, closeDate: row.close_date, nextStep: row.next_step, isOpen: Boolean(row.is_open) };
}

function rowToContact(row) {
  return row && { id: row.id, accountId: row.account_id, name: row.name, title: row.title, phone: row.phone, email: row.email, isKey: Boolean(row.is_key) };
}

function rowToActivity(row) {
  return row && { id: row.id, accountId: row.account_id, type: row.type, subject: row.subject, notes: row.notes, date: row.date, contactIds: JSON.parse(row.contact_ids ?? "[]"), createdBy: row.created_by, tags: JSON.parse(row.tags ?? "[]") };
}

function rowToTask(row) {
  return row && { id: row.id, accountId: row.account_id, subject: row.subject, dueDate: row.due_date, ownerId: row.owner_id, status: row.status };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, aliases TEXT NOT NULL, phonetic_key TEXT, city TEXT, tier TEXT, owner_id TEXT NOT NULL, team_owner_ids TEXT NOT NULL, key_contact_id TEXT);
CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, title TEXT, phone TEXT, email TEXT, is_key INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS opportunities (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, aliases TEXT NOT NULL, stage TEXT NOT NULL, amount REAL NOT NULL, close_date TEXT NOT NULL, next_step TEXT, is_open INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS activities (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, type TEXT NOT NULL, subject TEXT NOT NULL, notes TEXT, date TEXT NOT NULL, contact_ids TEXT NOT NULL, created_by TEXT NOT NULL, tags TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, subject TEXT NOT NULL, due_date TEXT NOT NULL, owner_id TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, owner_id TEXT NOT NULL, proposal_json TEXT NOT NULL, summary TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS commits (id TEXT PRIMARY KEY, call_id TEXT NOT NULL, account_id TEXT NOT NULL, owner_id TEXT NOT NULL, summary TEXT, created_at TEXT NOT NULL, reverted_at TEXT);
CREATE TABLE IF NOT EXISTS audit_fields (id INTEGER PRIMARY KEY AUTOINCREMENT, commit_id TEXT NOT NULL, call_id TEXT NOT NULL, owner_id TEXT NOT NULL, entity TEXT NOT NULL, record_id TEXT NOT NULL, field TEXT NOT NULL, before_value TEXT, after_value TEXT, operation TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);
CREATE INDEX IF NOT EXISTS idx_opps_account ON opportunities(account_id);
CREATE INDEX IF NOT EXISTS idx_audit_commit ON audit_fields(commit_id);
`;
