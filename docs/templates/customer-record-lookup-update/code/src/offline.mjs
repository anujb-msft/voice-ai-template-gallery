/**
 * Simulation mode: a typed or scripted line stands in for the speech model and
 * picks the flow method a live call's tool call would. Every decision stays in
 * the flow, so a simulated call and a live call are held to the same policy.
 * Standard library only.
 */
import { phoneFromText } from "./crm-shared.mjs";
import { isExplicitSave, STATES } from "./flow.mjs";

const CLOSED = new Set([STATES.REFUSED, STATES.TRANSFERRING, STATES.TRANSFERRED, STATES.ENDED]);
const MIND_CHANGE_RE = /\bwait\b|^\s*no\b|\bstop\b|\bcancel\b|\bhold on\b|\bdon'?t\b|\bkeep the (?:old|current|original|existing)\b|\bnever ?mind\b|\bundo\b|\bscratch that\b|\bchanged my mind\b/;
const LATE_WAIT_RE = /\bwait\b|\bstop\b|\bkeep the (?:old|current|original|existing)\b|\bscratch that\b|\bchanged my mind\b/;
const PERSON_RE = /\b(?:person|human|someone|sales operations|operator|representative|transfer me)\b/;
const ACCEPT_RE = /\b(?:yes|yeah|yep|sure|ok(?:ay)?|please do|put me through|go ahead|do it|connect me)\b/;
const DECLINE_RE = /^\s*(?:no|nope|not now|no thanks|never ?mind|that's all)\b/;
const AMEND_RE = /\b(?:actually|keep|change|make it|instead|move|set|use|wait|skip|don'?t|no task|no reminder)\b|^\s*no\b/;
const PROPOSAL_RE = /\b(?:log|logged|meeting|met with|remind me|agreed|close date|next step|stage|amount|discount|reassign|delete|merge|credit|net \d+|payment terms|billing terms|invoice terms|owner)\b/;
const CONTACT_UPDATE_RE = /\b(?:new|change|changed|update|updated|switch|switched|replace|now)\b/;
const CONTACT_ASK_RE = /\b(?:number|phone|mobile|cell|e-?mail|reach)\b/;
const DETAIL_RE = /\btell me more\b|\bmore about\b|\bwho'?s the contact\b|\bwho else\b|\bdetails? (?:on|about|for)\b|\bwhat about\b|\bthe task\b/;
const ACCOUNT_RE = /\bbrief|\baccount\b|\bcustomer\b|\bpull up\b|\blook up\b|\bopen\b|\bspell/;
const YES_RE = /^\s*(?:yes|yeah|yep|correct|right|that's (?:it|right|the one))\b/;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

export function registerSimulatedAgent(flow, callId) {
  flow.registerAgent(callId, { instruct: () => {}, nudge: () => {} });
}

export function handleUtterance(flow, callId, text) {
  const said = String(text ?? "").trim();
  if (!said) return flow.noInput(callId);
  const call = flow.get(callId);
  if (!call) return { ok: false, reason: "unknown_call" };
  const pinPending = call.state === STATES.IDENTIFYING && Boolean(call.pendingPstnRep);
  flow.pushTranscript(callId, "caller", pinPending && /\d/.test(said) ? "••••••" : said);
  if (/^[0-9*#]$/.test(said) && !call.accountCandidates?.length) return flow.dtmf(callId, said);
  if (pinPending) return /\d/.test(said) ? flow.submitPin(callId, said.replace(/\D/g, "")) : flow.repeatLast(callId);
  if (CLOSED.has(call.state)) return { ok: false, reason: "call_finished" };
  if (!call.rep) return { ok: false, reason: "not_verified" };
  const lower = said.toLowerCase();

  // Inside the undo window only a mind change, or a person, gets through.
  if (call.state === STATES.COMMITTING && call.pendingCommit) {
    if (MIND_CHANGE_RE.test(lower)) return flow.cancelPendingCommit(callId, "caller_changed_mind");
    if (PERSON_RE.test(lower)) return flow.transfer(callId, "explicit_request");
    return flow.holdForWindow(callId);
  }
  // A "wait" just after the window closed hears that the write landed and how to take it back.
  if (call.state === STATES.COMMITTED && LATE_WAIT_RE.test(lower)) return flow.cancelPendingCommit(callId, "caller_changed_mind");
  if (call.currentProposalId && isExplicitSave(said)) return flow.commitProposal(callId, call.currentProposalId, said);
  if (call.offeredHandoff) {
    if (DECLINE_RE.test(lower)) return flow.declineHandoff(callId);
    if (ACCEPT_RE.test(lower)) return flow.acceptHandoff(callId);
  }
  if (call.accountCandidates?.length) {
    const pick = pickCandidate(call.accountCandidates, lower);
    if (pick) return /\bbrief\b/.test(lower) ? flow.getBriefing(callId, pick.id) : flow.selectAccount(callId, pick.id);
  }
  if (/\bpause\b|\bgive me a (?:sec|second|minute|moment)\b|\bhold on\b/.test(lower)) return flow.pause(callId);
  if (call.state === STATES.PAUSED && /\bcontinue\b|\bi'?m back\b|\bgo ahead\b/.test(lower)) return flow.continue(callId);
  if (/\brepeat\b|\bsay that again\b|\bcome again\b/.test(lower)) return flow.repeatLast(callId);
  if (/\bresume (?:my |the )?draft\b/.test(lower)) return flow.resumeDraft(callId);
  if (/\bundo\b|\btake (?:it|that) back\b|\brevert\b/.test(lower)) return flow.undoLastCommit(callId);
  if (/\bcall me back later\b|\bsave (?:it |this |that )?as a draft\b|\bdraft it\b/.test(lower)) return flow.saveDraft(callId, call.currentProposalId, "caller_requested");
  if (PERSON_RE.test(lower) || /\bput me through\b/.test(lower)) return flow.transfer(callId, "explicit_request");
  if (call.state === STATES.CONFIRMING && call.currentProposalId && (AMEND_RE.test(lower) || phoneFromText(said))) {
    return flow.amendProposal(callId, call.currentProposalId, said);
  }

  if ((phoneFromText(said) || EMAIL_RE.test(said)) && CONTACT_UPDATE_RE.test(lower)) return propose(flow, call, said);
  if (CONTACT_ASK_RE.test(lower) && !PROPOSAL_RE.test(lower)) {
    const accountId = quietAccount(flow, call, said)?.id ?? call.accountId;
    if (!accountId) return flow.findAccount(callId, said);
    const contact = mentionedContact(flow, accountId, lower);
    if (contact) return flow.getContactInfo(callId, contact.id, /\be-?mail\b/.test(lower) ? "email" : "phone");
  }
  if (call.currentBriefing && DETAIL_RE.test(lower)) {
    const handle = pickHandle(call.currentBriefing.handles, lower);
    if (handle) return flow.getDetail(callId, handle.handle);
  }
  if (PROPOSAL_RE.test(lower)) return propose(flow, call, said);
  // "Yes" confirms an account here; while a change is being read back, only "yes, save it" saves (below).
  if (call.accountId && !call.currentBriefing && call.state !== STATES.CONFIRMING && YES_RE.test(lower)) return flow.getBriefing(callId, call.accountId);
  const named = quietAccount(flow, call, said);
  if (/\bbrief\b/.test(lower) && (named || call.accountId)) return flow.getBriefing(callId, named?.id ?? call.accountId);
  if (named || ACCOUNT_RE.test(lower)) return flow.findAccount(callId, said);
  if (call.state === STATES.CONFIRMING && call.currentProposalId) return flow.commitProposal(callId, call.currentProposalId, said);
  return flow.notUnderstood(callId);
}

/** A dictated update: the account named in it, else the one already open. */
function propose(flow, call, said) {
  const accountId = quietAccount(flow, call, said)?.id ?? call.accountId;
  if (!accountId) return flow.findAccount(call.id, said);
  return flow.proposeUpdate(call.id, accountId, said);
}

/** The account a sentence names, if it names exactly one; nothing is said. */
function quietAccount(flow, call, said) {
  const result = flow.crm.findAccounts?.(call.rep, said);
  return result?.status === "confirmed" ? result.account : null;
}

function mentionedContact(flow, accountId, lower) {
  const contacts = flow.crm.contacts?.(accountId) ?? [];
  const named = contacts.find((c) => new RegExp(String.raw`\b${escapeRe(c.name.split(/\s+/)[0].toLowerCase())}\b`).test(lower));
  return named ?? contacts.find((c) => c.isKey) ?? contacts[0] ?? null;
}

function pickCandidate(candidates, lower) {
  const ordinals = [String.raw`first|one|1|number one`, String.raw`second|two|2|number two`, String.raw`third|three|3|number three`];
  for (let i = 0; i < candidates.length && i < ordinals.length; i++) {
    if (new RegExp(String.raw`(?:^|\b)(?:${ordinals[i]})\b`).test(lower)) return candidates[i];
  }
  return candidates.find((c) => lower.includes(c.name.toLowerCase()) || (c.city && lower.includes(c.city.toLowerCase()))) ?? null;
}

function pickHandle(handles, lower) {
  if (/contact|who else/.test(lower)) return handles.find((h) => h.type === "contact");
  if (/task/.test(lower)) return handles.find((h) => h.type === "task");
  return handles.find((h) => lower.includes(h.label.toLowerCase().split(/\s+/)[0])) ?? handles[0];
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
