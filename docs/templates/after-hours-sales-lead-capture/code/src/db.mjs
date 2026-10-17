// The lead store. This file holds the in-memory store, which the tests and the
// offline demo use; src/db-sqlite.mjs extends it with durable SQLite tables.
// It imports only the Node standard library, so `npm test` never needs a native
// module.
import { randomUUID } from "node:crypto";
import { config } from "./config.mjs";
import { normaliseEmail, normalisePhone, phoneGroups } from "./policy.mjs";

export class MemoryLeadStore {
  name = "memory";

  constructor({ reps, qualification, hours = null, dedupeWindowDays = config.dedupeWindowDays, now = () => new Date() } = {}) {
    this.reps = reps;
    this.qualification = qualification;
    this.hours = hours;
    this.dedupeWindowDays = dedupeWindowDays;
    this.now = () => new Date(now());
    this.calls = new Map();
    this.events = [];
    this.transcripts = [];
    this.leads = new Map();
    this.outbox = [];
    this.nonSales = [];
    // Simulated calls rotate through their own pointer, so a demo never moves
    // the round-robin that real callers see, and a reset makes it repeatable.
    this.pointer = 0;
    this.simulatedPointer = 0;
  }

  // Persistence hooks. The memory store keeps everything in the maps above.
  persistLead() {}
  persistOutbox() {}
  persistNonSales() {}
  persistPointers() {}

  startCall(call) {
    this.calls.set(call.id, { ...call });
  }

  updateCall(id, patch) {
    const c = this.calls.get(id);
    if (c) this.calls.set(id, { ...c, ...patch });
  }

  recordEvent(callId, source, kind, detail = null) {
    this.events.push({ callId, source, kind, detail: detail == null ? null : String(detail), created_at: this.now().toISOString() });
  }

  recordTranscript(callId, role, text) {
    if (config.persistTranscripts) this.transcripts.push({ callId, role, text, created_at: this.now().toISOString() });
  }

  eventsFor(callId) {
    return this.events.filter((e) => e.callId === callId);
  }

  outboxBacklog() {
    return this.outbox.filter((m) => ["pending", "failed"].includes(m.status)).length;
  }

  listLeads() {
    return [...this.leads.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listOutbox() {
    return [...this.outbox];
  }

  saveNonSales({ callId, kind, note }) {
    const record = {
      id: randomUUID(),
      callId,
      kind,
      note,
      simulated: Boolean(this.calls.get(callId)?.simulated),
      createdAt: this.now().toISOString(),
    };
    this.nonSales.push(record);
    this.persistNonSales(record);
    return { ok: true };
  }

  /**
   * Normalizes contact details, merges a repeat caller into their open lead,
   * scores the lead with the server's rules and picks the owner. `assignTo`
   * (a rep or rep id) overrides the round-robin without advancing it; the flow
   * uses it when the on-call rep takes the lead. `notice` is appended to the
   * rep's message.
   */
  saveLead(fields, { callId = null, partial = false, simulated, assignTo = null, notice = null } = {}) {
    const normalizedPhone = normalisePhone(fields.callbackPhone);
    const normalizedEmail = normaliseEmail(fields.email);
    if (!normalizedPhone && !normalizedEmail) return { ok: false, reason: "contact_required" };
    const now = this.now();
    const isSimulated = Boolean(simulated ?? this.calls.get(callId)?.simulated);
    const duplicate = this.#findDuplicate(normalizedPhone, normalizedEmail, now, isSimulated);
    const scored = this.qualification.score(fields);
    const note = makeNote(fields, partial, duplicate);
    let lead;
    if (duplicate) {
      lead = {
        ...duplicate,
        notes: [...duplicate.notes, note],
        duplicateCount: (duplicate.duplicateCount ?? 0) + 1,
        updatedAt: now.toISOString(),
      };
      this.leads.set(lead.id, lead);
      this.#enqueueRepeat(lead, fields, notice);
    } else {
      const owner = this.#resolveOwner(assignTo, isSimulated);
      lead = {
        id: `lead-${randomUUID().slice(0, 8)}`,
        callId,
        type: "sales",
        simulated: isSimulated,
        name: fields.name ?? null,
        company: fields.company ?? null,
        normalizedPhone,
        normalizedEmail,
        productInterest: fields.productInterest ?? null,
        productLine: scored.productLine,
        quantity: fields.quantity ? Number(fields.quantity) : null,
        timeline: fields.timeline ?? null,
        role: fields.role ?? null,
        location: fields.location ?? null,
        notes: [note],
        partial: Boolean(partial),
        score: scored.score,
        points: scored.points,
        scoreBreakdown: scored.breakdown,
        owner,
        slaDueAt: this.#followUpDue(scored.score, now).toISOString(),
        contactedAt: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        duplicateCount: 0,
      };
      this.leads.set(lead.id, lead);
      this.#enqueueNotifications(lead, notice);
    }
    this.persistLead(lead);
    this.persistPointers();
    return { ok: true, lead, duplicateOf: duplicate?.id ?? null, slaPhrase: slaPhrase(scored.score) };
  }

  markContacted(leadId, at = this.now()) {
    const lead = this.leads.get(leadId);
    if (!lead) return null;
    lead.contactedAt = new Date(at).toISOString();
    lead.metSla = new Date(at) <= new Date(lead.slaDueAt);
    this.leads.set(leadId, lead);
    this.persistLead(lead);
    return lead;
  }

  failOutbox(id, reason = "delivery failed") {
    const m = this.outbox.find((x) => x.id === id);
    if (m) {
      m.status = "failed";
      m.error = reason;
      this.persistOutbox(m);
    }
    return m;
  }

  /** Removes everything simulated calls created. Real calls and leads stay. */
  resetSimulated() {
    const simulatedCalls = new Set([...this.calls.values()].filter((c) => c.simulated).map((c) => c.id));
    const fromSimulation = (x) => Boolean(x.simulated) || simulatedCalls.has(x.callId);
    const removedLeads = new Set();
    for (const [id, lead] of this.leads) {
      if (fromSimulation(lead)) {
        this.leads.delete(id);
        removedLeads.add(id);
      }
    }
    for (const id of simulatedCalls) this.calls.delete(id);
    this.events = this.events.filter((e) => !simulatedCalls.has(e.callId));
    this.transcripts = this.transcripts.filter((t) => !simulatedCalls.has(t.callId));
    this.outbox = this.outbox.filter((o) => !o.simulated && !removedLeads.has(o.leadId));
    this.nonSales = this.nonSales.filter((n) => !fromSimulation(n));
    this.simulatedPointer = 0;
    this.persistPointers();
    return { calls: simulatedCalls.size, leads: removedLeads.size };
  }

  /**
   * A scripted beat's fresh start: forgets the simulated leads from these
   * numbers, with their follow-up messages, so the beat's caller calls for the
   * first time again, and lines up the simulated round-robin so the next new
   * lead goes to `nextRep` (an active rep's id). The calls stay counted. Real
   * leads and the round-robin real callers see are never touched.
   */
  restoreSimulated({ phones = [], nextRep = null } = {}) {
    const active = this.reps.activeReps();
    const pointer = nextRep == null ? null : active.findIndex((r) => r.id === nextRep);
    if (pointer === -1) return { ok: false, reason: "not_an_active_rep" };
    const numbers = new Set(phones.map((p) => normalisePhone(p)).filter(Boolean));
    const forgotten = [...this.leads.values()].filter((l) => l.simulated && numbers.has(l.normalizedPhone)).map((l) => l.id);
    for (const id of forgotten) this.leads.delete(id);
    this.outbox = this.outbox.filter((o) => !forgotten.includes(o.leadId));
    if (pointer != null) this.simulatedPointer = pointer;
    this.persistPointers();
    return { ok: true, forgotten, nextRep: pointer == null ? null : active[pointer] };
  }

  stats() {
    return computeStats([...this.calls.values()], this.listLeads(), this.nonSales, this.outbox);
  }

  #findDuplicate(phone, email, now, simulated) {
    const cutoff = now.getTime() - this.dedupeWindowDays * 86400000;
    return [...this.leads.values()].find((l) =>
      Boolean(l.simulated) === simulated
      && new Date(l.createdAt).getTime() >= cutoff
      && ((phone && l.normalizedPhone === phone) || (email && l.normalizedEmail === email))) ?? null;
  }

  #resolveOwner(assignTo, simulated) {
    const id = typeof assignTo === "string" ? assignTo : assignTo?.id;
    const rep = id ? this.reps.find?.(id) ?? (typeof assignTo === "object" ? assignTo : null) : null;
    return rep ?? this.#nextRep(simulated);
  }

  #nextRep(simulated) {
    const active = this.reps.activeReps();
    if (!active.length) throw new Error("no active reps");
    const key = simulated ? "simulatedPointer" : "pointer";
    const rep = active[this[key] % active.length];
    this[key] = (this[key] + 1) % active.length;
    return rep;
  }

  #followUpDue(score, now) {
    const due = this.hours?.followUpDue?.(score, now);
    if (due) return due;
    const hours = score === "hot" ? 1 : score === "warm" ? 24 : 48;
    return new Date(now.getTime() + hours * 3600000);
  }

  #dueLabel(iso) {
    return this.hours?.dueLabel?.(iso) ?? iso;
  }

  #enqueueNotifications(lead, notice) {
    const manager = lead.score === "hot" ? this.reps.manager : null;
    const body = [notificationSummary(lead, this.#dueLabel(lead.slaDueAt)), notice].filter(Boolean).join(" ");
    const common = { leadId: lead.id, kind: "new", status: "pending", toName: lead.owner.displayName, simulated: Boolean(lead.simulated), createdAt: this.now().toISOString() };
    const teams = {
      id: randomUUID(),
      channel: "teams",
      ...common,
      to: lead.owner.teamsUserId,
      mentionManager: Boolean(manager),
      managerTeamsUserId: manager?.teamsUserId ?? null,
      managerName: manager?.displayName ?? null,
      body,
    };
    const email = { id: randomUUID(), channel: "email", ...common, to: lead.owner.email, body };
    this.outbox.push(teams, email);
    this.persistOutbox(teams);
    this.persistOutbox(email);
  }

  // A repeat caller keeps the lead's owner, who gets a short note about the call.
  #enqueueRepeat(lead, fields, notice) {
    const who = fields.name ?? lead.name ?? "The caller";
    const body = [`Repeat call: ${who} called again and was merged into ${lead.id}. ${contactOf(lead)}.`, notice].filter(Boolean).join(" ");
    const entry = {
      id: randomUUID(),
      leadId: lead.id,
      kind: "repeat",
      channel: "teams",
      status: "pending",
      to: lead.owner?.teamsUserId ?? null,
      toName: lead.owner?.displayName ?? null,
      mentionManager: false,
      managerTeamsUserId: null,
      managerName: null,
      body,
      simulated: Boolean(lead.simulated),
      createdAt: this.now().toISOString(),
    };
    this.outbox.push(entry);
    this.persistOutbox(entry);
  }
}

function makeNote(fields, partial, duplicate) {
  const bits = [];
  if (partial) bits.push("PARTIAL");
  if (duplicate) bits.push(`Repeat contact merged into ${duplicate.id}`);
  if (fields.notes) bits.push(fields.notes);
  return bits.join(" — ") || "Captured by after-hours assistant";
}

export function slaPhrase(score) {
  return score === "hot" ? "within the hour" : score === "warm" ? "by the next business day" : "within two business days";
}

function contactOf(lead) {
  return lead.normalizedPhone ? `Call back ${phoneGroups(lead.normalizedPhone)}` : `Email ${lead.normalizedEmail}`;
}

function notificationSummary(lead, dueLabel) {
  const detail = [lead.quantity ? Number(lead.quantity).toLocaleString("en-US") : null, lead.timeline].filter(Boolean).join(", ");
  const needs = `${lead.productInterest ?? "sales follow-up"}${detail ? ` (${detail})` : ""}`;
  const label = `${lead.partial ? "PARTIAL " : ""}${lead.score.toUpperCase()} lead`;
  return `${label}: ${lead.name ?? "Unknown caller"} at ${lead.company ?? "an unknown company"} needs ${needs}. ${contactOf(lead)} by ${dueLabel}.`;
}

function computeStats(calls, leads, nonSales, outbox) {
  const tally = (items, key) => items.reduce((acc, x) => {
    const k = x[key] ?? "none";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const contacted = leads.filter((l) => l.contactedAt);
  const responseMs = contacted.map((l) => new Date(l.contactedAt) - new Date(l.createdAt)).sort((a, b) => a - b);
  const qualified = leads.filter((l) => ["hot", "warm"].includes(l.score)).length;
  const leadIds = new Set(leads.map((l) => l.id));
  const routed = new Set(outbox.filter((o) => o.channel === "teams" && o.kind !== "repeat" && leadIds.has(o.leadId)).map((o) => o.leadId));
  return {
    calls: calls.length,
    leadsCaptured: leads.length,
    qualifiedLeads: qualified,
    qualifiedLeadRate: leads.length ? qualified / leads.length : 0,
    routedLeads: routed.size,
    liveTransfers: calls.filter((c) => String(c.outcome ?? "").startsWith("transferred:")).length,
    pagesStarted: calls.filter((c) => c.page).length,
    pagesConnected: calls.filter((c) => c.page === "connected").length,
    nonSalesCalls: nonSales.length,
    leadsByScore: tally(leads, "score"),
    duplicatesMerged: leads.reduce((n, l) => n + (l.duplicateCount ?? 0), 0),
    nonSalesByKind: tally(nonSales, "kind"),
    partialLeads: leads.filter((l) => l.partial).length,
    medianTimeToFirstResponseMs: responseMs.length ? responseMs[Math.floor(responseMs.length / 2)] : null,
    contactedWithinSlaShare: contacted.length ? contacted.filter((l) => l.metSla).length / contacted.length : null,
    outboxBacklog: outbox.filter((o) => ["pending", "failed"].includes(o.status)).length,
  };
}
