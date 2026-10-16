import assert from "node:assert/strict";
import { test } from "node:test";
import { Leg } from "../src/leg.mjs";

/** An utterance the leg has already cut and transcribed, which began `at` ms into the call. */
const utterance = (text, at) => ({ text, at, ms: 1000, endedAt: 0, locale: null, done: Promise.resolve() });

test("the agent's reply is what it began saying after the caller's last line or key press", async () => {
  const leg = new Leg({ id: "leg-1", client: null, direction: "outbound", remote: "+15550100" });
  // ACS confirms each tone as soon as it is sent.
  leg.connection = () => ({
    getCallMedia: () => ({
      sendDtmfTones: async (_tones, _to, { operationContext }) => leg.pending.get(operationContext).resolve(),
    }),
  });

  leg.utterances.push(utterance("Press one for billing.", 0));
  assert.equal(await leg.hear({ gapMs: 0 }), "Press one for billing.");
  assert.deepEqual(leg.reply, ["Press one for billing."], "before the caller acts, everything is the reply");

  const pressedAt = leg.elapsed;
  await leg.dtmf("1", { waitQuietMs: 0 });
  assert.deepEqual(leg.reply, [], "a key press starts a new reply");
  // The menu was still being read when the key went in; the next turn starts with the rest of it.
  leg.utterances.push(utterance("Or two for support.", pressedAt - 500), utterance("Billing. What's your account number?", leg.elapsed + 10));
  assert.equal(await leg.hear({ gapMs: 0 }), "Or two for support. Billing. What's your account number?");
  assert.deepEqual(leg.reply, ["Billing. What's your account number?"]);
});
