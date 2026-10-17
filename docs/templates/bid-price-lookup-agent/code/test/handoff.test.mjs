import { test } from "node:test";
import assert from "node:assert/strict";

import { teamsIdentifier, buildCustomCallingContext, resourceAccountFrom } from "../src/handoff.mjs";
import { AGENT_TOOLS, buildInstructions, forModel, localeLanguage } from "../src/agent.mjs";
import { PriceBook, LocationDirectory, FixtureFeed } from "../src/pricing.mjs";

const PATHS = { bidsPath: "./config/bids.json", futuresPath: "./config/futures.json", marketPath: "./config/market.json" };
const priceBookAt = (iso) => new PriceBook({
  locations: LocationDirectory.load("./config/locations.json"),
  feed: new FixtureFeed(PATHS),
  now: () => new Date(iso),
  options: { softStaleMinutes: 20, hardLimitMinutes: 240 },
});

test("Teams identifiers use app ids for queues and user ids for merchandisers", () => {
  assert.deepEqual(teamsIdentifier({ type: "callQueue", objectId: "queue-guid" }), { teamsAppId: "queue-guid", cloud: "public" });
  assert.deepEqual(teamsIdentifier({ type: "user", objectId: "user-guid" }), { microsoftTeamsUserId: "user-guid" });
  assert.throws(() => teamsIdentifier({ type: "user" }), /objectId/);
});

test("handoff context is sent as bounded VoIP headers", () => {
  const headers = buildCustomCallingContext({ sessionId: "s", callTopic: "Sell corn – Riverside", callContext: "x".repeat(5000), locationId: "riverside", reason: "sell_request" });
  assert.ok(headers.every((h) => h.kind === "voip"));
  assert.equal(headers.find((h) => h.key === "CallDetails.CallTopic").value, "Sell corn – Riverside");
  assert.equal(headers.find((h) => h.key === "CallDetails.CallContext").value.length, 1024);
  assert.equal(headers.find((h) => h.key === "CallDetails.LocationId").value, "riverside");
});

test("Teams Phone extensibility resource account is detected from rawId", () => {
  assert.equal(resourceAccountFrom({ kind: "unknown", rawId: "28:orgid:cc123456-5678-5678-1234-ccc123456789" }), "cc123456-5678-5678-1234-ccc123456789");
  assert.equal(resourceAccountFrom({ kind: "phoneNumber", rawId: "4:+14255550100" }), null);
});

test("agent tool schema has no destination target fields and declares the required tools", () => {
  assert.deepEqual(AGENT_TOOLS.map((t) => t.name).sort(), ["end_call", "get_bid", "list_bids", "repeat_last", "request_callback", "transfer_to_merchandiser"]);
  for (const tool of AGENT_TOOLS) {
    for (const name of Object.keys(tool.parameters.properties)) {
      assert.ok(!/phone|objectid|url|uri|target|teams/i.test(name), `${tool.name}.${name} exposes a destination`);
    }
  }
  const reasons = AGENT_TOOLS.find((t) => t.name === "transfer_to_merchandiser").parameters.properties.reason.enum;
  assert.ok(reasons.includes("contract_request") && reasons.includes("feed_outage"));
});

test("instructions enforce disclosure, no-advice boundary, no contracts, and no invented numbers", () => {
  const instructions = buildInstructions(priceBookAt("2026-09-08T15:45:00Z"), "en-US");
  assert.match(instructions, /automated assistant/i);
  assert.match(instructions, /Bids are subject to change without notice/);
  assert.match(instructions, /Every number you say must be inside a phrase returned by a tool/);
  assert.match(instructions, /Never advise whether to sell/);
  assert.match(instructions, /You cannot lock in, book, hedge or contract a price/);
  assert.match(instructions, /Never say that a price is locked, held or reserved/);
  assert.match(instructions, /If pricing data is unavailable, say so without any number/);
  assert.ok(!instructions.includes("00000000"));
});

test("the model sees the words to read and the flags to act on, never raw numbers or targets", () => {
  const quote = priceBookAt("2026-09-08T15:45:00Z").quote({ commodity: "corn", location: "Riverside" });
  const seen = forModel(quote);
  assert.equal(seen.phrase, "Corn at Riverside for November delivery is $4.12, that's 35 under December futures, as of 10:42 AM.");
  assert.equal(seen.freshness, "live");
  for (const hidden of ["cashBid", "basisCents", "futuresPrice", "asOf", "source", "locationId"]) assert.equal(seen[hidden], undefined, hidden);
  assert.deepEqual(forModel({ ok: false, clarify: true, message: "Did you mean Riverbend or Riverside?", target: { objectId: "x" } }), { ok: false, clarify: true, message: "Did you mean Riverbend or Riverside?" });
  assert.deepEqual(forModel(null), {});
});

test("locale helper drives opening language and Voice Live transcription hint", () => {
  assert.deepEqual(localeLanguage("fr-FR"), { locale: "fr-FR", code: "fr", label: "French (France)" });
  assert.equal(localeLanguage("en-US").code, "en");
});
