import { randomUUID } from "node:crypto";
import { config, publicChain } from "./config.mjs";
import {
  buildPageBrief,
  buildVoicemailPrompt,
  incidentReference,
  maskPhone,
  nextBusinessDay,
  normalisePhone,
  outranks,
  sanitizeTenantSaid,
  spokenSeconds,
} from "./policy.mjs";
import { levelLabel, opsAlertPayload, pageTopic, technicianCardPayload } from "./handoff.mjs";

/** Incident states, as stored. */
export const STATES = Object.freeze({
  INTAKE: "intake",
  OPEN: "open",
  PAGING: "paging",
  ACKNOWLEDGED: "acknowledged",
  TENANT_NOTIFIED: "tenantNotified",
  CLOSED: "closed",
  WORK_ORDER_LOGGED: "workOrderLogged",
  UNACKNOWLEDGED_ALERT: "unacknowledgedAlert",
  CANCELLED: "cancelled",
});

/** Incident states that stop paging. */
const DONE_STATES = new Set([STATES.ACKNOWLEDGED, STATES.TENANT_NOTIFIED, STATES.CLOSED, STATES.WORK_ORDER_LOGGED, STATES.CANCELLED]);

/**
 * Story states: one tenant call as the console follows it, from intake through
 * every page attempt it causes. The last six are terminal.
 */
export const STORY = Object.freeze({
  INTAKE: "intake",
  PAGING: "paging",
  CLOSED: "closed",
  WORK_ORDER: "work-order",
  DUPLICATE: "duplicate",
  ENDED: "ended",
  CANCELLED: "cancelled",
  EXHAUSTED: "exhausted",
});
export const FINISHED_STORY = new Set([STORY.CLOSED, STORY.WORK_ORDER, STORY.DUPLICATE, STORY.ENDED, STORY.CANCELLED, STORY.EXHAUSTED]);

/** Page attempts that have not reached an outcome yet. */
const OPEN_OUTCOMES = new Set(["ringing", "calling", "answered"]);

/** Fixed lines. Everything the agent says about a page is built by the server, never by the model. */
export const SPOKEN = Object.freeze({
  opening:
    "Contoso Property Management maintenance line. I'm an automated assistant. If anyone is in danger, or you smell gas or see fire, hang up and call 911 now. Otherwise, what's the problem?",
  urgent: "I'm contacting the on-call technician now. You'll get a call back when they have it.",
  emergencyPaging: "I'm also paging the on-call technician now.",
  duplicate: "A technician is already being contacted for this unit. I've attached these details to the open incident.",
  statusAck: "A technician has your request and will call you shortly.",
  statusStillTrying: "The team is still working to reach a technician for your request.",
  numberRefused: "I can't share phone numbers. Press 3 and I'll connect you to the tenant.",
  bridgeFailed: "I couldn't connect the tenant's line, so I'll call them to say you have it. The access details are on your Teams card.",
  tenantMissed: "The tenant didn't pick up, so I'll call them to say you have it. The access details are on your Teams card.",
  alreadyAccepted: "You've already accepted this page, so I can't connect the tenant now. The access details are on your Teams card.",
});

/**
 * The pager's state machine: intake → classify → page → retry or escalate →
 * acknowledge → tell the tenant. The server owns every decision; the model
 * only collects fields and reads what the server hands it.
 *
 * Time comes from `now` (the demo clock), never from `Date.now()` directly,
 * so the rotation, the retry gaps and the 20-minute alert all follow the clock
 * the console shows.
 */
export class PagerFlow {
  #inflight = new Set();

  constructor({ policy, audit, notifier = null, dialer = null, hub = null, now = Date.now, options = {}, simDialer = null, simNotifier = null }) {
    this.policy = policy;
    this.audit = audit;
    this.notifier = notifier;
    this.dialer = dialer ?? new SimulatedDialer();
    this.simDialer = simDialer ?? this.dialer;
    this.simNotifier = simNotifier ?? notifier;
    this.hub = hub;
    this.now = now;
    this.options = {
      intakeBudgetMs: config.budgets.intakeMs,
      pageBudgetMs: config.budgets.pageMs,
      persistTranscripts: config.persistTranscripts,
      ...options,
    };
    /** Stories (one per tenant call), by call id. */
    this.intakes = new Map();
    this.storyByIncident = new Map();
    /** The page in progress for an incident: { job, contact, brief, safetyNetJobId }. */
    this.pageSessions = new Map();
    this.connections = new Map();
    /** Tenant callback numbers, in memory only — never written to the store or sent to a client. */
    this.callbacks = new Map();
    this.statusMessages = new Map();
    this.nextOutcomes = [];
  }

  // ------------------------------------------------------------------ intake

  createIntake({ callId = randomUUID(), fromPhone = null, simulated = true, interactive = false } = {}) {
    const phone = normalisePhone(fromPhone);
    const tenant = this.policy.tenantByPhone(phone);
    const ctx = {
      id: callId,
      seq: 0,
      simulated,
      interactive,
      state: STORY.INTAKE,
      phase: "intake",
      fromPhone: phone,
      maskedPhone: maskPhone(phone),
      callerName: tenant?.name ?? null,
      tenant: tenant ? { propertyId: tenant.propertyId, unit: tenant.unit } : null,
      propertyId: tenant?.propertyId ?? null,
      unit: tenant?.unit ?? null,
      unitConfirmed: false,
      fields: { callbackNumber: phone, permissionToEnter: false },
      accessHeard: false,
      callbackConfirmed: false,
      pendingQuestion: null,
      transcript: [],
      spoken: [],
      events: [],
      incidentId: null,
      submitResult: null,
      classification: null,
      leg: null,
      nextPage: null,
      voicemail: null,
      workOrder: null,
      answeredAtMs: null,
      startedAtMs: this.now(),
      endedAtMs: null,
    };
    this.intakes.set(callId, ctx);
    this.#state(ctx);
    return ctx;
  }

  /** The tenant's call connected. With `speak`, the flow says the opening line itself (simulation). */
  answered(id, { speak = true } = {}) {
    const ctx = this.#story(id);
    if (ctx.answeredAtMs != null) return this.snapshot(id);
    ctx.answeredAtMs = this.now();
    this.#event(ctx, null, "teams-phone", "call_answered", ctx.simulated ? "Simulated tenant call" : "Tenant call answered");
    if (ctx.callerName) {
      const prop = this.policy.property(ctx.tenant.propertyId);
      this.#event(ctx, null, "agent", "caller_matched", `Caller ID ${ctx.maskedPhone} is on the lease for ${prop?.name ?? ctx.tenant.propertyId} ${ctx.tenant.unit}`);
    } else {
      const who = ctx.maskedPhone ? `Caller ID ${ctx.maskedPhone} is not on a lease` : "Caller ID is withheld";
      this.#event(ctx, null, "agent", "caller_unknown", `${who} — the agent asks for the property and unit`);
    }
    if (speak) this.#line(ctx, "agent", SPOKEN.opening);
    this.#state(ctx);
    return this.snapshot(id);
  }

  /** Something the other party said (tenant, or technician on a page). */
  heard(id, text, { label = null } = {}) {
    const ctx = this.#story(id);
    const said = String(text ?? "").trim();
    if (!said) return null;
    return this.#line(ctx, "caller", said, label ?? this.#otherParty(ctx));
  }

  /** A line the (simulated) agent says. */
  say(id, text, { label = null } = {}) {
    const ctx = this.#story(id);
    const line = String(text ?? "").trim();
    if (!line) return null;
    return this.#line(ctx, "agent", line, label ?? this.#agentLabel(ctx));
  }

  /** A trail entry for something the agent noticed that changes no field (silence, a request for a person). */
  note(id, source, kind, detail = null) {
    const ctx = this.#story(id);
    return this.#event(ctx, ctx.incidentId, source, kind, detail);
  }

  identifyUnit(id, { property = null, unit = null } = {}) {
    const ctx = this.#story(id);
    const result = this.policy.identifyUnit({ fromPhone: ctx.fromPhone, property, unit });
    if (result.ok) {
      ctx.propertyId = result.property.id;
      ctx.unit = result.unit;
      ctx.tenant = result.tenant;
      if (result.source !== "callerId") ctx.unitConfirmed = true;
      if (result.source !== "callerId") this.#event(ctx, null, "agent", "unit_confirmed", `${result.property.name} ${result.unit} (${result.source === "stated" ? "stated by the caller" : "caller ID, confirmed"})`);
    } else {
      this.#event(ctx, null, "agent", "unit_clarify", result.message);
    }
    this.#state(ctx);
    return result;
  }

  recordIssue(id, fields = {}) {
    const ctx = this.#story(id);
    const max = this.policy.triage.tenantSaidMaxChars;
    const captured = [];
    if (fields.issue) {
      if (!ctx.fields.issue) captured.push("what");
      ctx.fields.issue = String(fields.issue).slice(0, 300);
    }
    if (fields.details && !fields.tenantSaid) fields = { ...fields, tenantSaid: fields.details };
    if (fields.details) ctx.fields.details = String(fields.details).slice(0, 300);
    if (fields.tenantSaid) {
      const quote = sanitizeTenantSaid(fields.tenantSaid, max);
      const prev = ctx.fields.tenantSaid;
      ctx.fields.tenantSaid = !prev || quote.includes(prev) ? quote : prev.includes(quote) ? prev : sanitizeTenantSaid(`${prev} ${quote}`, max);
      captured.push("tenant's words");
    }
    const temp = Number(fields.indoorTempF ?? fields.temperatureF);
    if ((fields.indoorTempF ?? fields.temperatureF) != null && Number.isFinite(temp)) {
      ctx.fields.indoorTempF = temp;
      captured.push(`${temp}°F inside`);
    }
    if (typeof fields.permissionToEnter === "boolean") {
      ctx.fields.permissionToEnter = fields.permissionToEnter;
      ctx.accessHeard = true;
      captured.push(fields.permissionToEnter ? "may enter" : "no entry");
    }
    if (fields.accessNotes) {
      ctx.fields.accessNotes = sanitizeTenantSaid(fields.accessNotes, max);
      ctx.accessHeard = true;
      captured.push("access notes");
    }
    if (fields.callbackNumber) {
      const phone = normalisePhone(fields.callbackNumber);
      if (phone) {
        ctx.fields.callbackNumber = phone;
        ctx.callbackConfirmed = true;
        captured.push(`callback ${maskPhone(phone)}`);
      }
    }
    if (captured.length) this.#event(ctx, null, "agent", "context_captured", captured.join(" · "));
    this.#state(ctx);
    return { ok: true, missing: this.#missingSlots(ctx), fields: this.#safeFields(ctx.fields), callbackMasked: maskPhone(ctx.fields.callbackNumber) };
  }

  /** The tenant said the number they called from is the one to call back. */
  confirmCallback(id) {
    const ctx = this.#story(id);
    if (!ctx.fields.callbackNumber) return { ok: false, reason: "no_number" };
    ctx.callbackConfirmed = true;
    this.#event(ctx, null, "agent", "callback_confirmed", `Callback ${maskPhone(ctx.fields.callbackNumber)} — the number is never read aloud or shown`);
    this.#state(ctx);
    return { ok: true, callbackMasked: maskPhone(ctx.fields.callbackNumber) };
  }

  /**
   * Classify, deduplicate, save and schedule the first page. Synchronous: the
   * page itself goes out on the next `processDueJobs` (see `submit`).
   */
  classifyAndSubmit(id) {
    const ctx = this.#story(id);
    if (ctx.submitResult) return { ...ctx.submitResult, alreadySubmitted: true };
    const missing = this.#missingSlots(ctx);
    if (missing.length) return { ok: false, reason: "missing_slots", missing };
    const classification = this.policy.classify(ctx.fields);
    if (classification.missingSlots?.length) return { ok: false, reason: "missing_triage_slots", missing: classification.missingSlots };

    const max = this.policy.triage.tenantSaidMaxChars;
    const prop = this.policy.property(ctx.propertyId);
    const nowMs = this.now();
    const reportedAt = iso(nowMs);
    const routine = classification.severity === "routine";
    const callback = normalisePhone(ctx.fields.callbackNumber ?? ctx.fromPhone);
    const incident = {
      id: `inc_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
      state: routine ? STATES.WORK_ORDER_LOGGED : STATES.OPEN,
      severity: classification.severity,
      propertyId: prop.id,
      propertyName: prop.name,
      unit: ctx.unit,
      issueType: classification.issueType,
      issueTypeLabel: issueLabel(classification.issueType),
      issue: String(ctx.fields.issue),
      tenantSaid: sanitizeTenantSaid(ctx.fields.tenantSaid ?? ctx.fields.details ?? ctx.fields.issue, max),
      accessNotes: ctx.fields.accessNotes ?? "none",
      permissionToEnter: Boolean(ctx.fields.permissionToEnter),
      callbackMasked: maskPhone(callback),
      reportedAt,
      acknowledgedAt: null,
      closedAt: routine ? reportedAt : null,
      acknowledgedBy: null,
      bridgeRequested: false,
      duplicatesAttached: 0,
      safetyLine: classification.safetyLine,
      matchedRule: classification.matchedRule,
      simulated: ctx.simulated,
    };
    ctx.classification = classification;

    const windowMinutes = this.policy.escalation.duplicateWindowMinutes;
    const duplicate = this.audit.findDuplicate({ propertyId: incident.propertyId, unit: incident.unit, sinceMs: nowMs - windowMinutes * 60_000 });
    if (duplicate) {
      this.audit.updateIncident(duplicate.id, {
        duplicatesAttached: (duplicate.duplicatesAttached ?? 0) + 1,
        tenantSaid: mergeNote(duplicate.tenantSaid, incident.tenantSaid, max),
      });
      if (!this.callbacks.has(duplicate.id) && callback) this.callbacks.set(duplicate.id, callback);
      ctx.incidentId = duplicate.id;
      this.#event(ctx, duplicate.id, "policy", "duplicate_attached", `Same unit within ${windowMinutes} min — attached to reference ${incidentReference(duplicate.id)}, no second page`);
      let speak = SPOKEN.duplicate;
      if (outranks(incident.severity, duplicate.severity)) {
        this.audit.updateIncident(duplicate.id, {
          severity: incident.severity,
          state: STATES.OPEN,
          safetyLine: incident.safetyLine,
          matchedRule: `escalated:${incident.matchedRule}`,
        });
        this.#event(ctx, duplicate.id, "policy", "duplicate_severity_increased", `${duplicate.severity} → ${incident.severity}: paging restarts at the ${incident.severity} gap`);
        this.#schedulePage(duplicate.id, "primary", 1, nowMs, { prefix: "repage", alertPrefix: "realert", reason: `Severity rose to ${incident.severity} — paging restarts at the primary` });
        if (incident.severity === "emergency") speak = `${incident.safetyLine} ${speak}`;
      }
      ctx.state = STORY.DUPLICATE;
      ctx.phase = "done";
      ctx.endedAtMs = nowMs;
      ctx.submitResult = { ok: true, duplicate: true, incidentId: duplicate.id, reference: incidentReference(duplicate.id), severity: this.audit.getIncident(duplicate.id).severity, speak, scheduled: false };
      this.#state(ctx);
      return ctx.submitResult;
    }

    this.audit.createIncident(incident);
    if (callback) this.callbacks.set(incident.id, callback);
    ctx.incidentId = incident.id;
    this.storyByIncident.set(incident.id, ctx.id);
    const reason = classificationReason(classification, ctx.fields, this.policy.triage.noHeatThresholdF);
    this.#event(ctx, incident.id, "policy", "incident_created", `${incident.severity} · ${classification.matchedRule} · reference ${incidentReference(incident.id)}`);

    if (routine) {
      const threshold = this.policy.triage.noHeatThresholdF;
      const followUp = nextBusinessDay(new Date(nowMs), this.policy.timeZone);
      let speak = `This isn't urgent enough to page the on-call technician, so I've logged a work order for the office. They'll follow up ${followUp}.`;
      if (classification.issueType === "no_heat") speak += ` If it drops to ${threshold} degrees or below inside, call us back and we'll page the on-call technician.`;
      ctx.workOrder = { reference: incidentReference(incident.id), followUp, reason, thresholdF: classification.issueType === "no_heat" ? threshold : null, indoorTempF: ctx.fields.indoorTempF ?? null };
      this.#event(ctx, incident.id, "policy", "work_order_logged", `No page — ${reason}`);
      ctx.state = STORY.WORK_ORDER;
      ctx.phase = "done";
      ctx.endedAtMs = nowMs;
      ctx.submitResult = { ok: true, incidentId: incident.id, reference: incidentReference(incident.id), severity: "routine", issueType: incident.issueType, speak, scheduled: false, followUp };
      this.#state(ctx);
      return ctx.submitResult;
    }

    const speak = incident.severity === "emergency" ? `${incident.safetyLine} ${SPOKEN.emergencyPaging}` : [SPOKEN.urgent, incident.safetyLine].filter(Boolean).join(" ");
    ctx.state = STORY.PAGING;
    ctx.phase = "waiting";
    this.#schedulePage(incident.id, "primary", 1, nowMs, { reason: `${titleCase(incident.severity)} — page the on-call primary now` });
    ctx.submitResult = { ok: true, incidentId: incident.id, reference: incidentReference(incident.id), severity: incident.severity, issueType: incident.issueType, speak, scheduled: true };
    this.#state(ctx);
    return ctx.submitResult;
  }

  /** Classify and submit, then send the first page straight away. */
  submit(id) {
    return this.#track(async () => {
      const result = this.classifyAndSubmit(id);
      if (result.ok && result.scheduled && !result.alreadySubmitted) await this.#processDue();
      return result;
    });
  }

  // --------------------------------------------------------------- scheduler

  setNextPageOutcomes(outcomes) {
    this.nextOutcomes = Array.isArray(outcomes) ? [...outcomes] : [outcomes];
  }

  pendingJobs() {
    return this.audit.pendingJobs();
  }

  pendingCount() {
    return this.pendingJobs().length;
  }

  lagMs() {
    const first = this.pendingJobs()[0];
    if (!first) return 0;
    return Math.max(0, this.now() - Date.parse(first.dueAt));
  }

  /** Run every job that is due on the (demo) clock, once. Jobs scheduled while running wait for the next pass. */
  processDueJobs() {
    return this.#track(() => this.#processDue());
  }

  async forceNextPage(incidentId, outcome = "accept") {
    return this.#track(async () => {
      this.setNextPageOutcomes([outcome]);
      const job = this.pendingJobs().find((j) => j.incidentId === incidentId && j.kind === "page");
      if (!job) return { ok: false, reason: "no_pending_page" };
      this.audit.completeJob(job.id, "running");
      const result = await this.#runPageJob(job);
      this.audit.completeJob(job.id);
      return result;
    });
  }

  /** Resolves once nothing the flow started is still running; then the story's snapshot. */
  async settled(id = null) {
    while (this.#inflight.size) await Promise.allSettled([...this.#inflight]);
    return id ? this.snapshot(id) : null;
  }

  // -------------------------------------------------------------- page leg
  // Each accepts the story id (simulation) or the incident id (live page legs).

  /** The technician picked up. With `speak`, the flow reads the greeting and brief itself (simulation). */
  pageAnswered(id, { speak = true } = {}) {
    const { ctx, incidentId } = this.#resolve(id);
    const session = incidentId ? this.pageSessions.get(incidentId) : null;
    if (!session) return { ok: false, reason: "no_page" };
    const incident = this.#incident(incidentId);
    const attempt = this.#attempt(incidentId, session.job.id);
    if (attempt && !["ringing", "calling"].includes(attempt.outcome)) return { ok: true, ignored: true, outcome: attempt.outcome };
    this.#updateAttempt(incidentId, session.job.id, { outcome: "answered" });
    this.#holdSafetyNet(ctx, incidentId);
    const greeting = `This is the ${this.policy.organization} pager, an automated assistant, with ${article(incident.severity)} ${incident.severity} page for ${session.contact.name}.`;
    if (ctx) {
      ctx.phase = "briefed";
      ctx.leg = { ...(ctx.leg ?? this.#legFor(session)), status: "answered", reprompted: false };
      if (speak) {
        this.#line(ctx, "agent", greeting, this.#agentLabel(ctx));
        this.#line(ctx, "agent", session.brief, this.#agentLabel(ctx));
      }
    }
    this.#event(ctx, incidentId, "teams-phone", "page_answered", `${session.contact.name} picked up — the brief is read aloud (≈${spokenSeconds(session.brief)} s)`);
    this.#changed(ctx, incidentId);
    return { ok: true, greeting, brief: session.brief, contactName: session.contact.name };
  }

  /** Silence on the page leg: ringing rings out; after the brief, one reprompt, then no-answer. */
  pageSilence(id) {
    const { ctx, incidentId } = this.#resolve(id);
    if (!ctx?.leg || !incidentId) return { ok: true, ignored: true };
    if (ctx.phase === "briefed" && !ctx.leg.reprompted) {
      ctx.leg.reprompted = true;
      const text = `Are you there, ${firstName(ctx.leg.contact.name)}? Press 1 or say 'I've got it' to accept, 2 to decline, or 3 to talk to the tenant.`;
      if (this.#scripted(ctx)) this.#line(ctx, "agent", text, this.#agentLabel(ctx));
      this.#event(ctx, incidentId, "agent", "reprompt", "No response after the brief — asked once more");
      this.#state(ctx);
      return { ok: true, reprompted: true, speak: text };
    }
    return this.pageNoAnswer(id);
  }

  pageNoAnswer(id) {
    const { ctx, incidentId } = this.#resolve(id);
    const session = incidentId ? this.pageSessions.get(incidentId) : null;
    if (!session) return { ok: false, reason: "no_page" };
    const attempt = this.#attempt(incidentId, session.job.id);
    if (!attempt || !OPEN_OUTCOMES.has(attempt.outcome)) return { ok: true, ignored: true, outcome: attempt?.outcome ?? null };
    const afterBrief = attempt.outcome === "answered";
    this.#updateAttempt(incidentId, session.job.id, { outcome: "no-answer", completedAt: iso(this.now()) });
    const name = session.contact.name;
    if (ctx) {
      ctx.leg = null;
      ctx.phase = "waiting";
      this.#line(ctx, "system", afterBrief ? `${name} didn't respond after the brief — the page counts as unanswered.` : `No answer from ${name}.`);
    }
    this.#event(ctx, incidentId, "teams-phone", "page_no_answer", `${name} · ${levelLabel(session.job.level)} · attempt ${session.job.attempt} of ${this.policy.escalation.attemptsPerLevel}`);
    return this.#scheduleNext(session.job, "no-answer");
  }

  /**
   * The page reached voicemail. The box hears a callback prompt and a
   * reference only — never the property, unit, problem or the tenant's words.
   */
  pageVoicemail(id) {
    const { ctx, incidentId } = this.#resolve(id);
    const session = incidentId ? this.pageSessions.get(incidentId) : null;
    if (!session) return { ok: false, reason: "no_page" };
    const attempt = this.#attempt(incidentId, session.job.id);
    if (!attempt || !OPEN_OUTCOMES.has(attempt.outcome)) return { ok: true, ignored: true, outcome: attempt?.outcome ?? null };
    const incident = this.#incident(incidentId);
    const prompt = buildVoicemailPrompt(incident);
    const reference = incidentReference(incident.id);
    this.#updateAttempt(incidentId, session.job.id, { outcome: "voicemail", voicemailSafe: true, completedAt: iso(this.now()) });
    const name = session.contact.name;
    if (ctx) {
      ctx.leg = null;
      ctx.phase = "waiting";
      ctx.voicemail = { contactName: name, prompt, reference, at: iso(this.now()), withheld: withheldFrom(prompt, incident) };
      this.#line(ctx, "system", `${name}'s voicemail picked up.`);
      if (ctx.simulated) this.#line(ctx, "agent", prompt, "Agent → voicemail");
    }
    this.#event(ctx, incidentId, "teams-phone", "voicemail_prompt", `Safe prompt only — reference ${reference}; no property, unit, problem or tenant details`);
    return this.#scheduleNext(session.job, "voicemail");
  }

  /** The technician accepted (voice, DTMF 1, or a forced outcome). Cancels every pending page and tells the tenant. */
  async acknowledge(id, contact = null, { notifyTenant = true } = {}) {
    const { ctx, incidentId } = this.#resolve(id);
    const incident = this.#incident(incidentId);
    if (incident.acknowledgedAt) return { ok: true, alreadyAcknowledged: true, state: incident.state };
    const session = this.pageSessions.get(incidentId);
    const who = contact ?? session?.contact ?? null;
    const name = who?.name ?? who?.id ?? "technician";
    const at = iso(this.now());
    this.audit.cancelJobsForIncident(incidentId);
    this.audit.updateIncident(incidentId, { state: STATES.ACKNOWLEDGED, acknowledgedAt: at, acknowledgedBy: name });
    if (session) this.#updateAttempt(incidentId, session.job.id, (a) => (OPEN_OUTCOMES.has(a.outcome) ? { outcome: "accept", completedAt: at } : null));
    const ttaMs = Date.parse(at) - Date.parse(incident.reportedAt);
    this.#event(ctx, incidentId, "technician", "page_accepted", `${name} has it — ${formatDuration(ttaMs)} after the report`);
    const speak = notifyTenant ? `Thanks, ${firstName(name)}. I'll tell the tenant you have it. The access details are on your Teams card.` : null;
    if (speak && this.#scripted(ctx)) this.#line(ctx, "agent", speak, this.#agentLabel(ctx));
    let told = false;
    if (notifyTenant) {
      const sent = await this.#statusCall(ctx, incident, SPOKEN.statusAck, "Acknowledged");
      if (sent) this.audit.updateIncident(incidentId, { state: STATES.TENANT_NOTIFIED });
      told = Boolean(sent);
    }
    this.audit.updateIncident(incidentId, { state: STATES.CLOSED, closedAt: at });
    if (ctx) {
      ctx.leg = ctx.leg ? { ...ctx.leg, status: notifyTenant ? "accepted" : "bridged" } : null;
      ctx.state = STORY.CLOSED;
      ctx.phase = "done";
      ctx.nextPage = null;
      ctx.endedAtMs = this.now();
      this.#line(ctx, "system", `Closed — ${name} acknowledged ${formatDuration(ttaMs)} after the report.`);
    }
    const closing = !notifyTenant ? "Technician and tenant are talking" : told ? "Tenant told a technician has it" : "The tenant wasn't reached — the office follows up";
    this.#event(ctx, incidentId, "system", "incident_closed", closing);
    this.#changed(ctx, incidentId);
    return { ok: true, state: STATES.CLOSED, acknowledgedBy: name, timeToAcknowledgeMs: ttaMs, speak };
  }

  async decline(id, reason = "declined") {
    const { ctx, incidentId } = this.#resolve(id);
    const session = this.pageSessions.get(incidentId);
    if (!session) {
      this.#event(ctx, incidentId, "technician", "page_declined", reason);
      return this.#schedulePage(incidentId, "secondary", 1, this.now(), { kind: "escalation_pending", reason: "Declined — escalating to the secondary now" });
    }
    const at = iso(this.now());
    this.#updateAttempt(incidentId, session.job.id, (a) => (OPEN_OUTCOMES.has(a.outcome) ? { outcome: "decline", completedAt: at } : null));
    this.#event(ctx, incidentId, "technician", "page_declined", `${session.contact.name}${reason && reason !== "declined" ? ` — ${reason}` : ""}`);
    if (ctx) {
      ctx.leg = null;
      ctx.phase = "waiting";
    }
    const result = this.#scheduleNext(session.job, "decline");
    const speak = result.exhausted ? "Understood. I'll let the operations team know." : `Understood — I'll page the ${levelLabel(result.level)} now.`;
    if (this.#scripted(ctx)) {
      this.#line(ctx, "agent", speak, `Agent → ${firstName(session.contact.name)}`);
      if (!result.exhausted) await this.#processDue();
    }
    return { ...result, speak };
  }

  /** DTMF 3: connect the technician and the tenant. Neither sees the other's number; the server dials. */
  async bridgeToTenant(id, contact = null) {
    const { ctx, incidentId } = this.#resolve(id);
    const incident = this.#incident(incidentId);
    // Accepted already, so the tenant's status call has gone out: a second call to them would cross it.
    if (incident.acknowledgedAt) return { ok: false, reason: "already_acknowledged", speak: SPOKEN.alreadyAccepted };
    const callback = this.callbacks.get(incidentId);
    if (!callback) {
      const speak = "I don't have the tenant's callback number on this server any more. The access details are on your Teams card.";
      this.#event(ctx, incidentId, "teams-phone", "bridge_unavailable", "No callback number in memory (server restarted)");
      if (this.#scripted(ctx)) this.#line(ctx, "agent", speak, this.#agentLabel(ctx));
      return { ok: false, reason: "no_callback", speak };
    }
    const session = this.pageSessions.get(incidentId);
    const at = iso(this.now());
    const who = contact ?? session?.contact ?? null;
    const speak = `Connecting you to ${ctx?.callerName ? firstName(ctx.callerName) : "the tenant"} now — neither of you will see the other's number.`;
    if (this.#scripted(ctx)) this.#line(ctx, "agent", speak, this.#agentLabel(ctx));
    const dialer = incident.simulated ? this.simDialer : this.dialer;
    try {
      await dialer.bridgeToTenant?.({ incident: { ...incident, callbackNumber: callback }, callConnectionId: this.connectionId("page", incidentId) });
    } catch {
      // The technician still has it: it counts as an accept, and the tenant hears that from the status call instead.
      // ACS's reason is in the server log (see acsDialer); the console and the audit get a fixed one.
      this.#event(ctx, incidentId, "teams-phone", "bridge_failed", "The tenant's line couldn't be added");
      const ack = await this.acknowledge(incidentId, who);
      return { ok: false, bridged: false, reason: "bridge_failed", speak: SPOKEN.bridgeFailed, state: ack.state };
    }
    this.audit.updateIncident(incidentId, { bridgeRequested: true });
    if (session) this.#updateAttempt(incidentId, session.job.id, (a) => (OPEN_OUTCOMES.has(a.outcome) ? { outcome: "bridge", completedAt: at } : null));
    this.#event(ctx, incidentId, "teams-phone", "bridge_created", "Tenant added to the technician's call — both numbers stay server-side");
    const ack = await this.acknowledge(incidentId, who, { notifyTenant: false });
    return { ok: true, bridged: true, speak, state: ack.state };
  }

  /**
   * The tenant's line never joined the technician's call (a live call's
   * AddParticipantFailed). The technician still has it, so the tenant gets the
   * status call they would otherwise have had.
   */
  async tenantBridgeFailed(id, reason = null) {
    const { ctx, incidentId } = this.#resolve(id);
    const incident = incidentId ? this.audit.getIncident(incidentId) : null;
    if (!incident?.bridgeRequested) return { ok: false, reason: "no_bridge" };
    // The record says what happened: an accept, and no bridge.
    this.audit.updateIncident(incidentId, { bridgeRequested: false });
    const session = this.pageSessions.get(incidentId);
    if (session) this.#updateAttempt(incidentId, session.job.id, (a) => (a.outcome === "bridge" ? { outcome: "accept" } : null));
    if (ctx?.leg) ctx.leg = { ...ctx.leg, status: "accepted" };
    this.#event(ctx, incidentId, "teams-phone", "bridge_failed", reason || "The tenant's line didn't join");
    if (ctx) this.#line(ctx, "system", "The tenant's line didn't join — calling them back with the update instead.");
    await this.#statusCall(ctx, incident, SPOKEN.statusAck, "Bridge failed");
    this.#changed(ctx, incidentId);
    return { ok: true, speak: SPOKEN.tenantMissed };
  }

  repeatBrief(id) {
    const { ctx, incidentId } = this.#resolve(id);
    const incident = this.#incident(incidentId);
    const brief = this.pageSessions.get(incidentId)?.brief ?? buildPageBrief(incident, { timeZone: this.policy.timeZone });
    this.#event(ctx, incidentId, "technician", "brief_repeated", null);
    if (this.#scripted(ctx)) this.#line(ctx, "agent", brief, this.#agentLabel(ctx));
    return { ok: true, brief };
  }

  /** A technician's question, answered from stored fields only. Phone numbers are refused. */
  getTicketDetail(id, field) {
    const { ctx, incidentId } = this.#resolve(id);
    const incident = this.#incident(incidentId);
    const key = detailKey(field);
    if (key === "phone") {
      this.#event(ctx, incidentId, "agent", "number_request_guarded", "Phone numbers stay server-side — offered the bridge (press 3) instead");
      if (this.#scripted(ctx)) this.#line(ctx, "agent", SPOKEN.numberRefused, this.#agentLabel(ctx));
      this.#state(ctx);
      return { ok: false, refused: true, field: "phone", value: SPOKEN.numberRefused };
    }
    const allowed = {
      property: `${incident.propertyName}${this.policy.property(incident.propertyId)?.address ? `, ${this.policy.property(incident.propertyId).address}` : ""}.`,
      unit: `Unit ${incident.unit}.`,
      issue: `${titleCase(incident.issueTypeLabel ?? incident.issueType)}. The tenant said: ${incident.tenantSaid}`,
      severity: `${titleCase(incident.severity)}.`,
      access: incident.accessNotes && incident.accessNotes !== "none" ? incident.accessNotes : "No access notes were given.",
      permission: incident.permissionToEnter ? "The tenant gave permission to enter." : "The tenant did not give permission to enter.",
      note: incident.tenantSaid,
      time: `Reported ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: this.policy.timeZone }).format(new Date(incident.reportedAt)).replace(/\u202f/g, " ")}.`,
    };
    const value = allowed[key] ?? "That detail wasn't captured. The full ticket is on your Teams card.";
    this.#event(ctx, incidentId, "agent", "ticket_detail", key ?? String(field ?? "unknown"));
    if (this.#scripted(ctx)) this.#line(ctx, "agent", value, this.#agentLabel(ctx));
    return { ok: true, field: key ?? field, value };
  }

  // ------------------------------------------------------------ call control

  /**
   * End a call. During intake nothing has been paged, so the story simply
   * ends. Once paging, a simulated story is canceled (its pending pages
   * too); a real tenant hanging up after the report does not stop paging.
   */
  hangup(id, { reason = "hung up" } = {}) {
    const ctx = this.#story(id);
    if (FINISHED_STORY.has(ctx.state)) return this.snapshot(id);
    const nowMs = this.now();
    if (ctx.state === STORY.INTAKE) {
      ctx.state = STORY.ENDED;
      ctx.phase = "done";
      ctx.endedAtMs = nowMs;
      this.#event(ctx, null, "teams-phone", "call_ended", `${titleCase(reason)} before the report was complete — nothing was paged`);
    } else if (ctx.state === STORY.PAGING && ctx.simulated && ctx.incidentId) {
      const incidentId = ctx.incidentId;
      this.audit.cancelJobsForIncident(incidentId);
      const session = this.pageSessions.get(incidentId);
      if (session) this.#updateAttempt(incidentId, session.job.id, (a) => (OPEN_OUTCOMES.has(a.outcome) ? { outcome: "cancelled", completedAt: iso(nowMs) } : null));
      this.audit.updateIncident(incidentId, { state: STATES.CANCELLED, closedAt: iso(nowMs) });
      ctx.state = STORY.CANCELLED;
      ctx.phase = "done";
      ctx.leg = null;
      ctx.nextPage = null;
      ctx.endedAtMs = nowMs;
      this.#event(ctx, incidentId, "system", "page_cancelled", "Demo call ended — pending pages canceled");
    } else {
      return this.snapshot(id);
    }
    this.#state(ctx);
    return this.snapshot(id);
  }

  /** Before a new simulated call: end every unfinished simulated story and stop paging for it. */
  cancelOpenSimulations(exceptId = null) {
    const ids = [];
    for (const ctx of this.intakes.values()) {
      if (ctx.id === exceptId || !ctx.simulated || FINISHED_STORY.has(ctx.state)) continue;
      this.hangup(ctx.id, { reason: "replaced by a new call" });
      ids.push(ctx.id);
    }
    const nowIso = iso(this.now());
    for (const incident of this.audit.listIncidents()) {
      if (!incident.simulated || incident.acknowledgedAt || DONE_STATES.has(incident.state)) continue;
      this.audit.cancelJobsForIncident(incident.id);
      this.audit.updateIncident(incident.id, { state: STATES.CANCELLED, closedAt: nowIso });
    }
    return ids;
  }

  /** Demo reset: forget simulated stories, simulated pages and simulated notifications. Returns the story ids. */
  reset() {
    const ids = [];
    for (const ctx of [...this.intakes.values()]) {
      if (!ctx.simulated) continue;
      ids.push(ctx.id);
      this.intakes.delete(ctx.id);
    }
    for (const [incidentId, storyId] of [...this.storyByIncident]) if (ids.includes(storyId)) this.storyByIncident.delete(incidentId);
    for (const incident of this.audit.listIncidents()) {
      if (!incident.simulated) continue;
      this.storyByIncident.delete(incident.id);
      this.pageSessions.delete(incident.id);
      this.callbacks.delete(incident.id);
      this.statusMessages.delete(incident.id);
      for (const key of [...this.connections.keys()]) if (key.endsWith(`:${incident.id}`)) this.connections.delete(key);
    }
    if (Array.isArray(this.simDialer?.calls)) this.simDialer.calls.length = 0;
    if (Array.isArray(this.simNotifier?.sent)) this.simNotifier.sent.length = 0;
    this.nextOutcomes = [];
    return ids;
  }

  /**
   * The demo clock jumped by `deltaMs` (a preset change). Unfinished simulated
   * stories move with it, so a countdown keeps its remaining time instead of
   * firing — or stalling — because of the jump.
   */
  rebaseClock(deltaMs) {
    if (!deltaMs) return;
    const shift = (value) => (value ? iso(Date.parse(value) + deltaMs) : value);
    for (const ctx of this.intakes.values()) {
      if (!ctx.simulated || FINISHED_STORY.has(ctx.state)) continue;
      ctx.startedAtMs += deltaMs;
      if (ctx.answeredAtMs != null) ctx.answeredAtMs += deltaMs;
      if (ctx.nextPage) ctx.nextPage = { ...ctx.nextPage, dueAt: shift(ctx.nextPage.dueAt) };
      if (ctx.leg?.startedAt) ctx.leg = { ...ctx.leg, startedAt: shift(ctx.leg.startedAt) };
      if (!ctx.incidentId) continue;
      const incident = this.audit.getIncident(ctx.incidentId);
      if (incident) this.audit.updateIncident(incident.id, { reportedAt: shift(incident.reportedAt) });
      for (const job of this.audit.pendingJobs()) if (job.incidentId === ctx.incidentId) this.audit.rescheduleJob(job.id, shift(job.dueAt));
    }
  }

  // ------------------------------------------------------------ live legs

  liveTranscript(callId, leg, role, text, { contactName = null } = {}) {
    const said = String(text ?? "").trim();
    if (!said) return;
    if (this.options.persistTranscripts) this.audit.recordTranscript(`${leg}:${callId}`, role, said, iso(this.now()));
    const { ctx, incidentId } = this.#resolve(callId);
    const held = leg === "page" && this.#holdSafetyNet(ctx, incidentId);
    if (!ctx) return;
    this.#line(ctx, role === "agent" ? "agent" : "caller", said, this.#liveLabel(ctx, incidentId, leg, role, contactName));
    if (held) this.#state(ctx);
  }

  /**
   * Who a live line was said by, or to. The tenant's own call needs no label;
   * a page call is labeled with the technician it rang (`contactName`, from the
   * bridge), so a line said after an acknowledge or a decline keeps its name.
   */
  #liveLabel(ctx, incidentId, leg, role, contactName) {
    if (leg === "status") return role === "agent" ? `Agent → ${ctx.callerName ? firstName(ctx.callerName) : "tenant"}` : null;
    if (leg !== "page") return null;
    const name = contactName ?? this.pageSessions.get(incidentId)?.contact?.name ?? null;
    if (role === "agent") return `Agent → ${name ? firstName(name) : "technician"}`;
    return name ?? "Technician";
  }

  /**
   * While a technician is on an answered page, the safety-net page waits a full
   * gap after the last thing said on the call, so it can't ring over the brief
   * or their questions. A call that drops is rescheduled by its CallDisconnected.
   */
  #holdSafetyNet(ctx, incidentId) {
    const session = incidentId ? this.pageSessions.get(incidentId) : null;
    if (!session?.safetyNetJobId || this.#attempt(incidentId, session.job.id)?.outcome !== "answered") return false;
    return this.#postponeJob(ctx, session.safetyNetJobId, this.now() + this.#gap(this.#incident(incidentId)) * 60_000);
  }

  /** Move a pending job later — never earlier — and the console's countdown with it. */
  #postponeJob(ctx, jobId, dueMs) {
    const job = this.audit.pendingJobs().find((j) => j.id === jobId);
    if (!job || Date.parse(job.dueAt) >= dueMs) return false;
    const dueAt = iso(dueMs);
    this.audit.rescheduleJob(jobId, dueAt);
    if (ctx?.nextPage?.jobId === jobId) ctx.nextPage = { ...ctx.nextPage, dueAt };
    return true;
  }

  setCallConnection(leg, id, callConnectionId) {
    if (callConnectionId) this.connections.set(`${leg}:${id}`, callConnectionId);
  }

  connectionId(leg, id) {
    return this.connections.get(`${leg}:${id}`) ?? null;
  }

  pageBriefFor(id) {
    const { incidentId } = this.#resolve(id);
    const incident = incidentId ? this.audit.getIncident(incidentId) : null;
    if (!incident) return "";
    return this.pageSessions.get(incidentId)?.brief ?? buildPageBrief(incident, { timeZone: this.policy.timeZone });
  }

  voicemailPromptFor(id) {
    const { incidentId } = this.#resolve(id);
    return buildVoicemailPrompt(incidentId ? this.audit.getIncident(incidentId) : null);
  }

  statusMessageFor(id) {
    const { incidentId } = this.#resolve(id);
    return this.statusMessages.get(incidentId) ?? SPOKEN.statusAck;
  }

  eventsFor(id) {
    const ctx = this.intakes.get(id);
    if (ctx) return ctx.events.map((e) => ({ ...e }));
    return this.audit.eventsFor(id);
  }

  // ------------------------------------------------------------- snapshots

  snapshot(id) {
    const ctx = this.intakes.get(id);
    if (!ctx) return null;
    const nowMs = this.now();
    const incident = ctx.incidentId ? this.audit.getIncident(ctx.incidentId) : null;
    const attempts = incident ? this.audit.attemptsFor(incident.id) : [];
    const pending = incident ? this.audit.pendingJobs().filter((j) => j.incidentId === incident.id) : [];
    const done = FINISHED_STORY.has(ctx.state);
    const endMs = done ? (ctx.endedAtMs ?? nowMs) : nowMs;
    const unackMinutes = this.policy.escalation.unacknowledgedAlertMinutes;
    const paging = incident && incident.severity !== "routine" && ctx.state !== STORY.DUPLICATE;
    const elapsedMs = paging
      ? (incident.acknowledgedAt ? Date.parse(incident.acknowledgedAt) : endMs) - Date.parse(incident.reportedAt)
      : endMs - ctx.startedAtMs;
    const prop = ctx.propertyId ? this.policy.property(ctx.propertyId) : null;
    const preview = ctx.classification ?? (ctx.fields.issue ? this.policy.classify(ctx.fields) : null);
    const threshold = this.policy.triage.noHeatThresholdF;
    const nextPage = ctx.nextPage && pending.some((j) => j.id === ctx.nextPage.jobId) ? { ...ctx.nextPage, dueInMs: Date.parse(ctx.nextPage.dueAt) - nowMs } : null;
    const alertJob = pending.find((j) => j.kind === "alert");
    const brief = paging ? this.pageBriefFor(incident.id) : null;
    return {
      id: ctx.id,
      callId: ctx.id,
      seq: ctx.seq,
      simulated: ctx.simulated,
      interactive: ctx.interactive,
      state: ctx.state,
      phase: ctx.phase,
      finished: done,
      now: iso(nowMs),
      elapsedMs: Math.max(0, elapsedMs),
      budgetMs: paging ? unackMinutes * 60_000 : this.options.intakeBudgetMs,
      budgetLabel: paging ? "to acknowledge" : "intake",
      caller: { name: ctx.callerName, firstName: ctx.callerName ? firstName(ctx.callerName) : null, maskedPhone: ctx.maskedPhone, known: Boolean(ctx.callerName) },
      propertyId: ctx.propertyId,
      propertyName: prop?.name ?? null,
      unit: ctx.unit,
      unitConfirmed: ctx.unitConfirmed,
      tenant: ctx.tenant,
      fields: this.#safeFields(ctx.fields),
      context: {
        what: preview ? issueLabel(preview.issueType) : null,
        where: prop && ctx.unit ? `${prop.name}, unit ${ctx.unit}` : null,
        whereConfirmed: ctx.unitConfirmed,
        impact: ctx.fields.tenantSaid ?? null,
        indoorTempF: ctx.fields.indoorTempF ?? null,
        access: ctx.accessHeard ? accessSummary(ctx.fields) : null,
        permissionToEnter: ctx.accessHeard ? Boolean(ctx.fields.permissionToEnter) : null,
        callback: maskPhone(ctx.fields.callbackNumber),
        callbackConfirmed: ctx.callbackConfirmed,
      },
      classification: preview ? { ...classificationView(preview, ctx.fields, threshold), final: Boolean(ctx.classification) } : null,
      incident: this.#publicIncident(incident),
      onCall: this.#onCallFor(ctx.propertyId, nowMs),
      leg: ctx.leg ? { ...ctx.leg } : null,
      attempts: attempts.map((a) => ({ ...a, levelLabel: levelLabel(a.level) })),
      nextPage,
      alertAt: alertJob?.dueAt ?? null,
      brief,
      briefSeconds: brief ? spokenSeconds(brief) : null,
      briefWords: brief ? brief.split(/\s+/).filter(Boolean).length : null,
      workOrder: ctx.workOrder,
      voicemail: ctx.voicemail,
      transcript: ctx.transcript.map((l) => ({ ...l })),
      spoken: [...ctx.spoken],
    };
  }

  snapshotIntake(id) {
    return this.snapshot(id);
  }

  snapshotIncident(incidentId) {
    const incident = this.audit.getIncident(incidentId);
    if (!incident) return null;
    return {
      ...incident,
      reference: incidentReference(incident.id),
      attempts: this.audit.attemptsFor(incidentId),
      pendingJobs: this.pendingJobs().filter((j) => j.incidentId === incidentId),
      events: this.audit.eventsFor(incidentId),
    };
  }

  // -------------------------------------------------------------- internals

  async #processDue() {
    const jobs = this.audit.claimDueJobs(this.now());
    const results = [];
    for (const job of jobs) {
      try {
        results.push(job.kind === "alert" ? await this.#sendUnacknowledgedAlert(job) : await this.#runPageJob(job));
        this.audit.completeJob(job.id);
      } catch (err) {
        console.error(`[pager] job ${job.id} failed:`, err.message);
        this.audit.completeJob(job.id, "failed");
        results.push({ ok: false, jobId: job.id, error: err.message });
      }
    }
    return results;
  }

  #track(fn) {
    const promise = (async () => fn())();
    this.#inflight.add(promise);
    const done = () => this.#inflight.delete(promise);
    promise.then(done, done);
    return promise;
  }

  #schedulePage(incidentId, level, attempt, dueMs, { prefix = "page", alertPrefix = "alert", reason = null, kind = "page_scheduled" } = {}) {
    const incident = this.#incident(incidentId);
    const nowMs = this.now();
    const id = `${prefix}:${incidentId}:${level}:${attempt}`;
    const dueAt = iso(dueMs);
    if (this.audit.pendingJobs().some((j) => j.id === id)) this.audit.rescheduleJob(id, dueAt);
    else this.audit.upsertJob({ id, incidentId, kind: "page", level, attempt, dueAt, status: "pending", createdAt: iso(nowMs) });
    const alertBase = alertPrefix === "alert" ? Date.parse(incident.reportedAt) : nowMs;
    this.audit.upsertJob({
      id: `${alertPrefix}:${incidentId}`,
      incidentId,
      kind: "alert",
      level: null,
      attempt: null,
      dueAt: iso(alertBase + this.policy.escalation.unacknowledgedAlertMinutes * 60_000),
      status: "pending",
      createdAt: iso(nowMs),
    });
    if (incident.state === STATES.OPEN || incident.state === STATES.PAGING) this.audit.updateIncident(incidentId, { state: STATES.PAGING });
    const contact = this.#contactFor(incident, level, dueMs);
    const ctx = this.#storyFor(incidentId);
    const attemptsPerLevel = this.policy.escalation.attemptsPerLevel;
    const nextPage = {
      jobId: id,
      level,
      levelLabel: levelLabel(level),
      attempt,
      attemptsPerLevel,
      contactName: contact?.name ?? null,
      dueAt,
      reason,
      gapMinutes: this.#gap(incident),
      scheduledAt: iso(nowMs),
    };
    if (ctx) ctx.nextPage = nextPage;
    this.#event(ctx, incidentId, "scheduler", kind, reason ?? `${contact?.name ?? levelLabel(level)} · ${levelLabel(level)} · attempt ${attempt} of ${attemptsPerLevel}`);
    this.#changed(ctx, incidentId);
    return { ok: true, scheduled: id, level, attempt, dueAt, contactName: contact?.name ?? null };
  }

  async #runPageJob(job) {
    const incident = this.#incident(job.incidentId);
    if (incident.acknowledgedAt || DONE_STATES.has(incident.state)) return { ok: true, skipped: "not_paging", jobId: job.id };
    const ctx = this.#storyFor(incident.id);
    const nowMs = this.now();
    // A page still ringing (or talking without an answer) when the next one is due counts as no answer.
    for (const stale of this.audit.attemptsFor(incident.id)) {
      if (stale.id !== job.id && OPEN_OUTCOMES.has(stale.outcome)) this.audit.recordAttempt({ ...stale, outcome: "no-answer", completedAt: iso(nowMs) });
    }
    const scheduled = ctx?.nextPage?.jobId === job.id ? ctx.nextPage : null;
    const contact = this.#contactFor(incident, job.level, nowMs);
    if (!contact) {
      this.#event(ctx, incident.id, "scheduler", "page_failed", `Nobody on file for the ${levelLabel(job.level)}`);
      return this.#scheduleNext(job, "failed");
    }
    const simulated = Boolean(incident.simulated);
    const dialer = simulated ? this.simDialer : this.dialer;
    const notifier = simulated ? this.simNotifier : this.notifier;
    const brief = buildPageBrief(incident, { timeZone: this.policy.timeZone });
    const attemptsPerLevel = this.policy.escalation.attemptsPerLevel;
    const levels = this.policy.escalation.levels;
    const person = { id: contact.id, name: contact.name };
    this.pageSessions.set(incident.id, { job, contact: person, brief, safetyNetJobId: null });
    try {
      const posted = await notifier?.sendTechnicianCard?.(technicianCardPayload(incident, contact));
      if (posted?.ok === false) this.#event(ctx, incident.id, "teams", "technician_card_failed", `The Teams workflow answered HTTP ${posted.status}`);
      else this.#event(ctx, incident.id, "teams", "technician_card_sent", `Teams card to ${contact.name} — property, unit, issue and access; no phone numbers`);
    } catch (err) {
      this.#event(ctx, incident.id, "teams", "technician_card_failed", serverLogged(`Teams card to ${contact.name}`, err, "The Teams workflow couldn't be reached"));
    }

    const forced = this.nextOutcomes.length ? this.nextOutcomes.shift() : null;
    const interactive = !forced && ctx?.interactive && ctx.simulated;
    const outcome = forced ?? (interactive ? "ringing" : simulated ? "no-answer" : "calling");
    const startedAt = iso(nowMs);
    const attempt = {
      id: job.id,
      incidentId: incident.id,
      level: job.level,
      attempt: job.attempt,
      contactId: contact.id,
      contactName: contact.name,
      startedAt,
      completedAt: OPEN_OUTCOMES.has(outcome) ? null : startedAt,
      outcome,
      escalatedFrom: job.attempt === 1 && job.level !== levels[0] ? previousLevel(levels, job.level) : null,
      voicemailSafe: outcome === "voicemail",
    };
    this.audit.recordAttempt(attempt);
    const isFirst = this.audit.attemptsFor(incident.id).length === 1;
    const who = `${contact.name} (${levelLabel(job.level)}${job.attempt > 1 ? `, attempt ${job.attempt} of ${attemptsPerLevel}` : ""})`;
    const lead = isFirst
      ? `${ctx?.callerName ? `${firstName(ctx.callerName)}'s` : "The tenant's"} call ended — paging ${who} through Teams Phone.`
      : attempt.escalatedFrom
        ? `Escalating — paging ${who} through Teams Phone.`
        : `Paging ${who} through Teams Phone.`;

    const handoff = () => ({
      incident: this.#publicIncident(incident),
      level: job.level,
      levelLabel: levelLabel(job.level),
      attempt: job.attempt,
      attemptsPerLevel,
      brief,
      topic: pageTopic(incident),
      contactName: contact.name,
      reason: scheduled?.reason ?? null,
      why: this.#onCallFor(incident.propertyId, nowMs)?.why ?? null,
    });

    if (outcome === "ringing") {
      await dialer.pageTechnician?.({ incident, contact, brief, outcome });
      ctx.leg = { jobId: job.id, level: job.level, levelLabel: levelLabel(job.level), attempt: job.attempt, attemptsPerLevel, contact: person, status: "ringing", startedAt, reprompted: false };
      ctx.phase = "ringing";
      ctx.nextPage = null;
      this.#line(ctx, "system", lead);
      this.#publish(ctx.id, "handoff", handoff());
      this.#event(ctx, incident.id, "teams-phone", "page_ringing", `${contact.name} · ${levelLabel(job.level)} · attempt ${job.attempt} of ${attemptsPerLevel}`);
      this.#state(ctx);
      return { ok: true, ringing: true, jobId: job.id };
    }

    if (outcome === "calling") {
      try {
        const result = await dialer.pageTechnician({ incident, contact, brief, outcome });
        if (result?.callConnectionId) this.setCallConnection("page", incident.id, result.callConnectionId);
      } catch (err) {
        this.audit.recordAttempt({ ...attempt, outcome: "failed", completedAt: iso(this.now()) });
        this.#event(ctx, incident.id, "teams-phone", "page_failed", serverLogged(`Page to ${contact.name}`, err, `${contact.name}: the call couldn't be placed`));
        return this.#scheduleNext(job, "failed");
      }
      if (ctx) {
        ctx.leg = { jobId: job.id, level: job.level, levelLabel: levelLabel(job.level), attempt: job.attempt, attemptsPerLevel, contact: person, status: "calling", startedAt, reprompted: false };
        ctx.phase = "ringing";
        this.#line(ctx, "system", lead);
        this.#publish(ctx.id, "handoff", handoff());
      }
      this.#event(ctx, incident.id, "teams-phone", "page_calling", `${contact.name} · ${levelLabel(job.level)} · attempt ${job.attempt} of ${attemptsPerLevel}`);
      // Safety net: if nobody acknowledges, the next attempt still goes out after the usual gap.
      const next = this.#scheduleNext(job, "no-answer", { quiet: true });
      const session = this.pageSessions.get(incident.id);
      if (session && next.scheduled) session.safetyNetJobId = next.scheduled;
      return { ok: true, calling: true, jobId: job.id };
    }

    await dialer.pageTechnician?.({ incident, contact, brief: outcome === "voicemail" ? buildVoicemailPrompt(incident) : brief, outcome });
    this.#event(ctx, incident.id, "teams-phone", `page_${outcome.replace(/-/g, "_")}`, `${contact.name} · ${levelLabel(job.level)} · attempt ${job.attempt} of ${attemptsPerLevel}`);
    if (outcome === "accept") return this.acknowledge(incident.id, person);
    if (outcome === "bridge") return this.bridgeToTenant(incident.id, person);
    if (outcome === "decline") return this.#scheduleNext(job, "decline");
    if (outcome === "voicemail") {
      if (ctx) ctx.voicemail = { contactName: contact.name, prompt: buildVoicemailPrompt(incident), reference: incidentReference(incident.id), at: startedAt, withheld: withheldFrom(buildVoicemailPrompt(incident), incident) };
      return this.#scheduleNext(job, "voicemail");
    }
    return this.#scheduleNext(job, "no-answer");
  }

  #scheduleNext(job, reason, { quiet = false } = {}) {
    const incident = this.#incident(job.incidentId);
    const ctx = this.#storyFor(incident.id);
    const { levels, attemptsPerLevel } = this.policy.escalation;
    const immediate = reason === "decline";
    let level = job.level;
    let attempt = job.attempt + 1;
    if (immediate || attempt > attemptsPerLevel) {
      level = levels[levels.indexOf(job.level) + 1];
      attempt = 1;
    }
    const from = this.#attempt(incident.id, job.id)?.contactName ?? levelLabel(job.level);
    const prefix = job.id.split(":")[0] || "page";
    if (!level) {
      for (const pending of this.audit.pendingJobs()) if (pending.incidentId === incident.id && pending.kind === "page") this.audit.completeJob(pending.id, "superseded");
      if (ctx) {
        ctx.state = STORY.EXHAUSTED;
        ctx.phase = "done";
        ctx.leg = null;
        ctx.nextPage = null;
        ctx.endedAtMs = this.now();
        this.#line(ctx, "system", `Every level has been paged. The operations team is alerted ${this.policy.escalation.unacknowledgedAlertMinutes} minutes after the report if nobody acknowledges.`);
      }
      this.#event(ctx, incident.id, "scheduler", "page_exhausted", `${from} was the last level — the unacknowledged alert stays scheduled`);
      this.#changed(ctx, incident.id);
      return { ok: true, exhausted: true };
    }
    const gap = this.#gap(incident);
    const dueMs = this.now() + (immediate ? 0 : gap * 60_000);
    const nextId = `${prefix}:${incident.id}:${level}:${attempt}`;
    for (const pending of this.audit.pendingJobs()) {
      if (pending.incidentId === incident.id && pending.kind === "page" && pending.id !== nextId) this.audit.completeJob(pending.id, "superseded");
    }
    const nextName = this.#contactFor(incident, level, dueMs)?.name ?? levelLabel(level);
    const sameLevel = level === job.level;
    const minutes = `${gap} min`;
    const again = `Paging the ${levelLabel(level)} again (attempt ${attempt} of ${attemptsPerLevel}) in ${minutes} — the ${incident.severity} gap.`;
    const escalate = (lead) => `${lead} Escalating to the ${levelLabel(level)}, ${nextName}, ${immediate ? "now" : `in ${minutes}`}.`;
    const text = {
      "no-answer": sameLevel ? `No answer from ${from}. ${again}` : escalate(`${from} didn't answer ${attemptsPerLevel} attempts.`),
      voicemail: sameLevel ? `${from}'s voicemail got the safe prompt only. ${again}` : escalate(`${from}'s voicemail got the safe prompt only.`),
      decline: escalate(`${from} declined.`),
      failed: sameLevel ? `The call to ${from} didn't connect. ${again}` : escalate(`The call to ${from} didn't connect.`),
    }[reason] ?? escalate(`${from}: ${reason}.`);
    return this.#schedulePage(incident.id, level, attempt, dueMs, {
      prefix,
      alertPrefix: prefix === "repage" ? "realert" : "alert",
      reason: quiet ? `Safety net: ${text}` : text,
      kind: quiet ? "safety_net_pending" : sameLevel ? "retry_pending" : "escalation_pending",
    });
  }

  async #sendUnacknowledgedAlert(job) {
    const incident = this.#incident(job.incidentId);
    if (incident.acknowledgedAt || DONE_STATES.has(incident.state)) return { ok: true, skipped: "already_acknowledged" };
    const ctx = this.#storyFor(incident.id);
    const attempts = this.audit.attemptsFor(incident.id);
    const notifier = incident.simulated ? this.simNotifier : this.notifier;
    const minutes = this.policy.escalation.unacknowledgedAlertMinutes;
    try {
      const posted = await notifier?.sendOpsAlert?.(opsAlertPayload(incident, attempts));
      if (posted?.ok === false) this.#event(ctx, incident.id, "teams", "ops_alert_failed", `The Teams workflow answered HTTP ${posted.status}`);
      else this.#event(ctx, incident.id, "teams", "ops_alert_sent", `No acknowledgement ${minutes} min after the report — ${attempts.length} page${attempts.length === 1 ? "" : "s"} so far`);
    } catch (err) {
      this.#event(ctx, incident.id, "teams", "ops_alert_failed", serverLogged("Ops alert", err, "The Teams workflow couldn't be reached"));
    }
    this.audit.updateIncident(incident.id, { state: STATES.UNACKNOWLEDGED_ALERT });
    if (ctx) this.#line(ctx, "system", `No acknowledgement after ${minutes} minutes — the operations team has been alerted.`);
    await this.#statusCall(ctx, incident, SPOKEN.statusStillTrying, "Still trying");
    this.#changed(ctx, incident.id);
    return { ok: true, alert: true };
  }

  async #statusCall(ctx, incident, message, why) {
    this.statusMessages.set(incident.id, message);
    const callback = this.callbacks.get(incident.id);
    if (!callback) {
      this.#event(ctx, incident.id, "teams-phone", "status_call_skipped", "No callback number in memory (server restarted) — the office follows up");
      return null;
    }
    const dialer = incident.simulated ? this.simDialer : this.dialer;
    try {
      const result = await dialer.statusCall?.({ incident: { ...incident, callbackNumber: callback }, message });
      if (result?.callConnectionId) this.setCallConnection("status", incident.id, result.callConnectionId);
      if (this.#scripted(ctx)) this.#line(ctx, "agent", message, `Agent → ${ctx.callerName ? firstName(ctx.callerName) : "tenant"}`);
      this.#event(ctx, incident.id, "teams-phone", "status_call_sent", `${why} — tenant called back on ${maskPhone(callback)}`);
      return result ?? { ok: true };
    } catch (err) {
      this.#event(ctx, incident.id, "teams-phone", "status_call_failed", serverLogged(`Status call (${why})`, err, `${why} — the call back to the tenant couldn't be placed`));
      return null;
    }
  }

  #resolve(id) {
    const story = this.intakes.get(id);
    if (story) return { ctx: story, incidentId: story.incidentId };
    const storyId = this.storyByIncident.get(id);
    return { ctx: storyId ? (this.intakes.get(storyId) ?? null) : null, incidentId: id };
  }

  #story(id) {
    const ctx = this.intakes.get(id);
    if (!ctx) throw new Error(`unknown call ${id}`);
    return ctx;
  }

  #storyFor(incidentId) {
    const storyId = this.storyByIncident.get(incidentId);
    return storyId ? (this.intakes.get(storyId) ?? null) : null;
  }

  #incident(id) {
    const incident = id ? this.audit.getIncident(id) : null;
    if (!incident) throw new Error(`unknown incident ${id}`);
    return incident;
  }

  #attempt(incidentId, attemptId) {
    return this.audit.attemptsFor(incidentId).find((a) => a.id === attemptId) ?? null;
  }

  /** Both stores replace the whole row, so merge before writing. */
  #updateAttempt(incidentId, attemptId, patch) {
    const current = this.#attempt(incidentId, attemptId);
    if (!current) return null;
    const change = typeof patch === "function" ? patch(current) : patch;
    if (!change) return current;
    const next = { ...current, ...change };
    this.audit.recordAttempt(next);
    return next;
  }

  #contactFor(incident, level, atMs) {
    try {
      return this.policy.levelContact(incident.propertyId, level, new Date(atMs)) ?? null;
    } catch {
      return null;
    }
  }

  #onCallFor(propertyId, atMs) {
    const prop = propertyId ? this.policy.property(propertyId) : null;
    if (!prop) return null;
    try {
      return publicChain(this.policy.onCallChain(prop.group, new Date(atMs)));
    } catch {
      return null;
    }
  }

  #legFor(session) {
    return {
      jobId: session.job.id,
      level: session.job.level,
      levelLabel: levelLabel(session.job.level),
      attempt: session.job.attempt,
      attemptsPerLevel: this.policy.escalation.attemptsPerLevel,
      contact: session.contact,
      status: "calling",
      startedAt: iso(this.now()),
      reprompted: false,
    };
  }

  #gap(incident) {
    return this.policy.escalation.gapMinutes[incident.severity] ?? 3;
  }

  #missingSlots(ctx) {
    const missing = [];
    if (!ctx.propertyId) missing.push("property");
    if (!ctx.unit) missing.push("unit");
    if (!ctx.fields.issue) missing.push("issue");
    if (!ctx.fields.callbackNumber && !ctx.fromPhone) missing.push("callbackNumber");
    return missing;
  }

  #safeFields(fields) {
    const { callbackNumber, ...safe } = fields;
    return { ...safe, callbackMasked: maskPhone(callbackNumber) };
  }

  #publicIncident(incident) {
    if (!incident) return null;
    return {
      id: incident.id,
      reference: incidentReference(incident.id),
      state: incident.state,
      severity: incident.severity,
      issueType: incident.issueType,
      issueTypeLabel: incident.issueTypeLabel ?? issueLabel(incident.issueType),
      propertyId: incident.propertyId,
      propertyName: incident.propertyName,
      unit: incident.unit,
      reportedAt: incident.reportedAt,
      acknowledgedAt: incident.acknowledgedAt,
      closedAt: incident.closedAt,
      acknowledgedBy: incident.acknowledgedBy,
      timeToAcknowledgeMs: incident.acknowledgedAt ? Date.parse(incident.acknowledgedAt) - Date.parse(incident.reportedAt) : null,
      bridgeRequested: Boolean(incident.bridgeRequested),
      duplicatesAttached: incident.duplicatesAttached ?? 0,
      permissionToEnter: Boolean(incident.permissionToEnter),
      accessNotes: incident.accessNotes,
      tenantSaid: incident.tenantSaid,
      callbackMasked: incident.callbackMasked,
      matchedRule: incident.matchedRule,
      simulated: Boolean(incident.simulated),
    };
  }

  #scripted(ctx) {
    return Boolean(ctx?.simulated && ctx.interactive);
  }

  #otherParty(ctx) {
    if (ctx.leg && (ctx.phase === "ringing" || ctx.phase === "briefed")) return ctx.leg.contact.name;
    return ctx.callerName ? firstName(ctx.callerName) : "Caller";
  }

  #agentLabel(ctx) {
    if (ctx?.leg && (ctx.phase === "ringing" || ctx.phase === "briefed")) return `Agent → ${firstName(ctx.leg.contact.name)}`;
    return null;
  }

  #line(ctx, role, text, label = null) {
    const line = { role, text, label, at: iso(this.now()) };
    ctx.transcript.push(line);
    if (role === "agent") ctx.spoken.push(text);
    this.#publish(ctx.id, "transcript", { role, text, label });
    return line;
  }

  #event(ctx, incidentId, source, kind, detail = null) {
    const at = iso(this.now());
    const event = { source, kind, detail, at };
    if (incidentId) this.audit.recordEvent(incidentId, source, kind, detail, at);
    if (ctx) ctx.events.push(event);
    const target = ctx?.id ?? incidentId;
    if (target) this.#publish(target, "event", event);
    return event;
  }

  #state(ctx) {
    if (!ctx) return;
    ctx.seq += 1;
    this.#publish(ctx.id, "state", this.snapshot(ctx.id));
  }

  #changed(ctx, incidentId) {
    if (ctx) this.#state(ctx);
    else if (incidentId) this.#publish(incidentId, "incident", this.snapshotIncident(incidentId));
  }

  #publish(userId, target, payload) {
    this.hub?.send?.(userId, target, payload);
  }
}

/** Records instead of dialing: what would have been called, minus every phone number. */
export class SimulatedDialer {
  constructor() {
    this.calls = [];
  }
  async pageTechnician(payload) {
    this.calls.push({ kind: "page", ...redactPayload(payload) });
    return { ok: true, simulated: true };
  }
  async statusCall(payload) {
    this.calls.push({ kind: "status", incidentId: payload.incident.id, message: payload.message });
    return { ok: true, simulated: true };
  }
  async bridgeToTenant(payload) {
    this.calls.push({ kind: "bridge", incidentId: payload.incident.id });
    return { ok: true, simulated: true };
  }
}

function redactPayload(payload) {
  return { incidentId: payload.incident.id, contact: { id: payload.contact.id, name: payload.contact.name }, brief: payload.brief, outcome: payload.outcome };
}

/**
 * A failed call or Teams post: the error goes to the server log, and the console
 * and the audit get fixed wording. An ACS error can name the number it dialed,
 * and a fetch error can echo the signed workflow URL.
 */
function serverLogged(step, err, shown) {
  console.error(`[pager] ${step} failed:`, err?.message ?? err);
  return `${shown} (the reason is in the server log)`;
}

const iso = (ms) => new Date(ms).toISOString();
const firstName = (name) => String(name ?? "").trim().split(/\s+/)[0] || "there";
const titleCase = (value) => String(value ?? "").replace(/^./, (c) => c.toUpperCase());
const article = (word) => (/^[aeiou]/i.test(String(word ?? "")) ? "an" : "a");

export function issueLabel(type) {
  return (
    {
      active_leak: "active leak",
      no_heat: "no heat",
      lockout: "lockout",
      no_power: "no power",
      emergency: "emergency",
      routine_maintenance: "maintenance request",
      routine_other: "maintenance request",
    }[type] ?? type
  );
}

/** "6:05" — minutes and seconds. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms ?? 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function mergeNote(a, b, max) {
  return sanitizeTenantSaid([a, b].filter(Boolean).join(" | "), max);
}

function previousLevel(levels, level) {
  const idx = levels.indexOf(level);
  return idx > 0 ? levels[idx - 1] : null;
}

function ruleKeyword(matchedRule) {
  const parts = String(matchedRule ?? "").replace(/^escalated:/, "").split(":");
  return parts.length > 2 ? parts.slice(2).join(":") : (parts[1] ?? null);
}

/** Why the policy decided what it did, in a sentence the console can show. */
export function classificationReason(cls, fields = {}, thresholdF = 55) {
  const keyword = ruleKeyword(cls.matchedRule);
  const temp = Number(fields.indoorTempF);
  const hasTemp = fields.indoorTempF != null && Number.isFinite(temp);
  if (cls.severity === "emergency") return `"${keyword}" is an emergency keyword — the 911 safety line comes first, then the on-call technician is paged.`;
  if (cls.issueType === "no_heat") {
    if (!hasTemp) return `No heat — the inside temperature decides it (urgent at ${thresholdF}°F or below).`;
    return temp <= thresholdF
      ? `${temp}°F inside is at or below the ${thresholdF}°F no-heat line — urgent, page now.`
      : `${temp}°F inside is above the ${thresholdF}°F no-heat line — routine, a work order instead of a page.`;
  }
  if (cls.severity === "urgent") return `"${keyword}" matches the ${issueLabel(cls.issueType)} rule — urgent after hours, page now.`;
  if (cls.matchedRule === "routine:default") return "Nothing in the paging policy matched — routine, a work order instead of a page.";
  return `"${keyword}" is routine maintenance — a work order instead of a page.`;
}

function classificationView(cls, fields, thresholdF) {
  const temp = Number(fields?.indoorTempF);
  return {
    severity: cls.severity,
    issueType: cls.issueType,
    issueTypeLabel: issueLabel(cls.issueType),
    matchedRule: cls.matchedRule,
    keyword: ruleKeyword(cls.matchedRule),
    safetyLine: cls.safetyLine ?? null,
    gate: cls.issueType === "no_heat" ? { thresholdF, indoorTempF: fields?.indoorTempF != null && Number.isFinite(temp) ? temp : null } : null,
    missingSlots: cls.missingSlots ?? [],
    reason: classificationReason(cls, fields, thresholdF),
  };
}

function accessSummary(fields) {
  const permission = fields.permissionToEnter ? "May enter" : "No permission to enter";
  return fields.accessNotes ? `${permission} · ${fields.accessNotes}` : permission;
}

/** What the voicemail prompt left out — checked against the prompt itself, not assumed. */
function withheldFrom(prompt, incident) {
  const text = String(prompt ?? "").toLowerCase();
  const items = [
    ["Property", incident.propertyName],
    ["Unit", incident.unit ? `unit ${incident.unit}` : null],
    ["Problem", incident.issueTypeLabel ?? issueLabel(incident.issueType)],
    ["Tenant's words", incident.tenantSaid],
    ["Access details", incident.accessNotes && incident.accessNotes !== "none" ? incident.accessNotes : null],
  ];
  const checks = items
    .filter(([, value]) => value)
    .map(([label, value]) => ({ label, value: String(value), withheld: !text.includes(String(value).toLowerCase()) }));
  checks.push({ label: "Phone numbers", value: "any", withheld: !/\d{3}[\s.-]?\d{4}/.test(text) });
  return checks;
}

/** A technician's question, mapped to the one stored field it may read. */
function detailKey(field) {
  const f = String(field ?? "").toLowerCase();
  if (/phone|number|cell|mobile|callback|call back|contact|digits/.test(f)) return "phone";
  if (/permission|allowed|let (myself|me) in|may i enter|go in/.test(f)) return "permission";
  if (/access|key|lockbox|door|gate|code|get in|entry|entrance/.test(f)) return "access";
  if (/unit|apartment|apt/.test(f)) return "unit";
  if (/property|building|address|where/.test(f)) return "property";
  if (/severity|urgent|priority|how bad/.test(f)) return "severity";
  if (/said|words|quote|note/.test(f)) return "note";
  if (/when|time|reported/.test(f)) return "time";
  if (/issue|problem|what|wrong/.test(f)) return "issue";
  return null;
}
