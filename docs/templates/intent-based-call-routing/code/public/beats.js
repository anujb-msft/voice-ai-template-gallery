/**
 * The on-stage demo, beat by beat. The director in the presenter kit runs it:
 * Next ▶ (or →, PageDown, a clicker) runs one step, Auto-play runs the rest of
 * a beat, and 1–7 jump straight to a beat.
 *
 * Every beat pins the demo clock and answers its own call, so any beat can be
 * re-run on its own, in any order, at any time of day. The caller lines are
 * the ones the offline classifier (src/offline.mjs) routes the same way every
 * time; with Voice Live they are just as natural to say out loud.
 *
 * To adapt the demo, edit the lines and the narration here. The narration is
 * written for the room: `talk` while a beat runs, `cue` before a step, `after`
 * once the beat is done.
 */

const DANA = "+14255550101"; // Dana Whitfield, Northwind Traders
const MARCUS = "+14255550102"; // Marcus Bell, Fabrikam
const PRIYA = "+14255550103"; // Priya Raman, Tailwind Logistics

/** @param {{ setClock: (preset: string) => Promise<void> }} hooks */
export function createBeats({ setClock }) {
  const at = (preset) => () => setClock(preset);

  return [
    {
      title: "One question, no menu",
      prepare: at("business-hours"),
      talk: "No “press 1 for sales”. Dana says what she needs in her own words, and the agent works out where she should go.",
      steps: [
        {
          type: "start",
          fromPhone: DANA,
          label: "Dana Whitfield calls from Northwind Traders",
          cue: "Her caller ID matches the directory, so the greeting is personal. That's a convenience, not proof of identity.",
        },
        {
          type: "say",
          text: "I was charged twice on my invoice",
          cue: "The model proposes Billing with a confidence score. The server, not the model, checks it against the gate.",
        },
        {
          type: "say",
          text: "yes please",
          cue: "Even above the gate, the agent confirms before it transfers. Watch the Teams panel.",
        },
      ],
      after:
        "Billing's Teams client rings with what the call is about and who is calling, flagged as unverified. That context travels in the VoIP headers underneath.",
    },
    {
      title: "Not sure? Ask",
      prepare: at("business-hours"),
      talk: "Some requests really are ambiguous. A renewal charge: is that Sales or Billing?",
      steps: [
        { type: "start", fromPhone: PRIYA, label: "Priya Raman calls from Tailwind Logistics" },
        {
          type: "say",
          text: "I was charged for a renewal I did not order",
          cue: "Sales scores 0.6, below the 0.75 gate. Instead of guessing, the agent asks one question.",
        },
        {
          type: "say",
          text: "the charge on my card is wrong",
          cue: "One more sentence, and Billing clears the gate.",
        },
        { type: "say", text: "yes" },
      ],
      after:
        "A wrong transfer costs far more than one clarifying question. The gate is a number in config, not a line in a prompt.",
    },
    {
      title: "“A person, please”",
      prepare: at("business-hours"),
      talk: "The quickest way to lose a caller is to make them argue with a bot.",
      steps: [
        { type: "start", fromPhone: null, label: "An unknown number calls" },
        {
          type: "say",
          text: "can I just talk to a person",
          cue: "Asking for a person skips classification and confirmation entirely.",
        },
      ],
      after: "Straight to Reception: no gate and no “are you sure?”. It shows up in the “Asked for a person” metric.",
    },
    {
      title: "Changed their mind",
      prepare: at("business-hours"),
      talk: "Callers change their minds. The transfer waits a moment before it dispatches, so they can.",
      steps: [
        { type: "start", fromPhone: MARCUS, label: "Marcus Bell calls from Fabrikam" },
        { type: "say", text: "I have a question about my invoice", cue: "Billing clears the gate." },
        {
          type: "say",
          text: "yes please",
          cue: "Watch the bar under the gauge: the transfer waits about a second before it dispatches, and Marcus is about to change his mind.",
        },
        { type: "wait", ms: 600, chain: true },
        { type: "say", text: "no wait, the portal is down", chain: true },
        {
          type: "say",
          text: "yes",
          cue: "The pending transfer to Billing was cancelled before it left, and Support was offered instead.",
        },
      ],
      after: "Cancelled inside the window, re-proposed, re-confirmed. The trail shows billing → support.",
    },
    {
      title: "After hours: a message",
      prepare: at("after-hours"),
      talk: "Same server, 7:30 in the evening. Billing keeps office hours.",
      steps: [
        { type: "start", fromPhone: DANA, label: "Dana calls back after hours" },
        { type: "say", text: "I have a question about my invoice", cue: "Billing is still the right team." },
        {
          type: "say",
          text: "yes",
          cue: "But it's closed. The server checks the hours, not the model, and Billing's after-hours rule is to take a message.",
        },
        {
          type: "say",
          text: "please call me back about the duplicate charge",
          cue: "The message is recorded with a topic for the team. No callback time is promised.",
        },
      ],
      after: "No transfer into an empty queue. The message is in the audit log for Billing in the morning.",
    },
    {
      title: "After hours: diverted",
      prepare: at("after-hours"),
      talk: "Sales has a different after-hours rule: send the caller to Reception.",
      steps: [
        { type: "start", fromPhone: MARCUS, label: "Marcus calls after hours" },
        { type: "say", text: "I'd like a quote for an upgrade", cue: "Sales clears the gate…" },
        {
          type: "say",
          text: "yes",
          cue: "…but Sales is closed, so the server diverts to Reception and the agent tells Marcus why.",
        },
      ],
      after: "The Teams toast carries an AfterHours header, so Reception knows this call was meant for Sales.",
    },
    {
      title: "Silence → keypad",
      prepare: at("business-hours"),
      talk: "Speech doesn't always work: a bad line, a noisy room. The keypad is always there as a fallback.",
      steps: [
        { type: "start", fromPhone: null, label: "An unknown number calls" },
        { type: "silence", cue: "Nothing heard, so the agent asks one clarifying question." },
        { type: "silence", cue: "Still nothing. This time the agent offers the keypad." },
        {
          type: "dtmf",
          digit: "2",
          cue: "A keypress is unambiguous, so it routes without a spoken confirmation.",
        },
        {
          type: "action",
          action: "metrics",
          label: "Show the numbers",
          cue: "Every call is audited: transfers, clarifying questions, people requested, and median seconds to route.",
        },
      ],
      after: "The same numbers come from the same audit log in production.",
    },
  ];
}
