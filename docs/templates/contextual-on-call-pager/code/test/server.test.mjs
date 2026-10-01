import test from "node:test";
import assert from "node:assert/strict";
import { readiness, config } from "../src/config.mjs";
import { PagerPolicy } from "../src/policy.mjs";

await test("readiness reports Voice Live direct mode, current on-call, and simulation", () => {
  const policy = PagerPolicy.load();
  const ready = readiness(policy, { lagMs: () => 12, pendingCount: () => 2 }, { ...config, acs: { ...config.acs, endpoint: "", connectionString: "" }, publicBaseUrl: "", voiceLive: { ...config.voiceLive, endpoint: "" } });
  assert.equal(ready.voiceLive.model, "gpt-realtime");
  assert.equal(ready.voiceLive.apiVersion, "2026-04-10");
  assert.equal(ready.voiceLive.directMode, true);
  assert.equal(ready.simulationMode, true);
  assert.equal(ready.scheduler.pendingJobs, 2);
  assert.ok(ready.currentOnCall.central.primary.name);
});
