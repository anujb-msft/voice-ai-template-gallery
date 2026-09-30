# 311 Service Assistant — Sample Specification

**Status:** implementation guide for an illustrative, demo-grade sample. This is not a
production 311 system. Its service catalog, address fixture, department directory, and
case store are local fixtures, and its duplicate radius, priority rules, and retention
setting are examples to replace with the city's own.

Rows marked † were not asked individually. They are inherited from the gallery baseline
shared with the intent-based call routing sample, or are defaults to confirm during
review.

## Scope decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Entry point † | Teams Phone resource account via Teams Phone extensibility, with a plain ACS number as a documented fallback |
| 2 | Scenario | The City of Contoso (population about 150,000) runs one public 311 number. The sample handles 6 report types (pothole, streetlight out, missed trash pickup, graffiti, abandoned vehicle, noise complaint) and FAQ answers on trash schedules, permits, hours, and fees |
| 3 | FAQ grounding | A local Markdown corpus in the same front-matter format as the general inquiry agent, with the same fresh, stale, and expired rules and spoken source names |
| 4 | Location | A spoken street address or intersection is normalized and validated against a local address and street-centerline fixture with fuzzy matching, then read back for confirmation. Landmarks ("in front of the library") are stored as a note. Azure Maps geocoding is the documented live adapter |
| 5 | Case system | A local SQLite case store issues a spoken case number such as `SR-24-0193`, read in groups. An Open311 GeoReport v2 adapter interface is documented for a real 311 system. Callers can check the status of an existing case by number |
| 6 | Intake | A JSON schema per request type lists required and optional fields. The server tracks the missing fields and the model asks only for those |
| 7 | Duplicates | An open case of the same type within 50 m in the last 7 days is a duplicate. The caller's report is attached to it and its "me too" count goes up. The caller hears the existing case number |
| 8 | Emergencies | A server-side keyword and intent guard (fire, gas smell, crime in progress, downed power line, medical emergency) interrupts at once with "Please hang up and dial 911", or the gas utility's line for gas. The event is logged and no intake happens |
| 9 | Priority hazards | Hazards that are not emergencies, such as a large pothole in a travel lane or a traffic signal that is out, are flagged priority. In business hours they are routed to the owning department's live queue |
| 10 | Routing | A department directory (Public Works, Sanitation, Parking Enforcement, Code Enforcement, Clerk) lists each department's Teams queue, hours, and the request types it owns. The default target is a 311 live-agent queue |
| 11 | Guided service | One guided flow, bulk-item pickup scheduling. Other multi-step services (permits, business licenses) get a spoken step-by-step walkthrough from the corpus, plus an optional SMS link to the online form sent through ACS SMS with the caller's consent |
| 12 | Languages | English and Spanish. Voice Live detects the caller's language and the agent replies in it. The corpus and prompts exist in both locales |

## Implementation decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Voice Live model † | `gpt-realtime`, configurable |
| 2 | Session mode † | Direct model mode, with a documented path to Foundry agent mode |
| 3 | Credentials † | `DefaultAzureCredential` preferred, with an API key as the quick-start fallback |
| 4 | Offline runnability † | Full local mode, where a typed transcript drives the real state machine, retrieval, address matching, intake schema, duplicate check, and routing rules |
| 5 | Verification † | Automated fixtures with `node:test`, plus a manual live-call checklist |
| 6 | Case adapter | A `CaseStore` interface with `create`, `findDuplicates`, `attach`, and `getStatus`. The sample ships `SqliteCaseStore`. An `Open311CaseStore` is documented, not built |
| 7 | Geocoder | A `Geocoder` interface. The sample ships `FixtureGeocoder` over `addresses.json` and `streets.json`. An `AzureMapsGeocoder` is documented, not built |
| 8 | Duplicate check | Same request type, status open, within `DUPLICATE_RADIUS_M` (`50`) and `DUPLICATE_WINDOW_DAYS` (`7`), computed server-side with the haversine distance |
| 9 | Personal data | Name and callback number stay out of the model context. The model sees only that they were provided |
| 10 | Transcript retention † | Events and case records are stored at rest. The full transcript stays in memory unless persistence is opted in. Case records follow `CASE_RETENTION_DAYS` |
| 11 | Handoff mechanics † | Blind `TransferCallToParticipant` to the department or 311 queue, carrying `CallTopic` and `CallContext` |

## Experience decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Fictional org † | City of Contoso |
| 2 | AI disclosure † | The agent says it is an automated assistant in its opening line |
| 3 | Identity | Anonymous reporting is the default. Name and callback number are optional, offered with "Would you like updates on this case?" Caller ID is used only with consent |
| 4 | Status privacy | A status check by case number returns only the status and the owning department, never the reporter's details |
| 5 | Accessibility | Slower speech and repeats on request. Case numbers are read in groups and repeated. DTMF `1`/`2` works for yes and no. Relay and TTY callers are directed to the relay transfer path |
| 6 | Multi-intent | An "anything else?" loop allows up to 3 requests per call |
| 7 | Call cap | 5 minutes, configurable, with a wrap-up prompt at 4:30 |
| 8 | Escalation | Transfer when the caller asks for a person, the topic is out of scope, the agent fails twice, or a priority hazard arrives in business hours. After hours, the agent captures the request and states the next-business-day follow-up |
| 9 | DTMF † | `0` transfers to the 311 live-agent queue in business hours. `*` repeats the last phrase |
| 10 | Realtime transport † | Local WebSocket only, with no SignalR dependency |
| 11 | Default port † | `8096`, so it runs alongside the other gallery samples on `8090`–`8095` |
| 12 | Gallery card † | Visual scene updated to depict the report, location, and case-number flow when the sample lands |

## Goal

Build a runnable inbound voice agent for the City of Contoso's 311 line. It should answer
common civic questions from approved content, take service requests with a validated
location, give callers a case number they can use later, and route to the right
department when a person is needed. It should do this in English and Spanish, without
asking callers to identify themselves.

The agent is a front desk, not a dispatcher. It never promises a repair date, never
decides a request is not the city's responsibility, and never handles an emergency
beyond telling the caller to dial 911.

The demo data lives in `config/` and `content/`:

| File | Contents |
|---|---|
| `content/articles/{en,es}/*.md` | FAQ corpus with the general inquiry front matter (`id`, `title`, `topic`, `owner`, `source`, `shortUrl`, `lastReviewed`, `reviewBy`) |
| `config/request-types.json` | Per request type: ID, spoken names in both locales, owning department, required and optional fields, priority rules, and the duplicate policy |
| `config/departments.json` | Department ID, display name, Teams queue target, hours, time zone, and owned request types |
| `config/addresses.json` / `streets.json` | Address points and street centerlines with coordinates, used to validate addresses and intersections |
| `config/bulk-pickup.json` | Eligible items, per-call item limit, and the pickup calendar with open slots by zone |
| `config/emergency.json` | Emergency phrases in both locales and the redirect line for each category (911 or the gas utility) |
| `config/holidays.json` | City holidays that close the departments |

An example request type:

```json
{
  "id": "pothole",
  "names": { "en": ["pothole", "hole in the road"], "es": ["bache"] },
  "department": "public-works",
  "required": ["location", "size"],
  "optional": ["inTravelLane", "landmark"],
  "fields": {
    "size": { "type": "enum", "values": ["small", "medium", "large"] },
    "inTravelLane": { "type": "boolean" }
  },
  "priorityWhen": { "size": "large", "inTravelLane": true },
  "duplicate": { "radiusM": 50, "windowDays": 7 }
}
```

## Caller experience

1. The caller dials the City of Contoso 311 number, which is a Teams Phone resource
   account linked to ACS through Teams Phone extensibility. The documented ACS number
   fallback only changes provisioning.
2. Event Grid delivers `IncomingCall`. The server answers through Call Automation,
   starts bidirectional media streaming, and opens a Voice Live session.
3. The agent greets the caller: **"City of Contoso 311. I'm an automated assistant.
   For emergencies, hang up and dial 911. How can I help? Para español, hable en
   español."** When the caller speaks Spanish, the session switches to the Spanish
   prompts, corpus, and voice.
4. If the caller says anything that matches the emergency guard, the server interrupts
   the model and the agent says **"This sounds like an emergency. Please hang up and dial
   911 now."** For a gas smell, it gives the gas utility's line instead. The agent does
   no intake, logs the redirect, and ends the call.
5. **FAQ.** For "When is trash pickup on Maple Street?", the agent calls `search_faq`
   and answers from the retrieved passage, naming the source. Stale content gets a
   caveat. Expired or missing content gets **"I don't have approved information on
   that"** and an offer to connect to 311 staff.
6. **Report.** For "There's a pothole on Oak and 5th", the agent calls
   `start_request("pothole")`. It then calls `resolve_location` and reads back **"Oak
   Avenue at 5th Street — is that right?"** The server returns the missing fields and
   the agent asks only for those: **"Is it small, medium, or large? Is it in a travel
   lane?"**
7. Before creating the case, the server runs the duplicate check. If a match exists,
   the agent says **"That pothole was already reported, case S R, 2 4, 0 1 9 3. I've
   added your report to it."** Otherwise the agent creates the case and reads the new
   number in groups, twice.
8. The agent asks **"Would you like updates on this case?"** If yes, it asks for a name
   and confirms the callback number, using caller ID only if the caller agrees. If no,
   the case is anonymous.
9. If the report is a priority hazard and the owning department is open, the agent says
   **"I'm connecting you with Public Works now"** and transfers after the case is
   created. After hours, it says **"Public Works will follow up on the next business
   day."**
10. **Status.** For "What's the status of SR-24-0193?", the agent calls `get_case_status`
    and speaks only the status and department, for example **"That case is in progress
    with Public Works."**
11. **Guided service.** For bulk-item pickup, the agent checks each item against the
    eligible list, finds the next open date for the caller's zone, confirms it, and
    reads a case number. For a permit or business license, it walks through the steps
    from the corpus and asks **"Would you like a text with the link to the online
    form?"** It sends the SMS only after a yes.
12. After each request, the agent asks **"Is there anything else?"** It handles up to 3
    requests per call. The agent transfers when the caller asks for a person, the topic
    is out of scope, or it fails twice. It says **"We're almost out of time"** at 4:30,
    and the 5-minute cap (`CALL_TIME_BUDGET_MS`) or two no-inputs end the call politely.

## Architecture and implementation shape

```text
PSTN caller
   → Teams Phone service number / resource account   (fallback: plain ACS number)
   → ACS Call Automation (Event Grid, callbacks, call control, media streaming)
   ↔ Node.js 22 311 service
       ↔ Azure AI Voice Live API over WebSocket (en / es)
       ↔ emergency guard (runs on every final transcript before the model acts)
       ↔ content index (content/articles/{en,es}) + freshness evaluator
       ↔ Geocoder (FixtureGeocoder: addresses.json + streets.json)
       ↔ intake engine (request-types.json) + CaseStore (SQLite)
       ↔ department directory + hours + holidays
       ↔ ACS SMS (consented form links only)
       ↔ SQLite audit log + stats endpoint
       ↔ presenter console over a local WebSocket
   → ACS transfer to department queue or 311 live-agent queue
```

Reuse the password-reset sample's Express server, configuration pattern, ACS-to-Voice
Live media bridge, PCM16 24-kHz path, barge-in handling, SQLite event log, health
endpoint, and simulation-mode conventions. Reuse the general inquiry agent's content
loader, retrieval, and freshness evaluator unchanged. The state machine is:

`ringing → greeting → listening → (answering | intake → confirming → filed | status | guided) → listening … → (transferring → transferred) | (emergency_redirect → ended) | closing → ended`

The emergency guard runs server-side on each final caller transcript. When it matches, it
cancels the current model response, injects the redirect phrase, and moves the call to
`emergency_redirect` no matter what state it was in.

The model changes state only through server-owned tools:

- `search_faq(query)` returns passages with source, freshness, and a spoken citation.
- `start_request(type)` opens an intake and returns the missing required fields.
- `resolve_location(utterance)` returns a normalized address or intersection, a
  confirmation phrase, and `ambiguous` with candidates when needed. Unmatched input is
  returned as `unverified` and may be kept only as a landmark note.
- `set_field(name, value)` validates a field against the schema and returns the fields
  still missing.
- `submit_request()` runs the duplicate check. It then attaches to the existing case or
  creates a new one, and returns the spoken case-number phrase and the priority flag.
- `set_contact(wantsUpdates, useCallerId?, name?)` stores contact details against the
  case outside the model context.
- `get_case_status(caseNumber)` returns a phrase with only the status and department.
- `bulk_pickup(items)` checks eligibility and returns the next open date. The
  `confirm_bulk_pickup()` tool books the date and returns the case number.
- `send_form_link(serviceId)` sends the consented SMS to the caller ID.
- `transfer(reason, department?)` checks hours and holidays, then either transfers or
  returns the after-hours phrase. The model never sees a Teams target or phone number.
- `repeat_last()` and `end_call(reason)`.

Case numbers are formatted by the server as `SR-YY-NNNN` and spoken as grouped
characters in the caller's language. Case notes are stored in English, with the
caller's original wording kept alongside when the call was in Spanish.

## Teams handoff contract

Transfers use `TransferCallToParticipant` to the department's Teams queue from
`config/departments.json`, or to the 311 live-agent queue by default. Relay and TTY
callers go to the configured relay target. The Teams Phone extensibility custom context
carries:

- `CallDetails.SessionId`: the Auto Attendant session ID when present, and otherwise the
  ACS correlation ID, which is kept in the audit record.
- `CallDetails.CallTopic`: for example `PRIORITY pothole – SR-24-0193`, up to 48
  characters.
- `CallDetails.CallContext`: the case number, request type, confirmed location, captured
  fields, caller language, and transfer reason. Reporter contact details are included
  only when the caller asked for updates.

After hours, no transfer is attempted. The request is captured and the agent speaks the
next-business-day follow-up.

## Demo surface and configuration

The presenter console shows call state, detected language, the live transcript, the
emergency guard's decisions, retrieved passages with freshness, the resolved location
and alternatives, the intake form filling in field by field, the duplicate check result,
and the case created or attached. A map-free case board lists open cases with their
"me too" counts, and a **Close case** control drives status-check demos. A department
board shows which queues are open, with an **After hours** toggle. The console is marked
as a demo surface.

Configuration covers `PORT` (`8096`), `PUBLIC_BASE_URL`, `ACS_ENDPOINT` (with
`ACS_CONNECTION_STRING` as the fallback), `ACS_SMS_FROM`, `VOICE_LIVE_ENDPOINT`,
`VOICE_LIVE_MODEL` (`gpt-realtime`), and `VOICE_LIVE_API_VERSION` (`2026-04-10`), with
Entra auth using the **Cognitive Services User** and **Foundry User** roles and the
`https://ai.azure.com/.default` scope. It also covers `LOCALES` (`en-US,es-US`) with a
voice per locale, `CASE_STORE` (`sqlite`), `GEOCODER` (`fixture`),
`DUPLICATE_RADIUS_M` (`50`), `DUPLICATE_WINDOW_DAYS` (`7`), `MAX_REQUESTS_PER_CALL`
(`3`), `CASE_RETENTION_DAYS`, `CONTENT_EXPIRY_GRACE_DAYS` (`90`), `DEMO_NOW` (pins the
clock for hours, freshness, and duplicate windows), and `CALL_TIME_BUDGET_MS`
(`300000`).

With no Azure subscription, the typed-transcript mode drives the same state machine,
guard, retrieval, geocoding, intake, and case store. Only audio, SMS, and the transfer
are simulated. The sample ships a README, `DEMO-SCRIPT.md`, the Teams provisioning
snippet, the config fixtures, the bilingual corpus, and the call fixtures.

## Acceptance criteria

- A real call to the provisioned number is answered through Teams Phone extensibility
  and connected to Voice Live. The ACS number fallback reaches the same state machine.
  An in-hours priority transfer reaches the department queue. All are verified by the
  manual live-call checklist.
- Barge-in works, and duplicate Event Grid deliveries do not create duplicate sessions.
- `node:test` runs the fixtures with no cloud credentials. They cover each of the 6
  report types end to end, a fresh FAQ answer, a stale answer, an expired answer, an FAQ
  miss, an exact address, an intersection, a misheard street fixed by fuzzy matching, an
  ambiguous street, an unverifiable location kept as a landmark, a missing required
  field, a duplicate within the radius and window, a near miss just outside the radius,
  a near miss just outside the window, an anonymous report, a report with updates and
  consented caller ID, a status check, a status check for an unknown case number, bulk
  pickup with an ineligible item, a permit walkthrough with SMS consent, a permit
  walkthrough with SMS declined, a priority hazard in hours, a priority hazard after
  hours, a holiday, each emergency category in English and Spanish, an emergency phrase
  mid-intake, a full Spanish report, a fourth request past the per-call limit, two
  failed attempts, a relay caller, `0` and `*` DTMF, two no-inputs, the wrap-up prompt,
  an expired call cap, and a caller prompt-injection attempt asking for another
  reporter's details.
- An emergency phrase always produces the redirect and never creates a case.
- Every case number is read back in groups and repeated. Every location is confirmed
  before a case is filed.
- A status check never reveals the reporter's name or number. The model context never
  contains a name, a callback number, or a Teams target.
- FAQ answers come only from retrieved passages, with the source named.
- The opening line discloses that the caller is talking to an automated assistant.
- Utterance text is absent from the database unless transcript persistence is enabled.
- `GET /health` reports application, Voice Live, Teams Phone provisioning, ACS SMS,
  corpus counts by freshness and locale, case store, geocoder, department hours status,
  and simulation mode.
- `GET /api/stats` reports calls, containment (calls with no transfer), requests by type
  and department, duplicates merged, emergency redirects by category, transfers by
  reason, calls by language, average handle time, guided-flow starts and completions,
  and SMS links sent.

## Production gates and non-goals

The sample does not connect to a real 311 or asset-management system, geocode with a
live service, send photos, handle payments, accept full permit applications by voice,
support languages beyond English and Spanish, or record calls. Before real use, the
following are needed:

- Department sign-off on the request-type schemas, priority rules, and duplicate policy.
- Integration with the city's 311 system through Open311 or its native API, and with its
  authoritative address and centerline data or Azure Maps.
- Review of the emergency guard and redirect wording with the 911 PSAP and gas utility,
  with testing for false negatives in both languages.
- Legal review of public-records law, retention periods, and the anonymous reporting
  policy.
- Accessibility review, including relay and TTY access, and language-access review of
  the Spanish content by a qualified translator.
- SMS consent and opt-out handling that meets telecom rules, and a registered sender.
- Content ownership and review cadence for the bilingual corpus.
- Validated Event Grid subscriptions, warm compute on the answer path, rate limits, and
  managed identity or Key Vault for credentials.
- Applicable Teams certification and organizational reviews.

Primary measures are containment, request completion, and time to resolution.

## Microsoft reference contracts

- [Teams Phone extensibility overview](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-overview)
- [Answer Teams Phone calls with Call Automation](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-answer-teams-calls)
- [Teams Phone extensibility IVR and transfer](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-interactive-voice-response)
- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [Voice Live API how-to — endpoint, api-version, and Entra auth](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to)
- [Voice Live language support](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-language-support)
- [Call Automation transfer to a participant](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/transfer-call)
- [Send an SMS message with Azure Communication Services](https://learn.microsoft.com/azure/communication-services/quickstarts/sms/send)
- [Azure Maps search (geocoding)](https://learn.microsoft.com/azure/azure-maps/how-to-search-for-address)
