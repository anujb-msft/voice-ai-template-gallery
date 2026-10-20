// Customer Record Lookup & Update's film: the short one its tile and page play, cut from the
// console footage of its full walkthrough (films/customer-record-lookup-update.mjs). Built by
// `npm run reel -- customer-record-lookup-update`; reel/overview.mjs documents the fields.
const CALL = { x: 0, y: 246, w: 960 };
const SERVER = { x: 440, y: 246, w: 960 };
const CARD = { x: 0, y: 322, w: 960 };
const NUMBER = { x: 0, y: 360, w: 960 };

export default {
  id: "customer-record-lookup-update",
  film: "customer-record-lookup-update",
  name: "Customer Record Lookup & Update",

  open: {
    headline: "Updates the record. Only after a yes.",
    teams: true,
    shot: "grid",
    focus: SERVER,
    segments: [
      { from: "Log the Fabrikam meeting", to: "Here's what I have for Fabrikam", drop: 1, lead: 3, push: 1.6, tail: 0.5 },
      { from: "Yes, save it", to: "Saved to Fabrikam", lead: 0.4, tail: 0.8 },
    ],
  },

  title: {
    eyebrow: "Voice AI templates for Teams Phone",
    lines: ["Customer record", "lookup and update."],
    sub: "Bring customer context into the call—and write it back.",
    narration: ["Customer record lookup and update.", "Bring customer context into the call—and write it back."],
  },

  chapters: [
    {
      card: "Verified first.",
      clips: [
        {
          headline: "Caller ID is a hint. The PIN is proof.",
          focus: CALL,
          segments: [
            { from: "This is the Contoso sales assistant", head: 1 },
            { from: "Thanks, Alex", drop: 1, lead: 0.8, tail: 0.8 },
          ],
        },
        {
          headline: "Wrong PIN? Nothing opens.",
          teams: true,
          focus: SERVER,
          segments: [{ from: "I couldn't verify you", lead: 1.25, tail: 1.2 }],
        },
      ],
    },
    {
      card: "Need to know.",
      clips: [
        {
          headline: "Name an account. Get the briefing.",
          focus: CARD,
          segments: [{ from: "Brief me on Fabrikam", to: "Fabrikam, Strategic tier", drop: 1, tail: 1 }],
        },
        {
          headline: "Phone numbers? Only when asked.",
          focus: NUMBER,
          segments: [
            { from: "Fabrikam, Strategic tier", head: 3 },
            { from: "What's Dana's number", to: "Dana Ruiz's number" },
          ],
        },
      ],
    },
    {
      card: "Not its call.",
      clips: [
        {
          headline: "Not on the list? Nothing is written.",
          teams: true,
          focus: SERVER,
          segments: [{ from: "Raise Fabrikam's credit limit", to: "The credit limit and the payment terms", drop: 1 }],
        },
        {
          headline: "Put through in Teams. With the details.",
          teams: true,
          focus: SERVER,
          segments: [
            { from: "The credit limit and the payment terms", head: 2 },
            { from: "Yes, put me through", to: "Putting you through", tail: 2.5 },
          ],
        },
      ],
    },
  ],

  trust: {
    lines: ["The caller says yes.", "The server writes."],
    points: ["A field allow-list in config", "Six seconds to say “wait”", "An audit row per field"],
    narration: ["The caller says yes.", "The server writes."],
  },

  yours: {
    title: "Make it yours.",
    files: ["config/writable-fields.json", "config/reps.json", "config/routing.json"],
    prompt: "Let reps update a contact's job title, and leave changes to deals over $1M to Sales Operations.",
    narration: [
      "Make it yours.",
      "The fields a call may change, your reps and who picks up are configuration. Your coding agent can change the rest.",
    ],
  },

  end: {
    lines: ["Customer record", "lookup and update."],
    sub: "Run it in simulation in two minutes. Then connect your own Teams number and CRM.",
    narration: ["Run it in simulation in two minutes.", "Then connect your own Teams number and CRM."],
    run: "cd code && npm install && npm start",
  },
};
