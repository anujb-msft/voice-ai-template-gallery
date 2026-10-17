# Appointment Reminder Agent

An outbound reminder call from a clinic. Two days before an appointment the agent calls
the patient, says it is an automated assistant, and checks a date of birth before it
says anything about the visit. Then the patient can confirm, cancel, or ask for a new
time, and the clinic's schedule changes while they are still on the line.

The point is not that a model can hold a phone conversation. It is everything around
that: who may be called and when, what may be said before the right person is on the
line, what a voicemail or a family member may hear, and the fact that the agent never
books a new time itself. A request for a new time goes to a person at the scheduling
desk, with the context already on their screen.

Built on [Azure Communication Services Call Automation](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation),
which places the call from an ACS phone number, and the
[Azure AI Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live),
which listens and speaks. Teams comes in at the handoff: a request for a new time
transfers to the scheduling desk in Teams, and with Teams Phone extensibility a patient
who calls the clinic's Teams Phone number back can reach the same agent.

> Illustrative sample. Contoso Health, its clinics, patients, appointments and phone
> numbers are fictional, and nothing here is legal or clinical advice. Read
> [Security notes before production](#security-notes-before-production) before pointing
> this at a real phone number.

## What the demo shows

- **Identity first, then the minimum necessary.** The agent asks for the patient by
  first name, then for a date of birth. Until the *server* has matched it to the record,
  the call contains no department, provider, time or place. A spouse on the patient's
  list of proxies still has to give the patient's date of birth.
- **The server decides who may be called, and when.** Consent, preferred channel,
  opt-out, TTY, calling hours in the patient's own time zone, the reminder window, the
  24-hour cutoff, holidays, attempts and spacing are all checked before anything is
  dialed. A refused call shows the rule, and for a time rule the patient's local time
  and the next allowed time. A demo clock lets one server show both sides.
- **The schedule changes during the call.** A confirmation is written only after an
  explicit yes. A cancellation is read back first; then the slot is released and the
  console's schedule panel shows it free again.
- **The agent never books.** "Can I come next week instead?" goes to a person at the
  scheduling desk, with the appointment, `verified: true` and a single-use patient
  reference in VoIP headers. The console shows the literal headers next to a mock Teams
  incoming-call toast.
- **Voicemail and family hear a callback request, nothing more.** When someone else
  answers, or voicemail picks up on the last attempt, they hear the clinic's name, the
  patient's first name, that it is an appointment reminder, and a callback number — no
  department, provider, date or time. Earlier attempts leave no message.
- **Honest failure, never a loop.** Two date-of-birth misses, silence, the call's time
  limit, or a transfer nobody answers each end with the clinic's number or a saved
  callback request. A medical question gets the nurse line, never advice.

## Quick start

Runs with no Azure subscription at all. You need Node.js 22.13 or later.

```bash
npm install
npm start
# open http://127.0.0.1:8099
```

The console runs a scripted demo: press **→** (or **Next ▶**) and it plays six short
beats, placing the reminder call and typing the patient's lines. Switch **Voice off** to
**Speak agent + caller** to hear both sides in the browser's own speech.
[DEMO-SCRIPT.md](DEMO-SCRIPT.md) is the running order, with what to say at each step, and
`npm run rehearse` plays it end to end before you do.

Or drive it yourself: pick a **Patient to remind**, choose **Who picks up** and a
**Language**, press **Place the call**, and type what the patient says. The on-screen
keypad, **Silence** and **Hang up** work too, and the preset buttons on the demo clock at
the top move the time the dial policy sees. A typed transcript drives *the same state
machine* a real call would: the same dial gates, the same identity check, the same
schedule writes and the same handoff assembly. Only the model and the audio path are
stubbed.

Try these with **Who picks up** on **A person** and **Language** on **English** (Jordan
and Camila prefer Spanish). Press **Reset demo** before each row: a confirmed
appointment is not called again.

| Patient to remind | Type this | What you should see |
| --- | --- | --- |
| Jordan R. | `Yes, this is Jordan.` → `March 12th, 1984.` → `Yes, I'll be there.` | The details only after the date of birth matches, then confirmed with the fasting reminder |
| Jordan R. | `This is Alex, Jordan's husband.` → `March 12th, 1984.` → `Yes, we'll be there.` | An authorized proxy still gives Jordan's date of birth first, then confirmed |
| Jordan R. | `Yes, this is Jordan.`, then keypad `0` `3` `1` `2` `1` `9` `8` `4`, then keypad `1` | The date of birth keyed in, then confirmed from the keypad |
| Jordan R. | `Yes, this is Jordan.` → `January 1st, 1990.` → `January 1st, 1990.` | Not verified: the clinic's number, and nothing about the appointment |
| Jordan R. | `Yes, this is Jordan.` → `March 12th, 1984.` → `I have a fever, should I still come?` → `Yes.` | No medical advice; the nurse line is offered, and `Yes.` connects it |
| Avery S. | `Please stop calling me.` | Opted out before the call ends; the next **Place the call** for Avery is not placed |
| Camila L., with **Who picks up** on **Voicemail · last attempt** | — | A callback request only: no department, provider or time |
| Noah M. (A-20425), after pressing **Too late to call · 8:30 PM** on the demo clock | — | Not placed: the calling hours, Noah's local time and the next allowed time |

Run the tests — they need no Azure and no network:

```bash
npm test          # 52 cases: the flow, the schedule store, the campaign and handoff, the audit, the offline harness
npm run check     # syntax-checks the source, scripts, tests and console
npm run smoke     # boots its own simulation server on port 8199 and checks both WebSockets and the demo controls
npm run rehearse  # plays the six beats on port 8299 as the console does, three ways (~1 min)
npm run offline   # one reminder call in the terminal, on an in-memory schedule: Jordan confirms A-20418
```

`node src/offline.mjs --transcript cancel` (or `reschedule`, `wrong-party`, `voicemail`,
`optout`) runs the other scripted calls the same way, and `--at <ISO 8601>` pins the
clock.

`npm run rehearse` fails if a beat would land anywhere [DEMO-SCRIPT.md](DEMO-SCRIPT.md)
doesn't say: each beat's outcome and decision trail is pinned in `scripts/rehearse.mjs`, and
so are the metrics it ends on. It plays the script in order, again after a reset, and last
beat first with each beat twice, at Auto-play's pace and at full speed, and checks that a
live server refuses the demo controls. Neither `.env` nor your shell's settings reach its
server. Changed a beat on purpose? It prints the outcomes it reached, ready to paste over the
pins once you've checked them against the script.

### Demo controls

In simulation mode the console can move the clock the dial policy sees, so one running
server shows both a call that may go out and one that may not:

| Endpoint | What it does |
| --- | --- |
| `GET /api/demo/clock` | The demo clock, its time zone and the presets |
| `POST /api/demo/clock` | `{ "preset": "two-days-before" \| "day-before" \| "too-late" \| "real" }` or `{ "at": "<ISO 8601>" }` |
| `POST /api/demo/reset` | Forget the simulated calls, clear them from the audit, reseed the schedule and restore the starting clock |
| `POST /api/demo/restore` | `{ "appointmentIds": ["A-20418"] }` puts those appointments back as the seed has them, opt-out included. Each beat calls it first |
| `GET /api/stats` | The metrics strip: calls placed, patients reached, confirmed, cancelled, reschedules handed off, privacy-safe voicemails, callback only, not placed |
| `GET /api/schedule` | The schedule panel: every upcoming appointment with whether it may be called now and why, freed slots and reschedule requests |
| `GET /api/campaign/dry-run` | The dial plan on the demo clock: who is due, and why anyone is skipped. Nothing is dialed |

The `POST`s, like `POST /api/simulate`, return `403` while the server places real calls:
a real call always decides on the real time, and a reset never deletes a real call's
audit record. **Reset demo** reseeds whichever schedule database the server is using, so
present from a server with its own (DEMO-SCRIPT.md shows how). `DEMO_NOW` sets the
starting clock; it defaults to two days before the seeded appointments at 10:00 AM
Pacific, and an empty value means real time.

## How it works

```
POST /api/campaign/run   (CAMPAIGN_ENABLED=true and CAMPAIGN_DRY_RUN=false)
   │  every dial gate first; a refused patient is never dialed
   ▼
ACS Call Automation ──── createCall from ACS_CALLER_ID ────► the patient's phone
   │
   │  bidirectional media streaming over /ws/media: PCM16 24 kHz mono (pcm24KMono)
   ▼
this server ◄──── WebSocket, the same PCM16 both ways ────► Voice Live (gpt-realtime)
   │
   │  confirm_identity / check_dob / confirm_appointment / request_reschedule / …
   ▼
AppointmentReminderFlow ──── confirm, cancel, opt-out ────► the schedule (SQLite)
   │
   └── TransferCallToParticipant + VoIP custom context ────► scheduling desk (Teams user)
```

A patient who calls the number back arrives as an Event Grid
`Microsoft.Communication.IncomingCall` event. The server answers only when the number
belongs to a patient with an upcoming appointment, and the call starts at the same
identity check.

### The decision lives on the server

`src/flow.mjs` owns every decision that matters and imports nothing from Azure, Express
or SQLite. The model is the voice. Its 11 tools pass along what the patient said — a
yes, a date of birth, a reason — and none of them takes a phone number, a Teams ID, a
time or a slot, so it cannot dial anyone, transfer anywhere or book anything.

```
checking ──→ not_placed                       a dial gate said no: the reason and the next allowed time
   ↓
dialing ───→ retry_scheduled                  busy or no answer
   ↓
detecting ─→ voicemail ─→ retry_scheduled     not the last attempt: no message
   ↓                    ─→ ended              the last attempt: a callback request, nothing else
greeting ──→ ended                            someone else answered: a callback request
   ↓
verifying ─→ ended                            two date-of-birth misses: the clinic's number
   ↓
presenting ─→ confirmed                       after an explicit yes
            ─→ cancel_confirm ─→ cancelled    read back first, then the slot is released
            ─→ transferring                   a new time goes to the scheduling desk
```

| Rule | Where it is enforced |
| --- | --- |
| Who may be called, and when | `evaluateDialEligibility`: consent, channel, opt-out, TTY, a valid number, the test allowlist (real calls), the appointment's status, an open reschedule request, a call already in progress (real calls), holidays, calling hours, the cutoff, the reminder window, attempts and spacing, in that order |
| The window, the hours, the attempts | `config/campaign.json` |
| Nothing about the appointment before verification | `checkDob`, and `#guard`, which every appointment tool goes through |
| A schedule change needs a clear yes | `confirmAppointment`; `proposeCancel` reads back, then `cancelAppointment` |
| The agent never books | `requestReschedule`: a handoff to the scheduling desk, or a callback request when no desk is configured |
| What a voicemail may hear | `handleVoicemail`: a message on the last attempt only, and only a callback request |
| Emergencies and opt-outs come first | `screen`, on every patient turn |
| How long a call may take | `checkBudget`, on each patient turn: `CALL_TIME_BUDGET_MS`, default 240 s, with a wrap-up 40 s before the end |
| A transfer nobody answers | `transferFailed`: one honest line, then the call ends; the transfer is never retried |

Because the schedule, the audit sink, the transfer function and the clock are all
injected, the whole flow is testable with plain `node --test`: no mocks of the Azure
SDK, no subscription, and the tests pass before `npm install` has run.

In simulation mode `handleUtterance`, also in `flow.mjs`, stands in for the model: a
deterministic, phrase-based reading of the patient's line that calls the same flow
methods the model's tools call. That is why a scripted run produces the same
conversation every time. Every line the server owns — the opening, the date-of-birth
request, the voicemail message, the failures — comes from `config/scripts.json`. On a
real call each line reaches the model as its next instruction, and the standing
instructions tell it not to improvise the voicemail, wrong-party, opt-out, emergency and
verification-failure wording.

### What Teams receives

Only **VoIP headers** are used. SIP headers are a PSTN-side mechanism and do not reach a
Teams identifier, so context sent that way would vanish silently — the patient would
still be transferred, but the scheduler would pick up blind.

| Header | Contents |
| --- | --- |
| `CallDetails.SessionId` | The reminder call's id. For a callback, the Auto Attendant session id when the number sits behind one, otherwise the ACS correlation id |
| `CallDetails.CallTopic` | `Reschedule – <department> <appointment id>`, clipped to the Teams 48-character limit |
| `CallDetails.CallContext` | `{ "intent": "reschedule", "appointmentId", "patientRef", "verified": true, "sessionId" }` |

`patientRef` is not a patient id. It is a single-use reference that expires after five
minutes (`HANDOFF_TOKEN_TTL_MS`), issued by `src/schedule-store.mjs` and signed with
HMAC when `HANDOFF_TOKEN_SECRET` is set. The same file's `redeemHandoffToken` shows how
a desk tool would exchange it, once, for the appointment; this sample exposes no
endpoint for that. No date of birth or phone number travels in the headers.

The console's **VoIP headers on the wire** panel is built on the server by the same
`buildCustomCallingContext` the transfer uses, so what it shows is what Teams receives.

The scheduling desk is a Teams *user*, addressed as `{ microsoftTeamsUserId }` with
their Microsoft Entra object ID. A `+E.164` target is transferred as a phone number
instead, still with VoIP headers, which are meant for VoIP participants; check on a
test call that your route accepts them. Set the desk in `config/routing.json` or with
`SCHEDULING_AGENT_TARGET`. Transferring to a Teams user needs a voice-enabled user with
a Teams Phone license, and a Teams administrator has to allow your ACS resource with
`Set-CsTeamsAcsFederationConfiguration`. See
[Teams interop with Call Automation](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/teams-interop-call-automation).

## Configuration

Copy `.env.example` to `.env`. Everything has a working default; with the four call
settings empty the server runs in simulation mode.

| Variable | Default | Notes |
| --- | --- | --- |
| `ACS_ENDPOINT` | — | Required to place real calls. Keyless, via `DefaultAzureCredential` |
| `ACS_CONNECTION_STRING` | — | Fallback if you cannot use Entra. `ACS_ENDPOINT` wins if both are set |
| `ACS_CALLER_ID` | — | The ACS phone number reminder calls come from, in E.164 |
| `PUBLIC_BASE_URL` | — | Must be reachable by ACS and Event Grid |
| `VOICE_LIVE_ENDPOINT` | — | Azure AI Services resource |
| `VOICE_LIVE_API_KEY` | *(empty)* | Leave empty to use Entra, which is recommended |
| `VOICE_LIVE_MODEL` | `gpt-realtime` | |
| `VOICE_LIVE_API_VERSION` | `2026-04-10` | WebSocket transport API version |
| `VOICE_LIVE_VOICE` | `en-US-Ava:DragonHDLatestNeural` | One voice for every call. Each call's language comes from the patient's record, so pick a voice that also speaks Spanish if you call Spanish-speaking patients |
| `SCHEDULING_AGENT_TARGET` | *(empty)* | The scheduling desk: a Teams user's Entra object ID, or `+E.164`. Overrides `config/routing.json`. Empty turns a request for a new time on a real call into a callback request; the simulation always shows the handoff |
| `CAMPAIGN_ENABLED` | `false` | Real dialing needs this `true`… |
| `CAMPAIGN_DRY_RUN` | `true` | …and this `false`. Anything less returns the dial plan and dials nobody |
| `CAMPAIGN_MAX_CONCURRENT` | `2` | Reminder calls in flight at once |
| `ALLOWED_TEST_NUMBERS` | *(empty)* | Comma-separated E.164 numbers. When set, a real campaign run dials only these; empty filters nothing |
| `CALL_TIME_BUDGET_MS` | `240000` | From answer to goodbye; the agent wraps up 40 s before the end |
| `VOICEMAIL_GREETING_MS` | `4500` | A simulated greeting at least this long counts as voicemail. A real call is judged on its first words |
| `SCHEDULE_DB_PATH` | `data/schedule.db` | `:memory:` for a throwaway schedule. The defaults sit in this folder; a relative path you set is relative to where you start the server |
| `SCHEDULE_SEED_PATH` | `fixtures/appointments-seed.json` | Loaded into an empty schedule, and again by **Reset demo** |
| `AUDIT_DB_PATH` | `data/reminder-audit.db` | Calls, decisions and outcomes |
| `HANDOFF_TOKEN_SECRET` | *(empty)* | Signs `patientRef` with HMAC. Empty means a random token that only this schedule database can redeem |
| `HANDOFF_TOKEN_TTL_MS` | `300000` | How long a `patientRef` can be redeemed |
| `TRANSCRIPT_RETENTION` | `false` | Decisions and outcomes are always stored; utterance text only if you turn this on |
| `TRANSCRIPT_RETENTION_DAYS` | `7` | Not enforced yet: nothing purges old transcripts |
| `DEMO_NOW` | `2026-05-19T10:00:00-07:00` | Simulation only. The demo clock's starting time; empty means real time. Ignored on real calls |
| `TEAMS_RESOURCE_ACCOUNT_ID` | *(empty)* | Informational: shown in `/health` |
| `HOST`, `PORT` | `127.0.0.1`, `8099` | |

With any of the four call settings unset (`ACS_ENDPOINT` or `ACS_CONNECTION_STRING`,
`ACS_CALLER_ID`, `PUBLIC_BASE_URL`, `VOICE_LIVE_ENDPOINT`) the server logs
`SIMULATION MODE` and runs the offline console. `GET /health` breaks readiness out per
subsystem, because "not ready" is rarely uniform:

```jsonc
// excerpt
{
  "mode": "simulation",
  "missingConfig": ["ACS_ENDPOINT", "ACS_CALLER_ID", "PUBLIC_BASE_URL", "VOICE_LIVE_ENDPOINT"],
  "voiceLive": { "ready": false, "auth": "entra", "model": "gpt-realtime" },
  "acs": { "ready": false, "auth": "none", "callerIdConfigured": false },
  "campaignEnabled": false,
  "campaignDryRun": true,
  "schedulingAgentTarget": null,
  "schedule": { "driver": "better-sqlite3", "inMemory": false },
  "clock": { "preset": "two-days-before", "timeZone": "America/Los_Angeles" }
}
```

`"schedulingAgentTarget": null` answers "why did a request for a new time become a
callback?" before anyone has to read a log.

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

Changing who is called, when, and what is said is a config change, not a prompt rewrite.

| File | What it controls |
| --- | --- |
| `config/campaign.json` | The reminder window (calls start 52 hours before the appointment), calling hours (8:00 AM–8:00 PM in the patient's time zone), three attempts at least four hours apart, the 24-hour cutoff, and voicemail on the last attempt only |
| `config/clinics.json` | Each clinic's time zone, callback number, front-desk and nurse-line numbers and hours, after-hours nurse advice number, holidays, and late-cancellation wording |
| `config/scripts.json` | Every line the server owns, in English and Spanish |
| `config/routing.json` | The scheduling desk, the front desk and the nurse line |
| `config/prep.json` | Preparation reminders, such as fasting or bringing a medication list |
| `config/detection.json` | Voicemail phrases and beep tokens, emergency phrases and clinical-question phrases |

## Connecting it to a real phone number

Reminder calls go **out** from an Azure Communication Services phone number, with Call
Automation's `createCall`. Teams comes in at the handoff — the scheduling desk that takes
a request for a new time is a Teams user — and, optionally, for callbacks: with Teams
Phone extensibility, a patient who calls the clinic's Teams Phone number reaches your
ACS resource, and this server, too.

```
campaign run → createCall (from ACS_CALLER_ID) → the patient's phone
new time     → TransferCallToParticipant + VoIP headers → scheduling desk (Teams user)
callback     → ACS number, or Teams service number → resource account → linked ACS resource
             → Microsoft.Communication.IncomingCall (Event Grid) → /api/events
```

1. **Provision.** An ACS resource with a phone number that can place outbound calls,
   and an Azure AI Services resource in a region that serves the Voice Live model. Set
   `ACS_ENDPOINT`, `ACS_CALLER_ID` and `VOICE_LIVE_ENDPOINT`.
2. **Expose this server.** `npm run tunnel`, then set `PUBLIC_BASE_URL`. ACS posts call
   events to `<PUBLIC_BASE_URL>/api/calls/callback` and streams audio to `/ws/media`.
3. **Choose the scheduling desk.** A voice-enabled Teams user with a Teams Phone
   license. Put their Entra object ID in `SCHEDULING_AGENT_TARGET`, and have a Teams
   administrator allow your ACS resource with `Set-CsTeamsAcsFederationConfiguration`.
   Leave it empty and a request for a new time becomes a callback request.
4. **Take callbacks (optional).** Create an Event Grid system topic on the ACS resource
   with a webhook subscription to `<PUBLIC_BASE_URL>/api/events`, filtered to
   `Microsoft.Communication.IncomingCall`. The server answers the validation handshake
   itself. For callbacks on a Teams Phone number, link a Teams resource account to the
   ACS resource; see the
   [Teams Phone extensibility overview](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-overview).
   `scripts/provision-teams-phone.ps1` only prints a pointer to these steps.
5. **Use test patients.** A real server decides on the real clock, and the seeded
   appointments are in May 2026. Edit `fixtures/appointments-seed.json` so a test
   appointment is about two days away and the phone numbers are your own, then delete
   `data/schedule.db` so it reseeds. List the same phones in `ALLOWED_TEST_NUMBERS`.
6. **Check `/health`:** `"mode": "live"` and `"callReady": true`.
7. **Run the campaign.** Set `CAMPAIGN_ENABLED=true` and `CAMPAIGN_DRY_RUN=false`,
   restart, and `POST /api/campaign/run`. No scheduler is included: call it from your
   own job at the time you choose.

### Live call test matrix

These exercise the common paths on a real call. The model's wording can vary; the dial
gates, the identity check, the schedule writes and the handoff are deterministic.

| Flow | Say or do | Expected behavior |
| --- | --- | --- |
| Confirm | `Yes, this is <first name>` → the date of birth on file → `Yes, I'll be there` | No details until the date of birth matches; then the appointment is confirmed |
| Cancel | After verification, `I need to cancel` → `Yes` | A read-back first; then cancelled and the slot released |
| New time | After verification, `Can I come next week instead?` | Transfers to the scheduling desk; Teams shows `Reschedule – <department> <id>` |
| Someone else | `No, this is her sister` | A callback request only |
| Keypad | Key the date of birth as MMDDYYYY, then `1` | Verified, then confirmed |
| Voicemail | Let the call go to voicemail | No message before the last attempt; on the last attempt, a callback request only |
| Calling hours | `POST /api/campaign/run` outside 8:00 AM–8:00 PM in the patient's time zone | Nobody is dialed; the dial plan shows the reason and the next allowed time |
| Transfer failed | Ask for a new time while nobody at the desk answers | ACS posts `CallTransferFailed`; the agent apologizes once, says the request is saved, and ends the call. It is not counted as a handoff |

## Project layout

```
src/
  flow.mjs            the state machine: dial gates, identity, schedule decisions, handoff —
                      no Azure, Express or SQLite imports
  schedule-store.mjs  the schedule: SQLite tables, the seed, idempotent writes, handoff tokens
  handoff.mjs         reschedule context → VoIP headers
  agent.mjs           the tool schema and standing instructions given to the model
  offline.mjs         the simulated phone, and the terminal run behind `npm run offline`
  audit.mjs           in-memory audit sink and metrics (the interface the flow depends on)
  db.mjs              the SQLite implementation of that same interface
  config.mjs          environment variables and the policy files
  realtime.mjs        WebSocket hub that pushes state to the console
  server.mjs          campaign run, Event Grid intake, ACS callbacks, simulation API, demo controls
  voice/
    voice-live.mjs    the Voice Live WebSocket session
    acs.mjs           place, answer, transfer, DTMF, hang up
    call-bridge.mjs   binds one call to one Voice Live session
config/               the policy files
fixtures/
  appointments-seed.json  fictional patients, providers and appointments
public/               the presenter console
  app.js              the panels: call, decision, schedule, Teams toast, headers, trail, metrics
  beats.js            the scripted demo and its narration — edit this to adapt the demo
  presenter-kit.*     shared console building blocks, vendored: edit scripts/presenter-kit/
                      at the repository root, then run `node scripts/sync-presenter-kit.js`
scripts/
  smoke-websockets.mjs       boots a simulation server and checks the WebSockets and demo controls
  rehearse.mjs               plays every beat as the console does; pins what each one shows
  presenter-kit-rehearsal.mjs  the rehearsal engine, vendored like presenter-kit.*
  provision-teams-phone.ps1  notes only: points back to this README
test/                 52 cases, no Azure required
```

`flow.mjs`, `schedule-store.mjs`, `handoff.mjs`, `agent.mjs`, `offline.mjs`, `audit.mjs`
and `config.mjs` import no third-party packages: the schedule uses Node's built-in
`node:sqlite` unless `better-sqlite3` is installed, and `dotenv` is optional. That is
deliberate: the parts you most need to read and trust are the parts that run without
installing anything.

## Operational notes

- **Event Grid delivers duplicates by design.** The server de-duplicates on event id
  before answering, so a redelivery does not answer the same callback twice.
- **A second campaign run does not call the same patient twice.** A real call holds its
  appointment until it ends, and the in-flight limit is checked again right before each
  dial. A call whose `CallDisconnected` never arrives holds its appointment until the
  server restarts.
- **DTMF is always on.** Continuous recognition starts on `CallConnected`. The date of
  birth can be keyed as eight digits (MMDDYYYY); after verification, 1 confirms,
  2 cancels, 3 asks for a new time, 9 stops reminder calls and * repeats.
- **Silence is handled in simulation only.** The console's **Silence** says "Sorry, I
  didn't catch that", offers the keypad menu on the second silence once the patient is
  verified, and gives the clinic's number on the third. On a real call nothing reports
  silence to the flow yet, and the time limit is checked when the patient speaks, so
  add a silence timer before production.
- **The transfer is blind.** The agent's job ends once the context is delivered.
- **`CallTransferFailed` is handled once.** The patient is still on the line, so the
  agent apologizes once and says what happens next — a saved request and a callback
  from the scheduling desk, or the clinic's number for the nurse line — then ends the
  call. The transfer is not retried, a second failure event for the same call changes
  nothing, and a failed transfer is never counted as a handoff.
- **The server ends the call, not the model.** Once the flow reaches an end state, the
  bridge hangs up after the closing line has had time to play (about 65 ms a character,
  25 s at most), or at once when there is nothing to say, as on an early voicemail. The
  model's `end_call` never cuts a closing line short and is refused during a transfer.
- **Barge-in** sends `StopAudio` to ACS and `response.cancel` to Voice Live, so the
  agent stops mid-word rather than talking over the patient.
- **Voice Live allows one in-flight response.** A state change and a tool result can
  both want the agent to speak, so requests are coalesced in `voice-live.mjs`.

## Security notes before production

- **A date of birth is a knowledge check, not strong authentication.** Here it unlocks
  one appointment's details, and a confirm or a cancel after a clear yes. Anything more
  sensitive belongs with a person or a stronger check.
- **The model cannot dial, transfer or book.** Phone numbers, Teams IDs and times come
  from the server. Keep it that way: a tool that accepts a phone number turns a prompt
  injection into a toll-fraud vector.
- **Voicemail detection is a heuristic.** Call Automation has no answering-machine
  detection here, so on a real call the server reads the first transcribed words for
  phrases such as "leave a message" or "after the tone". When it takes a machine for a
  person, the agent asks for the patient by first name and says nothing more until a
  date of birth matches.
- **Anyone who answers can opt the number out.** Opt-outs are honored before
  verification and saved before the call ends. Decide whether that is the policy you
  want.
- **The console and the API have no authentication.** A tunnel exposes the campaign
  run, the hang-up endpoint, and `/health`, which shows the scheduling target and the
  database path. Put a real deployment behind authentication.
- **Transcripts are off by default.** Decisions and outcomes are stored; utterance text
  is stored only with `TRANSCRIPT_RETENTION=true`. Dates are masked, but only the seed's
  fictional first names are, so real names would not be. Nothing purges old
  transcripts yet.
- **The emergency line does not end the call.** It tells the patient to hang up and
  call 911, and the call stays open.
- **Disclose the assistant.** The opening line says it is automated. Several
  jurisdictions require this; every patient deserves it.
- **Calling rules differ by place.** Consent, calling hours, caller ID, voicemail
  wording and proxies are your compliance team's decisions. This sample shows where to
  enforce them, not what they should be.
- The seeded patients, clinics and phone numbers are fictional placeholders. Replace
  them.

## Microsoft references

- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [How to use the Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to)
- [Call Automation overview](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation)
- [Make an outbound call with Call Automation](https://learn.microsoft.com/azure/communication-services/quickstarts/call-automation/quickstart-make-an-outbound-call)
- [Teams Phone extensibility overview](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-overview)
- [Passing contextual data with custom headers](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/custom-context)
- [Teams interop with Call Automation](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/teams-interop-call-automation)
- [Bidirectional media streaming](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/audio-streaming-quickstart)
