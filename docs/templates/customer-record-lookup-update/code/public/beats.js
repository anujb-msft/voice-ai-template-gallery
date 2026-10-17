/**
 * The on-stage demo, beat by beat. The director in the presenter kit runs it:
 * Next ▶ (or →, PageDown, a clicker) runs one step, Auto-play runs the rest of
 * a beat, and 1–5 jump straight to a beat.
 *
 * Every beat pins the demo clock, puts the seeded Fabrikam record back and
 * answers its own call, so any beat can be re-run on its own, in any order, at
 * any time of day. The metrics keep counting until Reset demo. The caller
 * lines are ones the offline stand-in (src/offline.mjs) handles the same way
 * every time; with Voice Live they are just as natural to say out loud.
 *
 * To adapt the demo, edit the lines and the narration here. The narration is
 * written for the room: `talk` while a beat runs, `cue` before a step, `after`
 * once the beat is done.
 */

// Fictional demo PINs. config/reps.json stores only a hash of Alex Morgan's.
export const DEMO_PIN = "246810";
export const WRONG_PIN = "135790";

const DEBRIEF =
  "Log the Fabrikam meeting. Dana agreed to the renewal at 240k, moving to Closed Won pending signature, close date June 15th. Remind me to send the contract Friday.";
const NEW_MOBILE = "Update Fabrikam: Dana has a new mobile, 425 555 0143.";
const CREDIT_TERMS = "Raise Fabrikam's credit limit to 500k and move them to net 60 payment terms.";

/**
 * @param {{
 *   setClock: (preset: string) => Promise<void>,
 *   restoreRecords: () => Promise<void>,
 * }} hooks
 */
export function createBeats({ setClock, restoreRecords }) {
  const fresh = async () => {
    await setClock("demo-day");
    await restoreRecords();
  };

  return [
    {
      title: "Verified before anything is read",
      prepare: fresh,
      talk: "Alex Morgan is a Contoso sales rep, calling about his Fabrikam account from the road. Before the agent reads out a single field, it has to know who is calling.",
      steps: [
        {
          type: "start",
          caller: "alex-mobile",
          label: "Alex Morgan calls from his registered mobile",
          cue: "The number matches Alex's registered mobile. Caller ID is a hint, not proof, so the agent asks for a PIN before it opens any record.",
        },
        {
          type: "dtmf",
          digit: DEMO_PIN,
          label: "Alex keys in his PIN",
          cue: "The server checks the PIN against a stored hash. Watch the checklist.",
        },
        {
          type: "say",
          text: "Brief me on Fabrikam",
          cue: "Verified. The record opens only for accounts on Alex's list, and the card shows only what he may hear: no phone numbers yet, and never the credit terms.",
        },
        {
          type: "say",
          text: "What's Dana's number?",
          cue: "Contact details are read out only when asked for. From now on the card shows the number too.",
        },
      ],
      after:
        "Every check, lookup and disclosure is in the audit trail. The credit limit and payment terms stay with Sales Operations.",
    },
    {
      title: "Read back, a yes, then the undo window",
      prepare: fresh,
      talk: "Straight after the meeting, Alex dictates the update the way he'd tell a colleague. Nothing is written on the model's say-so.",
      steps: [
        {
          type: "start",
          caller: "alex-teams",
          label: "Alex calls from Teams",
          cue: "Signed in to Teams, so no PIN this time.",
        },
        {
          type: "say",
          text: DEBRIEF,
          cue: "The model turns the debrief into a proposed update. The server checks every field against the phone allow-list, and the agent reads all of it back.",
        },
        {
          type: "say",
          text: "Yes, save it.",
          cue: "An explicit yes. Even now the write waits: the undo window opens on the server, and the bar counts it down.",
        },
        {
          type: "action",
          action: "window",
          label: "Let the undo window run out",
          cue: "Nobody objects, so the write commits when the window closes, with an audit entry.",
        },
      ],
      after:
        "The write-back card shows each field before and after, with the audit ID. “Undo that” would still reverse it on this call.",
    },
    {
      title: "“Wait — keep the old number”",
      prepare: fresh,
      talk: "People change their minds mid-sentence. The undo window is there for exactly that.",
      steps: [
        { type: "start", caller: "alex-teams", label: "Alex calls from Teams again" },
        {
          type: "say",
          text: NEW_MOBILE,
          cue: "One field this time: Dana's mobile. The agent reads the new number back in full and names the one it replaces.",
        },
        {
          type: "say",
          text: "Yes, save it.",
          cue: "Confirmed, and the undo window opens. Alex is about to change his mind.",
        },
        { type: "wait", ms: 2500, chain: true },
        { type: "say", text: "Wait, no — keep the old number.", chain: true },
      ],
      after:
        "Stopped inside the window: nothing was written and the record keeps the old number. The trail shows the yes and the stop.",
    },
    {
      title: "Not mine to change",
      prepare: fresh,
      talk: "Some fields are never changed over the phone. The allow-list is server code, not a line in a prompt.",
      steps: [
        { type: "start", caller: "alex-teams", label: "Alex calls from Teams" },
        {
          type: "say",
          text: CREDIT_TERMS,
          cue: "The model would happily propose it. The server refuses both fields because they aren't on the phone allow-list, so nothing is written.",
        },
        {
          type: "say",
          text: "Yes, put me through.",
          cue: "The agent offers Sales Operations, who can make the change. Watch the Teams panel.",
        },
      ],
      after:
        "Sales Operations' Teams client rings with the account, the request and the refusal, so nobody has to ask Alex again. The same context travels in the VoIP headers.",
    },
    {
      title: "Can't verify, won't disclose",
      prepare: fresh,
      talk: "Last one: someone has Alex's phone, but not his PIN.",
      steps: [
        { type: "start", caller: "alex-mobile", label: "A call from Alex's registered mobile" },
        {
          type: "dtmf",
          digit: WRONG_PIN,
          label: "A wrong PIN",
          cue: "Wrong PIN: no record is opened and nothing is read out. The call goes to a person with only what is safe to share.",
        },
        {
          type: "action",
          action: "metrics",
          label: "Show the numbers",
          cue: "Every lookup, write, undo, refusal and handoff is audited, and these numbers come straight from that audit log.",
        },
      ],
      after:
        "Lookups, confirmed writes, undone writes, refusals and handoffs, all from the same audit log a real deployment keeps.",
    },
  ];
}
