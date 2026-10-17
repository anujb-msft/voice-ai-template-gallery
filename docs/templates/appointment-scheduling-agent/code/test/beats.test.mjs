/**
 * The console's beats (public/beats.js) are the offline scripts
 * (src/offline.mjs SCRIPTS), step for step, and they end the same way every
 * time: run from the top, run again after a reset, or run one at a time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createBeats } from "../public/beats.js";
import { SCRIPTS } from "../src/offline.mjs";
import { SqliteAudit } from "../src/db.mjs";
import { makeFlow, runScript, trail } from "./harness.mjs";

const ORDER = ["book", "book-whatever", "race", "referral", "identity-fails"];
const ACTIONS = { "take-slot": "@take-slot", "model-book": "@tool book" };

/** What happened to each beat's call, run in order on one server. */
const EXPECTED = [
  "booked:A-20440",
  "booked:A-20441",
  // A-20442 is the front desk's booking: the time taken out from under Avery.
  "booked:A-20443",
  "transferred:referral_coordinator",
  "transferred:scheduling_team",
];

/** The footer the last beat ends on. */
const FINALE = {
  calls: 5,
  booked: 3,
  refusedWrites: 3,
  racesLost: 1,
  racesResolved: 1,
  takenElsewhere: 1,
  handoffs: 2,
  eligibilityBlocks: 1,
  identityNotConfirmed: 1,
};

function recorder() {
  const calls = [];
  return {
    calls,
    hooks: {
      setClock: async (preset) => void calls.push(`clock:${preset}`),
      resetDemo: async () => void calls.push("reset"),
    },
  };
}

const beats = createBeats(recorder().hooks);

/** A beat as the offline driver types it: the caller's lines, and the demo actions as @-steps. */
function asScript(beat) {
  const [start, ...rest] = beat.steps;
  assert.equal(start.type, "start", `${beat.title} answers its own call first`);
  const lines = [];
  for (const step of rest) {
    if (step.type === "say") lines.push(step.text);
    else if (step.type === "action" && step.action in ACTIONS) lines.push(ACTIONS[step.action]);
    else if (step.type === "action" && step.action === "metrics") continue;
    else assert.fail(`${beat.title}: unexpected step ${JSON.stringify(step)}`);
  }
  return { phone: start.fromPhone, lines };
}

async function runAll(ctx) {
  const results = [];
  for (const name of ORDER) results.push(await runScript(ctx, SCRIPTS[name]));
  return results;
}

const pick = (stats) => Object.fromEntries(Object.keys(FINALE).map((key) => [key, stats[key]]));

test("the beats are the offline scripts, step for step", () => {
  assert.deepEqual(Object.keys(SCRIPTS), ORDER);
  assert.equal(beats.length, ORDER.length);
  beats.forEach((beat, i) => assert.deepEqual(asScript(beat), SCRIPTS[ORDER[i]], beat.title));
});

test("every beat pins the clock; the first also resets the demo", async () => {
  for (const [i, beat] of beats.entries()) {
    const { calls, hooks } = recorder();
    await createBeats(hooks)[i].prepare();
    assert.deepEqual(calls, i === 0 ? ["reset", "clock:tue-morning"] : ["clock:tue-morning"], beat.title);
  }
});

test("the narration is written for the room, and the demo ends on the metrics", () => {
  for (const beat of beats) {
    for (const key of ["title", "talk", "after"]) assert.ok(typeof beat[key] === "string" && beat[key].length > 3, `${beat.title}: ${key}`);
    for (const step of beat.steps) {
      if (step.cue != null) assert.equal(typeof step.cue, "string");
      if (step.type === "start") assert.match(step.fromPhone, /^\+1\d{3}55501\d\d$/, "fictional 555-01xx numbers only");
      if (step.type === "action") assert.ok(step.label, `${beat.title}: an action says what it does`);
    }
  }
  assert.deepEqual(beats.at(-1).steps.at(-1), { ...beats.at(-1).steps.at(-1), type: "action", action: "metrics" });
  assert.ok(beats.every((beat, i) => i === beats.length - 1 || !beat.steps.some((s) => s.action === "metrics")));
});

test("run from the top, each beat ends the way its narration says", async () => {
  const ctx = await makeFlow();
  const [book, whatever, race, referral, noId] = await runAll(ctx);
  assert.deepEqual([book, whatever, race, referral, noId].map((c) => c.outcome), EXPECTED);

  // 1. Booked: all four checks pass, on the caller's own yes.
  assert.deepEqual(book.checks.map((c) => c.status), ["pass", "pass", "pass", "pass"]);
  assert.equal(book.booking.consent, "said yes");

  // 2. Two refused writes, then a booking on the caller's yes.
  assert.equal(whatever.refusals, 2);
  const mia = trail(ctx.audit, whatever.id);
  assert.ok(mia.some((e) => /^caller write_refused no active proposal/.test(e)), mia.join("\n"));
  assert.ok(mia.some((e) => /^agent write_refused the model has no booking tool/.test(e)), mia.join("\n"));
  assert.equal(whatever.booking.consent, "said yes");

  // 3. The race: the yes to P1 is refused, a fresh pick (P2) gets a fresh yes, and the time is a different one.
  assert.equal(race.races, 1);
  assert.equal(race.booking.proposalId, "P2");
  assert.equal(race.booking.afterRace, true);
  assert.notEqual(race.booking.label, race.raceLost.label);
  const avery = trail(ctx.audit, race.id);
  for (const kind of ["taken_elsewhere", "write_refused P1 · slot_taken", "slot_taken P1 void", "race_resolved"]) {
    assert.ok(avery.some((e) => e.startsWith(`system ${kind}`)), `${kind}\n${avery.join("\n")}`);
  }

  // 4. Eligibility, not the model, says no; the coordinator sees why.
  assert.equal(referral.checks.find((c) => c.id === "eligibility").status, "fail");
  assert.equal(referral.handoff.callContext.ruleId, "REFERRAL_REQUIRED");
  assert.equal(referral.handoff.callTopic, "Scheduling – referral needed");

  // 5. Not verified: nothing about appointments said, and no patient details on the toast.
  assert.equal(noId.checks.find((c) => c.id === "identity").status, "fail");
  assert.equal(noId.handoff.callContext.firstName, undefined);
  assert.equal(noId.handoff.callContext.verified, "no");
  const lines = noId.transcript.filter((t) => t.role === "agent").map((t) => t.text).join(" ");
  assert.doesNotMatch(lines, /Dr\.|a\.m\.|p\.m\.|A-\d|Jordan/);

  assert.deepEqual(pick(ctx.audit.stats()), FINALE);
});

test("after a reset, a second run gives the same calls and the same numbers", async () => {
  const ctx = await makeFlow();
  const first = (await runAll(ctx)).map((c) => [c.outcome, c.booking?.label ?? null]);

  // What POST /api/demo/reset does in simulation.
  ctx.flow.reset();
  ctx.audit.reset();
  ctx.schedule.reseed();
  const second = (await runAll(ctx)).map((c) => [c.outcome, c.booking?.label ?? null]);

  assert.deepEqual(second, first);
  assert.deepEqual(pick(ctx.audit.stats()), FINALE);
});

test("each beat on its own ends the same way it does in the running order", async () => {
  for (const [i, name] of ORDER.entries()) {
    const ctx = await makeFlow();
    const call = await runScript(ctx, SCRIPTS[name]);
    assert.equal(call.outcome.split(":")[0], EXPECTED[i].split(":")[0], name);
    if (call.outcome.startsWith("transferred:")) assert.equal(call.outcome, EXPECTED[i], name);
  }
});

test("the SQLite audit counts the finale the same as the in-memory one", async () => {
  const audit = await SqliteAudit.open(":memory:", { driver: "node:sqlite" });
  const ctx = await makeFlow({ audit });
  await runAll(ctx);
  assert.deepEqual(pick(audit.stats()), FINALE);
});
