import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanEnv, scenarioStatus } from "../src/runner.mjs";
import { TemplateProbe } from "../src/probe.mjs";
import { CheckFailed, ScenarioContext } from "../src/scenario.mjs";

/** The caller's side of a call: the agent's turns are scripted, and what the caller does is recorded. */
function fakeLeg(turns = []) {
  const consumed = [];
  return {
    ended: false,
    actions: [],
    reply: [],
    async hear() {
      const text = turns.shift() ?? null;
      if (text) {
        consumed.push(text);
        this.reply.push(text);
      }
      return text;
    },
    async say(text) {
      this.actions.push(text);
      this.reply = [];
    },
    async dtmf(digits) {
      this.actions.push({ dtmf: digits });
      this.reply = [];
    },
    async hangup() {
      this.ended = true;
    },
    transcript: () => consumed.join(" "),
  };
}

/** A template that recorded `events` (an array, or a function for events that arrive later) and `record`. */
function context({ events = [], record = null, harness = null, turns } = {}) {
  const logs = [];
  const probe = {
    mark: () => 0,
    waitForNewId: async () => "call-1",
    newIds: () => ["call-1"],
    events: async () => (typeof events === "function" ? events() : events),
    record: async () => (typeof record === "function" ? record() : record),
    messagesFor: () => [],
  };
  const t = new ScenarioContext({ harness, probe, suite: { probe: {} }, scenario: {}, runtime: null, log: (l) => logs.push(l) });
  if (turns) {
    t.leg = fakeLeg(turns);
    t.legs.push(t.leg);
  }
  return { t, logs };
}

test("a failed check ends the scenario unless it is soft or fatal:false", () => {
  const { t, logs } = context();
  t.check("passes", 1, { x: 1 });
  t.check("model wording", false, "heard something else", { soft: true });
  t.check("a broken promise the call survives", false, null, { fatal: false });
  assert.throws(() => t.check("the flow is broken", false, "x".repeat(1000)), CheckFailed);
  assert.deepEqual(
    t.checks.map((c) => [c.name, c.ok, c.soft]),
    [
      ["passes", true, false],
      ["model wording", false, true],
      ["a broken promise the call survives", false, false],
      ["the flow is broken", false, false],
    ],
  );
  assert.equal(t.checks[0].detail, "[object Object]");
  assert.equal(t.checks[2].detail, null);
  assert.equal(t.checks[3].detail.length, 400);
  assert.deepEqual(
    logs.map((l) => l.trim()[0]),
    ["✓", "~", "✗", "✗"],
  );
});

test("scenario status: errors, then failures (fatal or not), then warnings", () => {
  const pass = { ok: true, soft: false };
  const warn = { ok: false, soft: true };
  const fail = { ok: false, soft: false };
  assert.equal(scenarioStatus([]), "pass");
  assert.equal(scenarioStatus([pass, pass]), "pass");
  assert.equal(scenarioStatus([pass, warn]), "warn");
  assert.equal(scenarioStatus([warn, fail, pass]), "fail", "a fatal:false failure still fails the scenario");
  assert.equal(scenarioStatus([pass, fail], new CheckFailed("x")), "fail");
  assert.equal(scenarioStatus([pass], new Error("socket hang up")), "error");
  assert.equal(scenarioStatus([warn], new Error("scenario timed out")), "error");
});

test("cleanEnv drops empty values, so a suite can unset what the harness inherited", () => {
  const inherited = { ACS_CONNECTION_STRING: "endpoint=…", PORT: "8091", KEEP: "1" };
  const suite = { ACS_CONNECTION_STRING: "", PORT: "8091", EXTRA: undefined, NONE: null, ZERO: "0" };
  assert.deepEqual(cleanEnv({ ...inherited, ...suite }), { PORT: "8091", KEEP: "1", ZERO: "0" });
});

test("hear(pattern) keeps listening across turns until the agent says it", async () => {
  const { t } = context({ turns: ["One moment.", "What are the last four digits of your employee ID?", "Thanks."] });
  const heard = await t.hear(/last (four|4)/i);
  assert.equal(heard, "One moment. What are the last four digits of your employee ID?");
  assert.equal(t.checks.at(-1).ok, true);
  assert.equal(await t.hear(), "Thanks.", "no pattern: the next turn, and no check");
  assert.equal(t.checks.length, 1);
  assert.equal(await t.hear({ timeoutMs: 10 }), null, "options as the only argument");
});

test("hear(pattern) records what it did hear when the agent never says it", async () => {
  const { t } = context({ turns: ["Hello, this is the help desk."] });
  const heard = await t.hear(/goodbye/i, { soft: true });
  assert.equal(heard, "Hello, this is the help desk.");
  assert.deepEqual(t.checks.at(-1), {
    name: "agent said /goodbye/i",
    ok: false,
    soft: true,
    detail: "Hello, this is the help desk.",
  });
  await assert.rejects(t.hear(/goodbye/i), CheckFailed);
  assert.equal(t.checks.at(-1).detail, "(nothing)");
});

test("hear(pattern) still takes the turns an ended call left unheard", async () => {
  const { t } = context({ turns: ["Sorry, I can't advise on that.", "Goodbye."] });
  t.leg.ended = true;
  assert.equal(await t.hear(/goodbye/i), "Sorry, I can't advise on that. Goodbye.", "a goodbye said just before the hangup counts");
  assert.equal(t.checks.at(-1).ok, true);

  const left = context({ turns: ["Sorry, I can't."] }).t;
  left.leg.ended = true;
  await left.hear(/call you back/i, { soft: true });
  assert.deepEqual(left.checks.at(-1), {
    name: "agent said /call you back/i",
    ok: false,
    soft: true,
    detail: "Sorry, I can't.; the call had ended",
  });
});

test("replied(pattern) checks the agent's reply to the caller's last line, even turns converse already heard", async () => {
  const { t } = context({ turns: ["Which appointment?", "This is within 24 hours. Should I cancel it?", "Cancelled. Goodbye."] });
  await t.converse({ until: /24 hours/i, replies: [[/which/i, "Tomorrow's follow-up."]] });
  assert.equal(await t.replied(/24 hours/i), "This is within 24 hours. Should I cancel it?", "no new turn needed");
  await t.say("Yes, please.");
  assert.equal(await t.replied(/cancelled/i), "Cancelled. Goodbye.", "listens on while the reply doesn't match");
  await t.replied(/24 hours/i, { soft: true, timeoutMs: 10 });
  assert.deepEqual(
    t.checks.map((c) => c.ok),
    [true, true, false],
  );
  assert.equal(t.checks.at(-1).detail, "Cancelled. Goodbye.", "the caller's new line started a new reply");
});

test("replied(pattern) leaves out words the agent began before the caller's last line", async () => {
  const { t } = context({ turns: [] });
  const turns = ["Or two for support. Billing. What's your account number?"];
  t.leg.hear = async () => {
    const text = turns.shift() ?? null;
    if (text) t.leg.reply.push("Billing. What's your account number?");
    return text;
  };
  await t.replied(/support/i, { soft: true, timeoutMs: 1000 });
  assert.deepEqual(t.checks.at(-1), {
    name: "agent said /support/i",
    ok: false,
    soft: true,
    detail: "Billing. What's your account number?",
  });
});

test("expectHeard checks everything the agent has said on the call", async () => {
  const { t } = context({ turns: ["Hi Alex.", "Your code is ready."] });
  await t.hear();
  await t.hear();
  t.expectHeard(/\bAlex\b/);
  t.expectHeard(/goodbye/i, { soft: true });
  assert.deepEqual(
    t.checks.map((c) => c.ok),
    [true, false],
  );
});

test("on a call the harness joined late, missing the agent's first line only warns", async () => {
  // Media reached the harness 20 s after it dialed: the greeting had already gone by.
  const leg = Object.assign(fakeLeg(["Sure, what's the account number?"]), { direction: "outbound", mediaAt: 20200 });
  const { t } = context({ harness: { dial: async () => leg } });
  await t.dial();
  assert.deepEqual(
    t.checks.map((c) => [c.name, c.ok, c.soft]),
    [
      ["call connected", true, false],
      ["the harness could hear the call from the start", false, true],
    ],
  );
  assert.match(t.checks[1].detail, /20\.2 s after dialing/);

  await t.hear(/thanks for calling/i);
  assert.deepEqual([t.checks.at(-1).ok, t.checks.at(-1).soft], [false, true]);
  assert.match(t.checks.at(-1).detail, /^Sure, what's the account number\?; the harness joined this call late/);
  t.expectHeard(/automated assistant/i);
  assert.deepEqual([t.checks.at(-1).ok, t.checks.at(-1).soft], [false, true]);
  // Later turns were heard in full: they still fail.
  await assert.rejects(t.hear(/goodbye/i, { timeoutMs: 10 }), CheckFailed);
});

test("a late answered call's first listen can be a conversation; later checks stay strict", async () => {
  const leg = Object.assign(fakeLeg(["Hello?", "Is this Alex?"]), { direction: "inbound", mediaAt: 16000 });
  const { t } = context({ harness: { expectIncoming: async () => leg } });
  await t.answer();
  assert.match(t.checks.at(-1).detail, /16\.0 s after answering/);
  await t.converse({ until: /Alex/ });
  await assert.rejects(t.hear(/appointment/i, { timeoutMs: 10 }), CheckFailed);
});

test("a call the harness joined in time keeps every check strict", async () => {
  const leg = Object.assign(fakeLeg(["Hello."]), { direction: "outbound", mediaAt: 4000 });
  const { t } = context({ harness: { dial: async () => leg } });
  await t.dial();
  assert.equal(t.checks.length, 1);
  await assert.rejects(t.hear(/thanks for calling/i), CheckFailed);
  assert.throws(() => t.expectHeard(/automated assistant/i), CheckFailed);
});

test("converse answers each turn from the script until the agent is done", async () => {
  const { t } = context({
    turns: [
      "Hi, what's your name?",
      "Thanks. Press one to confirm your address.",
      "Sorry, I didn't catch that.",
      "And which service is this about?",
      "Your report is filed. Goodbye.",
    ],
  });
  const done = await t.converse({
    until: /report is filed/i,
    replies: [
      [/name/i, "Dana Ruiz"],
      [/press one/i, { dtmf: "1" }],
      [/which service/i, (heard, ctx) => (ctx === t && heard.includes("service") ? "Missed trash pickup" : null)],
    ],
    fallback: "Missed trash pickup on Elm Street.",
  });
  assert.equal(done, true);
  assert.deepEqual(t.leg.actions, [
    "Dana Ruiz",
    { dtmf: "1" },
    "Missed trash pickup on Elm Street.",
    "Missed trash pickup",
  ]);
});

test("converse gives up after maxTurns, and until can be a function", async () => {
  const { t } = context({ turns: ["What's your name?", "What's your name?", "What's your name?", "What's your name?"] });
  const done = await t.converse({ until: (heard) => /goodbye/i.test(heard), replies: [[/name/i, "Dana"]], maxTurns: 3 });
  assert.equal(done, false);
  assert.deepEqual(t.leg.actions, ["Dana", "Dana"], "each reply is used at most twice by default");
});

test("event helpers read the template's audit trail, optionally after a mark", async () => {
  const events = [
    { kind: "identity_confirmed", detail: "4217", source: "tool" },
    { kind: "code_issued", detail: null, source: "tool" },
    { kind: "state", detail: "voice_code: redial", source: "server" },
  ];
  const { t } = context({ events });
  assert.equal(await t.callId(), "call-1");
  assert.equal(await t.eventMark(), 3);
  assert.equal(await t.hasEvent("identity_confirmed", { detail: "4217" }), true);
  assert.equal(await t.hasEvent("identity_confirmed", { since: 1 }), false);
  assert.equal(await t.hasEvent("state", { detail: /redial$/, source: "server" }), true);
  assert.equal(await t.hasEvent("state", { detail: /redial$/, source: "tool" }), false);
  assert.equal(await t.hasEvent(/^code_/), true);
  assert.equal(t.checks.length, 0, "hasEvent and eventMark record no checks");

  const hit = await t.waitForEvent("state", { detail: /redial/ });
  assert.equal(hit.detail, "voice_code: redial");
  await t.expectNoEvent("code_bad");
  await t.expectNoEvent("code_issued", { soft: true });
  assert.deepEqual(
    t.checks.map((c) => [c.name, c.ok]),
    [
      ['event "state" with /redial/', true],
      ['no event "code_bad"', true],
      ['no event "code_issued"', false],
    ],
  );
});

test("waitForEvent waits for events that arrive later, and says what was recorded when it gives up", async () => {
  const events = [{ kind: "call_started" }];
  setTimeout(() => events.push({ kind: "code_ok" }), 300);
  const { t } = context({ events: () => events });
  assert.equal((await t.waitForEvent("code_ok", { timeoutMs: 3000 })).kind, "code_ok");
  assert.equal(await t.waitForEvent("password_set", { timeoutMs: 100, soft: true }), null);
  assert.deepEqual(t.checks.at(-1), {
    name: 'event "password_set"',
    ok: false,
    soft: true,
    detail: "recorded: call_started, code_ok",
  });
  await assert.rejects(t.waitForEvent("password_set", { timeoutMs: 100 }), CheckFailed);
});

test("waitForState reads a field of the template's record (default: state)", async () => {
  let record = { state: "calling", outcome: null };
  setTimeout(() => (record = { state: "escalated", outcome: "escalated:identity_failed" }), 300);
  const { t } = context({ record: () => record });
  const snap = await t.waitForState(/^escalated/, { timeoutMs: 3000 });
  assert.equal(snap.outcome, "escalated:identity_failed");
  await t.waitForState("escalated:identity_failed", { field: "outcome" });
  await t.waitForState(true, { field: (s) => s.outcome.endsWith("identity_failed") });
  await t.waitForState("completed", { timeoutMs: 100, soft: true });
  assert.deepEqual(
    t.checks.map((c) => [c.name, c.ok, c.detail]),
    [
      ["state is /^escalated/", true, "escalated"],
      ['outcome is "escalated:identity_failed"', true, "escalated:identity_failed"],
      ['record is "true"', true, "true"],
      ['state is "completed"', false, 'was "escalated"'],
    ],
  );
});

test("answer() records whether the template's call reached the harness", async () => {
  const leg = fakeLeg();
  const ok = context({ harness: { expectIncoming: async ({ from }) => (from === "+18665550142" ? leg : null) } });
  assert.equal(await ok.t.answer({ from: "+18665550142" }), leg);
  assert.equal(ok.t.leg, leg);
  assert.equal(ok.t.checks.at(-1).ok, true);

  const missed = context({
    harness: { expectIncoming: async () => Promise.reject(new Error("no call from the template within 60 s")) },
  });
  await assert.rejects(missed.t.answer({ timeoutMs: 10 }), CheckFailed);
  assert.deepEqual(missed.t.checks.at(-1), {
    name: "the template called the harness number",
    ok: false,
    soft: false,
    detail: "no call from the template within 60 s",
  });
  // Started before the trigger and never awaited (the scenario failed first): no unhandled rejection.
  missed.t.answer({ timeoutMs: 10 });
});

test("answer() stops waiting when the scenario ends, and hangs up a call that connects too late", async () => {
  // Like the real harness: waits until the scenario's signal aborts.
  const waiting = context({
    harness: {
      expectIncoming: ({ signal }) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("the scenario ended")))),
    },
  });
  const pending = waiting.t.answer();
  waiting.t.end();
  await pending;
  assert.deepEqual(waiting.t.checks, [], "an ended scenario records no failed answer");

  let connect;
  const late = context({ harness: { expectIncoming: () => new Promise((resolve) => (connect = resolve)) } });
  const answered = late.t.answer();
  late.t.end();
  const leg = fakeLeg();
  connect(leg);
  await answered;
  assert.equal(leg.ended, true);
  assert.deepEqual(late.t.legs, []);
  assert.deepEqual(late.t.checks, []);
});

test("nextCall hangs up and forgets the previous call's id", async () => {
  const { t } = context({ turns: [] });
  await t.callId();
  const first = t.leg;
  await t.nextCall();
  assert.equal(first.ended, true);
  assert.equal(t.leg, null);
  assert.equal(t.id, null);
  await assert.rejects(t.hear(), /no call/);
});

test("callId follows the busiest new call when the template also answered a ghost", async () => {
  const probe = new TemplateProbe({ baseUrl: "http://127.0.0.1:9", hub: false });
  const hub = (id, n = 1) => {
    for (let i = 0; i < n; i++) probe.messages.push({ at: Date.now(), target: "event", id, payload: {} });
  };
  hub("earlier-call", 3);
  const logs = [];
  const make = () =>
    new ScenarioContext({ harness: null, probe, suite: { probe: {} }, scenario: {}, runtime: null, log: (l) => logs.push(l) });

  // An Event Grid retry of a call that rang while the template was down appears first, then this call.
  const t = make();
  hub("ghost");
  hub("this-call");
  setTimeout(() => hub("this-call", 3), 300);
  assert.equal(await t.callId(), "this-call");
  assert.match(logs.at(-1), /2 new calls on the template's hub \(1 vs 4 messages\); following the busiest$/);

  const next = make();
  hub("next-call");
  assert.equal(await next.callId(), "next-call", "one new call: taken at once");
  assert.equal(logs.length, 1);
});

/** A call whose agent utterances were identified as `said` ([locale, text] pairs); `late` ones finish identifying afterwards. */
function spokenLeg(said, { late = [] } = {}) {
  const utterances = said.map(([locale, text]) => ({ locale, text, done: Promise.resolve() }));
  for (const [locale, text] of late) {
    const u = { locale: null, text: null };
    u.done = new Promise((resolve) => setTimeout(() => resolve(Object.assign(u, { locale, text })), 30));
    utterances.push(u);
  }
  return { utterances };
}

test("after the call, an agent that drifted out of the caller's language fails the scenario without ending it", async () => {
  const { t, logs } = context();
  t.legs.push(
    spokenLeg([
      ["en-US", "Hi Alex, this is the Contoso IT assistant."],
      ["fr-CA", "Le code que je vais vous donner est cinq deux cinq."],
    ]),
    spokenLeg([], { late: [["es-ES", "Hola Alex, soy el asistente de TI de Contoso."]] }),
  );
  await t.checkLanguage();
  const [c] = t.checks;
  assert.equal(c.name, "the agent spoke en-US");
  assert.equal(c.ok, false);
  assert.equal(c.soft, false);
  assert.match(c.detail, /^2 of 3 utterances were in fr-CA, es-ES, e\.g\. "Le code que je vais/);
  assert.equal(scenarioStatus(t.checks), "fail");
  assert.match(logs.at(-1), /✗ the agent spoke en-US/);
});

test("the language check passes in the expected language and honours scenario and suite languages", async () => {
  const english = context().t;
  english.legs.push(spokenLeg([["en-US", "Thanks for calling the City of Contoso."], ["en-GB", "Is there anything else at all?"]]));
  await english.checkLanguage();
  assert.deepEqual(english.checks.map((c) => [c.name, c.ok]), [["the agent spoke en-US", true]]);

  const bilingual = context().t;
  bilingual.suite = { probe: {}, languages: ["en-US", "es-US"] };
  bilingual.legs.push(spokenLeg([["es-US", "Gracias por llamar a la ciudad de Contoso."]]));
  await bilingual.checkLanguage();
  assert.deepEqual(bilingual.checks.map((c) => [c.name, c.ok]), [["the agent spoke en-US or es-US", true]]);

  const spanishOnly = context().t;
  spanishOnly.suite = { probe: {}, languages: ["en-US", "es-US"] };
  spanishOnly.scenario = { languages: ["es-US"] };
  spanishOnly.legs.push(spokenLeg([["en-US", "Thanks for calling the City of Contoso."]]));
  await spanishOnly.checkLanguage();
  assert.deepEqual(spanishOnly.checks.map((c) => [c.name, c.ok]), [["the agent spoke es-US", false]], "the scenario's languages win");
});

test("the language check is skipped when nothing the agent said was identified", async () => {
  const { t } = context();
  await t.checkLanguage();
  t.legs.push(spokenLeg([[null, "words the identifier could not place"]]), { utterances: undefined });
  await t.checkLanguage();
  assert.deepEqual(t.checks, []);
});
