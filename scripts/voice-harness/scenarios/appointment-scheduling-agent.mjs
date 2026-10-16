// Appointment scheduling agent: the harness is the patient calling Contoso Health's
// scheduling line, following DEMO-SCRIPT.md beats 4-6 plus the safety and
// verification policies in src/flow.mjs.
//
// The seed is the shipped fixtures/appointments-seed.json with every patient's
// phone replaced by the harness number (nothing else dialable is left), Jordan
// pinned to English, and Avery's next visit moved inside 24 hours of the demo
// clock so a cancellation hits the late-cancellation notice.
//
// Policy under test: the model cannot book or cancel on its own; only the
// caller's explicit yes to the server's read-back may write, and a slot taken
// by another caller needs a fresh choice and fresh consent.

const DEMO_NOW = "2026-05-19T10:00:00-07:00";

/** `dobDigits` is the same date as MM DD YYYY digits, a form normalizeDob always parses (flow.mjs:303). */
const JORDAN = { name: "Jordan Rivera", dob: "March twelfth, nineteen eighty-four", dobDigits: "zero three, one two, one nine eight four" };
const AVERY = { name: "Avery Stone", dob: "June ninth, nineteen seventy-nine", dobDigits: "zero six, zero nine, one nine seven nine" };

/** Any opening ends the greeting wait, including an identity ask in place of the greeting (see answered). */
const OPENING_HEARD = /automated|assistant|c[oa]ntoso|health|scheduling|appointment|help|verify|name|birth/i;
const DISCLOSURE = /automated|virtual|assistant|\bA\.?I\b/i;

function seedFixture(runtime) {
  const seed = runtime.readTemplateJson("fixtures/appointments-seed.json");
  for (const patient of seed.patients) {
    patient.phones = [{ number: runtime.harnessNumber, type: "mobile", status: "ok" }];
    if (patient.patientId === "P-1007") patient.preferredLanguage = "en";
  }
  // Avery's follow-up with Dr. Patel, moved to 08:30 tomorrow (22.5 h after DEMO_NOW).
  const late = seed.appointments.find((a) => a.appointmentId === "A-20419");
  if (late) Object.assign(late, { start: "2026-05-20T08:30:00-07:00", end: "2026-05-20T08:45:00-07:00" });
  return seed;
}

function prepare(runtime) {
  return {
    SCHEDULE_SEED_PATH: runtime.writeJson("appointments-seed.json", seedFixture(runtime)),
    SCHEDULE_DB_PATH: runtime.path("schedule.db"),
    SCHEDULE_ADAPTER: "sqlite",
    DEMO_NOW,
    // normalizeDob falls back to local-time Date parsing, and slot search uses local days.
    TZ: "America/Los_Angeles",
    ACS_CALLER_ID: runtime.templateNumber,
    TEAMS_RESOURCE_ACCOUNT_ID: "",
    SMS_ENABLED: "false",
    SMS_ALLOWED_NUMBERS: runtime.harnessNumber,
    HOLD_TTL_MS: "300000",
    OPTIONS_PER_TURN: "3",
    SEARCH_HORIZON_DAYS: "90",
    CALL_TIME_BUDGET_MS: "420000",
    TRANSCRIPT_RETENTION: "false",
    HANDOFF_TOKEN_SECRET: "voice-harness-handoff-secret",
  };
}

const probe = { idKey: "callId" };

/** Rings the scheduling line, waits for the opening and checks its AI disclosure. */
async function answered(t) {
  await t.dial();
  // The server's greeting (flow.mjs:42) reaches the model as an instruction (flow.mjs:249 #say -> instruct), and it
  // paraphrases it ("this call is with an automated system"), often without the clinic's name, or at times skips it
  // and asks for the patient's name and date of birth first, so any opening ends the wait. Expected to fail at times
  // until fixed: a skipped greeting drops the AI disclosure.
  const heard = await t.hear(OPENING_HEARD, { timeoutMs: 25000 });
  await t.callId();
  t.check("the greeting discloses an automated assistant", DISCLOSURE.test(heard ?? ""), heard || "(nothing)", { fatal: false });
}

const verified = async (t) => Boolean((await t.snapshot().catch(() => null))?.verified);

/**
 * Gives name and date of birth until the server marks the call verified (the model calls verify_patient).
 * The first try is spoken the way a patient would say it. Expected to fail until fixed: the model passes ordinals
 * ("March 12th, 1984") that normalizeDob cannot parse (flow.mjs:303), so a rejected first try is retried once with
 * the date as digits, which it can parse, to reach the rest of the flow. A second rejection transfers the call.
 */
async function verifyAs(t, who, intent, { firstTry = { soft: true } } = {}) {
  await t.say(`Hi, ${intent} My name is ${who.name}, date of birth ${who.dob}.`);
  await t.converse({
    until: async () => (await verified(t)) || (await t.hasEvent("tool_rejected", { detail: /^verify_patient/ })),
    replies: [
      [/birth|birthday/i, `It's ${who.dob}.`],
      [/name|who am i speaking/i, `${who.name}.`],
    ],
    fallback: `My name is ${who.name}, and my date of birth is ${who.dob}.`,
    maxTurns: 5,
    timeoutMs: 75000,
  });
  const first = await verified(t);
  t.check("a naturally spoken date of birth verifies", first, first ? who.dob : `verify_patient rejected "${who.dob}"`, firstTry);
  if (!first) {
    const digits = `My name is ${who.name}, and my date of birth is ${who.dobDigits}.`;
    await t.converse({
      until: () => verified(t),
      replies: [[/birth|name|match|again|repeat|once more/i, digits]],
      fallback: digits,
      maxTurns: 4,
      timeoutMs: 60000,
    });
  }
  await t.waitForState("true", { field: (s) => String(Boolean(s?.verified)), timeoutMs: 10000 });
}

/** Reason, visit type and preferences until the server has offered slots. */
async function getOffers(t) {
  await t.converse({
    until: async () => ["offering", "holding", "read_back"].includes((await t.snapshot().catch(() => null))?.state),
    replies: [
      [/what kind of visit|what's it for|what is it for|reason|what brings/i, "It's a new problem. I have a rash on my arm, and I'd like a new problem visit with my primary care doctor, Dr. Patel."],
      [/visit type|type of visit|new problem|follow.?up/i, "A new problem visit in primary care, please."],
      [/location|provider|day|time of day|prefer|morning|afternoon/i, "Mornings work best, with Dr. Patel at the Northgate clinic. Any day is fine."],
      [/anything else|is there|can i help/i, "I'd just like the earliest morning time with Dr. Patel."],
    ],
    fallback: "A morning appointment with Dr. Patel, please.",
    maxTurns: 7,
    timeoutMs: 120000,
  });
  await t.waitForState("offering", { timeoutMs: 15000 });
  await t.replied(/would either|work|available|option|\bat\b/i, { timeoutMs: 20000, soft: true });
}

/** The read-back is up; the caller has not agreed yet, so nothing may be booked. */
async function expectUnbookedReadBack(t) {
  await t.waitForState("read_back", { timeoutMs: 30000 });
  await t.hear(/confirm|shall i book|book it|is that right/i, { timeoutMs: 20000, soft: true });
  await t.expectNoEvent("outcome", { detail: "booked" });
}

async function consentToBook(t) {
  // isAffirmative rejects any "no"/"not" in the line, so the consent is a plain yes.
  await t.say("Yes, please book it.");
  await t.waitForEvent("outcome", { detail: "booked", timeoutMs: 30000 });
  await t.waitForState("booked");
  await t.hear(/booked|you're all set|confirmed/i, { timeoutMs: 20000, soft: true });
}

export default {
  id: "appointment-scheduling-agent",
  template: "appointment-scheduling-agent",
  title: "Appointment scheduling agent (inbound, Contoso Health)",
  direction: "inbound",
  order: 40,
  probe,
  prepare,
  scenarios: [
    {
      name: "book-with-read-back",
      title: "Jordan is verified, offered morning slots, hears a read-back and is booked only after saying yes",
      timeoutMs: 300000,
      async run(t) {
        await answered(t);
        await verifyAs(t, JORDAN, "I'd like to book an appointment.", { firstTry: { fatal: false } });
        await getOffers(t);
        await t.say("The first one, please.");
        await expectUnbookedReadBack(t);
        await consentToBook(t);
        await t.expectNoEvent("slot_taken");
      },
    },
    {
      name: "competing-caller-slot-taken",
      title: "Another caller holds the first slot; keypad 1 gets slot_taken, and only a fresh choice plus a fresh yes books",
      timeoutMs: 300000,
      async run(t) {
        await answered(t);
        await verifyAs(t, JORDAN, "I'd like to book an appointment.");
        await getOffers(t);
        const compete = await t.api.post(`/api/simulate/${await t.callId()}/compete`, { index: 0 });
        t.check("a competing caller held the first offered slot", compete.ok, JSON.stringify(compete.body).slice(0, 300));
        const mark = await t.eventMark();
        await t.dtmf("1");
        await t.waitForEvent("slot_taken", { since: mark, timeoutMs: 15000 });
        await t.waitForState("offering");
        await t.expectNoEvent("outcome", { detail: "booked" });
        // The keypad path returns "that time was just taken" without speaking it; the agent should still tell the caller.
        await t.hear(/taken|no longer|isn't available|not available|another/i, { timeoutMs: 15000, soft: true });
        await t.say("Okay. Then I'll take the second time you offered.");
        await expectUnbookedReadBack(t);
        await consentToBook(t);
      },
    },
    {
      name: "keypad-choice-then-decline",
      title: "Keypad 1 holds the first slot for read-back; declining it books nothing",
      timeoutMs: 300000,
      async run(t) {
        await answered(t);
        await verifyAs(t, JORDAN, "I'd like to book an appointment.");
        await getOffers(t);
        await t.dtmf("1");
        await t.waitForState("read_back", { timeoutMs: 15000 });
        await t.hear({ timeoutMs: 15000 });
        await t.say("No, I've changed my mind. Don't book that one.");
        await t.pause(10000);
        await t.expectNoEvent("outcome", { detail: "booked" });
        const snap = await t.snapshot().catch(() => null);
        t.check("the call is not booked", snap?.state !== "booked", snap?.state);
      },
    },
    {
      name: "verification-fails-twice",
      title: "A wrong date of birth twice for a known name goes to the scheduling team, unverified",
      timeoutMs: 240000,
      async run(t) {
        await answered(t);
        await t.say("Hi, I'd like to book an appointment. My name is Jordan Rivera, date of birth July fourth, nineteen ninety.");
        await t.converse({
          until: () => t.hasEvent("transfer"),
          replies: [
            [/didn't match|try|again|birth/i, "Sorry, it's Jordan Rivera, born July fifth, nineteen ninety."],
            [/name/i, "Jordan Rivera."],
          ],
          fallback: "Jordan Rivera, born July fifth, nineteen ninety.",
          maxTurns: 5,
          timeoutMs: 100000,
        });
        // Two DOB misses on a real name is the server's limit: no third try, no PHI.
        await t.waitForEvent("transfer", { detail: /^scheduling_team.*verification_failed/, timeoutMs: 15000 });
        await t.waitForState("escalating");
        await t.waitForState("false", { field: (s) => String(Boolean(s?.verified)) });
        await t.replied(/team|connect|transfer|someone/i, { timeoutMs: 15000, soft: true });
      },
    },
    {
      name: "urgent-symptom-nurse-line",
      title: "An urgent symptom locks booking and routes to the nurse line",
      timeoutMs: 240000,
      async run(t) {
        await answered(t);
        await verifyAs(t, JORDAN, "I need to see a doctor.");
        await t.hear({ timeoutMs: 15000 });
        await t.say("I've had a high fever for three days and I need to be seen.");
        // The safety check runs on the text the model passes to note_reason.
        await t.waitForEvent("transfer", { detail: /^nurse_line/, timeoutMs: 30000 });
        await t.waitForEvent("transfer", { detail: /urgent_phrase/, timeoutMs: 2000, soft: true });
        await t.waitForState("escalating");
        await t.hear(/nurse/i, { timeoutMs: 20000, soft: true });
        await t.say("Can't you just book me something for tomorrow morning?");
        await t.pause(10000);
        await t.expectNoEvent("outcome", { detail: "booked" });
      },
    },
    {
      name: "cancel-within-24-hours",
      title: "Avery cancels tomorrow's visit: late-cancellation notice, explicit yes, cancelled",
      timeoutMs: 300000,
      async run(t) {
        await answered(t);
        await verifyAs(t, AVERY, "I need to cancel an appointment.");
        await t.converse({
          until: async () => (await t.snapshot().catch(() => null))?.state === "cancelling",
          replies: [
            [/which|what appointment|upcoming|tomorrow|follow.?up|Patel/i, "The follow-up with Dr. Patel tomorrow morning at eight thirty."],
            [/reason|why/i, "I have a work conflict."],
          ],
          fallback: "I need to cancel my follow-up with Dr. Patel tomorrow morning.",
          maxTurns: 5,
          timeoutMs: 100000,
        });
        await t.waitForState("cancelling", { timeoutMs: 15000 });
        await t.replied(/24 hours|late.cancel|should i cancel|cancel it/i, { timeoutMs: 20000, soft: true });
        t.expectHeard(/24 hours|late.cancel/i, { soft: true });
        await t.expectNoEvent("outcome", { detail: "cancelled" });
        await t.say("Yes, please cancel it.");
        await t.waitForEvent("outcome", { detail: "cancelled", timeoutMs: 30000 });
        await t.waitForState("cancelled");
      },
    },
    {
      name: "keypad-zero-scheduling-team",
      title: "Pressing 0 asks for the scheduling team, with no verification needed",
      async run(t) {
        await answered(t);
        await t.dtmf("0");
        await t.waitForEvent("transfer", { detail: /^scheduling_team.*dtmf/, timeoutMs: 15000 });
        await t.waitForState("escalating");
      },
    },
  ],
};
