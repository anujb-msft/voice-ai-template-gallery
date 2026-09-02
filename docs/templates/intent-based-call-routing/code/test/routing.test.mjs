import { test } from "node:test";
import assert from "node:assert/strict";

import { RoutingFlow, STATES } from "../src/flow.mjs";
import { RoutePolicy, CallerDirectory, maskPhone } from "../src/routes.mjs";
import { MemoryAudit } from "../src/audit.mjs";
import { classifyOffline, handleUtterance, wantsHuman, registerSimulatedAgent } from "../src/offline.mjs";

/**
 * The whole routing flow is exercised here with no Azure, no database and no
 * network. Everything the model is not trusted with — the route allowlist, the
 * confidence gate, business hours, the time budget, the transfer ladder — is
 * asserted directly.
 */

// Wednesday 2 Sep 2026, 10:00 America/Los_Angeles. Sales, support and billing open.
const OPEN = Date.parse("2026-09-02T17:00:00Z");
// Same Wednesday, 19:00 America/Los_Angeles. Sales and billing closed, support open.
const CLOSED = Date.parse("2026-09-03T02:00:00Z");

const KNOWN_CALLER = "+14255550101";
const UNKNOWN_CALLER = "+14255559999";

function makeFlow({ now = OPEN, transfer = null, options = {} } = {}) {
  let clock = now;
  const audit = new MemoryAudit();
  const flow = new RoutingFlow({
    routes: RoutePolicy.load(),
    callers: CallerDirectory.load(),
    audit,
    transfer,
    now: () => clock,
    // transferDelayMs 0 removes the mind-change timer so tests stay deterministic.
    options: { transferDelayMs: 0, ...options },
  });
  return { flow, audit, advance: (ms) => (clock += ms) };
}

/** Answer a call and return its id. */
function answer(flow, fromPhone = UNKNOWN_CALLER) {
  const call = flow.create({ fromPhone });
  flow.answered(call.id);
  return call.id;
}

const confident = (routeId, extra = {}) => ({
  routeId,
  confidence: 0.95,
  callTopic: `${routeId} enquiry`,
  callSummary: `Caller needs ${routeId}.`,
  ...extra,
});

// --------------------------------------------------------------- happy paths

for (const routeId of ["sales", "support", "billing"]) {
  test(`${routeId}: confident proposal, caller confirms, call transfers`, async () => {
    const { flow } = makeFlow();
    const id = answer(flow);

    const proposal = flow.proposeRoute(id, confident(routeId));
    assert.equal(proposal.ok, true);
    assert.equal(proposal.confirmRequired, true, "a spoken route always needs confirming");
    assert.equal(flow.get(id).state, STATES.CONFIRMING);

    const commit = flow.confirmRoute(id, routeId);
    assert.equal(commit.ok, true);
    assert.equal(commit.action, "transfer");

    const snap = await flow.settled(id);
    assert.equal(snap.state, STATES.TRANSFERRED);
    assert.equal(snap.destination.routeId, routeId);
    assert.equal(snap.handoff.callTopic, `${routeId} enquiry`);
  });
}

test("an explicit request for a person skips confirmation entirely", async () => {
  const { flow, audit } = makeFlow();
  const id = answer(flow);

  const result = flow.requestHuman(id, "explicit_request");
  assert.equal(result.ok, true);
  assert.equal(result.routeId, "reception");

  const snap = await flow.settled(id);
  assert.equal(snap.state, STATES.TRANSFERRED);
  assert.equal(snap.destination.routeId, "reception");
  assert.ok(
    audit.eventsFor(id).every((e) => e.kind !== "route_proposed"),
    "asking for a human must not trigger a classification round trip",
  );
});

test("a keypad press commits without a spoken confirmation", async () => {
  const { flow } = makeFlow();
  const id = answer(flow);

  const result = flow.dtmf(id, "3");
  assert.equal(result.ok, true);
  assert.equal(result.routeId, "billing");

  const snap = await flow.settled(id);
  assert.equal(snap.destination.routeId, "billing");
  assert.equal(snap.state, STATES.TRANSFERRED);
});

test("an unmapped digit is ignored rather than guessed at", () => {
  const { flow } = makeFlow();
  const id = answer(flow);
  assert.deepEqual(flow.dtmf(id, "9"), { ok: false, reason: "unmapped_digit" });
  assert.equal(flow.get(id).state, STATES.CLASSIFYING);
});

// ------------------------------------------------------------ the confidence gate

test("a proposal below the threshold clarifies instead of transferring", () => {
  const { flow } = makeFlow();
  const id = answer(flow);

  const result = flow.proposeRoute(id, { routeId: "sales", confidence: 0.6 });
  assert.equal(result.clarify, true);
  assert.equal(result.reason, "low_confidence");
  assert.equal(flow.get(id).state, STATES.CLASSIFYING);
  assert.equal(flow.get(id).confirmedRouteId, null);
});

test("the threshold is inclusive at exactly 0.75", () => {
  const { flow } = makeFlow();
  const id = answer(flow);
  assert.equal(flow.proposeRoute(id, { routeId: "sales", confidence: 0.75 }).ok, true);
});

test("a route id that is not on the allowlist is rejected", () => {
  const { flow, audit } = makeFlow();
  const id = answer(flow);

  const result = flow.proposeRoute(id, { routeId: "payroll", confidence: 0.99 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown_route");
  assert.match(result.message, /sales/, "the model is told what it may choose from");
  assert.ok(audit.eventsFor(id).some((e) => e.kind === "route_rejected"));
  assert.equal(flow.get(id).confirmedRouteId, null);
});

test("confirming a route that was never proposed is refused", () => {
  const { flow } = makeFlow();
  const id = answer(flow);
  flow.proposeRoute(id, confident("sales"));

  const result = flow.confirmRoute(id, "billing");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "route_not_proposed");
  assert.equal(flow.get(id).state, STATES.CONFIRMING);
});

// ------------------------------------------------------------------ giving up well

test("two unclear turns clarify, the third routes to a person", async () => {
  const { flow } = makeFlow();
  const id = answer(flow);

  const first = flow.noInput(id);
  assert.equal(first.clarify, true);
  assert.equal(first.offerKeypad, false);

  const second = flow.noInput(id);
  assert.equal(second.clarify, true);
  assert.equal(second.offerKeypad, true, "the last attempt offers the keypad");

  const third = flow.noInput(id);
  assert.equal(third.fallback, true);
  assert.equal(third.reason, "unresolved_intent");

  const snap = await flow.settled(id);
  assert.equal(snap.destination.routeId, "reception");
  assert.equal(snap.topic, "Unclear — needs triage");
});

test("an out-of-scope question is deflected once, then routed to a person", async () => {
  const { flow } = makeFlow();
  const id = answer(flow);

  const first = flow.outOfScope(id, "what are your office hours in Berlin?");
  assert.equal(first.deflected, true);
  assert.equal(flow.get(id).state, STATES.CLASSIFYING);

  const second = flow.outOfScope(id, "and do you ship to Norway?");
  assert.equal(second.fallback, true);
  assert.equal(second.reason, "repeated_out_of_scope");

  const snap = await flow.settled(id);
  assert.equal(snap.destination.routeId, "reception");
});

test("the time budget expires to a person and only fires once", async () => {
  const { flow, audit, advance } = makeFlow();
  const id = answer(flow);

  advance(90_000);
  const result = flow.checkBudget(id);
  assert.equal(result.fallback, true);
  assert.equal(result.reason, "time_budget_expired");

  const snap = await flow.settled(id);
  assert.equal(snap.destination.routeId, "reception");
  assert.equal(audit.eventsFor(id).filter((e) => e.kind === "budget_expired").length, 1);

  // A late arriving proposal must not reopen a finished call.
  assert.equal(flow.proposeRoute(id, confident("sales")).reason, "call_finished");
});

test("the budget does not expire a call that already has a confirmed route", async () => {
  const { flow, advance } = makeFlow({ options: { transferDelayMs: 5_000 } });
  const id = answer(flow);
  flow.proposeRoute(id, confident("support"));
  flow.confirmRoute(id, "support");

  advance(120_000);
  assert.deepEqual(flow.checkBudget(id), { ok: true });
  assert.equal(flow.get(id).state, STATES.TRANSFERRING);

  await flow.dispatchTransfer(id);
  assert.equal(flow.get(id).destination.routeId, "support");
});

// ------------------------------------------------------------- changing your mind

test("a caller can change their mind up until the transfer dispatches", async () => {
  const { flow, audit } = makeFlow({ options: { transferDelayMs: 5_000 } });
  const id = answer(flow);

  flow.proposeRoute(id, confident("sales"));
  flow.confirmRoute(id, "sales");
  assert.equal(flow.get(id).state, STATES.TRANSFERRING);

  const changed = flow.proposeRoute(id, confident("billing"));
  assert.equal(changed.ok, true);
  assert.equal(changed.confirmRequired, true);
  assert.equal(flow.get(id).state, STATES.CONFIRMING);
  assert.equal(flow.get(id).pendingDispatch, null, "the scheduled transfer is cancelled");
  assert.ok(audit.eventsFor(id).some((e) => e.kind === "route_changed"));

  flow.confirmRoute(id, "billing");
  await flow.dispatchTransfer(id);
  assert.equal(flow.get(id).destination.routeId, "billing");
});

test("once the transfer has dispatched the route is frozen", async () => {
  const { flow } = makeFlow();
  const id = answer(flow);
  flow.proposeRoute(id, confident("sales"));
  flow.confirmRoute(id, "sales");
  await flow.settled(id);

  assert.equal(flow.proposeRoute(id, confident("billing")).reason, "call_finished");
  assert.equal(flow.get(id).destination.routeId, "sales");
});

test("a keypress inside the mind-change window replaces the pending transfer", async () => {
  const { flow } = makeFlow({ options: { transferDelayMs: 5_000 } });
  const id = answer(flow);
  flow.proposeRoute(id, confident("billing"));
  flow.confirmRoute(id, "billing");
  const armed = flow.get(id).pendingDispatch;
  assert.ok(armed, "a transfer is pending");

  // Pressing 2 replaces the pending billing transfer. If the old timer were left
  // armed it would win the race and the caller would land in the wrong queue.
  assert.equal(flow.dtmf(id, "2").routeId, "support");
  assert.notEqual(flow.get(id).pendingDispatch, armed);
  assert.equal(flow.get(id).destination.routeId, "support");

  await flow.dispatchTransfer(id);
  assert.equal(flow.get(id).destination.routeId, "support");
  assert.equal(flow.get(id).transferAttempts, 1, "only one transfer was attempted");
});

test("changing your mind clears the destination so nothing stale is handed off", () => {
  const { flow } = makeFlow({ options: { transferDelayMs: 5_000 } });
  const id = answer(flow);
  flow.proposeRoute(id, confident("sales"));
  flow.confirmRoute(id, "sales");
  assert.equal(flow.get(id).destination.routeId, "sales");

  flow.proposeRoute(id, confident("billing"));
  assert.equal(flow.get(id).destination, null);
});

test("a keypress after the transfer has dispatched is refused", async () => {
  const { flow } = makeFlow();
  const id = answer(flow);
  flow.proposeRoute(id, confident("sales"));
  flow.confirmRoute(id, "sales");
  await flow.settled(id);

  assert.equal(flow.dtmf(id, "2").reason, "call_finished");
  assert.equal(flow.requestHuman(id).reason, "call_finished");
  assert.equal(flow.get(id).destination.routeId, "sales");
});

// ------------------------------------------------------------------ business hours

test("after hours, billing takes a message instead of transferring", async () => {
  const { flow } = makeFlow({ now: CLOSED });
  const id = answer(flow);

  flow.proposeRoute(id, confident("billing"));
  const commit = flow.confirmRoute(id, "billing");
  assert.equal(commit.action, "message");
  assert.equal(commit.afterHours, true);
  assert.equal(flow.get(id).state, STATES.MESSAGING);

  const taken = flow.takeMessage(id, {
    callTopic: "Duplicate charge on invoice 8841",
    callSummary: "Caller was billed twice in August and wants the second charge reversed.",
  });
  assert.equal(taken.recorded, true);
  assert.equal(flow.get(id).state, STATES.ENDED);
  assert.equal(flow.get(id).outcome, "message_taken");
});

test("take_message is refused unless the flow chose message-taking", () => {
  const { flow } = makeFlow();
  const id = answer(flow);
  assert.deepEqual(flow.takeMessage(id, { callTopic: "anything" }), {
    ok: false,
    reason: "not_taking_messages",
  });
});

test("after hours, sales diverts to reception and says so", async () => {
  const { flow } = makeFlow({ now: CLOSED });
  const id = answer(flow);

  flow.proposeRoute(id, confident("sales"));
  const commit = flow.confirmRoute(id, "sales");
  assert.equal(commit.action, "transfer");
  assert.equal(commit.afterHours, true);
  assert.equal(commit.routeId, "reception");

  const snap = await flow.settled(id);
  assert.equal(snap.destination.routeId, "reception");
  assert.equal(snap.handoff.afterHours, true);
  assert.equal(flow.get(id).destination.divertedFrom, "sales");
});

test("a 24x7 route stays open at night", () => {
  const routes = RoutePolicy.load();
  assert.equal(routes.isOpen("support", new Date(CLOSED)), true);
  assert.equal(routes.isOpen("sales", new Date(CLOSED)), false);
  assert.equal(routes.isOpen("billing", new Date(CLOSED)), false);
  assert.equal(routes.isOpen("reception", new Date(CLOSED)), true);
  assert.equal(routes.isOpen("sales", new Date(OPEN)), true);
});

// ----------------------------------------------------------------- caller identity

test("a known caller enriches the handoff but is never marked verified", async () => {
  const { flow } = makeFlow();
  const id = answer(flow, KNOWN_CALLER);
  flow.proposeRoute(id, confident("support"));
  flow.confirmRoute(id, "support");

  const snap = await flow.settled(id);
  assert.equal(snap.handoff.callerDetails.name, "Dana Whitfield");
  assert.equal(snap.handoff.callerDetails.company, "Northwind Traders");
  assert.equal(snap.handoff.callerDetails.verified, false, "caller ID is not authentication");
  assert.equal(snap.caller.verified, false);
});

test("an unknown caller produces no caller details at all", async () => {
  const { flow } = makeFlow();
  const id = answer(flow, UNKNOWN_CALLER);
  flow.proposeRoute(id, confident("support"));
  flow.confirmRoute(id, "support");

  const snap = await flow.settled(id);
  assert.equal(snap.handoff.callerDetails, undefined);
  assert.equal(snap.caller, null);
});

test("phone numbers are masked everywhere they surface", () => {
  assert.equal(maskPhone("+14255550101"), "+•••••••••01");
  assert.equal(maskPhone(null), "anonymous");
  const { flow } = makeFlow();
  const id = answer(flow, KNOWN_CALLER);
  assert.ok(!flow.snapshot(id).maskedPhone.includes("4255550101"));
});

// -------------------------------------------------------------- the handoff payload

test("the handoff respects the Teams CallTopic length limit", async () => {
  const { flow } = makeFlow();
  const id = answer(flow);
  flow.proposeRoute(
    id,
    confident("support", {
      callTopic: "The caller cannot sign in to the reporting portal after the weekend upgrade",
    }),
  );
  flow.confirmRoute(id, "support");

  const snap = await flow.settled(id);
  assert.ok(snap.handoff.callTopic.length <= 48, snap.handoff.callTopic);
  assert.match(snap.handoff.callTopic, /…$/);
});

test("sentiment is restricted to the agreed vocabulary", () => {
  const { flow } = makeFlow();
  const id = answer(flow);

  flow.proposeRoute(id, confident("billing", { sentiment: "delighted" }));
  assert.equal(flow.get(id).sentiment, null, "arbitrary sentiment strings are dropped");

  flow.proposeRoute(id, confident("billing", { sentiment: "frustrated" }));
  assert.equal(flow.get(id).sentiment, "frustrated");
  assert.equal(flow.handoffContext(flow.get(id)).callSentiment, "frustrated");
});

test("the handoff carries no Teams object ids the model could have influenced", async () => {
  const { flow } = makeFlow();
  const id = answer(flow);
  flow.proposeRoute(id, confident("sales"));
  flow.confirmRoute(id, "sales");
  const snap = await flow.settled(id);

  assert.ok(!JSON.stringify(snap.handoff).includes("0000-0000"));
});

test("the model's menu describes routes but never their targets", () => {
  const menuText = RoutePolicy.load().menuText();
  assert.match(menuText, /sales/);
  assert.match(menuText, /Keypad 1/);
  assert.ok(!menuText.includes("objectId"));
  assert.ok(!menuText.includes("0000-0000"));
});

// --------------------------------------------------------------- transfer failures

test("a failed transfer is retried once, then diverted, then admitted honestly", async () => {
  const attempts = [];
  const { flow, audit } = makeFlow({
    transfer: async (_call, destination) => {
      attempts.push(destination.routeId);
      throw new Error("queue unreachable");
    },
  });
  const id = answer(flow);
  flow.proposeRoute(id, confident("sales"));
  flow.confirmRoute(id, "sales");
  await flow.settled(id);

  assert.deepEqual(attempts, ["sales", "sales", "reception"]);
  assert.equal(flow.get(id).state, STATES.FALLBACK);
  assert.ok(audit.eventsFor(id).some((e) => e.kind === "transfer_diverted"));

  flow.endCall(id, "transfer_unavailable");
  assert.equal(flow.get(id).state, STATES.ENDED);
});

test("a transfer that succeeds on the retry still completes normally", async () => {
  let calls = 0;
  const { flow } = makeFlow({
    transfer: async () => {
      if (++calls === 1) throw new Error("transient");
    },
  });
  const id = answer(flow);
  flow.proposeRoute(id, confident("support"));
  flow.confirmRoute(id, "support");

  const snap = await flow.settled(id);
  assert.equal(calls, 2);
  assert.equal(snap.state, STATES.TRANSFERRED);
  assert.equal(snap.destination.routeId, "support");
});

test("the real transfer receives the destination target and the handoff context", async () => {
  const seen = [];
  const { flow } = makeFlow({ transfer: async (call, destination) => seen.push({ call, destination }) });
  const id = answer(flow, KNOWN_CALLER);
  flow.proposeRoute(id, confident("billing"));
  flow.confirmRoute(id, "billing");
  await flow.settled(id);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].destination.target.objectId, "00000000-0000-0000-0000-000000000003");
  assert.equal(seen[0].destination.target.type, "callQueue");
  assert.equal(seen[0].destination.context.routeId, "billing");
  assert.equal(seen[0].destination.context.callerDetails.verified, false);
});

// ------------------------------------------------------------------------- audit

test("every call leaves an auditable trail without storing utterances by default", async () => {
  const { flow, audit } = makeFlow();
  const id = answer(flow, KNOWN_CALLER);
  flow.pushTranscript(id, "caller", "I was charged twice");
  flow.proposeRoute(id, confident("billing"));
  flow.confirmRoute(id, "billing");
  await flow.settled(id);

  const kinds = audit.eventsFor(id).map((e) => e.kind);
  for (const expected of ["call_created", "route_proposed", "route_confirmed", "transfer_started", "state"]) {
    assert.ok(kinds.includes(expected), `missing ${expected} in ${kinds.join(", ")}`);
  }

  const stats = audit.stats();
  assert.equal(stats.calls, 1);
  assert.equal(stats.byRoute.billing, 1);

  const stored = audit.calls.get(id);
  assert.equal(stored.callerVerified, false);
  assert.ok(!stored.maskedPhone.includes("4255550101"));
});

// -------------------------------------------------------------- offline classifier

test("the offline classifier picks the obvious route and flags the ambiguous one", () => {
  assert.equal(classifyOffline("I want to buy more licences").routeId, "sales");
  assert.equal(classifyOffline("my dashboard is broken and throwing an error").routeId, "support");
  assert.equal(classifyOffline("I was charged twice on my invoice").routeId, "billing");
  assert.equal(classifyOffline("hello there").routeId, null);

  const ambiguous = classifyOffline("I was charged for a renewal I did not order");
  assert.ok(ambiguous.confidence < 0.75, "a genuinely ambiguous utterance must not clear the gate");
});

test("an explicit ask for a human is detected before classification", () => {
  assert.equal(wantsHuman("can I just speak to a person please"), true);
  assert.equal(wantsHuman("I need to pay my invoice"), false);
});

test("a typed transcript drives the same state machine end to end", async () => {
  const { flow } = makeFlow();
  const id = answer(flow);

  const vague = handleUtterance(flow, id, "hello?");
  assert.equal(vague.clarify, true);

  const proposal = handleUtterance(flow, id, "my invoice has a duplicate charge on it");
  assert.equal(proposal.ok, true);
  assert.equal(proposal.routeId, "billing");

  flow.confirmRoute(id, "billing");
  const snap = await flow.settled(id);
  assert.equal(snap.state, STATES.TRANSFERRED);
  assert.equal(snap.destination.routeId, "billing");
  assert.ok(snap.transcript.length >= 2);
});

test("the simulated agent speaks on the same code path the real one is steered by", async () => {
  const { flow } = makeFlow();
  const call = flow.create({ fromPhone: "+14255550101" });
  registerSimulatedAgent(flow, call.id);
  flow.answered(call.id);

  const spoken = () => flow.get(call.id).transcript.filter((t) => t.role === "agent").map((t) => t.text);

  // The greeting uses the directory match, and says it is automated.
  assert.match(spoken()[0], /Dana/);
  assert.match(spoken()[0], /automated assistant/);

  handleUtterance(flow, call.id, "my invoice has a duplicate charge on it");
  assert.match(spoken().at(-1), /Billing/);

  handleUtterance(flow, call.id, "yes please");
  await flow.settled(call.id);
  assert.match(spoken().at(-1), /Connecting you now/);
});

test("an unknown caller is greeted without a name", () => {
  const { flow } = makeFlow();
  const call = flow.create({ fromPhone: "+14255559999" });
  registerSimulatedAgent(flow, call.id);
  flow.answered(call.id);

  const greeting = flow.get(call.id).transcript[0].text;
  assert.match(greeting, /automated assistant/);
  assert.doesNotMatch(greeting, /Dana/);
});
