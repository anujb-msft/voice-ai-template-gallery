import { test } from "node:test";
import assert from "node:assert/strict";
import { teamsIdentifier, buildCustomCallingContext, resourceAccountFrom } from "../src/handoff.mjs";
import { AGENT_TOOLS, buildInstructions, localeLanguage } from "../src/agent.mjs";
import { HoursPolicy, Catalog } from "../src/policy.mjs";

test("sales queue is addressed as a Teams app", () => { assert.deepEqual(teamsIdentifier({ type:"callQueue", objectId:"queue" }), { teamsAppId:"queue", cloud:"public" }); });
test("missing Teams object id fails loudly", () => { assert.throws(()=>teamsIdentifier({ type:"callQueue" }),/objectId/); });
test("handoff context becomes VoIP headers with CallTopic <= 48 chars", () => { const headers=buildCustomCallingContext({ sessionId:"s", callTopic:"x".repeat(80), callContext:"needs bolts", routeId:"sales", afterHours:false }); assert.ok(headers.every(h=>h.kind==="voip")); assert.equal(headers.find(h=>h.key==="CallDetails.CallTopic").value.length,48); assert.equal(headers.find(h=>h.key==="CallDetails.RouteId").value,"sales"); });
test("absent handoff fields are omitted", () => { const keys=buildCustomCallingContext({ sessionId:"s", callTopic:"Sales inquiry" }).map(h=>h.key); assert.deepEqual(keys,["CallDetails.SessionId","CallDetails.CallTopic"]); });
test("TPE resource account is parsed from raw id", () => { assert.equal(resourceAccountFrom({ rawId:"28:orgid:cc123456-5678-5678-1234-ccc123456789" }),"cc123456-5678-5678-1234-ccc123456789"); assert.equal(resourceAccountFrom({ rawId:"4:+14255550193" }),null); });
test("agent tool surface has only server-owned tools", () => { assert.deepEqual(AGENT_TOOLS.map(t=>t.name).sort(),["classify_non_sales","end_call","lookup_catalog","save_lead"]); assert.ok(!JSON.stringify(AGENT_TOOLS).match(/score|owner|teamsAppId|phoneNumber/)); });
test("instructions disclose assistant and forbid prices, stock, and budget", () => { const instructions=buildInstructions({ hours:HoursPolicy.load("./config/hours.json"), catalog:Catalog.load("./config/catalog.json") },"en-US"); assert.match(instructions,/automated assistant/i); assert.match(instructions,/Never ask for budget/i); assert.match(instructions,/Never quote prices, stock/i); assert.doesNotMatch(instructions,/00000000-0000/); });
test("locale helper returns Voice Live transcription code", () => { assert.deepEqual(localeLanguage("fr-FR"), { locale:"fr-FR", code:"fr", label:"French (France)" }); });
