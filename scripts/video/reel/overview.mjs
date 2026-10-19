// The overview reel: one short film across all eleven templates, cut from the
// console footage each template's own film recorded (see films/*.mjs). Built by
// `npm run reel` (src/reel.mjs) after every film has been composed.
//
// Each clip names a composed film and one or more segments of its call. A segment
// runs from the heard line starting with `from` to the heard line starting with
// `to` (or just the `from` line), inclusive:
//   head  skip the first `head` sentences of the segment's first line
//   drop  keep only the first `drop` sentences of the segment's last line
//   lead  seconds of footage before the first line (default 0.5; 1.0 on a chapter's
//         first clip, to cover the device rising)
//   tail  seconds of footage after the last line (default 0.6)
// Trims cut in the pause between sentences, so the picture never jumps mid-line.
// `teams: true` marks clips whose frame shows the Teams panel, which the console
// simulates; the reel labels them. `translations` subtitle non-English lines, keyed
// by the line's opening words.
//
// The camera: `focus` (on a clip, or a segment to override it) names one of the
// film's shots, or an explicit { x, y, w } region of the console in CSS px (the
// three panels sit at y≈246; w960 frames two of them). A clip opens on `shot`
// (default "grid", the whole console) and leans into its focus `push` seconds in
// (default 0.8); a later segment glides on from where the last one settled.
// Without a focus, `shot` holds the camera still; with neither, it replays the
// film's own moves.
//
// Everything said here must stay true of the templates: no invented metrics, and
// the disclosure names the synthetic voices, fictional callers and simulation mode.
export default {
  id: "overview",
  name: "Voice AI templates for Teams Phone",
  narrator: {
    voice: "cedar",
    style:
      "The voice of a premium product film: calm, warm, intimate and confident. Unhurried and understated, never salesy; short phrases with space around them, as if speaking to one person.",
  },

  open: {
    film: "intent-based-call-routing",
    headline: "No menu. Just say what you need.",
    teams: true,
    shot: "grid",
    segments: [
      { from: "Hi Dana", to: "It sounds like Billing", lead: 3.5, focus: { x: 0, y: 246, w: 960 }, push: 1.6 },
      { from: "yes please", to: "Connecting you now", tail: 3.6, focus: { x: 440, y: 246, w: 960 } },
    ],
  },

  title: {
    lines: ["Voice AI templates", "for Teams Phone."],
    sub: "Eleven of them. Each one ready to run.",
    narration: ["Voice AI templates for Teams Phone.", "Eleven of them, each one ready to run."],
  },

  chapters: [
    {
      card: "It answers.",
      clips: [
        {
          film: "general-inquiry-agent",
          headline: "Answers from your content. And names the source.",
          focus: "decision",
          segments: [{ from: "What are City Hall", to: "City Hall public counters", drop: 3 }],
        },
        {
          film: "bid-price-lookup-agent",
          headline: "Your prices, read word for word.",
          focus: "quote",
          segments: [{ from: "What's corn paying", to: "Corn at Riverside", drop: 1 }],
        },
        {
          film: "311-service-assistant",
          headline: "Hears Spanish. Answers in Spanish.",
          focus: "decision",
          segments: [{ from: "Hola, necesito", to: "Puedo programar" }],
          translations: {
            "Hola, necesito": "I need a mattress and an old sofa picked up.",
            "Puedo programar": "I can schedule that pickup. What's the address?",
          },
        },
      ],
    },
    {
      card: "It acts.",
      clips: [
        {
          film: "appointment-scheduling-agent",
          headline: "Slot just taken? It never double-books.",
          focus: "decision",
          segments: [{ from: "Yes, book it", to: "Sorry, that time was just taken", drop: 1 }],
        },
        {
          film: "appointment-reminder-agent",
          headline: "Calls patients before their visit.",
          focus: "decision",
          segments: [{ from: "Hello?", to: "Yes, this is Jordan" }],
        },
        {
          film: "customer-record-lookup-update",
          headline: "Updates the record. Only after a yes.",
          focus: "teams",
          segments: [{ from: "Yes, save it", to: "Saved to Fabrikam" }],
        },
        {
          film: "it-helpdesk-password-reset",
          headline: "Won't skip security. However urgent.",
          focus: "decision",
          segments: [{ from: "I don't have my employee ID", to: "I'm sorry, I can't skip that", drop: 1 }],
        },
      ],
    },
    {
      card: "It hands off.",
      clips: [
        {
          film: "it-hr-help-desk-triage",
          headline: "Sensitive calls go straight to a person.",
          teams: true,
          focus: "teams",
          segments: [{ from: "My manager keeps", to: "That is something our HR team", tail: 1.6 }],
        },
        {
          film: "contextual-on-call-pager",
          headline: "Spots the emergency. Pages the on-call tech.",
          teams: true,
          segments: [
            { from: "Water is pouring", to: "Understood", drop: 1, focus: { x: 0, y: 246, w: 960 } },
            { from: "I'm contacting the on-call", drop: 2, tail: 1.8, focus: "teams" },
          ],
        },
        {
          film: "after-hours-sales-lead-capture",
          headline: "Hot lead after hours? It pages your rep.",
          teams: true,
          segments: [
            { from: "This is Sam Rivera", head: 1, focus: "decision" },
            { from: "Thanks, Sam. I'm paging", tail: 1.4, focus: "teams" },
          ],
        },
      ],
    },
  ],

  trust: {
    lines: ["The model talks.", "Your server decides."],
    points: ["Facts from your systems", "Rules in your code", "An audit trail for every call"],
    narration: ["The model talks.", "Your server decides."],
  },

  end: {
    lines: ["Voice AI templates", "for Teams Phone."],
    sub: "Eleven starting points. Make them yours.",
    stack: "Teams Phone extensibility · Azure AI Voice Live · Azure OpenAI GPT Realtime",
    narration: ["Eleven starting points.", "Make them yours."],
  },

  fine: "Simulation mode · Synthetic voices by Azure OpenAI GPT Realtime · Fictional callers · Calls shortened",
  disclosure:
    "Every voice is synthetic, performed by Azure OpenAI GPT Realtime through Azure AI Voice Live. Callers, companies and numbers are fictional. Each template's console was recorded in simulation mode; its Teams panel is simulated.",

  // The still the gallery's front page shows for the reel (hero.webp): the open's
  // handoff, this many seconds before the open ends. Its Teams label stays in frame.
  hero: { before: 1.8 },
};
