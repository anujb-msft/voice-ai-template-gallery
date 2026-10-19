// IT / HR Help Desk Triage's film: the short one its Video button plays, cut from the
// console footage of its full walkthrough (films/it-hr-help-desk-triage.mjs). Built by
// `npm run reel -- it-hr-help-desk-triage`; reel/overview.mjs documents the fields.
export default {
  id: "it-hr-help-desk-triage",
  film: "it-hr-help-desk-triage",
  name: "IT / HR Help Desk Triage",

  open: {
    headline: "Sensitive calls go to HR. Privately.",
    teams: true,
    shot: "grid",
    segments: [
      { from: "My manager keeps", lead: 3, focus: "decision", push: 1.6 },
      { from: "That is something our HR team", tail: 3.6, focus: "teams" },
    ],
  },

  title: {
    eyebrow: "Voice AI templates for Teams Phone",
    lines: ["IT and HR", "help desk triage."],
    sub: "Routine requests, resolved on the call. Sensitive ones, routed privately to HR.",
    narration: [
      "IT and HR help desk triage.",
      "Routine requests, resolved on the call. Sensitive ones, routed privately to HR.",
    ],
  },

  chapters: [
    {
      card: "It answers.",
      clips: [
        {
          headline: "Approved articles only. Matched, not guessed.",
          focus: "decision",
          segments: [{ from: "My VPN keeps", to: "From the IT VPN guide" }],
        },
        {
          headline: "Nothing is filed until you say yes.",
          teams: true,
          segments: [
            { from: "Here's the ticket: Laptop", focus: "decision" },
            { from: "Yes, file it", to: "Your ticket is INC-004821", drop: 1, focus: "inbox" },
          ],
        },
      ],
    },
    {
      card: "Proof first.",
      clips: [
        {
          headline: "Caller ID is a hint. A code is proof.",
          teams: true,
          segments: [
            { from: "What's happening with INC-004610", to: "I can help with that", drop: 1, focus: "decision" },
            { from: "I sent a six-digit code", tail: 1.2, focus: "inbox" },
          ],
        },
        {
          headline: "Wrong code? Nothing personal is read out.",
          focus: "decision",
          segments: [
            { from: "654321", to: "That code didn't match" },
            { from: "123456", to: "Thanks, Sam" },
          ],
        },
      ],
    },
    {
      card: "It escalates.",
      clips: [
        {
          headline: "Phishing? Priority 1. By rule.",
          focus: "decision",
          segments: [{ from: "I think I clicked", to: "Here's the ticket: Phishing", drop: 2 }],
        },
        {
          headline: "On-call sees the P1 before picking up.",
          teams: true,
          segments: [{ from: "This is urgent", tail: 2.5, focus: "teams" }],
        },
      ],
    },
  ],

  trust: {
    lines: ["Who may hear what?", "Your server decides."],
    points: ["The privacy guard runs first", "Personal answers need proof", "Handoff fields set per queue"],
    narration: ["Who may hear what?", "Your server decides."],
  },

  yours: {
    title: "Make it yours.",
    files: ["config/sensitive.json", "config/routing.json", "src/adapters/otp.mjs"],
    prompt: "Wire OtpSender.deliver to Microsoft Graph so the code posts to the employee's Teams chat.",
    narration: ["Make it yours.", "Your Teams queues, topics and sensitive phrases are configuration. Your coding agent can change the rest."],
  },

  end: {
    lines: ["IT and HR", "help desk triage."],
    sub: "Run it in simulation in two minutes. Then connect your own Teams number and queues.",
    narration: ["Run it in simulation in two minutes.", "Then connect your own Teams number and queues."],
    run: "cd code && npm install && npm start",
  },
};
