// Film script: IT Help Desk Password Reset.
//
// beats[n] narrates console beat n (1-based, as on screen): `intro` before it
// starts, `cues[s]` before step s, `post[s]` after step s settles, `after` at
// the end. The console holds still while the narrator speaks.
//
// Outbound: each beat starts when an employee clicks "Forgot password?" and the
// help desk calls them back. The employee who answers is the beat's caller.
// Every beat pins the demo clock and places its own callback, so the filmed
// beats don't depend on the cut ones (the footer metrics add up the filmed calls).
export default {
  id: "it-helpdesk-password-reset",
  port: 18100,
  lang: "en-US",

  cast: {
    agent: { name: "Agent", voice: "marin" },
    callers: {
      alex: {
        name: "Alex Morgan",
        voice: "ash",
        style:
          "Alex Morgan, who works in Field Operations at Contoso, locked out of their account at the start of a shift and " +
          "taking the IT help desk's callback on a mobile phone. Busy, direct and a little impatient, keen to get back to work. " +
          "A real person on a phone call, not an actor.",
      },
      jordan: {
        name: "Jordan Patel",
        voice: "sage",
        style:
          "Jordan Patel, who works in Contoso's Finance department, taking the IT help desk's callback at a desk after asking " +
          "for a password reset. Polite but distracted, unsure of the employee ID at first, and short on patience when things drag. " +
          "Natural phone delivery, not an actor.",
      },
    },
  },

  beats: {
    1: {
      caller: "alex",
      intro: "Here's that callback. The page sends only a username, so the call goes to the number on file.",
      cues: {
        3: "Only the phone heard that code; your server never sends it to the page. A username alone can't reset anything.",
        4: "Your server checks each rule as Alex types. The agent is told only which rules failed, never the password.",
      },
      post: {
        5: "The model only talked. Your server checked the digits, the code and every rule, and closed the ticket on its own.",
      },
      shots: { "cue 3": "portal", "cue 4": "portal", "post 5": "decision" },
    },
    3: {
      caller: "alex",
      intro: "Another callback to Alex's number. Whoever answers tries the classic help desk attack: urgency first, then someone else's account.",
      skip: 1,
      skipLabel: "Past the greeting",
      post: {
        2: "Even a persuaded model couldn't skip it. Your server has no path past verification, and a second push goes to a person.",
        3: "Sam's record was never looked up. The call goes to the service desk, flagged, and Teams shows the risk before anyone answers.",
      },
      shots: { "post 2": "decision", "post 3": "teams" },
    },
    6: {
      caller: "jordan",
      intro: "Later, Jordan Patel in Finance gets a callback. Jordan has the right digits, but is pulled away before typing the code.",
      // The greeting and the digits replay beat 1, so the film picks up at the code.
      skip: 2,
      skipLabel: "Jordan is verified",
      cues: { 3: "The demo clock skips ahead seven minutes. Codes last five, judged by your server's clock." },
      post: {
        5: "A person, no argument. Teams tells the service desk that Jordan is verified and frustrated, and what's been tried.",
        6: "Every number here traces back to a call in the audit trail.",
      },
      shots: { "cue 3": "top", "post 5": "teams", "step 6": "metrics" },
    },
  },

  // Beat 2 (Wrong digits) shows two misses closing verification, which the hood states; beat 3 already shows
  // the server can't be talked past it. Later calls skip the greeting beat 1 already played.
  // Beat 4 (An approved answer) replays beat 1's whole reset for one point, FAQ-only answers, which the hood makes.
  // Beat 5 (Keypad on a noisy line) replays beat 1's reset by keypad; same policy, a different channel.
  edit: { beats: [1, 3, 6] },

  scenes: {
    open: {
      call: {
        label: "Incoming call",
        name: "Contoso IT",
        detail: "Password reset callback",
        line: "Alex Morgan · Field Operations",
      },
      menuTitle: "The usual password reset",
      menu: [
        { key: "✉", text: "Ticket opened. We'll be in touch." },
        "For password resets, press 3.",
        { key: "♪", text: "Your call is important to us." },
      ],
      bubble: { who: "Alex", text: "I'm locked out, and my shift starts now" },
      narration: [
        "Wednesday, 9:05 in the morning. Alex Morgan is locked out, just as a shift starts.",
        "Usually that means a ticket, a phone menu and a queue. This time, the help desk calls first.",
      ],
    },
    title: {
      title: "IT Help Desk Password Reset",
      promise: "Forgot password? We already called you back.",
    },
    how: {
      title: "From “Forgot password?” to a verified reset",
      narration: [
        "Forgot password opens a ticket. The help desk calls back from a Teams number, through Teams Phone extensibility.",
        "Call Automation carries the audio to Voice Live, where GPT Realtime talks.",
        "Your server decides. When a person is needed, the service desk takes over in Teams.",
      ],
      stages: [
        { label: "Employee", detail: "Clicks Forgot password? to sign in", line: 0 },
        { label: "Teams Phone", detail: "The callback, from a Teams number", brand: true, line: 0 },
        { label: "Call Automation", detail: "Places the call, bridges the audio", line: 1 },
        { label: "Voice Live", detail: "GPT Realtime holds the conversation", line: 1 },
        { label: "Reset policy", detail: "Your server: digits, code, password rules", line: 2 },
        { label: "IT service desk", detail: "Teams handoff, with the context", brand: true, line: 2 },
      ],
    },
    hood: {
      title: "The model can only ask. Your server decides.",
      narration: [
        "The model's tools only ask: check these digits, issue a code, refuse, answer from the FAQ, hand off, or hang up.",
        "None takes a username, a phone number or a password. Your server decides what each request leads to.",
      ],
      points: [
        { k: "Identity", v: "Last four of the employee ID, compared on your server. Two misses close it." },
        { k: "One-time code", v: "Read aloud on the call, never sent to the page. Five minutes, three per call." },
        { k: "Password policy", v: "12+ characters, mixed case, a number and a symbol; no name; not a common password." },
        { k: "refuse_request", v: "Someone else's account, or pushing twice to skip verification: flagged, handed over." },
        { k: "answer_question", v: "Approved FAQ only. If it isn't covered, the agent offers the service desk." },
        { k: "Handoff", v: "Topic, risk, ticket and caller in VoIP headers. No digits, codes or passwords." },
      ],
    },
    yours: {
      narration: [
        "Your directory and ticketing system plug in as providers, and the limits sit in one policy block.",
        "The README and this demo script give your coding agent the context for the rest.",
      ],
      files: [
        { path: "src/flow.mjs", note: "POLICY: misses, code lifetime, codes per call" },
        { path: "src/providers/directory.mjs", note: "Entra ID or Okta, and the password policy" },
        { path: "src/providers/ticketing.mjs", note: "ServiceNow, Jira Service Management" },
        { path: "knowledge/password-reset-faq.md", note: "The only answers the agent may give" },
        { path: "SERVICE_DESK_TEAMS_ID=…", note: "The Teams service desk for handoffs, in .env" },
        { path: "code/public/beats.js", note: "This demo, step by step" },
      ],
      context: ["README.md", "DEMO-SCRIPT.md", "test/"],
      prompt: "Connect the directory provider to Microsoft Entra ID, and require 14-character passwords.",
    },
    close: {
      narration: ["IT help desk password reset. Run it in simulation in two minutes, then connect it to your own Teams number."],
      run: "cd code && npm install && npm start",
    },
  },
};
