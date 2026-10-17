import { test } from "node:test";
import assert from "node:assert/strict";

import { STATES } from "../src/flow.mjs";
import { handleUtterance } from "../src/offline.mjs";
import { NEW_MOBILE, lastAgentLine, makeFlow, startTeams } from "./support.mjs";

const ALEX_TEAMS = "8:orgid:11111111-1111-1111-1111-111111111111";

/** A real (not simulated) call. The stub transfer stands in for ACS accepting the request, and counts dispatches. */
function liveFlow() {
  let dispatches = 0;
  const made = makeFlow({ transfer: async () => { dispatches += 1; } });
  return { ...made, dispatches: () => dispatches };
}

function sorryLines(flow, callId) {
  return flow.snapshot(callId).transcript.filter((t) => t.role === "agent" && /I'm sorry/.test(t.text));
}

test("CallTransferFailed after ACS accepted: one honest line, the update kept as a draft, never re-dispatched", async () => {
  const { flow, crm, audit, dispatches } = liveFlow();
  const id = flow.create({ teamsUserId: ALEX_TEAMS }).id;
  flow.answer(id);
  assert.equal(flow.get(id).simulated, false);
  assert.equal(handleUtterance(flow, id, NEW_MOBILE).ok, true, "a proposal is open when the rep asks for a person");
  const sent = await flow.transfer(id, "explicit_request");
  assert.equal(sent.ok, true);
  assert.equal(flow.get(id).state, STATES.TRANSFERRED);
  assert.equal(audit.stats(crm).handoffs, 1);

  const first = flow.transferFailed(id, "Call was not answered.");
  assert.deepEqual([first.ok, first.reason, first.draft], [false, "transfer_failed", true]);
  const second = flow.transferFailed(id, "Call was not answered.");
  assert.deepEqual(second, { ok: false, reason: "nothing_to_recover" });

  assert.equal(dispatches(), 1, "exactly one dispatch: the failure never re-dispatches");
  const snap = flow.snapshot(id);
  assert.equal(snap.state, STATES.ENDED);
  assert.equal(snap.outcome, "transfer_failed");
  assert.equal(snap.handoff, null);
  assert.equal(lastAgentLine(flow, id), "I'm sorry, I couldn't reach Contoso Sales Operations after all. Your Fabrikam update is saved as a draft. Please try again later. Goodbye.");
  assert.equal(sorryLines(flow, id).length, 1, "the line is said once");
  assert.equal(crm.auditRows().length, 0, "nothing was written");

  const failures = audit.eventsFor(id).filter((e) => e.kind === "transfer_failed");
  assert.equal(failures.length, 1);
  assert.match(failures[0].detail, /^Call was not answered · after ACS accepted$/);
  const stats = audit.stats(crm);
  assert.deepEqual([stats.handoffs, stats.transfers, stats.failedTransfers, stats.draftsSaved], [0, 0, 1, 1], "a failed transfer is not a handoff");
});

test("an unverified caller whose safe handoff fails hears that no records were opened", async () => {
  const { flow, crm, audit, dispatches } = liveFlow();
  const id = flow.create({ fromPhone: "+14255550197" }).id;
  flow.answer(id);
  const failed = await flow.submitPin(id, "135790");
  assert.deepEqual([failed.reason, failed.transferred], ["wrong_pin", true]);
  assert.equal(flow.get(id).state, STATES.TRANSFERRED);

  assert.equal(flow.transferFailed(id, "Call was not answered.").reason, "transfer_failed");
  assert.equal(flow.transferFailed(id).reason, "nothing_to_recover");
  assert.equal(dispatches(), 1);
  assert.equal(flow.get(id).state, STATES.ENDED);
  assert.equal(flow.get(id).outcome, "transfer_failed");
  assert.equal(lastAgentLine(flow, id), "I'm sorry, I couldn't reach Contoso Sales Operations after all. No records were opened. Please try again later. Goodbye.");
  assert.equal(flow.snapshot(id).record, null);
  const stats = audit.stats(crm);
  assert.deepEqual([stats.handoffs, stats.failedTransfers, stats.verificationFailures], [0, 1, 1]);
});

test("a simulated call, an unknown call or a live call that was never transferred cannot be reopened", async () => {
  const { flow, crm, audit, dispatches } = liveFlow();
  const simulated = startTeams(flow);
  const handed = flow.transfer(simulated, "explicit_request");
  assert.deepEqual([handed.ok, handed.simulated], [true, true]);
  assert.equal(flow.get(simulated).state, STATES.TRANSFERRED);
  assert.deepEqual(flow.transferFailed(simulated, "Call was not answered."), { ok: false, reason: "nothing_to_recover" });
  assert.equal(flow.get(simulated).state, STATES.TRANSFERRED, "a simulated handoff stays handed off");
  assert.equal(flow.get(simulated).outcome, "transferred:explicit_request");
  assert.equal(sorryLines(flow, simulated).length, 0);

  assert.deepEqual(flow.transferFailed("no-such-call"), { ok: false, reason: "nothing_to_recover" });

  const live = flow.create({ teamsUserId: ALEX_TEAMS }).id;
  flow.answer(live);
  assert.deepEqual(flow.transferFailed(live), { ok: false, reason: "nothing_to_recover" }, "still talking to the agent: nothing to recover");
  assert.equal(flow.get(live).state, STATES.LISTENING);

  assert.equal(dispatches(), 0, "a simulated call is never dispatched");
  assert.equal(audit.stats(crm).failedTransfers, 0);
});
