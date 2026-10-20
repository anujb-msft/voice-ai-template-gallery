// Bid / Price Lookup Agent's film: the short one its tile and page play, cut from the
// console footage of its full walkthrough (films/bid-price-lookup-agent.mjs). Built by
// `npm run reel -- bid-price-lookup-agent`; reel/overview.mjs documents the fields.
export default {
  id: "bid-price-lookup-agent",
  film: "bid-price-lookup-agent",
  name: "Bid / Price Lookup Agent",

  open: {
    headline: "No recording. Just today's bid.",
    shot: "grid",
    focus: "quote",
    segments: [
      { from: "What's corn paying", to: "Corn at Riverside for November", drop: 1, lead: 3.5, push: 1.6 },
      { from: "And beans", to: "Soybeans at Riverside", drop: 1 },
    ],
  },

  title: {
    eyebrow: "Voice AI templates for Teams Phone",
    lines: ["Bid and price", "lookup."],
    sub: "Today's bid on every call, priced by your server, never by the model.",
    narration: ["Bid and price lookup.", "Today's bid on every call, priced by your server, never by the model."],
  },

  chapters: [
    {
      card: "It watches the clock.",
      clips: [
        {
          headline: "Say that again? It checks again.",
          focus: "quote",
          segments: [{ from: "Say that again", to: "Soybeans at Riverside", drop: 2 }],
        },
        {
          headline: "Market closed? It quotes the last close.",
          focus: "quote",
          segments: [{ from: "Repeat that", to: "As of the last close", drop: 1 }],
        },
      ],
    },
    {
      card: "It won't advise.",
      clips: [
        {
          headline: "The disclaimer first. Every call.",
          focus: "quote",
          segments: [{ from: "Contoso Grain Co-op bid line", drop: 4 }],
        },
        {
          headline: "Now or wait? The merchandiser's call.",
          focus: "quote",
          segments: [{ from: "Should I lock that in", to: "I can't advise" }],
        },
      ],
    },
    {
      card: "It hands off.",
      clips: [
        {
          headline: "Lock it in? Only a merchandiser can.",
          teams: true,
          focus: "teams",
          segments: [{ from: "Okay, lock in", to: "I can't lock in", tail: 1.2 }],
        },
      ],
    },
  ],

  trust: {
    lines: ["The model reads.", "The server prices."],
    points: ["No raw prices to the model", "Stale prices get a caveat", "No tool can lock a price"],
    narration: ["The model reads.", "The server prices."],
  },

  yours: {
    title: "Make it yours.",
    files: ["config/locations.json", "config/bids.json", "config/market.json"],
    prompt: "Swap the fixture futures feed for our licensed market-data API. Keep the 20-minute freshness rule.",
    narration: ["Make it yours.", "Your elevators, bids and market hours are configuration. Your coding agent can change the rest."],
  },

  end: {
    lines: ["Bid and price", "lookup."],
    sub: "Run it in simulation in two minutes. Then connect a licensed feed and your Teams number.",
    narration: ["Run it in simulation in two minutes.", "Then connect a licensed feed and your Teams number."],
    run: "cd code && npm install && npm start",
  },
};
