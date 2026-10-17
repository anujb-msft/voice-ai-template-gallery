# Contextual On-Call Pager

An after-hours maintenance line on Teams Phone. A tenant calls Contoso Property
Management in the middle of the night and describes the problem in their own words.
The agent captures what is wrong, where, a short quote from the tenant, whether the
technician may go in and the callback number — once, as structured fields — and the
server calls whoever is on call tonight with a short spoken brief built from them,
escalating until someone accepts.

The point is not that a model can summarize a phone call. It is everything around
that: who is on call tonight and why, what happens when nobody answers, what a
voicemail greeting is allowed to hear, which problems can wait for the office, and how
a technician gets a question answered without anyone handing out a phone number.

Built on [Azure Communication Services Call Automation](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation),
the [Azure AI Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live),
and Teams Phone extensibility.

> Illustrative sample. The organization, properties, tenants, technicians and rotation
> are fictional, and this is not an emergency dispatch or a production paging system.
> Read [Security notes before production](#security-notes-before-production) before
> pointing this at a real phone number.

## What the demo shows

- **Context, captured once.** The agent records the problem, the unit, a short quote
  from the tenant, access notes, permission to enter and the callback number as
  fields, not a transcript. The page is built from those fields, so every page reads
  the same way: what, where, when it was reported, the tenant's own words, and whether
  the technician may go in.
- **The server decides how urgent.** The model has no severity argument. Gas, fire,
  smoke or an injury is an emergency; an active leak, a lockout, no power, or no heat
  at or below 55 °F is urgent; everything else becomes a work order. The console shows
  the rule that matched.
- **Who's on call, and why.** The rotation, a swap override and the property manager
  come from `config/oncall.json`, evaluated on a demo clock you can move. The console
  says *why* tonight's technician is on call: "Central rotation since Mon, Sep 28", or
  "Swap override for Thu, Oct 1 — replaces the central rotation".
- **Escalation on a timer, not a hunch.** Two attempts per level, 3 minutes apart for
  urgent problems and 1 minute for emergencies: the primary, the secondary, then the
  property manager. A decline escalates at once, and the console counts down to the
  next page. If nobody has accepted 20 minutes after the report, the operations
  channel is alerted.
- **Voicemail stays private.** When a page reaches voicemail, the agent leaves a
  callback prompt and a four-digit reference — no building, unit, problem or tenant
  name — and the console lists what was left out, and why.
- **Not worth waking anyone.** A routine problem, or no heat above the 55 °F line,
  becomes a work order for the office with the next business day as the follow-up — on
  a weekend, Monday morning. The tenant hears why nobody is being woken.
- **Questions, not phone numbers.** The paged technician can ask about the incident,
  and press 3 to be connected to the tenant. Asking for the tenant's number is refused;
  the bridge connects them without either seeing the other's number.
- **Numbers at the end.** Incidents, pages, acknowledgements, escalations, voicemails,
  work orders and the median time to acknowledge, from the audit store.

## Quick start

Runs with no Azure subscription at all.

```bash
npm install
npm start
# open http://127.0.0.1:8095
```

The console runs a scripted demo: press **→** (or **Next ▶**, Page Down, or a
presentation clicker) and it plays five short beats — *Leak at midnight*, *Nobody
answers*, *Voicemail keeps it private*, *Not worth waking anyone* and *Questions, not
phone numbers* — typing, and if you pick a room voice also speaking, the tenant's and
the technician's lines. Keys **1**–**5** jump to a beat, and **Auto-play** plays the
rest of a beat hands-free. [DEMO-SCRIPT.md](DEMO-SCRIPT.md) is the running order, with
what to say at each step.

Or drive it yourself: pick a clock preset in the header, pick a **Caller ID**, click
**Answer a call**, and type what the tenant says. Once a page rings, the same box
speaks for the technician: the keypad sends the technician's keys (**1** accept, **2**
decline, **3** connect to the tenant, **\*** repeat the brief), and **Voicemail picks
up**, **Silence** and **Skip to the next page** stand in for a phone nobody answers.
A typed transcript drives *the same state machine* a real call would: the same triage
rules, the same rotation, the same escalation timers, the same page brief. Only the
model and the phone network are stubbed — an offline stand-in plays the agent, and a
simulated dialer plays the technician's phone.

Try these. Start each one with **Reset demo**, then pick the clock and the caller:

| Clock and caller | Type or press | What you should see |
| --- | --- | --- |
| Weeknight on call, Alice Rivera | `Water is pouring through my kitchen ceiling and it's spreading fast.` → `Yes, 4B. You can go in — the spare key is in the lockbox by the back door.` → `Yes, that's my cell.` → `Morgan Lee here.` → `I've got it.` | An urgent active leak; Morgan Lee is paged with the brief and accepts, and the tenant gets a call back: "A technician has your request and will call you shortly." |
| Weeknight on call, Dee Nguyen | `The heat is out in unit 11 at Pine Terrace and it's 52 degrees in here. You can let yourself in.` → `Yes.` → **Silence** → **Skip to the next page** → **Silence** → **Skip to the next page** → `Priya Shah here.` → `I've got it.` | Below the 55 °F line, so urgent. Omar Diaz is paged twice, 3 minutes apart, then "Omar Diaz didn't answer 2 attempts. Escalating to the secondary, Priya Shah", who accepts |
| Weeknight on call, Alice Rivera | The first three lines of the leak above → `Morgan Lee here.` → press **2** | "Morgan Lee declined. Escalating to the secondary, Priya Shah, now." — no wait for a timer |
| Swap night, Ben Carter | `I'm locked out of my apartment and my keys are inside.` → `Yes, 2A. I'm waiting in the lobby by the front door.` → `Yes.` → **Voicemail picks up** | Priya Shah is paged, because of the swap override. Her voicemail gets only a callback prompt and a reference, and the console lists what was left out |
| Weekend, Grace Kim | `The heat is out in my bedroom, but it's about 64 degrees inside.` → `Yes, unit 7. You can go in, I'm home all weekend.` → `Yes.` | Above the 55 °F line, so nobody is paged: "I've logged a work order for the office. They'll follow up Monday morning." |
| Weeknight on call, Ben Carter | `No power in unit 2A at Maple Court since the storm. You can go in, and please call me back on this number.` → `Morgan here.` → `What's the tenant's phone number?` → press **3** | "I can't share phone numbers. Press 3 and I'll connect you to the tenant." Then "Connecting you to Ben now — neither of you will see the other's number." |
| Weeknight on call, Alice Rivera | `I smell gas in the kitchen.` | The 911 safety line first, then "I'm also paging the on-call technician now." — an emergency page to Morgan Lee |
| Weeknight on call, Alice Rivera | `Can I talk to a real person?` → **Silence** → **Silence** | "The office is closed, so I can't put you through to a person — but this line pages the on-call technician for urgent problems…". Two silences end the call, and nobody is paged |
| Weeknight on call, Unknown number | `Water is leaking from the ceiling in unit 9 at Maple Court.` → `4B` → `Yes` → `Yes` | "I could not validate unit 9 at Maple Court." The agent asks again, accepts 4B, and pages Morgan Lee |

Run the tests — they need no Azure and no network:

```bash
npm test        # 48 cases: policy, state machine, page brief, Teams payloads, the offline stand-in
npm run check   # node --check on every module (a POSIX shell loop)
npm run smoke   # boots its own server on port 8195 and checks both WebSockets and the demo controls
```

### Demo controls

In simulation mode the console can move the clock the paging policy sees, so one
running server shows tonight's rotation, a swap night and a weekend, and an escalation
that would take minutes happens on a click:

| Endpoint | What it does |
| --- | --- |
| `GET /api/demo/clock` | The demo clock, its time zone, the presets, and who is on call for each property group at that time, and why |
| `POST /api/demo/clock` | `{ "preset": "weeknight" \| "swap-night" \| "weekend" \| "real" }` or `{ "at": "<ISO 8601>" }` |
| `POST /api/demo/clock/advance` | `{ "minutes": 3 }` (up to 1440) or `{ "at": "<ISO 8601>" }`. Forward only. Pages and alerts that fall due on the way run before the response |
| `POST /api/demo/reset` | Forget the simulated calls, incidents, pages and Teams notifications, and restore the starting clock |
| `GET /api/stats` | Incidents, pages, acknowledgements, escalations, no-answers, voicemails, declines, work orders and time to acknowledge |

| Preset | Demo time (America/Los_Angeles) | What it shows |
| --- | --- | --- |
| `weeknight` — Weeknight on call | Wed, Sep 30, 11:42 PM | Morgan Lee (Maple Court) and Omar Diaz (Pine Terrace), from the rotation that started Mon, Sep 28 |
| `swap-night` — Swap night | Thu, Oct 1, 11:10 PM | A swap override puts Priya Shah first for Maple Court |
| `weekend` — Weekend | Sat, Oct 3, 10:15 PM | The same rotation; routine work orders follow up Monday morning |
| `real` — Real time | now | The real clock |

The `POST`s return `403` while the server answers real calls: a live page always runs
on the real time, and a reset never deletes a real incident. Set `DEMO_NOW` to start
the server with the clock already pinned; a time that matches a preset selects it.

The console drives these simulation routes, and you can too. Each one waits until
everything it set off has settled, so the response already holds the result. A real
call returns `409` — the console can follow it, not drive it — except for hang-up.

| Endpoint | What it does |
| --- | --- |
| `POST /api/simulate` | Start a simulated tenant call. `{ "fromPhone": "+12065550102" }`; leave it out for Alice Rivera, or send `""` for a withheld number. An unfinished demo call is ended first |
| `POST /api/simulate/:callId/say` | `{ "text": "…" }` — the tenant speaks or, once a page rings, the technician |
| `POST /api/simulate/:callId/dtmf` | `{ "digit": "1" }` — a key, from whoever is on the line |
| `POST /api/simulate/:callId/silence` | Nobody speaks; on a ringing page, nobody answers |
| `POST /api/simulate/:callId/voicemail` | The ringing page reaches voicemail |
| `POST /api/simulate/:callId/submit` | Submit the report with the fields captured so far |
| `POST /api/simulate/:callId/hangup` | End the call. On a real call the pages carry on |
| `POST /api/simulate/intake` | A whole tenant call in one request: `{ "transcript": [lines], "pageOutcomes": [...] }`, where each outcome is `accept`, `decline`, `no-answer`, `voicemail` or `bridge` |
| `POST /api/simulate/page/:incidentId` | `{ "outcome": "accept" }` — settle the next pending page without a conversation |

On the starting clock this returns an urgent `active_leak` incident, closed, with
`acknowledgedBy: "Morgan Lee"`:

```bash
curl -s -X POST http://127.0.0.1:8095/api/simulate/intake \
  -H 'content-type: application/json' \
  -d '{"fromPhone":"+12065550101","pageOutcomes":["accept"],"transcript":["Water is pouring through my kitchen ceiling.","Yes, 4B. You can go in, the spare key is in the lockbox by the back door.","Yes, that is my cell."]}'
```

To read what happened: `GET /api/calls/:id`, `/api/calls/:id/events`,
`/api/incidents`, `/api/incidents/:id` and `/api/incidents/:id/events`.

## How it works

```
Tenant (PSTN)
   │  Event Grid: Microsoft.Communication.IncomingCall
   ▼
ACS Call Automation ──── answerCall + bidirectional media streaming ────┐
   │                                                                    │
   │  PCM16 24 kHz mono (pcm24KMono)                                     │
   ▼                                                                    │
this server ──── WebSocket, PCM16 forwarded verbatim ────► Voice Live ──┘
   │                                                         (gpt-realtime)
   │  identify_unit / record_issue / classify_and_submit / end_call
   ▼
PagerFlow ── severity, who is on call, escalation timers (config/*.json)
   │
   ├── createCall ──► technician's mobile, with its own Voice Live session
   │                  get_ticket_detail / acknowledge / decline / bridge_to_tenant / repeat_brief / left_voicemail
   ├── Teams Workflows ──► technician card; ops alert if nobody accepts
   ├── addParticipant ──► the tenant joins the page call when the technician presses 3
   └── createCall ──► the tenant's callback number, once someone accepts: a Voice Live
                      session says one server-written update, then the server hangs up
```

### The decision lives on the server

`src/flow.mjs` owns every decision that matters and imports nothing from Azure,
Express or SQLite. The model's job is to fill in fields and read what the server gives
it. It has no severity argument, and it never chooses who is paged, when, or what the
page says: the tools in `src/agent.mjs` take a property, a unit and the report's
fields, and nothing else. The one phone number it can supply is the tenant's callback —
see [Security notes before production](#security-notes-before-production).

```
open → paging → acknowledged → tenantNotified → closed
          ↺  no answer, voicemail or decline: the next attempt, then the next level
          ↘  unacknowledgedAlert   nobody accepted within 20 minutes of the report
workOrderLogged                    routine: nobody is paged
cancelled                          simulation only: a demo call ended before anyone accepted
```

| Rule | Where it is enforced |
| --- | --- |
| Which unit, for which tenant | `PagerPolicy.identifyUnit` — caller ID proposes a unit, the tenant confirms it, and a unit not on file is refused |
| How urgent it is | `PagerPolicy.classify`, from `config/triage.json` |
| Who is on call, and why | `PagerPolicy.onCallChain`, from `config/oncall.json`, on the demo clock |
| What the page says | `buildPageBrief`; the tenant's quote is cleaned by `sanitizeTenantSaid` first |
| What a voicemail hears | `buildVoicemailPrompt` — a callback prompt and a reference, nothing else |
| When to page again, and whom | `PagerFlow#scheduleNext`, from `config/escalation.json` |
| A second call about the same unit | `findDuplicate` in the audit store — attaches to the open incident instead of paging twice; a higher severity restarts paging |
| Nobody accepted | `PagerFlow#sendUnacknowledgedAlert`, 20 minutes after the report |

Because the audit store, the dialer, the Teams notifier and the clock are all
injected, the entire flow is testable with plain `node --test` — no mocks of the
Azure SDK and no subscription. The demo clock is the same injection: the server moves
`now`, and the rotation and the escalation timers follow without knowing a demo clock
exists.

In simulation mode, `src/offline.mjs` stands in for the model: a small keyword parser
fills the same fields the live agent fills through its tools, and speaks the lines the
server returns. It knows the demo's phrasing and little else — it is there so the
console runs without Azure, not as a second classifier.

### What the technician receives

The page is an outbound call to the technician's mobile. The agent says it is an
automated pager, then reads a brief the server built — for the leak above:

> Urgent: active leak at Maple Court, unit 4B, reported 11:42 PM. Tenant said: Water is
> pouring through my kitchen ceiling and it's spreading fast. You may enter. Access:
> The spare key is in the lockbox by the back door. Press 1 or say 'I've got it' to
> accept.

On the page, **1** accepts, **2** declines, **3** connects the technician to the
tenant and **\*** repeats the brief. The technician can also ask questions; the
answers come from the stored incident through `get_ticket_detail`, never a phone
number. If the page reaches voicemail, all it hears is "Contoso maintenance has an
urgent page for you. Please call the maintenance line." and a four-digit reference.

Each page also posts JSON to `TEAMS_WORKFLOW_URL` (`"type": "technicianPage"`, with
the technician's Teams user ID to @mention, the property, unit, issue, access notes
and the tenant's quote), and the 20-minute alert posts `"type":
"opsUnacknowledgedAlert"`, with every attempt, to `TEAMS_OPS_WORKFLOW_URL`. With
the URLs empty — the default — the payloads are recorded locally instead.

The console's **VoIP headers** panel shows the same page as Teams Phone custom calling
context, built on the server by `buildCustomCallingContext`:

| Header | Contents |
| --- | --- |
| `CallDetails.SessionId` | The incident id |
| `CallDetails.CallTopic` | "Active leak · Maple Court 4B", clipped at a word to the Teams 48-character limit |
| `CallDetails.CallContext` | The brief, without the keypad instructions |
| `CallDetails.Severity` | `emergency` or `urgent` |
| `CallDetails.Escalation` | Which level and attempt, such as "secondary · attempt 1 of 2" |
| `CallDetails.PermissionToEnter` | `true` or `false` |

Every value is capped at 1,024 characters, and none holds a phone number. No live call
sends these headers yet: the page is a PSTN call placed with `createCall`, which in
`@azure/communication-call-automation` 1.6 does not carry custom calling context —
Call Automation sends it on `addParticipant` and on transfers. A deployment that rings
the technician's Teams client instead of a mobile number would hand the context over
that way. For a PSTN page, the brief is spoken and the same facts go to Teams as the
Workflows card.

## Configuration

Copy `.env.example` to `.env`. Everything has a working default except the four values
that make real calls possible.

| Variable | Default | Notes |
| --- | --- | --- |
| `ACS_ENDPOINT` | — | Required for real calls. Keyless, via `DefaultAzureCredential` |
| `ACS_CONNECTION_STRING` | — | Fallback if you cannot use Entra. `ACS_ENDPOINT` wins if both are set |
| `ACS_OUTBOUND_CALLER_ID` | — | Required for real calls. The E.164 number that pages and tenant calls present; one this ACS resource can call from |
| `PUBLIC_BASE_URL` | — | Required for real calls. Must be reachable by Event Grid and ACS |
| `VOICE_LIVE_ENDPOINT` | — | Required for real calls. Azure AI Services resource |
| `VOICE_LIVE_API_KEY` | *(empty)* | Leave empty to use Entra, which is recommended |
| `VOICE_LIVE_MODEL` | `gpt-realtime` | |
| `VOICE_LIVE_API_VERSION` | `2026-04-10` | |
| `VOICE_LIVE_VOICE` | `en-US-Ava:DragonHDLatestNeural` | Azure TTS voice; set this alongside `LOCALE` |
| `LOCALE` | `en-US` | The language both legs start in |
| `TEAMS_WORKFLOW_URL` | *(empty)* | Teams Workflows webhook for the technician card. Empty records it locally |
| `TEAMS_OPS_WORKFLOW_URL` | *(empty)* | Teams Workflows webhook for the unacknowledged alert. Empty records it locally |
| `TEAMS_CLOUD` | `public` | Reported in `/health` |
| `INTAKE_TIME_BUDGET_MS` | `300000` | Drawn as the console's intake budget bar; nothing ends a call on it yet. Falls back to `CALL_TIME_BUDGET_MS` |
| `PAGE_TIME_BUDGET_MS` | `180000` | Reported in `/health`; the paging bar uses the 20-minute alert window |
| `PERSIST_TRANSCRIPTS` | `false` | Incidents, pages and the audit trail are always stored; utterances are not |
| `DB_PATH` | `./data/pager.db` | SQLite. If `better-sqlite3` cannot load, the server keeps the audit in memory |
| `PROPERTIES_PATH`, `TENANTS_PATH`, `ONCALL_PATH`, `TRIAGE_PATH`, `ESCALATION_PATH` | `./config/*.json` | Point these at `config/*.local.json` copies to use a real roster without committing it |
| `DEMO_NOW` | *(empty)* | Simulation only. Pins the demo clock at startup (ISO 8601). Empty starts on Weeknight on call; ignored on real calls |
| `HOST`, `PORT` | `127.0.0.1`, `8095` | |

With any of the four call variables unset the server logs `SIMULATION MODE` and runs
the offline console. `GET /health` breaks readiness out per subsystem, and says who is
on call right now and why:

```jsonc
{
  "mode": "simulation",
  "voiceLive": { "ready": false, "auth": "entra", "model": "gpt-realtime", "apiVersion": "2026-04-10", "directMode": true },
  "teamsPhone": { "ready": false, "auth": "none", "cloud": "public", "missing": ["ACS_ENDPOINT", "ACS_OUTBOUND_CALLER_ID", "PUBLIC_BASE_URL"] },
  "outboundCalling": { "ready": false, "callerId": "missing" },
  "currentOnCall": {
    "central": { "primary": { "id": "tech-morgan", "name": "Morgan Lee" }, "why": "Central rotation since Mon, Sep 28", "localTime": "Wed, 11:42 PM PDT" /* … */ },
    "north": { "primary": { "id": "tech-omar", "name": "Omar Diaz" }, "why": "North rotation since Mon, Sep 28" /* … */ }
  },
  "paging": { "attemptsPerLevel": 2, "gapMinutes": { "urgent": 3, "emergency": 1 }, "unacknowledgedAlertMinutes": 20 /* … */ },
  "clock": { "preset": "weeknight", "timeZone": "America/Los_Angeles" /* … */ }
}
```

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

`config/` is the whole paging policy. Changing who is on call, or what counts as
urgent, is a config change, not a prompt rewrite.

```jsonc
// config/oncall.json (excerpt)
{
  "timeZone": "America/Los_Angeles",
  "rotations": {
    "central": [
      { "startsOn": "2026-09-28", "primary": "tech-morgan", "secondary": "tech-priya" },
      { "startsOn": "2026-10-05", "primary": "tech-priya", "secondary": "tech-morgan" }
    ]
  },
  "overrides": [
    { "date": "2026-10-01", "group": "central", "primary": "tech-priya", "secondary": "tech-morgan", "reason": "swap" }
  ]
}
```

An override for the local date wins over the rotation; otherwise the latest rotation
that has started applies. The third level is the property manager named in
`properties.json`.

- `properties.json` — each property's name, the aliases callers use, its on-call group
  and its property manager.
- `tenants.json` — tenants by phone number and unit. A caller ID match proposes the
  unit; it does not authenticate anyone.
- `triage.json` — the emergency, urgent and routine keywords, the 55 °F no-heat line,
  the safety line for each problem, and how long the tenant's quote may be.
- `escalation.json` — the levels, attempts per level, the gap between pages for each
  severity, and the unacknowledged-alert and duplicate windows.
  `answeringMachineAckSeconds` is not used yet.

## Connecting it to a real phone number

The tenant's call comes in through **Teams Phone extensibility**: the tenant dials a
Teams service number on a resource account, Teams routes the call to your linked ACS
resource, and this sample answers it with Call Automation. Pages and the call back to
the tenant go out through ACS.

```
Tenant (PSTN) → Teams service number → Teams resource account → linked ACS resource
              → Microsoft.Communication.IncomingCall (Event Grid) → this sample

this sample → createCall, from ACS_OUTBOUND_CALLER_ID → technician's mobile
            → addParticipant → the tenant, joined to the page call (key 3)
            → createCall → the tenant's callback number, once someone accepts
```

> **The number is the part that trips people up.** Teams Phone extensibility requires
> a Teams *service* number, from Microsoft Calling Plan, Operator Connect, or Direct
> Routing. **A phone number purchased in Azure Communication Services cannot be
> assigned to a Teams resource account** — there is no cmdlet or portal path that
> converts one. Acquiring a Microsoft number also needs at least one Calling Plan
> license in the tenant, and toll-free needs funded pay-as-you-go billing. The free
> `PHONESYSTEM_VIRTUALUSER` license is right for the resource account itself but does
> not let you acquire a number.
>
> If you only hold an ACS number you can still exercise the whole state machine —
> calls to it reach this sample as ordinary Call Automation calls. This sample handles
> both kinds of call the same way and does not record which one it answered.

1. **Provision.** An ACS resource, an Azure AI Services resource, and a Teams tenant
   with a service number on a resource account.
2. **Register a calling bot** and create the resource account against its application
   ID, so the account is yours rather than a first-party Auto Attendant.
3. **Bind the resource account to ACS.** `Set-CsOnlineApplicationInstance -AcsResourceId
   <immutable GUID>` then `Sync-CsOnlineApplicationInstance`. Note this is *not*
   `Set-CsTeamsAcsFederationConfiguration`, which governs a different feature — ACS
   users talking to Teams users — and does nothing for phone extensibility.
   [`scripts/provision-teams-phone.ps1`](scripts/provision-teams-phone.ps1) prints this
   checklist with your values filled in; it changes nothing.
4. **Grant ACS server consent** for that resource account via the `teamsExtension`
   assignment API. The Teams-side binding alone is only half of it.
5. **Get a number to page from.** Pages and the call back to the tenant are outbound
   calls placed by ACS. Set `ACS_OUTBOUND_CALLER_ID` to a number this ACS resource can
   place calls from.
6. **Load your roster.** Copy `oncall.json`, `tenants.json` and `properties.json` to
   `config/*.local.json`, fill in real technicians — mobile numbers in E.164, and
   Teams user object IDs for the card's @mention — and point `ONCALL_PATH`,
   `TENANTS_PATH` and `PROPERTIES_PATH` at the copies. `config/*.local.json` is
   gitignored.
7. **Create the Teams workflows** that receive the technician card and the operations
   alert, and set `TEAMS_WORKFLOW_URL` and `TEAMS_OPS_WORKFLOW_URL`.
8. **Expose this server.** `npm run tunnel`, then set `PUBLIC_BASE_URL`.
9. **Subscribe to `IncomingCall`.** Create an Event Grid system topic on the ACS
   resource with a webhook subscription to `<PUBLIC_BASE_URL>/api/events`, filtered to
   `Microsoft.Communication.IncomingCall`. The server answers the validation handshake
   automatically. Set the Azure Bot calling webhook to `https://eventgrid.azure.net`.
10. **Check `/health`,** then call the number.

Pages present `ACS_OUTBOUND_CALLER_ID`, not the Teams service number. Placing them from
the resource account instead —
[server-initiated outbound calls for Teams Phone extensibility](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-server-outbound-call)
— is not wired up in this sample.

### Live call test matrix

These exercise the common paths through a real Voice Live call. The agent's wording
comes from the model and varies; the severity, who is paged, the timers and the brief
come from the server and do not.

| Flow | Say or do | Expected behavior |
| --- | --- | --- |
| Urgent leak, accepted | Call from a number in your tenants file: `Water is pouring through my kitchen ceiling` → confirm the unit, permission to enter and the callback number → on the technician's phone, press `1` or say `I've got it` | The on-call primary for that property is called and hears the brief; the acknowledgement is recorded with the time to acknowledge. The agent thanks them and hangs up, and the tenant's phone rings with a spoken update: "A technician has your request and will call you shortly." |
| Decline | On the technician's phone, press `2` | The agent says who it's paging next and hangs up; the next level is paged at once |
| Question | On the technician's phone: `Where's the spare key?` | Answered from the stored access notes |
| Number request, then bridge | `What's the tenant's number?` → press `3` | Refuses the number, says it's connecting the tenant, then goes quiet; the tenant joins the page call. Both sides see `ACS_OUTBOUND_CALLER_ID`, not each other. If the tenant doesn't pick up, the agent comes back to say so, hangs up, and the tenant gets the spoken update instead |
| Repeat | Press `*` | The brief is read again |
| Ring-out | Let the technician's phone ring out | Recorded as a no-answer; the next attempt is 3 minutes later (1 for an emergency) |
| Voicemail | Let the page reach voicemail | The greeting carries no details. On hearing a voicemail greeting or a beep, the agent leaves only the server's prompt and hangs up; the attempt is recorded as voicemail, and the next one is scheduled |
| Gas | `I smell gas in the kitchen` | The 911 safety line, then an emergency page, 1 minute between attempts |
| Routine | `I have a dripping faucet in the bathroom` | A work order for the office, with the next business day as the follow-up; nobody is paged |
| Nobody accepts | Decline or ignore every page | The operations alert posts 20 minutes after the report, and the tenant gets a spoken update: "The team is still working to reach a technician for your request." |

## Project layout

```
src/
  flow.mjs          the state machine: intake, paging, escalation — no Azure, Express or SQLite imports
  policy.mjs        triage, the on-call rotation and its "why", the page brief, the voicemail prompt
  handoff.mjs       the technician card, the operations alert, and the VoIP headers
  agent.mjs         the tool schemas and standing instructions for the intake and the page
  offline.mjs       the stand-in agent and technician, used only in simulation
  audit.mjs         in-memory audit store (the interface the flow depends on) and the metrics
  db.mjs            the SQLite implementation of that same interface
  notifications.mjs posts to Teams Workflows; records locally when no URL is set
  realtime.mjs      WebSocket hub that pushes state to the console
  config.mjs        environment, readiness, and what is missing for real calls
  server.mjs        Event Grid intake, ACS callbacks, simulation API, demo clock
  voice/
    voice-live.mjs  the Voice Live WebSocket session
    acs.mjs         answer, page, call back, bridge, DTMF, hang up
    call-bridge.mjs binds one call leg to one Voice Live session, and hangs up finished calls
config/
  properties.json   the properties, their on-call group and property manager
  tenants.json      fictional tenants, matched by caller ID
  oncall.json       technicians, rotations and date overrides
  triage.json       what counts as an emergency, urgent or routine
  escalation.json   levels, attempts, gaps, and the alert and duplicate windows
public/             the presenter console
  app.js            the panels: call, paging decision, page guardrails, page, rotation, trail, metrics
  beats.js          the scripted demo and its narration — edit this to adapt the demo
  presenter-kit.*   shared console building blocks, vendored: edit scripts/presenter-kit/
                    at the repository root, then run `node scripts/sync-presenter-kit.js`
scripts/
  smoke-websockets.mjs       boots its own server and checks both WebSockets and the demo controls
  provision-teams-phone.ps1  prints the Teams Phone provisioning checklist; changes nothing
test/               no Azure and no network required
```

`flow.mjs`, `policy.mjs`, `handoff.mjs`, `agent.mjs`, `offline.mjs`, `audit.mjs` and
`notifications.mjs` import no third-party packages. That is deliberate: the parts you
most need to read and trust are the parts that run without installing anything.

## Operational notes

- **Event Grid delivers duplicates by design.** The server de-duplicates
  `IncomingCall` on event id before answering, so a redelivery does not answer the same
  call twice.
- **DTMF is always on.** Continuous recognition starts on `CallConnected` for the
  person on the line. Only the page acts on keys today: **1**, **2**, **3** and **\***.
  A key runs the same tool as the spoken request, and the agent then says the result.
  The keypad shortcut for a person in the console is simulation only.
- **Pages are scheduled jobs.** Each page and alert is a job in the audit store with a
  due time; a scheduler runs whatever has fallen due every 5 seconds, on the same clock
  the policy reads.
- **Hanging up does not stop the paging.** Once the report is in, the tenant can hang
  up. A page that fails to connect, or ends before anyone accepts, counts as a
  no-answer and escalates.
- **A live voicemail is the model's call.** There is no answering-machine detection.
  The page agent's greeting carries no details, and it reads the brief only after a
  person speaks. If it hears a voicemail greeting or a beep instead, it calls
  `left_voicemail` and says only the prompt the server returns; the attempt is recorded
  as voicemail and the next one is scheduled. The reference it leaves matches the
  incident in the console and the audit trail; nothing on the line looks it up yet.
- **The tenant's status call is one server-written update.** It runs its own Voice
  Live session with no tools: the agent says it's an automated assistant, reads the
  update, and the server hangs up (after 40 seconds at most).
- **The server hangs up a page it's finished with.** After an accept, a decline, a
  voicemail prompt or a failed bridge, the agent says its closing line, and the server
  hangs up once that has had time to play — about 65 ms a character, 25 seconds at
  most. A page the technician hands to the tenant with **3** is their call from then
  on, so the server never hangs it up. A late answer to a page that has already moved
  on (accepted, or rung again) hears that it has been handled, and is hung up.
- **The next page waits while the technician is talking.** On an answered page, every
  line said pushes the safety-net page a full gap later, so a retry can't ring while
  the brief is being read or a question answered. A call that drops counts as
  unanswered and escalates.
- **If Voice Live can't connect,** a page or a status call is hung up, so a page
  escalates instead of ringing in silence. The tenant's own call is left up but silent:
  play a fallback message there before production.
- **The callback number is held in memory only.** After a restart, the call back and
  the bridge are skipped and logged (`status_call_skipped`, `bridge_unavailable`).
- **A failed call or Teams post shows fixed wording.** The console and the audit name
  the step that failed; the error from ACS or the workflow goes to the server log only,
  because it can name the number dialed or echo the signed workflow URL. If the
  tenant's status call fails or is skipped, the incident closes as *The tenant wasn't
  reached — the office follows up*.
- **Barge-in** sends `StopAudio` to ACS and `response.cancel` to Voice Live, so the
  agent stops mid-word rather than talking over the caller.
- **Voice Live allows one in-flight response.** A state change and a tool result can
  both want the agent to speak, so requests are coalesced in `voice-live.mjs`.
- **`MediaStreamingFailed` is logged with its code and subcode,** because a media
  socket that never connected otherwise looks like a Voice Live problem.

## Security notes before production

- **The callback number is the one number the model can supply.** `record_issue`
  accepts a `callbackNumber`, and the server dials it — for the status call, and when a
  technician presses 3. Nothing restricts it today, so a caller could talk the agent
  into calling a premium-rate or international number. Allow only the caller's own
  number, or numbers in your region, before production.
- **Caller ID is not authentication.** A tenant match proposes a unit, which the
  caller confirms, and releases nothing else.
- **No phone numbers on a page.** The brief, the technician card, the operations alert
  and the VoIP headers carry none. Contact numbers stay in the server-side roster, and
  anything number-like in the tenant's quote is removed before it can be read out.
- **The tenant's words are quoted, not obeyed.** The quote is one line, capped at 160
  characters, with instruction-like text removed, and it is read inside a brief the
  server built.
- **Voicemail hears nothing private:** a callback prompt and a reference, with no
  address, unit, problem or name.
- **Transcripts are off by default.** Incidents and the audit trail are stored;
  utterance text reaches disk only if you set `PERSIST_TRANSCRIPTS`.
- **Disclose the assistant.** The intake and the page both say up front that they are
  automated. Several jurisdictions require this; all callers deserve it.
- **This is not an emergency service.** The opening line sends anyone in danger to 911.
  The gas, fire and smoke rules page a maintenance technician; they do not call for
  help.
- **Lock down the console and the webhooks.** The console and its API have no sign-in,
  and `npm run tunnel` exposes the server anonymously — fine for a fictional demo, not
  for a real roster. The server does not authenticate Event Grid or Call Automation
  callbacks; see
  [securing the webhook endpoint](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/secure-webhook-endpoint).
- **Phone numbers are masked** in the console, the audit store and the logs.
- The seeded tenants, technicians, 555 numbers and Teams user IDs are fictional
  placeholders. Replace them through `config/*.local.json`.

## Microsoft references

- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [How to use the Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to)
- [Call Automation overview](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation)
- [Passing contextual data with custom headers](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/custom-context)
- [Teams interop with Call Automation](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/teams-interop-call-automation)
- [Bidirectional media streaming](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/audio-streaming-quickstart)
- [Placing outbound calls for Teams Phone extensibility](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-server-outbound-call)
- [Securing the Call Automation webhook endpoint](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/secure-webhook-endpoint)
