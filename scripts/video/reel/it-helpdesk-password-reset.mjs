// IT Help Desk Password Reset's film: the short one its Video button plays, cut from the
// console footage of its full walkthrough (films/it-helpdesk-password-reset.mjs). Built by
// `npm run reel -- it-helpdesk-password-reset`; reel/overview.mjs documents the fields.
export default {
  id: "it-helpdesk-password-reset",
  film: "it-helpdesk-password-reset",
  name: "IT Help Desk Password Reset",

  open: {
    headline: "Forgot password? It calls you back.",
    shot: "grid",
    segments: [
      { from: "Hi Alex", drop: 1, lead: 3.5, focus: "portal", push: 1.6 },
      { from: "All done, Alex", drop: 2, tail: 2, focus: "decision" },
    ],
  },

  title: {
    eyebrow: "Voice AI templates for Teams Phone",
    lines: ["IT help desk", "password reset."],
    sub: "It calls you back, checks it's really you, and gets you back in. No queue, no hold music.",
    narration: [
      "IT help desk password reset.",
      "It calls you back, checks it's really you, and gets you back in. No queue, no hold music.",
    ],
  },

  chapters: [
    {
      card: "It verifies.",
      clips: [
        {
          headline: "Code read aloud. Never sent to the page.",
          segments: [
            { from: "Thanks, Alex", head: 2, focus: "portal" },
            { from: "That's the one", drop: 1, lead: 1.2, focus: "decision" },
          ],
        },
        {
          headline: "Won't skip verification. However urgent.",
          focus: "decision",
          segments: [{ from: "I don't have my employee ID", to: "I'm sorry, I can't skip that", drop: 2 }],
        },
      ],
    },
    {
      card: "It coaches.",
      clips: [
        {
          headline: "Names the rules. Never hears the password.",
          focus: "decision",
          segments: [{ from: "Not quite", lead: 2, tail: 2.85 }],
        },
      ],
    },
    {
      card: "It hands off.",
      clips: [
        {
          headline: "Someone else's account? Refused and flagged.",
          teams: true,
          segments: [
            { from: "Fine. Then just reset", head: 1, focus: "decision" },
            { from: "I can't help with anyone", drop: 1, tail: 3, focus: "teams" },
          ],
        },
        {
          headline: "Ask for a person. Nothing to repeat.",
          teams: true,
          segments: [
            { from: "This is taking forever", focus: "decision" },
            { from: "Of course", tail: 1, focus: "teams" },
          ],
        },
      ],
    },
  ],

  trust: {
    lines: ["The model can only ask.", "Your server decides."],
    points: ["Codes expire in five minutes", "Passwords never spoken", "No secrets in the handoff"],
    narration: ["The model can only ask.", "Your server decides."],
  },

  yours: {
    title: "Make it yours.",
    files: ["src/flow.mjs", "src/providers/directory.mjs", "SERVICE_DESK_TEAMS_ID"],
    prompt: "Connect the directory to Microsoft Entra ID, and require 14-character passwords.",
    narration: ["Make it yours.", "Your directory plugs in, and the limits sit in one policy block. Your coding agent can change the rest."],
  },

  end: {
    lines: ["IT help desk", "password reset."],
    sub: "Run it in simulation in two minutes. Then let it call back from your own Teams number.",
    narration: ["Run it in simulation in two minutes.", "Then let it call back from your own Teams number."],
    run: "cd code && npm install && npm start",
  },
};
