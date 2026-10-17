# Appointment Scheduling Agent

An inbound scheduling line on Teams Phone for Contoso Health, a fictional clinic group.
A caller gives a name and date of birth, says what the visit is for in their own words,
hears two times that fit, and books one by saying yes. When a person is needed, the call
goes to the right Teams queue with what has already been checked on the receiving
agent's screen.

The point is not that a model can book an appointment. It is that the model *can't*. It
can verify, search and propose a time, but only the server writes to the schedule: once,
and only when the caller says yes to the time that was just read back. If someone else
takes that time first, nothing is written and the caller chooses again. Identity,
eligibility and consent are decisions in code, not instructions in a prompt.

Built on [Azure Communication Services Call Automation](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation),
the [Azure AI Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live),
and [Teams Phone extensibility](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-overview).
Runs on Node.js 22 or later.

> Illustrative sample. The clinic, patients, providers, schedule and Teams object IDs are
> fictional. Read [Security notes before production](#security-notes-before-production)
> before pointing this at a real phone number or a real scheduling system.

## What the demo shows

- **The model can't book.** Its tools verify, search, hold a time and ask for a person;
  `book`, `reschedule` and `cancel` are not among them. When it reaches for one anyway,
  the server refuses it by name and writes nothing.
- **One yes, one write.** A booking is written only when the caller says yes (or presses
  1) to the *active proposal*: the one time that was just held and read back. At that
  moment the server checks identity, eligibility and the active proposal again and
  records the caller's consent, and the console ticks off all four.
- **No silent swap.** If the held time is taken before the yes lands (`slot_taken`), the
  write is refused, the proposal is void and the caller hears fresh times. The earlier
  yes doesn't carry over to any of them.
- **Eligibility is policy, not judgment.** Insurance, visit frequency, referrals and
  orders are checked in a fixed order from config. A visit that needs a referral isn't
  offered, and the referral coordinator is one sentence away.
- **Caller ID is not identity.** A matching number greets no one by name. Two misses on
  name and date of birth end in a handoff that discloses nothing about appointments.
- **Context that survives the handoff.** The topic and what has been checked travel to
  Teams as VoIP headers, and the console shows the literal headers next to a mock Teams
  incoming-call toast.
- **Safety words outrank scheduling.** Emergency or urgent symptoms go to the nurse line,
  with a 911 line first for an emergency, whatever the call was doing.
- **A clock you can set.** Openings, lead times and whether a queue is staffed all depend
  on the time, so the demo pins it: Tuesday 9:50 AM by default, Friday 6:30 PM for the
  after-hours paths.

## Quick start

Runs with no Azure subscription at all.

```bash
npm install
npm start
# open http://127.0.0.1:8100
curl http://127.0.0.1:8100/health
```

The console runs a scripted demo: press **→** (or **Next ▶**) and it plays five short
beats (a booking, a refused write, a race for the same time, a referral handoff and a
failed identity check), typing (and, if you like, speaking) the caller's lines.
[DEMO-SCRIPT.md](DEMO-SCRIPT.md) is the running order, with what to say at each step, and
`npm run rehearse` plays it end to end before you do.

Or drive it yourself: pick a **Caller ID**, click **Answer a call**, and type what the
caller says. It works fully in simulation mode with no Azure credentials: typed
utterances drive the same verification, eligibility, slot search, hold, booking,
reschedule, cancellation, waitlist, audit and WebSocket console paths used by a live
call. Only the model and the audio path are stubbed.

Try these. Each row starts from **Reset demo** on the Tue 9:50 AM clock; a row that starts
with … carries on from the one above.

| Caller ID → type this | What you should see |
| --- | --- |
| Jordan Rivera → `Jordan Rivera, 03/12/1984`, then `I've had a cough for a week and I'd like to see my usual doctor, mornings if possible.` | Verified, then two times with Dr. Patel: today at 11 a.m. or Thursday at 8:30 a.m. Nothing is held yet |
| … then `The first one.` and `Yes, please.` | The time is held and read back; the yes books it as A-20440 and all four checks go green |
| Mia Chen → `Mia Chen, 02/18/1991`, then `Just book me whatever you have.` | Refused: nothing is booked until she has heard a specific time and said yes to it |
| … then `A follow-up with Dr. Patel.`, and with two times offered click **Model calls “book”** | The tool call is refused on the trail, nothing is written, and the agent repeats the offer |
| Avery Stone → `Avery Stone, 06/09/1979`, `A follow-up with Dr. Patel, please.`, `The first one.`, then click **Front desk books it** and type `Yes, book it.` | `slot_taken`: nothing is written and two fresh times are offered. `The first one.` and `Yes.` book the new time |
| Jordan → `Jordan Rivera, 03/12/1984`, then `I'd like a skin check for a mole.` | No times: a skin check needs a referral. `Connect me with the referral coordinator.` transfers, with the context in the Teams toast |
| Jordan → `Jordan Rivera, 03/21/1984`, then `Jordan Rivera, 12/03/1984` | Two misses, nothing about appointments, and a handoff marked not verified |
| `Can I talk to a person?`, or keypad **0** | The scheduling team, straight away. A time on hold travels with the call as `heldSlot` |
| `I have chest pain.` | The 911 line, then the nurse line |
| Jordan → `Jordan Rivera, 03/12/1984`, then `I need to move my appointment.` | His MRI and X-ray are listed. `The X-ray.`, `The first one.` and `Yes.` move it |
| Mia → `Mia Chen, 02/18/1991`, then `I need to cancel my appointment.` | Her skin check is read back. `Yes.` and `Yes.` cancel it |
| Clock on **Fri 6:30 PM**, then `Can I talk to a person?` | The team is closed: a callback is filed for a known number, and an unknown number hears when to call back |

Run the tests. They need no Azure, no network, and not even `npm install`:

```bash
npm test          # 54 cases: the flow, the store, the tools and the five beats, on Node's built-in node:sqlite
npm run check
npm run smoke     # after npm install: boots its own server on port 8200, checks both WebSockets and the demo controls
npm run rehearse  # after npm install: plays the five beats on port 8300 as the console does, three ways (~2 min)
npm run offline -- --script race    # one beat in the terminal, no server
```

`npm run rehearse` fails if a beat would land anywhere [DEMO-SCRIPT.md](DEMO-SCRIPT.md)
doesn't say: each beat's outcome and decision trail is pinned in `scripts/rehearse.mjs`, and
so are the metrics it ends on. It plays the script in order, again after a reset, and last
beat first with each beat twice, at Auto-play's pace and at full speed, and checks that a
live server refuses the demo controls. Neither `.env` nor your shell's settings reach its
server. Changed a beat on purpose? It prints the outcomes it reached, ready to paste over the
pins once you've checked them against the script.

The scripts:

- `npm start`: `node src/server.mjs` on port 8100.
- `npm run dev`: the same, in watch mode.
- `npm test`: `node --test test/*.test.mjs`.
- `npm run check`: syntax checks on `src/`, `src/voice/`, `scripts/`, `test/` and `public/*.js`.
- `npm run smoke`: starts a simulation-mode server on port 8200, then checks the console
  hub and the media WebSocket, a simulated call and the demo controls, and stops it.
- `npm run rehearse`: starts a simulation-mode server on port 8300 with the shipped
  settings, plays every beat in `public/beats.js` three ways as the console does, then
  boots it live with fictional settings to check the demo controls are refused.
- `npm run offline`: the flow in the terminal. `-- --script book|book-whatever|race|referral|identity-fails`
  runs a beat; `-- --phone +12065550142 --say "Jordan Rivera, 03/12/1984|A follow-up with Dr. Patel."`
  runs your own lines. In either, `@take-slot` (the front desk takes the time read back, or
  else the first time offered) and `@tool book` (a model tries to book) are steps, printed
  where they happen; `--preset tue-morning|fri-evening|real`, `--at <ISO 8601>` and `--json`
  also work.
- `npm run tunnel`: a dev tunnel to port 8100 for the ACS callbacks.

### Demo controls

In simulation mode the console can set the clock the schedule sees, put the stage back the
way it started, and stage the two things that test the booking rule: a busy front desk and
a model that reaches for a tool it doesn't have.

| Endpoint | What it does |
| --- | --- |
| `GET /api/demo/clock` | The demo clock, its time zone and the presets |
| `POST /api/demo/clock` | `{ "preset": "tue-morning" \| "fri-evening" \| "real" }` or `{ "at": "<ISO 8601>" }`. Calls in progress move with it |
| `POST /api/demo/reset` | Forget the simulated calls, clear them from the audit, and restore the seeded schedule and the starting clock |
| `POST /api/demo/take-slot` | `{ "callId" }`: the front desk books the time this caller is about to accept, so `slot_taken` happens on cue. `409` until a time has been offered |
| `POST /api/demo/tool` | `{ "callId", "name", "args" }`: a tool call through the same dispatcher a live call uses. `"name": "book"` comes back refused |
| `GET /api/stats` | The metrics: calls, booked, refused writes, races resolved, handoffs, and the schedule's counts |
| `GET /api/schedule/grid?provider=prov-patel&days=5` | The availability grid: 15-minute cells marked free, booked, held, break, holiday, past or closed, never who |

While the server answers real calls, every demo `POST` and `POST /api/simulate` return
`403`, because a simulated booking would land in the real schedule; a real call can be
watched in the console but never spoken for. Reset clears only simulated calls from the
audit, and it restores the schedule only when that is the in-memory demo copy, which is the
default in simulation. If `SCHEDULE_DB_PATH` names a file, the file is left alone.

Set `DEMO_NOW` to start the server with the clock pinned somewhere else. Unset, it starts
on Tuesday, May 19, 2026 at 9:50 AM in the clinic's time zone; set it empty for the real
time. A pinned clock runs forward from there, so a held time counts down in real minutes.

## How it works

```
PSTN caller → Teams service number → Teams resource account → your ACS resource
   │  Event Grid: Microsoft.Communication.IncomingCall
   ▼
ACS Call Automation ──── answerCall + bidirectional media streaming ────┐
   │                                                                    │
   │  PCM16 24 kHz mono (pcm24KMono)                                    │
   ▼                                                                    │
this server ──── WebSocket, PCM16 forwarded verbatim ────► Voice Live ──┘
   │                                                    (gpt-realtime)
   │  the caller's words → callerSaid(), the gate
   │  the model's tools  → verify_patient / search_slots / hold_slot / transfer / …
   ▼
SchedulingFlow ──── search · hold · the one write ────► ScheduleAdapter (SQLite)
   │
   └──── TransferCallToParticipant + VoIP custom context ────► Teams call queue
```

### The decision lives on the server

`src/flow.mjs` is the server-owned state machine, and it imports nothing from Express or the
Azure SDKs. It enforces verification, safety lockouts, ordered eligibility rules, explicit
read-back confirmation, idempotency and handoff redemption. The model's tools
(`src/agent.mjs`) can verify, search, hold one time and ask for a person. None of them can
book, move or cancel an appointment, take a number to transfer to, or name a Teams target.
A tool named `book`, `reschedule` or `cancel` is refused by name in `src/tools.mjs` before
anything else runs.

```
ringing → verifying → verified → offering → confirming → booked | rescheduled | cancelled
             ↘ escalating → transferred      ↑_______________|  slot_taken: fresh options
```

| Rule | Where it is enforced |
| --- | --- |
| Who the caller is | `SchedulingFlow.verifyPatient`: name and date of birth against the record, two tries, and caller ID is never proof |
| What can be booked by voice | `evaluateEligibility`: insurance, visit frequency, referral, then order. The wording and the alternatives come from `config/eligibility.json` |
| Which times are offered | `ScheduleAdapter.searchSlots`: the providers' weekly templates and clinic holidays, at least `MIN_LEAD_MINUTES` from now, `OPTIONS_PER_TURN` at a time |
| What a yes can confirm | The active proposal only: one time held for `HOLD_TTL_MS` and read back |
| The one write | `SchedulingFlow#commit`, reached only from the caller's yes (`callerSaid`) or keypad 1 (`dtmf`). It re-checks the active proposal, identity and eligibility, records the consent, and writes once, keyed to the hold |
| A time taken first | `bookAppointment` returns `slot_taken`; `#raceLost` voids the proposal, leaves that time out and offers fresh ones |
| Safety words | `classifySafety`, on every caller line before anything else |
| Whether a queue is staffed | `SchedulingRoutes.isOpen`, in the queue's own time zone and holiday list |
| Retry, divert, then admit failure | `SchedulingFlow#dispatchTransfer`: one retry, then the scheduling team, then the main number |

Because the schedule store, the audit sink, the transfer and the clock are all injected,
the whole flow is testable with plain `node --test`: no mocks of the Azure SDK, no
subscription, and the store falls back to Node's built-in `node:sqlite` when
`better-sqlite3` isn't installed.

The flow hands the model an instruction together with the exact words for it. On a real
call the model says them; in simulation the offline agent (`src/offline.mjs`) speaks them
verbatim, which is why a typed call reads like a real one without a model.

Out of hours, nobody is transferred to an empty queue. The scheduling team and the referral
coordinator file a callback when the caller's number is known, and otherwise tell the
caller when to call back. The nurse line gives the after-hours nurse number. Booking itself
doesn't depend on staffed hours.

### What Teams receives

Only **VoIP headers** are used. SIP headers are a PSTN-side mechanism and do not reach a
Teams identifier, so context sent that way would vanish silently: the caller would still be
transferred, but the scheduler would answer blind.

| Header | Contents |
| --- | --- |
| `CallDetails.SessionId` | The Auto Attendant session id when this line sits behind one, otherwise the ACS correlation id |
| `CallDetails.CallTopic` | Why the call is coming, from the destination's `topic` or `reasonTopics`, clipped to the Teams 48-character limit |
| `CallDetails.CallContext` | JSON of what has been checked, limited to the destination's `fields` allowlist: first name, how the caller was verified, the visit type, eligibility, a held time, the reason and a one-line summary |

A caller who wasn't verified carries no patient details at all: `verified` reads `no`, and
the summary says nothing was disclosed. The summary never contains a name, a date of birth
or a phone number, and a callback number is masked.

The console's **VoIP headers on the wire** panel is built on the server by the same
`buildCustomCallingContext` the transfer uses, so what it shows is what Teams receives.

Call queues are resource accounts, so they are addressed as Teams *apps*
(`{ teamsAppId }`); a destination with `"type": "user"` rings a person
(`{ microsoftTeamsUserId }`). Both take a Microsoft Entra object ID, which is why
`routing.json` holds object IDs and never phone numbers.

## Configuration

Copy `.env.example` to `.env` only to answer real calls. Everything has a working default
except the three values that make real calls possible.

| Variable | Default | Notes |
| --- | --- | --- |
| `ACS_ENDPOINT` | — | Required to answer real calls. Keyless, via `DefaultAzureCredential` |
| `ACS_CONNECTION_STRING` | — | Fallback if you can't use Entra. `ACS_ENDPOINT` wins if both are set |
| `PUBLIC_BASE_URL` | — | HTTPS URL that Event Grid and ACS can reach: the webhook, the call callbacks and the media socket |
| `VOICE_LIVE_ENDPOINT` | — | Azure AI Services resource |
| `VOICE_LIVE_API_KEY` | *(empty)* | Leave empty to use Entra, which is recommended |
| `VOICE_LIVE_MODEL` | `gpt-realtime` | |
| `VOICE_LIVE_API_VERSION` | `2026-04-10` | The WebSocket transport api-version |
| `VOICE_LIVE_VOICE` | `en-US-Ava:DragonHDLatestNeural` | Azure TTS voice; set this alongside `LOCALE` |
| `LOCALE` | `en-US` | The conversation language in the agent's instructions, and the transcription hint |
| `TEAMS_RESOURCE_ACCOUNT_ID` | — | The resource account the scheduling number is assigned to; shown on `/health` |
| `TEAMS_CLOUD` | `public` | `public`, `dod` or `gcch`, for a sovereign Teams tenant |
| `HOST`, `PORT` | `127.0.0.1`, `8100` | |
| `OPTIONS_PER_TURN` | `2` | Times read out per turn |
| `MIN_LEAD_MINUTES` | `60` | Nothing sooner is offered, so the caller can still get there |
| `SEARCH_HORIZON_DAYS` | `90` | How far ahead a search looks |
| `HOLD_TTL_MS` | `300000` | How long a time read back to the caller stays held while they decide |
| `CALL_TIME_BUDGET_MS` | `420000` | Real calls only. Past it, a person takes over |
| `TRANSFER_DELAY_MS` | `2500` | The pause between "I'm connecting you" and the transfer, so the line is heard first. `0` transfers immediately |
| `SCHEDULE_DB_PATH` | `data/schedule.db` | Created from the seed on first start. In simulation, unset or empty means an in-memory copy of the seed instead, which **Reset demo** restores |
| `SCHEDULE_SEED_PATH` | `fixtures/appointments-seed.json` | The seed a new schedule is created from |
| `HANDOFF_TOKEN_SECRET` | *(empty)* | Shared with the reminder agent, so a signed token it issued redeems here too |
| `HANDOFF_TOKEN_TTL_MS` | `300000` | The lifetime of a handoff token this store issues. Expiry is fixed when a token is issued, so the reminder agent's own setting governs the tokens it sends |
| `DB_PATH` | `data/scheduling-audit.db` | The audit: calls, decisions and events |
| `TRANSCRIPT_RETENTION` | `false` | Decisions are always stored; what callers said is not, unless you set this |
| `DEMO_NOW` | `2026-05-19T09:50:00-07:00` | Simulation only. Pins the clock the schedule sees, so every run offers the same times; empty uses the real time. Ignored on real calls |

Runtime SQLite files are created under `data/` and are intentionally gitignored. A relative
path you set yourself is resolved from the directory you start the server in.

Until all three call settings are in place (`ACS_ENDPOINT` or `ACS_CONNECTION_STRING`,
`PUBLIC_BASE_URL` and `VOICE_LIVE_ENDPOINT`), the server runs in simulation mode and the
console drives simulated calls. `GET /health` breaks readiness out per subsystem, because
"not ready" is rarely uniform: Voice Live can be configured while ACS is not, and both can
be configured while `routing.json` still holds the placeholder object IDs.

```jsonc
{
  "mode": "simulation",
  "missingConfig": ["ACS_ENDPOINT", "PUBLIC_BASE_URL", "VOICE_LIVE_ENDPOINT"],
  "voiceLive": { "ready": false, "auth": "entra", "model": "gpt-realtime", "apiVersion": "2026-04-10" },
  "telephony": { "ready": false, "auth": "none", "missing": ["ACS_ENDPOINT", "PUBLIC_BASE_URL"] },
  "teams":     { "ready": false, "unprovisionedDestinations": ["scheduling_team", "nurse_line", "referral_coordinator"] },
  "schedule":  { "dbPath": ":memory: (a fresh copy of the seeded schedule)", "sharedWithReminder": false, "reseededByReset": true },
  "clock":     { "preset": "tue-morning", "now": "2026-05-19T16:50:00.000Z" }
}
```

The `teams` line answers "why did my transfer fail?" before anyone has to read a log.

### Keyless auth

Both Azure connections default to Entra, so no key needs to live on disk.

**ACS.** Set `ACS_ENDPOINT` and leave `ACS_CONNECTION_STRING` unset. The signed-in identity
needs **Communication and Email Service Owner** on the ACS resource. Locally that identity
comes from `az login`; in Azure, use a managed identity.

**Voice Live.** Assign the same identity both roles on the AI Services resource:

- **Cognitive Services User**
- **Foundry User**

The server then acquires a token for the `https://ai.azure.com/.default` scope through
`DefaultAzureCredential`. Setting `VOICE_LIVE_API_KEY` overrides this.

### Handoff destinations

`config/routing.json` is the whole handoff policy. The model names a destination id
(`scheduling_team`, `nurse_line` or `referral_coordinator`); the server resolves it, checks
the hours and builds the context.

```jsonc
"scheduling_team": {
  "label": "Scheduling team",
  "type": "callQueue",                              // or "user" to ring a person
  "target": "00000000-0000-0000-0000-000000000001", // a Teams object ID; the model never sees it
  "topic": "Scheduling – caller request",
  "reasonTopics": { "verification_failed": "Scheduling – identity not confirmed", … },
  "hours": { "timeZone": "America/Los_Angeles", "days": [1, 2, 3, 4, 5], "open": "07:00", "close": "18:00", "closed": ["2026-05-25"] },
  "afterHoursLine": "Our scheduling team is closed right now, so I've asked them to call you back when they open.",
  "fields": ["firstName", "verified", "visitType", "eligibility", "heldSlot", "reason", "summary"] // the context allowlist
}
```

The shipped object IDs are placeholders, and `/health` lists every destination still using
one. `"afterHours": "advise"`, as on the nurse line, reads the after-hours line instead of
filing a callback. There is no local override file, so edit `routing.json` in place and
keep your tenant's object IDs out of a public repository.

The eligibility wording is config too: `config/eligibility.json`, with the visit types,
providers, clinics, referrals, orders, prep notes and safety words beside it in `config/`.

### Shared schedule and the reminder handoff

`fixtures/appointments-seed.json` and the adapter schema are shared with the appointment
reminder sample; this sample adds the `holds`, `waitlist` and `appointment_reasons` tables.
Set both samples to the same `SCHEDULE_DB_PATH` to demo a reminder-to-scheduling transfer.
`/health` reports `sharedWithReminder: true` when the path points into the reminder
sample's folder.

A caller the reminder agent transfers here carries a one-time token (`patientRef` in
`CallDetails.CallContext`) instead of repeating a date of birth. Handoff tokens in
`handoff_tokens` are single-use, time-limited, and bound to the call/session correlation
ID. A token signed with `HANDOFF_TOKEN_SECRET` by a process that doesn't share the database
is checked for its signature, expiry and correlation ID, but it isn't recorded, so it isn't
single-use: prefer the shared database. A token that doesn't redeem falls back to name and
date of birth.

## Connecting it to a real phone number

Inbound uses **Teams Phone extensibility**: the caller dials a Teams service number on a
resource account, Teams routes the call to your linked ACS resource, and this sample
answers it with Call Automation.

```
PSTN caller → Teams service number → Teams resource account → linked ACS resource
            → Microsoft.Communication.IncomingCall (Event Grid) → this sample
```

> **The number is the part that trips people up.** Teams Phone extensibility requires a
> Teams *service* number, from Microsoft Calling Plan, Operator Connect, or Direct Routing.
> **A phone number purchased in Azure Communication Services cannot be assigned to a Teams
> resource account**: there is no cmdlet or portal path that converts one. Acquiring a
> Microsoft number also needs at least one Calling Plan license in the tenant, and
> toll-free needs funded pay-as-you-go billing. The free `PHONESYSTEM_VIRTUALUSER` license
> is right for the resource account itself but does not let you acquire a number.
>
> If you only hold an ACS number you can still exercise the whole state machine: calls to
> it reach this sample as ordinary Call Automation calls. They arrive without the Teams
> resource account identity, and the server logs them as `acs-direct` rather than
> `teams-phone-extensibility`, so the difference is never silent.

1. **Provision.** An ACS resource, an Azure AI Services resource, and a Teams tenant with a
   service number on a resource account.
2. **Register a calling bot** and create the resource account against its application ID,
   so the account is yours rather than a first-party Auto Attendant.
3. **Bind the resource account to ACS.** `Set-CsOnlineApplicationInstance -AcsResourceId
   <immutable GUID>`, then `Sync-CsOnlineApplicationInstance`. This is *not*
   `Set-CsTeamsAcsFederationConfiguration`, which governs a different feature (ACS users
   talking to Teams users) and does nothing for phone extensibility. See
   [`scripts/provision-teams-phone.ps1`](scripts/provision-teams-phone.ps1), which also
   prints the resource account's object ID for `TEAMS_RESOURCE_ACCOUNT_ID`.
4. **Grant ACS server consent** for that resource account through the `teamsExtension`
   assignment API. The Teams-side binding alone is only half of it.
5. **Collect object IDs.** Put the Entra object ID of the scheduling team's, the nurse
   line's and the referral coordinator's call queue resource accounts in `routing.json`;
   the script reads them back. These are the *transfer targets*, separate from the inbound
   resource account. If your tenant has no call queues yet, a `"type": "user"` target
   pointing at any Teams user with Enterprise Voice is enough to see a transfer.
6. **Expose this server.** `npm run tunnel`, then set `PUBLIC_BASE_URL`.
7. **Subscribe to `IncomingCall`.** Create an Event Grid system topic on the ACS resource
   with a webhook subscription to `<PUBLIC_BASE_URL>/api/events`, filtered to
   `Microsoft.Communication.IncomingCall`. The server answers the validation handshake
   automatically. Set the Azure Bot calling webhook to `https://eventgrid.azure.net`.
8. **Check `/health`,** then call the number.

With the call settings in place the server answers real calls: it schedules on the real
time, uses the schedule file rather than the in-memory demo copy, and refuses simulated
calls and every demo control. To rehearse next to it, start a simulation copy on another
port, as [DEMO-SCRIPT.md](DEMO-SCRIPT.md) shows.

## FHIR R4 adapter mapping (documentation only)

A production adapter should implement the same interface as `ScheduleAdapter`:

- `searchSlots` → FHIR `Slot` search joined to `Schedule.actor` (`Practitioner`/`Location`), filtered by visit type, role, location, and horizon.
- `holdSlot` → scheduling-system hold or tentative `Appointment` with expiration metadata; conflicts must map to `slot_taken`.
- `bookAppointment` → confirmed `Appointment` create/update from the held slot.
- `rescheduleAppointment` → transaction/bundle that books the new appointment before cancelling the old one.
- `cancelAppointment` → `Appointment.status=cancelled` plus cancellation reason.
- `addWaitlist` → local request queue or FHIR `Appointment`/`Task` depending on the scheduling system.

Whatever the system, a time that is gone must come back as `slot_taken`, and a hold must
never book any time but its own. This sample intentionally does not implement a live FHIR
client.

## Project layout

```
src/
  flow.mjs            the state machine: every check, proposal, refusal and write. No Express
                      or Azure SDK imports
  schedule-store.mjs  the schedule (SQLite): slot search, five-minute holds, booking, atomic
                      rescheduling, cancellation, waitlist, handoff tokens, the console's
                      grid and stats, reseed, and the demo's take-slot
  tools.mjs           the only path from a model tool call to the flow
  agent.mjs           the tool schema and the standing instructions given to the model
  routes.mjs          handoff destinations, opening hours and the context allowlist
  handoff.mjs         destination → Teams identifier, context → VoIP headers
  offline.mjs         the simulated agent and the offline CLI; its SCRIPTS mirror the beats
  config.mjs          env vars, config files, clock presets and /health readiness
  sqlite.mjs          better-sqlite3 when it loads, node:sqlite otherwise
  audit.mjs           in-memory audit sink (the interface the flow depends on)
  db.mjs              the SQLite implementation of that same interface
  realtime.mjs        WebSocket hub that pushes state to the console
  server.mjs          Event Grid intake, ACS callbacks, simulation API, demo controls, stats, health
  voice/              used only when live configuration is present
    voice-live.mjs    the Voice Live WebSocket session
    acs.mjs           answer, transfer, DTMF, hang up
    call-bridge.mjs   binds one call to one Voice Live session
config/               policy as data: visit types, eligibility wording, providers, clinics,
                      referrals, orders, prep notes, safety words, routing
fixtures/
  appointments-seed.json  the seeded schedule, shared with the appointment reminder sample
public/               the presenter console
  app.js              the panels: call, booking decision, Teams toast, availability, trail, metrics
  beats.js            the scripted demo and its narration: edit this to adapt the demo
  presenter-kit.*     shared console building blocks, vendored: edit scripts/presenter-kit/
                      at the repository root, then run `node scripts/sync-presenter-kit.js`
scripts/
  smoke-websockets.mjs     boots a server on port 8200 and checks the WebSocket upgrades
                           and the demo controls
  rehearse.mjs             plays every beat as the console does; pins what each one shows
  presenter-kit-rehearsal.mjs  the rehearsal engine, vendored like presenter-kit.*
  provision-teams-phone.ps1  the Teams side of Teams Phone extensibility
test/                 54 cases on harness.mjs, no Azure required
AGENTS.md             guidance for coding agents that change this sample
DEMO-SCRIPT.md        the presenter's running order
```

`flow.mjs`, `schedule-store.mjs`, `tools.mjs`, `agent.mjs`, `routes.mjs`, `handoff.mjs`,
`offline.mjs`, `audit.mjs`, `sqlite.mjs` and `config.mjs` import no npm package statically:
`dotenv` and `better-sqlite3` are loaded only if they are installed. That is deliberate:
the parts you most need to read and trust are the parts that run without installing
anything.

## Operational notes

- **Event Grid delivers duplicates by design.** The server de-duplicates on event id
  before answering, so a redelivery does not answer the same call twice.
- **The keypad is always on but never announced.** Continuous DTMF recognition starts on
  `CallConnected`: 1 and 2 answer the active proposal, and 0 asks for a person at any
  point.
- **The server takes the caller's turn when it has to.** A yes, a no or a safety word is
  handled before the model acts on the line; the bridge sends `StopAudio` to ACS and
  `response.cancel` to Voice Live, so the server's line isn't talked over.
- **Barge-in** works the same way: when the caller starts speaking, the agent stops
  mid-word rather than talking over them.
- **The transfer is blind.** The agent's job ends once the context is delivered.
- **`CallTransferFailed` re-enters the flow's own retry ladder** rather than starting a
  second, competing recovery path.
- **Voice Live allows one in-flight response.** A server line and a tool result can both
  want the agent to speak, so requests are coalesced in `voice-live.mjs`.
- **A held time expires.** If the caller takes longer than `HOLD_TTL_MS` to say yes, the
  write is refused and fresh times are offered, just as after `slot_taken`.

## Security notes before production

- **Caller ID is not authentication.** A matching number neither verifies the caller nor
  personalizes the greeting. A failed check reads the same whether or not the patient
  exists, and after two misses the call is handed off without disclosing anything.
- **The model cannot book or pick a transfer target.** It has no booking tool, and it
  names a destination id from an allowlist; the server resolves the Teams target. Keep it
  that way: a tool that books on the model's say-so, or transfers to a number the model
  supplies, turns a prompt injection into a booking or a toll-fraud vector.
- **Keep the write behind the caller's own yes.** `#commit` is the only write path; review
  any change that adds another caller of `bookAppointment`, `rescheduleAppointment` or
  `cancelAppointment`.
- **Transcripts are off by default.** Decisions and events are persisted because they are
  the audit trail; what callers said reaches disk only if you set `TRANSCRIPT_RETENTION`.
  Dates of birth and phone numbers are masked before a caller line is kept.
- **Disclose the assistant.** The opening line says it is automated. Several jurisdictions
  require this; all callers deserve it.
- **Phone numbers are masked** in the console, the audit database, the handoff context and
  the logs.
- **A signed reminder token is not single-use.** Prefer the shared schedule database, which
  records every redemption.
- **The demo controls write to the schedule.** They are off whenever the call settings are
  present; don't expose a simulation-mode server beyond your own machine.
- The seeded patients, providers, schedule and object IDs are fictional placeholders.
  Replace them.

## Microsoft references

- [Teams Phone extensibility overview](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-overview)
- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [How to use the Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to)
- [Call Automation overview](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation)
- [Passing contextual data with custom headers](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/custom-context)
- [Teams interop with Call Automation](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/teams-interop-call-automation)
- [Bidirectional media streaming](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/audio-streaming-quickstart)
