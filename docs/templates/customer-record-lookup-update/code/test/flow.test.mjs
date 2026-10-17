import { test } from "node:test";
import assert from "node:assert/strict";

import { STATES, isExplicitSave } from "../src/flow.mjs";
import { handleUtterance } from "../src/offline.mjs";
import { DEBRIEF, DEMO_DAY, lastAgentLine, makeFlow as makeTestFlow, startMobile } from "./support.mjs";

function makeFlow({ now = DEMO_DAY } = {}) {
  return makeTestFlow({ now });
}

function start(flow) {
  const call = flow.startSimulation({ repId: "rep-alex" });
  return call.id;
}

function fullProposal(flow, id) {
  flow.findAccount(id, "Fabrikam");
  return flow.proposeUpdate(id, "acct-fabrikam", DEBRIEF);
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

test("keypad PIN digits collect one at a time; * starts again and # submits early", () => {
  const { flow } = makeFlow();
  const id = startMobile(flow);
  assert.equal(flow.dtmf(id, "2").digits, 1);
  assert.equal(flow.dtmf(id, "4").digits, 2);
  assert.equal(flow.dtmf(id, "*").cleared, true);
  assert.equal(flow.snapshot(id).identity.find((c) => c.id === "pin").detail, "Waiting for PIN");
  for (const d of "24681") flow.dtmf(id, d);
  assert.equal(flow.snapshot(id).identity.find((c) => c.id === "pin").detail, "5 of 6 digits");
  const done = flow.dtmf(id, "0");
  assert.equal(done.ok, true);
  assert.equal(flow.get(id).state, STATES.LISTENING);
  assert.ok(!JSON.stringify(flow.snapshot(id)).includes("246810"), "the PIN is never in the snapshot");

  const early = startMobile(flow);
  flow.dtmf(early, "1");
  const submitted = flow.dtmf(early, "#");
  assert.equal(submitted.reason, "wrong_pin");
  assert.equal(flow.get(early).state, STATES.TRANSFERRED);
});

test("identity is checked before anything is read out, and the checklist shows what was checked", () => {
  const { flow } = makeFlow();
  const id = startMobile(flow);
  const before = flow.snapshot(id);
  assert.equal(before.state, STATES.IDENTIFYING);
  assert.equal(before.record, null);
  assert.equal(before.identity.find((c) => c.id === "caller").detail, "Registered mobile, number ending 0197");
  assert.equal(before.identity.find((c) => c.id === "access").detail, "Locked until verified");
  handleUtterance(flow, id, "Brief me on Fabrikam");
  assert.equal(flow.get(id).state, STATES.IDENTIFYING, "spoken words are not a PIN");
  assert.equal(flow.snapshot(id).record, null);
  for (const d of "246810") flow.dtmf(id, d);
  handleUtterance(flow, id, "Brief me on Fabrikam");
  const after = flow.snapshot(id);
  assert.deepEqual(
    after.identity.map((c) => c.tone),
    ["ok", "ok", "ok", "idle"],
  );
  assert.equal(after.identity.find((c) => c.id === "contact").detail, "Withheld until asked for");
  assert.equal(after.record.contact.phone, null, "the card withholds the number until it is asked for");
  assert.deepEqual(after.record.withheld, ["Credit limit and payment terms — Sales Operations only"]);
  handleUtterance(flow, id, "What's Dana's number?");
  assert.equal(flow.snapshot(id).record.contact.phone, "206 555 0120");
  assert.match(lastAgentLine(flow, id), /206 555 0120/);
});

test("unknown callers are refused", () => {
  const { flow } = makeFlow();
  const call = flow.create({ fromPhone: "+14255550188" });
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
  assert.match(briefing.phrase, /One task is due today: send the security questionnaire/);
  assert.match(briefing.phrase, /Dana Ruiz/);
  assert.ok(briefing.handles.some((h) => h.handle === "opportunity:opp-fab-renewal"));
});

test("after its due date, the same task is read out as overdue, not due today", () => {
  const { flow } = makeFlow({ now: Date.parse("2026-06-12T19:00:00Z") });
  const id = start(flow);
  const briefing = flow.getBriefing(id, "acct-fabrikam");
  assert.match(briefing.phrase, /One task is overdue: send the security questionnaire/);
  assert.doesNotMatch(briefing.phrase, /due today/);
  assert.equal(flow.snapshot(id).record.dueTasks[0].overdue, true);
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

test("a bare yes to the read-back saves nothing and asks for 'yes, save it'", () => {
  const { flow, crm } = makeFlow();
  const id = start(flow);
  handleUtterance(flow, id, DEBRIEF);
  assert.equal(flow.get(id).state, STATES.CONFIRMING);
  const bare = handleUtterance(flow, id, "Yes");
  assert.equal(bare.reason, "not_confirmed");
  assert.equal(lastAgentLine(flow, id), `Say "yes, save it" if you want me to write this to Fabrikam's record.`);
  assert.equal(flow.get(id).state, STATES.CONFIRMING);
  assert.equal(flow.get(id).pendingCommit, null);
  assert.equal(crm.getOpportunity(flow.get(id).rep, "opp-fab-renewal").stage, "Negotiation");
  assert.equal(handleUtterance(flow, id, "Yes, save it.").ok, true);
  assert.equal(crm.getOpportunity(flow.get(id).rep, "opp-fab-renewal").stage, "Closed Won");
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
  crm.editRecord("opportunity", "opp-fab-renewal", "amount", 123);
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

  // On a live call a tool result is how a line reaches the model, so the closing rides in it.
  const third = makeFlow({ now: () => clock });
  const id3 = start(third.flow);
  clock += 480000;
  assert.equal(third.flow.findAccount(id3, "Fabrikam").phrase, "We're out of time, so I'll end the call here. Goodbye.");
  assert.equal(third.flow.get(id3).state, STATES.ENDED);
});

test("offline typed transcript drives end-to-end briefing, proposal, commit", () => {
  const { flow, crm } = makeFlow();
  const id = start(flow);
  assert.equal(handleUtterance(flow, id, "Brief me on Fabrikam").ok, true);
  assert.match(flow.snapshot(id).lastPhrase, /Fabrikam/);
  handleUtterance(flow, id, "What's Dana's number?");
  const proposal = handleUtterance(flow, id, DEBRIEF);
  assert.equal(proposal.ok, true);
  handleUtterance(flow, id, "yes, save it");
  assert.equal(crm.getOpportunity(flow.get(id).rep, "opp-fab-renewal").stage, "Closed Won");
});

test("a field the agent may not change is refused by policy, nothing is written, and a person is offered", () => {
  const { flow, crm } = makeFlow();
  const id = start(flow);
  const refused = handleUtterance(flow, id, "Raise Fabrikam's credit limit to 500k and move them to net 60 payment terms.");
  assert.equal(refused.reason, "refused_by_policy");
  assert.equal(refused.offeredHandoff, true);
  assert.match(refused.phrase, /The credit limit and the payment terms aren't on the list of things I can change by phone, so nothing was written/);
  assert.equal(crm.auditRows().length, 0);
  assert.deepEqual(flow.snapshot(id).offeredHandoff.labels, ["the credit limit", "the payment terms"]);
  assert.equal(flow.get(id).state, STATES.LISTENING);

  const declined = handleUtterance(flow, id, "No thanks.");
  assert.equal(declined.ok, true);
  assert.equal(flow.snapshot(id).offeredHandoff, null);
  assert.equal(flow.get(id).state, STATES.LISTENING);
});

