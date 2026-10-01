import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { config, resolvePath, todayIso, nowDate } from "./config.mjs";

export const STATES = Object.freeze({
  RINGING: "ringing",
  IDENTIFYING: "identifying",
  REFUSED: "refused",
  GREETING: "greeting",
  LISTENING: "listening",
  BRIEFING: "briefing",
  PROPOSING: "proposing",
  CONFIRMING: "confirming",
  COMMITTED: "committed",
  PAUSED: "paused",
  TRANSFERRING: "transferring",
  TRANSFERRED: "transferred",
  DRAFTING: "drafting",
  CLOSING: "closing",
  ENDED: "ended",
});

const TERMINAL = new Set([STATES.REFUSED, STATES.TRANSFERRED, STATES.ENDED]);

export class CustomerRecordFlow {
  constructor({ crm, reps, audit, transfer = null, hub = null, now = () => Date.now(), options = {} }) {
    this.crm = crm;
    this.reps = reps;
    this.audit = audit;
    this.transferCall = transfer;
    this.hub = hub;
    this.now = now;
    this.options = {
      callTimeBudgetMs: config.callTimeBudgetMs,
      wrapUpMs: config.wrapUpMs,
      persistTranscripts: config.persistTranscripts,
      ...options,
    };
    this.calls = new Map();
    this.agents = new Map();
    this.proposals = new Map();
    this.picklists = JSON.parse(readFileSync(resolvePath(config.crm.picklistsPath), "utf8"));
    this.allowlist = JSON.parse(readFileSync(resolvePath(config.crm.writableFieldsPath), "utf8"));
    this.routing = JSON.parse(readFileSync(resolvePath(config.crm.routingPath), "utf8"));
  }

  create({ callId = randomUUID(), fromPhone = null, teamsUserId = null, incomingCallContext = null, sessionId = null, resourceAccountId = null } = {}) {
    const call = {
      id: callId,
      fromPhone,
      teamsUserId,
      incomingCallContext,
      sessionId: sessionId ?? callId,
      resourceAccountId,
      arrival: resourceAccountId ? "teams-phone-extensibility" : "acs-direct",
      callConnectionId: null,
      state: STATES.RINGING,
      rep: null,
      pendingPstnRep: null,
      verifiedBy: null,
      accountId: null,
      accountName: null,
      accountCandidates: [],
      currentBriefing: null,
      currentProposalId: null,
      lastCommitId: null,
      lastPhrase: null,
      failures: 0,
      noInputs: 0,
      refusedItems: [],
      startedAt: this.now(),
      answeredAt: null,
      endedAt: null,
      outcome: null,
      transcript: [],
    };
    this.calls.set(call.id, call);
    this.audit.startCall({ id: call.id, state: call.state, startedAt: iso(call.startedAt), callerVerified: false, arrival: call.arrival });
    this.#event(call, "system", "call_created", call.arrival);
    return call;
  }

  get(callId) { return this.calls.get(callId) ?? null; }
  registerAgent(callId, handle) { this.agents.set(callId, handle); }
  unregisterAgent(callId) { this.agents.delete(callId); }
  setCallConnection(callId, callConnectionId) { const c = this.get(callId); if (c) c.callConnectionId = callConnectionId; }

  answer(callId) {
    const call = this.#require(callId);
    call.answeredAt = this.now();
    this.#setState(call, STATES.IDENTIFYING);
    if (call.teamsUserId) {
      const rep = this.reps.resolveTeamsUser(call.teamsUserId);
      if (rep) return this.#identify(call, rep);
    }
    if (call.fromPhone) {
      const pending = this.reps.beginPstn(call.fromPhone);
      if (pending) {
        call.pendingPstnRep = pending;
        this.#speak(call, `Please enter your Contoso sales PIN. Press 0 for sales operations.`);
        return { ok: true, needsPin: true };
      }
    }
    return this.refuse(call.id);
  }

  startSimulation({ repId = "rep-alex", callId = randomUUID() } = {}) {
    const repDoc = this.reps.reps.find((r) => r.id === repId) ?? this.reps.reps[0];
    const call = this.create({ callId, teamsUserId: repDoc?.teamsUserId });
    this.answer(call.id);
    return call;
  }

  submitPin(callId, pin) {
    const call = this.#require(callId);
    if (!call.pendingPstnRep) return { ok: false, reason: "no_pin_pending" };
    const rep = this.reps.verifyPin(call.pendingPstnRep.repId, pin);
    if (!rep) {
      this.#event(call, "caller", "pin_failed", "wrong_pin");
      return this.refuse(call.id, "wrong_pin");
    }
    return this.#identify(call, rep);
  }

  refuse(callId, reason = "unknown_caller") {
    const call = this.#require(callId);
    this.#speak(call, "This line is for Contoso sales staff.");
    this.#finish(call, STATES.REFUSED, reason);
    return { ok: false, reason };
  }

  #identify(call, rep) {
    call.rep = rep;
    call.verifiedBy = rep.verifiedBy;
    this.audit.updateCall(call.id, { repName: rep.displayName, callerVerified: true, verifiedBy: rep.verifiedBy });
    this.#setState(call, STATES.GREETING);
    const draft = this.crm.latestDraftHint(rep);
    const draftLine = draft ? ` You have an unsaved update for ${draft.accountName}. Say 'resume my draft' to pick it up.` : "";
    this.#speak(call, `Hi ${rep.firstName}, I'm the Contoso sales assistant, an automated agent. Which account?${draftLine}`);
    this.#setState(call, STATES.LISTENING);
    return { ok: true, rep: { id: rep.id, displayName: rep.displayName, verifiedBy: rep.verifiedBy }, draft };
  }

  findAccount(callId, utterance) {
    const call = this.#requireIdentified(callId);
    if (this.#budgetExpired(call)) return this.#expire(call);
    const result = this.crm.findAccounts(call.rep, utterance);
    call.accountCandidates = result.candidates ?? [];
    this.#event(call, "agent", "find_account", result.status);
    if (result.status === "confirmed") {
      call.accountId = result.account.id;
      call.accountName = result.account.name;
      this.#remember(call, result.phrase);
      return { ok: true, ...result };
    }
    if (result.status === "no_match") {
      const failed = this.#failure(call, "account_no_match");
      if (failed?.simulated || failed instanceof Promise) return failed;
    }
    this.#remember(call, result.phrase ?? "I couldn't find that account. Could you spell it?");
    return { ok: result.status !== "no_match", ...result };
  }

  selectAccount(callId, accountId) {
    const call = this.#requireIdentified(callId);
    const match = call.accountCandidates.find((c) => c.id === accountId) ?? this.crm.visibleAccount(call.rep, accountId);
    if (!match) return { ok: false, reason: "not_a_candidate" };
    call.accountId = match.id;
    call.accountName = match.name;
    const phrase = `${match.name} in ${match.city}?`;
    this.#remember(call, phrase);
    return { ok: true, account: match, phrase };
  }

  getBriefing(callId, accountId = null) {
    const call = this.#requireIdentified(callId);
    const id = accountId ?? call.accountId;
    const result = this.crm.getBriefing(call.rep, id);
    if (!result.ok) return this.#failure(call, result.reason);
    call.accountId = id;
    call.accountName = result.account.name;
    call.currentBriefing = result;
    this.#setState(call, STATES.BRIEFING);
    this.#event(call, "agent", "briefing", result.account.name);
    this.#remember(call, result.phrase);
    this.#setState(call, STATES.LISTENING);
    return result;
  }

  getDetail(callId, handle) {
    const call = this.#requireIdentified(callId);
    const result = this.crm.getDetail(call.rep, handle);
    if (result.ok) this.#remember(call, result.phrase);
    return result;
  }

  getContactInfo(callId, contactId, field) {
    const call = this.#requireIdentified(callId);
    const result = this.crm.getContactInfo(call.rep, contactId, field);
    if (result.ok) this.#remember(call, result.phrase);
    return result;
  }

  proposeUpdate(callId, accountId, dictation) {
    const call = this.#requireIdentified(callId);
    if (this.#budgetExpired(call)) return this.#expire(call);
    const account = this.crm.visibleAccount(call.rep, accountId ?? call.accountId);
    if (!account) return this.#failure(call, "account_not_visible");
    const proposal = buildProposal({ crm: this.crm, rep: call.rep, account, dictation, allowlist: this.allowlist, picklists: this.picklists });
    proposal.id = randomUUID();
    proposal.callId = call.id;
    proposal.accountId = account.id;
    proposal.accountName = account.name;
    proposal.createdAt = iso(this.now());
    this.proposals.set(proposal.id, proposal);
    call.currentProposalId = proposal.id;
    call.accountId = account.id;
    call.accountName = account.name;
    call.refusedItems.push(...proposal.refused.map((r) => r.field));
    for (const r of proposal.refused) this.#event(call, "agent", "refused_write", `${r.entity}.${r.field}`);
    this.#event(call, "agent", "proposal", proposal.id);
    this.#setState(call, STATES.CONFIRMING);
    this.#remember(call, proposal.readBack);
    return { ok: true, proposalId: proposal.id, readBack: proposal.readBack, refused: proposal.refused, proposal: publicProposal(proposal) };
  }

  amendProposal(callId, proposalId, change) {
    const call = this.#requireIdentified(callId);
    const proposal = this.#proposalFor(call, proposalId);
    const amended = amendProposal(proposal, change, { crm: this.crm, rep: call.rep, allowlist: this.allowlist, picklists: this.picklists });
    this.proposals.set(proposal.id, amended);
    this.#event(call, "agent", "proposal_amended", proposal.id);
    this.#remember(call, amended.readBack);
    return { ok: true, proposalId: proposal.id, readBack: amended.readBack, proposal: publicProposal(amended) };
  }

  commitProposal(callId, proposalId, confirmation) {
    const call = this.#requireIdentified(callId);
    const proposal = this.#proposalFor(call, proposalId);
    if (!isExplicitSave(confirmation)) return { ok: false, reason: "not_confirmed", message: "Please say 'yes, save it' if you want me to write this to CRM." };
    if (!hasWrite(proposal)) return { ok: false, reason: "nothing_to_write" };
    const result = this.crm.applyChangeSet(call.rep, call.id, proposal);
    if (!result.ok) return result;
    call.lastCommitId = result.commitId;
    call.currentProposalId = null;
    this.#event(call, "agent", "commit", result.commitId);
    this.#setState(call, STATES.COMMITTED);
    this.#remember(call, "Saved.");
    this.#setState(call, STATES.LISTENING);
    return { ok: true, commitId: result.commitId, phrase: "Saved." };
  }

  undoLastCommit(callId) {
    const call = this.#requireIdentified(callId);
    if (!call.lastCommitId) return { ok: false, reason: "no_commit" };
    const result = this.crm.revertCommit(call.rep, call.lastCommitId);
    if (result.ok) {
      this.#event(call, "agent", "undo", call.lastCommitId);
      this.#remember(call, "Undone.");
    }
    return result;
  }

  saveDraft(callId, proposalId = null, reason = "caller_requested") {
    const call = this.#requireIdentified(callId);
    const proposal = this.#proposalFor(call, proposalId ?? call.currentProposalId, false);
    if (!proposal) return { ok: false, reason: "no_proposal" };
    const result = this.crm.saveDraft(call.rep, proposal);
    if (result.ok) {
      this.#event(call, "agent", "draft_saved", reason);
      this.#setState(call, STATES.DRAFTING);
      this.#remember(call, `I saved that as a draft for ${result.accountName}.`);
      this.#setState(call, STATES.LISTENING);
    }
    return result;
  }

  resumeDraft(callId) {
    const call = this.#requireIdentified(callId);
    const result = this.crm.resumeDraft(call.rep, call.accountId);
    if (!result.ok) return result;
    const proposal = { ...result.proposal, id: randomUUID() };
    this.proposals.set(proposal.id, proposal);
    call.currentProposalId = proposal.id;
    call.accountId = result.account.id;
    call.accountName = result.account.name;
    this.#event(call, "agent", "draft_resumed", result.draftId);
    this.#remember(call, proposal.readBack);
    return { ok: true, proposalId: proposal.id, readBack: proposal.readBack, account: result.account };
  }

  pause(callId) { const call = this.#requireIdentified(callId); this.#setState(call, STATES.PAUSED); return { ok: true }; }
  continue(callId) { const call = this.#requireIdentified(callId); if (call.state === STATES.PAUSED) this.#setState(call, STATES.LISTENING); return { ok: true }; }
  repeatLast(callId) { const call = this.#require(callId); if (call.lastPhrase) this.#speak(call, call.lastPhrase); return { ok: true, phrase: call.lastPhrase }; }

  dtmf(callId, digit) {
    if (digit === "0") return this.transfer(callId, "dtmf_zero");
    if (digit === "*") return this.repeatLast(callId);
    return { ok: false, reason: "unmapped_digit" };
  }

  noInput(callId) {
    const call = this.#require(callId);
    call.noInputs += 1;
    this.#event(call, "caller", "no_input", call.noInputs);
    if (call.noInputs >= 2) return this.endCall(callId, "two_no_inputs");
    this.#speak(call, "I didn't catch that. Which account?");
    return { ok: true, retry: true };
  }

  checkBudget(callId) {
    const call = this.get(callId);
    if (!call || TERMINAL.has(call.state)) return { ok: true };
    const elapsed = this.now() - (call.answeredAt ?? call.startedAt);
    if (elapsed >= this.options.callTimeBudgetMs) return this.endCall(callId, "call_time_cap");
    if (elapsed >= this.options.wrapUpMs && call.currentProposalId) return this.saveDraft(callId, call.currentProposalId, "wrap_up");
    if (elapsed >= this.options.wrapUpMs && !call.wrapWarned) {
      call.wrapWarned = true;
      this.#speak(call, "We're almost out of time.");
      return { ok: true, warned: true };
    }
    return { ok: true };
  }

  transfer(callId, reason = "caller_requested") {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    this.#setState(call, STATES.TRANSFERRING);
    const context = this.handoffContext(call, reason);
    this.#event(call, "agent", "transfer", reason);
    if (!this.transferCall) {
      this.#setState(call, STATES.TRANSFERRED);
      this.audit.updateCall(call.id, { simulated: true, outcome: `transferred:${reason}` });
      return { ok: true, simulated: true, context };
    }
    return Promise.resolve(this.transferCall(call, { target: this.routing.salesOperations, context })).then(() => {
      this.#setState(call, STATES.TRANSFERRED);
      return { ok: true, context };
    });
  }

  handoffContext(call, reason = "caller_requested") {
    return {
      sessionId: call.sessionId ?? call.id,
      callTopic: clip(`Sales rep – ${call.accountName ?? "CRM assistance"}`, 48),
      callContext: JSON.stringify({ rep: call.rep?.displayName ?? null, account: call.accountName, proposal: this.proposals.get(call.currentProposalId)?.readBack ?? null, draftId: this.crm.latestDraftHint(call.rep ?? {})?.draftId ?? null, refusedRequests: call.refusedItems, reason }),
      routeId: "sales-operations",
      target: this.routing.salesOperations?.displayName,
    };
  }

  endCall(callId, outcome = "agent_ended") {
    const call = this.get(callId);
    if (!call || TERMINAL.has(call.state)) return { ok: true };
    if (call.currentProposalId) this.saveDraft(callId, call.currentProposalId, outcome);
    this.#finish(call, STATES.ENDED, outcome);
    return { ok: true };
  }

  pushTranscript(callId, role, text) {
    const call = this.get(callId);
    if (!call || !text) return;
    call.transcript.push({ role, text, at: this.now() });
    this.audit.recordTranscript(callId, role, text);
    this.#publish(call, "transcript", { role, text });
  }

  recordAgentAction(callId, { tool, ok = true, detail = null }) {
    const call = this.get(callId);
    if (call) this.#event(call, "agent", ok ? "tool" : "tool_rejected", detail ? `${tool}: ${detail}` : tool);
  }

  snapshot(callId) {
    const call = this.get(callId);
    if (!call) return null;
    return {
      id: call.id,
      state: call.state,
      rep: call.rep ? { displayName: call.rep.displayName, verifiedBy: call.verifiedBy } : null,
      account: call.accountId ? { id: call.accountId, name: call.accountName } : null,
      accountCandidates: call.accountCandidates,
      briefing: call.currentBriefing ? { phrase: call.currentBriefing.phrase, handles: call.currentBriefing.handles } : null,
      proposal: call.currentProposalId ? publicProposal(this.proposals.get(call.currentProposalId)) : null,
      lastCommitId: call.lastCommitId,
      lastPhrase: call.lastPhrase,
      failures: call.failures,
      noInputs: call.noInputs,
      elapsedMs: (call.endedAt ?? this.now()) - call.startedAt,
      transcript: call.transcript,
      handoff: call.state === STATES.TRANSFERRING || call.state === STATES.TRANSFERRED ? this.handoffContext(call) : null,
    };
  }

  #proposalFor(call, id, required = true) {
    const proposal = id ? this.proposals.get(id) : null;
    if (!proposal && required) throw new Error(`unknown proposal ${id}`);
    if (proposal && proposal.callId !== call.id) throw new Error("proposal belongs to another call");
    return proposal;
  }
  #require(callId) { const call = this.get(callId); if (!call) throw new Error(`unknown call ${callId}`); return call; }
  #requireIdentified(callId) { const call = this.#require(callId); if (!call.rep) throw new Error("caller is not identified"); return call; }
  #budgetExpired(call) { return call.answeredAt != null && this.now() - call.answeredAt >= this.options.callTimeBudgetMs; }
  #expire(call) { return this.endCall(call.id, "call_time_cap"); }
  #failure(call, reason) { call.failures += 1; this.#event(call, "system", "failure", reason); if (call.failures >= 2) return this.transfer(call.id, "two_failures"); return { ok: false, reason, failures: call.failures }; }
  #remember(call, phrase) { call.lastPhrase = phrase; this.#speak(call, phrase); }
  #speak(call, text) { if (text) { this.pushTranscript(call.id, "agent", text); this.agents.get(call.id)?.instruct?.(text, text); } }
  #event(call, source, kind, detail) { this.audit.recordEvent(call.id, source, kind, detail); this.#publish(call, "event", { source, kind, detail, at: iso(this.now()) }); }
  #publish(call, target, payload) { this.hub?.send?.(call.id, target, payload); }
  #setState(call, state) { if (call.state === state) return; const from = call.state; call.state = state; this.audit.updateCall(call.id, { state }); this.#event(call, "system", "state", `${from} → ${state}`); this.#publish(call, "state", this.snapshot(call.id)); }
  #finish(call, state, outcome) { call.outcome = outcome; call.endedAt = this.now(); this.#setState(call, state); this.audit.updateCall(call.id, { outcome, endedAt: iso(call.endedAt), durationMs: call.endedAt - call.startedAt }); }
}

export function buildProposal({ crm, rep, account, dictation, allowlist, picklists }) {
  const text = String(dictation ?? "");
  const lower = text.toLowerCase();
  const refused = [];
  const addRefused = (entity, field, reason) => refused.push({ entity, field, reason, spoken: "I can't change that by phone. I've left it out." });
  if (/discount|pricing|price cut|percent off/.test(lower)) addRefused("opportunity", "discount", "not_allowlisted");
  if (/reassign|owner|give .* account to|assign .* to/.test(lower)) addRefused("account", "owner", "not_allowlisted");
  if (/delete|remove the account|merge/.test(lower)) addRefused("account", /delete/.test(lower) ? "delete" : "merge", "not_allowlisted");

  const contacts = crm.contacts(account.id);
  const mentionedContacts = contacts.filter((c) => lower.includes(c.name.toLowerCase().split(/\s+/)[0]) || lower.includes(c.name.toLowerCase()));
  const openOpps = crm.opportunities(account.id).filter((o) => o.isOpen);
  const opportunity = matchOpportunity(openOpps, lower);
  const diffs = [];
  if (opportunity) {
    const stage = extractStage(text, picklists.opportunityStage.map((s) => s.value));
    if (stage.invalid) addRefused("opportunity", "stage", "invalid_stage");
    else if (stage.value) addDiff(diffs, "stage", opportunity.stage, stage.value, allowlist, picklists, refused);
    const amount = extractAmount(text);
    if (amount != null) addDiff(diffs, "amount", opportunity.amount, amount, allowlist, picklists, refused);
    const closeDate = extractCloseDate(text);
    if (closeDate) addDiff(diffs, "closeDate", opportunity.closeDate, closeDate, allowlist, picklists, refused);
    const nextStep = /pending signature/i.test(text) ? "Pending signature" : null;
    if (nextStep) addDiff(diffs, "nextStep", opportunity.nextStep, nextStep, allowlist, picklists, refused);
  }
  const activity = /\b(log|meeting|met|call)\b/i.test(text)
    ? { type: lower.includes("call") && !lower.includes("meeting") ? "call" : "meeting", subject: `${account.name} meeting`, notes: clipText(text, 1000), date: todayIso(), contactIds: mentionedContacts.map((c) => c.id) }
    : null;
  const taskMatch = text.match(/remind me to\s+(.+?)(?:\s+(today|tomorrow|friday|monday|tuesday|wednesday|thursday|saturday|sunday|\d{1,2}\/\d{1,2}))?[.!?]?$/i);
  const task = taskMatch ? { subject: clipText(taskMatch[1].replace(/\s+(today|tomorrow|friday|monday|tuesday|wednesday|thursday|saturday|sunday)$/i, ""), 120), dueDate: parseRelativeDate(taskMatch[2] ?? "today"), owner: "me" } : null;
  if (task) validateField("task", "create", "dueDate", task.dueDate, allowlist, picklists, refused);
  const proposal = { activity, opportunityUpdates: opportunity && diffs.length ? [{ id: opportunity.id, name: opportunity.name, diffs }] : [], task, refused };
  proposal.readBack = readBack(account, proposal, crm, rep);
  return proposal;
}

function addDiff(diffs, field, before, after, allowlist, picklists, refused) {
  if (String(before) === String(after)) return;
  const problem = validateField("opportunity", "update", field, after, allowlist, picklists, refused);
  if (!problem) diffs.push({ field, before, after });
}

function validateField(entity, operation, field, value, allowlist, picklists, refused) {
  const rule = allowlist?.[entity]?.[operation]?.[field];
  if (!rule) { refused.push({ entity, field, reason: "not_allowlisted" }); return "not_allowlisted"; }
  if (rule.type === "picklist" && !picklists[rule.picklist]?.some((p) => p.value.toLowerCase() === String(value).toLowerCase())) { refused.push({ entity, field, reason: "invalid_picklist" }); return "invalid_picklist"; }
  if (rule.type === "currency" && (Number(value) < rule.min || Number(value) > rule.max)) { refused.push({ entity, field, reason: "out_of_bounds" }); return "out_of_bounds"; }
  if (rule.type === "date") {
    if (rule.notBefore === "today" && value < todayIso()) { refused.push({ entity, field, reason: "date_in_past" }); return "date_in_past"; }
    if (rule.withinDays && daysBetween(todayIso(), value) > rule.withinDays) { refused.push({ entity, field, reason: "date_too_far" }); return "date_too_far"; }
  }
  return null;
}

function amendProposal(proposal, change, ctx) {
  const copy = JSON.parse(JSON.stringify(proposal));
  const lower = String(change ?? "").toLowerCase();
  const update = copy.opportunityUpdates?.[0];
  if (update) {
    const stage = extractStage(change, ctx.picklists.opportunityStage.map((s) => s.value));
    if (stage.value) replaceDiff(update, "stage", stage.value);
    const amount = extractAmount(change);
    if (amount != null) replaceDiff(update, "amount", amount);
    const date = extractCloseDate(change);
    if (date) replaceDiff(update, "closeDate", date);
    update.diffs = update.diffs.filter((d) => String(d.before) !== String(d.after));
    if (!update.diffs.length) copy.opportunityUpdates = [];
  }
  if (/no task|don't remind|do not remind/.test(lower)) copy.task = null;
  copy.readBack = readBack({ id: copy.accountId, name: copy.accountName }, copy, ctx.crm, ctx.rep, "Updated: ");
  return copy;
}
function replaceDiff(update, field, after) { const d = update.diffs.find((x) => x.field === field); if (d) d.after = after; }
function readBack(account, proposal, crm, _rep, prefix = "Here's what I have: ") {
  const parts = [];
  if (proposal.activity) parts.push(`a ${proposal.activity.type} activity${proposal.activity.contactIds?.length ? " with " + proposal.activity.contactIds.map((id) => crm.contacts(account.id).find((c) => c.id === id)?.name).filter(Boolean).join(" and ") : ""}, today`);
  for (const u of proposal.opportunityUpdates ?? []) {
    const changes = u.diffs.map((d) => `${labelField(d.field)} from ${spokenValue(d.before, d.field)} to ${spokenValue(d.after, d.field)}`).join(", ");
    parts.push(`${u.name} goes ${changes}`);
  }
  if (proposal.task) parts.push(`a task for you, ${proposal.task.subject}, due ${spokenDate(proposal.task.dueDate)}`);
  if (!parts.length) parts.push("no allowed CRM changes");
  const refused = proposal.refused?.length ? ` ${proposal.refused[0].spoken}` : "";
  return `${prefix}${parts.join(". ")}. Save it?${refused}`;
}
function publicProposal(p) { return p && { id: p.id, accountId: p.accountId, accountName: p.accountName, activity: p.activity, opportunityUpdates: p.opportunityUpdates, task: p.task, refused: p.refused, readBack: p.readBack }; }
function hasWrite(p) { return Boolean(p.activity || p.task || p.opportunityUpdates?.some((u) => u.diffs.length)); }
export function isExplicitSave(text) { const t = String(text ?? "").toLowerCase(); return /\byes[, ]+save it\b|\byes[, ]+please save\b|\bgo ahead and save\b|\bsave it\b/.test(t) && !/\bmaybe\b|\bi think\b|\bnot\b/.test(t); }
function matchOpportunity(opps, lower) { return opps.map((o) => ({ o, score: [o.name, ...(o.aliases ?? [])].some((n) => lower.includes(n.toLowerCase())) ? 5 : o.aliases.some((a) => lower.includes(a.toLowerCase().split(/\s+/)[0])) ? 3 : 0 })).filter((x) => x.score).sort((a, b) => b.score - a.score || b.o.amount - a.o.amount)[0]?.o ?? null; }
function extractStage(text, allowed) { const lower = String(text).toLowerCase(); for (const s of allowed) if (lower.includes(s.toLowerCase())) return { value: s }; if (/\bclosed\s+(?!won|lost)\w+/.test(lower)) return { invalid: true }; const m = lower.match(/(?:move|moving|stage|keep it in|to)\s+(?:to\s+)?([a-z ]+?)(?: pending|,|\.| close|$)/); if (m && /closed|proposal|negotiation|happy|won|lost/i.test(m[1])) return { invalid: true, value: m[1].trim() }; return {}; }
function extractAmount(text) { const m = String(text).match(/(?:at|amount|for)\s+\$?([0-9]+(?:\.[0-9]+)?)\s*(k|thousand|m|million)?\b/i); if (!m) return null; const n = Number(m[1]); return /m|million/i.test(m[2] ?? "") ? n * 1_000_000 : /k|thousand/i.test(m[2] ?? "") ? n * 1000 : n; }
function extractCloseDate(text) { const m = String(text).match(/close date\s+([A-Za-z]+\s+\d{1,2}|\d{1,2}\/\d{1,2})/i); return m ? parseRelativeDate(m[1]) : null; }
function parseRelativeDate(value) { const base = nowDate(); const lower = String(value ?? "today").toLowerCase(); if (lower === "today") return todayIso(); if (lower === "tomorrow") { const d = new Date(base); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); } const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]; const idx = weekdays.indexOf(lower); if (idx >= 0) { const d = new Date(base); const delta = (idx - d.getDay() + 7) % 7 || 7; d.setDate(d.getDate() + delta); return d.toISOString().slice(0, 10); } const md = lower.match(/^([a-z]+)\s+(\d{1,2})$/i); if (md) { const year = base.getFullYear(); const d = new Date(`${md[1]} ${md[2]}, ${year} 12:00:00`); return d.toISOString().slice(0, 10); } const slash = lower.match(/^(\d{1,2})\/(\d{1,2})$/); if (slash) return `${base.getFullYear()}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`; return todayIso(); }
function daysBetween(a, b) { return Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000); }
function labelField(f) { return ({ closeDate: "close date", nextStep: "next step" }[f] ?? f); }
function spokenValue(v, f) { return f === "amount" ? money(Number(v)) : f === "closeDate" ? spokenDate(v) : String(v); }
function money(n) { return n >= 1000 ? `${Math.round(n / 1000)} thousand` : String(n); }
function spokenDate(iso) { return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric" }); }
function clipText(v, limit) { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return s.length <= limit ? s : s.slice(0, limit); }
function clip(v, limit) { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return s.length <= limit ? s : `${s.slice(0, limit - 1).trimEnd()}…`; }
function iso(ms) { return new Date(ms).toISOString(); }
