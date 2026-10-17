# Demo script — 5 beats, about 6 minutes

A rehearsable running order for the customer record lookup and update agent. Alex Morgan,
a Contoso sales rep, calls about his customer Fabrikam: he hears the record, updates it by
voice, changes his mind, and asks for something the agent may not do. Every beat runs in
**simulation mode**, so no Azure subscription, phone number, Teams tenant or CRM is
needed, and nothing on stage depends on a network.

**The beats:** 1 Verified before anything is read · 2 Read back, a yes, then the undo
window · 3 "Wait — keep the old number" · 4 Not mine to change · 5 Can't verify, won't
disclose, ending on the metrics.

The argument you are making is *not* "a model can read a CRM record out loud". Everyone
believes that already. It is: **the interesting part is what the server won't do on the
model's say-so.** It reads nothing out before it knows who is calling, writes nothing
without a read-back, an explicit yes and an undo window, and never touches a field that
isn't on the phone allow-list.

The console drives itself. Each press of **→** runs one step of the script and types (and,
if you like, speaks) the caller's line, so your hands are free and your eyes are on the room.

---

## Set up — five minutes before

```bash
npm install
npm run rehearse                   # every beat, three ways, on its own server (~80 s)
npm start                          # http://127.0.0.1:8097
curl -s 127.0.0.1:8097/health      # expect "mode": "simulation"
```

`npm run rehearse` plays the script the way the console does and fails if any beat would
land somewhere this page doesn't say. It runs its own server on port 8297 with the shipped
settings (not your `.env`) and keeps its records in memory, so it can run while your demo
server is up and never touches `./data/crm.db`.

- [ ] Open **Microsoft Edge** at `http://127.0.0.1:8097/?voices=online`. Edge's online
      voices are the Azure neural voices, so the room *hears* a voice product. Without
      `?voices=online` the console uses on-device voices only and nothing leaves the machine.
- [ ] Set the voice menu (top right) to **Speak agent + caller**, or **Speak agent** if you
      would rather read the caller's lines yourself.
- [ ] Zoom to **125%** (Ctrl and +) and press **F11**. The beat strip should fit on one line.
- [ ] Press **Reset demo**: no calls, zeroed metrics, the seeded customer records and the
      starting clock. Every beat also pins the clock to the demo day (Wednesday, June 10,
      2026) and puts the seeded records back, so the time of day you present at doesn't
      matter and no beat inherits another beat's write.
- [ ] Run beat 1 once to wake the voices, then press **Reset demo** again.

The chip in the top-right corner must say **simulation mode**. If it says **live · Teams
Phone**, this server found Azure settings in `.env`, and the demo clock, the record restore
and the reset are switched off so they can't affect real calls. Start it with
`PUBLIC_BASE_URL= npm start` to force simulation (an empty variable wins over `.env`), on
another `PORT` if the live server is still running.

### Driving it

| Key | What it does |
| --- | --- |
| **→**, **PageDown** or a presenter clicker | Run the next step |
| **Auto-play** | Run the rest of the current beat |
| **1**–**5** | Jump to a beat. Each beat pins the clock, restores the seeded records and answers its own call, so any beat re-runs cleanly, in any order |
| **PageUp** | Back to the start of this beat; press again for the previous beat |
| **Esc** | Stop auto-play and the voices |
| **N** | Show or hide the narration under the beat strip |

The manual controls work at any point: pick a **Caller ID** (Alex on Teams, Alex's mobile,
Jordan on Teams, or an unknown number), click **Answer a call**, type your own caller line,
use the keypad (Alex's PIN or a wrong one while the agent waits for a PIN; `0` for a person
and `*` to repeat after that), or send **Silence** or **Hang up**. Use them for "what if…?"
questions, then press a beat number to get back on script.

**Who's who.** Alex Morgan is a Contoso sales rep and Fabrikam is his account. Dana Ruiz is
Fabrikam's VP of Operations. Contoso Sales Operations is the Teams call queue that takes the
call when the agent can't help. All of them are fictional.

---

## 1 — Verified before anything is read *(~90s)*

> "Alex Morgan is a Contoso sales rep, calling about his Fabrikam account from the road.
> Before the agent reads out a single field, it has to know who is calling."

**→** Alex calls from his registered mobile. *"This is the Contoso sales assistant, an
automated agent. Please enter your six-digit Contoso sales PIN."*

> "The number matches Alex's registered mobile. Caller ID is a hint, not proof, so the
> agent asks for a PIN before it opens any record."

Point at **Checked before anything is read out**: *Registered mobile, number ending 0197*,
*Waiting for PIN*, and record access *Locked until verified*.

**→** Alex keys in his PIN. The transcript shows dots, never the digits.

> "The server checks the PIN against a stored hash. Watch the checklist."

The PIN row turns to **Correct**. *"Thanks, Alex, you're verified. Which account?"*

**→** *"Brief me on Fabrikam"*. *"Fabrikam, Strategic tier, your account. Last touch was a
call on May 2 about pilot rollout. 3 open deals: enterprise renewal at about 250 thousand,
in Negotiation, closing June 30, … One task is due today: send the security questionnaire.
Your contact is Dana Ruiz, VP of Operations."*

> "Verified. The record opens only for accounts on Alex's list, and the card shows only
> what he may hear: no phone numbers yet, and never the credit terms."

Point at the **Record card**: Dana Ruiz with *phone withheld until asked for*, and the
**Withheld** row, *Credit limit and payment terms — Sales Operations only*.

**→** *"What's Dana's number?"* *"Dana Ruiz's number is 206 555 0120."*

> "Contact details are read out only when asked for. From now on the card shows the number
> too."

The checklist now reads *Read out on request: Dana Ruiz · number*.

> "Every check, lookup and disclosure is in the audit trail. The credit limit and payment
> terms stay with Sales Operations."

## 2 — Read back, a yes, then the undo window *(~90s)*

> "Straight after the meeting, Alex dictates the update the way he'd tell a colleague.
> Nothing is written on the model's say-so."

**→** Alex calls from Teams. *"Hi Alex, I'm the Contoso sales assistant, an automated
agent. Which account?"*

> "Signed in to Teams, so no PIN this time."

**→** *"Log the Fabrikam meeting. Dana agreed to the renewal at 240k, moving to Closed Won
pending signature, close date June 15th. Remind me to send the contract Friday."*

> "The model turns the debrief into a proposed update. The server checks every field
> against the phone allow-list, and the agent reads all of it back."

*"Here's what I have for Fabrikam. A meeting activity with Dana Ruiz, today. Enterprise
renewal: stage from Negotiation to Closed Won, amount from 250 thousand to 240 thousand,
close date from June 30 to June 15, and next step from Security questionnaire to Pending
signature. A task for you to send the contract, due Friday, June 12. Save it?"* The
headline reads **Read back — waiting for a yes**, and **Write-back** lists every change.

**→** *"Yes, save it."* *"Saving in six seconds. Say "wait" to stop it."*

> "An explicit yes. Even now the write waits: the undo window opens on the server, and the
> bar counts it down."

The headline is **Yes — the undo window is open**: confirmed, not yet written. A bare
"yes" wouldn't have opened it: the server needs an explicit save such as "yes, save it",
and a "maybe" or a "don't" never counts.

**→** Let the undo window run out.

> "Nobody objects, so the write commits when the window closes, with an audit entry."

*"Saved to Fabrikam's record."* The headline turns to **Written to Fabrikam's record**.

> "The write-back card shows each field before and after, with the audit ID. “Undo that”
> would still reverse it on this call."

Point at **Write-back**: the new meeting, the stage, amount, close date and next step
before → after, and the new task, with 12 audit rows and the audit ID.

## 3 — "Wait — keep the old number" *(~45s)*

> "People change their minds mid-sentence. The undo window is there for exactly that."

**→** Alex calls from Teams again.

**→** *"Update Fabrikam: Dana has a new mobile, 425 555 0143."*

> "One field this time: Dana's mobile. The agent reads the new number back in full and
> names the one it replaces."

*"Here's what I have for Fabrikam. Dana Ruiz's number changes from the one ending 0120 to
425 555 0143. Save it?"*

**→** *"Yes, save it."* *"Saving in six seconds. Say "wait" to stop it."*

> "Confirmed, and the undo window opens. Alex is about to change his mind."

Two and a half seconds later, with no press from you: *"Wait, no — keep the old number."*
*"Stopped. Nothing was written: Dana Ruiz's number is still the one ending 0120."* The bar
stops with a few seconds left, **nothing written**; the headline reads **Stopped — nothing
written**, and **Write-back** shows the new number struck through, *not written*.

> "Stopped inside the window: nothing was written and the record keeps the old number. The
> trail shows the yes and the stop."

## 4 — Not mine to change *(~60s)*

> "Some fields are never changed over the phone. The allow-list is server code, not a line
> in a prompt."

**→** Alex calls from Teams.

**→** *"Raise Fabrikam's credit limit to 500k and move them to net 60 payment terms."*

> "The model would happily propose it. The server refuses both fields because they aren't
> on the phone allow-list, so nothing is written."

*"The credit limit and the payment terms aren't on the list of things I can change by
phone, so nothing was written. Contoso Sales Operations can change them. Want me to put you
through with the details?"* The headline reads **Not mine to change**, and **Write-back**
lists both fields as refused.

**→** *"Yes, put me through."* *"Putting you through to Contoso Sales Operations with the
details."*

> "The agent offers Sales Operations, who can make the change. Watch the Teams panel."

Move to **What Sales Operations sees**: *Alex Morgan · Fabrikam*, *Verified · Teams
sign-in*, the topic *Fabrikam – credit limit, payment terms*, and what Alex asked for and
why nothing was written. Then point at **VoIP headers on the wire**: `CallDetails.SessionId`,
`CallTopic`, `CallContext` and `RouteId`, with no PIN and no phone number in any of them.

> "Sales Operations' Teams client rings with the account, the request and the refusal, so
> nobody has to ask Alex again. The same context travels in the VoIP headers."

## 5 — Can't verify, won't disclose *(~60s)*

> "Last one: someone has Alex's phone, but not his PIN."

**→** A call from Alex's registered mobile. The same greeting asks for the PIN.

**→** A wrong PIN. *"I couldn't verify you, so I can't open any records. I'll put you
through to Contoso Sales Operations."*

> "Wrong PIN: no record is opened and nothing is read out. The call goes to a person with
> only what is safe to share."

The headline reads **Couldn't verify — nothing disclosed**, the checklist says *Wrong PIN —
no records opened*, and the record card says *Nothing opened — the caller wasn't verified*.
The toast shows an *Unverified caller* from a number ending 0197, *Not verified — no records
opened*, with nothing about Fabrikam or Dana.

**→** Show the numbers.

> "Every lookup, write, undo, refusal and handoff is audited, and these numbers come
> straight from that audit log."

After one run from **Reset demo**, the footer reads **Calls 5 · Lookups 2 · Confirmed
writes 1 · Undone writes 1 · Refusals 1 · Handoffs 2 · Verification failures 1**.

> "Lookups, confirmed writes, undone writes, refusals and handoffs, all from the same audit
> log a real deployment keeps."

---

## If something goes wrong

- **A beat went sideways.** Press its number. The beat pins the clock, restores the seeded
  records and answers a fresh call, so it re-runs from the top.
- **Everything looks wrong.** **Reset demo**, then **1**.
- **No sound.** Check the voice menu, and that the URL has `?voices=online` in Edge. Or just
  narrate — the voices are a presenter aid, not part of the product.
- **The undo bar didn't seem to move.** It counts down in script, not CSS, so it runs even
  when the PC asks for reduced motion (common over Remote Desktop). It follows the server's
  window: it starts on the yes and stops when the server commits or cancels.
- **You pressed → twice quickly.** Before it answers the next call, the console waits for
  an open undo window or a transfer to finish (for at most the window plus three seconds),
  so a quick press never cuts a write short.
- **The metrics look high.** They count every call since the last reset, including any you
  made by hand. Press **Reset demo** before you start.

## Taking a real call

With Azure configured (see the README, "Connecting it to a real phone number"), the chip
says **live · Teams Phone** and the console follows a real call whenever no other call is in
progress on screen: call from Teams or a registered mobile, and the transcript, checklist,
record card, undo window, Teams toast and trail fill in from the real call, with the room
voice muted. The demo clock is real time, and **Reset demo** and the record restore are off.
The scripted beats still run as simulated calls, and a simulated call is never transferred
for real, but their writes stay in the server's CRM, so present the beats from a simulation
server.

## If someone asks

**"Is this actually running Azure?"**
Not right now — it's in simulation mode, which is why it can't fail on stage. Set three
environment variables and the identical state machine answers calls through **Teams Phone
extensibility**: the rep dials a Teams service number, or calls the resource account
straight from Teams, and Teams hands the call to Azure Communication Services. **Call
Automation** answers it and streams the audio both ways to the **Azure AI Voice Live API**,
which does the listening and the speaking. The speech model, the audio path and the Teams
transfer itself are the only stand-ins; every check, refusal and write you just watched is
the real code.

**"What exactly is simulated?"**
The model, the audio and the transfer. A small offline stand-in (`src/offline.mjs`) sends
each typed line to the flow method the model's tool call would reach on a live call, the
browser speaks the lines, and the Teams panel is a mock of what Sales Operations would see.
The identity checks, the allow-list, the undo window, the CRM writes with their audit rows,
and the handoff context, headers included, all run the server code a real call runs,
against a local copy of the seeded records.

**"How does the context reach Sales Operations?"**
VoIP custom headers on the transfer. Not SIP headers — those are a PSTN-side mechanism and
never reach a Teams identifier, so the call would connect and the person would still answer
blind. The server masks phone numbers, email addresses and anything PIN-shaped before the
context is built.

**"Why not let the model write directly? It understood the debrief."**
Understanding isn't confirmation. The model can only *propose* a change set through a tool.
The server checks every field against `config/writable-fields.json` and the agent reads the
result back. The server opens the undo window only when the rep's last words, which the
model has to quote to it, are an explicit "yes, save it", and the write lands when the
window closes, with before and after values in the audit. That is what makes a spoken write
safe to stop, undo and audit.

**"What does a developer customize first?"**
- `config/writable-fields.json`: what may be changed by phone, and the rules each value must
  pass. Anything not listed is refused, and Sales Operations is offered.
- `config/reps.json`: who may call, with their Teams identity, registered mobile and PIN hash.
- `config/routing.json`: the Teams call queue (or user) that takes handoffs.
- `src/providers/`: swap the local CRM for your own; `dataverse-crm.mjs` is a documented stub.
- `public/beats.js`: the demo lines and this narration.

**"Where does this break?"**
Caller ID is worth nothing on a spoofed call, which is why a mobile caller needs a PIN, and
why one wrong PIN goes to a person instead of offering another guess. On a live call the PIN
depends on keypad tones reaching the server, so test DTMF on your carrier first. And a
hang-up inside the undo window still commits a write the rep already confirmed: "wait"
stops it before, and "undo that" reverses it after, on the same call.
