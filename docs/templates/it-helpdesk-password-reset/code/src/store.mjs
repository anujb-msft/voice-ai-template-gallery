import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * The password policy and the in-memory stores.
 *
 * Standard library only, so the tests, the offline simulation and the live
 * server all run exactly the same policy code. The SQLite providers in
 * `providers/` reuse the policy from here; only the storage differs.
 */

export const COMMON_PASSWORDS = new Set([
  "password", "password1", "welcome1", "letmein", "qwerty123",
  "contoso123", "changeme", "summer2026", "winter2026", "admin123",
]);

export function hashPassword(plain) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(plain, salt, 64).toString("hex")}`;
}

export function verifyPassword(plain, stored) {
  if (!stored) return false;
  const [salt, key] = stored.split(":");
  if (!salt || !key) return false;
  const a = Buffer.from(key, "hex");
  const b = scryptSync(String(plain ?? ""), salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Password policy, expressed as data so the voice agent can read the rules
 * aloud and coach the user in real time rather than just rejecting input.
 * The failure strings are spoken, so keep them speakable.
 */
export function validatePasswordPolicy(password, user) {
  const pw = String(password ?? "");
  const failures = [];
  if (pw.length < 12) failures.push("It needs to be at least 12 characters long.");
  if (!/[A-Z]/.test(pw)) failures.push("It needs at least one capital letter.");
  if (!/[a-z]/.test(pw)) failures.push("It needs at least one lowercase letter.");
  if (!/[0-9]/.test(pw)) failures.push("It needs at least one number.");
  if (!/[^A-Za-z0-9]/.test(pw)) failures.push("It needs at least one symbol.");
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) failures.push("That password is on the commonly-used blocklist.");
  if (user?.username && pw.toLowerCase().includes(user.username.toLowerCase())) {
    failures.push("It can't contain your username.");
  }
  if (user?.displayName) {
    for (const part of user.displayName.split(/\s+/).filter((p) => p.length >= 3)) {
      if (pw.toLowerCase().includes(part.toLowerCase())) {
        failures.push("It can't contain part of your name.");
        break;
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * The fictional Contoso workforce the demo runs on. `scripts/seed.mjs` writes
 * the same two people into SQLite for live calls.
 */
export const DEMO_EMPLOYEES = Object.freeze([
  Object.freeze({
    id: "u-alex",
    username: "alex.morgan",
    displayName: "Alex Morgan",
    // Real directories carry a phonetic field; the agent is told to use it.
    phoneticName: null,
    email: "alex.morgan@contoso.com",
    phone: "+14255550142",
    department: "Field Operations",
    employeeId: "E-104217",
    locked: true,
  }),
  Object.freeze({
    id: "u-jordan",
    username: "jordan.patel",
    displayName: "Jordan Patel",
    phoneticName: null,
    email: "jordan.patel@contoso.com",
    phone: "+14255550143",
    department: "Finance",
    employeeId: "E-100892",
    locked: false,
  }),
]);

/**
 * DirectoryProvider over an in-memory copy of DEMO_EMPLOYEES. It is the
 * simulation's directory, and the live fallback when SQLite cannot be opened.
 * @implements {import("./providers/directory.mjs").DirectoryProvider}
 */
export class MemoryDirectory {
  name = "memory";

  /** @param {{ employees?: object[], phone?: string }} [options] `phone` overrides every callback number. */
  constructor({ employees = DEMO_EMPLOYEES, phone = "" } = {}) {
    this.employees = employees;
    this.phone = phone;
    this.reset();
  }

  reset() {
    this.users = new Map(this.employees.map((e) => [e.id, this.#fixture(e)]));
  }

  #fixture(e) {
    return { ...e, phone: this.phone || e.phone, passwordHash: null, lastResetAt: null };
  }

  /**
   * Put one employee back to the fixture record (locked or not, no password
   * set), so a scripted simulation behaves the same however often it runs.
   */
  restore(username) {
    const key = String(username ?? "").trim().toLowerCase();
    const e = this.employees.find((x) => x.username.toLowerCase() === key);
    if (e) this.users.set(e.id, this.#fixture(e));
  }

  #public(row) {
    if (!row) return null;
    const { passwordHash, lastResetAt, ...user } = row;
    return { ...user };
  }

  #byUsername(username) {
    const key = String(username ?? "").trim().toLowerCase();
    for (const row of this.users.values()) if (row.username.toLowerCase() === key) return row;
    return null;
  }

  async findByUsername(username) {
    return this.#public(this.#byUsername(username));
  }

  async findById(id) {
    return this.#public(this.users.get(id));
  }

  async authenticate(username, password) {
    const row = this.#byUsername(username);
    if (!row) return { ok: false, reason: "unknown_user" };
    if (row.locked) return { ok: false, reason: "locked" };
    if (!verifyPassword(password, row.passwordHash)) return { ok: false, reason: "bad_password" };
    return { ok: true, user: this.#public(row) };
  }

  validatePasswordPolicy(password, user) {
    return validatePasswordPolicy(password, user);
  }

  async setPassword(id, password) {
    const row = this.users.get(id);
    if (!row) return { ok: false, reason: "unknown_user" };
    const policy = validatePasswordPolicy(password, row);
    if (!policy.ok) return { ok: false, reason: "policy", failures: policy.failures };
    row.passwordHash = hashPassword(password);
    row.locked = false;
    row.lastResetAt = new Date().toISOString();
    return { ok: true };
  }

  async unlockAccount(id) {
    const row = this.users.get(id);
    if (row) row.locked = false;
  }
}

/** TicketingProvider in memory: INC0007001, INC0007002, … */
export class MemoryTicketing {
  name = "memory";

  constructor({ first = 7001 } = {}) {
    this.first = first;
    this.reset();
  }

  reset() {
    this.next = this.first;
    this.tickets = new Map();
  }

  async openTicket({ userId, sessionId, category, summary }) {
    const id = `INC${String(this.next++).padStart(7, "0")}`;
    this.tickets.set(id, { id, userId, sessionId, category, summary, status: "open", deflected: false });
    return { id };
  }

  async closeTicket(id, { deflected, summary }) {
    const ticket = this.tickets.get(id);
    if (!ticket) return;
    ticket.status = deflected ? "closed_deflected" : "closed_escalated";
    ticket.deflected = Boolean(deflected);
    ticket.summary = summary;
  }

  async getTicket(id) {
    const ticket = this.tickets.get(id);
    return ticket ? { ...ticket } : null;
  }

  async deflectionStats() {
    const all = [...this.tickets.values()];
    return { total: all.length, deflected: all.filter((t) => t.deflected).length };
  }
}

export function medianSeconds(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(median);
}

/**
 * The metrics footer, computed from the audit rather than kept as counters, so
 * the numbers can always be traced back to a session and its events.
 */
export function computeStats(sessions, events) {
  const count = (...kinds) => events.filter((e) => kinds.includes(e.kind)).length;
  const completed = sessions.filter((s) => s.outcome === "reset_completed");
  return {
    callbacks: sessions.length,
    verified: sessions.filter((s) => s.verified).length,
    resetsCompleted: completed.length,
    refused: count("refused", "verification_failed"),
    handedOff: sessions.filter((s) => s.handedOff || String(s.outcome ?? "").startsWith("escalated")).length,
    kbAnswers: count("kb_answer"),
    medianSecondsToReset: medianSeconds(completed.map((s) => s.secondsToReset)),
  };
}

/**
 * The audit trail in memory. Every session and every event the console shows
 * comes from here. Nothing in it ever holds a verification code or a password.
 */
export class MemoryAudit {
  name = "memory";
  sessions = new Map();
  events = [];

  /** The demo reset: forget simulated sessions and their events. A real call's record stays. */
  reset() {
    const simulated = new Set([...this.sessions.values()].filter((s) => s.simulated).map((s) => s.id));
    for (const id of simulated) this.sessions.delete(id);
    this.events = this.events.filter((e) => !simulated.has(e.sessionId));
  }

  startSession(summary) {
    this.sessions.set(summary.id, { ...summary });
  }

  updateSession(id, patch) {
    const row = this.sessions.get(id);
    if (row) Object.assign(row, patch);
  }

  recordEvent(sessionId, { source = "system", kind, detail = null, at = new Date().toISOString() }) {
    const event = { sessionId, source, kind, detail: detail == null ? null : String(detail), at };
    this.events.push(event);
    return event;
  }

  eventsFor(sessionId) {
    return this.events.filter((e) => e.sessionId === sessionId);
  }

  stats() {
    return computeStats([...this.sessions.values()], this.events);
  }
}
