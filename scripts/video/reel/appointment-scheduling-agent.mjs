// Appointment Scheduling Agent's film: the short one its tile and page play, cut from the
// console footage of its full walkthrough (films/appointment-scheduling-agent.mjs). Built by
// `npm run reel -- appointment-scheduling-agent`; reel/overview.mjs documents the fields.
const CALL = { x: 0, y: 246, w: 960 };
const RIGHT = { x: 440, y: 280, w: 960 };

export default {
  id: "appointment-scheduling-agent",
  film: "appointment-scheduling-agent",
  name: "Appointment Scheduling Agent",

  open: {
    headline: "One call. One yes. Booked.",
    shot: "grid",
    segments: [
      { from: "I've had a cough", lead: 3.2, focus: CALL, push: 1.6 },
      { from: "Yes, please", to: "You're booked", drop: 1, lead: 1, focus: RIGHT },
    ],
  },

  title: {
    eyebrow: "Voice AI templates for Teams Phone",
    lines: ["Appointment", "scheduling agent."],
    sub: "Patients say what they need. Their yes books the visit, on the call.",
    narration: ["Appointment scheduling agent.", "Patients say what they need. Their yes books the visit, on the call."],
  },

  chapters: [
    {
      card: "It checks.",
      clips: [
        {
          headline: "Name and birth date. Never caller ID.",
          focus: CALL,
          segments: [{ from: "Jordan Rivera", to: "Thanks, Jordan" }],
        },
        {
          headline: "Held and read back. Nothing written yet.",
          focus: RIGHT,
          segments: [{ from: "The first one", to: "To confirm" }],
        },
      ],
    },
    {
      card: "Never double-booked.",
      clips: [
        {
          headline: "Taken mid-call? Nothing is booked.",
          focus: RIGHT,
          segments: [{ from: "Yes, book it", to: "Sorry, that time", drop: 1, lead: 2.5 }],
        },
        {
          headline: "A fresh pick. A fresh yes. Booked.",
          focus: RIGHT,
          segments: [
            { from: "Sorry, that time", head: 1, drop: 2 },
            { from: "The first one" },
            { from: "To confirm", head: 1, to: "You're booked", drop: 1 },
          ],
        },
      ],
    },
    {
      card: "Knows its limits.",
      clips: [
        {
          headline: "Needs a referral? No times offered.",
          focus: RIGHT,
          segments: [{ from: "I'd like a skin check", to: "Dermatology visits", drop: 1 }],
        },
        {
          headline: "Handed to a person. Nobody starts over.",
          teams: true,
          focus: RIGHT,
          segments: [{ from: "Connect me with", to: "I'm connecting you", tail: 4.3 }],
        },
      ],
    },
  ],

  trust: {
    lines: ["The model can't book.", "Only the caller's yes can."],
    points: ["Read back before every yes", "Rechecked at the write", "Eligibility rules in config"],
    narration: ["The model can't book.", "Only the caller's yes can."],
  },

  yours: {
    title: "Make it yours.",
    files: ["config/visit-types.json", "config/eligibility.json", "src/schedule-store.mjs"],
    prompt: "Connect src/schedule-store.mjs to our FHIR R4 Slot and Appointment APIs. Conflicts stay slot_taken.",
    narration: ["Make it yours.", "Visit types, eligibility rules and Teams queues are configuration. Your coding agent can change the rest."],
  },

  end: {
    lines: ["Appointment", "scheduling agent."],
    sub: "Run it in simulation, with no Azure subscription. Then connect your clinic's Teams number.",
    narration: ["Run it in simulation, with no Azure subscription.", "Then connect your clinic's Teams number."],
    run: "cd code && npm install && npm start",
  },
};
