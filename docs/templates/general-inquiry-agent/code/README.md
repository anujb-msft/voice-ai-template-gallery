# General Inquiry Agent

The City of Contoso's information line, answered by a voice agent. A resident calls with a
question about city services, hours, locations, policies or eligibility, and gets an answer
read from approved content with its source named — or a person, with the question already
on their screen.

The point is not that a model can answer a question from documents. It is what the server
won't let the model decide: whether an answer is too out of date to read out, whether City
Hall is open right now, and whether a caller qualifies for a program. Those calls are made
in code, on the server's clock, and every one of them lands in the audit log.

Built on [Azure Communication Services Call Automation](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation),
the [Azure AI Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live),
and [Teams Phone extensibility](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-overview).

> Illustrative sample. The city, its content, its information desk and the phone numbers
> are fictional. Read [Security notes before production](#security-notes-before-production)
> before pointing this at a real phone number.

## What the demo shows

- **Answers from approved content only, with the source named.** Every answer comes from
  `content/articles/*.md` and says where it came from; "Where did that come from?" gets the
  source and its short URL. The console shows the article id, its owner and its review date.
- **A freshness gate the model can't talk its way past.** Every article has a `reviewBy`
  date. Past it, the answer carries a spoken caveat and is flagged in the audit log. More
  than 90 days past it, the article's text never reaches the model: the agent says what it
  can't confirm and offers a person.
- **Open or closed comes from the clock, not the model.** "City Hall is open right now,
  until 5 p.m." is worked out on the server from the article's published hours, in the
  city's time zone.
- **No transfer into an empty queue.** Outside the information desk's staffed hours, asking
  for a person — or pressing 0 — gets the next opening time and the after-hours message
  instead of a transfer nobody will answer.
- **Eligibility is decided by staff.** The agent reads the published criteria, says staff
  make the final decision, and offers a person. An age or an income the caller mentions is
  kept out of the search and masked as `[number]` in the audit log and in what Teams
  receives. There is no caller lookup: the agent never sees an account or a record.
- **Context that survives the handoff.** The subject, and a summary of what was asked,
  answered and held back, travel to Teams as VoIP headers. The console shows the literal
  headers next to a mock Teams incoming-call toast, and the summary never repeats the topic.
- **Honest limits.** With no approved answer, or a service request this line can't take,
  the agent says so rather than guessing, and offers a person — or, after hours, the next
  opening time. Two silences, or a call that reaches its five-minute limit, go to a person
  while the desk is staffed. The opening line says it is an automated assistant.
- **The numbers at the end.** Answered and grounded, answered with a caveat, refused as out
  of date, handed to a person, closed after hours, and no approved answer — from the same
  audit log a real deployment writes.
- **A local console.** Every state change reaches the presenter console over the server's
  own WebSocket (`/ws/hub`); there is no SignalR dependency.

## Quick start

Runs with no Azure subscription at all. Needs Node.js 22 or later.

```bash
npm install
npm start
# open http://127.0.0.1:8092
```

The console runs a scripted demo: press **→** (or **Next ▶**) and it plays six short beats,
typing the caller's lines for you; set the voice menu to **Speak agent + caller** to hear
both sides. Each beat sets the demo clock it needs. [DEMO-SCRIPT.md](DEMO-SCRIPT.md) is the
running order, with what to say at each step.

Or drive it yourself. The demo clock starts on real time unless `DEMO_NOW` or `DEMO_TODAY`
is set, so first click **Business hours** in the top bar. Then pick a **Caller ID**, click
**Answer a call**, and type what the caller says; the **0** key, **Silence** and **Hang up**
stand in for the keypad, a no-input timeout and the caller hanging up. A typed line drives
the same state machine a real call would — the same content index, freshness policy, hours
and handoff assembly. Only the audio, the model's wording and the transfer itself are
simulated.

Try these, on the **Business hours** clock:

| Type this | What you should see |
| --- | --- |
| `What are City Hall's hours?` | The hours, "City Hall is open right now, until 5 p.m.", and the source named |
| then `Where did that come from?` | The source again, with its short URL, `contoso.gov/cityhall` |
| `Can the city pick up an old sofa?` | An answer with a caveat: the article was due for review in July |
| `Do I need a permit for a yard sale?` | Not read out, because the article is out of date; the agent says what it can't confirm and offers a person |
| `I'm 67 — do I qualify for the senior utility discount?`, then `Yes, please.` | The published criteria and "Staff make the final decision on eligibility", then a handoff whose context says `[number]`, not 67 |
| `I want to report a pothole on Elm Street.` | This line can't file service requests, so it offers a person |
| `Can you recommend a good pizza place?` | No approved answer, so it won't guess; it offers a person |
| `Can I talk to a person?`, or the **0** key | Straight to the information desk |
| **Silence** twice | A reprompt that mentions 0, then a person |
| Click **After hours**, then `Can I talk to a person?` | No transfer: the desk is closed and opens again Thursday at 8 a.m. |

A whole typed call also runs through the API, on whatever the demo clock says.
`config/offline-transcript.json` is a ready-made one:

```bash
curl -s http://127.0.0.1:8092/api/simulate \
  -H 'content-type: application/json' \
  -d @config/offline-transcript.json
```

The response has each turn's result and the final call snapshot.

Run the tests — they need no Azure and no network:

```bash
npm test        # 46 cases across content, freshness, hours, the flow and the Teams handoff
npm run check   # syntax check of src/, scripts/, test/ and the console scripts
npm run smoke   # boots its own simulation server on port 8192 and checks both WebSockets and the demo controls
```

The tests cover fresh, stale and expired retrieval, misses and service requests,
eligibility disclaimers and the personal-detail guard, citations and multi-question calls,
repeat and slower, DTMF `0`, human requests in and out of staffed hours, no-inputs, the
call cap, a failed transfer, an invalid `record_answer`, a prompt-injection attempt, the
demo clock and the handoff headers. `npm run check` is a POSIX shell loop, so on Windows
run it from Git Bash or WSL. `npm run dev` starts the server in Node's watch mode.

### Demo controls

In simulation mode the console can move the clock the policy sees — content freshness,
City Hall's opening hours and the desk's staffed hours — so one running server shows both
the business-hours and the after-hours paths, and the same articles stay fresh, due for
review or out of date however long after today you run it:

| Endpoint | What it does |
| --- | --- |
| `GET /api/demo/clock` | The demo clock, its time zone and the presets |
| `POST /api/demo/clock` | `{ "preset": "business-hours" \| "after-hours" \| "real" }` or `{ "at": "<ISO 8601>" }` |
| `POST /api/demo/reset` | Forget the simulated calls, clear them from the audit and restore the starting clock |
| `GET /api/stats` | The metrics: calls, answers, grounded-answer rate, answers with a caveat, expired refusals, misses, transfers, failed transfers, human requests, after-hours closures, declined offers, escalation and deflection rates, and counts per topic |

**Business hours** is Wednesday, September 30, 2026, at 10 a.m. Pacific; **After hours** is
7 p.m. the same day, when City Hall and the desk are closed until Thursday at 8 a.m. Both
`POST`s return `403` while the server answers real calls: a real caller always gets answers
judged on the real date, and a reset never deletes a real call's audit record. Set
`DEMO_NOW` to start the server with the clock already set; it runs on from there. Moving the
clock keeps an open call's elapsed time.

## How it works

```
PSTN caller → Teams service number → resource account → linked ACS resource
   │  Event Grid: Microsoft.Communication.IncomingCall
   ▼
ACS Call Automation ──── answerCall + bidirectional media streaming ────┐
   │                                                                    │
   │  PCM16 24 kHz mono (pcm24KMono)                                    │
   ▼                                                                    │
this server ──── WebSocket, PCM16 forwarded verbatim ────► Voice Live ──┘
   │                                                     (gpt-realtime)
   │  search_content / record_answer / request_human / end_call
   ▼
InquiryFlow ──── TransferCallToParticipant + VoIP custom context ────► Teams
   │                                                             call queue
   ├── ContentIndex   content/articles/*.md, judged on the server's clock
   └── StaffedHours   config/hours.json: the desk's hours and its queue
```

### The decision lives on the server

`src/flow.mjs` owns every decision that matters and imports nothing from Azure, Express or
SQLite. The model's powers are narrow: it can search the approved content, record which
articles an answer came from, ask for a person, and end the call. It never sees a Teams
object ID, a phone number or a destination — `request_human` takes a reason, a short topic
and an optional sentiment, and the information desk in `config/hours.json` is the only
place a call can go.

```
ringing → greeting → listening ⇄ answering
                         │
                         ├──→ transferring → transferred
                         │          └──→ closed   (the transfer failed)
                         └──→ closed   (after hours, caller done, caller hung up)
```

| Rule | Where it is enforced |
| --- | --- |
| What can be said | `ContentIndex.search` in `src/content.mjs`: approved articles only, scored against `RETRIEVAL_MIN_SCORE` |
| Fresh, due for review, or out of date | `ContentIndex.freshness`, on calendar dates in the city's time zone, with `CONTENT_EXPIRY_GRACE_DAYS` after `reviewBy` |
| Out-of-date text never reaches the model | `ContentIndex.search` holds expired passages back; the model is told only that an expired match exists |
| Which articles an answer may cite | `InquiryFlow.recordAnswer`: only ids the latest search returned |
| Whether a place is open right now | `hoursNow` on the passage, from the article's `openHours` and the server's clock |
| Whether a person can take the call | `StaffedHours.decision`, from the staffed hours in `config/hours.json` |
| Where a transfer goes | The single queue in `config/hours.json` |
| Numbers the caller says | Dropped from every search query, and masked in the audit log and the handoff context |
| How many silences before a person | `InquiryFlow.noInput`: the second one in a call |
| How long a call may run | `CALL_TIME_BUDGET_MS`, five minutes by default, checked at the caller's next question |

Because the audit sink, the transfer function and the clock are all injected, the entire
flow is testable with plain `node --test` — no mocks of the Azure SDK and no subscription.
The demo clock is that same injected clock: `src/hours.mjs` and `src/content.mjs` take
`now` instead of reading the system time, which is how the console can show the after-hours
path at 10 a.m.

In simulation mode `src/offline.mjs` stands in for the model: a blank line is a silence, a
single digit is a keypress, and anything else goes to `InquiryFlow.answerFromSearch`. That
calls the same `searchContent`, `recordAnswer`, `requestHuman` and `endCall` the model's
tools call, and builds the reply from the passage the server returned: the first sentence,
whether the place is open, the source, then any caveat or eligibility disclaimer. On a live
call the model words the answer itself from the same passages and the instructions in
`src/agent.mjs`, which require the caveat and the disclaimer; the audit log flags an answer
built on a stale article either way. The flow's fixed lines — the greeting, "connecting you
now", the after-hours message and the goodbye — are handed to the live model as the
instruction for its next turn.

### What Teams receives

Only **VoIP headers** are used. SIP headers are a PSTN-side mechanism and do not reach a
Teams identifier, so context sent that way would vanish silently — the caller would still
be transferred, but the person would answer blind.

| Header | Contents |
| --- | --- |
| `CallDetails.SessionId` | The incoming call's own `CallDetails.SessionId` when it has one, otherwise the ACS correlation id |
| `CallDetails.CallTopic` | The subject in plain words — "Senior utility discount — eligibility", or the caller's own words — clipped to the Teams 48-character limit |
| `CallDetails.CallContext` | What the caller asked, which article answered it, what was held back as out of date, and why the call is being transferred — never repeating the topic, and clipped to 900 characters |
| `CallDetails.CallSentiment` | Only when the agent passes one of `frustrated`, `angry`, `upset` or `distressed`; the simulated agent never does |

Every value is capped at 1024 characters. The console's **VoIP headers on the wire** panel
is built on the server by the same `buildCustomCallingContext` the transfer uses, so what
it shows is what Teams receives.

The information desk is a call queue, and call queues are resource accounts, so it is
addressed as a Teams *app* (`{ teamsAppId, cloud }`). Set `"type": "user"` in
`config/hours.json` to transfer to a single Teams *user* instead
(`{ microsoftTeamsUserId }`). Both take a Microsoft Entra object ID, which is why
`hours.json` holds an object ID and never a phone number.

## Configuration

Copy `.env.example` to `.env`. Everything has a working default except the three values
that make real calls possible.

| Variable | Default | Notes |
| --- | --- | --- |
| `ACS_ENDPOINT` | — | Required to answer real calls. Keyless, via `DefaultAzureCredential` |
| `ACS_CONNECTION_STRING` | — | Quick-start fallback if you cannot use Entra. `ACS_ENDPOINT` wins if both are set |
| `PUBLIC_BASE_URL` | — | Public HTTPS URL for the ACS callbacks and the `wss://` media stream; must be reachable by Event Grid and ACS |
| `VOICE_LIVE_ENDPOINT` | — | Azure AI Services resource |
| `VOICE_LIVE_API_KEY` | *(empty)* | Leave empty to use Entra, which is recommended |
| `VOICE_LIVE_MODEL` | `gpt-realtime` | Voice Live direct model |
| `VOICE_LIVE_API_VERSION` | `2026-04-10` | Voice Live WebSocket API version |
| `VOICE_LIVE_VOICE` | `en-US-Ava:DragonHDLatestNeural` | Azure TTS voice; set this alongside `LOCALE` |
| `LOCALE` | `en-US` | The language the agent speaks, and the hint for speech recognition |
| `TEAMS_CLOUD` | `public` | Teams cloud of a call-queue target: `public`, `dod` or `gcch` |
| `CALL_TIME_BUDGET_MS` | `300000` | Five minutes. Checked at the caller's next question, which then goes to a person (after hours, to the next opening time) |
| `RETRIEVAL_MIN_SCORE` | `2.5` | Below this keyword score there is no approved answer |
| `CONTENT_EXPIRY_GRACE_DAYS` | `90` | Days after `reviewBy` that an article is still read, with a caveat; after that it is withheld |
| `PERSIST_TRANSCRIPTS` | `false` | Decisions, citations and each question (numbers masked, clipped to 160 characters) are always stored; the full transcript only when this is `true` |
| `DB_PATH` | `./data/general-inquiry.db` | SQLite audit database; `data/` is gitignored, and `:memory:` keeps nothing on disk |
| `CONTENT_ARTICLES_PATH` | `./content/articles` | The approved content |
| `HOURS_PATH` | `./config/hours.json` | Time zone, staffed hours, after-hours message and the Teams queue |
| `DEMO_NOW` | *(empty)* | Simulation only. Starts the demo clock at this ISO 8601 time; ignored on real calls |
| `DEMO_TODAY` | *(empty)* | Simulation only. `YYYY-MM-DD`, the same as `DEMO_NOW` at noon UTC−7 on that date |
| `PORT` / `HOST` | `8092` / `127.0.0.1` | Where the server listens |

With any of the three call variables unset, the server logs `SIMULATION MODE` with the
missing names and runs the offline console. `GET /health` breaks readiness out per
subsystem, because "not ready" is rarely uniform — Voice Live can be configured while ACS
is not, and both can be configured while `hours.json` still holds the placeholder object ID:

```jsonc
// GET /health, abridged
{
  "mode": "simulation",
  "simulationMode": true,
  "missingConfig": ["ACS_ENDPOINT", "PUBLIC_BASE_URL", "VOICE_LIVE_ENDPOINT"],
  "voiceLive":    { "ready": false, "auth": "entra", "model": "gpt-realtime" },
  "telephony":    { "ready": false, "auth": "none", "missing": ["ACS_ENDPOINT", "PUBLIC_BASE_URL"] },
  "teamsPhone":   { "ready": false, "queue": "Contoso information desk", "cloud": "public" },
  "contentIndex": { "articleCount": 12, "staleCount": 1, "expiredCount": 1 },
  "clock":        { "preset": "business-hours", "now": "2026-09-30T17:00:00.000Z", "timeZone": "America/Los_Angeles" }
}
```

`teamsPhone.ready` stays `false` until `config/hours.json` holds a real object ID, which
answers "why did my transfer fail?" before anyone has to read a log. The content counts
are judged on the demo clock.

### Keyless auth

Both Azure connections default to Entra, so no key needs to live on disk.

**ACS.** Set `ACS_ENDPOINT` and leave `ACS_CONNECTION_STRING` unset. The signed-in
identity needs **Communication and Email Service Owner** on the ACS resource. Locally that
identity comes from `az login`; in Azure, use a managed identity.

**Voice Live.** Assign the same identity both roles on the AI Services resource:

- **Cognitive Services User**
- **Foundry User**

The server then acquires a token for the `https://ai.azure.com/.default` scope through
`DefaultAzureCredential`. Setting `VOICE_LIVE_API_KEY` overrides this.

### Content

`content/articles/` holds one Markdown file per approved answer. Adding an answer is a
content change, not a prompt rewrite:

```markdown
---
id: city-hall-hours
title: City Hall hours
topic: hours-locations
owner: Contoso Customer Service
source: Contoso Customer Service — City Hall guide
shortUrl: contoso.gov/cityhall
lastReviewed: 2026-08-15
reviewBy: 2027-02-15
openHours: Mon-Fri 08:00-17:00
place: City Hall
tags: [city hall, hours, address, holiday]
---

## Public counter hours
City Hall public counters are open Monday through Friday from 8:00 a.m. to 5:00 p.m. …
```

Every field down to `reviewBy` is required. `openHours` and `place` give an article an
open-or-closed answer. The whole article is searched, but only its first `##` section is
ever read out. `topic` is one of the four in the `search_content` schema in
`src/agent.mjs`; add new ones there and to `inferTopic` in `src/content.mjs`.

## Connecting it to a real phone number

Inbound uses **Teams Phone extensibility**: the caller dials a Teams service number on a
resource account, Teams routes the call to your linked ACS resource, and this sample
answers it with Call Automation.

```
PSTN caller → Teams service number → Teams resource account → linked ACS resource
            → Microsoft.Communication.IncomingCall (Event Grid) → this sample
```

> **The number is the part that trips people up.** Teams Phone extensibility requires a
> Teams *service* number, from Microsoft Calling Plan, Operator Connect, or Direct
> Routing. **A phone number purchased in Azure Communication Services cannot be assigned
> to a Teams resource account.**
>
> If you only hold an ACS number you can still exercise the whole state machine — calls
> to it reach this sample as ordinary Call Automation calls. They arrive without the
> Teams resource account identity, and the audit log records them as `acs-direct`
> rather than `teams-phone-extensibility`, so the difference is never silent.

1. **Provision.** An ACS resource, an Azure AI Services resource, and a Teams tenant with a
   service number on a resource account.
2. **Register a calling bot** and create the resource account against its application ID,
   so the account is yours rather than a first-party auto attendant.
3. **Bind the resource account to ACS.** `Set-CsOnlineApplicationInstance -AcsResourceId
   <immutable GUID>`, then `Sync-CsOnlineApplicationInstance`. This is *not*
   `Set-CsTeamsAcsFederationConfiguration`, which governs a different feature — ACS users
   talking to Teams users. [`scripts/provision-teams-phone.ps1`](scripts/provision-teams-phone.ps1)
   does the binding, can assign the number, and resolves the transfer target's object ID.
4. **Grant ACS server consent** for that resource account through the `teamsExtension`
   assignment API; the script prints the request. The Teams-side binding alone is only half
   of it.
5. **Point the handoff at your desk.** Put the Entra object ID of your call queue's
   resource account in `config/hours.json`, with your time zone, staffed hours and
   after-hours message. To keep your own values out of git, copy the file outside the
   repository and set `HOURS_PATH` to it. If your tenant has no call queue yet,
   `"type": "user"` with the object ID of any Teams user with Enterprise Voice is enough to
   see a transfer.
6. **Review the content dates.** A real call is judged on the real date, so some sample
   articles may already be past their `reviewBy` dates — on a live server those answers
   carry a caveat or are withheld until you update them.
7. **Expose this server.** `npm run tunnel` (a dev tunnel on port 8092), then set
   `PUBLIC_BASE_URL`.
8. **Subscribe to `IncomingCall`.** Create an Event Grid system topic on the ACS resource
   with a webhook subscription to `<PUBLIC_BASE_URL>/api/events`, filtered to
   `Microsoft.Communication.IncomingCall`. The server answers the validation handshake
   automatically. Set the Azure Bot calling webhook to `https://eventgrid.azure.net`.
9. **Check `/health`** — `mode` is `live`, and `voiceLive`, `telephony` and `teamsPhone`
   all report ready — then call the number.

### Live call test matrix

On a live call the model words the answers itself, so the sentences vary. Which article is
used, whether it may be read out, whether a place or the desk is open, and where the call
goes are decided by the server.

| Flow | Say or do | Expected behavior |
| --- | --- | --- |
| Hours | `What are City Hall's hours?` | Reads the hours, says whether City Hall is open now on the real clock, and names the source |
| Source | `Where did that come from?` | The source and its short URL |
| Freshness | Ask about an article past its `reviewBy` date | Within 90 days, the answer with a caveat; after that, it says what it can't confirm and offers a person. Which articles these are depends on the date you call |
| Eligibility | `I'm 67 — do I qualify for the senior utility discount?` → `yes` | The published criteria and that staff make the final decision, then a transfer whose context masks the age |
| Human escape | `Can I talk to a person?` | While the desk is staffed, a transfer with context; after hours, the next opening time and no transfer |
| Keypad | Press `0` | The same as asking for a person; other digits are ignored |
| Out of scope | `Can you recommend a good pizza place?` | No guess; it offers a person while the desk is staffed |
| Barge-in | Talk over the agent | The agent stops speaking and listens |

## Project layout

```
src/
  flow.mjs        the state machine — no Azure, Express or SQLite imports
  content.mjs     the content index: articles, retrieval, freshness, masking
  hours.mjs       staffed hours, opening hours and the next opening, in the city's time zone
  handoff.mjs     the Teams target and the VoIP headers
  agent.mjs       the tool schema and standing instructions given to the model
  offline.mjs     typed caller lines for the console and /api/simulate: silence, keypress or speech
  audit.mjs       in-memory audit sink and the metrics (the interface the flow depends on)
  db.mjs          the SQLite implementation of that same interface
  config.mjs      environment variables and /health readiness
  realtime.mjs    WebSocket hub that pushes state to the console
  server.mjs      Event Grid intake, ACS callbacks, simulation API, demo controls
  voice/
    voice-live.mjs  the Voice Live WebSocket session
    acs.mjs         answer, transfer, DTMF, hang up
    call-bridge.mjs binds one call's media to one Voice Live session
config/
  hours.json      time zone, staffed hours, after-hours message, the Teams queue
  offline-transcript.json  a typed call for /api/simulate
content/articles/ twelve approved answers, one Markdown file each
public/           the presenter console
  app.js          the panels: call, grounding decision, Teams toast, audit trail, metrics
  beats.js        the scripted demo and its narration — edit this to adapt the demo
  presenter-kit.* shared console building blocks, vendored: edit scripts/presenter-kit/
                  at the repository root, then run `node scripts/sync-presenter-kit.js`
scripts/
  smoke-websockets.mjs       boots a simulation server on port 8192 and checks the
                             WebSockets and the demo controls
  provision-teams-phone.ps1  binds the resource account to ACS and resolves the queue
test/             46 cases, no Azure required
```

`flow.mjs`, `content.mjs`, `hours.mjs`, `handoff.mjs`, `agent.mjs`, `offline.mjs` and
`audit.mjs` import nothing but Node's standard library, each other and `config.mjs`, which
loads `dotenv` only if it is installed. That is deliberate: the parts you most need to read
and trust are the parts that run without installing anything.

## Operational notes

- **Event Grid delivers duplicates by design.** The server de-duplicates on event id before
  answering, so a redelivery does not answer the same call twice.
- **DTMF is always on.** Continuous recognition starts on `CallConnected`, so the caller can
  press 0 for a person at any point; the reprompt after a silence mentions it. Other digits
  are ignored.
- **The transfer is blind.** The agent's job ends once the context is delivered.
- **`CallTransferFailed` sends the transfer again,** to the same queue and with no attempt
  limit. Add a cap before production. A transfer that ACS rejects outright ends the call
  with an apology and where to go next.
- **Barge-in** sends `StopAudio` to ACS and `response.cancel` to Voice Live, so the agent
  stops mid-word rather than talking over the caller.
- **Voice Live allows one in-flight response.** A state transition and a tool result can
  both want the agent to speak, so requests are coalesced in `voice-live.mjs`.
- **Silence is a simulation control.** On a live call Voice Live's turn detection handles
  pauses; the two-silences rule runs only from the console and `/api/simulate`.
- **The five-minute limit is checked when the caller asks something.** On a live call that
  is the model's next search, so a call with no further question is not cut off.
- **City holidays are not modeled.** Staffed hours are weekly, so a holiday looks like a
  normal weekday. Add closures to `config/hours.json` and `src/hours.mjs` before you put a
  real number on it.
- **Freshness is judged on calendar dates** in the city's time zone, not on UTC timestamps.

## Security notes before production

- **Move retrieval to Azure AI Search or another governed content system.** This sample
  scores keywords over a dozen local Markdown files. Keep the freshness check on whatever
  comes back.
- **Establish accountable owners and review SLAs for every article.** Review dates only
  help if somebody owns them, which is why every article names an owner.
- **Evaluate answer accuracy against a larger question set.**
- **Add prompt-injection tests for caller speech and content.** The suite has one case for
  caller speech; extend it, and run it against a live model.
- **Validate Teams Phone extensibility, Event Grid, rate limits, warm compute, Key Vault /
  managed identity, and organizational certification requirements.**
- **Keep transcripts off by default unless retention, masking, and consent requirements are
  approved.** Even with them off, the audit log keeps each question with its numbers
  masked, the server log prints each tool call's arguments as the model sent them, and the
  console's live transcript shows the caller's words unmasked.
- **The model cannot choose a destination or read expired text.** `request_human` has no
  destination parameter, and expired passages never leave the server. Keep it that way; a
  tool that accepts a phone number turns a prompt injection into a toll-fraud vector.
- **Masking has limits.** An age, an income or a house number is kept out of the search and
  masked in the audit log and the Teams context, but only numbers of two or more digits are
  caught, and the live model hears everything the caller says.
- **Phone numbers are masked** in the console and the audit database, and the server log
  never prints the caller ID.
- **Disclose the assistant.** The opening line says it is automated; keep it.
- **Nothing is authenticated.** The console, `/api/*`, `/ws/hub`, `/ws/media`, the Event
  Grid endpoint and the ACS callback route accept any request, and `npm run tunnel` opens
  them to anyone with the URL. Add authentication, and authenticate the webhooks, before
  you take real calls.
- The city, its content, the phone numbers and the queue's object ID are fictional
  placeholders. Replace them.

## Microsoft references

- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [How to use the Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to)
- [Call Automation overview](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation)
- [Passing contextual data with custom headers](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/custom-context)
- [Teams interop with Call Automation](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/teams-interop-call-automation)
- [Bidirectional media streaming](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/audio-streaming-quickstart)
- [Teams Phone extensibility overview](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-overview)
- [Teams Phone extensibility quickstart](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-quickstart)
- [Teams Phone extensibility FAQ](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-faq)
