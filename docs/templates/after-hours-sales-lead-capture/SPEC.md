# After-Hours Sales Lead Capture — Sample Specification

**Status:** implementation guide for an illustrative, demo-grade sample. This is not a
production sales system. Its CRM is a local SQLite store, and its qualification rules and
follow-up SLAs are examples to replace with the organization's own.

Rows marked † were not asked individually. They are inherited from the gallery baseline
shared with the intent-based call routing sample, or are defaults to confirm during
review.

## Scope decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Entry point † | Teams Phone resource account via Teams Phone extensibility, with a plain ACS number as a documented fallback |
| 2 | Scenario † | Contoso Industrial Supply, a manufacturer and distributor of fasteners, fittings, and packaging supplies |
| 3 | Coverage | Business-hours config (time zone, weekly hours, holidays). In hours, the call goes to the sales queue by blind transfer. After hours, or when the queue overflows, the agent captures the lead |
| 4 | Qualification | Light BANT-style: product interest, quantity or volume, timeline, and company and role, scored to `hot`, `warm`, or `cold`. No budget question |
| 5 | Captured fields | Name, company, callback phone (defaults to caller ID and is confirmed by read-back), email (spelled back), product interest, quantity, timeline, location or state, and notes |
| 6 | CRM | Local SQLite lead store only. The sample defines no external CRM adapter |
| 7 | Duplicates | A match on normalized E.164 phone or lowercased email within 30 days appends a note to the existing lead instead of creating a new one |
| 8 | Ownership | Round-robin across all active reps in `config/reps.json` |
| 9 | Notification | Teams message to the owning rep through a Teams Workflows webhook, plus an email summary. Hot leads also @mention the sales manager |
| 10 | Consent | AI disclosure only. Consent to follow-up is implied by the call. No SMS or marketing opt-in is collected |
| 11 | Product knowledge | A small product catalog JSON (lines, SKU families, minimum order quantities, typical lead times). The agent may state general information but never pricing, quotes, or availability commitments |
| 12 | Follow-up SLA | Hot within 1 business hour, warm by next business day, cold within 2 business days. Time to first response is measured from a rep's "contacted" mark in the console |
| 13 | Non-sales callers | Existing customers with order or service issues, spam or robocalls, and emergencies get the support number and hours or a polite close. Their calls are logged as `non-sales`, and no rep is assigned |

## Implementation decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Voice Live model † | `gpt-realtime`, configurable |
| 2 | Session mode † | Direct model mode, with a documented path to Foundry agent mode |
| 3 | Credentials † | `DefaultAzureCredential` preferred, with an API key as the quick-start fallback |
| 4 | Offline runnability † | Full local mode, where a typed transcript drives the real state machine, scoring, dedupe, assignment, and notification outbox |
| 5 | Verification † | Automated fixtures with `node:test`, plus a manual live-call checklist |
| 6 | Scoring † | Deterministic server-side rules in `config/qualification.json`. The model collects answers, and the server computes the score. The model never assigns a score |
| 7 | Notification delivery † | A durable outbox table. Live mode posts to `TEAMS_WORKFLOW_URL` and sends email through Azure Communication Services Email. Offline, the outbox is shown in the console and never sent |
| 8 | No-input policy † | Two reprompts, then save whatever was captured as a partial lead and close politely |
| 9 | Transcript retention † | Events, lead fields, and summaries are stored at rest. The full transcript stays in memory unless persistence is opted in |
| 10 | Handoff † | Blind `TransferCallToParticipant` to the configured sales Call Queue in hours, carrying `CallTopic` and `CallContext` |

## Experience decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Fictional org † | Contoso Industrial Supply |
| 2 | AI disclosure | The agent says it is an automated assistant in its opening line. There is no separate consent prompt |
| 3 | Read-back † | Phone number read back in digit groups, and email spelled back letter by letter, each confirmed before saving |
| 4 | Call cap † | 6 minutes, configurable, then the agent saves what it has and closes |
| 5 | Closing promise † | The agent states the SLA window for the caller's score in plain words, for example "someone from our sales team will call you within the hour" |
| 6 | DTMF † | `0` in hours transfers to the sales queue. After hours, `0` is acknowledged and the agent continues capture |
| 7 | Realtime transport † | Local WebSocket only, with no SignalR dependency |
| 8 | Default port † | `8093`, so it runs alongside the password-reset (`8090`), routing (`8091`), and general inquiry (`8092`) samples |
| 9 | Gallery card † | Visual scene updated to depict the capture, score, and notify flow when the sample lands |
| 10 | Transfer audio † | A spoken "connecting you with our sales team now", with no hold tone |

## Goal

Build a runnable inbound voice agent that answers Contoso Industrial Supply's sales line
when no one is available. It should capture a complete, confirmed lead, qualify it with
a small set of questions, save it without creating duplicates, assign it to a rep, and
notify that rep, so that a missed call becomes a timely callback instead of lost
pipeline.

The agent is a capture and qualification assistant, not a salesperson. It can describe
product lines in general terms, but it never quotes prices, confirms stock, or commits
to delivery dates. Those questions are recorded as notes for the rep.

The demo data lives in `config/`:

| File | Contents |
|---|---|
| `hours.json` | Time zone, weekly sales hours, holiday dates, sales Call Queue application ID, support number and hours for non-sales callers |
| `reps.json` | Rep ID, display name, email, Teams user ID for the @mention, `active` flag, and the sales manager |
| `qualification.json` | Scoring rules and point thresholds for `hot`, `warm`, and `cold` |
| `catalog.json` | Product lines, SKU families, minimum order quantities, and typical lead-time ranges |

An example qualification rule set:

```json
{
  "timeline": { "within30Days": 3, "within90Days": 2, "later": 0, "unknown": 0 },
  "quantity": { "atOrAboveMoq": 2, "belowMoq": 0, "unknown": 1 },
  "productInterest": { "catalogLine": 1, "other": 0 },
  "role": { "decisionMaker": 2, "influencer": 1, "unknown": 0 },
  "thresholds": { "hot": 6, "warm": 3 }
}
```

## Caller experience

1. The caller dials the Contoso Industrial Supply sales number, which is a Teams Phone
   resource account linked to ACS through Teams Phone extensibility. The documented ACS
   number fallback only changes provisioning.
2. Event Grid delivers `IncomingCall`. The server checks `config/hours.json`. In sales
   hours, it transfers to the sales queue. If the queue overflows or times out, the
   call arrives back at the agent. After hours, and on holidays, the server answers
   through Call Automation, starts bidirectional media streaming, and opens a Voice Live
   session.
3. The agent greets the caller: **"Thanks for calling Contoso Industrial Supply. I'm an
   automated assistant. Our sales team isn't available right now, but I can take your
   details and have the right person call you back. What are you looking for today?"**
4. The agent listens for the caller's need. If the caller is an existing customer with an
   order or service issue, the agent gives the support number and hours and closes. If
   the caller describes an emergency, the agent tells them to hang up and call emergency
   services. Spam and robocalls are closed politely. Each of these calls is logged with
   the lead type `non-sales`.
5. For a sales inquiry, the agent collects the product interest, quantity, timeline,
   company, role, and location or state through natural conversation. It may use
   `lookup_catalog` to confirm a product line or mention a typical minimum order
   quantity. If the caller asks for a price, stock, or a delivery date, the agent says
   **"I can't quote that, but I'll note it so your rep can give you an exact answer."**
6. The agent confirms contact details. It offers the caller ID as the callback number
   and reads it back in digit groups. It asks for an email address and spells it back.
   The caller can correct either one.
7. The agent calls `save_lead`. The server normalizes the phone number and email, checks
   for a match in the last 30 days, scores the lead, and assigns the next rep in the
   round-robin. A duplicate appends a note to the existing lead and keeps its owner.
8. The agent closes with the SLA window for the score: **"Thanks, Dana. Someone from our
   sales team will call you within the hour."** For warm leads it says "by the next
   business day", and for cold leads "within two business days". The score itself is
   never spoken.
9. The server writes a Teams message and an email summary for the owning rep to the
   outbox. Hot leads also @mention the sales manager. Live mode delivers them, and
   offline mode shows them in the console.
10. A 6-minute call cap (`CALL_TIME_BUDGET_MS`) applies throughout. When it expires, or
    after two no-inputs, the server saves any captured fields as a partial lead and the
    agent closes.

## Architecture and implementation shape

```text
PSTN caller
   → Teams Phone service number / resource account   (fallback: plain ACS number)
   → ACS Call Automation (Event Grid, callbacks, call control, media streaming)
   ↔ Node.js 22 lead-capture service
       ↔ Azure AI Voice Live API over WebSocket
       ↔ sales hours + catalog + qualification rules + rep roster
       ↔ SQLite lead store, notification outbox, and audit log
       ↔ presenter console over a local WebSocket
   → ACS transfer to sales Teams Call Queue (in hours)
   → Teams Workflows webhook + ACS Email (notifications)
```

Reuse the password-reset sample's Express server, configuration pattern, ACS-to-Voice
Live media bridge, PCM16 24-kHz path, barge-in handling, SQLite event log, health
endpoint, and simulation-mode conventions. The state machine is:

`ringing → routing → (transferring → transferred) | greeting → discovery → qualifying → confirming → saving → closing → ended`

A `non-sales` branch goes from `discovery` to `closing` without a save.

The model changes state only through server-owned tools:

- `lookup_catalog(query)` returns matching product lines with their SKU families,
  minimum order quantities, and lead-time ranges. It returns no prices or stock levels.
- `save_lead(fields)` validates and normalizes the fields and returns `leadId`,
  `duplicateOf` if a match was found, and the spoken `slaPhrase`. The server computes the
  score and owner. The model receives neither the score nor the rep's contact details.
- `classify_non_sales(kind)` logs `existing-customer`, `spam`, or `emergency` and returns
  the text the agent should say.
- `end_call(reason)` closes the call.

Phone numbers are normalized to E.164 and emails are lowercased and trimmed before the
duplicate check. Only one open lead per normalized contact exists in a 30-day window.
The round-robin pointer is stored in SQLite, so it survives restarts, and skips reps
marked inactive.

## Teams handoff contract

In-hours transfers use `TransferCallToParticipant` to the sales Call Queue configured in
`config/hours.json`, addressed with `MicrosoftTeamsAppIdentifier`. The Teams Phone
extensibility custom context carries:

- `CallDetails.SessionId`: the Auto Attendant session ID when present, and otherwise the
  ACS correlation ID, which is kept in the audit record.
- `CallDetails.CallTopic`: `Sales inquiry`, or the captured product line if the agent
  collected one before the transfer, up to 48 characters.
- `CallDetails.CallContext`: one or two sentences summarizing any captured need,
  quantity, and timeline.

After-hours leads are never transferred. They are delivered to the rep by notification.

## Demo surface and configuration

The presenter console shows the hours decision, call state, the live transcript, the
lead form filling in as fields are confirmed, the score breakdown by rule, the duplicate
check, the assigned rep, and the notification outbox. A leads view lists every lead with
its score, owner, SLA due time, and a **Mark contacted** action. The action records the
first-response time and whether it met the SLA. The console is marked as a demo surface
and never claims a message was delivered in simulation mode.

Configuration covers `PORT` (`8093`), `PUBLIC_BASE_URL`, `ACS_ENDPOINT` (with
`ACS_CONNECTION_STRING` as the fallback), `VOICE_LIVE_ENDPOINT`, `VOICE_LIVE_MODEL`
(`gpt-realtime`), and `VOICE_LIVE_API_VERSION` (`2026-04-10`), with Entra auth using the
**Cognitive Services User** and **Foundry User** roles and the
`https://ai.azure.com/.default` scope. It also covers `TEAMS_WORKFLOW_URL`,
`ACS_EMAIL_SENDER`, `DEDUPE_WINDOW_DAYS` (`30`), `DEMO_NOW`, `CALL_TIME_BUDGET_MS`
(`360000`), and a single `LOCALE`/`VOICE` pair. Business-hour SLA math uses the time
zone, weekly hours, and holidays in `config/hours.json`.

With no Azure subscription, the typed-transcript mode drives the same state machine,
scoring, dedupe, assignment, and outbox. Only audio, the in-hours transfer, and message
delivery are simulated. The sample ships a README, `DEMO-SCRIPT.md`, the Teams
provisioning snippet, the config fixtures, and the call fixtures.

## Acceptance criteria

- A real after-hours call to the provisioned number is answered through Teams Phone
  extensibility and connected to Voice Live. The ACS number fallback reaches the same
  state machine. An in-hours call is transferred to the sales queue without starting a
  Voice Live session. All three are verified by the manual live-call checklist.
- Barge-in works, and duplicate Event Grid deliveries do not create duplicate sessions or
  leads.
- `node:test` runs the fixtures with no cloud credentials. They cover a hot lead, a warm
  lead, a cold lead, a duplicate by phone, a duplicate by email, a repeat caller after 30
  days, a corrected phone read-back, a corrected email spelling, a caller with no email,
  a price and stock question, an existing customer with an order issue, an emergency, a
  robocall, an in-hours call, a holiday call, a queue overflow, two no-inputs with a
  partial lead, an expired call cap, round-robin across three reps with one inactive, a
  failed webhook delivery that stays in the outbox, and a caller prompt-injection attempt.
- The score and owner are computed only by the server. The model never speaks a score, a
  price, stock level, or delivery commitment.
- Every saved lead has a confirmed phone number or email. Non-sales calls never create a
  lead and never notify a rep.
- Hot-lead notifications @mention the sales manager. Warm and cold notifications do not.
- The opening line discloses that the caller is talking to an automated assistant.
- Utterance text is absent from the database unless transcript persistence is enabled.
- `GET /health` reports application, Voice Live, Teams Phone provisioning, hours status,
  active rep count, outbox backlog, and simulation mode.
- `GET /api/stats` reports calls, leads captured, qualified-lead rate (hot plus warm over
  all leads), leads by score, duplicates merged, non-sales calls by kind, partial leads,
  median time to first response, and the share of leads contacted within their SLA.

## Production gates and non-goals

The sample does not integrate a real CRM, collect marketing or SMS consent, quote prices,
check inventory, place orders, call leads back, record calls, or support multiple
languages. Its qualification rules and round-robin are deliberately simple. Before real
use, the following are needed:

- Integration with the system-of-record CRM, with its own duplicate and ownership rules.
- Legal review of implied consent, recording notices, and follow-up contact rules in each
  market served.
- Qualification criteria and SLAs agreed with sales and revenue operations.
- Accessibility review, including TTY and relay access.
- Validated Event Grid subscriptions, warm compute on the answer path, rate limits, and
  managed identity or Key Vault for webhook and email secrets.
- Applicable Teams certification and organizational reviews.

Primary measures are leads captured, qualified-lead rate, median time to first response,
and SLA attainment.

## Microsoft reference contracts

- [Teams Phone extensibility overview](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-overview)
- [Answer Teams Phone calls with Call Automation](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-answer-teams-calls)
- [Teams Phone extensibility IVR and transfer](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-interactive-voice-response)
- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [Voice Live API how-to — endpoint, api-version, and Entra auth](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to)
- [Azure Communication Services Email overview](https://learn.microsoft.com/azure/communication-services/concepts/email/email-overview)
- [Create incoming webhooks with Workflows for Microsoft Teams](https://support.microsoft.com/office/create-incoming-webhooks-with-workflows-for-microsoft-teams-8ae491c7-0394-4861-ba59-055e33f75498)
