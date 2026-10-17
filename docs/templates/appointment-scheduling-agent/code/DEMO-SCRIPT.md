# Demo script — 5 beats, about 6 minutes

A rehearsable running order for the appointment scheduling agent: booked in one call, "just
book whatever", taken mid-call, needs a referral, and identity fails, ending on the metrics.
Every beat runs in **simulation mode**, so no Azure subscription, phone number or Teams
tenant is needed, and nothing on stage depends on a network.

The argument you are making is *not* "a model can book an appointment". Everyone believes
that already. It is: **the model talks and proposes; the server decides what gets written.**
No tool the model can call books anything. Only the caller's own yes to the time that was
just read back writes it, and if that time is taken in the meantime, the caller picks again
and says yes again. The server never quietly books a different time.

The console drives itself. Each press of **→** runs one step of the script and types (and,
if you like, speaks) the caller's line, so your hands are free and your eyes are on the room.

---

## Set up — five minutes before

```bash
npm install
npm run rehearse                   # every beat, three ways, on its own server (~2 min)
npm start                          # http://127.0.0.1:8100
curl -s 127.0.0.1:8100/health      # expect "mode": "simulation" and "reseededByReset": true
```

`npm run rehearse` plays the script the way the console does and fails if any beat would
land somewhere this page doesn't say. It runs its own server on port 8300 with the shipped
settings (not your `.env`), so it can run while your demo server is up.

- [ ] Open **Microsoft Edge** at `http://127.0.0.1:8100/?voices=online`. Edge's online
      voices are the Azure neural voices, so the room *hears* a voice product. Without
      `?voices=online` the console uses on-device voices only and nothing leaves the machine.
- [ ] Set the voice menu (top right) to **Speak agent + caller**, or **Speak agent** if you
      would rather read the caller's lines yourself.
- [ ] Zoom to **125%** (Ctrl and +) and press **F11**. The beat strip should fit on one line.
- [ ] Press **Reset demo**: the seeded schedule is back, there are no calls, the metrics are
      zero and the clock reads **Tue 9:50 AM**. Every beat sets the clock it needs, so the
      time of day you present at doesn't matter.
- [ ] Run beat 1 once to wake the voices, then press **Reset demo** again. Beat 1 resets the
      demo itself, so a run from the top offers the same times and ends on the same numbers.

The chip in the top-right corner must say **simulation mode**. If it says **live · Teams
Phone**, this server found Azure settings in `.env`, and it refuses simulated calls and the
demo controls, because their bookings would land in the real schedule. Start a simulation
copy instead; an empty variable wins over `.env`:

```bash
PUBLIC_BASE_URL= SCHEDULE_DB_PATH= DB_PATH=:memory: PORT=8101 npm start
```

That keeps the demo's schedule and metrics in memory, apart from the live server's files.

### Driving it

| Key | What it does |
| --- | --- |
| **→**, **PageDown** or a presenter clicker | Run the next step |
| **Auto-play** | Run the rest of the current beat |
| **1**–**5** | Jump to a beat. Each beat sets the clock and answers its own call, so any beat re-runs cleanly, in any order |
| **PageUp** | Back to the start of this beat; press again for the previous beat |
| **Esc** | Stop auto-play and the voices |
| **N** | Show or hide the narration under the beat strip |

The manual controls work at any point: pick a **Caller ID** and **Answer a call**, type your
own caller line, press a keypad key (**1** yes, **2** no, **0** a person), send **Silence**
or **Hang up**, or use the **Demo** buttons, **Front desk books it** and **Model calls
“book”**. The clock in the header switches to **Fri 6:30 PM**, when every queue is closed:
ask for a person then and it becomes a callback. Use them for "what if…?" questions, then
press a beat number to get back on script.

---

## 1 — Booked in one call *(~90s)*

> "Tuesday morning at Contoso Health. Jordan says what's wrong in plain words; the agent
> finds a time that fits, and the server checks four things before anything is written."

**→** Jordan Rivera calls the scheduling line. Caller ID matches a patient, but that isn't
proof. The agent asks for a name and date of birth and greets no one by name.

**→** *"Jordan Rivera, 03/12/1984"*. **Identity** goes green in the checklist. The date of
birth stays out of the transcript.

**→** *"I've had a cough for a week and I'd like to see my usual doctor, mornings if
possible."* A sick visit with Dr. Patel, mornings. The server searches and offers two times,
not ten: today at 11 a.m., or Thursday at 8:30 a.m. Nothing is held yet.

**→** *"The first one."* Now one time is held for five minutes and read back. That's the
active proposal, **P1**. Point at its cell in the **Availability** grid. Still nothing is
booked.

**→** *"Yes, please."* Jordan's own yes to the active proposal: the only thing that writes.

All four checks are green, the cell turns solid in the grid and the booking card shows the
confirmation number, **A-20440**. This is the most important sentence in the demo:

> "The model never called a booking tool. It doesn't have one. It found times and proposed
> one. My server checked that the caller is who they say, that the visit can be booked by
> voice, that this exact time is the one on the table, and that Jordan said yes to it. Only
> then did it write."

## 2 — “Just book whatever” *(~75s)*

> "Mia is in a hurry. The model would happily oblige. The server won't."

**→** Mia Chen calls. **→** *"Mia Chen, 02/18/1991"*. Verified.

**→** *"Just book me whatever you have."* No time has been read back, so there's nothing to
say yes to. The write is refused (**Refused — nothing to say yes to**) and the agent asks
what kind of visit she needs.

**→** *"A follow-up with Dr. Patel."* Two times offered.

**→** The model calls “book” anyway. Now the model itself reaches for a booking tool. There
isn't one, so the server refuses it. Watch the booking decision and the trail: **Refused —
the model has no booking tool**.

> "That step sends a tool call through the same dispatcher a live call uses. Whatever the
> model is talked into, by a confused caller or by a prompt injection, writing to the
> schedule isn't one of its tools."

**→** *"The second one."* A specific time, held and read back. **→** *"Yes."* Her yes to
that proposal is what writes it.

Two refused writes on the trail, and nothing booked until Mia said yes to a time she'd heard.
The model can suggest; the server books, and only on the caller's yes.

## 3 — Taken mid-call *(~90s)*

> "Two people want the same time. Avery is on the phone; the front desk is at a keyboard."

**→** Avery Stone calls. **→** *"Avery Stone, 06/09/1979"*. **→** *"A follow-up with Dr.
Patel, please."* **→** *"The first one."* P1 is held and read back: today at 11:30 a.m.
when you run from the top. Avery is about to say yes.

**→** The front desk books that time: the same action as the **Front desk books it**
button. The cell in the grid changes hands, and the transcript notes it. Avery hasn't been
told.

**→** *"Yes, book it."* Avery says yes, but the time is gone. The server refuses the write,
voids P1 and offers fresh times: **Taken mid-call — fresh pick, fresh yes**. It never moves a
yes to a different time.

> "The hold kept other voice callers off that time while Avery decided, but the front desk
> books through another channel, and it got there first. So the server checks again at the
> moment of the write. Moving Avery's yes to the next free time would be convenient, and
> it would be booking a time Avery never agreed to."

**→** *"The first one."* A fresh pick is a new proposal, **P2**. The earlier yes doesn't
count for it. **→** *"Yes."* A fresh yes to P2. Now it's written.

The trail shows the refused write and the fresh proposal; the booking card notes it was
booked **after a race — fresh pick, fresh yes**. No double booking, and no silent swap.

## 4 — Needs a referral *(~45s)*

> "Some visits can't be booked by voice. That's a rule in config, not the model's judgment."

**→** Jordan calls back. **→** *"Jordan Rivera, 03/12/1984"*.

**→** *"I'd like a skin check for a mole."* Dermatology needs a referral on file and there
isn't one. **Eligibility** goes red, and the server offers no times. The agent offers a
visit with Dr. Patel or the referral coordinator instead.

**→** *"Connect me with the referral coordinator."* A handoff to a person. Watch **What the
Teams agent sees**.

The referral coordinator's Teams client rings with the topic, **Scheduling – referral
needed**, and what's already checked: verified, a skin check, the rule that blocked it
(`REFERRAL_REQUIRED`). The same context rides in the **VoIP headers on the wire** underneath.

> "Nobody asks Jordan to start over. And notice what isn't there: no date of birth. Each
> destination has an allowlist of the fields that may leave the server."

## 5 — Identity fails *(~60s)*

> "Jordan's number again, but the date of birth doesn't match. Caller ID isn't identity."

**→** Someone calls from Jordan's number. **→** *"Jordan Rivera, 03/21/1984"*. No match.
One more try, and nothing about appointments is said either way.

**→** *"Jordan Rivera, 12/03/1984"*. A second miss. The agent stops asking and hands the call
to the scheduling team.

> "The agent doesn't say whether Jordan is a patient, doesn't hint at an upcoming
> appointment, and doesn't let the caller keep guessing. A miss sounds the same whether or
> not the patient exists. A person takes it from here."

The toast reads **Caller not verified** and carries no patient details.

**→** Show the numbers. Every call is audited: booked, writes refused, races resolved and
handoffs to a person. From the top, the strip reads **Calls 5 · Booked 3 · Refused writes
3 · Races resolved 1 · Handoffs to a person 2**, with one eligibility block and one identity
not confirmed.

> "The numbers come from the same audit log a real call writes to. Three writes refused, and
> every booking on the board is a time a caller heard and said yes to."

---

## If something goes wrong

- **A beat went sideways.** Press its number. The beat sets its clock and answers a fresh
  call, so it re-runs from the top.
- **The times differ from this script.** Beats run out of order, or without a reset, offer
  later times as earlier beats fill the schedule, but every beat still ends the same way.
  For the exact times above: **Reset demo**, then **1**.
- **Everything looks wrong.** **Reset demo**, then **1**.
- **Front desk books it is greyed out.** It needs a time on the table, so it lights up only
  once times have been offered, and never on a live server. In beat 3 its step comes right
  after *"The first one."*
- **You paused on a held time.** A hold lasts five minutes of real time (`HOLD_TTL_MS`).
  Stop for questions between *"The first one."* and the yes for longer than that, and the
  time is released and the caller hears fresh options. Press the beat's number to re-run it.
- **No sound.** Check the voice menu, and that the URL has `?voices=online` in Edge. Or just
  narrate: the voices are a presenter aid, not part of the product.

## Taking a real call

With Azure configured (see the README, "Connecting it to a real phone number"), the chip
says **live · Teams Phone**, and the console follows a real call to the Teams Phone number:
dial it, and the transcript, booking decision, checklist, availability grid, Teams toast and
trail fill in from the real call, with the room voice muted. The clock is real time, and
**Reset demo**, the clock presets and the **Demo** buttons are off.

The scripted beats don't run on a live server: a simulated call books into the schedule it
is given, so the server refuses simulated calls while it answers real ones. Run the beats
from a simulation copy on another port (see the mode chip above), and dial the real number
from the live one.

## If someone asks

**"Is this actually running Azure?"**
Not right now. It's in simulation mode, which is why nothing on stage depends on a network.
Set three environment variables and the identical state machine answers a Teams Phone number
through Teams Phone extensibility: Teams owns the number and the call queues, Azure
Communication Services Call Automation answers the call and bridges the media, and the Azure
AI Voice Live API does the listening and speaking. In simulation, a scripted stand-in plays
the model's part through the same tool dispatcher, and typed lines stand in for speech.
Every check, refusal and write you watched is the real server code.

**"What stops the model from booking anyway?"**
There's nothing to talk it into. Its tools can verify, search and hold a time, and that's
all. The write is a server function that runs only on the caller's own yes, or keypad 1, to
the active proposal, and it checks identity, eligibility and the proposal again at the
moment it writes.

**"How does the person on the other end get the context?"**
VoIP custom headers on the transfer: a session ID, a call topic and a JSON context, built
from an allowlist per destination. Not SIP headers: those are a PSTN-side mechanism and never
reach a Teams identifier, so the call would connect and the scheduler would still answer
blind.

**"What would I change first?"**
The policy is data. Visit types, referral and order rules, providers and their weekly
templates, and the handoff destinations with their Teams object IDs are JSON files in
`config/`. Then replace the SQLite schedule with your scheduling system behind the same
adapter. The README maps each call to FHIR R4, and the one rule to keep is that a time that's
gone comes back as `slot_taken` and is never swapped for another.

**"Where does this break?"**
Names and dates of birth are the hardest thing to hear over a phone line. A misheard date
counts as a miss, and two misses go to a person, which is the safe direction to fail. Caller
ID is never treated as identity, because it is worth nothing on a spoofed call.
