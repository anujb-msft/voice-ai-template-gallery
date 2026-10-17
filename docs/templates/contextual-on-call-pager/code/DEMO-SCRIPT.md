# Demo script — 5 beats, about 6 minutes

A rehearsable running order for the contextual on-call pager: the after-hours maintenance
line of Contoso Property Management, a fictional landlord. Every beat runs in **simulation
mode**, so no Azure subscription, phone number or Teams tenant is needed, and nothing on
stage depends on a network.

The argument you are making is *not* "a model can summarize a phone call". Everyone
believes that already. It is: **the server's paging policy decides who gets woken, when to
escalate and what a voicemail may hear — and the technician who picks up never has to call
the tenant back to ask "so what's wrong?"**

The console drives itself. Each press of **→** runs one step of the script and types (and,
if you like, speaks) the tenant's or the technician's line, so your hands are free and your
eyes are on the room.

---

## Set up — five minutes before

```bash
npm install
npm start                          # http://127.0.0.1:8095
curl -s 127.0.0.1:8095/health      # expect "mode":"simulation"
```

- [ ] Open **Microsoft Edge** at `http://127.0.0.1:8095/?voices=online`. Edge's online
      voices are Microsoft neural voices, and with `?voices=online` the voice menu (top
      right) starts on **Speak agent + caller**. Without it the console uses on-device
      voices only, and nothing leaves the machine.
- [ ] Choose **Speak agent** in the voice menu if you would rather read the tenant's and the
      technician's lines yourself.
- [ ] The console fits one screen at **1536 × 864** CSS pixels. On a 1920 × 1080 display at
      100% Windows scaling, zoom Edge to **125%** (Ctrl and +); if Windows already scales
      to 125%, leave Edge at 100%. Press **F11**.
- [ ] Press **Reset demo**: no calls, a clean audit trail, zeroed metrics, and the demo
      clock back on **Wed, 11:42 PM**. Every beat sets the clock it needs, so the time of
      day you present at doesn't matter.
- [ ] Run beat 1 once to wake the voices, then press **Reset demo** again.

The chip in the top-right corner must say **simulation mode**. If it says **live · Teams
Phone**, this server found Azure settings in `.env`, and the demo clock and **Reset demo**
are switched off so they can't affect real calls. Start it with `PUBLIC_BASE_URL= npm start`
to force simulation (an empty variable wins over `.env`), on another `PORT` if the live
server is still running.

### Driving it

| Key | What it does |
| --- | --- |
| **→**, **PageDown** or a presenter clicker | Run the next step. When a beat ends the button says **Next beat ▶**: the next press loads that beat — its clock and its narration — and the press after it answers the beat's call |
| **Auto-play** | Run the rest of the current beat |
| **1**–**5** | Jump to a beat. Each beat sets the clock and answers its own call, so any beat re-runs cleanly, in any order |
| **PageUp** | Back to the start of this beat; press again for the previous beat |
| **Esc** | Stop auto-play and the voices |
| **N** | Show or hide the narration under the beat strip |

The manual controls work at any point. Pick a **Caller ID** and press **Answer a call**,
then type what the tenant says — or, once a page is ringing, what the technician says. The
keypad has **1** accept, **2** decline, **3** talk to the tenant and **\*** repeat for the
technician, and **0** for a tenant who wants a person. **Silence** while a page rings counts
as no answer, **Voicemail picks up** sends the page to voicemail, and **Skip to the next
page** moves the demo clock to the moment the next page is due. The presets next to the
clock — **Weeknight on call**, **Swap night**, **Weekend** and **Real time** — change who is
on call. Use them for "what if…?" questions, then press a beat number to get back on script.

---

## 1 — Leak at midnight *(~75s)*

Before you press anything, point at **Who's on call now**: Morgan Lee for Maple Court and
Omar Diaz for Pine Terrace, each with the reason — the rotation and when it started.

> "It's 11:42 on a Wednesday night and water is coming through a tenant's ceiling. Every
> after-hours line fails in one of two ways. It wakes the wrong person, or it wakes the
> right person with no idea what's going on — so the first thing they do is call the
> tenant back and ask 'so what's wrong?'"

**→** Alice Rivera calls. Her caller ID matches her lease, so the agent knows her building.
The greeting says it's an automated assistant and gives the 911 line before anything else.

**→** *"Water is pouring through my kitchen ceiling and it's spreading fast."* The decision
panel says **Active leak — urgent**: "ceiling" matches the active leak rule.

> "The agent listened and filled in fields — what, where, how bad. It didn't decide this
> is urgent. The server did, from triage rules in a JSON file: keywords and one temperature
> line."

**→** *"Yes, 4B. You can go in — the spare key is in the lockbox by the back door."* Unit
confirmed, permission to enter, where the key is. The agent reads back only the last four
digits of the callback number.

**→** *"Yes, that's my cell."* That's everything the page needs, and Morgan's phone rings.
The right-hand card becomes **What the technician sees**: **Active leak · Maple Court 4B**,
**URGENT**, **MAY ENTER**.

**→** *"Morgan Lee here."* Morgan hears the brief:

> *Urgent: active leak at Maple Court, unit 4B, reported 11:42 PM. Tenant said: Water is
> pouring through my kitchen ceiling and it's spreading fast. You may enter. Access: The
> spare key is in the lockbox by the back door.*

This is the most important sentence in the demo:

> "That brief isn't the model improvising. The server wrote it from the captured fields,
> so it says the same thing every time, and it never contains a phone number. The model
> doesn't choose who gets paged and never sees the technician's number — the server dials
> from the on-call roster."

**→** *"I've got it — on my way."* **Morgan Lee has it.** The retries and the ops alert are
canceled, and the agent calls Alice back to say so. Point at **VoIP headers — Teams Phone
custom calling context**: the same facts in the form a page to Morgan's Teams client carries.

> "Morgan never had to call Alice to ask what's wrong. The context traveled with the page."

## 2 — Nobody answers *(~75s)*

**→** loads the beat; it's still Wednesday night. **→** Dee Nguyen calls. Pine Terrace is on
the north rotation, so this page goes to Omar Diaz, not Morgan.

**→** *"The heat is out in unit 11 at Pine Terrace and it's 52 degrees in here. You can let
yourself in."* The gauge puts **52°F** below the **55°F** no-heat line: urgent.

> "Is no heat worth waking someone? That's a business decision, so it's a number in
> config — not a judgment call the model makes at midnight."

**→** *"Yes."* Omar's phone rings. **→** Omar doesn't pick up. The policy schedules attempt 2
of 2 in 3 minutes, and the countdown under the gauge starts.

> "That countdown is the server's timer, not an animation. Nobody waits three minutes on
> stage, so watch me skip ahead."

**→** The demo clock jumps 3 minutes and the scheduler sends the retry. **→** Omar still
doesn't answer: **Escalating to Priya Shah** — *Omar Diaz didn't answer 2 attempts.
Escalating to the secondary, Priya Shah, in 3 min.*

**→** Another 3 minutes. Priya's phone rings with the same brief, flagged **ESCALATED ·
SECONDARY**. **→** *"Priya Shah here."* **→** *"I've got it."* Acknowledged about six minutes
after the report, on page 3, and the 20-minute ops alert is canceled.

> "Two tries, then the secondary, then the property manager. The gaps and the levels are
> policy in a config file, not prompt text — and every page carried the same context."

## 3 — Voicemail keeps it private *(~60s)*

**→** loads the beat: the clock jumps to **Thu, 11:10 PM**. Point at **Who's on call now**:
**Swap override for Thu, Oct 1 — replaces the central rotation**. Priya swapped shifts with
Morgan, so tonight she covers Maple Court.

**→** Ben Carter calls. **→** *"I'm locked out of my apartment and my keys are inside."* A
lockout is urgent. **→** *"Yes, 2A. I'm waiting in the lobby by the front door."* No
permission to enter: he's outside. **→** *"Yes."* The page goes to Priya, from the override.

**→** Priya's phone goes to voicemail. The agent leaves this, and only this:

> *Contoso maintenance has an urgent page for you. Please call the maintenance line.
> Reference* — four digits, read one at a time.

Point at **Left on voicemail** and the line under it: **Left out: property, unit, problem,
tenant's words, access details, phone numbers**.

> "A voicemail box can be shared, or played on speaker in a kitchen. So it hears a callback
> prompt and a reference number, and nothing else. The reference means something only to
> the maintenance line."

Priya's second attempt is scheduled 3 minutes out. Moving to the next beat cancels it:
every beat starts clean.

## 4 — Not worth waking anyone *(~45s)*

**→** loads the beat: **Sat, 10:15 PM**. **→** Grace Kim calls from Pine Terrace.

**→** *"The heat is out in my bedroom, but it's about 64 degrees inside."* The gauge puts
**64°F** above the 55°F line: routine.

**→** *"Yes, unit 7. You can go in, I'm home all weekend."* The agent still takes everything
down, so the work order is complete. **→** *"Yes."* The decision panel says **A work order,
not a page**, and Grace hears that the office will follow up Monday morning — and to call
back if it drops to 55 degrees or below.

> "Nobody's phone rang. The same policy that escalated Dee's call so hard decided this one
> can wait until Monday, and it told Grace exactly what happens next."

## 5 — Questions, not phone numbers *(~60s)*

**→** loads the beat: back to Wednesday night. **→** Ben calls again.

**→** *"No power in unit 2A at Maple Court since the storm. You can go in, and please call
me back on this number."* What, where, access and callback in one sentence. The agent
doesn't ask again for what it already has, and pages Morgan.

**→** *"Morgan here."* **→** *"What's the tenant's phone number?"* The decision panel says
**Phone numbers stay on the server**, and the agent answers: *"I can't share phone numbers.
Press 3 and I'll connect you to the tenant."*

**→** Morgan presses **3**: *"Connecting you to Ben now — neither of you will see the other's
number."*

> "The technician can ask about anything the agent captured — except a phone number. The
> server connects them instead, so neither number ever leaves it."

**→** **Show the numbers.** The metrics footer: after a clean run from **Reset demo**, 5
incidents, 6 pages, 3 acknowledged, 1 escalation, 1 voicemail and 1 work order. The median
time to acknowledge depends on your pace.

> "Pages, acknowledgements, escalations, time to acknowledge. Those come out of the same
> audit trail you've been watching, not a separate analytics pipeline."

---

## If something goes wrong

- **A beat went sideways.** Press its number. The beat resets its clock and answers a fresh
  call, which cancels the old call's pending pages.
- **Everything looks wrong.** **Reset demo**, then **1**.
- **No sound.** Check the voice menu, and that the URL has `?voices=online` in Edge. Or just
  narrate — the voices are a presenter aid, not part of the product.
- **The countdown didn't seem to move.** It counts down in script from the server's due
  time, not in CSS, so it runs even when the PC asks for reduced motion (common over Remote
  Desktop). After **Skip to the next page** part-way through a wait, it restarts at full
  width for the time that's left.
- **The metrics look high.** They count everything since the last **Reset demo**, including
  your "what if…?" calls.
- **The agent didn't follow an ad-libbed line.** The offline stand-in for the model knows
  demo-like phrasing only. The beat lines always work; for questions from the room, use the
  phrases in the README's flow table.

## Taking a real call

With Azure configured (see the README, "Connecting it to a real phone number"), the chip
says **live · Teams Phone** and the console follows a real call whenever it isn't showing a
scripted one: call the Teams Phone number, and the transcript, decision, technician card and
trail fill in from the real call, with the room voice muted. A real page rings a real
technician's phone, so warn whoever is on call. The demo clock is real time, and **Reset
demo** and the presets are off. The scripted beats still run as simulated calls — they never
dial, post a card or call anyone back — but on the real clock, so who's on call may differ
from the script.

## If someone asks

**"Is this actually running Azure?"**
Not right now — it's in simulation mode, which is why it can't fail on stage. Configure ACS,
a public URL and Voice Live, and the same server answers a Teams Phone number through Teams
Phone extensibility, with the Azure AI Voice Live API for speech and Azure Communication
Services Call Automation for the calls and the pages. The agent's words and the audio path
are the only stand-ins; the triage, the rotation, the escalation timers, the brief and the
voicemail prompt you just watched are the real code.

**"How does the technician get the context?"**
Twice. The brief is spoken on the page, and the same facts go to Teams as a card through a
Teams Workflows webhook. The VoIP headers on screen are Teams Phone custom calling context:
what a page to the technician's Teams client carries. A page to a mobile number goes over
the phone network, where those headers don't exist — which is why the brief is spoken.

**"Who decides it's urgent — the model?"**
No. `config/triage.json` does: keyword groups and a temperature line. The model records what
the tenant said; it has no tool that sets the severity.

**"What if the technician says no?"**
Pressing **2**, or saying so, escalates to the next level at once — no waiting out the gap.

**"What about real emergencies?"**
A gas smell, smoke, fire, carbon monoxide or an injury gets the 911 line first, then an
emergency page with a 1-minute gap between attempts. This is a maintenance pager, not an
emergency dispatch service.

**"How do I change who's on call?"**
`config/oncall.json` holds the rotations, with start dates, and dated overrides like the
swap in beat 3. `config/escalation.json` holds the levels, the attempts and the gaps.

**"Where does this break?"**
Caller ID isn't authentication: it pre-fills the unit, and the agent still confirms it. On a
real call, voicemail detection is the model following an instruction — it waits for a person
to speak before reading the brief — not a server guarantee; the console shows the server's
path once voicemail is detected. And pages present the caller ID set in
`ACS_OUTBOUND_CALLER_ID`, not the Teams service number: placing them from the Teams resource
account isn't wired up yet, and the README links the quickstart that does it.
