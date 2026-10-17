# Demo script — 7 beats, about 7 minutes

A rehearsable running order for the intent-based call routing agent. Every beat runs in
**simulation mode**, so no Azure subscription, phone number or Teams tenant is needed, and
nothing on stage depends on a network.

The argument you are making is *not* "a model can classify a sentence". Everyone believes
that already. It is: **the interesting part is what happens when it is unsure, when the
caller changes their mind, and when the person on the other end picks up.**

The console drives itself. Each press of **→** runs one step of the script and types (and,
if you like, speaks) the caller's line, so your hands are free and your eyes are on the room.

---

## Set up — five minutes before

```bash
npm install
npm run rehearse                   # every beat, three ways, on its own server (~2 min)
npm start                          # http://127.0.0.1:8091
curl -s 127.0.0.1:8091/health      # expect "mode": "simulation"
```

`npm run rehearse` plays the script the way the console does and fails if any beat would
land somewhere this page doesn't say. It runs its own server on port 8291 with the shipped
settings (not your `.env`), so it can run while your demo server is up.

- [ ] Open **Microsoft Edge** at `http://127.0.0.1:8091/?voices=online`. Edge's online
      voices are the Azure neural voices, so the room *hears* a voice product. Without
      `?voices=online` the console uses on-device voices only and nothing leaves the machine.
- [ ] Set the voice menu (top right) to **Speak agent + caller**, or **Speak agent** if you
      would rather read the caller's lines yourself.
- [ ] Zoom to **125%** (Ctrl and +) and press **F11**. The beat strip should fit on one line.
- [ ] Press **Reset demo**: no calls and zeroed metrics. Every beat sets the clock it needs,
      so the time of day you present at doesn't matter.
- [ ] Run beat 1 once to wake the voices, then press **Reset demo** again.

The chip in the top-right corner must say **simulation mode**. If it says **live · Teams
Phone**, this server found Azure settings in `.env`, and the demo clock and reset are
switched off so they can't affect real calls. Start it with `PUBLIC_BASE_URL= npm start` to
force simulation (an empty variable wins over `.env`), on another `PORT` if the live server
is still running.

### Driving it

| Key | What it does |
| --- | --- |
| **→**, **PageDown** or a presenter clicker | Run the next step |
| **Auto-play** | Run the rest of the current beat |
| **1**–**7** | Jump to a beat. Each beat sets the clock and answers its own call, so any beat re-runs cleanly, in any order |
| **PageUp** | Back to the start of this beat; press again for the previous beat |
| **Esc** | Stop auto-play and the voices |
| **N** | Show or hide the narration under the beat strip |

The manual controls work at any point: type your own caller line, press a keypad key, send
**Silence** or **Hang up**. Use them for "what if…?" questions, then press a beat number to
get back on script.

---

## 1 — One question, no menu *(~75s)*

Before you press anything, point at the empty console.

> "Every company has this. You call the main line and a recording reads you a menu you
> have to translate your problem into. Press 1 for sales. Press 2 for support. Except your
> problem isn't a number — it's a sentence. So people mash zero, and when they finally reach
> a human, that human says 'so what's this about?'"

**→** Dana Whitfield calls. Her caller ID matches the directory, so the greeting is personal.

**→** *"I was charged twice on my invoice."* The gauge lands on **0.95** against the gate
at **0.75**, and the agent offers Billing.

This is the most important sentence in the demo:

> "The model didn't route this call. It *proposed* one id from a list of four, and a
> number. My server compared that number with a threshold I set, checked that Billing is
> open, and decided. The model can't dial. No tool it can call accepts a phone number — so
> a prompt injection can't turn this into toll fraud."

**→** *"Yes please."* The state goes **transferring**, then **transferred**. Move to **What
the Teams agent sees**.

> "That's what the Billing agent picks up to: what the call is about and who's calling.
> Nobody has to ask 'so what's this about?'. And look — *matched on caller ID, not
> verified*. Caller ID is not authentication, so we never pass it along as identity."

Point at **VoIP headers on the wire**: the same context, as the Teams client receives it.

## 2 — Not sure? Ask *(~60s)*

**→** Priya Raman calls. **→** *"I was charged for a renewal I did not order."*

> "Is that Billing, or is that Sales? Honestly — it's both."

The gauge stops at **0.60**, below the gate, and the decision panel says **Not sure yet**.
The agent asks one question instead of picking.

> "Most demos hide this case, because a confident wrong answer looks better on stage than
> an honest question. But a wrong route is the expensive failure: the caller waits nine
> minutes in the wrong queue and starts over. The gate is one number in config. Raise it
> and the agent asks more and misroutes less — that's a business decision, so it lives
> where the business can change it, not inside a prompt."

**→** *"The charge on my card is wrong"* clears the gate. **→** *"Yes."* The Teams toast
carries both of Priya's sentences, so the agent hears the whole story.

## 3 — "A person, please" *(~30s)*

**→** An unknown number calls. **→** *"Can I just talk to a person?"*

Straight to Reception. No gate, no "are you sure?", no "let me try one more thing".

> "The number one complaint about every system like this is that it won't let you out. So
> asking for a person skips everything. And it's counted as a request, not a failure — if
> it shows up on a third of your calls, go and read those transcripts."

## 4 — Changed their mind *(~60s)*

**→** Marcus Bell calls. **→** *"I have a question about my invoice."* Billing clears the gate.

**→** *"Yes please"* — then point at the **bar under the gauge**. The transfer waits about
a second before it dispatches, and Marcus says *"no wait, the portal is down"* inside it.
The bar freezes amber: **cancelled — the caller changed their mind (Billing → Support)**.

> "Between 'connecting you now' and the connection there's a window of about a second.
> People change their mind in exactly that gap — they remember what they actually called
> about. Commit the instant they say yes, and the correction lands on a confused person in
> the wrong department."

**→** *"Yes."* Support. The toast carries both sentences, change of mind included, and the
trail shows `route_changed billing → support`.

> You don't need to widen the window: the script sends Marcus's correction 0.6 seconds
> after his yes. If you drive this beat by hand instead, start the server with
> `TRANSFER_DELAY_MS=6000` so you have time to type, and say so — it's one setting.

## 5 — After hours: a message *(~45s)*

**→** The clock jumps to **7:30 PM** and Billing shows **Closed**. Dana calls back.

**→** *"I have a question about my invoice"* — Billing is still the right team. **→**
*"Yes."* But Billing is closed, and its after-hours rule is to take a message.

> "The server checks the hours, not the model. The model never sees a clock it could get
> wrong."

**→** *"Please call me back about the duplicate charge."* The message is recorded with a
topic for the team. No callback time is promised, because nobody has agreed to one.

## 6 — After hours: diverted *(~30s)*

**→** Marcus calls after hours. **→** *"I'd like a quote for an upgrade."* Sales clears the
gate. **→** *"Yes."* Sales is closed, and its rule is different: divert to Reception.

Point at the toast: **after hours · meant for Sales**, and the `AfterHours` header on the
wire. Reception knows why this call landed on them.

## 7 — Silence → keypad *(~60s)*

**→** An unknown number calls. **→** Silence: the agent asks one clarifying question.
**→** Silence again: now it offers the keypad.

> "The keypad is always live. We just don't announce it up front, because announcing it is
> how you end up back at the menu we deleted. It's offered only when speech has failed."

**→** The caller presses **2**. A keypress is unambiguous, so it routes to Support without a
spoken confirmation. **→** The metrics come up.

> "Median seconds to route, clarifying questions, how often people asked for a person.
> Those are the numbers that tell you whether this is working, and they come out of the
> same audit trail you've been watching — not a separate analytics pipeline. And every
> dead end in this state machine is a person, never a loop."

---

## If something goes wrong

- **A beat went sideways.** Press its number. The beat resets its clock and answers a fresh
  call, so it re-runs from the top.
- **Everything looks wrong.** **Reset demo**, then **1**.
- **No sound.** Check the voice menu, and that the URL has `?voices=online` in Edge. Or just
  narrate — the voices are a presenter aid, not part of the product.
- **The window bar didn't seem to move.** It counts down in script, not CSS, so it runs even
  when the PC asks for reduced motion (common over Remote Desktop). If you pressed → twice
  quickly, the console waits for the pending transfer before it answers the next call.

## Taking a real call

With Azure configured (see the README, "Connecting it to a real phone number"), the chip
says **live · Teams Phone** and the console follows a real call to the Teams Phone number
whenever it isn't showing a scripted one: dial it, and the transcript, decision, Teams toast
and trail fill in from the real call, with the room voice muted. The demo clock is real
time and **Reset demo** is off. The scripted beats still run as simulated calls, and a
simulated call is never transferred for real.

## If someone asks

**"Is this actually running Azure?"**
Not right now — it's in simulation mode, which is why it can't fail on stage. Set three
environment variables and the identical state machine answers a Teams Phone number through
Teams Phone extensibility, with Voice Live for speech and Azure Communication Services Call
Automation bridging the media. The classifier and the audio path are the only stubs;
everything you just watched decide is the real code.

**"How is the context actually delivered?"**
VoIP custom headers on the transfer. Not SIP headers — those are a PSTN-side mechanism and
never reach a Teams identifier, so the call would connect and the agent would still answer
blind. That's the most common way this gets built wrong.

**"What about sentiment?"**
It's in the payload only when the caller *said* they were unhappy. We don't infer it from
tone of voice. Inferring emotion from audio and routing on it is a decision to make
deliberately, with your legal team — not by accident because an API offered it.

**"How long to add a fifth department?"**
One JSON object: an id, a description, a Teams object ID and opening hours. The menu the
model sees is generated from that file, so there's no prompt to rewrite and no code to touch.

**"Where does this break?"**
Accents and background noise degrade the transcript before they degrade the routing, so the
confidence gate does more work than it looks like. And the directory lookup is caller-ID
based, which is worth nothing on a spoofed call — hence *not verified* everywhere it appears.
