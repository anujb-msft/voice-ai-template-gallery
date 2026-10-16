import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAudit } from "../src/audit.mjs";
import { PagerFlow, SimulatedDialer, STATES } from "../src/flow.mjs";
import { PagerPolicy } from "../src/policy.mjs";
import { TeamsNotifier } from "../src/notifications.mjs";
import { runTranscript } from "../src/offline.mjs";

const leakTranscript = ["yes unit 4B at Maple Court", "water is coming through the kitchen ceiling", "permission to enter, lockbox at the back door", "call me at 555-123-0001"];
const rejected = (statusCode, message) => Object.assign(new Error(message), { statusCode, details: { error: { code: "BadRequest", message } } });
const unreachable = async () => { throw new TypeError("fetch failed"); };

// Simulated dialer whose next N page or status placements throw, as createCall does when a request is rejected.
class FlakyDialer extends SimulatedDialer {
  constructor({ pageFailures = 0, statusFailures = 0 } = {}) { super(); this.pageFailures = pageFailures; this.statusFailures = statusFailures; }
  async pageTechnician(payload) {
    if (this.pageFailures > 0) { this.pageFailures -= 1; throw rejected(400, "Invalid request."); }
    return super.pageTechnician(payload);
  }
  async statusCall(payload) {
    if (this.statusFailures > 0) { this.statusFailures -= 1; throw new TypeError("Cannot read properties of undefined (reading 'communicationUserId')"); }
    return super.statusCall(payload);
  }
}
function harness({ dialer = new FlakyDialer(), notifier = new TeamsNotifier() } = {}) {
  let nowMs = Date.parse("2026-09-30T23:42:00-07:00");
  const audit = new MemoryAudit();
  const flow = new PagerFlow({ policy: PagerPolicy.load(), audit, dialer, notifier, now: () => nowMs });
  return { flow, audit, dialer, notifier, advance: (minutes) => { nowMs += minutes * 60_000; }, now: () => nowMs };
}
const event = (audit, incidentId, kind) => audit.eventsFor(incidentId).find((e) => e.kind === kind);
const pendingPages = (audit, incidentId) => audit.pendingJobs().filter((j) => j.incidentId === incidentId && j.kind === "page");
const runningJobs = (audit) => [...audit.jobs.values()].filter((j) => j.status === "running");

await test("a page that cannot be placed is a failed attempt and the primary is retried after the gap", async () => {
  const h = harness({ dialer: new FlakyDialer({ pageFailures: 1 }) });
  const r = await runTranscript(h.flow, { transcript: leakTranscript });
  const id = r.submitted.incidentId;

  assert.deepEqual(h.audit.attemptsFor(id).map((a) => `${a.level}:${a.attempt}:${a.outcome}`), ["primary:1:failed"]);
  assert.equal(event(h.audit, id, "page_attempt").detail, "primary:1:failed");
  assert.equal(event(h.audit, id, "page_failed").detail, "primary:1: 400 Invalid request.");
  assert.equal(h.audit.jobs.get(`page:${id}:primary:1`).status, "done");
  assert.deepEqual(runningJobs(h.audit), []);
  const [next] = pendingPages(h.audit, id);
  assert.equal(next.id, `page:${id}:primary:2`);
  assert.equal(Date.parse(next.dueAt) - h.now(), 3 * 60_000);
  assert.equal(h.dialer.calls.filter((c) => c.kind === "page").length, 0);

  h.advance(3);
  h.flow.setNextPageOutcomes(["accept"]);
  await h.flow.processDueJobs();
  assert.equal(h.audit.getIncident(id).state, STATES.CLOSED);
  assert.deepEqual(h.audit.attemptsFor(id).map((a) => a.outcome), ["failed", "accept"]);
});

await test("a scheduler tick resolves with a serialisable failure result instead of throwing", async () => {
  const h = harness();
  const r = await runTranscript(h.flow, { transcript: leakTranscript, pageOutcomes: ["no-answer"] });
  const id = r.submitted.incidentId;
  h.dialer.pageFailures = 1;
  h.advance(3);
  const processed = await h.flow.processDueJobs();
  const [result] = JSON.parse(JSON.stringify(processed));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "page_failed");
  assert.equal(result.error, "400 Invalid request.");
  assert.equal(result.next.scheduled, `page:${id}:secondary:1`);
  assert.equal(h.audit.jobs.get(`page:${id}:primary:2`).status, "done");
});

await test("when every page fails the chain escalates to the end and the 20-minute alert still fires", async () => {
  const h = harness({ dialer: new FlakyDialer({ pageFailures: Infinity }) });
  const r = await runTranscript(h.flow, { transcript: leakTranscript });
  const id = r.submitted.incidentId;
  let last;
  for (let tick = 0; tick < 5; tick += 1) {
    h.advance(3);
    [last] = await h.flow.processDueJobs();
    assert.equal(last.reason, "page_failed");
  }
  assert.deepEqual(last.next, { ok: true, exhausted: true });
  assert.deepEqual(h.audit.attemptsFor(id).map((a) => `${a.level}:${a.attempt}:${a.outcome}`), [
    "primary:1:failed", "primary:2:failed", "secondary:1:failed", "secondary:2:failed", "propertyManager:1:failed", "propertyManager:2:failed",
  ]);
  assert.deepEqual(pendingPages(h.audit, id), []);
  assert.deepEqual(runningJobs(h.audit), []);

  h.advance(5);
  await h.flow.processDueJobs();
  assert.equal(h.audit.getIncident(id).state, STATES.UNACKNOWLEDGED_ALERT);
  assert.equal(h.notifier.sent.at(-1).kind, "opsAlert");
  assert.equal(h.dialer.calls.at(-1).kind, "status");
});

await test("forcing a page that cannot be placed returns the failure and escalates", async () => {
  const h = harness();
  const r = await runTranscript(h.flow, { transcript: leakTranscript, pageOutcomes: ["no-answer"] });
  const id = r.submitted.incidentId;
  h.dialer.pageFailures = 1;
  const result = await h.flow.forceNextPage(id, "accept");
  assert.equal(result.reason, "page_failed");
  assert.equal(h.audit.jobs.get(`page:${id}:primary:2`).status, "done");
  assert.equal(h.audit.getIncident(id).acknowledgedAt, null);
  assert.equal(pendingPages(h.audit, id)[0].id, `page:${id}:secondary:1`);
});

await test("a tenant status call that cannot be placed is logged and the acknowledged incident still closes", async () => {
  const h = harness({ dialer: new FlakyDialer({ statusFailures: 1 }) });
  const r = await runTranscript(h.flow, { transcript: leakTranscript, pageOutcomes: ["accept"] });
  const id = r.submitted.incidentId;
  const incident = h.audit.getIncident(id);
  assert.equal(incident.state, STATES.CLOSED);
  assert.ok(incident.acknowledgedAt);
  assert.match(event(h.audit, id, "status_call_failed").detail, /^acknowledged: Cannot read properties of undefined/);
  assert.equal(event(h.audit, id, "tenant_status_call"), undefined);
  assert.equal(h.audit.jobs.get(`page:${id}:primary:1`).status, "done");
  assert.deepEqual(h.audit.pendingJobs().filter((j) => j.incidentId === id), []);
});

await test("the unacknowledged alert completes when the ops post and the status call both fail", async () => {
  const notifier = new TeamsNotifier({ opsWorkflowUrl: "https://example.invalid/ops", fetchImpl: unreachable });
  const h = harness({ dialer: new FlakyDialer({ statusFailures: 1 }), notifier });
  const r = await runTranscript(h.flow, { transcript: leakTranscript, pageOutcomes: ["no-answer"] });
  const id = r.submitted.incidentId;
  h.advance(20);
  await h.flow.processDueJobs();
  assert.equal(h.audit.getIncident(id).state, STATES.UNACKNOWLEDGED_ALERT);
  assert.equal(event(h.audit, id, "notification_failed").detail, "ops_alert: fetch failed");
  assert.match(event(h.audit, id, "status_call_failed").detail, /^unacknowledged: /);
  assert.ok(event(h.audit, id, "unacknowledged_alert"));
  assert.equal(h.audit.jobs.get(`alert:${id}`).status, "done");
  assert.deepEqual(runningJobs(h.audit), []);
});

await test("a technician card that cannot be posted is logged and the page call still goes out", async () => {
  const notifier = new TeamsNotifier({ workflowUrl: "https://example.invalid/card", fetchImpl: unreachable });
  const h = harness({ notifier });
  const r = await runTranscript(h.flow, { transcript: leakTranscript, pageOutcomes: ["accept"] });
  const id = r.submitted.incidentId;
  assert.equal(event(h.audit, id, "notification_failed").detail, "technician_card: fetch failed");
  assert.equal(h.dialer.calls.filter((c) => c.kind === "page").length, 1);
  assert.equal(h.audit.getIncident(id).state, STATES.CLOSED);
});

await test("an unexpected error inside a job marks it failed and the alert job remains the backstop", async () => {
  const h = harness();
  h.flow.policy.levelContact = () => { throw new Error("rotation unavailable"); };
  const r = await runTranscript(h.flow, { transcript: leakTranscript });
  const id = r.submitted.incidentId;
  assert.equal(h.audit.jobs.get(`page:${id}:primary:1`).status, "failed");
  assert.equal(event(h.audit, id, "job_failed").detail, `page:${id}:primary:1: rotation unavailable`);
  assert.deepEqual(runningJobs(h.audit), []);
  h.advance(20);
  await h.flow.processDueJobs();
  assert.equal(h.audit.getIncident(id).state, STATES.UNACKNOWLEDGED_ALERT);
});
