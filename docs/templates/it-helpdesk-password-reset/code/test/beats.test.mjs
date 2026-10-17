import { test } from "node:test";
import assert from "node:assert/strict";

// Pin the shipped knowledge base; knowledge.mjs honors KNOWLEDGE_FILE.
delete process.env.KNOWLEDGE_FILE;
const { createBeats } = await import("../public/beats.js");
const { ResetFlow } = await import("../src/flow.mjs");
const { DEMO_EMPLOYEES, MemoryAudit, MemoryDirectory, MemoryTicketing } = await import("../src/store.mjs");
const { HANDOFF_REASONS } = await import("../src/handoff.mjs");
const { findAnswer } = await import("../src/knowledge.mjs");
const { registerSimulatedAgent } = await import("../src/offline.mjs");

/**
 * The scripted demo, run in-process the way the console drives the server:
 * every beat in public/beats.js, step by step, against the same state machine,
 * offline agent and stores. When a line stops producing what its narration
 * promises, this fails here rather than on stage.
 */

// The server's clock presets (src/server.mjs).
const PRESETS = {
  "start-of-shift": Date.parse("2026-09-30T09:05:00-07:00"),
  "seven-minutes-later": Date.parse("2026-09-30T09:12:00-07:00"),
};
const ALEX = DEMO_EMPLOYEES.find((e) => e.username === "alex.morgan");
const settle = () => new Promise((r) => setTimeout(r, 10));

/** Record whose record the directory is asked about. */
function spyOn(directory, lookups) {
  const subject = {
    findByUsername: (username) => username,
    findById: (id) => id,
    authenticate: (username) => username,
    setPassword: (id) => id,
    unlockAccount: (id) => id,
    validatePasswordPolicy: (_password, user) => user?.username,
  };
  for (const [name, who] of Object.entries(subject)) {
    const original = directory[name].bind(directory);
    directory[name] = (...args) => {
      lookups.push(String(who(...args)));
      return original(...args);
    };
  }
  return directory;
}

/** The server in-process, and a console that plays the employee's phone and browser. */
function demoServer() {
  let clock = PRESETS["start-of-shift"];
  let minted = 0;
  const frames = [];
  const lookups = [];
  const codesRead = [];
  const sandbox = { directory: spyOn(new MemoryDirectory(), lookups), ticketing: new MemoryTicketing() };
  const audit = new MemoryAudit();
  const flow = new ResetFlow({
    stores: sandbox,
    sandbox,
    audit,
    hub: { send: (callId, target, payload) => frames.push({ callId, target, payload }) },
    now: () => clock,
    monotonic: () => clock,
    options: {
      timeZone: "America/Los_Angeles",
      codeGenerator: () => String(314159 + 111111 * minted++).slice(-6),
    },
  });

  const setClock = async (preset) => {
    assert.ok(preset in PRESETS, `unknown clock preset "${preset}"`);
    clock = PRESETS[preset];
  };
  const beats = createBeats({ setClock });
  let call = null;

  /** The browser side, as /api/simulate/:id/portal/* runs it: in the call's queue, with the agent listening. */
  async function portal(fn) {
    let result;
    await flow.run(call.id, () =>
      call.agent.collect(async () => {
        result = await fn(call.id);
      }),
    );
    return result;
  }

  const actions = {
    clock: (step) => setClock(step.preset),
    portalCode: () =>
      portal((id) => {
        const { code } = flow.handset(id);
        codesRead.push(code);
        return flow.submitCode(id, code);
      }),
    portalPassword: async ({ password }) => {
      await portal((id) => flow.checkPassword(id, password));
      return portal((id) => flow.submitPassword(id, password));
    },
    metrics: () => audit.stats(),
  };

  const steps = {
    async start({ username }) {
      sandbox.directory.restore(username);
      const { callId: id } = await flow.start({ username, simulated: true });
      call = { id, agent: registerSimulatedAgent(flow, id) };
      await flow.run(id, () => flow.callbackSimulated(id));
      return flow.run(id, () => call.agent.collect(() => flow.answered(id)));
    },
    say: ({ text }) => flow.run(call.id, () => call.agent.hear(text)),
    dtmf: ({ digit }) => flow.run(call.id, () => call.agent.press(digit)),
    silence: () => flow.run(call.id, () => call.agent.silence()),
    action: (step) => actions[step.action](step),
  };

  /** One beat, as the director runs it: prepare, then every step in order. */
  async function play(index) {
    const beat = beats[index];
    await beat.prepare();
    lookups.length = 0;
    codesRead.length = 0;
    const results = [];
    for (const step of beat.steps) results.push(await steps[step.type](step));
    await settle();
    const { id } = call;
    const mine = frames.filter((f) => f.callId === id);
    return {
      id,
      results,
      snap: flow.snapshot(id),
      events: audit.eventsFor(id),
      said: (role) => audit.eventsFor(id).filter((e) => e.kind === "transcript" && e.source === role).map((e) => e.detail),
      frames: (target) => mine.filter((f) => f.target === target).map((f) => f.payload),
      lookups: [...lookups],
      codesRead: [...codesRead],
      // Everything the hub carried and the audit kept for this call, the call id taken out.
      carried: JSON.stringify([mine, audit.eventsFor(id)]).split(id).join("<call>"),
    };
  }

  return { flow, audit, sandbox, beats, play };
}

const outcome = ({ snap }) => ({ state: snap.state, outcome: snap.outcome, escalation: snap.escalation?.reason ?? null });

test("the demo is the six beats the script narrates; each pins the clock and places its own callback", () => {
  const { beats } = demoServer();
  assert.deepEqual(
    beats.map((b) => b.title),
    ["Locked out, reset by phone", "Wrong digits", "Pressure to skip", "An approved answer", "Keypad on a noisy line", "Too slow, then a person"],
  );
  for (const beat of beats) {
    assert.equal(typeof beat.prepare, "function", beat.title);
    assert.equal(beat.steps[0].type, "start", beat.title);
    assert.ok(beat.talk && beat.after, `${beat.title} has narration`);
  }
  assert.equal(beats.at(-1).steps.at(-1).action, "metrics");
});

// One run-through, in order, on one server: what the room sees.
const show = demoServer();
const firstRun = [];

test("beat 1, Locked out, reset by phone: verified, the code typed on the page, a weak password coached, then reset", async () => {
  const run = await show.play(0);
  firstRun.push(outcome(run));
  const { snap } = run;
  assert.deepEqual(outcome(run), { state: "completed", outcome: "reset_completed", escalation: null });
  assert.equal(snap.via, "Teams Phone extensibility (simulated)");
  // The number on file in the directory, masked; a ticket is open before the phone rings.
  assert.equal(snap.phone, "+1••••••0142");
  assert.equal(run.events[0].kind, "ticket_created");
  assert.equal(run.said("caller")[0], "Sure, it's [ID digits withheld].");

  const [, , code, weak, strong] = run.results;
  assert.deepEqual(code, { ok: true });
  assert.equal(weak.ok, false);
  assert.deepEqual(weak.failures, ["It needs to be at least 12 characters long.", "It can't contain part of your name."]);
  assert.deepEqual(strong, { ok: true });
  assert.ok(run.said("agent").includes("Not quite. It needs to be at least 12 characters long. It can't contain part of your name. Try another one."));

  assert.equal((await show.sandbox.directory.authenticate("alex.morgan", "Harbor-Lantern-42!")).ok, true);
  assert.equal((await show.sandbox.ticketing.getTicket(snap.ticketId)).status, "closed_deflected");
  assert.equal(snap.callEnded, true);
  assert.equal(snap.endReason, "ended");

  // The agent coached on the rules but never heard the password, and the code went only to the phone.
  assert.equal(run.codesRead.length, 1);
  for (const secret of ["Alex-2026!", "Harbor-Lantern-42!", "4217", ...run.codesRead]) {
    assert.equal(run.carried.includes(secret), false, `${secret} leaked`);
  }
});

test("beat 2, Wrong digits: two misses close verification; the agent reveals nothing and offers the service desk", async () => {
  const run = await show.play(1);
  firstRun.push(outcome(run));
  const { snap } = run;
  assert.deepEqual(outcome(run), { state: "verification_failed", outcome: "verification_failed", escalation: null });
  assert.equal(snap.attempts, 2);
  assert.equal(snap.code.codesIssued, 0);
  assert.equal(snap.callEnded, true);

  const agent = run.said("agent");
  assert.ok(agent.some((line) => line.includes("I can put you through to the IT service desk")));
  assert.equal(agent.at(-1), "Okay. Nothing on your account has changed. If you need help later, the IT service desk can take it from there. Goodbye.");
  // Never how close the digits were, whether the account is locked, or any digit at all.
  for (const line of agent) assert.doesNotMatch(line, /\d|lock|close|digit(?:s)? (?:were|was)/i);
  for (const line of run.said("caller")) assert.doesNotMatch(line, /\d|\b(?:one|two|three|four|six|seven|eight|nine)\b/i);
  assert.equal((await show.flow.issueVerificationCode(run.id)).code, undefined);
});

test("beat 3, Pressure to skip: no path past verification, nobody else's record, and a flagged handoff in Teams", async () => {
  const run = await show.play(2);
  firstRun.push(outcome(run));
  const { snap } = run;
  assert.deepEqual(outcome(run), { state: "escalated", outcome: "escalated:other_account_request", escalation: "other_account_request" });
  assert.deepEqual(snap.refusals, ["skip_verification", "other_account"]);
  assert.equal(snap.verified, false);
  assert.equal(snap.endReason, "transferred");

  // The first push: refused, and the agent asks for the digits again.
  const [, skip] = run.results;
  assert.deepEqual(skip.tools, ["refuse_request"]);
  assert.match(skip.said.join(" "), /I can't skip that\..*Can you tell me the last four digits of your employee ID\?$/);

  // Only the employee who asked was ever looked up.
  assert.ok(run.lookups.length > 0);
  assert.ok(run.lookups.every((who) => who === "alex.morgan" || who === ALEX.id), run.lookups.join(", "));

  // The Teams panel: topic, risk, ticket and an unverified caller, and the same in the VoIP headers.
  const handoffs = run.frames("handoff");
  assert.equal(handoffs.length, 1);
  const [handoff] = handoffs;
  assert.equal(handoff.topic, HANDOFF_REASONS.other_account_request.topic);
  assert.equal(handoff.risk, "Asked to reset another employee's password");
  assert.equal(handoff.ticketId, snap.ticketId);
  assert.equal(handoff.caller.verified, false);
  const headers = Object.fromEntries(handoff.voipHeaders.map((h) => [h.key, h.value]));
  assert.equal(headers["CallDetails.CallTopic"], handoff.topic);
  assert.equal(headers["CallDetails.Risk"], handoff.risk);
  assert.equal(headers["CallDetails.TicketId"], snap.ticketId);
  assert.equal(JSON.parse(headers.CallerDetails).verified, false);
  assert.equal((await show.sandbox.ticketing.getTicket(snap.ticketId)).status, "closed_escalated");
});

test("beat 4, An approved answer: reset, then the VPN question answered from the knowledge base", async () => {
  const run = await show.play(3);
  firstRun.push(outcome(run));
  const { snap } = run;
  assert.deepEqual(outcome(run), { state: "completed", outcome: "reset_completed", escalation: null });
  assert.equal(snap.answers, 1);
  assert.equal(snap.callEnded, true);

  const entry = findAnswer("My VPN still says my password is wrong.");
  assert.equal(entry.question, "My VPN still says my password is wrong.");
  const [firstSentence] = entry.answer.split(/(?<=[.!?])\s+/);
  const [, , , , question] = run.results;
  assert.deepEqual(question.tools, ["answer_question"]);
  assert.ok(question.said[0].startsWith(firstSentence), question.said[0]);
  assert.ok(run.events.some((e) => e.kind === "kb_answer"));
  assert.ok(run.frames("state").some((s) => s.decision?.headline === "From the approved knowledge base"));
});

test("beat 5, Keypad on a noisy line: silence offers the keypad, and the digits appear nowhere", async () => {
  const run = await show.play(4);
  firstRun.push(outcome(run));
  assert.deepEqual(outcome(run), { state: "completed", outcome: "reset_completed", escalation: null });

  const [, silence] = run.results;
  assert.match(silence.said.join(" "), /type them on your phone's keypad/);
  assert.match(run.events.find((e) => e.kind === "identity_verified").detail, /\(keypad\)$/);
  assert.ok(run.events.some((e) => e.kind === "transcript" && e.detail === "Entered four digits on the keypad."));
  assert.doesNotMatch(run.carried, /4217|four,? two,? one,? seven/i);
  for (const code of run.codesRead) assert.equal(run.carried.includes(code), false);
});

test("beat 6, Too slow, then a person: the stale code is refused, a fresh one read, then a handoff with the mood", async () => {
  const run = await show.play(5);
  firstRun.push(outcome(run));
  const { snap } = run;
  assert.deepEqual(outcome(run), { state: "escalated", outcome: "escalated:caller_requested_person", escalation: "caller_requested_person" });

  const [, , , stale, , metrics] = run.results;
  assert.deepEqual(stale, { ok: false, reason: "expired" });
  assert.match(run.events.find((e) => e.kind === "code_expired").detail, /^read at 9:05\sAM, typed at 9:12\sAM$/);
  assert.ok(run.said("agent").includes("Sorry, that code had expired; codes only last five minutes. Here's a fresh code: [code withheld]."));
  assert.equal(snap.code.codesIssued, 2);

  const [handoff] = run.frames("handoff");
  assert.equal(handoff.sentiment, "Frustrated");
  assert.equal(handoff.caller.verified, true);
  assert.match(handoff.context, /^Identity verified with the last four digits of the employee ID; 2 one-time codes read aloud, 1 expired; no changes made to the account\./);
  assert.equal(snap.endReason, "transferred");

  // The numbers the beat ends on.
  assert.deepEqual(metrics, {
    callbacks: 6,
    verified: 4,
    resetsCompleted: 3,
    refused: 3,
    handedOff: 2,
    kbAnswers: 1,
    medianSecondsToReset: 1,
  });
});

test("a second run-through on the same server ends every beat the same way", async () => {
  assert.equal(firstRun.length, 6);
  const again = [];
  for (let i = 0; i < 6; i += 1) again.push(outcome(await show.play(i)));
  assert.deepEqual(again, firstRun);
  assert.equal(show.audit.stats().callbacks, 12);
});

test("any beat can be run on its own, in any order", async () => {
  const fresh = demoServer();
  const reversed = [];
  for (let i = 5; i >= 0; i -= 1) reversed.unshift(outcome(await fresh.play(i)));
  assert.deepEqual(reversed, firstRun);
});

test("after a demo reset the numbers start from zero and the story plays again", async () => {
  const stage = demoServer();
  for (let i = 0; i < 6; i += 1) await stage.play(i);
  stage.flow.reset();
  stage.sandbox.directory.reset();
  stage.sandbox.ticketing.reset();
  stage.audit.reset();
  assert.deepEqual(stage.audit.stats(), {
    callbacks: 0,
    verified: 0,
    resetsCompleted: 0,
    refused: 0,
    handedOff: 0,
    kbAnswers: 0,
    medianSecondsToReset: null,
  });
  const run = await stage.play(0);
  assert.equal(run.snap.ticketId, "INC0007001");
  assert.deepEqual(outcome(run), firstRun[0]);
});
