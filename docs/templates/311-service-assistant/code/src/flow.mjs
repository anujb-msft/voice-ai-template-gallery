import { randomUUID } from "node:crypto";
import { config, clockNow } from "./config.mjs";
import { buildHandoffContext } from "./handoff.mjs";

export const STATES = Object.freeze({
  RINGING: "ringing",
  GREETING: "greeting",
  LISTENING: "listening",
  ANSWERING: "answering",
  INTAKE: "intake",
  CONFIRMING: "confirming",
  FILED: "filed",
  STATUS: "status",
  GUIDED: "guided",
  TRANSFERRING: "transferring",
  TRANSFERRED: "transferred",
  EMERGENCY_REDIRECT: "emergency_redirect",
  CLOSING: "closing",
  ENDED: "ended",
});

const TERMINAL = new Set([STATES.TRANSFERRED, STATES.ENDED]);
const OPENING = "City of Contoso 311. I'm an automated assistant. For emergencies, hang up and dial 911. How can I help? Para español, hable en español.";

export class ServiceAssistantFlow {
  constructor({ requests, departments, content, geocoder, cases, emergency, bulkPickup, audit, transfer = null, sms = null, hub = null, now = () => clockNow(), options = {} }) {
    this.requests = requests;
    this.departments = departments;
    this.content = content;
    this.geocoder = geocoder;
    this.cases = cases;
    this.emergency = emergency;
    this.bulkPickupConfig = bulkPickup;
    this.audit = audit;
    this.transferFn = transfer;
    this.sms = sms;
    this.hub = hub;
    this.now = now;
    this.options = { maxRequestsPerCall: config.maxRequestsPerCall, callTimeBudgetMs: config.callTimeBudgetMs, duplicateRadiusM: config.duplicate.radiusM, duplicateWindowDays: config.duplicate.windowDays, ...options };
    this.calls = new Map();
    this.agents = new Map();
  }

  create({ callId = randomUUID(), fromPhone = null, incomingCallContext = null, sessionId = null, resourceAccountId = null } = {}) {
    const call = { id: callId, fromPhone, maskedPhone: maskPhone(fromPhone), incomingCallContext, sessionId, resourceAccountId, arrival: resourceAccountId ? "teams-phone-extensibility" : "acs-direct", callConnectionId: null, state: STATES.RINGING, language: "en-US", startedAt: this.now(), answeredAt: null, endedAt: null, transcript: [], requestsHandled: 0, failedAttempts: 0, noInputs: 0, lastSpoken: null, current: null, bulk: null, lastCase: null, transferDepartmentId: null, outcome: null, wrapPrompted: false, modelContext: [] };
    this.calls.set(call.id, call);
    this.audit.startCall({ id: call.id, state: call.state, language: call.language, startedAt: call.startedAt });
    this.#event(call, "system", "call_created", call.arrival);
    return call;
  }

  get(callId) { return this.calls.get(callId) ?? null; }
  registerAgent(callId, handle) { this.agents.set(callId, handle); }
  unregisterAgent(callId) { this.agents.delete(callId); }
  setCallConnection(callId, id) { const c = this.get(callId); if (c) c.callConnectionId = id; }

  answered(callId) {
    const call = this.#require(callId);
    call.answeredAt = this.now();
    this.#setState(call, STATES.GREETING);
    this.#say(call, OPENING);
    this.#setState(call, STATES.LISTENING);
    return this.snapshot(callId);
  }

  observeCaller(callId, text) {
    const call = this.#require(callId);
    const said = String(text ?? "").trim();
    if (!said) return this.noInput(callId);
    if (looksSpanish(said)) this.setLanguage(callId, "es-US");
    this.pushTranscript(callId, "caller", said);
    const emergency = this.checkEmergency(said);
    if (emergency) return this.emergencyRedirect(callId, emergency);
    return { ok: true };
  }

  setLanguage(callId, language) {
    const call = this.#require(callId);
    if (call.language === language) return;
    call.language = language;
    this.audit.updateCall(call.id, { language });
    this.#event(call, "system", "language", language);
  }

  checkEmergency(text) {
    const normalized = normalize(text);
    for (const category of this.emergency.categories ?? []) {
      for (const lang of ["en", "es"]) for (const phrase of category.phrases?.[lang] ?? []) {
        if (normalized.includes(normalize(phrase))) return category;
      }
    }
    return null;
  }

  emergencyRedirect(callId, category) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    call.current = null;
    const line = category.id === "gas" ? `This sounds like a gas emergency. Please hang up and call the ${category.redirect} now.` : "This sounds like an emergency. Please hang up and dial 911 now.";
    this.#event(call, "system", "emergency_redirect", category.id);
    this.#setState(call, STATES.EMERGENCY_REDIRECT);
    this.#say(call, line);
    this.#finish(call, STATES.ENDED, `emergency:${category.id}`);
    return { ok: true, category: category.id, redirect: category.redirect, createdCase: false, phrase: line };
  }

  searchFaq(callId, query) {
    const call = this.#require(callId);
    if (this.#budgetExpired(call)) return this.#expire(call);
    const passages = this.content.search(query, call.language);
    this.#event(call, "agent", "search_faq", query);
    this.#publish(call, "faq", { query, passages });
    if (!passages.length) {
      const phrase = call.language.startsWith("es") ? "No tengo información aprobada sobre eso. Puedo comunicarle con el personal de 311." : "I don't have approved information on that. I can connect you with 311 staff.";
      this.#say(call, phrase);
      return { ok: false, reason: "no_approved_information", phrase, passages: [] };
    }
    const p = passages[0];
    const caveat = p.freshness === "stale" ? " This information may need confirmation." : "";
    const phrase = `${p.passage} Source: ${p.spokenCitation}.${caveat}`;
    this.#setState(call, STATES.ANSWERING);
    this.#say(call, phrase);
    this.#afterRequestPrompt(call, false);
    return { ok: true, passages, phrase };
  }

  startRequest(callId, typeId) {
    const call = this.#require(callId);
    if (call.requestsHandled >= this.options.maxRequestsPerCall) return this.transfer(callId, { reason: "request_limit", departmentId: "311-live" });
    const type = this.requests.get(typeId);
    if (!type) return this.fail(callId, `unknown request type ${typeId}`);
    call.current = { typeId, fields: {}, missing: [...type.required], location: null, confirmedLocation: false, originalLanguage: call.language };
    this.#setState(call, STATES.INTAKE);
    this.#event(call, "agent", "request_started", typeId);
    this.#publish(call, "intake", this.currentIntakeSnapshot(call));
    return { ok: true, type: typeId, missing: call.current.missing };
  }

  resolveLocation(callId, utterance) {
    const call = this.#require(callId);
    if (!call.current) return { ok: false, reason: "no_active_request" };
    const result = this.geocoder.resolve(utterance);
    if (result.ok) {
      call.current.location = result;
      call.current.fields.location = result.normalized;
      call.current.confirmedLocation = true;
      this.#recomputeMissing(call);
    } else if (result.unverified) {
      call.current.fields.landmark = result.landmark;
    }
    this.#event(call, "agent", "location_resolved", result.ok ? result.normalized : result.ambiguous ? "ambiguous" : "unverified");
    this.#publish(call, "location", result);
    return { ...result, missing: call.current.missing };
  }

  setField(callId, name, value) {
    const call = this.#require(callId);
    if (!call.current) return { ok: false, reason: "no_active_request" };
    const type = this.requests.get(call.current.typeId);
    const field = type.fields?.[name];
    const clean = validateField(field, value);
    if (!clean.ok) return clean;
    call.current.fields[name] = clean.value;
    this.#recomputeMissing(call);
    this.#event(call, "agent", "field_set", name);
    this.#publish(call, "intake", this.currentIntakeSnapshot(call));
    return { ok: true, missing: call.current.missing, fields: call.current.fields };
  }

  submitRequest(callId) {
    const call = this.#require(callId);
    if (!call.current) return { ok: false, reason: "no_active_request" };
    this.#recomputeMissing(call);
    if (call.current.missing.length) return { ok: false, reason: "missing_required", missing: call.current.missing };
    const type = this.requests.get(call.current.typeId);
    const department = this.departments.get(type.department);
    const location = call.current.location;
    const duplicate = this.cases.findDuplicates({ type: type.id, location, radiusM: type.duplicate?.radiusM ?? this.options.duplicateRadiusM, windowDays: type.duplicate?.windowDays ?? this.options.duplicateWindowDays })[0];
    if (duplicate) {
      const attached = this.cases.attach(duplicate, { callId: call.id, at: new Date(this.now()).toISOString() });
      call.lastCase = attached;
      call.current = null;
      call.requestsHandled += 1;
      this.#event(call, "system", "duplicate_attached", attached.id);
      const phrase = `That ${type.id.replaceAll("-", " ")} was already reported, case ${speakCaseNumber(attached.id)}. I've added your report to it.`;
      this.#say(call, phrase);
      this.#setState(call, STATES.FILED);
      this.#afterRequestPrompt(call);
      return { ok: true, duplicate: true, caseNumber: attached.id, spokenCaseNumber: speakCaseNumber(attached.id), phrase };
    }
    const priority = isPriority(type, call.current.fields);
    const created = this.cases.create({ type: type.id, department: department.id, location, lat: location.lat, lon: location.lon, zone: location.zone, fields: { ...call.current.fields }, priority, language: call.language, originalLanguage: call.current.originalLanguage });
    call.lastCase = created;
    call.current = null;
    call.requestsHandled += 1;
    this.#event(call, "system", "case_created", created.id);
    this.#publish(call, "case", created);
    const phrase = `Your case number is ${speakCaseNumber(created.id)}. Again, ${speakCaseNumber(created.id)}.`;
    this.#say(call, phrase);
    this.#setState(call, STATES.FILED);
    if (priority) {
      const open = this.departments.isOpen(department.id, new Date(this.now()));
      if (open) return { ...this.transfer(callId, { reason: "priority", departmentId: department.id }), caseNumber: created.id, priority: true };
      const afterHours = this.departments.nextBusinessPhrase(department.id);
      this.#say(call, afterHours);
      return { ok: true, caseNumber: created.id, spokenCaseNumber: speakCaseNumber(created.id), priority: true, afterHours: true, phrase: `${phrase} ${afterHours}` };
    }
    this.#afterRequestPrompt(call);
    return { ok: true, duplicate: false, caseNumber: created.id, spokenCaseNumber: speakCaseNumber(created.id), priority, phrase };
  }

  setContact(callId, { wantsUpdates, useCallerId = false, name = null, callbackNumber = null } = {}) {
    const call = this.#require(callId);
    if (!call.lastCase) return { ok: false, reason: "no_case" };
    const contact = wantsUpdates ? { wantsUpdates: true, useCallerId: Boolean(useCallerId), name: name ? "provided" : null, callbackNumber: useCallerId ? "caller-id-consented" : callbackNumber ? "provided" : null } : { wantsUpdates: false };
    this.cases.updateContact(call.lastCase.id, contact);
    call.lastCase.contact = contact;
    this.#event(call, "agent", "contact_set", wantsUpdates ? "updates" : "anonymous");
    return { ok: true, caseNumber: call.lastCase.id, storedOutsideModel: true, contact: { wantsUpdates: contact.wantsUpdates } };
  }

  getCaseStatus(callId, caseNumber) {
    const call = this.#require(callId);
    const c = this.cases.getStatus(normalizeCaseNumber(caseNumber));
    this.#setState(call, STATES.STATUS);
    if (!c) {
      const phrase = `I couldn't find a case with that number.`;
      this.#say(call, phrase);
      return { ok: false, reason: "not_found", phrase };
    }
    const dept = this.departments.get(c.department)?.displayName ?? c.department;
    const phrase = `That case is ${c.status.replaceAll("_", " ")} with ${dept}.`;
    this.#say(call, phrase);
    this.#afterRequestPrompt(call, false);
    return { ok: true, status: c.status, department: dept, phrase };
  }

  bulkPickup(callId, items = []) {
    const call = this.#require(callId);
    const normalized = items.map((i) => String(i).toLowerCase().trim()).filter(Boolean);
    const ineligible = normalized.filter((i) => this.bulkPickupConfig.ineligibleItems.includes(i) || !this.bulkPickupConfig.eligibleItems.includes(i));
    this.#setState(call, STATES.GUIDED);
    this.#event(call, "agent", "guided_started", "bulk-pickup");
    if (ineligible.length) return { ok: false, reason: "ineligible_item", ineligible, phrase: `${ineligible.join(", ")} is not eligible for bulk pickup.` };
    if (normalized.length > this.bulkPickupConfig.maxItemsPerCall) return { ok: false, reason: "too_many_items", limit: this.bulkPickupConfig.maxItemsPerCall };
    call.bulk = { items: normalized, zone: null, date: null };
    return { ok: true, eligible: normalized, needsLocation: true };
  }

  confirmBulkPickup(callId, locationUtterance = null) {
    const call = this.#require(callId);
    if (!call.bulk) return { ok: false, reason: "no_bulk_flow" };
    const location = locationUtterance ? this.geocoder.resolve(locationUtterance) : null;
    const zone = location?.zone ?? "A";
    const date = this.bulkPickupConfig.calendar[zone]?.[0];
    const created = this.cases.create({ type: "bulk-pickup", department: "sanitation", location: location?.ok ? location : { normalized: `Zone ${zone}`, zone }, fields: { items: call.bulk.items, pickupDate: date }, priority: false, language: call.language });
    call.lastCase = created;
    call.bulk = null;
    call.requestsHandled += 1;
    this.#event(call, "agent", "guided_completed", "bulk-pickup");
    const phrase = `Bulk pickup is scheduled for ${date}. Your case number is ${speakCaseNumber(created.id)}. Again, ${speakCaseNumber(created.id)}.`;
    this.#say(call, phrase);
    this.#afterRequestPrompt(call);
    return { ok: true, date, caseNumber: created.id, spokenCaseNumber: speakCaseNumber(created.id), phrase };
  }

  async sendFormLink(callId, serviceId) {
    const call = this.#require(callId);
    this.#event(call, "agent", "sms_link_sent", serviceId);
    if (this.sms) {
      const sent = await this.sms.send({ to: call.fromPhone, serviceId, locale: call.language });
      return { ok: sent.ok, simulated: false, serviceId, to: call.maskedPhone, link: sent.link, phrase: "I've sent the link by text." };
    }
    return { ok: true, simulated: true, serviceId, to: call.maskedPhone, phrase: "I've sent the link by text." };
  }

  transfer(callId, { reason = "caller_requested", departmentId = "311-live" } = {}) {
    const call = this.#require(callId);
    const department = this.departments.get(departmentId) ?? this.departments.get("311-live");
    if (!this.departments.isOpen(department.id, new Date(this.now())) && reason !== "relay") {
      const phrase = this.departments.nextBusinessPhrase(department.id);
      this.#say(call, phrase);
      this.#event(call, "system", "transfer_after_hours", department.id);
      return { ok: true, transferred: false, afterHours: true, phrase };
    }
    call.transferDepartmentId = department.id;
    const context = buildHandoffContext(call, { department, reason });
    this.#setState(call, STATES.TRANSFERRING);
    this.#event(call, "system", "transfer_started", reason);
    this.#say(call, `I'm connecting you with ${department.displayName} now.`);
    if (!this.transferFn) {
      this.#publish(call, "handoff", context);
      this.#finish(call, STATES.TRANSFERRED, `transferred:${department.id}`, { durationMs: this.now() - call.startedAt });
      return { ok: true, transferred: true, simulated: true, department: department.id, context };
    }
    return Promise.resolve(this.transferFn(call, { target: department.teamsQueue, context })).then(() => {
      this.#finish(call, STATES.TRANSFERRED, `transferred:${department.id}`);
      return { ok: true, transferred: true, department: department.id, context };
    });
  }

  fail(callId, reason = "failed_attempt") {
    const call = this.#require(callId);
    call.failedAttempts += 1;
    this.#event(call, "agent", "failed_attempt", reason);
    if (call.failedAttempts >= 2) return this.transfer(callId, { reason: "failed_twice", departmentId: "311-live" });
    this.#say(call, "Sorry, I didn't get that. Could you say it another way?");
    return { ok: false, reason, remaining: 2 - call.failedAttempts };
  }

  dtmf(callId, digit) {
    if (digit === "0") return this.transfer(callId, { reason: "dtmf_0", departmentId: "311-live" });
    if (digit === "1") return { ok: true, digit, meaning: "yes" };
    if (digit === "2") return { ok: true, digit, meaning: "no" };
    if (digit === "*") return this.repeatLast(callId);
    this.#event(this.#require(callId), "caller", "dtmf_ignored", digit);
    return { ok: false, reason: "unmapped_digit" };
  }

  repeatLast(callId) { const call = this.#require(callId); if (call.lastSpoken) this.#say(call, call.lastSpoken); return { ok: true, repeated: call.lastSpoken }; }
  noInput(callId) { const call = this.#require(callId); call.noInputs += 1; this.#event(call, "caller", "no_input", String(call.noInputs)); if (call.noInputs >= 2) return this.endCall(callId, "two_no_inputs"); this.#say(call, "Are you still there? You can press 0 for a person."); return { ok: true, noInputs: call.noInputs }; }
  checkBudget(callId) { const call = this.get(callId); if (!call) return { ok: true }; const elapsed = this.now() - (call.answeredAt ?? call.startedAt); if (!call.wrapPrompted && elapsed >= this.options.callTimeBudgetMs - 30000) { call.wrapPrompted = true; this.#say(call, "We're almost out of time. Let's finish this up."); return { ok: true, wrapUp: true }; } if (elapsed >= this.options.callTimeBudgetMs) return this.#expire(call); return { ok: true }; }
  endCall(callId, outcome = "ended") { const call = this.get(callId); if (!call || TERMINAL.has(call.state)) return { ok: true }; this.#finish(call, STATES.ENDED, outcome); return { ok: true }; }
  settled(callId) { return Promise.resolve(this.snapshot(callId)); }

  pushTranscript(callId, role, text) { const call = this.get(callId); if (!call || !text) return; call.transcript.push({ role, text, at: this.now() }); this.audit.recordTranscript?.(callId, role, text); this.#publish(call, "transcript", { role, text }); }
  currentIntakeSnapshot(call) { return call.current ? { typeId: call.current.typeId, missing: call.current.missing, fields: call.current.fields, location: call.current.location } : null; }
  snapshot(callId) {
    const call = this.get(callId);
    if (!call) return null;
    return { id: call.id, state: call.state, language: call.language, maskedPhone: call.maskedPhone, requestsHandled: call.requestsHandled, current: this.currentIntakeSnapshot(call), lastCase: call.lastCase ? publicCase(call.lastCase) : null, lastSpoken: call.lastSpoken, transcript: call.transcript, elapsedMs: (call.endedAt ?? this.now()) - call.startedAt, budgetMs: this.options.callTimeBudgetMs, outcome: call.outcome };
  }
  sanitizedModelContext(callId) { const call = this.#require(callId); return call.modelContext.map((x) => ({ ...x })); }

  #require(callId) { const call = this.get(callId); if (!call) throw new Error(`unknown call ${callId}`); return call; }
  #recomputeMissing(call) { const type = this.requests.get(call.current.typeId); call.current.missing = type.required.filter((f) => f === "location" ? !call.current.confirmedLocation : call.current.fields[f] == null || call.current.fields[f] === ""); }
  #budgetExpired(call) { return call.answeredAt != null && !TERMINAL.has(call.state) && this.now() - call.answeredAt >= this.options.callTimeBudgetMs; }
  #expire(call) { this.#say(call, "We've reached the call time limit, so I'll close this call now. Please call 311 again if you need more help."); this.#finish(call, STATES.ENDED, "time_budget_expired"); return { ok: true, expired: true }; }
  #afterRequestPrompt(call, counted = true) { this.#setState(call, STATES.LISTENING); if (counted && call.requestsHandled >= this.options.maxRequestsPerCall) this.#say(call, "I can handle up to three requests on this call. I'll connect you with 311 staff for anything else."); else this.#say(call, "Is there anything else?"); }
  #say(call, text) { call.lastSpoken = text; this.pushTranscript(call.id, "agent", text); this.agents.get(call.id)?.instruct?.("Speak this exact line.", text); }
  #finish(call, state, outcome, extra = {}) { call.outcome = outcome; call.endedAt = this.now(); this.#setState(call, state); this.audit.updateCall(call.id, { outcome, endedAt: call.endedAt, durationMs: call.endedAt - call.startedAt, ...extra }); }
  #setState(call, state) { if (call.state === state) return; const from = call.state; call.state = state; this.audit.updateCall(call.id, { state }); this.#event(call, "system", "state", `${from} → ${state}`); this.#publish(call, "state", this.snapshot(call.id)); }
  #event(call, source, kind, detail) { this.audit.recordEvent(call.id, source, kind, detail); this.#publish(call, "event", { source, kind, detail, at: new Date(this.now()).toISOString() }); }
  #publish(call, target, payload) { this.hub?.send?.(call.id, target, payload); }
}

export function speakCaseNumber(value) {
  const m = /^([A-Z]{2})-(\d{2})-(\d{4})$/i.exec(String(value));
  if (!m) return String(value).split("").join(" ");
  return `${m[1].toUpperCase().split("").join(" ")}, ${m[2].split("").join(" ")}, ${m[3].split("").join(" ")}`;
}
function validateField(field, value) {
  if (!field) return { ok: true, value };
  if (field.type === "enum") {
    const lower = String(value).toLowerCase().trim();
    const match = field.values.find((v) => v === lower);
    return match ? { ok: true, value: match } : { ok: false, reason: "invalid_enum", values: field.values };
  }
  if (field.type === "boolean") return { ok: true, value: typeof value === "boolean" ? value : /^(yes|true|1|si|sí|y)$/i.test(String(value)) };
  return { ok: true, value: String(value).trim() };
}
function isPriority(type, fields) { return Object.entries(type.priorityWhen ?? {}).length > 0 && Object.entries(type.priorityWhen).every(([k, v]) => fields[k] === v); }
function publicCase(c) { return { id: c.id, type: c.type, department: c.department, status: c.status, location: c.location?.normalized ?? c.locationText, meToo: c.meToo, priority: c.priority, fields: c.fields }; }
function normalizeCaseNumber(s) { return String(s).toUpperCase().replace(/\bS\s*R\b/, "SR").replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function normalize(s) { return String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim(); }
function looksSpanish(s) { return /\b(hola|espanol|español|bache|basura|grafiti|ruido|permiso|si|sí)\b/i.test(s); }
function maskPhone(phone) { if (!phone) return null; const digits = String(phone).replace(/\D/g, ""); return digits.length < 4 ? "****" : `***-${digits.slice(-4)}`; }
