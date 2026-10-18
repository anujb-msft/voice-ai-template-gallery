// Film script: Customer Record Lookup & Update.
//
// beats[n] narrates console beat n (1-based, as on screen): `intro` before it
// starts, `cues[s]` before step s, `post[s]` after step s settles, `after` at
// the end. The console holds still while the narrator speaks.
export default {
  id: "customer-record-lookup-update",
  port: 18098,
  lang: "en-US",

  cast: {
    agent: { name: "Agent", voice: "marin" },
    callers: {
      alex: {
        name: "Alex Morgan",
        voice: "echo",
        style:
          "Alex Morgan, a Contoso field sales rep, calling the record desk about his Fabrikam account between customer meetings. " +
          "Brisk, friendly and practical, often on the move: a real person on a phone call, not an actor.",
      },
    },
  },

  beats: {
    1: {
      caller: "alex",
      intro: "Alex is on his way to see Fabrikam, and calls the record desk from his mobile.",
      cues: {
        2: "Caller ID matches his registered mobile, but that's only a hint. Nothing opens until your server checks his PIN against a stored hash.",
      },
      post: {
        3: "Your server wrote that briefing, from accounts Alex owns or works on. Phone numbers stay off it until he asks.",
      },
      shots: { "step 3": { x: 0, y: 520, w: 960, hold: true }, "post 3": "decision" },
    },
    2: {
      caller: "alex",
      intro: "Straight after the meeting, Alex calls back from Teams. His Teams sign-in verifies him, so there's no PIN.",
      post: {
        2: "The model only passed Alex's words along. Your server picked out each field, checked it against your allow-list, and wrote that read-back.",
      },
      // Nothing between steps 3 and 4: the undo window runs on a server timer.
      cues: {
        3: "A bare yes wouldn't count. Even after “yes, save it”, your server holds the write for six seconds, and “wait” still stops it.",
      },
      after: "Nobody objected, so your server wrote it all in one commit, an audit row per field. “Undo that” would still reverse it.",
      shots: { "post 2": "writeback", after: "writeback" },
    },
    3: {
      caller: "alex",
      intro: "Next call, from Teams again: Dana has a new mobile number.",
      cues: { 3: "Watch the bar. Alex's yes opens the six-second window, and he's about to change his mind." },
      after: "The model asked to cancel, but the timer belongs to your server, and it stopped the write with seconds to spare.",
      shots: { after: "decision" },
    },
    4: {
      caller: "alex",
      intro: "Now Alex asks for changes only Sales Operations may make. What a call can change is set by your server, not the prompt.",
      skip: 1,
      skipLabel: "Past the greeting",
      post: {
        2: "Your server refused both fields, whatever the model made of them. And your routing config decides who picks up.",
      },
      after:
        "Sales Operations' Teams queue rings, with the account, the request and the refusal in the VoIP headers. No PIN, no phone numbers.",
      shots: { "post 2": "writeback", after: "teams" },
    },
    5: {
      intro: "Last call: someone has Alex's phone, but not his PIN.",
      post: {
        2: "No second try, and no record opened. Sales Operations gets only the failed check and the number's last four digits.",
      },
      after:
        "These numbers come straight from the audit log. The model talked; your server decided who was verified, what was read out and what was written.",
      shots: { "post 2": "teams", "step 3": "metrics" },
    },
  },

  // Four beats teach a different server rule each: verify before reading, an explicit yes and an undo
  // window before writing, the allow-list, and failing safe. Beat 3 (a change of mind inside the undo
  // window) is cut for length: beat 2's narration says "wait" stops a write, and the hood names the window.
  edit: { beats: [1, 2, 4, 5] },

  scenes: {
    open: {
      call: { name: "Alex Morgan", detail: "Contoso sales rep", number: "+1 (425) 555-0197", line: "Contoso · Record desk" },
      menuTitle: "Between meetings, the usual way",
      menu: [
        { key: "⌨", text: "Open the laptop in the parking lot to read up." },
        { key: "✎", text: "Type the meeting notes in tonight, from memory." },
      ],
      bubble: { who: "Alex", text: "Brief me on Fabrikam." },
      narration: [
        "Field reps live between meetings, and the CRM lives on a laptop.",
        "So the briefing gets skipped, and the notes wait until tonight. Alex just calls the record desk.",
      ],
    },
    title: {
      title: "Customer Record Lookup & Update",
      promise: "Bring customer context into the call—and write it back.",
    },
    how: {
      narration: [
        "Reps call the record desk straight from Teams, or dial its Teams number from their mobile, through Teams Phone extensibility.",
        "Azure Communication Services Call Automation bridges the audio to Voice Live, where GPT Realtime holds the conversation.",
        "Your server verifies the rep, reads and writes the CRM, and passes what it can't change to Sales Operations in Teams.",
      ],
      stages: [
        { label: "Sales rep", detail: "Teams, or a registered mobile", line: 0 },
        { label: "Teams Phone", detail: "Record desk on a resource account", brand: true, line: 0 },
        { label: "Call Automation", detail: "Azure Communication Services media bridge", line: 1 },
        { label: "Voice Live", detail: "GPT Realtime holds the conversation", line: 1 },
        { label: "Record policy", detail: "Your server: identity, allow-list, undo", line: 2 },
        { label: "Sales Operations", detail: "Teams call queue, with context", brand: true, line: 2 },
      ],
    },
    hood: {
      title: "The model proposes. The server writes.",
      narration: [
        "The model holds the conversation and passes the rep's words to server tools. Fields, record IDs and transfer targets come from your server.",
        "Your server verifies the caller, scopes every record, checks each field against the allow-list, holds the undo window, and writes the audit rows.",
      ],
      points: [
        { k: "RepDirectory", v: "A Teams sign-in, or a registered mobile plus PIN. A wrong PIN opens nothing." },
        { k: "canSee", v: "Only accounts the rep owns, or is on the account team for." },
        { k: "writable-fields", v: "Activities, tasks, deal stage, amount, close date, next step, contact details." },
        { k: "isExplicitSave", v: "“Yes, save it” or “go ahead and save”. Never a bare yes, or a maybe." },
        { k: "COMMIT_UNDO_MS", v: "Six seconds to say “wait”. Then one commit, with an audit row per field." },
        { k: "POLICY_REFUSALS", v: "Credit limit, payment terms, discounts, ownership: refused, and a person offered." },
      ],
    },
    yours: {
      narration: [
        "Making it yours is mostly configuration: the fields a call may change, your reps, and who answers for Sales Operations.",
        "Your CRM plugs in behind one adapter. The spec, the tests and this demo script give your coding agent the rest.",
      ],
      files: [
        { path: "config/writable-fields.json", note: "The write allow-list and its limits" },
        { path: "config/reps.json", note: "Teams IDs, registered mobiles, PIN hashes" },
        { path: "config/routing.json", note: "The Sales Operations transfer target" },
        { path: "src/providers/dataverse-crm.mjs", note: "Where your CRM plugs in: a documented stub" },
        { path: "SPEC.md", note: "Caller experience and acceptance criteria" },
        { path: "code/public/beats.js", note: "This demo, step by step" },
      ],
      prompt: "Let reps update a contact's job title by phone, and send any deal amount over 1 million to Sales Operations.",
    },
    close: {
      narration: ["Customer record lookup and update. Run it in simulation in two minutes, then connect your own Teams number and CRM."],
      run: "cd code && npm install && npm start",
    },
  },
};
