# Demo script — Bid Price Lookup Agent

## Setup

1. In `docs/templates/bid-price-lookup-agent/code`, run `npm start`.
2. Open <http://127.0.0.1:8094>.
3. Point out the mode pill: simulation mode is expected without Azure credentials.

## Walkthrough

1. Click **Answer demo call**.
   - The first line discloses the automated assistant and speaks the bid disclaimer once.
2. Type: `what's corn at Riverside`.
   - Show the fixed phrase: “Corn at Riverside for November delivery is $4.12…”
   - Highlight that the model did not generate the number; it came from the server tool.
3. Type: `and beans?`.
   - The agent reuses Riverside as the last location.
4. Type: `all locations for corn`.
   - The bid board returns the top five locations sorted by cash price.
5. Type: `should I sell?`.
   - The agent refuses advice and does not predict markets.
6. Click **DTMF \***.
   - The last phrase repeats verbatim.
7. Type: `I want to sell`.
   - The mock Teams handoff appears with CallTopic, CallContext, LocationId, and reason.

## Freshness and outage controls

- Click **Make stale**, then ask `what's corn at Riverside` to show the delayed-price caveat.
- Click **Feed down**, then ask for a quote to show the in-hours merchandiser transfer path.

## Closing message

This sample is a price reader, not a merchandiser. Before production, replace fixtures with a licensed market-data feed, review compliance wording, and provision real Teams user or queue object IDs in `config/locations.json`.
