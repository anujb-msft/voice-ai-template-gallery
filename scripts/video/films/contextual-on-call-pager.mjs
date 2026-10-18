// Film script: Contextual On-Call Pager.
//
// beats[n] narrates console beat n (1-based, as on screen): `intro` before it
// starts, `cues[s]` before step s, `post[s]` after step s settles, `after` at
// the end. The console holds still while the narrator speaks.
//
// Each beat is a tenant's call to the after-hours line, then the pages it
// triggers. The tenant is the beat's caller; the technicians who pick up the
// pages (Morgan, Priya) are voiced through `lines`.
export default {
  id: "contextual-on-call-pager",
  port: 18097,
  lang: "en-US",

  cast: {
    agent: { name: "Agent", voice: "marin" },
    callers: {
      alice: {
        name: "Alice Rivera",
        voice: "coral",
        style:
          "Alice Rivera, a tenant at Maple Court, calling the after-hours maintenance line near midnight with water pouring " +
          "through her kitchen ceiling. Worried and a little breathless, but clear. A real person on a phone call, not an actor.",
      },
      dee: {
        name: "Dee Nguyen",
        voice: "alloy",
        style:
          "Dee Nguyen, a tenant at Pine Terrace, calling late at night because the heat is out and the apartment is down to 52 degrees. " +
          "Cold, tired and matter-of-fact. Natural phone delivery.",
      },
      ben: {
        name: "Ben Carter",
        voice: "echo",
        style:
          "Ben Carter, a tenant at Maple Court, calling the maintenance line on a Thursday night because he's locked out " +
          "with his keys inside. Calm and practical, a little sheepish. Natural phone delivery, not an actor.",
      },
      grace: {
        name: "Grace Kim",
        voice: "shimmer",
        style:
          "Grace Kim, a tenant at Pine Terrace, calling on a Saturday night because the heat in her bedroom is out. " +
          "Relaxed and reasonable, in no hurry. Natural phone delivery.",
      },
      morgan: {
        name: "Morgan Lee",
        voice: "ash",
        style:
          "Morgan Lee, the on-call maintenance technician, answering a page on a mobile phone near midnight. Just woken but alert, " +
          "brief and practical. A real technician on a phone call, not an actor.",
      },
      priya: {
        name: "Priya Shah",
        voice: "sage",
        style:
          "Priya Shah, a maintenance technician on the on-call rotation, answering a page late at night. Calm, efficient and " +
          "to the point. Natural phone delivery.",
      },
    },
  },

  // The technicians' lines, in beats whose caller is the tenant.
  lines: [
    { match: "Morgan", caller: "morgan" },
    { match: "I've got it — on my way", caller: "morgan" },
    { match: "Priya", caller: "priya" },
    { match: /^I've got it\.$/, caller: "priya" },
  ],

  beats: {
    1: {
      caller: "alice",
      intro: "Here's where that page starts. Wednesday, 11:42 at night, Alice Rivera calls the after-hours line.",
      post: {
        2: "The agent fills in fields. The server's triage rules call an active leak urgent; the model never picks a severity.",
        4: "The rotation says Morgan. The Teams card already has the unit, the problem and the way in, and no phone numbers.",
      },
      cues: { 5: "Listen for the brief. The server writes it from those fields; the model only reads it." },
      shots: { "post 2": "decision", "post 4": "teams" },
    },
    2: {
      caller: "dee",
      intro: "Same night, at Pine Terrace, where Omar Diaz is on call. Dee Nguyen's heat is out, and it's getting cold.",
      skip: [
        [1, 1],
        [8, 8],
      ],
      skipLabel: ["Past the greeting", "Priya hears the brief"],
      post: {
        2: "52 degrees is under the 55-degree no-heat line in config, so it's urgent.",
        4: "No answer. The server's timer allows two tries per level, three minutes apart. The demo clock skips ahead.",
      },
      after: "Two misses, then the secondary. Priya's acknowledgement canceled the 20-minute operations alert.",
      shots: { "post 2": "decision", "post 4": "decision" },
    },
    3: {
      caller: "ben",
      intro: "Thursday night. Priya swapped shifts with Morgan, so when Ben Carter is locked out at Maple Court, the page goes to her.",
      skip: 4,
      skipLabel: "Priya is paged",
      post: {
        5: "Anyone near the phone could hear that. So the server keeps the building, the unit and the problem off voicemail.",
      },
      shots: { "post 5": "guard" },
    },
    4: {
      caller: "grace",
      intro: "Saturday, 10:15 at night, and Grace Kim's bedroom heat is out. Is that worth waking a technician?",
      skip: 1,
      skipLabel: "Past the greeting",
      post: { 2: "64 degrees is above the 55-degree line, so the server calls it routine. The model doesn't get a vote." },
      after: "Nobody woke up, and the work order keeps every detail.",
      shots: { "post 2": "decision" },
    },
  },

  // Beat 5 (Questions, not phone numbers) is cut: it replays beat 1's page, and its lesson, that numbers
  // never leave the server, is already made by the Teams card, the voicemail and the hood. Later calls skip
  // the greeting and the brief beat 1 already played, and the locked-out call skips to its voicemail.
  edit: { beats: [1, 2, 3, 4] },

  scenes: {
    open: {
      call: {
        label: "Incoming call",
        name: "Contoso Maintenance",
        detail: "On-call pager",
        line: "Morgan Lee · on call tonight",
      },
      menuTitle: "The usual after-hours page",
      menu: [
        { key: "✉", text: "PAGE: call 206-555-0101" },
        { key: "?", text: "What's wrong? Which unit? Can I get in?" },
        { key: "↻", text: "No answer? Somebody tries again. Eventually." },
      ],
      bubble: { who: "Morgan", text: "Tell me what's wrong, which unit, and how I get in" },
      narration: [
        "It's 11:42 at night, and Contoso is paging its on-call technician.",
        "Most pages are a number to call back. This one arrives with the answers.",
      ],
    },
    title: {
      title: "Contextual On-Call Pager",
      promise: "Reach the right person with the context already attached.",
    },
    how: {
      narration: [
        "Tenants call the maintenance line's Teams number. Call Automation answers, and places each page.",
        "Voice Live, with GPT Realtime, talks to both. Your server decides who to wake, and writes the brief.",
      ],
      stages: [
        { label: "Tenant", detail: "Calls the after-hours line" },
        { label: "Teams Phone", detail: "The maintenance line's Teams number", brand: true },
        { label: "Call Automation", detail: "Answers, then places each page" },
        { label: "Voice Live", detail: "GPT Realtime, on both calls" },
        { label: "Paging policy", detail: "Your server: triage, rotation, timers" },
        { label: "Technician", detail: "A spoken brief, plus a Teams card", brand: true },
      ],
    },
    hood: {
      title: "The model listens. The server decides who wakes up.",
      narration: [
        "The model listens, fills in fields, and reads the brief it's handed. It never picks a severity or a person.",
        "Your server classifies, picks the on-call chain, writes the brief and runs the timers.",
      ],
      points: [
        { k: "classify", v: "Config rules: emergency words, urgent issues, the 55°F no-heat line." },
        { k: "onCallChain", v: "Primary, secondary, property manager: the rotation, with its overrides." },
        { k: "buildPageBrief", v: "The spoken brief, written by the server from the captured fields." },
        { k: "Escalation", v: "Two tries per level, 3 minutes apart (1 for emergencies); ops alert at 20." },
        { k: "Questions", v: "Answered from stored fields. A request for a number gets a bridge offer." },
        { k: "Voicemail", v: "A callback prompt and a reference number. Nothing else." },
      ],
    },
    yours: {
      narration: [
        "Most changes are configuration: triage rules, rotations and swaps, escalation timers, buildings.",
        "The spec and this demo script give your coding agent the context for the rest.",
      ],
      files: [
        { path: "config/triage.json", note: "Emergency words, urgent issues, the 55°F line" },
        { path: "config/oncall.json", note: "Rotations, swap overrides, technicians" },
        { path: "config/escalation.json", note: "Levels, tries per level, gaps, ops alert" },
        { path: "config/properties.json", note: "Buildings, aliases, property managers" },
        { path: "SPEC.md", note: "Caller journey and acceptance criteria" },
        { path: "code/public/beats.js", note: "This demo, step by step" },
      ],
      context: ["SPEC.md", "DEMO-SCRIPT.md", "test/"],
      prompt: "Add a holiday rotation for Thanksgiving week, and make the emergency retry gap two minutes instead of one.",
    },
    close: {
      narration: ["Contextual on-call pager. Run it in simulation in two minutes, then connect it to your own Teams number."],
      run: "cd code && npm install && npm start",
    },
  },
};
