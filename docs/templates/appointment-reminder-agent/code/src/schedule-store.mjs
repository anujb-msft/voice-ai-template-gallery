/**
 * Shared Contoso Health schedule store.
 *
 * The appointment reminder sample owns this SQLite implementation and seed. The
 * appointment scheduling sample can copy this file verbatim and extend the
 * ScheduleAdapter with searchSlots/holdSlot/releaseHold/bookAppointment/
 * rescheduleAppointment/addWaitlist while keeping the same tables, occupancy
 * locking model, and handoff token contract.
 */
import Database from "better-sqlite3";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.mjs";

const STATUS_OPEN = new Set(["booked", "confirmed"]);

export class ScheduleAdapter {
  constructor({ dbPath = config.schedule.dbPath, seedPath = config.schedule.seedPath, now = () => new Date(config.demoNow), handoffTokenSecret = config.schedule.handoffTokenSecret, tokenTtlMs = config.schedule.handoffTokenTtlMs } = {}) {
    this.dbPath = dbPath;
    this.seedPath = seedPath;
    this.now = now;
    this.handoffTokenSecret = handoffTokenSecret;
    this.tokenTtlMs = tokenTtlMs;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.seedIfEmpty(seedPath);
  }

  static reset({ dbPath = config.schedule.dbPath } = {}) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(`${dbPath}${suffix}`); } catch {}
    }
  }

  seedIfEmpty(seedPath = this.seedPath) {
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM appointments").get().n;
    if (count > 0) return false;
    const seed = JSON.parse(readFileSync(seedPath, "utf8"));
    const tx = this.db.transaction(() => {
      const providerStmt = this.db.prepare(`INSERT INTO providers (provider_id, name, department, record_json) VALUES (?, ?, ?, ?)`);
      for (const p of seed.providers ?? []) providerStmt.run(p.providerId ?? p.provider_id, p.name, p.department ?? null, JSON.stringify(p.record ?? p.record_json ?? p));

      const patientStmt = this.db.prepare(`INSERT INTO patients (patient_id, first_name, last_name, dob, record_json) VALUES (?, ?, ?, ?, ?)`);
      for (const p of seed.patients ?? []) patientStmt.run(p.patientId ?? p.patient_id, p.firstName ?? p.first_name, p.lastName ?? p.last_name, p.dob, JSON.stringify(p));

      const apptStmt = this.db.prepare(`INSERT INTO appointments
        (appointment_id, patient_id, provider_id, department, location, visit_type, start, end, prep_code, status, cancel_reason, attended, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const a of seed.appointments ?? []) {
        const id = a.appointmentId ?? a.appointment_id;
        const providerId = a.providerId ?? a.provider_id ?? providerIdByName(seed.providers, a.provider);
        apptStmt.run(id, a.patientId ?? a.patient_id, providerId, a.department ?? null, a.location ?? null, a.visitType ?? a.visit_type ?? null, a.start, a.end ?? addMinutesIso(a.start, 15), a.prepCode ?? a.prep_code ?? null, a.status ?? "booked", a.cancelReason ?? a.cancel_reason ?? null, a.attended == null ? null : Number(a.attended), a.source ?? "seed", new Date().toISOString());
        if (STATUS_OPEN.has(a.status ?? "booked") && new Date(a.end ?? a.start) > this.now()) {
          this.#writeOccupancy(providerId, a.start, a.end ?? addMinutesIso(a.start, 15), "appointment", id);
        }
      }
    });
    tx();
    return true;
  }

  getAppointment(appointmentId) {
    const row = this.db.prepare(`SELECT * FROM appointments WHERE appointment_id = ?`).get(appointmentId);
    return row ? this.#hydrateAppointment(row) : null;
  }

  getPatient(patientId) {
    const row = this.db.prepare(`SELECT * FROM patients WHERE patient_id = ?`).get(patientId);
    return row ? hydratePatient(row) : null;
  }

  getProvider(providerId) {
    const row = this.db.prepare(`SELECT * FROM providers WHERE provider_id = ?`).get(providerId);
    return row ? { providerId: row.provider_id, name: row.name, department: row.department, record: parse(row.record_json) } : null;
  }

  listUpcoming({ patientId = null, from = this.now().toISOString(), to = null, statuses = ["booked", "confirmed"] } = {}) {
    const clauses = ["datetime(start) >= datetime(@from)"];
    const params = { from, to, patientId };
    if (to) clauses.push("datetime(start) <= datetime(@to)");
    if (patientId) clauses.push("patient_id = @patientId");
    if (statuses?.length) clauses.push(`status IN (${statuses.map((_, i) => `@s${i}`).join(",")})`);
    statuses?.forEach((s, i) => (params[`s${i}`] = s));
    return this.db.prepare(`SELECT * FROM appointments WHERE ${clauses.join(" AND ")} ORDER BY datetime(start)`).all(params).map((r) => this.#hydrateAppointment(r));
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
      this.db.prepare(`UPDATE appointments SET status = 'confirmed', updated_at = ? WHERE appointment_id = ?`).run(new Date().toISOString(), appointmentId);
      return { ok: true, action: "confirm", appointment: this.getAppointment(appointmentId) };
    });
  }

  cancelAppointment(appointmentId, reasonCode = "patient_requested", idempotencyKey = `cancel:${appointmentId}:${reasonCode}`) {
    return this.#idempotent(idempotencyKey, () => {
      const appt = this.getAppointment(appointmentId);
      if (!appt) throw new Error(`unknown appointment ${appointmentId}`);
      const releasedAt = new Date().toISOString();
      const tx = this.db.transaction(() => {
        this.db.prepare(`UPDATE appointments SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE appointment_id = ?`).run(reasonCode, releasedAt, appointmentId);
        this.db.prepare(`INSERT OR REPLACE INTO released_slots (appointment_id, provider_id, location, start, end, reason, released_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(appointmentId, appt.providerId, appt.location, appt.start, appt.end, reasonCode, releasedAt);
        this.db.prepare(`DELETE FROM occupancy WHERE kind = 'appointment' AND ref = ?`).run(appointmentId);
      });
      tx();
      return { ok: true, action: "cancel", appointment: this.getAppointment(appointmentId), releasedSlot: { appointmentId, providerId: appt.providerId, location: appt.location, start: appt.start, end: appt.end, reason: reasonCode, releasedAt } };
    });
  }

  requestReschedule(appointmentId, idempotencyKey = `reschedule:${appointmentId}`) {
    return this.#idempotent(idempotencyKey, () => {
      const appt = this.getAppointment(appointmentId);
      if (!appt) throw new Error(`unknown appointment ${appointmentId}`);
      this.db.prepare(`INSERT INTO reschedule_requests (appointment_id, patient_id, status, created_at) VALUES (?, ?, 'requested', ?)`)
        .run(appointmentId, appt.patientId, new Date().toISOString());
      return { ok: true, action: "request_reschedule", appointment: appt };
    });
  }

  issueHandoffToken({ appointmentId, patientId, correlationId }) {
    const appt = this.getAppointment(appointmentId);
    if (!appt || appt.patientId !== patientId) throw new Error("handoff appointment/patient mismatch");
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this.tokenTtlMs).toISOString();
    const random = randomBytes(24).toString("base64url");
    const token = this.handoffTokenSecret
      ? signToken({ appointmentId, patientId, correlationId, exp: Date.parse(expiresAt), nonce: random }, this.handoffTokenSecret)
      : random;
    const tokenHash = sha256(token);
    this.db.prepare(`INSERT INTO handoff_tokens (token_hash, appointment_id, patient_id, correlation_id, created_at, expires_at, redeemed_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`)
      .run(tokenHash, appointmentId, patientId, correlationId ?? null, createdAt, expiresAt);
    return { token, expiresAt, appointmentId };
  }

  redeemHandoffToken({ token, correlationId }) {
    const tokenHash = sha256(token);
    let row = this.db.prepare(`SELECT * FROM handoff_tokens WHERE token_hash = ?`).get(tokenHash);
    let payload = null;
    if (!row && this.handoffTokenSecret) payload = verifyToken(token, this.handoffTokenSecret);
    if (!row && !payload) return { ok: false, reason: "invalid" };
    const now = new Date();
    if (row) {
      if (row.redeemed_at) return { ok: false, reason: "used" };
      if (new Date(row.expires_at) <= now) return { ok: false, reason: "expired" };
      if (row.correlation_id && correlationId && row.correlation_id !== correlationId) return { ok: false, reason: "wrong_call" };
      this.db.prepare(`UPDATE handoff_tokens SET redeemed_at = ? WHERE token_hash = ?`).run(now.toISOString(), tokenHash);
      return { ok: true, appointment: this.getAppointment(row.appointment_id), patient: this.getPatient(row.patient_id) };
    }
    if (payload.exp <= now.getTime()) return { ok: false, reason: "expired" };
    if (payload.correlationId && correlationId && payload.correlationId !== correlationId) return { ok: false, reason: "wrong_call" };
    return { ok: true, appointment: this.getAppointment(payload.appointmentId), patient: this.getPatient(payload.patientId), stateless: true };
  }

  suppressPatient(patientId, reason = "opt_out") {
    this.db.prepare(`INSERT OR REPLACE INTO suppression (patient_id, reason, created_at) VALUES (?, ?, ?)`)
      .run(patientId, reason, new Date().toISOString());
    return { ok: true };
  }

  isSuppressed(patientId) {
    return Boolean(this.db.prepare(`SELECT 1 FROM suppression WHERE patient_id = ?`).get(patientId));
  }

  recordAttempt({ appointmentId, patientId, state, outcome = null, attempt = 1, nextAttemptAt = null, detail = null }) {
    this.db.prepare(`INSERT INTO campaign_attempts (appointment_id, patient_id, state, outcome, attempt, next_attempt_at, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(appointmentId, patientId, state, outcome, attempt, nextAttemptAt, detail, new Date().toISOString());
  }

  attemptsFor(appointmentId) {
    return this.db.prepare(`SELECT * FROM campaign_attempts WHERE appointment_id = ? ORDER BY id`).all(appointmentId);
  }

  stats() {
    const scalar = (sql) => this.db.prepare(sql).get().n;
    const grouped = (sql) => Object.fromEntries(this.db.prepare(sql).all().map((r) => [r.k, r.n]));
    return {
      appointments: scalar(`SELECT COUNT(*) AS n FROM appointments`),
      upcomingOpen: scalar(`SELECT COUNT(*) AS n FROM appointments WHERE status IN ('booked','confirmed') AND datetime(start) >= datetime('now')`),
      releasedSlots: scalar(`SELECT COUNT(*) AS n FROM released_slots`),
      optOuts: scalar(`SELECT COUNT(*) AS n FROM suppression`),
      attempts: scalar(`SELECT COUNT(*) AS n FROM campaign_attempts`),
      outcomes: grouped(`SELECT COALESCE(outcome, state) AS k, COUNT(*) AS n FROM campaign_attempts GROUP BY k`),
      noShowComparison: this.#noShowComparison(),
    };
  }

  close() { this.db.close(); }

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

  #writeOccupancy(providerId, start, end, kind, ref, expiresAt = null) {
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO occupancy (provider_id, unit_start, kind, ref, expires_at) VALUES (?, ?, ?, ?, ?)`);
    for (const unit of fiveMinuteUnits(start, end)) stmt.run(providerId, unit, kind, ref, expiresAt);
  }

  #idempotent(key, fn) {
    const existing = this.db.prepare(`SELECT result_json FROM idempotency WHERE key = ?`).get(key);
    if (existing) return parse(existing.result_json);
    const result = fn();
    this.db.prepare(`INSERT INTO idempotency (key, result_json, created_at) VALUES (?, ?, ?)`)
      .run(key, JSON.stringify(result), new Date().toISOString());
    return result;
  }

  #noShowComparison() {
    const rows = this.db.prepare(`SELECT status, attended FROM appointments WHERE attended IS NOT NULL`).all();
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
