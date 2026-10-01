import { randomUUID } from "node:crypto";
import { config, nowDate } from "./config.mjs";
import { clip, isAffirmative, maskPhone } from "./util.mjs";

export const STATES = Object.freeze({ RINGING:"ringing", GREETING:"greeting", LISTENING:"listening", CLASSIFYING:"classifying", CLARIFYING:"clarifying", ANSWERING:"answering", VERIFYING:"verifying", PERSONAL_ANSWER:"personal_answer", PROPOSING_TICKET:"proposing_ticket", CONFIRMING:"confirming", FILED:"filed", HANDOFF_RESET:"handoff_reset", SENSITIVE:"sensitive", AFTER_HOURS_OFFER:"after_hours_offer", TRANSFERRING:"transferring", TRANSFERRED:"transferred", WRAP_UP:"wrap_up", CLOSING:"closing", ENDED:"ended" });
const TERMINAL = new Set([STATES.TRANSFERRED, STATES.ENDED]);
const TOPIC_LIMIT = 48;

export class TriageFlow {
  constructor({ taxonomy, guard, knowledge, directory, hris, tickets, priority, outages, routing, audit, transfer = null, hub = null, otp, now = () => nowDate(), options = {} }) {
    Object.assign(this, { taxonomy, guard, knowledge, directory, hris, tickets, priority, outages, routing, audit, transfer, hub, otp, now });
    this.options = { confidenceMin: config.classifierConfidenceMin, timeBudgetMs: config.callTimeBudgetMs, wrapUpMs: config.wrapUpMs, passwordResetTarget: config.passwordResetTarget, otpChannel: config.otpChannel, ...options };
    this.calls = new Map();
    this.agents = new Map();
  }
  create({ callId = randomUUID(), teamsUserId = null, fromPhone = null, simulation = true, sessionId = null, incomingCallContext = null, resourceAccountId = null } = {}) {
    const employee = teamsUserId ? this.directory.findByTeamsUserId(teamsUserId) : null;
    const call = { id: callId, sessionId: sessionId ?? callId, state: STATES.RINGING, simulation, incomingCallContext, resourceAccountId, arrival: resourceAccountId ? "teams-phone-extensibility" : "acs-direct", fromPhone, maskedPhone: maskPhone(fromPhone), employee, verified: Boolean(employee), verification: null, consentShareName: false, locale: config.locale, domain: null, topicId: null, pendingTopicId: null, pendingProposal: null, lastSpoken: null, transcript: [], startedAt: this.now().getTime(), answeredAt: null, endedAt: null, failures: 0, noInputs: 0, openIssue: null };
    this.calls.set(call.id, call);
    this.audit.startCall({ id: call.id, state: call.state, verified: call.verified, domain: call.domain, startedAt: call.startedAt, simulation });
    this.#event(call, "system", "call_created", call.verified ? "teams_verified" : "anonymous");
    return call;
  }
  get(id) { return this.calls.get(id) ?? null; }
  registerAgent(id, handle) { this.agents.set(id, handle); }
  recordAgentAction(id, { tool, ok = true, detail = null } = {}) { const call = this.get(id); if (call) this.#event(call, "agent", ok ? "tool" : "tool_rejected", detail ? `${tool}: ${detail}` : tool); }
  setCallConnection(id, callConnectionId) { const c = this.get(id); if (c) c.callConnectionId = callConnectionId; }
  answered(id) {
    const call = this.#require(id); call.answeredAt = this.now().getTime(); this.#setState(call, STATES.GREETING);
    const name = call.employee?.firstName ?? "there";
    const banner = this.outages.banner(this.now());
    const spoken = `Hi ${name}, this is the Contoso IT and HR help line. I'm an automated assistant.${banner ? ` ${banner}` : ""} What can I help you with?`;
    this.#speak(call, spoken); this.#setState(call, STATES.LISTENING); return call;
  }
  ingestUtterance(id, text) {
    const call = this.#require(id); const said = String(text ?? "").trim();
    if (!said) return this.noInput(id);
    if (TERMINAL.has(call.state)) return { ok:false, reason:"call_finished" };
    const guard = this.guard.check(said);
    if (guard.sensitive) return this.#sensitivePath(call, guard);
    this.pushTranscript(id, "caller", said);
    if (this.#budgetExpired(call)) return this.#expire(call);
    return { ok:true };
  }
  classify(utterance) { return this.taxonomy.classify(utterance, { confidenceMin: this.options.confidenceMin }); }
  answerQuestion(id, topicId, { locale = config.locale } = {}) {
    const call = this.#require(id); const topic = this.taxonomy.get(topicId); if (!topic) return { available:false, reason:"unknown_topic" };
    const result = this.knowledge.answer(topic.action.articleId, { locale, caller: call.employee, at: this.now() });
    if (!result.available) return { ...result, fallback: topic.action.fallback };
    call.domain = topic.domain; call.topicId = topicId; this.audit.updateCall(call.id, { domain: call.domain, topicId }); this.#event(call,"system","answered",result.article.id); this.#speak(call, result.text); this.#setState(call, STATES.LISTENING);
    return { ok:true, ...result, citation: result.article.id };
  }
  startVerification(id, email) {
    const call = this.#require(id); const employee = this.directory.findByEmail(email); this.#setState(call, STATES.VERIFYING);
    if (!employee) { this.#event(call,"system","verification","unknown_email"); this.#speak(call,"I could not find that work email in the demo directory."); return { ok:false, reason:"unknown_email" }; }
    const sent = this.otp.send(employee, this.options.otpChannel); call.verification = { email: employee.workEmail, expiresAt: sent.expiresAt, code: sent.code }; call.employee = employee;
    this.#event(call,"system","verification","code_sent"); this.#speak(call, `I sent a one-time code to the mobile number on your employee record. Please say or type the code.`); return { ok:true, sent:true, channel: this.options.otpChannel };
  }
  checkCode(id, code) {
    const call = this.#require(id); const v = call.verification;
    if (!v) return { ok:false, reason:"not_started" };
    if (this.now().getTime() > v.expiresAt) { this.#event(call,"system","verification","expired"); this.#speak(call,"That code has expired. I can send a new one if needed."); return { ok:false, reason:"expired" }; }
    if (String(code).replace(/\s+/g,"") !== v.code) { this.#event(call,"system","verification","failed"); this.#speak(call,"That code did not match."); return { ok:false, reason:"failed" }; }
    call.verified = true; this.audit.updateCall(call.id, { verified:true }); this.#event(call,"system","verification","verified"); this.#speak(call,"Thanks, you are verified."); return { ok:true, verified:true };
  }
  getPersonalAnswer(id, kind) {
    const call = this.#require(id); if (!call.verified || !call.employee) { this.#speak(call,"I need to verify you before sharing personal information."); return { ok:false, needsVerification:true }; }
    const ans = this.hris.answer(call.employee.workEmail, kind); this.#event(call,"system","personal_answer",kind); this.#speak(call, ans.spoken); this.#setState(call, STATES.LISTENING); return ans;
  }
  refusePersonal(id, reason = "not_allowed") { const call = this.#require(id); const spoken = "I can only share personal HR information about the verified caller, and never salary or another employee's data."; this.#event(call,"system","personal_refused",reason); this.#speak(call, spoken); return { ok:false, refused:true, reason }; }
  proposeTicket(id, { topicId, description, impact = "me", blocked = false } = {}) {
    const call = this.#require(id); const topic = this.taxonomy.get(topicId); if (!topic) throw new Error(`unknown topic ${topicId}`);
    if (!call.verified || !call.employee) { this.#speak(call,"I need to verify you before I can create a ticket."); return { ok:false, needsVerification:true }; }
    const outage = this.outages.match(description, this.now());
    if (outage) { const ticket = this.tickets.attachToIncident({ requester: call.employee.workEmail, parentIncident: outage.parentIncident, summary: `${topic.id}: ${description}` }); this.#event(call,"system","outage_attached",outage.parentIncident); this.#speak(call, `That's the outage I mentioned. I've added you to ${outage.parentIncident} so you'll get updates.`); return { ok:true, attachedToIncident:true, ticket }; }
    const priority = this.priority.priority({ impact: topic.action.impact ?? impact, blocked, securityCategory: topic.action.securityCategory });
    const asset = this.directory.matchDevice(call.employee, description);
    const proposalId = randomUUID(); const summary = clip(description || topic.examples?.[0] || topic.id, 120);
    call.pendingProposal = { proposalId, topicId, category: topic.action.category ?? "General", priority, summary, asset, securityCategory: topic.action.securityCategory, requester: call.employee.workEmail };
    this.#setState(call, STATES.CONFIRMING);
    const assetText = asset ? ` on your ${asset.type} ending in ${asset.serialLast4}` : "";
    this.#speak(call, `I'll file this: ${summary}${assetText}. ${blocked ? "You're blocked" : "You're not blocked"}, so that's priority ${priority.slice(1)}. File it?`);
    return { ok:true, proposal: call.pendingProposal, readback: call.lastSpoken };
  }
  fileTicket(id, proposalId, confirmation) {
    const call = this.#require(id); const p = call.pendingProposal;
    if (!p || p.proposalId !== proposalId) return { ok:false, reason:"missing_proposal" };
    if (!isAffirmative(confirmation)) { this.#event(call,"system","ticket_not_confirmed","no_explicit_confirmation"); this.#speak(call,"No problem — I won't file it unless you clearly confirm."); return { ok:false, reason:"not_confirmed" }; }
    const ticket = this.tickets.createTicket({ requester: p.requester, category: p.category, priority: p.priority, summary: p.summary, asset: p.asset });
    call.pendingProposal = null; call.lastTicket = ticket; this.#event(call,"system","ticket_created",ticket.number); this.#setState(call, STATES.FILED); this.#speak(call, `Your ticket is ${spellTicket(ticket.number)}. I'll send it to you in Teams chat.`);
    if (p.priority === "P1") { this.route(id, p.securityCategory ? "it-on-call" : "it-service-desk", `P1 ${p.category}`, { ticket }); }
    return { ok:true, ticket };
  }
  getMyTickets(id) {
    const call = this.#require(id); if (!call.verified || !call.employee) return { ok:false, needsVerification:true };
    const tickets = this.tickets.getMyTickets(call.employee.workEmail); const spoken = tickets.length ? tickets.map((t)=>`${t.number} is ${t.status}: ${t.lastUpdate}`).join(" ") : "I don't see any open demo tickets for you.";
    this.#speak(call, spoken); return { ok:true, tickets, spoken };
  }
  sendLink(id, target) { const call = this.#require(id); if (!call.verified) return { ok:false, needsVerification:true }; this.#event(call,"system","link_sent",target); this.#speak(call,"I sent that link in Teams chat."); return { ok:true }; }
  handoffPasswordReset(id, intent) {
    const call = this.#require(id); const topic = intent === "mfa_reregister" ? "MFA re-registration" : "Account unlock";
    if (!this.options.passwordResetTarget) {
      const topicId = intent === "mfa_reregister" ? "it-mfa-reregister" : "it-account-unlock";
      const resetTopic = this.taxonomy.get(topicId);
      const result = this.proposeTicket(id, { topicId, description: `${topic} needed`, blocked:true });
      if (result.ok && call.pendingProposal && resetTopic?.action?.fallback?.category) call.pendingProposal.category = resetTopic.action.fallback.category;
      return result;
    }
    const context = { intent, employeeHint: call.employee?.workEmail ?? null, sessionId: call.sessionId };
    this.#event(call,"system","password_reset_handoff",intent); this.#speak(call, `I'll connect you to our password reset assistant. It will verify you and ${intent === "unlock" ? "unlock your account" : "help re-register MFA"}.`);
    return this.#transfer(call, "password-reset-agent", topic, context);
  }
  route(id, destination, reason, extra = {}) { const call = this.#require(id); return this.#transfer(call, destination, reason, extra); }
  requestCallback(id, destination = "confidential-hr") { const call = this.#require(id); const c = this.tickets.createHrCase({ requester: call.employee?.workEmail ?? "anonymous", callback:true, consentShareName:call.consentShareName }); this.#event(call,"system","callback_requested",destination); this.#speak(call,"I created a confidential HR callback request for the next business day."); this.#finish(call, STATES.ENDED, "callback_requested"); return { ok:true, caseNumber:c.number }; }
  repeatLast(id) { const call = this.#require(id); if (call.lastSpoken) this.#speak(call, call.lastSpoken); return { ok:true, repeated:Boolean(call.lastSpoken) }; }
  dtmf(id, digit) { const call = this.#require(id); if (digit === "*") return this.repeatLast(id); if (digit === "0") return this.route(id, call.domain === "HR" ? "hr-shared-services" : "it-service-desk", "caller_pressed_zero"); return { ok:false, reason:"unmapped_digit" }; }
  noInput(id) { const call = this.#require(id); call.noInputs += 1; if (call.noInputs >= 2) { this.#speak(call,"I am not hearing anything, so I will end the call for now. Please call back when you are ready."); this.#finish(call, STATES.ENDED, "no_input"); return { ok:true, ended:true }; } this.#speak(call,"Sorry, I didn't catch that. How can I help?"); return { ok:true, clarify:true }; }
  checkBudget(id) { const call = this.get(id); if (!call) return { ok:false }; if (this.#budgetExpired(call)) return this.#expire(call); if (call.answeredAt && !call.wrapWarned && this.now().getTime() - call.answeredAt >= this.options.wrapUpMs) { call.wrapWarned = true; this.#setState(call, STATES.WRAP_UP); this.#speak(call,"We're almost out of time. I can file a ticket for anything still open."); return { ok:true, wrapUp:true }; } return { ok:true }; }
  endCall(id, outcome = "ended") { const call = this.get(id); if (!call || TERMINAL.has(call.state)) return { ok:true }; this.#finish(call, STATES.ENDED, outcome); return { ok:true }; }
  snapshot(id) {
    const c = this.get(id); if (!c) return null;
    const redact = (text) => redactDeviceSerials(c, text);
    return { id:c.id, state:c.state, caller:this.directory.publicProfile(c.employee, { verified:c.verified }), verified:c.verified, domain:c.domain, topicId:c.topicId, pendingProposal:c.pendingProposal ? { proposalId:c.pendingProposal.proposalId, topicId:c.pendingProposal.topicId, category:c.pendingProposal.category, priority:c.pendingProposal.priority, summary:c.pendingProposal.summary } : null, lastTicket:c.lastTicket, lastSpoken:redact(c.lastSpoken), transcript:c.transcript.map((t)=>({ ...t, text:redact(t.text) })), handoff:c.handoff ?? null, elapsedMs:(c.endedAt ?? this.now().getTime()) - c.startedAt, budgetMs:this.options.timeBudgetMs };
  }
  pushTranscript(id, role, text, opts = {}) { const call = this.get(id); if (!call || !text) return; const row = { role, text: opts.redacted ? "[redacted]" : text, at:this.now().toISOString() }; call.transcript.push(row); this.audit.recordTranscript(id, role, text, opts); this.#publish(call,"transcript",row); }
  #sensitivePath(call, guard) {
    this.#setState(call, STATES.SENSITIVE); this.#event(call,"system","confidential_hr",null); this.audit.recordTranscript(call.id,"caller","[redacted]",{ sensitive:true }); call.transcript.push({ role:"caller", text:"[redacted confidential HR]", at:this.now().toISOString() });
    if (guard.riskOfHarm) this.#speak(call, guard.safetyText);
    this.#speak(call, guard.acknowledgement);
    if (this.routing.isOpen("confidential-hr", this.now())) return this.#transfer(call, "confidential-hr", "Confidential HR", { confidential:true });
    this.#setState(call, STATES.AFTER_HOURS_OFFER); this.#speak(call, guard.afterHours); return { ok:true, sensitive:true, afterHours:true };
  }
  #transfer(call, destinationId, reason, extra = {}) {
    const destination = this.routing.get(destinationId); if (!destination) return { ok:false, reason:"unknown_destination" };
    const context = this.handoffContext(call, destinationId, reason, extra); call.handoff = context; this.#setState(call, STATES.TRANSFERRING); this.#event(call,"system","transfer",destinationId); this.#publish(call,"handoff",context);
    if (this.transfer) return Promise.resolve(this.transfer(call, { target:destination.target, context })).then(()=>{ this.#finish(call, STATES.TRANSFERRED, `transferred:${destinationId}`); return { ok:true, context }; });
    this.#finish(call, STATES.TRANSFERRED, `transferred:${destinationId}`, { simulated:true }); return { ok:true, simulated:true, context };
  }
  handoffContext(call, destinationId, reason, extra = {}) {
    if (destinationId === "confidential-hr") return { sessionId: call.sessionId, callTopic:"Confidential HR", callContext:"Confidential HR", destinationId, confidential:true, verifiedName: call.consentShareName ? call.employee?.displayName : undefined };
    if (destinationId === "password-reset-agent") return { sessionId: call.sessionId, callTopic: clip(reason, TOPIC_LIMIT), callContext: { intent: extra.intent, employeeHint: extra.employeeHint, sessionId: call.sessionId }, destinationId };
    return { sessionId: call.sessionId, callTopic: clip(ticketTopic(reason, extra.ticket), TOPIC_LIMIT), callContext: { verifiedName: call.employee?.displayName ?? null, ticketNumber: extra.ticket?.number ?? call.lastTicket?.number ?? null, priority: extra.ticket?.priority ?? call.pendingProposal?.priority ?? null, topic: call.topicId, matchedAsset: call.pendingProposal?.asset?.assetTag ?? null, tried: call.lastArticle ?? null }, destinationId };
  }
  #budgetExpired(call) { return call.answeredAt && !TERMINAL.has(call.state) && this.now().getTime() - call.answeredAt >= this.options.timeBudgetMs; }
  #expire(call) { this.#speak(call,"We have reached the time limit for this call. I will close it now so you can call back or reach the service desk."); this.#finish(call, STATES.ENDED, "time_budget_expired"); return { ok:true, expired:true }; }
  #finish(call, state, outcome, extra = {}) { call.endedAt = this.now().getTime(); call.outcome = outcome; this.#setState(call, state); this.audit.updateCall(call.id, { outcome, endedAt:new Date(call.endedAt).toISOString(), durationMs: call.endedAt-call.startedAt, ...extra }); }
  #setState(call, state) { if (call.state === state) return; const from = call.state; call.state = state; this.audit.updateCall(call.id, { state }); this.#event(call,"system","state",`${from} → ${state}`); this.#publish(call,"state",this.snapshot(call.id)); }
  #speak(call, text) { call.lastSpoken = text; this.pushTranscript(call.id,"agent",text); this.agents.get(call.id)?.instruct?.("", text); }
  #event(call, source, kind, detail) { this.audit.recordEvent(call.id, source, kind, detail); this.#publish(call,"event",{ source, kind, detail, at:this.now().toISOString() }); }
  #publish(call, target, payload) { this.hub?.send?.(call.id,target,payload); }
  #require(id) { const c = this.get(id); if (!c) throw new Error(`unknown call ${id}`); return c; }
}
function spellTicket(n) { return String(n).replace(/-/g, ", ").replace(/[A-Z]/g, (c)=>`${c},`).replace(/0/g,"0-").replace(/,$/,""); }
function ticketTopic(reason, ticket) { return ticket ? `${reason} ${ticket.priority}, ${ticket.number}` : reason; }

function redactDeviceSerials(call, text) {
  let out = String(text ?? "");
  for (const d of call.employee?.devices ?? []) if (d.serialLast4) out = out.replaceAll(String(d.serialLast4), "••••");
  return out;
}
