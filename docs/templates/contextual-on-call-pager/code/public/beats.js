/**
 * The on-stage demo, beat by beat. The director in the presenter kit runs it:
 * Next ▶ (or →, PageDown, a clicker) runs one step, Auto-play runs the rest of
 * a beat, and 1–5 jump straight to a beat.
 *
 * Every beat pins the demo clock and answers its own call, so any beat can be
 * re-run on its own, in any order. The rotation, the escalation timers and the
 * "is it worth waking someone" rule all read that clock. The tenant and
 * technician lines are ones the offline stand-in (src/offline.mjs) handles the
 * same way every time; with Voice Live they are just as natural to say aloud.
 *
 * To adapt the demo, edit the lines and the narration here. The narration is
 * written for the room: `talk` while a beat runs, `cue` before a step, `after`
 * once the beat is done. Typed lines go to whoever is on the line: the tenant
 * during intake, the technician once a page is ringing.
 */

const ALICE = "+12065550101"; // Alice Rivera, Maple Court 4B
const BEN = "+12065550102"; // Ben Carter, Maple Court 2A
const DEE = "+12065550103"; // Dee Nguyen, Pine Terrace 11
const GRACE = "+12065550104"; // Grace Kim, Pine Terrace 7

/** @param {{ setClock: (preset: string) => Promise<void> }} hooks */
export function createBeats({ setClock }) {
  const at = (preset) => () => setClock(preset);

  return [
    {
      title: "Leak at midnight",
      prepare: at("weeknight"),
      talk: "Wednesday, 11:42 at night. Water is coming through Alice's ceiling. One call should be enough: the agent takes the facts, and the right technician hears them.",
      steps: [
        {
          type: "start",
          fromPhone: ALICE,
          label: "Alice Rivera calls the after-hours line",
          cue: "Caller ID matches her lease, so the agent knows her building. Who's on call comes from the rotation and the clock, not from a spreadsheet.",
        },
        {
          type: "say",
          text: "Water is pouring through my kitchen ceiling and it's spreading fast.",
          cue: "The agent captures what, where and impact as fields. The server's triage rules classify it: an active leak is urgent.",
        },
        {
          type: "say",
          text: "Yes, 4B. You can go in — the spare key is in the lockbox by the back door.",
          cue: "Unit confirmed, permission to enter, where the key is. The agent reads back only the last four digits of the callback number.",
        },
        {
          type: "say",
          text: "Yes, that's my cell.",
          cue: "That's everything the page needs. Watch what the technician sees.",
        },
        {
          type: "say",
          text: "Morgan Lee here.",
          label: "Morgan picks up: “Morgan Lee here.”",
          cue: "Morgan hears a short brief. The server writes it from the captured fields — the model doesn't.",
        },
        {
          type: "say",
          text: "I've got it — on my way.",
          label: "Morgan: “I've got it — on my way.”",
          cue: "Morgan accepts. The retries and the ops alert are canceled, and the agent calls Alice back.",
        },
      ],
      after:
        "Morgan never had to call Alice to ask what's wrong: the context traveled with the page. The VoIP headers show the same facts as Teams Phone custom calling context.",
    },
    {
      title: "Nobody answers",
      prepare: at("weeknight"),
      talk: "Same night, Pine Terrace. Dee's heat is out. Is that worth waking someone? The server decides from a number, and then it keeps paging until someone answers.",
      steps: [
        {
          type: "start",
          fromPhone: DEE,
          label: "Dee Nguyen calls from Pine Terrace",
          cue: "Pine Terrace is on the north rotation, so this page goes to Omar, not Morgan.",
        },
        {
          type: "say",
          text: "The heat is out in unit 11 at Pine Terrace and it's 52 degrees in here. You can let yourself in.",
          cue: "52°F inside is at or below the 55°F no-heat line, so it's urgent. The gauge shows the line.",
        },
        { type: "say", text: "Yes.", cue: "Callback confirmed. Omar's phone rings." },
        {
          type: "silence",
          label: "Omar doesn't pick up",
          cue: "No answer. The policy schedules attempt 2 of 2 in 3 minutes, the urgent gap. The countdown is the server's timer.",
        },
        {
          type: "action",
          action: "advance",
          minutes: 3,
          label: "Skip ahead 3 minutes on the demo clock",
          cue: "Nobody waits three minutes on stage. The demo clock jumps, and the server's scheduler sends the retry.",
        },
        {
          type: "silence",
          label: "Omar still doesn't pick up",
          cue: "Two misses at the primary level. The policy escalates to the secondary, Priya, and says why.",
        },
        {
          type: "action",
          action: "advance",
          minutes: 3,
          label: "Skip ahead another 3 minutes",
          cue: "Priya's phone rings with the same brief, flagged as an escalation.",
        },
        { type: "say", text: "Priya Shah here.", label: "Priya picks up: “Priya Shah here.”" },
        {
          type: "say",
          text: "I've got it.",
          label: "Priya: “I've got it.”",
          cue: "Acknowledged six minutes after the report, and the 20-minute ops alert is canceled.",
        },
      ],
      after: "Two tries, then the secondary. The gaps and the levels are policy in config, not prompt text — and every page carried the same context.",
    },
    {
      title: "Voicemail keeps it private",
      prepare: at("swap-night"),
      talk: "Thursday night. Priya swapped shifts with Morgan, so she covers the central buildings. The on-call panel shows the override and why.",
      steps: [
        {
          type: "start",
          fromPhone: BEN,
          label: "Ben Carter calls from Maple Court",
        },
        {
          type: "say",
          text: "I'm locked out of my apartment and my keys are inside.",
          cue: "A lockout is urgent under the triage rules.",
        },
        {
          type: "say",
          text: "Yes, 2A. I'm waiting in the lobby by the front door.",
          cue: "Unit confirmed, and where to find him. No permission to enter: he's outside.",
        },
        {
          type: "say",
          text: "Yes.",
          cue: "The page goes to Priya: the swap override, not the regular rotation.",
        },
        {
          type: "action",
          action: "voicemail",
          label: "Priya's phone goes to voicemail",
          cue: "Anyone near a phone can hear its voicemail. So the agent leaves a callback prompt and a reference number, and nothing else.",
        },
      ],
      after:
        "What voicemail heard is under the toast, and what it left out: the building, the unit, the problem, Ben's words, the access details. The retry still goes out in 3 minutes.",
    },
    {
      title: "Not worth waking anyone",
      prepare: at("weekend"),
      talk: "Saturday night. The heat in Grace's bedroom is out, but it's 64 degrees inside. Should someone get out of bed?",
      steps: [
        {
          type: "start",
          fromPhone: GRACE,
          label: "Grace Kim calls from Pine Terrace",
        },
        {
          type: "say",
          text: "The heat is out in my bedroom, but it's about 64 degrees inside.",
          cue: "64°F is above the 55°F no-heat line. The gauge puts it on the routine side.",
        },
        {
          type: "say",
          text: "Yes, unit 7. You can go in, I'm home all weekend.",
          cue: "The agent still takes everything down, so the work order is complete.",
        },
        {
          type: "say",
          text: "Yes.",
          cue: "Routine: a work order for Monday morning instead of a page. The agent tells Grace what happens next.",
        },
      ],
      after: "Nobody's phone rang. The work order has the same context, and Grace knows to call back if it drops to 55°F.",
    },
    {
      title: "Questions, not phone numbers",
      prepare: at("weeknight"),
      talk: "Back to Wednesday night. Ben's power is out, and this time the technician has a question for him.",
      steps: [
        {
          type: "start",
          fromPhone: BEN,
          label: "Ben Carter calls from Maple Court",
        },
        {
          type: "say",
          text: "No power in unit 2A at Maple Court since the storm. You can go in, and please call me back on this number.",
          cue: "What, where, access and callback in one sentence. The agent doesn't ask again for what it already has, and pages Morgan.",
        },
        { type: "say", text: "Morgan here.", label: "Morgan picks up: “Morgan here.”" },
        {
          type: "say",
          text: "What's the tenant's phone number?",
          label: "Morgan asks: “What's the tenant's phone number?”",
          cue: "Phone numbers stay on the server. The agent offers to connect them instead.",
        },
        {
          type: "dtmf",
          digit: "3",
          label: "Morgan presses 3 to talk to Ben",
          cue: "The agent bridges Morgan to Ben. Neither one sees the other's number.",
        },
        {
          type: "action",
          action: "metrics",
          label: "Show the numbers",
          cue: "Every page is audited: pages, acknowledgements, escalations, voicemails, work orders, and the median time to acknowledge.",
        },
      ],
      after: "The same numbers come from the same audit log in production.",
    },
  ];
}
