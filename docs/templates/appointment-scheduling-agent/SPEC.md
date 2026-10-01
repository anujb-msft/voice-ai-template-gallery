# Appointment Scheduling Agent — Sample Specification

**Status:** implementation guide for an illustrative, demo-grade sample. This is not a
production patient-access system. Its patients, providers, referrals, orders,
schedules, and eligibility rules are local SQLite and JSON fixtures with fictional
people. Its visit types, eligibility rules, safety phrase lists, and access targets are
examples to replace with the organization's own, after clinical, privacy, and
compliance review.

Rows marked † were not asked individually. They are inherited from the gallery baseline
shared with the intent-based call routing sample, or are defaults to confirm during
review.

## Scope decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Scenario | Contoso Health's inbound scheduling line for existing patients. Callers can book, reschedule, or cancel primary care, dermatology, and imaging visits. It shares Contoso Health, the clinics, the patients, and the SQLite schedule with the appointment reminder sample |
| 2 | Visit types | From `config/visit-types.json`: new problem (30 minutes), follow-up (15), annual physical (40), skin check (20), and imaging by modality (X-ray 15, ultrasound 30, MRI 45). Each type lists its department, eligible provider roles, prep code, and access target |
| 3 | New patients | Not booked by voice. A caller who isn't found as a patient gets a callback request from the registration team, with only a callback number and a preferred time captured |
| 4 | Reminder handoff | Accepts the reminder sample's reschedule transfer. A valid `patientRef` token lets the patient go straight to choosing a new time for the appointment named in `CallContext` |
| 5 | Identity | Full name plus date of birth, matched server-side. A caller ID that matches a patient only pre-selects the record; it never counts as verification. Authorized proxies listed on the record can act after giving their own name and the patient's date of birth. Two failed checks send the caller to the scheduling team during hours, or give the callback number after hours |
| 6 | Eligibility | A server-side rules engine in `config/eligibility.json`. Dermatology and imaging need an active, unexpired referral. Imaging also needs an order for the modality. The annual physical is limited to one every 12 months. Patients under 18 only see pediatrics-capable providers. Insurance must be active, or the caller must acknowledge self-pay. When a rule fails, the agent explains it in plain words and offers the right alternative. It never overrides a rule |
| 7 | Reason for visit and safety | The agent asks for a short reason for the visit, kept server-side. Emergency phrases get "hang up and call 911" first. Urgent-symptom phrases offer the nurse line during hours, or the nurse-advice number after hours, and nothing is booked until a nurse is involved. The agent gives no medical advice and never switches the caller to a shorter or different visit type than the rules require |
| 8 | No availability | When nothing is open within the visit type's access target (for example 14 days), the agent offers other providers or locations, then a waitlist entry with the patient's preferred days, or a callback |
| 9 | Hours and escalation | The agent answers 24/7, which extends access beyond office hours. During hours, the caller can reach the scheduling team queue, which receives the call's context. After hours, a person request becomes a callback request |
| 10 | Cancellation | Cancelling by voice follows the reminder sample's rules: a reason code, the late-cancellation notice within 24 hours, read-back, and an explicit yes. The slot is marked `released` |

## Implementation decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Voice Live model † | `gpt-realtime`, configurable |
| 2 | Session mode † | Direct model mode, with a documented path to Foundry agent mode |
| 3 | Credentials † | `DefaultAzureCredential` preferred, with an API key as the quick-start fallback |
| 4 | Offline runnability † | Full local mode, where a typed transcript drives the real verification, eligibility engine, slot search, holds, bookings, SMS stub, safety guard, and handoffs |
| 5 | Verification † | Automated fixtures with `node:test`, plus a manual live-call checklist |
| 6 | Schedule adapter | The reminder sample's `ScheduleAdapter` on the same SQLite file (`SCHEDULE_DB_PATH`), extended with `searchSlots`, `holdSlot`, `releaseHold`, `bookAppointment`, `rescheduleAppointment`, `cancelAppointment`, and `addWaitlist`. A FHIR R4 adapter (`Slot` search, `Appointment` create, `Schedule`) is documented with an interface contract but not built |
| 7 | Slot search | Open slots are generated from provider templates in `config/providers.json` (weekly hours, location, and visit types offered), minus booked appointments, active holds, and clinic holidays. Results are filtered by the patient's preferences (provider, "my usual doctor" meaning the primary care provider on file, location, day, time of day, or earliest) and limited to 90 days out |
| 8 | Holds and races | Choosing an option places a 5-minute hold. Holds and appointments both write rows to an `occupancy` table with a unique key on provider and 5-minute unit, so two callers can't hold or book overlapping time. A lost race returns `slot_taken`. Booking converts the hold into an appointment in one transaction, after re-reading the slot. Holds are released at the end of the call, at the call cap, or when they expire |
| 9 | Confirmed writes | Every booking, reschedule, and cancellation gets a full read-back and an explicit yes before it's written. Writes use idempotency keys and are audited. A reschedule books the new slot and cancels the old one in the same transaction, so the patient is never left with no appointment |
| 10 | Confirmation message | With an SMS consent on file, a confirmation text goes out through ACS SMS. It contains the date, time, location, and a portal link, with no visit type, reason, or provider. Without SMS consent, the agent speaks a confirmation number |
| 11 | Personal data | The model never sees phone numbers, dates of birth, medical record numbers, patient IDs, insurance details, or the text of the reason for visit. It gets the patient's first name, spoken slot options, eligibility outcomes as reason codes with plain-language text, and the read-back phrase |
| 12 | Retention | Raw audio is never stored. The audit log has outcomes and reason codes only. The reason for visit is stored separately, masked, on the appointment record. Transcripts stay in memory by default. When `TRANSCRIPT_RETENTION` is on, transcripts are stored with names and dates of birth masked and kept for `TRANSCRIPT_RETENTION_DAYS` (`7`) |
| 13 | Handoff mechanics † | Blind `TransferCallToParticipant` with `CallTopic`, `CallContext`, and `SessionId`. Each destination gets only the fields it needs |

## Experience decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Fictional org † | Contoso Health, with clinics in Seattle and Phoenix |
| 2 | Entry points | A Teams resource account through Teams Phone extensibility (the clinic's main-line auto attendant, "press 2 to schedule") and a plain ACS number |
| 3 | AI disclosure | The agent says it is an automated assistant in its opening line |
| 4 | Languages | English and Spanish. The first language is detected from the caller's speech. After verification, the patient's `preferredLanguage` is used |
| 5 | Speaking options | At most 2 or 3 options at a time, spoken naturally ("Tuesday the 19th at 10:15 with Dr. Patel at Northgate"), then "would you like more options?" Dates and times are spoken in full and repeated on request |
| 6 | DTMF fallback | After two failed speech recognitions: `1` first option, `2` second option, `3` more options, `0` scheduling team, `*` repeat. The date of birth can be entered as eight digits, `MMDDYYYY` |
| 7 | Call cap | 7 minutes, configurable, with a wrap-up at 6 minutes. Any hold is released when the cap is reached |
| 8 | Realtime transport † | Local WebSocket only, with no SignalR dependency |
| 9 | Default port † | `8100`, so it runs alongside the other gallery samples on `8090`–`8099` |
| 10 | Gallery card † | Visual scene updated to depict verification, eligibility, the slot offer, and the booked appointment when the sample lands |

## Goal

Build a runnable inbound voice agent that turns a scheduling call into a correct, booked
appointment. The agent finds out who is calling, what kind of visit they need, and
whether they're eligible for it, then offers real open times, holds the chosen slot, and
books it after a read-back. Anything it shouldn't decide goes to the right person: urgent
symptoms to a nurse, missing referrals to the referral coordinator, new patients to
registration, and anything else to the scheduling team.

The demo data lives in `config/` and `fixtures/`. Files marked "shared" are the same files
the reminder sample uses:

| File | Contents |
|---|---|
| `config/visit-types.json` | Visit type codes, spoken names per locale, durations, department, eligible provider roles, prep code, access target in days, and whether a referral or order is required |
| `config/providers.json` | About 8 providers with role, department, locations, pediatrics flag, spoken name, and weekly templates (days, start and end times, visit types offered, and breaks) |
| `config/eligibility.json` | Ordered rules, each with an ID, the visit types it applies to, a condition, a plain-language explanation per locale, and the alternative to offer |
| `config/clinics.json` | Shared. Locations, time zones, holidays, front-desk and nurse line hours and targets, the after-hours nurse-advice number, and the late-cancellation policy |
| `config/prep.json` | Shared. Prep codes mapped to spoken instructions per locale |
| `config/safety.json` | Emergency and urgent-symptom phrase lists per locale, marked as needing clinical review |
| `config/routing.json` | The scheduling team queue, nurse line, referral coordinator, registration callback queue, and the `CallContext` fields each one receives |
| `fixtures/appointments-seed.json` | Shared. Demo patients, providers, booked appointments, and past appointments for the demo weeks |
| `config/referrals.json` | Referrals by patient, with department, status, and expiry date |
| `config/orders.json` | Imaging orders by patient, with modality, status, and expiry date |

An example eligibility rule and the outcome the model sees:

```json
{
  "id": "REFERRAL_REQUIRED",
  "appliesTo": ["DERM_SKIN_CHECK", "DERM_NEW_PROBLEM"],
  "requires": { "referral": { "department": "Dermatology", "status": "active", "notExpired": true } },
  "explain": {
    "en": "Dermatology visits need a referral from your primary care provider, and I don't see an active one on file.",
    "es": "Las citas de dermatología requieren una referencia de su médico de atención primaria, y no veo una activa."
  },
  "alternatives": ["book_pcp_visit", "referral_coordinator_callback"]
}
```

```json
{ "eligible": false, "ruleId": "REFERRAL_REQUIRED", "say": "Dermatology visits need a referral…", "alternatives": ["book_pcp_visit", "referral_coordinator_callback"] }
```

Rules are checked in order, and every rule must pass. The model can't skip or reword a
rule into a different decision. It can only speak the explanation and offer the listed
alternatives.

## Caller experience

1. The caller reaches the agent from the main-line auto attendant or the ACS number. The
   agent speaks first: **"Hi, you've reached Contoso Health scheduling. I'm an automated
   assistant. I can book, change, or cancel an appointment. What can I help you with?"**
   If the caller speaks Spanish, the agent continues in Spanish.
2. **Identity.** "I need to make an appointment." **"Sure. Can I have the patient's full
   name and date of birth?"** The server matches both. If the caller ID matched a patient,
   that record is tried first, but the name and date of birth are still required. A
   mismatch gets one more try. A second mismatch: **"I'm not able to confirm that. Let me
   connect you with our scheduling team."** After hours, the agent gives the callback
   number.
3. **Not a patient.** "I've never been there before." **"Welcome. New patients are set up
   by our registration team. What's the best number and time for them to call you?"** A
   callback request is filed, and no booking is made.
4. **Reason and safety.** **"Thanks, Jordan. What kind of visit do you need, and what's
   it for?"** "I have a rash I want looked at." The server checks the reason against the
   safety lists. For "I'm having trouble breathing right now," the agent first says **"If
   this is an emergency, please hang up and call 911,"** then offers the nurse line. For
   an urgent symptom such as "a high fever for three days," it offers the nurse line
   during hours, or the nurse-advice number after hours, and doesn't book.
5. **Visit type.** The model maps the request to a visit type through
   `choose_visit_type`, and the server checks it against the rules: a rash is a
   dermatology skin check or a primary care new-problem visit. The agent asks: **"Would
   you like to see dermatology, or your primary care doctor first?"**
6. **Eligibility.** "Dermatology." The server finds no active referral. **"Dermatology
   visits need a referral from your primary care provider, and I don't see an active one
   on file. I can book you with Dr. Patel, your primary care doctor, or ask our referral
   coordinator to call you. Which would you prefer?"**
7. **Search.** "Dr. Patel is fine. Mornings are best." **"Dr. Patel has Tuesday the 19th
   at 10:15 at Northgate, or Thursday the 21st at 8:30 at Northgate. Would either of
   those work?"** "Anything Monday?" The agent searches again with the new preference.
8. **Hold.** "Tuesday at 10:15." The server places the hold. If another caller got the
   slot first: **"Sorry, that time was just taken. Dr. Patel also has…"**
9. **Read-back and booking.** **"To confirm: a new-problem visit with Dr. Patel on
   Tuesday, May 19th, at 10:15 a.m., at the Northgate clinic. Shall I book it?"** "Yes."
   The server books the appointment in one transaction.
10. **Prep and confirmation.** **"You're booked. Please arrive 15 minutes early and bring
    a list of your medications. I've sent a text with the details."** Without SMS
    consent: **"Your confirmation number is K-4-7-2-9."**
11. **Reschedule from the reminder.** The reminder sample transfers Jordan with a
    `patientRef` token. The server redeems it, and the agent skips verification:
    **"Hi, Jordan. I can help you find a new time for your imaging appointment on
    Thursday at 9:30. What days work better?"** The new slot is booked and the old one
    cancelled in the same transaction. An invalid or expired token gets the full identity
    check.
12. **Reschedule or cancel by direct call.** After verification, the agent lists upcoming
    appointments, one at a time, and follows the same read-back rules. A cancellation
    within 24 hours first reads the late-cancellation notice.
13. **No availability.** If nothing is open within the access target: **"Dr. Patel's
    next opening is in five weeks. Dr. Nguyen at the Capitol Hill clinic has Friday at
    2:00. Would you like that, or should I add you to Dr. Patel's waitlist?"**
14. **Person request.** "Let me talk to someone." During hours, the agent transfers to the
    scheduling team with context. After hours: **"Our scheduling team opens at 7 a.m.
    I've asked them to call you back."**
15. **Speech trouble.** After two failed recognitions: **"You can also use your keypad.
    Press 1 for the first time, 2 for the second, 3 for more options, or 0 for our
    scheduling team."**
16. The agent wraps up at 6 minutes. At the 7-minute cap (`CALL_TIME_BUDGET_MS`), or after
    two no-inputs, any hold is released and the call ends politely with the callback
    number.

## Architecture and implementation shape

```text
Teams caller → main-line auto attendant → Teams resource account
   → Teams Phone extensibility → ACS Call Automation          (or PSTN → ACS number → Event Grid IncomingCall)
   ← reminder sample transfer with CallContext {intent: reschedule, appointmentId, patientRef}
   ↔ Node.js 22 scheduling service
       ↔ Azure AI Voice Live API over WebSocket
       ↔ identity verifier + patientRef redeemer
       ↔ safety guard (emergency + urgent-symptom phrases)
       ↔ eligibility engine (visit types, referrals, orders, age, insurance, frequency)
       ↔ ScheduleAdapter (shared SQLite: appointments, occupancy, holds, waitlist, handoff tokens)
       ↔ ACS SMS confirmation (consent-gated, allow-listed in demo)
       ↔ continuous DTMF recognition
       ↔ SQLite audit log + stats endpoint
       ↔ presenter console with provider schedule grid over a local WebSocket
   → ACS transfer to scheduling team | nurse line | referral coordinator, or a callback request
```

Reuse the password-reset sample's Express server, configuration pattern, ACS-to-Voice
Live media bridge, PCM16 24-kHz path, barge-in handling, SQLite event log, health
endpoint, and simulation-mode conventions. Reuse the reminder sample's `ScheduleAdapter`,
right-party verifier, prep text, cancellation rules, and safety guard.

The call moves through these states:

`ringing → greeting → (handoff_token → redeemed | invalid → verifying) | verifying → (new_patient → registration_callback) | (unverified → escalate) | verified → choose_action → (book | reschedule | cancel) → reason → (emergency | urgent → nurse) | visit_type → eligibility → (blocked → alternative) | searching → offering → holding → (slot_taken → offering) | read_back → booked → prep → confirm_message → anything_else → wrap_up → closing → ended`

The `escalating`, `callback_filed`, and `waitlisted` states can be reached from any
point after verification.

The model changes state only through server-owned tools:

- `verify_patient(fullName, dob)` returns `verified`, `retry`, `failed`, `proxy_ask_dob`,
  or `not_found`. The model never sees the date of birth on file.
- `redeem_handoff()` redeems the `patientRef` from `CallContext`. It returns `redeemed`
  with the appointment's spoken summary, or `invalid`.
- `list_upcoming()` returns the verified patient's upcoming appointments as spoken
  summaries with opaque handles.
- `note_reason(text)` stores the reason server-side and returns `ok`, `urgent`, or
  `emergency`. The model doesn't get the stored text back.
- `choose_visit_type(code)` returns the eligibility result: `eligible`, or a rule ID with
  the explanation and the alternatives.
- `search_slots(preferences)` returns up to `OPTIONS_PER_TURN` options as spoken text
  with opaque option IDs, and `more_available`.
- `hold_slot(optionId)` returns `held`, with an expiry and the read-back phrase, or
  `slot_taken`.
- `book(holdId, confirmation)` and `reschedule(holdId, appointmentHandle, confirmation)`
  require an explicit yes in the caller's last utterance, and return the prep text and
  the confirmation channel.
- `propose_cancel(appointmentHandle, reasonCode)` and `cancel(proposalId, confirmation)`
  follow the reminder sample's rules.
- `add_waitlist(preferences)`, `request_callback(queue)`, `transfer(destination,
  reason)`, `repeat_last()`, and `end_call(reason)`.

The server, not the model, handles safety, eligibility, and slot integrity. Emergency
phrases make the server suppress the model's pending response and speak the fixed
emergency line first. When `note_reason` returns `urgent` or `emergency`, `book` is
locked for the rest of the call. Eligibility is re-checked in `hold_slot` and `book`, so
an earlier tool call can't be bypassed. `book` re-reads the slot in the same
transaction that converts the hold.

`patientRef` tokens are created by the reminder sample in the shared database's
`handoff_tokens` table. Each one is random, single-use, expires after
`HANDOFF_TOKEN_TTL_MS` (`300000`), and is bound to the ACS correlation ID of the
transferred call. A deployment that doesn't share the database signs the token with
`HANDOFF_TOKEN_SECRET` (HMAC) and redeems the appointment through the adapter.

## Teams handoff contract

Transfers use `TransferCallToParticipant` to a target from `config/routing.json`. On a
Teams Phone extensibility deployment, the custom context carries:

- `CallDetails.SessionId`: the ACS correlation ID, kept in the audit record.
- `CallDetails.CallTopic`: up to 48 characters, for example `Scheduling – Derm referral
  needed`, `Nurse line – urgent symptom`, or `Scheduling – caller request`.
- `CallDetails.CallContext`: only the fields listed for that destination:
  - Scheduling team: the patient's first name, verification result, chosen visit type,
    eligibility result, the held slot and its expiry (if any), and what the agent
    already did. The hold is extended once, by `HOLD_TTL_MS`, when the transfer starts.
  - Nurse line: the patient's first name, the verification result, and that the safety
    guard matched an urgent phrase. The reason text is not passed.
  - Referral coordinator: the patient's first name, the department, and the rule that
    blocked booking.

Inbound from the reminder sample, the agent reads `CallContext` `{intent: "reschedule",
appointmentId, patientRef, verified, sessionId}` and trusts it only after the server
redeems `patientRef`. On a plain ACS number, `CallContext` travels as SIP custom headers
with the same fields.

## Demo surface and configuration

The presenter console has a **provider schedule grid**: one column per provider for the
selected day, showing booked time, active holds with a countdown, released slots, and
template hours. Beside it, the live call panel shows the call state, transcript,
verification result, the eligibility rules checked and their outcomes, the search
preferences and the options offered, tool calls, and the booking write. Patient names
are masked (`Jordan R.`). A **Reset data** control restores the shared fixture, and a
**Simulate competing caller** control holds a slot the live caller is about to pick, to
demo the race. The console is marked as a demo surface.

Configuration covers `PORT` (`8100`), `PUBLIC_BASE_URL`, `ACS_ENDPOINT` (with
`ACS_CONNECTION_STRING` as the fallback), `TEAMS_RESOURCE_ACCOUNT_ID`,
`VOICE_LIVE_ENDPOINT`, `VOICE_LIVE_MODEL` (`gpt-realtime`), and `VOICE_LIVE_API_VERSION`
(`2026-04-10`), with Entra auth using the **Cognitive Services User** and **Foundry
User** roles and the `https://ai.azure.com/.default` scope. It also covers
`SCHEDULE_ADAPTER` (`sqlite`), `SCHEDULE_DB_PATH` (set it to the same file as the
reminder sample to share data), `HOLD_TTL_MS` (`300000`), `SEARCH_HORIZON_DAYS` (`90`),
`OPTIONS_PER_TURN` (`3`), `HANDOFF_TOKEN_TTL_MS` (`300000`), `HANDOFF_TOKEN_SECRET`
(only when the database isn't shared), `SMS_ENABLED` (`false`), `ACS_SMS_FROM`,
`SMS_ALLOWED_NUMBERS` (live texts go only to these numbers in the demo),
`SCHEDULER_MINUTES_PER_BOOKING` (`6`, the baseline for scheduler hours saved),
`TRANSCRIPT_RETENTION` (`false`), `TRANSCRIPT_RETENTION_DAYS` (`7`), `DEMO_NOW` (pins
the clock for search, holds, holidays, access targets, referral expiry, and late
cancellations), and `CALL_TIME_BUDGET_MS` (`420000`).

With no Azure subscription, the typed-transcript mode drives every server component. The
SMS sender writes to the console instead of sending, and only audio, telephony, and
transfers are simulated. The sample ships a README, `DEMO-SCRIPT.md`, the Teams resource
account and ACS number provisioning steps, the SMS number setup, the config and data
fixtures, and the call fixtures.

## Acceptance criteria

- A live call reaches the agent through the auto attendant and the Teams resource
  account, and through the ACS number. A transfer from the reminder sample arrives with
  `CallContext` and redeems its token. Transfers reach the scheduling team, the nurse
  line, and the referral coordinator. A confirmation text reaches an allowed test number.
  All are verified by the manual live-call checklist.
- Barge-in works, and duplicate Event Grid deliveries do not create duplicate sessions,
  holds, or bookings.
- `node:test` runs the fixtures with no cloud credentials. They cover a correct name and
  date of birth, one wrong then correct, two wrong (escalation in hours, callback number
  after hours), a caller ID match that still requires verification, DOB entered by
  keypad, an authorized proxy, an unauthorized proxy, a new patient, a valid reminder
  token, an expired token, a reused token, a token from a different call, an emergency
  phrase spoken first, an urgent symptom in hours and after hours with booking locked, a
  primary care new-problem booking, a follow-up, an annual physical within 12 months
  (blocked), dermatology with and without an active referral, an expired referral,
  imaging with and without an order, a patient under 18 seeing only pediatrics-capable
  providers, inactive insurance with and without self-pay, "my usual doctor," a time of
  day preference, "more options," the 90-day horizon, a clinic holiday, a 40-minute
  physical not overlapping a 15-minute visit, a race lost to a competing hold, an expired
  hold, read-back declined, "maybe" treated as no, a repeated `book` being idempotent, a
  reschedule that books new before cancelling old, a reschedule failure leaving the
  original appointment intact, a cancellation inside 24 hours with the late-cancellation
  notice, no availability within the access target leading to another provider, a
  waitlist entry, SMS with and without consent, a Spanish caller, DTMF `1`, `2`, `3`,
  `0`, and `*`, a person request in and after hours, the 6-minute wrap-up, the 7-minute
  cap releasing a hold, two no-inputs, and a prompt-injection attempt to skip
  verification, override an eligibility rule, or book without a read-back.
- No booking, reschedule, or cancellation happens without verification (or a redeemed
  token), every eligibility rule passing, a live hold, and an explicit yes in the
  caller's last utterance.
- Two concurrent callers can never hold or book overlapping time for the same provider.
- A failed reschedule never cancels the original appointment.
- The model context never contains phone numbers, dates of birth, medical record numbers,
  patient IDs, insurance details, or the stored reason for visit.
- A confirmation text never contains the visit type, reason, or provider, and is sent
  only with SMS consent.
- The opening line discloses that the caller is talking to an automated assistant.
- Utterance text and audio are absent from the database unless `TRANSCRIPT_RETENTION` is
  on, and stored transcripts have names and dates of birth masked.
- `GET /health` reports application, Voice Live, ACS, the Teams resource account, the
  schedule adapter and database path, whether the database is shared with the reminder
  sample, SMS mode, active holds, and simulation mode.
- `GET /api/stats` reports calls, the verified rate, bookings completed (new and
  reschedule), cancellations, abandonment after verification broken down by step
  (eligibility, search, hold, confirm), eligibility blocks by rule, holds expired or lost
  to a race, waitlist and callback entries, escalations by destination, after-hours
  bookings, reminder handoffs received and converted, median time to book, and scheduler
  hours saved (bookings × `SCHEDULER_MINUTES_PER_BOOKING`).

## Production gates and non-goals

The sample does not register new patients, connect to a live EHR or practice-management
system, check eligibility with a payer, give clinical advice, triage symptoms beyond the
phrase lists, take payments, or record audio. Before real use, the following are needed:

- An implemented and tested scheduling adapter (for example FHIR R4 `Slot`, `Schedule`,
  and `Appointment`), running with a least-privilege service identity, with the
  scheduling system as the source of truth for holds and conflicts.
- Clinical review of visit types, durations, eligibility rules, the emergency and
  urgent-symptom phrase lists, prep text, and nurse-line routing.
- Real eligibility and referral checks against the payer and referral systems.
- HIPAA and privacy review of identity verification, proxy authorization, handoff
  tokens, what each transfer destination receives, SMS content, and retention.
  Microsoft's HIPAA offering covers in-scope Azure services under a business associate
  agreement; the deploying organization still owns its own compliance.
- SMS consent capture and opt-out handling, toll-free or 10DLC number registration, and
  review of message content.
- Accessibility review, including relay callers, the DTMF path, and spoken date formats.
- Teams Phone and resource account licensing, validated Event Grid subscriptions, warm
  compute, and managed identity or Key Vault for credentials.

Primary measures are bookings completed, abandonment, and scheduler hours saved.

## Microsoft reference contracts

- [Teams Phone extensibility overview](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-overview)
- [Answer Teams Phone calls with Call Automation](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-answer-teams-calls)
- [Interactive voice response and transfer with Teams Phone extensibility](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-interactive-voice-response)
- [Plan Teams auto attendants and call queues](https://learn.microsoft.com/microsoftteams/plan-auto-attendant-call-queue)
- [Create a Teams call queue](https://learn.microsoft.com/microsoftteams/create-a-phone-system-call-queue)
- [Set up holidays in Teams](https://learn.microsoft.com/microsoftteams/set-up-holidays-in-teams)
- [Call Automation overview](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation)
- [Audio streaming with Call Automation](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/audio-streaming-quickstart)
- [Control mid-call media actions, including continuous DTMF](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/control-mid-call-media-actions)
- [Call Automation transfer to a participant](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/actions-for-call-control#transfer-a-participant-in-a-call)
- [Send an SMS with Azure Communication Services](https://learn.microsoft.com/azure/communication-services/quickstarts/sms/send)
- [SMS concepts, including opt-out handling](https://learn.microsoft.com/azure/communication-services/concepts/sms/concepts)
- [SMS FAQ, including toll-free verification](https://learn.microsoft.com/azure/communication-services/concepts/sms/sms-faq)
- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [Voice Live API how-to — endpoint, api-version, and Entra auth](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to)
- [Voice Live language support](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-language-support)
- [Azure Health Data Services FHIR service overview](https://learn.microsoft.com/azure/healthcare-apis/fhir/overview)
- [HIPAA and Microsoft Azure](https://learn.microsoft.com/azure/compliance/offerings/offering-hipaa-us)
