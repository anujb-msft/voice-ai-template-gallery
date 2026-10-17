/**
 * The on-stage demo, beat by beat. The director in the presenter kit runs it:
 * Next ▶ (or →, PageDown, a clicker) runs one step, Auto-play runs the rest of
 * a beat, and 1–5 jump straight to a beat.
 *
 * Every beat pins the demo clock to Tuesday 9:50 AM and answers its own call,
 * so any beat can be re-run on its own and in any order. Beat 1 also resets
 * the demo first (the seeded schedule, the metrics and the clock), so a run
 * from the top offers the same times and ends on the same numbers every time.
 * Run out of order, the times offered shift as earlier beats fill the
 * schedule, but every beat still ends the same way.
 *
 * The caller lines are the ones src/offline.mjs (SCRIPTS) handles the same
 * way every time, and test/beats.test.mjs holds them to it; with Voice Live
 * they are just as natural to say out loud.
 *
 * Two steps are demo actions rather than caller lines:
 *   take-slot   the front desk books the time this caller is about to accept
 *               (POST /api/demo/take-slot), so the race can be shown on cue;
 *   model-book  the model reaches for a "book" tool it does not have
 *               (POST /api/demo/tool), through the same dispatcher a live
 *               call uses.
 *
 * To adapt the demo, edit the lines and the narration here. The narration is
 * written for the room: `talk` while a beat runs, `cue` before a step, `after`
 * once the beat is done.
 */

const JORDAN = "+12065550142"; // Jordan Rivera, Dr. Patel's patient
const MIA = "+12065550102"; // Mia Chen
const AVERY = "+12065550101"; // Avery Stone

/**
 * @param {{
 *   setClock: (preset: string) => Promise<void>,
 *   resetDemo: () => Promise<void>,
 * }} hooks
 */
export function createBeats({ setClock, resetDemo }) {
  const at = (preset) => () => setClock(preset);
  const fromTheTop = async () => {
    await resetDemo();
    await setClock("tue-morning");
  };

  return [
    {
      title: "Booked in one call",
      prepare: fromTheTop,
      talk: "Tuesday morning at Contoso Health. Jordan says what's wrong in plain words; the agent finds a time that fits, and the server checks four things before anything is written.",
      steps: [
        {
          type: "start",
          fromPhone: JORDAN,
          label: "Jordan Rivera calls the scheduling line",
          cue: "Caller ID matches a patient, but that isn't proof. The agent asks for a name and date of birth and greets no one by name.",
        },
        {
          type: "say",
          text: "Jordan Rivera, 03/12/1984",
          cue: "Identity goes green in the checklist. The date of birth stays out of the transcript.",
        },
        {
          type: "say",
          text: "I've had a cough for a week and I'd like to see my usual doctor, mornings if possible.",
          cue: "A sick visit with Dr. Patel, mornings. The server searches and offers two times, not ten. Nothing is held yet.",
        },
        {
          type: "say",
          text: "The first one.",
          cue: "Now one time is held for five minutes and read back. That's the active proposal, P1. Watch its cell in the grid. Still nothing is booked.",
        },
        {
          type: "say",
          text: "Yes, please.",
          cue: "Jordan's own yes to the active proposal: the only thing that writes.",
        },
      ],
      after:
        "All four checks are green, the cell turns solid in the grid and the booking card shows the confirmation number. The model never called a booking tool. It doesn't have one.",
    },
    {
      title: "“Just book whatever”",
      prepare: at("tue-morning"),
      talk: "Mia is in a hurry. The model would happily oblige. The server won't.",
      steps: [
        { type: "start", fromPhone: MIA, label: "Mia Chen calls" },
        { type: "say", text: "Mia Chen, 02/18/1991", cue: "Verified." },
        {
          type: "say",
          text: "Just book me whatever you have.",
          cue: "No time has been read back, so there's nothing to say yes to. The write is refused and the agent asks what kind of visit she needs.",
        },
        { type: "say", text: "A follow-up with Dr. Patel.", cue: "Two times offered." },
        {
          type: "action",
          action: "model-book",
          label: "The model calls “book” anyway",
          cue: "Now the model itself reaches for a booking tool. There isn't one, so the server refuses it. Watch the booking decision and the trail.",
        },
        { type: "say", text: "The second one.", cue: "A specific time, held and read back." },
        { type: "say", text: "Yes.", cue: "Her yes to that proposal is what writes it." },
      ],
      after:
        "Two refused writes on the trail, and nothing booked until Mia said yes to a time she'd heard. The model can suggest; the server books, and only on the caller's yes.",
    },
    {
      title: "Taken mid-call",
      prepare: at("tue-morning"),
      talk: "Two people want the same time. Avery is on the phone; the front desk is at a keyboard.",
      steps: [
        { type: "start", fromPhone: AVERY, label: "Avery Stone calls" },
        { type: "say", text: "Avery Stone, 06/09/1979" },
        { type: "say", text: "A follow-up with Dr. Patel, please." },
        { type: "say", text: "The first one.", cue: "P1 is held and read back. Avery is about to say yes." },
        {
          type: "action",
          action: "take-slot",
          label: "The front desk books that time",
          cue: "Meanwhile the front desk books the same time. The cell in the grid changes hands. Avery hasn't been told.",
        },
        {
          type: "say",
          text: "Yes, book it.",
          cue: "Avery says yes, but the time is gone. The server refuses the write, voids P1 and offers fresh times. It never moves a yes to a different time.",
        },
        {
          type: "say",
          text: "The first one.",
          cue: "A fresh pick is a new proposal, P2. The earlier yes doesn't count for it.",
        },
        { type: "say", text: "Yes.", cue: "A fresh yes to P2. Now it's written." },
      ],
      after:
        "The trail shows the refused write and the fresh proposal; the booking card notes it was booked after a race. No double booking, and no silent swap.",
    },
    {
      title: "Needs a referral",
      prepare: at("tue-morning"),
      talk: "Some visits can't be booked by voice. That's a rule in config, not the model's judgment.",
      steps: [
        { type: "start", fromPhone: JORDAN, label: "Jordan calls back" },
        { type: "say", text: "Jordan Rivera, 03/12/1984" },
        {
          type: "say",
          text: "I'd like a skin check for a mole.",
          cue: "Dermatology needs a referral on file and there isn't one. Eligibility goes red, and the server offers no times.",
        },
        {
          type: "say",
          text: "Connect me with the referral coordinator.",
          cue: "A handoff to a person. Watch the Teams panel.",
        },
      ],
      after:
        "The referral coordinator's Teams client rings with the topic and what's already checked: verified, a skin check, the rule that blocked it. The same context rides in the VoIP headers underneath.",
    },
    {
      title: "Identity fails",
      prepare: at("tue-morning"),
      talk: "Jordan's number again, but the date of birth doesn't match. Caller ID isn't identity.",
      steps: [
        { type: "start", fromPhone: JORDAN, label: "Someone calls from Jordan's number" },
        {
          type: "say",
          text: "Jordan Rivera, 03/21/1984",
          cue: "No match. One more try, and nothing about appointments is said either way.",
        },
        {
          type: "say",
          text: "Jordan Rivera, 12/03/1984",
          cue: "A second miss. The agent stops asking and hands the call to the scheduling team.",
        },
        {
          type: "action",
          action: "metrics",
          label: "Show the numbers",
          cue: "Every call is audited: booked, writes refused, races resolved and handoffs to a person.",
        },
      ],
      after:
        "The toast reads “not verified” and carries no patient details. The numbers come from the same audit log a real call writes to.",
    },
  ];
}
