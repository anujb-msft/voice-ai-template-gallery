/**
 * The CRM in memory, seeded from config/crm-seed.json. The tests and the smoke
 * check run on it, and so does the demo with CRM_ADAPTER=memory or when SQLite
 * will not load: nothing to install, and reset() puts every record back exactly
 * as seeded. Same interface as the SQLite adapter in db.mjs, which reseeds the
 * same way; both phrase records through crm-shared.mjs.
 */
import { readFileSync } from "node:fs";
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

const clone = (value) => (value == null ? value : structuredClone(value));

export class MemoryCrmAdapter {
  name = "memory";

  constructor({ seedPath = config.crm.seedPath, now = Date.now, timeZone = "UTC" } = {}) {
    this.seedPath = seedPath;
    this.now = now;
    this.timeZone = timeZone;
    this.reset();
  }

  today() {
    return todayIn(this.now(), this.timeZone);
  }

  #stamp() {
    return new Date(this.now()).toISOString();
  }

  /** Put every record back exactly as seeded; drop commits, audit rows and drafts. */
  reset() {
    const seed = JSON.parse(readFileSync(resolvePath(this.seedPath), "utf8"));
    this.state = {
      accounts: (seed.accounts ?? []).map((a) => ({ aliases: [], teamOwnerIds: [], ...a })),
      contacts: (seed.contacts ?? []).map((c) => ({ ...c, isKey: Boolean(c.isKey) })),
      opportunities: (seed.opportunities ?? []).map((o) => ({ aliases: [], ...o, isOpen: Boolean(o.isOpen) })),
      activities: (seed.activities ?? []).map((a) => ({ contactIds: [], tags: [], ...a })),
      tasks: (seed.tasks ?? []).map((t) => ({ status: "open", ...t })),
      drafts: (seed.drafts ?? []).map((d) => ({ id: d.id, accountId: d.accountId, ownerId: d.ownerId, proposal: d.proposal ?? {}, summary: d.summary ?? null, createdAt: d.createdAt ?? this.#stamp() })),
      commits: [],
      audit: [],
      auditSeq: 0,
    };
    return this.counts();
  }

  counts() {
    const s = this.state;
    return { accounts: s.accounts.length, contacts: s.contacts.length, opportunities: s.opportunities.length, activities: s.activities.length, tasks: s.tasks.length, drafts: s.drafts.length };
  }

  accountById(id) {
    return clone(this.state.accounts.find((a) => a.id === id)) ?? null;
  }

  visibleAccount(rep, accountId) {
    const account = this.accountById(accountId);
    return account && canSee(rep, account) ? account : null;
  }

  findAccounts(rep, utterance) {
    return matchAccounts(this.state.accounts.map(clone), rep, utterance);
  }

  getBriefing(rep, accountId) {
    const account = this.visibleAccount(rep, accountId);
    if (!account) return { ok: false, reason: "not_found" };
    const today = this.today();
    const activities = this.state.activities.filter((a) => a.accountId === accountId);
    const lastActivity = clone([...activities].reverse().sort((a, b) => b.date.localeCompare(a.date))[0]) ?? null;
    const opportunities = this.state.opportunities
      .filter((o) => o.accountId === accountId && o.isOpen)
      .sort((a, b) => a.closeDate.localeCompare(b.closeDate))
      .slice(0, 3)
      .map(clone);
    const dueTasks = this.state.tasks
      .filter((t) => t.accountId === accountId && t.ownerId === rep.ownerId && t.status === "open" && t.dueDate <= today)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .map(clone);
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
      const task = this.state.tasks.find((t) => t.id === id);
      if (!task || !this.visibleAccount(rep, task.accountId)) return { ok: false, reason: "not_found" };
      return { ok: true, phrase: taskPhrase(task), task: clone(task) };
    }
    return { ok: false, reason: "unknown_handle" };
  }

  getContact(rep, contactId) {
    const contact = this.state.contacts.find((c) => c.id === contactId);
    return contact && this.visibleAccount(rep, contact.accountId) ? clone(contact) : null;
  }

  getContactInfo(rep, contactId, field) {
    const contact = this.getContact(rep, contactId);
    if (!contact) return { ok: false, reason: "not_found" };
    if (!Object.hasOwn(CONTACT_COLUMNS, field)) return { ok: false, reason: "field_not_allowed" };
    return { ok: true, contactId, field, value: contact[field], phrase: contactInfoPhrase(contact, field) };
  }

  contacts(accountId) {
    return this.state.contacts
      .filter((c) => c.accountId === accountId)
      .sort((a, b) => Number(b.isKey) - Number(a.isKey) || a.name.localeCompare(b.name))
      .map(clone);
  }

  opportunities(accountId) {
    return this.state.opportunities.filter((o) => o.accountId === accountId).sort((a, b) => a.closeDate.localeCompare(b.closeDate)).map(clone);
  }

  getOpportunity(rep, opportunityId) {
    const opp = this.state.opportunities.find((o) => o.id === opportunityId);
    return opp && this.visibleAccount(rep, opp.accountId) ? clone(opp) : null;
  }

  /** One commit, all or nothing, one audit row per field written. */
  applyChangeSet(rep, callId, proposal) {
    const account = this.visibleAccount(rep, proposal.accountId);
    if (!account) return { ok: false, reason: "not_found" };
    const backup = structuredClone(this.state);
    try {
      return this.#apply(rep, callId, proposal, account);
    } catch (error) {
      this.state = backup;
      throw error;
    }
  }

  #apply(rep, callId, proposal, account) {
    const s = this.state;
    const commitId = randomUUID();
    const at = this.#stamp();
    s.commits.push({ id: commitId, call_id: callId, account_id: account.id, owner_id: rep.ownerId, summary: proposal.readBack ?? null, created_at: at, reverted_at: null });
    const audit = (entity, recordId, field, before, after, operation) =>
      s.audit.push({ id: ++s.auditSeq, commit_id: commitId, call_id: callId, owner_id: rep.ownerId, entity, record_id: recordId, field, before_value: valueString(before), after_value: valueString(after), operation, created_at: at });
    for (const u of proposal.opportunityUpdates ?? []) {
      const opp = s.opportunities.find((o) => o.id === u.id);
      if (!opp || !canSee(rep, s.accounts.find((a) => a.id === opp.accountId))) throw new Error(`opportunity ${u.id} not visible`);
      for (const diff of u.diffs) {
        if (!Object.hasOwn(OPPORTUNITY_COLUMNS, diff.field)) throw new Error(`unsupported opportunity field ${diff.field}`);
        const before = opp[diff.field];
        opp[diff.field] = diff.after;
        audit("opportunity", u.id, diff.field, before, diff.after, "update");
      }
    }
    for (const u of proposal.contactUpdates ?? []) {
      const contact = s.contacts.find((c) => c.id === u.id);
      if (!contact || !canSee(rep, s.accounts.find((a) => a.id === contact.accountId))) throw new Error(`contact ${u.id} not visible`);
      for (const diff of u.diffs) {
        if (!Object.hasOwn(CONTACT_COLUMNS, diff.field)) throw new Error(`unsupported contact field ${diff.field}`);
        const before = contact[diff.field];
        contact[diff.field] = diff.after;
        audit("contact", u.id, diff.field, before, diff.after, "update");
      }
    }
    if (proposal.activity) {
      const a = proposal.activity;
      const id = a.id ?? randomUUID();
      s.activities.push({ id, accountId: account.id, type: a.type, subject: a.subject, notes: a.notes, date: a.date, contactIds: a.contactIds ?? [], createdBy: rep.ownerId, tags: ["Logged by voice agent", `call:${callId}`] });
      for (const [field, after] of Object.entries({ subject: a.subject, type: a.type, notes: a.notes, date: a.date, contacts: (a.contactIds ?? []).join(",") })) {
        audit("activity", id, field, null, after, "create");
      }
    }
    if (proposal.task) {
      const t = proposal.task;
      const id = t.id ?? randomUUID();
      s.tasks.push({ id, accountId: account.id, subject: t.subject, dueDate: t.dueDate, ownerId: rep.ownerId, status: "open" });
      for (const [field, after] of Object.entries({ subject: t.subject, dueDate: t.dueDate, owner: rep.ownerId })) {
        audit("task", id, field, null, after, "create");
      }
    }
    s.drafts = s.drafts.filter((d) => !(d.accountId === account.id && d.ownerId === rep.ownerId));
    return { ok: true, commitId };
  }

  /** Undo a commit, unless someone has changed one of its fields since. */
  revertCommit(rep, commitId) {
    const s = this.state;
    const commit = s.commits.find((c) => c.id === commitId);
    if (!commit || commit.owner_id !== rep.ownerId) return { ok: false, reason: "not_found" };
    if (commit.reverted_at) return { ok: false, reason: "already_reverted" };
    const rows = s.audit.filter((r) => r.commit_id === commitId).reverse();
    for (const r of rows) {
      const current = valueString(this.#currentValue(r));
      if (r.operation === "update" && current !== r.after_value) return { ok: false, reason: "conflict", field: r.field, current, expected: r.after_value };
    }
    for (const r of rows) {
      if (r.operation === "update" && r.entity === "opportunity") {
        const opp = s.opportunities.find((o) => o.id === r.record_id);
        if (opp) opp[r.field] = parseStored(r.before_value);
      } else if (r.operation === "update" && r.entity === "contact") {
        const contact = s.contacts.find((c) => c.id === r.record_id);
        if (contact) contact[r.field] = r.before_value;
      } else if (r.operation === "create" && r.entity === "activity") {
        s.activities = s.activities.filter((a) => a.id !== r.record_id);
      } else if (r.operation === "create" && r.entity === "task") {
        s.tasks = s.tasks.filter((t) => t.id !== r.record_id);
      }
    }
    commit.reverted_at = this.#stamp();
    return { ok: true, commitId };
  }

  #currentValue(row) {
    if (row.entity === "opportunity") return this.state.opportunities.find((o) => o.id === row.record_id)?.[row.field];
    if (row.entity === "contact") return this.state.contacts.find((c) => c.id === row.record_id)?.[row.field];
    return row.after_value;
  }

  /** A change made outside the agent, as a colleague editing the CRM would. Tests use it for conflicts. */
  editRecord(entity, id, field, value) {
    const [table, columns] = entity === "opportunity" ? [this.state.opportunities, OPPORTUNITY_COLUMNS] : entity === "contact" ? [this.state.contacts, CONTACT_COLUMNS] : [];
    const record = table?.find((r) => r.id === id);
    if (!record || !Object.hasOwn(columns, field)) return { ok: false, reason: "not_found" };
    record[field] = value;
    return { ok: true };
  }

  saveDraft(rep, proposal) {
    if (!proposal?.accountId) return { ok: false, reason: "no_proposal" };
    const account = this.visibleAccount(rep, proposal.accountId);
    if (!account) return { ok: false, reason: "not_found" };
    const id = randomUUID();
    this.state.drafts = this.state.drafts.filter((d) => !(d.accountId === account.id && d.ownerId === rep.ownerId));
    this.state.drafts.push({ id, accountId: account.id, ownerId: rep.ownerId, proposal: structuredClone(proposal), summary: proposal.readBack ?? "Voice update draft", createdAt: this.#stamp() });
    return { ok: true, draftId: id, accountName: account.name };
  }

  resumeDraft(rep, accountId = null) {
    const draft = this.#latestDraft(rep, accountId);
    if (!draft) return { ok: false, reason: "no_draft" };
    const account = this.visibleAccount(rep, draft.accountId);
    if (!account) return { ok: false, reason: "not_found" };
    return { ok: true, draftId: draft.id, account, proposal: structuredClone(draft.proposal), summary: draft.summary };
  }

  latestDraftHint(rep) {
    const draft = this.#latestDraft(rep);
    return draft ? { draftId: draft.id, accountId: draft.accountId, accountName: this.accountById(draft.accountId)?.name, summary: draft.summary } : null;
  }

  #latestDraft(rep, accountId = null) {
    return [...this.state.drafts].reverse().filter((d) => d.ownerId === rep.ownerId && (!accountId || d.accountId === accountId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  auditRows(commitId = null) {
    return this.state.audit.filter((r) => !commitId || r.commit_id === commitId).map(clone);
  }

  fieldsWrittenByEntity() {
    const out = {};
    for (const r of this.state.audit) out[r.entity] = (out[r.entity] ?? 0) + 1;
    return out;
  }

  committedActivityCount() {
    return new Set(this.state.audit.filter((r) => r.entity === "activity").map((r) => r.commit_id)).size;
  }

  close() {}
}
