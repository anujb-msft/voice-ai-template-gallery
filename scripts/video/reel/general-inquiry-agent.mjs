// General Inquiry Agent's film: the short one its Video button plays, cut from the
// console footage of its full walkthrough (films/general-inquiry-agent.mjs). Built by
// `npm run reel -- general-inquiry-agent`; reel/overview.mjs documents the fields.
export default {
  id: "general-inquiry-agent",
  film: "general-inquiry-agent",
  name: "General Inquiry Agent",

  open: {
    headline: "Real answers. And where they came from.",
    shot: "grid",
    focus: "decision",
    segments: [
      { from: "What are City Hall", to: "City Hall public counters", drop: 2, lead: 3.5, push: 1.6 },
      { from: "Where did that come from", to: "That came from", drop: 2 },
    ],
  },

  title: {
    eyebrow: "Voice AI templates for Teams Phone",
    lines: ["General", "inquiry agent."],
    sub: "Answer the common question before it becomes a queue.",
    narration: ["General inquiry agent.", "Answer the common question before it becomes a queue."],
  },

  chapters: [
    {
      card: "It checks.",
      clips: [
        {
          headline: "Out of date? It won't read it out.",
          focus: "decision",
          segments: [{ from: "Do I need a permit", to: "I found something", drop: 1 }],
        },
        {
          headline: "After hours? It won't ring an empty desk.",
          focus: "decision",
          segments: [{ from: "Can I talk to a person?", to: "I can't connect you right now", drop: 1 }],
        },
      ],
    },
    {
      card: "It won't pretend.",
      clips: [
        {
          headline: "Can't take the report? It says so.",
          focus: "decision",
          segments: [{ from: "I want to report a pothole", to: "I can't file service requests", drop: 2 }],
        },
        {
          headline: "Who qualifies? Staff decide, not the model.",
          focus: "decision",
          segments: [{ from: "I'm 67" }, { from: "The senior utility discount", head: 2, drop: 4 }],
        },
      ],
    },
    {
      card: "It hands off.",
      clips: [
        {
          headline: "Handed to staff. No need to repeat it.",
          teams: true,
          focus: "decision+teams",
          segments: [{ from: "The senior utility discount", to: "Connecting you now", head: 4, tail: 3 }],
        },
      ],
    },
  ],

  trust: {
    lines: ["The model speaks.", "Your content answers."],
    points: ["Review dates enforced", "Hours on the server's clock", "Staff decide eligibility"],
    narration: ["The model speaks.", "Your content answers."],
  },

  yours: {
    title: "Make it yours.",
    files: ["content/articles/", "config/hours.json", "CONTENT_EXPIRY_GRACE_DAYS"],
    prompt: "Add a city holiday calendar, so City Hall and the information desk show as closed on holidays.",
    narration: ["Make it yours.", "Your content and your hours are configuration. Your coding agent can change the rest."],
  },

  end: {
    lines: ["General", "inquiry agent."],
    sub: "Run it in simulation, no Azure needed. Then bring your content and your Teams number.",
    narration: ["Run it in simulation, no Azure needed.", "Then bring your content and your Teams number."],
    run: "cd code && npm install && npm start",
  },
};
