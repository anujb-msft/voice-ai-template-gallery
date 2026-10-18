// Film script: 311 Service Assistant.
//
// beats[n] narrates console beat n (1-based, as on screen): `intro` before it
// starts, `cues[s]` before step s, `post[s]` after step s settles, `after` at
// the end. The console holds still while the narrator speaks.
//
// All five beats are filmed: each shows a different server policy (verify,
// redirect, switch language, answer from approved content, hand off). Later
// calls skip what the first already showed: the greeting (kept in the Spanish
// call, which answers its "Para español"), and the text-message consent. The
// civic call skips to the question the server won't answer.
export default {
  id: "311-service-assistant",
  port: 18092,
  lang: "en-US",

  cast: {
    agent: { name: "Agent", voice: "marin" },
    callers: {
      alex: {
        name: "Alex Chen",
        voice: "ash",
        style:
          "Alex Chen, a resident calling his city's 311 line about a pothole he drives past every day. Easygoing and helpful, " +
          "says it the way people do: a street and a corner. Natural phone delivery, not an actor.",
      },
      // Sam calls twice, worried the first time and relaxed the second, so the two calls get their own delivery.
      sam: {
        name: "Sam Rivera",
        voice: "verse",
        style:
          "Sam Rivera, a resident who has just noticed a gas smell in his kitchen and isn't sure how serious it is. " +
          "Worried and a little hurried, but not panicking: a real person on a phone call.",
      },
      samLater: {
        name: "Sam Rivera",
        voice: "verse",
        style:
          "Sam Rivera, a resident calling 311 with two everyday questions about trash pickup and City Hall's hours. " +
          "Relaxed and matter-of-fact, natural phone delivery.",
      },
      lucia: {
        name: "Lucía Ortega",
        voice: "shimmer",
        style:
          "Lucía Ortega, a resident who speaks Spanish naturally, as a native speaker, calling her city's 311 line to get an " +
          "old mattress and sofa picked up. Warm, practical and unhurried, natural phone delivery in everyday US Spanish.",
      },
      resident: {
        name: "Resident",
        voice: "coral",
        style:
          "A resident whose trash pickup has been skipped three weeks running, calling with their number withheld. " +
          "Frustrated and tired of waiting, but civil: a real person on a phone call, not an actor.",
      },
    },
  },

  beats: {
    1: {
      caller: "alex",
      intro: "First, Alex Chen reports a pothole the way people actually talk.",
      post: {
        2: "The server, not the model, found that corner on the city's map. Nothing is filed until Alex confirms.",
        4: "A text goes out only with consent. The model never sees Alex's number.",
      },
      shots: { "post 2": "decision", "post 4": "teams" },
    },
    2: {
      caller: "sam",
      intro: "Some calls must never become a service request. Sam Rivera smells gas in his kitchen, and he's called 311.",
      skip: 1,
      skipLabel: "Past the greeting",
      post: { 2: "That was the server's rule, not the model's judgment. It checks every caller turn first: no questions, no case." },
      shots: { "post 2": "decision" },
    },
    3: {
      caller: "lucia",
      lang: "es-US",
      intro: "Lucía Ortega calls the same number, in Spanish.",
      skip: [4, 5],
      skipLabel: "Case number texted",
      post: { 2: "Nobody pressed 2. The server heard Spanish and switched the same agent's language and voice, under the same rules." },
      shots: { "post 2": "decision" },
    },
    4: {
      caller: "samLater",
      intro: "Later, Sam calls back with questions. The model may answer them only from articles the city has approved.",
      skip: 2,
      skipLabel: "Trash day, answered",
      post: { 3: "The only match was an expired notice, so the server withheld it." },
      shots: { "post 3": "decision" },
    },
    5: {
      caller: "resident",
      intro: "Next, a complaint. The server's policy is to apologize, promise nothing, and offer a report or a person.",
      skip: 1,
      skipLabel: "Past the greeting",
      post: {
        3: "The server checked the hours and picked the Teams queue. Staff see the topic, a summary and the caller's mood.",
        4: "Five calls, one number. The model held each conversation; the city's server decided every outcome, and audited it.",
      },
      shots: { "post 3": "teams@bottom", "post 4": "metrics" },
    },
  },

  scenes: {
    open: {
      call: { name: "Alex Chen", detail: "Resident", number: "+1 (206) 555-0142", line: "City of Contoso · 311" },
      menu: ["For English, press 1.", { key: "2", text: "Para español, oprima 2." }, "To report a problem, press 3.", "For trash and recycling, press 4."],
      narration: [
        "One number for everything a city does: potholes, trash, questions, and sometimes an emergency.",
        "A phone tree makes residents pick a branch, and a language. This assistant just listens.",
      ],
    },
    title: {
      title: "311 Service Assistant",
      promise: "One civic number, from question to completed request.",
    },
    how: {
      narration: [
        "Residents call a Teams phone number, through Teams Phone extensibility.",
        "Azure Communication Services Call Automation bridges the audio to Voice Live, where GPT Realtime holds the conversation.",
        "The city's server decides, and hands off to a Teams call queue with context.",
      ],
      stages: [
        { label: "Resident", detail: "Any phone, English or Spanish" },
        { label: "Teams Phone", detail: "311 number on a resource account", brand: true },
        { label: "Call Automation", detail: "Azure Communication Services media bridge" },
        { label: "Voice Live", detail: "GPT Realtime speech to speech" },
        { label: "City policy", detail: "Your server, your config" },
        { label: "Teams call queue", detail: "Staff answer with topic and context", brand: true },
      ],
    },
    hood: {
      title: "The model talks. The city's server decides.",
      narration: [
        "The model converses and calls tools. Every line the caller hears is written by the server.",
        "The server checks the place, the rules and the hours before it files, texts or transfers.",
      ],
      points: [
        { k: "Every line", v: "Written by the server, spoken word for word by the agent." },
        { k: "Emergency rule", v: "Checked on every caller turn, in English and Spanish. No questions, no case." },
        { k: "resolve_location", v: "The city's address data verifies the place; the caller confirms before filing." },
        { k: "submit_request", v: "Required fields, duplicate merging and priority rules, all from config." },
        { k: "search_faq", v: "Reviewed, unexpired articles only, with the source named. Otherwise, no guess." },
        { k: "transfer", v: "The server checks hours, picks the Teams queue and builds the context." },
      ],
    },
    yours: {
      narration: [
        "Making it yours is mostly configuration: request rules, departments and hours, emergency phrases, and approved articles.",
        "The spec and this demo script give your coding agent the context for the rest.",
      ],
      files: [
        { path: "config/request-types.json", note: "Fields, priority rules, response targets" },
        { path: "config/departments.json", note: "Hours and the Teams queue for each" },
        { path: "config/emergency.json", note: "Phrases and guidance, English and Spanish" },
        { path: "content/articles/", note: "Approved answers, with source and review date" },
        { path: "SPEC.md", note: "Caller journeys and acceptance criteria" },
        { path: "code/public/beats.js", note: "This demo, step by step" },
      ],
      prompt: "Add a Parks department with its own Teams queue, and a fallen-tree report that's a priority when it blocks a road.",
    },
    close: {
      narration: ["311 Service Assistant. Run it in simulation, then connect it to your city's Teams number."],
      run: "cd code && npm install && npm start",
    },
  },
};
