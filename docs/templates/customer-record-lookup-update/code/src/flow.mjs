/**
 * The call policy for Customer Record Lookup & Update. Everything that decides
 * what a caller may hear or change runs here, on the server: identity before
 * any record is opened, records scoped to the rep, contact details only on
 * request, writes only from an allow-list after an explicit "yes, save it",
 * and an undo window before a confirmed write commits. The model reaches the
 * CRM only through these methods. Standard library only: the tests need no
 * Azure, no network and no database.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { config, resolvePath } from "./config.mjs";
import { daysBetween, joinEnglish, normalise, parseRelativeDate, phoneFromText, phoneTail, shortDate, spokenDate, spokenPhone, todayIn } from "./crm-shared.mjs";

export const STATES = Object.freeze({
  RINGING: "ringing",
  IDENTIFYING: "identifying",
  REFUSED: "refused",
  GREETING: "greeting",
  LISTENING: "listening",
  BRIEFING: "briefing",
  PROPOSING: "proposing",
  CONFIRMING: "confirming",
  COMMITTING: "committing",
  COMMITTED: "committed",
  PAUSED: "paused",
  TRANSFERRING: "transferring",
  TRANSFERRED: "transferred",
  DRAFTING: "drafting",
  CLOSING: "closing",
  ENDED: "ended",
});

const TERMINAL = new Set([STATES.REFUSED, STATES.TRANSFERRED, STATES.ENDED]);
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const FIELD_NAMES = { stage: "stage", amount: "amount", closeDate: "close date", nextStep: "next step", dueDate: "due date", phone: "phone number", email: "email" };
const SAFETY_REASONS = new Set(["verification_failed", "two_failures"]);

/** Requests the agent never writes, whatever the model makes of them. Sales Operations owns them. */
const POLICY_REFUSALS = [
  { entity: "opportunity", field: "discount", label: "the discount", pattern: /\bdiscount|\bpricing\b|\bprice cut\b|\bpercent off\b/ },
  { entity: "account", field: "owner", label: "the account owner", pattern: /\breassign|\bowner\b|\bgive .* account to\b|\bassign .* to\b/ },
  { entity: "account", field: "delete", label: "deleting an account", pattern: /\bdelete\b|\bremove the account\b/ },
  { entity: "account", field: "merge", label: "merging accounts", pattern: /\bmerge\b/ },
  { entity: "account", field: "creditLimit", label: "the credit limit", pattern: /\bcredit (?:limit|line)\b/ },
  { entity: "account", field: "paymentTerms", label: "the payment terms", pattern: /\bnet[ -]?\d{2}\b|\b(?:payment|billing|invoice) terms\b/ },
];

export class CustomerRecordFlow {
  constructor({ crm, reps, audit, transfer = null, hub = null, now = () => Date.now(), timeZone = config.timeZone, options = {} }) {
    this.crm = crm;
    this.reps = reps;
    this.audit = audit;
    this.transferCall = transfer;
    this.hub = hub;
    this.now = now;
    this.timeZone = timeZone;
    this.options = {
      callTimeBudgetMs: config.callTimeBudgetMs,
      wrapUpMs: config.wrapUpMs,
      persistTranscripts: config.persistTranscripts,
      commitUndoMs: config.commitUndoMs,
      picklistsPath: config.crm.picklistsPath,
      writableFieldsPath: config.crm.writableFieldsPath,
      routingPath: config.crm.routingPath,
      pinLength: 6,
      ...options,
    };
    const load = (path) => JSON.parse(readFileSync(resolvePath(path), "utf8"));
    this.picklists = load(this.options.picklistsPath);
    this.allowlist = load(this.options.writableFieldsPath);
    this.routing = load(this.options.routingPath);
    this.calls = new Map();
    this.agents = new Map();
    this.proposals = new Map();
  }

  /** The calendar day the policy runs on (the demo clock in simulation). */
  today() {
    return todayIn(this.now(), this.timeZone);
  }

  get(callId) {
    return this.calls.get(callId) ?? null;
  }

  registerAgent(callId, agent) {
    this.agents.set(callId, agent);
  }

  unregisterAgent(callId) {
    this.agents.delete(callId);
  }

  setCallConnection(callId, callConnectionId) {
    const call = this.get(callId);
    if (call) call.callConnectionId = callConnectionId;
  }

  // ------------------------------------------------------------ call setup

  create({ callId = randomUUID(), fromPhone = null, teamsUserId = null, incomingCallContext = null, sessionId = null, resourceAccountId = null, simulated = false, arrival = null } = {}) {
    const call = {
      id: callId,
      fromPhone,
      teamsUserId,
      incomingCallContext,
      sessionId: sessionId ?? callId,
      resourceAccountId,
      arrival: arrival ?? (resourceAccountId ? "teams-phone-extensibility" : "acs-direct"),
      callConnectionId: null,
      simulated,
      state: STATES.RINGING,
      rep: null,
      pendingPstnRep: null,
      claimedRepName: null,
      pinDigits: "",
      pinFailed: false,
      callerIdMatched: false,
      verifiedBy: null,
      accountId: null,
      accountName: null,
      accountRelationship: null,
      accountCandidates: [],
      currentBriefing: null,
      currentProposalId: null,
      pendingCommit: null,
      lastCommitId: null,
      lastWrite: null,
      lastRefusal: null,
      offeredHandoff: null,
      handoff: null,
      disclosed: new Map(),
      record: null,
      recordContactId: null,
      lastPhrase: null,
      failures: 0,
      noInputs: 0,
      refusedItems: [],
      wrapWarned: false,
      inflight: null,
      startedAt: this.now(),
      answeredAt: null,
      endedAt: null,
      outcome: null,
      transcript: [],
    };
    this.calls.set(call.id, call);
    this.audit.startCall({ id: call.id, state: call.state, startedAt: iso(call.startedAt), callerVerified: false, arrival: call.arrival, simulated: call.simulated });
    this.#event(call, "system", "call_created", call.arrival);
    return call;
  }

  /** Identity comes first: a Teams sign-in, or a registered mobile plus PIN. Nobody else gets in. */
  answer(callId) {
    const call = this.#require(callId);
    if (call.state !== STATES.RINGING) return { ok: false, reason: "already_answered" };
    call.answeredAt = this.now();
    this.#setState(call, STATES.IDENTIFYING);
    const teamsRep = call.teamsUserId ? this.reps.resolveTeamsUser(call.teamsUserId) : null;
    if (teamsRep) return this.#identify(call, teamsRep);
    const pstn = call.fromPhone ? this.reps.beginPstn(call.fromPhone) : null;
    if (pstn) {
      call.pendingPstnRep = pstn;
      call.claimedRepName = pstn.displayName;
      call.callerIdMatched = true;
      this.#event(call, "caller", "pin_requested", `number ending ${phoneTail(call.fromPhone)}`);
      this.#remember(call, `This is the Contoso sales assistant, an automated agent. ${this.#pinPrompt()}`);
      this.#touch(call);
      return { ok: true, needsPin: true };
    }
    return this.refuse(callId, "unknown_caller");
  }

  startSimulation({ repId = "rep-alex", fromPhone = null, callId = randomUUID() } = {}) {
    const rep = this.reps.reps.find((r) => r.id === repId);
    const call = this.create({ callId, fromPhone, teamsUserId: fromPhone ? null : rep?.teamsUserId ?? null, simulated: true, arrival: "simulation" });
    this.answer(call.id);
    return this.get(call.id);
  }

  /** Keypad. While a PIN is pending, digits collect (never logged); otherwise 0 is a person and * repeats. */
  dtmf(callId, digit) {
    const call = this.#require(callId);
    const key = String(digit ?? "").trim();
    if (call.state === STATES.IDENTIFYING && call.pendingPstnRep) {
      if (/^\d$/.test(key)) {
        call.pinDigits += key;
        if (call.pinDigits.length >= this.options.pinLength) return this.submitPin(callId, call.pinDigits);
        this.#touch(call);
        return { ok: true, collecting: true, digits: call.pinDigits.length };
      }
      if (key === "#") return call.pinDigits ? this.submitPin(callId, call.pinDigits) : { ok: false, reason: "no_digits" };
      if (key === "*") {
        call.pinDigits = "";
        this.#remember(call, `Let's start again. ${this.#pinPrompt()}`);
        this.#touch(call);
        return { ok: true, cleared: true };
      }
      return { ok: false, reason: "unmapped_digit" };
    }
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    if (key === "0") return this.transfer(callId, "dtmf_zero");
    if (key === "*") return this.repeatLast(callId);
    return { ok: false, reason: "unmapped_digit" };
  }

  submitPin(callId, pin) {
    const call = this.#require(callId);
    if (!call.pendingPstnRep) return { ok: false, reason: "no_pin_pending" };
    const digits = String(pin ?? "").replace(/\D/g, "");
    call.pinDigits = "";
    const rep = this.reps.verifyPin(call.pendingPstnRep.repId, digits);
    if (!rep) return this.#verificationFailed(call, "wrong_pin");
    return this.#identify(call, rep);
  }

  refuse(callId, reason = "unknown_caller") {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    this.#event(call, "caller", "refused_caller", reason);
    this.#remember(call, "This is the Contoso sales assistant, an automated agent. This line is for Contoso sales staff, so I can't help with this call. Goodbye.");
    this.#finish(call, STATES.REFUSED, reason);
    return { ok: false, reason };
  }

  /** A wrong PIN opens nothing and reads nothing out: the caller goes to a person, with a safe context. */
  #verificationFailed(call, reason) {
    call.pinFailed = true;
    call.pendingPstnRep = null;
    call.pinDigits = "";
    this.#event(call, "caller", "verification_failed", reason === "wrong_pin" ? "wrong PIN · no records opened" : reason);
    this.audit.updateCall(call.id, { callerVerified: false });
    this.#remember(call, `I couldn't verify you, so I can't open any records. I'll put you through to ${this.#targetName()}.`);
    const done = (r) => ({ ...r, ok: false, reason, transferred: Boolean(r?.ok) });
    const result = this.transfer(call.id, "verification_failed");
    return isPromise(result) ? result.then(done) : done(result);
  }

  #identify(call, rep) {
    call.rep = rep;
    call.verifiedBy = rep.verifiedBy;
    call.pendingPstnRep = null;
    call.pinDigits = "";
    this.audit.updateCall(call.id, { repName: rep.displayName, callerVerified: true, verifiedBy: rep.verifiedBy });
    this.#event(call, "caller", "verified", rep.verifiedBy === "pstn-pin" ? "mobile + PIN" : "Teams sign-in");
    this.#setState(call, STATES.GREETING);
    const draft = this.crm.latestDraftHint?.(rep) ?? null;
    const intro = rep.verifiedBy === "pstn-pin" ? `Thanks, ${rep.firstName}, you're verified.` : `Hi ${rep.firstName}, I'm the Contoso sales assistant, an automated agent.`;
    const draftLine = draft ? `You have an unsaved update for ${draft.accountName}. Say 'resume my draft' to pick it up.` : "";
    this.#remember(call, [intro, draftLine, "Which account?"].filter(Boolean).join(" "));
    this.#setState(call, STATES.LISTENING);
    return { ok: true, rep: { id: rep.id, displayName: rep.displayName, verifiedBy: rep.verifiedBy }, draft: draft ? { accountName: draft.accountName } : null };
  }

  // -------------------------------------------------------------- accounts

  findAccount(callId, utterance) {
    const call = this.#requireIdentified(callId);
    if (this.#overBudget(call)) return this.endCall(callId, "call_time_cap");
    const result = this.crm.findAccounts(call.rep, utterance);
    call.accountCandidates = result.candidates ?? [];
    this.#event(call, "agent", "find_account", result.status.replace("_", " "));
    if (result.status === "confirmed") {
      this.#selectAccount(call, result.account);
      this.#refreshRecord(call);
      this.#remember(call, result.phrase);
      this.#touch(call);
      return { ok: true, ...result };
    }
    if (result.status === "no_match") {
      const failed = this.#failure(call, "account_no_match", "I couldn't find an account by that name on your list. Could you spell it?");
      if (isPromise(failed) || failed.ok !== false) return failed;
      return { ...result, ...failed };
    }
    const n = result.candidates.length;
    this.#remember(call, `I found ${NUMBER_WORDS[n] ?? n}: ${result.phrase}. Which one?`);
    this.#touch(call);
    return { ok: true, ...result };
  }

  selectAccount(callId, accountId) {
    const call = this.#requireIdentified(callId);
    const account = this.crm.visibleAccount(call.rep, accountId);
    if (!account) return { ok: false, reason: "not_a_candidate" };
    this.#selectAccount(call, account);
    this.#refreshRecord(call);
    const phrase = `${account.name} in ${account.city}?`;
    this.#remember(call, phrase);
    this.#touch(call);
    return { ok: true, account: { id: account.id, name: account.name, city: account.city }, phrase };
  }

  #selectAccount(call, account) {
    if (call.accountId !== account.id) {
      call.currentBriefing = null;
      call.record = null;
      call.recordContactId = null;
    }
    call.accountId = account.id;
    call.accountName = account.name;
    call.accountRelationship = account.ownerId === call.rep?.ownerId ? "own" : "team";
    call.accountCandidates = [];
  }

  // --------------------------------------------------------------- lookups

  /** The fixed-order briefing. Contact details stay masked until asked for. */
  getBriefing(callId, accountId = null) {
    const call = this.#requireIdentified(callId);
    if (this.#overBudget(call)) return this.endCall(callId, "call_time_cap");
    const id = accountId ?? call.accountId;
    if (!id) {
      this.#remember(call, "Which account?");
      this.#touch(call);
      return { ok: false, reason: "no_account", phrase: "Which account?" };
    }
    const result = this.crm.getBriefing(call.rep, id);
    if (!result.ok) return this.#failure(call, result.reason, "I can't open that account.");
    this.#selectAccount(call, result.account);
    call.currentBriefing = { phrase: result.phrase, handles: result.handles };
    this.#event(call, "agent", "briefing", result.account.name);
    this.#refreshRecord(call);
    if (call.pendingCommit) this.#touch(call);
    else this.#enter(call, STATES.BRIEFING);
    this.#remember(call, result.phrase);
    return result;
  }

  getDetail(callId, handle) {
    const call = this.#requireIdentified(callId);
    const result = this.crm.getDetail(call.rep, handle);
    if (!result.ok) return this.#failure(call, result.reason, "I can't find that one.");
    this.#event(call, "agent", "lookup", result.opportunity?.name ?? result.contact?.name ?? result.task?.subject ?? "record");
    if (result.contact) {
      call.recordContactId = result.contact.id;
      this.#refreshRecord(call);
    }
    this.#remember(call, result.phrase);
    this.#touch(call);
    return result;
  }

  /** A phone number or email is read out only when the rep asks for it, and the card shows only what was read out. */
  getContactInfo(callId, contactId, field) {
    const call = this.#requireIdentified(callId);
    const result = this.crm.getContactInfo(call.rep, contactId, field);
    if (!result.ok) return this.#failure(call, result.reason, "I can't share that one.");
    const contact = this.crm.getContact(call.rep, contactId);
    if (contact.accountId !== call.accountId) {
      const account = this.crm.visibleAccount(call.rep, contact.accountId);
      if (account) this.#selectAccount(call, account);
    }
    const label = `${contact.name} · ${field === "phone" ? "number" : "email"}`;
    call.disclosed.set(`${contactId}:${field}`, label);
    call.recordContactId = contactId;
    this.#event(call, "agent", "contact_lookup", label);
    this.#refreshRecord(call);
    this.#remember(call, result.phrase);
    this.#touch(call);
    return result;
  }

  // ------------------------------------------------------------- proposals

  /** Dictation → an allow-listed change set and a read-back. Nothing is written here. */
  proposeUpdate(callId, accountId, dictation) {
    const call = this.#requireIdentified(callId);
    if (call.pendingCommit) return this.holdForWindow(callId);
    if (this.#overBudget(call)) return this.endCall(callId, "call_time_cap");
    const account = this.crm.visibleAccount(call.rep, accountId ?? call.accountId);
    if (!account) return this.#failure(call, "account_not_visible", "Which account is this for?");
    this.#selectAccount(call, account);
    this.#enter(call, STATES.PROPOSING);
    call.offeredHandoff = null;
    const today = this.today();
    const built = buildProposal({ crm: this.crm, rep: call.rep, account, dictation, allowlist: this.allowlist, picklists: this.picklists, today });
    for (const r of built.refused) this.#event(call, "agent", "refused_write", `${r.entity}.${r.field}`);
    const policy = built.refused.filter((r) => r.reason === "not_allowlisted");
    const labels = unique(policy.map((r) => r.label));
    if (policy.length) {
      call.refusedItems.push(...labels);
      this.#event(call, "agent", "policy_refusal", joinEnglish(labels));
    }
    if (!hasWrite(built)) {
      const reason = policy.length ? "refused_by_policy" : built.refused.length ? "nothing_allowed" : "nothing_to_write";
      call.lastRefusal = built.refused.length ? { reason, at: iso(this.now()), items: built.refused.map(refusalItem) } : null;
      let phrase;
      if (policy.length) {
        const other = leftOutPhrase(built.refused.filter((r) => r.reason !== "not_allowlisted"));
        const many = labels.length > 1;
        phrase = `${capitalise(joinEnglish(labels))} ${many ? "aren't" : "isn't"} on the list of things I can change by phone, so nothing was written.${other ? ` ${other}` : ""} ${this.#targetName()} can change ${many ? "them" : "it"}. Want me to put you through with the details?`;
        call.offeredHandoff = { reason: "refused_by_policy", fields: unique(policy.map((r) => r.field)), labels, request: redact(dictation) };
      } else {
        phrase = `${leftOutPhrase(built.refused) || "I didn't hear a change I can make."} Nothing was written.`;
      }
      this.#refreshRecord(call);
      this.#remember(call, phrase);
      this.#rest(call);
      return { ok: false, reason, refused: built.refused, phrase, offeredHandoff: Boolean(call.offeredHandoff) };
    }
    const proposal = { ...built, id: randomUUID(), callId: call.id, accountId: account.id, accountName: account.name, createdAt: iso(this.now()) };
    proposal.rows = writeRows(proposal);
    if (call.currentProposalId) this.proposals.delete(call.currentProposalId);
    this.proposals.set(proposal.id, proposal);
    call.currentProposalId = proposal.id;
    if (proposal.contactUpdates[0]) call.recordContactId = proposal.contactUpdates[0].id;
    call.lastRefusal = built.refused.length ? { reason: "partly_refused", at: iso(this.now()), items: built.refused.map(refusalItem) } : null;
    this.#event(call, "agent", "proposal", plural(proposal.rows.length, "change"));
    this.#refreshRecord(call);
    this.#enter(call, STATES.CONFIRMING);
    this.#remember(call, proposal.readBack);
    return { ok: true, proposalId: proposal.id, readBack: proposal.readBack, refused: built.refused, proposal: publicProposal(proposal) };
  }

  /** "Actually keep it in Negotiation": rebuild the change set before anything is written. */
  amendProposal(callId, proposalId, change) {
    const call = this.#requireIdentified(callId);
    if (call.pendingCommit) return this.holdForWindow(callId);
    const proposal = this.#proposalFor(call, proposalId);
    if (!proposal) return { ok: false, reason: "no_proposal", phrase: "There's nothing waiting to change." };
    const ctx = { crm: this.crm, rep: call.rep, allowlist: this.allowlist, picklists: this.picklists, today: this.today(), refused: [] };
    const { next, changed } = amendChangeSet(proposal, change, ctx);
    for (const r of ctx.refused) this.#event(call, "agent", "refused_write", `${r.entity}.${r.field}`);
    if (!changed && !ctx.refused.length) {
      const phrase = 'I didn\'t catch what to change. Say the new value, or "yes, save it".';
      this.#remember(call, phrase);
      this.#touch(call);
      return { ok: false, reason: "no_change", phrase };
    }
    if (!hasWrite(next)) {
      this.proposals.delete(proposal.id);
      if (call.currentProposalId === proposal.id) call.currentProposalId = null;
      this.#event(call, "agent", "proposal_amended", "nothing left");
      this.#refreshRecord(call);
      this.#remember(call, "Nothing left to save.");
      this.#rest(call);
      return { ok: true, proposal: null, readBack: "Nothing left to save." };
    }
    next.refused = [...(proposal.refused ?? []), ...ctx.refused];
    next.readBack = readBack(next, { opening: "Updated.", refused: ctx.refused, today: ctx.today });
    next.rows = writeRows(next);
    this.proposals.set(next.id, next);
    call.currentProposalId = next.id;
    if (next.contactUpdates[0]) call.recordContactId = next.contactUpdates[0].id;
    this.#event(call, "agent", "proposal_amended", plural(next.rows.length, "change"));
    this.#refreshRecord(call);
    this.#enter(call, STATES.CONFIRMING);
    this.#remember(call, next.readBack);
    return { ok: true, proposalId: next.id, readBack: next.readBack, refused: ctx.refused, proposal: publicProposal(next) };
  }

  #proposalFor(call, proposalId) {
    const proposal = (proposalId && this.proposals.get(proposalId)) || (call.currentProposalId && this.proposals.get(call.currentProposalId)) || null;
    return proposal && proposal.callId === call.id ? proposal : null;
  }

  // ------------------------------------------------- commit and undo window

  /**
   * "Yes, save it" opens the undo window; the write commits when it closes.
   * A mind change inside the window cancels it and nothing is written. The
   * window length is server policy (COMMIT_UNDO_MS); the console only shows it.
   */
  commitProposal(callId, proposalId, confirmation) {
    const call = this.#requireIdentified(callId);
    if (call.pendingCommit) return this.holdForWindow(callId);
    const proposal = this.#proposalFor(call, proposalId);
    if (!proposal) {
      const phrase = "There's nothing waiting to be saved.";
      this.#remember(call, phrase);
      this.#touch(call);
      return { ok: false, reason: "no_proposal", phrase };
    }
    if (!isExplicitSave(confirmation)) {
      const phrase = `Say "yes, save it" if you want me to write this to ${possessive(proposal.accountName)} record.`;
      this.#remember(call, phrase);
      this.#touch(call);
      return { ok: false, reason: "not_confirmed", message: phrase, phrase };
    }
    if (!hasWrite(proposal)) return { ok: false, reason: "nothing_to_write" };
    const windowMs = Math.max(0, Number(this.options.commitUndoMs) || 0);
    if (!windowMs) return this.#applyCommit(call, proposal);
    const startedAt = this.now();
    call.pendingCommit = {
      proposalId: proposal.id,
      startedAt,
      commitsAt: startedAt + windowMs,
      windowMs,
      startedPerf: performance.now(),
      timer: setTimeout(() => this.#closeWindow(call.id), windowMs),
      waiters: [],
    };
    this.#event(call, "agent", "commit_pending", `${Math.round(windowMs / 100) / 10}s undo window`);
    const phrase = `Saving in ${spokenSeconds(windowMs)}. Say "wait" to stop it.`;
    this.#enter(call, STATES.COMMITTING);
    this.#remember(call, phrase);
    return { ok: true, pending: true, proposalId: proposal.id, commitsAt: iso(startedAt + windowMs), windowMs, phrase };
  }

  /** The window closed without a mind change: write it. A hang-up or transfer closes it early, and the confirmed write still lands. */
  #closeWindow(callId, { quiet = false } = {}) {
    const call = this.get(callId);
    const pending = call?.pendingCommit;
    if (!pending) return null;
    clearTimeout(pending.timer);
    call.pendingCommit = null;
    const proposal = this.proposals.get(pending.proposalId);
    const silent = quiet || TERMINAL.has(call.state) || call.state === STATES.TRANSFERRING;
    let result;
    try {
      result = proposal ? this.#applyCommit(call, proposal, { quiet: silent }) : { ok: false, reason: "no_proposal" };
    } catch (error) {
      result = { ok: false, reason: "commit_failed", error: error.message };
    }
    if (!result.ok) {
      this.#event(call, "system", "commit_failed", result.reason);
      if (!silent) {
        this.#remember(call, "I couldn't save that. Nothing was written.");
        this.#rest(call);
      }
    }
    for (const resolve of pending.waiters) resolve({ ...result, settled: result.ok ? "committed" : "failed" });
    return result;
  }

  #applyCommit(call, proposal, { quiet = false } = {}) {
    const result = this.crm.applyChangeSet(call.rep, call.id, proposal);
    if (!result.ok) return result;
    const auditRows = this.crm.auditRows(result.commitId).length;
    call.lastCommitId = result.commitId;
    if (call.currentProposalId === proposal.id) call.currentProposalId = null;
    this.proposals.delete(proposal.id);
    const auditId = result.commitId.slice(0, 8);
    call.lastWrite = { commitId: result.commitId, status: "committed", accountName: proposal.accountName, rows: proposal.rows, auditRows, auditId, at: iso(this.now()) };
    this.#event(call, "agent", "commit", `${plural(auditRows, "audit row")} · ${auditId}`);
    this.#refreshRecord(call);
    const phrase = `Saved to ${possessive(proposal.accountName)} record.`;
    if (quiet) this.#touch(call);
    else {
      this.#enter(call, STATES.COMMITTED);
      this.#remember(call, phrase);
    }
    return { ok: true, commitId: result.commitId, auditRows, phrase };
  }

  /** A mind change inside the undo window: the timer is cleared and nothing is written. */
  cancelPendingCommit(callId, reason = "caller_changed_mind") {
    const call = this.#requireIdentified(callId);
    const pending = call.pendingCommit;
    if (!pending) {
      if (call.lastWrite?.status !== "committed") return { ok: false, reason: "nothing_pending" };
      const phrase = `That's already saved. Say "undo that" and I'll take it back.`;
      this.#remember(call, phrase);
      this.#touch(call);
      return { ok: false, reason: "already_committed", phrase };
    }
    const remainingMs = this.#remaining(call);
    clearTimeout(pending.timer);
    call.pendingCommit = null;
    const proposal = this.proposals.get(pending.proposalId) ?? null;
    this.proposals.delete(pending.proposalId);
    if (call.currentProposalId === pending.proposalId) call.currentProposalId = null;
    const accountName = proposal?.accountName ?? call.accountName;
    call.lastWrite = { commitId: null, status: "cancelled", accountName, rows: proposal?.rows ?? [], auditRows: 0, reason, remainingMs, at: iso(this.now()) };
    this.#event(call, "caller", "commit_cancelled", `${(remainingMs / 1000).toFixed(1)}s left · nothing written`);
    this.#refreshRecord(call);
    const phoneDiff = onlyPhoneChange(proposal);
    const phrase = phoneDiff
      ? `Stopped. Nothing was written: ${possessive(phoneDiff.name)} number is still the one ending ${phoneTail(phoneDiff.before)}.`
      : `Stopped. Nothing was written to ${possessive(accountName)} record.`;
    this.#remember(call, phrase);
    this.#rest(call);
    for (const resolve of pending.waiters) resolve({ ok: true, settled: "cancelled" });
    return { ok: true, cancelled: true, wrote: false, remainingMs, phrase };
  }

  /** While a confirmed write waits out its window, other writes wait too. */
  holdForWindow(callId) {
    const call = this.#require(callId);
    if (!call.pendingCommit) return { ok: false, reason: "nothing_pending" };
    const phrase = `One moment, I'm saving the last change. Say "wait" to stop it.`;
    this.#speak(call, phrase);
    this.#touch(call);
    return { ok: false, reason: "commit_pending", remainingMs: this.#remaining(call), phrase };
  }

  /** Resolves when the call's undo window closes, whichever way it closes. */
  afterUndoWindow(callId) {
    const pending = this.get(callId)?.pendingCommit;
    if (!pending) return Promise.resolve({ settled: "none" });
    return new Promise((resolve) => pending.waiters.push(resolve));
  }

  /** Waits, bounded, for every open undo window and in-flight transfer, so a reset never cuts one off. */
  async settleAll(boundMs = 15000) {
    const work = [];
    for (const call of this.calls.values()) {
      if (call.pendingCommit) work.push(this.afterUndoWindow(call.id));
      if (call.inflight) work.push(call.inflight);
    }
    if (!work.length) return { ok: true, waited: 0 };
    let timer;
    const bound = new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), boundMs);
    });
    const outcome = await Promise.race([Promise.allSettled(work).then(() => "settled"), bound]);
    clearTimeout(timer);
    return { ok: outcome === "settled", waited: work.length, outcome };
  }

  async settled(callId) {
    const call = this.get(callId);
    if (call?.inflight) await call.inflight.catch(() => {});
    return this.snapshot(callId);
  }

  /** Demo reset: open windows close without writing, and every call is forgotten. */
  reset() {
    for (const call of this.calls.values()) {
      const pending = call.pendingCommit;
      if (!pending) continue;
      clearTimeout(pending.timer);
      call.pendingCommit = null;
      for (const resolve of pending.waiters) resolve({ ok: true, settled: "reset" });
    }
    this.calls.clear();
    this.proposals.clear();
    this.agents.clear();
  }

  /** The demo clock jumped: shift stored times so elapsed times and windows stay intact. */
  rebaseClock(deltaMs) {
    if (!deltaMs) return;
    for (const call of this.calls.values()) {
      for (const key of ["startedAt", "answeredAt", "endedAt"]) if (call[key] != null) call[key] += deltaMs;
      if (call.pendingCommit) {
        call.pendingCommit.startedAt += deltaMs;
        call.pendingCommit.commitsAt += deltaMs;
      }
      for (const turn of call.transcript) turn.at += deltaMs;
    }
  }

  undoLastCommit(callId) {
    const call = this.#requireIdentified(callId);
    if (call.pendingCommit) return this.cancelPendingCommit(callId, "undo_in_window");
    const say = (reason, phrase, extra = {}) => {
      this.#remember(call, phrase);
      this.#touch(call);
      return { ok: false, reason, phrase, ...extra };
    };
    if (call.lastWrite?.status === "undone") return say("already_reverted", "That's already undone.");
    if (!call.lastCommitId || call.lastWrite?.status !== "committed") return say("nothing_to_undo", "There's nothing from this call to undo.");
    const result = this.crm.revertCommit(call.rep, call.lastCommitId);
    if (!result.ok) {
      this.#event(call, "agent", "undo_failed", result.reason.replace(/_/g, " "));
      if (result.reason === "conflict") return say("conflict", `I can't undo that: someone has changed the ${FIELD_NAMES[result.field] ?? result.field} since. Nothing was changed.`, { field: result.field });
      return say(result.reason, result.reason === "already_reverted" ? "That's already undone." : "I can't undo that one.");
    }
    this.#event(call, "caller", "undo", `audit ${call.lastCommitId.slice(0, 8)}`);
    call.lastWrite = { ...call.lastWrite, status: "undone", at: iso(this.now()) };
    this.#refreshRecord(call);
    const phrase = `Undone. ${possessive(call.lastWrite.accountName)} record is back to how it was.`;
    this.#remember(call, phrase);
    this.#rest(call);
    return { ok: true, commitId: result.commitId, phrase };
  }

  // ------------------------------------------------------------------ drafts

  saveDraft(callId, proposalId = null, reason = "caller_requested") {
    const call = this.#requireIdentified(callId);
    if (call.pendingCommit) return this.holdForWindow(callId);
    const proposal = this.#proposalFor(call, proposalId);
    if (!proposal) {
      const phrase = "There's nothing to save as a draft.";
      this.#remember(call, phrase);
      this.#touch(call);
      return { ok: false, reason: "no_proposal", phrase };
    }
    return this.#draft(call, proposal, reason);
  }

  /** A draft keeps the proposal for later; no field is written. */
  #draft(call, proposal, reason, { quiet = false } = {}) {
    const result = this.crm.saveDraft(call.rep, proposal);
    if (!result.ok) return result;
    this.proposals.delete(proposal.id);
    if (call.currentProposalId === proposal.id) call.currentProposalId = null;
    this.#event(call, "agent", "draft_saved", reason.replace(/_/g, " "));
    const phrase = `${reason === "wrap_up" ? "We're almost out of time, so I" : "I"} saved that as a draft for ${result.accountName}. Nothing was written to the record.`;
    if (!quiet) {
      this.#refreshRecord(call);
      this.#enter(call, STATES.DRAFTING);
      this.#remember(call, phrase);
      this.#rest(call);
    }
    return { ...result, phrase };
  }

  resumeDraft(callId, accountId = null) {
    const call = this.#requireIdentified(callId);
    if (call.pendingCommit) return this.holdForWindow(callId);
    const scope = accountId ?? call.accountId;
    let result = this.crm.resumeDraft(call.rep, scope);
    if (!result.ok && scope) result = this.crm.resumeDraft(call.rep, null);
    if (!result.ok) {
      const phrase = "I don't have a draft for you.";
      this.#remember(call, phrase);
      this.#touch(call);
      return { ok: false, reason: result.reason, phrase };
    }
    const proposal = { opportunityUpdates: [], contactUpdates: [], activity: null, task: null, refused: [], ...result.proposal, id: randomUUID(), callId: call.id, accountId: result.account.id, accountName: result.account.name, createdAt: iso(this.now()) };
    refreshBefores(proposal, this.crm, call.rep);
    proposal.readBack = readBack(proposal, { opening: `Here's your draft for ${result.account.name}.`, refused: [], today: this.today() });
    proposal.rows = writeRows(proposal);
    if (call.currentProposalId) this.proposals.delete(call.currentProposalId);
    this.proposals.set(proposal.id, proposal);
    call.currentProposalId = proposal.id;
    this.#selectAccount(call, result.account);
    this.#event(call, "agent", "draft_resumed", result.account.name);
    this.#refreshRecord(call);
    this.#enter(call, STATES.CONFIRMING);
    this.#remember(call, proposal.readBack);
    return { ok: true, proposalId: proposal.id, readBack: proposal.readBack, account: { id: result.account.id, name: result.account.name }, proposal: publicProposal(proposal) };
  }

  // ------------------------------------------------------------ call control

  pause(callId) {
    const call = this.#requireIdentified(callId);
    if (call.pendingCommit) return this.holdForWindow(callId);
    this.#remember(call, `Sure, I'll wait. Say "continue" when you're ready.`);
    this.#enter(call, STATES.PAUSED);
    return { ok: true };
  }

  continue(callId) {
    const call = this.#requireIdentified(callId);
    if (call.state === STATES.PAUSED) {
      this.#remember(call, "Go ahead.");
      this.#rest(call);
    }
    return { ok: true };
  }

  repeatLast(callId) {
    const call = this.#require(callId);
    if (call.lastPhrase) this.#speak(call, call.lastPhrase);
    this.#touch(call);
    return { ok: true, phrase: call.lastPhrase };
  }

  /** Simulation: a line the offline router couldn't place. Neither a failure nor a no-input. */
  notUnderstood(callId) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    const phrase = call.accountName ? `Sorry, I didn't catch that. Ask about ${call.accountName}, dictate an update, or ask for a person.` : "Sorry, I didn't catch that. Which account?";
    this.#remember(call, phrase);
    this.#touch(call);
    return { ok: false, reason: "not_understood", phrase };
  }

  /** The rep said yes to the handoff the agent offered after a policy refusal. */
  acceptHandoff(callId) {
    const call = this.#requireIdentified(callId);
    return this.transfer(callId, call.offeredHandoff?.reason ?? "explicit_request");
  }

  declineHandoff(callId) {
    const call = this.#requireIdentified(callId);
    call.offeredHandoff = null;
    const phrase = call.accountName ? `OK. Anything else on ${call.accountName}?` : "OK. Which account?";
    this.#remember(call, phrase);
    this.#rest(call);
    return { ok: true, phrase };
  }

  noInput(callId) {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state)) return { ok: false, reason: "call_finished" };
    if ([STATES.COMMITTING, STATES.PAUSED, STATES.TRANSFERRING].includes(call.state)) return { ok: true, ignored: true };
    call.noInputs += 1;
    this.#event(call, "caller", "no_input", `${call.noInputs} of 2`);
    if (call.noInputs >= 2) return this.endCall(callId, "two_no_inputs");
    const phrase = call.pendingPstnRep
      ? `I didn't get that. ${this.#pinPrompt()}`
      : call.currentProposalId
        ? `Say "yes, save it" to save, or tell me what to change.`
        : call.accountName
          ? `Anything else on ${call.accountName}?`
          : "I didn't catch that. Which account?";
    this.#remember(call, phrase);
    this.#touch(call);
    return { ok: true, noInputs: call.noInputs, phrase };
  }

  /** Called on a timer: a warning near the end, a draft at wrap-up, and a hard cap. */
  checkBudget(callId) {
    const call = this.get(callId);
    if (!call?.answeredAt || TERMINAL.has(call.state) || call.state === STATES.TRANSFERRING) return { ok: true };
    if (this.#overBudget(call)) return this.endCall(callId, "call_time_cap");
    if (call.pendingCommit) return { ok: true, pending: true };
    if (this.now() - call.answeredAt < this.options.wrapUpMs || call.wrapWarned) return { ok: true };
    call.wrapWarned = true;
    const proposal = call.rep ? this.#proposalFor(call, null) : null;
    if (proposal) return this.#draft(call, proposal, "wrap_up");
    this.#remember(call, "We're almost out of time.");
    this.#touch(call);
    return { ok: true, warned: true };
  }

  /** A person, with context: Teams shows the topic, and the context rides in the VoIP headers. */
  transfer(callId, reason = "explicit_request") {
    const call = this.#require(callId);
    if (TERMINAL.has(call.state) || call.state === STATES.TRANSFERRING) return { ok: false, reason: "call_finished" };
    if (call.offeredHandoff && !SAFETY_REASONS.has(reason)) reason = call.offeredHandoff.reason;
    if (call.pendingCommit) this.#closeWindow(callId, { quiet: true });
    const target = this.routing.salesOperations;
    const name = this.#targetName();
    const line = {
      verification_failed: null,
      refused_by_policy: `Putting you through to ${name} with the details.`,
      two_failures: `I'm having trouble with this. Putting you through to ${name}.`,
    }[reason];
    const context = this.handoffContext(call, reason);
    call.handoff = { ...context, reason, at: iso(this.now()) };
    call.offeredHandoff = null;
    this.#event(call, "agent", "transfer", `${reason.replace(/_/g, " ")} → ${name}`);
    if (line !== null) this.#remember(call, line ?? `Putting you through to ${name}.`);
    this.#enter(call, STATES.TRANSFERRING);
    this.#publish(call, "handoff", { ...context, reason, simulated: call.simulated });
    if (call.simulated || !this.transferCall) {
      this.audit.updateCall(call.id, { simulated: true });
      this.#finish(call, STATES.TRANSFERRED, `transferred:${reason}`);
      return { ok: true, simulated: true, context };
    }
    const job = Promise.resolve()
      .then(() => this.transferCall(call, { target, context }))
      .then(() => {
        this.#finish(call, STATES.TRANSFERRED, `transferred:${reason}`);
        return { ok: true, context };
      })
      .catch((error) => {
        this.#event(call, "system", "transfer_failed", error?.message ?? "transfer failed");
        call.handoff = null;
        if (!call.rep) {
          this.#remember(call, `I couldn't reach ${name} just now. Please try again later. Goodbye.`);
          this.#finish(call, STATES.ENDED, "transfer_failed");
        } else {
          this.#remember(call, `I couldn't reach ${name} just now. I'm still here.`);
          this.#setState(call, call.currentProposalId ? STATES.CONFIRMING : STATES.LISTENING);
        }
        return { ok: false, reason: "transfer_failed" };
      })
      .finally(() => {
        if (call.inflight === job) call.inflight = null;
      });
    call.inflight = job;
    return job;
  }

  /**
   * ACS accepted the transfer request, then posted CallTransferFailed: nobody
   * took the call, and the caller is still on the line with the agent. Say so
   * once, keep an unconfirmed update as a draft (never a write), and end the
   * call. It never dispatches again, so a queue that keeps failing cannot
   * loop, and the failed handoff is not counted as one.
   */
  transferFailed(callId, message = "transfer failed") {
    const call = this.get(callId);
    if (!call || call.simulated || call.state !== STATES.TRANSFERRED) return { ok: false, reason: "nothing_to_recover" };
    const name = this.#targetName();
    call.handoff = null;
    this.#event(call, "system", "transfer_failed", `${String(message).replace(/[.\s]+$/, "")} · after ACS accepted`);
    const proposal = call.rep ? this.#proposalFor(call, null) : null;
    const draft = hasWrite(proposal) ? this.#draft(call, proposal, "transfer_failed", { quiet: true }) : null;
    const next = !call.rep ? "No records were opened." : draft?.ok ? `Your ${draft.accountName} update is saved as a draft.` : "";
    this.#remember(call, [`I'm sorry, I couldn't reach ${name} after all.`, next, "Please try again later. Goodbye."].filter(Boolean).join(" "));
    this.#finish(call, STATES.ENDED, "transfer_failed");
    return { ok: false, reason: "transfer_failed", error: message, draft: Boolean(draft?.ok) };
  }

  /** What the person who picks up needs, and nothing the caller didn't earn: no PINs, numbers or IDs. */
  handoffContext(call, reason = "explicit_request") {
    const base = { sessionId: call.sessionId ?? call.id, routeId: "sales-operations", target: this.#targetName() };
    if (!call.rep) {
      const tail = phoneTail(call.fromPhone);
      return {
        ...base,
        callTopic: "Unverified caller – no records opened",
        callContext: JSON.stringify({
          verified: false,
          reason,
          callerId: tail ? `number ending ${tail}` : "withheld",
          check: call.callerIdMatched ? `Caller ID matched ${call.claimedRepName}'s registered mobile; ${call.pinFailed ? "PIN failed" : "PIN not entered"}` : "Caller ID is not on the rep list",
          note: "No records were opened or read out.",
        }),
      };
    }
    const policyLabels = unique(
      (call.offeredHandoff?.labels ?? call.lastRefusal?.items?.filter((i) => i.reason === "not_allowlisted").map((i) => i.label) ?? []).map(withoutArticle),
    );
    const topic = reason === "refused_by_policy" && policyLabels.length ? `${call.accountName ?? "Sales rep"} – ${policyLabels.join(", ")}` : `Sales rep – ${call.accountName ?? "CRM assistance"}`;
    const proposal = (call.currentProposalId && this.proposals.get(call.currentProposalId)) || (call.pendingCommit && this.proposals.get(call.pendingCommit.proposalId)) || null;
    const context = {
      rep: call.rep.displayName,
      verifiedBy: call.verifiedBy === "pstn-pin" ? "registered mobile + PIN" : "Teams sign-in",
      account: call.accountName,
      reason,
      request: call.offeredHandoff?.request ?? null,
      refusedRequests: unique(call.refusedItems.map(withoutArticle)),
      proposal: proposal ? redact(proposal.readBack, 300) : null,
      lastWrite: lastWriteSummary(call.lastWrite),
      draftId: this.crm.latestDraftHint?.(call.rep)?.draftId ?? null,
    };
    if (JSON.stringify(context).length > 1000 && context.proposal) context.proposal = clip(context.proposal, 120);
    if (JSON.stringify(context).length > 1000) context.request = null;
    return { ...base, callTopic: clip(topic, 48), callContext: JSON.stringify(context) };
  }

  endCall(callId, outcome = "agent_ended") {
    const call = this.get(callId);
    if (!call || TERMINAL.has(call.state)) return { ok: true };
    if (call.pendingCommit) this.#closeWindow(callId, { quiet: true });
    const proposal = call.rep ? this.#proposalFor(call, null) : null;
    const draft = proposal ? this.#draft(call, proposal, outcome, { quiet: true }) : null;
    const closing = CLOSINGS[outcome];
    const phrase = closing ? `${closing}${draft?.ok ? " Your update is saved as a draft." : ""} Goodbye.` : null;
    if (phrase) this.#remember(call, phrase);
    this.#finish(call, STATES.ENDED, outcome);
    // A closing reached inside a tool call (the time cap) reaches the caller in the tool result.
    return phrase ? { ok: true, draft: Boolean(draft?.ok), phrase } : { ok: true, draft: Boolean(draft?.ok) };
  }

  pushTranscript(callId, role, text) {
    const call = this.get(callId);
    if (!call || !text) return;
    if (role === "caller") call.noInputs = 0;
    const at = this.now();
    call.transcript.push({ role, text, at });
    this.audit.recordTranscript(callId, role, text);
    this.#publish(call, "transcript", { role, text, at: iso(at) });
  }

  recordAgentAction(callId, { tool, ok = true, detail = null }) {
    const call = this.get(callId);
    if (call) this.#event(call, "agent", ok ? "tool" : "tool_rejected", detail ? `${tool}: ${detail}` : tool);
  }

  // ---------------------------------------------------------------- snapshot

  /** What the console renders. Contact details appear only once they were read out on request. */
  snapshot(callId) {
    const call = this.get(callId);
    if (!call) return null;
    const pending = call.pendingCommit;
    const proposal = (call.currentProposalId && this.proposals.get(call.currentProposalId)) || (pending && this.proposals.get(pending.proposalId)) || null;
    return {
      id: call.id,
      callId: call.id,
      state: call.state,
      simulated: call.simulated,
      outcome: call.outcome,
      arrival: call.arrival,
      rep: call.rep ? { displayName: call.rep.displayName, firstName: call.rep.firstName, verifiedBy: call.verifiedBy } : null,
      identity: this.#identityChecks(call),
      account: call.accountId ? { id: call.accountId, name: call.accountName, relationship: call.accountRelationship } : null,
      accountCandidates: call.accountCandidates,
      briefing: call.currentBriefing,
      record: call.record,
      proposal: publicProposal(proposal),
      pendingCommit: pending ? { proposalId: pending.proposalId, startedAt: iso(pending.startedAt), commitsAt: iso(pending.commitsAt), windowMs: pending.windowMs, remainingMs: this.#remaining(call) } : null,
      lastWrite: call.lastWrite,
      lastRefusal: call.lastRefusal,
      lastCommitId: call.lastCommitId,
      offeredHandoff: call.offeredHandoff ? { reason: call.offeredHandoff.reason, labels: call.offeredHandoff.labels } : null,
      handoff: call.handoff,
      lastPhrase: call.lastPhrase,
      failures: call.failures,
      noInputs: call.noInputs,
      elapsedMs: call.answeredAt ? (call.endedAt ?? this.now()) - call.answeredAt : 0,
      budgetMs: this.options.callTimeBudgetMs,
      transcript: call.transcript.map((t) => ({ role: t.role, text: t.text, at: iso(t.at) })),
    };
  }

  /** The identity checklist: what was checked before anything was read out. */
  #identityChecks(call) {
    const rep = call.rep;
    const n = this.options.pinLength;
    const tail = phoneTail(call.fromPhone);
    const caller =
      rep?.verifiedBy === "teams-user"
        ? { tone: "ok", detail: `Teams sign-in — ${rep.displayName}` }
        : call.callerIdMatched
          ? { tone: "ok", detail: `Registered mobile, number ending ${tail}` }
          : call.state === STATES.RINGING
            ? { tone: "idle", detail: "Waiting to answer" }
            : { tone: "err", detail: tail ? `Number ending ${tail} is not on the rep list` : "No caller ID" };
    const pin =
      rep?.verifiedBy === "teams-user"
        ? { tone: "idle", detail: "Not needed — signed in to Teams" }
        : rep?.verifiedBy === "pstn-pin"
          ? { tone: "ok", detail: "Correct" }
          : call.pinFailed
            ? { tone: "err", detail: "Wrong PIN — no records opened" }
            : call.pendingPstnRep
              ? { tone: "warn", detail: call.pinDigits.length ? `${call.pinDigits.length} of ${n} digits` : "Waiting for PIN" }
              : call.state === STATES.RINGING
                ? { tone: "idle", detail: "Not asked yet" }
                : { tone: "idle", detail: "Not offered — caller ID not recognized" };
    const ownership = call.accountRelationship === "own" ? `${rep?.firstName}'s own account` : `on ${rep?.firstName}'s account team`;
    const access = rep
      ? call.accountId
        ? { tone: "ok", detail: `${call.accountName} — ${ownership}` }
        : { tone: "idle", detail: "Scoped to accounts on the rep's list" }
      : { tone: call.pinFailed || TERMINAL.has(call.state) ? "err" : "warn", detail: "Locked until verified" };
    const disclosed = [...call.disclosed.values()];
    const contact = disclosed.length ? { tone: "ok", detail: `Read out on request: ${disclosed.join(", ")}` } : { tone: "idle", detail: rep ? "Withheld until asked for" : "Withheld" };
    return [
      { id: "caller", label: "Caller", ...caller },
      { id: "pin", label: "PIN", ...pin },
      { id: "access", label: "Record access", ...access },
      { id: "contact", label: "Contact details", ...contact },
    ];
  }

  /** The record card: only what this rep may see, phone and email only once read out. */
  #refreshRecord(call) {
    const briefing = call.rep && call.accountId ? this.crm.getBriefing(call.rep, call.accountId) : null;
    if (!briefing?.ok) {
      call.record = null;
      return;
    }
    const contactId = call.recordContactId ?? briefing.keyContact?.id ?? null;
    const contact = contactId ? this.crm.getContact(call.rep, contactId) : null;
    const shown = (field) => Boolean(contact && call.disclosed.has(`${contact.id}:${field}`));
    const today = this.today();
    call.record = {
      accountId: briefing.account.id,
      account: { name: briefing.account.name, city: briefing.account.city, tier: briefing.account.tier, relationship: briefing.account.ownerId === call.rep.ownerId ? "Your account" : "Account team" },
      contact: contact ? { id: contact.id, name: contact.name, title: contact.title, phone: shown("phone") ? spokenPhone(contact.phone) : null, email: shown("email") ? contact.email : null } : null,
      deals: briefing.opportunities.map((o) => ({ id: o.id, name: o.name, stage: o.stage, amount: o.amount, closeDate: o.closeDate, nextStep: o.nextStep })),
      lastTouch: briefing.lastActivity ? { type: briefing.lastActivity.type, subject: briefing.lastActivity.subject, date: briefing.lastActivity.date } : null,
      dueTasks: briefing.dueTasks.map((t) => ({ id: t.id, subject: t.subject, dueDate: t.dueDate, overdue: t.dueDate < today })),
      withheld: ["Credit limit and payment terms — Sales Operations only"],
      updatedAt: iso(this.now()),
    };
  }

  // ---------------------------------------------------------------- helpers

  #pinPrompt() {
    const n = this.options.pinLength;
    return `Please enter your ${NUMBER_WORDS[n] ?? n}-digit Contoso sales PIN.`;
  }

  #remaining(call) {
    const pending = call.pendingCommit;
    return pending ? Math.max(0, Math.round(pending.windowMs - (performance.now() - pending.startedPerf))) : 0;
  }

  /** Back to the resting state for what is open: a window, a proposal, or nothing. */
  #rest(call) {
    if (TERMINAL.has(call.state) || call.state === STATES.TRANSFERRING) return;
    this.#enter(call, call.pendingCommit ? STATES.COMMITTING : call.currentProposalId ? STATES.CONFIRMING : STATES.LISTENING);
  }

  #enter(call, state) {
    if (!this.#setState(call, state)) this.#touch(call);
  }

  #setState(call, state) {
    if (call.state === state) return false;
    const from = call.state;
    call.state = state;
    this.audit.updateCall(call.id, { state });
    this.#event(call, "system", "state", `${from} → ${state}`);
    this.#publish(call, "state", this.snapshot(call.id));
    return true;
  }

  #touch(call) {
    this.#publish(call, "state", this.snapshot(call.id));
  }

  #remember(call, phrase) {
    call.lastPhrase = phrase;
    this.#speak(call, phrase);
  }

  /** In simulation the line goes straight to the transcript; on a live call the model says it and its own transcript arrives. */
  #speak(call, text) {
    if (!text) return;
    const agent = this.agents.get(call.id);
    if (!agent?.live) this.pushTranscript(call.id, "agent", text);
    agent?.instruct?.(text, text);
  }

  #event(call, source, kind, detail) {
    this.audit.recordEvent(call.id, source, kind, detail);
    this.#publish(call, "event", { source, kind, detail, at: iso(this.now()) });
  }

  #publish(call, target, payload) {
    this.hub?.send?.(call.id, target, payload);
  }

  #finish(call, state, outcome) {
    call.outcome = outcome;
    call.endedAt = this.now();
    call.pendingPstnRep = null;
    this.audit.updateCall(call.id, { outcome, endedAt: iso(call.endedAt), durationMs: call.endedAt - call.startedAt });
    this.#enter(call, state);
  }

  /** Two failures in a call and the rep goes to a person. */
  #failure(call, reason, phrase) {
    call.failures += 1;
    this.#event(call, "system", "failure", reason.replace(/_/g, " "));
    if (call.failures >= 2) return this.transfer(call.id, "two_failures");
    this.#remember(call, phrase);
    this.#touch(call);
    return { ok: false, reason, failures: call.failures, phrase };
  }

  #overBudget(call) {
    return call.answeredAt != null && this.now() - call.answeredAt >= this.options.callTimeBudgetMs;
  }

  #require(callId) {
    const call = this.get(callId);
    if (!call) throw new Error(`unknown call ${callId}`);
    return call;
  }

  #requireIdentified(callId) {
    const call = this.#require(callId);
    if (!call.rep) throw new Error("caller is not identified");
    return call;
  }

  #targetName() {
    return this.routing.salesOperations?.displayName ?? "Sales Operations";
  }
}

// ------------------------------------------------------------------ policy

const MONTH_WORDS = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const DATE_WORDS = String.raw`(?:today|tomorrow|(?:mon|tues|wednes|thurs|fri|satur|sun)day|${MONTH_WORDS}\.?\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}\/\d{1,2})`;
const CLOSE_DATE_RE = new RegExp(String.raw`\bclose date\s+(?:is\s+|to\s+|of\s+|on\s+|now\s+)?(${DATE_WORDS})\b`, "i");
const TASK_RE = new RegExp(String.raw`\bremind me to\s+([^.!?]+?)(?:\s+(?:on\s+|by\s+)?(${DATE_WORDS}))?\s*(?:[.!?]|$)`, "i");
const TASK_DUE_RE = new RegExp(String.raw`\b(?:due|remind me|reminder)\s+(?:on\s+|by\s+|for\s+)?(${DATE_WORDS})\b`, "i");
const AMOUNT_RE = /\b(?:at|amount(?:\s+(?:is|to|of))?|for)\s+(\$)?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|m|million)?\b/gi;
const LOOSE_AMOUNT_RE = /(\$)?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|m|million)?\b/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const CONTACT_CHANGE_RE = /\b(?:new|change|changed|changes|update|updated|switch|switched|replace|now)\b/;
const KEEP_OLD_CONTACT_RE = /\b(?:keep|use) the (?:old|current|existing|original) (?:one|number|phone|mobile|email)\b|\bkeep the old\b/;
const CLOSINGS = {
  two_no_inputs: "I haven't heard anything, so I'll end the call here.",
  call_time_cap: "We're out of time, so I'll end the call here.",
};

/**
 * Dictation → an allow-listed change set. Anything off the allow-list, or
 * invalid, is refused with a reason and never reaches the change set.
 */
export function buildProposal({ crm, rep, account, dictation, allowlist, picklists, today }) {
  const ctx = { allowlist, picklists, today };
  const text = String(dictation ?? "").trim();
  const lower = text.toLowerCase();
  const refused = [];
  for (const rule of POLICY_REFUSALS) {
    if (rule.pattern.test(lower)) refused.push({ entity: rule.entity, field: rule.field, label: rule.label, reason: "not_allowlisted" });
  }
  const contacts = crm.contacts(account.id);
  const mentioned = contacts.filter((c) => wholeWord(lower, c.name.toLowerCase()) || wholeWord(lower, firstWord(c.name).toLowerCase()));

  const opportunityUpdates = [];
  const opportunity = matchOpportunity(crm.opportunities(account.id).filter((o) => o.isOpen), lower);
  if (opportunity) {
    const diffs = [];
    const stage = extractStage(text, picklists.opportunityStage.map((s) => s.value));
    if (stage) addDiff(diffs, refused, "opportunity", "stage", opportunity.stage, stage, ctx);
    const amount = extractAmount(text);
    if (amount != null) addDiff(diffs, refused, "opportunity", "amount", opportunity.amount, amount, ctx);
    const close = text.match(CLOSE_DATE_RE);
    if (close) addDiff(diffs, refused, "opportunity", "closeDate", opportunity.closeDate, parseRelativeDate(close[1].replace(/\./g, ""), today), ctx);
    const nextStep = extractNextStep(text);
    if (nextStep) addDiff(diffs, refused, "opportunity", "nextStep", opportunity.nextStep, nextStep, ctx);
    if (diffs.length) opportunityUpdates.push({ id: opportunity.id, name: opportunity.name, diffs });
  }

  const contactUpdates = [];
  const phone = phoneFromText(text);
  const email = text.match(EMAIL_RE)?.[0]?.toLowerCase() ?? null;
  if ((phone || email) && CONTACT_CHANGE_RE.test(lower)) {
    const contact = mentioned[0] ?? contacts.find((c) => c.id === account.keyContactId) ?? null;
    if (contact) {
      const diffs = [];
      if (phone) addDiff(diffs, refused, "contact", "phone", contact.phone, phone, ctx);
      if (email) addDiff(diffs, refused, "contact", "email", contact.email, email, ctx);
      if (diffs.length) contactUpdates.push({ id: contact.id, name: contact.name, diffs });
    }
  }

  const taskMatch = text.match(TASK_RE);
  const body = taskMatch ? text.replace(taskMatch[0], " ") : text;
  let activity = null;
  if (/\b(?:log|logged|meeting|met|call|called|spoke)\b/i.test(body)) {
    const type = /\b(?:call|called|spoke)\b/i.test(body) && !/\b(?:meeting|met)\b/i.test(body) ? "call" : "meeting";
    const candidate = { type, subject: clip(`${account.name} ${type}`, 120), notes: clip(text, 1000), date: today, contactIds: mentioned.map((c) => c.id), contactNames: mentioned.map((c) => c.name) };
    const problems = checkAll("activity", "create", { type: candidate.type, subject: candidate.subject, notes: candidate.notes, date: candidate.date }, ctx);
    if (problems.length) refused.push(...problems);
    else activity = candidate;
  }

  let task = null;
  if (taskMatch) {
    const candidate = { subject: clip(taskMatch[1].trim(), 120), dueDate: parseRelativeDate((taskMatch[2] ?? "today").replace(/\./g, ""), today), owner: "me" };
    const problems = checkAll("task", "create", candidate, ctx);
    if (problems.length) refused.push(...problems);
    else task = candidate;
  }

  const changes = { accountName: account.name, activity, opportunityUpdates, contactUpdates, task, refused };
  return { ...changes, readBack: readBack(changes, { refused, today }) };
}

/** A spoken correction applied to an existing change set. `ctx.refused` collects only the new refusals. */
export function amendChangeSet(proposal, change, ctx) {
  const next = structuredClone(proposal);
  next.opportunityUpdates ??= [];
  next.contactUpdates ??= [];
  const text = String(change ?? "");
  const lower = text.toLowerCase();
  let changed = false;
  const mark = (did) => {
    changed = did || changed;
  };

  let update = next.opportunityUpdates[0];
  if (!update) {
    const opp = matchOpportunity(ctx.crm.opportunities(next.accountId).filter((o) => o.isOpen), lower);
    if (opp) {
      update = { id: opp.id, name: opp.name, diffs: [] };
      next.opportunityUpdates.push(update);
    }
  }
  const opp = update ? ctx.crm.getOpportunity(ctx.rep, update.id) : null;
  if (opp) {
    const stage = extractStage(text, ctx.picklists.opportunityStage.map((s) => s.value));
    if (stage) mark(setDiff(update, ctx.refused, "opportunity", "stage", opp.stage, stage, ctx));
    const amount = extractAmount(text) ?? extractAmount(text, { loose: true });
    if (amount != null) mark(setDiff(update, ctx.refused, "opportunity", "amount", opp.amount, amount, ctx));
    const close = text.match(CLOSE_DATE_RE);
    if (close) mark(setDiff(update, ctx.refused, "opportunity", "closeDate", opp.closeDate, parseRelativeDate(close[1].replace(/\./g, ""), ctx.today), ctx));
    const nextStep = extractNextStep(text);
    if (nextStep) mark(setDiff(update, ctx.refused, "opportunity", "nextStep", opp.nextStep, nextStep, ctx));
  }

  const phone = phoneFromText(text);
  const email = text.match(EMAIL_RE)?.[0]?.toLowerCase() ?? null;
  if (KEEP_OLD_CONTACT_RE.test(lower) && next.contactUpdates.length) {
    next.contactUpdates = [];
    mark(true);
  } else if (phone || email) {
    let cu = next.contactUpdates[0];
    if (!cu) {
      const contacts = ctx.crm.contacts(next.accountId);
      const contact = contacts.find((c) => wholeWord(lower, firstWord(c.name).toLowerCase())) ?? contacts[0];
      if (contact) {
        cu = { id: contact.id, name: contact.name, diffs: [] };
        next.contactUpdates.push(cu);
      }
    }
    const contact = cu ? ctx.crm.getContact(ctx.rep, cu.id) : null;
    if (contact && phone) mark(setDiff(cu, ctx.refused, "contact", "phone", contact.phone, phone, ctx));
    if (contact && email) mark(setDiff(cu, ctx.refused, "contact", "email", contact.email, email, ctx));
  }

  const taskMatch = text.match(TASK_RE);
  if (/\bno task\b|\bno reminder\b|\bdon'?t remind\b|\bdo not remind\b|\bskip the (?:task|reminder)\b/.test(lower)) {
    if (next.task) mark(true);
    next.task = null;
  } else if (taskMatch) {
    const candidate = { subject: clip(taskMatch[1].trim(), 120), dueDate: parseRelativeDate((taskMatch[2] ?? "today").replace(/\./g, ""), ctx.today), owner: "me" };
    const problems = checkAll("task", "create", candidate, ctx);
    if (problems.length) ctx.refused.push(...problems);
    else {
      next.task = candidate;
      mark(true);
    }
  } else if (next.task && TASK_DUE_RE.test(text)) {
    const dueDate = parseRelativeDate(text.match(TASK_DUE_RE)[1].replace(/\./g, ""), ctx.today);
    const problems = checkAll("task", "create", { dueDate }, ctx);
    if (problems.length) ctx.refused.push(...problems);
    else if (dueDate !== next.task.dueDate) {
      next.task = { ...next.task, dueDate };
      mark(true);
    }
  }

  if (/\bdon'?t log\b|\bdo not log\b|\bno activity\b|\bskip the (?:activity|meeting|log)\b/.test(lower) && next.activity) {
    next.activity = null;
    mark(true);
  }
  next.opportunityUpdates = next.opportunityUpdates.filter((u) => u.diffs.length);
  next.contactUpdates = next.contactUpdates.filter((u) => u.diffs.length);
  return { next, changed };
}

/** The allow-list check: null, or why the value can't be written. */
export function validateField(entity, operation, field, value, { allowlist, picklists, today }) {
  const rule = allowlist?.[entity]?.[operation]?.[field];
  if (!rule) return { reason: "not_allowlisted" };
  switch (rule.type) {
    case "picklist":
      return picklists?.[rule.picklist]?.some((p) => p.value.toLowerCase() === String(value).toLowerCase()) ? null : { reason: "invalid_picklist" };
    case "currency": {
      const n = Number(value);
      return Number.isFinite(n) && n >= (rule.min ?? 0) && n <= (rule.max ?? Infinity) ? null : { reason: "out_of_bounds", limit: rule.max };
    }
    case "text":
      return String(value ?? "").length <= (rule.maxLength ?? Infinity) ? null : { reason: "too_long", limit: rule.maxLength };
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return { reason: "invalid_date" };
      if ((rule.notBefore === "today" || rule.withinDays) && value < today) return { reason: "date_in_past" };
      if (rule.withinDays && daysBetween(today, value) > rule.withinDays) return { reason: "date_too_far", limit: rule.withinDays };
      return null;
    case "phone":
      return /^\+1\d{10}$/.test(String(value)) ? null : { reason: "invalid_phone" };
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value)) ? null : { reason: "invalid_email" };
    case "fixed":
      return value === rule.value ? null : { reason: "not_allowlisted" };
    default:
      return null;
  }
}

function checkAll(entity, operation, values, ctx) {
  const problems = [];
  for (const [field, value] of Object.entries(values)) {
    const problem = validateField(entity, operation, field, value, ctx);
    if (problem) problems.push(refusal(entity, field, value, problem));
  }
  return problems;
}

function addDiff(diffs, refused, entity, field, before, after, ctx) {
  if (sameValue(before, after)) return;
  const problem = validateField(entity, "update", field, after, ctx);
  if (problem) refused.push(refusal(entity, field, after, problem));
  else diffs.push({ field, before, after });
}

/** Set, replace or drop one field's diff. Returns whether the change set changed. */
function setDiff(update, refused, entity, field, current, after, ctx) {
  const problem = validateField(entity, "update", field, after, ctx);
  if (problem) {
    refused.push(refusal(entity, field, after, problem));
    return false;
  }
  const i = update.diffs.findIndex((d) => d.field === field);
  if (sameValue(current, after)) {
    if (i < 0) return false;
    update.diffs.splice(i, 1);
    return true;
  }
  if (i >= 0 && sameValue(update.diffs[i].after, after)) return false;
  if (i >= 0) update.diffs[i] = { field, before: current, after };
  else update.diffs.push({ field, before: current, after });
  return true;
}

function extractStage(text, stages) {
  const lower = String(text).toLowerCase();
  const twoWord = stages.find((s) => s.includes(" ") && wholeWord(lower, s.toLowerCase()));
  if (twoWord) return twoWord;
  const closed = lower.match(/\bclosed\s+(?!won\b|lost\b)([a-z]+)/);
  if (closed) return `Closed ${capitalise(closed[1])}`;
  return stages.find((s) => !s.includes(" ") && new RegExp(String.raw`\b(?:to|in|into|at|is|stage|as)\s+(?:the\s+)?${escapeRe(s.toLowerCase())}\b`).test(lower)) ?? null;
}

/** "at 240k", "amount to $240,000"; loose mode (corrections) takes any amount said with $ or a unit. */
function extractAmount(text, { loose = false } = {}) {
  for (const m of String(text).matchAll(loose ? LOOSE_AMOUNT_RE : AMOUNT_RE)) {
    const n = Number(m[2].replace(/,/g, ""));
    const unit = (m[3] ?? "").toLowerCase();
    if (!Number.isFinite(n) || (loose && !m[1] && !unit)) continue;
    const value = unit === "k" || unit === "thousand" ? n * 1000 : unit === "m" || unit === "million" ? n * 1_000_000 : n;
    if (!m[1] && !unit && value < 1000) continue;
    return Math.round(value);
  }
  return null;
}

function extractNextStep(text) {
  const m = String(text).match(/\bnext step\s+(?:is\s+)?(?:to\s+)?:?\s*([^.!?]+)/i);
  if (m) return capitalise(clip(m[1].trim(), 200));
  return /\bpending signature\b/i.test(text) ? "Pending signature" : null;
}

/** The longest deal name or alias said as a whole phrase; on a tie, the bigger deal. */
export function matchOpportunity(opportunities, text) {
  const padded = ` ${normalise(text)} `;
  let best = null;
  for (const o of opportunities) {
    for (const name of [o.name, ...(o.aliases ?? [])]) {
      const n = normalise(name);
      if (!n || !padded.includes(` ${n} `)) continue;
      if (!best || n.length > best.length || (n.length === best.length && o.amount > best.opportunity.amount)) best = { opportunity: o, length: n.length };
    }
  }
  return best?.opportunity ?? null;
}

// --------------------------------------------------------------- read-back

const EMAIL_RE_G = new RegExp(EMAIL_RE.source, "g");
const PHONE_LIKE_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}\b/g;
const REFUSAL_DETAIL = {
  not_allowlisted: "Not on the phone allow-list",
  invalid_picklist: "Not a valid option",
  out_of_bounds: "Outside the allowed range",
  too_long: "Too long to save by phone",
  invalid_date: "Not a date",
  date_in_past: "In the past",
  date_too_far: "Too far out",
  invalid_phone: "Not a full phone number",
  invalid_email: "Not an email address",
};

/** The read-back the rep confirms. Every write is said out loud before "yes, save it" can commit it. */
export function readBack(changes, { opening = null, refused = [], today = null } = {}) {
  const parts = [opening ?? `Here's what I have for ${changes.accountName}.`];
  const a = changes.activity;
  if (a) {
    const who = a.contactNames?.length ? ` with ${joinEnglish(a.contactNames)}` : "";
    parts.push(`${/^[aeiou]/i.test(a.type) ? "An" : "A"} ${a.type} activity${who}, ${dayWords(a.date, today)}.`);
  }
  for (const u of changes.opportunityUpdates ?? []) {
    const items = u.diffs.map((d) => `${FIELD_NAMES[d.field] ?? d.field} from ${spokenValue(d.field, d.before)} to ${spokenValue(d.field, d.after)}`);
    if (items.length) parts.push(`${u.name}: ${joinEnglish(items)}.`);
  }
  for (const u of changes.contactUpdates ?? []) {
    for (const d of u.diffs) {
      if (d.field === "phone") parts.push(`${possessive(u.name)} number changes from ${d.before ? `the one ending ${phoneTail(d.before)}` : "none"} to ${spokenPhone(d.after)}.`);
      else parts.push(`${possessive(u.name)} email changes to ${d.after}.`);
    }
  }
  if (changes.task) parts.push(`A task for you to ${changes.task.subject}, due ${dayWords(changes.task.dueDate, today)}.`);
  const left = leftOutPhrase(refused);
  if (left) parts.push(left);
  parts.push("Save it?");
  return parts.join(" ");
}

/** What was left out of a change set, and why, in words the rep can act on. */
export function leftOutPhrase(refused = []) {
  if (!refused?.length) return "";
  const out = [];
  const policy = unique(refused.filter((r) => r.reason === "not_allowlisted").map((r) => r.label ?? FIELD_NAMES[r.field] ?? r.field));
  if (policy.length) {
    const many = policy.length > 1;
    out.push(`${capitalise(joinEnglish(policy))} ${many ? "aren't" : "isn't"} on the list of things I can change by phone, so I left ${many ? "them" : "it"} out.`);
  }
  for (const r of refused) {
    if (r.reason === "not_allowlisted") continue;
    const phrase = refusalPhrase(r);
    if (!out.includes(phrase)) out.push(phrase);
  }
  return out.join(" ");
}

function refusalPhrase(r) {
  const name = FIELD_NAMES[r.field] ?? r.field;
  const task = r.entity === "task";
  switch (r.reason) {
    case "invalid_picklist":
      return r.field === "stage" ? `"${r.value}" isn't a sales stage, so I left the stage alone.` : `"${r.value}" isn't an option for the ${name}, so I left it alone.`;
    case "date_in_past":
      return task ? "The due date can't be in the past, so I left the task out." : `The ${name} can't be in the past, so I left it alone.`;
    case "date_too_far":
      return task ? `The due date is more than ${r.limit} days out, so I left the task out.` : `The ${name} is more than ${r.limit} days out, so I left it alone.`;
    case "out_of_bounds":
      return `That ${name} is outside what I can set by phone, so I left it alone.`;
    case "invalid_phone":
      return "That doesn't sound like a full phone number, so I left the number alone.";
    case "invalid_email":
      return "That doesn't sound like an email address, so I left the email alone.";
    case "too_long":
      return task ? "That task is too long to save by phone, so I left it out." : `That ${name} is too long to save by phone, so I left it alone.`;
    case "invalid_date":
      return `I didn't catch the ${name}, so I left it alone.`;
    default:
      return `I left the ${name} alone.`;
  }
}

/** The before → after rows the record card shows, one per field written. */
export function writeRows(proposal) {
  const rows = [];
  const a = proposal.activity;
  if (a) rows.push({ entity: "activity", label: `New ${a.type}`, before: null, after: `${a.subject} · ${shortDate(a.date)}` });
  for (const u of proposal.opportunityUpdates ?? []) {
    for (const d of u.diffs) rows.push({ entity: "opportunity", label: `${u.name} · ${FIELD_NAMES[d.field] ?? d.field}`, before: displayValue(d.field, d.before), after: displayValue(d.field, d.after) });
  }
  for (const u of proposal.contactUpdates ?? []) {
    for (const d of u.diffs) rows.push({ entity: "contact", label: `${u.name} · ${FIELD_NAMES[d.field] ?? d.field}`, before: maskedBefore(d), after: d.field === "phone" ? spokenPhone(d.after) : d.after });
  }
  const t = proposal.task;
  if (t) rows.push({ entity: "task", label: "New task", before: null, after: `${t.subject} · due ${shortDate(t.dueDate)}` });
  return rows;
}

/** The proposal as the console sees it: contact details the rep didn't ask for stay masked. */
export function publicProposal(p) {
  if (!p) return null;
  return {
    id: p.id,
    accountId: p.accountId,
    accountName: p.accountName,
    readBack: p.readBack,
    rows: p.rows ?? writeRows(p),
    refused: (p.refused ?? []).map(refusalItem),
    activity: p.activity ? { type: p.activity.type, subject: p.activity.subject, date: p.activity.date, contactNames: p.activity.contactNames ?? [] } : null,
    opportunityUpdates: (p.opportunityUpdates ?? []).map((u) => ({ id: u.id, name: u.name, diffs: u.diffs.map((d) => ({ field: d.field, before: d.before, after: d.after })) })),
    contactUpdates: (p.contactUpdates ?? []).map((u) => ({ id: u.id, name: u.name, diffs: u.diffs.map((d) => ({ field: d.field, before: maskedBefore(d), after: d.after })) })),
    task: p.task ? { subject: p.task.subject, dueDate: p.task.dueDate } : null,
    createdAt: p.createdAt ?? null,
  };
}

function hasWrite(p) {
  return Boolean(p && (p.activity || p.task || p.opportunityUpdates?.some((u) => u.diffs.length) || p.contactUpdates?.some((u) => u.diffs.length)));
}

/** Only an explicit "yes, save it" commits. Hedges and negatives never do. */
export function isExplicitSave(text) {
  const lower = String(text ?? "").toLowerCase();
  if (/\bmaybe\b|\bi think\b|\bnot\b|\bdon'?t\b|\bdo not\b|\bnever\b/.test(lower)) return false;
  return /\byes[,.!]?\s+(?:please\s+)?save it\b|\byes[,.!]?\s+please save\b|\bgo ahead and save\b|\bsave it\b/.test(lower);
}

/** A resumed draft is re-read against the record as it is now; fields already at their new value drop out. */
function refreshBefores(proposal, crm, rep) {
  const refresh = (updates, read) =>
    (updates ?? [])
      .map((u) => {
        const current = read(u.id);
        const diffs = current ? u.diffs.map((d) => ({ ...d, before: current[d.field] })).filter((d) => !sameValue(d.before, d.after)) : [];
        return { ...u, diffs };
      })
      .filter((u) => u.diffs.length);
  proposal.opportunityUpdates = refresh(proposal.opportunityUpdates, (id) => crm.getOpportunity(rep, id));
  proposal.contactUpdates = refresh(proposal.contactUpdates, (id) => crm.getContact(rep, id));
}

function onlyPhoneChange(proposal) {
  if (!proposal || proposal.activity || proposal.task || proposal.opportunityUpdates?.some((u) => u.diffs.length)) return null;
  const diffs = (proposal.contactUpdates ?? []).flatMap((u) => u.diffs.map((d) => ({ ...d, name: u.name })));
  return diffs.length === 1 && diffs[0].field === "phone" ? { name: diffs[0].name, before: diffs[0].before } : null;
}

function lastWriteSummary(write) {
  if (!write) return null;
  const head = { committed: "Saved", cancelled: "Stopped in the undo window, nothing written", undone: "Saved, then undone" }[write.status] ?? write.status;
  // Contact values stay out of the handoff: the field name is enough for whoever picks up.
  const rows = (write.rows ?? []).map((r) => (r.entity === "contact" ? r.label : r.before != null ? `${r.label}: ${r.before} → ${r.after}` : `${r.label}: ${r.after}`));
  return redact(`${head}${rows.length ? ` — ${rows.join("; ")}` : ""}`, 200);
}

function refusal(entity, field, value, problem) {
  return { entity, field, label: FIELD_NAMES[field] ?? field, reason: problem.reason, value, ...(problem.limit != null ? { limit: problem.limit } : {}) };
}

function refusalItem(r) {
  return { entity: r.entity, field: r.field, label: r.label ?? FIELD_NAMES[r.field] ?? r.field, reason: r.reason, detail: REFUSAL_DETAIL[r.reason] ?? r.reason };
}

// ----------------------------------------------------------------- phrasing

function dayWords(date, today) {
  if (!date) return "";
  if (!today) return spokenDate(date);
  const days = daysBetween(today, date);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days > 1 && days <= 6) return `${new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}, ${spokenDate(date)}`;
  return spokenDate(date);
}

function spokenValue(field, value) {
  if (value == null || value === "") return "none";
  if (field === "amount") return spokenAmount(value);
  if (field === "closeDate" || field === "dueDate") return spokenDate(value);
  return String(value);
}

function spokenAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  if (n >= 1_000_000) return `${Math.round(n / 10_000) / 100} million`;
  if (n >= 1000) return `${Math.round(n / 100) / 10} thousand`;
  return `$${n}`;
}

function displayValue(field, value) {
  if (value == null || value === "") return null;
  if (field === "amount") return `$${Number(value).toLocaleString("en-US")}`;
  if (field === "closeDate" || field === "dueDate") return shortDate(value);
  return String(value);
}

function maskedBefore(diff) {
  if (diff.before == null || diff.before === "") return null;
  if (diff.field === "phone") return `ending ${phoneTail(diff.before)}`;
  const [user, domain] = String(diff.before).split("@");
  return domain ? `${user.charAt(0)}•••@${domain}` : "•••";
}

function spokenSeconds(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  return `${NUMBER_WORDS[s] ?? s} ${s === 1 ? "second" : "seconds"}`;
}

function isPromise(value) {
  return Boolean(value && typeof value.then === "function");
}

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

function unique(items) {
  return [...new Set(items.filter((x) => x != null && x !== ""))];
}

function capitalise(text) {
  const s = String(text ?? "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function possessive(name) {
  const s = String(name ?? "");
  return /s$/i.test(s) ? `${s}'` : `${s}'s`;
}

function clip(text, limit) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length <= limit ? s : `${s.slice(0, limit - 1).trimEnd()}…`;
}

/** Phone numbers, emails and long digit runs (a PIN) never ride along in a handoff. */
function redact(text, limit = 160) {
  if (text == null) return null;
  const masked = String(text)
    .replace(PHONE_LIKE_RE, "[phone number]")
    .replace(EMAIL_RE_G, "[email]")
    .replace(/(?<![$\d,.])\b\d{5,}\b/g, "[digits]");
  return clip(masked, limit);
}

function plural(n, word) {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

function withoutArticle(text) {
  return String(text ?? "").replace(/^the\s+/i, "");
}

function sameValue(a, b) {
  if (a == null || a === "") return b == null || b === "";
  return b != null && String(a).toLowerCase() === String(b).toLowerCase();
}

function wholeWord(haystack, needle) {
  return Boolean(needle) && new RegExp(String.raw`\b${escapeRe(needle)}\b`).test(haystack);
}

function firstWord(name) {
  return String(name ?? "").split(/\s+/)[0];
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
