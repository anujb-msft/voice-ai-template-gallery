// Film script: Appointment Scheduling Agent.
//
// beats[n] narrates console beat n (1-based, as on screen): `intro` before it
// starts, `cues[s]` before step s, `post[s]` after step s settles, `after` at
// the end. The console holds still while the narrator speaks.
//
// An inbound template: patients call Contoso Health's scheduling line. The
// model verifies, searches and holds; only the caller's own yes to the active
// proposal writes, on the server.
export default {
  id: "appointment-scheduling-agent",
  port: 18095,
  lang: "en-US",

  cast: {
    agent: {
      name: "Agent",
      voice: "marin",
      style:
        "Contoso Health's automated scheduling assistant, answering the clinic's scheduling line. Warm, calm and " +
        "efficient, careful with names, dates and times: natural phone delivery at an unhurried pace, never pushy.",
    },
    callers: {
      jordan: {
        name: "Jordan Rivera",
        voice: "ash",
        style:
          "Jordan Rivera, a patient of Dr. Patel's at Contoso Health, calling the scheduling line on a Tuesday morning, " +
          "first about a week-long cough and later about a mole. Plain-spoken, polite and a little under the weather: " +
          "a real person on a phone call, not an actor.",
      },
      mia: {
        name: "Mia Chen",
        voice: "shimmer",
        style:
          "Mia Chen, a patient calling between meetings who wants a follow-up with Dr. Patel booked fast and would take " +
          "any time at all. Brisk and a little impatient, but friendly: a real person on a phone call, not an actor.",
      },
      avery: {
        name: "Avery Stone",
        voice: "coral",
        style:
          "Avery Stone, a patient booking a follow-up with Dr. Patel who knows what they want and decides quickly. " +
          "Relaxed, friendly and to the point: natural phone delivery, not an actor.",
      },
    },
  },

  beats: {
    1: {
      caller: "jordan",
      intro:
        "Tuesday morning. Jordan calls Contoso Health about a cough. The model can find him a time, but only the server can book it.",
      post: {
        2: "Four checks stand between this call and the schedule. Identity is first: a name and date of birth that match, never caller ID.",
        4: "That time is now held for five minutes and read back: the active proposal, P1. Only Jordan's own yes can write it.",
      },
      after: "Four green checks, and the server wrote the booking. The model never called a booking tool. It doesn't have one.",
      shots: { "post 2": "decision", "post 4": "availability", after: "decision" },
    },
    2: {
      caller: "mia",
      intro: "Mia Chen will take any time at all. A model might oblige. The server won't.",
      cues: {
        5: "Now the model itself reaches for a booking tool, the way a prompt injection might push it to.",
      },
      post: {
        5: "There's no booking tool to call. The server refuses it, logs it, and writes nothing.",
      },
      after: "Two refused writes on the trail, and nothing booked until Mia said yes to a time she'd heard.",
      shots: { "post 5": "decision", after: "trail" },
    },
    3: {
      caller: "avery",
      intro: "Two people, one time. Avery Stone is on the phone; the front desk is at a keyboard.",
      skip: 2,
      skipLabel: "Avery is verified",
      cues: {
        5: "Before Avery can say yes, the front desk books that same time. Watch its cell in the grid.",
      },
      post: {
        6: "The server refused the write and voided P1. It never moves a yes onto another time.",
      },
      after: "Booked after a race: a fresh pick and a fresh yes. No double booking, and no silent swap.",
      shots: { "cue 5": "availability", "post 6": "decision", after: "availability@bottom" },
    },
    4: {
      caller: "jordan",
      intro: "Jordan calls back about a mole. Whether that's bookable by voice is a config rule, not the model's judgment.",
      skip: 2,
      skipLabel: "Jordan is verified",
      post: {
        3: "Eligibility is red on the referral rule, so the server offers no times. There's nothing to say yes to.",
        4: "The coordinator's Teams client rings with the topic and what's already checked, so Jordan won't start over.",
      },
      after: "The VoIP headers carry only the fields this queue may see. Jordan's date of birth isn't one.",
      shots: { "post 3": "decision", "post 4": "teams", after: "teams@bottom" },
    },
  },

  // Beat 2 (the model reaches for a booking tool) repeats beat 1's point that the model has no booking tool, and beat 5
  // (identity fails) repeats beat 1's caller-ID lesson and beat 4's handoff. Beats 3 and 4 skip the greeting and identity
  // check beat 1 already showed. That keeps the film under six minutes.
  edit: { beats: [1, 3, 4] },

  scenes: {
    open: {
      call: { name: "Jordan Rivera", detail: "Dr. Patel's patient", number: "+1 (206) 555-0142", line: "Contoso Health · Scheduling" },
      menu: [
        "For appointments, press 2.",
        { key: "♪", text: "Please hold for the next available scheduler." },
        { key: "✉", text: "Leave your number and we'll call you back." },
      ],
      bubble: { text: "I'd like to see my usual doctor, mornings if possible" },
      narration: [
        "Jordan Rivera has had a cough for a week. He wants to see his usual doctor, and soon.",
        "Too often, that means a phone menu, a queue, and a callback later. This agent books it on the call.",
      ],
    },
    title: {
      title: "Appointment Scheduling Agent",
      promise: "Turn the call into a booked appointment.",
    },
    how: {
      title: "From a phone call to a booked appointment",
      narration: [
        "Patients call the clinic's Teams Phone number.",
        "Azure Communication Services Call Automation answers and bridges the audio to Voice Live, where GPT Realtime holds the conversation.",
        "Your scheduling policy decides what's bookable and writes only on the caller's yes. Otherwise, a person in a Teams call queue takes over.",
      ],
      stages: [
        { label: "Caller", detail: "Any phone" },
        { label: "Teams Phone", detail: "Service number on a resource account", brand: true },
        { label: "Call Automation", detail: "Answers and bridges the audio" },
        { label: "Voice Live", detail: "GPT Realtime speech to speech" },
        { label: "Scheduling policy", detail: "Your server: verify, hold, book on a yes" },
        { label: "Teams call queue", detail: "A person, with context in VoIP headers", brand: true },
      ],
    },
    hood: {
      title: "The model proposes. The server books.",
      narration: [
        "The model can verify a caller, search the schedule and hold a time. Booking, moving and cancelling aren't its tools.",
        "One code path writes to the schedule, and only on the caller's own yes to the time just read back.",
      ],
      points: [
        { k: "hold_slot", v: "Holds one offered time for five minutes and reads it back. A hold isn't a booking." },
        { k: "WRITE_ACTIONS", v: "Book, reschedule and cancel are not model tools. Calling one is refused and logged." },
        { k: "#commit", v: "The only write: the caller's yes or keypad 1 to the active proposal, rechecked." },
        { k: "slot_taken", v: "The proposal is voided and fresh times offered. A new pick needs a fresh yes." },
        { k: "Eligibility", v: "Insurance, frequency, referral and order rules in config, not the model." },
        { k: "fields", v: "Each queue's allowlist for the VoIP headers. Never a date of birth." },
      ],
    },
    yours: {
      narration: [
        "Making it yours starts in config: visit types, eligibility rules, providers and their hours, and the Teams queues for each handoff.",
        "Then have your coding agent connect your own scheduling system, behind the same adapter.",
      ],
      files: [
        { path: "config/visit-types.json", note: "Visit types, lengths, prep, referral or order needs" },
        { path: "config/eligibility.json", note: "Insurance, frequency, referral and order rules" },
        { path: "config/providers.json", note: "Providers, clinics and weekly hours" },
        { path: "config/routing.json", note: "Teams call queues, hours, the fields each may see" },
        { path: "src/schedule-store.mjs", note: "Swap the SQLite schedule for your own system" },
        { path: "code/public/beats.js", note: "This demo, step by step" },
      ],
      context: ["SPEC.md", "AGENTS.md", "test/"],
      prompt: "Connect src/schedule-store.mjs to our FHIR R4 Slot and Appointment APIs. Conflicts must still come back as slot_taken.",
    },
    close: {
      narration: [
        "Appointment Scheduling Agent. Run it in simulation with no Azure subscription, then connect your Teams Phone number and your scheduling queues.",
      ],
      run: "cd code && npm install && npm start",
    },
  },
};
