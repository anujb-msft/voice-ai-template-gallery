import { randomUUID } from "node:crypto";
import { config, clockNow } from "./config.mjs";
import { buildHandoffContext, buildCustomCallingContext, clipTopic } from "./handoff.mjs";
import { norm, zonedParts } from "./fixtures.mjs";
import { linkFor } from "./sms.mjs";

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
export const OPENING = "City of Contoso 311. I'm an automated assistant. For emergencies, hang up and dial 911. How can I help? Para español, hable en español.";
/** Every line the caller hears is written by the server; the voice model only speaks it. */
export const SAY_EXACTLY = "Say exactly this, word for word, then stop and listen:";
const SMS_FROM = "City of Contoso 311";

const REASONS = {
  priority: "Priority hazard",
  complaint: "Complaint",
  caller_requested: "Caller asked for a person",
  dtmf_0: "Caller pressed 0",
  failed_twice: "Not understood twice",
  request_limit: "Request limit reached",
  relay: "Relay caller",
  no_answer: "No approved answer",
  transfer_fallback: "Transfer fallback",
};

const FIELD_PROMPTS = {
  location: ["Where is it? A street address or the nearest cross street works best.", "¿Dónde está? Lo mejor es una dirección o la calle transversal más cercana."],
  size: ["Is it small, medium, or large? And is it in a travel lane?", "¿Es pequeño, mediano o grande? ¿Y está en un carril de circulación?"],
  poleNumber: ["Is there a number on the pole? If not, just say no number.", "¿El poste tiene un número? Si no, diga sin número."],
  pickupType: ["Was it trash, recycling, or yard waste?", "¿Era basura, reciclaje o residuos de jardín?"],
  surface: ["Is the graffiti on a building, a sign, a sidewalk, or a wall?", "¿El grafiti está en un edificio, un letrero, una acera o un muro?"],
  vehicleDescription: ["Can you describe the vehicle? The color and type are enough.", "¿Puede describir el vehículo? El color y el tipo son suficientes."],
  noiseType: ["What kind of noise is it: music, construction, or something else?", "¿Qué tipo de ruido es: música, construcción u otro?"],
};

const STATUS_WORDS = {
  open: { en: "open", es: "abierto" },
  in_progress: { en: "in progress", es: "en curso" },
  closed: { en: "closed", es: "cerrado" },
};

const NUMBER_WORDS = {
  en: ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"],
  es: ["cero", "una", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez"],
};
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const LANDMARKS_ES = { "in front of the library": "frente a la biblioteca" };
const LANGUAGE_NAMES = { en: "English", es: "Spanish" };

export class ServiceAssistantFlow {
  constructor({ requests, departments, content, geocoder, cases, emergency, bulkPickup, audit, transfer = null, sms = null, hub = null, now = () => clockNow(), offlineTexts = true, options = {} }) {
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
    // With no real SMS sender, texts are shown on the console instead of sent.
    this.offlineTexts = offlineTexts;
    this.options = {
      maxRequestsPerCall: config.maxRequestsPerCall,
      callTimeBudgetMs: config.callTimeBudgetMs,
      duplicateRadiusM: config.duplicate.radiusM,
      duplicateWindowDays: config.duplicate.windowDays,
      transferDelayMs: 0,
      voices: config.voiceLive.voices,
      ...options,
    };
    this.calls = new Map();
    this.agents = new Map();
    this.outbox = [];
    this.textSeq = 0;
    this.itemAliases = buildItemAliases(bulkPickup);
  }

  create({ callId = randomUUID(), fromPhone = null, incomingCallContext = null, sessionId = null, resourceAccountId = null, simulated = false } = {}) {
    const call = {
      id: callId,
      fromPhone,
      maskedPhone: maskPhone(fromPhone),
      incomingCallContext,
      sessionId,
      resourceAccountId,
      arrival: simulated ? "simulated" : resourceAccountId ? "teams-phone-extensibility" : "acs-direct",
      simulated: Boolean(simulated),
      callConnectionId: null,
      state: STATES.RINGING,
      language: "en-US",
      agentLocale: "en-US",
      voice: this.#voiceFor("en-US"),
      startedAt: this.now(),
      answeredAt: null,
      endedAt: null,
      transcript: [],
      requestsHandled: 0,
      failedAttempts: 0,
      noInputs: 0,
      lastSpoken: null,
      current: null,
      bulk: null,
      lastCase: null,
      cases: [],
      texts: [],
      pending: null,
      complaint: null,
      sentiment: "neutral",
      emergency: null,
      faq: null,
      handoff: null,
      decision: null,
      decisions: [],
      updates: null,
      updatesDeclined: false,
      transferDepartmentId: null,
      outcome: null,
      wrapPrompted: false,
      cancelled: false,
      work: new Set(),
      toSpeak: [],
      unspoken: [],
      modelContext: [],
    };
    this.calls.set(call.id, call);
    this.audit.startCall({ id: call.id, state: call.state, language: call.language, startedAt: call.startedAt, simulated: call.simulated });
    this.#event(call, "system", "call_created", call.arrival);
    return call;
  }

  get(callId) { return this.calls.get(callId) ?? null; }

  registerAgent(callId, handle) {
    this.agents.set(callId, handle);
    const call = this.get(callId);
    // Lines spoken before the voice session was ready (the opening, usually) are said now.
    if (call?.unspoken.length && handle?.instruct) handle.instruct(SAY_EXACTLY, call.unspoken.splice(0).join(" "));
  }
  unregisterAgent(callId) { this.agents.delete(callId); }
  setCallConnection(callId, id) { const c = this.get(callId); if (c) c.callConnectionId = id; }

  /** Demo reset: forget simulated calls and simulated texts. Real calls are left alone. */
  reset() {
    const removed = [];
    for (const [id, call] of this.calls) {
      if (!call.simulated) continue;
      call.cancelled = true;
      this.calls.delete(id);
      this.agents.delete(id);
      removed.push(id);
    }
    this.outbox = this.outbox.filter((t) => !t.simulated);
    return removed;
  }

  /** The demo clock jumped; move live calls with it so their time budget doesn't jump too. */
  rebaseClock(deltaMs) {
    if (!deltaMs) return;
    for (const call of this.calls.values()) {
      if (TERMINAL.has(call.state)) continue;
      call.startedAt += deltaMs;
      if (call.answeredAt != null) call.answeredAt += deltaMs;
    }
  }

  answered(callId) {
    const call = this.#require(callId);
    if (call.answeredAt != null) return this.snapshot(callId);
    call.answeredAt = this.now();
    this.#setState(call, STATES.GREETING);
    this.#say(call, OPENING);
    this.#setState(call, STATES.LISTENING);
    return this.snapshot(callId);
  }

  /** Every caller turn passes through here first: transcript, language, and the emergency rule. */
  observeCaller(callId, text) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    const said = String(text ?? "").trim();
    if (!said) return this.noInput(callId);
    this.pushTranscript(callId, "caller", said);
    call.noInputs = 0;
    if (!call.language.startsWith("es") && looksSpanish(said)) this.setLanguage(callId, "es-US");
    else if (call.language.startsWith("es") && /\b(in english|english please|speak english|en ingles)\b/.test(norm(said))) this.setLanguage(callId, "en-US");
    const emergency = this.checkEmergency(said);
    if (emergency) return this.emergencyRedirect(callId, emergency);
    if (call.state === STATES.TRANSFERRING) return { ok: false, reason: "transferring" };
    return { ok: true };
  }

  setLanguage(callId, language) {
    const call = this.#require(callId);
    if (!language || call.language === language) return { ok: true, language: call.language };
    call.language = language;
    call.agentLocale = language;
    call.voice = this.#voiceFor(language);
    this.audit.updateCall(call.id, { language });
    this.#event(call, "system", "language", language);
    this.agents.get(call.id)?.setLocale?.(language, call.voice);
    this.#event(call, "system", "agent_locale", `${language} · ${call.voice}`);
    const name = LANGUAGE_NAMES[language.slice(0, 2)] ?? language;
    this.#decide(call, { title: `Caller switched to ${name}`, detail: `Agent locale ${language} · voice ${call.voice}. Same rules, same service.`, verdict: `same rules, in ${name}`, tone: "info" });
    this.#publish(call, "language", { language, agentLocale: call.agentLocale, voice: call.voice });
    return { ok: true, language };
  }

  checkEmergency(text) {
    const said = ` ${norm(text)} `;
    for (const category of this.emergency.categories ?? []) {
      for (const lang of ["en", "es"]) {
        for (const phrase of category.phrases?.[lang] ?? []) {
          if (said.includes(` ${norm(phrase)} `)) return { ...category, matched: phrase, matchedLanguage: lang };
        }
      }
    }
    return null;
  }

  /** The emergency rule: no intake, no questions, no case. Guidance, then the call ends. */
  emergencyRedirect(callId, category) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    if (category.matchedLanguage === "es" && !call.language.startsWith("es")) this.setLanguage(callId, "es-US");
    const lang = this.#lang(call);
    const cancelledIntake = call.current?.typeId ?? (call.bulk ? "bulk-pickup" : null);
    call.current = null;
    call.bulk = null;
    call.pending = null;
    const guidance = category.guidance?.[lang] ?? this.emergency.guidance?.[lang] ?? this.emergency.guidance?.en ?? "This sounds like an emergency. Please hang up and dial 911 now.";
    call.emergency = { category: category.id, label: category.label ?? category.id, matched: category.matched ?? null, redirect: category.redirect, guidance, createdCase: false, cancelledIntake, at: this.#iso() };
    this.#event(call, "system", "emergency_redirect", category.id);
    this.#publish(call, "emergency", call.emergency);
    const heard = category.matched ? `Heard “${category.matched}”. ` : "";
    this.#decide(call, { title: "Emergency rule fired", detail: `${heard}${call.emergency.label}: safety guidance and ${category.redirect}. No report, no questions${cancelledIntake ? `; the ${cancelledIntake} intake was cancelled` : ""}. The server decided this, not the model.`, verdict: "emergency → no report, no questions", tone: "bad" });
    this.#setState(call, STATES.EMERGENCY_REDIRECT);
    this.#say(call, guidance);
    this.#finish(call, STATES.ENDED, `emergency:${category.id}`);
    return { ok: true, category: category.id, redirect: category.redirect, createdCase: false, phrase: guidance };
  }

  /** Answers come only from approved, unexpired articles, and always name the source. */
  searchFaq(callId, query, { prompt = true } = {}) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    if (this.#budgetExpired(call)) return this.#expire(call);
    const found = this.content.lookup ? this.content.lookup(query, call.language) : { passages: this.content.search(query, call.language), withheld: [] };
    const passages = found.passages ?? [];
    const withheld = found.withheld ?? [];
    call.faq = { query, passages, withheld, answered: passages.length > 0, at: this.#iso() };
    this.#event(call, "agent", "search_faq", query);
    this.#publish(call, "faq", call.faq);
    const lang = this.#lang(call);
    if (!passages.length) {
      const phrase = lang === "es"
        ? "No tengo información aprobada sobre eso, así que no voy a adivinar. ¿Quiere que le comunique con el personal de 311?"
        : "I don't have approved information on that, so I won't guess. Would you like me to connect you with 311 staff?";
      call.pending = "offer-person";
      this.#event(call, "agent", "faq_refused", query);
      const held = withheld.map((w) => `${w.title} (last reviewed ${w.lastReviewed})`).join("; ");
      this.#decide(call, { title: "No approved answer, so no guess", detail: held ? `Matched only expired content, which is withheld: ${held}. Offering 311 staff.` : "Nothing in the approved content matches. Offering 311 staff.", verdict: "no guess → 311 staff offered", tone: "warn" });
      this.#setState(call, STATES.LISTENING);
      this.#say(call, phrase);
      return { ok: false, reason: "no_approved_information", phrase, passages: [], withheld };
    }
    const p = passages[0];
    const caveat = p.freshness === "stale" ? (lang === "es" ? " Es posible que esta información necesite confirmación." : " This information may need confirmation.") : "";
    const phrase = `${p.passage} ${lang === "es" ? "Fuente" : "Source"}: ${p.spokenCitation}.${caveat}`;
    this.#event(call, "agent", "faq_answered", p.id);
    this.#decide(call, {
      title: p.freshness === "stale" ? "Answered with a freshness caveat" : "Answered from approved content",
      detail: `${p.title} · ${p.source} · last reviewed ${p.lastReviewed} (${p.freshness}).${withheld.length ? ` Withheld as expired: ${withheld.map((w) => w.title).join(", ")}.` : ""}`,
      verdict: p.freshness === "stale" ? "answered, with a caveat" : "grounded answer, source named",
      tone: p.freshness === "stale" ? "warn" : "good",
    });
    this.#setState(call, STATES.ANSWERING);
    this.#say(call, phrase);
    this.#setState(call, STATES.LISTENING);
    if (prompt) this.anythingElse(callId);
    return { ok: true, passages, withheld, phrase };
  }

  anythingElse(callId) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    call.pending = "anything-else";
    const phrase = this.#t(call, "Is there anything else I can help you with?", "¿Hay algo más en lo que pueda ayudarle?");
    this.#setState(call, STATES.LISTENING);
    this.#say(call, phrase);
    return { ok: true, phrase };
  }

  whatElse(callId) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    call.pending = null;
    const phrase = this.#t(call, "Sure. What else can I help with?", "Claro. ¿En qué más le puedo ayudar?");
    this.#setState(call, STATES.LISTENING);
    this.#say(call, phrase);
    return { ok: true, phrase };
  }

  startRequest(callId, typeId) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    if (call.requestsHandled >= this.options.maxRequestsPerCall) return this.transfer(callId, { reason: "request_limit", departmentId: "311-live" });
    const type = this.requests.get(typeId);
    if (!type) return this.fail(callId, `unknown request type ${typeId}`);
    call.pending = null;
    call.current = { typeId, fields: {}, missing: [...type.required], location: null, confirmedLocation: false, locationHint: null, originalLanguage: call.language };
    this.#setState(call, STATES.INTAKE);
    this.#event(call, "agent", "request_started", typeId);
    this.#publish(call, "intake", this.currentIntakeSnapshot(call));
    return { ok: true, type: typeId, missing: call.current.missing };
  }

  /**
   * Verify a spoken location against the city's address data. With `readBack`
   * the verified place is read to the caller and the case waits for a yes.
   */
  resolveLocation(callId, utterance, { readBack = false, speak = readBack } = {}) {
    const call = this.#require(callId);
    const cur = call.current;
    if (!cur) return { ok: false, reason: "no_active_request" };
    let result = this.geocoder.resolve(utterance);
    if (!result.ok && cur.locationHint) {
      const retry = this.geocoder.resolve(`${cur.locationHint} ${utterance}`);
      if (retry.ok) result = retry;
    }
    if (result.ok) {
      cur.location = result;
      cur.fields.location = result.normalized;
      cur.confirmedLocation = !readBack;
      cur.locationHint = null;
    } else {
      cur.location = null;
      delete cur.fields.location;
      cur.confirmedLocation = false;
      if (result.ambiguous) cur.locationHint = result.candidates?.[0]?.label?.split(" at ")[0] ?? String(utterance);
      if (result.unverified) cur.fields.landmark = result.landmark;
    }
    this.#recomputeMissing(call);
    this.#event(call, "agent", result.ok ? "location_resolved" : "location_unresolved", result.ok ? result.normalized : result.ambiguous ? "ambiguous" : "unverified");
    this.#publish(call, "location", { ...result, readBack: Boolean(result.ok && readBack) });
    this.#publish(call, "intake", this.currentIntakeSnapshot(call));
    let phrase = null;
    if (result.ok && readBack) {
      call.pending = "confirm-location";
      this.#setState(call, STATES.CONFIRMING);
      phrase = this.#readBack(call, result);
      this.#decide(call, { title: "Location verified, reading it back", detail: `“${String(utterance).trim()}” → ${result.normalized} (${result.kind}, zone ${result.zone}). Nothing is filed until the caller confirms.`, verdict: "read back, waiting for a yes", tone: "info" });
      this.#say(call, phrase);
    } else if (!result.ok && speak) {
      phrase = result.ambiguous
        ? this.#t(call, `I found more than one location on ${cur.locationHint}. What's the nearest cross street?`, `Encontré más de una ubicación en ${cur.locationHint}. ¿Cuál es la calle transversal más cercana?`)
        : this.#t(call, "I couldn't verify that location. What's the street address or the nearest cross street?", "No pude verificar esa ubicación. ¿Cuál es la dirección o la calle transversal más cercana?");
      this.#say(call, phrase);
    }
    return { ...result, readBack: Boolean(result.ok && readBack), missing: cur.missing, phrase };
  }

  confirmLocation(callId, yes = true) {
    const call = this.#require(callId);
    const cur = call.current;
    if (!cur?.location) return { ok: false, reason: "no_location" };
    call.pending = null;
    if (yes) {
      cur.confirmedLocation = true;
      this.#recomputeMissing(call);
      this.#event(call, "caller", "location_confirmed", cur.location.normalized);
      this.#publish(call, "intake", this.currentIntakeSnapshot(call));
      this.#setState(call, STATES.INTAKE);
      if (!cur.missing.length) return this.submitRequest(callId);
      return this.askForMissing(callId);
    }
    this.#event(call, "caller", "location_rejected", cur.location.normalized);
    cur.location = null;
    delete cur.fields.location;
    cur.confirmedLocation = false;
    this.#recomputeMissing(call);
    this.#publish(call, "intake", this.currentIntakeSnapshot(call));
    this.#setState(call, STATES.INTAKE);
    const phrase = this.#t(call, "Sorry about that. What's the street address or the nearest cross street?", "Disculpe. ¿Cuál es la dirección o la calle transversal más cercana?");
    this.#say(call, phrase);
    return { ok: true, confirmed: false, phrase, missing: cur.missing };
  }

  askForMissing(callId) {
    const call = this.#require(callId);
    const field = call.current?.missing[0];
    if (!field) return { ok: true, missing: [] };
    const [en, es] = FIELD_PROMPTS[field] ?? [`What's the ${field}?`, `¿Cuál es el dato de ${field}?`];
    const phrase = this.#t(call, en, es);
    this.#setState(call, STATES.INTAKE);
    this.#say(call, phrase);
    return { ok: true, asked: field, missing: call.current.missing, phrase };
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
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    const cur = call.current;
    if (!cur) return { ok: false, reason: "no_active_request" };
    this.#recomputeMissing(call);
    if (cur.missing.length) return { ok: false, reason: "missing_required", missing: cur.missing };
    const type = this.requests.get(cur.typeId);
    const department = this.departments.get(type.department);
    const location = cur.location;
    const lang = this.#lang(call);
    const label = this.requests.label(type.id, call.language);
    const place = placePhrase(location, lang);
    const radiusM = type.duplicate?.radiusM ?? this.options.duplicateRadiusM;
    const windowDays = type.duplicate?.windowDays ?? this.options.duplicateWindowDays;
    const duplicate = this.cases.findDuplicates({ type: type.id, location, radiusM, windowDays })[0];
    const priority = isPriority(type, cur.fields);
    call.pending = null;
    if (duplicate) {
      // A hazard report on a standard case raises that case; it never files a second one.
      const raise = priority && !duplicate.priority;
      const escalation = raise ? { priority: true, fields: Object.fromEntries(Object.keys(type.priorityWhen ?? {}).map((k) => [k, cur.fields[k]])) } : {};
      const attached = this.cases.attach(duplicate, { callId: call.id, at: this.#iso() }, escalation);
      call.lastCase = attached;
      call.current = null;
      call.requestsHandled += 1;
      const card = this.#upsertCard(call, attached);
      this.#event(call, "system", "duplicate_attached", attached.id);
      if (raise) this.#event(call, "system", "case_escalated", attached.id);
      this.#publish(call, "case", { ...card, duplicate: true, escalated: raise });
      const merged = `An open ${this.requests.label(type.id)} within ${radiusM} m was reported in the last ${windowDays} days, so no duplicate is filed. Reports on it: ${attached.meToo}.`;
      if (raise) this.#decide(call, { title: `Existing case ${attached.id} raised to priority`, detail: `${merged} This report meets the priority rule, so the case is now a priority hazard with a ${card.slaText} response target.`, verdict: "merged and raised to priority", tone: "warn" });
      else this.#decide(call, { title: `Added to existing case ${attached.id}`, detail: `${merged}${priority ? " It is already a priority hazard, so the department is not paged again." : ""}`, verdict: "merged, not filed twice", tone: "info" });
      this.#setState(call, STATES.FILED);
      const spoken = speakCaseNumber(attached.id);
      const dept = this.departments.spokenName(department.id, call.language);
      const merge = lang === "es"
        ? `Ya existe un reporte de ${label} ${place}, así que agregué su reporte al caso ${spoken}. Repito, ${spoken}.`
        : `That ${label} ${place} was already reported, so I've added your report to case ${spoken}. Again, ${spoken}.`;
      const note = raise
        ? this.#t(call, "Because it's a hazard, I've raised that case to priority.", "Como es un peligro, marqué ese caso como prioritario.")
        : priority
          ? this.#t(call, `It's already a priority for ${dept}.`, `Ya es prioritario para ${dept}.`)
          : null;
      const phrase = note ? `${merge} ${note}` : merge;
      this.#say(call, phrase);
      const result = { duplicate: true, meToo: attached.meToo };
      if (raise) return this.#routePriority(call, department, attached, phrase, { ...result, escalated: true });
      this.#afterFiling(call);
      return { ok: true, ...result, caseNumber: attached.id, spokenCaseNumber: spoken, priority: Boolean(attached.priority), phrase };
    }
    const created = this.cases.create({ type: type.id, department: department.id, location, lat: location.lat, lon: location.lon, zone: location.zone, fields: { ...cur.fields }, priority, language: call.language, originalLanguage: cur.originalLanguage, callId: call.id, simulated: call.simulated });
    call.lastCase = created;
    call.current = null;
    call.requestsHandled += 1;
    const card = this.#upsertCard(call, created);
    this.#event(call, "system", "case_created", created.id);
    this.#publish(call, "case", card);
    this.#setState(call, STATES.FILED);
    const spoken = speakCaseNumber(created.id);
    const dept = this.departments.spokenName(department.id, call.language);
    const phrase = lang === "es"
      ? `Registré un reporte de ${label} ${place} con ${dept}. Su número de caso es ${spoken}. Repito, ${spoken}.`
      : `I've filed a ${label} report ${place} with ${dept}. Your case number is ${spoken}. Again, ${spoken}.`;
    this.#decide(call, { title: `Service request ${created.id} created`, detail: `${capitalize(this.requests.label(type.id))} · ${location.normalized} · ${priority ? "priority" : "standard"} · ${department.displayName} · response target ${card.slaText}${card.due ? `, due ${card.due.length > 10 ? zonedParts(new Date(card.due), this.departments.timeZone).date : card.due}` : ""}.`, verdict: priority ? "filed as priority" : "filed after a confirmed location", tone: priority ? "warn" : "good" });
    this.#say(call, phrase);
    if (priority) return this.#routePriority(call, department, created, phrase);
    this.#afterFiling(call);
    return { ok: true, duplicate: false, caseNumber: created.id, spokenCaseNumber: spoken, priority, phrase };
  }

  /** Step 9: a priority hazard goes to its department while it is open, else to the next business day. */
  #routePriority(call, department, c, phrase, extra = {}) {
    const spoken = speakCaseNumber(c.id);
    if (this.departments.isOpen(department.id, new Date(this.now()))) {
      return { ...this.transfer(call.id, { reason: "priority", departmentId: department.id }), caseNumber: c.id, spokenCaseNumber: spoken, priority: true, ...extra };
    }
    const next = this.departments.nextBusinessPhrase(department.id, call.language);
    this.#event(call, "system", "priority_after_hours", department.id);
    this.#decide(call, { title: "Priority hazard, department closed", detail: `${department.displayName} is closed, so ${c.id} is ${extra.escalated ? "raised to priority" : "filed"} and flagged for the next business day instead of a transfer.`, verdict: "closed → next business day", tone: "warn" });
    this.#say(call, next);
    this.#afterFiling(call);
    return { ok: true, caseNumber: c.id, spokenCaseNumber: spoken, priority: true, afterHours: true, phrase: `${phrase} ${next}`, ...extra };
  }

  setContact(callId, { wantsUpdates, useCallerId = false, name = null, callbackNumber = null } = {}) {
    const call = this.#require(callId);
    if (!call.lastCase) return { ok: false, reason: "no_case" };
    const contact = wantsUpdates
      ? { wantsUpdates: true, useCallerId: Boolean(useCallerId), name: name ? "provided" : null, callbackNumber: useCallerId ? "caller-id-consented" : callbackNumber ? "provided" : null }
      : { wantsUpdates: false };
    this.cases.updateContact(call.lastCase.id, contact);
    call.lastCase.contact = contact;
    call.updates = wantsUpdates ? "text" : null;
    call.updatesDeclined = !wantsUpdates;
    if (call.pending === "updates") call.pending = null;
    this.#event(call, "agent", "contact_set", wantsUpdates ? "updates" : "anonymous");
    return { ok: true, caseNumber: call.lastCase.id, storedOutsideModel: true, contact: { wantsUpdates: contact.wantsUpdates } };
  }

  /** The caller said yes to updates: record consent and text the case number. */
  acceptUpdates(callId) {
    const call = this.#require(callId);
    const c = call.lastCase;
    if (!c) return { ok: false, reason: "no_case" };
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    this.setContact(callId, { wantsUpdates: true, useCallerId: true });
    const lang = this.#lang(call);
    const where = placePhrase(c.location, lang);
    const link = caseLink(c.id, call.language);
    let text;
    if (c.type === "bulk-pickup") {
      const items = joinList((c.fields?.items ?? []).map((i) => this.#itemLabel(i, lang)), lang);
      const date = textDate(c.fields?.pickupDate, lang);
      text = lang === "es"
        ? `311 de la Ciudad de Contoso: la recogida de ${items} ${where} está programada para ${date}. Caso ${c.id}. Responda STOP para cancelar.`
        : `City of Contoso 311: bulk pickup of ${items} ${where} is scheduled for ${date}. Case ${c.id}. Reply STOP to opt out.`;
    } else {
      const label = this.requests.label(c.type, call.language);
      text = lang === "es"
        ? `311 de la Ciudad de Contoso: su reporte de ${label} ${where} es el caso ${c.id}. Consulte el estado en ${link}. Responda STOP para cancelar.`
        : `City of Contoso 311: your ${label} report ${where} is case ${c.id}. Track it at ${link}. Reply STOP to opt out.`;
    }
    const sms = this.#text(call, { kind: "case", text, link, caseNumber: c.id });
    if (sms) this.#decide(call, { title: sms.simulated ? "Confirmation text (simulated, not sent)" : "Confirmation text sent", detail: `To ${call.maskedPhone} with consent. The number stays on the server and never reaches the model.`, verdict: sms.simulated ? "with consent · simulated" : "with consent", tone: "good" });
    const phrase = sms
      ? this.#t(call, "Done. I've texted your case number to the number you're calling from. Is there anything else I can help you with?", "Listo. Le envié el número de caso por mensaje de texto al número desde el que llama. ¿Hay algo más en lo que pueda ayudarle?")
      : this.#t(call, "I can't send a text on this call, so please keep your case number handy. Is there anything else I can help you with?", "No puedo enviar mensajes de texto en esta llamada, así que guarde su número de caso. ¿Hay algo más en lo que pueda ayudarle?");
    call.pending = "anything-else";
    this.#setState(call, STATES.LISTENING);
    this.#say(call, phrase);
    return { ok: Boolean(sms), sms, phrase };
  }

  goodbye(callId) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    call.pending = null;
    this.#setState(call, STATES.CLOSING);
    const phrase = this.#t(call, "Thank you for calling City of Contoso 311. Goodbye.", "Gracias por llamar al 311 de la Ciudad de Contoso. Adiós.");
    this.#say(call, phrase);
    this.#finish(call, STATES.ENDED, "completed");
    return { ok: true, ended: true, phrase };
  }

  sendFormLink(callId, serviceId = "permits") {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    call.pending = null;
    if (!this.#textChannel(call)) {
      const phrase = this.#t(call, "I can't send a text on this call. You'll find the form on the city website.", "No puedo enviar mensajes de texto en esta llamada. Encontrará el formulario en el sitio web de la ciudad.");
      this.#say(call, phrase);
      return { ok: false, reason: "no_text_channel", phrase };
    }
    this.#event(call, "agent", "sms_link_sent", serviceId);
    const link = linkFor(serviceId, call.language);
    const text = this.#t(call, `City of Contoso 311: here's the online ${serviceId === "permits" ? "permit " : ""}form you asked for: ${link}`, `311 de la Ciudad de Contoso: aquí está el formulario en línea que pidió: ${link}`);
    const sms = this.#text(call, { kind: "link", text, link });
    const phrase = this.#t(call, "I've sent the link by text.", "Le envié el enlace por mensaje de texto.");
    this.#say(call, phrase);
    return { ok: true, simulated: sms?.simulated ?? true, serviceId, to: call.maskedPhone, link, sms, phrase };
  }

  offerFormLink(callId, serviceId = "permits") {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    if (!this.#textChannel(call)) return this.anythingElse(callId);
    call.pending = `form-link:${serviceId}`;
    const phrase = this.#t(call, "Would you like me to text you the link to the online form?", "¿Quiere que le envíe por mensaje de texto el enlace al formulario en línea?");
    this.#say(call, phrase);
    return { ok: true, phrase };
  }

  /** Status and owning department only. Reporter details never leave the case store. */
  getCaseStatus(callId, caseNumber, { guarded = false } = {}) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    const id = normalizeCaseNumber(caseNumber);
    const c = this.cases.getStatus(id);
    const lang = this.#lang(call);
    call.pending = null;
    this.#setState(call, STATES.STATUS);
    this.#event(call, "agent", "case_status", c ? id : `not found ${id}`);
    if (!c) {
      const phrase = this.#t(call, "I couldn't find a case with that number. Could you read it to me again? It starts with S R.", "No encontré un caso con ese número. ¿Me lo puede leer otra vez? Empieza con S R.");
      this.#setState(call, STATES.LISTENING);
      this.#say(call, phrase);
      return { ok: false, reason: "not_found", phrase };
    }
    const status = STATUS_WORDS[c.status]?.[lang] ?? String(c.status).replaceAll("_", " ");
    const dept = this.departments.spokenName(c.department, call.language);
    let phrase = lang === "es" ? `Ese caso está ${status} con ${dept}.` : `That case is ${status} with ${dept}.`;
    if (guarded) {
      phrase += this.#t(call, " I can only share a case's status and the department handling it.", " Solo puedo compartir el estado de un caso y el departamento que lo atiende.");
      this.#decide(call, { title: "Status only, reporter details withheld", detail: "The caller asked about who reported the case. Contact details stay in the case store; the model never sees them.", verdict: "status only", tone: "warn" });
    }
    this.#setState(call, STATES.LISTENING);
    this.#say(call, phrase);
    this.anythingElse(callId);
    return { ok: true, status: c.status, department: this.departments.get(c.department)?.displayName ?? c.department, caseNumber: c.id, phrase };
  }

  bulkPickup(callId, items = [], { ask = true } = {}) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    if (call.requestsHandled >= this.options.maxRequestsPerCall) return this.transfer(callId, { reason: "request_limit", departmentId: "311-live" });
    const cfg = this.bulkPickupConfig;
    const lang = this.#lang(call);
    const canonical = [...new Set(items.map((i) => this.itemAliases.get(norm(i)) ?? norm(i)).filter(Boolean))];
    const ineligible = canonical.filter((i) => cfg.ineligibleItems.includes(i) || !cfg.eligibleItems.includes(i));
    call.pending = null;
    this.#setState(call, STATES.GUIDED);
    this.#event(call, "agent", "guided_started", "bulk-pickup");
    if (ineligible.length) {
      const names = joinList(ineligible.map((i) => this.#itemLabel(i, lang)), lang);
      const phrase = this.#t(call, `Sorry, bulk pickup can't take ${names}. Is there anything else I can help you with?`, `Lo siento, la recogida de artículos grandes no acepta ${names}. ¿Hay algo más en lo que pueda ayudarle?`);
      this.#decide(call, { title: "Bulk pickup: item not accepted", detail: `${ineligible.join(", ")} is not on the city's accepted list, so nothing is scheduled.`, verdict: "not accepted → nothing scheduled", tone: "warn" });
      call.bulk = null;
      call.pending = "anything-else";
      this.#setState(call, STATES.LISTENING);
      this.#say(call, phrase);
      return { ok: false, reason: "ineligible_item", ineligible, phrase };
    }
    if (!canonical.length) {
      call.bulk = { items: [] };
      const phrase = this.#t(call, "What would you like picked up? I can schedule up to three items, like a mattress, a sofa, or a chair.", "¿Qué quiere que recojamos? Puedo programar hasta tres artículos, como un colchón, un sofá o una silla.");
      this.#say(call, phrase);
      return { ok: false, reason: "no_items", phrase };
    }
    if (canonical.length > cfg.maxItemsPerCall) {
      const max = numberWord(cfg.maxItemsPerCall, lang);
      const phrase = this.#t(call, `I can schedule up to ${max} items per call. Which ${max} would you like picked up?`, `Puedo programar hasta ${max} artículos por llamada. ¿Cuáles ${max} quiere que recojamos?`);
      call.bulk = { items: [] };
      this.#say(call, phrase);
      return { ok: false, reason: "too_many_items", limit: cfg.maxItemsPerCall, phrase };
    }
    call.bulk = { items: canonical };
    this.#publish(call, "bulk", call.bulk);
    if (ask) {
      const names = joinList(canonical.map((i) => this.#itemLabel(i, lang)), lang);
      this.#say(call, this.#t(call, `I can schedule a bulk pickup for ${names}. What's the pickup address?`, `Puedo programar la recogida de ${names}. ¿Cuál es la dirección de recogida?`));
    }
    return { ok: true, eligible: canonical, needsLocation: true };
  }

  /** Books the next collection day for the address's zone, from the city calendar. */
  confirmBulkPickup(callId, locationUtterance = null) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    if (!call.bulk?.items?.length) return { ok: false, reason: "no_bulk_flow" };
    const resolved = locationUtterance ? this.geocoder.resolve(locationUtterance) : null;
    const location = resolved?.ok ? resolved : null;
    if (!location) {
      // The zone sets the date, so an address the city can't verify books nothing.
      const ambiguous = Boolean(resolved?.ambiguous);
      const phrase = ambiguous
        ? this.#t(call, "I found more than one place by that name. What's the house number and street for the pickup?", "Encontré más de un lugar con ese nombre. ¿Cuál es el número y la calle para la recogida?")
        : this.#t(call, "I couldn't verify that pickup address. What's the house number and street?", "No pude verificar esa dirección de recogida. ¿Cuál es el número y la calle?");
      this.#event(call, "agent", "location_unresolved", ambiguous ? "ambiguous" : "unverified");
      this.#decide(call, { title: "Pickup address not verified", detail: `${locationUtterance ? `“${String(locationUtterance).trim()}”` : "No address"} didn't match the city's address data, so no date is booked.`, verdict: "unverified → nothing scheduled", tone: "warn" });
      this.#say(call, phrase);
      return { ok: false, reason: ambiguous ? "location_ambiguous" : "location_unresolved", phrase };
    }
    const zone = location.zone ?? "A";
    const today = zonedParts(new Date(this.now()), this.departments.timeZone).date;
    const dates = this.bulkPickupConfig.calendar[zone] ?? [];
    const date = dates.find((d) => d > today) ?? dates[dates.length - 1];
    const items = [...call.bulk.items];
    const created = this.cases.create({ type: "bulk-pickup", department: "sanitation", location: location ?? { normalized: `Zone ${zone}`, zone }, lat: location?.lat ?? null, lon: location?.lon ?? null, zone, fields: { items, pickupDate: date }, priority: false, language: call.language, originalLanguage: call.language, callId: call.id, simulated: call.simulated });
    call.lastCase = created;
    call.bulk = null;
    call.requestsHandled += 1;
    const card = this.#upsertCard(call, created);
    this.#event(call, "agent", "guided_completed", "bulk-pickup");
    this.#publish(call, "case", card);
    this.#decide(call, { title: `Bulk pickup ${created.id} scheduled`, detail: `${joinList(items.map((i) => this.#itemLabel(i, "en")), "en")} · ${location?.normalized ?? `Zone ${zone}`} · zone ${zone} calendar → ${date}. Accepted items and dates come from the city's rules.`, verdict: "scheduled from the zone calendar", tone: "good" });
    this.#setState(call, STATES.FILED);
    const spoken = speakCaseNumber(created.id);
    const lang = this.#lang(call);
    const where = location ? ` ${placePhrase(location, lang)}` : "";
    const phrase = lang === "es"
      ? `La recogida está programada para ${spokenDate(date, "es")}${where}. Su número de caso es ${spoken}. Repito, ${spoken}.`
      : `Bulk pickup is scheduled for ${spokenDate(date, "en")}${where ? `,${where}` : ""}. Your case number is ${spoken}. Again, ${spoken}.`;
    this.#say(call, phrase);
    this.#afterFiling(call);
    return { ok: true, date, caseNumber: created.id, spokenCaseNumber: spoken, phrase };
  }

  /** A complaint is acknowledged, never argued with, and the caller is offered a person. */
  complaint(callId, said) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    const text = String(said ?? "").replace(/\s+/g, " ").trim();
    const about = /\b(trash|garbage|recycling|pickup|pick up|truck|trucks|basura|reciclaje|camion|camiones)\b/.test(norm(text)) ? "missed-trash" : null;
    call.complaint = { text, topic: complaintTopic(text), about, at: this.#iso() };
    call.sentiment = "frustrated";
    call.pending = "complaint";
    this.#event(call, "caller", "complaint", call.complaint.topic);
    this.#publish(call, "complaint", { ...call.complaint, sentiment: call.sentiment });
    this.#decide(call, { title: "Complaint heard, offering a person", detail: "Sentiment: frustrated. The agent apologizes, makes no promises, and offers a report or a 311 staff member.", verdict: "complaint → offer a person", tone: "warn" });
    const phrase = about
      ? this.#t(call, "I'm sorry about that. I can hear how frustrating it is. I can file a missed-pickup report now, or connect you with a 311 staff member who can look into it. Which would you prefer?", "Lamento mucho lo ocurrido; entiendo lo frustrante que es. Puedo registrar un reporte de recolección omitida ahora o comunicarle con alguien del personal de 311 que pueda revisarlo. ¿Qué prefiere?")
      : this.#t(call, "I'm sorry about that. I can hear how frustrating it is. I can connect you with a 311 staff member who can look into it, or take a report now. Which would you prefer?", "Lamento mucho lo ocurrido; entiendo lo frustrante que es. Puedo comunicarle con alguien del personal de 311 que pueda revisarlo, o tomar un reporte ahora. ¿Qué prefiere?");
    this.#setState(call, STATES.LISTENING);
    this.#say(call, phrase);
    return { ok: true, complaint: call.complaint, phrase };
  }

  /** Warm handoff to a Teams queue. The context the person sees is built here, on the server. */
  transfer(callId, { reason = "caller_requested", departmentId = "311-live" } = {}) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    if (call.state === STATES.TRANSFERRING) return { ok: false, reason: "already_transferring" };
    const department = this.departments.get(departmentId) ?? this.departments.get("311-live");
    const lang = this.#lang(call);
    call.pending = null;
    if (reason !== "relay" && !this.departments.isOpen(department.id, new Date(this.now()))) {
      const phrase = `${this.departments.closedPhrase(department.id, call.language)} ${this.#t(call, "I can still take a report or answer a question.", "Todavía puedo tomar un reporte o responder una pregunta.")}`;
      this.#event(call, "system", "transfer_after_hours", department.id);
      this.#decide(call, { title: `${department.displayName} is closed, so no transfer`, detail: `Hours come from the department directory: ${this.departments.hoursPhrase(department.id).replace(/\.$/, "")}. The caller can still report or ask.`, verdict: "after hours → no transfer", tone: "warn" });
      this.#setState(call, STATES.LISTENING);
      this.#say(call, phrase);
      return { ok: true, transferred: false, afterHours: true, department: department.id, phrase };
    }
    const latest = call.lastCase;
    const topic = reason === "complaint" && call.complaint
      ? call.complaint.topic
      : latest
        ? null
        : call.faq && !call.faq.answered
          ? clipTopic(`Question: ${call.faq.query}`)
          : REASONS[reason] ?? reason;
    const summary = this.#summary(call, reason);
    call.transferDepartmentId = department.id;
    const context = buildHandoffContext(call, { department, reason, topic, summary });
    call.handoff = this.#handoffCard(call, department, reason, context, summary);
    this.#setState(call, STATES.TRANSFERRING);
    this.#event(call, "system", "transfer_started", reason);
    this.#decide(call, { title: `Handing off to ${department.displayName}`, detail: `${REASONS[reason] ?? reason}. Topic, summary${latest ? `, case ${latest.id}` : ""}${call.sentiment !== "neutral" ? ", sentiment" : ""} and language travel with the call.`, verdict: "warm handoff with context", tone: reason === "priority" ? "warn" : "info" });
    const spoken = this.departments.spokenName(department.id, call.language);
    this.#say(call, lang === "es" ? `Le estoy comunicando con ${spoken} ahora.` : `I'm connecting you with ${spoken} now.`);
    if (call.simulated || !this.transferFn) {
      this.#event(call, "system", "transfer_simulated", department.id);
      this.#publish(call, "handoff", call.handoff);
      this.#finish(call, STATES.TRANSFERRED, `transferred:${department.id}`);
      return { ok: true, transferred: true, simulated: true, department: department.id, context, handoff: call.handoff };
    }
    this.#publish(call, "handoff", call.handoff);
    this.#track(call, this.#runTransfer(call, department, context));
    return { ok: true, transferring: true, department: department.id, context, handoff: call.handoff };
  }

  /**
   * ACS accepted the transfer request, then posted CallTransferFailed: nobody
   * picked up, and the caller is still on the line with the agent. Say so
   * honestly, repeat the case number if there is one, and end the call once.
   * Dialing the queue again instead would loop for as long as it kept failing.
   */
  transferFailed(callId, message = "transfer failed") {
    const call = this.get(callId);
    if (!call || call.simulated || call.state !== STATES.TRANSFERRED) return { ok: false, reason: "nothing_to_recover" };
    const department = this.departments.get(call.transferDepartmentId) ?? this.departments.get("311-live");
    const latest = call.lastCase;
    // Leave the terminal state so the call can be finished again, as ended.
    this.#setState(call, STATES.CLOSING);
    this.#event(call, "system", "transfer_failed", `${department.id}: ${message}`, { accepted: true });
    this.#decide(call, { title: `Nobody at ${department.displayName} picked up`, detail: `ACS accepted the transfer request, then reported it failed (${message}). The agent apologizes${latest ? `, repeats case ${latest.id}` : ""} and ends the call. It does not dial the queue again.`, verdict: "transfer not answered → close honestly", tone: "bad" });
    const spoken = latest ? speakCaseNumber(latest.id) : null;
    this.#say(call, spoken
      ? this.#t(call, `I'm sorry, nobody was available to take your call. Your request is still on file. Your case number is ${spoken}. Please call 311 again later if you'd like to speak with someone. Goodbye.`, `Lo siento, no había nadie disponible para atender su llamada. Su solicitud sigue registrada. Su número de caso es ${spoken}. Llame al 311 de nuevo más tarde si desea hablar con alguien. Adiós.`)
      : this.#t(call, "I'm sorry, nobody was available to take your call. Please call 311 again later if you'd like to speak with someone. Goodbye.", "Lo siento, no había nadie disponible para atender su llamada. Llame al 311 de nuevo más tarde si desea hablar con alguien. Adiós."));
    this.#finish(call, STATES.ENDED, "transfer_failed");
    return { ok: false, reason: "transfer_failed", error: message };
  }

  fail(callId, reason = "failed_attempt") {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    call.failedAttempts += 1;
    call.pending = null;
    this.#event(call, "agent", "failed_attempt", reason);
    if (call.failedAttempts >= 3) {
      // The handoff after the second miss didn't happen (311 staff closed, or the transfer failed).
      // Close politely rather than ask again or dial again.
      const closed = !this.departments.isOpen("311-live", new Date(this.now()));
      const hours = this.departments.hoursPhrase("311-live", call.language);
      this.#decide(call, { title: "Not understood again, so the agent says goodbye", detail: closed ? `311 staff are closed (${hours}), so there is no one to hand the call to. The agent closes politely instead of asking again.` : "The handoff didn't complete, so the agent closes politely instead of dialing again.", verdict: "third miss → polite close", tone: "warn" });
      this.#say(call, closed
        ? this.#t(call, `I'm sorry I couldn't help with that. Please call 311 again ${hours} to reach a person. Goodbye.`, `Lamento no haber podido ayudarle. Llame al 311 otra vez ${hours}, para hablar con una persona. Adiós.`)
        : this.#t(call, "I'm sorry I couldn't help with that. Please call 311 again later. Goodbye.", "Lamento no haber podido ayudarle. Llame al 311 de nuevo más tarde. Adiós."));
      return this.endCall(callId, "not_understood");
    }
    if (call.failedAttempts >= 2) return this.transfer(callId, { reason: "failed_twice", departmentId: "311-live" });
    // Mid-report, ask the open question again rather than start over.
    const cur = call.current;
    const field = cur?.missing[0];
    let phrase;
    let state = field ? STATES.INTAKE : STATES.LISTENING;
    if (field === "location" && cur.location) {
      call.pending = "confirm-location";
      state = STATES.CONFIRMING;
      phrase = `${this.#t(call, "Sorry, I didn't get that.", "Disculpe, no le entendí.")} ${this.#readBack(call, cur.location)}`;
    } else if (field === "location" && cur.locationHint) {
      phrase = this.#t(call, `Sorry, I didn't get that. What's the nearest cross street on ${cur.locationHint}?`, `Disculpe, no le entendí. ¿Cuál es la calle transversal más cercana en ${cur.locationHint}?`);
    } else if (field === "location") {
      phrase = this.#t(call, "I couldn't verify that location. What's the street address or the nearest cross street?", "No pude verificar esa ubicación. ¿Cuál es la dirección o la calle transversal más cercana?");
    } else if (field) {
      const [en, es] = FIELD_PROMPTS[field] ?? [`What's the ${field}?`, `¿Cuál es el dato de ${field}?`];
      phrase = this.#t(call, `Sorry, I didn't get that. ${en}`, `Disculpe, no le entendí. ${es}`);
    } else {
      phrase = this.#t(call, "Sorry, I didn't get that. You can report a problem, check on a case, or ask a city question. What do you need?", "Disculpe, no le entendí. Puede reportar un problema, consultar un caso o hacer una pregunta sobre la ciudad. ¿Qué necesita?");
    }
    this.#setState(call, state);
    this.#say(call, phrase);
    return { ok: false, reason, remaining: 2 - call.failedAttempts, phrase };
  }

  dtmf(callId, digit) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    const d = String(digit ?? "").trim();
    this.pushTranscript(callId, "caller", `(pressed ${d})`);
    call.noInputs = 0;
    this.#event(call, "caller", "dtmf", d);
    if (d === "0") return this.transfer(callId, { reason: "dtmf_0", departmentId: "311-live" });
    if (d === "*") return this.repeatLast(callId);
    if (d === "1") return { ok: true, digit: d, meaning: "yes" };
    if (d === "2") return { ok: true, digit: d, meaning: "no" };
    this.#event(call, "caller", "dtmf_ignored", d);
    return { ok: false, reason: "unmapped_digit" };
  }

  repeatLast(callId) {
    const call = this.#require(callId);
    if (call.lastSpoken && !TERMINAL.has(call.state)) {
      this.#event(call, "caller", "repeat", null);
      this.#say(call, call.lastSpoken);
    }
    return { ok: true, repeated: call.lastSpoken };
  }

  noInput(callId) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    call.noInputs += 1;
    this.#event(call, "caller", "no_input", String(call.noInputs));
    if (call.noInputs >= 2) {
      this.#say(call, this.#t(call, "I haven't heard anything, so I'll end the call now. Please call 311 again anytime. Goodbye.", "No he escuchado nada, así que terminaré la llamada. Llame al 311 cuando quiera. Adiós."));
      return this.endCall(callId, "two_no_inputs");
    }
    this.#say(call, this.#t(call, "Are you still there? You can press 0 for a person.", "¿Sigue ahí? Puede marcar 0 para hablar con una persona."));
    return { ok: true, noInputs: call.noInputs };
  }

  checkBudget(callId) {
    const call = this.get(callId);
    if (!call || TERMINAL.has(call.state)) return { ok: true };
    const elapsed = this.now() - (call.answeredAt ?? call.startedAt);
    if (elapsed >= this.options.callTimeBudgetMs) return this.#expire(call);
    if (!call.wrapPrompted && elapsed >= this.options.callTimeBudgetMs - 30000) {
      call.wrapPrompted = true;
      this.#event(call, "system", "budget_wrap_up", String(elapsed));
      this.#say(call, this.#t(call, "We're almost out of time. Let's finish this up.", "Nos queda poco tiempo. Terminemos con esto."));
      return { ok: true, wrapUp: true };
    }
    return { ok: true };
  }

  endCall(callId, outcome = "ended") {
    const call = this.get(callId);
    if (!call || TERMINAL.has(call.state)) return { ok: true, ended: false };
    this.#finish(call, STATES.ENDED, outcome);
    return { ok: true, ended: true, outcome };
  }

  /** Resolves once everything this call started (real texts, live transfers) has finished. */
  async settled(callId) {
    for (let round = 0; round < 10; round += 1) {
      const call = this.get(callId);
      if (!call?.work.size) break;
      await Promise.allSettled([...call.work]);
    }
    await new Promise((resolve) => setImmediate(resolve));
    return this.snapshot(callId);
  }

  pushTranscript(callId, role, text) {
    const call = this.get(callId);
    if (!call || !text) return;
    const entry = { role, text, at: this.#iso() };
    call.transcript.push(entry);
    this.audit.recordTranscript?.(callId, role, text);
    this.#publish(call, "transcript", entry);
  }

  currentIntakeSnapshot(call) {
    const cur = call.current;
    if (!cur) return null;
    return { typeId: cur.typeId, label: this.requests.label(cur.typeId), missing: cur.missing, fields: cur.fields, location: cur.location, confirmedLocation: cur.confirmedLocation, locationHint: cur.locationHint };
  }

  snapshot(callId) {
    const call = this.get(callId);
    if (!call) return null;
    return {
      id: call.id,
      callId: call.id,
      state: call.state,
      simulated: call.simulated,
      arrival: call.arrival,
      language: call.language,
      agentLocale: call.agentLocale,
      voice: call.voice,
      maskedPhone: call.maskedPhone,
      requestsHandled: call.requestsHandled,
      maxRequests: this.options.maxRequestsPerCall,
      current: this.currentIntakeSnapshot(call),
      bulk: call.bulk,
      lastCase: call.lastCase ? this.#card(call.lastCase) : null,
      cases: call.cases,
      lastSpoken: call.lastSpoken,
      pending: call.pending,
      transcript: call.transcript,
      texts: call.texts,
      emergency: call.emergency,
      complaint: call.complaint,
      sentiment: call.sentiment,
      faq: call.faq,
      handoff: call.handoff,
      decision: call.decision,
      decisions: call.decisions,
      elapsedMs: (call.endedAt ?? this.now()) - (call.answeredAt ?? call.startedAt),
      budgetMs: this.options.callTimeBudgetMs,
      outcome: call.outcome,
    };
  }

  sanitizedModelContext(callId) { const call = this.#require(callId); return call.modelContext.map((x) => ({ ...x })); }

  #require(callId) {
    const call = this.get(callId);
    if (!call) throw new Error(`unknown call ${callId}`);
    return call;
  }

  #recomputeMissing(call) {
    const type = this.requests.get(call.current.typeId);
    call.current.missing = type.required.filter((f) => (f === "location" ? !call.current.confirmedLocation : call.current.fields[f] == null || call.current.fields[f] === ""));
  }

  /** "I have the pothole at Oak Avenue and 5th Street. Is that right?" */
  #readBack(call, location) {
    return this.#lang(call) === "es"
      ? `Tengo la ubicación ${placePhrase(location, "es")}. ¿Es correcto?`
      : `I have the ${this.requests.label(call.current.typeId, call.language)} ${placePhrase(location, "en")}. Is that right?`;
  }

  #budgetExpired(call) { return call.answeredAt != null && !TERMINAL.has(call.state) && this.now() - call.answeredAt >= this.options.callTimeBudgetMs; }

  #expire(call) {
    this.#say(call, this.#t(call, "We've reached the call time limit, so I'll close this call now. Please call 311 again if you need more help.", "Llegamos al límite de tiempo de la llamada, así que voy a terminarla. Llame al 311 otra vez si necesita más ayuda."));
    this.#finish(call, STATES.ENDED, "time_budget_expired");
    return { ok: true, expired: true };
  }

  /** What follows a filed case: the request cap, an offer of text updates, or "anything else?". */
  #afterFiling(call) {
    if (TERMINAL.has(call.state)) return;
    if (call.requestsHandled >= this.options.maxRequestsPerCall) {
      const max = numberWord(this.options.maxRequestsPerCall, this.#lang(call));
      call.pending = "anything-else";
      this.#say(call, this.#t(call, `I can handle up to ${max} requests on this call. I'll connect you with 311 staff for anything else.`, `Puedo atender hasta ${max} solicitudes por llamada. Le comunicaré con el personal de 311 para cualquier otra cosa.`));
      return;
    }
    if (call.lastCase && !call.updates && !call.updatesDeclined && this.#textChannel(call)) {
      call.pending = "updates";
      this.#say(call, this.#t(call, "Would you like text updates on this case, or is there anything else?", "¿Quiere recibir actualizaciones por mensaje de texto sobre este caso, o hay algo más?"));
      return;
    }
    call.pending = "anything-else";
    this.#say(call, this.#t(call, "Is there anything else I can help you with?", "¿Hay algo más en lo que pueda ayudarle?"));
  }

  #textChannel(call) {
    if (!call.fromPhone) return null;
    if (call.simulated) return "simulated";
    if (this.sms) return "real";
    return this.offlineTexts ? "simulated" : null;
  }

  /** Simulated texts go to the console's phone panel only; real ones go through ACS SMS. */
  #text(call, { kind, text, link = null, caseNumber = null }) {
    const channel = this.#textChannel(call);
    if (!channel) return null;
    const simulated = channel === "simulated";
    const entry = { id: `sms-${++this.textSeq}`, callId: call.id, kind, to: call.maskedPhone, from: SMS_FROM, text, link, caseNumber, locale: call.language, at: this.#iso(), status: simulated ? "simulated" : "sending", simulated };
    call.texts.push(entry);
    this.outbox.push(entry);
    if (this.outbox.length > 200) this.outbox.splice(0, this.outbox.length - 200);
    this.#publish(call, "sms", entry);
    if (simulated) {
      this.#event(call, "system", "sms_simulated", caseNumber ? `${kind} ${caseNumber}` : kind);
      return entry;
    }
    this.#track(call, (async () => {
      try {
        const sent = await this.sms.sendText({ to: call.fromPhone, text });
        entry.status = sent?.ok === false ? "failed" : "sent";
        this.#event(call, "system", entry.status === "sent" ? "sms_sent" : "sms_failed", kind);
      } catch (err) {
        entry.status = "failed";
        this.#event(call, "system", "sms_failed", errorText(err));
      }
      this.#publish(call, "sms", entry);
    })());
    return entry;
  }

  async #runTransfer(call, department, context) {
    if (this.options.transferDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.options.transferDelayMs));
    if (call.cancelled || TERMINAL.has(call.state)) return;
    try {
      await this.transferFn(call, { target: department.teamsQueue, context, department });
      this.#event(call, "system", "transfer_succeeded", department.id);
      this.#finish(call, STATES.TRANSFERRED, `transferred:${department.id}`);
      return;
    } catch (err) {
      this.#event(call, "system", "transfer_failed", `${department.id}: ${errorText(err)}`);
    }
    const fallback = this.departments.get("311-live");
    if (fallback && fallback.id !== department.id && !call.cancelled && this.departments.isOpen(fallback.id, new Date(this.now()))) {
      const fallbackContext = buildHandoffContext(call, { department: fallback, reason: "transfer_fallback", topic: call.handoff?.callTopic ?? null, summary: call.handoff?.summary ?? null });
      call.transferDepartmentId = fallback.id;
      call.handoff = this.#handoffCard(call, fallback, "transfer_fallback", fallbackContext, call.handoff?.summary ?? null);
      this.#publish(call, "handoff", call.handoff);
      try {
        await this.transferFn(call, { target: fallback.teamsQueue, context: fallbackContext, department: fallback });
        this.#event(call, "system", "transfer_succeeded", fallback.id);
        this.#finish(call, STATES.TRANSFERRED, `transferred:${fallback.id}`);
        return;
      } catch (err) {
        this.#event(call, "system", "transfer_failed", `${fallback.id}: ${errorText(err)}`);
      }
    }
    if (call.cancelled || TERMINAL.has(call.state)) return;
    this.#setState(call, STATES.LISTENING);
    this.#say(call, this.#t(call, "I'm sorry, I couldn't complete the transfer. I can still take a report or answer a question.", "Lo siento, no pude completar la transferencia. Todavía puedo tomar un reporte o responder una pregunta."));
  }

  #handoffCard(call, department, reason, context, summary) {
    return {
      ...context,
      department: department.id,
      departmentName: department.displayName,
      queue: department.teamsQueue?.displayName ?? department.displayName,
      reason,
      reasonLabel: REASONS[reason] ?? reason,
      summary,
      sentiment: call.sentiment,
      tags: [REASONS[reason] ?? reason, call.lastCase?.priority ? "Priority" : null, call.language.startsWith("es") ? "Español" : null, call.sentiment !== "neutral" ? capitalize(call.sentiment) : null].filter(Boolean),
      language: call.language,
      caseNumber: call.lastCase?.id ?? null,
      maskedPhone: call.maskedPhone,
      simulated: call.simulated || !this.transferFn,
      at: this.#iso(),
      voipHeaders: buildCustomCallingContext(context),
    };
  }

  #summary(call, reason) {
    const parts = [REASONS[reason] ?? reason];
    const c = call.lastCase;
    if (c) parts.push(`${c.priority ? "Priority " : ""}${this.requests.label(c.type)} ${c.id} at ${c.location?.normalized ?? "an unverified location"}`);
    else if (call.current) parts.push(`${capitalize(this.requests.label(call.current.typeId))} intake in progress${call.current.location ? ` at ${call.current.location.normalized}` : ""}`);
    if (call.complaint?.about === "missed-trash") parts.push("About missed trash pickup");
    if (call.faq && !call.faq.answered) parts.push(`Asked “${String(call.faq.query).slice(0, 80)}”, which has no approved answer`);
    if (call.sentiment !== "neutral") parts.push(`Caller sounds ${call.sentiment}`);
    if (call.language.startsWith("es")) parts.push("Speaks Spanish");
    return `${parts.join(". ")}.`;
  }

  #upsertCard(call, c) {
    const card = this.#card(c);
    const index = call.cases.findIndex((x) => x.id === card.id);
    if (index >= 0) call.cases[index] = card;
    else call.cases.push(card);
    return card;
  }

  /** What the console's case card shows. No contact details. */
  #card(c) {
    const type = this.requests.get(c.type);
    let slaText = null;
    let due = null;
    if (c.type === "bulk-pickup") {
      slaText = "Scheduled pickup";
      due = c.fields?.pickupDate ?? null;
    } else if (c.priority && type?.sla?.priorityHours) {
      // A case raised to priority by a later report: its clock starts when it was raised.
      slaText = `${type.sla.priorityHours} hours (priority)`;
      due = new Date(Date.parse(c.escalatedAt ?? c.createdAt) + type.sla.priorityHours * 3600000).toISOString();
    } else if (type?.sla?.businessDays) {
      slaText = `${type.sla.businessDays} business days`;
      due = this.departments.addBusinessDays(new Date(Date.parse(c.createdAt)), type.sla.businessDays);
    }
    return {
      id: c.id,
      type: c.type,
      label: this.requests.label(c.type),
      department: c.department,
      departmentName: this.departments.get(c.department)?.displayName ?? c.department,
      location: c.location?.normalized ?? null,
      zone: c.zone ?? c.location?.zone ?? null,
      priority: Boolean(c.priority),
      escalatedAt: c.escalatedAt ?? null,
      status: c.status,
      meToo: c.meToo ?? 1,
      slaText,
      due,
      fields: { ...(c.fields ?? {}) },
      language: c.language ?? null,
      createdAt: c.createdAt,
      simulated: Boolean(c.simulated),
    };
  }

  #say(call, text) {
    if (!text) return;
    call.lastSpoken = text;
    this.pushTranscript(call.id, "agent", text);
    call.toSpeak.push(text);
    // Lines said in the same turn reach the voice model as one instruction.
    if (call.toSpeak.length === 1) queueMicrotask(() => this.#flushSpeech(call));
  }

  #flushSpeech(call) {
    const lines = call.toSpeak.splice(0);
    if (!lines.length || call.cancelled) return;
    const agent = this.agents.get(call.id);
    if (agent?.instruct) agent.instruct(SAY_EXACTLY, lines.join(" "));
    else call.unspoken = [...call.unspoken, ...lines].slice(-5);
  }

  #track(call, promise) {
    const tracked = Promise.resolve(promise).catch((err) => this.#event(call, "system", "error", errorText(err)));
    call.work.add(tracked);
    tracked.finally(() => call.work.delete(tracked));
    return tracked;
  }

  /** What the server decided, for the console: a headline, the reason, a short verdict and a tone. */
  #decide(call, { title, detail = "", verdict = "", tone = "info" }) {
    const decision = { title, detail, verdict, tone, at: this.#iso() };
    call.decision = decision;
    call.decisions = [...call.decisions, decision].slice(-20);
    this.#publish(call, "decision", decision);
  }

  #finish(call, state, outcome, extra = {}) {
    if (TERMINAL.has(call.state)) return;
    call.outcome = outcome;
    call.endedAt = this.now();
    call.pending = null;
    this.audit.updateCall(call.id, { outcome, endedAt: call.endedAt, durationMs: call.endedAt - call.startedAt, ...extra });
    this.#event(call, "system", "call_ended", outcome);
    this.#setState(call, state);
    // A live bridge uses this to hang up once the closing line has played.
    this.agents.get(call.id)?.finished?.(state, outcome, call.lastSpoken);
  }

  #setState(call, state) {
    if (call.state === state) return;
    const from = call.state;
    call.state = state;
    this.audit.updateCall(call.id, { state });
    this.#event(call, "system", "state", `${from} → ${state}`);
    this.#publish(call, "state", this.snapshot(call.id));
  }

  #event(call, source, kind, detail, meta = null) {
    this.audit.recordEvent(call.id, source, kind, detail, meta);
    this.#publish(call, "event", { source, kind, detail: detail == null ? null : String(detail), ...(meta ? { meta } : {}), at: this.#iso() });
  }

  #publish(call, target, payload) { this.hub?.send?.(call.id, target, payload); }
  #iso() { return new Date(this.now()).toISOString(); }
  #lang(call) { return call.language.startsWith("es") ? "es" : "en"; }
  #t(call, en, es) { return this.#lang(call) === "es" ? es : en; }
  #itemLabel(item, lang) { return this.bulkPickupConfig.labels?.[item]?.[lang] ?? this.bulkPickupConfig.labels?.[item]?.en ?? item; }

  #voiceFor(language) {
    const voices = this.options?.voices ?? config.voiceLive.voices ?? [];
    const lower = String(language).toLowerCase();
    return voices.find((v) => v.toLowerCase().startsWith(lower)) ?? voices.find((v) => v.slice(0, 2).toLowerCase() === lower.slice(0, 2)) ?? voices[0] ?? null;
  }
}

export function speakCaseNumber(value) {
  const m = /^([A-Z]{2})-(\d{2})-(\d{4})$/i.exec(String(value));
  if (!m) return String(value).split("").join(" ");
  return `${m[1].toUpperCase().split("").join(" ")}, ${m[2].split("").join(" ")}, ${m[3].split("").join(" ")}`;
}

export function validateField(field, value) {
  if (!field) return { ok: true, value };
  if (field.type === "enum") {
    const lower = String(value).toLowerCase().trim();
    const match = field.values.find((v) => v === lower);
    return match ? { ok: true, value: match } : { ok: false, reason: "invalid_enum", values: field.values };
  }
  if (field.type === "boolean") return { ok: true, value: typeof value === "boolean" ? value : /^(yes|true|1|si|sí|y)$/i.test(String(value)) };
  return { ok: true, value: String(value).trim() };
}

export function isPriority(type, fields) {
  const rules = Object.entries(type.priorityWhen ?? {});
  return rules.length > 0 && rules.every(([k, v]) => fields[k] === v);
}

export function normalizeCaseNumber(s) {
  return String(s).toUpperCase().replace(/\bS\s*R\b/, "SR").replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function maskPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  return digits.length < 4 ? "****" : `***-${digits.slice(-4)}`;
}

const SPANISH = /\b(hola|espanol|necesito|quiero|tengo|bache|basura|grafiti|ruido|permiso|recojan|recoger|recogida|colchon|por favor|gracias|buenos dias|buenas tardes|hay un|hay una|esta|donde|cuando|calle)\b/;
export function looksSpanish(s) { return SPANISH.test(norm(s)); }

export function caseLink(caseNumber, locale = "en-US") {
  return `https://contoso.example/311/${caseNumber}${String(locale).startsWith("es") ? "?lang=es" : ""}`;
}

function buildItemAliases(cfg = {}) {
  const map = new Map();
  for (const item of [...(cfg.eligibleItems ?? []), ...(cfg.ineligibleItems ?? [])]) map.set(norm(item), item);
  for (const [alias, item] of Object.entries(cfg.aliases ?? {})) map.set(norm(alias), item);
  return map;
}

function complaintTopic(text) {
  const sentences = String(text).split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const preamble = /^(i('d| would)? (want|like) to (make|file|lodge|register) a complaint|i have a complaint|this is a complaint|quiero (poner|hacer|presentar) una queja|tengo una queja)\b/i;
  const body = sentences.filter((s) => !preamble.test(s));
  let s = (body.length ? body : sentences).join(" ").replace(/^(the|my|our)\s+/i, "");
  s = s.charAt(0).toLowerCase() + s.slice(1);
  return clipTopic(`Complaint: ${s}`);
}

function placeName(loc, lang) {
  if (!loc?.normalized) return lang === "es" ? "la ubicación indicada" : "the location you gave";
  if (loc.kind === "landmark") return lang === "es" ? LANDMARKS_ES[loc.normalized] ?? loc.normalized : loc.normalized;
  if (loc.kind === "intersection") return loc.normalized.replace(" at ", lang === "es" ? " y " : " and ");
  return loc.normalized;
}

function placePhrase(loc, lang) {
  if (loc?.kind === "landmark") return placeName(loc, lang);
  return `${lang === "es" ? "en" : "at"} ${placeName(loc, lang)}`;
}

function dateParts(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return { day: d.getUTCDay(), month: d.getUTCMonth(), date: d.getUTCDate() };
}

/** English keeps the ISO date (unambiguous for the voice); Spanish says it the Spanish way. */
function spokenDate(iso, lang) {
  if (!iso) return lang === "es" ? "la próxima fecha disponible" : "the next available date";
  const p = dateParts(iso);
  return lang === "es" ? `el ${DIAS[p.day]} ${p.date} de ${MESES[p.month]}` : `${DAYS[p.day]}, ${iso}`;
}

function textDate(iso, lang) {
  if (!iso) return lang === "es" ? "la próxima fecha disponible" : "the next available date";
  const p = dateParts(iso);
  return lang === "es" ? `el ${DIAS[p.day]} ${p.date} de ${MESES[p.month]}` : `${DAYS[p.day]}, ${MONTHS[p.month]} ${p.date}`;
}

function joinList(items, lang) {
  const and = lang === "es" ? "y" : "and";
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} ${and} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}${lang === "es" ? "" : ","} ${and} ${items[items.length - 1]}`;
}

function numberWord(n, lang) { return NUMBER_WORDS[lang]?.[n] ?? String(n); }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function errorText(err) { return String(err?.message ?? err).slice(0, 160); }
