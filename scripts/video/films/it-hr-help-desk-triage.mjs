// Film script: IT / HR Help Desk Triage.
//
// beats[n] narrates console beat n (1-based, as on screen): `intro` before it
// starts, `cues[s]` before step s, `post[s]` after step s settles, `after` at
// the end. The console holds still while the narrator speaks.
export default {
  id: "it-hr-help-desk-triage",
  port: 18101,
  lang: "en-US",

  cast: {
    agent: { name: "Agent", voice: "marin" },
    callers: {
      sam: {
        name: "Sam Rivera",
        voice: "alloy",
        style:
          "Sam Rivera, a Contoso employee calling the internal IT and HR help line, from the Teams app or a mobile phone. " +
          "Matter-of-fact about laptop and VPN trouble, a little anxious about a security slip: a real person on a phone call, not an actor.",
      },
      samHR: {
        name: "Sam Rivera",
        voice: "alloy",
        style:
          "Sam Rivera, a Contoso employee calling the help line from Teams about something personal: a manager's comments. " +
          "Quiet and hesitant, choosing the words carefully: a real person on a phone call, not an actor.",
      },
      maria: {
        name: "Maria Lopez",
        voice: "sage",
        style:
          "Maria Lopez, a Contoso team manager calling the internal help line from the Teams app between meetings. " +
          "Organized, brisk and friendly: natural phone delivery, not an actor.",
      },
    },
  },

  beats: {
    1: {
      caller: "sam",
      intro: "Sam Rivera calls the help line from Teams. Teams sign-in already says who's calling, so there are no security questions.",
      post: {
        2: "That's the approved VPN article, word for word. Answers come from your knowledge base, not from the model's memory.",
        3: "Your server drafted that ticket. Sam can't work, so the matrix says P2, and the laptop comes from the directory, not from Sam.",
      },
      after: "One call, two outcomes: an approved answer, and a ticket filed only on a clear yes.",
      shots: { "post 3": "decision", after: "inbox" },
    },
    2: {
      caller: "maria",
      intro: "Maria Lopez wants an update. The agent can read a ticket's status aloud, but only to people on that ticket.",
      post: {
        2: "That's Sam's ticket, not Maria's. Your server checks who it belongs to, and won't read it out.",
        4: "No duplicate ticket. Your server adds Maria to the open Outlook incident instead.",
      },
      after: "Who may hear what is a server rule, not a line in a prompt.",
    },
    3: {
      caller: "sam",
      intro: "Now Sam calls from a mobile phone. Caller ID is easy to fake, so even a matching number is only a hint.",
      skip: 1,
      skipLabel: "Past the greeting",
      post: {
        3: "Your server made a one-time code for this call. In simulation nothing is sent: it appears in this mock Teams chat.",
        4: "Refused. One more miss, and Sam goes to a person who can verify another way.",
      },
      after: "Only then is the ticket read out. The code works once, and never reaches the audit log or a console watching a real call.",
      shots: { "post 3": "inbox", "post 4": "decision" },
    },
    4: {
      caller: "samHR",
      intro: "Some calls need a person straight away, with as little on record as possible. Watch what the agent doesn't do.",
      skip: 1,
      skipLabel: "Past the greeting",
      post: {
        2: "Your server's guard ran first, before any classifier or tool. No questions, no ticket, and the transcript keeps only a placeholder.",
      },
      after: "The person who picks up sees “Confidential HR”. No topic, no summary, no notes, in the Teams toast or the headers.",
      shots: { "post 2": "decision", after: "teams" },
    },
    5: {
      caller: "maria",
      intro: "Maria Lopez's problem could belong to IT or to HR. A wrong transfer wastes everyone's time.",
      post: {
        2: "Two topics tie at 0.45, under the 0.70 gate in config. So your server asks one question instead of guessing.",
        3: "Payroll sees Maria's name and the topic, nothing more. Each queue gets only the fields routing.json allows.",
      },
      shots: { "post 2": "decision", "post 3": "teams" },
    },
    6: {
      caller: "maria",
      intro: "When the approved answer doesn't fix it, the caller gets a person without starting over.",
      post: {
        3: "Straight to the IT service desk, no more questions. They see who's calling, the topic, and what Maria already tried.",
      },
      shots: { "post 3": "teams" },
    },
    7: {
      caller: "sam",
      intro: "Last call of the day, and it's an urgent one. A security incident can't wait in a queue.",
      skip: 1,
      skipLabel: "Past the greeting",
      post: {
        2: "Security incidents are P1 by rule, in your server's priority matrix. The model never sets a priority.",
        3: "IT on-call sees the P1, the ticket number and Sam's laptop before picking up.",
      },
      after: "Every outcome is counted. Private HR calls show as “fewer than five” until there are enough that nobody can be singled out.",
      shots: { "post 2": "decision", "post 3": "teams", "step 4": "metrics" },
    },
  },

  // Beat 2 (only your own tickets, outage dedupe) is cut for length: beat 3 already shows the server deciding who may hear a ticket, and the hood names both rules.
  // Beat 5 (one question when IT or HR is unclear) is cut for length too; the hood names the confidence gate.
  // Beat 6 (asking for a person) repeats the handoff-with-context lesson that beat 7 already shows.
  // Beats 3, 4 and 7 skip the greeting beat 1 has already shown.
  edit: { beats: [1, 3, 4, 7] },

  scenes: {
    open: {
      call: { label: "Incoming Teams call", name: "Sam Rivera", detail: "Contoso employee", line: "Contoso IT and HR help line" },
      menu: ["For IT, press 1.", "For HR, press 2.", "For payroll, press 3.", { key: "♪", text: "All our staff are busy. Please hold." }],
      narration: [
        "On a typical help line, employees guess whether a problem belongs to IT, HR or payroll, and often wait in the wrong queue.",
        "Some problems are too personal for a phone menu. Here, employees just say what's wrong.",
      ],
    },
    title: {
      title: "IT / HR Help Desk Triage",
      promise: "Resolve the routine request. Route the sensitive one privately.",
    },
    how: {
      narration: [
        "Employees call the help line from Teams, or from any phone, through Teams Phone extensibility.",
        "Azure Communication Services Call Automation bridges the audio to Voice Live, where GPT Realtime holds the conversation.",
        "Your server decides who's calling, what they may hear, and which Teams queue takes the call.",
      ],
      stages: [
        { label: "Caller", detail: "An employee, on Teams or any phone" },
        { label: "Teams Phone", detail: "Help-line number on a resource account", brand: true },
        { label: "Call Automation", detail: "Azure Communication Services media bridge" },
        { label: "Voice Live", detail: "GPT Realtime speech to speech" },
        { label: "Triage policy", detail: "Your server: identity, tickets, routing" },
        { label: "Teams queues", detail: "IT, on-call, HR, Payroll, Confidential HR", brand: true },
      ],
    },
    hood: {
      title: "The model converses. The server decides.",
      narration: [
        "Under the hood, the model converses and proposes. It never sets a priority, and it can't send anyone to a private queue.",
        "Your server decides: the guard runs first, identity and confidence are gated, the matrix sets priority, and each queue gets only its allowed fields.",
      ],
      points: [
        { k: "Sensitive guard", v: "Runs first on every turn. Asks nothing, files nothing, stores none of the words." },
        { k: "Identity", v: "Teams sign-in, or a one-time code to Teams chat. Caller ID is only a hint." },
        { k: "Confidence gate", v: "Under 0.70, one clarifying question. Still unclear after that, a person." },
        { k: "Priority matrix", v: "Impact and blocked set P1 to P4. Security incidents are always P1." },
        { k: "Tickets", v: "Filed only on a yes. Status read only to people on it. Outages join one incident." },
        { k: "callContext", v: "Only the fields routing.json allows per queue. Confidential HR gets just the label." },
      ],
    },
    yours: {
      narration: [
        "Making it yours is mostly configuration: your topics and approved articles, your Teams queues and hours, your sensitive phrases and priority rules.",
        "Delivering the one-time code is left as a stub. Your coding agent wires it to Teams chat, with the spec and tests as guardrails.",
      ],
      files: [
        { path: "config/sensitive.json", note: "Phrases that go straight to Confidential HR" },
        { path: "config/routing.json", note: "Teams queues, hours, allowed handoff fields" },
        { path: "config/taxonomy.json", note: "Topics, keywords, and the action for each" },
        { path: "config/priority-matrix.json", note: "Impact and blocked to priority; security P1" },
        { path: "kb/", note: "Approved IT and HR articles, with review dates" },
        { path: "src/adapters/otp.mjs", note: "Code delivery: a stub until you wire it" },
      ],
      prompt: "Wire OtpSender.deliver to Microsoft Graph so the code posts to the employee's Teams chat. Keep the 5-minute expiry and its tests.",
      context: ["SPEC.md", "DEMO-SCRIPT.md", "test/"],
    },
    close: {
      narration: ["IT and HR help desk triage. Run it in simulation in two minutes, then connect it to your own Teams number."],
      run: "cd code && npm install && npm start",
    },
  },
};
