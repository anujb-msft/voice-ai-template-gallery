/**
 * The on-stage demo, beat by beat. The director in the presenter kit runs it:
 * Next ▶ (or →, PageDown, a clicker) runs one step, Auto-play runs the rest of
 * a beat, and 1–6 jump straight to a beat.
 *
 * Every beat pins the demo clock and answers its own call, so any beat can be
 * re-run on its own, in any order, at any time of day. Freshness is judged on
 * the same clock, so the article that is "due for review" in beat 2 stays due
 * for review however long after the event you run the demo. The caller lines
 * are ones the offline agent (src/offline.mjs) handles the same way every
 * time; with Voice Live they are just as natural to say out loud.
 *
 * To adapt the demo, edit the lines and the narration here. The narration is
 * written for the room: `talk` while a beat runs, `cue` before a step, `after`
 * once the beat is done.
 */

// Fictional caller IDs. The information line identifies nobody: the number is
// masked on screen and in the audit log.
const RESIDENT_A = "+14255550123";
const RESIDENT_B = "+14255550145";
const RESIDENT_C = "+14255550167";

/** @param {{ setClock: (preset: string) => Promise<void> }} hooks */
export function createBeats({ setClock }) {
  const at = (preset) => () => setClock(preset);

  return [
    {
      title: "Hours, with the source",
      prepare: at("business-hours"),
      talk: "A resident calls the City of Contoso information line with an everyday question. It's Wednesday, 10 a.m. on the demo clock.",
      steps: [
        {
          type: "start",
          fromPhone: RESIDENT_A,
          label: "A resident calls the information line",
          cue: "The agent says up front that it's automated, and what it can help with.",
        },
        {
          type: "say",
          text: "What are City Hall's hours?",
          cue: "The model can only answer from approved city content. Watch the source panel: the content id, the owner, and the review date.",
        },
        {
          type: "say",
          text: "Where did that come from?",
          cue: "Ask where an answer came from and you get the source, with a short URL to check it.",
        },
        { type: "say", text: "Thanks, that's all." },
      ],
      after:
        "Every answer comes from an article with an owner and a review date, and names its source. Whether City Hall is open right now came from the server's clock, not from the model.",
    },
    {
      title: "Due for review: a caveat",
      prepare: at("business-hours"),
      talk: "Content goes out of date. The bulky item pickup article was due for review in July.",
      steps: [
        { type: "start", fromPhone: RESIDENT_B, label: "Another resident calls" },
        {
          type: "say",
          text: "Can the city pick up an old sofa?",
          cue: "The article is past its review date but inside the 90-day grace period. The agent may use it, but it has to say so.",
        },
      ],
      after:
        "The caveat isn't the model being cautious. The server marked the passage as due for review, and the audit log flags the answer. In two weeks, this article won't be read out at all.",
    },
    {
      title: "Out of date: not read out",
      prepare: at("business-hours"),
      talk: "The yard-sale permit article is six months past its review date. The rules may have changed since.",
      steps: [
        { type: "start", fromPhone: RESIDENT_C, label: "A resident calls about a yard sale" },
        {
          type: "say",
          text: "Do I need a permit for a yard sale?",
          cue: "The search finds the article, but the server withholds it. The model is told only that an out-of-date match exists, so it can't read it out as fact.",
        },
        {
          type: "say",
          text: "No thanks, I'll check the website.",
          cue: "The caller can say no. Nobody gets pushed into a queue.",
        },
      ],
      after:
        "The agent says what it can't confirm and offers a person or the website. The refusal is a policy decision in code, and it's counted.",
    },
    {
      title: "After hours",
      prepare: at("after-hours"),
      talk: "Same server, 7 p.m. the same Wednesday. City Hall and the information desk have both closed.",
      steps: [
        { type: "start", fromPhone: RESIDENT_A, label: "A resident calls after hours" },
        {
          type: "say",
          text: "What are City Hall's hours?",
          cue: "Same article, same answer, but whether City Hall is open now follows the clock.",
        },
        {
          type: "say",
          text: "Can I talk to a person?",
          cue: "Nobody is at the desk, so the server won't transfer the call into an empty queue.",
        },
      ],
      after:
        "Instead, the agent gives the next opening, Thursday at 8 a.m., and points to contoso.gov. There's no dead-end transfer, and no promise of a callback the city can't keep.",
    },
    {
      title: "Eligibility: a person decides",
      prepare: at("business-hours"),
      talk: "Back to business hours. Whether someone qualifies for a program is a staff decision, not the agent's.",
      steps: [
        { type: "start", fromPhone: RESIDENT_B, label: "A resident asks about a discount" },
        {
          type: "say",
          text: "I'm 67 — do I qualify for the senior utility discount?",
          cue: "The agent reads out the published criteria but doesn't rule on the caller's own situation. Their age is masked before it reaches the search or the audit log.",
        },
        { type: "say", text: "Yes, please.", cue: "Watch the Teams panel." },
      ],
      after:
        "The staff member's Teams client rings with the topic and what was already covered, so the caller doesn't have to repeat it. The topic and the summary never say the same thing twice.",
    },
    {
      title: "Not on this line: a person",
      prepare: at("business-hours"),
      talk: "Some calls aren't questions at all. This line answers from approved content; it doesn't file service requests.",
      steps: [
        { type: "start", fromPhone: null, label: "A caller with a withheld number" },
        {
          type: "say",
          text: "I want to report a pothole on Elm Street.",
          cue: "The agent doesn't pretend to file it. It says what this line can't do, and offers a person.",
        },
        {
          type: "say",
          text: "Can I talk to a person, please?",
          cue: "Asking for a person always works while the desk is staffed.",
        },
        {
          type: "action",
          action: "metrics",
          label: "Show the numbers",
          cue: "Every call is audited: grounded answers, caveats, refusals, handoffs, and after-hours closures.",
        },
      ],
      after: "These numbers come from the same audit log in production.",
    },
  ];
}
