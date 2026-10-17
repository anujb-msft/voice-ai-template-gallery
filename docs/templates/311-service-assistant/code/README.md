# 311 Service Assistant

A city's 311 line that residents can simply talk to. A caller can ask a city question,
report a pothole or a missed pickup, check on a case, or book a bulk-item pickup, in
English or Spanish and in one conversation. When they need a person, they reach 311 staff
on Teams, and what they already said is on the staff member's screen.

The point is not that a model can fill in a form. It is the part a city cannot leave to a
model:
- a gas leak stops the conversation in code;
- a location is checked against the city's address data and read back before anything is
  filed;
- answers come only from reviewed content, with the source named;
- office hours decide whether a person can be reached;
- the handoff means the caller doesn't have to say it all again.

Built on [Azure Communication Services Call Automation](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation),
the [Azure AI Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live),
and Teams Phone extensibility.

> Illustrative sample. The City of Contoso and everything about it are fictional: its
> addresses, departments, articles, phone numbers and Teams object IDs. Read
> [Security notes before production](#security-notes-before-production) before pointing
> this at a real phone number.

## What the demo shows

- **Emergencies are a server rule, not a model judgment.** The server checks every
  caller turn against `config/emergency.json`. "I smell gas" gets safety guidance and
  the gas utility's number at once, with no questions and no case.
- **Nothing is filed on an unverified location.** The caller describes the place in
  their own words. The server resolves it against the city's address data and reads it
  back: "I have the pothole at Oak Avenue and 5th Street. Is that right?" Nothing is
  filed until the caller says yes.
- **Answers come only from approved content.** Every article has an owner, a source and
  a last-reviewed date.
  - Fresh articles are read out with the source named.
  - Stale articles are read out with a caveat.
  - Expired articles are withheld: the agent says it won't guess and offers 311 staff.
- **A real service request, with the follow-up on the caller's phone.** The caller gets a
  case number, a department, a priority and a response target. With their consent, they
  also get a confirmation text. In simulation the text appears on the console's phone
  panel and is never sent.
- **The same service in Spanish.** A caller who speaks Spanish is answered in Spanish.
  The locale and voice reach the agent, and the questions, the case and the text follow.
- **A person, with context, when one is available.** Some calls go to a Teams call queue
  with a topic and context as VoIP headers:
  - a complaint;
  - a priority hazard;
  - a request for a person;
  - two turns the agent can't use.

  When the queue is closed, the caller is told when to call back. They are not
  transferred into an empty queue.

## Quick start

Runs with no Azure subscription at all.

```bash
npm install
npm start
# open http://127.0.0.1:8096
```

The console runs a scripted demo. Press **→** (or **Next ▶**) and it plays five short
beats:
1. a pothole report;
2. a gas leak;
3. a Spanish-speaking caller;
4. a civic question;
5. a complaint that needs a person.

It types the caller's lines and can also speak them. [DEMO-SCRIPT.md](DEMO-SCRIPT.md) is
the running order, with what to say at each step.

Or drive it yourself: pick a **Caller ID**, click **Answer a call**, and type what the
caller says. The keypad buttons send **1** (yes), **2** (no), **0** (a person) and
**\*** (repeat). **Silence** stands in for a caller who says nothing.

A typed transcript drives *the same state machine* a real call would. It uses the same
emergency rule, geocoder, approved content, office hours and handoff assembly. Only the
voice model and the audio path are stubbed.

Try these after **Reset demo**, with the clock on **Business hours**:

| Type this | What you should see |
| --- | --- |
| `Hi, there's a big pothole on Oak Avenue, right at the corner of Fifth Street.` then `Yes, that's right.` | The place is read back, then case SR-26-0193 is filed with Public Works, response target 5 business days |
| `Hi, I smell gas in my kitchen and I'm not sure what to do.` | **Emergency rule fired**: leave the building, call the gas utility at 555-0109 or dial 911. No questions, no case |
| `When is trash pickup on Maple Street?` | Zone A, Tuesday, with the source: Sanitation service guide |
| `What are the counter hours at City Hall?` | The only matching article has expired, so the agent won't guess and offers 311 staff |
| `Hola, necesito que recojan un colchón y un sofá viejo.` | The call switches to Spanish (es-US) and asks for the pickup address |
| `There's a large pothole in the travel lane at Oak and 5th, cars are swerving around it.` then `Yes, that's right.` | A priority case with a 24-hour target, then a transfer to Public Works. On **After hours**: "Public Works will follow up on the next business day." Typed right after the first row, it joins SR-26-0193 and raises that case to priority instead of filing a second one |
| `Can I talk to a person?` | Straight to the 311 Live Agent Queue. On **After hours**, the caller hears the hours instead and is not transferred |
| `blah blah`, twice | "Sorry, I didn't get that…", then 311 staff |
| `There's a big pothole.` then `Maple and Pine.` then `Elm and Birch.` | "I couldn't verify that location…", then 311 staff. Nothing is filed |
| **Silence**, twice | "Are you still there? You can press 0 for a person.", then a polite goodbye |

Run the tests. They need no Azure and no network:

```bash
npm test        # 40 cases across the call flow, the demo controls and the Teams handoff
npm run check
npm run smoke   # boots its own server on port 8196 and checks both WebSockets, the simulate routes and the demo controls
```

`npm run smoke` stops with a message if something is already listening on port 8196.

### Demo controls

In simulation mode, the console can move the clock that the policy code sees. That clock
decides office hours, collection days, response targets and content freshness. So one
running server can show both the business-hours path and the after-hours path:

| Endpoint | What it does |
| --- | --- |
| `GET /api/demo/clock` | The demo clock, its time zone and the presets |
| `POST /api/demo/clock` | `{ "preset": "business-hours" \| "after-hours" \| "real" }` or `{ "at": "<ISO 8601>" }` |
| `POST /api/demo/reset` | Forgets the simulated calls, service requests and texts, clears them from the audit and restores the starting clock |

The presets:
- `business-hours` is Wednesday, September 30, 2026, at 10:30 a.m. Pacific, when every
  department is open.
- `after-hours` is 7:30 p.m. the same day, when Public Works and 311 staff have gone
  home.

The clock keeps running from the time you set. Case numbers start again at SR-26-0193
after a reset.

Both `POST`s return `403` while the server answers real calls, for two reasons. A live
call always uses the real time, and a reset never deletes a real call's record or a real
service request. Set `DEMO_NOW` to start the server with the clock already pinned.

The console also reads three other endpoints:
- `GET /api/stats`: the metrics in its footer, plus breakdowns by request type,
  department and transfer reason;
- `GET /api/sms`: the texts on its phone panel;
- `GET /api/cases`: the service requests, without contact details.

## How it works

```
PSTN caller
   │  Teams service number → resource account → linked ACS resource
   │  Event Grid: Microsoft.Communication.IncomingCall
   ▼
ACS Call Automation ──── answerCall + bidirectional media streaming ────┐
   │                                                                    │
   │  PCM16 24 kHz mono (pcm24KMono)                                    │
   ▼                                                                    │
this server ──── WebSocket, PCM16 forwarded verbatim ────► Voice Live ──┘
   │                                                         (gpt-realtime)
   │  search_faq / resolve_location / submit_request / transfer / …
   ▼
ServiceAssistantFlow ── emergency rule · geocoder · approved content · cases
   │
   └── TransferCallToParticipant + VoIP custom context ────► Teams call queue
```

### The decision lives on the server

`src/flow.mjs` owns every decision that matters and imports nothing from Azure, Express
or SQLite. The model's job is to listen and call tools. It never sees a Teams object ID,
the caller's phone number or a reporter's name. Every line the caller hears is written by
the server and sent to Voice Live to be said word for word: the read-back, the case
number, the emergency guidance and the handoff line.

```
ringing → greeting → listening ⇄ answering · intake ⇄ confirming → filed · guided · status
                         │
                         ├─ the caller is done ──────► closing → ended
                         ├─ an emergency phrase ─────► emergency_redirect → ended
                         └─ a person, and open ──────► transferring → transferred
```

| Rule | Where it is enforced |
| --- | --- |
| Which phrases are emergencies, and what the caller hears | `config/emergency.json`, checked by `ServiceAssistantFlow.checkEmergency` on every caller turn |
| A location must be verified and confirmed before filing | `FixtureGeocoder` (`config/addresses.json`, `config/streets.json`), then `resolveLocation` and `confirmLocation` |
| Which report types exist and what each one needs | `config/request-types.json`: required fields, department, response targets and priority rules |
| Which answers may be read out | `ContentIndex`, by each article's `lastReviewed` date: fresh up to 180 days, then stale for `CONTENT_EXPIRY_GRACE_DAYS`, then expired and withheld |
| Whether a department can take a transfer | `DepartmentDirectory.isOpen`, from `config/departments.json` hours and `config/holidays.json` |
| Whether a report is a duplicate | The request type's `duplicate` rule in `request-types.json` (50 m and 7 days for every shipped type). A duplicate joins the open case. If it reports a hazard and that case is standard, the case is raised to priority once |
| Which bulk items may be collected, and when | `config/bulk-pickup.json`: accepted items and each zone's collection calendar |
| Whether a text may be sent | The caller's consent, a number that isn't withheld, and `ACS_SMS_FROM` on a live call |
| What happens when the agent can't use a turn | `ServiceAssistantFlow.fail`. A place the geocoder can't verify counts as a miss too. The first miss asks again. The second goes to 311 staff, or, after hours, tells the caller their hours. A third miss ends the call politely instead of asking again |
| How long a call may take, and how many requests it may carry | `CALL_TIME_BUDGET_MS` (five minutes) and `MAX_REQUESTS_PER_CALL` (3) |

The audit sink, the case store, the transfer function, the texts and the clock are all
injected. That makes the entire flow testable with plain `node --test`, with no mocks of
the Azure SDK and no subscription.

### What Teams receives

Only **VoIP headers** are used. SIP headers are a PSTN-side mechanism and do not reach a
Teams identifier. Context sent that way would vanish silently: the caller would still be
transferred, but the staff member would answer blind.

| Header | Contents |
| --- | --- |
| `CallDetails.SessionId` | The Auto Attendant's session id when this line sits behind one, otherwise the ACS correlation id |
| `CallDetails.CallTopic` | What the call is about, cut at a word to the Teams 48-character limit: `PRIORITY pothole – SR-26-0193`, `Complaint: trash trucks have skipped my street…` |
| `CallDetails.CallContext` | JSON, described below |
| `CallDetails.RouteId` | The department whose queue takes the call |

`CallDetails.CallContext` holds:
- the case number, request type, verified location and fields;
- the language and the transfer reason;
- a short summary;
- for a complaint, the caller's own words and the sentiment they expressed;
- whether the caller asked for updates, as consent flags only, never the number.

The console's **VoIP headers on the wire** panel is built on the server by the same
`buildCustomCallingContext` that the transfer uses. What it shows is what Teams receives.

Department queues are resource accounts, so they are addressed as Teams *apps*
(`{ teamsAppId, cloud }`). A named person would be addressed as a Teams *user*
(`{ microsoftTeamsUserId }`). Both take a Microsoft Entra object ID. That is why
`departments.json` holds object IDs and never phone numbers.

## Configuration

Copy `.env.example` to `.env`. Everything has a working default except the three values
that make real calls possible.

| Variable | Default | Notes |
| --- | --- | --- |
| `ACS_ENDPOINT` | — | Required to answer real calls. Keyless, through `DefaultAzureCredential` |
| `ACS_CONNECTION_STRING` | — | Fallback if you cannot use Entra. `ACS_ENDPOINT` wins if both are set |
| `PUBLIC_BASE_URL` | — | Must be reachable by Event Grid and ACS, for callbacks and the media WebSocket |
| `VOICE_LIVE_ENDPOINT` | — | Azure AI Services resource |
| `VOICE_LIVE_API_KEY` | *(empty)* | Leave empty to use Entra, which is recommended |
| `VOICE_LIVE_MODEL` | `gpt-realtime` | |
| `VOICE_LIVE_API_VERSION` | `2026-04-10` | |
| `VOICE_LIVE_VOICES` | `en-US-Ava:DragonHDLatestNeural,es-US-PalomaNeural` | One voice per locale. The agent switches voice when the caller switches language |
| `LOCALES` | `en-US,es-US` | Informational. The English and Spanish lines are built in |
| `ACS_SMS_FROM` | *(empty)* | An SMS-capable number on the ACS resource. Without it, live callers are not offered texts. Simulated calls always show their texts on the console and never send them |
| `TEAMS_CLOUD` | `public` | The cloud in a Teams app identifier |
| `HOST` / `PORT` | `127.0.0.1` / `8096` | |
| `CASE_STORE` | `sqlite` | `sqlite` or `memory`. If SQLite cannot load, the server keeps cases and the audit in memory and logs why |
| `DB_PATH` | `./data/311-service.db` | |
| `GEOCODER` | `fixture` | The only geocoder shipped |
| `DUPLICATE_RADIUS_M` / `DUPLICATE_WINDOW_DAYS` | `50` / `7` | For a request type without its own `duplicate` rule |
| `MAX_REQUESTS_PER_CALL` | `3` | After that, the next request goes to 311 staff |
| `CALL_TIME_BUDGET_MS` | `300000` | Thirty seconds before the limit, the agent asks to wrap up. At the limit, it closes the call politely |
| `CONTENT_EXPIRY_GRACE_DAYS` | `90` | How long a stale article is still read out, with a caveat |
| `CASE_RETENTION_DAYS` | `365` | Recorded setting. This sample does not purge cases |
| `PERSIST_TRANSCRIPTS` | `false` | Writes the transcript to the SQLite store. Decisions and case details are always stored |
| `DEMO_NOW` | *(empty)* | Simulation only. Pins the demo clock (ISO 8601) so a demo shows the same open and closed departments every run. Ignored on real calls |
| `*_PATH` | `./config/…`, `./content/articles` | `REQUEST_TYPES_PATH`, `DEPARTMENTS_PATH`, `ADDRESSES_PATH`, `STREETS_PATH`, `BULK_PICKUP_PATH`, `EMERGENCY_PATH`, `HOLIDAYS_PATH`, `ARTICLES_PATH` |

With any of the three call variables unset, the server logs `SIMULATION MODE` and runs
the offline console. `GET /health` breaks readiness out per subsystem, because "not
ready" is rarely uniform:

```jsonc
{
  "mode": "simulation",
  "voiceLive":  { "ready": false, "auth": "entra", "model": "gpt-realtime" },
  "telephony":  { "ready": false, "auth": "none", "missing": ["ACS_ENDPOINT", "PUBLIC_BASE_URL"] },
  "teamsPhone": { "ready": false, "entryPoint": "teams-phone-extensibility", "fallback": "acs-direct" },
  "sms":        { "ready": false, "from": "missing" },
  "corpus":     { "en": { "fresh": 1, "stale": 1, "expired": 2, "total": 4 }, "es": { … } },
  "departments": { "public-works": true, "sanitation": true, "311-live": true, … },
  "texts": "simulated",
  "clock": { "preset": "business-hours", "now": "2026-09-30T17:30:00.000Z" }
}
```

### Keyless auth

Both Azure connections default to Entra, so no key needs to live on disk.

**ACS.** Set `ACS_ENDPOINT` and leave `ACS_CONNECTION_STRING` unset. The signed-in
identity needs **Communication and Email Service Owner** on the ACS resource. Locally,
that identity comes from `az login`; in Azure, use a managed identity. Texts use the same
endpoint and credential.

**Voice Live.** Assign the same identity both of these roles on the AI Services resource:

- **Cognitive Services User**
- **Foundry User**

The server then gets a token for the `https://ai.azure.com/.default` scope through
`DefaultAzureCredential`. Setting `VOICE_LIVE_API_KEY` overrides this.

### City data

The files in `config/` and `content/` are the whole policy. Adding a report type, an
emergency phrase, a department or an article is a data change, not a prompt rewrite. The
report types the model is told about come from `request-types.json`.

- **`request-types.json`.** Each type's required fields, department, response target,
  priority rule and duplicate rule.
- **`departments.json`.** Each department's hours, time zone and Teams queue. Holidays
  come from `holidays.json`.
- **`emergency.json`.** The emergency phrases in English and Spanish, and what the caller
  hears for each category.
- **`addresses.json` and `streets.json`.** The addresses the geocoder can verify, and
  each street's aliases and intersections.
- **`bulk-pickup.json`.** Accepted and refused items, and each zone's calendar.
- **`content/articles/{en,es}/*.md`.** The approved answers. Each one names its owner,
  its source and its `lastReviewed` date in front matter.

To keep your own data out of git, copy a file to `config/<name>.local.json` and point
its `*_PATH` variable at the copy. `config/*.local.json` is gitignored.

## Connecting it to a real phone number

Inbound calls use **Teams Phone extensibility**. The caller dials a Teams service number
on a resource account. Teams routes the call to your linked ACS resource, and this sample
answers it with Call Automation.

```
PSTN caller → Teams service number → Teams resource account → linked ACS resource
            → Microsoft.Communication.IncomingCall (Event Grid) → this sample
```

> **The number is the part that trips people up.** Teams Phone extensibility requires a
> Teams *service* number from Microsoft Calling Plan, Operator Connect or Direct Routing.
> **A phone number purchased in Azure Communication Services cannot be assigned to a
> Teams resource account.** There is no cmdlet or portal path that converts one.
> Acquiring a Microsoft number also needs at least one Calling Plan license in the
> tenant, and toll-free needs funded pay-as-you-go billing. The free
> `PHONESYSTEM_VIRTUALUSER` license is right for the resource account itself, but it does
> not let you acquire a number.
>
> If you only hold an ACS number, you can still exercise the whole state machine. Calls
> to it reach this sample as ordinary Call Automation calls. They arrive without the
> Teams resource account identity, and the server logs them as `acs-direct` rather than
> `teams-phone-extensibility`, so the difference is never silent.

1. **Provision.** You need an ACS resource, an Azure AI Services resource, and a Teams
   tenant with a service number on a resource account.
2. **Register a calling bot.** Create the resource account against the bot's application
   ID, so the account is yours rather than a first-party Auto Attendant.
3. **Bind the resource account to ACS.** Run `Set-CsOnlineApplicationInstance
   -AcsResourceId <immutable GUID>`, then `Sync-CsOnlineApplicationInstance`. This is
   *not* `Set-CsTeamsAcsFederationConfiguration`, which governs a different feature (ACS
   users talking to Teams users) and does nothing for phone extensibility.
   [`scripts/provision-teams-phone.ps1`](scripts/provision-teams-phone.ps1) prints
   reminders for the binding, the webhooks and the object IDs with your own values
   filled in. It changes nothing.
4. **Grant ACS server consent** for that resource account through the `teamsExtension`
   assignment API. The Teams-side binding alone is only half of it.
5. **Collect object IDs.** Get the Entra object ID of each department queue's resource
   account and put it in `departments.json` (or in a `config/departments.local.json` copy,
   with `DEPARTMENTS_PATH` set). These are the *transfer targets*, separate from the
   inbound resource account. If your tenant has no call queues yet, set a department's
   `teamsQueue.type` to `"user"` and point it at any Teams user with Enterprise Voice to
   see a transfer.
6. **Expose this server.** Run `npm run tunnel`, then set `PUBLIC_BASE_URL`.
7. **Subscribe to `IncomingCall`.** Create an Event Grid system topic on the ACS
   resource, with a webhook subscription to `<PUBLIC_BASE_URL>/api/events` filtered to
   `Microsoft.Communication.IncomingCall`. The server answers the validation handshake
   automatically. Call Automation callbacks come back to `/api/calls/callback`, which the
   server sets when it answers. Set the Azure Bot calling webhook to
   `https://eventgrid.azure.net`.
8. **Optionally, set `ACS_SMS_FROM`** to an SMS-capable number on the ACS resource, so
   callers who agree get their case number by text.
9. **Check `/health`,** then call the number.

On a server that answers real calls, the console follows a real call when nothing else
is on screen, with the room voice muted. The clock buttons and **Reset demo** are turned
off, and the policy uses the real time.

## Project layout

```
src/
  flow.mjs        the state machine — no Azure, Express or SQLite imports
  offline.mjs     the simulated agent the console drives: same tools, no model
  agent.mjs       the tool schema and standing instructions given to the model
  handoff.mjs     department → Teams identifier, context → VoIP headers
  content.mjs     approved articles and their freshness
  geocoder.mjs    the fixture geocoder: addresses, intersections, streets, landmarks
  fixtures.mjs    request types, the department directory, hours and holidays
  cases.mjs       in-memory case store (the interface the flow depends on)
  audit.mjs       in-memory audit sink and the demo metrics
  db.mjs          the SQLite implementation of both, loaded only when used
  sms.mjs         confirmation texts; the ACS SMS SDK loads only for a real text
  config.mjs      environment settings and /health readiness
  realtime.mjs    WebSocket hub that pushes state to the console
  server.mjs      Event Grid intake, ACS callbacks, simulation API, demo controls
  voice/
    voice-live.mjs  the Voice Live WebSocket session
    acs.mjs         answer, transfer, DTMF, hang up
    call-bridge.mjs binds one call to one Voice Live session
config/           the city's rules: request types, departments, emergencies, addresses, bulk pickup
content/articles/ approved answers in English and Spanish
public/           the presenter console
  app.js          the panels: call, decision, case card, phone, Teams toast, trail, metrics
  beats.js        the scripted demo and its narration — edit this to adapt the demo
  presenter-kit.* shared console building blocks, vendored: edit scripts/presenter-kit/
                  at the repository root, then run `node scripts/sync-presenter-kit.js`
scripts/
  smoke-websockets.mjs     boots the server on port 8196 and checks the WebSockets,
                           the simulate routes and the demo controls
  provision-teams-phone.ps1 prints the Teams Phone checklist
test/             36 cases, no Azure required
```

None of `flow.mjs`, `offline.mjs`, `agent.mjs`, `handoff.mjs`, `content.mjs`,
`geocoder.mjs`, `fixtures.mjs`, `cases.mjs` or `audit.mjs` imports a third-party
package. That is deliberate: the parts you most need to read and trust run, and
`npm test` passes, without `npm install`. `config.mjs` loads `dotenv` only if it is
installed. The Azure SDKs and SQLite are imported only when a live call or a SQLite
store needs them.

## Operational notes

- **Event Grid delivers duplicates by design.** The server de-duplicates on event id
  before answering, so a redelivery does not answer the same call twice.
- **The keypad is always on.** Continuous DTMF recognition starts on `CallConnected`:
  - 1 means yes;
  - 2 means no;
  - 0 asks for a person;
  - \* repeats the last line.

  The agent mentions 0 when the caller goes quiet.
- **A live transfer waits two seconds,** so "I'm connecting you with … now" plays before
  the call leaves.
- **If ACS rejects a transfer request,** the flow tries 311 staff once if they are open.
  Otherwise it apologizes and stays on the line to take a report or answer a question.
- **`CallTransferFailed` closes the call once, honestly.** It means ACS accepted the
  transfer and then nobody answered. `flow.transferFailed` apologizes, repeats the case
  number if there is one, and ends the call with the outcome `transfer_failed`. It never
  dials the queue again, so a queue that keeps failing cannot cause a loop, and the call
  is not counted as handed off.
- **Barge-in** sends `StopAudio` to ACS and `response.cancel` to Voice Live, so the agent
  stops mid-word rather than talking over the caller.
- **An emergency phrase cancels the current response.** On a live call, the rule runs
  on Voice Live's transcript of the caller's turn, so the model may already have started
  to answer. The server cancels that answer, and the caller hears the guidance instead.
- **Voice Live allows one in-flight response.** A state transition and a tool result can
  both want the agent to speak, so requests are coalesced in `voice-live.mjs`.
- **The call budget is enforced on the clock.** A real call is checked every five
  seconds, even if the caller goes quiet.

## Security notes before production

- **Replace the fixtures** with authoritative 311 or Open311, GIS and department
  systems, and replace the placeholder object IDs.
- **The emergency rule is a phrase list, not a classifier.** Review the phrases and the
  guidance with your emergency services and gas utility. Keep it on the server: the model
  is told to stop, but the server is what ends the call.
- **Caller ID is not authentication.** A status check returns only the status and the
  department. It never returns another reporter's details, and a test covers a prompt
  injection that asks for them.
- **The model never holds contact details.** `set_contact` stores consent flags
  outside the model's context. The caller's number reaches only the SMS sender, and only
  with consent.
- **Phone numbers are masked** in the console, the texts panel and the logs, and the
  audit does not record them. The full caller ID stays on the call in memory and is used
  only to send a text the caller agreed to.
- **Transcripts are off by default.** Decisions and case details are persisted because
  they are the audit trail. The transcript is written to the SQLite store only if you
  set `PERSIST_TRANSCRIPTS`.
- **Disclose the assistant.** The opening line says it is automated and points
  emergencies to 911.
- **Complete the reviews** a public service needs before going live: legal, records
  retention, SMS consent, accessibility and language access.
- **Store secrets** in a managed identity or Key Vault. Add rate limits, monitoring, and
  validation of the Event Grid subscription.

## Microsoft references

- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [How to use the Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to)
- [Call Automation overview](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation)
- [Passing contextual data with custom headers](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/custom-context)
- [Teams interop with Call Automation](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/teams-interop-call-automation)
- [Bidirectional media streaming](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/audio-streaming-quickstart)
