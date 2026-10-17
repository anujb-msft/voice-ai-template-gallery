/**
 * The on-stage demo, beat by beat. The director in the presenter kit runs it:
 * Next ▶ (or →, PageDown, a clicker) runs one step, Auto-play runs the rest of
 * a beat, and 1–5 jump straight to a beat.
 *
 * Every beat brings the price feed up and pins the demo clock to 10:45 AM on a
 * trading day before it answers its own call, so any beat can be re-run on its
 * own, in any order, at any time of day. The caller lines are ones the offline
 * stand-in (src/offline.mjs) understands the same way every time; with Voice
 * Live they are just as natural to say out loud.
 *
 * To adapt the demo, edit the lines and the narration here. The narration is
 * written for the room: `talk` while a beat runs, `cue` before a step, `after`
 * once the beat is done.
 */

const DALE = "+14255550111"; // Dale Meyer, a grower who sells at Riverside
const ROSA = "+14255550112"; // Rosa Alvarez, a grower who sells at Lake Mills

/**
 * @param {{
 *   setClock: (preset: string) => Promise<void>,
 *   setFeed: (up: boolean) => Promise<void>,
 * }} hooks
 */
export function createBeats({ setClock, setFeed }) {
  const fresh = async () => {
    await setFeed(true);
    await setClock("prices-fresh");
  };

  return [
    {
      title: "What's corn paying?",
      prepare: fresh,
      talk: "Many bid lines are a recording that someone re-records every morning. Here Dale asks in his own words, and hears today's number.",
      steps: [
        {
          type: "start",
          fromPhone: DALE,
          label: "Dale Meyer calls the bid line",
          cue: "Every call opens with the same disclosure and the co-op's disclaimer: bids change, so confirm before selling.",
        },
        {
          type: "say",
          text: "What's corn paying at Riverside?",
          cue: "The model only hears the commodity and the location. The price, the basis and the “as of” time come from the server, word for word.",
        },
        {
          type: "say",
          text: "And beans?",
          cue: "A follow-up keeps the location: soybeans at Riverside, from the same bid sheet.",
        },
        { type: "say", text: "That's all, thanks." },
      ],
      after:
        "Point at the price card: cash bid, basis against the futures month, the “as of” time and the source. The agent read that sentence; it didn't write the number.",
    },
    {
      title: "Not sure? Ask",
      prepare: fresh,
      talk: "A wrong price is worse than no price. When a request is unclear, the agent asks one short question instead of guessing.",
      steps: [
        { type: "start", fromPhone: null, label: "An unknown number calls" },
        {
          type: "say",
          text: "What's the bid at Fairview?",
          cue: "Fairview posts corn, soybeans and wheat. No commodity means no number, just one question.",
        },
        {
          type: "say",
          text: "Wheat.",
          cue: "The answer fills only the gap the agent asked about. Fairview is kept.",
        },
        {
          type: "say",
          text: "And corn at the river elevator?",
          cue: "“River” matches two locations, Riverbend and Riverside. The server won't pick one for the caller.",
        },
        { type: "say", text: "Riverbend." },
        { type: "say", text: "That's all, thanks." },
      ],
      after: "Two clarifying questions, no guesses. Both are in the decision trail and in the metrics.",
    },
    {
      title: "Stale price, honest caveat",
      prepare: fresh,
      talk: "Prices age. The server decides whether a number may be called current, from the futures timestamp and the market hours, not the model.",
      steps: [
        { type: "start", fromPhone: null, label: "An unknown number calls" },
        {
          type: "say",
          text: "Soybeans at Riverside?",
          cue: "At 10:45 the soybean futures are 4 minutes old, inside the 20-minute window, so the quote is live.",
        },
        {
          type: "action",
          action: "clock",
          preset: "prices-stale",
          label: "Move the demo clock to 11:20 AM",
          cue: "At 11:20 the soybean futures are 39 minutes old, past the 20-minute window. Watch the freshness gauge when the caller asks again.",
        },
        {
          type: "say",
          text: "Say that again?",
          cue: "A repeat is never a replay. The server re-checks first, and the same number now comes with a caveat.",
        },
        {
          type: "action",
          action: "clock",
          preset: "after-close",
          label: "Move the demo clock to 2:00 PM, after the close",
          cue: "The futures market closed at 1:20, so there is no live price at all.",
        },
        {
          type: "say",
          text: "Repeat that, please.",
          cue: "After the close the agent quotes the last settlement and says so. It never calls it current.",
        },
        { type: "hangup" },
      ],
      after:
        "Live, delayed with a caveat, last close: three answers to one question, each decided by policy code. The trail shows why each time.",
    },
    {
      title: "Feed down: no number",
      prepare: fresh,
      talk: "What happens when the pricing feed goes down? The worst possible answer is a confident, made-up number.",
      steps: [
        {
          type: "action",
          action: "feed",
          up: false,
          label: "Take the price feed down",
          cue: "A simulation-only switch: from now on every read from the feed fails.",
        },
        { type: "start", fromPhone: ROSA, label: "Rosa Alvarez calls" },
        {
          type: "say",
          text: "Wheat at Lake Mills?",
          cue: "No feed, no number. The agent says so plainly and offers a person now, or a callback.",
        },
        {
          type: "say",
          text: "Have them call me back.",
          cue: "Rosa's caller ID makes a callback possible, so the request is logged for the Lake Mills merchandiser.",
        },
        { type: "action", action: "feed", up: true, label: "Bring the price feed back up" },
      ],
      after:
        "No number was invented. The callback request, with what Rosa asked about, is in the audit log for the merchandiser.",
    },
    {
      title: "Lock it in? A person",
      prepare: fresh,
      talk: "Reading a bid is fine. Advising on it, or locking it in, is a merchandiser's job, and the agent knows the difference.",
      steps: [
        { type: "start", fromPhone: DALE, label: "Dale calls back" },
        {
          type: "say",
          text: "Corn at Riverside for December?",
          cue: "A specific delivery month, straight from the posted bids.",
        },
        {
          type: "say",
          text: "Should I lock that in now, or wait?",
          cue: "That's a request for advice. The agent declines and points to the merchandiser.",
        },
        {
          type: "say",
          text: "Okay, lock in 5,000 bushels at that price.",
          cue: "Contracting is a hard stop. Nothing is locked: the call goes to a person, with the context.",
        },
        {
          type: "action",
          action: "metrics",
          label: "Show the numbers",
          cue: "Every quote, caveat, refusal and handoff came from the same audit log.",
        },
      ],
      after:
        "The merchandiser's Teams client rings with what Dale wants, his last quote and why he was handed over. The same context travels in the VoIP headers.",
    },
  ];
}
