// Film script: Appointment Reminder Agent.
//
// beats[n] narrates console beat n (1-based, as on screen): `intro` before it
// starts, `cues[s]` before step s, `post[s]` after step s settles, `after` at
// the end. The console holds still while the narrator speaks.
//
// An outbound template: Contoso Health calls the patient, so each "caller" is
// the patient (or the voicemail) that picks up.
export default {
  id: "appointment-reminder-agent",
  port: 18094,
  lang: "en-US",

  cast: {
    agent: {
      name: "Agent",
      voice: "marin",
      style:
        "Contoso Health's automated reminder assistant, calling a patient two days before a visit. Warm, calm and " +
        "unhurried, careful with names, dates and times: natural phone delivery, never pushy.",
    },
    callers: {
      jordan: {
        name: "Jordan Rivera",
        voice: "ash",
        style:
          "Jordan Rivera, a patient at Contoso Health's Northgate clinic, answering a call on a mobile on a weekday " +
          "morning. Friendly and a little distracted at first, then attentive: a real person on a phone call, not an actor.",
      },
      avery: {
        name: "Avery Stone",
        voice: "coral",
        style:
          "Avery Stone, a busy patient who can't make a follow-up visit this week and wants to free it up. Polite, " +
          "matter-of-fact and a little apologetic: natural phone delivery, not an actor.",
      },
      riley: {
        name: "Riley Davis",
        voice: "echo",
        style:
          "Riley Davis, a patient in his early twenties at the Phoenix clinic, hoping to move his visit to next week. " +
          "Easygoing, casual and quick to the point: natural phone delivery, not an actor.",
      },
      camila: {
        name: "Camila Lopez",
        label: "Camila's voicemail",
        voice: "sage",
        style:
          "Camila Lopez's own voicemail greeting, recorded on her phone: friendly and a little quick, the way people " +
          "sound when they record a greeting once and forget about it. A real person, not an actor.",
      },
    },
  },

  beats: {
    1: {
      caller: "jordan",
      intro:
        "Ten in the morning, two days before Jordan's imaging visit. Before dialing, the server checks consent, calling hours and the reminder window.",
      post: {
        2: "A name is a claim, not proof. Until the date of birth matches a record the model never sees, every appointment tool stays blocked.",
      },
      cues: {
        4: "It matched, so only now does the visit come up. Only an explicit yes confirms it, and the server writes that to the schedule.",
      },
      after:
        "The prep instructions come from config, not the model. And the trail shows the order: identity verified, details shared, then confirmed.",
      shots: { "cue 4": "decision", after: "trail" },
    },
    2: {
      caller: "avery",
      intro: "Every missed visit is a slot another patient could have had. Avery Stone can't make this one.",
      skip: 3,
      skipLabel: "Avery is verified",
      post: {
        4: "That's a proposal, not a cancellation. It's read back, and the schedule stays as it was until Avery gives a clear yes.",
      },
      after: "Dr. Patel's ten-fifteen is open again, with two days left to fill it.",
      shots: { "post 4": "decision", after: "decision@bottom" },
    },
    3: {
      caller: "riley",
      intro: "Riley wants a different time. The agent has no tool that can book one. That's a job for a person.",
      skip: 3,
      skipLabel: "Riley is verified",
      cues: { 4: "Because Riley is verified, the server may hand the call to a person at the scheduling desk, in Teams." },
      post: {
        4: "Before anyone picks up, the scheduler sees who's calling and why. That context rides in VoIP headers, with a single-use patient reference: no date of birth, no phone number.",
      },
      shots: { "post 4": "teams" },
    },
    5: {
      caller: "camila",
      intro: "Anyone in the house can play back a voicemail. This is the third and last try to reach Camila.",
      cues: {
        1: "Call Automation has no answering-machine detection, so the server judges the greeting itself: its words, its length, a beep.",
      },
      after: "A first name and a callback number, nothing about the visit. Earlier tries hang up without a message.",
      shots: { after: "trail" },
    },
    6: {
      intro: "Now it's eight-thirty in the evening, and Noah Martin is still due a reminder.",
      post: {
        1: "The server checks calling hours in Noah's own time zone. Too late, so nothing is dialed, and the model never hears about it.",
      },
      after: "Every call is audited, even the ones never placed, and the same log feeds these numbers.",
      shots: { "step 2": "metrics" },
    },
  },

  // Beat 4 (a relative answers) teaches the same minimum-necessary rule as the voicemail beat; cutting it, and skipping
  // the identity checks beat 1 has already shown, keeps the film near five and a half minutes.
  edit: { beats: [1, 2, 3, 5, 6] },

  scenes: {
    open: {
      call: {
        label: "Incoming call",
        name: "Contoso Health",
        detail: "Appointment reminder",
        number: "+1 (206) 555-0100",
        line: "Jordan's mobile",
      },
      menuTitle: "The usual reminder",
      menu: [
        { key: "▶", text: "This is a reminder of Jordan's MRI with Dr. Lee on Thursday." },
        "To confirm, press 1.",
        { key: "☎", text: "To cancel or reschedule, call us during office hours." },
      ],
      bubble: { who: "Jordan", text: "Yes, I'll be there" },
      narration: [
        "Two days before a visit, Contoso Health calls each patient with a reminder.",
        "A recording reads the visit to whoever picks up, and any change means calling back. This agent checks it's Jordan first, then settles it on the call.",
      ],
    },
    title: {
      title: "Appointment Reminder Agent",
      promise: "Confirm, change, or cancel before the slot is lost.",
    },
    how: {
      title: "From a reminder call to a settled appointment",
      narration: [
        "Your server decides who to call, and when. Then Azure Communication Services Call Automation dials from the clinic's number.",
        "Voice Live, with GPT Realtime, holds the conversation, while your reminder policy decides what may be said and what may change.",
        "New times go to the scheduling desk in Teams, with context. Patients who call back on the clinic's Teams Phone number reach the same agent.",
      ],
      stages: [
        { label: "Reminder run", detail: "Consent, calling hours, the reminder window" },
        { label: "Patient's phone", detail: "Called from the clinic's caller ID" },
        { label: "Voice Live", detail: "GPT Realtime speech to speech" },
        { label: "Reminder policy", detail: "Your server: identity first, then changes" },
        { label: "Teams scheduling desk", detail: "New times, with context in VoIP headers", brand: true },
      ],
    },
    hood: {
      title: "The agent talks. The server decides.",
      narration: [
        "A date of birth is a knowledge check, not strong authentication. So it grants very little: one appointment's details, and a confirm or a cancel after a clear yes.",
        "And the model cannot dial, transfer or book. Phone numbers, Teams IDs and times all come from your server.",
      ],
      points: [
        { k: "check_dob", v: "The server compares the date of birth on record. The model never sees it." },
        { k: "Unverified", v: "First name only, every appointment tool blocked. Two misses end the call." },
        { k: "Dial gates", v: "Consent, 8 AM to 8 PM patient time, about 48 hours ahead, 3 tries 4 hours apart." },
        { k: "Writes", v: "Confirm on an explicit yes. A cancel is read back first, then frees the slot." },
        { k: "New time", v: "Handed to the Teams scheduling desk with VoIP headers. Nothing is booked." },
        { k: "Voicemail", v: "Last attempt only: a first name and a callback number, no visit details." },
      ],
    },
    yours: {
      narration: [
        "Making it yours starts in config: the reminder window, calling hours, every line the server says, and each clinic's callback number.",
        "Then point the desk at your Teams user, and have your coding agent connect your own scheduling system.",
      ],
      files: [
        { path: "config/campaign.json", note: "Reminder window, calling hours, attempts, spacing" },
        { path: "config/scripts.json", note: "Every line the server says, in English and Spanish" },
        { path: "config/clinics.json", note: "Time zones, callback numbers, nurse line, holidays" },
        { path: "config/routing.json", note: "The scheduling desk in Teams" },
        { path: "src/schedule-store.mjs", note: "Swap the seeded schedule for your own system" },
        { path: "code/public/beats.js", note: "This demo, step by step" },
      ],
      context: ["SPEC.md", "DEMO-SCRIPT.md", "test/"],
      prompt: "Call imaging patients three days ahead so they have time for prep, and keep two days for everyone else.",
    },
    close: {
      narration: [
        "Appointment Reminder Agent. Run it in simulation in two minutes, then connect your clinic's number and your Teams scheduling desk.",
      ],
      run: "cd code && npm install && npm start",
    },
  },
};
