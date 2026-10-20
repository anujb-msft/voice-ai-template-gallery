// Intent-Based Call Routing's film: the short one its tile and page play, cut from the
// console footage of its full walkthrough (films/intent-based-call-routing.mjs). Built by
// `npm run reel -- intent-based-call-routing`; reel/overview.mjs documents the fields.
const CALL = { x: 0, y: 246, w: 960 };
const HANDOFF = { x: 440, y: 246, w: 960 };

export default {
  id: "intent-based-call-routing",
  film: "intent-based-call-routing",
  name: "Intent-Based Call Routing",

  open: {
    headline: "No menu. Just say what you need.",
    teams: true,
    shot: "grid",
    segments: [
      { from: "Hi Dana", to: "It sounds like Billing", lead: 3.5, focus: CALL, push: 1.6 },
      { from: "yes please", to: "Connecting you now", tail: 3.6, focus: HANDOFF },
    ],
  },

  title: {
    eyebrow: "Voice AI templates for Teams Phone",
    lines: ["Intent-based", "call routing."],
    sub: "Callers say what they need. The right Teams queue answers, already knowing why.",
    narration: ["Intent-based call routing.", "Callers say what they need. The right Teams queue answers, already knowing why."],
  },

  chapters: [
    {
      card: "It asks.",
      clips: [
        {
          headline: "Not sure? One question, not a guess.",
          focus: CALL,
          segments: [
            { from: "I was charged for a renewal", to: "Sorry, I want to make sure" },
            { from: "the charge on my card", to: "It sounds like Billing" },
          ],
        },
      ],
    },
    {
      card: "It listens.",
      clips: [
        {
          headline: "Ask for a person. Get one.",
          teams: true,
          segments: [{ from: "can I just talk to a person", to: "Connecting you now to Reception", tail: 3, focus: HANDOFF }],
        },
        {
          headline: "Changed their mind? The transfer waits.",
          segments: [{ after: "Hi Marcus", from: "yes please", to: "It sounds like Support", focus: CALL }],
        },
      ],
    },
    {
      card: "No dead ends.",
      clips: [
        {
          headline: "After hours, it takes a message.",
          segments: [{ from: "Billing is closed", to: "Thanks — I've passed", drop: 1, focus: CALL }],
        },
        {
          headline: "Bad line? The keypad still works.",
          focus: CALL,
          segments: [
            { from: "Sorry — I want to get this right", head: 2 },
            { from: "Connecting you now to Support", lead: 2.5, tail: 1.6 },
          ],
        },
      ],
    },
  ],

  trust: {
    lines: ["The model proposes.", "The server decides."],
    points: ["A confidence gate in config", "Hours for every queue", "An audit trail for every call"],
    narration: ["The model proposes.", "The server decides."],
  },

  yours: {
    title: "Make it yours.",
    files: ["config/routes.json", "config/callers.json", "CONFIDENCE_THRESHOLD"],
    prompt: "Add a Legal route that's open weekdays nine to five and takes a message after hours.",
    narration: ["Make it yours.", "Your teams and their hours are configuration. Your coding agent can change the rest."],
  },

  end: {
    lines: ["Intent-based", "call routing."],
    sub: "Run it in simulation in two minutes. Then connect your own Teams number.",
    narration: ["Run it in simulation in two minutes.", "Then connect your own Teams number."],
    run: "cd code && npm install && npm start",
  },
};
