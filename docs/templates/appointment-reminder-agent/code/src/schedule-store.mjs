/**
 * Shared Contoso Health schedule store.
 *
 * The appointment reminder sample owns this SQLite implementation and seed. The
 * appointment scheduling sample can copy this file and extend the
 * ScheduleAdapter with searchSlots/holdSlot/releaseHold/bookAppointment/
 * rescheduleAppointment/addWaitlist while keeping the same tables, occupancy
 * locking model, and handoff token contract.
 *
 * Driver: the store only uses the API that better-sqlite3 and Node's built-in
 * node:sqlite share (prepare().get/all/run, exec, close), so tests and offline
 * runs need no native module. The server opens better-sqlite3 lazily through
 * ScheduleAdapter.open() and falls back to an in-memory node:sqlite store.
 *
 * Clock: every timestamp comes from the injected now(), so the console's demo
 * clock drives the whole schedule.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { config, demoNowDate } from "./config.mjs";

const require = createRequire(import.meta.url);
const STATUS_OPEN = new Set(["booked", "confirmed"]);
const TABLES = ["patients", "providers", "appointments", "occupancy", "released_slots", "handoff_tokens", "idempotency", "suppression", "campaign_attempts", "reschedule_requests"];

export function isMemoryPath(dbPath) {
  return !dbPath || dbPath === ":memory:";
}

export function openBuiltinDatabase(dbPath = ":memory:") {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(dbPath);
}

export class ScheduleAdapter {
  constructor({
    dbPath = config.schedule.dbPath,
    seedPath = config.schedule.seedPath,
    now = () => demoNowDate(),
    handoffTokenSecret = config.schedule.handoffTokenSecret,
    tokenTtlMs = config.schedule.handoffTokenTtlMs,
    database = null,
    driver = null,
  } = {}) {
    this.dbPath = dbPath;
    this.seedPath = seedPath;
    this.now = now;
    this.handoffTokenSecret = handoffTokenSecret;
    this.tokenTtlMs = tokenTtlMs;
    if (!database && !isMemoryPath(dbPath)) mkdirSync(dirname(dbPath), { recursive: true });
    this.db = database ?? openBuiltinDatabase(dbPath);
    this.driver = driver ?? (database ? "custom" : "node:sqlite");
    if (!isMemoryPath(dbPath)) this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.seedIfEmpty(seedPath);
  }

  /** Server entry point: better-sqlite3 when it loads, else an in-memory node:sqlite store. */
  static async open(options = {}) {
    const dbPath = options.dbPath ?? config.schedule.dbPath;
    const log = options.log ?? console.log;
    let database = null;
    try {
      const { default: Database } = await import("better-sqlite3");
      if (!isMemoryPath(dbPath)) mkdirSync(dirname(dbPath), { recursive: true });
      database = new Database(dbPath);
    } catch (error) {
      log(`[schedule] better-sqlite3 did not load (${error?.code ?? error?.message}); using Node's built-in node:sqlite with an in-memory copy of the seed`);
      return new ScheduleAdapter({ ...options, dbPath: ":memory:", driver: "node:sqlite (in-memory fallback)" });
    }
    return new ScheduleAdapter({ ...options, dbPath, database, driver: "better-sqlite3" });
  }

  static reset({ dbPath = config.schedule.dbPath } = {}) {
    if (isMemoryPath(dbPath)) return;
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(`${dbPath}${suffix}`); } catch {}
    }
  }

  get inMemory() {
    return isMemoryPath(this.dbPath);
  }

  seedIfEmpty(seedPath = this.seedPath) {
    const count = this.#get("SELECT COUNT(*) AS n FROM appointments").n;
    if (count > 0) return false;
    const seed = JSON.parse(readFileSync(seedPath, "utf8"));
    const stamp = this.now().toISOString();
    this.#transaction(() => {
      for (const p of seed.providers ?? []) {
        this.#run(`INSERT INTO providers (provider_id, name, department, record_json) VALUES (?, ?, ?, ?)`,
          p.providerId ?? p.provider_id, p.name, p.department, JSON.stringify(p.record ?? p.record_json ?? p));
      }
      for (const p of seed.patients ?? []) {
        this.#run(`INSERT INTO patients (patient_id, first_name, last_name, dob, record_json) VALUES (?, ?, ?, ?, ?)`,
          p.patientId ?? p.patient_id, p.firstName ?? p.first_name, p.lastName ?? p.last_name, p.dob, JSON.stringify(p));
      }
      for (const a of seed.appointments ?? []) this.#insertSeedAppointment(seed, a, stamp);
    });
    return true;
  }

  /**
   * Put one appointment back exactly as the seed has it: its status, its slot,
   * and a clean reminder history (attempts, reschedule requests, handoff tokens,
   * idempotency keys and the patient's opt-out). The console's beats call this so
   * each beat starts identical without resetting the rest of the run.
   */
  restoreAppointment(appointmentId) {
    const seed = JSON.parse(readFileSync(this.seedPath, "utf8"));
    const original = (seed.appointments ?? []).find((a) => (a.appointmentId ?? a.appointment_id) === appointmentId);
    if (!original) return { ok: false, reason: "unknown_appointment" };
    const patientId = original.patientId ?? original.patient_id;
    const stamp = this.now().toISOString();
    this.#transaction(() => {
      this.#run(`DELETE FROM occupancy WHERE kind = 'appointment' AND ref = ?`, appointmentId);
      for (const table of ["appointments", "released_slots", "campaign_attempts", "reschedule_requests", "handoff_tokens"]) {
        this.#run(`DELETE FROM ${table} WHERE appointment_id = ?`, appointmentId);
      }
      this.#run(`DELETE FROM idempotency WHERE instr(key, ?) > 0`, appointmentId);
      this.#run(`DELETE FROM suppression WHERE patient_id = ?`, patientId);
      this.#insertSeedAppointment(seed, original, stamp);
    });
    return { ok: true, appointment: this.getAppointment(appointmentId) };
  }

  hasOpenRescheduleRequest(appointmentId) {
    return Boolean(this.#get(`SELECT 1 AS hit FROM reschedule_requests WHERE appointment_id = ? AND status = 'requested'`, appointmentId));
  }

  /** Wipe every table and load the seed again, so each demo run starts identical. */
  reseed() {
    this.#transaction(() => {
      for (const table of TABLES) this.db.exec(`DELETE FROM ${table}`);
      if (this.#get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`)) this.db.exec(`DELETE FROM sqlite_sequence`);
    });
    this.seedIfEmpty();
    return this.stats();
  }

  getAppointment(appointmentId) {
    const row = this.#get(`SELECT * FROM appointments WHERE appointment_id = ?`, appointmentId);
    return row ? this.#hydrateAppointment(row) : null;
  }

  getPatient(patientId) {
    const row = this.#get(`SELECT * FROM patients WHERE patient_id = ?`, patientId);
    return row ? hydratePatient(row) : null;
  }

  getProvider(providerId) {
    const row = this.#get(`SELECT * FROM providers WHERE provider_id = ?`, providerId);
    return row ? { providerId: row.provider_id, name: row.name, department: row.department, record: parse(row.record_json) } : null;
  }

  /** statuses: null lists every status (the console's schedule panel uses that). */
  listUpcoming({ patientId = null, from = this.now().toISOString(), to = null, statuses = ["booked", "confirmed"] } = {}) {
    const clauses = [];
    const params = [];
    if (from) { clauses.push("datetime(start) >= datetime(?)"); params.push(from); }
    if (to) { clauses.push("datetime(start) <= datetime(?)"); params.push(to); }
    if (patientId) { clauses.push("patient_id = ?"); params.push(patientId); }
    if (statuses?.length) { clauses.push(`status IN (${statuses.map(() => "?").join(",")})`); params.push(...statuses); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.#all(`SELECT * FROM appointments ${where} ORDER BY datetime(start), appointment_id`, ...params).map((r) => this.#hydrateAppointment(r));
  }

  listReminderCandidates({ now = this.now(), leadTimeHours = 48, leadWindowHours = 8 } = {}) {
    const from = new Date(now.getTime() + (leadTimeHours - leadWindowHours / 2) * 3600_000).toISOString();
    const to = new Date(now.getTime() + (leadTimeHours + leadWindowHours / 2) * 3600_000).toISOString();
    return this.listUpcoming({ from, to });
  }

  confirmAppointment(appointmentId, idempotencyKey = `confirm:${appointmentId}`) {
    return this.#idempotent(idempotencyKey, () => {
      const existing = this.getAppointment(appointmentId);
      if (!existing) throw new Error(`unknown appointment ${appointmentId}`);
      this.#run(`UPDATE appointments SET status = 'confirmed', updated_at = ? WHERE appointment_id = ?`, this.now().toISOString(), appointmentId);
      return { ok: true, action: "confirm", appointment: this.getAppointment(appointmentId) };
    });
  }

  cancelAppointment(appointmentId, reasonCode = "patient_requested", idempotencyKey = `cancel:${appointmentId}:${reasonCode}`) {
    return this.#idempotent(idempotencyKey, () => {
      const appt = this.getAppointment(appointmentId);
      if (!appt) throw new Error(`unknown appointment ${appointmentId}`);
      const releasedAt = this.now().toISOString();
      this.#transaction(() => {
        this.#run(`UPDATE appointments SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE appointment_id = ?`, reasonCode, releasedAt, appointmentId);
        this.#run(`INSERT OR REPLACE INTO released_slots (appointment_id, provider_id, location, start, end, reason, released_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          appointmentId, appt.providerId, appt.location, appt.start, appt.end, reasonCode, releasedAt);
        this.#run(`DELETE FROM occupancy WHERE kind = 'appointment' AND ref = ?`, appointmentId);
      });
      return { ok: true, action: "cancel", appointment: this.getAppointment(appointmentId), releasedSlot: { appointmentId, providerId: appt.providerId, location: appt.location, start: appt.start, end: appt.end, reason: reasonCode, releasedAt } };
    });
  }

  requestReschedule(appointmentId, idempotencyKey = `reschedule:${appointmentId}`) {
    return this.#idempotent(idempotencyKey, () => {
      const appt = this.getAppointment(appointmentId);
      if (!appt) throw new Error(`unknown appointment ${appointmentId}`);
      this.#run(`INSERT INTO reschedule_requests (appointment_id, patient_id, status, created_at) VALUES (?, ?, 'requested', ?)`,
        appointmentId, appt.patientId, this.now().toISOString());
      return { ok: true, action: "request_reschedule", appointment: appt };
    });
  }

  issueHandoffToken({ appointmentId, patientId, correlationId }) {
    const appt = this.getAppointment(appointmentId);
    if (!appt || appt.patientId !== patientId) throw new Error("handoff appointment/patient mismatch");
    const issuedAt = this.now();
    const createdAt = issuedAt.toISOString();
    const expiresAt = new Date(issuedAt.getTime() + this.tokenTtlMs).toISOString();
    const random = randomBytes(24).toString("base64url");
    const token = this.handoffTokenSecret
      ? signToken({ appointmentId, patientId, correlationId, exp: Date.parse(expiresAt), nonce: random }, this.handoffTokenSecret)
      : random;
    this.#run(`INSERT INTO handoff_tokens (token_hash, appointment_id, patient_id, correlation_id, created_at, expires_at, redeemed_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      sha256(token), appointmentId, patientId, correlationId, createdAt, expiresAt);
    return { token, expiresAt, appointmentId };
  }

  redeemHandoffToken({ token, correlationId }) {
    const tokenHash = sha256(token);
    const row = this.#get(`SELECT * FROM handoff_tokens WHERE token_hash = ?`, tokenHash);
    let payload = null;
    if (!row && this.handoffTokenSecret) payload = verifyToken(token, this.handoffTokenSecret);
    if (!row && !payload) return { ok: false, reason: "invalid" };
    const now = this.now();
    if (row) {
      if (row.redeemed_at) return { ok: false, reason: "used" };
      if (new Date(row.expires_at) <= now) return { ok: false, reason: "expired" };
      if (row.correlation_id && correlationId && row.correlation_id !== correlationId) return { ok: false, reason: "wrong_call" };
      this.#run(`UPDATE handoff_tokens SET redeemed_at = ? WHERE token_hash = ?`, now.toISOString(), tokenHash);
      return { ok: true, appointment: this.getAppointment(row.appointment_id), patient: this.getPatient(row.patient_id) };
    }
    if (payload.exp <= now.getTime()) return { ok: false, reason: "expired" };
    if (payload.correlationId && correlationId && payload.correlationId !== correlationId) return { ok: false, reason: "wrong_call" };
    return { ok: true, appointment: this.getAppointment(payload.appointmentId), patient: this.getPatient(payload.patientId), stateless: true };
  }

  suppressPatient(patientId, reason = "opt_out") {
    this.#run(`INSERT OR REPLACE INTO suppression (patient_id, reason, created_at) VALUES (?, ?, ?)`, patientId, reason, this.now().toISOString());
    return { ok: true };
  }

  isSuppressed(patientId) {
    return Boolean(this.#get(`SELECT 1 AS hit FROM suppression WHERE patient_id = ?`, patientId));
  }

  recordAttempt({ appointmentId, patientId, state, outcome = null, attempt = 1, nextAttemptAt = null, detail = null }) {
    this.#run(`INSERT INTO campaign_attempts (appointment_id, patient_id, state, outcome, attempt, next_attempt_at, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      appointmentId, patientId, state, outcome, attempt, nextAttemptAt, detail, this.now().toISOString());
  }

  /**
   * Correct the outcome already logged for a dial (a handoff whose transfer then
   * failed) instead of logging a second attempt for the same call.
   */
  amendAttempt({ appointmentId, attempt, fromOutcome, state, outcome, detail = null }) {
    const row = this.#get(`SELECT id FROM campaign_attempts WHERE appointment_id = ? AND attempt = ? AND outcome = ? ORDER BY id DESC LIMIT 1`, appointmentId, attempt, fromOutcome);
    if (!row) return false;
    this.#run(`UPDATE campaign_attempts SET state = ?, outcome = ?, detail = COALESCE(?, detail) WHERE id = ?`, state, outcome, detail, row.id);
    return true;
  }

  attemptsFor(appointmentId) {
    return this.#all(`SELECT * FROM campaign_attempts WHERE appointment_id = ? ORDER BY id`, appointmentId).map((r) => ({ ...r }));
  }

  releasedSlots() {
    return this.#all(`SELECT * FROM released_slots ORDER BY released_at, appointment_id`).map((r) => ({
      appointmentId: r.appointment_id, providerId: r.provider_id, location: r.location, start: r.start, end: r.end, reason: r.reason, releasedAt: r.released_at,
    }));
  }

  rescheduleRequests() {
    return this.#all(`SELECT * FROM reschedule_requests ORDER BY id`).map((r) => ({
      appointmentId: r.appointment_id, patientId: r.patient_id, status: r.status, createdAt: r.created_at,
    }));
  }

  stats(now = this.now()) {
    const scalar = (sql, ...params) => this.#get(sql, ...params).n;
    const grouped = (sql) => Object.fromEntries(this.#all(sql).map((r) => [r.k, r.n]));
    return {
      appointments: scalar(`SELECT COUNT(*) AS n FROM appointments`),
      upcomingOpen: scalar(`SELECT COUNT(*) AS n FROM appointments WHERE status IN ('booked','confirmed') AND datetime(start) >= datetime(?)`, now.toISOString()),
      byStatus: grouped(`SELECT status AS k, COUNT(*) AS n FROM appointments GROUP BY status`),
      releasedSlots: scalar(`SELECT COUNT(*) AS n FROM released_slots`),
      rescheduleRequests: scalar(`SELECT COUNT(*) AS n FROM reschedule_requests`),
      optOuts: scalar(`SELECT COUNT(*) AS n FROM suppression`),
      attempts: scalar(`SELECT COUNT(*) AS n FROM campaign_attempts`),
      outcomes: grouped(`SELECT COALESCE(outcome, state) AS k, COUNT(*) AS n FROM campaign_attempts GROUP BY k`),
      noShowComparison: this.#noShowComparison(),
    };
  }

  close() { this.db.close(); }

  #get(sql, ...params) { return this.db.prepare(sql).get(...params.map(bindable)); }
  #all(sql, ...params) { return this.db.prepare(sql).all(...params.map(bindable)); }
  #run(sql, ...params) { return this.db.prepare(sql).run(...params.map(bindable)); }

  #transaction(fn) {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  #hydrateAppointment(row) {
    const patient = this.getPatient(row.patient_id);
    const provider = this.getProvider(row.provider_id);
    return {
      appointmentId: row.appointment_id,
      patientId: row.patient_id,
      providerId: row.provider_id,
      department: row.department,
      location: row.location,
      visitType: row.visit_type,
      start: row.start,
      end: row.end,
      prepCode: row.prep_code,
      status: row.status,
      cancelReason: row.cancel_reason,
      attended: row.attended == null ? null : Boolean(row.attended),
      source: row.source,
      updatedAt: row.updated_at,
      patient,
      provider,
    };
  }

  #insertSeedAppointment(seed, a, stamp) {
    const id = a.appointmentId ?? a.appointment_id;
    const providerId = a.providerId ?? a.provider_id ?? providerIdByName(seed.providers, a.provider);
    const end = a.end ?? addMinutesIso(a.start, 15);
    this.#run(`INSERT INTO appointments
      (appointment_id, patient_id, provider_id, department, location, visit_type, start, end, prep_code, status, cancel_reason, attended, source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, a.patientId ?? a.patient_id, providerId, a.department, a.location, a.visitType ?? a.visit_type, a.start, end,
      a.prepCode ?? a.prep_code, a.status ?? "booked", a.cancelReason ?? a.cancel_reason,
      a.attended == null ? null : Number(a.attended), a.source ?? "seed", stamp);
    if (STATUS_OPEN.has(a.status ?? "booked") && new Date(end) > this.now()) {
      this.#writeOccupancy(providerId, a.start, end, "appointment", id);
    }
    return id;
  }

  #writeOccupancy(providerId, start, end, kind, ref, expiresAt = null) {
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO occupancy (provider_id, unit_start, kind, ref, expires_at) VALUES (?, ?, ?, ?, ?)`);
    for (const unit of fiveMinuteUnits(start, end)) stmt.run(...[providerId, unit, kind, ref, expiresAt].map(bindable));
  }

  #idempotent(key, fn) {
    const existing = this.#get(`SELECT result_json FROM idempotency WHERE key = ?`, key);
    if (existing) return parse(existing.result_json);
    const result = fn();
    this.#run(`INSERT INTO idempotency (key, result_json, created_at) VALUES (?, ?, ?)`, key, JSON.stringify(result), this.now().toISOString());
    return result;
  }

  #noShowComparison() {
    const rows = this.#all(`SELECT status, attended FROM appointments WHERE attended IS NOT NULL`);
    const totals = { reminded: { attended: 0, total: 0 }, notReached: { attended: 0, total: 0 } };
    for (const r of rows) {
      const bucket = r.status === "completed" ? totals.reminded : totals.notReached;
      bucket.total += 1;
      if (r.attended) bucket.attended += 1;
    }
    return totals;
  }
}

export function hydratePatient(row) {
  const record = parse(row.record_json);
  return { patientId: row.patient_id, firstName: row.first_name, lastName: row.last_name, dob: row.dob, ...record };
}

export function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

export function fiveMinuteUnits(start, end) {
  const units = [];
  let t = Math.floor(new Date(start).getTime() / 300_000) * 300_000;
  const until = new Date(end).getTime();
  for (; t < until; t += 300_000) units.push(new Date(t).toISOString());
  return units;
}

// node:sqlite rejects undefined (and older releases reject booleans); better-sqlite3 rejects booleans.
function bindable(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `h.${body}.${sig}`;
}

function verifyToken(token, secret) {
  const [, body, sig] = String(token).split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!timingSafeEqualString(sig, expected)) return null;
  try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
}

function timingSafeEqualString(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && createHash("sha256").update(aa).digest("hex") === createHash("sha256").update(bb).digest("hex");
}

function parse(json) { try { return JSON.parse(json ?? "{}"); } catch { return {}; } }
function providerIdByName(providers, name) { return providers?.find((p) => p.name === name)?.providerId ?? null; }
function addMinutesIso(start, minutes) { return new Date(new Date(start).getTime() + minutes * 60_000).toISOString(); }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS patients(
  patient_id TEXT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  dob TEXT,
  record_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS providers(
  provider_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  department TEXT,
  record_json TEXT
);
CREATE TABLE IF NOT EXISTS appointments(
  appointment_id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  department TEXT,
  location TEXT,
  visit_type TEXT,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  prep_code TEXT,
  status TEXT NOT NULL,
  cancel_reason TEXT,
  attended INTEGER,
  source TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS occupancy(
  provider_id TEXT NOT NULL,
  unit_start TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('hold','appointment')),
  ref TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY(provider_id, unit_start)
);
CREATE TABLE IF NOT EXISTS released_slots(
  appointment_id TEXT PRIMARY KEY,
  provider_id TEXT,
  location TEXT,
  start TEXT,
  end TEXT,
  reason TEXT,
  released_at TEXT
);
CREATE TABLE IF NOT EXISTS handoff_tokens(
  token_hash TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  correlation_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT
);
CREATE TABLE IF NOT EXISTS idempotency(
  key TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suppression(
  patient_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaign_attempts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  state TEXT NOT NULL,
  outcome TEXT,
  attempt INTEGER NOT NULL,
  next_attempt_at TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reschedule_requests(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appointments_start ON appointments(start);
CREATE INDEX IF NOT EXISTS idx_attempts_appointment ON campaign_attempts(appointment_id);
`;
