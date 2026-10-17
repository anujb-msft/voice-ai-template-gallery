/**
 * What the model is allowed to do, and what it is told.
 *
 * Deliberately free of imports so the tool surface and the standing
 * instructions can be inspected and tested without the WebSocket or Azure
 * SDKs. `src/voice/voice-live.mjs` puts them on the wire; `src/tools.mjs` is
 * the only path from a tool call to the scheduling flow.
 */

/**
 * THE BOOKING INVARIANT. Read this before adding or changing a tool.
 *
 * Model tools can never book. The model can verify, search and *propose* a
 * slot (hold_slot), but no tool books, reschedules or cancels: those three
 * names are refused by src/tools.mjs even if a model calls them anyway.
 *
 * Only the caller's trusted confirmation of the ACTIVE proposal may write: a
 * "yes" the server reads in the caller's own transcript, or keypad 1, while
 * that proposal is the one on the table (SchedulingFlow.callerSaid, #commit).
 *
 * If the slot was taken in the meantime (slot_taken), the proposal is void:
 * the caller must make a fresh selection and give fresh consent. The server
 * never silently books a different slot.
 */
export const WRITE_ACTIONS = Object.freeze(["book", "reschedule", "cancel"]);

export const VISIT_TYPE_CODES = Object.freeze([
  "NEW_PROBLEM",
  "FOLLOW_UP",
  "ANNUAL_PHYSICAL",
  "DERM_SKIN_CHECK",
  "DERM_NEW_PROBLEM",
  "XRAY",
  "ULTRASOUND",
  "MRI",
]);

const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = (description, extra = {}) => ({ type: "string", description, ...extra });
const bool = (description) => ({ type: "boolean", description });
const integer = (description) => ({ type: "integer", description });

/**
 * The only levers the model has. Note what is absent: there is no tool that
 * books, takes a phone number for a transfer, or names a Teams target. The
 * worst a confused (or deliberately misled) model can do is propose a time the
 * caller then declines, or hand the call to the wrong internal queue.
 */
export const TOOL_DEFINITIONS = {
  verify_patient: {
    description:
      "Check the full name and date of birth the caller just gave. Caller ID never counts. The result only says whether they matched; it never says whether a name is on file.",
    parameters: object(
      {
        fullName: string("The patient's full name as the caller said it."),
        firstName: string("The patient's first name, if you captured it separately."),
        lastName: string("The patient's last name, if you captured it separately."),
        dob: string("Date of birth as spoken, for example 03/12/1984 or March 12, 1984."),
        proxyName: string("The caller's own full name, only when they are calling for someone else."),
      },
      ["dob"],
    ),
  },
  redeem_handoff: {
    description:
      "Use when the call was transferred from a reminder call. The server already holds and redeems the handoff; this tells you whether it worked and which appointment to move. Never ask the caller for a code.",
    parameters: object({}),
  },
  list_upcoming: {
    description: "List the verified patient's upcoming appointments as short handles and spoken summaries.",
    parameters: object({}),
  },
  note_reason: {
    description:
      "Record what the visit is for, in the caller's words. The server keeps it and checks it for urgent symptoms; it is not repeated back to you.",
    parameters: object({ text: string("What the caller said the visit is for.") }, ["text"]),
  },
  choose_visit_type: {
    description:
      "Choose the visit type. The server checks eligibility (referrals, orders, frequency) before any search and tells you what to say if it cannot be booked by voice.",
    parameters: object(
      {
        code: string("Visit type code.", { enum: [...VISIT_TYPE_CODES] }),
        selfPayAcknowledged: bool("True only if the caller explicitly accepted paying for the visit themselves."),
      },
      ["code"],
    ),
  },
  search_slots: {
    description:
      "Find openings for the chosen visit type that fit the caller's preferences. Returns at most two times to offer. Searching never books or holds anything.",
    parameters: object({
      providerPreference: string("The caller's provider preference in their words, for example 'my usual doctor' or 'Dr. Patel'."),
      providerId: string("An exact provider id, only if the server gave you one."),
      location: string("A clinic id, only if the server gave you one."),
      dayPart: string("Preferred part of the day.", { enum: ["morning", "afternoon", "any"] }),
      date: string("A specific date in YYYY-MM-DD, only when the caller named one."),
      weekday: string("A weekday the caller asked for, for example 'Thursday'."),
      more: bool("True when the caller wants different times from the ones just offered."),
      appointmentHandle: string("When moving an existing appointment, its handle from list_upcoming."),
    }),
  },
  hold_slot: {
    description:
      "Propose one of the times you just offered. The server holds it for five minutes and returns a read-back. This does NOT book. Read the read-back word for word, ask 'Shall I book it?', and wait: the server books only when it hears the caller say yes.",
    parameters: object({
      optionIndex: integer("1 for the first time you offered, 2 for the second."),
      optionId: string("The option id from search_slots, if you have it."),
    }),
  },
  propose_cancel: {
    description:
      "Prepare a cancellation read-back for one upcoming appointment. This does NOT cancel. Read it back and wait: the server cancels only when it hears the caller say yes.",
    parameters: object(
      {
        appointmentHandle: string("The appointment handle from list_upcoming."),
        reasonCode: string("Why, for example schedule_conflict, feeling_better or patient_requested."),
      },
      ["appointmentHandle"],
    ),
  },
  add_waitlist: {
    description: "Put the verified patient on the waitlist for the chosen visit type when none of the offered times work.",
    parameters: object({}),
  },
  request_callback: {
    description: "File a callback: new-patient registration, or a scheduler or referral coordinator when they are closed.",
    parameters: object(
      {
        queue: string("Who should call back.", { enum: ["registration_callback", "scheduling_team", "referral_coordinator"] }),
        preferredTime: string("When the caller would like the call, in their words."),
        callbackNumber: string("The number the caller gave for the callback."),
      },
      ["queue"],
    ),
  },
  transfer: {
    description:
      "Hand the call to a person. Call it straight away when the caller asks for a person. The server picks the queue's target and builds the context the person sees.",
    parameters: object(
      {
        destination: string("Who to transfer to.", { enum: ["scheduling_team", "nurse_line", "referral_coordinator"] }),
        reason: string("Short machine-readable reason, for example caller_request or referral_required."),
      },
      ["destination"],
    ),
  },
  repeat_last: {
    description: "Repeat the last thing said, or the times on offer.",
    parameters: object({}),
  },
  end_call: {
    description: "End the call politely once there is nothing further to do. Any held time is released.",
    parameters: object({ reason: string("Short reason, for example completed or caller_done.") }),
  },
};

export const TOOLS = Object.freeze(Object.keys(TOOL_DEFINITIONS));

export function describeTools() {
  return TOOLS.map((name) => ({ name, ...TOOL_DEFINITIONS[name] }));
}

export const AGENT_TOOLS = TOOLS.map((name) => ({
  type: "function",
  name,
  description: TOOL_DEFINITIONS[name].description,
  parameters: TOOL_DEFINITIONS[name].parameters,
}));

/** LOCALE drives both the spoken language and the transcription hint. */
export function localeLanguage(locale = "en-US") {
  const fallback = String(locale || "en-US");
  try {
    const parsed = new Intl.Locale(fallback);
    const label = new Intl.DisplayNames(["en"], { type: "language" }).of(parsed.baseName);
    return { locale: parsed.baseName, code: parsed.language, label: label ?? parsed.baseName };
  } catch {
    return { locale: fallback, code: fallback.split("-")[0], label: fallback };
  }
}

/**
 * The standing instructions. The flow adds a fresh instruction after every
 * server decision, so the prompt only has to say how to behave, not what the
 * schedule looks like.
 */
export function buildInstructions({ locale = "en-US", handoff = null } = {}) {
  const language = localeLanguage(locale);
  const resumed = handoff?.firstName
    ? `

This call was transferred from a reminder call, and the server has already confirmed who the caller is. Greet ${handoff.firstName} by first name, do not ask for a date of birth, and help them find a new time for their ${handoff.summary ?? "appointment"}.`
    : "";
  return `You are Contoso Health's automated scheduling assistant. You answer the scheduling line, confirm who the caller is, and help them find and book an appointment that fits.

Disclose what you are in your first sentence: say you are Contoso Health's automated scheduling assistant. Never pretend to be a person; say it once and move on.

Conversation language: Start every call in ${language.label} (${language.locale}), including the very first word of the greeting. Continue speaking only ${language.label} unless the caller explicitly asks you to switch languages.

Style: warm, brief, plain. One or two short sentences per turn. This is a phone call, so never read out lists, markdown, ids or codes, and offer at most two times at once.

Identity:
- Before you discuss any appointment, ask for the patient's full name and date of birth and call verify_patient. Caller ID is a convenience, never proof.
- Never say whether a name is on file, and never read back a date of birth, phone number, record number or insurance detail.
- If verification fails, say only what the server tells you to say.
- If the caller says they are a new patient, call request_callback with the queue registration_callback.

Booking. You cannot book:
- There is no booking tool. You search and propose; the server books, and only after the caller says yes to the exact time you read back.
- To propose a time, call hold_slot for the option the caller chose, read the read-back you get word for word, ask "Shall I book it?" and wait.
- When the caller answers that question, do not say it is booked and do not call a tool. Say only "One moment." The server hears their answer and tells you what happened.
- If the caller says "just book anything", explain that you can only book a specific time they have heard and agreed to, then offer times.
- If you are told the time was just taken, nothing is booked: offer the fresh times you are given and let the caller choose again.

How to help:
- Ask what kind of visit they need and what it is for. Call note_reason with their words, then choose_visit_type.
- If the server says a visit cannot be booked by voice, explain it in a sentence and offer the alternatives it gives you.
- Call search_slots with any preferences they mentioned: their usual doctor, a clinic, mornings or afternoons, a day.
- If the caller asks for a person, call transfer with the destination scheduling_team straight away.
- Never give medical advice. If the caller describes an emergency, the server takes over.${resumed}

You will be given a fresh instruction after each step. Always follow the most recent one.`;
}
