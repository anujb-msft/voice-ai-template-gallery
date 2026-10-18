// Film script: After-Hours Sales Lead Capture.
//
// beats[n] narrates console beat n (1-based, as on screen): `intro` before it
// starts, `cues[s]` before step s, `post[s]` after step s settles, `after` at
// the end. The console holds still while the narrator speaks.
export default {
  id: "after-hours-sales-lead-capture",
  port: 18093,
  lang: "en-US",

  cast: {
    agent: { name: "Agent", voice: "marin" },
    callers: {
      dana: {
        name: "Dana Morgan",
        voice: "coral",
        style:
          "Dana Morgan, purchasing manager at Northwind Traders, calling a supplier in the evening to line up a large bolt order. " +
          "Organized, friendly and businesslike: a real person on a phone call, not an actor.",
      },
      sam: {
        name: "Sam Rivera",
        voice: "ash",
        style:
          "Sam Rivera, operations director at Tailwind Traders, calling in the evening because a packaging line is down. " +
          "Under pressure but composed, quick and to the point. Natural phone delivery, not an actor.",
      },
      robin: {
        name: "Robin Diaz",
        voice: "shimmer",
        style:
          "Robin Diaz, maintenance supervisor at Wide World Importers, calling late at night with a conveyor line down. " +
          "Tired and worried, but polite. Natural phone delivery, not an actor.",
      },
    },
  },

  beats: {
    1: {
      caller: "dana",
      intro:
        "7:30 on a Wednesday evening, and Contoso's sales team has gone home. Your server checks the clock, so the agent takes the call.",
      post: {
        2: "One sentence filled in most of the lead. The server scores each answer against your rules, in plain English. The model never sees the score.",
        3: "A decision maker: eight of eight. But the server won't save the lead until Dana confirms the callback number.",
      },
      after:
        "Saved. The server picked the owner and the deadline, and queued the follow-up for Teams and email. Nobody was paged: hot isn't urgent.",
      shots: { "post 2": "decision", after: "teams" },
    },
    2: {
      intro: "Same server, 10:30 that morning. Only the clock has changed.",
      after:
        "Sales is open, so the server sends the call straight to the sales queue in Teams. No agent, no questions, and caller ID flagged as not verified.",
      shots: { after: "teams" },
    },
    5: {
      caller: "sam",
      intro: "Back to 7:30 in the evening. Ben Ortiz is on call until 9, and your policy decides when he's worth interrupting.",
      skip: 1,
      skipLabel: "Past the greeting",
      post: {
        2: "Sam asked for a person, but the model can't promise one. It only notes the request, and the server judges urgency from Sam's own words.",
        4: "Ben picks up already knowing the score, the urgency and why he was paged. That context travels with the call in VoIP headers.",
      },
      cues: { 3: "When Sam confirms the number, the server decides whether to page. Watch the Teams panel." },
      after: "Hot and urgent, inside on-call cover: that's your server's rule for a page, and the reason is written into the lead's follow-up.",
      shots: { "step 4": "teams", after: "decision" },
    },
    6: {
      caller: "robin",
      intro:
        "The same kind of call at 10:30 at night: a conveyor line is down, and Robin Diaz needs lock nuts first thing. But on-call cover ended at 9.",
      skip: 2,
      skipLabel: "Hot and urgent, like Sam",
      post: {
        3: "Hot and urgent, but outside on-call cover, so no page. The server tells the agent what it can promise, and writes the reason into the follow-up.",
      },
      after: "Every call is counted in the lead store: leads captured, qualified and routed, live transfers, and pages answered.",
      shots: { "post 3": "decision", "step 4": "metrics" },
    },
  },

  // Beat 3 (Read back, corrected) repeats beat 1's read-back rule; beat 4 (Not a sales call) is the lightest
  // lesson. Leaving both out, and skipping the greeting and intake the film has already shown in beats 5 and 6,
  // keeps it near five minutes.
  edit: { beats: [1, 2, 5, 6] },

  scenes: {
    open: {
      call: { name: "Dana Morgan", detail: "Northwind Traders", number: "+1 (425) 555-0193", line: "Contoso Industrial Supply · Sales" },
      menuTitle: "The usual after-hours line",
      menu: [
        { key: "☾", text: "Our office is now closed." },
        { key: "✉", text: "Please leave a message after the tone." },
      ],
      bubble: { who: "Dana", text: "We need about 12,000 hex bolts by the end of the month." },
      narration: [
        "Sales teams go home. Buyers keep calling.",
        "After hours, a buyer with a big order usually reaches voicemail, and may call a competitor next. This agent picks up.",
      ],
    },
    title: {
      title: "After-Hours Sales Lead Capture",
      promise: "Never let an unanswered call become a lost lead.",
    },
    how: {
      narration: [
        "Calls arrive on Contoso's sales number in Teams, through Teams Phone extensibility.",
        "After hours, Azure Communication Services Call Automation bridges the audio to Voice Live, where GPT Realtime takes the details.",
        "Your server scores the lead and decides what happens next: a page to the on-call rep in Teams, or the morning queue.",
      ],
      stages: [
        { label: "Caller", detail: "Any phone, any hour", line: 0 },
        { label: "Teams Phone", detail: "Sales number on a resource account", brand: true, line: 0 },
        { label: "Call Automation", detail: "Azure Communication Services media bridge", line: 1 },
        { label: "Voice Live", detail: "GPT Realtime takes the details", line: 1 },
        { label: "Lead policy", detail: "Your server: hours, score, owner, page", line: 2 },
        { label: "Teams", detail: "Sales queue, or the on-call rep", brand: true, line: 2 },
      ],
    },
    hood: {
      title: "The model asks. The server decides.",
      narration: [
        "Under the hood, the model holds the conversation and fills in the lead. It never sees the score, and it can't promise a person.",
        "Your server checks the hours, scores the lead, insists on a confirmed number, picks the owner and decides whether to page. Every decision lands in the trail.",
      ],
      points: [
        { k: "isSalesOpen", v: "Weekdays, 8 AM to 6 PM Pacific. In hours, straight to the sales queue." },
        { k: "Lead score", v: "Product, quantity, timeline and role: 8 points. Hot at 6, warm at 3." },
        { k: "save_lead", v: "Refused until the caller confirms the callback number read back to them." },
        { k: "Urgency", v: "Found by the server in the caller's own words: “line is down”, “first thing”." },
        { k: "decidePage", v: "Inside on-call cover only: hot and urgent, or qualified and asking for a person." },
        { k: "Owner, deadline", v: "Round robin over active reps. Hot: an hour after opening. Warm: next business day." },
      ],
    },
    yours: {
      narration: [
        "Making it yours is mostly configuration: sales hours and on-call cover, the scoring rules, your catalog's minimum orders, and your reps.",
        "The spec, the tests and this demo script give your coding agent the context for the rest.",
      ],
      files: [
        { path: "config/hours.json", note: "Sales hours, holidays, on-call cover" },
        { path: "config/qualification.json", note: "Points per answer, hot and warm thresholds" },
        { path: "config/catalog.json", note: "Product lines and minimum orders" },
        { path: "config/reps.json", note: "Reps, sales manager, Teams user IDs" },
        { path: "SPEC.md", note: "Caller journey and acceptance criteria" },
        { path: "code/public/beats.js", note: "This demo, step by step" },
      ],
      prompt: "Add Saturday on-call cover from 9 AM to 1 PM, and send fittings leads to Ben Ortiz first.",
    },
    close: {
      narration: ["After-hours sales lead capture. Run it in simulation in two minutes, then connect it to your own Teams number."],
      run: "cd code && npm install && npm start",
    },
  },
};
