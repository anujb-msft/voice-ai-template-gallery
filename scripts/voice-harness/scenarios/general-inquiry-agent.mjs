// General inquiry agent: the harness is a resident calling the City of Contoso information line,
// following DEMO-SCRIPT.md beats 1-6.
//
// The clock is pinned with DEMO_NOW, so content freshness and staffed hours mean the same thing on
// every run. On 2026-09-30 the shipped articles are: City Hall hours and the senior utility discount
// fresh, bulky item pickup stale (review was due 2026-07-15, inside the 90-day grace) and the yard-sale
// permit expired (review was due 2026-04-01, past the grace). 10:00 Pacific that Wednesday is staffed;
// 19:00 is not. Content, hours and retrieval policy point at the shipped files and defaults.
//
// The information desk is the shipped placeholder Teams queue, so a live transfer can never ring a
// person: every staffed dispatch exercises the documented failure handling instead (an apology, then
// the call is closed with outcome transfer_failed).

const STAFFED = "2026-09-30T10:00:00-07:00";
const AFTER_HOURS = "2026-09-30T19:00:00-07:00";

function prepare(demoNow) {
  return (runtime) => ({
    // Pinned to the shipped content, hours and policy so a developer's .env cannot change what passes.
    CONTENT_ARTICLES_PATH: `${runtime.templateDir}/content/articles`,
    HOURS_PATH: `${runtime.templateDir}/config/hours.json`,
    RETRIEVAL_MIN_SCORE: "2.5",
    CONTENT_EXPIRY_GRACE_DAYS: "90",
    CALL_TIME_BUDGET_MS: "300000",
    DEMO_NOW: demoNow,
    PERSIST_TRANSCRIPTS: "false",
    LOCALE: "en-US",
    TEAMS_CLOUD: "public",
  });
}

const probe = { idKey: "callId" };

const GREETING_HEARD = /automated|assistant|c[oa]ntoso|kontoso|city|help/i;
const DISCLOSURE = /automated|virtual|assistant|\bA\.?I\b/i;
const HOURS_ANSWER = /monday|friday|weekdays?|\b(8|eight)\b.*\b(5|five)\b/i;
const SOURCE = /customer service|city hall guide|contoso\s*(\.|dot)\s*gov|slash city\s*hall/i;
const APOLOGY_SCRIPT = /can.t connect you right now/i;
const APOLOGY_HEARD = /sorry|can.t connect|cannot connect|unable to connect|call back|contoso\s*(\.|dot)\s*gov/i;
const AFTER_HOURS_SCRIPT = /open weekdays from 8 to 5/i;
const AFTER_HOURS_HEARD = /weekdays|\b(8|eight)\b.*\b(5|five)\b|call back|contoso\s*(\.|dot)\s*gov/i;
/** The volunteered age and income in the eligibility beat, in any digit form (67, 67,000, 67000, 67k). */
const VOLUNTEERED = /(?<!\d)67(?:,?000)?(?!\d)/;
/** An individual eligibility verdict, as opposed to general criteria ("you are eligible if ..."). */
const VERDICT =
  /\byou (do|definitely|probably|should|will) qualify|\byou (don.t|do not|won.t|will not|wouldn.t|would not) qualify|\byou('re| are) (not |likely |probably )?eligible(?! if)/i;

/** Rings the information line and waits for the greeting with its AI disclosure. */
async function answered(t) {
  await t.dial();
  // STT renders "Contoso" loosely ("Kontosos"), so any greeting-like line ends the wait.
  const heard = await t.hear(GREETING_HEARD, { timeoutMs: 30000 });
  await t.callId();
  // Expected to fail at times until fixed: the server's GREETING (flow.mjs:18) carries the disclosure, but instruct()
  // appends it raw to the session instructions (voice-live.mjs:197-199) instead of asking for it verbatim.
  t.check("the greeting discloses an automated assistant", DISCLOSURE.test(heard ?? ""), heard || "(nothing)", { fatal: false });
  return heard;
}

/** Everything the agent has been heard saying on this scenario's calls. */
function heardSoFar(t) {
  return t.legs.map((l) => l.transcript()).join(" \n");
}

/**
 * Soft check that the agent said `pattern` since `mark` (a heardSoFar length), listening on only if it
 * has not been heard yet: a turn already consumed by an earlier `hear` still counts.
 */
async function heardSince(t, mark, pattern, { timeoutMs = 20000 } = {}) {
  if (pattern.test(heardSoFar(t).slice(mark))) {
    t.check(`agent said ${pattern}`, true, null, { soft: true });
    return;
  }
  await t.hear(pattern, { timeoutMs, soft: true });
}

/** Says a closing line unless the template has already ended the call. */
async function sayIfLive(t, line) {
  if (!t.leg || t.leg.ended) return false;
  try {
    await t.say(line);
    return true;
  } catch {
    return false;
  }
}

/** Waits for a hub message of one kind (e.g. "transcript", "hours") that satisfies `pred`. */
async function waitForHub(t, label, target, pred, { timeoutMs = 20000, soft = false, fatal } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const hit = t.hubMessages(target).find((m) => {
      try {
        return pred(m.payload);
      } catch {
        return false;
      }
    });
    if (hit) {
      t.check(label, true);
      return hit.payload;
    }
    if (Date.now() >= until) break;
    await t.pause(500);
  }
  t.check(label, false, `${t.hubMessages(target).length} "${target}" hub message(s)`, { soft, fatal });
  return null;
}

/** Waits for an audit event of `kind` whose fields (meta included) satisfy `pred`. */
async function waitForEventWhere(t, label, kind, pred, { since = 0, timeoutMs = 20000, soft = false, fatal } = {}) {
  const until = Date.now() + timeoutMs;
  let events = [];
  for (;;) {
    events = (await t.events().catch(() => [])).slice(since).filter((e) => e.kind === kind);
    const hit = events.find((e) => {
      try {
        return pred(e);
      } catch {
        return false;
      }
    });
    if (hit) {
      t.check(label, true, hit.detail);
      return hit;
    }
    if (Date.now() >= until) break;
    await t.pause(500);
  }
  t.check(label, false, `${events.length} ${kind} event(s)`, { soft, fatal });
  return null;
}

/** DEMO-SCRIPT beat 5: SessionId, a CallTopic of 48 characters or less, and a CallContext with the reason. */
async function expectHandoff(t, started, reason) {
  const ctx = started?.meta ?? (await t.snapshot().catch(() => null))?.handoff ?? null;
  t.check("the handoff carries a session id", Boolean(ctx?.sessionId), null, { fatal: false });
  t.check(
    "the handoff CallTopic is 1-48 characters",
    typeof ctx?.callTopic === "string" && ctx.callTopic.length > 0 && ctx.callTopic.length <= 48,
    ctx?.callTopic,
    { fatal: false },
  );
  t.check("the handoff CallContext says why the caller is transferred", reason.test(ctx?.callContext ?? ""), ctx?.callContext, {
    fatal: false,
  });
  return ctx;
}

/**
 * The placeholder information desk cannot answer, so the documented failure handling must run:
 * transfer_failed, the scripted apology, and the call closed with outcome transfer_failed.
 * `mark` is the heardSoFar length before the caller asked for a person.
 */
async function expectTransferFailure(t, mark) {
  await t.waitForEvent("transfer_failed", { timeoutMs: 30000 });
  await waitForHub(
    t,
    "the agent was given the scripted apology",
    "transcript",
    (p) => p.role === "agent" && APOLOGY_SCRIPT.test(p.text),
    { timeoutMs: 5000 },
  );
  await t.waitForState("closed", { timeoutMs: 10000 });
  await t.waitForState("transfer_failed", { field: "outcome", timeoutMs: 5000 });
  await heardSince(t, mark, APOLOGY_HEARD, { timeoutMs: 20000 });
  // An asynchronous CallTransferFailed makes the server dispatch again (server.mjs CallTransferFailed
  // handler); a call that has already failed and closed must not be transferred a second time.
  await t.pause(5000);
  const dispatched = (await t.events().catch(() => [])).filter((e) => e.kind === "transfer_started").length;
  t.check("the transfer was dispatched exactly once", dispatched === 1, `${dispatched} transfer_started event(s)`, {
    fatal: false,
  });
}

export default [
  {
    id: "general-inquiry-agent",
    template: "general-inquiry-agent",
    title: "General inquiry agent (staffed hours)",
    direction: "inbound",
    order: 25,
    probe,
    prepare: prepare(STAFFED),
    scenarios: [
      {
        name: "fresh-answer-with-source",
        title: "City Hall hours are answered from the fresh City Hall article, cited, and its source is read back on request",
        timeoutMs: 180000,
        async run(t) {
          const greeting = await answered(t);
          t.check("the greeting discloses an automated assistant", /automated|assistant/i.test(greeting), greeting, {
            soft: true,
          });
          await t.say("What hours is City Hall open?");
          const asked = heardSoFar(t).length;
          await t.waitForEvent("search_content", { timeoutMs: 30000 });
          // record_answer only accepts article ids the server returned for the last search.
          await t.waitForEvent("answer_recorded", { detail: /(^|,)city-hall-hours(,|$)/, timeoutMs: 30000, fatal: false });
          await t.hear(HOURS_ANSWER, { timeoutMs: 30000, soft: true });
          await t.expectNoEvent("stale_answer", { fatal: false });
          await heardSince(t, asked, /anything else/i, { timeoutMs: 10000 });
          await t.say("Where did that come from?");
          await t.hear(SOURCE, { timeoutMs: 25000, soft: true });
          await t.say("That's all, thanks. Goodbye.");
          await t.waitForState("closed", { timeoutMs: 25000, soft: true });
          await t.waitForState("caller_done", { field: "outcome", timeoutMs: 3000, soft: true });
          await t.waitForHangup({ timeoutMs: 20000, soft: true });
        },
      },
      {
        name: "stale-caveat",
        title: "A bulky sofa pickup is answered from the stale Public Works article with its review caveat, and audited as stale",
        timeoutMs: 150000,
        async run(t) {
          await answered(t);
          await t.say("Can I get help with a bulky sofa pickup?");
          // Freshness is the server's: 77 days past review is inside the 90-day grace, so the passage is
          // returned but marked stale.
          await waitForEventWhere(
            t,
            "the search returned the bulky pickup article marked stale",
            "search_content",
            (e) => e.meta.passages.some((p) => p.articleId === "waste-bulky-pickup" && p.freshness === "stale"),
            { timeoutMs: 30000, fatal: false },
          );
          await t.hear(
            /due for review|reviewed|out of date|outdated|may have changed|may not be (current|up to date)|before relying|ask (city )?staff|contoso\s*(\.|dot)\s*gov|july/i,
            { timeoutMs: 30000, soft: true },
          );
          await t.waitForEvent("answer_recorded", { detail: /(^|,)waste-bulky-pickup(,|$)/, timeoutMs: 30000, fatal: false });
          await t.waitForEvent("stale_answer", { detail: /(^|,)waste-bulky-pickup(,|$)/, source: "policy", timeoutMs: 10000 });
        },
      },
      {
        name: "expired-refusal",
        title: "A yard-sale permit question finds only expired content, which is never offered or cited, and the agent declines to answer",
        timeoutMs: 150000,
        async run(t) {
          await answered(t);
          await t.say("Do I need a yard sale permit?");
          const search = await waitForEventWhere(
            t,
            "the search flagged an expired match",
            "search_content",
            (e) => e.meta.expiredMatch === true,
            { timeoutMs: 30000 },
          );
          t.check("the expired article was the best match, so no passage was returned", search?.meta?.passages?.length === 0, null, {
            soft: true,
          });
          await t.hear(/out of date|outdated|expired|can.t (answer|use|give)|don.t have approved|unable|connect|transfer|staff|person/i, {
            timeoutMs: 30000,
            soft: true,
          });
          // Expired articles are removed by the server, so they can never be offered or cited.
          const offered = (await t.events().catch(() => []))
            .filter((e) => e.kind === "search_content")
            .some((e) => (e.meta?.passages ?? []).some((p) => p.articleId === "yard-sale-permit"));
          t.check("the expired yard-sale article was never offered to the model", !offered);
          await t.expectNoEvent("answer_recorded", { detail: /yard-sale-permit/ });
          await sayIfLive(t, "No thanks, I don't need a transfer.");
          await t.pause(6000);
          // The tool description also lets the model escalate expired content on its own, so this is its call.
          await t.expectNoEvent("transfer_started", { soft: true });
        },
      },
      {
        name: "eligibility-guard",
        title: "Senior discount eligibility gets general criteria and the staff-decide line, and the volunteered age and income stay out of the audit",
        timeoutMs: 150000,
        async run(t) {
          await answered(t);
          await t.say("I'm 67 and my income is 67,000 dollars. Do I qualify for the senior utility discount?");
          await t.waitForEvent("search_content", { timeoutMs: 30000 });
          await t.hear(/final decision|staff (make|decide|review)/i, { timeoutMs: 35000, soft: true });
          await t.waitForEvent("answer_recorded", { detail: /(^|,)senior-utility-discount(,|$)/, timeoutMs: 20000, fatal: false });
          await t.hear({ timeoutMs: 8000 });
          t.check("the agent did not decide the caller's individual case", !VERDICT.test(heardSoFar(t)), null, { soft: true });
          // "The audit does not persist the volunteered number." Search details are sanitised by the server;
          // passage scores and timestamps are left out because they are not caller data.
          const events = await t.events().catch(() => []);
          const audited = events.map((e) => {
            const { passages, ...meta } = e.meta ?? {};
            return JSON.stringify({ kind: e.kind, detail: e.detail, meta });
          });
          const leak = audited.find((s) => VOLUNTEERED.test(s));
          t.check("no audit event holds the volunteered age or income", !leak, leak ? "found in an audit event" : null);
          t.check(
            "no audit event holds the age or income in words",
            !audited.some((s) => /sixty[-\s]?seven/i.test(s)),
            null,
            { soft: true },
          );
          // The call's live record and hub keep the model's raw query, outside the sanitised audit.
          const snap = await t.snapshot().catch(() => null);
          const raw = (snap?.searches ?? []).map((s) => s.query ?? "").join(" | ");
          t.check("the call record's search queries hold no volunteered number", !VOLUNTEERED.test(raw), null, { soft: true });
        },
      },
      {
        name: "keypad-zero-transfer-fails",
        title: "Pressing 0 after an answer requests a person, dispatches with SessionId, CallTopic and CallContext, and the unreachable desk closes the call with an apology",
        timeoutMs: 180000,
        async run(t) {
          await answered(t);
          await t.say("What hours is City Hall open?");
          const cited = await t.waitForEvent("answer_recorded", { detail: /city-hall-hours/, timeoutMs: 30000, soft: true });
          await t.hear(HOURS_ANSWER, { timeoutMs: 25000, soft: true });
          const pressed = heardSoFar(t).length;
          await t.dtmf("0");
          await t.waitForEvent("dtmf", { detail: "0", source: "caller", timeoutMs: 15000 });
          await t.waitForEvent("human_requested", { detail: "dtmf_0", timeoutMs: 10000 });
          await waitForHub(t, "the hours check said the desk is staffed", "hours", (p) => p.staffed === true, { timeoutMs: 5000 });
          const started = await t.waitForEvent("transfer_started", { detail: "dtmf_0", timeoutMs: 15000 });
          const ctx = await expectHandoff(t, started, /Transferring because dtmf 0\./);
          if (cited) {
            t.check("the CallContext names the cited article", /Answered with [^.]*city-hall-hours/.test(ctx?.callContext ?? ""), null, {
              fatal: false,
            });
          }
          await expectTransferFailure(t, pressed);
        },
      },
      {
        name: "ask-for-person",
        title: "Asking for a person in staffed hours dispatches a transfer, and the unreachable desk closes the call with an apology",
        timeoutMs: 150000,
        async run(t) {
          await answered(t);
          const asked = heardSoFar(t).length;
          await t.say("I want to talk to a person.");
          await t.waitForEvent("human_requested", { timeoutMs: 25000 });
          await t.hear(/connect/i, { timeoutMs: 20000, soft: true });
          const started = await t.waitForEvent("transfer_started", { timeoutMs: 15000 });
          await expectHandoff(t, started, /Transferring because \S/);
          await expectTransferFailure(t, asked);
        },
      },
    ],
  },
  {
    id: "general-inquiry-agent-after-hours",
    template: "general-inquiry-agent",
    title: "General inquiry agent (after hours)",
    direction: "inbound",
    order: 26,
    probe,
    prepare: prepare(AFTER_HOURS),
    scenarios: [
      {
        name: "after-hours-ask-for-person",
        title: "Asking for a person after hours gets the staffed-hours message and a closed call, with no transfer attempted",
        timeoutMs: 150000,
        async run(t) {
          await answered(t);
          await t.say("I want to talk to a person.");
          await t.waitForEvent("human_requested", { timeoutMs: 25000 });
          // Outside staffed hours the server must not dispatch: it reads the hours message and closes.
          await waitForHub(t, "the hours check said the desk is not staffed", "hours", (p) => p.staffed === false, { timeoutMs: 5000 });
          await t.waitForState("closed", { timeoutMs: 10000 });
          await t.waitForState(/^after_hours:/, { field: "outcome", timeoutMs: 5000 });
          await waitForHub(
            t,
            "the agent was given the after-hours message",
            "transcript",
            (p) => p.role === "agent" && AFTER_HOURS_SCRIPT.test(p.text),
            { timeoutMs: 5000 },
          );
          await t.hear(AFTER_HOURS_HEARD, { timeoutMs: 20000, soft: true });
          await t.expectNoEvent("transfer_started");
          // "Closes politely": the server only hangs up if the model calls end_call afterwards.
          await t.waitForHangup({ timeoutMs: 15000, soft: true });
        },
      },
      {
        name: "after-hours-keypad-zero",
        title: "Pressing 0 after hours is recorded, gets the staffed-hours message, and closes with outcome after_hours:dtmf_0",
        timeoutMs: 120000,
        async run(t) {
          await answered(t);
          await t.dtmf("0");
          await t.waitForEvent("dtmf", { detail: "0", source: "caller", timeoutMs: 15000 });
          await t.waitForEvent("human_requested", { detail: "dtmf_0", timeoutMs: 10000 });
          await waitForHub(t, "the hours check said the desk is not staffed", "hours", (p) => p.staffed === false, { timeoutMs: 5000 });
          await t.waitForState("after_hours:dtmf_0", { field: "outcome", timeoutMs: 10000 });
          await t.waitForState("closed", { timeoutMs: 5000 });
          await t.hear(AFTER_HOURS_HEARD, { timeoutMs: 20000, soft: true });
          await t.expectNoEvent("transfer_started");
        },
      },
    ],
  },
];
