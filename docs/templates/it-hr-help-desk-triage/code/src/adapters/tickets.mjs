import { config } from "../config.mjs";
import { readJson } from "../util.mjs";

/** First numbers handed out on a fresh demo, so a reset always files INC-004821 next. */
const FIRST_NUMBER = { INC: 4821, REQ: 2100, HRC: 800 };

/**
 * The ITSM stand-in. Tickets and HR cases created on simulated calls are marked
 * `simulated`, so a demo reset can drop them without touching real records.
 * Swap this class for your ITSM's API; the flow only uses the methods below.
 */
export class MemoryTicketAdapter {
  name = "memory";

  constructor(seed = readJson(config.paths.itsmSeed)) {
    this.tickets = (seed.tickets ?? []).map((t) => ({ ...t }));
    this.hrCases = (seed.hrCases ?? []).map((c) => ({ ...c }));
    /** Callers added to an existing incident instead of getting a duplicate ticket. */
    this.affected = (seed.affected ?? []).map((a) => ({ ...a }));
    this.renumber();
  }

  createTicket({ kind = "incident", requester, category, priority, summary, asset = null, parentIncident = null, simulated = false }) {
    const prefix = kind === "request" ? "REQ" : "INC";
    const number = formatNumber(prefix, this.next[prefix]++);
    const ticket = {
      number, kind, requester, category, priority, summary, asset, parentIncident,
      status: "New", lastUpdate: "Logged by the IT and HR help line.", simulated: Boolean(simulated),
    };
    this.tickets.push(ticket);
    return ticket;
  }

  /** Adds the caller to the parent incident. No new ticket number is used. */
  attachToIncident({ requester, parentIncident, summary = null, simulated = false }) {
    const parent = this.findByNumber(parentIncident);
    const alreadyAffected = this.isAffected(parentIncident, requester);
    if (!alreadyAffected) this.affected.push({ parentIncident, requester, simulated: Boolean(simulated) });
    return {
      number: parentIncident,
      parentIncident,
      kind: "affected",
      requester,
      category: parent?.category ?? null,
      priority: parent?.priority ?? null,
      summary: parent?.summary ?? summary,
      status: parent?.status ?? "Open",
      lastUpdate: parent?.lastUpdate ?? null,
      alreadyAffected,
      simulated: Boolean(simulated),
    };
  }

  findByNumber(number) {
    const wanted = String(number ?? "").toUpperCase();
    return this.tickets.find((t) => t.number === wanted) ?? null;
  }

  isAffected(number, requester) {
    return this.affected.some((a) => a.parentIncident === number && a.requester === requester);
  }

  /** The requester's own tickets, plus incidents they were added to. */
  getMyTickets(requester) {
    return this.tickets
      .filter((t) => t.requester === requester || this.isAffected(t.number, requester))
      .sort((a, b) => a.number.localeCompare(b.number));
  }

  createHrCase({ requester, callback = false, consentShareName = false, simulated = false }) {
    const number = formatNumber("HRC", this.next.HRC++);
    const hrCase = { number, requester, callback, consentShareName, summary: "Confidential HR", status: "Restricted", simulated: Boolean(simulated) };
    this.hrCases.push(hrCase);
    return hrCase;
  }

  stats() {
    const tally = (field) => this.tickets.reduce((acc, t) => {
      const key = t[field] ?? "none";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    return { byCategory: tally("category"), byPriority: tally("priority") };
  }

  /** Demo reset: forget everything simulated calls created and reuse their numbers. */
  reset() {
    this.tickets = this.tickets.filter((t) => !t.simulated);
    this.hrCases = this.hrCases.filter((c) => !c.simulated);
    this.affected = this.affected.filter((a) => !a.simulated);
    this.renumber();
  }

  /** Next numbers continue after anything already stored, so a restart never collides. */
  renumber() {
    const highest = (prefix, rows) => Math.max(0, ...rows.map((r) => parseNumber(prefix, r.number)));
    this.next = {
      INC: Math.max(FIRST_NUMBER.INC, highest("INC", this.tickets) + 1),
      REQ: Math.max(FIRST_NUMBER.REQ, highest("REQ", this.tickets) + 1),
      HRC: Math.max(FIRST_NUMBER.HRC, highest("HRC", this.hrCases) + 1),
    };
  }
}

/**
 * SQLite is loaded lazily so the policy code and the tests never need the
 * native module; if it cannot load or open, the demo keeps working in memory.
 */
export async function createTicketAdapter(kind = config.ticketAdapter, { path = config.dbPath, log = () => {} } = {}) {
  if (kind !== "sqlite") return new MemoryTicketAdapter();
  try {
    const { SqliteTicketAdapter } = await import("./tickets-sqlite.mjs");
    return new SqliteTicketAdapter(path);
  } catch (e) {
    log(`[tickets] falling back to in-memory tickets: ${e.message}`);
    return new MemoryTicketAdapter();
  }
}

function formatNumber(prefix, n) { return `${prefix}-${String(n).padStart(6, "0")}`; }
function parseNumber(prefix, number) {
  const m = new RegExp(`^${prefix}-(\\d+)$`).exec(String(number ?? ""));
  return m ? Number(m[1]) : 0;
}
