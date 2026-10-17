# Customer Record Lookup & Update

A hands-free CRM line for Contoso's field sales reps. A rep calls from Teams or from a
registered mobile, hears a short briefing on one of their customer accounts, dictates
what happened in a meeting, and gets the record updated — but only after the agent has
read the change back, heard an explicit "yes, save it", and let a short undo window run
out.

The point is not that a model can read a CRM record out loud. It is everything around
that: who is calling before anything is read out, which fields this caller may hear,
which fields anyone may change by phone, what happens when the caller changes their mind
halfway through a save, and what Sales Operations sees when a request is not the agent's
to handle.

Built on [Azure Communication Services Call Automation](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation),
the [Azure AI Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live),
and [Teams Phone extensibility](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-overview).

> Illustrative sample. The reps, the customer accounts and the organization are
> fictional. Read [Security notes before production](#security-notes-before-production)
> before pointing this at a real phone number or a real CRM.

## What the demo shows

- **Verified before anything is read.** A Teams sign-in identifies the rep. A call from
  a registered mobile is only a hint until the six-digit PIN is right. The console's
  checklist shows each check, and the record card stays locked until they pass.
- **Only what this caller may hear.** Records open only for accounts the rep owns or is
  on the account team for. A contact's phone number or email stays off the card until
  the rep asks for it, and credit limits and payment terms stay with Sales Operations.
- **Read back, an explicit yes, then an undo window.** A dictated update becomes a
  proposal checked against an allow-list of fields and limits. The agent reads it back,
  and a bare "yes" is not enough: it waits for "yes, save it". A server-owned window
  (six seconds by default) then counts down before the write commits with field-level
  audit rows, and the console shows before → after.
- **A mind change writes nothing.** "Wait, no — keep the old number" inside the window
  stops the write, and the panel says nothing was written. After the window, "undo
  that" reverts the commit, unless someone has changed the field since.
- **Not mine to change.** Discounts, a new account owner, deleting or merging accounts,
  credit limits and payment terms are refused by server policy, whatever the model makes
  of the request, and the agent offers to put the rep through to Contoso Sales
  Operations with the details.
- **Can't verify, won't disclose.** A wrong PIN opens no record and reads nothing out;
  the call goes to Sales Operations with only the last four digits of the number and the
  failed check. A caller who is neither a known rep on Teams nor a registered mobile
  hears that the line is for sales staff, and the call ends.
- **Metrics from the audit trail.** Lookups, confirmed writes, undone writes, refusals
  and handoffs are counted from audited call events, not estimated.

## Quick start

Runs with no Azure subscription at all.

```bash
npm install
npm start
# open http://127.0.0.1:8097
```

The console runs a scripted demo: press **→** (or **Next ▶**) and it plays five short
beats, typing — and, if you like, speaking — the caller's lines. [DEMO-SCRIPT.md](DEMO-SCRIPT.md)
is the running order, with what to say at each step.

Or drive it yourself: pick a **Caller ID**, click **Answer a call**, and type what the
caller says. A typed transcript drives *the same state machine* a real call would: the
same identity checks, the same allow-list, the same undo window, the same handoff
assembly. Only the speech model and the audio path are stubbed; a keyword stand-in plays
the model's part.

Try these, in order, on one **Alex (Teams)** call:

| Type this | What you should see |
| --- | --- |
| `Brief me on Fabrikam` | Tier, last touch, three open deals, a task due today and the key contact, with no phone number |
| `What's Dana's number?` | The number is read out because the rep asked, and only now appears on the card |
| `Log the Fabrikam meeting. Dana agreed to the renewal at 240k, moving to Closed Won pending signature, close date June 15th. Remind me to send the contract Friday.` | A read-back of a meeting activity, four deal changes and a task due Friday, June 12, then "Save it?" |
| `Yes` | Not enough: the agent asks for "yes, save it", and nothing is written |
| `Yes, save it.` | "Saving in six seconds", a countdown, then "Saved to Fabrikam's record." with a before → after diff and audit rows |
| `Undo that` | "Undone. Fabrikam's record is back to how it was." |
| `Update Fabrikam: Dana has a new mobile, 425 555 0143.` → `Yes, save it.` → `Wait, no — keep the old number.` | Stopped inside the window: nothing written, and the number is still the one ending 0120 |
| `Raise Fabrikam's credit limit to 500k and move them to net 60 payment terms.` → `Yes, put me through.` | Refused by policy with nothing written, then a handoff to Contoso Sales Operations with the details |

Then, each on a new call:

| Caller ID and input | What you should see |
| --- | --- |
| **Alex (Teams)**: `I need a person` | Straight to Contoso Sales Operations, no questions asked |
| **Alex (Teams)**: `Brief me on Tailspin`, twice | Another rep's private account stays closed; after the second miss, a person |
| **Alex (mobile)**: the keypad's **PIN wrong** key (`135790`) | No record opened, nothing read out, a safe handoff |
| **Alex (mobile)**: the keypad's **PIN Alex's** key (`246810`) | "Thanks, Alex, you're verified. Which account?" |
| **Unknown number** | The line is for Contoso sales staff; the call ends politely |

The undo window is six seconds. `wait` on its own is enough to stop it; to have time to
type a whole sentence, start the server with `COMMIT_UNDO_MS=10000`.

Run the tests — they need no Azure and no network:

```bash
npm test        # 53 cases: identity, the allow-list, the undo window, the handoff, the demo controls
npm run check
npm run smoke   # boots its own server on port 8197 and checks both WebSockets, the undo window and the demo controls
```

### Demo controls

In simulation mode the console pins the clock the record rules see and puts the seeded
customer records back, so every run starts identical:

| Endpoint | What it does |
| --- | --- |
| `GET /api/demo/clock` | The demo clock, its time zone and the presets |
| `POST /api/demo/clock` | `{ "preset": "demo-day" \| "real" }` or `{ "at": "<ISO 8601>" }` |
| `POST /api/demo/reset` | Forget the simulated calls and their audit events, restore the seeded customer records and the starting clock. An open undo window closes without writing |
| `POST /api/demo/records` | Restore the seeded customer records only, once any open undo window has closed (waiting a bounded time); calls and metrics stay. Each scripted beat starts with this |
| `GET /api/stats` | The metrics the console ends on: lookups, confirmed writes, undone writes, refusals, handoffs, and a few more |

The `POST`s return `403` while the server answers real calls: a live call always runs on
the real time, and a reset never deletes a real call's audit record.

The clock matters because the records carry real dates and the rules read them: which
task is due today and which is overdue, what "Friday" means, that a close date can't be
in the past, and that a new task is due within 90 days. A simulation therefore starts on
the **Demo day** preset — Wednesday, June 10, 2026, at noon Pacific — so every run says
"due today" and means the same Friday; **Real time** reads the same task as overdue.
Moving the clock never stretches or shortens an undo window, which runs on the server's
own timer. Set `DEMO_NOW` to start the server somewhere else.

## How it works

```
Rep on Teams, or on a registered mobile
   │  Teams Phone extensibility → linked ACS resource
   │  Event Grid: Microsoft.Communication.IncomingCall
   ▼
ACS Call Automation ──── answerCall + bidirectional media streaming ────┐
   │                                                                    │
   │  PCM16 24 kHz mono (pcm24KMono)                                     │
   ▼                                                                    │
this server ──── WebSocket, PCM16 forwarded verbatim ────► Voice Live ──┘
   │                                                         (gpt-realtime)
   │  find_account / get_briefing / propose_update / commit_proposal / …
   ▼
CustomerRecordFlow ──── reads, and confirmed writes ────► CRM adapter (SQLite fixture)
   │
   └──── TransferCallToParticipant + VoIP custom context ────► Teams call queue
                                                               (Sales Operations)
```

### The decision lives on the server

`src/flow.mjs` owns every decision that matters and imports nothing from Azure, Express
or SQLite. The model's power is to call tools — find an account, read a briefing,
propose an update, pass on the rep's confirmation — and each tool lands in the flow,
which decides. No tool has a parameter for a Teams object ID, a PIN, a number to dial or
a URL, and a test asserts that: the model can neither vouch for a caller nor choose where
a call goes. A contact's stored number reaches the model only through
`get_contact_info`, when the rep has asked for it; a read-back names only its last four
digits.

```
ringing → identifying ──► greeting → listening ⇄ briefing
              │
              ├──► refused                        not a known rep
              └──► transferring → transferred     wrong PIN, nothing opened

listening → proposing → confirming ──"yes, save it"──► committing ──window closes──► committed
                         ↺ amend                           │
                                                           └──"wait"──► listening, nothing written
```

| Rule | Where it is enforced |
| --- | --- |
| Who is calling | `RepDirectory` in `src/providers/crm.mjs`: a Teams user, or a registered mobile plus the PIN |
| Which accounts a rep may open | `canSee` in `src/crm-shared.mjs`: accounts the rep owns or is on the team for |
| Which fields may change, and within what limits | `config/writable-fields.json`, loaded into an allow-list |
| What is never changed by phone | `POLICY_REFUSALS` in `src/flow.mjs`, which offers a person instead |
| What counts as "yes" | `isExplicitSave` in `src/flow.mjs`: "yes, save it", never a bare "yes" or a "maybe" |
| How long the undo window runs | `COMMIT_UNDO_MS`, default 6 s; `0` writes at once |
| Whether an undo is still safe | The CRM adapter's `revertCommit`, which refuses if the field has changed since |
| How long a call may take | `CALL_TIME_BUDGET_MS`, default 8 minutes; at `WRAP_UP_MS` an unconfirmed update is kept as a draft |
| How many misses before a person | Two in a call — an account not found, a record the rep can't open — then Sales Operations |

Because the CRM adapter, the rep directory, the audit sink, the transfer function, the
console hub and the clock are all injected, the entire flow is testable with plain
`node --test` — no mocks of the Azure SDK and no subscription.

Every line that carries a decision — the briefing, the read-back, "Saving in six
seconds", "Stopped. Nothing was written" — is written by the flow, not by the model. In
simulation the stand-in agent says it verbatim. On a live call the tool result carries
the line for the model to say, and a line that happens outside a tool, such as the undo
window closing, is sent to Voice Live as "say this, as written". That is why simulation
produces a readable conversation without a model, and why the wording is easy to review
in `flow.mjs`.

### What Teams receives

Only **VoIP headers** are used. SIP headers are a PSTN-side mechanism and do not reach a
Teams identifier, so context sent that way would vanish silently — the rep would still
be transferred, but Sales Operations would answer blind.

| Header | Contents |
| --- | --- |
| `CallDetails.SessionId` | The Auto Attendant session id when this line sits behind one, otherwise the ACS correlation id |
| `CallDetails.CallTopic` | What the call is about, clipped to the Teams 48-character limit, such as `Fabrikam – credit limit, payment terms` |
| `CallDetails.CallContext` | JSON: the rep and how they were verified, the account, the reason, the request, any refused fields, the pending proposal and the last write. For an unverified caller: only the last four digits of the number, the failed check, and that no records were opened |
| `CallDetails.RouteId` | `sales-operations` |

Phone numbers, email addresses and long digit runs are masked in the context, so a
contact's number never reaches whoever picks up: the field name is enough.
The console's **VoIP headers on the wire** panel is built on the server by the same
`buildCustomCallingContext` the transfer uses, so what it shows is what Teams receives.

A call queue is a resource account, so it is addressed as a Teams *app*
(`{ teamsAppId }`); a `"type": "user"` target is addressed as a Teams *user*
(`{ microsoftTeamsUserId }`). Both take a Microsoft Entra object ID, which is why
`routing.json` holds an object ID and never a phone number.

## Configuration

Copy `.env.example` to `.env`. Everything has a working default except the three
values that make real calls possible.

| Variable | Default | Notes |
| --- | --- | --- |
| `ACS_ENDPOINT` | — | Required to answer real calls. Keyless, via `DefaultAzureCredential` |
| `ACS_CONNECTION_STRING` | — | Fallback if you cannot use Entra. `ACS_ENDPOINT` wins if both are set |
| `PUBLIC_BASE_URL` | — | Must be reachable by Event Grid and ACS |
| `VOICE_LIVE_ENDPOINT` | — | Azure AI Services resource |
| `VOICE_LIVE_API_KEY` | *(empty)* | Leave empty to use Entra, which is recommended |
| `VOICE_LIVE_MODEL` | `gpt-realtime` | |
| `VOICE_LIVE_API_VERSION` | `2026-04-10` | |
| `VOICE_LIVE_VOICE` | `en-US-Ava:DragonHDLatestNeural` | Azure TTS voice; set this alongside `LOCALE` |
| `LOCALE` | `en-US` | The agent's language and the speech-recognition hint |
| `TEAMS_CLOUD` | `public` | The Teams cloud of the transfer target |
| `HOST`, `PORT` | `127.0.0.1`, `8097` | Where the server listens |
| `CRM_ADAPTER` | `sqlite` | `sqlite`, `memory`, or `dataverse` (a documented stub) |
| `CRM_DB_PATH` | `./data/crm.db` | The SQLite file, created and seeded on first run; `data/` is gitignored |
| `CRM_SEED_PATH`, `REPS_PATH`, `ROUTING_PATH`, `WRITABLE_FIELDS_PATH`, `PICKLISTS_PATH` | `./config/…` | Point any of these at a `config/*.local.json` copy to keep your own data out of git |
| `TIME_ZONE` | `America/Los_Angeles` | What "today" and "Friday" mean |
| `COMMIT_UNDO_MS` | `6000` | The undo window after "yes, save it". `0` writes at once |
| `CALL_TIME_BUDGET_MS` | `480000` | The whole call, then a polite goodbye |
| `WRAP_UP_MS` | `420000` | "We're almost out of time"; an unconfirmed update is kept as a draft |
| `TRANSCRIPT_RETENTION` | `false` | Decisions are always audited; what was said is added only if you set this |
| `PIN_REQUIRED_FOR_PSTN` | `true` | Reported by `/health`. The flow asks every registered mobile for the PIN either way |
| `DEMO_NOW` | *(empty)* | Simulation only. Where the demo clock starts: `demo-day` (the default when empty), `real`, or an ISO 8601 time. Ignored on real calls |
| `DATAVERSE_URL`, `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` | — | Passed to the Dataverse adapter stub, which does not use them yet |

With the three call variables unset the server logs `SIMULATION MODE` and runs the
offline console. `GET /health` breaks readiness out per subsystem, because "not ready"
is rarely uniform — Voice Live can be configured while ACS is not, and both can be
configured while `routing.json` still holds the placeholder object ID:

```jsonc
{
  "mode": "simulation",
  "voiceLive": { "ready": false, "auth": "entra", "model": "gpt-realtime" },
  "telephony": { "ready": false, "auth": "none", "missing": ["ACS_ENDPOINT", "PUBLIC_BASE_URL"] },
  "teams":     { "ready": false, "unprovisionedTargets": ["salesOperations"] },
  "crm":       { "adapter": "sqlite", "ready": true, "seedCounts": { "accounts": 8, "contacts": 9, "opportunities": 6, "activities": 2, "tasks": 2, "drafts": 0 } },
  "policy":    { "commitUndoMs": 6000, "callBudgetMs": 480000, "wrapUpMs": 420000 },
  "clock":     { "preset": "demo-day", "now": "2026-06-10T19:00:00.000Z", "timeZone": "America/Los_Angeles" }
}
```

The `teams` line answers "why did my transfer fail?" before anyone has to read a log.

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

### Where the records live

`CRM_ADAPTER` picks the CRM. Every adapter offers the flow the same methods, chosen in
`src/providers/crm.mjs`:

- **`sqlite`** (the default): `src/db.mjs`, a local database at `CRM_DB_PATH`, seeded
  from `config/crm-seed.json` on first run. Records survive a restart; **Reset demo**
  puts the seed back. If the native SQLite module will not load, the server logs that and
  runs the in-memory CRM instead.
- **`memory`**: `src/crm-memory.mjs`, the same records in the process, reseeded on every
  start. The tests and the smoke run use it.
- **`dataverse`**: `src/providers/dataverse-crm.mjs`, a documented stub — every method
  throws. Its comments describe a real adapter: call the
  [Dataverse Web API](https://learn.microsoft.com/power-apps/developer/data-platform/webapi/overview)
  as the rep, through the [on-behalf-of flow](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-on-behalf-of-flow),
  so the CRM's own roles and [field-level security](https://learn.microsoft.com/power-platform/admin/field-level-security)
  decide what can be read and written.

Both local adapters keep each commit and its field-level audit rows, which is what makes
"undo that" and its conflict check possible. Both phrase records through
`src/crm-shared.mjs`, so a rep hears the same words from either.

### What the agent may change

`config/writable-fields.json` is the whole write policy. Adding a writable field is a
config change, not a prompt rewrite:

```jsonc
{
  "opportunity": {
    "update": {
      "stage":     { "type": "picklist", "picklist": "opportunityStage" },  // from config/picklists.json
      "amount":    { "type": "currency", "min": 0, "max": 10000000 },
      "closeDate": { "type": "date", "notBefore": "today" },
      "nextStep":  { "type": "text", "maxLength": 200 }
    }
  },
  "task":    { "create": { "dueDate": { "type": "date", "withinDays": 90 }, "owner": { "type": "fixed", "value": "me" } } },
  "contact": { "update": { "phone": { "type": "phone" }, "email": { "type": "email" } } }
}
```

A value outside its limits is left out of the read-back with a reason ("The close date
can't be in the past, so I left it alone"). A request on the refused list — a discount
or pricing change, a new account owner, deleting or merging an account, a credit limit,
payment terms — writes nothing and offers a person in Sales Operations instead.

## Connecting it to a real phone number

Inbound uses **Teams Phone extensibility**: the call reaches a Teams resource account,
Teams routes it to your linked ACS resource, and this sample answers it with Call
Automation. The server tells callers apart by the caller id: a phone number (`4:+1…`)
must be a rep's registered mobile and then needs the PIN; a Teams user (`8:orgid:…`) is
matched by object ID.

```
PSTN caller → Teams service number → Teams resource account → linked ACS resource
            → Microsoft.Communication.IncomingCall (Event Grid) → this sample
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
> calls to it reach this sample as ordinary Call Automation calls. They arrive
> without the Teams resource account identity, and the server logs them as
> `acs-direct` rather than `teams-phone-extensibility` so the difference is never
> silent.

1. **Provision.** An ACS resource, an Azure AI Services resource, and a Teams tenant
   with a service number on a resource account.
2. **Register a calling bot** and create the resource account against its application
   ID, so the account is yours rather than a first-party Auto Attendant.
3. **Bind the resource account to ACS.** `Set-CsOnlineApplicationInstance -AcsResourceId
   <immutable GUID>` then `Sync-CsOnlineApplicationInstance`. Note this is *not*
   `Set-CsTeamsAcsFederationConfiguration`, which governs a different feature — ACS
   users talking to Teams users — and does nothing for phone extensibility. See
   [`scripts/provision-teams-phone.ps1`](scripts/provision-teams-phone.ps1).
4. **Grant ACS server consent** for that resource account via the `teamsExtension`
   assignment API. The Teams-side binding alone is only half of it.
5. **Set the transfer target.** Put the Entra object ID of the Sales Operations call
   queue's resource account in `config/routing.json` (the script prints it). To keep
   your own IDs out of git, copy the file to `config/routing.local.json` and set
   `ROUTING_PATH` — `config/*.local.json` is gitignored. If your tenant has no call
   queue yet, a `"type": "user"` target pointing at any Teams user with Enterprise Voice
   is enough to see a transfer.
6. **Add your reps.** `config/reps.json` holds each rep's Entra object ID and Teams user
   ID, registered mobile, PIN hash, and the CRM owner ID their accounts are filed under.
   Copy it to `config/reps.local.json` and set `REPS_PATH`, and read the PIN note under
   the security notes first.
7. **Expose this server.** `npm run tunnel`, then set `PUBLIC_BASE_URL`.
8. **Subscribe to `IncomingCall`.** Create an Event Grid system topic on the ACS
   resource with a webhook subscription to `<PUBLIC_BASE_URL>/api/events`, filtered to
   `Microsoft.Communication.IncomingCall`. The server answers the validation handshake
   automatically. Set the Azure Bot calling webhook to `https://eventgrid.azure.net`.
9. **Check `/health`,** then call the number.

### Live call test matrix

These phrases exercise the common paths through a real Voice Live call. The model words
its own replies around the server's lines, so the phrasing varies; who is verified, what
is refused and when a write lands are decided by the server and do not.

| Flow | Say or do | Expected behavior |
| --- | --- | --- |
| Briefing | From Teams: `Brief me on Fabrikam` | Says it is automated, then the briefing; no contact number until asked |
| Contact on request | `What's Dana's number?` | Reads out that one number, because it was asked for |
| Save | The meeting debrief, then `Yes, save it` | A read-back, "Saving in six seconds", then saved with audit rows |
| Bare yes | The debrief, then `Yes` | Asks for "yes, save it"; nothing is written |
| Mind change | `Yes, save it`, then `Wait` within six seconds | Stopped; nothing is written |
| Undo | After a save: `Undo that` | Reverted, unless the field has changed since |
| Policy refusal | `Raise Fabrikam's credit limit to 500k` → `Yes, put me through` | Refused, then transferred with the details in the VoIP headers |
| Human escape | `I need a person`, or keypad `0` from a phone | Transferred to Sales Operations |
| Mobile PIN | From the registered mobile, key the PIN | Nothing is read until the PIN is right; a wrong PIN hands off with no records opened |
| Call me back | Mid-update: `Call me back later` | The update is kept as a draft, not written; the next call offers to resume it |
| Transfer recovery | Ask for a person while the Sales Operations queue does not answer | One apology and a goodbye, any unconfirmed update kept as a draft — never a second attempt |

The keypad only works on calls from a phone: Teams callers are identified by sign-in, so
the server starts DTMF recognition only for phone numbers.

## Project layout

```
src/
  flow.mjs          the state machine and every policy decision — no Azure, Express or SQLite imports
  crm-shared.mjs    who may see a record, how it is phrased, dates and phone numbers
  crm-memory.mjs    the CRM in memory: the tests, the smoke run, and CRM_ADAPTER=memory
  db.mjs            the CRM in SQLite: CRM_ADAPTER=sqlite, the default
  providers/
    crm.mjs           picks the CRM adapter; the rep directory and the PIN check
    dataverse-crm.mjs a documented Dataverse stub
  handoff.mjs       transfer target → Teams identifier, context → VoIP headers
  agent.mjs         the tool schema and standing instructions given to the model
  offline.mjs       keyword stand-in for the model, used only by the console
  audit.mjs         in-memory audit trail and the /api/stats metrics
  realtime.mjs      WebSocket hub that pushes state to the console
  config.mjs        environment, defaults and /health readiness
  server.mjs        Event Grid intake, ACS callbacks, simulation API, demo controls
  voice/
    voice-live.mjs    the Voice Live WebSocket session
    acs.mjs           answer, transfer, DTMF, hang up
    call-bridge.mjs   binds one call to one Voice Live session
config/
  crm-seed.json         fictional accounts, contacts, deals, activities and tasks
  reps.json             fictional reps: Teams IDs, registered mobiles, PIN hashes
  writable-fields.json  the write allow-list and its limits
  picklists.json        stages, activity types and tiers, as spoken
  routing.json          the Sales Operations transfer target
  briefing.json         the briefing's order and limits, as documentation (not read at run time)
public/             the presenter console
  app.js            the panels: call, identity and record card, Teams toast, write-back, audit trail, metrics
  beats.js          the scripted demo and its narration — edit this to adapt the demo
  presenter-kit.*   shared console building blocks, vendored: edit scripts/presenter-kit/
                    at the repository root, then run `node scripts/sync-presenter-kit.js`
scripts/
  smoke-websockets.mjs       boots its own server on 8197 and checks the WebSocket upgrades
  provision-teams-phone.ps1  the Teams side of Teams Phone extensibility
test/               53 cases, no Azure required
```

`flow.mjs`, `crm-shared.mjs`, `crm-memory.mjs`, `handoff.mjs`, `agent.mjs`, `offline.mjs`
and `audit.mjs` import no third-party packages. That is deliberate: the parts you most
need to read and trust are the parts that run without installing anything.

## Operational notes

- **Event Grid delivers duplicates by design.** The server de-duplicates on event id
  before answering, so a redelivery does not answer the same call twice.
- **The identity check waits for the voice.** The flow starts once Voice Live is
  connected on the media bridge, so the caller hears the disclosure and the PIN prompt.
- **A confirmed write is not lost to a hang-up.** A hang-up or a transfer inside the undo
  window still commits what the rep confirmed. Only a mind change, or a demo reset,
  stops it.
- **Writes take turns.** While a window is open, a new update or another "yes" is held
  ("One moment, I'm saving the last change"), and the console's next scripted call waits
  for the window to close, up to a bound.
- **The transfer is blind.** The agent's job ends once the context is delivered.
  Staying on the line would put a silent third party on every handed-off call.
- **`CallTransferFailed` is answered, not retried.** When ACS accepted the transfer but
  nobody picked up, the flow apologizes once, keeps any unconfirmed update as a draft,
  says goodbye, and ends the call. Such a transfer does not count as a handoff in
  `/api/stats`.
- **The server ends the call, not the model.** Once the flow refuses or ends a call (an
  unknown caller, the call-time cap, a failed transfer), the bridge hangs up after the
  closing line has had time to play (about 65 ms a character, 25 s at most). The model's
  `end_call` never cuts a closing line short and is refused once a transfer has started.
- **Barge-in** sends `StopAudio` to ACS and `response.cancel` to Voice Live, so the
  agent stops mid-word rather than talking over the caller.
- **Voice Live allows one in-flight response.** A state change and a tool result can
  both want the agent to speak, so requests are coalesced in `voice-live.mjs`.

## Security notes before production

- **Caller ID is not authentication.** A registered mobile only earns the PIN prompt;
  nothing is read until the PIN is right, and a wrong PIN hands the call to a person.
  The fixture stores PINs as unsalted SHA-256 hashes, which is fine for fictional data
  and not for real reps: use your identity provider, or at least a salted, slow hash
  and a lockout.
- **The model cannot write outside the allow-list or choose a destination.** It
  proposes; the flow validates every field and transfers only to the configured target.
  Keep it that way: a tool that accepts a phone number turns a prompt injection into a
  toll-fraud vector.
- **"Yes, save it" is checked on the server, from the model's quote.** On a live call
  the model passes the rep's last words as `commit_proposal`'s `confirmation`. The
  server rejects a bare "yes", but it trusts the quote; if that matters to you, compare
  it with the transcript.
- **Act as the rep against a real CRM.** The fixture filters records itself; a
  production adapter should call the CRM on behalf of the rep, so the CRM's own security
  decides what can be read and written.
- **Transcripts are off by default.** Decisions are audited; what was said reaches the
  audit only if you set `TRANSCRIPT_RETENTION`. `src/voice/voice-live.mjs` does log each
  tool call's arguments, and `propose_update` carries the rep's dictation, which can
  include a phone number: remove or redact that log line before production.
- **Disclose the assistant.** The opening line says it is automated. Several
  jurisdictions require this; all callers deserve it.
- **The handoff carries only what was earned.** An unverified caller is named by the
  last four digits of the number, and contact values never enter the VoIP headers.
- The seeded reps, accounts, PIN and object IDs are fictional placeholders. Replace them.

## Microsoft references

- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [How to use the Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to)
- [Call Automation overview](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation)
- [Passing contextual data with custom headers](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/custom-context)
- [Teams interop with Call Automation](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/teams-interop-call-automation)
- [Bidirectional media streaming](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/audio-streaming-quickstart)
- [Continuous DTMF recognition and other mid-call actions](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/control-mid-call-media-actions)
- [Teams Phone extensibility overview](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-overview)
- [Teams Phone extensibility FAQ](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-faq)
- [Teams Phone extensibility quickstart](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-quickstart)
- [Dataverse Web API overview](https://learn.microsoft.com/power-apps/developer/data-platform/webapi/overview)
- [Microsoft identity platform and the OAuth 2.0 on-behalf-of flow](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-on-behalf-of-flow)
- [Field-level security in Dataverse](https://learn.microsoft.com/power-platform/admin/field-level-security)
