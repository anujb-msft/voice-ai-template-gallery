import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config, resolvePath, todayIso } from "./config.mjs";

export class SqliteCrmAdapter {
  name = "sqlite";

  constructor({ path = config.crm.dbPath, seedPath = config.crm.seedPath } = {}) {
    this.path = path;
    this.seedPath = seedPath;
    if (path !== ":memory:") mkdirSync(dirname(resolvePath(path)), { recursive: true });
    this.db = new Database(path === ":memory:" ? path : resolvePath(path));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    if (this.counts().accounts === 0) this.reset();
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
      for (const d of seed.drafts ?? []) draft.run({ ...d, proposalJson: JSON.stringify(d.proposal ?? {}), createdAt: d.createdAt ?? new Date().toISOString() });
    });
    tx();
    return this.counts();
  }

  counts() {
    const one = (table) => this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    return { accounts: one("accounts"), contacts: one("contacts"), opportunities: one("opportunities"), activities: one("activities"), tasks: one("tasks"), drafts: one("drafts") };
  }

  accountById(id) {
    return inflateAccount(this.db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id));
  }

  visibleAccount(rep, accountId) {
    const account = this.accountById(accountId);
    return account && canSee(rep, account) ? account : null;
  }

  findAccounts(rep, utterance) {
    const q = normalise(utterance);
    const spelled = String(utterance ?? "").match(/\b(?:spelled|spell(?:ing)?)\s+([a-z](?:\s+[a-z]){2,})/i);
    const spelledText = spelled ? spelled[1].replace(/\s+/g, "") : null;
    const rows = this.db.prepare(`SELECT * FROM accounts`).all().map(inflateAccount).filter((a) => canSee(rep, a));
    const scored = rows.map((a) => ({ account: a, score: accountScore(a, spelledText ?? q) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.account.name.localeCompare(b.account.name));
    if (!scored.length) return { status: "no_match", candidates: [] };
    const top = scored[0].score;
    const close = scored.filter((s) => s.score >= Math.max(2, top - 1)).slice(0, 3);
    if ((top >= 6 && (scored[1]?.score ?? 0) <= top - 3) || (close.length === 1 && top >= 4)) {
      const a = scored[0].account;
      return { status: "confirmed", account: a, phrase: `${a.name} in ${a.city}?` };
    }
    return { status: "candidates", candidates: close.map(({ account }) => ({ id: account.id, name: account.name, city: account.city, tier: account.tier })), phrase: close.map(({ account }, i) => `${i + 1}. ${account.name} in ${account.city}, ${account.tier}`).join("; ") };
  }

  getBriefing(rep, accountId) {
    const account = this.visibleAccount(rep, accountId);
    if (!account) return { ok: false, reason: "not_found" };
    const contacts = this.contacts(accountId);
    const keyContact = contacts.find((c) => c.id === account.keyContactId) ?? contacts[0] ?? null;
    const lastActivity = this.db.prepare(`SELECT * FROM activities WHERE account_id = ? ORDER BY date DESC LIMIT 1`).get(accountId) ?? null;
    const opportunities = this.db.prepare(`SELECT * FROM opportunities WHERE account_id = ? AND is_open = 1 ORDER BY close_date LIMIT 3`).all(accountId).map(inflateOpportunity);
    const dueTasks = this.db.prepare(`SELECT * FROM tasks WHERE account_id = ? AND owner_id = ? AND status = 'open' AND due_date <= ? ORDER BY due_date`).all(accountId, rep.ownerId, todayIso()).map(rowToTask);
    const handles = [];
    for (const o of opportunities) handles.push({ handle: `opportunity:${o.id}`, type: "opportunity", id: o.id, label: o.name });
    if (keyContact) handles.push({ handle: `contact:${keyContact.id}`, type: "contact", id: keyContact.id, label: keyContact.name });
    for (const t of dueTasks) handles.push({ handle: `task:${t.id}`, type: "task", id: t.id, label: t.subject });
    const phrase = briefingPhrase(account, lastActivity, opportunities, dueTasks, keyContact, rep);
    return { ok: true, account, contacts: contacts.map(maskContact), keyContact: keyContact && maskContact(keyContact), lastActivity, opportunities, dueTasks, handles, phrase };
  }

  getDetail(rep, handle) {
    const [kind, id] = String(handle ?? "").split(":");
    if (kind === "opportunity") {
      const opp = inflateOpportunity(this.db.prepare(`SELECT * FROM opportunities WHERE id = ?`).get(id));
      if (!opp || !this.visibleAccount(rep, opp.accountId)) return { ok: false, reason: "not_found" };
      return { ok: true, phrase: `${opp.name}: ${opp.stage}, ${money(opp.amount)}, closing ${spokenDate(opp.closeDate)}. Next step: ${opp.nextStep}.`, opportunity: opp };
    }
    if (kind === "contact") {
      const c = this.db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(id);
      if (!c || !this.visibleAccount(rep, c.account_id)) return { ok: false, reason: "not_found" };
      return { ok: true, phrase: `${c.name}, ${c.title}. Say what is ${firstName(c.name)}'s number or email if you want contact details.`, contact: maskContact(rowToContact(c)) };
    }
    if (kind === "task") {
      const t = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
      if (!t || !this.visibleAccount(rep, t.account_id)) return { ok: false, reason: "not_found" };
      return { ok: true, phrase: `${t.subject}, due ${spokenDate(t.due_date)}.`, task: rowToTask(t) };
    }
    return { ok: false, reason: "unknown_handle" };
  }

  getContactInfo(rep, contactId, field) {
    const c = this.db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(contactId);
    if (!c || !this.visibleAccount(rep, c.account_id)) return { ok: false, reason: "not_found" };
    if (!new Set(["phone", "email"]).has(field)) return { ok: false, reason: "field_not_allowed" };
    return { ok: true, contactId, field, value: c[field], phrase: `${rowToContact(c).name}'s ${field} is ${c[field]}.` };
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

  applyChangeSet(rep, callId, proposal) {
    const account = this.visibleAccount(rep, proposal.accountId);
    if (!account) return { ok: false, reason: "not_found" };
    const commitId = randomUUID();
    const at = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO commits (id,call_id,account_id,owner_id,summary,created_at,reverted_at) VALUES (?,?,?,?,?,?,NULL)`).run(commitId, callId, account.id, rep.ownerId, proposal.readBack, at);
      for (const u of proposal.opportunityUpdates ?? []) {
        const opp = this.getOpportunity(rep, u.id);
        if (!opp) throw new Error(`opportunity ${u.id} not visible`);
        for (const diff of u.diffs) {
          const column = FIELD_COLUMNS[diff.field];
          if (!column) throw new Error(`unsupported opportunity field ${diff.field}`);
          const before = opp[diff.field];
          this.db.prepare(`UPDATE opportunities SET ${column} = ? WHERE id = ?`).run(diff.after, u.id);
          this.#audit({ commitId, callId, rep, entity: "opportunity", recordId: u.id, field: diff.field, before, after: diff.after, operation: "update", at });
        }
      }
      if (proposal.activity) {
        const id = proposal.activity.id ?? randomUUID();
        const a = proposal.activity;
        this.db.prepare(`INSERT INTO activities (id,account_id,type,subject,notes,date,contact_ids,created_by,tags) VALUES (?,?,?,?,?,?,?,?,?)`).run(id, account.id, a.type, a.subject, a.notes, a.date, JSON.stringify(a.contactIds ?? []), rep.ownerId, JSON.stringify(["Logged by voice agent", `call:${callId}`]));
        for (const [field, after] of Object.entries({ subject: a.subject, type: a.type, notes: a.notes, date: a.date, contacts: (a.contactIds ?? []).join(",") })) {
          this.#audit({ commitId, callId, rep, entity: "activity", recordId: id, field, before: null, after, operation: "create", at });
        }
      }
      if (proposal.task) {
        const id = proposal.task.id ?? randomUUID();
        const t = proposal.task;
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
    this.db.prepare(`INSERT INTO audit_fields (commit_id,call_id,owner_id,entity,record_id,field,before_value,after_value,operation,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(commitId, callId, rep.ownerId, entity, recordId, field, valueString(before), valueString(after), operation, at);
  }

  revertCommit(rep, commitId) {
    const commit = this.db.prepare(`SELECT * FROM commits WHERE id = ?`).get(commitId);
    if (!commit || commit.owner_id !== rep.ownerId) return { ok: false, reason: "not_found" };
    if (commit.reverted_at) return { ok: false, reason: "already_reverted" };
    const rows = this.db.prepare(`SELECT * FROM audit_fields WHERE commit_id = ? ORDER BY id DESC`).all(commitId);
    for (const r of rows) {
      const current = this.#currentValue(r);
      if (r.operation === "update" && valueString(current) !== r.after_value) {
        return { ok: false, reason: "conflict", field: r.field, current: valueString(current), expected: r.after_value };
      }
    }
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        if (r.operation === "update" && r.entity === "opportunity") {
          const column = FIELD_COLUMNS[r.field];
          this.db.prepare(`UPDATE opportunities SET ${column} = ? WHERE id = ?`).run(parseStored(r.before_value), r.record_id);
        } else if (r.operation === "create" && r.entity === "activity") {
          this.db.prepare(`DELETE FROM activities WHERE id = ?`).run(r.record_id);
        } else if (r.operation === "create" && r.entity === "task") {
          this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(r.record_id);
        }
      }
      this.db.prepare(`UPDATE commits SET reverted_at = ? WHERE id = ?`).run(new Date().toISOString(), commitId);
    });
    tx();
    return { ok: true, commitId };
  }

  #currentValue(row) {
    if (row.entity === "opportunity") {
      const column = FIELD_COLUMNS[row.field];
      const rec = column ? this.db.prepare(`SELECT ${column} AS value FROM opportunities WHERE id = ?`).get(row.record_id) : null;
      return rec?.value;
    }
    return row.after_value;
  }

  saveDraft(rep, proposal) {
    if (!proposal?.accountId) return { ok: false, reason: "no_proposal" };
    const account = this.visibleAccount(rep, proposal.accountId);
    if (!account) return { ok: false, reason: "not_found" };
    const id = randomUUID();
    this.db.prepare(`DELETE FROM drafts WHERE account_id = ? AND owner_id = ?`).run(account.id, rep.ownerId);
    this.db.prepare(`INSERT INTO drafts (id,account_id,owner_id,proposal_json,summary,created_at) VALUES (?,?,?,?,?,?)`).run(id, account.id, rep.ownerId, JSON.stringify(proposal), proposal.readBack ?? "Voice update draft", new Date().toISOString());
    return { ok: true, draftId: id, accountName: account.name };
  }

  resumeDraft(rep, accountId = null) {
    const row = accountId
      ? this.db.prepare(`SELECT * FROM drafts WHERE owner_id = ? AND account_id = ? ORDER BY created_at DESC LIMIT 1`).get(rep.ownerId, accountId)
      : this.db.prepare(`SELECT * FROM drafts WHERE owner_id = ? ORDER BY created_at DESC LIMIT 1`).get(rep.ownerId);
    if (!row) return { ok: false, reason: "no_draft" };
    const account = this.visibleAccount(rep, row.account_id);
    if (!account) return { ok: false, reason: "not_found" };
    return { ok: true, draftId: row.id, account, proposal: JSON.parse(row.proposal_json), summary: row.summary };
  }

  latestDraftHint(rep) {
    const row = this.db.prepare(`SELECT d.*, a.name FROM drafts d JOIN accounts a ON a.id = d.account_id WHERE d.owner_id = ? ORDER BY d.created_at DESC LIMIT 1`).get(rep.ownerId);
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

const FIELD_COLUMNS = { stage: "stage", amount: "amount", closeDate: "close_date", nextStep: "next_step" };

function inflateAccount(row) {
  return row && { id: row.id, name: row.name, aliases: JSON.parse(row.aliases ?? "[]"), phoneticKey: row.phonetic_key, city: row.city, tier: row.tier, ownerId: row.owner_id, teamOwnerIds: JSON.parse(row.team_owner_ids ?? "[]"), keyContactId: row.key_contact_id };
}
function inflateOpportunity(row) {
  return row && { id: row.id, accountId: row.account_id, name: row.name, aliases: JSON.parse(row.aliases ?? "[]"), stage: row.stage, amount: row.amount, closeDate: row.close_date, nextStep: row.next_step, isOpen: Boolean(row.is_open) };
}
function rowToContact(row) { return row && { id: row.id, accountId: row.account_id, name: row.name, title: row.title, phone: row.phone, email: row.email, isKey: Boolean(row.is_key) }; }
function rowToTask(row) { return row && { id: row.id, accountId: row.account_id, subject: row.subject, dueDate: row.due_date, ownerId: row.owner_id, status: row.status }; }
function canSee(rep, account) { return Boolean(rep?.ownerId && account && (account.ownerId === rep.ownerId || account.teamOwnerIds.includes(rep.ownerId))); }
function normalise(v) { return String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function accountScore(account, q) {
  const query = normalise(q);
  if (!query) return 0;
  const names = [account.name, ...(account.aliases ?? [])].map(normalise);
  if (names.some((n) => n === query)) return 8;
  if (names.some((n) => n.includes(query) || query.includes(n))) return 6;
  const tokens = query.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const n of names) for (const t of tokens) if (n.includes(t)) score += 2;
  if (account.phoneticKey && query.replace(/[^a-z]/g, "").startsWith(account.phoneticKey.toLowerCase().slice(0, 3))) score += 3;
  return score;
}
function maskContact(c) { return c && { id: c.id, accountId: c.accountId, name: c.name, title: c.title, isKey: c.isKey }; }
function firstName(name) { return String(name ?? "").split(/\s+/)[0]; }
function money(amount) { return amount >= 1000 ? `about ${Math.round(amount / 1000)} thousand` : `$${amount}`; }
function spokenDate(iso) { return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric" }); }
function briefingPhrase(account, lastActivity, opportunities, dueTasks, keyContact, rep) {
  const owner = account.ownerId === rep.ownerId ? "your account" : "an account team account";
  const parts = [`${account.name}, ${account.tier} tier, ${owner}.`];
  if (lastActivity) parts.push(`Last touch was a ${lastActivity.type} on ${spokenDate(lastActivity.date)} about ${lastActivity.subject.toLowerCase()}.`);
  if (opportunities.length) {
    const deals = opportunities.slice(0, 3).map((o) => `${o.name.toLowerCase()} at ${money(o.amount)}, in ${o.stage}, closing ${spokenDate(o.closeDate)}`);
    parts.push(`${opportunities.length} open ${opportunities.length === 1 ? "deal" : "deals"}: ${joinEnglish(deals)}.`);
  }
  if (dueTasks.length) parts.push(`${dueTasks.length === 1 ? "One task is" : `${dueTasks.length} tasks are`} due today: ${joinEnglish(dueTasks.map((t) => t.subject))}.`);
  if (keyContact) parts.push(`Your contact is ${keyContact.name}, ${keyContact.title}.`);
  return parts.join(" ");
}
function joinEnglish(items) { return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`; }
function valueString(v) { return v == null ? null : String(v); }
function parseStored(v) { return /^-?\d+(?:\.\d+)?$/.test(String(v)) ? Number(v) : v; }

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
