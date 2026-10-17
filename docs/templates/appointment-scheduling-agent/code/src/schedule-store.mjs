/**
 * The Contoso Health schedule store: the demo's stand-in for a real EHR
 * scheduling API.
 *
 * It keeps the table layout, five-minute occupancy locking and handoff-token
 * contract of the appointment reminder sample, so the two samples can share
 * one database file. Every write goes through a hold:
 *
 *   searchSlots()      reads only.
 *   holdSlot()         reserves the five-minute units of one offered slot.
 *   bookAppointment()  turns that hold into an appointment only while every
 *                      unit is still the hold's own. If anyone else booked the
 *                      time in between, it returns slot_taken. It never books a
 *                      neighboring time instead.
 *
 * Time comes from the injected `now`, so the server's demo clock decides what
 * "today", "too soon" and "the next opening" mean.
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { config, fixtures, nowDate } from "./config.mjs";
import { isMemoryPath, openDatabase } from "./sqlite.mjs";

const STATUS_OPEN = new Set(["booked", "confirmed"]);
const UNIT_MS = 300_000;
const STEP_MINUTES = 15;
const DAY_MS = 86_400_000;
/** The seeded patient the demo's "front desk" books for when it takes a slot. */
const FRONT_DESK_PATIENT = "P-1011";
const TABLES = [
  "appointment_reasons", "waitlist", "holds", "reschedule_requests", "campaign_attempts", "suppression",
  "idempotency", "handoff_tokens", "released_slots", "occupancy", "appointments", "providers", "patients",
];

export class ScheduleAdapter {
  /** Opens (or creates) the database, preferring better-sqlite3, and seeds it on first use. */
  static async open({ dbPath = config.schedule.dbPath, driver = "auto", log, ...options } = {}) {
    const db = await openDatabase(dbPath, { driver, log });
    return new ScheduleAdapter({ ...options, db, dbPath });
  }

  constructor({
    db,
    dbPath = ":memory:",
    seedPath = config.schedule.seedPath,
    now = () => nowDate(),
    handoffTokenSecret = config.schedule.handoffTokenSecret,
    tokenTtlMs = config.schedule.handoffTokenTtlMs,
    minLeadMinutes = config.schedule.minLeadMinutes,
  } = {}) {
    if (!db) throw new Error("ScheduleAdapter needs a database: use await ScheduleAdapter.open({ dbPath })");
    this.db = db;
    this.dbPath = dbPath;
    this.seedPath = seedPath;
    this.now = now;
    this.handoffTokenSecret = handoffTokenSecret;
    this.tokenTtlMs = tokenTtlMs;
    this.minLeadMinutes = minLeadMinutes;
    if (!isMemoryPath(dbPath)) this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.seedIfEmpty(seedPath);
  }

  get driver() {
    return this.db.driver;
  }

  static reset({ dbPath = config.schedule.dbPath } = {}) {
    if (isMemoryPath(dbPath)) return;
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(`${dbPath}${suffix}`); } catch {}
    }
  }

  seedIfEmpty(seedPath = this.seedPath) {
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM appointments").get().n;
    if (count > 0) return false;
    const seed = JSON.parse(readFileSync(seedPath, "utf8"));
    this.db.transaction(() => {
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
        const end = a.end ?? addMinutesIso(a.start, 15);
        apptStmt.run(id, a.patientId ?? a.patient_id, providerId, a.department ?? null, a.location ?? null, a.visitType ?? a.visit_type ?? null, a.start, end, a.prepCode ?? a.prep_code ?? null, a.status ?? "booked", a.cancelReason ?? a.cancel_reason ?? null, a.attended == null ? null : Number(a.attended), a.source ?? "seed", new Date().toISOString());
        // Every open appointment occupies its time, past or future, so moving the demo clock never frees one.
        if (STATUS_OPEN.has(a.status ?? "booked")) this.#writeOccupancy(providerId, a.start, end, "appointment", id);
      }
    })();
    return true;
  }

  /** Back to the seeded schedule, so every demo run starts from the same day. */
  reseed() {
    this.db.transaction(() => {
      for (const table of TABLES) this.db.exec(`DELETE FROM ${table}`);
      try { this.db.exec("DELETE FROM sqlite_sequence"); } catch {}
    })();
    this.seedIfEmpty();
  }

  getAppointment(appointmentId) {
    const row = this.db.prepare(`SELECT * FROM appointments WHERE appointment_id = ?`).get(appointmentId);
    return row ? this.#hydrateAppointment(row) : null;
  }

  getPatient(patientId) {
    const row = this.db.prepare(`SELECT * FROM patients WHERE patient_id = ?`).get(patientId);
    return row ? hydratePatient(row) : null;
  }

  listPatients() {
    return this.db.prepare(`SELECT * FROM patients ORDER BY patient_id`).all().map(hydratePatient);
  }

  getProvider(providerId) {
    const row = this.db.prepare(`SELECT * FROM providers WHERE provider_id = ?`).get(providerId);
    return row ? { providerId: row.provider_id, name: row.name, department: row.department, record: parse(row.record_json) } : null;
  }

  listUpcoming({ patientId = null, from = this.now().toISOString(), to = null, statuses = ["booked", "confirmed"] } = {}) {
    const clauses = ["datetime(start) >= datetime(@from)"];
    const params = { from };
    if (to) {
      clauses.push("datetime(start) <= datetime(@to)");
      params.to = to;
    }
    if (patientId) {
      clauses.push("patient_id = @patientId");
      params.patientId = patientId;
    }
    if (statuses?.length) {
      clauses.push(`status IN (${statuses.map((_, i) => `@s${i}`).join(",")})`);
      statuses.forEach((s, i) => (params[`s${i}`] = s));
    }
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
      this.db.transaction(() => {
        this.db.prepare(`UPDATE appointments SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE appointment_id = ?`).run(reasonCode, releasedAt, appointmentId);
        this.db.prepare(`INSERT OR REPLACE INTO released_slots (appointment_id, provider_id, location, start, end, reason, released_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(appointmentId, appt.providerId, appt.location, appt.start, appt.end, reasonCode, releasedAt);
        this.db.prepare(`DELETE FROM occupancy WHERE kind = 'appointment' AND ref = ?`).run(appointmentId);
      })();
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

  /**
   * Openings for one visit type, read from the providers' weekly templates
   * minus everything occupied. Each clinic's own time zone decides the wall
   * clock; holidays, breaks and the minimum lead time are skipped. Options are
   * spread across days first (the earliest opening on each day), so a caller
   * hears a real choice rather than two back-to-back times.
   */
  searchSlots({ patientId = null, visitTypeCode, preferences = {}, from = null, to = null, limit = config.schedule.optionsPerTurn, exclude = [] } = {}) {
    this.#releaseExpiredHolds();
    const visit = fixtures.visitTypes[visitTypeCode];
    if (!visit) return { ok: false, error: "unknown_visit_type", options: [], moreAvailable: false, releasedSlots: 0 };
    const now = this.now();
    const prefs = preferences ?? {};
    const patient = patientId ? this.getPatient(patientId) : null;
    const earliest = Math.max(from ? Date.parse(from) || 0 : 0, now.getTime() + this.minLeadMinutes * 60_000);
    const horizon = to ? Date.parse(to) : now.getTime() + config.schedule.searchHorizonDays * DAY_MS;
    const providers = providerTemplates()
      .filter((p) => p.department === visit.department && visit.eligibleProviderRoles.includes(p.role))
      .filter((p) => !prefs.providerId || p.providerId === prefs.providerId)
      .filter((p) => !prefs.usualDoctor || p.providerId === patient?.pcpProviderId)
      .filter((p) => !prefs.location || p.locations.includes(prefs.location))
      .filter((p) => !patient || ageOn(patient.dob, now) >= 18 || p.pediatrics);

    const busy = this.#busyUnits();
    const released = new Set(this.db.prepare(`SELECT provider_id, start FROM released_slots`).all().map((r) => `${r.provider_id}|${Date.parse(r.start)}`));
    const skip = new Set(exclude ?? []);
    const found = [];
    const days = new Set();
    // Start a day early: a clinic's local date can trail the UTC date.
    for (let dayMs = Math.floor(earliest / DAY_MS) * DAY_MS - DAY_MS; dayMs <= horizon + DAY_MS; dayMs += DAY_MS) {
      const dateKey = new Date(dayMs).toISOString().slice(0, 10);
      const weekday = new Date(dayMs).getUTCDay();
      if (prefs.date && prefs.date !== dateKey) continue;
      if (prefs.weekday != null && Number(prefs.weekday) !== weekday) continue;
      for (const provider of providers) {
        for (const block of provider.weeklyTemplate ?? []) {
          if (!block.days.includes(weekday) || !block.visitTypes.includes(visitTypeCode)) continue;
          const location = block.location ?? provider.locations[0];
          if ((prefs.location && prefs.location !== location) || isClinicHoliday(location, dateKey)) continue;
          const timeZone = clinicTimeZone(location);
          for (let m = toMinutes(block.start); m + visit.durationMinutes <= toMinutes(block.end); m += STEP_MINUTES) {
            const endMin = m + visit.durationMinutes;
            if (insideAnyBreak(m, endMin, block.breaks ?? [])) continue;
            if (prefs.timeOfDay === "morning" && m >= 12 * 60) continue;
            if (prefs.timeOfDay === "afternoon" && m < 12 * 60) continue;
            const startMs = wallTimeToMs(dateKey, m, timeZone);
            if (startMs < earliest || startMs > horizon) continue;
            if (skip.has(`${provider.providerId}|${startMs}`)) continue;
            const start = isoInZone(startMs, timeZone);
            const end = isoInZone(startMs + visit.durationMinutes * 60_000, timeZone);
            if (!unitsFree(busy, provider.providerId, start, end)) continue;
            found.push(makeSlot({ provider, location, visitTypeCode, start, end, released: released.has(`${provider.providerId}|${startMs}`) }));
            days.add(dateKey);
          }
        }
      }
      if (days.size >= limit && found.length > limit) break;
    }

    found.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.providerName.localeCompare(b.providerName));
    const picks = [];
    const seenDays = new Set();
    for (const slot of found) {
      if (picks.length >= limit) break;
      if (seenDays.has(slot.dateKey)) continue;
      seenDays.add(slot.dateKey);
      picks.push(slot);
    }
    for (const slot of found) {
      if (picks.length >= limit) break;
      if (!picks.includes(slot)) picks.push(slot);
    }
    picks.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const options = picks.map((slot) => ({ ...slot, spoken: spokenWhen(slot.start, slot.timeZone, now) }));
    return { ok: true, options, moreAvailable: found.length > picks.length, releasedSlots: options.filter((o) => o.released).length };
  }

  holdSlot(optionOrId, { patientId = null, ttlMs = config.schedule.holdTtlMs, idempotencyKey = null } = {}) {
    this.#releaseExpiredHolds();
    const option = typeof optionOrId === "string" ? decodeSlot(optionOrId) : optionOrId;
    if (!option?.providerId || !option.start || !option.end) return { ok: false, error: "invalid_slot" };
    if (idempotencyKey) {
      // A retried hold gets the same hold back, but only while it is still held.
      const cached = this.db.prepare(`SELECT result_json FROM idempotency WHERE key = ?`).get(idempotencyKey);
      const previous = cached ? parse(cached.result_json) : null;
      if (previous?.ok && this.#holdStatus(previous.holdId) === "held") return previous;
    }
    const holdId = randomUUID();
    const expiresAt = new Date(this.now().getTime() + ttlMs).toISOString();
    const units = fiveMinuteUnits(option.start, option.end);
    const result = this.db.transaction(() => {
      const stmt = this.db.prepare(`INSERT OR IGNORE INTO occupancy (provider_id, unit_start, kind, ref, expires_at) VALUES (?, ?, 'hold', ?, ?)`);
      let inserted = 0;
      for (const unit of units) inserted += Number(stmt.run(option.providerId, unit, holdId, expiresAt).changes);
      if (inserted !== units.length) {
        this.db.prepare(`DELETE FROM occupancy WHERE kind = 'hold' AND ref = ?`).run(holdId);
        return { ok: false, error: "slot_taken" };
      }
      this.db.prepare(`INSERT INTO holds (hold_id, patient_id, provider_id, location, visit_type, department, start, end, prep_code, expires_at, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?)`)
        .run(holdId, patientId ?? option.patientId ?? null, option.providerId, option.location, option.visitTypeCode, option.department ?? null, option.start, option.end, option.prepCode ?? null, expiresAt, new Date().toISOString());
      return { ok: true, holdId, expiresAt, slot: option, readBack: option.readBack ?? readBack(option) };
    })();
    if (idempotencyKey && result.ok) {
      this.db.prepare(`INSERT OR REPLACE INTO idempotency (key, result_json, created_at) VALUES (?, ?, ?)`).run(idempotencyKey, JSON.stringify(result), new Date().toISOString());
    }
    return result;
  }

  releaseHold(holdId) {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE holds SET status = 'released' WHERE hold_id = ? AND status = 'held'`).run(holdId);
      this.db.prepare(`DELETE FROM occupancy WHERE kind = 'hold' AND ref = ?`).run(holdId);
    })();
    return { ok: true, holdId };
  }

  /** One more hold period, e.g. while a scheduler picks up a transferred call. */
  extendHold(holdId, ttlMs = config.schedule.holdTtlMs) {
    this.#releaseExpiredHolds();
    if (this.#holdStatus(holdId) !== "held") return { ok: false, error: "hold_not_found" };
    const expiresAt = new Date(this.now().getTime() + ttlMs).toISOString();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE holds SET expires_at = ? WHERE hold_id = ? AND status = 'held'`).run(expiresAt, holdId);
      this.db.prepare(`UPDATE occupancy SET expires_at = ? WHERE kind = 'hold' AND ref = ?`).run(expiresAt, holdId);
    })();
    return { ok: true, holdId, expiresAt };
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
      return this.db.transaction(() => {
        const booked = this.#bookHeldAppointment({ holdId, patientId: expectedPatient, reason, source: "reschedule", skipCleanup: true });
        if (!booked.ok) return booked;
        this.db.prepare(`UPDATE appointments SET status = 'cancelled', cancel_reason = 'rescheduled', updated_at = ? WHERE appointment_id = ?`).run(now, appointmentId);
        this.db.prepare(`INSERT OR REPLACE INTO released_slots (appointment_id, provider_id, location, start, end, reason, released_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(appointmentId, original.providerId, original.location, original.start, original.end, "rescheduled", now);
        this.db.prepare(`DELETE FROM occupancy WHERE kind = 'appointment' AND ref = ?`).run(appointmentId);
        return { ok: true, action: "reschedule", oldAppointment: this.getAppointment(appointmentId), appointment: booked.appointment, releasedSlot: { appointmentId, providerId: original.providerId, location: original.location, start: original.start, end: original.end, reason: "rescheduled", releasedAt: now } };
      })();
    });
  }

  /**
   * Demo only (the server allows it in simulation mode): another booking
   * channel, the front desk, books a time out from under a caller. Given the
   * caller's hold, the hold's units become the front desk's appointment and the
   * hold itself stays 'held', just as if a system that ignores holds had
   * written first. The caller's yes then comes back slot_taken.
   */
  takeSlot({ holdId = null, option = null, patientId = FRONT_DESK_PATIENT, source = "front_desk" } = {}) {
    this.#releaseExpiredHolds();
    const hold = holdId ? this.db.prepare(`SELECT * FROM holds WHERE hold_id = ? AND status = 'held'`).get(holdId) : null;
    const slot = hold
      ? { providerId: hold.provider_id, location: hold.location, visitTypeCode: hold.visit_type, department: hold.department, start: hold.start, end: hold.end, prepCode: hold.prep_code }
      : typeof option === "string" ? decodeSlot(option) : option;
    if (!slot?.providerId || !slot.start || !slot.end) return { ok: false, error: "nothing_to_take" };
    try {
      return this.db.transaction(() => {
        if (hold) this.db.prepare(`DELETE FROM occupancy WHERE kind = 'hold' AND ref = ?`).run(holdId);
        const appointmentId = this.#nextAppointmentId();
        const units = fiveMinuteUnits(slot.start, slot.end);
        const stmt = this.db.prepare(`INSERT OR IGNORE INTO occupancy (provider_id, unit_start, kind, ref, expires_at) VALUES (?, ?, 'appointment', ?, NULL)`);
        let inserted = 0;
        for (const unit of units) inserted += Number(stmt.run(slot.providerId, unit, appointmentId).changes);
        if (inserted !== units.length) throw new Error("slot_taken");
        this.db.prepare(`INSERT INTO appointments (appointment_id, patient_id, provider_id, department, location, visit_type, start, end, prep_code, status, cancel_reason, attended, source, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', NULL, NULL, ?, ?)`)
          .run(appointmentId, patientId, slot.providerId, slot.department ?? null, slot.location ?? null, slot.visitTypeCode ?? null, slot.start, slot.end, slot.prepCode ?? null, source, new Date().toISOString());
        return { ok: true, appointmentId, providerId: slot.providerId, start: slot.start, end: slot.end, source };
      })();
    } catch (error) {
      if (error.message === "slot_taken") return { ok: false, error: "slot_taken" };
      throw error;
    }
  }

  /**
   * One provider's next working days in 15-minute cells, for the console's
   * availability grid. Cells say only free, booked, held, break, holiday, past
   * or closed — never who the appointment is for.
   */
  grid({ providerId = "prov-patel", days = 5, startHour = 8, endHour = 17 } = {}) {
    this.#releaseExpiredHolds();
    const provider = providerTemplates().find((p) => p.providerId === providerId);
    if (!provider) return { ok: false, error: "unknown_provider" };
    const location = provider.locations[0];
    const timeZone = clinicTimeZone(location);
    const nowMs = this.now().getTime();
    const earliest = nowMs + this.minLeadMinutes * 60_000;
    const busy = this.#busyUnits();
    const sources = new Map(this.db.prepare(`SELECT appointment_id, source FROM appointments`).all().map((r) => [r.appointment_id, r.source]));
    const today = zonedDateKey(nowMs, timeZone);
    const rows = [];
    for (let i = 0, dateKey = today; rows.length < days && i < 60; i += 1, dateKey = addDaysKey(dateKey, 1)) {
      const blocks = (provider.weeklyTemplate ?? []).filter((b) => b.days.includes(weekdayOf(dateKey)));
      if (!blocks.length) continue;
      const holiday = isClinicHoliday(blocks[0].location ?? location, dateKey);
      const cells = [];
      for (let m = startHour * 60; m < endHour * 60; m += STEP_MINUTES) {
        const startMs = wallTimeToMs(dateKey, m, timeZone);
        const start = isoInZone(startMs, timeZone);
        const block = blocks.find((b) => m >= toMinutes(b.start) && m + STEP_MINUTES <= toMinutes(b.end));
        const cell = { start, time: hhmm(m), state: "closed" };
        if (block && holiday) cell.state = "holiday";
        else if (block && insideAnyBreak(m, m + STEP_MINUTES, block.breaks ?? [])) cell.state = "break";
        else if (block) {
          const hit = fiveMinuteUnits(start, isoInZone(startMs + STEP_MINUTES * 60_000, timeZone))
            .map((unit) => busy.get(`${providerId}|${unit}`))
            .find(Boolean);
          if (hit?.kind === "hold") Object.assign(cell, { state: "held", ref: hit.ref });
          else if (hit) Object.assign(cell, { state: "booked", ref: hit.ref, source: sources.get(hit.ref) ?? null });
          else cell.state = startMs < earliest ? "past" : "free";
        }
        cells.push(cell);
      }
      rows.push({ dateKey, label: dayLabel(dateKey), today: dateKey === today, holiday, cells });
    }
    return {
      ok: true,
      providerId,
      providerName: provider.spokenName,
      location,
      locationName: clinicName(location),
      timeZone,
      stepMinutes: STEP_MINUTES,
      startHour,
      endHour,
      now: new Date(nowMs).toISOString(),
      earliest: new Date(earliest).toISOString(),
      minLeadMinutes: this.minLeadMinutes,
      rows,
    };
  }

  addWaitlist({ patientId, visitTypeCode, preferences = {}, reason = null } = {}) {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare(`INSERT INTO waitlist (patient_id, visit_type, preferences_json, reason, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)`)
      .run(patientId, visitTypeCode ?? "UNSPECIFIED", JSON.stringify(preferences ?? {}), reason, createdAt);
    return { ok: true, waitlistId: Number(result.lastInsertRowid), patientId, visitTypeCode, createdAt };
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
    const row = this.db.prepare(`SELECT * FROM handoff_tokens WHERE token_hash = ?`).get(tokenHash);
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
    const now = this.now().toISOString();
    const count = (sql, ...args) => Number(this.db.prepare(sql).get(...args).n);
    return {
      appointments: count(`SELECT COUNT(*) AS n FROM appointments`),
      upcomingOpen: count(`SELECT COUNT(*) AS n FROM appointments WHERE status IN ('booked','confirmed') AND datetime(start) >= datetime(?)`, now),
      bookingsByVoice: count(`SELECT COUNT(*) AS n FROM appointments WHERE source IN ('voice','reschedule')`),
      frontDeskBookings: count(`SELECT COUNT(*) AS n FROM appointments WHERE source = 'front_desk'`),
      activeHolds: count(`SELECT COUNT(*) AS n FROM holds WHERE status = 'held' AND datetime(expires_at) > datetime(?)`, now),
      releasedSlots: count(`SELECT COUNT(*) AS n FROM released_slots`),
      waitlist: count(`SELECT COUNT(*) AS n FROM waitlist WHERE status = 'open'`),
    };
  }

  close() {
    this.db.close();
  }

  #bookHeldAppointment({ holdId, patientId, reason = null, source = "voice", skipCleanup = false } = {}) {
    if (!skipCleanup) this.#releaseExpiredHolds();
    const hold = holdId ? this.db.prepare(`SELECT * FROM holds WHERE hold_id = ?`).get(holdId) : null;
    if (!hold || hold.status !== "held") return { ok: false, error: hold?.status === "expired" ? "hold_expired" : "hold_not_found" };
    if (patientId && hold.patient_id && hold.patient_id !== patientId) return { ok: false, error: "patient_mismatch" };
    if (Date.parse(hold.expires_at) <= this.now().getTime()) {
      this.releaseHold(holdId);
      return { ok: false, error: "hold_expired" };
    }
    return this.db.transaction(() => {
      const units = fiveMinuteUnits(hold.start, hold.end);
      const mine = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM occupancy WHERE provider_id = ? AND kind = 'hold' AND ref = ?`).get(hold.provider_id, holdId).n);
      // Every unit must still belong to this hold. Anything less means someone
      // else booked the time: refuse, and never book a neighboring slot instead.
      if (mine !== units.length) return { ok: false, error: "slot_taken" };
      const appointmentId = this.#nextAppointmentId();
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO appointments (appointment_id, patient_id, provider_id, department, location, visit_type, start, end, prep_code, status, cancel_reason, attended, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', NULL, NULL, ?, ?)`)
        .run(appointmentId, patientId ?? hold.patient_id, hold.provider_id, hold.department, hold.location, hold.visit_type, hold.start, hold.end, hold.prep_code, source, now);
      this.db.prepare(`UPDATE holds SET status = 'booked' WHERE hold_id = ?`).run(holdId);
      this.db.prepare(`UPDATE occupancy SET kind = 'appointment', ref = ?, expires_at = NULL WHERE kind = 'hold' AND ref = ?`).run(appointmentId, holdId);
      if (reason) this.db.prepare(`INSERT INTO appointment_reasons (appointment_id, masked_reason, created_at) VALUES (?, ?, ?)`).run(appointmentId, maskReason(reason), now);
      return { ok: true, action: source === "reschedule" ? "reschedule_book" : "book", appointment: this.getAppointment(appointmentId) };
    })();
  }

  /** Sequential, so a rerun of the demo reads out the same confirmation numbers. */
  #nextAppointmentId() {
    const row = this.db.prepare(`SELECT MAX(CAST(SUBSTR(appointment_id, 3) AS INTEGER)) AS n FROM appointments WHERE appointment_id GLOB 'A-[0-9]*'`).get();
    return `A-${Math.max(Number(row?.n) || 0, 20_000) + 1}`;
  }

  #holdStatus(holdId) {
    return this.db.prepare(`SELECT status FROM holds WHERE hold_id = ?`).get(holdId ?? "")?.status ?? null;
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

  #busyUnits() {
    const rows = this.db.prepare(`SELECT provider_id, unit_start, kind, ref FROM occupancy`).all();
    return new Map(rows.map((r) => [`${r.provider_id}|${r.unit_start}`, { kind: r.kind, ref: r.ref }]));
  }

  #releaseExpiredHolds() {
    const expired = this.db.prepare(`SELECT hold_id FROM holds WHERE status = 'held' AND datetime(expires_at) <= datetime(?)`).all(this.now().toISOString());
    if (!expired.length) return 0;
    this.db.transaction(() => {
      for (const { hold_id } of expired) {
        this.db.prepare(`UPDATE holds SET status = 'expired' WHERE hold_id = ?`).run(hold_id);
        this.db.prepare(`DELETE FROM occupancy WHERE kind = 'hold' AND ref = ?`).run(hold_id);
      }
    })();
    return expired.length;
  }

  /** Replays a success for the same key. A failure is not cached, so a fresh attempt can still succeed. */
  #idempotent(key, fn) {
    const existing = this.db.prepare(`SELECT result_json FROM idempotency WHERE key = ?`).get(key);
    if (existing) return parse(existing.result_json);
    const result = fn();
    if (result?.ok) {
      this.db.prepare(`INSERT OR REPLACE INTO idempotency (key, result_json, created_at) VALUES (?, ?, ?)`)
        .run(key, JSON.stringify(result), new Date().toISOString());
    }
    return result;
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
  let t = Math.floor(new Date(start).getTime() / UNIT_MS) * UNIT_MS;
  const until = new Date(end).getTime();
  for (; t < until; t += UNIT_MS) units.push(new Date(t).toISOString());
  return units;
}

export function clinicTimeZone(location) {
  return fixtures.clinics.locations[location]?.timeZone ?? "America/Los_Angeles";
}

export function clinicName(location) {
  return fixtures.clinics.locations[location]?.displayName ?? location;
}

/** "Tuesday, May 19th" in the clinic's time zone. */
export function spokenDate(iso, timeZone) {
  const p = zonedParts(Date.parse(iso), timeZone, { weekday: "long", month: "long", day: "numeric" });
  return `${p.weekday}, ${p.month} ${ordinal(Number(p.day))}`;
}

/** "11 a.m.", "8:30 a.m." in the clinic's time zone. */
export function spokenTime(iso, timeZone) {
  const p = zonedParts(Date.parse(iso), timeZone, { hour: "numeric", minute: "2-digit", hour12: true });
  const period = /^p/i.test(p.dayPeriod ?? "") ? "p.m." : "a.m.";
  return `${p.hour}${p.minute === "00" ? "" : `:${p.minute}`} ${period}`;
}

/** "Tuesday, May 19th, at 11 a.m." */
export function spokenDateTime(iso, timeZone) {
  return `${spokenDate(iso, timeZone)}, at ${spokenTime(iso, timeZone)}`;
}

/** An option as the agent offers it: "today at 11 a.m.", or the full date further out. */
export function spokenWhen(iso, timeZone, now) {
  const day = zonedDateKey(Date.parse(iso), timeZone);
  const today = zonedDateKey(now.getTime(), timeZone);
  if (day === today) return `today at ${spokenTime(iso, timeZone)}`;
  if (day === addDaysKey(today, 1)) return `tomorrow at ${spokenTime(iso, timeZone)}`;
  return spokenDateTime(iso, timeZone);
}

export function withArticle(name) {
  return `${/^(?:[aeiou]|mri\b|x-ray)/i.test(String(name)) ? "an" : "a"} ${name}`;
}

function readBack(slot) {
  const visit = fixtures.visitTypes[slot.visitTypeCode];
  const name = slot.visitName ?? visit?.spokenName?.en ?? String(slot.visitTypeCode).toLowerCase();
  const timeZone = slot.timeZone ?? clinicTimeZone(slot.location);
  return `${withArticle(name)} with ${slot.providerName} on ${spokenDateTime(slot.start, timeZone)}, at the ${clinicName(slot.location)}`;
}

function makeSlot({ provider, location, visitTypeCode, start, end, released = false }) {
  const visit = fixtures.visitTypes[visitTypeCode];
  const timeZone = clinicTimeZone(location);
  const slot = {
    optionId: [provider.providerId, visitTypeCode, location, start].join("~"),
    slotKey: `${provider.providerId}|${Date.parse(start)}`,
    providerId: provider.providerId,
    providerName: provider.spokenName,
    location,
    locationName: clinicName(location),
    visitTypeCode,
    visitName: visit.spokenName?.en ?? visitTypeCode,
    department: visit.department,
    durationMinutes: visit.durationMinutes,
    prepCode: visit.prepCode,
    start,
    end,
    dateKey: zonedDateKey(Date.parse(start), timeZone),
    timeZone,
    released: Boolean(released),
  };
  slot.label = `${dayLabel(slot.dateKey)} · ${shortTime(start, timeZone)}`;
  slot.spoken = spokenDateTime(start, timeZone);
  slot.readBack = readBack(slot);
  return slot;
}

/** Option ids are readable and self-describing: provider~visit type~clinic~start. */
function decodeSlot(id) {
  const [providerId, visitTypeCode, location, start] = String(id ?? "").split("~");
  const provider = providerTemplates().find((p) => p.providerId === providerId);
  const visit = fixtures.visitTypes[visitTypeCode];
  const startMs = Date.parse(start);
  if (!provider || !visit || !fixtures.clinics.locations[location] || !Number.isFinite(startMs)) return null;
  const timeZone = clinicTimeZone(location);
  return makeSlot({ provider, location, visitTypeCode, start: isoInZone(startMs, timeZone), end: isoInZone(startMs + visit.durationMinutes * 60_000, timeZone) });
}

function unitsFree(busy, providerId, start, end) {
  const units = fiveMinuteUnits(start, end);
  return units.length > 0 && units.every((unit) => !busy.has(`${providerId}|${unit}`));
}

// ---------------------------------------------------------------- time zones

const formatters = new Map();
function formatter(timeZone, options) {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat("en-US", { timeZone, ...options }));
  return formatters.get(key);
}

function zonedParts(ms, timeZone, options) {
  return Object.fromEntries(formatter(timeZone, options).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
}

function zoneOffsetMinutes(ms, timeZone) {
  const p = zonedParts(ms, timeZone, { hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** The instant a clinic's wall clock reads `minutes` past midnight on `dateKey`. */
function wallTimeToMs(dateKey, minutes, timeZone) {
  const [y, mo, d] = dateKey.split("-").map(Number);
  const wall = Date.UTC(y, mo - 1, d, 0, minutes);
  const guess = wall - zoneOffsetMinutes(wall, timeZone) * 60_000;
  return wall - zoneOffsetMinutes(guess, timeZone) * 60_000;
}

/** ISO 8601 with the clinic's own offset, e.g. 2026-05-19T11:00:00-07:00. */
function isoInZone(ms, timeZone) {
  const offset = zoneOffsetMinutes(ms, timeZone);
  const local = new Date(ms + offset * 60_000).toISOString().slice(0, 19);
  const abs = Math.abs(offset);
  return `${local}${offset < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function zonedDateKey(ms, timeZone) {
  const p = zonedParts(ms, timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
}

function addDaysKey(dateKey, days) {
  const [y, mo, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

function weekdayOf(dateKey) {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

/** "Tue, May 19" for a calendar date. */
function dayLabel(dateKey) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${dateKey}T12:00:00Z`));
}

function shortTime(iso, timeZone) {
  return formatter(timeZone, { hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
}

function ordinal(n) {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

const pad = (n) => String(n).padStart(2, "0");
function hhmm(minutes) { return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`; }

// ------------------------------------------------------------------- helpers

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
function toMinutes(text) { const [h, m = 0] = String(text).split(":").map(Number); return h * 60 + m; }
function insideAnyBreak(startMin, endMin, breaks) { return breaks.some((b) => startMin < toMinutes(b.end) && endMin > toMinutes(b.start)); }
function isClinicHoliday(location, dateKey) { return (fixtures.clinics.locations[location]?.holidays ?? []).includes(dateKey); }
function ageOn(dob, now) { const b = new Date(dob); let age = now.getUTCFullYear() - b.getUTCFullYear(); const m = now.getUTCMonth() - b.getUTCMonth(); if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age -= 1; return age; }
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
