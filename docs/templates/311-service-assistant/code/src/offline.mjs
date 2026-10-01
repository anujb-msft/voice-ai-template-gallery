import { STATES } from "./flow.mjs";

export function registerSimulatedAgent(flow, callId) {
  flow.registerAgent(callId, {
    instruct: (_prompt, spoken) => { if (spoken) flow.pushTranscript(callId, "agent", spoken); },
    nudge: (_prompt, opts) => { if (opts?.spoken) flow.pushTranscript(callId, "agent", opts.spoken); },
  });
}

export function handleUtterance(flow, callId, text) {
  const said = String(text ?? "").trim();
  if (!said) return flow.noInput(callId);
  const observed = flow.observeCaller(callId, said);
  if (observed?.category || flow.get(callId)?.state === STATES.ENDED) return observed;
  if (/^[0-9*]$/.test(said)) return flow.dtmf(callId, said);
  const call = flow.get(callId);

  if (/(relay|tty|t t y)/i.test(said)) return flow.transfer(callId, { reason: "relay", departmentId: "relay" });
  if (/(person|human|operator|agent|representative|alguien|persona)/i.test(said)) return flow.transfer(callId, { reason: "caller_requested", departmentId: "311-live" });
  const status = /(SR[-\s]?\d{2}[-\s]?\d{4})/i.exec(said);
  if (/status|estado|case|caso/i.test(said) && status) return flow.getCaseStatus(callId, status[1]);

  if (/bulk|large item|mattress|sofa|recogida/i.test(said)) {
    const items = extractItems(said);
    const result = flow.bulkPickup(callId, items.length ? items : ["mattress"]);
    if (result.ok && /maple|oak|pine|cedar|library|\d+/.test(said.toLowerCase())) return flow.confirmBulkPickup(callId, said);
    return result;
  }
  if (call?.bulk && /(maple|oak|pine|cedar|library|\d+)/i.test(said)) return flow.confirmBulkPickup(callId, said);

  if (/permit|license|licen[cs]e|permiso/i.test(said)) {
    const faq = flow.searchFaq(callId, said);
    if (/(text|sms|link|sí|si|yes)/i.test(said) && !/(no|decline)/i.test(said)) flow.sendFormLink(callId, "permits");
    return faq;
  }

  if (/trash|garbage|pickup|hours|fees|fee|schedule|basura|tarifa|horario/i.test(said) && !flow.requests.match?.(said)) {
    return flow.searchFaq(callId, said);
  }

  if (!call?.current) {
    const type = flow.requests.match(said, call?.language ?? "en-US");
    if (!type) return flow.fail(callId, "unrecognized_intent");
    const start = flow.startRequest(callId, type.id);
    if (start?.transferred || start?.afterHours) return start;
    const loc = flow.resolveLocation(callId, said);
    fillObviousFields(flow, callId, said, type.id);
    const current = flow.get(callId).current;
    if (current && current.missing.length === 0) return flow.submitRequest(callId);
    return { ok: true, start, location: loc, missing: current?.missing ?? [] };
  }

  if (/(yes|yeah|correct|right|sí|si)/i.test(said) && call.current.location && !call.current.confirmedLocation) {
    call.current.confirmedLocation = true;
  }
  if (!call.current.location && /(maple|oak|pine|cedar|library|\d+)/i.test(said)) flow.resolveLocation(callId, said);
  fillObviousFields(flow, callId, said, call.current.typeId);
  if (call.current?.missing.length === 0) return flow.submitRequest(callId);
  return { ok: true, missing: call.current?.missing ?? [] };
}

function fillObviousFields(flow, callId, text, typeId) {
  const lower = text.toLowerCase();
  const set = (n, v) => flow.setField(callId, n, v);
  if (typeId === "pothole") {
    if (/large|big|grande/.test(lower)) set("size", "large"); else if (/medium|mediano/.test(lower)) set("size", "medium"); else if (/small|peque/.test(lower)) set("size", "small");
    if (/travel lane|lane|traffic|carril/.test(lower)) set("inTravelLane", true);
  }
  if (typeId === "streetlight-out") set("poleNumber", /pole\s*([a-z0-9-]+)/i.exec(text)?.[1] ?? "unknown");
  if (typeId === "missed-trash") set("pickupType", /recycling/.test(lower) ? "recycling" : /yard/.test(lower) ? "yard waste" : "trash");
  if (typeId === "graffiti") set("surface", /sign/.test(lower) ? "sign" : /sidewalk/.test(lower) ? "sidewalk" : /wall/.test(lower) ? "wall" : "building");
  if (typeId === "abandoned-vehicle") set("vehicleDescription", text.replace(/abandoned vehicle|abandoned car/i, "").trim() || "vehicle");
  if (typeId === "noise-complaint") set("noiseType", /construction/.test(lower) ? "construction" : /music/.test(lower) ? "loud music" : "noise");
}

function extractItems(text) {
  const known = ["mattress", "sofa", "chair", "table", "dresser", "paint", "oil", "battery", "refrigerator", "construction debris"];
  const lower = text.toLowerCase();
  return known.filter((i) => lower.includes(i));
}
