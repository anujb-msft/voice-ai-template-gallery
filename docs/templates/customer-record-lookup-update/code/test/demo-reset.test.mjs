// Demo reset: every run of the demo starts from the same records, the same metrics and the same day.
import { test } from "node:test";
import assert from "node:assert/strict";

import { STATES } from "../src/flow.mjs";
import { handleUtterance } from "../src/offline.mjs";
import { CREDIT_LIMIT, DEBRIEF, DEMO_DAY, makeFlow, startMobile, startTeams } from "./support.mjs";

const SEEDED = { accounts: 8, contacts: 9, opportunities: 6, activities: 2, tasks: 2, drafts: 0 };
const ALEX = { ownerId: "owner-alex" };

test("a records reset puts every seeded record back and forgets commits and audit rows", () => {
  const { flow, crm } = makeFlow();
  const id = startTeams(flow);
  handleUtterance(flow, id, DEBRIEF);
  assert.equal(handleUtterance(flow, id, "Yes, save it.").ok, true);
  assert.equal(crm.getOpportunity(ALEX, "opp-fab-renewal").amount, 240000);
  assert.ok(crm.auditRows().length > 0);
  assert.deepEqual(crm.counts(), { ...SEEDED, activities: 3, tasks: 3 });

  assert.deepEqual(crm.reset(), SEEDED);
  const renewal = crm.getOpportunity(ALEX, "opp-fab-renewal");
  assert.deepEqual([renewal.amount, renewal.stage, renewal.closeDate], [250000, "Negotiation", "2026-06-30"]);
  assert.equal(crm.getContact(ALEX, "contact-dana").phone, "+12065550120");
  assert.equal(crm.auditRows().length, 0);
  assert.equal(crm.committedActivityCount(), 0);
  assert.deepEqual(crm.fieldsWrittenByEntity(), {});
});

test("an audit reset zeroes the metrics but keeps any call from a real phone", () => {
  const { flow, crm, audit } = makeFlow();
  const id = startTeams(flow);
  handleUtterance(flow, id, "Brief me on Fabrikam");
  handleUtterance(flow, id, CREDIT_LIMIT);
  handleUtterance(flow, id, "Yes, put me through.");
  audit.startCall({ id: "live-1", simulated: false, startedAt: new Date(DEMO_DAY).toISOString() });
  audit.recordEvent("live-1", "agent", "briefing", "Fabrikam");

  const before = audit.stats(crm);
  assert.equal(before.calls, 2);
  assert.equal(before.lookups, 2);
  assert.equal(before.refusals, 1);
  assert.equal(before.handoffs, 1);

  audit.reset();
  crm.reset();
  const after = audit.stats(crm);
  assert.equal(after.calls, 1, "the real call stays");
  assert.equal(after.lookups, 1);
  assert.deepEqual([after.confirmedWrites, after.undoneWrites, after.refusals, after.handoffs, after.verificationFailures], [0, 0, 0, 0, 0]);
});

test("the metrics the console ends on are all reported", () => {
  const { crm, audit } = makeFlow();
  const stats = audit.stats(crm);
  for (const key of ["calls", "lookups", "confirmedWrites", "undoneWrites", "cancelledInWindow", "refusals", "handoffs", "verificationFailures", "averageHandleTimeSeconds"]) {
    assert.ok(Object.hasOwn(stats, key), key);
  }
  assert.deepEqual([stats.calls, stats.lookups, stats.confirmedWrites, stats.handoffs], [0, 0, 0, 0]);
});

test("a flow reset ends every call, simulated or not, without writing", () => {
  const { flow, crm } = makeFlow({ commitUndoMs: 5000 });
  const teams = startTeams(flow);
  const mobile = startMobile(flow);
  handleUtterance(flow, teams, DEBRIEF);
  handleUtterance(flow, teams, "Yes, save it.");
  assert.equal(flow.get(teams).state, STATES.COMMITTING);
  flow.reset();
  assert.equal(flow.get(teams), null);
  assert.equal(flow.get(mobile), null);
  assert.equal(crm.auditRows().length, 0);
  assert.equal(crm.getOpportunity(ALEX, "opp-fab-renewal").amount, 250000);
});

test("the demo-day clock fixes what is due: the same day reads 'due today', later days read 'overdue'", () => {
  let clock = DEMO_DAY;
  const { flow } = makeFlow({ now: () => clock });
  const first = startTeams(flow);
  handleUtterance(flow, first, "Brief me on Fabrikam");
  assert.match(flow.snapshot(first).briefing.phrase, /One task is due today: send the security questionnaire/);

  clock = Date.parse("2026-10-17T19:00:00Z");
  const later = startTeams(flow);
  handleUtterance(flow, later, "Brief me on Fabrikam");
  assert.match(flow.snapshot(later).briefing.phrase, /One task is overdue: send the security questionnaire/);
  assert.equal(flow.snapshot(later).record.dueTasks[0].overdue, true);
});
