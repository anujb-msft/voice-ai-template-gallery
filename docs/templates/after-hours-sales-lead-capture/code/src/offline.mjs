import { STATES } from "./flow.mjs";
import { normaliseEmail, normalisePhone, stateFromText } from "./policy.mjs";

export function registerSimulatedAgent(flow, callId) {
  flow.registerAgent(callId, { instruct: () => {}, nudge: () => {} });
}

export function classifyUtterance(text) {
  const t = String(text ?? "").toLowerCase();
  if (/emergency|fire|medical|police|danger/.test(t)) return { kind: "emergency" };
  if (/robocall|unsubscribe|warranty|seo|crypto|spam/.test(t)) return { kind: "spam" };
  if (/existing order|order status|where is my order|return|service issue|already bought|invoice problem/.test(t)) return { kind: "existing-customer" };
  return null;
}

export function handleUtterance(flow, callId, text) {
  const said = String(text ?? "").trim();
  if (!said) return flow.noInput(callId);
  flow.pushTranscript(callId, "caller", said);
  const call = flow.get(callId);
  if (!call || [STATES.ENDED, STATES.TRANSFERRED].includes(call.state)) return { ok: false, reason: "call_finished" };
  const nonSales = classifyUtterance(said);
  if (nonSales) return flow.classifyNonSales(callId, nonSales.kind, said);
  if (/\b(price|pricing|quote|stock|availability|available|deliver by|delivery date)\b/i.test(said)) {
    flow.updateFields(callId, { notes: append(call.draft.notes, `Caller asked: ${said}. Agent did not quote price, stock, or delivery commitment.`) });
    flow.pushTranscript(callId, "agent", "I can't quote that, but I'll note it so your rep can give you an exact answer.");
  }
  const patch = extractFields(said, flow.catalog);
  if (Object.keys(patch).length) flow.updateFields(callId, patch);
  const updated = flow.get(callId);
  if (readyToSave(updated.draft)) return flow.saveLead(callId);
  return { ok: true, draft: flow.publicDraft(updated), awaiting: missingFields(updated.draft) };
}

export async function runTranscript(flow, callId, transcript = []) {
  let result = null;
  for (const line of transcript) {
    result = handleUtterance(flow, callId, line);
    if ([STATES.ENDED, STATES.TRANSFERRED].includes(flow.get(callId)?.state)) break;
  }
  return { result, snapshot: flow.snapshot(callId) };
}

export function extractFields(text, catalog) {
  const out = {};
  const raw = String(text ?? "");
  const t = raw.toLowerCase();
  const email = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (email) { out.email = email; out.emailConfirmed = true; }
  const phone = raw.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/)?.[0];
  if (phone) { out.callbackPhone = normalisePhone(phone); out.phoneConfirmed = true; }
  if (/\b(correct|yes|that's right|that is right)\b/i.test(raw)) {
    if (out.callbackPhone || /phone|number/.test(t)) out.phoneConfirmed = true;
    if (out.email || /email|mail/.test(t)) out.emailConfirmed = true;
  }
  const name = raw.match(/(?:my name is|this is|i am|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/)?.[1];
  if (name && !/calling|looking|interested/i.test(name)) out.name = name;
  const company = raw.match(/(?:from|at|with)\s+([A-Z][A-Za-z0-9& -]{2,40})(?:\.|,| and |$)/)?.[1];
  if (company && !/calling|looking|interested/i.test(company)) out.company = company.trim();
  const product = catalog.lookup(raw)[0];
  if (product) out.productInterest = product.name;
  const quantity = raw.match(/(?:qty|quantity|need|order|about|around|for)\s+([0-9][0-9,]*)/)?.[1] ?? raw.match(/([0-9][0-9,]*)\s*(?:units|pieces|boxes|bolts|screws|fittings|cartons)/)?.[1];
  if (quantity) out.quantity = Number(quantity.replace(/,/g, ""));
  if (/asap|this week|next week|within 30|this month|two weeks/i.test(raw)) out.timeline = raw.match(/(asap|this week|next week|within 30 days|this month|two weeks)/i)?.[0] ?? "within 30 days";
  else if (/within 90|next quarter|few months|60 days/i.test(raw)) out.timeline = raw.match(/(within 90 days|next quarter|few months|60 days)/i)?.[0] ?? "within 90 days";
  else if (/later|next year|exploring/i.test(raw)) out.timeline = "later";
  if (/owner|founder|director|vp|president|procurement|purchasing|buyer|manager|engineer|operations/i.test(raw)) out.role = raw.match(/owner|founder|director|vp|president|procurement|purchasing|buyer|manager|engineer|operations/i)[0];
  const state = stateFromText(raw);
  if (state) out.location = state;
  return out;
}

function readyToSave(d) { return Boolean((d.phoneConfirmed && d.callbackPhone) || (d.emailConfirmed && normaliseEmail(d.email))) && d.productInterest && d.quantity && d.timeline && d.company && d.role; }
function missingFields(d) { return [!d.productInterest&&"product", !d.quantity&&"quantity", !d.timeline&&"timeline", !d.company&&"company", !d.role&&"role", !((d.phoneConfirmed&&d.callbackPhone)||(d.emailConfirmed&&normaliseEmail(d.email)))&&"confirmed contact"].filter(Boolean); }
function append(a,b){ return [a,b].filter(Boolean).join(" "); }
