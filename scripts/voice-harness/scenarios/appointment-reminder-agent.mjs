// Appointment reminder agent (OUTBOUND): the template's campaign calls the harness
// number and the harness plays Jordan Rivera (or Jordan's voicemail).
//
// Dialing safety: the seed is the shipped fixtures/appointments-seed.json with
// Jordan's phone set to the harness number and every other patient's phone set
// to the harness number marked "bad" (so the dial plan skips them as
// bad_number); ALLOWED_TEST_NUMBERS is the harness number alone, and
// CAMPAIGN_MAX_CONCURRENT=1 so each run places at most one call.
//
// Each scenario that ends with a recorded attempt (confirm, cancel, opt-out,
// wrong party...) makes that appointment ineligible (spacing), so the seed adds
// clones of Jordan's MRI as separate patients P-9101.. at later times inside the
// 44-52 h lead window; the next run calls the next one.
//
// Known template bug: src/voice/acs.mjs:11 passes `{ phoneNumber }` as the call
// target, which @azure/communication-call-automation createCall cannot read, so
// POST /api/campaign/run currently answers 500 and nothing rings. `launch`
// records that as a failure and drains the harness's answer waiter.

const DEMO_NOW = "2026-05-19T10:00:00-07:00";
const DOB = "March twelfth, nineteen eighty-four";
const CLONES = 9;

/** What may only be said after date-of-birth verification. */
const PHI = /\bMRI\b|imaging|Northgate|Dr\.? Lee|nine[- ]thirty|9:30|May (21|twenty)|fasting|eight hours/i;

function seedFixture(runtime) {
  const seed = runtime.readTemplateJson("fixtures/appointments-seed.json");
  for (const patient of seed.patients) {
    const ok = patient.patientId === "P-1007";
    patient.phones = [{ number: runtime.harnessNumber, type: "mobile", status: ok ? "ok" : "bad" }];
    if (ok) Object.assign(patient, { preferredLanguage: "en", preferredChannel: "voice" });
  }
  const jordan = seed.patients.find((p) => p.patientId === "P-1007");
  const mri = seed.appointments.find((a) => a.appointmentId === "A-20418");
  for (let i = 1; i <= CLONES; i++) {
    const patientId = `P-91${String(i).padStart(2, "0")}`;
    seed.patients.push({ ...structuredClone(jordan), patientId });
    const start = new Date(Date.parse("2026-05-21T09:30:00-07:00") + i * 15 * 60000);
    const end = new Date(start.getTime() + 45 * 60000);
    const local = (d) => `${new Date(d.getTime() - 7 * 3600000).toISOString().slice(0, 19)}-07:00`;
    seed.appointments.push({ ...mri, appointmentId: `A-91${String(i).padStart(2, "0")}`, patientId, start: local(start), end: local(end) });
  }
  return seed;
}

function prepare(runtime) {
  return {
    SCHEDULE_SEED_PATH: runtime.writeJson("appointments-seed.json", seedFixture(runtime)),
    SCHEDULE_DB_PATH: runtime.path("schedule.db"),
    SCHEDULE_ADAPTER: "sqlite",
    DEMO_NOW,
    TZ: "America/Los_Angeles",
    CAMPAIGN_ENABLED: "true",
    CAMPAIGN_DRY_RUN: "false",
    CAMPAIGN_MAX_CONCURRENT: "1",
    ALLOWED_TEST_NUMBERS: runtime.harnessNumber,
    ACS_CALLER_ID: runtime.templateNumber,
    TEAMS_RESOURCE_ACCOUNT_ID: "",
    VOICEMAIL_GREETING_MS: "4500",
    CALL_TIME_BUDGET_MS: "240000",
    TRANSCRIPT_RETENTION: "false",
    HANDOFF_TOKEN_SECRET: "voice-harness-handoff-secret",
  };
}

const probe = { idKey: "callId" };

const planRows = (body) => (body?.dialPlan ?? []).map((r) => `${r.appointmentId}:${r.state}${r.skipReason ? `(${r.skipReason})` : ""}`).join(" ");

/**
 * Arms the harness to answer, runs the campaign (one call, to the harness
 * number), answers with "Hello?" and listens for the reminder opening.
 * Returns the appointment id being called, or null if nothing rang.
 */
async function launch(t, { greet = "Hello?" } = {}) {
  const plan = await t.api.get("/api/campaign/dry-run");
  const row = plan.body?.dialPlan?.find((r) => r.state === "scheduled");
  t.check("the dry-run plan has an appointment to call", Boolean(row), planRows(plan.body));
  const call = t.answer({ timeoutMs: 60000 });
  const run = await t.api.post("/api/campaign/run", {});
  const launched = run.body?.launched ?? [];
  if (!run.ok || launched.length !== 1) {
    t.check("the campaign placed exactly one call", false, `HTTP ${run.status} ${JSON.stringify(run.body).slice(0, 300)}`, { fatal: false });
    await call; // fails the scenario if nothing rings, and frees the harness's answer slot
    return null;
  }
  t.useId(launched[0]);
  await call;
  await t.waitForEvent("call_created", { detail: "outbound" });
  if (greet) {
    await t.pause(1000);
    await t.say(greet);
    await t.hear(/automated|assistant|Contoso|reminder|Jordan/i, { timeoutMs: 25000, soft: true });
  }
  return row.appointmentId;
}

/** Confirms identity and date of birth until the server marks the call verified. */
async function verify(t) {
  await t.say("Yes, this is Jordan.");
  await t.converse({
    until: async () => Boolean((await t.snapshot().catch(() => null))?.verified),
    replies: [
      [/birth|birthday/i, `It's ${DOB}.`],
      [/speaking with|is this|am i/i, "Yes, this is Jordan speaking."],
    ],
    fallback: `Yes, this is Jordan. My date of birth is ${DOB}.`,
    maxTurns: 5,
    timeoutMs: 80000,
  });
  await t.waitForState("true", { field: (s) => String(Boolean(s?.verified)), timeoutMs: 10000 });
  await t.hear(/make it|appointment|MRI|imaging|May|Northgate/i, { timeoutMs: 20000, soft: true });
}

const agentSaid = (t) => t.legs.map((l) => l.transcript()).join(" ");

export default {
  id: "appointment-reminder-agent",
  template: "appointment-reminder-agent",
  title: "Appointment reminder agent (outbound campaign to the harness number)",
  direction: "outbound",
  order: 41,
  probe,
  prepare,
  scenarios: [
    {
      name: "dry-run-dial-plan",
      title: "The dial plan schedules only Jordan's harness-number appointments and skips everyone else",
      async run(t) {
        const plan = await t.api.get("/api/campaign/dry-run");
        const rows = plan.body?.dialPlan ?? [];
        t.check("the dry-run endpoint answers", plan.ok && rows.length > 0, planRows(plan.body));
        t.check("the plan uses the pinned demo clock", plan.body?.now === DEMO_NOW, plan.body?.now);
        const scheduled = rows.filter((r) => r.state === "scheduled");
        t.check(
          "only A-20418 and its clones are scheduled",
          scheduled.length > 0 && scheduled.every((r) => r.appointmentId === "A-20418" || r.appointmentId.startsWith("A-91")),
          planRows(plan.body),
        );
        const skipped = Object.fromEntries(rows.filter((r) => r.state === "skipped").map((r) => [r.appointmentId, r.skipReason]));
        // Shipped gates: SMS-preferring, no-consent and TTY patients are never voice-dialled.
        t.check("A-20420 is skipped for channel", skipped["A-20420"] === "channel", skipped["A-20420"]);
        t.check("A-20421 is skipped for no consent", skipped["A-20421"] === "no_consent", skipped["A-20421"]);
        t.check("A-20422 is skipped for TTY", skipped["A-20422"] === "tty", skipped["A-20422"]);
        t.check("the other patients' numbers are not dialable", skipped["A-20419"] === "bad_number", skipped["A-20419"]);
        const health = await t.api.get("/health");
        t.check("the campaign is enabled and live", health.body?.campaignEnabled === true && health.body?.campaignDryRun === false, JSON.stringify(health.body).slice(0, 300), { soft: true });
      },
    },
    {
      name: "confirm-by-voice",
      title: "Jordan confirms identity and date of birth, hears the appointment, and confirms by voice",
      timeoutMs: 240000,
      async run(t) {
        if (!(await launch(t))) return;
        // Before verification only the first name may be used.
        t.check("no appointment details before verification", !PHI.test(agentSaid(t)), agentSaid(t).slice(0, 300));
        await verify(t);
        await t.say("Yes, I'll be there.");
        await t.waitForState("confirmed", { timeoutMs: 30000 });
        await t.waitForState("confirmed", { field: "outcome" });
        await t.hear(/confirmed|fast|eight hours|see you/i, { timeoutMs: 20000, soft: true });
      },
    },
    {
      name: "keypad-repeat-and-confirm",
      title: "After verification, * repeats the last line and 1 confirms without a spoken yes",
      timeoutMs: 240000,
      async run(t) {
        if (!(await launch(t))) return;
        await verify(t);
        const snap = await t.snapshot();
        const said = () => t.hubMessages("transcript").filter((m) => m.payload?.role === "agent" && m.payload?.text === snap?.lastPhrase).length;
        const before = said();
        await t.dtmf("*");
        await t.pause(4000);
        // repeatLast re-sends the exact server line; ACS reports * as "asterisk", which TONE_DIGITS does not map.
        t.check("* repeated the last server line", Boolean(snap?.lastPhrase) && said() > before, snap?.lastPhrase, { fatal: false });
        await t.hear({ timeoutMs: 10000 });
        await t.dtmf("1");
        await t.waitForState("confirmed", { timeoutMs: 15000 });
        await t.waitForState("confirmed", { field: "outcome" });
      },
    },
    {
      name: "cancel-with-read-back",
      title: "Cancelling reads back the appointment and only cancels after an explicit yes",
      timeoutMs: 240000,
      async run(t) {
        if (!(await launch(t))) return;
        await verify(t);
        await t.say("No, I won't be able to make it. I need to cancel because of a schedule conflict.");
        await t.converse({
          until: async () => (await t.snapshot().catch(() => null))?.state === "cancel_confirm",
          replies: [[/reason|why/i, "A schedule conflict."]],
          fallback: "Please cancel it. It's a schedule conflict.",
          maxTurns: 4,
          timeoutMs: 60000,
        });
        await t.waitForState("cancel_confirm", { timeoutMs: 10000 });
        await t.hear(/should i cancel|cancel/i, { timeoutMs: 20000, soft: true });
        // The proposal alone must not write: no outcome of any kind before the caller's yes.
        await t.expectNoEvent("outcome");
        await t.say("Yes, please cancel it.");
        await t.waitForState("cancelled", { timeoutMs: 30000 });
        await t.waitForState("cancelled", { field: "outcome" });
      },
    },
    {
      name: "reschedule-callback",
      title: "With no scheduling-agent target, a reschedule request files a callback and ends the call",
      timeoutMs: 240000,
      async run(t) {
        if (!(await launch(t))) return;
        await verify(t);
        await t.say("I can't make that time. Can I reschedule it?");
        // routing.json ships an empty schedulingAgent target: the documented fallback is a callback request.
        await t.waitForState("reschedule_callback", { field: "outcome", timeoutMs: 40000 });
        await t.waitForEvent("outcome", { detail: "no_target" });
        await t.waitForState("ended");
        await t.hear(/call you back|scheduling team/i, { timeoutMs: 20000, soft: true });
      },
    },
    {
      name: "wrong-party-no-details",
      title: "Someone else answers: the agent asks them to pass on a callback and reveals nothing",
      timeoutMs: 180000,
      async run(t) {
        if (!(await launch(t))) return;
        await t.say("No, this isn't Jordan. I'm just a friend, and Jordan's not here right now.");
        await t.waitForState("wrong_party", { field: "outcome", timeoutMs: 40000 });
        await t.waitForState("ended");
        await t.hear(/call|ask|Contoso/i, { timeoutMs: 20000, soft: true });
        await t.pause(3000);
        t.check("no appointment details were given to the wrong person", !PHI.test(agentSaid(t)), agentSaid(t).slice(0, 400));
      },
    },
    {
      name: "clinical-question-nurse-line",
      title: "A clinical question is not answered by the bot; the nurse line is offered",
      timeoutMs: 240000,
      async run(t) {
        if (!(await launch(t))) return;
        await verify(t);
        await t.say("Should I still come in if I have a fever? Is it safe to take my medicine before the scan?");
        await t.waitForState("clinical", { timeoutMs: 40000 });
        await t.hear(/nurse/i, { timeoutMs: 20000, soft: true });
        await t.expectNoEvent("outcome", { detail: "confirmed" });
      },
    },
    {
      name: "opt-out-persists",
      title: "Saying stop calling opts Jordan out, and the next dial plan skips the appointment as suppressed",
      timeoutMs: 240000,
      async run(t) {
        const appointmentId = await launch(t);
        if (!appointmentId) return;
        await t.say("Please stop calling me with these automated reminders. Take me off your list.");
        await t.waitForState("opt_out", { timeoutMs: 40000 });
        await t.waitForState("opted_out", { field: "outcome" });
        await t.waitForEvent("outcome", { detail: "suppressed" });
        await t.hear(/won't get|no more|removed|reminder calls/i, { timeoutMs: 20000, soft: true });
        await t.hangup();
        const plan = await t.api.get("/api/campaign/dry-run");
        const row = plan.body?.dialPlan?.find((r) => r.appointmentId === appointmentId);
        t.check("the opted-out appointment is skipped as suppressed", row?.skipReason === "suppressed", planRows(plan.body));
      },
    },
    {
      name: "voicemail-no-details",
      title: "A voicemail greeting gets no appointment details, and the call is recorded as voicemail",
      timeoutMs: 180000,
      async run(t) {
        if (!(await launch(t, { greet: null }))) return;
        await t.pause(800);
        await t.say(
          "Hi, you've reached Jordan. I can't take your call right now, I'm not available. Please leave a message after the tone, and I'll get back to you as soon as I can.",
        );
        await t.hear({ timeoutMs: 15000 });
        await t.pause(8000);
        // Voicemail may carry only the callback request (scripts.json "voicemail"), never PHI.
        t.check("no appointment details were left on voicemail", !PHI.test(agentSaid(t)), agentSaid(t).slice(0, 400));
        // Live detection (detection.json) only runs in /api/simulate today; this documents the gap.
        await t.waitForState(/voicemail/, { field: "outcome", timeoutMs: 15000, fatal: false });
      },
    },
  ],
};
