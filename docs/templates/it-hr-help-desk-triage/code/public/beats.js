/**
 * The on-stage demo, beat by beat. The director in the presenter kit runs it:
 * Next ▶ (or →, PageDown, a clicker) runs one step, Auto-play runs the rest of
 * a beat, and 1–7 jump straight to a beat.
 *
 * Every beat pins the demo clock and answers its own call, so any beat can be
 * re-run on its own, in any order. The caller lines are the ones the offline
 * router (src/offline.mjs) handles the same way every time; with Voice Live
 * they are just as natural to say out loud.
 *
 * To adapt the demo, edit the lines and the narration here. The narration is
 * written for the room: `talk` while a beat runs, `cue` before a step, `after`
 * once the beat is done. Callers are the ids in the console's caller picker
 * (CALLERS in app.js), which mirror config/directory.json.
 */

const SAM = "sam"; // Sam Rivera, signed in to the Teams app
const MARIA = "maria"; // Maria Lopez, signed in to the Teams app
const SAM_MOBILE = "sam-mobile"; // Sam's mobile number, +1 425 555 0101: caller ID only

/** @param {{ setClock: (preset: string) => Promise<void> }} hooks */
export function createBeats({ setClock }) {
  const at = (preset) => () => setClock(preset);

  return [
    {
      title: "Teams: answer, then ticket",
      prepare: at("business-hours"),
      talk: "Sam calls the help line straight from Teams. Teams has already signed Sam in, so the agent knows who is calling without a single security question.",
      steps: [
        {
          type: "start",
          caller: SAM,
          label: "Sam Rivera calls from Teams",
          cue: "The greeting uses Sam's name because the identity came from Teams sign-in. It also mentions today's Outlook outage before anyone asks.",
        },
        {
          type: "say",
          text: "My VPN keeps disconnecting",
          cue: "A routine question. The answer comes from the approved IT article, not from the model's own words.",
        },
        {
          type: "say",
          text: "My laptop screen keeps flickering and I can't work",
          cue: "That needs a technician, so the agent drafts a ticket. The server sets the priority from the matrix — Sam can't work, so P2 — and attaches the laptop from the directory.",
        },
        {
          type: "say",
          text: "Yes, file it",
          cue: "Nothing is filed without a yes. Watch Sam's Teams chat on the right.",
        },
      ],
      after:
        "One call, two outcomes: an approved answer, then a P2 ticket with the right device attached. INC-004821 lands in Sam's Teams chat.",
    },
    {
      title: "Only your own tickets",
      prepare: at("business-hours"),
      talk: "Maria wants an update. The agent can read ticket status aloud, but only for tickets Maria is allowed to see.",
      steps: [
        { type: "start", caller: MARIA, label: "Maria Lopez calls from Teams" },
        {
          type: "say",
          text: "What's happening with INC-004610?",
          cue: "That's Sam's printer ticket, not Maria's. The server checks who it belongs to and won't read it out.",
        },
        {
          type: "say",
          text: "What about INC-004700?",
          cue: "INC-004700 is the company-wide Outlook incident, so anyone may hear its status.",
        },
        {
          type: "say",
          text: "Outlook won't open for me either",
          cue: "Instead of filing a duplicate, the server adds Maria to the open incident.",
        },
      ],
      after:
        "Who may hear what is a server rule, not a line in a prompt. And one outage means one incident, not a pile of duplicate tickets.",
    },
    {
      title: "Phone caller: prove it",
      prepare: at("business-hours"),
      talk: "Now Sam calls from a mobile phone instead of Teams. Caller ID is easy to fake, so a matching number is a hint, not proof.",
      steps: [
        {
          type: "start",
          caller: SAM_MOBILE,
          label: "Sam calls from a mobile phone",
          cue: "The number matches Sam's mobile in the directory, yet the greeting stays anonymous: “Hi there”.",
        },
        {
          type: "say",
          text: "What's happening with INC-004610?",
          cue: "Ticket status is personal, so the server asks the caller to prove who they are first.",
        },
        {
          type: "say",
          text: "sam.rivera@contoso.com",
          cue: "The server sends a one-time code to Sam's Teams chat. In this demo nothing is sent: the code appears in the mock chat on the right.",
        },
        {
          type: "say",
          text: "654321",
          cue: "A wrong code is refused. One more miss and the call goes to a person who can verify Sam another way.",
        },
        {
          type: "say",
          text: "123456",
          cue: "The right code. Now the agent finishes what Sam asked for in the first place.",
        },
      ],
      after:
        "The checklist shows every step of the identity gate. The code never reaches the audit log, and a console watching a real call never receives it.",
    },
    {
      title: "Sensitive HR stays private",
      prepare: at("business-hours"),
      talk: "Some calls need a person straight away, and as few details as possible. Watch what the agent doesn't do.",
      steps: [
        { type: "start", caller: SAM, label: "Sam Rivera calls from Teams" },
        {
          type: "say",
          text: "My manager keeps making comments about me and I don't know what to do",
          cue: "The sensitive-topic guard runs before anything else. No questions and no ticket, and the transcript keeps a placeholder instead of Sam's words.",
        },
      ],
      after:
        "The HR person's Teams client shows “Confidential HR” and nothing else: no summary, no transcript, no reason. After hours, the same guard offers a next-business-day callback instead.",
    },
    {
      title: "IT or HR? Ask once",
      prepare: at("business-hours"),
      talk: "Maria's problem could belong to IT or to HR. A wrong transfer wastes everyone's time, so the agent asks one question instead of guessing.",
      steps: [
        { type: "start", caller: MARIA, label: "Maria Lopez calls from Teams" },
        {
          type: "say",
          text: "I can't get into the payroll system and my pay is wrong",
          cue: "It matches two topics at 0.45, below the 0.70 gate, so the agent asks one short question.",
        },
        {
          type: "say",
          text: "It's my paycheck, the amount is wrong",
          cue: "Now it's clearly pay, so the call goes to Payroll with Maria's name and the topic.",
        },
      ],
      after:
        "One question, then the right queue. If the answer were still unclear, the call would go to a person rather than round in circles.",
    },
    {
      title: "Still stuck? A person",
      prepare: at("business-hours"),
      talk: "Self-service only goes so far. When the approved answer doesn't fix it, the caller gets a person without starting over.",
      steps: [
        { type: "start", caller: MARIA, label: "Maria Lopez calls from Teams" },
        {
          type: "say",
          text: "The printer on my floor keeps jamming",
          cue: "The approved printer guide answers first.",
        },
        {
          type: "say",
          text: "I already tried all that. Can I talk to someone?",
          cue: "Asking for a person goes straight to a person, no more questions. The IT service desk sees who is calling, the topic, and what was already tried.",
        },
      ],
      after:
        "Whoever picks up knows Maria already followed the printer guide, so the conversation starts where the agent left off.",
    },
    {
      title: "Phishing: P1 to on-call",
      prepare: at("business-hours"),
      talk: "Last one, and it's urgent. A security incident doesn't wait in a queue.",
      steps: [
        { type: "start", caller: SAM, label: "Sam Rivera calls from Teams" },
        {
          type: "say",
          text: "I think I clicked a phishing link",
          cue: "Security incidents are priority 1 by rule. The matrix decides, not the model.",
        },
        {
          type: "say",
          text: "Yes",
          cue: "The ticket is filed, Sam gets it in Teams chat, and the call goes straight to IT on-call with the ticket number.",
        },
        {
          type: "action",
          action: "metrics",
          label: "Show the numbers",
          cue: "Every call is audited: answers, tickets, duplicates avoided, codes accepted and refused, private HR calls, and handoffs.",
        },
      ],
      after:
        "The same numbers come from the same audit log in production. Private HR calls show as “<5” until there are enough that nobody can be singled out.",
    },
  ];
}
