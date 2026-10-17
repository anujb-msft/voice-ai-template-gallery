// The undo window: after "yes, save it" the write waits, cancellable, before it commits.
// The window length is server policy (COMMIT_UNDO_MS); these tests use short windows.
import { test } from "node:test";
import assert from "node:assert/strict";

import { STATES } from "../src/flow.mjs";
import { handleUtterance } from "../src/offline.mjs";
import { DEBRIEF, DEMO_DAY, NEW_MOBILE, danaPhone, lastAgentLine, makeFlow, startTeams } from "./support.mjs";

function confirmNewMobile(flow) {
  const id = startTeams(flow);
  const proposal = handleUtterance(flow, id, NEW_MOBILE);
  assert.equal(proposal.ok, true);
  assert.match(proposal.readBack, /Dana Ruiz/);
  const yes = handleUtterance(flow, id, "Yes, save it.");
  return { id, yes };
}

test("a confirmed write waits out the undo window, then commits with an audit entry", async () => {
  const { flow, crm, audit } = makeFlow({ commitUndoMs: 120 });
  const { id, yes } = confirmNewMobile(flow);
  assert.equal(yes.ok, true);
  assert.equal(yes.pending, true);
  assert.equal(yes.windowMs, 120);
  assert.equal(flow.get(id).state, STATES.COMMITTING);
  assert.equal(danaPhone(flow, crm, id), "+12065550120", "nothing is written while the window is open");
  assert.equal(crm.auditRows().length, 0);

  const settled = await flow.afterUndoWindow(id);
  assert.equal(settled.settled, "committed");
  assert.match(danaPhone(flow, crm, id), /4255550143$/);
  const snap = flow.snapshot(id);
  assert.equal(snap.pendingCommit, null);
  assert.equal(snap.lastWrite.status, "committed");
  assert.equal(snap.lastWrite.auditRows, 1);
  assert.equal(snap.lastWrite.auditId, snap.lastWrite.commitId.slice(0, 8));
  assert.deepEqual(
    snap.lastWrite.rows.map((r) => [r.label, r.before, r.after]),
    [["Dana Ruiz · phone number", "ending 0120", "425 555 0143"]],
    "the card can show the change as before and after, the old number masked",
  );
  assert.equal(snap.state, STATES.COMMITTED);
  assert.match(lastAgentLine(flow, id), /Saved to Fabrikam's record/);
  const stats = audit.stats(crm);
  assert.equal(stats.confirmedWrites, 1);
  assert.equal(stats.undoneWrites, 0);
});

test("the console sees the window as server policy: start, end, length and time left", () => {
  const { flow } = makeFlow({ commitUndoMs: 5000 });
  const { id, yes } = confirmNewMobile(flow);
  const pending = flow.snapshot(id).pendingCommit;
  assert.equal(pending.windowMs, 5000);
  assert.equal(Date.parse(pending.commitsAt) - Date.parse(pending.startedAt), 5000);
  assert.equal(pending.commitsAt, yes.commitsAt);
  assert.ok(pending.remainingMs > 0 && pending.remainingMs <= 5000);
  assert.match(yes.phrase, /^Saving in five seconds\. Say "wait" to stop it\.$/);
  flow.cancelPendingCommit(id);
});

test("a mind change inside the window cancels it and nothing is written", () => {
  const { flow, crm, audit } = makeFlow({ commitUndoMs: 5000 });
  const { id } = confirmNewMobile(flow);
  const wait = handleUtterance(flow, id, "Wait, no — keep the old number.");
  assert.equal(wait.ok, true);
  assert.equal(wait.cancelled, true);
  assert.equal(wait.wrote, false);
  assert.equal(wait.phrase, "Stopped. Nothing was written: Dana Ruiz's number is still the one ending 0120.");
  const snap = flow.snapshot(id);
  assert.equal(snap.pendingCommit, null);
  assert.equal(snap.lastWrite.status, "cancelled");
  assert.equal(snap.lastWrite.auditRows, 0);
  assert.equal(snap.proposal, null, "the cancelled change is gone, not waiting for another yes");
  assert.equal(snap.state, STATES.LISTENING);
  assert.equal(danaPhone(flow, crm, id), "+12065550120");
  assert.equal(crm.auditRows().length, 0);
  const stats = audit.stats(crm);
  assert.equal(stats.confirmedWrites, 0);
  assert.equal(stats.undoneWrites, 1);
  assert.equal(stats.cancelledInWindow, 1);
});

test("every way of changing your mind inside the window stops the write", () => {
  for (const said of ["Wait", "Stop!", "No, cancel that.", "Hold on", "Never mind", "Don't save it", "Undo that", "Scratch that", "I changed my mind", "Keep the current one"]) {
    const { flow, crm } = makeFlow({ commitUndoMs: 5000 });
    const { id } = confirmNewMobile(flow);
    const result = handleUtterance(flow, id, said);
    assert.equal(result.cancelled, true, said);
    assert.equal(crm.auditRows().length, 0, said);
  }
});

test("inside the window other requests wait their turn and nothing new is proposed", () => {
  const { flow, crm } = makeFlow({ commitUndoMs: 5000 });
  const { id } = confirmNewMobile(flow);
  for (const said of [DEBRIEF, "Yes, save it.", "Pause"]) {
    const held = handleUtterance(flow, id, said);
    assert.equal(held.reason, "commit_pending", said);
    assert.match(held.phrase, /I'm saving the last change/);
  }
  assert.equal(flow.commitProposal(id, null, "yes, save it").reason, "commit_pending");
  assert.equal(flow.proposeUpdate(id, "acct-fabrikam", DEBRIEF).reason, "commit_pending");
  assert.equal(flow.get(id).state, STATES.COMMITTING);
  assert.equal(crm.auditRows().length, 0);
  flow.cancelPendingCommit(id);
});

test("undo inside the window cancels; after the window it reverts the committed write", async () => {
  const { flow, crm, audit } = makeFlow({ commitUndoMs: 60 });
  let { id } = confirmNewMobile(flow);
  assert.equal(flow.undoLastCommit(id).cancelled, true);
  assert.equal(crm.auditRows().length, 0);

  ({ id } = confirmNewMobile(flow));
  await flow.afterUndoWindow(id);
  assert.match(danaPhone(flow, crm, id), /4255550143$/);
  const tooLate = handleUtterance(flow, id, "Wait, keep the old one.");
  assert.equal(tooLate.reason, "already_committed");
  assert.match(tooLate.phrase, /already saved/);
  const undo = handleUtterance(flow, id, "Undo that");
  assert.equal(undo.ok, true);
  assert.equal(danaPhone(flow, crm, id), "+12065550120");
  assert.equal(flow.snapshot(id).lastWrite.status, "undone");
  const stats = audit.stats(crm);
  assert.equal(stats.confirmedWrites, 1);
  assert.equal(stats.undoneWrites, 2);
  assert.equal(stats.cancelledInWindow, 1);
});

test("hanging up inside the window still lands the write the caller confirmed", () => {
  const { flow, crm } = makeFlow({ commitUndoMs: 5000 });
  const { id } = confirmNewMobile(flow);
  flow.endCall(id, "caller_hung_up");
  assert.equal(flow.get(id).state, STATES.ENDED);
  assert.equal(flow.snapshot(id).pendingCommit, null);
  assert.equal(flow.snapshot(id).lastWrite.status, "committed");
  assert.match(danaPhone(flow, crm, id), /4255550143$/);
});

test("asking for a person inside the window commits first, and the handoff says what was saved", () => {
  const { flow, crm } = makeFlow({ commitUndoMs: 5000 });
  const { id } = confirmNewMobile(flow);
  const result = handleUtterance(flow, id, "Actually, I need a person.");
  assert.equal(result.ok, true);
  assert.equal(flow.get(id).state, STATES.TRANSFERRED);
  assert.match(danaPhone(flow, crm, id), /4255550143$/);
  const context = JSON.parse(flow.snapshot(id).handoff.callContext);
  assert.match(context.lastWrite, /^Saved/);
  assert.ok(!flow.snapshot(id).handoff.callContext.includes("0143"), "the new number stays out of the handoff");
});

test("settleAll waits for open windows, but only so long", async () => {
  const quick = makeFlow({ commitUndoMs: 80 });
  const first = confirmNewMobile(quick.flow);
  const settled = await quick.flow.settleAll(2000);
  assert.deepEqual([settled.ok, settled.waited, settled.outcome], [true, 1, "settled"]);
  assert.equal(quick.flow.snapshot(first.id).lastWrite.status, "committed");

  const slow = makeFlow({ commitUndoMs: 5000 });
  const second = confirmNewMobile(slow.flow);
  const bounded = await slow.flow.settleAll(40);
  assert.deepEqual([bounded.ok, bounded.outcome], [false, "timeout"]);
  assert.ok(slow.flow.snapshot(second.id).pendingCommit, "the window is still open");
  slow.flow.cancelPendingCommit(second.id);
  assert.deepEqual(await quick.flow.settleAll(40), { ok: true, waited: 0 });
});

test("a demo reset closes open windows without writing", async () => {
  const { flow, crm } = makeFlow({ commitUndoMs: 5000 });
  const { id } = confirmNewMobile(flow);
  const closed = flow.afterUndoWindow(id);
  flow.reset();
  assert.equal((await closed).settled, "reset");
  assert.equal(flow.get(id), null);
  assert.equal(crm.auditRows().length, 0);
  assert.equal(crm.getContact({ ownerId: "owner-alex" }, "contact-dana").phone, "+12065550120");
});

test("COMMIT_UNDO_MS=0 commits at once", () => {
  const { flow, crm } = makeFlow({ commitUndoMs: 0 });
  const { id, yes } = confirmNewMobile(flow);
  assert.equal(yes.pending, undefined);
  assert.ok(yes.commitId);
  assert.equal(flow.snapshot(id).pendingCommit, null);
  assert.match(danaPhone(flow, crm, id), /4255550143$/);
});

test("moving the demo clock keeps an open window's length and time left", () => {
  let clock = DEMO_DAY;
  const { flow } = makeFlow({ now: () => clock, commitUndoMs: 5000 });
  const { id } = confirmNewMobile(flow);
  const before = flow.snapshot(id).pendingCommit;
  clock += 86_400_000;
  flow.rebaseClock(86_400_000);
  const after = flow.snapshot(id).pendingCommit;
  assert.equal(Date.parse(after.commitsAt) - Date.parse(after.startedAt), 5000);
  assert.equal(Date.parse(after.startedAt) - Date.parse(before.startedAt), 86_400_000);
  assert.ok(after.remainingMs > 0);
  flow.cancelPendingCommit(id);
});
