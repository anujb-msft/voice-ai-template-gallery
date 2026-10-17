# Demo script — 6 beats, about 6 minutes

A rehearsable running order for the General Inquiry Agent: the City of Contoso
information line. Every beat runs in **simulation mode**, so no Azure subscription, phone
number or Teams tenant is needed, and the demo itself doesn't depend on a network; only the
optional online voices do.

**The beats:** 1 Hours, with the source · 2 Due for review: a caveat · 3 Out of date: not
read out · 4 After hours · 5 Eligibility: a person decides · 6 Not on this line: a person.

The argument you are making is *not* "a model can answer questions from documents".
Everyone believes that already. It is: **the interesting part is what the server won't let
the model say** — an answer from a page past its review date, whether the office is open
right now, and whether a caller qualifies.

The console drives itself. Each press of **→** runs one step of the script and types (and,
if you like, speaks) the caller's line, so your hands are free and your eyes are on the room.
The blockquotes, and the quoted cue after each **→**, are the narration in
[`public/beats.js`](public/beats.js), word for word; press **N** to show it under the beat
strip while you rehearse.

---

## Set up — five minutes before

```bash
npm install
npm start                          # http://127.0.0.1:8092
curl -s 127.0.0.1:8092/health      # expect "mode": "simulation"
```

- [ ] Open **Microsoft Edge** at `http://127.0.0.1:8092/?voices=online`. Edge's online
      voices are the Azure neural voices, so the room *hears* a voice product. Without
      `?voices=online` the console uses on-device voices only and nothing leaves the machine.
- [ ] Set the voice menu (top right) to **Speak agent + caller**, or **Speak agent** if you
      would rather read the caller's lines yourself. Then click an empty part of the page:
      while a menu has the focus, the arrow keys change the menu instead of running the script.
- [ ] Zoom to **125%** (Ctrl and +) and press **F11**.
- [ ] Press **Reset demo**: no calls and zeroed metrics. Every beat sets the demo clock it
      needs, so the time of day you present at doesn't matter.
- [ ] Run beat 1 once to wake the voices, then press **Reset demo** again.

The chip in the top-right corner must say **simulation mode**. If it says **live · Teams
Phone**, this server found Azure settings in `.env`, and the demo clock and reset are
switched off so they can't affect real calls. Start it with `PUBLIC_BASE_URL= npm start` to
force simulation (an empty variable wins over `.env`), on another `PORT` if the live server
is still running.

The demo clock is in the top bar. Its presets — **Business hours** (Wednesday,
September 30, 2026, 10 a.m. Pacific), **After hours** (7 p.m. the same day) and **Real
time** — are there for "what if…?" questions; the beats set it for you. Content freshness
and the desk's hours are both judged on that clock, which is why the article that is due
for review in beat 2 stays due for review however long after today you present.

### Driving it

| Key | What it does |
| --- | --- |
| **→**, **PageDown** or a presenter clicker | Run the next step |
| **Auto-play** | Run the rest of the current beat |
| **1**–**6** | Jump to a beat (or click its title in the beat strip). Each beat sets the clock and answers its own call, so any beat re-runs cleanly, in any order |
| **PageUp** | Back to the start of this beat; press again for the previous beat |
| **Esc** | Stop auto-play and the voices |
| **N** | Show or hide the narration under the beat strip |

The manual controls work at any point: pick a **Caller ID** and press **Answer a call**,
type what the caller says and press **Say**, press keypad **0** for a person, or send
**Silence** or **Hang up**. Use them for "what if…?" questions, then press a beat number to
get back on script.

---

## 1 — Hours, with the source *(~75s)*

Before you press anything, point at the empty console and set up the problem in your own
words: a city information line hears the same questions all day — when are you open, do I
need a permit, do I qualify — and the hard part isn't answering them. It's saying only what
the city has approved, and stopping when a page goes out of date.

> "A resident calls the City of Contoso information line with an everyday question. It's
> Wednesday, 10 a.m. on the demo clock."

**→** **A resident calls the information line.** "The agent says up front that it's
automated, and what it can help with."

**→** *"What are City Hall's hours?"* "The model can only answer from approved city
content. Watch the source panel: the content id, the owner, and the review date."

The agent answers from the article and adds *"City Hall is open right now, until 5 p.m."*
Point at **Source on screen**: `city-hall-hours`, owned by **Contoso Customer Service**,
last reviewed **Aug 15, 2026**, review by **Feb 15, 2027**.

**→** *"Where did that come from?"* "Ask where an answer came from and you get the source,
with a short URL to check it." The agent reads out **contoso.gov/cityhall**.

**→** *"Thanks, that's all."* The call closes.

> "Every answer comes from an article with an owner and a review date, and names its
> source. Whether City Hall is open right now came from the server's clock, not from the
> model."

## 2 — Due for review: a caveat *(~45s)*

> "Content goes out of date. The bulky item pickup article was due for review in July."

**→** **Another resident calls.**

**→** *"Can the city pick up an old sofa?"* "The article is past its review date but inside
the 90-day grace period. The agent may use it, but it has to say so."

The agent answers, then adds *"This information was due for review in July, so please check
contoso.gov/bulky or ask staff before relying on it."* The decision reads **Answered — with
a caveat**, and **Freshness** in the source panel reads *due for review — inside the 90-day
grace, caveat required*. In **Content and desk**, the Bulky item pickup row reads *77 days
past review · read out with a caveat for 14 days more*.

> "The caveat isn't the model being cautious. The server marked the passage as due for
> review, and the audit log flags the answer. In two weeks, this article won't be read out
> at all."

The resident is still on the line; the next beat hangs up before it answers a new call.

## 3 — Out of date: not read out *(~60s)*

> "The yard-sale permit article is six months past its review date. The rules may have
> changed since."

**→** **A resident calls about a yard sale.**

**→** *"Do I need a permit for a yard sale?"* "The search finds the article, but the server
withholds it. The model is told only that an out-of-date match exists, so it can't read it
out as fact."

The agent: *"I found something on that, but it's past its review date and may be out of
date, so I can't give it to you as an answer. I can't confirm the current rules, but staff
can, or you can check contoso.gov. Would you like me to connect you?"* Point at **Out of
date — not read out**, then at the source panel: `yard-sale-permit`, **Review by** *Apr 1,
2026 · 182 days ago*, and **Shown to the model** *only that an out-of-date match exists*.

This is the most important point in the demo, so say it plainly: this isn't a prompt asking
the model to be careful. The old rules never reached the model, so there was nothing for it
to paraphrase.

**→** *"No thanks, I'll check the website."* "The caller can say no. Nobody gets pushed into
a queue." The agent says goodbye.

> "The agent says what it can't confirm and offers a person or the website. The refusal is
> a policy decision in code, and it's counted."

## 4 — After hours *(~60s)*

> "Same server, 7 p.m. the same Wednesday. City Hall and the information desk have both
> closed."

**→** **A resident calls after hours.** The demo clock jumps to 7 p.m., and the
**Information desk** row in **Content and desk** turns **closed**.

**→** *"What are City Hall's hours?"* "Same article, same answer, but whether City Hall is
open now follows the clock." This time: *"City Hall is closed right now and opens again
Thursday at 8 a.m."*

**→** *"Can I talk to a person?"* "Nobody is at the desk, so the server won't transfer the
call into an empty queue." The agent: *"I can't connect you right now — the information
desk is closed and opens again Thursday at 8 a.m. Our information desk is open weekdays
from 8 to 5. Please call back then, or visit contoso.gov. Goodbye."* The decision reads
**The information desk is closed**, and the Teams panel says *No transfer — the desk is
closed on the demo clock, so nobody's Teams client rings.*

> "Instead, the agent gives the next opening, Thursday at 8 a.m., and points to
> contoso.gov. There's no dead-end transfer, and no promise of a callback the city can't
> keep."

## 5 — Eligibility: a person decides *(~75s)*

> "Back to business hours. Whether someone qualifies for a program is a staff decision, not
> the agent's."

**→** **A resident asks about a discount.** The clock goes back to 10 a.m.

**→** *"I'm 67 — do I qualify for the senior utility discount?"* "The agent reads out the
published criteria but doesn't rule on the caller's own situation. Their age is masked
before it reaches the search or the audit log."

The agent reads the criteria from **Contoso Benefits Office — Utility discount**, then:
*"Staff make the final decision on eligibility. I can't check your situation on this line,
but staff can. Would you like me to connect you?"* The decision reads **Criteria only —
staff decide**.

**→** *"Yes, please."* "Watch the Teams panel."

The mock Teams toast for the **Contoso information desk** shows the topic **Senior utility
discount — eligibility** and one line of context: *Caller asked: "I'm [number] — do I
qualify for the senior utility discount?" Answered from senior-utility-discount.
Transferring because eligibility needs a staff decision.* Point at the **[number]**: the
server masked the age before it searched, logged the question or built the handoff. Then
point at **VoIP headers on the wire** — `CallDetails.SessionId`, `CallDetails.CallTopic`
and `CallDetails.CallContext`, built by the same function a real transfer uses.

> "The staff member's Teams client rings with the topic and what was already covered, so
> the caller doesn't have to repeat it. The topic and the summary never say the same thing
> twice."

## 6 — Not on this line: a person *(~60s)*

> "Some calls aren't questions at all. This line answers from approved content; it doesn't
> file service requests."

**→** **A caller with a withheld number.**

**→** *"I want to report a pothole on Elm Street."* "The agent doesn't pretend to file it.
It says what this line can't do, and offers a person." The decision reads **Not something
this line can do**.

**→** *"Can I talk to a person, please?"* "Asking for a person always works while the desk
is staffed." The toast's topic is the caller's own words — **Report a pothole on Elm
Street** — and the caller shows as **Number withheld**.

**→** **Show the numbers.** "Every call is audited: grounded answers, caveats, refusals,
handoffs, and after-hours closures."

After one clean run from **Reset demo**: **6** calls, **4** answered and grounded, **1**
with a caveat, **1** refused as out of date, **2** handed to a person, **1** closed after
hours, and **1** with no approved answer (the pothole).

> "These numbers come from the same audit log in production."

---

## If something goes wrong

- **A beat went sideways.** Press its number. The beat resets its clock and answers a fresh
  call, so it re-runs from the top.
- **Everything looks wrong.** **Reset demo**, then **1**.
- **The numbers at the end are bigger.** They count every simulated call since the last
  reset, including re-runs and anything you typed by hand. Press **Reset demo** before you
  start.
- **→ does nothing.** The focus is in a menu, or in the caller box with text in it. Click an
  empty part of the page, or press **Next ▶**.
- **No sound.** Check the voice menu, and that the URL has `?voices=online` in Edge. Or just
  narrate — the voices are a presenter aid, not part of the product.
- **"This server answers real calls, so the demo clock stays on real time."** The server is
  live, so the beats run on today's real date and time, and what they show about freshness
  and the desk's hours depends on when you run them. Use a simulation server; see the mode
  chip, above.

## Taking a real call

With Azure configured (see the README, "Connecting it to a real phone number"), the chip
says **live · Teams Phone** and the console follows a real call to the Teams Phone number
whenever it isn't showing a scripted one: dial it, and the transcript, decision, source,
Teams toast and trail fill in from the real call, with the room voice muted. The demo clock
is real time and **Reset demo** is off, so freshness and the desk's hours are judged on the
real date. The scripted beats still run as simulated calls, and a simulated call is never
transferred for real.

## If someone asks

**"Is this actually running on Azure?"**
Not right now — it's in simulation mode, which is why it can't fail on stage. With three
environment variables set, and the Teams Phone setup in the README done, the same server
answers a real phone number through **Teams Phone extensibility**: the caller dials a Teams
service number on a resource account, and Teams hands the call to the linked Azure
Communication Services resource. **ACS Call Automation** answers it and is the media bridge,
streaming the caller's audio to this server and the agent's audio back. The **Azure AI Voice
Live API** does the listening and the speaking.

**"So what's simulated?"**
The audio, the model's wording, and the transfer. A typed line stands in for speech, and a
small offline agent (`src/offline.mjs`) calls the same server functions the real model's
tools call: `search_content`, `record_answer`, `request_human` and `end_call`. Everything
you watched decide is the real code: the content index, the freshness policy, the hours,
the masking, the handoff context and the audit trail. The Teams toast is a mock; the VoIP
headers under it are the real ones.

**"Couldn't the model just ignore the policy?"**
Not the parts that matter. An expired article is removed from the search results before the
model sees them. A stale one comes back marked as due for review: the instructions tell the
agent to read the caveat, and the audit log flags any answer built on it. `record_answer`
refuses to cite an article the last search didn't return. Whether a place is open right
now, and whether a person can take the call, comes from the server's clock and
`config/hours.json` — the model is never asked to work it out. And the caller's numbers are
dropped from every search, whatever query the model writes.

**"How does the context reach Teams?"**
VoIP custom headers on the transfer: `CallDetails.SessionId`, `CallDetails.CallTopic`
(clipped to the Teams 48-character limit) and `CallDetails.CallContext`, plus
`CallDetails.CallSentiment` only when the agent passes one. Not SIP headers — those are a
PSTN-side mechanism and don't reach a Teams identifier.

**"What would I customize first?"**
The content. `content/articles/` holds one Markdown file per approved answer, each with an
owner, a source, a short URL, `lastReviewed` and `reviewBy` dates and, for a place, its
`openHours`; replace the Contoso articles with your own. Then `config/hours.json`: your time
zone, the desk's staffed hours, the after-hours message, and your Teams call queue's object
ID. Then two numbers in `.env`: the grace period after a review date
(`CONTENT_EXPIRY_GRACE_DAYS`, 90 days) and the retrieval bar (`RETRIEVAL_MIN_SCORE`, 2.5).
The dates, hours and thresholds aren't in the prompt, so changing them doesn't mean
rewriting it.

**"Can it take a message or book a callback?"**
No, on purpose. After hours it gives the next opening and the website, and promises nothing
the city hasn't agreed to.

**"What about public holidays?"**
Not modeled yet. The staffed hours are weekly, so a holiday looks like a normal weekday.
Add closures to `config/hours.json` and `src/hours.mjs` before you put a real number on it.

**"Where does this break?"**
Retrieval is keyword scoring over a dozen Markdown files: right for a demo, not for a
city's website. Swap the scoring in `src/content.mjs` for Azure AI Search or your own
knowledge base, and keep the freshness check on what comes back; the citations, the hours
and the handoff don't change. And review dates only help if somebody owns them, so every
article names an owner.
