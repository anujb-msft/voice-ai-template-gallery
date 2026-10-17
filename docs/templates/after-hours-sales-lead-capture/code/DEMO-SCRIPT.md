# Demo script — 6 beats, about 7 minutes

A rehearsable running order for the after-hours sales lead capture agent at Contoso
Industrial Supply, a fictional distributor of fasteners, fittings and packaging. Every beat
runs in **simulation mode**, so no Azure subscription, phone number or Teams tenant is
needed, and nothing on stage depends on a network.

The beats: **1** after hours, a hot lead is captured · **2** in sales hours, straight to a
person · **3** the callback number is read back and corrected · **4** a support call stays
out of the pipeline · **5** hot and urgent, so the on-call rep is paged · **6** after on-call
cover ends, the morning queue, then the numbers.

The argument you are making is *not* "a model can fill in a form". Everyone believes that
already. It is: **the server, not the model, decides whether the assistant answers at all,
whether a callback number is good enough to save, and whether a lead is worth interrupting
someone's evening for.** The clock decides the first, the caller decides the second, and a
written policy decides the third.

The console drives itself. Each press of **→** runs one step of the script and types (and,
if you like, speaks) the caller's line, so your hands are free and your eyes are on the room.
The quoted lines below are the narration the console shows under the beat strip, word for
word; the text around them says what to point at.

---

## Set up — five minutes before

```bash
npm install
npm start                          # http://127.0.0.1:8093
curl -s 127.0.0.1:8093/health      # expect "mode": "simulation"
```

- [ ] Open **Microsoft Edge** at `http://127.0.0.1:8093/?voices=online`. Edge's online
      voices are the Azure neural voices, so the room *hears* a voice product. Without
      `?voices=online` the console uses on-device voices only and nothing leaves the machine.
- [ ] Set the voice menu (top right) to **Speak agent + caller**, or **Speak agent** if you
      would rather read the caller's lines yourself.
- [ ] Zoom to **125%** (Ctrl and +) and press **F11**. The beat strip should fit on one line;
      if it can't, it shows just the current beat.
- [ ] Press **Reset demo**: no calls, no leads and zeroed metrics. Every beat sets the clock
      it needs, so the time of day you present at doesn't matter.
- [ ] Run beat 1 once to wake the voices, then press **Reset demo** again. A beat run twice
      without a reset is a repeat call from the same number, so its lead is merged into the
      first one, and that isn't the story beat 1 tells.

The chip in the top-right corner must say **simulation mode**. If it says **live · Teams
Phone**, this server found Azure settings in `.env`, and the demo clock and reset are
switched off so they can't affect real calls. Start it with `PUBLIC_BASE_URL= npm start` to
force simulation (an empty variable wins over `.env`), on another `PORT` if the live server
is still running.

Next to the voice menu is the **demo clock**: the time the server's sales-hours and on-call
rules see, for example *Wed 7:30 PM PDT*. Every beat sets it for you. Its buttons —
**Business hours** (10:30 AM), **After hours** (7:30 PM) and **Late night** (10:30 PM), all
on Wednesday, September 2, 2026, and **Real time** — are there for "what if…?" questions.
Sales is open 8 AM to 6 PM on weekdays, and Ben Ortiz is on call until 9 PM; the rules list
under **Lead and routing decision** follows the clock.

### Driving it

| Key | What it does |
| --- | --- |
| **→**, **PageDown** or a presenter clicker | Run the next step |
| **Auto-play** | Run the rest of the current beat |
| **1**–**6** | Jump to a beat. Each beat sets the clock and answers its own call, so beats run in any order |
| **PageUp** | Back to the start of this beat; press again for the previous beat |
| **Esc** | Stop auto-play and the voices |
| **N** | Show or hide the narration under the beat strip |

The manual controls work at any point: choose a **Caller ID** and press **Answer a call**,
type what the caller says, press **0** on the keypad to ask for a person, send **Silence** or
**Hang up**, or, while the on-call rep is being paged, **Simulate no answer**. Use them for
"what if…?" questions, then press a beat number to get back on script. Call as **Pat Kim**:
Pat's beat never saves a lead, so nothing you try is merged into one of the beats' leads.
Three that work well on the **After hours** clock:

| Type or press | What happens |
| --- | --- |
| *How much do 5,000 hex bolts cost?* | No price: the agent says it can't quote that, notes the question for the rep, and carries on qualifying |
| *Hi, are you hiring? I'd like to apply for a job.* | A pointer to the careers page, and no lead |
| **Silence**, three times | Two prompts to try again, then a polite goodbye, and a partial lead saved from the caller ID, marked as not read back |

---

## 1 — After hours: capture *(~90s)*

Before you press anything, point at the empty console.

> "7:30 on a Wednesday evening, and the sales team has gone home. Without this, a buyer with
> a big order gets voicemail, and maybe calls a competitor next."

**→** The clock jumps to **Wed 7:30 PM**, and Dana Morgan calls from Northwind Traders.
The rules show sales **closed**, so the server lets the assistant answer, and its first
sentence says it's automated.

> "The server checked the sales hours, not the model: sales is closed, so the assistant
> answered and said up front that it's automated. Now watch the lead panel. One sentence
> fills in most of the lead, and each answer is scored in plain English."

**→** *"Hi, this is Dana Morgan from Northwind Traders. We need about 12,000 hex bolts by
the end of the month."* Point at **Why this score**: hex bolts are a catalog line, *12,000
meets the 5,000 minimum order*, and *"by the end of the month" is within 30 days*. That's
6 of 8 already, and hot starts at 6. The agent asks the one thing still missing: who signs
off on the order.

> "A decision maker makes it 8 of 8. Before anything is saved, the agent reads back the
> callback number."

**→** *"Yes, I'm the purchasing manager, so it's my call."* The gauge reaches **8 of 8**. The
agent reads back the caller ID, *425-555-0193*, and the decision panel says nothing is saved
until it's confirmed.

> "Confirmed, so the server saves the lead, assigns an owner and sets the callback deadline."

**→** *"Yes, that's the best number."* **Lead saved — HOT**: Ava Chen owns it and calls back
by Thursday 9 AM. Move to **What the sales team sees in Teams**: the follow-up message for
Ava, with the sales manager, Jordan Lee, @-mentioned.

> "A hot lead with an owner and a callback due within an hour of opening. The Teams panel
> shows the follow-up message, with the sales manager @-mentioned. Nobody was paged: hot
> isn't the same as urgent."

## 2 — Business hours: straight to sales *(~40s)*

> "Same server, 10:30 on the same Wednesday morning: only the clock changed. Sales is open,
> so the server sends the caller straight to the sales queue, and the assistant stays out of
> the way."

**→** The clock jumps to **Wed 10:30 AM** and the rules show sales **open**. Pat Kim calls,
and the call goes straight to the **Contoso Industrial Supply Sales Queue**. The assistant
never speaks, and nothing is scored.

> "No questions and no capture: a person answers. The Teams toast says it's an in-hours
> sales call, with the caller ID flagged as not verified, and the VoIP headers carry that
> context."

Point at **VoIP headers on the wire**: `CallDetails.CallTopic` is *Sales inquiry*, and
`CallDetails.RouteId` is *sales*.

## 3 — Read back, corrected *(~75s)*

> "Back to the evening. A lead is only worth something if you can call it back, so the agent
> reads the number back before it saves anything."

**→** The clock goes back to **7:30 PM**, and Casey Quinn calls from Fabrikam's front desk
line.

> "200 is below the 250 minimum order for fittings. The agent doesn't argue, and the score
> shows why: no points for quantity."

**→** *"Hi, this is Casey Quinn with Fabrikam. We're looking at about 200 brass fittings next
quarter."* **Quantity** scores 0 of 2: *200 is below the 250 minimum order*. The agent
mentions the minimum once, says the rep can go over the options, and moves on.

> "An influencer, not the decision maker. Now the read-back, and the caller ID is Fabrikam's
> front desk."

**→** *"Not me, I'm the maintenance engineer. I recommend what we buy."* **Decision role**
scores 1 of 2, and the gauge settles on **4 of 8**: warm. The agent reads back the caller ID,
*425-555-0128*.

> "Casey corrects it. The new number gets read back too: the server won't save a callback
> number nobody has confirmed."

**→** *"No, that's the front desk. Please use my mobile, 425-555-0147."* The transcript notes
**Callback number corrected: 425-555-0128 → 425-555-0147**, and the agent reads the new
number back: *"Got it: 425-555-0147. Did I get that right?"*

> "Only now is the lead saved, with the corrected number."

**→** *"Yes, that's right."* **Lead saved — WARM**, owned by Ben Ortiz. Point at the
**Callback** row of the lead record: *425-555-0147 · corrected from 425-555-0128, then read
back and confirmed*.

> "A warm lead, 4 of 8, with a callback by the next business day. The mobile number is the
> one saved, and the trail shows the correction."

## 4 — Not a sales call *(~30s)*

> "Not every after-hours call is a lead, and counting them as leads would bury the real
> ones."

**→** Lee Park calls.

> "An existing order is a support call. The agent says so politely and gives the support
> number and hours."

**→** *"Hi, I'm calling about an existing order. It was supposed to arrive today and it
hasn't."* The agent apologizes and gives the support line, *+1 425 555 0190*, with its
hours. The decision panel says **A support call, not a lead**, and nothing is scored.

> "No lead was created, so the sales pipeline stays clean. The call still counts, as not a
> sales call."

## 5 — Hot and urgent: page on call *(~90s)*

> "Some calls can't wait for the morning. Ben Ortiz is on call until 9 PM, and the policy
> decides when he's worth interrupting."

**→** At **7:30 PM**, Sam Rivera calls from Tailwind Traders. The rules show **On call: Ben
Ortiz**.

> "Hot, urgent, and asking for a person. The agent doesn't promise anyone yet: it notes the
> request and confirms the number first."

**→** *"This is Sam Rivera, operations director at Tailwind Traders. Our packaging line is
down and we need 2,000 cartons by tomorrow morning. Can I talk to someone tonight?"* One
sentence makes it **8 of 8**, and the trail shows *asked for a person*. The agent says it will
check who's available once the details are confirmed, and reads back *425-555-0162*.

> "Once the number is confirmed, the lead is saved. Hot and urgent, inside on-call hours: the
> server pages Ben in Teams while Sam stays on the line."

**→** *"Yes, that's my cell."* **Paging Ben Ortiz**: *hot and urgent → page on call*. The
agent asks Sam to stay on the line. The bar under the gauge counts down while Ben's Teams
rings, and the Teams panel shows the incoming call, tagged with the score, *after hours*,
*urgent* and *asked for a person*.

> "Ben sees who's calling, what they need and why he was paged before he says hello."

**→** **Ben picks up in Teams** when the countdown ends, about six seconds after the page
started: the toast says **Connected** and the call is handed over. Point at
`CallDetails.CallContext` under **VoIP headers on the wire**: the score, who Sam is, what
they need, why it's urgent, the confirmed callback number, and *Paged because: Hot and
urgent, and Ben Ortiz is on call until 9 PM*.

> "Ben has the lead, the urgency and the reason he was paged before he answers. The same
> reason is on the lead record for the morning."

## 6 — After cover ends: morning queue *(~75s)*

> "The same kind of call at 10:30 at night. On-call cover ended at 9."

**→** The clock jumps to **Wed 10:30 PM**: sales is closed, and the on-call rule says **no
cover**. Robin Diaz calls from Wide World Importers.

> "Urgent, and asking for a person, but nobody is on call. The agent won't promise a person
> it can't deliver."

**→** *"Hi, this is Robin Diaz, maintenance supervisor at Wide World Importers. Our conveyor
line is down and we need 6,000 lock nuts first thing tomorrow. Is anyone there tonight?"*
Hot again, 7 of 8: a maintenance supervisor recommends rather than signs off. The agent says
it will check who's available once the details are confirmed, and reads back
*425-555-0184*.

> "Hot, but not paged, and the reason is on screen and on the lead."

**→** *"Yes, that's the right number."* **Lead saved — HOT**: *no on-call cover → morning
queue*. The agent says plainly that no one is on call, and the **On call** row of the lead
record says why: *not paged — on-call cover ends at 9 PM, so it goes to the morning queue*.
The Teams message for Dana Brooks is tagged **not paged**.

> "Every call is counted: leads captured, qualified and routed for follow-up, live transfers,
> pages, and the calls that weren't sales at all."

**→** **Show the numbers.** Run in order from a reset, the six beats come to 6 calls, 4 leads
captured, 4 qualified (hot or warm), 4 routed for follow-up, 2 live transfers, 1 of 1
on-call pages answered, 1 call that wasn't sales, and no repeat calls merged.

> "Robin hears honestly that no one is on call, and the lead is in the morning queue, due
> within an hour of opening, with the reason attached. The numbers come from the lead store,
> just as they would in production."

---

## If something goes wrong

- **A beat went sideways.** Press its number. The beat sets its clock and answers a fresh
  call, so it runs from the top. If it had already saved a lead, the new call is a repeat
  call from the same number and its lead is merged into the earlier one: the dedupe rule at
  work, but not the beat's story. Press **Reset demo** first, then the beat's number.
- **Everything looks wrong.** **Reset demo** clears the simulated calls and leads, restores
  the starting clock and loads beat 1.
- **No sound.** Check the voice menu, and that the URL has `?voices=online` in Edge. Or just
  narrate — the voices are a presenter aid, not part of the product.
- **The paging bar didn't seem to move.** It counts down in script, not CSS, so it runs even
  when the PC asks for reduced motion (common over Remote Desktop). If you press → before Ben
  has picked up, the console waits for the handoff instead of cutting it off.
- **The numbers at the end don't match.** They count every call since the last reset,
  including your own "what if…?" calls and any re-runs.

## Taking a real call

With Azure configured (see the README, "Connecting it to a real phone number"), the chip
says **live · Teams Phone** and the console follows a real call to the Teams Phone number
whenever it isn't showing a scripted one: dial it, and the transcript, lead panel, Teams
panel and trail fill in from the real call, with the room voice muted. On a real call the
lead panel fills in when the agent first tries to save the lead, just before the read-back,
rather than sentence by sentence.

A live server always decides on the real time: the demo clock stays on real time, **Reset
demo** is off, and a call in sales hours goes straight to the sales queue, as in beat 2. To
take a capture call during the day, change the sales hours in `config/hours.json` and
restart. The scripted beats still run as simulated calls, which are never transferred or
paged for real, but on the real clock, so present the script from a simulation-mode server
and keep the live one for the real call.

## If someone asks

**"Is this actually running Azure?"**
Not right now — it's in simulation mode, which is why it can't fail on stage. Configure
Azure and the same server answers a Teams Phone number through Teams Phone extensibility:
Azure Communication Services Call Automation answers the call and bridges its audio to the
Azure AI Voice Live API, and the handoffs go to the sales queue or the on-call rep in Teams.
The stand-ins are the agent (a scripted stand-in, `src/offline.mjs`, plays the model), the
audio, and the Teams side, which is a mock built from the real handoff and the real follow-up
message. Everything you watched decide — the hours, the score, the read-back, the owner, the
deadline and the page — is the real server code.

**"Does the follow-up message really reach Teams?"**
Not yet, live or simulated. Messages are written to an outbox (`GET /api/outbox`), and the
Teams panel shows the one for this call. Posting them to Teams, sending email or creating the
lead in your CRM is the integration you add; `TEAMS_WORKFLOW_URL` and `ACS_EMAIL_SENDER` are
reserved for it in `.env.example`.

**"How does the rep get the context?"**
VoIP custom headers on the transfer — `CallDetails.CallTopic`, `CallContext`, `RouteId` and
`AfterHours` — so Teams shows what the call is about before anyone says hello. Not SIP
headers: those belong to the PSTN side and never reach a Teams identifier, so the call would
connect and the rep would still answer blind.

**"Why not page the on-call rep for every hot lead?"**
Hot and urgent aren't the same thing. Dana's lead is worth a lot, but it can wait until the
morning, and nobody should be interrupted at home for a call that can wait. The policy pages
only inside on-call hours, and only for a hot lead that is urgent or a hot or warm caller
who asks for a person. The cover hours and the rep are in `config/hours.json`; the rule is
one function, `decidePage` in `src/policy.mjs`. When a caller was urgent or asked for a
person, the reason they were or weren't paged goes onto the lead and into the rep's message.

**"Does the model score the lead?"**
No. The model asks the questions and calls four tools. The server scores the answers against
`config/qualification.json` and the catalog's minimum orders, picks the owner in rotation,
sets the callback deadline and decides on paging; the model gets back only the lead id and
the follow-up promise to read out. It can't skip the read-back either: the server refuses to
save a callback number the caller hasn't confirmed.

**"What would a developer customize first?"**
The four files in `config/`: `hours.json` (sales hours, holidays, the support line, on-call
cover and the sales queue's Teams object ID), `reps.json` (who owns leads, and the manager to
@-mention), `qualification.json` (the points and the hot and warm thresholds) and
`catalog.json` (product lines and minimum orders). Then connect the outbox to your CRM and
to Teams.

**"Where does this break?"**
Caller ID isn't identity — it can be spoofed — which is why the in-hours toast says *not
verified* and why, after hours, the number is read back before it's saved. And on a live
call the conversation is the model's: the server enforces the read-back and scores what it's
given, but whether the caller is asked the right questions depends on the prompt and the
model.
