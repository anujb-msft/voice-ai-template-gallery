import { normalisePhone } from "./policy.mjs";

const YES = /\b(yes|yeah|yep|correct|right|ok|okay|permission|you can enter|enter)\b/i;
const NO = /\b(no|nope|do not|don't)\b/i;

export function startOfflineIntake(flow, { fromPhone = "+15551230001" } = {}) {
  const call = flow.createIntake({ fromPhone: normalisePhone(fromPhone), simulated: true });
  flow.answered(call.id);
  return call;
}

export function handleTenantUtterance(flow, callId, text) {
  const said = String(text ?? "").trim();
  const ctx = flow.intakes.get(callId);
  if (!ctx) throw new Error(`unknown intake ${callId}`);
  ctx.transcript.push({ role: "tenant", text: said, at: new Date(flow.now()).toISOString() });

  if (/\b(unit|apartment|apt)\s*([a-z0-9-]+)/i.test(said) || /\b(maple|pine)\b/i.test(said)) {
    const unit = said.match(/\b(?:unit|apartment|apt)\s*([a-z0-9-]+)/i)?.[1] ?? ctx.unit;
    const property = said.match(/\b(maple court|maple|pine terrace|pine)\b/i)?.[1] ?? null;
    const identified = flow.identifyUnit(callId, { property, unit });
    if (!identified.ok) return identified;
  }

  const patch = {};
  if (/\b(leak|water|ceiling|flood|pipe|heat|furnace|heater|locked out|lockout|power|fire|gas|smoke|dishwasher|faucet|drain|noise)\b/i.test(said)) {
    if (!ctx.fields.issue) patch.issue = said;
    patch.details = said;
    patch.tenantSaid = said;
  }
  const temp = said.match(/\b(\d{2})\s*(?:degrees|degree|f|fahrenheit)?\b/i)?.[1];
  if (/heat|temperature|degrees|fahrenheit/i.test(said) && temp) patch.indoorTempF = Number(temp);
  if (/\b(front|back|side|gate|dog|key|lockbox|door|entry|access)\b/i.test(said)) patch.accessNotes = said;
  if (YES.test(said) && /enter|permission|come in|access/i.test(said)) patch.permissionToEnter = true;
  if (NO.test(said) && /enter|permission|come in|access/i.test(said)) patch.permissionToEnter = false;
  const phone = said.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0];
  if (phone) patch.callbackNumber = phone;

  if (Object.keys(patch).length) return flow.recordIssue(callId, patch);
  if (YES.test(said) && ctx.propertyId && ctx.unit) return flow.identifyUnit(callId, {});
  return { ok: true, ignored: true };
}

export async function runTranscript(flow, { fromPhone = "+15551230001", transcript = [], pageOutcomes = [] } = {}) {
  const call = startOfflineIntake(flow, { fromPhone });
  if (pageOutcomes.length) flow.setNextPageOutcomes(pageOutcomes);
  for (const line of transcript) handleTenantUtterance(flow, call.id, line);
  const submitted = flow.classifyAndSubmit(call.id);
  await flow.processDueJobs();
  return { callId: call.id, submitted, intake: flow.snapshotIntake(call.id), incident: submitted.incidentId ? flow.snapshotIncident(submitted.incidentId) : null };
}

export async function simulatePageOutcome(flow, incidentId, outcome) {
  return flow.forceNextPage(incidentId, outcome);
}
