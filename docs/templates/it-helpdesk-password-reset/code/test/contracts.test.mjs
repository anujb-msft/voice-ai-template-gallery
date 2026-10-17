import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Pin the shipped knowledge base; knowledge.mjs honors KNOWLEDGE_FILE.
delete process.env.KNOWLEDGE_FILE;
const { VOIP_VALUE_LIMIT, HANDOFF_REASONS, handoffTopic, serviceDeskIdentifier, buildCustomCallingContext } = await import("../src/handoff.mjs");
const { findAnswer, knowledgeBase } = await import("../src/knowledge.mjs");
const { AGENT_TOOLS, buildInstructions, localeLanguage } = await import("../src/agent.mjs");
const { STEPS } = await import("../src/flow.mjs");
const { assertCallConfig, isPlaceholder, isSimulated } = await import("../src/config.mjs");

/**
 * The contracts around the state machine: what Teams receives on a handoff,
 * what the agent may answer from, which tools the model has, and when the
 * server is allowed to place real calls. Every config here is passed in
 * explicitly, so a developer's own .env never changes a result.
 */

// --------------------------------------------------------------- handoff

test("the VoIP headers carry the context; empty fields are left out and long ones cut to the limit", () => {
  const headers = buildCustomCallingContext({
    sessionId: "call-1",
    callTopic: HANDOFF_REASONS.caller_requested_person.topic,
    callContext: "x".repeat(VOIP_VALUE_LIMIT + 50),
    callSentiment: "Frustrated",
    risk: null,
    ticketId: "",
    callerDetails: { name: "Jordan Patel", username: "jordan.patel", department: "Finance", verified: true },
  });
  assert.deepEqual(
    headers.map((h) => h.key),
    ["CallDetails.SessionId", "CallDetails.CallTopic", "CallDetails.CallContext", "CallDetails.CallSentiment", "CallerDetails"],
  );
  assert.ok(headers.every((h) => h.kind === "voip"));
  assert.equal(headers[2].value.length, VOIP_VALUE_LIMIT);
  // The verified flag always travels with the name.
  assert.deepEqual(JSON.parse(headers[4].value), { name: "Jordan Patel", username: "jordan.patel", department: "Finance", verified: true });
});

test("the service desk is a Teams call queue or a named specialist, never a phone number", () => {
  assert.deepEqual(serviceDeskIdentifier({ id: "queue-1" }), { teamsAppId: "queue-1", cloud: "public" });
  assert.deepEqual(serviceDeskIdentifier({ id: "queue-1", cloud: "gcch" }), { teamsAppId: "queue-1", cloud: "gcch" });
  assert.deepEqual(serviceDeskIdentifier({ id: "user-1", kind: "user" }), { microsoftTeamsUserId: "user-1" });
  assert.throws(() => serviceDeskIdentifier({ id: "" }), /SERVICE_DESK_TEAMS_ID/);
});

test("every handoff reason reads as a password-reset topic, even one nobody planned for", () => {
  for (const [reason, { topic, sentiment }] of Object.entries(HANDOFF_REASONS)) {
    assert.match(topic, /^Password reset/, reason);
    assert.ok(sentiment, reason);
  }
  assert.deepEqual(handoffTopic("printer_on_fire"), { topic: "Password reset: printer on fire", sentiment: "Neutral" });
});

// ------------------------------------------------------------- knowledge

test("the knowledge base holds the FAQ's answers and none of its notes to the author or the presenter", () => {
  const { entries, text } = knowledgeBase();
  assert.ok(entries.length >= 20);
  assert.deepEqual([...new Set(entries.map((e) => e.section))], ["Security and trust", "During the reset", "Password rules", "After the reset"]);
  assert.match(text, /^Q: How do I know this call is really from IT\?\nA: /);
  assert.doesNotMatch(text, /Try these during the demo|Handing off to a human/);
});

test("a question is matched on its rare words; one the FAQ doesn't cover gets no answer rather than a guess", () => {
  assert.equal(findAnswer("My VPN still says my password is wrong.")?.question, "My VPN still says my password is wrong.");
  assert.equal(findAnswer("My VPN still says my password is wrong.")?.section, "After the reset");
  assert.equal(findAnswer("What are the password rules?")?.question, "What are the password requirements?");
  assert.equal(findAnswer("Can you fix my printer?"), null);
  assert.equal(findAnswer("Um, okay."), null);
  assert.equal(findAnswer(""), null);
});

// ----------------------------------------------------------------- agent

test("every tool the instructions name is one the model has, and the live bridge handles every tool", () => {
  const tools = AGENT_TOOLS.map((t) => t.name);
  assert.deepEqual(tools, ["confirm_identity", "issue_verification_code", "refuse_request", "request_human", "answer_question", "escalate", "end_call"]);

  const ctx = { user: { displayName: "Alex Morgan", department: "Field Operations" }, transfer: false };
  const texts = [buildInstructions(), ...Object.values(STEPS).map((step) => step.agentInstructions?.(ctx) ?? "")];
  const named = new Set(texts.flatMap((text) => [...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1])));
  assert.ok(named.size >= 6);
  for (const name of named) assert.ok(tools.includes(name), `the instructions name ${name}, which is not a tool`);

  const bridge = readFileSync(new URL("../src/voice/call-bridge.mjs", import.meta.url), "utf8");
  for (const name of tools) assert.match(bridge, new RegExp(`case "${name}":`), `the live bridge has no handler for ${name}`);
});

test("the refusals the model can record are exactly the two the server enforces", () => {
  const refuse = AGENT_TOOLS.find((t) => t.name === "refuse_request");
  assert.deepEqual(refuse.parameters.properties.kind.enum, ["other_account", "skip_verification"]);
  const instructions = buildInstructions();
  assert.match(instructions, /Never reset, unlock or discuss anyone else's account/);
  assert.match(instructions, /Never skip, shorten or work around identity verification/);
  assert.match(instructions, /If verification fails, reveal nothing about the account/);
});

test("the instructions pin the call's language and carry the knowledge base as data", () => {
  const { locale, label } = localeLanguage("fr-CA");
  assert.equal(locale, "fr-CA");
  assert.match(label, /French/);
  const text = buildInstructions({ locale: "fr-CA", knowledge: "Q: Example?\nA: Example." });
  assert.ok(text.includes(`Start every call in ${label} (fr-CA)`));
  assert.ok(text.endsWith("=== KNOWLEDGE BASE ===\nQ: Example?\nA: Example.\n=== END KNOWLEDGE BASE ==="));
  assert.equal(buildInstructions().includes("=== KNOWLEDGE BASE ==="), false);
  assert.match(localeLanguage().label, /English/);
});

// ---------------------------------------------------------------- config

const LIVE = {
  publicBaseUrl: "https://helpdesk-demo.example.com",
  acs: {
    connectionString: "fake-connection-string",
    telephonyMode: "teams-phone",
    callerId: "",
    teamsResourceAccountId: "11111111-2222-3333-4444-555555555555",
  },
  voiceLive: { endpoint: "https://contoso-voice.example.com", apiKey: "fake-key" },
  demo: { defaultPhone: "+14255550100" },
};

test("a complete Teams Phone configuration places real calls", () => {
  assert.deepEqual(assertCallConfig(LIVE), []);
  assert.equal(isSimulated(LIVE), false);
});

test("anything missing, or still the .env.example placeholder, keeps the server in simulation", () => {
  const cfg = structuredClone(LIVE);
  cfg.acs.teamsResourceAccountId = "00000000-0000-0000-0000-000000000000";
  cfg.voiceLive.apiKey = "<your-voice-live-key>";
  cfg.demo.defaultPhone = "+1XXXXXXXXXX";
  assert.deepEqual(assertCallConfig(cfg), ["TPE_RESOURCE_ACCOUNT_ID", "VOICE_LIVE_API_KEY", "DEMO_PHONE_NUMBER"]);
  assert.equal(isSimulated(cfg), true);
  assert.equal(isSimulated({ ...LIVE, publicBaseUrl: "" }), true);
});

test("an unrecognized telephony mode is reported as missing, not guessed", () => {
  const cfg = structuredClone(LIVE);
  cfg.acs.telephonyMode = null;
  assert.deepEqual(assertCallConfig(cfg), ["TELEPHONY_MODE"]);
});

test("direct ACS mode needs its own caller number instead of the Teams resource account", () => {
  const cfg = structuredClone(LIVE);
  cfg.acs.telephonyMode = "acs-direct";
  assert.deepEqual(assertCallConfig(cfg), ["ACS_CALLER_ID"]);
  cfg.acs.callerId = "+14255550199";
  assert.deepEqual(assertCallConfig(cfg), []);
});

test("placeholders from .env.example are recognized; real-looking values are not", () => {
  for (const value of ["", null, undefined, "<key>", "+1XXXXXXXXXX", "00000000-0000-0000-0000-000000000000"]) {
    assert.equal(isPlaceholder(value), true, String(value));
  }
  for (const value of ["+14255550100", "https://contoso-voice.example.com", "11111111-2222-3333-4444-555555555555"]) {
    assert.equal(isPlaceholder(value), false, value);
  }
});
