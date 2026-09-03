import { test } from "node:test";
import assert from "node:assert/strict";

import { teamsIdentifier, buildCustomCallingContext, resourceAccountFrom } from "../src/handoff.mjs";
import { RoutingFlow, STATES } from "../src/flow.mjs";
import { RoutePolicy, CallerDirectory } from "../src/routes.mjs";
import { MemoryAudit } from "../src/audit.mjs";
import { handleUtterance, isAffirmative } from "../src/offline.mjs";
import { AGENT_TOOLS, buildInstructions, localeLanguage } from "../src/agent.mjs";

// The shipped config, pinned explicitly. RoutePolicy.load() otherwise honours
// ROUTES_PATH, so a developer testing against their own tenant would turn these
// assertions red without changing a line of source.
const SHIPPED_ROUTES = "./config/routes.json";
const SHIPPED_CALLERS = "./config/callers.json";


/**
 * Covers the boundary between the routing decision and Teams: how a route
 * target becomes an identifier, how context becomes VoIP headers, and what the
 * model is actually allowed to ask for.
 */

const OPEN = Date.parse("2026-09-02T17:00:00Z");
const CLOSED = Date.parse("2026-09-03T02:00:00Z");

function makeFlow({ now = OPEN } = {}) {
  const audit = new MemoryAudit();
  const flow = new RoutingFlow({
    routes: RoutePolicy.load(SHIPPED_ROUTES),
    callers: CallerDirectory.load(SHIPPED_CALLERS),
    audit,
    now: () => now,
    options: { transferDelayMs: 0, confidenceThreshold: 0.75, maxClarifications: 2 },
  });
  return { flow, audit };
}

// ------------------------------------------------------------ Teams identifiers

test("a call queue is addressed as a Teams app, a specialist as a Teams user", () => {
  assert.deepEqual(teamsIdentifier({ type: "callQueue", objectId: "queue-guid" }), {
    teamsAppId: "queue-guid",
    cloud: "public",
  });
  assert.deepEqual(teamsIdentifier({ type: "autoAttendant", objectId: "aa-guid" }), {
    teamsAppId: "aa-guid",
    cloud: "public",
  });
  assert.deepEqual(teamsIdentifier({ type: "user", objectId: "user-guid" }), {
    microsoftTeamsUserId: "user-guid",
  });
});

test("a target with no object id fails loudly rather than dialling nowhere", () => {
  assert.throws(() => teamsIdentifier({ type: "callQueue" }), /objectId/);
  assert.throws(() => teamsIdentifier(null), /objectId/);
});

test("every configured route target resolves to a Teams identifier", () => {
  const routes = RoutePolicy.load(SHIPPED_ROUTES);
  for (const id of routes.ids) {
    const identifier = teamsIdentifier(routes.get(id).target);
    assert.ok(identifier.teamsAppId || identifier.microsoftTeamsUserId, `${id} has no usable identifier`);
  }
});

// -------------------------------------------------------------- VoIP handoff

test("the handoff becomes VoIP headers, never SIP headers", () => {
  const headers = buildCustomCallingContext({
    sessionId: "abc",
    callTopic: "Duplicate charge",
    callContext: "Billed twice in August.",
    routeId: "billing",
  });

  assert.ok(headers.length > 0);
  assert.ok(
    headers.every((h) => h.kind === "voip"),
    "SIP headers are PSTN-only and would be silently dropped en route to Teams",
  );
});

test("absent context fields are omitted rather than sent as empty headers", () => {
  const headers = buildCustomCallingContext({
    sessionId: "abc",
    callTopic: "Pricing question",
    callContext: null,
    callSentiment: null,
    routeId: "sales",
    afterHours: false,
  });

  const keys = headers.map((h) => h.key);
  assert.deepEqual(keys, ["CallDetails.SessionId", "CallDetails.CallTopic", "CallDetails.RouteId"]);
});

test("caller details travel as one record so the unverified flag cannot be lost", () => {
  const headers = buildCustomCallingContext({
    sessionId: "abc",
    callTopic: "Renewal",
    routeId: "sales",
    callerDetails: { name: "Dana Whitfield", company: "Northwind Traders", verified: false },
  });

  const caller = headers.find((h) => h.key === "CallerDetails");
  assert.equal(JSON.parse(caller.value).verified, false);
});

test("header values stay inside the 1024 character VoIP limit", () => {
  const headers = buildCustomCallingContext({
    sessionId: "abc",
    callTopic: "x",
    callContext: "y".repeat(5000),
    routeId: "support",
  });
  assert.equal(headers.find((h) => h.key === "CallDetails.CallContext").value.length, 1024);
});

test("after-hours diversions are declared in the handoff", () => {
  const headers = buildCustomCallingContext({ sessionId: "a", callTopic: "t", routeId: "reception", afterHours: true });
  assert.equal(headers.find((h) => h.key === "CallDetails.AfterHours").value, "true");
});

test("a real routing decision produces headers a Teams agent can read", async () => {
  const { flow } = makeFlow();
  const call = flow.create({ fromPhone: "+14255550102" });
  flow.answered(call.id);
  flow.proposeRoute(call.id, {
    routeId: "support",
    confidence: 0.92,
    callTopic: "Reporting portal will not load",
    callSummary: "Portal has been erroring since the weekend upgrade.",
    sentiment: "frustrated",
  });
  flow.confirmRoute(call.id, "support");
  const snap = await flow.settled(call.id);

  const headers = Object.fromEntries(buildCustomCallingContext(snap.handoff).map((h) => [h.key, h.value]));
  assert.equal(headers["CallDetails.CallTopic"], "Reporting portal will not load");
  assert.equal(headers["CallDetails.RouteId"], "support");
  assert.equal(headers["CallDetails.CallSentiment"], "frustrated");
  assert.equal(JSON.parse(headers["CallerDetails"]).name, "Marcus Bell");
});

// ----------------------------------------------------------------- agent tools

test("the model has no tool that accepts a number, an id, or a URL", () => {
  for (const tool of AGENT_TOOLS) {
    for (const [name, schema] of Object.entries(tool.parameters.properties)) {
      assert.ok(
        !/phone|objectid|url|uri|target|number$/i.test(name),
        `${tool.name}.${name} would let the model choose a destination directly`,
      );
      assert.ok(schema.type, `${tool.name}.${name} has no declared type`);
    }
  }
});

test("sentiment is constrained by the tool schema, not just the prompt", () => {
  const propose = AGENT_TOOLS.find((t) => t.name === "propose_route");
  assert.deepEqual(propose.parameters.properties.sentiment.enum, [
    "frustrated",
    "angry",
    "upset",
    "distressed",
  ]);
  assert.ok(!propose.parameters.required.includes("sentiment"), "sentiment must be optional");
});

test("every tool the bridge dispatches exists in the schema and vice versa", () => {
  const declared = AGENT_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(declared, [
    "confirm_route",
    "end_call",
    "not_covered",
    "propose_route",
    "request_human",
    "take_message",
  ]);
});

test("the instructions disclose the assistant and list only route ids", () => {
  const routes = RoutePolicy.load(SHIPPED_ROUTES);
  const instructions = buildInstructions(routes, "en-US");

  assert.match(instructions, /automated assistant/i);
  assert.match(instructions, /Contoso/);
  assert.match(instructions, /Start every call in American English \(en-US\)/);
  assert.match(instructions, /including the very first word/i);
  for (const id of routes.ids) assert.ok(instructions.includes(id), `${id} missing from the menu`);
  assert.ok(!instructions.includes("0000-0000"), "Teams object ids must never reach the model");
  assert.match(instructions, /never invent/i);
});

test("locale controls the opening language and transcription hint", () => {
  const routes = RoutePolicy.load(SHIPPED_ROUTES);
  const language = localeLanguage("fr-FR");
  const instructions = buildInstructions(routes, "fr-FR");

  assert.deepEqual(language, { locale: "fr-FR", code: "fr", label: "French (France)" });
  assert.match(instructions, /Start every call in French \(France\) \(fr-FR\)/);
  assert.doesNotMatch(instructions, /American English/);
  assert.equal(localeLanguage("en-US").code, "en", "Voice Live transcription uses ISO-639-1");
});

// ------------------------------------------------------- offline console driving

test("typing yes accepts the destination that was offered", async () => {
  const { flow } = makeFlow();
  const call = flow.create({ fromPhone: "+14255550101" });
  flow.answered(call.id);

  handleUtterance(flow, call.id, "I need to ask about a charge on my invoice");
  assert.equal(flow.get(call.id).state, STATES.CONFIRMING);

  handleUtterance(flow, call.id, "yes please");
  const snap = await flow.settled(call.id);
  assert.equal(snap.state, STATES.TRANSFERRED);
  assert.equal(snap.destination.routeId, "billing");
});

test("saying no after an offer re-opens classification instead of transferring", () => {
  const { flow } = makeFlow();
  const call = flow.create({});
  flow.answered(call.id);

  handleUtterance(flow, call.id, "I want to buy a new licence");
  assert.equal(flow.get(call.id).state, STATES.CONFIRMING);

  handleUtterance(flow, call.id, "no, actually my portal is broken and throwing an error");
  assert.equal(flow.get(call.id).state, STATES.CONFIRMING);
  assert.equal(flow.get(call.id).proposed.routeId, "support");
});

test("after hours the typed utterance is captured as a message", () => {
  const { flow } = makeFlow({ now: CLOSED });
  const call = flow.create({});
  flow.answered(call.id);

  handleUtterance(flow, call.id, "there is a duplicate charge on my invoice");
  handleUtterance(flow, call.id, "yes");
  assert.equal(flow.get(call.id).state, STATES.MESSAGING);

  handleUtterance(flow, call.id, "Please call me back about invoice 8841, I was billed twice.");
  assert.equal(flow.get(call.id).state, STATES.ENDED);
  assert.equal(flow.get(call.id).outcome, "message_taken");
});

test("a typed digit is treated as a keypad press, not as speech", async () => {
  const { flow } = makeFlow();
  const call = flow.create({});
  flow.answered(call.id);

  handleUtterance(flow, call.id, "2");
  const snap = await flow.settled(call.id);
  assert.equal(snap.destination.routeId, "support");
});

test("affirmatives are recognised without swallowing corrections", () => {
  assert.equal(isAffirmative("yes please"), true);
  assert.equal(isAffirmative("yeah that's it"), true);
  assert.equal(isAffirmative("no, actually billing"), false);
  assert.equal(isAffirmative("yes but actually I meant support"), false);
});

// ------------------------------------ Teams Phone extensibility inbound identity

test("a TPE call carries the dialled resource account", () => {
  // Teams Phone extensibility puts the resource account in to.rawId. Note the
  // documented to.kind is "unknown", not "microsoftTeamsApp" — matching on kind
  // would silently classify every real TPE call as a plain ACS one.
  const to = { kind: "unknown", rawId: "28:orgid:cc123456-5678-5678-1234-ccc123456789" };
  assert.equal(resourceAccountFrom(to), "cc123456-5678-5678-1234-ccc123456789");

  const { flow } = makeFlow();
  const call = flow.create({ fromPhone: "+14255550111", resourceAccountId: resourceAccountFrom(to) });
  assert.equal(call.arrival, "teams-phone-extensibility");
  assert.equal(call.resourceAccountId, "cc123456-5678-5678-1234-ccc123456789");
});

test("a call straight to an ACS number is not mistaken for a TPE call", () => {
  assert.equal(resourceAccountFrom({ kind: "phoneNumber", rawId: "4:+18552903649" }), null);
  assert.equal(resourceAccountFrom(undefined), null);
  assert.equal(resourceAccountFrom({ rawId: "28:orgid:not-a-guid" }), null);

  const call = makeFlow().flow.create({ fromPhone: "+14255550111" });
  assert.equal(call.arrival, "acs-direct");
  assert.equal(call.resourceAccountId, null);
});

test("the caller's phone number survives the ACS 4: raw-id prefix", () => {
  // from.rawId arrives as "4:+E164"; dropping the prefix is what makes the
  // known-caller lookup work at all.
  assert.equal("4:+12065551212".replace(/^4:/, ""), "+12065551212");
});
