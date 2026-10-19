// Contextual On-Call Pager's film: the short one its Video button plays, cut from the
// console footage of its full walkthrough (films/contextual-on-call-pager.mjs). Built by
// `npm run reel -- contextual-on-call-pager`; reel/overview.mjs documents the fields.
const CALL = { x: 0, y: 246, w: 960 };
const PAGE = { x: 440, y: 246, w: 960 };

export default {
  id: "contextual-on-call-pager",
  film: "contextual-on-call-pager",
  name: "Contextual On-Call Pager",

  open: {
    headline: "A page that arrives with the answers.",
    teams: true,
    shot: "grid",
    segments: [
      { from: "Water is pouring", lead: 3.5, focus: CALL, push: 1.6 },
      { from: "Urgent: active leak", drop: 2, focus: PAGE },
      { from: "I've got it — on my way", to: "Thanks, Morgan", drop: 1, tail: 2, focus: PAGE },
    ],
  },

  title: {
    eyebrow: "Voice AI templates for Teams Phone",
    lines: ["Contextual", "on-call pager."],
    sub: "When it's urgent, it pages the on-call tech with the context already attached.",
    narration: ["Contextual on-call pager.", "When it's urgent, it pages the on-call tech with the context already attached."],
  },

  chapters: [
    {
      card: "It knows urgent.",
      clips: [
        {
          headline: "52 degrees, no heat? That's a page.",
          focus: CALL,
          segments: [{ from: "The heat is out in unit 11", to: "Understood — no heat", drop: 1, tail: 2.6 }],
        },
        {
          headline: "64 degrees? A work order for Monday.",
          focus: CALL,
          segments: [{ from: "The heat is out in my bedroom" }, { from: "This isn't urgent enough", drop: 2, tail: 1.2 }],
        },
      ],
    },
    {
      card: "It keeps trying.",
      clips: [
        {
          headline: "No answer? It retries, then the next tech.",
          teams: true,
          focus: PAGE,
          segments: [
            { after: "The heat is out in unit 11", from: "I'm contacting the on-call", head: 2, tail: 4.2 },
            { from: "I've got it", to: "Thanks, Priya", drop: 1, lead: 1.5, tail: 3 },
          ],
        },
      ],
    },
    {
      card: "It's discreet.",
      clips: [
        {
          headline: "All the context. No phone numbers.",
          teams: true,
          focus: PAGE,
          segments: [{ from: "Is the number ending 0101", to: "I'm contacting the on-call", drop: 1, tail: 2.5 }],
        },
        {
          headline: "Voicemail never hears the details.",
          teams: true,
          focus: PAGE,
          segments: [{ from: "Contoso maintenance has an urgent page", tail: 2 }],
        },
      ],
    },
  ],

  trust: {
    lines: ["The model listens.", "The server decides who wakes up."],
    points: ["Triage rules in config", "Escalation on a timer", "No phone numbers on a page"],
    narration: ["The model listens.", "The server decides who wakes up."],
  },

  yours: {
    title: "Make it yours.",
    files: ["config/triage.json", "config/oncall.json", "config/escalation.json"],
    prompt: "Add a holiday rotation for Thanksgiving week, and make the emergency retry gap two minutes.",
    narration: ["Make it yours.", "Triage rules, rotations and timers are configuration. Your coding agent can change the rest."],
  },

  end: {
    lines: ["Contextual", "on-call pager."],
    sub: "Run it in simulation in two minutes. Then add your technicians and your Teams number.",
    narration: ["Run it in simulation in two minutes.", "Then add your technicians and your Teams number."],
    run: "cd code && npm install && npm start",
  },
};
