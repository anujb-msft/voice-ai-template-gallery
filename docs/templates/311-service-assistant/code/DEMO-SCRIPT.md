# Demo script — 5 beats, about 6 minutes

Report a pothole · I smell gas · Same service in Spanish · A civic question · A complaint, to a person.

A rehearsable running order for the City of Contoso 311 Service Assistant. Every beat runs
in **simulation mode**, so no Azure subscription, phone number or Teams tenant is needed,
and nothing on stage depends on a network.

The argument you are making is *not* "a model can hold a phone conversation". Everyone
believes that already. It is: **the server, not the model, decides what happens** — the
emergency rule, the verified location, the approved answer, the text that needs consent,
and the handoff to a person. The model makes the call pleasant; the city's own rules make
it safe.

The console drives itself. Each press of **→** runs one step of the script and types (and,
if you like, speaks) the caller's line, so your hands are free and your eyes are on the room.

---

## Set up — five minutes before

```bash
npm install
npm run rehearse                   # every beat, three ways, on its own server (~1 min)
npm start                          # http://127.0.0.1:8096
curl -s 127.0.0.1:8096/health      # expect "mode": "simulation"
```

`npm run rehearse` plays the script the way the console does and fails if any beat would
land somewhere this page doesn't say. It runs its own server on port 8296 with the shipped
settings (not your `.env`), so it can run while your demo server is up.

- [ ] Open **Microsoft Edge** at `http://127.0.0.1:8096/?voices=online`. Edge's online
      voices are the Azure neural voices, so the room *hears* a voice product, and Lucía's
      lines in beat 3 are read in a Spanish voice. Without `?voices=online` the console uses
      on-device voices only and nothing leaves the machine.
- [ ] Set the voice menu (top right) to **Speak agent + caller**, or **Speak agent** if you
      would rather read the caller's lines yourself.
- [ ] Zoom to **125%** (Ctrl and +) and press **F11**. The beat strip should fit on one line.
- [ ] Press **Reset demo**: no calls, no service requests, no texts on the phone panel, and
      zeroed metrics. Every beat sets the clock it needs (a Wednesday at 10:30 a.m., when
      every department is open), so the time of day you present at doesn't matter.
- [ ] Run beat 1 once to wake the voices, then press **Reset demo** again. Beat 1 resets
      the demo before Alex calls, so on stage the pothole is filed fresh as SR-26-0193,
      not added to the report you just rehearsed.

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
| **1**–**5** | Jump to a beat. Each beat sets the clock and answers its own call, so beats run in any order. Beat 1 also resets the demo |
| **PageUp** | Back to the start of this beat; press again for the previous beat |
| **Esc** | Stop auto-play and the voices |
| **N** | Show or hide the narration under the beat strip |

The manual controls work at any point: pick a **Caller ID**, click **Answer a call**, type
your own caller line, press a keypad key (**1** yes, **2** no, **0** a person, **\*** repeat),
or send **Silence** or **Hang up**. Use them for "what if…?" questions, then press a beat
number to get back on script.

---

## 1 — Report a pothole *(~90s)*

Before you press anything, point at the empty console.

> "Alex reports a pothole the way people actually talk: a street and a corner. No form, no
> menu."

**→** Alex Chen calls 311. The greeting says "dial 911" before anything else — *"City of
Contoso 311. I'm an automated assistant. For emergencies, hang up and dial 911. How can I
help? Para español, hable en español."* — and every caller turn is checked for an
emergency first.

**→** *"Hi, there's a big pothole on Oak Avenue, right at the corner of Fifth Street."* The
geocoder on the server, not the model, turns that into a verified location: **Oak Avenue at
5th Street**, zone B. The agent reads it back: *"I have the pothole at Oak Avenue and 5th
Street. Is that right?"*

> "The model heard a sentence. The server turned it into a place the city's map knows, and
> nothing is filed until the caller says yes. A report at the wrong corner sends a crew to
> the wrong corner."

**→** *"Yes, that's right."* Only a confirmed location gets filed. Point at the case card:
**SR-26-0193** · Pothole · Public Works · Oak Avenue at 5th Street · zone B · Standard ·
response target 5 business days, due October 7. The agent reads the number in groups,
twice: *"S R, 2 6, 0 1 9 3."*

**→** *"Yes, text me updates please."* A text goes out only with consent. In simulation it
lands on the **Caller's phone** panel, marked *simulated — never sent*: *"City of Contoso
311: your pothole report at Oak Avenue and 5th Street is case SR-26-0193…"*

**→** *"No, that's all, thanks."* Goodbye.

> "SR-26-0193 is filed against a verified location and routed to Public Works with a
> five-business-day target. The caller's number stayed on the server; the model never saw
> it."

## 2 — I smell gas *(~45s)*

> "Some calls must never turn into a service request."

**→** Sam Rivera calls 311.

**→** *"Hi, I smell gas in my kitchen and I'm not sure what to do."* The emergency rule runs
on the server before the model gets a turn. The decision panel turns red — **Emergency rule
fired**, heard "smell gas" — and the agent gives safety guidance and the gas utility's
number, with no questions: *"This sounds like a gas emergency. Please leave the building now
and don't switch anything on or off. Once you're outside, call the gas utility at 555-0109,
or dial 911."* The call ends.

> "A model that gets this right almost every time is a model that, once in a while, asks
> someone standing in a gas-filled kitchen for their cross street. So it isn't the model's
> call. Every caller turn goes through a rule on the server first, and the phrases and the
> guidance live in `config/emergency.json`, where the people who own emergency language can
> review them."

No report, no questions, no case number. The rule fired in code, the caller heard what to
do, and the trail shows `emergency_redirect` in red.

## 3 — Same service in Spanish *(~75s)*

> "Lucía calls in Spanish. Same rules, same service; only the language changes."

**→** Lucía Ortega calls 311. The greeting ends with *"Para español, hable en español"*. No
menu to find.

**→** *"Hola, necesito que recojan un colchón y un sofá viejo."* The server hears Spanish and
switches the agent's locale to **es-US** and its voice to **es-US-PalomaNeural** — the
decision panel says **Caller switched to Spanish**. Both items are on the city's accepted
list: *"Puedo programar la recogida de un colchón y un sofá. ¿Cuál es la dirección de
recogida?"*

**→** *"En el 1200 de Maple Street."* The pickup date comes from the zone calendar in config,
not from the model: **SR-26-0194**, *"el sábado 3 de octubre"*.

**→** *"Sí, por favor."* Consent first, then the text, in Spanish.

**→** *"No, gracias."*

> "Nobody pressed 2 for Spanish, and nobody maintains a second copy of the rules. The
> accepted-items list, the calendar and the case store are the same ones Alex used."

SR-26-0194: a mattress and a sofa, picked up Saturday, October 3, from the zone A calendar.
The language travels with the case, and would travel with a handoff too.

## 4 — A civic question *(~60s)*

> "Questions get answers only from approved, reviewed content, with the source named."

**→** Sam Rivera calls with two questions.

**→** *"When is trash pickup on Maple Street?"* The answer is read from a reviewed article,
and the agent says where it came from: *"…Maple Street is in Zone A with regular pickup on
Tuesday… Source: Sanitation service guide."* The **Approved content** list shows the article
and its review date.

**→** *"And what are the counter hours at City Hall?"* The only match is an expired notice.
The server withholds it — the list marks it **expired · withheld** — so there is no
guessing, and 311 staff are offered instead: *"I don't have approved information on that, so
I won't guess. Would you like me to connect you with 311 staff?"*

> "The most damaging answer a city can give is a confident, out-of-date one. Every article
> carries the date it was last reviewed, and past the grace period the server won't let it
> be read out. The honest answer is 'I don't know — here's a person'."

**→** *"No, that's all."*

One answer with its source, and one honest "I don't have approved information on that".
Expired content never reaches the caller.

## 5 — A complaint, to a person *(~75s)*

> "An unhappy caller. The agent listens, doesn't argue, and offers a person."

**→** A caller with a withheld number.

**→** *"I want to make a complaint. The trash trucks have skipped my street three weeks in a
row and nobody has called me back."* The server hears a complaint and frustration. No
promises: the agent apologizes and offers a report or a person — *"I'm sorry about that. I
can hear how frustrating it is. I can file a missed-pickup report now, or connect you with a
311 staff member who can look into it. Which would you prefer?"*

**→** *"I'd like to talk to a person, please."* A warm handoff to the **311 Live Agent
Queue**. Move to **Teams · 311 staff**: the topic (*"Complaint: trash trucks have skipped my
street…"*), a summary, the sentiment and the language arrive with the call, and the caller's
own words travel in the context.

Point at **VoIP headers on the wire**: `CallDetails.SessionId`, `CallTopic`, `CallContext`
and `RouteId`, the same context as the Teams client receives it.

> "Nobody at 311 has to ask 'so what's this about?', and the caller doesn't have to tell
> the story twice."

**→** **Show the numbers.** Every call is audited: requests created, emergencies escalated,
questions answered and handoffs. From a reset, the five beats leave 5 calls, 2 requests
created, 1 emergency escalated, 1 answered from approved content, 1 handed to a person, 2
texts with consent and 1 call in Spanish.

> "311 staff pick up already knowing what the call is about. The same numbers come from the
> same audit log in production."

---

## If something goes wrong

- **A beat went sideways.** Press its number. The beat resets its clock and answers a fresh
  call, so it re-runs from the top. Beat 1 resets the whole demo, so the metrics start
  again from it.
- **Everything looks wrong.** **Reset demo**, then **1**.
- **No sound.** Check the voice menu, and that the URL has `?voices=online` in Edge. Or just
  narrate — the voices are a presenter aid, not part of the product.
- **No text on the phone panel.** A text needs the caller's yes and a caller number. Beat
  5's caller withheld theirs, so there is nothing to text.

## Taking a real call

With Azure configured (see "Connecting it to a real phone number" in the README), the chip
says **live · Teams Phone** and the console follows a real call to the Teams Phone number
whenever it isn't showing a scripted one: dial it, and the transcript, decisions, case card
and Teams toast fill in from the real call, with the room voice muted. The demo clock is
real time and **Reset demo** is off. The scripted beats still run as simulated calls: a
simulated call is never transferred for real, and its texts stay on the phone panel.

## If someone asks

**"Is this actually running on Teams?"**
Not right now — it's in simulation mode, which is why it can't fail on stage. Configure it
and the identical flow answers a Teams Phone number through **Teams Phone extensibility**:
the caller dials a Teams service number, Teams hands the call to a linked **Azure
Communication Services** resource, and Call Automation answers it and bridges the audio to
the **Azure AI Voice Live API** (`gpt-realtime`) for speech in and out. Handoffs go back
into Teams call queues with the context attached.

**"What's simulated?"**
The phone line, the speech and the model. In simulation a small keyword stand-in plays the
agent, so the demo is the same every time. The emergency rule, the geocoder, the request
rules, content freshness, the duplicate check, office hours, the case store and the handoff
context are the real code, and they run the same way on a live call.

**"Why doesn't the gas call go to a person?"**
Because the right person isn't at 311. The guidance is to get out first and call from
outside; a transfer would keep the caller on the phone, in the building, waiting for someone
to pick up. So the agent gives the guidance and the utility's number, logs the redirect and
ends the call. The phrases, the guidance and the number are in `config/emergency.json`.

**"How does the context reach Teams?"**
VoIP custom headers on the transfer, built on the server. Not SIP headers — those are a
PSTN-side mechanism and never reach a Teams identifier, so the call would connect and staff
would answer blind.

**"What does a developer change first?"**
`config/`: the request types and the questions each one needs, the departments with their
Teams queue object IDs and hours, the emergency phrases, the bulk-pickup calendar, and the
address fixtures (swap in your city's address service). Then `content/articles/` for the
approved answers, and `public/beats.js` to rewrite this demo for your city. The report types
the agent knows about are generated from `config/request-types.json`, so adding one is not a
prompt rewrite.

**"What if two people report the same pothole?"**
The second report joins the first instead of filing a second case: an open pothole within
50 m, reported in the last 7 days, is the same pothole. To show it after beat 1, click
**Answer a call** and type Alex's two lines again: *"That pothole at Oak Avenue and 5th
Street was already reported, so I've added your report to case S R, 2 6, 0 1 9 3."* If the
second report is a hazard, such as a large pothole in the travel lane, it also raises that
case to priority.

**"What if it doesn't understand?"**
It asks once more. A second miss goes to 311 staff. After hours, when there is nobody to
hand the call to, a third miss ends the call politely with the hours to call back. Silence
twice ends the call, and **0** on the keypad asks for a person at any point. Every dead end
is a person or an honest goodbye, never a loop.

**"Where does this break?"**
The geocoder here is a fixture with a handful of streets, so a place it doesn't know gets
"I couldn't verify that location" and nothing is filed. A second place it can't verify goes
to 311 staff, like any other miss. A real deployment plugs in the city's address service.
And caller ID isn't authentication, which is why a status check gives only the status and
the department, never who reported it.
