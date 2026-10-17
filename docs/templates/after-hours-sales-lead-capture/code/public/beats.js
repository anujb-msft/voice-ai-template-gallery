/**
 * The on-stage demo, beat by beat. The director in the presenter kit runs it:
 * Next ▶ (or →, PageDown, a clicker) runs one step, Auto-play runs the rest of
 * a beat, and 1–6 jump straight to a beat.
 *
 * Every beat pins the demo clock, forgets its caller's earlier lead, lines up
 * the rep the lead goes to and answers its own call, so any beat can be re-run
 * on its own, in any order, and lands the same way. The clock is the story:
 * sales is open 8 AM to 6 PM on weekdays, and the on-call rep covers until
 * 9 PM. The caller lines are ones the offline stand-in agent (src/offline.mjs)
 * handles the same way every time; with Voice Live they are just as natural to
 * say out loud. test/demo.test.mjs runs the same lines and checks every outcome.
 *
 * To adapt the demo, edit the lines and the narration here, then the matching
 * lines in test/demo.test.mjs and DEMO-SCRIPT.md. The narration is written for
 * the room: `talk` while a beat runs, `cue` before a step, `after` once the
 * beat is done.
 */

const DANA = "+14255550193"; // Dana Morgan, Northwind Traders
const PAT = "+14255550175"; // Pat Kim
const CASEY = "+14255550128"; // Casey Quinn, Fabrikam (the front desk line)
const CASEY_MOBILE = "+14255550147"; // the number Casey corrects it to
const LEE = "+14255550111"; // Lee Park, an existing customer
const SAM = "+14255550162"; // Sam Rivera, Tailwind Traders
const ROBIN = "+14255550184"; // Robin Diaz, Wide World Importers

/**
 * @param {{
 *   setClock: (preset: string) => Promise<void>,
 *   restore: (caller: { phones: string[], nextRep?: string }) => Promise<void>,
 * }} hooks
 */
export function createBeats({ setClock, restore }) {
  // A beat that saves a lead starts from scratch: no earlier lead from its
  // caller to merge into, and the rotation on the rep the script names.
  const at = (preset, caller) => async () => {
    await setClock(preset);
    if (caller) await restore(caller);
  };

  return [
    {
      title: "After hours: capture",
      prepare: at("after-hours", { phones: [DANA], nextRep: "ava" }),
      talk: "7:30 on a Wednesday evening, and the sales team has gone home. Without this, a buyer with a big order gets voicemail, and maybe calls a competitor next.",
      steps: [
        { type: "start", fromPhone: DANA, label: "Dana Morgan calls from Northwind Traders" },
        {
          type: "say",
          text: "Hi, this is Dana Morgan from Northwind Traders. We need about 12,000 hex bolts by the end of the month.",
          cue: "The server checked the sales hours, not the model: sales is closed, so the assistant answered and said up front that it's automated. Now watch the lead panel. One sentence fills in most of the lead, and each answer is scored in plain English.",
        },
        {
          type: "say",
          text: "Yes, I'm the purchasing manager, so it's my call.",
          cue: "A decision maker makes it 8 of 8. Before anything is saved, the agent reads back the callback number.",
        },
        {
          type: "say",
          text: "Yes, that's the best number.",
          cue: "Confirmed, so the server saves the lead, assigns an owner and sets the callback deadline.",
        },
      ],
      after:
        "A hot lead with an owner and a callback due within an hour of opening. The Teams panel shows the follow-up message, with the sales manager @-mentioned. Nobody was paged: hot isn't the same as urgent.",
    },
    {
      title: "Business hours: straight to sales",
      prepare: at("business-hours"),
      talk: "Same server, 10:30 on the same Wednesday morning: only the clock changed. Sales is open, so the server sends the caller straight to the sales queue, and the assistant stays out of the way.",
      steps: [{ type: "start", fromPhone: PAT, label: "Pat Kim calls during sales hours" }],
      after:
        "No questions and no capture: a person answers. The Teams toast says it's an in-hours sales call, with the caller ID flagged as not verified, and the VoIP headers carry that context.",
    },
    {
      title: "Read back, corrected",
      prepare: at("after-hours", { phones: [CASEY, CASEY_MOBILE], nextRep: "ben" }),
      talk: "Back to the evening. A lead is only worth something if you can call it back, so the agent reads the number back before it saves anything.",
      steps: [
        { type: "start", fromPhone: CASEY, label: "Casey Quinn calls from Fabrikam's front desk" },
        {
          type: "say",
          text: "Hi, this is Casey Quinn with Fabrikam. We're looking at about 200 brass fittings next quarter.",
          cue: "200 is below the 250 minimum order for fittings. The agent doesn't argue, and the score shows why: no points for quantity.",
        },
        {
          type: "say",
          text: "Not me, I'm the maintenance engineer. I recommend what we buy.",
          cue: "An influencer, not the decision maker. Now the read-back, and the caller ID is Fabrikam's front desk.",
        },
        {
          type: "say",
          text: "No, that's the front desk. Please use my mobile, 425-555-0147.",
          cue: "Casey corrects it. The new number gets read back too: the server won't save a callback number nobody has confirmed.",
        },
        { type: "say", text: "Yes, that's right.", cue: "Only now is the lead saved, with the corrected number." },
      ],
      after:
        "A warm lead, 4 of 8, with a callback by the next business day. The mobile number is the one saved, and the trail shows the correction.",
    },
    {
      title: "Not a sales call",
      prepare: at("after-hours"),
      talk: "Not every after-hours call is a lead, and counting them as leads would bury the real ones.",
      steps: [
        { type: "start", fromPhone: LEE, label: "Lee Park calls about an order" },
        {
          type: "say",
          text: "Hi, I'm calling about an existing order. It was supposed to arrive today and it hasn't.",
          cue: "An existing order is a support call. The agent says so politely and gives the support number and hours.",
        },
      ],
      after: "No lead was created, so the sales pipeline stays clean. The call still counts, as not a sales call.",
    },
    {
      title: "Hot and urgent: page on call",
      prepare: at("after-hours", { phones: [SAM] }),
      talk: "Some calls can't wait for the morning. Ben Ortiz is on call until 9 PM, and the policy decides when he's worth interrupting.",
      steps: [
        { type: "start", fromPhone: SAM, label: "Sam Rivera calls from Tailwind Traders" },
        {
          type: "say",
          text: "This is Sam Rivera, operations director at Tailwind Traders. Our packaging line is down and we need 2,000 cartons by tomorrow morning. Can I talk to someone tonight?",
          cue: "Hot, urgent, and asking for a person. The agent doesn't promise anyone yet: it notes the request and confirms the number first.",
        },
        {
          type: "say",
          text: "Yes, that's my cell.",
          cue: "Once the number is confirmed, the lead is saved. Hot and urgent, inside on-call hours: the server pages Ben in Teams while Sam stays on the line.",
        },
        {
          type: "action",
          action: "awaitHandoff",
          label: "Ben picks up in Teams",
          cue: "Ben sees who's calling, what they need and why he was paged before he says hello.",
        },
      ],
      after:
        "Ben has the lead, the urgency and the reason he was paged before he answers. The same reason is on the lead record for the morning.",
    },
    {
      title: "After cover ends: morning queue",
      prepare: at("late-night", { phones: [ROBIN], nextRep: "dana" }),
      talk: "The same kind of call at 10:30 at night. On-call cover ended at 9.",
      steps: [
        { type: "start", fromPhone: ROBIN, label: "Robin Diaz calls from Wide World Importers" },
        {
          type: "say",
          text: "Hi, this is Robin Diaz, maintenance supervisor at Wide World Importers. Our conveyor line is down and we need 6,000 lock nuts first thing tomorrow. Is anyone there tonight?",
          cue: "Urgent, and asking for a person, but nobody is on call. The agent won't promise a person it can't deliver.",
        },
        {
          type: "say",
          text: "Yes, that's the right number.",
          cue: "Hot, but not paged, and the reason is on screen and on the lead.",
        },
        {
          type: "action",
          action: "metrics",
          label: "Show the numbers",
          cue: "Every call is counted: leads captured, qualified and routed for follow-up, live transfers, pages, and the calls that weren't sales at all.",
        },
      ],
      after:
        "Robin hears honestly that no one is on call, and the lead is in the morning queue, due within an hour of opening, with the reason attached. The numbers come from the lead store, just as they would in production.",
    },
  ];
}
