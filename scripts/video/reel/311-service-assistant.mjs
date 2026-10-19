// 311 Service Assistant's film: the short one its Video button plays, cut from the
// console footage of its full walkthrough (films/311-service-assistant.mjs). Built by
// `npm run reel -- 311-service-assistant`; reel/overview.mjs documents the fields.
const CALL = { x: 0, y: 280, w: 960 };
const ANSWERS = { x: 0, y: 332, w: 960 };
const HANDOFF = { x: 440, y: 290, w: 960 };

export default {
  id: "311-service-assistant",
  film: "311-service-assistant",
  name: "311 Service Assistant",

  open: {
    headline: "Report a pothole. Get a case number.",
    shot: "grid",
    segments: [
      { from: "Hi, there's a big pothole", to: "I have the pothole", lead: 3.5, focus: CALL, push: 1.6 },
      { from: "Yes, that's right", focus: CALL },
      // The spelled case number takes longer to say than to read, so the cuts are pinned.
      { from: "I've filed a pothole report", head: 1, drop: 2, headAt: 4.6, dropAt: 10, focus: CALL },
    ],
  },

  title: {
    eyebrow: "Voice AI templates for Teams Phone",
    lines: ["311 service", "assistant."],
    sub: "One number for the whole city. Residents just talk, in English or Spanish.",
    narration: ["Three-one-one service assistant.", "One number for the whole city. Residents just talk, in English or Spanish."],
  },

  chapters: [
    {
      card: "It speaks Spanish.",
      clips: [
        {
          headline: "Hola? Same rules, same service.",
          focus: CALL,
          segments: [{ from: "Hola, necesito", to: "Puedo programar" }],
          translations: {
            "Hola, necesito": "Hi, I need a mattress and an old sofa picked up.",
            "Puedo programar": "I can schedule the pickup of a mattress and a sofa. What's the pickup address?",
          },
        },
        {
          headline: "Scheduled in Spanish. On the city's calendar.",
          focus: CALL,
          segments: [{ from: "En el 1200", to: "La recogida", drop: 1, dropAt: 6 }],
          translations: {
            "En el 1200": "At 1200 Maple Street.",
            "La recogida": "The pickup is scheduled for Saturday, October 3, at 1200 Maple Street.",
          },
        },
      ],
    },
    {
      card: "Safety first.",
      clips: [
        {
          headline: "Smell gas? No questions. Just safety.",
          focus: CALL,
          segments: [{ from: "Hi, I smell gas", to: "This sounds like a gas emergency", drop: 2, dropAt: 5.7 }],
        },
      ],
    },
    {
      card: "It hands off.",
      clips: [
        {
          headline: "No approved answer? It won't guess.",
          focus: ANSWERS,
          segments: [{ from: "And what are the counter hours", to: "I don't have approved information" }],
        },
        {
          headline: "Frustrated? A person, already briefed.",
          teams: true,
          focus: HANDOFF,
          segments: [
            { from: "I want to make a complaint", focus: CALL },
            { from: "I'd like to talk to a person", to: "I'm connecting you with 311 staff", tail: 3 },
          ],
        },
      ],
    },
  ],

  trust: {
    lines: ["The model talks.", "The city's server decides."],
    points: ["Emergency rule on every turn", "Locations checked, read back", "Approved answers, or none"],
    narration: ["The model talks.", "The city's server decides."],
  },

  yours: {
    title: "Make it yours.",
    files: ["config/request-types.json", "config/departments.json", "content/articles/"],
    prompt: "Add a Parks department with its own Teams queue, and make a fallen tree blocking a road a priority.",
    narration: ["Make it yours.", "Departments, request rules and approved answers are configuration. Your coding agent can change the rest."],
  },

  end: {
    lines: ["311 service", "assistant."],
    sub: "Run it in simulation, with no Azure subscription. Then connect your city's Teams number.",
    narration: ["Run it in simulation, with no Azure subscription.", "Then connect your city's Teams number."],
    run: "cd code && npm install && npm start",
  },
};
