/**
 * The on-stage demo, beat by beat. The director in the presenter kit runs it:
 * Next ▶ (or →, PageDown, a clicker) runs one step, Auto-play runs the rest of
 * a beat, and 1–6 jump straight to a beat.
 *
 * Every beat pins the demo clock and puts its patient's appointment back the
 * way the seed has it, so any beat can be re-run on its own, in any order. The
 * patient lines are ones the offline stand-in (src/offline.mjs) handles the
 * same way every time; with Voice Live they are just as natural to say out loud.
 * The calls run in English for the room, whatever each patient's preference.
 *
 * To adapt the demo, edit the lines and the narration here. The narration is
 * written for the room: `talk` while a beat runs, `cue` before a step, `after`
 * once the beat is done.
 */

const says = (who, text, cue) => ({ type: "say", text, label: `${who} says “${text}”`, ...(cue ? { cue } : {}) });

/**
 * @param {{
 *   setClock: (preset: string) => Promise<void>,
 *   restore: (appointmentIds: string[]) => Promise<void>,
 * }} hooks
 */
export function createBeats({ setClock, restore }) {
  const at = (preset, ...appointmentIds) => async () => {
    await setClock(preset);
    await restore(appointmentIds);
  };

  return [
    {
      title: "Confirmed in one call",
      prepare: at("two-days-before", "A-20418"),
      talk: "Two days before an imaging appointment, the agent calls Jordan. It says nothing about the visit until it knows it's talking to Jordan.",
      steps: [
        {
          type: "start",
          appointmentId: "A-20418",
          language: "en",
          outcome: "answered",
          label: "Place the reminder call to Jordan R. (A-20418)",
          cue: "Before it dials, the server checks consent, calling hours and the reminder window on the demo clock: 10:00 AM, two days before the visit.",
        },
        says("Jordan", "Yes, this is Jordan.", "“This is Jordan” is a claim, not proof. The agent asks for a date of birth and still hasn't shared any appointment details."),
        says("Jordan", "March 12th, 1984.", "The server checks the date of birth against the record. Only a match unlocks the appointment details: the minimum necessary."),
        says("Jordan", "Yes, I'll be there.", "Jordan confirms. The server marks A-20418 confirmed: watch the schedule panel."),
      ],
      after:
        "Confirmed in the clinic's schedule, with the prep instructions for the visit. The trail shows identity verified before a single detail was shared.",
    },
    {
      title: "Cancel frees the slot",
      prepare: at("two-days-before", "A-20419"),
      talk: "Avery can't make it. A cancellation only helps if the time goes back on the books for another patient.",
      steps: [
        {
          type: "start",
          appointmentId: "A-20419",
          language: "en",
          outcome: "answered",
          label: "Place the reminder call to Avery S. (A-20419)",
        },
        says("Avery", "Yes, speaking."),
        says("Avery", "June 9th, 1979.", "Verified, so the agent reads out the appointment."),
        says("Avery", "I need to cancel.", "Nothing changes yet. The agent reads the cancellation back and waits for a clear yes."),
        says("Avery", "Yes, please cancel it.", "A clear yes. The server cancels A-20419 and releases the 10:15 slot with Dr. Patel."),
      ],
      after: "The schedule panel shows the slot free again, ready for the next patient who needs it.",
    },
    {
      title: "New time → a person",
      prepare: at("two-days-before", "A-20423"),
      talk: "Riley wants a different time. Finding one means options and trade-offs, so a person on the scheduling desk takes it. The agent books nothing itself.",
      steps: [
        {
          type: "start",
          appointmentId: "A-20423",
          language: "en",
          outcome: "answered",
          label: "Place the reminder call to Riley D. (A-20423)",
        },
        says("Riley", "Yes, this is Riley."),
        says("Riley", "August 14th, 2002.", "Verified, so the agent reads out the appointment."),
        says(
          "Riley",
          "Can I come next week instead?",
          "The server hands the call to the scheduling desk in Teams, with the context in the VoIP headers. Watch the Teams panel.",
        ),
      ],
      after:
        "The scheduler's Teams client rings with who it is, that identity was verified, and what Riley asked for. The current slot stays booked until a new one is chosen.",
    },
    {
      title: "Someone else answers",
      prepare: at("two-days-before", "A-20424"),
      talk: "Family members answer phones. A reminder must not tell them what kind of appointment Camila has, or when.",
      steps: [
        {
          type: "start",
          appointmentId: "A-20424",
          language: "en",
          outcome: "answered",
          label: "Place the reminder call to Camila L. (A-20424)",
          cue: "The agent asks for Camila by first name and shares no appointment details.",
        },
        says(
          "Camila's sister",
          "No, this is her sister.",
          "Not the patient, so the server allows a callback request only: no department, no provider, no time.",
        ),
      ],
      after: "The decision panel names the rule: minimum necessary. Nothing about the appointment was said.",
    },
    {
      title: "Voicemail: callback only",
      prepare: at("two-days-before", "A-20424"),
      talk: "Anyone can play back a voicemail. Early attempts leave no message at all; the last attempt leaves a callback number and nothing else.",
      steps: [
        {
          type: "start",
          appointmentId: "A-20424",
          language: "en",
          outcome: "voicemail",
          attempt: 3,
          label: "Call Camila L. again: voicemail picks up (attempt 3 of 3)",
          cue: "The greeting says “leave a message”, so the server treats it as voicemail, not as Camila.",
        },
      ],
      after: "A callback request only: no department, no provider, no time. The trail shows why.",
    },
    {
      title: "Too late to call",
      prepare: at("too-late", "A-20425"),
      talk: "Same server, 8:30 in the evening. Reminder calls keep to calling hours in the patient's own time zone.",
      steps: [
        {
          type: "start",
          appointmentId: "A-20425",
          language: "en",
          outcome: "answered",
          label: "Try to call Noah M. at 8:30 PM",
          cue: "The server refuses before anything is dialed, and says when the next call is allowed.",
        },
        {
          type: "action",
          action: "metrics",
          label: "Show the numbers",
          cue: "Every call is audited: patients reached, confirmed, cancelled, handed to scheduling, and privacy-safe voicemails.",
        },
      ],
      after: "The same numbers come from the same audit log in production.",
    },
  ];
}
