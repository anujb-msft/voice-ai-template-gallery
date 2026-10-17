# Demo script — 5 beats, about 6 minutes

A rehearsable running order for the bid / price lookup agent, the Contoso Grain Co-op bid
line. Every beat runs in **simulation mode**, so no Azure subscription, phone number or
Teams tenant is needed. The only thing that can reach the network is Edge's online voices,
if you turn them on.

The beats: **1** What's corn paying? · **2** Not sure? Ask · **3** Stale price, honest
caveat · **4** Feed down: no number · **5** Lock it in? A person.

The argument you are making is *not* "a model can read a price aloud". Everyone believes
that already. It is: **the server decides which number may be said, and when to say none at
all — and anything that sounds like a contract goes to a person.**

The console drives itself. Each press of **→** runs one step of the script and types (and,
if you like, speaks) the caller's line, so your hands are free and your eyes are on the room.
The narration below is the same text the console shows under the beat strip: a step's cue
while that step is next, the beat's opening line when the next step has no cue, and the
closing line once the beat is done.

---

## Set up — five minutes before

```bash
npm install
npm start                          # http://127.0.0.1:8094
curl -s 127.0.0.1:8094/health      # expect "mode": "simulation"
```

- [ ] Open **Microsoft Edge** at `http://127.0.0.1:8094/?voices=online`. Edge's online
      voices are the Azure neural voices, so the room *hears* a voice product. Without
      `?voices=online` the console uses on-device voices only and nothing leaves the machine.
- [ ] Set the voice menu (top right) to **Speak agent + caller**, or **Speak agent** if you
      would rather read the caller's lines yourself.
- [ ] Zoom to **125%** (Ctrl and +) and press **F11**. The beat strip should fit on one line.
- [ ] Press **Reset demo**: no calls, zeroed metrics, the price feed up and the clock back at
      10:45 AM. Every beat brings the feed up and sets the clock it needs, so the time of
      day you present at doesn't matter.
- [ ] Run beat 1 once to wake the voices, then press **Reset demo** again.

The chip in the top-right corner must say **simulation mode**. If it says **live · Teams
Phone**, this server found Azure settings in `.env`, and the demo clock, the feed switch and
reset are switched off so they can't affect real calls. Start it with
`PUBLIC_BASE_URL= npm start` to force simulation (an empty variable wins over `.env`), on
another `PORT` if the live server is still running.

### Driving it

| Key | What it does |
| --- | --- |
| **→**, **PageDown** or a presenter clicker | Run the next step |
| **Auto-play** | Run the rest of the current beat |
| **1**–**5** | Jump to a beat. Each beat brings the feed up, sets the clock to 10:45 AM and answers its own call, so any beat re-runs cleanly, in any order |
| **PageUp** | Back to the start of this beat; press again for the previous beat |
| **Esc** | Stop auto-play and the voices |
| **N** | Show or hide the narration under the beat strip |

The manual controls work at any point: pick a **Caller ID**, click **Answer a call**, type
your own caller line, press keypad **\*** or **0**, send **Silence** or **Hang up**, move the
clock from the chip in the header, or **Take the feed down**. Use them for "what if…?"
questions, then press a beat number to get back on script.

---

## 1 — What's corn paying? *(~75s)*

Before you press anything, point at the empty console.

> "Many bid lines are a recording that someone re-records every morning. Here Dale asks in
> his own words, and hears today's number."

> "Every call opens with the same disclosure and the co-op's disclaimer: bids change, so
> confirm before selling."

**→** Dale Meyer calls the bid line: *"Contoso Grain Co-op bid line. I'm an automated
assistant. Bids are subject to change without notice. Confirm with the merchandiser before
selling. Which commodity and location?"*

> "The model only hears the commodity and the location. The price, the basis and the “as
> of” time come from the server, word for word."

**→** *"What's corn paying at Riverside?"* — *"Corn at Riverside for November delivery is
$4.12, that's 35 under December futures, as of 10:42 AM."* The price card shows **$4.12**
with a **live** badge; the facts show the basis, the December futures and their last
trade, the "as of" time and its age, and the source. The gauge shows the futures are a few
minutes old, well inside the 20-minute window.

> "A follow-up keeps the location: soybeans at Riverside, from the same bid sheet."

**→** *"And beans?"* — soybeans at Riverside, **$10.11**, 18 under November futures, as of
10:41 AM.

**→** *"That's all, thanks."* The agent says goodbye and the call ends.

> "Point at the price card: cash bid, basis against the futures month, the “as of” time
> and the source. The agent read that sentence; it didn't write the number."

## 2 — Not sure? Ask *(~75s)*

> "A wrong price is worse than no price. When a request is unclear, the agent asks one
> short question instead of guessing."

**→** An unknown number calls.

> "Fairview posts corn, soybeans and wheat. No commodity means no number, just one
> question."

**→** *"What's the bid at Fairview?"* — *"Which commodity at Fairview — corn, soybeans, or
wheat?"* The price card says **No number yet**, and the decision reads **No commodity
given**.

> "The answer fills only the gap the agent asked about. Fairview is kept."

**→** *"Wheat."* — wheat at Fairview, **$5.17** for September delivery, 55 under September
futures.

> "“River” matches two locations, Riverbend and Riverside. The server won't pick one for
> the caller."

**→** *"And corn at the river elevator?"* — *"Did you mean Riverbend or Riverside?"* The
decision reads **Two locations match**, and both are highlighted in the merchandiser list.

**→** *"Riverbend."* — corn at Riverbend, **$4.16**, 31 under December futures.
**→** *"That's all, thanks."*

> "Two clarifying questions, no guesses. Both are in the decision trail and in the
> metrics."

## 3 — Stale price, honest caveat *(~90s)*

> "Prices age. The server decides whether a number may be called current, from the futures
> timestamp and the market hours, not the model."

**→** An unknown number calls.

> "At 10:45 the soybean futures are 4 minutes old, inside the 20-minute window, so the
> quote is live."

**→** *"Soybeans at Riverside?"* — **$10.11**, as of 10:41 AM, **live**.

> "At 11:20 the soybean futures are 39 minutes old, past the 20-minute window. Watch the
> freshness gauge when the caller asks again."

**→** The clock in the header moves to **11:20 AM**.

> "A repeat is never a replay. The server re-checks first, and the same number now comes
> with a caveat."

**→** *"Say that again?"* — the same $10.11, then *"These prices may be delayed."* The gauge
is past the window, the badge says **may be delayed**, and the decision reads **Delayed —
quoted with a caveat**.

> "The futures market closed at 1:20, so there is no live price at all."

**→** The clock moves to **2:00 PM**, after the close.

> "After the close the agent quotes the last settlement and says so. It never calls it
> current."

**→** *"Repeat that, please."* — *"As of the last close, soybeans at Riverside for November
delivery were $10.05, that's 18 under November futures."* The decision reads **Market
closed — last settlement only**. **→** The caller hangs up.

> "Live, delayed with a caveat, last close: three answers to one question, each decided by
> policy code. The trail shows why each time."

## 4 — Feed down: no number *(~60s)*

> "What happens when the pricing feed goes down? The worst possible answer is a confident,
> made-up number."

> "A simulation-only switch: from now on every read from the feed fails."

**→** The price feed goes down. The **Price feed** line in the quote panel turns red.

**→** Rosa Alvarez calls.

> "No feed, no number. The agent says so plainly and offers a person now, or a callback."

**→** *"Wheat at Lake Mills?"* — *"Pricing data is unavailable right now, so I can't give
you a price. I can connect you with the Lake Mills merchandiser now, or have them call you
back. Which would you like?"* The price card says **No price**: nothing was quoted.

> "Rosa's caller ID makes a callback possible, so the request is logged for the Lake Mills
> merchandiser."

**→** *"Have them call me back."* — *"I've asked the Lake Mills merchandiser to call you
back at the number ending 12."* The merchandiser panel shows a callback card, **Call back:
wheat – Lake Mills**, rather than a ringing call, and there are no VoIP headers because
nothing was transferred.

**→** The price feed comes back up.

> "No number was invented. The callback request, with what Rosa asked about, is in the
> audit log for the merchandiser."

## 5 — Lock it in? A person *(~75s)*

> "Reading a bid is fine. Advising on it, or locking it in, is a merchandiser's job, and
> the agent knows the difference."

**→** Dale calls back.

> "A specific delivery month, straight from the posted bids."

**→** *"Corn at Riverside for December?"* — **$4.14**, 33 under December futures, as of
10:42 AM.

> "That's a request for advice. The agent declines and points to the merchandiser."

**→** *"Should I lock that in now, or wait?"* — *"I can't advise on that, but the
merchandiser can talk it through with you."* The price card is tagged **no advice given**.

> "Contracting is a hard stop. Nothing is locked: the call goes to a person, with the
> context."

**→** *"Okay, lock in 5,000 bushels at that price."* — *"I can't lock in or book a price on
this line — only a merchandiser can. Connecting you with the Riverside merchandiser now."*
The decision reads **Only a merchandiser can lock a price**. Move to **What the
merchandiser sees**: the Teams toast reads **Lock a price: corn – Riverside**, with Dale's
last quote, his own words and the reason, tagged **nothing locked**.

> "Every quote, caveat, refusal and handoff came from the same audit log."

**→** The metrics come up. After a run from **Reset demo**: 5 calls, 8 quotes given, 2
clarifying questions, 1 delayed-price caveat, 1 last-close quote, 1 feed-down refusal, 1
advice declined, 1 lock / book declined, 1 handoff and 1 callback.

> "The merchandiser's Teams client rings with what Dale wants, his last quote and why he
> was handed over. The same context travels in the VoIP headers."

Point at **VoIP headers on the wire**: `CallDetails.CallTopic`, `CallDetails.CallContext`,
`CallDetails.LocationId` and `CallDetails.TransferReason: contract_request`, exactly as the
transfer sends them.

---

## If something goes wrong

- **A beat went sideways.** Press its number. The beat brings the feed up, resets its clock
  and answers a fresh call, so it re-runs from the top.
- **Everything looks wrong.** **Reset demo**, then **1**.
- **A quote came out delayed or as a last close when it shouldn't have.** Look at the clock
  chip in the header. A beat sets it, but a manual preset you chose in between stays until
  the next beat starts or you press **Reset demo**.
- **"Pricing data is unavailable" in the wrong beat.** The feed is still down from a manual
  test. Click **Bring the feed back**, or press the beat's number.
- **No sound.** Check the voice menu, and that the URL has `?voices=online` in Edge. Or just
  narrate — the voices are a presenter aid, not part of the product.

## Taking a real call

With Azure configured (see the README, "Connecting it to a real phone number"), the chip
says **live · Teams Phone** and the console follows a real call to the Teams Phone number
whenever it isn't showing a scripted one: dial it, and the transcript, quote, Teams toast
and trail fill in from the real call, with the room voice muted. The demo clock is real
time, the price feed can't be taken down, and **Reset demo** is off. The scripted beats
still run as simulated calls, and a simulated call is never transferred for real, but they
can't move the clock or take the feed down either, so beats 3 and 4 won't show what this
script describes. Present the beats from a simulation-mode server, and keep the live one
for the real call.

The fixture prices are dated Tuesday, September 8, 2026, so on a live call the agent quotes
them as the last close. Connect a real price source before you dial in front of an
audience.

## If someone asks

**"Is this actually running Azure?"**
Not right now — it's in simulation mode, so no Azure service is in the loop. Set three
environment variables, provision the Teams Phone number as the README describes, and the
same server answers it through Teams Phone extensibility, with Azure Communication
Services Call Automation as the media bridge and the Voice Live API for speech. In
simulation the model, the audio and the Teams transfer are stand-ins; every price, caveat,
refusal and handoff decision you just watched came from the server code a real call runs.

**"Could the model just make up a price?"**
The model never works a price out. Its tools take the commodity and the location the
caller said and return the sentence to read, word for word. Raw prices, the basis and the
Teams targets stay on the server, and the tests check that. When the feed is down, the tool
returns no number at all, and the instructions forbid inventing one.

**"How is the context actually delivered?"**
VoIP custom headers on the transfer. Not SIP headers — those are a PSTN-side mechanism and
never reach a Teams identifier, so the call would connect and the merchandiser would still
answer blind.

**"How do I add a location, or change the freshness window?"**
A location is one JSON object in `config/locations.json` (aliases, hours and the
merchandiser's Teams object ID) plus its rows in `config/bids.json`. The location list the
model sees is generated from `locations.json`. The 20-minute window and the 240-minute hard
limit are `FUTURES_STALE_MINUTES` and `FUTURES_HARD_LIMIT_MINUTES` in `.env`. That is a
business decision, so it lives where the business can change it, not inside a prompt.

**"What would a developer change first?"**
The price source: the fixture feed in `src/pricing.mjs` reads JSON files, and a licensed
market-data feed goes in its place. Then the locations and merchandisers, then the beats in
`public/beats.js` if you want to demo your own bids.

**"Where does this break?"**
Speech recognition on local place names. A name that isn't clear gets a question, but a
misheard name that matches a different location gets that location's price, which is why
every quote says the location back. Aliases in `locations.json` help. Caller ID is only
used to offer a callback, never as identity, because it can be spoofed. And a callback
request is only logged: how it reaches the merchandiser is up to your deployment.
