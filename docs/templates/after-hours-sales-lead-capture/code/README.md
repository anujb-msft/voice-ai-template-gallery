# After-Hours Sales Lead Capture

A Teams Phone assistant for the hours when nobody is in the sales office. In sales hours
it stays out of the way and sends the caller straight to the sales queue. After hours it
says up front that it's automated, asks the questions a sales rep would ask, reads the
callback number back, and saves a scored lead with an owner, a callback deadline and a
follow-up message for the morning. When a hot lead can't wait and someone is on call, it
pages the on-call rep in Teams instead.

The point is not that a model can fill in a form. It is everything around that: the
*server*, not the model, decides whether the assistant answers at all, how the lead
scores, whether a callback number is good enough to save, who owns the lead, and whether
it's worth interrupting someone's evening for — and each decision is shown with its
reason.

Built on [Azure Communication Services Call Automation](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation),
the [Azure AI Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live),
and Teams Phone extensibility.

> Illustrative sample. Contoso Industrial Supply, its catalog, its sales team and every
> caller are fictional. Read [Security notes before production](#security-notes-before-production)
> before pointing this at a real phone number.

## What the demo shows

- **The clock decides, not the model.** The server checks the sales hours (weekdays,
  8 AM to 6 PM Pacific, with holidays) before the assistant says a word. In sales hours
  the call goes straight to the sales queue; after hours the assistant answers.
- **An honest opening.** The first sentence says it's an automated assistant and that
  the sales team isn't available.
- **A score in plain English.** The server scores product line, quantity against the
  catalog's minimum order, timeline and decision role, and the console explains every
  point: *12,000 meets the 5,000 minimum order*. Hot is 6 of 8 or more; warm is 3 or more.
- **Nothing is saved until the number is confirmed.** The agent reads the callback
  number back. A correction is read back too, and the server refuses to save a number
  the caller hasn't confirmed.
- **An owner and a deadline.** Each lead gets a rep in rotation and a callback deadline
  by score — within an hour of opening for hot, the next business day for warm — and a
  follow-up message for Teams and email, with the sales manager @-mentioned on hot leads.
- **Paging only when it's worth it.** Inside on-call hours, a hot lead that is urgent,
  or a hot or warm caller who asks for a person, pages the on-call rep in Teams while
  the caller holds. Otherwise the lead waits for the morning, and the reason is on it.
- **A clean pipeline.** Support calls, job seekers, spam and emergencies get a polite
  pointer to the right place and never become leads.
- **Context that survives the handoff.** Live transfers carry a topic, a summary and the
  route as VoIP headers, and the console shows the literal headers next to a mock Teams
  toast.
- **Repeat calls merge.** A second call from the same number within 30 days updates the
  earlier lead instead of adding another.
- **Numbers from the lead store.** Calls, leads captured, qualified and routed for
  follow-up, live transfers, pages answered, and calls that weren't sales.

## Quick start

Runs with no Azure subscription at all.

```bash
npm install
npm start
# open http://127.0.0.1:8093
```

The console runs a scripted demo: press **→** (or **Next ▶**) and it plays six short
beats, setting the demo clock and typing — and, if you like, speaking — the caller's
lines. [DEMO-SCRIPT.md](DEMO-SCRIPT.md) is the running order, with what to say at each
step, and `npm run rehearse` plays it end to end before you do.

Or drive it yourself: pick a **Caller ID**, click **Answer a call**, and type what the
caller says. A typed call drives *the same state machine* a real call would: the same
sales hours, scoring, read-back rule, owner rotation, paging policy and handoff assembly.
Only the agent and the audio path are stubbed.

Try these with the demo clock on **After hours**:

| Type or press | What you should see |
| --- | --- |
| `Hi, this is Dana Morgan from Northwind Traders. We need about 12,000 hex bolts by the end of the month.` | 6 of 8 from one sentence, each point explained, then a question about who signs off |
| `How much do 5,000 hex bolts cost?` | No price: the question is noted for the rep, and qualifying carries on |
| `Hi, are you hiring? I'd like to apply for a job.` | A pointer to the careers page, and no lead |
| At the read-back: `No, that's the front desk. Please use my mobile, 425-555-0147.` | The new number is read back too, and only the confirmed one is saved |
| **0** on the keypad | Taken as asking for a person: a few details first, then the policy decides whether to page |
| *Silence* three times | Two prompts, a goodbye, and a partial lead from the caller ID, marked as not read back |

Run the tests — they need no Azure and no network:

```bash
npm test          # the state machine, the policy, the Teams handoff and the demo controls
npm run check
npm run smoke     # boots its own server on port 8193 and checks both WebSockets and the demo controls
npm run rehearse  # plays the six beats on port 8293 as the console does, three ways (~1.5 min)
```

`npm run rehearse` fails if a beat would land anywhere [DEMO-SCRIPT.md](DEMO-SCRIPT.md)
doesn't say: each beat's outcome, lead and decision trail, and the closing numbers, are
pinned in `scripts/rehearse.mjs`. It plays the script in order, again after a reset, and
last beat first with each beat twice, at Auto-play's pace and at full speed, and checks
that a live server refuses the demo controls. Neither `.env` nor your shell's settings
reach its server, and its leads stay in memory, so nothing is written to `data/`. Changed
a beat on purpose? It prints the outcomes it reached, ready to paste over the pins once
you've checked them against the script.

### Demo controls

In simulation mode the console can move the clock the sales-hours and on-call rules see,
so one running server shows the in-hours, after-hours and late-night paths:

| Endpoint | What it does |
| --- | --- |
| `GET /api/demo/clock` | The demo clock, its time zone and presets, whether sales is open, and who is on call |
| `POST /api/demo/clock` | `{ "preset": "business-hours" \| "after-hours" \| "late-night" \| "real" }` or `{ "at": "<ISO 8601>" }` |
| `POST /api/demo/reset` | Forget the simulated calls and leads, and restore the starting clock and the owner rotation |
| `POST /api/demo/restore` | `{ "phones": ["+14255550193"], "nextRep": "ava" }`: forget the simulated leads from those numbers and line up the owner rotation on that rep, so a beat runs as a first call in any order. The calls stay counted |
| `GET /api/stats` | Calls, leads captured, qualified and routed for follow-up, live transfers, pages, non-sales calls and merged repeats |

The presets are 10:30 AM, 7:30 PM and 10:30 PM on Wednesday, September 2, 2026, Pacific
time. The three `POST`s return `403` while the server answers real calls: a live call
always uses the real time, and neither a reset nor a restore ever touches a real call's
lead. Set `DEMO_NOW` to start the server with the clock already pinned, for example
`DEMO_NOW=2026-09-02T19:30:00-07:00`.

## How it works

```
PSTN caller
   │  Event Grid: Microsoft.Communication.IncomingCall
   ▼
this server ── sales open? ── yes ──► answerCall, no media ──► TransferCallToParticipant
   │                                                           + VoIP custom context
   │  no: after hours, or the sales queue overflowed                    │
   ▼                                                                    ▼
ACS Call Automation ── answerCall + bidirectional media ──┐      Teams sales queue
   │  PCM16 24 kHz mono (pcm24KMono)                       │
   ▼                                                       │
this server ──── WebSocket ────► Voice Live (gpt-realtime) ┘
   │  lookup_catalog / save_lead / classify_non_sales / end_call
   ▼
LeadCaptureFlow ── score, read-back, owner, deadline ──► lead store + follow-up outbox
   │
   └─ hot and urgent, inside on-call hours ── TransferCallToParticipant ──► on-call rep in Teams
                                              + VoIP custom context
```

In sales hours the call is answered without media and transferred as soon as it
connects, so the assistant never speaks. An incoming call that carries the VoIP header
`CallDetails.QueueOverflow` — from your own overflow routing — is captured even in sales
hours.

After hours the caller talks to Voice Live through the server. The model holds the
conversation and calls four tools; the server owns everything the tools decide.
`src/flow.mjs` has no Azure, Express or SQLite imports: the transfer, the clock, the lead
store and the console hub are injected, so the tests and the console run the same code a
real call does.

### The decisions live on the server

| Decision | Made by | What the model gets |
| --- | --- | --- |
| Whether the assistant answers at all | `HoursPolicy` in `src/policy.mjs`, from `config/hours.json` (weekly hours, holidays, time zone) | Nothing: in sales hours it's never connected |
| The score and its reasons | `QualificationPolicy` in `src/policy.mjs`, from `config/qualification.json` and the minimum orders in `config/catalog.json` | Not the score |
| Whether the callback number can be saved | `saveLead` in `src/flow.mjs` refuses an unconfirmed number with `contact_unconfirmed` | The number to read back |
| Who owns the lead, and by when | The lead store (`src/db.mjs`): active reps in rotation, and a deadline from the score and the next opening | The lead id and the follow-up promise to read out |
| Whether a repeat call merges | The lead store: the same phone number or email within `DEDUPE_WINDOW_DAYS` | The same promise, plus "I've added this to your earlier request" |
| Whether to page the on-call rep | `decidePage` in `src/policy.mjs`, from the on-call cover in `config/hours.json` | `stayOnLine`, so it asks the caller to hold |
| Whether it's a sales call at all | `classify_non_sales` in `src/flow.mjs`: an existing order gets the support line and hours from `config/hours.json`, a job seeker the careers page, an emergency the advice to call emergency services | The words to read out |

`decidePage` is the whole paging policy, and every answer carries a plain-English
reason that goes on the lead: no page while sales is open; no page when nothing is
urgent and no one asked for a person; no page outside on-call cover; a page for a hot
lead that is urgent, or for a hot or warm caller who asks for a person. A partial save,
from silence or the time budget, never pages: there is no one left on the line.

### What Teams receives

Every transfer — to the sales queue or to the on-call rep — sets these on
`customCallingContext`:

| Header | Example, from beat 5 of the demo | Notes |
| --- | --- | --- |
| `CallDetails.SessionId` | the incoming call's session id, or its correlation id | Ties the Teams call back to the lead |
| `CallDetails.CallTopic` | `Cartons — Tailwind Traders` | 48 characters at most |
| `CallDetails.CallContext` | `HOT lead (8 of 8). Sam Rivera, operations director, Tailwind Traders. Cartons, 2,000 units, needed by tomorrow morning. …` | Includes the confirmed callback number and why the rep was paged |
| `CallDetails.RouteId` | `on-call`, or `sales` for the sales queue | |
| `CallDetails.AfterHours` | `true` | Sent only after hours |

The sales queue is addressed as a Teams app (`teamsAppId`, the object ID of the call
queue's resource account); the on-call rep as a Teams user (`microsoftTeamsUserId`). These
are VoIP headers, not SIP headers: SIP headers belong to the PSTN side and don't reach a
Teams identifier.

## Configuration

Copy `.env.example` to `.env`. Everything has a working default except the three values
that make real calls possible.

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | |
| `PORT` | `8093` | |
| `PUBLIC_BASE_URL` | — | Required for real calls. Must be reachable by Event Grid and ACS |
| `ACS_ENDPOINT` | — | Required for real calls. Keyless, via `DefaultAzureCredential` |
| `ACS_CONNECTION_STRING` | — | Fallback if you can't use Entra. `ACS_ENDPOINT` wins if both are set |
| `TEAMS_CLOUD` | `public` | The Teams cloud of the sales queue |
| `VOICE_LIVE_ENDPOINT` | — | Required for real calls. Azure AI Services resource |
| `VOICE_LIVE_API_KEY` | *(empty)* | Leave empty to use Entra, which is recommended |
| `VOICE_LIVE_MODEL` | `gpt-realtime` | |
| `VOICE_LIVE_API_VERSION` | `2026-04-10` | |
| `VOICE_LIVE_VOICE` | `en-US-Ava:DragonHDLatestNeural` | Set this alongside `LOCALE` |
| `LOCALE` | `en-US` | |
| `HOURS_PATH`, `REPS_PATH`, `QUALIFICATION_PATH`, `CATALOG_PATH` | `./config/*.json` | Point these at your own copies |
| `DEDUPE_WINDOW_DAYS` | `30` | A repeat call within this window merges into the earlier lead |
| `CALL_TIME_BUDGET_MS` | `360000` | Real calls only. When it runs out, the agent saves what it has as a partial lead and ends the call |
| `PAGE_WINDOW_MS` | `6000` | How long a paged caller is asked to hold before the transfer to the on-call rep |
| `DEMO_NOW` | *(empty)* | Simulation only. Pins the demo clock (ISO 8601); ignored on real calls, and an invalid value means real time |
| `PERSIST_TRANSCRIPTS` | `false` | Leads and decisions are always stored; what was said is stored only if this is set |
| `DB_PATH` | `./data/after-hours-sales.db` | SQLite. `:memory:` keeps everything in memory |
| `TEAMS_WORKFLOW_URL`, `ACS_EMAIL_SENDER` | *(empty)* | Reserved for delivering the follow-up messages; not used yet, so messages stay in the outbox |

With any of the three call variables unset, the server runs in simulation mode and the
console types the calls. `GET /health` breaks readiness out per subsystem:

```jsonc
{
  "mode": "simulation",
  "callReady": false,
  "missingConfig": ["ACS_ENDPOINT", "PUBLIC_BASE_URL", "VOICE_LIVE_ENDPOINT"],
  "voiceLive": { "ready": false, "auth": "entra", "model": "gpt-realtime" },
  "telephony": { "ready": false, "auth": "none", "missing": ["ACS_ENDPOINT", "PUBLIC_BASE_URL"] },
  "teamsPhone": { "ready": true, "salesQueue": "Contoso Industrial Supply Sales Queue", "cloud": "public" },
  "hours": { "open": false, "timeZone": "America/Los_Angeles", "holiday": false },
  "onCall": { "configured": true, "covered": true, "reason": "On call until 9 PM", "repName": "Ben Ortiz", "until": "9 PM" },
  "activeReps": 3,
  "outboxBacklog": 0,
  "clock": { "preset": "real", "now": "…" }
}
```

`teamsPhone.ready` only says a sales-queue object ID is set; it doesn't know whether the
ID is real. The shipped IDs are placeholders, so replace them before a real call.

### Keyless auth

Both Azure connections default to Entra, so no key needs to live on disk.

**ACS.** Set `ACS_ENDPOINT` and leave `ACS_CONNECTION_STRING` unset. The signed-in
identity needs **Communication and Email Service Owner** on the ACS resource. Locally
that identity comes from `az login`; in Azure, use a managed identity.

**Voice Live.** Assign the same identity both roles on the AI Services resource:

- **Cognitive Services User**
- **Foundry User**

The server then acquires a token for the `https://ai.azure.com/.default` scope through
`DefaultAzureCredential`. Setting `VOICE_LIVE_API_KEY` overrides this.

### Policy files

The four files in `config/` are the whole policy. Changing them is a config change, not a
prompt rewrite; the catalog the model sees is generated from `catalog.json`.

- `hours.json`: the organization, time zone, weekly sales hours, holidays, the support
  line and its hours, the on-call cover (`onCall`: the rep, the days, and the time cover
  ends) and the sales queue to transfer to.
- `reps.json`: the reps who own leads, whether each is active, their Teams user IDs, and
  the sales manager to @-mention on hot leads.
- `qualification.json`: the points for timeline, quantity, product line and decision
  role, and the hot and warm thresholds.
- `catalog.json`: the product lines, the words that identify them, minimum orders and
  lead times.

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
> Routing. **A phone number purchased in Azure Communication Services can't be assigned
> to a Teams resource account.** If you only hold an ACS number, calls to it still reach
> this sample as ordinary Call Automation calls, so you can exercise the whole state
> machine, but without the Teams resource account.

1. **Provision.** An ACS resource, an Azure AI Services resource, and a Teams tenant with
   a service number on a resource account, a sales call queue, and a Teams Phone user for
   each rep.
2. **Register a calling bot** and create the resource account against its application ID.
3. **Bind the resource account to ACS.** `Set-CsOnlineApplicationInstance -AcsResourceId
   <immutable GUID>`, then `Sync-CsOnlineApplicationInstance`.
   [`scripts/provision-teams-phone.ps1`](scripts/provision-teams-phone.ps1) prints the rest
   of this checklist with your values filled in; it doesn't change anything itself.
4. **Grant ACS server consent** for that resource account through the `teamsExtension`
   assignment API. The Teams-side binding alone is only half of it.
5. **Collect object IDs.** Put the Entra object ID of the sales call queue's resource
   account in `config/hours.json` as `salesQueue.objectId`, and each rep's Entra user
   object ID in `config/reps.json` as `teamsUserId`. Check who is on call, and until when,
   in `onCall` in `hours.json`. To keep your own IDs out of git, copy the files elsewhere
   and set `HOURS_PATH` and `REPS_PATH`.
6. **Expose this server.** `npm run tunnel`, then set `PUBLIC_BASE_URL`.
7. **Subscribe to `IncomingCall`.** Create an Event Grid system topic on the ACS resource
   with a webhook subscription to `<PUBLIC_BASE_URL>/api/events`, filtered to
   `Microsoft.Communication.IncomingCall`. The server answers the validation handshake
   automatically. Set the Azure Bot calling webhook to `https://eventgrid.azure.net`.
8. **Check `/health`** for `"mode": "live"`, then call the number, once in sales hours and
   once after.

### Live call test matrix

On a live call the conversation is the model's, so the wording varies. The decisions —
the hours, the score, the read-back, the owner, the deadline and the page — are the
server's and don't. To test capture during the day, change the sales hours in
`config/hours.json` and restart: the demo clock is off on a live server.

| Flow | Say or do | Expected behavior |
| --- | --- | --- |
| Sales hours | Call during sales hours | Transferred straight to the sales queue; the assistant never speaks, and Teams receives `CallDetails.RouteId: sales` |
| Capture | `This is Dana Morgan from Northwind Traders. We need about 12,000 hex bolts by the end of the month.` Answer the questions, then confirm the number | Says it's automated, qualifies, reads back the number, saves a hot lead, and promises a call within an hour of opening |
| Correction | At the read-back: `No, please use 425-555-0147` | Reads the new number back; only the confirmed number is saved |
| Price | `How much do hex bolts cost?` | Doesn't quote a price; notes the question for the rep |
| Not a sales call | `I'm calling about an order that hasn't arrived` | Gives the support line and hours; no lead |
| Urgent, on call | Before cover ends: `Our line is down and we need 2,000 cartons by tomorrow morning. Can I talk to someone tonight?` Then confirm the number | Saves the lead, asks the caller to hold, then transfers to the on-call rep with the context |
| Urgent, no cover | The same, after on-call cover ends | Says no one is on call, and saves the lead for the morning with the reason |
| Keypad | Press `0` | Takes a few details first, then checks who's available |
| Silence | Say nothing | Two prompts, then a goodbye; with caller ID, a partial lead |

When the lead is first saved on a real call, the console's lead panel fills in all at
once, just before the read-back, rather than sentence by sentence as in simulation.

## Project layout

```
src/
  flow.mjs        the state machine — no Azure, Express or SQLite imports
  policy.mjs      sales hours, holidays, on-call cover, paging, catalog and scoring
  db.mjs          the in-memory lead store: dedupe, owner, deadline, outbox, metrics
  db-sqlite.mjs   the same store on SQLite, loaded only when it's used
  handoff.mjs     Teams identifiers and the VoIP headers
  agent.mjs       the tool schema and standing instructions given to the model
  offline.mjs     the scripted stand-in for the model, used only by the console
  audit.mjs       an in-memory audit sink; not used by the server
  realtime.mjs    WebSocket hub that pushes state to the console
  config.mjs      environment settings and /health readiness
  server.mjs      Event Grid intake, ACS callbacks, simulation API, demo controls
  voice/
    voice-live.mjs  the Voice Live WebSocket session
    acs.mjs         answer, transfer, DTMF, hang up
    call-bridge.mjs binds one call to one Voice Live session, with barge-in
config/
  hours.json, reps.json, qualification.json, catalog.json   the policy
public/           the presenter console
  app.js          the panels: call, lead, decision, Teams, VoIP headers, trail, numbers
  beats.js        the scripted demo and its narration — edit this to adapt the demo
  presenter-kit.* shared console building blocks, vendored: edit scripts/presenter-kit/
                  at the repository root, then run `node scripts/sync-presenter-kit.js`
scripts/
  smoke-websockets.mjs       boots its own server and checks the WebSockets and demo controls
  rehearse.mjs               plays every beat as the console does; pins what each one shows
  presenter-kit-rehearsal.mjs  the rehearsal engine, vendored like presenter-kit.*
  provision-teams-phone.ps1  prints the Teams Phone checklist
test/             flow, handoff and demo tests; no Azure required
```

`flow.mjs`, `policy.mjs`, `handoff.mjs`, `agent.mjs`, `offline.mjs` and `db.mjs` import
no third-party packages. If `better-sqlite3` can't load, the server says so in the log
and keeps leads in memory.

## Operational notes

- **Event Grid delivers duplicates by design.** The server de-duplicates on event id
  before answering, so a redelivery doesn't answer the same call twice.
- **DTMF is always on.** Continuous recognition starts on `CallConnected`; **0** asks for
  a person.
- **Barge-in** sends `StopAudio` to ACS and `response.cancel` to Voice Live, so the agent
  stops mid-word rather than talking over the caller.
- **The follow-up messages aren't delivered yet.** They wait in the outbox
  (`GET /api/outbox`), and `/health` reports the backlog. Posting them to Teams, sending
  email or creating the lead in your CRM is the integration you add.
- **Mark a lead contacted** with `POST /api/leads/:id/contacted`; `/api/stats` then
  reports the time to first response and the share contacted within the deadline.
- **Leads are kept in `data/`** (SQLite, gitignored). Simulated and real leads never merge
  with each other, and **Reset demo** clears only the simulated ones.

## Security notes before production

- **Caller ID is not authentication.** It can be spoofed. The in-hours handoff says the
  number isn't verified, and after hours the number is read back before it's saved.
- **Keep the model away from the decisions.** Scoring, dedupe, assignment, deadlines and
  paging stay on the server; the model gets back only the lead id and the follow-up
  promise.
- **Replace the SQLite lead store** with your system of record and its ownership rules.
- **Review consent, recording, retention, accessibility and follow-up rules** for each
  market you call back.
- **Disclose the assistant.** The opening line says it's automated.
- **Transcripts are off by default.** Utterance text reaches disk only if you set
  `PERSIST_TRANSCRIPTS`.
- **Phone numbers are masked in the logs** only; the console and the lead store keep the
  full number, because the callback needs it.
- **Store secrets in Key Vault** and use managed identity, not `.env`.
- **Add rate limits, poison-message handling and delivery retries** before taking real
  traffic.
- The company, reps, catalog and object IDs are fictional placeholders. Replace them.

## Microsoft references

- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [How to use the Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to)
- [Call Automation overview](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation)
- [Custom context: VoIP and SIP headers](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/custom-context)
- [Teams interop with Call Automation](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/teams-interop-call-automation)
- [Bidirectional audio streaming](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/audio-streaming-quickstart)
