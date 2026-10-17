/**
 * The on-stage demo, beat by beat. The director in the presenter kit runs it:
 * Next ▶ (or →, PageDown, a clicker) runs one step, Auto-play runs the rest of
 * a beat, and 1–5 jump straight to a beat.
 *
 * Every beat pins the demo clock and answers its own call, so any beat can be
 * re-run on its own, in any order, at any time of day. The caller lines are
 * ones the offline stand-in (src/offline.mjs) handles the same way every time;
 * with Voice Live they are just as natural to say out loud.
 *
 * To adapt the demo, edit the lines and the narration here. The narration is
 * written for the room: `talk` while a beat runs, `cue` before a step, `after`
 * once the beat is done. A start step may carry `lang`, the language the
 * caller is about to speak, so the room hears their lines in that voice.
 */

const ALEX = "+12065550142"; // Alex Chen
const LUCIA = "+12065550187"; // Lucía Ortega, who speaks Spanish
const SAM = "+12065550118"; // Sam Rivera

/** @param {{ setClock: (preset: string) => Promise<void> }} hooks */
export function createBeats({ setClock }) {
  const at = (preset) => () => setClock(preset);

  return [
    {
      title: "Report a pothole",
      prepare: at("business-hours"),
      talk: "Alex reports a pothole the way people actually talk: a street and a corner. No form, no menu.",
      steps: [
        {
          type: "start",
          fromPhone: ALEX,
          label: "Alex Chen calls 311",
          cue: "The greeting says “dial 911” before anything else, and every caller turn is checked for an emergency first.",
        },
        {
          type: "say",
          text: "Hi, there's a big pothole on Oak Avenue, right at the corner of Fifth Street.",
          cue: "The geocoder on the server, not the model, turns that into a verified location. The agent reads it back.",
        },
        {
          type: "say",
          text: "Yes, that's right.",
          cue: "Only a confirmed location gets filed. Watch the case card: category, department, zone and response target.",
        },
        {
          type: "say",
          text: "Yes, text me updates please.",
          cue: "A text goes out only with consent. In simulation it lands on the phone panel and is never sent.",
        },
        { type: "say", text: "No, that's all, thanks." },
      ],
      after:
        "SR-26-0193 is filed against a verified location and routed to Public Works with a five-business-day target. The caller's number stayed on the server; the model never saw it.",
    },
    {
      title: "I smell gas",
      prepare: at("business-hours"),
      talk: "Some calls must never turn into a service request.",
      steps: [
        { type: "start", fromPhone: SAM, label: "Sam Rivera calls 311" },
        {
          type: "say",
          text: "Hi, I smell gas in my kitchen and I'm not sure what to do.",
          cue: "The emergency rule runs on the server before the model gets a turn: safety guidance and the gas utility's number. No questions.",
        },
      ],
      after:
        "No report, no questions, no case number. The rule fired in code, the caller heard what to do, and the trail shows emergency_redirect.",
    },
    {
      title: "Same service in Spanish",
      prepare: at("business-hours"),
      talk: "Lucía calls in Spanish. Same rules, same service; only the language changes.",
      steps: [
        {
          type: "start",
          fromPhone: LUCIA,
          lang: "es-US",
          label: "Lucía Ortega calls 311",
          cue: "The greeting ends with “Para español, hable en español”. No menu to find.",
        },
        {
          type: "say",
          text: "Hola, necesito que recojan un colchón y un sofá viejo.",
          cue: "The server hears Spanish and switches the agent's locale and voice. Both items are on the city's accepted list.",
        },
        {
          type: "say",
          text: "En el 1200 de Maple Street.",
          cue: "The pickup date comes from the zone calendar in config, not from the model.",
        },
        { type: "say", text: "Sí, por favor.", cue: "Consent first, then the text, in Spanish." },
        { type: "say", text: "No, gracias." },
      ],
      after:
        "SR-26-0194: a mattress and a sofa, picked up Saturday, October 3, from the zone A calendar. The language travels with the case, and would travel with a handoff too.",
    },
    {
      title: "A civic question",
      prepare: at("business-hours"),
      talk: "Questions get answers only from approved, reviewed content, with the source named.",
      steps: [
        { type: "start", fromPhone: SAM, label: "Sam Rivera calls with two questions" },
        {
          type: "say",
          text: "When is trash pickup on Maple Street?",
          cue: "The answer is read from a reviewed article, and the agent says where it came from.",
        },
        {
          type: "say",
          text: "And what are the counter hours at City Hall?",
          cue: "The only match is an expired notice. The server withholds it: no guessing, and 311 staff are offered instead.",
        },
        { type: "say", text: "No, that's all." },
      ],
      after:
        "One answer with its source, and one honest “I don't have approved information on that”. Expired content never reaches the caller.",
    },
    {
      title: "A complaint, to a person",
      prepare: at("business-hours"),
      talk: "An unhappy caller. The agent listens, doesn't argue, and offers a person.",
      steps: [
        { type: "start", fromPhone: null, label: "A caller with a withheld number" },
        {
          type: "say",
          text: "I want to make a complaint. The trash trucks have skipped my street three weeks in a row and nobody has called me back.",
          cue: "The server hears a complaint and frustration. No promises: the agent apologizes and offers a report or a person.",
        },
        {
          type: "say",
          text: "I'd like to talk to a person, please.",
          cue: "A warm handoff. Watch the Teams panel: the topic, a summary, the sentiment and the language arrive with the call.",
        },
        {
          type: "action",
          action: "metrics",
          label: "Show the numbers",
          cue: "Every call is audited: requests created, emergencies escalated, questions answered and handoffs.",
        },
      ],
      after:
        "311 staff pick up already knowing what the call is about. The same numbers come from the same audit log in production.",
    },
  ];
}
