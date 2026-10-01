import { isExplicitSave, STATES } from "./flow.mjs";

export function registerSimulatedAgent(flow, callId) {
  flow.registerAgent(callId, { instruct: () => {}, nudge: () => {} });
}

export function handleUtterance(flow, callId, text) {
  const said = String(text ?? "").trim();
  if (!said) return flow.noInput(callId);
  flow.pushTranscript(callId, "caller", said);
  const call = flow.get(callId);
  const lower = said.toLowerCase();

  if (/^[0-9]$/.test(said) || said === "*") return flow.dtmf(callId, said);
  if (call?.state === STATES.IDENTIFYING && call.pendingPstnRep) return flow.submitPin(callId, said.replace(/\D/g, ""));
  if (/\bpause\b/.test(lower)) return flow.pause(callId);
  if (/\bcontinue\b/.test(lower)) return flow.continue(callId);
  if (/\brepeat\b|\*/.test(lower)) return flow.repeatLast(callId);
  if (/\bundo\b/.test(lower)) return flow.undoLastCommit(callId);
  if (/\b(call me back later|save (it )?as a draft|later)\b/.test(lower)) return flow.saveDraft(callId, call.currentProposalId, "caller_requested");
  if (/\bresume my draft\b/.test(lower)) return flow.resumeDraft(callId);
  if (/\b(person|human|sales operations|operator)\b/.test(lower)) return flow.transfer(callId, "explicit_request");

  if (call?.state === STATES.CONFIRMING && call.currentProposalId) {
    if (isExplicitSave(said)) return flow.commitProposal(callId, call.currentProposalId, said);
    if (/\b(actually|keep|change|make it|instead|no,?)\b/.test(lower)) return flow.amendProposal(callId, call.currentProposalId, said);
    return { ok: false, reason: "not_confirmed" };
  }

  if (/\b(number|phone|email)\b/.test(lower) && call?.currentBriefing?.keyContact) {
    return flow.getContactInfo(callId, call.currentBriefing.keyContact.id, /email/.test(lower) ? "email" : "phone");
  }

  if (/tell me more|more about|who'?s the contact|who else|task/.test(lower) && call?.currentBriefing) {
    const handle = pickHandle(call.currentBriefing.handles, lower);
    if (handle) return flow.getDetail(callId, handle.handle);
  }

  if (/\b(log|meeting|met with|remind me|agreed|close date|discount|reassign|delete)\b/.test(lower)) {
    const accountId = call?.accountId ?? findAccountIdFirst(flow, callId, said);
    return flow.proposeUpdate(callId, accountId, said);
  }

  if (/\bbrief|update|account|customer|fabrikam|northwind|tailspin|contoso|adatum|proseware|coho|wide world|spell/.test(lower)) {
    const result = flow.findAccount(callId, said);
    if (result.status === "confirmed" && /\bbrief\b/.test(lower)) return flow.getBriefing(callId, result.account.id);
    return result;
  }

  return flow.noInput(callId);
}

function findAccountIdFirst(flow, callId, said) {
  const call = flow.get(callId);
  if (call?.accountId) return call.accountId;
  const result = flow.findAccount(callId, said);
  return result.account?.id ?? call?.accountId;
}

function pickHandle(handles, lower) {
  if (/contact|who else/.test(lower)) return handles.find((h) => h.type === "contact");
  if (/task/.test(lower)) return handles.find((h) => h.type === "task");
  return handles.find((h) => lower.includes(h.label.toLowerCase().split(/\s+/)[0])) ?? handles[0];
}
