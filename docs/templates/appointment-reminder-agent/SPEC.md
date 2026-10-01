# Appointment Reminder Agent — Sample Specification

**Status:** implementation guide for an illustrative, demo-grade sample. This is not a
production patient-outreach system. Its patients, appointments, consent records, and
clinic settings are local SQLite and JSON fixtures with fictional people. Its consent
rules, calling window, retry ladder, and voicemail wording are examples to replace with
the organization's own, after privacy, compliance, and legal review. Nothing in this
spec is legal advice.

Rows marked † were not asked individually. They are inherited from the gallery baseline
shared with the intent-based call routing sample, or are defaults to confirm during
review.

## Scope decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Scenario | Contoso Health, a fictional multi-site outpatient clinic group. A nightly campaign calls patients 48 hours before appointments in primary care, dermatology, and imaging. The patient can confirm, cancel (which releases the slot), or ask for a different time |
| 2 | Rescheduling | The reminder agent never books a new time. A reschedule request is a live handoff to the appointment scheduling sample. If that sample is not deployed, the agent files a callback request for the scheduling desk instead |
| 3 | Prep instructions | After a confirmation, the agent reads the appointment's prep instructions from config, such as "arrive 15 minutes early" or "don't eat for 8 hours before your lab work" |
| 4 | Outbound channel | Call Automation `CreateCall` from an ACS phone number, shown as the clinic's caller ID. The documented alternative is a server-initiated Teams Phone extensibility call from a Teams resource account (`TeamsAppSource`), which uses the resource account's Teams number |
| 5 | Inbound callback | The same number accepts inbound calls. A patient returning a missed call or voicemail reaches the same agent, runs the same right-party check, and can act on all their upcoming appointments, one at a time. A callback closes any remaining campaign attempts for those appointments |
| 6 | Right-party check | No appointment details until the right person is verified. The agent asks "Am I speaking with Jordan?" and then for the date of birth, which the server matches against the record. If someone else answers, the agent only asks them to have Jordan call back. An authorized proxy listed on the record (a caregiver or parent) can act after giving their own name and the patient's date of birth. Two failed checks end the call politely with the callback number, logged as unverified |
| 7 | Voicemail | Call Automation has no answering-machine detection, so the server infers voicemail: a long uninterrupted greeting, phrases such as "leave a message" or "after the tone", or a detected beep. The voicemail message is minimum-necessary and contains no health information: "This is Contoso Health calling for Jordan with an appointment reminder. Please call us back at…" It never names the appointment, date, provider, or department |
| 8 | Consent and calling window | Enforced by the server before dialing. Only patients with a recorded voice-reminder consent are called (`consent.voice = true`, with a source and date). Calls go out only between 8 a.m. and 8 p.m. in the patient's time zone, never on clinic holidays, and only if the patient's preferred reminder channel is voice. "Stop calling me" or "opt out" is written to a suppression list immediately and confirmed out loud |
| 9 | Retry ladder | From `config/campaign.json`: up to 3 attempts at least 4 hours apart, inside the calling window, and never later than 24 hours before the appointment. A voicemail is left once, on the last attempt only. Busy and no-answer schedule a retry. A wrong or disconnected number marks the contact bad and flags it for staff |
| 10 | Clinical questions | The agent gives no clinical advice. "Should I still come if I have a fever?" gets an offer to transfer to the clinic's nurse line during hours, or the after-hours nurse-advice number. Emergency phrases get "hang up and call 911" first |
| 11 | Accessibility exclusions | Patients flagged as TTY users or with a hearing-related communication preference are not called. They appear on a staff follow-up list |

## Implementation decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Voice Live model † | `gpt-realtime`, configurable |
| 2 | Session mode † | Direct model mode, with a documented path to Foundry agent mode |
| 3 | Credentials † | `DefaultAzureCredential` preferred, with an API key as the quick-start fallback |
| 4 | Offline runnability † | Full local mode, where a typed transcript and a simulated call outcome (answered, busy, no answer, voicemail greeting, bad number) drive the real campaign scheduler, consent and window checks, right-party check, schedule writes, handoffs, and retries |
| 5 | Verification † | Automated fixtures with `node:test`, plus a manual live-call checklist |
| 6 | Campaign scheduler | In-process. Each night (or on demand) it selects appointments 48 hours out, applies consent, suppression, preferred channel, accessibility flags, and the calling window, and writes a dial plan. A pacing limit (`CAMPAIGN_MAX_CONCURRENT`, default `2`) caps simultaneous calls. Dry-run mode prints the dial plan and the reason each patient was included or skipped, without placing calls |
| 7 | Schedule adapter | A `ScheduleAdapter` over a SQLite fixture seeded from `data/appointments-seed.json`, the same seed the scheduling sample uses. Appointments have an ID, patient, provider, department, location, start time, prep code, and status. Writes are `confirmAppointment`, `cancelAppointment` (with a reason code), and `requestReschedule`. A cancellation marks the slot `released` so a waitlist process could reuse it; the waitlist itself is out of scope. A FHIR `Appointment` adapter is documented, not built |
| 8 | Confirmed writes | Every change is read back and needs an explicit yes before it is written. Writes are idempotent per appointment and action, and audited. Cancelling inside 24 hours of the start time triggers the clinic's late-cancellation notice before the confirmation |
| 9 | Voicemail detection | A server-side detector over the inbound PCM stream and the first final transcript: continuous speech longer than `VOICEMAIL_GREETING_MS` (`4500`) with no pause, a voicemail phrase list per locale, or a beep found by a single-frequency tone detector. The detector decides before the agent speaks. The voicemail text is fixed by the server, not composed by the model, and is spoken after the beep or after 1.5 seconds of silence |
| 10 | Personal data | The model never sees phone numbers, dates of birth, medical record numbers, or patient IDs. Before verification it gets only the patient's first name. After verification it gets the spoken appointment summary (day, time, department, location, and provider) and the prep text |
| 11 | Retention | Raw audio is never stored. Transcripts stay in memory by default. When `TRANSCRIPT_RETENTION` is on, transcripts are stored with names and dates of birth masked and kept for `TRANSCRIPT_RETENTION_DAYS` (`7`). The audit log records outcomes and reason codes only, with no health information |
| 12 | Handoff mechanics † | Blind `TransferCallToParticipant` with `CallTopic`, `CallContext`, and `SessionId`. Each destination gets only the fields it needs |

## Experience decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Fictional org † | Contoso Health, with clinics in Seattle and Phoenix (two time zones) |
| 2 | AI disclosure | The agent says it is an automated assistant in its opening line, in the patient's language |
| 3 | Languages | English and Spanish, from the patient record's `preferredLanguage`. Voicemail, prep instructions, and the late-cancellation notice exist for both locales |
| 4 | Pacing and repeats | Each locale uses an Azure standard voice so the Voice Live `rate` setting applies. Patients flagged `slowSpeech` get rate `0.85`. "Say that again" or `*` repeats the last phrase |
| 5 | DTMF fallback | After two failed speech recognitions, the agent offers keys: `1` confirm, `2` cancel, `3` reschedule, `9` stop reminder calls, `*` repeat. The date of birth can also be entered as eight digits, `MMDDYYYY` |
| 6 | Call cap | 4 minutes, configurable, with a wrap-up at 3:20 |
| 7 | Escalation † | Transfer to the clinic front desk during its hours when the patient asks for a person or the agent fails twice after the DTMF fallback. Outside hours, the agent gives the callback number |
| 8 | Realtime transport † | Local WebSocket only, with no SignalR dependency |
| 9 | Default port † | `8099`, so it runs alongside the other gallery samples on `8090`–`8098` |
| 10 | Gallery card † | Visual scene updated to depict the outbound campaign, the right-party check, and confirm, cancel, or reschedule when the sample lands |

## Goal

Build a runnable outbound voice agent that reminds Contoso Health patients about
upcoming appointments and records whether each patient is coming. Confirmations reduce
no-shows, cancellations free up slots early enough to reuse, and reschedule requests go
straight to the scheduling agent instead of becoming a missed visit.

Compliance is part of the design, not an add-on. The server decides who may be called,
when, and how often. Nobody hears appointment details until the right person is
verified, and a voicemail never contains more than a name and a callback number.

The demo data lives in `config/` and `data/`:

| File | Contents |
|---|---|
| `config/campaign.json` | Lead time (48 hours), calling window (08:00–20:00 local), attempts (3), minimum spacing (4 hours), cutoff (24 hours before the appointment), voicemail-on-last-attempt flag, pacing limit, and the nightly run time |
| `config/clinics.json` | Locations with time zone, callback number, front-desk hours and Teams or PSTN target, nurse line hours and target, after-hours nurse-advice number, holiday calendar, and late-cancellation policy text per locale |
| `config/prep.json` | Prep codes mapped to spoken instructions per locale, for example `FASTING_8H`, `ARRIVE_15`, `BRING_MED_LIST`, and `NO_LOTION` for dermatology |
| `config/scripts.json` | Fixed server-owned text per locale: the voicemail message, the wrong-party message, the opt-out confirmation, the emergency message, and the clinical-question deflection |
| `config/detection.json` | Voicemail phrase lists per locale, the greeting length threshold, beep frequency band, emergency phrases, and clinical-question phrases |
| `config/routing.json` | The appointment scheduling agent's target, each clinic's front desk and nurse line, and the `CallContext` fields each destination receives |
| `data/patients.json` | About 12 demo patients with first and last name, date of birth, phone numbers, time zone, `preferredLanguage`, `preferredChannel`, consent record, authorized proxies, and accessibility flags |
| `data/appointments-seed.json` | About 30 appointments over the demo week, shared with the scheduling sample, plus past appointments with an `attended` field for the no-show comparison |

An example patient record and appointment:

```json
{
  "patientId": "P-1007",
  "firstName": "Jordan",
  "lastName": "Rivera",
  "dob": "1984-03-12",
  "phones": [{ "number": "+12065550142", "type": "mobile", "status": "ok" }],
  "timeZone": "America/Los_Angeles",
  "preferredLanguage": "es",
  "preferredChannel": "voice",
  "consent": { "voice": true, "source": "patient-portal", "date": "2025-11-04" },
  "proxies": [{ "name": "Alex Rivera", "relationship": "spouse", "authorized": true }],
  "flags": { "tty": false, "slowSpeech": false }
}
```

```json
{
  "appointmentId": "A-20418",
  "patientId": "P-1007",
  "department": "Imaging",
  "provider": "Dr. Lee",
  "location": "seattle-northgate",
  "start": "2026-05-21T09:30:00-07:00",
  "prepCode": "FASTING_8H",
  "status": "booked"
}
```

A patient is dialed only when all of these hold: `consent.voice` is true,
`preferredChannel` is `voice`, the number is not suppressed or marked bad, `flags.tty` is
false, the current time in the patient's zone is inside the window and not a clinic
holiday, the attempt count is below the limit, the last attempt was at least 4 hours ago,
and the appointment is more than 24 hours away. `DEMO_NOW` pins the clock for every one of
these checks.

## Caller experience

1. At the nightly run time, the scheduler builds the dial plan for appointments 48 hours
   out and logs why each patient was included or skipped. When the window opens in each
   patient's time zone, it places calls with `CreateCall`, up to the pacing limit.
2. **Busy, no answer, or bad number.** The server records the outcome. Busy and no answer
   schedule the next attempt. A disconnected number is marked bad and listed for staff.
3. **Voicemail.** The greeting runs past 4.5 seconds, or the detector hears "leave a
   message" or a beep. On attempts 1 and 2 the agent hangs up without speaking. On the
   last attempt it waits for the beep or silence and says: **"This is Contoso Health
   calling for Jordan with an appointment reminder. Please call us back at
   206-555-0100. Thank you."**
4. **Answered.** After the patient says "Hello?", the agent speaks: **"Hi, this is
   Contoso Health's automated assistant, calling with an appointment reminder. Am I
   speaking with Jordan?"** For a Spanish-preference patient, the same line is spoken in
   Spanish.
5. **Wrong party.** "No, this is his brother." **"Thanks. Could you please ask Jordan to
   call Contoso Health at 206-555-0100? Have a good day."** No other details are shared.
   The attempt counts, and the ladder continues.
6. **Right-party check.** "Yes, this is Jordan." **"Thanks, Jordan. To protect your
   privacy, please tell me your date of birth."** The server matches it. A mismatch gets
   one more try. A second mismatch ends the call: **"I'm sorry, I wasn't able to confirm
   that. Please call us at 206-555-0100."**
7. **Proxy.** "I'm his wife, Alex. I handle his appointments." The server finds Alex on
   the authorized proxy list and asks for Jordan's date of birth. The rest of the call
   proceeds on Jordan's behalf, and the audit log records that a proxy acted.
8. **Reminder.** **"You have an imaging appointment with Dr. Lee on Thursday, May 21st,
   at 9:30 a.m., at the Northgate clinic. Will you be able to make it?"**
9. **Confirm.** "Yes." The agent calls `confirm_appointment`, then reads the prep:
   **"You're confirmed. Please don't eat or drink anything except water for 8 hours
   before your appointment, and arrive 15 minutes early."**
10. **Cancel.** "I need to cancel." **"I can cancel your imaging appointment on Thursday
    at 9:30. Would you like to book a different time instead?"** "No, just cancel." The
    agent asks for a reason from a short list, reads back, and gets a yes before
    `cancel_appointment`. Inside 24 hours, it first reads the late-cancellation notice.
    **"It's cancelled. Thanks for letting us know so someone else can use that time."**
11. **Reschedule.** "Can I come next week instead?" **"I'll connect you to our scheduling
    assistant, who can find you a new time. Your current appointment stays booked until
    you choose a new one."** The agent calls `request_reschedule` and transfers. If the
    scheduling sample is not configured, it says **"I've asked our scheduling team to
    call you back tomorrow to find a new time."**
12. **Clinical question.** "Should I still come if I have a fever?" **"I can't give
    medical advice, but our nurse line can help. Would you like me to connect you?"**
    After hours, it reads the nurse-advice number instead.
13. **Emergency.** If the patient says something such as "I'm having chest pain right
    now", the agent first says **"If this is an emergency, please hang up and call 911."**
14. **Opt out.** "Stop calling me." **"Okay. You won't get any more automated reminder
    calls from Contoso Health. You can change this anytime through the patient portal or
    by calling the clinic."** The suppression is written before the call ends.
15. **Speech trouble.** After two failed recognitions: **"You can also use your keypad.
    Press 1 to confirm, 2 to cancel, 3 to change the time, or 9 to stop reminder calls."**
16. **Callback.** Jordan calls back after a voicemail. The server matches the calling
    number to a patient, but the agent still asks for the name and date of birth before
    saying anything else. It then handles each upcoming appointment in turn and closes
    the remaining campaign attempts for them.
17. The agent wraps up at 3:20, and the 4-minute cap (`CALL_TIME_BUDGET_MS`) or two
    no-inputs end the call politely with the callback number.

## Architecture and implementation shape

```text
Campaign scheduler (nightly + on demand; consent, window, retry ladder, pacing)
   → ACS Call Automation CreateCall from the clinic ACS number
       (alternative: Teams Phone extensibility server outbound from a resource account)
   ← inbound callbacks to the same number (Event Grid IncomingCall)
   ↔ Node.js 22 reminder service
       ↔ Azure AI Voice Live API over WebSocket
       ↔ voicemail detector (greeting length, phrase list, beep tone) — runs before the agent speaks
       ↔ safety guard (emergency + clinical-question phrases)
       ↔ right-party verifier (patients.json; proxies)
       ↔ ScheduleAdapter (SQLite fixture shared with the scheduling sample)
       ↔ consent + suppression store
       ↔ continuous DTMF recognition
       ↔ SQLite audit log + stats endpoint
       ↔ presenter console with campaign board over a local WebSocket
   → ACS transfer to appointment scheduling agent | clinic front desk | nurse line
```

Reuse the password-reset sample's Express server, configuration pattern, ACS-to-Voice
Live media bridge, PCM16 24-kHz path, barge-in handling, SQLite event log, health
endpoint, and simulation-mode conventions. Add the outbound path: `CreateCall` with
media streaming options, `CallConnected` and `CreateCallFailed` handling, and
`StartContinuousDtmfRecognition` once connected.

Each appointment has a campaign state:

`pending → scheduled → dialing → (busy | no_answer → retry_scheduled → dialing …) | bad_number | voicemail_left | wrong_party → retry_scheduled | reached_unverified | confirmed | cancelled | reschedule_handoff | reschedule_callback | opted_out | completed_by_callback | skipped (no_consent | channel | suppressed | tty | cutoff | holiday)`

Each call has a call state:

`dialing → connected → detecting → (voicemail → (hang_up | leaving_message) → ended) | greeting → right_party → (wrong_party → ended) | verifying → (unverified → ended) | presenting → (confirming → confirmed → prep) | (cancel_reason → cancel_confirm → cancelled) | reschedule → transferring | opt_out | clinical → (nurse_transfer | advice_number) | dtmf_menu … → wrap_up → closing → ended`

Inbound callbacks start at `ringing → greeting → verifying` and then step through the
patient's upcoming appointments with the same `presenting` loop.

The model changes state only through server-owned tools:

- `confirm_identity(isPatient | proxyName)` records the answer to "Am I speaking
  with…?" and returns `ask_dob`, `wrong_party`, or `proxy_ask_dob`.
- `check_dob(spokenOrDigits)` returns `verified`, `retry`, or `failed`. The model never
  sees the date of birth on file.
- `get_appointment_summary()` returns the next pending appointment as a spoken summary,
  or `none`.
- `confirm_appointment(confirmation)` requires an explicit yes in the patient's last
  utterance, and returns the prep text.
- `propose_cancel(reasonCode)` returns a read-back phrase, plus the late-cancellation
  notice when inside 24 hours. `cancel_appointment(proposalId, confirmation)` writes it.
- `request_reschedule()` records the request and transfers to the scheduling agent, or
  files a callback request if no target is configured.
- `opt_out()` writes the suppression immediately.
- `nurse_line()` transfers during hours, or returns the after-hours advice number.
- `transfer(reason)`, `repeat_last()`, and `end_call(reason)`.

The server, not the model, handles voicemail and safety. The voicemail detector runs
before the greeting is spoken. On a voicemail, the model never gets a turn: the server
either hangs up or speaks the fixed message. When an emergency phrase is heard, the
server suppresses the model's pending response and speaks the fixed emergency line
first. Wrong-party, opt-out, and verification-failure lines are also fixed text from
`config/scripts.json`.

## Teams handoff contract

Transfers use `TransferCallToParticipant` to a target from `config/routing.json`. On a
Teams Phone extensibility deployment, the custom context carries:

- `CallDetails.SessionId`: the ACS correlation ID, kept in the audit record and shared
  with the scheduling agent.
- `CallDetails.CallTopic`: up to 48 characters, for example `Reschedule – Imaging
  A-20418`, `Nurse line – reminder call`, or `Front desk – reminder help`.
- `CallDetails.CallContext`: only the fields listed for that destination:
  - Appointment scheduling agent: `{intent: "reschedule", appointmentId, patientRef,
    verified: true, sessionId}`. `patientRef` is a short-lived opaque token that the
    scheduling sample redeems server-side against the shared store. It is not a patient
    ID or any other personal data. The scheduling agent checks the token and may still
    run its own verification.
  - Clinic front desk: the patient's first name, appointment ID, the verification
    result, and what the agent already did.
  - Nurse line: the patient's first name, the appointment ID, and that the patient asked
    a clinical question. The question's text is not passed.

On a plain ACS number, `CallContext` is sent as SIP custom headers on the transfer, with
the same fields.

## Demo surface and configuration

The presenter console has a **campaign board**: one row per appointment in the dial plan,
with a masked patient name (`Jordan R.`), department, local time, attempt count, next
attempt time, and the current campaign state. Skipped rows show their reason. Selecting a
row shows the live call: call state, the voicemail detector's decision and why, the
transcript, verification result, tool calls, and the schedule write. A **Run campaign
now** control, a **Dry run** control, and a **Reset data** control drive the demo. A
**simulated outcome** picker lets the presenter answer, reject, or send a typed call to
voicemail. The console is marked as a demo surface.

Configuration covers `PORT` (`8099`), `PUBLIC_BASE_URL`, `ACS_ENDPOINT` (with
`ACS_CONNECTION_STRING` as the fallback), `ACS_CALLER_ID` (the clinic's ACS number),
`TEAMS_RESOURCE_ACCOUNT_ID` (optional, for Teams Phone extensibility outbound),
`VOICE_LIVE_ENDPOINT`, `VOICE_LIVE_MODEL` (`gpt-realtime`), and `VOICE_LIVE_API_VERSION`
(`2026-04-10`), with Entra auth using the **Cognitive Services User** and **Foundry
User** roles and the `https://ai.azure.com/.default` scope. It also covers
`SCHEDULE_ADAPTER` (`sqlite`), `SCHEDULE_DB_PATH` (set it to the same file as the
scheduling sample to share data), `SCHEDULING_AGENT_TARGET` (empty means file a callback
request), `CAMPAIGN_ENABLED` (`false` until explicitly turned on), `CAMPAIGN_DRY_RUN`
(`true`), `CAMPAIGN_MAX_CONCURRENT` (`2`), `VOICEMAIL_GREETING_MS` (`4500`),
`TRANSCRIPT_RETENTION` (`false`), `TRANSCRIPT_RETENTION_DAYS` (`7`), `DEMO_NOW` (pins
the clock for the window, holidays, cutoffs, and late cancellations), and
`CALL_TIME_BUDGET_MS` (`240000`).

The sample is safe by default. `CAMPAIGN_ENABLED=false` and `CAMPAIGN_DRY_RUN=true` mean
a fresh clone never dials anyone. Live dialing also requires every number in the dial
plan to be on an `ALLOWED_TEST_NUMBERS` list, so a demo can only call the presenter's
own phones.

With no Azure subscription, the typed-transcript mode drives the scheduler, the consent
and window checks, simulated call outcomes, the voicemail detector (using typed greetings
and a "beep" token), verification, schedule writes, handoffs, and retries. Only audio,
dialing, and transfers are simulated. The sample ships a README, `DEMO-SCRIPT.md`, the
ACS number and optional Teams resource account provisioning steps, the config and data
fixtures, and the call fixtures.

## Acceptance criteria

- A live outbound call to an allowed test number connects through `CreateCall`, the
  voicemail detector runs, and the agent reaches Voice Live. A real voicemail box gets
  the fixed message on the last attempt only. An inbound callback to the same number
  reaches the same state machine. Transfers reach the scheduling agent, a front desk, and
  a nurse line. All are verified by the manual live-call checklist.
- Barge-in works, and duplicate Event Grid deliveries do not create duplicate sessions or
  duplicate dials.
- `node:test` runs the fixtures with no cloud credentials. They cover the dial plan for
  the demo week, a patient without consent (skipped), a non-voice preferred channel
  (skipped), a suppressed number (skipped), a TTY flag (skipped and listed for staff), a
  time before 8 a.m. and after 8 p.m. in each time zone, a clinic holiday, the 24-hour
  cutoff, busy and no-answer retries with 4-hour spacing, a third attempt being the last,
  a bad number flagged for staff, voicemail on attempts 1 and 2 (hang up) and attempt 3
  (message), each voicemail signal (long greeting, phrase, beep), a human who says a long
  "hello" not being mistaken for voicemail, a wrong party, a correct date of birth, one
  wrong then correct, two wrong (unverified), DOB entered by keypad, an authorized proxy,
  an unauthorized proxy (refused), confirm with prep, confirm in Spanish, cancel with a
  reason, cancel inside 24 hours with the late-cancellation notice, "maybe" treated as no
  confirmation, a repeated confirm being idempotent, reschedule with a configured
  scheduling target and the right `CallContext`, reschedule with no target filing a
  callback, a clinical question in hours and after hours, an emergency phrase spoken
  first, a spoken opt-out, DTMF `1`, `2`, `3`, `9`, and `*`, a request for a person, the
  3:20 wrap-up, an expired call cap, two no-inputs, a callback with two pending
  appointments, a callback closing remaining campaign attempts, a callback from an
  unknown number, and a prompt-injection attempt to make the agent read the appointment
  before verification or to leave details on voicemail.
- No patient is dialed unless every consent, suppression, channel, accessibility, window,
  holiday, spacing, attempt, and cutoff check passes. Dry run shows the same decisions
  without dialing.
- No appointment detail, department, or provider is spoken before verification, to a
  wrong party, or on voicemail.
- No schedule write happens without an explicit yes in the patient's last utterance, and
  repeated writes do not change the outcome.
- An opt-out is persisted before the call ends, and the patient is never dialed again.
- The model context never contains phone numbers, dates of birth, medical record numbers,
  or patient IDs.
- The opening line discloses that the patient is talking to an automated assistant.
- Utterance text and audio are absent from the database unless `TRANSCRIPT_RETENTION` is
  on, and stored transcripts have names and dates of birth masked.
- `GET /health` reports application, Voice Live, ACS caller ID, the optional Teams
  resource account, the schedule adapter, whether the campaign is enabled or in dry run,
  the next scheduled run, calls in flight against the pacing limit, the scheduling agent
  target, and simulation mode.
- `GET /api/stats` reports appointments in scope, dialed, and skipped by reason;
  attempts; contact rate (answered by a person); right-party rate; outcomes (confirmed,
  cancelled, reschedule handoff, reschedule callback, unverified, wrong party, voicemail
  left, bad number); released slots; opt-outs; callbacks; and a no-show comparison
  between reminded and not-reached patients, computed from the fixture's `attended`
  field.

## Production gates and non-goals

The sample does not connect to a live EHR or practice-management system, book new
appointments, manage a waitlist, send SMS or email reminders, give clinical advice,
record audio, or call anyone outside the allowed test numbers. Before real use, the
following are needed:

- Legal and compliance review of outbound calling rules for each jurisdiction, including
  the TCPA and state telemarketing and healthcare-message rules, consent capture and
  revocation, calling windows, and caller ID requirements.
- HIPAA and privacy review of the right-party check, proxy authorization, the voicemail
  wording, what each transfer destination receives, and retention. Microsoft's HIPAA
  offering covers in-scope Azure services under a business associate agreement; the
  deploying organization still owns its own compliance.
- Caller ID name (CNAM) registration and branded-calling setup for the clinic number,
  plus monitoring of spam labeling by carriers.
- An implemented and tested scheduling adapter (for example FHIR `Appointment` and
  `Slot`), running with a least-privilege service identity.
- Accessibility review, including the TTY and relay path, the slow-speech setting, and
  the DTMF menu.
- Clinical sign-off on the emergency and clinical-question phrase lists, prep text, and
  nurse-line routing.
- Tuning and measurement of the voicemail detector against real greetings, with a
  documented false-positive rate.
- Licensing for outbound calls. A Teams resource account used for server-initiated
  outbound PSTN calls needs a Pay-As-You-Go Calling Plan.
- Validated Event Grid subscriptions, warm compute, carrier rate limits, and managed
  identity or Key Vault for credentials.

Primary measures are no-show rate, confirmations, and recovered slots.

## Microsoft reference contracts

- [Call Automation overview](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation)
- [Make an outbound call with Call Automation](https://learn.microsoft.com/azure/communication-services/quickstarts/call-automation/quickstart-make-an-outbound-call)
- [Teams Phone extensibility overview](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-overview)
- [Place outbound calls with Call Automation for Teams Phone extensibility](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-server-outbound-call)
- [ACS phone number types](https://learn.microsoft.com/azure/communication-services/concepts/numbers/number-types)
- [Audio streaming with Call Automation](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/audio-streaming-quickstart)
- [Control mid-call media actions, including continuous DTMF](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/control-mid-call-media-actions)
- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [Voice Live API how-to — endpoint, api-version, Entra auth, and speaking rate](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to)
- [Voice Live language support](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-language-support)
- [Call Automation transfer to a participant](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/actions-for-call-control#transfer-a-participant-in-a-call)
- [HIPAA and Microsoft Azure](https://learn.microsoft.com/azure/compliance/offerings/offering-hipaa-us)
