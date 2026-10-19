// After-Hours Sales Lead Capture's film: the short one its Video button plays, cut from the
// console footage of its full walkthrough (films/after-hours-sales-lead-capture.mjs). Built by
// `npm run reel -- after-hours-sales-lead-capture`; reel/overview.mjs documents the fields.
const CALL = { x: 0, y: 246, w: 960 };
const TEAMS = { x: 440, y: 240, w: 960 };

export default {
  id: "after-hours-sales-lead-capture",
  film: "after-hours-sales-lead-capture",
  name: "After-Hours Sales Lead Capture",

  open: {
    headline: "Never let an unanswered call cost a lead.",
    teams: true,
    shot: "grid",
    segments: [
      { from: "This is Sam Rivera", drop: 2, lead: 3.5, focus: CALL, push: 1.6 },
      { from: "Thanks, Sam. I'm paging", tail: 3.5, focus: TEAMS },
    ],
  },

  title: {
    eyebrow: "Voice AI templates for Teams Phone",
    lines: ["After-hours", "sales lead capture."],
    sub: "It scores every lead, and pages the on-call rep when a hot one can't wait.",
    narration: ["After-hours sales lead capture.", "It scores every lead, and pages the on-call rep when a hot one can't wait."],
  },

  chapters: [
    {
      card: "It qualifies.",
      clips: [
        {
          headline: "One answer. Already a hot lead.",
          focus: CALL,
          segments: [{ from: "Hi, this is Dana Morgan", to: "Thanks, Dana. Hex bolts", drop: 2, tail: 2 }],
        },
      ],
    },
    {
      card: "It follows through.",
      clips: [
        {
          headline: "Reads the number back. Saves only on a yes.",
          teams: true,
          focus: TEAMS,
          segments: [{ from: "I have your number", lead: 0.3 }, { from: "Yes, that's the best number" }],
        },
        {
          headline: "Hot, not urgent? An owner and a deadline.",
          teams: true,
          shot: TEAMS,
          focus: TEAMS,
          segments: [{ from: "Thanks, Dana. Our sales team", lead: 0.3, tail: 1.5 }],
        },
      ],
    },
    {
      card: "No false promises.",
      clips: [
        {
          headline: "Asked for a person? The server decides.",
          focus: CALL,
          segments: [
            { from: "This is Sam Rivera", head: 2 },
            { from: "Thanks, Sam. Cartons", head: 2, drop: 3, tail: 2 },
          ],
        },
        {
          headline: "No one on call? It won't promise a person.",
          focus: CALL,
          segments: [{ from: "Yes, that's the right number", to: "There's no one on call", drop: 1, tail: 2.5 }],
        },
      ],
    },
  ],

  trust: {
    lines: ["The model asks the questions.", "The server keeps the score."],
    points: ["Scored by rules in config", "Saved only after read-back", "Pages only in on-call hours"],
    narration: ["The model asks the questions.", "The server keeps the score."],
  },

  yours: {
    title: "Make it yours.",
    files: ["config/hours.json", "config/qualification.json", "config/reps.json"],
    prompt: "Add Saturday on-call cover from 9 AM to 1 PM, and send fittings leads to Ben Ortiz first.",
    narration: ["Make it yours.", "Sales hours, on-call cover, scoring and reps are configuration. Your coding agent can change the rest."],
  },

  end: {
    lines: ["After-hours", "sales lead capture."],
    sub: "Run it in simulation in two minutes. Then connect your own Teams sales number.",
    narration: ["Run it in simulation in two minutes.", "Then connect your own Teams sales number."],
    run: "cd code && npm install && npm start",
  },
};
