import { haversineMeters } from "./geocoder.mjs";

const START_SEQUENCE = 193;

/**
 * Service requests in memory. Standard library only, so the server can start
 * (and every test can run) without the native SQLite module; db.mjs layers
 * persistence on top of this when it loads.
 *
 * Rows created by simulated calls carry `simulated: true`, which is what lets
 * the demo reset clear them without touching real cases.
 */
export class MemoryCaseStore {
  name = "memory";
  constructor({ now = () => Date.now(), startSequence = START_SEQUENCE } = {}) {
    this.now = now;
    this.startSequence = startSequence;
    this.next = startSequence;
    this.cases = [];
  }
  create(input) {
    const now = new Date(this.now()).toISOString();
    const row = { id: input.caseNumber ?? this.#nextCaseNumber(), status: "open", meToo: 1, createdAt: now, updatedAt: now, simulated: false, ...input };
    this.cases.push(row);
    return row;
  }
  /**
   * Another caller's report of an open case. With `priority`, a hazard report
   * raises a standard case: the fields that met the rule are kept and the
   * priority clock starts now. A case is raised once.
   */
  attach(existing, note = null, { priority = false, fields = null } = {}) {
    const now = new Date(this.now()).toISOString();
    existing.meToo = (existing.meToo ?? 1) + 1;
    existing.updatedAt = now;
    if (note) existing.attachments = [...(existing.attachments ?? []), note];
    if (priority && !existing.priority) {
      existing.priority = true;
      existing.escalatedAt = now;
      if (fields) existing.fields = { ...(existing.fields ?? {}), ...fields };
    }
    return existing;
  }
  findDuplicates({ type, location, radiusM, windowDays }) {
    const min = this.now() - windowDays * 86400000;
    return this.cases.filter((c) => c.type === type && c.status === "open" && c.lat != null && location?.lat != null && Date.parse(c.createdAt) >= min && haversineMeters(c, location) <= radiusM);
  }
  getStatus(caseNumber) { return this.cases.find((c) => c.id.toUpperCase() === String(caseNumber).toUpperCase()) ?? null; }
  updateContact(caseNumber, contact) { const c = this.getStatus(caseNumber); if (c) c.contact = contact; return c; }
  close(caseNumber) { const c = this.getStatus(caseNumber); if (c) { c.status = "closed"; c.updatedAt = new Date(this.now()).toISOString(); } return c; }
  all() { return [...this.cases]; }

  /** Demo reset: drop the cases simulated calls created; keep real ones and number on from them. */
  reset() {
    const before = this.cases.length;
    this.cases = this.cases.filter((c) => !c.simulated);
    this.renumber();
    return before - this.cases.length;
  }

  renumber() {
    const max = this.cases.map((c) => Number(String(c.id).split("-").pop())).filter(Number.isFinite).sort((a, b) => b - a)[0];
    this.next = max ? Math.max(max + 1, this.startSequence) : this.startSequence;
  }

  #nextCaseNumber() { return `SR-${String(new Date(this.now()).getFullYear()).slice(2)}-${String(this.next++).padStart(4, "0")}`; }
}
