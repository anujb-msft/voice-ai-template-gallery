# Demo script — 6 beats, about 6 minutes

A rehearsable running order for the appointment reminder agent. Every beat runs in
**simulation mode**, so no Azure subscription, phone number or Teams tenant is needed, and
nothing on stage depends on a network.

**The beats:** 1 Confirmed in one call · 2 Cancel frees the slot · 3 New time → a person ·
4 Someone else answers · 5 Voicemail: callback only · 6 Too late to call, ending on the numbers.

The argument you are making is *not* "a model can make a phone call". Everyone believes
that already. It is: **the interesting part is what the agent may not say, and when it may
not call. The server decides both, not the model.**

The console drives itself. Each press of **→** runs one step of the script: it places the
reminder call, or types (and, if you like, speaks) the patient's line, so your hands are
free and your eyes are on the room.

---

## Set up — five minutes before

```bash
npm install
npm start                          # http://127.0.0.1:8099
curl -s 127.0.0.1:8099/health      # expect "mode": "simulation"
```

- [ ] Open **Microsoft Edge** at `http://127.0.0.1:8099/?voices=online`. Edge's online
      voices are the Azure neural voices, so the room *hears* a voice product. Without
      `?voices=online` the console uses on-device voices only and nothing leaves the machine.
- [ ] Set the voice menu (top right) to **Speak agent + caller**, or **Speak agent** if you
      would rather read the patient's lines yourself.
- [ ] Zoom to **125%** (Ctrl and +) and press **F11**. The beat strip should fit on one line.
- [ ] Press **Reset demo**: the seeded schedule, no calls, zeroed metrics, and the clock back
      at **2 days before · 10:00 AM**. Every beat sets the clock it needs and puts its
      patient's appointment back the way the seed has it, so the time of day you present at
      doesn't matter.
- [ ] Run beat 1 once to wake the voices, then press **Reset demo** again.

The chip in the top-right corner must say **simulation mode**. If it says **live · Teams
Phone**, this server found Azure settings in `.env` and places real calls, so the scripted
beats, **Place the call**, the demo clock and **Reset demo** are all switched off: simulated
calls write to the schedule, and a demo must never touch a real one. Present from a
separate simulation server instead:
`PUBLIC_BASE_URL= SCHEDULE_DB_PATH=:memory: AUDIT_DB_PATH=:memory: npm start`. An empty
variable wins over `.env`, and the in-memory databases keep the demo away from the live
schedule. Add `PORT=` with a free port if the live server is still running.

### Driving it

| Key | What it does |
| --- | --- |
| **→**, **PageDown** or a presenter clicker | Run the next step |
| **Auto-play** | Run the rest of the current beat |
| **1**–**6** | Jump to a beat. On its first step, each beat sets the clock and puts its patient's appointment back, so any beat re-runs cleanly, in any order |
| **PageUp** | Back to the start of this beat; press again for the previous beat |
| **Esc** | Stop auto-play and the voices |
| **N** | Show or hide the narration under the beat strip |

The manual controls work at any point. Pick a **Patient to remind**, choose **Who picks up**
(a person, voicemail, or nobody) and a **Language**, and press **Place the call**. Then type
what the patient says, press keypad keys (the legend under the keypad says what each one
does), or send **Silence** or **Hang up**. A manual call speaks the patient's preferred
language, and Jordan and Camila prefer Spanish, so set **Language** to **English** for the
room. Use the controls for "what if…?" questions, then press a beat number to get back on
script: the beat puts its patient's appointment back, opt-out included. Good ones to have
ready, straight after **Reset demo**:

- **"What if the spouse answers?"** Jordan R., *"This is Alex, Jordan's husband."* Alex is an
  authorized proxy on Jordan's record, so the agent asks for *Jordan's* date of birth
  (*"March 12th, 1984."*) before it says anything about the appointment.
- **"What if they want to stop?"** Avery S., *"Please stop calling me."* The opt-out is saved
  before the call ends, and the next **Place the call** for Avery is refused.
- **"What if they ask a medical question?"** Jordan R., *"Yes, this is Jordan."*, *"March
  12th, 1984."*, then *"I have a fever, should I still come?"* The agent gives no medical
  advice and offers the nurse line; *"Yes."* connects it, with the context in the Teams
  panel.

---

## 1 — Confirmed in one call *(~90s)*

The narration reads: *"Two days before an imaging appointment, the agent calls Jordan. It
says nothing about the visit until it knows it's talking to Jordan."*

Before you press anything, point at the empty console.

> "Every clinic makes reminder calls, because a no-show is a slot nobody else got to use.
> Placing the call is the easy part. The hard part is that whoever picks up might not be
> the patient, and 'your MRI with Dr. Lee on Thursday' is not something to tell a stranger."

**→** **Place the reminder call to Jordan R. (A-20418).** Before it dials, the server checks
consent, calling hours and the reminder window on the demo clock: 10:00 AM, two days before
the visit. The first check reads **Cleared to call**. Someone picks up, and the agent says
it's Contoso Health's automated assistant with an appointment reminder and asks for Jordan
by first name: no department, no provider, no time.

**→** *"Yes, this is Jordan."* "This is Jordan" is a claim, not proof. The agent asks for a
date of birth and still hasn't said why it's calling.

**→** *"March 12th, 1984."* The server checks the date of birth against the record. Only a
match unlocks the appointment details: the minimum necessary. The agent reads them out:
imaging with Dr. Lee, Thursday, May 21 at 9:30 AM, at the Northgate clinic.

This is the most important sentence in the demo:

> "The model never saw Jordan's date of birth. It passed on what Jordan said, my server
> compared it with the record, and only then did the model get the appointment to read out.
> Before that it knew a first name. There was nothing for it to leak."

**→** *"Yes, I'll be there."* Jordan confirms. The server marks A-20418 confirmed: watch the
schedule panel. **The clinic's schedule** shows A-20418 **confirmed**, and the agent reads
out the prep instructions for the visit.

When the beat is done, the narration reads: *"Confirmed in the clinic's schedule, with the
prep instructions for the visit. The trail shows identity verified before a single detail
was shared."* Point at the **Decision trail**: the date-of-birth match comes before the
details.

## 2 — Cancel frees the slot *(~60s)*

The narration reads: *"Avery can't make it. A cancellation only helps if the time goes back
on the books for another patient."*

**→** **Place the reminder call to Avery S. (A-20419).** **→** *"Yes, speaking."*
**→** *"June 9th, 1979."* Verified, so the agent reads out the appointment: primary care
with Dr. Patel, Thursday, May 21 at 10:15 AM.

**→** *"I need to cancel."* Nothing changes yet. The agent reads the cancellation back and
waits for a clear yes. The decision panel says **Cancel? Read it back first**.

> "A cancellation is the one thing on this call you can't take back, so the agent reads
> it back first, and the server won't touch the schedule until it hears a clear yes."

**→** *"Yes, please cancel it."* A clear yes. The server cancels A-20419 and releases the
10:15 slot with Dr. Patel. The schedule panel shows A-20419 **cancelled** and a new row,
**Open slot · Dr. Patel**, marked **free again**. Avery gets the number to book a new visit.

> "Two days' notice is enough time for the clinic to give that slot to someone else. A
> reminder call that ends in a cancellation is still a good call."

When the beat is done: *"The schedule panel shows the slot free again, ready for the next
patient who needs it."*

## 3 — New time → a person *(~75s)*

The narration reads: *"Riley wants a different time. Finding one means options and
trade-offs, so a person on the scheduling desk takes it. The agent books nothing itself."*

**→** **Place the reminder call to Riley D. (A-20423).** Riley's clinic is in Phoenix, so the
calling hours and the reminder window are judged in Riley's time zone, not the server's.

**→** *"Yes, this is Riley."* **→** *"August 14th, 2002."* Verified, so the agent reads out
the appointment.

**→** *"Can I come next week instead?"* The server hands the call to the scheduling desk in
Teams, with the context in the VoIP headers. Watch the Teams panel.

Move to **What the scheduling desk sees**, a mock of the desk's Teams client. The toast
rings for **Scheduling desk** with the topic **Reschedule – Primary Care A-20423** and the
context: *"Riley D. (verified) wants a new time for Primary Care Follow-up on Thu, May 21,
10:00 AM MST. The current slot stays booked until a new one is chosen."* The tags say
**new time**, **verified** and **nothing booked**.

> "There is no booking tool. Not 'the model is told not to book': there is no tool it
> could call. A new time is a negotiation with somebody's calendar, so a person does it,
> and they pick up already knowing who it is, that identity was checked, and what Riley
> asked for."

Point at **VoIP headers on the wire**: these are exactly what the real transfer sends. The
topic, the session id, and a context with the intent, the appointment id, `verified: true`
and a short-lived patient reference. No date of birth and no phone number go to Teams.

When the beat is done: *"The scheduler's Teams client rings with who it is, that identity
was verified, and what Riley asked for. The current slot stays booked until a new one is
chosen."*

## 4 — Someone else answers *(~45s)*

The narration reads: *"Family members answer phones. A reminder must not tell them what
kind of appointment Camila has, or when."*

**→** **Place the reminder call to Camila L. (A-20424).** The agent asks for Camila by first
name, and that's all it says.

**→** *"No, this is her sister."* Not the patient, so the server allows a callback request
only: no department, no provider, no time. The agent asks the sister to have Camila call
Contoso Health at 602-555-0100, and the call ends.

> "That's the whole call, and it's the right call. Only a proxy named on the patient's
> record, like Jordan's spouse, gets asked for the date of birth. That's a field in the
> record, not a judgment call by the model."

When the beat is done: *"The decision panel names the rule: minimum necessary. Nothing
about the appointment was said."*

## 5 — Voicemail: callback only *(~45s)*

The narration reads: *"Anyone can play back a voicemail. Early attempts leave no message
at all; the last attempt leaves a callback number and nothing else."*

**→** **Call Camila L. again: voicemail picks up (attempt 3 of 3).** The greeting says
"leave a message", so the server treats it as voicemail, not as Camila. The agent leaves
one line: *"This is Contoso Health calling for Camila with an appointment reminder. Please
call us back at 602-555-0100. Thank you."*

> "That message is fixed text in config, chosen by the server. On the first two attempts
> it hangs up without leaving anything at all."

When the beat is done: *"A callback request only: no department, no provider, no time. The
trail shows why."*

## 6 — Too late to call *(~60s)*

The narration reads: *"Same server, 8:30 in the evening. Reminder calls keep to calling
hours in the patient's own time zone."* The demo clock jumps to 8:30 PM, and its **Too
late to call · 8:30 PM** preset lights up.

**→** **Try to call Noah M. at 8:30 PM.** Noah hasn't been called yet, so only the clock
stands in the way. The server refuses before anything is dialed, and says when the next
call is allowed. The decision panel reads **Not placed: outside calling hours**: *"Calling
hours are 8:00 AM–8:00 PM in Noah's time zone; it's 8:30 PM there now. Next allowed: Wed,
May 20, 8:00 AM PDT."*

> "The model doesn't decide when to call, and it can't dial. The same server check refuses
> a patient who never consented, one who'd rather get a text, one who opted out, and an
> appointment less than 24 hours away."

**→** **Show the numbers.** Every call is audited: patients reached, confirmed, cancelled,
handed to scheduling, and privacy-safe voicemails. After a clean run of all six beats the
footer reads:

| Calls placed | Patients reached | Confirmed | Cancelled · slot freed | Reschedules handed off | Privacy-safe voicemails | Callback only | Not placed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | 3 | 1 | 1 | 1 | 1 | 1 | 1 |

> "Reached means verified: the right person, confirmed by date of birth. The sister's
> call counts as a callback request, not a reach, and the 8:30 call was never placed."

When the beat is done: *"The same numbers come from the same audit log in production."*

---

## If something goes wrong

- **A beat went sideways.** Press its number, then **→**. The beat resets its clock and its
  patient's appointment and places a fresh call, so it re-runs from the top.
- **Everything looks wrong.** **Reset demo**, then **1**. Reset restores the seeded schedule,
  clears the calls and the metrics, and puts the clock back.
- **No sound.** Check the voice menu, and that the URL has `?voices=online` in Edge. Or just
  narrate: the voices are a presenter aid, not part of the product.
- **→ does nothing.** A menu has focus, or the text box has text in it. Click an empty part
  of the page.
- **Place the call ends in "Not placed".** That's the dial policy doing its job on the
  current clock and schedule: after beat 1, Jordan is already confirmed, and at **Too late
  to call** nobody can be called. Pick another patient, press the **2 days before ·
  10:00 AM** clock preset, or press **Reset demo**.
- **The agent speaks Spanish.** A manually placed call uses the patient's preferred
  language, and Jordan and Camila prefer Spanish. Set **Language** to **English** for the
  room. The beats always run in English.

## Taking a real call

With Azure configured (see the README, "Connecting it to a real phone number"), the chip
says **live · Teams Phone**. Reminder calls go out from the campaign run, and only once
you've switched the campaign on and turned its dry run off. List your own test phones in
`ALLOWED_TEST_NUMBERS` first: when it's empty, nothing is filtered out.
The console follows a real call whenever it's idle: the transcript, the decision, the
Teams toast and the trail fill in from the real call, with the room voice muted. The clock
is real time, and the scripted beats, **Place the call**, the pickers and **Reset demo**
are off, because simulated calls write to the schedule. Run the scripted demo from a
separate simulation server (see "Set up").

## If someone asks

**"Is this actually running Azure?"**
Not right now. It's in simulation mode, which is why it can't fail on stage: the patient's
lines are typed and read by a deterministic stand-in for the model, the phone line is
simulated, and the Teams toast is a mock built from the real handoff context. Set four
environment variables, switch the campaign on, and the same state machine places real
calls. Azure Communication Services Call Automation dials the patient and bridges the
audio to the Azure AI Voice Live API, which listens and speaks. A request for a new time
transfers to the scheduling desk in Teams, and a patient who calls back from the number on
file can reach the same agent on the clinic's Teams Phone number through Teams Phone
extensibility. The dial gates, the identity check, the schedule writes and the handoff
you just watched are the real code.

**"How does the scheduler get the context?"**
VoIP custom headers on the transfer. `CallDetails.CallTopic` is the line the Teams client
shows; `CallDetails.CallContext` carries the intent, the appointment id, `verified: true`
and a short-lived patient reference. Not SIP headers: those are a PSTN-side mechanism and
never reach a Teams identifier, so the desk would pick up blind.

**"What if nobody at the scheduling desk answers?"**
Azure Communication Services reports the failed transfer while the patient is still on the
line. The agent says so honestly ("I'm sorry, I couldn't reach our scheduling team just
now. Your request for a new time is saved, and they'll call you back. Your current
appointment stays booked until then. Goodbye.") and ends the call. It doesn't try the
transfer again, so a desk that keeps failing can't trap the patient in a loop, and the
failed transfer isn't counted as a handoff. With no desk configured at all, the agent
files a callback request instead of transferring.

**"Is a date of birth enough?"**
It's a knowledge check, not strong authentication, so it unlocks very little: one
appointment's details, and a confirm or a cancel after a clear yes. Two misses end the call
with the clinic's number, logged as unverified. Anything more sensitive belongs with a
person or a stronger check.

**"Where does this break?"**
Voicemail detection reads the greeting's words, so an unusual greeting can look like a
person. Then the agent asks for the patient by first name and says nothing more, which is
no more than the voicemail message would say. Dates are the hardest thing to hear on a
phone line, so the patient can also key the date of birth on the keypad as eight digits.

**"What would a developer change first?"**
`config/campaign.json` for the reminder window, calling hours, attempts and spacing;
`config/scripts.json` for every line the server owns, in English and Spanish;
`config/clinics.json` for time zones, callback numbers, the nurse line and holidays;
`config/routing.json` for the scheduling desk; and `src/schedule-store.mjs`, to point the
agent at a real scheduling system instead of the seeded SQLite one. To change the demo
itself, edit `public/beats.js`.
