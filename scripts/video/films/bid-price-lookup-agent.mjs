// Film script: Bid / Price Lookup Agent.
//
// beats[n] narrates console beat n (1-based, as on screen): `intro` before it
// starts, `cues[s]` before step s, `post[s]` after step s settles, `after` at
// the end. The console holds still while the narrator speaks.
export default {
  id: "bid-price-lookup-agent",
  port: 18096,
  lang: "en-US",

  cast: {
    agent: { name: "Agent", voice: "marin" },
    callers: {
      dale: {
        name: "Dale Meyer",
        voice: "ash",
        style:
          "Dale Meyer, a grain farmer who sells at the co-op's Riverside elevator, calling the bid line from his pickup " +
          "between fields. Plain-spoken and unhurried, he knows the market well: a real person on a phone call, not an actor.",
      },
      rosa: {
        name: "Rosa Alvarez",
        voice: "coral",
        style:
          "Rosa Alvarez, a grower who sells at the co-op's Lake Mills elevator, checking the wheat bid before she hauls. " +
          "Practical, friendly and brief: natural phone delivery, not an actor.",
      },
      grower: {
        name: "Caller",
        voice: "verse",
        style:
          "A grower calling the co-op's bid line from a number it doesn't know, a little vague about which elevator he means. " +
          "Casual and quick, natural phone delivery.",
      },
      harvest: {
        name: "Caller",
        voice: "shimmer",
        style:
          "A grower calling between loads at harvest, a little distracted, who asks to hear the price again. " +
          "Brisk and practical: a real person on a phone call, not an actor.",
      },
    },
  },

  beats: {
    1: {
      caller: "dale",
      intro: "Dale Meyer sells grain at the co-op's Riverside elevator. He calls for today's corn bid.",
      post: {
        2: "Every word of that quote was written by your server. The agent only read it.",
      },
      after: "The model never sees a raw bid, basis or futures price, so it has no number of its own to invent.",
      shots: { "post 2": "quote" },
    },
    2: {
      caller: "grower",
      intro: "A wrong price is worse than no price. This caller leaves things out.",
      post: {
        2: "No commodity, no number. The server sends back one question instead of a guess.",
        4: "“The river elevator” matches Riverbend and Riverside. The server won't pick one for the caller.",
      },
      after: "Two questions, no guesses, and each answer filled only the gap it was asked about.",
      shots: { "post 4": "quote" },
    },
    3: {
      caller: "harvest",
      intro: "Prices age, and a stale price is a wrong one. Your server decides whether a quote may still be called current.",
      skip: 1,
      skipLabel: "Past the greeting",
      cues: {
        3: "The clock jumps to 11:20, and the caller asks again.",
        5: "Now it's two in the afternoon, after the 1:20 close.",
      },
      post: {
        2: "At 10:45, those futures are four minutes old, inside the twenty-minute window. So the quote is live.",
        4: "A repeat is never a replay. The server checked again, found thirty-nine-minute-old futures, and added the caveat.",
        6: "No live price exists now, so the agent gives the last settlement, and says so.",
      },
      after: "Three answers to one question, each decided by policy code. The trail shows why.",
      shots: { "post 2": "quote", "post 4": "quote", after: "trail" },
    },
    4: {
      caller: "rosa",
      intro: "Rosa Alvarez sells at Lake Mills. Just before she calls, the price feed goes down.",
      post: {
        3: "No price from the server, so none from the agent. A callback is offered only because Rosa's caller ID is known.",
        4: "The callback is logged, her number masked and no time promised. Connect it to your own task list.",
      },
      shots: { "step 1": "quote", "post 4": "teams" },
    },
    5: {
      caller: "dale",
      intro: "Dale calls back. Reading a bid is the agent's job. Advising on it, or locking it in, belongs to the merchandiser.",
      skip: 1,
      skipLabel: "Past the greeting",
      cues: { 4: "No tool on this line can lock, book or contract a price. Watch the Teams panel." },
      post: {
        4: "Nothing was locked. The Riverside merchandiser's Teams client rings with Dale's last quote, his own words and the reason.",
      },
      after: "The model held the conversation. Your server decided every quote, caveat, refusal and handoff, and counted them.",
      shots: { "post 4": "teams", "step 5": "metrics" },
    },
  },

  // Beat 2 (clarifying questions) and beat 4 (feed down) are cut to keep this low-complexity template near five
  // minutes; the hood names both rules. Beats 3 and 5 skip the greeting the film has already shown.
  edit: { beats: [1, 3, 5] },

  scenes: {
    open: {
      call: { name: "Dale Meyer", detail: "Grower · Riverside", number: "+1 (425) 555-0111", line: "Contoso Grain Co-op · Bid line" },
      menu: ["For corn, press 1.", "For soybeans, press 2.", "For wheat, press 3.", { key: "♪", text: "Today's bids, as recorded this morning…" }],
      narration: [
        "A grain co-op's bid line is usually a recording, made once in the morning, while prices move all day.",
        "Growers press through a menu for a number that may already be stale. This agent just answers.",
      ],
    },
    title: {
      title: "Bid / Price Lookup Agent",
      promise: "Today's bid on every call. Priced by your server, never by the model.",
    },
    how: {
      narration: [
        "Growers call a Teams phone number, through Teams Phone extensibility.",
        "Azure Communication Services Call Automation bridges the audio to Voice Live, where GPT Realtime holds the conversation.",
        "Your server prices every quote. To sell or lock a price, the merchandiser takes the call in Teams.",
      ],
      stages: [
        { label: "Caller", detail: "A grower, on any phone" },
        { label: "Teams Phone", detail: "Bid-line number on a resource account", brand: true },
        { label: "Call Automation", detail: "Azure Communication Services media bridge" },
        { label: "Voice Live", detail: "GPT Realtime speech to speech" },
        { label: "Price book", detail: "Your server: bids, futures, market hours" },
        { label: "Teams merchandiser", detail: "A user or call queue, with VoIP headers", brand: true },
      ],
    },
    hood: {
      title: "The model reads. The server prices.",
      narration: [
        "Under the hood, the model only converses. It passes on what the grower asked, and reads back the server's sentence.",
        "The server decides the rest: the location, whether a price is live, delayed or missing, and that every lock request goes to a person.",
      ],
      points: [
        { k: "forModel", v: "The server's sentence and flags. Never the raw bid, basis or futures price." },
        { k: "Clarify", v: "A missing commodity, or two matching locations: one question, never a guess." },
        { k: "Freshness", v: "Live under 20 minutes. Then a caveat. After the close, the last settlement." },
        { k: "Feed down", v: "No number at all. The merchandiser now, or a callback if there's a caller ID." },
        { k: "Lock / book", v: "No tool can. The request goes to the location's merchandiser." },
        { k: "Handoff", v: "Topic, last quote, the caller's words and the reason, in VoIP headers." },
      ],
    },
    yours: {
      narration: [
        "Making it yours is mostly configuration: your elevators, merchandisers and hours, your bid sheet, market hours and freshness window.",
        "A licensed feed replaces one fixture class, and the spec and tests give your coding agent the rules that must hold.",
      ],
      files: [
        { path: "config/locations.json", note: "Elevators, aliases, merchandisers and hours" },
        { path: "config/bids.json", note: "The posted bid sheet: basis by delivery month" },
        { path: "config/market.json", note: "Trading session and market holidays" },
        { path: "FUTURES_STALE_MINUTES=20", note: "The freshness window, in .env" },
        { path: "src/pricing.mjs", note: "Swap the fixture feed for your licensed feed" },
        { path: "SPEC.md", note: "Caller journey and acceptance criteria" },
      ],
      prompt: "Swap the fixture futures feed for our licensed market-data API. Keep the 20-minute freshness rule and its tests.",
      context: ["SPEC.md", "DEMO-SCRIPT.md", "test/"],
    },
    close: {
      narration: ["Bid and price lookup. Run it in simulation in two minutes, then connect it to your own Teams number."],
      run: "cd code && npm install && npm start",
    },
  },
};
