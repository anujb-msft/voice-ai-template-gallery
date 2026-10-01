import { randomUUID } from "node:crypto";
import { config } from "./config.mjs";
import { buildPageBrief, buildVoicemailPrompt, groupedDigits, maskPhone, normalisePhone, outranks, sanitizeTenantSaid } from "./policy.mjs";
import { opsAlertPayload, technicianCardPayload } from "./handoff.mjs";

export const STATES = Object.freeze({
  INTAKE: "intake",
  OPEN: "open",
  PAGING: "paging",
  ACKNOWLEDGED: "acknowledged",
  TENANT_NOTIFIED: "tenantNotified",
  CLOSED: "closed",
  WORK_ORDER_LOGGED: "workOrderLogged",
  UNACKNOWLEDGED_ALERT: "unacknowledgedAlert",
});

const DEFAULT_SPOKEN = {
  opening: "Contoso Property Management maintenance line. I'm an automated assistant. If anyone is in danger, or you smell gas or see fire, hang up and call 911 now. Otherwise, what's the problem?",
  urgent: "I'm contacting the on-call technician now. You'll get a call back when they have it.",
  routine: "I've logged this for the office. They will follow up next business day.",
  duplicate: "A technician is already being contacted for this unit. I've attached these details to the open incident.",
  statusAck: "A technician has your request and will call you shortly.",
  statusStillTrying: "The team is still working to reach a technician for your request.",
};

export class PagerFlow {
  constructor({ policy, audit, notifier = null, dialer = null, hub = null, now = Date.now, options = {} }) {
    this.policy = policy;
    this.audit = audit;
    this.notifier = notifier;
    this.dialer = dialer ?? new SimulatedDialer();
    this.hub = hub;
    this.now = now;
    this.options = { intakeBudgetMs: config.budgets.intakeMs, pageBudgetMs: config.budgets.pageMs, ...options };
    this.intakes = new Map();
    this.pageSessions = new Map();
    this.nextOutcomes = [];
  }

  createIntake({ callId = randomUUID(), fromPhone = null, simulated = true } = {}) {
    const tenant = this.policy.tenantByPhone(fromPhone);
    const ctx = {
      id: callId,
      state: STATES.INTAKE,
      fromPhone: normalisePhone(fromPhone),
      maskedPhone: maskPhone(fromPhone),
      tenant: tenant ? { propertyId: tenant.propertyId, unit: tenant.unit } : null,
      propertyId: tenant?.propertyId ?? null,
      unit: tenant?.unit ?? null,
      fields: { callbackNumber: normalisePhone(fromPhone), permissionToEnter: false },
      startedAtMs: this.now(),
      simulated,
      transcript: [],
      spoken: [],
    };
    this.intakes.set(callId, ctx);
    this.#publish(callId, "intake", this.snapshotIntake(callId));
    return ctx;
  }

  answered(callId) {
    const ctx = this.#intake(callId);
    this.#speak(ctx, DEFAULT_SPOKEN.opening);
    if (ctx.tenant) {
      const prop = this.policy.property(ctx.tenant.propertyId);
      this.#speak(ctx, `Is this about unit ${ctx.tenant.unit} at ${prop.name}?`);
    }
    return this.snapshotIntake(callId);
  }

  identifyUnit(callId, { property = null, unit = null } = {}) {
    const ctx = this.#intake(callId);
    const result = this.policy.identifyUnit({ fromPhone: ctx.fromPhone, property, unit });
    if (result.ok) {
      ctx.propertyId = result.property.id;
      ctx.unit = result.unit;
      ctx.tenant = result.tenant;
      this.#speak(ctx, result.prompt);
    }
    return result;
  }

  recordIssue(callId, fields = {}) {
    const ctx = this.#intake(callId);
    const clean = { ...fields };
    if (clean.callbackNumber) clean.callbackNumber = normalisePhone(clean.callbackNumber);
    if (clean.tenantSaid || clean.details) clean.tenantSaid = sanitizeTenantSaid(clean.tenantSaid ?? clean.details, this.policy.triage.tenantSaidMaxChars);
    Object.assign(ctx.fields, clean);
    const missing = this.#missingSlots(ctx);
    if (ctx.fields.callbackNumber) this.#speak(ctx, `I have the callback number as ${groupedDigits(ctx.fields.callbackNumber)}.`);
    return { ok: true, missing, fields: this.#safeFields(ctx.fields) };
  }

  classifyAndSubmit(callId) {
    const ctx = this.#intake(callId);
    const missing = this.#missingSlots(ctx);
    if (missing.length) return { ok: false, reason: "missing_slots", missing };

    const prop = this.policy.property(ctx.propertyId);
    const classification = this.policy.classify(ctx.fields);
    if (classification.missingSlots?.length) return { ok: false, reason: "missing_triage_slots", missing: classification.missingSlots };

    const reportedAt = new Date(this.now()).toISOString();
    const incident = {
      id: `inc_${randomUUID().slice(0, 8)}`,
      state: classification.severity === "routine" ? STATES.WORK_ORDER_LOGGED : STATES.OPEN,
      severity: classification.severity,
      propertyId: prop.id,
      propertyName: prop.name,
      unit: ctx.unit,
      issueType: classification.issueType,
      issueTypeLabel: issueLabel(classification.issueType),
      issue: String(ctx.fields.issue),
      tenantSaid: sanitizeTenantSaid(ctx.fields.tenantSaid ?? ctx.fields.details ?? ctx.fields.issue, this.policy.triage.tenantSaidMaxChars),
      accessNotes: ctx.fields.accessNotes ?? "none",
      permissionToEnter: Boolean(ctx.fields.permissionToEnter),
      callbackNumber: normalisePhone(ctx.fields.callbackNumber ?? ctx.fromPhone),
      callbackMasked: maskPhone(ctx.fields.callbackNumber ?? ctx.fromPhone),
      reportedAt,
      acknowledgedAt: null,
      closedAt: classification.severity === "routine" ? reportedAt : null,
      acknowledgedBy: null,
      bridgeRequested: false,
      duplicatesAttached: 0,
      safetyLine: classification.safetyLine,
      matchedRule: classification.matchedRule,
      simulated: ctx.simulated,
    };

    const sinceMs = this.now() - this.policy.escalation.duplicateWindowMinutes * 60_000;
    const duplicate = this.audit.findDuplicate({ propertyId: incident.propertyId, unit: incident.unit, sinceMs });
    if (duplicate) {
      this.audit.updateIncident(duplicate.id, {
        duplicatesAttached: (duplicate.duplicatesAttached ?? 0) + 1,
        tenantSaid: mergeNote(duplicate.tenantSaid, incident.tenantSaid, this.policy.triage.tenantSaidMaxChars),
      });
      this.audit.recordEvent(duplicate.id, "tenant", "duplicate_attached", incident.tenantSaid);
      if (outranks(incident.severity, duplicate.severity)) {
        this.audit.updateIncident(duplicate.id, { severity: incident.severity, state: STATES.OPEN, safetyLine: incident.safetyLine, matchedRule: `escalated:${incident.matchedRule}` });
        this.audit.recordEvent(duplicate.id, "system", "duplicate_severity_increased", `${duplicate.severity}->${incident.severity}`);
        this.#schedulePage(duplicate.id, "primary", 1, this.now());
      }
      this.#speak(ctx, DEFAULT_SPOKEN.duplicate);
      return { ok: true, duplicate: true, incidentId: duplicate.id, severity: duplicate.severity, speak: DEFAULT_SPOKEN.duplicate };
    }

    this.audit.createIncident(incident);
    this.audit.recordEvent(incident.id, "system", "incident_created", classification.matchedRule);

    if (incident.severity === "emergency") {
      this.#speak(ctx, this.policy.triage.emergency.safetyLine);
      this.#schedulePage(incident.id, "primary", 1, this.now());
      return { ok: true, incidentId: incident.id, severity: incident.severity, speak: this.policy.triage.emergency.safetyLine, scheduled: true };
    }
    if (incident.severity === "urgent") {
      const spoken = [DEFAULT_SPOKEN.urgent, incident.safetyLine].filter(Boolean).join(" ");
      this.#speak(ctx, spoken);
      this.#schedulePage(incident.id, "primary", 1, this.now());
      return { ok: true, incidentId: incident.id, severity: incident.severity, speak: spoken, scheduled: true };
    }
    this.audit.recordEvent(incident.id, "system", "work_order_logged", incident.matchedRule);
    this.#speak(ctx, DEFAULT_SPOKEN.routine);
    return { ok: true, incidentId: incident.id, severity: "routine", speak: DEFAULT_SPOKEN.routine, scheduled: false };
  }

  setNextPageOutcomes(outcomes) {
    this.nextOutcomes = Array.isArray(outcomes) ? [...outcomes] : [outcomes];
  }

  pendingJobs() { return this.audit.pendingJobs(); }
  pendingCount() { return this.pendingJobs().length; }
  lagMs() {
    const first = this.pendingJobs()[0];
    if (!first) return 0;
    return Math.max(0, this.now() - new Date(first.dueAt).getTime());
  }

  async processDueJobs() {
    const jobs = this.audit.claimDueJobs(this.now());
    const results = [];
    for (const job of jobs) {
      if (job.kind === "alert") results.push(await this.#sendUnacknowledgedAlert(job));
      else results.push(await this.#runPageJob(job));
      this.audit.completeJob(job.id);
    }
    return results;
  }

  async forceNextPage(incidentId, outcome = "accept") {
    this.setNextPageOutcomes([outcome]);
    const job = this.pendingJobs().find((j) => j.incidentId === incidentId && j.kind === "page");
    if (!job) return { ok: false, reason: "no_pending_page" };
    this.audit.completeJob(job.id, "running");
    const result = await this.#runPageJob(job);
    this.audit.completeJob(job.id);
    return result;
  }

  getTicketDetail(incidentId, field) {
    const incident = this.#incident(incidentId);
    const allowed = {
      property: incident.propertyName,
      unit: incident.unit,
      issue: incident.issue,
      severity: incident.severity,
      access: incident.accessNotes,
      permission: incident.permissionToEnter ? "Tenant gave permission to enter." : "Tenant did not give permission to enter.",
      note: incident.tenantSaid,
      time: incident.reportedAt,
    };
    return { ok: true, field, value: allowed[field] ?? "That detail was not captured." };
  }

  async acknowledge(incidentId, contact = null) {
    const incident = this.#incident(incidentId);
    if (incident.acknowledgedAt) return { ok: true, alreadyAcknowledged: true };
    const at = new Date(this.now()).toISOString();
    this.audit.cancelJobsForIncident(incidentId);
    this.audit.updateIncident(incidentId, { state: STATES.ACKNOWLEDGED, acknowledgedAt: at, acknowledgedBy: contact?.name ?? contact?.id ?? "technician" });
    this.audit.recordEvent(incidentId, "tech", "acknowledged", contact?.name ?? null);
    await this.dialer.statusCall?.({ incident, message: DEFAULT_SPOKEN.statusAck });
    this.audit.updateIncident(incidentId, { state: STATES.TENANT_NOTIFIED });
    this.audit.recordEvent(incidentId, "system", "tenant_status_call", "acknowledged");
    this.audit.updateIncident(incidentId, { state: STATES.CLOSED, closedAt: at });
    this.#publish(incidentId, "incident", this.audit.getIncident(incidentId));
    return { ok: true, state: STATES.CLOSED };
  }

  async decline(incidentId, reason = "declined") {
    const session = this.pageSessions.get(incidentId);
    this.audit.recordEvent(incidentId, "tech", "declined", reason);
    if (session) return this.#scheduleNext(session.job, "decline");
    const incident = this.#incident(incidentId);
    return this.#schedulePage(incident.id, "secondary", 1, this.now());
  }

  async bridgeToTenant(incidentId) {
    const incident = this.#incident(incidentId);
    this.audit.updateIncident(incidentId, { bridgeRequested: true });
    this.audit.recordEvent(incidentId, "tech", "bridge_requested", "server_owned_numbers");
    await this.dialer.bridgeToTenant?.({ incident });
    return { ok: true, bridged: true };
  }

  repeatBrief(incidentId) {
    const incident = this.#incident(incidentId);
    return { ok: true, brief: buildPageBrief(incident) };
  }

  snapshotIntake(callId) {
    const ctx = this.intakes.get(callId);
    if (!ctx) return null;
    return { id: ctx.id, state: ctx.state, maskedPhone: ctx.maskedPhone, tenant: ctx.tenant, propertyId: ctx.propertyId, unit: ctx.unit, fields: this.#safeFields(ctx.fields), spoken: ctx.spoken, transcript: ctx.transcript };
  }

  snapshotIncident(incidentId) {
    const incident = this.audit.getIncident(incidentId);
    if (!incident) return null;
    return { ...incident, attempts: this.audit.attemptsFor(incidentId), pendingJobs: this.pendingJobs().filter((j) => j.incidentId === incidentId), events: this.audit.eventsFor(incidentId) };
  }

  #intake(callId) {
    const ctx = this.intakes.get(callId);
    if (!ctx) throw new Error(`unknown intake ${callId}`);
    return ctx;
  }
  #incident(id) {
    const incident = this.audit.getIncident(id);
    if (!incident) throw new Error(`unknown incident ${id}`);
    return incident;
  }
  #missingSlots(ctx) {
    const missing = [];
    if (!ctx.propertyId) missing.push("property");
    if (!ctx.unit) missing.push("unit");
    if (!ctx.fields.issue) missing.push("issue");
    if (!ctx.fields.callbackNumber && !ctx.fromPhone) missing.push("callbackNumber");
    if (ctx.fields.permissionToEnter == null) missing.push("permissionToEnter");
    return missing;
  }
  #safeFields(fields) {
    const { callbackNumber: _callbackNumber, ...safe } = fields;
    return { ...safe, callbackMasked: maskPhone(fields.callbackNumber) };
  }
  #speak(ctx, text) {
    ctx.spoken.push(text);
    ctx.transcript.push({ role: "agent", text, at: new Date(this.now()).toISOString() });
    this.#publish(ctx.id, "transcript", { role: "agent", text });
  }
  #schedulePage(incidentId, level, attempt, dueMs) {
    const incident = this.#incident(incidentId);
    const id = `page:${incidentId}:${level}:${attempt}`;
    this.audit.upsertJob({ id, incidentId, kind: "page", level, attempt, dueAt: new Date(dueMs).toISOString(), status: "pending", createdAt: new Date(this.now()).toISOString() });
    this.audit.upsertJob({ id: `alert:${incidentId}`, incidentId, kind: "alert", level: null, attempt: null, dueAt: new Date(new Date(incident.reportedAt).getTime() + this.policy.escalation.unacknowledgedAlertMinutes * 60_000).toISOString(), status: "pending", createdAt: new Date(this.now()).toISOString() });
    this.audit.updateIncident(incidentId, { state: STATES.PAGING });
    this.audit.recordEvent(incidentId, "scheduler", "page_scheduled", `${level}:${attempt}`);
    this.#publish(incidentId, "scheduler", { pendingJobs: this.pendingJobs() });
    return { ok: true, scheduled: id };
  }
  async #runPageJob(job) {
    const incident = this.#incident(job.incidentId);
    if (incident.acknowledgedAt || incident.state === STATES.CLOSED) return { ok: true, skipped: "already_acknowledged" };
    const contact = this.policy.levelContact(incident.propertyId, job.level, new Date(this.now()));
    const brief = buildPageBrief(incident);
    await this.notifier?.sendTechnicianCard?.(technicianCardPayload(incident, contact));
    const outcome = this.nextOutcomes.length ? this.nextOutcomes.shift() : "no-answer";
    const attempt = { id: job.id, incidentId: incident.id, level: job.level, attempt: job.attempt, contactId: contact.id, contactName: contact.name, startedAt: new Date(this.now()).toISOString(), completedAt: new Date(this.now()).toISOString(), outcome, escalatedFrom: job.attempt === 1 && job.level !== "primary" ? previousLevel(this.policy.escalation.levels, job.level) : null, voicemailSafe: outcome === "voicemail" };
    this.audit.recordAttempt(attempt);
    this.audit.recordEvent(incident.id, "pager", "page_attempt", `${job.level}:${job.attempt}:${outcome}`);
    this.pageSessions.set(incident.id, { job, contact, brief });
    await this.dialer.pageTechnician?.({ incident, contact, brief: outcome === "voicemail" ? buildVoicemailPrompt() : brief, outcome });
    if (outcome === "accept") return this.acknowledge(incident.id, contact);
    if (outcome === "bridge") { await this.bridgeToTenant(incident.id); return this.acknowledge(incident.id, contact); }
    if (outcome === "decline") return this.#scheduleNext(job, "decline");
    return this.#scheduleNext(job, outcome);
  }
  #scheduleNext(job, reason) {
    const incident = this.#incident(job.incidentId);
    const levels = this.policy.escalation.levels;
    const attemptsPerLevel = this.policy.escalation.attemptsPerLevel;
    let nextLevel = job.level;
    let nextAttempt = job.attempt + 1;
    const immediate = reason === "decline";
    if (immediate || nextAttempt > attemptsPerLevel) {
      const idx = levels.indexOf(job.level);
      nextLevel = levels[idx + 1];
      nextAttempt = 1;
    }
    if (!nextLevel) return { ok: true, exhausted: true };
    const gap = this.policy.escalation.gapMinutes[incident.severity] ?? 3;
    return this.#schedulePage(incident.id, nextLevel, nextAttempt, this.now() + (immediate ? 0 : gap * 60_000));
  }
  async #sendUnacknowledgedAlert(job) {
    const incident = this.#incident(job.incidentId);
    if (incident.acknowledgedAt || incident.state === STATES.CLOSED) return { ok: true, skipped: "already_acknowledged" };
    const attempts = this.audit.attemptsFor(incident.id);
    await this.notifier?.sendOpsAlert?.(opsAlertPayload(incident, attempts));
    await this.dialer.statusCall?.({ incident, message: DEFAULT_SPOKEN.statusStillTrying });
    this.audit.updateIncident(incident.id, { state: STATES.UNACKNOWLEDGED_ALERT });
    this.audit.recordEvent(incident.id, "system", "unacknowledged_alert", String(attempts.length));
    return { ok: true, alert: true };
  }
  #publish(userId, target, payload) { this.hub?.send?.(userId, target, payload); }
}

export class SimulatedDialer {
  constructor() { this.calls = []; }
  async pageTechnician(payload) { this.calls.push({ kind: "page", ...redactPayload(payload) }); return { ok: true, simulated: true }; }
  async statusCall(payload) { this.calls.push({ kind: "status", incidentId: payload.incident.id, message: payload.message }); return { ok: true, simulated: true }; }
  async bridgeToTenant(payload) { this.calls.push({ kind: "bridge", incidentId: payload.incident.id }); return { ok: true, simulated: true }; }
}
function redactPayload(payload) { return { incidentId: payload.incident.id, contact: { id: payload.contact.id, name: payload.contact.name }, brief: payload.brief, outcome: payload.outcome }; }
function issueLabel(type) { return ({ active_leak: "active leak", no_heat: "no heat", lockout: "lockout", no_power: "no power", emergency: "emergency" })[type] ?? type; }
function mergeNote(a, b, max) { return sanitizeTenantSaid([a, b].filter(Boolean).join(" | "), max); }
function previousLevel(levels, level) { const idx = levels.indexOf(level); return idx > 0 ? levels[idx - 1] : null; }
