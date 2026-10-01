import { test } from "node:test";
import assert from "node:assert/strict";

import { teamsIdentifier, buildCustomCallingContext, resourceAccountFrom } from "../src/handoff.mjs";
import { AGENT_TOOLS, buildInstructions, localeLanguage } from "../src/agent.mjs";
import { readiness } from "../src/config.mjs";
import { SqliteCrmAdapter } from "../src/db.mjs";
import { RepDirectory } from "../src/providers/crm.mjs";
import { MemoryAudit } from "../src/audit.mjs";
import { CustomerRecordFlow } from "../src/flow.mjs";

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
  const crm = new SqliteCrmAdapter({ path: ":memory:" });
  const flow = new CustomerRecordFlow({ crm, reps: RepDirectory.load(), audit: new MemoryAudit(), now: () => Date.parse("2026-06-10T19:00:00Z") });
  const call = flow.startSimulation({ repId: "rep-alex" });
  flow.findAccount(call.id, "Fabrikam");
  const p = flow.proposeUpdate(call.id, "acct-fabrikam", "Log the Fabrikam meeting. Dana agreed to the renewal at 240k, moving to Closed Won, close date June 15th.");
  const ctx = flow.handoffContext(flow.get(call.id), "explicit_request");
  assert.equal(ctx.sessionId, call.id);
  assert.ok(ctx.callTopic.length <= 48);
  assert.match(ctx.callContext, /Alex Morgan/);
  assert.match(ctx.callContext, /Fabrikam/);
  assert.match(ctx.callContext, /proposal/);
  assert.ok(!ctx.callContext.includes("246810"));
  assert.ok(!ctx.callContext.includes("12065550120"));
  assert.equal(p.ok, true);
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

