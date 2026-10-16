// IT help desk password reset: the harness plays both halves of DEMO-SCRIPT.md.
//
// The template calls out. An employee clicks "Forgot password?" and the agent
// rings them back, so the harness is two things at once:
//   - the browser: it drives the wizard's REST endpoints (sign in, start the
//     reset, type the code, choose a password), exactly as public/app.js does;
//   - the employee's phone: it answers the callback from the template number,
//     says the last four digits of the employee ID, and listens for the code.
//
// The code check is end to end: the harness types the code it heard over the
// phone. If speech-to-text mishears a digit that is a warning, and it types the
// code the server issued instead, so one misheard digit does not hide the rest.
//
// Every scenario starts from a freshly seeded directory: alex.morgan, locked.

import { heardDigits } from "../src/util.mjs";

const USER = { username: "alex.morgan", lastFour: "4217", spokenLastFour: "Four two one seven." };

/** Passes every rule in validatePasswordPolicy and has no part of "Alex Morgan" in it. */
const NEW_PASSWORD = "Harbor-Lantern-42!";

/** What `npm run seed` and the server share. Keyless, so a developer's keys never leak into a run. */
const ENV = {
  TELEPHONY_MODE: "acs-direct",
  DIRECTORY_PROVIDER: "sqlite",
  TICKETING_PROVIDER: "sqlite",
  VOICE_LIVE_MODEL: "gpt-realtime",
  VOICE_LIVE_API_VERSION: "2026-04-10",
  // Pinned so the deflection maths below means the same on every machine.
  HELPDESK_TICKET_COST_USD: "25",
  HELPDESK_TICKET_MINUTES: "18",
  KNOWLEDGE_FILE: "",
  ACS_CONNECTION_STRING: "",
  VOICE_LIVE_API_KEY: "",
  AZURE_SIGNALR_CONNECTION_STRING: "",
  TPE_RESOURCE_ACCOUNT_ID: "",
};

/** The template rings the harness, from the template number. */
const callEnv = (runtime) => ({
  ACS_CALLER_ID: runtime.templateNumber,
  DEMO_PHONE_NUMBER: runtime.harnessNumber,
});

/** Re-seeds the sample directory, which locks alex.morgan again. The script's output (passwords) is discarded. */
function seed(runtime) {
  runtime.node(["scripts/seed.mjs"], { ...runtime.env, ...ENV, ...callEnv(runtime) });
}

const sessionPath = (id, rest = "") => `/api/reset/${encodeURIComponent(id)}${rest}`;

const probe = {
  idKey: "sessionId",
  // Every update the wizard needs is also in the REST API, so the hub is not used.
  hub: false,
  recordPath: (id) => sessionPath(id),
  eventsPath: (id) => sessionPath(id, "/events"),
};

const json = (r) => JSON.stringify(r?.body ?? null);

/** Speech-to-text writes "last four" or "last 4". */
const ASKS_LAST_FOUR = /last (four|4)|employee (id|i\.d\.|number)/i;

/** The browser half of beat 1: a locked account, then "Forgot password?". Answers the callback. */
async function startReset(t) {
  const login = await t.api.post("/api/login", { username: USER.username, password: "not-my-password" });
  t.check(`${USER.username} cannot sign in because the account is locked`, login.body?.reason === "locked", json(login));

  const ringing = t.answer({ from: t.config.templateNumber, timeoutMs: 60000 });
  const start = await t.api.post("/api/reset/start", { username: USER.username });
  t.check("the reset session started", start.body?.ok === true && Boolean(start.body?.sessionId), json(start));
  t.check(
    "the template placed a real call (not simulation mode)",
    !start.body?.simulated,
    start.body?.missing?.length ? `missing ${start.body.missing.join(", ")}` : null,
  );
  t.useId(start.body.sessionId);
  await ringing;
  await t.waitForState("verify_identity", { timeoutMs: 30000 });
}

/** Beat 2: the agent greets Alex by name and asks for the last four digits. */
async function greeted(t) {
  const heard = await t.hear(ASKS_LAST_FOUR, { timeoutMs: 40000, soft: true });
  t.expectHeard(/\bAlex\b/i, { soft: true });
  return heard;
}

async function verifyIdentity(t, { since = 0 } = {}) {
  await t.say(USER.spokenLastFour);
  await t.waitForEvent("identity_confirmed", { detail: USER.lastFour, since, timeoutMs: 25000 });
  await t.waitForState("voice_code");
}

/** Throws away anything the agent already said, so the next `hear` is about what happens next. */
async function drain(t) {
  await t.leg.quiet(1200, 15000);
  while (await t.hear({ timeoutMs: 300, gapMs: 300 })) {
    // discard
  }
}

/**
 * Listens until the agent has read out six digits. Codes are read slowly,
 * digit by digit, so pauses up to 1.8 s still count as one turn, and turns
 * are joined until six digits in a row have been heard.
 */
async function hearCode(t, { timeoutMs = 45000 } = {}) {
  const until = Date.now() + timeoutMs;
  let heard = "";
  while (Date.now() < until && !t.leg.ended) {
    const text = await t.hear({ timeoutMs: until - Date.now(), gapMs: 1800 });
    if (!text) break;
    heard = `${heard} ${text}`;
    const code = heardDigits(heard);
    if (code) return code;
  }
  return null;
}

/**
 * The latest code the server issued, from its audit log (null if the log no
 * longer holds the plain code). Checked without echoing the code into reports.
 */
async function issuedCode(t, { since = 0, timeoutMs = 5000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const hit = (await t.events().catch(() => []))
      .slice(since)
      .filter((e) => e.kind === "code_issued")
      .at(-1);
    if (hit || Date.now() >= until) {
      t.check("the agent asked the server for a verification code", Boolean(hit));
      return /^\d{6}$/.test(hit.detail ?? "") ? hit.detail : null;
    }
    await t.pause(500);
  }
}

const wrongDigits = (a, b) => [...a].filter((d, i) => d !== b[i]).length;

/** Beat 3: types what was heard into the browser, and checks the password step unlocks. */
async function typeCode(t, heard) {
  const issued = await issuedCode(t);
  t.check(
    "the harness heard the code the agent read aloud",
    Boolean(heard) && (!issued || heard === issued),
    !heard ? "heard no six-digit code" : issued && heard !== issued ? `${wrongDigits(heard, issued)} of 6 digits misheard` : "all six digits",
    { soft: true },
  );
  const typed = issued && heard !== issued ? issued : heard;
  t.check("there is a code to type", Boolean(typed));
  const mark = await t.eventMark();
  const res = await t.api.post(sessionPath(t.id, "/code"), { code: typed });
  t.check("the code is accepted", res.body?.ok === true, res.body?.reason);
  await t.waitForEvent("code_ok", { since: mark });
  await t.waitForState("choose_password");
}

/** Waits for the server to brief the live agent (an `agent_nudge`), recording a named check. */
async function agentTold(t, name, { since, detail, timeoutMs = 8000, fatal } = {}) {
  const until = Date.now() + timeoutMs;
  let told = false;
  while (!told && Date.now() < until) {
    told = await t.hasEvent("agent_nudge", { since, detail });
    if (!told) await t.pause(500);
  }
  t.check(name, told, told ? null : "no agent_nudge was recorded", { fatal });
  return told;
}

const stats = async (t) => (await t.api.get("/api/stats")).body ?? {};

/** Beat 5: the agent hands over to a person and ends the call itself. */
async function handedOff(t, outcome) {
  const snap = await t.waitForState("escalated", { timeoutMs: 15000 });
  t.check(`outcome is ${outcome}`, outcome instanceof RegExp ? outcome.test(snap?.outcome ?? "") : snap?.outcome === outcome, snap?.outcome);
  await t.expectNoEvent("code_issued");
  await t.waitForHangup({ timeoutMs: 45000, soft: true });
  // The handover line may already have been heard (e.g. by `converse`); check the whole call.
  while (await t.hear({ timeoutMs: 500 })) {
    // collect what was still queued
  }
  t.expectHeard(/specialist|IT team|someone|colleague|human|person/i, { soft: true });
}

export default {
  template: "it-helpdesk-password-reset",
  title: "IT help desk password reset (outbound callback)",
  direction: "outbound",
  order: 80,
  probe,
  env: ENV,
  prepare(runtime) {
    seed(runtime);
    return callEnv(runtime);
  },
  beforeEach(t) {
    // A completed reset unlocks the account; each scenario starts locked. (Not in --attach mode.)
    if (t.runtime) seed(t.runtime);
  },
  scenarios: [
    {
      name: "demo-script",
      title: "The full demo: identity, code, two questions mid-step, coaching on a weak password, reset, sign in",
      timeoutMs: 360000,
      async run(t) {
        const before = await stats(t);
        await startReset(t);
        await greeted(t);
        await verifyIdentity(t);
        await typeCode(t, await hearCode(t));

        // Beat 4: questions while the agent is reading the policy. It answers, then steers back.
        await t.interrupt("Sorry, wait. Can't you just tell me my current password?");
        await t.hear(/scrambl|hash|encrypt|can't see|cannot see|nobody|no one|not able to see/i, {
          timeoutMs: 30000,
          soft: true,
        });
        await drain(t);
        await t.say("OK. Can you suggest a good password for me?");
        await t.hear(/rather not|unrelated words|three or four|random words|passphrase/i, { timeoutMs: 30000, soft: true });

        // Typing a weak password. DEMO-SCRIPT.md: the agent coaches on what is missing before they submit.
        await drain(t);
        let mark = await t.eventMark();
        const live = await t.api.post(sessionPath(t.id, "/check-password"), { password: "password" });
        t.check('the live policy check lists what is wrong with "password"', live.body?.ok === false && live.body?.failures?.length >= 4, json(live));
        await agentTold(t, "live coaching: the agent is told what the typed password is missing", { since: mark, fatal: false });

        // Submitting it anyway is refused, and the agent is told exactly why.
        await drain(t);
        mark = await t.eventMark();
        const weak = await t.api.post(sessionPath(t.id, "/password"), { password: "password" });
        t.check("a weak password is refused by policy", weak.body?.ok === false && weak.body?.reason === "policy", json(weak));
        await t.waitForEvent("password_rejected", { since: mark });
        await agentTold(t, "the agent is told why the password was rejected", { since: mark, detail: /rejected/i });
        await t.hear(/twelve|12|capital|upper|number|symbol|common|longer/i, { timeoutMs: 30000, soft: true });

        const strong = await t.api.post(sessionPath(t.id, "/password"), { password: NEW_PASSWORD });
        t.check("a strong password is accepted", strong.body?.ok === true, json(strong));
        await t.waitForEvent("password_set");
        const done = await t.waitForState("completed");
        t.check("outcome is reset_completed", done?.outcome === "reset_completed", done?.outcome);

        const after = await stats(t);
        t.check("the ticket counts as deflected", after.deflected === (before.deflected ?? 0) + 1, `${before.deflected} → ${after.deflected}`);
        t.check(
          "the deflection saved one ticket ($25, 18 minutes)",
          after.savedUsd - (before.savedUsd ?? 0) === 25 && after.savedMinutes - (before.savedMinutes ?? 0) === 18,
          `$${after.savedUsd}, ${after.savedMinutes} min`,
        );
        const login = await t.api.post("/api/login", { username: USER.username, password: NEW_PASSWORD });
        t.check("alex.morgan can sign in with the new password", login.body?.ok === true, login.body?.reason);

        await t.hear(/all set|updated|sign in|unlocked|anything else/i, { timeoutMs: 30000, soft: true });
        await t.say("No, that's everything. Thanks!");
        await t.waitForHangup({ timeoutMs: 30000, soft: true });
      },
    },
    {
      name: "identity-fails-escalates",
      title: "Two wrong employee ID answers hand the caller to a specialist, and no code is ever issued",
      async run(t) {
        await startReset(t);
        await greeted(t);
        await t.say("One one one one.");
        await t.waitForEvent("identity_failed", { detail: "attempt 1", timeoutMs: 25000 });
        await t.hear(/again|repeat|didn't match|doesn't match|did not match|try/i, { timeoutMs: 25000, soft: true });
        await t.say("Nine nine nine nine.");
        await t.waitForEvent("identity_failed", { detail: "attempt 2", timeoutMs: 25000 });
        await t.expectNoEvent("identity_confirmed");
        await handedOff(t, "escalated:identity_failed");
      },
    },
    {
      name: "wrong-code-reread",
      title: "A mistyped code is refused and the agent reads the same code again",
      timeoutMs: 300000,
      async run(t) {
        await startReset(t);
        await greeted(t);
        await verifyIdentity(t);
        const first = await hearCode(t);
        t.check("the agent read a code aloud", Boolean(first), null, { soft: true });
        const issued = await issuedCode(t);
        await drain(t);

        // Codes are 100000-999999, so this never matches.
        const mark = await t.eventMark();
        const wrong = await t.api.post(sessionPath(t.id, "/code"), { code: "000000" });
        t.check("a wrong code is refused", wrong.body?.ok === false && wrong.body?.reason === "mismatch", json(wrong));
        await t.waitForEvent("code_bad", { since: mark });
        await agentTold(t, "the agent is told the code did not match", { since: mark, detail: /didn't match/i });

        const again = await hearCode(t);
        t.expectHeard(/didn't match|did not match|doesn't match|wrong|incorrect|not quite/i, { soft: true });
        await t.expectNoEvent("code_issued", { since: mark, soft: true });
        t.check("the agent read the same code again", Boolean(again) && (!issued || again === issued), null, { soft: true });
        await typeCode(t, again);
      },
    },
    {
      name: "not-requested-escalates",
      title: '"I didn\'t request this" is treated as a possible compromise and escalated before any verification',
      async run(t) {
        await startReset(t);
        await t.hear(/last (four|4)|employee|password reset/i, { timeoutMs: 40000, soft: true });
        await t.say("Wait, I didn't request this. I never asked for a password reset.");
        await t.converse({
          until: () => t.hasEvent("state", { detail: /^escalated/ }),
          replies: [[/sure|confirm|certain|correct|right|did you/i, "Yes, I'm sure. I didn't ask for this."]],
          fallback: "I really didn't request this. I'm worried someone is trying to get into my account.",
          maxTurns: 4,
          timeoutMs: 90000,
        });
        await t.expectNoEvent("identity_confirmed");
        await handedOff(t, /^escalated:/);
      },
    },
    {
      name: "dropped-call-redial",
      title: "A call dropped during the code step can be redialled, and the reset still finishes",
      timeoutMs: 360000,
      async run(t) {
        await startReset(t);
        await greeted(t);
        await verifyIdentity(t);
        await issuedCode(t, { timeoutMs: 30000 });
        await t.pause(1500);

        // The phone drops mid-code. The session waits where it was and offers a redial.
        await t.hangup();
        await t.pause(3000);
        await t.waitForState("voice_code");

        const mark = await t.eventMark();
        const ringing = t.answer({ from: t.config.templateNumber, timeoutMs: 60000 });
        const recall = await t.api.post(sessionPath(t.id, "/recall"), {});
        t.check("the redial was placed", recall.body?.ok === true && !recall.body?.simulated, json(recall));
        await ringing;
        await t.waitForEvent("state", { detail: "voice_code: redial", since: mark, timeoutMs: 15000 });
        const opening = await t.hear({ timeoutMs: 40000, gapMs: 1500 });

        // DEMO-SCRIPT.md: the redial resumes the same step, so identity is not asked for again.
        const restarted = await t.hasEvent("state", { detail: /^verify_identity/, since: mark });
        t.check(
          "the redial resumed at the code step instead of re-checking identity",
          !restarted,
          restarted ? `the agent opened with: ${String(opening ?? "").slice(0, 160)}` : null,
          { fatal: false },
        );
        if (restarted) {
          if (!ASKS_LAST_FOUR.test(opening ?? "")) await t.hear(ASKS_LAST_FOUR, { timeoutMs: 20000, soft: true });
          await verifyIdentity(t, { since: mark });
        }
        await typeCode(t, await hearCode(t));
      },
    },
  ],
};
