import { norm } from "./fixtures.mjs";
import { STATES } from "./flow.mjs";

/**
 * The offline stand-in for the voice model. It reads a typed caller turn and
 * calls the same flow tools the live model would; every policy decision is
 * still made by the flow.
 */
export function registerSimulatedAgent(flow, callId) {
  flow.registerAgent(callId, { simulated: true, instruct() {}, nudge() {}, setLocale() {} });
}

const YES = /\b(yes|yeah|yep|yup|sure|correct|right|ok|okay|please|of course|go ahead|si|claro|correcto|exacto|por favor|de acuerdo|vale)\b/;
const NO = /\b(no|nope|nah|not now|not really|no thanks|nothing|wrong|incorrect|thats all|that s all|that s it|thats it|nada|incorrecto|eso es todo)\b/;
const FILLER = new Set("yes yeah yep yup sure correct right ok okay please of course go ahead si claro correcto exacto por favor de acuerdo vale no nope nah not now really thanks thank you nothing that thats s all it is nada eso es todo gracias muchas well um uh oh just bye goodbye adios i m im fine good".split(" "));
const GOODBYE = /\b(that s all|thats all|that s it|thats it|bye|goodbye|eso es todo|adios)\b/;
const PERSON = /\b(person|human|operator|representative|live agent|agent|real person|alguien|persona|operador|agente)\b/;
const RELAY = /\b(relay|tty|t t y|teletypewriter)\b/;
const COMPLAINT = /\b(complaint|complain|complaining|frustrated|unacceptable|fed up|ridiculous|nobody (has )?called|no one (has )?called|queja|quejarme|harto|harta)\b/;
const CASE_NUMBER = /\bS\s*R[-\s]?(\d{2})[-\s]?(\d{4})\b/i;
const STATUS = /\b(status|estado|case|caso|update|check|checking)\b/;
const PRIVATE = /\b(reporter|who reported|name|phone|contact|email|address|nombre|telefono|quien)\b/;
const BULK = /\b(bulk|large items?|big items?|recogida|recojan|recoger|muebles|articulos grandes)\b/;
const PICK_UP = /\b(pick up|pickup|picked up|haul|haul away|take away|collect|llevar|llevarse|retirar)\b/;
const PERMIT = /\b(permit|permits|license|licence|licenses|permiso|permisos|licencia)\b/;
const FAQ = /\b(trash|garbage|recycling|pickup|pick up|collected|collection|hours|open|closed|fees?|cost|costs|schedule|holiday|holidays|basura|reciclaje|recoleccion|tarifas?|horarios?|horas|cuesta|abierto|cerrado)\b/;
const QUESTION_START = /^(what|when|where|how|is|are|can|do|does|que|cuando|donde|como|cual|cuales)\b/;
const VEHICLE = /\b(red|blue|green|white|black|silver|gray|grey|yellow|brown|tan|van|car|truck|sedan|suv|pickup|coupe|camper|coche|carro|camioneta|rojo|azul|blanco|negro|gris)\b/;
const UNSURE = /\b(no idea|not sure|don t know|dont know|no se|no lo se|ni idea|no estoy segur[oa])\b/;

export function handleUtterance(flow, callId, text) {
  const call = flow.get(callId);
  if (!call) return { ok: false, reason: "unknown_call" };
  const budget = flow.checkBudget(callId);
  if (budget.expired) return budget;
  const said = String(text ?? "").trim();
  if (!said) return flow.noInput(callId);

  if (/^[0-9*#]$/.test(said)) {
    const pressed = flow.dtmf(callId, said);
    if (pressed.meaning && flow.get(callId)?.pending) return answerPending(flow, callId, pressed.meaning) ?? pressed;
    return pressed;
  }

  const observed = flow.observeCaller(callId, said);
  if (observed.category || !observed.ok || finished(call)) return observed;
  const t = norm(said);

  const answered = answerPending(flow, callId, said);
  if (answered) return answered;

  if (RELAY.test(t)) return flow.transfer(callId, { reason: "relay", departmentId: "relay" });
  if (PERSON.test(t)) return flow.transfer(callId, { reason: call.complaint ? "complaint" : "caller_requested", departmentId: "311-live" });

  const caseNumber = CASE_NUMBER.exec(said);
  if (caseNumber && (STATUS.test(t) || t.split(" ").length <= 4)) {
    return flow.getCaseStatus(callId, `SR-${caseNumber[1]}-${caseNumber[2]}`, { guarded: PRIVATE.test(t) });
  }

  const items = extractItems(flow, t);
  if (call.bulk) {
    const continued = continueBulk(flow, callId, said, items);
    if (continued) return continued;
  }

  if (call.current) return continueIntake(flow, callId, said);

  const type = flow.requests.match(said, call.language);
  if (COMPLAINT.test(t) && !type) return flow.complaint(callId, said);

  if (BULK.test(t) || (items.length && PICK_UP.test(t))) return startBulk(flow, callId, said, items);

  if (PERMIT.test(t)) {
    const faq = flow.searchFaq(callId, said, { prompt: false });
    if (!faq.ok) return faq;
    if (/\b(text|sms|link|send|enlace|mensaje)\b/.test(t) && !/\bno\b/.test(t)) {
      flow.sendFormLink(callId, "permits");
      flow.anythingElse(callId);
    } else if (/\bno\b/.test(t)) flow.anythingElse(callId);
    else flow.offerFormLink(callId, "permits");
    return faq;
  }

  if (FAQ.test(t) && !type) return flow.searchFaq(callId, said);

  if (type) {
    const started = flow.startRequest(callId, type.id);
    if (!started.ok || started.transferred || started.transferring || started.afterHours) return started;
    fillObviousFields(flow, callId, said, null);
    return beginIntake(flow, callId, said, started);
  }

  if (/\?\s*$/.test(said) || QUESTION_START.test(t)) return flow.searchFaq(callId, said);
  if (GOODBYE.test(t)) return flow.goodbye(callId);
  return flow.fail(callId, "unrecognized_intent");
}

/** Answers to the question the assistant just asked. Returns null when the turn is something else. */
function answerPending(flow, callId, said) {
  const call = flow.get(callId);
  const pending = call?.pending;
  if (!pending) return null;
  const t = norm(said);
  const no = NO.test(t);
  const yes = !no && YES.test(t);
  const plain = t.split(" ").every((w) => FILLER.has(w));

  if (pending === "confirm-location" && call.current) {
    if (yes && plain) return flow.confirmLocation(callId, true);
    const where = flow.geocoder.resolve(said);
    if (where.ok && where.normalized !== call.current.location?.normalized) return flow.resolveLocation(callId, said, { readBack: true });
    if (yes || where.ok) {
      fillObviousFields(flow, callId, said, null);
      return flow.confirmLocation(callId, true);
    }
    if (no) return flow.confirmLocation(callId, false);
  } else if (pending === "updates") {
    if (yes) return flow.acceptUpdates(callId);
    if (no) {
      flow.setContact(callId, { wantsUpdates: false });
      if (plain) return flow.goodbye(callId);
    }
  } else if (pending === "anything-else") {
    if (no && plain) return flow.goodbye(callId);
    if (yes && plain) return flow.whatElse(callId);
  } else if (pending === "offer-person") {
    if (yes) return flow.transfer(callId, { reason: "no_answer", departmentId: "311-live" });
    if (no) return GOODBYE.test(t) ? flow.goodbye(callId) : flow.anythingElse(callId);
  } else if (pending.startsWith("form-link:")) {
    const serviceId = pending.slice("form-link:".length);
    if (yes) {
      const sent = flow.sendFormLink(callId, serviceId);
      flow.anythingElse(callId);
      return sent;
    }
    if (no) return flow.anythingElse(callId);
  } else if (pending === "complaint") {
    if (PERSON.test(t) || (yes && plain)) return flow.transfer(callId, { reason: "complaint", departmentId: "311-live" });
    if (/\b(file|report|reporte|registrar|registre|registrelo)\b/.test(t)) {
      const typeId = flow.requests.match(said, call.language)?.id ?? call.complaint?.about;
      if (!typeId) return flow.transfer(callId, { reason: "complaint", departmentId: "311-live" });
      const started = flow.startRequest(callId, typeId);
      if (!started.ok || started.transferred || started.transferring || started.afterHours) return started;
      const text = `${call.complaint?.text ?? ""} ${said}`;
      fillObviousFields(flow, callId, text, null);
      return beginIntake(flow, callId, text, started);
    }
  }
  if (finished(call)) return null;
  call.pending = null;
  return null;
}

/**
 * The turn that opened a report: use any place it names, then ask for what's missing.
 * A verified place is always read back, as the live bridge does, so nothing is
 * filed until the caller confirms where.
 */
function beginIntake(flow, callId, said, started) {
  const probe = flow.geocoder.resolve(said);
  let located = null;
  if (probe.ok || probe.ambiguous) located = flow.resolveLocation(callId, said, { readBack: true, speak: true });
  return intakeTail(flow, callId, located, started);
}

/** A report already under way: the turn most likely answers the last question. */
function continueIntake(flow, callId, said) {
  const call = flow.get(callId);
  const cur = call.current;
  const t = norm(said);
  const asked = cur.missing[0] ?? null;
  const before = progress(cur);
  let located = null;
  if (!cur.confirmedLocation) {
    const probe = flow.geocoder.resolve(cur.locationHint ? `${cur.locationHint} ${said}` : said);
    const direct = flow.geocoder.resolve(said);
    if (!cur.location || direct.ok || (probe.ok && !cur.location)) {
      // Speak only for news: a place, or a new street to narrow down. A miss is counted below.
      // Boolean, because an undefined `speak` would fall back to speaking and skip the count.
      const news = Boolean(direct.ok || probe.ok || (direct.ambiguous && direct.candidates?.[0]?.label?.split(" at ")[0] !== cur.locationHint));
      // "I'm not sure" or a bare yes or no is a non-answer, not a landmark note.
      const nonAnswer = UNSURE.test(t) || (t.split(" ").every((w) => FILLER.has(w)) && (YES.test(t) || NO.test(t)));
      if (news || !nonAnswer) located = flow.resolveLocation(callId, said, { readBack: true, speak: news });
    }
  }
  fillObviousFields(flow, callId, said, asked === "location" ? null : asked);
  const now = flow.get(callId).current;
  // Nothing in the turn answered the question. That counts as a failed attempt, so
  // a caller who can't say where or how big reaches a person, not the same question.
  if (now && !finished(call) && !located?.phrase && progress(now) === before) return flow.fail(callId, "unanswered");
  return intakeTail(flow, callId, located, { ok: true, missing: now?.missing ?? [] });
}

/** What the caller has given so far. A landmark note doesn't count: anything unverifiable becomes one. */
function progress(cur) {
  return JSON.stringify([{ ...cur.fields, landmark: undefined }, cur.location?.normalized ?? null, cur.confirmedLocation, cur.locationHint]);
}

function intakeTail(flow, callId, located, fallback) {
  const call = flow.get(callId);
  if (!call?.current || finished(call)) return located ?? fallback;
  if (call.pending === "confirm-location") return located;
  if (!call.current.missing.length) return flow.submitRequest(callId);
  if (located?.phrase) return located;
  return flow.askForMissing(callId);
}

function startBulk(flow, callId, said, items) {
  const where = flow.geocoder.resolve(said);
  if (where.ok) {
    const result = flow.bulkPickup(callId, items, { ask: false });
    if (result.ok) return flow.confirmBulkPickup(callId, said);
    const call = flow.get(callId);
    if (call.bulk && result.reason === "no_items") call.bulk.where = said;
    return result;
  }
  return flow.bulkPickup(callId, items);
}

function continueBulk(flow, callId, said, items) {
  const call = flow.get(callId);
  const where = flow.geocoder.resolve(said);
  if (!call.bulk.items.length) {
    if (!items.length) return null;
    const remembered = call.bulk.where;
    if (where.ok || remembered) {
      const result = flow.bulkPickup(callId, items, { ask: false });
      return result.ok ? flow.confirmBulkPickup(callId, where.ok ? said : remembered) : result;
    }
    return flow.bulkPickup(callId, items);
  }
  if (where.ok) return flow.confirmBulkPickup(callId, said);
  if (where.ambiguous) return flow.bulkPickup(callId, call.bulk.items);
  return null;
}

/** Bulk items named in the turn, in the order the caller said them. */
function extractItems(flow, t) {
  const found = [];
  for (const [alias, item] of flow.itemAliases) {
    const m = new RegExp(`\\b${alias}(e?s)?\\b`).exec(t);
    if (m && !found.some((f) => f.item === item)) found.push({ item, at: m.index });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.item);
}

/**
 * Fills the details a caller volunteers. Size and travel lane are set only when
 * said; the rest fall back to a sensible default so a one-sentence report files.
 */
/** The normalized turn with the city's street names removed (they are already normalized to [a-z0-9 ]). */
function withoutStreetNames(flow, t) {
  const { addresses = [], streets = [] } = flow.geocoder ?? {};
  const names = [...addresses.map((a) => a.street), ...streets.flatMap((s) => [s.name, ...(s.aliases ?? [])])].map(norm).filter(Boolean);
  return names.reduce((text, name) => text.replace(new RegExp(`\\b${name}\\b`, "g"), " "), t);
}

function fillObviousFields(flow, callId, said, asked) {
  const cur = flow.get(callId)?.current;
  if (!cur) return;
  const t = norm(said);
  const missing = new Set(cur.missing);
  const set = (name, value) => flow.setField(callId, name, value);
  switch (cur.typeId) {
    case "pothole": {
      const size = /\b(large|big|huge|deep|grande|enorme)\b/.test(t) ? "large" : /\b(medium|mediano|mediana)\b/.test(t) ? "medium" : /\b(small|little|pequeno|pequena|chico|chica)\b/.test(t) ? "small" : null;
      if (size) set("size", size);
      // Street names come out first, so "10 Cedar Lane" is a place, not a travel lane.
      const road = withoutStreetNames(flow, t);
      if (/\b(travel lane|lane|traffic|carril|trafico)\b/.test(road)) set("inTravelLane", !/\b(not|isn t|isnt|outside|no esta|fuera de|fuera del)\b(\s+\w+){0,3}\s+(lane|traffic|carril|trafico)\b/.test(road));
      else if (asked === "size" && /\b(yes|yeah|si)\b/.test(t)) set("inTravelLane", true);
      else if (asked === "size" && /\bno\b/.test(t) && !UNSURE.test(t)) set("inTravelLane", false);
      break;
    }
    case "streetlight-out": {
      const pole = /\bpole\s*(?:number\s*)?(?:is\s*)?([a-z]{0,3}\d[a-z0-9-]*)\b/.exec(t)?.[1] ?? (asked === "poleNumber" ? /\b([a-z]{0,3}\d[a-z0-9-]*)\b/.exec(t)?.[1] : null);
      if (pole) set("poleNumber", pole);
      else if (missing.has("poleNumber")) set("poleNumber", "unknown");
      break;
    }
    case "missed-trash":
      if (missing.has("pickupType") || /\b(recycling|reciclaje|yard|jardin)\b/.test(t)) set("pickupType", /\b(recycling|reciclaje)\b/.test(t) ? "recycling" : /\b(yard|jardin)\b/.test(t) ? "yard waste" : "trash");
      break;
    case "graffiti":
      if (missing.has("surface")) set("surface", /\b(sign|letrero|senal)\b/.test(t) ? "sign" : /\b(sidewalk|acera|banqueta)\b/.test(t) ? "sidewalk" : /\b(wall|pared|muro)\b/.test(t) ? "wall" : "building");
      if (/\b(offensive|obscene|hate|racist|ofensivo|ofensiva)\b/.test(t)) set("offensive", true);
      break;
    case "abandoned-vehicle": {
      if (!missing.has("vehicleDescription")) break;
      const desc = said
        .replace(/abandoned (vehicle|car)|car has not moved|veh[ií]culo abandonado|auto abandonado/gi, " ")
        .replace(/\b(at|on|near|in front of|by|en|cerca de|frente a)\b.*$/i, "")
        .replace(/^[\s,.:;-]*(there(?: is|'s)?|it'?s|it is|hay|es)?\s*/i, "")
        .replace(/[\s,.;:!?-]+$/, "")
        .trim();
      if (desc && (asked === "vehicleDescription" || VEHICLE.test(norm(desc)))) set("vehicleDescription", desc);
      break;
    }
    case "noise-complaint":
      if (missing.has("noiseType")) set("noiseType", /\b(construction|construccion)\b/.test(t) ? "construction" : /\b(music|musica)\b/.test(t) ? "loud music" : asked === "noiseType" ? said.trim().slice(0, 60) : "noise");
      break;
    default:
      break;
  }
}

function finished(call) { return call.state === STATES.ENDED || call.state === STATES.TRANSFERRED; }
