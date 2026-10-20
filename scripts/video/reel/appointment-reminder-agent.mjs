// Appointment Reminder Agent's film: the short one its tile and page play, cut from the
// console footage of its full walkthrough (films/appointment-reminder-agent.mjs). Built by
// `npm run reel -- appointment-reminder-agent`; reel/overview.mjs documents the fields.
export default {
  id: "appointment-reminder-agent",
  film: "appointment-reminder-agent",
  name: "Appointment Reminder Agent",

  open: {
    headline: "Can't make it? The slot is free again.",
    shot: "grid",
    focus: "decision",
    segments: [
      { from: "I need to cancel", to: "I can cancel", lead: 3, push: 1.6, tail: 0.4 },
      { from: "Yes, please cancel it", to: "Your appointment is cancelled", drop: 2, lead: 0.4, tail: 0.8 },
    ],
  },

  title: {
    eyebrow: "Voice AI templates for Teams Phone",
    lines: ["Appointment", "reminder agent."],
    sub: "It calls before the visit. Confirm, change or cancel, before the slot is lost.",
    narration: ["Appointment reminder agent.", "It calls before the visit. Confirm, change or cancel, before the slot is lost."],
  },

  chapters: [
    {
      card: "Identity first.",
      clips: [
        {
          headline: "Says who's calling. Holds back the details.",
          focus: "decision",
          segments: [{ from: "Hello?", to: "Yes, this is Jordan" }],
        },
        {
          headline: "Date of birth first. Then the details.",
          focus: "decision",
          segments: [
            { from: "Thanks, Jordan", tail: 0.4 },
            { from: "March 12th", to: "You have an imaging", drop: 1, lead: 0.4 },
          ],
        },
      ],
    },
    {
      card: "It confirms.",
      clips: [
        {
          headline: "A clear yes. Then the prep instructions.",
          focus: "decision",
          segments: [{ from: "Yes, I'll be there", to: "You're confirmed", drop: 2 }],
        },
      ],
    },
    {
      card: "Knows its limits.",
      clips: [
        {
          headline: "A new time? A person books it, in Teams.",
          teams: true,
          focus: "teams",
          segments: [{ from: "Can I come next week", to: "I'll connect you", tail: 1.4 }],
        },
        {
          headline: "Voicemail? A name, a number. No details.",
          focus: "decision",
          segments: [{ from: "Hi, you've reached Camila", to: "This is Contoso Health calling for Camila" }],
          // The voice stopped at the number: the line's closing "Thank you." was never said.
          captions: {
            "This is Contoso Health calling for Camila":
              "This is Contoso Health calling for Camila with an appointment reminder. Please call us back at 602-555-0100.",
          },
        },
      ],
    },
  ],

  trust: {
    lines: ["The agent asks.", "The server checks."],
    points: ["Calling hours and consent", "Date of birth before details", "A clear yes before changes"],
    narration: ["The agent asks.", "The server checks."],
  },

  yours: {
    title: "Make it yours.",
    files: ["config/campaign.json", "config/scripts.json", "config/clinics.json"],
    prompt: "Call imaging patients three days ahead for prep, and keep two days for everyone else.",
    narration: ["Make it yours.", "Your calling hours, reminder window and scripts are configuration. Your coding agent can change the rest."],
  },

  end: {
    lines: ["Appointment", "reminder agent."],
    sub: "Run it in simulation in two minutes. Then connect your clinic's number and Teams.",
    narration: ["Run it in simulation in two minutes.", "Then connect your clinic's number and Teams."],
    run: "cd code && npm install && npm start",
  },
};
