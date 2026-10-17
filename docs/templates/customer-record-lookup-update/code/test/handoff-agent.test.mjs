import { test } from "node:test";
import assert from "node:assert/strict";

import { teamsIdentifier, buildCustomCallingContext, resourceAccountFrom } from "../src/handoff.mjs";
import { AGENT_TOOLS, buildInstructions, localeLanguage } from "../src/agent.mjs";
import { readiness } from "../src/config.mjs";
import { STATES } from "../src/flow.mjs";
import { handleUtterance } from "../src/offline.mjs";
import { CREDIT_LIMIT, NEW_MOBILE, makeFlow, startMobile, startTeams } from "./support.mjs";

// Nothing the caller didn't earn goes to the person who picks up: no PIN, no phone numbers.
const SECRETS = ["246810", "135790", "12065550120", "206 555 0120", "4255550197", "425 555 0197", "4255550143", "425 555 0143"];

function assertNoSecrets(text) {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `handoff context leaks ${secret}`);
}

test("Teams handoff addresses queues as apps and users as users", () => {
  assert.deepEqual(teamsIdentifier({ type: "callQueue", objectId: "queue-guid" }), { teamsAppId: "queue-guid", cloud: "public" });
  assert.deepEqual(teamsIdentifier({ type: "user", objectId: "user-guid" }), { microsoftTeamsUserId: "user-guid" });
  assert.throws(() => teamsIdentifier({ type: "callQueue" }), /objectId/);
});

test("custom context uses Teams Phone VoIP headers and clips values", () => {
  const headers = buildCustomCallingContext({ sessionId: "s1", callTopic: "Sales rep – Fabrikam renewal update", callContext: "x".repeat(5000), routeId: "sales-operations" });
  assert.ok(headers.every((h) => h.kind === "voip"));
  assert.equal(headers.find((h) => h.key === "CallDetails.CallTopic").value, "Sales rep – Fabrikam renewal update");
  assert.equal(headers.find((h) => h.key === "CallDetails.CallContext").value.length, 1024);
});

test("resource account is extracted only from Teams Phone extensibility raw ids", () => {
  assert.equal(resourceAccountFrom({ rawId: "28:orgid:cc123456-5678-5678-1234-ccc123456789", kind: "unknown" }), "cc123456-5678-5678-1234-ccc123456789");
  assert.equal(resourceAccountFrom({ rawId: "4:+14255550197" }), null);
});

test("handoff context carries session, topic <=48 chars, proposal summary, no PIN or contact details", () => {
  const { flow } = makeFlow();
  const call = flow.startSimulation({ repId: "rep-alex" });
  flow.findAccount(call.id, "Fabrikam");
  const p = flow.proposeUpdate(call.id, "acct-fabrikam", "Log the Fabrikam meeting. Dana agreed to the renewal at 240k, moving to Closed Won, close date June 15th.");
  const ctx = flow.handoffContext(flow.get(call.id), "explicit_request");
  assert.equal(ctx.sessionId, call.id);
  assert.ok(ctx.callTopic.length <= 48);
  assert.equal(ctx.callTopic, "Sales rep – Fabrikam");
  assert.match(ctx.callContext, /Alex Morgan/);
  assert.match(ctx.callContext, /Fabrikam/);
  assert.match(ctx.callContext, /proposal/);
  assertNoSecrets(ctx.callContext);
  assert.equal(p.ok, true);
});

test("a policy refusal hands off to Sales Operations with the refused fields as the topic", () => {
  const hub = { frames: [], send(callId, target, payload) { this.frames.push({ callId, target, payload }); } };
  const { flow, crm, audit } = makeFlow({ hub });
  const id = startMobile(flow);
  for (const digit of "246810") flow.dtmf(id, digit);
  const refused = handleUtterance(flow, id, CREDIT_LIMIT);
  assert.equal(refused.reason, "refused_by_policy");
  assert.equal(crm.auditRows().length, 0, "nothing was written");
  const accepted = handleUtterance(flow, id, "Yes, put me through.");
  assert.equal(accepted.ok, true);
  assert.equal(flow.get(id).state, STATES.TRANSFERRED);

  const handoff = flow.snapshot(id).handoff;
  assert.equal(handoff.callTopic, "Fabrikam – credit limit, payment terms");
  assert.equal(handoff.reason, "refused_by_policy");
  assert.equal(handoff.routeId, "sales-operations");
  const context = JSON.parse(handoff.callContext);
  assert.equal(context.rep, "Alex Morgan");
  assert.equal(context.verifiedBy, "registered mobile + PIN");
  assert.equal(context.account, "Fabrikam");
  assert.deepEqual(context.refusedRequests, ["credit limit", "payment terms"]);
  assert.match(context.request, /credit limit/);
  assertNoSecrets(handoff.callContext);

  const headers = buildCustomCallingContext(handoff);
  assert.deepEqual(headers.map((h) => h.key), ["CallDetails.SessionId", "CallDetails.CallTopic", "CallDetails.CallContext", "CallDetails.RouteId"]);
  assert.ok(headers.every((h) => h.kind === "voip" && h.value.length <= 1024));
  assert.ok(hub.frames.some((f) => f.target === "handoff" && f.payload.callTopic === handoff.callTopic), "the console hears about the handoff");

  const stats = audit.stats(crm);
  assert.equal(stats.refusals, 1);
  assert.equal(stats.handoffs, 1);
});

test("a person asked for mid-proposal: the handoff has the request, not the new number", () => {
  const { flow } = makeFlow();
  const id = startTeams(flow);
  assert.equal(handleUtterance(flow, id, NEW_MOBILE).ok, true);
  assert.equal(handleUtterance(flow, id, "Actually, I need a person.").ok, true);
  const handoff = flow.snapshot(id).handoff;
  assert.equal(handoff.callTopic, "Sales rep – Fabrikam");
  const context = JSON.parse(handoff.callContext);
  assert.equal(context.verifiedBy, "Teams sign-in");
  assert.match(context.proposal, /Dana Ruiz/);
  assertNoSecrets(handoff.callContext);
});

test("a failed PIN hands off as unverified, and no record is named", () => {
  const { flow, crm, audit } = makeFlow();
  const id = startMobile(flow);
  const failed = flow.submitPin(id, "135790");
  assert.deepEqual([failed.ok, failed.reason, failed.transferred], [false, "wrong_pin", true]);
  const handoff = flow.snapshot(id).handoff;
  assert.equal(handoff.callTopic, "Unverified caller – no records opened");
  const context = JSON.parse(handoff.callContext);
  assert.equal(context.verified, false);
  assert.equal(context.callerId, "number ending 0197");
  assert.equal(context.note, "No records were opened or read out.");
  // Sales Operations learns whose registered mobile it was, so a lost phone can be followed up; no account or contact is named.
  assert.equal(context.check, "Caller ID matched Alex Morgan's registered mobile; PIN failed");
  assert.ok(!/Fabrikam|Dana/.test(handoff.callContext));
  assertNoSecrets(handoff.callContext);
  assert.equal(flow.snapshot(id).record, null);
  const stats = audit.stats(crm);
  assert.equal(stats.verificationFailures, 1);
  assert.equal(stats.lookups, 0);
  assert.equal(stats.handoffs, 1);
});

test("the agent can stop a write inside the undo window", () => {
  const cancel = AGENT_TOOLS.find((t) => t.name === "cancel_pending_commit");
  assert.ok(cancel, "cancel_pending_commit is a tool");
  assert.match(cancel.description, /undo window/);
  assert.match(AGENT_TOOLS.find((t) => t.name === "commit_proposal").description, /undo window/);
  assert.match(buildInstructions(null, "en-US"), /cancel_pending_commit/);
});

test("agent tool schemas do not let the model choose Teams IDs, PINs, phone numbers, or URLs", () => {
  for (const tool of AGENT_TOOLS) {
    for (const name of Object.keys(tool.parameters.properties)) {
      assert.doesNotMatch(name, /teams|pin|phoneNumber|objectId|url|uri|target/i, `${tool.name}.${name}`);
    }
  }
});

test("instructions disclose automation and protect personal data", () => {
  const instructions = buildInstructions(null, "en-US");
  assert.match(instructions, /automated agent/i);
  assert.match(instructions, /Never ask for or repeat Teams IDs, phone numbers, PINs/i);
  assert.match(instructions, /yes, save it/i);
  assert.doesNotMatch(instructions, /11111111-1111/);
  assert.deepEqual(localeLanguage("fr-FR"), { locale: "fr-FR", code: "fr", label: "French (France)" });
});

test("readiness separates simulation, Voice Live, telephony, Teams, CRM, and reps", () => {
  const bare = readiness({ crmCounts: { accounts: 8 }, repCount: 2, routing: { salesOperations: { objectId: "00000000-0000-0000-0000-000000000097" } } }, {
    publicBaseUrl: "",
    acs: { endpoint: "", connectionString: "", teamsCloud: "public" },
    voiceLive: { endpoint: "", apiKey: "", model: "gpt-realtime", apiVersion: "2026-04-10" },
    crm: { adapter: "sqlite" },
    pinRequiredForPstn: true,
  });
  assert.equal(bare.voiceLive.ready, false);
  assert.equal(bare.voiceLive.auth, "entra");
  assert.deepEqual(bare.telephony.missing, ["ACS_ENDPOINT", "PUBLIC_BASE_URL"]);
  assert.equal(bare.teams.ready, false);
  assert.equal(bare.crm.seedCounts.accounts, 8);
  assert.equal(bare.reps.count, 2);
});

