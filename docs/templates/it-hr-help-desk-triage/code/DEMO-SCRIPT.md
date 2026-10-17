# Demo script — 7 beats, about 8 minutes

A rehearsable running order for the IT / HR help desk triage agent. Every beat runs in
**simulation mode**, so no Azure subscription, phone number or Teams tenant is needed, and
nothing on stage depends on a network.

**The beats:** 1 Teams: answer, then ticket · 2 Only your own tickets · 3 Phone caller:
prove it · 4 Sensitive HR stays private · 5 IT or HR? Ask once · 6 Still stuck? A person ·
7 Phishing: P1 to on-call, ending on the numbers.

The argument you are making is *not* "a model can answer an IT question". Everyone believes
that already. It is: **the interesting part is what the agent won't do — read out anything
personal before it knows who is calling, ask about a private HR matter, or guess between IT
and HR — and that each of those rules is server code, not a line in a prompt.**

The console drives itself. Each press of **→** runs one step of the script and types (and,
if you like, speaks) the caller's line, so your hands are free and your eyes are on the room.
The narration below is the same text the console shows under the beat strip: the quoted
paragraph while a beat runs, the line after each **→** before that step, and the closing
quote once the beat is done.

---

## Set up — five minutes before

```bash
npm install
npm run rehearse                   # every beat, three ways, on its own server (~75 s)
npm start                          # http://127.0.0.1:8098
curl -s 127.0.0.1:8098/health      # expect "mode": "simulation"
```

`npm run rehearse` plays the script the way the console does and fails if any beat would
land somewhere this page doesn't say. It runs its own server on port 8298 with the shipped
settings (not your `.env`), so it can run while your demo server is up.

- [ ] Open **Microsoft Edge** at `http://127.0.0.1:8098/?voices=online`. Edge's online
      voices are the Azure neural voices, so the room *hears* a voice product. Without
      `?voices=online` the console uses on-device voices only and nothing leaves the machine.
- [ ] Set the voice menu (top right) to **Speak agent + caller**, or **Speak agent** if you
      would rather read the caller's lines yourself.
- [ ] Zoom to **125%** (Ctrl and +) and press **F11**. The beat strip should fit on one line.
- [ ] Press **Reset demo**: no calls, zeroed metrics, an empty mock chat, and the next
      ticket number back at **INC-004821**. Every beat sets the clock it needs, so the time
      of day you present at doesn't matter.
- [ ] Run beat 1 once to wake the voices, then press **Reset demo** again, so beat 1 files
      INC-004821 on stage.

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

The manual controls work at any point: pick a caller and press **Answer a call**, type your
own caller line, press keypad **0** (a person) or **\*** (repeat), send **Silence** or **Hang
up**. Use them for "what if…?" questions, then press a beat number to get back on script.

### Where to look

- **The call** — the transcript, and the call's time limit once it's running.
- **Triage decision** — what the server decided and why: the confidence gauge, the
  **Identity** checklist, the ticket card, and **The privacy rule** on a sensitive call.
- **What the Teams agent sees** — a mock of the incoming-call toast, drawn from the real
  handoff, and the **VoIP headers on the wire** beneath it.
- **The employee's Teams chat** — where one-time codes and new tickets land. In simulation
  nothing is sent anywhere; this panel is the only place they appear.
- **Decision trail** and **Where calls can go** at the bottom, and the metrics in the footer.

---

## 1 — Teams: answer, then ticket *(~90s)*

> "Sam calls the help line straight from Teams. Teams has already signed Sam in, so the
> agent knows who is calling without a single security question."

**→ Sam Rivera calls from Teams.** The greeting uses Sam's name because the identity came
from Teams sign-in. It also mentions today's Outlook outage before anyone asks.

**→** *"My VPN keeps disconnecting"* — A routine question. The answer comes from the
approved IT article, not from the model's own words.

**→** *"My laptop screen keeps flickering and I can't work"* — That needs a technician, so
the agent drafts a ticket. The server sets the priority from the matrix — Sam can't work, so
P2 — and attaches the laptop from the directory.

**→** *"Yes, file it"* — Nothing is filed without a yes. Watch Sam's Teams chat on the right.

*Point at* the ticket card under **Triage decision**, then the new ticket in **The
employee's Teams chat**.

> "One call, two outcomes: an approved answer, then a P2 ticket with the right device
> attached. INC-004821 lands in Sam's Teams chat."

## 2 — Only your own tickets *(~60s)*

> "Maria wants an update. The agent can read ticket status aloud, but only for tickets
> Maria is allowed to see."

**→ Maria Lopez calls from Teams.**

**→** *"What's happening with INC-004610?"* — That's Sam's printer ticket, not Maria's. The
server checks who it belongs to and won't read it out.

**→** *"What about INC-004700?"* — INC-004700 is the company-wide Outlook incident, so anyone
may hear its status.

**→** *"Outlook won't open for me either"* — Instead of filing a duplicate, the server adds
Maria to the open incident.

> "Who may hear what is a server rule, not a line in a prompt. And one outage means one
> incident, not a pile of duplicate tickets."

## 3 — Phone caller: prove it *(~90s)*

> "Now Sam calls from a mobile phone instead of Teams. Caller ID is easy to fake, so a
> matching number is a hint, not proof."

**→ Sam calls from a mobile phone.** The number matches Sam's mobile in the directory, yet
the greeting stays anonymous: “Hi there”.

**→** *"What's happening with INC-004610?"* — Ticket status is personal, so the server asks
the caller to prove who they are first.

**→** *"sam.rivera@contoso.com"* — The server sends a one-time code to Sam's Teams chat. In
this demo nothing is sent: the code appears in the mock chat on the right.

**→** *"654321"* — A wrong code is refused. One more miss and the call goes to a person who
can verify Sam another way.

**→** *"123456"* — The right code. Now the agent finishes what Sam asked for in the first
place.

*Point at* the **Identity** checklist as it ticks through caller ID, work email, code sent,
code read back and verified, and at the code's countdown beneath it.

> "The checklist shows every step of the identity gate. The code never reaches the audit
> log, and a console watching a real call never receives it."

## 4 — Sensitive HR stays private *(~45s)*

> "Some calls need a person straight away, and as few details as possible. Watch what the
> agent doesn't do."

**→ Sam Rivera calls from Teams.**

**→** *"My manager keeps making comments about me and I don't know what to do"* — The
sensitive-topic guard runs before anything else. No questions and no ticket, and the
transcript keeps a placeholder instead of Sam's words.

*Point at* **The privacy rule** under **Triage decision**, the toast in **What the Teams
agent sees**, and the headers under it.

> "The HR person's Teams client shows “Confidential HR” and nothing else: no summary, no
> transcript, no reason. After hours, the same guard offers a next-business-day callback
> instead."

## 5 — IT or HR? Ask once *(~45s)*

> "Maria's problem could belong to IT or to HR. A wrong transfer wastes everyone's time, so
> the agent asks one question instead of guessing."

**→ Maria Lopez calls from Teams.**

**→** *"I can't get into the payroll system and my pay is wrong"* — It matches two topics at
0.45, below the 0.70 gate, so the agent asks one short question.

**→** *"It's my paycheck, the amount is wrong"* — Now it's clearly pay, so the call goes to
Payroll with Maria's name and the topic.

*Point at* the gauge stopping short of the gate, and the toast's **after one question** tag.

> "One question, then the right queue. If the answer were still unclear, the call would go
> to a person rather than round in circles."

## 6 — Still stuck? A person *(~45s)*

> "Self-service only goes so far. When the approved answer doesn't fix it, the caller gets a
> person without starting over."

**→ Maria Lopez calls from Teams.**

**→** *"The printer on my floor keeps jamming"* — The approved printer guide answers first.

**→** *"I already tried all that. Can I talk to someone?"* — Asking for a person goes
straight to a person, no more questions. The IT service desk sees who is calling, the
topic, and what was already tried.

> "Whoever picks up knows Maria already followed the printer guide, so the conversation
> starts where the agent left off."

## 7 — Phishing: P1 to on-call *(~75s)*

> "Last one, and it's urgent. A security incident doesn't wait in a queue."

**→ Sam Rivera calls from Teams.**

**→** *"I think I clicked a phishing link"* — Security incidents are priority 1 by rule. The
matrix decides, not the model.

**→** *"Yes"* — The ticket is filed, Sam gets it in Teams chat, and the call goes straight to
IT on-call with the ticket number.

**→ Show the numbers.** Every call is audited: answers, tickets, duplicates avoided, codes
accepted and refused, private HR calls, and handoffs.

> "The same numbers come from the same audit log in production. Private HR calls show as
> “<5” until there are enough that nobody can be singled out."

After all seven beats in order from a reset, the footer reads: **7** calls, **4** answered,
**2** tickets filed, **1** duplicate avoided, **1** verified by code, **1** wrong code
refused, **<5** sensitive routed privately, and **3** handed off.

---

## If something goes wrong

- **A beat went sideways.** Press its number. The beat resets its clock and answers a fresh
  call, so it re-runs from the top.
- **Everything looks wrong.** **Reset demo**, then **1**.
- **The ticket isn't INC-004821.** Ticket numbers only restart on **Reset demo**, so a
  re-run of beat 1 files the next number. Reset, then run beat 1.
- **No sound.** Check the voice menu, and that the URL has `?voices=online` in Edge. Or just
  narrate — the voices are a presenter aid, not part of the product.
- **The chip says live · Teams Phone.** See the mode chip above: restart with
  `PUBLIC_BASE_URL= npm start`.

## Taking a real call

With Azure configured (see the README, "Live setup"), the chip says **live · Teams Phone**
and the console follows a real call to the help line whenever it isn't showing a scripted
one: call it from Teams or a phone, and the transcript, identity checklist, decision, Teams
toast and trail fill in from the real call, with the room voice muted. The demo clock is
real time and **Reset demo** is off. The scripted beats still run as simulated calls: a
simulated call is never transferred for real, and its codes and tickets appear only in the
mock chat.

A Teams caller is verified by sign-in and needs no code. A real phone caller does: the
server generates the code but only logs that delivery is a stub until you wire
`OtpSender.deliver` (`src/adapters/otp.mjs`) to your Teams chat, email or SMS sender. Until
then, show phone verification with beat 3.

## If someone asks

**"Is this actually running Azure?"**
Not right now — it's in simulation mode, which is why it can't fail on stage. Set three
environment variables and the same server answers a Teams Phone resource account through
**Teams Phone extensibility**: Azure Communication Services Call Automation answers the call
and bridges its audio, and the **Azure AI Voice Live API** listens and speaks. The stand-ins
are the classifier (a deterministic keyword router in `src/offline.mjs` takes the model's
place), the audio, the delivery of one-time codes, and the ticketing, HR and directory
systems, which are JSON fixtures in `config/`. Everything you watched decide — who the
caller is, what may be read out, the priority, the private route, the queue — is the real
policy code.

**"Why doesn't a Teams caller need a code?"**
With Teams Phone extensibility, a call from the Teams app arrives as the signed-in Teams
user, not as a phone number, so the identity comes from the employee's Microsoft Entra
sign-in. A phone call only brings caller ID, which is easy to fake, so the sample treats it
as a hint and asks for a one-time code before anything personal. The code goes to the
employee on record, not to whoever is calling.

**"How does the context reach the person who picks up?"**
As VoIP custom headers on the Call Automation transfer — the panel shows them exactly as
sent. Not SIP headers: those are a PSTN-side mechanism and never reach a Teams identifier.
Each queue gets only the fields `config/routing.json` allows it, and the confidential HR
line gets the words "Confidential HR" and nothing else.

**"Can the model make something up?"**
Not where it matters. Answers are read from approved articles in `kb/`, each with an owner
and a review date, and an article past its date isn't read out at all. Priority comes from
`config/priority-matrix.json`, who may hear a ticket's status is checked against its owner,
and the sensitive-topic guard runs before the classifier. The model proposes; the server
decides.

**"What would I change first?"**
`config/routing.json` for your queues' Teams object ids and hours (the sample ships
placeholders), `config/taxonomy.json` and `kb/` for your topics and approved answers, and
`config/sensitive.json` — agree those categories with HR, legal and employee relations
before any real call. Then swap the fixtures in `src/adapters/` for your directory, HR and
ticketing systems, and wire code delivery.
