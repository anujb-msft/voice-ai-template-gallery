// Film script: Intent-Based Call Routing.
//
// beats[n] narrates console beat n (1-based, as on screen): `intro` before it
// starts, `cues[s]` before step s, `post[s]` after step s settles, `after` at
// the end. The console holds still while the narrator speaks.
export default {
  id: "intent-based-call-routing",
  port: 18091,
  lang: "en-US",

  cast: {
    agent: { name: "Agent", voice: "marin" },
    callers: {
      dana: {
        name: "Dana Whitfield",
        voice: "coral",
        style:
          "Dana Whitfield, accounts-payable lead at a logistics company, calling a supplier about a billing problem. " +
          "Friendly, direct and a little hurried: a real person on a phone call, not an actor.",
      },
      priya: {
        name: "Priya Raman",
        voice: "sage",
        style:
          "Priya Raman, an operations manager calling about a renewal charge she did not expect. Polite, puzzled and a " +
          "little annoyed: natural phone delivery, not an actor.",
      },
      marcus: {
        name: "Marcus Bell",
        voice: "ash",
        style:
          "Marcus Bell, an easygoing IT manager calling his software vendor. Quick and casual, the kind of caller who " +
          "changes his mind mid-sentence. Natural phone delivery.",
      },
      unknown: {
        name: "Caller",
        voice: "verse",
        style: "A caller who has no patience for phone menus and just wants a human. Calm but firm, natural phone delivery.",
      },
    },
  },

  beats: {
    1: {
      caller: "dana",
      intro: "Dana calls Contoso's main line. There's no menu. She just says what she needs.",
      post: { 2: "The model proposes Billing, with a confidence score. The server, not the model, checks it against the gate." },
      cues: { 3: "Even above the gate, the agent confirms before it transfers. Watch the Teams panel." },
      after:
        "Billing's Teams client rings with the reason for the call and who's calling, flagged as unverified. " +
        "That context travels in the call's VoIP headers.",
    },
    2: {
      caller: "priya",
      intro: "Some requests really are ambiguous. Priya was charged for a renewal she didn't order. Is that Sales, or Billing?",
      post: { 2: "Sales scored 0.6, under the 0.75 gate. So instead of guessing, the agent asks one question." },
      after: "A wrong transfer costs far more than one clarifying question. And the gate is a number in config, not a line in a prompt.",
    },
    3: {
      caller: "unknown",
      intro: "The quickest way to lose a caller is to make them argue with a bot.",
      after: "Asking for a person goes straight to Reception. No gate, and no “are you sure?”",
    },
    4: {
      caller: "marcus",
      intro: "Callers change their minds. Marcus has a question about his invoice.",
      cues: { 3: "Watch the bar under the gauge. The transfer waits about a second before it dispatches, and Marcus is about to change his mind." },
      post: { 5: "The transfer to Billing was cancelled before it left, and Support is offered instead." },
      after: "Cancelled inside the window, re-proposed, and re-confirmed. The trail shows billing, then support.",
    },
    5: {
      caller: "dana",
      intro: "Same server, 7:30 in the evening. Billing keeps office hours.",
      cues: { 3: "Billing is still the right team, but it's closed. The server checks the hours, and Billing's after-hours rule is to take a message." },
      after: "No transfer into an empty queue. The message waits in the audit log, with its topic, for Billing in the morning.",
    },
    6: {
      caller: "marcus",
      intro: "Sales has a different after-hours rule: send the caller to Reception.",
      after: "The Teams toast carries an after-hours header, so Reception knows this call was meant for Sales.",
    },
    7: {
      caller: "unknown",
      intro: "And when speech doesn't work at all, a bad line, a noisy room, the keypad is always there.",
      cues: {
        4: "A keypress is unambiguous, so it routes without asking again.",
        5: "And every call is audited: transfers, clarifying questions, people requested, and how long it took to route.",
      },
      shots: { "cue 5": "metrics" },
    },
  },

  // Beat 6 (Sales diverted after hours) repeats beat 5's lesson; leaving it out keeps the film near five minutes.
  edit: { beats: [1, 2, 3, 4, 5, 7] },

  scenes: {
    open: {
      call: { name: "Dana Whitfield", detail: "Northwind Traders", number: "+1 (425) 555-0101", line: "Contoso · Main line" },
      menu: ["For sales, press 1.", "For support, press 2.", "For billing, press 3.", "To hear these options again…"],
      narration: [
        "Every call to a main line starts with a reason.",
        "A phone menu makes the caller translate that reason into a number. This agent just asks.",
      ],
    },
    title: {
      title: "Intent-Based Call Routing",
      promise: "Callers say what they need. The right Teams queue answers, already knowing why.",
    },
    how: {
      narration: [
        "Calls arrive on a Teams phone number, through Teams Phone extensibility.",
        "Azure Communication Services Call Automation bridges the audio to Voice Live, where GPT Realtime holds the conversation.",
        "Your server decides where the call goes, and Teams receives it with context.",
      ],
      stages: [
        { label: "Caller", detail: "Any phone" },
        { label: "Teams Phone", detail: "Main-line number on a resource account", brand: true },
        { label: "Call Automation", detail: "Azure Communication Services media bridge" },
        { label: "Voice Live", detail: "GPT Realtime speech to speech" },
        { label: "Routing policy", detail: "Your server, your routes.json" },
        { label: "Teams call queue", detail: "Topic, context and caller in VoIP headers", brand: true },
      ],
    },
    hood: {
      title: "The model proposes. The server decides.",
      narration: [
        "Under the hood, the model's only power is to propose a route from a fixed list.",
        "The server applies the confidence gate, the office hours, and the confirmation. Then Call Automation transfers the call to the Teams queue, with its context.",
        "Every failure path ends with a person, never a loop.",
      ],
      points: [
        { k: "propose_route", v: "A route id, a confidence and a reason, from an allowlist. Never a phone number." },
        { k: "Gate", v: "Confidence of at least 0.75, or one clarifying question. Two, at most." },
        { k: "Hours", v: "Each queue's own time zone. After hours: take a message, or divert." },
        { k: "Confirm", v: "The caller says yes, then has about a second to change their mind." },
        { k: "Transfer", v: "Call Automation to the Teams call queue, with VoIP headers." },
      ],
    },
    yours: {
      narration: [
        "Making it yours is mostly configuration. Your teams, how they're described, their hours and after-hours rules all live in routes.json, and the gate is one environment variable.",
        "The spec, the tests and this demo script give your coding agent the context to change the rest.",
      ],
      files: [
        { path: "config/routes.json", note: "Teams, descriptions, hours, after-hours rules" },
        { path: "config/callers.json", note: "Caller directory for personal greetings" },
        { path: "CONFIDENCE_THRESHOLD=0.75", note: "The gate, in .env" },
        { path: "SPEC.md", note: "Caller journey and acceptance criteria" },
        { path: "code/public/beats.js", note: "This demo, step by step" },
      ],
      prompt: "Add a Legal route that's open weekdays nine to five and takes a message after hours.",
    },
    close: {
      narration: ["Intent-based call routing. Run it in simulation in two minutes, then connect it to your own Teams number."],
      run: "cd code && npm install && npm start",
    },
  },
};
