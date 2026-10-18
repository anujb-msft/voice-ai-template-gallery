// Film script: General Inquiry Agent.
//
// beats[n] narrates console beat n (1-based, as on screen): `intro` before it
// starts, `cues[s]` before step s, `post[s]` after step s settles, `after` at
// the end. The console holds still while the narrator speaks.
//
// The agent's lines are long (the greeting alone is 27 words), so the
// narration stays lean: one setup and one payoff per call.
export default {
  id: "general-inquiry-agent",
  port: 18099,
  lang: "en-US",

  cast: {
    agent: { name: "Agent", voice: "marin" },
    // The information line identifies nobody, so the callers stay anonymous, as in the console.
    callers: {
      resident: {
        name: "Resident",
        voice: "coral",
        style:
          "A resident of the City of Contoso calling the city's information line with a quick, everyday question about City Hall. " +
          "Friendly, casual and to the point: a real person on a phone call, not an actor.",
      },
      yardSale: {
        name: "Resident",
        voice: "sage",
        style:
          "A resident planning a weekend yard sale who wants to know whether she needs a city permit. Cheerful and practical, " +
          "and happy to check the city's website herself. Natural phone delivery, not an actor.",
      },
      senior: {
        name: "Resident",
        voice: "ballad",
        style:
          "A 67-year-old retired resident asking the city whether he qualifies for the senior utility discount. Warm, polite " +
          "and a little unsure of the rules, glad to be put through to someone. Natural phone delivery.",
      },
      withheld: {
        name: "Caller",
        voice: "ash",
        style:
          "A resident calling with his number withheld to report a pothole on Elm Street, who asks for a person when the line " +
          "can't take the report. Direct and a little impatient, but civil: a real person on a phone call.",
      },
    },
  },

  beats: {
    1: {
      caller: "resident",
      intro: "Wednesday, 10 in the morning. A resident calls the City of Contoso's information line.",
      post: {
        2: "That's an approved article, with an owner and a review date. Whether it's open now came from the server's clock, not the model.",
      },
      shots: { "post 2": "decision" },
    },
    3: {
      caller: "yardSale",
      intro: "Every article has a review date. The yard-sale permit article is six months past it, and a resident is asking.",
      skip: 1,
      skipLabel: "Past the greeting",
      post: { 2: "The server held it back. The model was told only that an out-of-date match exists. There was nothing to paraphrase." },
      shots: { "post 2": "decision" },
    },
    4: {
      caller: "resident",
      intro: "Seven in the evening. City Hall and the information desk have both closed, and a resident wants to talk to a person.",
      // The hours answer repeats beat 1's, so the film goes straight to the refused transfer.
      skip: 2,
      skipLabel: "Hours: closed right now",
      post: { 3: "The server checked the desk's staffed hours. No transfer into an empty queue, and no promise of a callback the city can't keep." },
      shots: { "post 3": "decision+teams" },
    },
    5: {
      caller: "senior",
      intro: "Back to business hours. Whether a caller qualifies for a city program is for staff to decide, not the model.",
      skip: 1,
      skipLabel: "Past the greeting",
      // The agent itself says staff decide and offers a person, so the narrator waits for the transfer.
      post: { 3: "The desk's Teams client rings with the topic and what was already covered, in VoIP headers. Even there, the age is masked." },
      shots: { "post 3": "decision+teams" },
    },
    6: {
      caller: "withheld",
      intro: "Not every call is a question. This line can't file service requests, and the agent won't pretend it can.",
      skip: 1,
      skipLabel: "Past the greeting",
      post: { 4: "Every call is audited: answers, refusals, handoffs and after-hours closures, from the same log a real deployment writes." },
      shots: { "post 4": "metrics" },
    },
  },

  // Beat 2 (a caveat on an article due for review) is the milder half of beat 3's freshness lesson; leaving it
  // out, and skipping the greeting beat 1 already played, keeps the film near five minutes.
  edit: { beats: [1, 3, 4, 5, 6] },

  scenes: {
    open: {
      call: { name: "Resident", number: "+1 (425) 555-0123", line: "City of Contoso · Information line" },
      menu: [
        "For City Hall hours and locations, press 1.",
        "For permits, press 2.",
        "For trash and recycling, press 3.",
        { key: "♪", text: "Please hold for the next available representative." },
      ],
      narration: [
        "A city's information line hears the same few questions all day: hours, permits, pickups, programs.",
        "Usually that means a menu, then a queue. This agent answers from the city's approved content.",
      ],
    },
    title: {
      title: "General Inquiry Agent",
      promise: "Answer the common question before it becomes a queue.",
    },
    how: {
      narration: [
        "Residents call a Teams phone number, through Teams Phone extensibility.",
        "Azure Communication Services Call Automation bridges the audio to Voice Live, where GPT Realtime holds the conversation.",
        "Your server supplies the approved content, and hands off to a Teams call queue with context.",
      ],
      stages: [
        { label: "Resident", detail: "Any phone" },
        { label: "Teams Phone", detail: "Information line on a resource account", brand: true },
        { label: "Call Automation", detail: "Azure Communication Services media bridge" },
        { label: "Voice Live", detail: "GPT Realtime speech to speech" },
        { label: "Approved content", detail: "Your articles, hours and policy" },
        { label: "Teams call queue", detail: "Staff answer with topic and context", brand: true },
      ],
    },
    hood: {
      title: "What the server won't let the model decide.",
      narration: [
        "On a live call, the model searches the city's content and words the answer. It doesn't set the rules.",
        "Freshness, opening hours, what's masked and the transfer are decided in code, on the server's clock, and every decision is audited.",
      ],
      points: [
        { k: "search_content", v: "Keyword search over approved articles. Below the score bar, no answer." },
        { k: "Freshness", v: "Up to 90 days past review: read with a caveat. After that, never sent to the model." },
        { k: "Open now", v: "Worked out on the server's clock, in the city's time zone." },
        { k: "record_answer", v: "Only articles the latest search returned. Every answer is logged." },
        { k: "Eligibility", v: "An age or income never reaches the search, and is masked in the log and Teams." },
        { k: "request_human", v: "A reason and a topic, never a destination. Desk closed: the next opening." },
      ],
    },
    yours: {
      narration: [
        "Making it yours is mostly content: your articles, with owners and review dates, plus your hours and two thresholds.",
        "The spec and this demo script give your coding agent the context for the rest.",
      ],
      files: [
        { path: "content/articles/", note: "Approved answers: owner, source, review date" },
        { path: "config/hours.json", note: "Time zone, staffed hours, the Teams queue" },
        { path: "CONTENT_EXPIRY_GRACE_DAYS=90", note: "Days past review before it's withheld, in .env" },
        { path: "RETRIEVAL_MIN_SCORE=2.5", note: "How strong a match must be to answer, in .env" },
        { path: "SPEC.md", note: "Caller experience, Teams handoff, acceptance criteria" },
        { path: "code/public/beats.js", note: "This demo, step by step" },
      ],
      prompt: "Add a city holiday calendar, so City Hall and the information desk show as closed on holidays.",
    },
    close: {
      narration: ["General Inquiry Agent. Run it in simulation, then connect it to your own Teams number."],
      run: "cd code && npm install && npm start",
    },
  },
};
