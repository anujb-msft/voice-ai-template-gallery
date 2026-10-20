# Bid / Price Lookup Agent

This gallery package presents an inbound voice agent for a grain co-op's bid line. A
grower calls, asks for a commodity at a location in their own words — "What's corn paying
at Riverside?" — and hears the posted cash bid, the basis against the futures month and the
time the price is as of, instead of a recording someone re-records every morning. To sell,
lock in a price or talk it through, the caller is connected to that location's merchandiser
in Teams, with their question and last quote already on the merchandiser's screen. Calls
arrive on the phone channel through Teams Phone extensibility, with Azure Communication
Services Call Automation bridging the call and the Azure AI Voice Live API for speech.

The interesting part is not reading a number aloud. It is that the server, not the model,
decides whether a price may be called current (live, delayed with a caveat, or the last
close), that a feed outage produces no number at all, and that nothing on this line can
lock, book or contract a price.

## Package contents

- [`code/`](./code/) — runnable source implementation and presenter console, fictional
  bid, futures, market-hours and location fixtures, setup instructions, configuration
  example, presenter demo script, Teams provisioning script, and tests.
- [`SPEC.md`](./SPEC.md) — the agreed caller journey, architecture, price-freshness rules,
  Teams handoff contract, and acceptance criteria.
- [`video/`](./video/) — recording, poster, caption, and transcript delivery scaffolding.
  No media binary is included yet.
- [`slides/`](./slides/) — the one-slide value proposition (PDF), generated from
  `template.json`. The editable deck and its preview image are not included yet.
- [`media/`](./media/) — gallery thumbnail and conceptual architecture illustration.
- [`template.json`](./template.json) — business and technical metadata, GitHub
  Pages-safe relative paths, and expected asset status.

## Run the implementation

It runs with no Azure subscription. A typed transcript drives the same call flow, pricing
policy and handoff rules a real call would; the speech model, the audio and the Teams
transfer are simulated, and a demo clock and a price-feed switch let one server show every
price state.

```bash
cd code
npm install
npm start          # http://127.0.0.1:8094
```

Open <http://127.0.0.1:8094> and press **→** to run the scripted demo one step at a time;
[`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md) is the running order and narration.

```bash
npm test           # no Azure and no network required
```

## Common flows to test

In the console, pick a **Caller ID** (Dale Meyer unless the row says otherwise), click
**Answer a call** and type each line. A fresh start puts the demo clock at 10:45 AM Central
on a trading day, the **Prices fresh** preset; a row that needs another time names the
preset to click on the clock in the header. **Reset demo** restores the clock and the feed.

| Flow | Say or type | Expected behavior |
| --- | --- | --- |
| Quote | `What's corn paying at Riverside?` | "Corn at Riverside for November delivery is $4.12, that's 35 under December futures, as of 10:42 AM." The quote panel shows the cash bid, basis, futures reference, "as of" time and source |
| Missing commodity | `What's the bid at Fairview?` → `Wheat.` | Asks one question, "Which commodity at Fairview — corn, soybeans, or wheat?", then quotes wheat at Fairview without asking for the location again |
| Ambiguous location | `Corn at the river elevator?` → `Riverside.` | Asks "Did you mean Riverbend or Riverside?" instead of picking one, then quotes Riverside |
| Delayed price | On the **Prices stale** clock: `Soybeans at Riverside?` | Quotes $10.11 as of 10:41 AM, then "These prices may be delayed.", because the futures are past the 20-minute freshness window |
| Market closed | On the **Market closed** clock: `Corn at Riverside?` | "As of the last close, corn at Riverside for November delivery was $4.08…" Priced from the last settlement and never called current |
| Feed down | Click **Take the feed down**, Caller ID **Rosa Alvarez**: `Wheat at Lake Mills?` → `Have them call me back.` | Says pricing data is unavailable and gives no number, offers the Lake Mills merchandiser now or a callback, then logs a callback to the number ending 12. With **Unknown number** as the caller ID, only the transfer is offered |
| Advice and contracts | `Corn at Riverside for December?` → `Should I lock that in now, or wait?` → `Okay, lock in 5,000 bushels at that price.` | Quotes $4.14, declines to advise, then refuses to lock anything and transfers to the Riverside merchandiser; the Teams toast reads "Lock a price: corn – Riverside", with the last quote and the caller's words |
| A person | `Corn at Riverside?` → `Can I talk to a merchandiser?`, or press keypad **0** | "Connecting you with the Riverside merchandiser now.", with no confirmation question; the call context carries the last quote |
| After hours | On the **After hours** clock: `Corn at Riverside?` → `I want to sell.` | Quotes the last close, then gives the Riverside merchandiser's hours, 8 AM to 5 PM Central Time, Monday through Friday, instead of ringing a closed desk |

On a live call the model words the conversation, so its phrasing can vary; which price may
be quoted, the freshness caveat, and every refusal and handoff are decided by the same
server code as in simulation. A live call is always priced on the real clock, so with the
bundled fixtures it hears last-close prices. See the
[`code/README.md` live call test matrix](./code/README.md#live-call-test-matrix) for setup
details and test-environment caveats.

For real calls, follow the setup and Teams Phone provisioning guidance in
[`code/README.md`](./code/README.md). To present it, use
[`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md).

Do not commit `.env`, generated `data/`, logs, or `node_modules/`.
