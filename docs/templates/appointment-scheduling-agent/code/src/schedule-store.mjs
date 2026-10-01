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
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { config, fixtures } from "./config.mjs";

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

  searchSlots({ patientId = null, visitTypeCode, preferences = {}, from = this.now().toISOString(), to = null, limit = config.schedule.optionsPerTurn } = {}) {
    this.#releaseExpiredHolds();
    const visit = fixtures.visitTypes[visitTypeCode];
    if (!visit) throw new Error(`unknown visit type ${visitTypeCode}`);
    const patient = patientId ? this.getPatient(patientId) : null;
    const horizon = to ? new Date(to) : new Date(this.now().getTime() + config.schedule.searchHorizonDays * 86_400_000);
    const providers = providerTemplates()
      .filter((p) => p.department === visit.department)
      .filter((p) => visit.eligibleProviderRoles.includes(p.role))
      .filter((p) => !preferences.providerId || p.providerId === preferences.providerId)
      .filter((p) => preferences.usualDoctor ? p.providerId === patient?.pcpProviderId : true)
      .filter((p) => !preferences.location || p.locations.includes(preferences.location))
      .filter((p) => patient && ageOn(patient.dob, this.now()) < 18 ? p.pediatrics : true);

    const slots = [];
    const cursor = startOfDay(new Date(from));
    for (let day = new Date(cursor); day <= horizon && slots.length < limit + 20; day = addDays(day, 1)) {
      const dateKey = isoDate(day);
      for (const p of providers) {
        for (const block of p.weeklyTemplate ?? []) {
          if (!block.days.includes(day.getDay()) || !block.visitTypes.includes(visitTypeCode)) continue;
          const location = block.location ?? p.locations[0];
          if (isClinicHoliday(location, dateKey) || (preferences.location && preferences.location !== location)) continue;
          for (let startMin = toMinutes(block.start); startMin + visit.durationMinutes <= toMinutes(block.end); startMin += 5) {
            const endMin = startMin + visit.durationMinutes;
            if (insideAnyBreak(startMin, endMin, block.breaks ?? [])) continue;
            if (preferences.timeOfDay === "morning" && startMin >= 12 * 60) continue;
            if (preferences.timeOfDay === "afternoon" && startMin < 12 * 60) continue;
            const startIso = withOffset(dateKey, startMin);
            const endIso = withOffset(dateKey, endMin);
            if (new Date(startIso) < new Date(from)) continue;
            if (!this.#unitsAvailable(p.providerId, startIso, endIso)) continue;
            const released = Boolean(this.db.prepare(`SELECT 1 FROM released_slots WHERE provider_id = ? AND start = ?`).get(p.providerId, startIso));
            slots.push(makeSlot({ providerId: p.providerId, providerName: p.spokenName, location, visitTypeCode, durationMinutes: visit.durationMinutes, prepCode: visit.prepCode, department: visit.department, start: startIso, end: endIso, released, patientId }));
          }
        }
      }
    }
    slots.sort((a, b) => new Date(a.start) - new Date(b.start) || a.providerName.localeCompare(b.providerName));
    return { ok: true, options: slots.slice(0, limit), moreAvailable: slots.length > limit, releasedSlots: slots.filter((s) => s.released).length };
  }

  holdSlot(optionOrId, { patientId = null, ttlMs = config.schedule.holdTtlMs, idempotencyKey = null } = {}) {
    this.#releaseExpiredHolds();
    const option = typeof optionOrId === "string" ? decodeSlot(optionOrId) : optionOrId;
    if (!option?.providerId || !option.start || !option.end) return { ok: false, error: "invalid_slot" };
    if (idempotencyKey) {
      const existing = this.db.prepare(`SELECT result_json FROM idempotency WHERE key = ?`).get(idempotencyKey);
      if (existing) return parse(existing.result_json);
    }
    const holdId = randomUUID();
    const expiresAt = new Date(this.now().getTime() + ttlMs).toISOString();
    const units = fiveMinuteUnits(option.start, option.end);
    const tx = this.db.transaction(() => {
      const stmt = this.db.prepare(`INSERT OR IGNORE INTO occupancy (provider_id, unit_start, kind, ref, expires_at) VALUES (?, ?, 'hold', ?, ?)`);
      let inserted = 0;
      for (const unit of units) inserted += stmt.run(option.providerId, unit, holdId, expiresAt).changes;
      if (inserted !== units.length) {
        this.db.prepare(`DELETE FROM occupancy WHERE kind = 'hold' AND ref = ?`).run(holdId);
        return null;
      }
      this.db.prepare(`INSERT INTO holds (hold_id, patient_id, provider_id, location, visit_type, department, start, end, prep_code, expires_at, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?)`)
        .run(holdId, patientId ?? option.patientId ?? null, option.providerId, option.location, option.visitTypeCode, option.department, option.start, option.end, option.prepCode, expiresAt, new Date().toISOString());
      return { ok: true, holdId, expiresAt, slot: option, readBack: readBack(option) };
    });
    const result = tx() ?? { ok: false, error: "slot_taken" };
    if (idempotencyKey) this.db.prepare(`INSERT OR REPLACE INTO idempotency (key, result_json, created_at) VALUES (?, ?, ?)`).run(idempotencyKey, JSON.stringify(result), new Date().toISOString());
    return result;
  }

  releaseHold(holdId) {
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE holds SET status = 'released' WHERE hold_id = ? AND status = 'held'`).run(holdId);
      this.db.prepare(`DELETE FROM occupancy WHERE kind = 'hold' AND ref = ?`).run(holdId);
    });
    tx();
    return { ok: true, holdId };
  }

  bookAppointment({ holdId, patientId, reason = null, idempotencyKey = `book:${holdId}` } = {}) {
    return this.#idempotent(idempotencyKey, () => this.#bookHeldAppointment({ holdId, patientId, reason, source: "voice" }));
  }

  rescheduleAppointment({ appointmentId, holdId, patientId = null, reason = null, idempotencyKey = `reschedule:${appointmentId}:${holdId}` } = {}) {
    return this.#idempotent(idempotencyKey, () => {
      const original = this.getAppointment(appointmentId);
      if (!original) return { ok: false, error: "unknown_appointment" };
      const expectedPatient = patientId ?? original.patientId;
      if (original.patientId !== expectedPatient) return { ok: false, error: "patient_mismatch" };
      const now = new Date().toISOString();
      const tx = this.db.transaction(() => {
        const booked = this.#bookHeldAppointment({ holdId, patientId: expectedPatient, reason, source: "reschedule", skipCleanup: true });
        if (!booked.ok) return booked;
        this.db.prepare(`UPDATE appointments SET status = 'cancelled', cancel_reason = 'rescheduled', updated_at = ? WHERE appointment_id = ?`).run(now, appointmentId);
        this.db.prepare(`INSERT OR REPLACE INTO released_slots (appointment_id, provider_id, location, start, end, reason, released_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(appointmentId, original.providerId, original.location, original.start, original.end, "rescheduled", now);
        this.db.prepare(`DELETE FROM occupancy WHERE kind = 'appointment' AND ref = ?`).run(appointmentId);
        return { ok: true, action: "reschedule", oldAppointment: this.getAppointment(appointmentId), appointment: booked.appointment, releasedSlot: { appointmentId, providerId: original.providerId, location: original.location, start: original.start, end: original.end, reason: "rescheduled", releasedAt: now } };
      });
      return tx();
    });
  }

  addWaitlist({ patientId, visitTypeCode, preferences = {}, reason = null } = {}) {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare(`INSERT INTO waitlist (patient_id, visit_type, preferences_json, reason, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)`)
      .run(patientId, visitTypeCode, JSON.stringify(preferences), reason, createdAt);
    return { ok: true, waitlistId: result.lastInsertRowid, patientId, visitTypeCode, createdAt };
  }

  issueHandoffToken({ appointmentId, patientId, correlationId }) {
    const appt = this.getAppointment(appointmentId);
    if (!appt || appt.patientId !== patientId) throw new Error("handoff appointment/patient mismatch");
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(this.now().getTime() + this.tokenTtlMs).toISOString();
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
    const now = this.now();
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
      upcomingOpen: this.db.prepare(`SELECT COUNT(*) AS n FROM appointments WHERE status IN ('booked','confirmed') AND datetime(start) >= datetime(?)`).get(this.now().toISOString()).n,
      releasedSlots: scalar(`SELECT COUNT(*) AS n FROM released_slots`),
      optOuts: scalar(`SELECT COUNT(*) AS n FROM suppression`),
      attempts: scalar(`SELECT COUNT(*) AS n FROM campaign_attempts`),
      activeHolds: this.db.prepare(`SELECT COUNT(*) AS n FROM holds WHERE status = 'held' AND datetime(expires_at) > datetime(?)`).get(this.now().toISOString()).n,
      waitlist: scalar(`SELECT COUNT(*) AS n FROM waitlist WHERE status = 'open'`),
      bookingsByVoice: scalar(`SELECT COUNT(*) AS n FROM appointments WHERE source IN ('voice','reschedule')`),
      outcomes: grouped(`SELECT COALESCE(outcome, state) AS k, COUNT(*) AS n FROM campaign_attempts GROUP BY k`),
      noShowComparison: this.#noShowComparison(),
    };
  }

  close() { this.db.close(); }

  #bookHeldAppointment({ holdId, patientId, reason = null, source = "voice", skipCleanup = false } = {}) {
    if (!skipCleanup) this.#releaseExpiredHolds();
    const hold = this.db.prepare(`SELECT * FROM holds WHERE hold_id = ?`).get(holdId);
    if (!hold || hold.status !== "held") return { ok: false, error: "hold_not_found" };
    if (new Date(hold.expires_at) <= this.now()) {
      this.releaseHold(holdId);
      return { ok: false, error: "hold_expired" };
    }
    const appointmentId = `A-${randomBytes(4).toString("hex").toUpperCase()}`;
    const now = new Date().toISOString();
    const run = () => {
      const units = fiveMinuteUnits(hold.start, hold.end);
      const heldUnits = this.db.prepare(`SELECT COUNT(*) AS n FROM occupancy WHERE provider_id = ? AND kind = 'hold' AND ref = ?`).get(hold.provider_id, holdId).n;
      if (heldUnits !== units.length) return { ok: false, error: "slot_taken" };
      this.db.prepare(`INSERT INTO appointments (appointment_id, patient_id, provider_id, department, location, visit_type, start, end, prep_code, status, cancel_reason, attended, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', NULL, NULL, ?, ?)`)
        .run(appointmentId, patientId ?? hold.patient_id, hold.provider_id, hold.department, hold.location, hold.visit_type, hold.start, hold.end, hold.prep_code, source, now);
      this.db.prepare(`UPDATE holds SET status = 'booked' WHERE hold_id = ?`).run(holdId);
      this.db.prepare(`UPDATE occupancy SET kind = 'appointment', ref = ?, expires_at = NULL WHERE kind = 'hold' AND ref = ?`).run(appointmentId, holdId);
      if (reason) this.db.prepare(`INSERT INTO appointment_reasons (appointment_id, masked_reason, created_at) VALUES (?, ?, ?)`).run(appointmentId, maskReason(reason), now);
      return { ok: true, action: source === "reschedule" ? "reschedule_book" : "book", appointment: this.getAppointment(appointmentId) };
    };
    return run();
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

  #writeOccupancy(providerId, start, end, kind, ref, expiresAt = null) {
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO occupancy (provider_id, unit_start, kind, ref, expires_at) VALUES (?, ?, ?, ?, ?)`);
    for (const unit of fiveMinuteUnits(start, end)) stmt.run(providerId, unit, kind, ref, expiresAt);
  }

  #unitsAvailable(providerId, start, end) {
    const units = fiveMinuteUnits(start, end);
    if (!units.length) return false;
    const q = this.db.prepare(`SELECT 1 FROM occupancy WHERE provider_id = ? AND unit_start = ?`);
    return units.every((unit) => !q.get(providerId, unit));
  }

  #releaseExpiredHolds() {
    const expired = this.db.prepare(`SELECT hold_id FROM holds WHERE status = 'held' AND datetime(expires_at) <= datetime(?)`).all(this.now().toISOString());
    const tx = this.db.transaction(() => {
      for (const { hold_id } of expired) {
        this.db.prepare(`UPDATE holds SET status = 'expired' WHERE hold_id = ?`).run(hold_id);
        this.db.prepare(`DELETE FROM occupancy WHERE kind = 'hold' AND ref = ?`).run(hold_id);
      }
    });
    tx();
    return expired.length;
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
function providerTemplates() { return fixtures.providers.providers ?? []; }
function toMinutes(hhmm) { const [h, m = 0] = String(hhmm).split(":").map(Number); return h * 60 + m; }
function startOfDay(d) { const copy = new Date(d); copy.setHours(0, 0, 0, 0); return copy; }
function addDays(d, days) { const copy = new Date(d); copy.setDate(copy.getDate() + days); return copy; }
function isoDate(d) { return d.toISOString().slice(0, 10); }
function offset() { return "-07:00"; }
function withOffset(dateKey, minutes) { return `${dateKey}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00${offset()}`; }
function insideAnyBreak(startMin, endMin, breaks) { return breaks.some((b) => startMin < toMinutes(b.end) && endMin > toMinutes(b.start)); }
function isClinicHoliday(location, dateKey) { return (fixtures.clinics.locations[location]?.holidays ?? []).includes(dateKey); }
function ageOn(dob, now) { const b = new Date(dob); let age = now.getFullYear() - b.getFullYear(); const m = now.getMonth() - b.getMonth(); if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age -= 1; return age; }
function encodeSlot(slot) { return Buffer.from(JSON.stringify(slot)).toString("base64url"); }
function decodeSlot(id) { try { return JSON.parse(Buffer.from(String(id), "base64url").toString("utf8")); } catch { return null; } }
function makeSlot(slot) { const option = { ...slot }; option.optionId = encodeSlot(option); option.spoken = readBack(option).replace(/^a /, ""); return option; }
function readBack(slot) { return `a ${slot.visitTypeCode.replaceAll("_", " ").toLowerCase()} with ${slot.providerName} on ${spokenDateTime(slot.start)} at ${clinicName(slot.location)}`; }
function clinicName(location) { return fixtures.clinics.locations[location]?.displayName ?? location; }
function spokenDateTime(iso) { return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }).format(new Date(iso)); }
function maskReason(text) { return String(text ?? "").replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, "[name]").replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, "[date]").slice(0, 160); }

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
CREATE TABLE IF NOT EXISTS holds(
  hold_id TEXT PRIMARY KEY,
  patient_id TEXT,
  provider_id TEXT NOT NULL,
  location TEXT NOT NULL,
  visit_type TEXT NOT NULL,
  department TEXT,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  prep_code TEXT,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS waitlist(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id TEXT NOT NULL,
  visit_type TEXT NOT NULL,
  preferences_json TEXT,
  reason TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS appointment_reasons(
  appointment_id TEXT PRIMARY KEY,
  masked_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appointments_start ON appointments(start);
CREATE INDEX IF NOT EXISTS idx_attempts_appointment ON campaign_attempts(appointment_id);
CREATE INDEX IF NOT EXISTS idx_holds_status ON holds(status, expires_at);
`;
