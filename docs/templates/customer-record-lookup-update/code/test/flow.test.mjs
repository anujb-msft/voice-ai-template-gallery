import { test } from "node:test";
import assert from "node:assert/strict";

import { SqliteCrmAdapter } from "../src/db.mjs";
import { MemoryAudit } from "../src/audit.mjs";
import { CustomerRecordFlow, STATES, isExplicitSave } from "../src/flow.mjs";
import { RepDirectory } from "../src/providers/crm.mjs";
import { handleUtterance } from "../src/offline.mjs";

function makeFlow({ now = Date.parse("2026-06-10T19:00:00Z") } = {}) {
  const crm = new SqliteCrmAdapter({ path: ":memory:" });
  const audit = new MemoryAudit({ persistTranscripts: false, afterCallMinutesBaseline: 6 });
  const reps = RepDirectory.load();
  const flow = new CustomerRecordFlow({ crm, reps, audit, now: typeof now === "function" ? now : () => now, options: { callTimeBudgetMs: 480000, wrapUpMs: 420000 } });
  return { flow, crm, audit, reps };
}

function start(flow) {
  const call = flow.startSimulation({ repId: "rep-alex" });
  return call.id;
}

function fullProposal(flow, id) {
  flow.findAccount(id, "Fabrikam");
  return flow.proposeUpdate(id, "acct-fabrikam", "Log the Fabrikam meeting. Dana agreed to the renewal at 240k, moving to Closed Won pending signature, close date June 15th. Remind me to send the contract Friday.");
}

test("known Teams user is identified and hears AI disclosure", () => {
  const { flow } = makeFlow();
  const id = start(flow);
  const snap = flow.snapshot(id);
  assert.equal(snap.rep.displayName, "Alex Morgan");
  assert.equal(snap.rep.verifiedBy, "teams-user");
  assert.match(snap.transcript[0].text, /automated agent/);
});

test("registered PSTN mobile requires a correct PIN", () => {
  const { flow } = makeFlow();
  const call = flow.create({ fromPhone: "+14255550197" });
  assert.equal(flow.answer(call.id).needsPin, true);
  assert.equal(flow.submitPin(call.id, "000000").reason, "wrong_pin");

  const second = flow.create({ fromPhone: "+14255550197" });
  flow.answer(second.id);
  const ok = flow.submitPin(second.id, "246810");
  assert.equal(ok.ok, true);
  assert.equal(flow.snapshot(second.id).rep.verifiedBy, "pstn-pin");
});

test("unknown callers are refused", () => {
  const { flow } = makeFlow();
  const call = flow.create({ fromPhone: "+14255559999" });
  const result = flow.answer(call.id);
  assert.equal(result.reason, "unknown_caller");
  assert.equal(flow.get(call.id).state, STATES.REFUSED);
  assert.match(flow.snapshot(call.id).transcript.at(-1).text, /Contoso sales staff/);
});

test("owned and account-team accounts are visible, other reps' private accounts are hidden", () => {
  const { flow } = makeFlow();
  const id = start(flow);
  assert.equal(flow.findAccount(id, "Fabrikam").status, "confirmed");
  assert.equal(flow.findAccount(id, "Northwind").status, "confirmed", "Alex is on the Northwind account team");
  assert.equal(flow.findAccount(id, "Tailspin").status, "no_match");
});

test("account matching handles candidates and spelled names", () => {
  const { flow } = makeFlow();
  const id = start(flow);
  const candidates = flow.findAccount(id, "co");
  assert.equal(candidates.status, "candidates");
  assert.ok(candidates.candidates.length >= 1);
  assert.equal(flow.findAccount(id, "spelled f a b r i k a m").status, "confirmed");
});

test("briefing follows the fixed order and exposes drill-in handles", () => {
  const { flow } = makeFlow();
  const id = start(flow);
  const briefing = flow.getBriefing(id, "acct-fabrikam");
  assert.equal(briefing.ok, true);
  assert.match(briefing.phrase, /Fabrikam, Strategic tier, your account/);
  assert.match(briefing.phrase, /Last touch/);
  assert.match(briefing.phrase, /open deals/);
  assert.match(briefing.phrase, /due today/);
  assert.match(briefing.phrase, /Dana Ruiz/);
  assert.ok(briefing.handles.some((h) => h.handle === "opportunity:opp-fab-renewal"));
});

test("briefing drill-ins and contact details are gated", () => {
  const { flow } = makeFlow();
  const id = start(flow);
  const briefing = flow.getBriefing(id, "acct-fabrikam");
  const detail = flow.getDetail(id, "opportunity:opp-fab-renewal");
  assert.match(detail.phrase, /Enterprise renewal/);
  assert.ok(!JSON.stringify(briefing).includes("12065550120"), "phone is not in model context by default");
  const phone = flow.getContactInfo(id, "contact-dana", "phone");
  assert.equal(phone.value, "+12065550120");
});

test("a full debrief creates activity, opportunity diffs, and a task read-back", () => {
  const { flow } = makeFlow();
  const id = start(flow);
  const result = fullProposal(flow, id);
  assert.equal(result.ok, true);
  assert.match(result.readBack, /meeting activity with Dana Ruiz/);
  assert.match(result.readBack, /stage from Negotiation to Closed Won/);
  assert.match(result.readBack, /amount from 250 thousand to 240 thousand/);
  assert.match(result.readBack, /close date from June 30 to June 15/);
  assert.match(result.readBack, /send the contract/);
});

test("amendment rebuilds proposal before writing", () => {
  const { flow } = makeFlow();
  const id = start(flow);
  const p = fullProposal(flow, id);
  const amended = flow.amendProposal(id, p.proposalId, "Actually keep it in Negotiation.");
  assert.doesNotMatch(amended.readBack, /stage from/);
  assert.match(amended.readBack, /amount from 250 thousand to 240 thousand/);
});

test("field allow-list refuses discount, owner change, delete, invalid stage and bad dates", () => {
  const { flow } = makeFlow();
  const id = start(flow);
  const discount = flow.proposeUpdate(id, "acct-fabrikam", "Give them a 10 percent discount and reassign the account to Jordan and delete the old account.");
  assert.deepEqual(discount.refused.map((r) => r.field).sort(), ["delete", "discount", "owner"].sort());
  const invalid = flow.proposeUpdate(id, "acct-fabrikam", "Move the renewal to Closed Happy, close date June 1. Remind me to send paperwork 12/31.");
  assert.ok(invalid.refused.some((r) => r.field === "stage"));
  assert.ok(invalid.refused.some((r) => r.field === "closeDate"));
  assert.ok(invalid.refused.some((r) => r.field === "dueDate"));
});

test("maybe is not a confirmation and explicit save is", () => {
  assert.equal(isExplicitSave("maybe"), false);
  assert.equal(isExplicitSave("I think so"), false);
  assert.equal(isExplicitSave("yes, save it"), true);
  const { flow } = makeFlow();
  const id = start(flow);
  const p = fullProposal(flow, id);
  assert.equal(flow.commitProposal(id, p.proposalId, "maybe").reason, "not_confirmed");
  assert.equal(flow.commitProposal(id, p.proposalId, "yes, save it").ok, true);
});

test("confirmed commit writes every field with audit rows and no transcript persistence", () => {
  const { flow, crm, audit } = makeFlow();
  const id = start(flow);
  const p = fullProposal(flow, id);
  const commit = flow.commitProposal(id, p.proposalId, "yes, save it");
  assert.equal(commit.ok, true);
  const opp = crm.getOpportunity(flow.get(id).rep, "opp-fab-renewal");
  assert.equal(opp.stage, "Closed Won");
  assert.equal(opp.amount, 240000);
  assert.equal(opp.closeDate, "2026-06-15");
  const rows = crm.auditRows(commit.commitId);
  assert.ok(rows.length >= 8);
  assert.ok(rows.some((r) => r.entity === "opportunity" && r.field === "amount" && r.before_value === "250000" && r.after_value === "240000"));
  assert.equal(audit.transcripts.length, 0);
});

test("undo restores committed values and undo conflict is reported", () => {
  const { flow, crm } = makeFlow();
  const id = start(flow);
  let p = fullProposal(flow, id);
  flow.commitProposal(id, p.proposalId, "yes, save it");
  assert.equal(flow.undoLastCommit(id).ok, true);
  assert.equal(crm.getOpportunity(flow.get(id).rep, "opp-fab-renewal").amount, 250000);

  p = fullProposal(flow, id);
  const commit = flow.commitProposal(id, p.proposalId, "yes, save it");
  crm.db.prepare("UPDATE opportunities SET amount = 123 WHERE id = 'opp-fab-renewal'").run();
  const conflict = crm.revertCommit(flow.get(id).rep, commit.commitId);
  assert.equal(conflict.reason, "conflict");
});

test("hang-up, call me back later, and resume draft preserve proposals without field writes", () => {
  const { flow, crm } = makeFlow();
  const id = start(flow);
  const p = fullProposal(flow, id);
  const draft = flow.saveDraft(id, p.proposalId, "caller_requested");
  assert.equal(draft.ok, true);
  assert.equal(crm.getOpportunity(flow.get(id).rep, "opp-fab-renewal").amount, 250000);
  const resumed = flow.resumeDraft(id);
  assert.equal(resumed.ok, true);
  assert.match(resumed.readBack, /Save it/);
});

test("pause, continue, DTMF shortcuts, two failures and two no-inputs work", () => {
  const { flow } = makeFlow();
  let id = start(flow);
  assert.equal(flow.pause(id).ok, true);
  assert.equal(flow.get(id).state, STATES.PAUSED);
  assert.equal(flow.continue(id).ok, true);
  assert.equal(flow.dtmf(id, "*").ok, true);
  assert.equal(flow.dtmf(id, "0").ok, true);
  assert.equal(flow.get(id).state, STATES.TRANSFERRED);

  id = start(flow);
  flow.findAccount(id, "Tailspin");
  const secondFailure = flow.findAccount(id, "Tailspin");
  assert.equal(secondFailure.simulated, true);
  assert.equal(flow.get(id).state, STATES.TRANSFERRED);

  id = start(flow);
  flow.noInput(id);
  flow.noInput(id);
  assert.equal(flow.get(id).state, STATES.ENDED);
});

test("wrap-up saves a draft and expired cap ends the call", () => {
  let clock = Date.parse("2026-06-10T19:00:00Z");
  const { flow } = makeFlow({ now: () => clock });
  const id = start(flow);
  fullProposal(flow, id);
  clock += 420000;
  assert.equal(flow.checkBudget(id).ok, true);
  assert.equal(flow.get(id).state, STATES.LISTENING);

  const later = makeFlow({ now: () => clock });
  const id2 = start(later.flow);
  clock += 480000;
  assert.equal(later.flow.checkBudget(id2).ok, true);
  assert.equal(later.flow.get(id2).state, STATES.ENDED);
});

test("offline typed transcript drives end-to-end briefing, proposal, commit", () => {
  const { flow, crm } = makeFlow();
  const id = start(flow);
  assert.equal(handleUtterance(flow, id, "Brief me on Fabrikam").ok, true);
  assert.match(flow.snapshot(id).lastPhrase, /Fabrikam/);
  handleUtterance(flow, id, "What's Dana's number?");
  const proposal = handleUtterance(flow, id, "Log the Fabrikam meeting. Dana agreed to the renewal at 240k, moving to Closed Won pending signature, close date June 15th. Remind me to send the contract Friday.");
  assert.equal(proposal.ok, true);
  handleUtterance(flow, id, "yes, save it");
  assert.equal(crm.getOpportunity(flow.get(id).rep, "opp-fab-renewal").stage, "Closed Won");
});

