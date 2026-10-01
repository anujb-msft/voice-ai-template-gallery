# Contextual On-Call Pager — Sample Specification

**Status:** implementation guide for an illustrative, demo-grade sample. This is not a
production emergency or paging system. Its on-call schedule and tenant roster are local
fixtures, and its triage rules and escalation timings are examples to replace with the
organization's own.

Rows marked † were not asked individually. They are inherited from the gallery baseline
shared with the intent-based call routing sample, or are defaults to confirm during
review.

## Scope decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Entry point † | Inbound on a Teams Phone resource account via Teams Phone extensibility, with a plain ACS number as a documented fallback. Outbound pages and tenant calls present the same line number as caller ID |
| 2 | Scenario | Contoso Property Management after-hours maintenance line. A tenant reports an urgent issue such as a leak, no heat, or a lockout, and the agent pages the on-call maintenance technician |
| 3 | Request capture | Inbound voice intake by the same agent: property, unit, issue, severity, access notes, permission to enter, and callback number. A voicemail-transcript input path is documented as an alternative, not built |
| 4 | Triage | Server-side rules in config. **Emergency** (fire, gas smell, injury): the caller is told to hang up and call 911, then the tech is paged. **Urgent** (active leak, no heat below a threshold, lockout, no power): page now. **Routine**: log a work order for business hours, with no page |
| 5 | Tenant identification | Caller ID matched against a tenant roster fixture to prefill property and unit, which are confirmed aloud. Unknown callers state the property and unit, validated against the property list. No PIN |
| 6 | On-call schedule | Local JSON rotation (weekly rotations per property group, with overrides for swaps and holidays). An adapter interface is documented for PagerDuty, Opsgenie, or Teams Shifts |
| 7 | Contact method | Outbound ACS PSTN call to the tech's mobile. The agent speaks a 2–3 sentence brief and answers questions about the ticket. A Teams Workflows card with the full details is sent in parallel |
| 8 | Acknowledgement | The tech says "I've got it" or presses `1` to accept. Pressing `2` or saying "can't take it" declines and escalates immediately. Answering-machine detection leaves only a callback prompt, with no details, and counts as not acknowledged |
| 9 | Escalation | Primary called up to 2 times 3 minutes apart, then secondary up to 2 times, then the property manager. Emergencies use 1-minute gaps. With no acknowledgement after 20 minutes, the Teams ops channel is alerted and the tenant gets a status call |
| 10 | Tenant follow-up | After acknowledgement, an automated status call tells the tenant a technician has the request. The tech's number is never shared. The tech can press `3` during the page to be bridged directly to the tenant |
| 11 | Duplicates | A call about the same unit within 2 hours attaches to the open incident instead of paging again, unless the severity rises |

## Implementation decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Voice Live model † | `gpt-realtime`, configurable, used for both the tenant intake and the tech page |
| 2 | Session mode † | Direct model mode, with a documented path to Foundry agent mode |
| 3 | Credentials † | `DefaultAzureCredential` preferred, with an API key as the quick-start fallback |
| 4 | Offline runnability † | Full local mode. Typed transcripts drive both the intake and the page conversations, and a simulated clock advances the escalation scheduler |
| 5 | Verification † | Automated fixtures with `node:test`, plus a manual live-call checklist |
| 6 | Brief generation | Structured fields captured by server tools during intake fill a server template (property, unit, issue, severity, access notes, time reported). The model may add one short note, capped in length and labeled "tenant said" |
| 7 | Durability | Incidents, page attempts, and escalation timers are persisted in SQLite. A scheduler resumes pending pages after a restart |
| 8 | Answering-machine handling † | Call Automation answering-machine detection where available. Otherwise, no acknowledgement within 30 seconds of answer is treated as not acknowledged |
| 9 | Transcript retention † | Events, incident fields, and page attempts are stored at rest. Full transcripts stay in memory unless persistence is opted in |
| 10 | Bridge † | `AddParticipant` adds the tenant's number to the tech's call, and the agent leaves the media path. Neither party hears the other's number |

## Experience decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Fictional org † | Contoso Property Management |
| 2 | AI disclosure † | Both the tenant intake and the tech page open by saying they are an automated assistant |
| 3 | Safety line † | Any emergency keyword triggers the 911 instruction before anything else is asked |
| 4 | Read-back † | Callback number read back in digit groups, and unit number confirmed, before the incident is saved |
| 5 | Intake call cap † | 5 minutes, configurable. Page calls are capped at 3 minutes |
| 6 | Tech DTMF † | `1` accept, `2` decline, `3` bridge to tenant, `*` repeat the brief |
| 7 | Realtime transport † | Local WebSocket only, with no SignalR dependency |
| 8 | Default port † | `8095`, so it runs alongside the earlier samples on `8090`–`8094` |
| 9 | Gallery card † | Visual scene updated to depict the intake, page, acknowledge, and escalate flow when the sample lands |
| 10 | Tenant closing † | The agent tells urgent callers a technician is being contacted now, and routine callers that the office will follow up next business day |

## Goal

Build a runnable voice agent that takes after-hours maintenance calls for Contoso
Property Management, decides whether a technician must be woken up, and then calls the
current on-call technician with a short, accurate brief. It keeps calling down the
escalation chain until someone acknowledges and tells the tenant what is happening. This
replaces manual pager coordination and shortens the time from report to acknowledgement.

The agent is an intake and paging coordinator, not a dispatcher or safety service. It
never promises an arrival time, never gives repair instructions beyond a configured
safety line (for example, "shut off the water valve under the sink if you can do so
safely"), and always sends emergencies to 911 first.

The demo data lives in `config/`:

| File | Contents |
|---|---|
| `properties.json` | Property ID, name, address, aliases, property group, and the property manager |
| `tenants.json` | Tenant name, normalized phone, property, and unit |
| `oncall.json` | Technicians (ID, name, mobile, Teams user ID), weekly rotations per property group (primary and secondary), and dated overrides |
| `triage.json` | Keyword and slot rules for `emergency`, `urgent`, and `routine`, the no-heat temperature threshold, and safety lines per issue type |
| `escalation.json` | Attempts per level, gaps in minutes for urgent and emergency, the unacknowledged alert limit, and the duplicate window |

An example escalation policy:

```json
{
  "levels": ["primary", "secondary", "propertyManager"],
  "attemptsPerLevel": 2,
  "gapMinutes": { "urgent": 3, "emergency": 1 },
  "unacknowledgedAlertMinutes": 20,
  "duplicateWindowMinutes": 120
}
```

## Caller experience

1. A tenant dials the maintenance line, which is a Teams Phone resource account linked
   to ACS through Teams Phone extensibility. The server answers through Call Automation,
   starts media streaming, and opens a Voice Live session.
2. The agent greets the tenant: **"Contoso Property Management maintenance line. I'm an
   automated assistant. If anyone is in danger, or you smell gas or see fire, hang up
   and call 911 now. Otherwise, what's the problem?"**
3. The server matches the caller ID against the roster. On a match, the agent confirms:
   **"Is this about unit 4B at Maple Court?"** Otherwise, the tenant states the property
   and unit, which are validated against the property list.
4. The agent collects the issue, any details needed by the triage rules (for example,
   whether water is actively leaking, or the indoor temperature), access notes, and
   permission to enter. It confirms the callback number by read-back.
5. The server classifies the issue. For an emergency, the agent repeats the 911
   instruction and ends the call, and paging starts. For an urgent issue, the agent says
   **"I'm contacting the on-call technician now. You'll get a call back when they have
   it."** It gives any configured safety line. For a routine issue, it logs a work order
   and says the office will follow up next business day.
6. If the unit already has an open incident from the last 2 hours, the agent says the
   technician is already being contacted and attaches the new details. A higher severity
   restarts paging at the new level's timing.
7. The server resolves the on-call technician from the rotation and overrides, and places
   an outbound call. The Teams card is posted at the same time.
8. The technician hears: **"This is the Contoso maintenance automated pager. Urgent: active
   leak at Maple Court, unit 4B, reported 11:42 PM. Tenant gave permission to enter. Tenant
   said water is coming through the kitchen ceiling. Press 1 or say 'I've got it' to
   accept."** The tech can ask questions about the ticket, press `*` to repeat, `2` to
   decline, or `3` to be connected to the tenant.
9. If there is no acknowledgement, the scheduler retries and escalates by the policy. An
   answering machine hears only **"Contoso maintenance has an urgent page for you. Please
   call the maintenance line."**
10. On acknowledgement, the server records the time and places a status call to the
    tenant: **"A technician has your request and will call you shortly."** If no one has
    acknowledged after 20 minutes, the ops channel is alerted and the tenant gets a
    status call saying the team is still working to reach a technician.

## Architecture and implementation shape

```text
Tenant (PSTN)
   → Teams Phone service number / resource account   (fallback: plain ACS number)
   → ACS Call Automation (Event Grid, callbacks, call control, media streaming)
   ↔ Node.js 22 pager service
       ↔ Azure AI Voice Live API over WebSocket (intake + page sessions)
       ↔ triage rules + properties + tenant roster + on-call rotation
       ↔ SQLite incidents, page attempts, scheduler jobs, and audit log
       ↔ presenter console over a local WebSocket
   → ACS outbound call to technician mobile (+ AddParticipant bridge to tenant)
   → ACS outbound status call to tenant
   → Teams Workflows webhook (tech card, ops channel alert)
```

Reuse the password-reset sample's Express server, configuration pattern, ACS-to-Voice
Live media bridge, PCM16 24-kHz path, barge-in handling, SQLite event log, health
endpoint, and simulation-mode conventions.

The incident state machine is:

`open → paging(level, attempt) → acknowledged → tenantNotified → closed`, with
`paging → escalated(next level)`, `paging → unacknowledgedAlert`, and a `routine` branch
that goes straight to `workOrderLogged`.

Intake tools:

- `identify_unit(property?, unit?)` returns the roster match or validates a stated unit.
- `record_issue(fields)` stores structured fields and returns the missing slots the
  triage rules need.
- `classify_and_submit()` runs the triage rules, deduplicates, and returns the severity
  and the phrase to speak. The model never picks the severity.
- `end_call(reason)` closes the call.

Page tools:

- `get_ticket_detail(field)` answers a technician question from the stored fields only.
- `acknowledge()`, `decline(reason?)`, and `bridge_to_tenant()` change the incident
  state. The model never sees phone numbers.

The scheduler is a SQLite job table polled every few seconds. Each job has an incident,
a level, an attempt number, and a due time. Jobs are idempotent, so a restart or a
duplicate callback never places a second call for the same attempt. An acknowledgement
cancels every pending job for the incident.

## Teams handoff contract

This sample does not transfer inbound calls to a Teams queue. Teams is used for
notifications:

- **Technician card:** property, unit, issue, severity, access notes, the "tenant said"
  note, time reported, and incident ID. It is posted through `TEAMS_WORKFLOW_URL` with the
  tech's Teams user ID for the @mention.
- **Ops channel alert:** posted at the unacknowledged limit, with every attempt and its
  outcome.

A documented extension routes the tenant to a Teams Call Queue during business hours
with `CallTopic` set to the issue and `CallContext` set to the brief.

## Demo surface and configuration

The presenter console shows the intake transcript, the triage decision with the matched
rule, the resolved on-call chain, a timeline of page attempts with outcomes, the
scheduler queue, and the acknowledgement and tenant-notification status. Controls let
the presenter answer a simulated page as the technician (accept, decline, no answer, or
voicemail) and **Advance clock** to show escalation without waiting. The console is
marked as a demo surface.

Configuration covers `PORT` (`8095`), `PUBLIC_BASE_URL`, `ACS_ENDPOINT` (with
`ACS_CONNECTION_STRING` as the fallback), `ACS_OUTBOUND_CALLER_ID`,
`VOICE_LIVE_ENDPOINT`, `VOICE_LIVE_MODEL` (`gpt-realtime`), and `VOICE_LIVE_API_VERSION`
(`2026-04-10`), with Entra auth using the **Cognitive Services User** and **Foundry
User** roles and the `https://ai.azure.com/.default` scope. It also covers
`TEAMS_WORKFLOW_URL`, `TEAMS_OPS_WORKFLOW_URL`, `DEMO_NOW` (pins the clock for the
rotation and scheduler), `INTAKE_TIME_BUDGET_MS` (`300000`), `PAGE_TIME_BUDGET_MS`
(`180000`), and a single `LOCALE`/`VOICE` pair.

With no Azure subscription, the typed-transcript mode drives the same intake, triage,
rotation lookup, scheduler, and acknowledgement logic. Only audio, outbound calls, the
bridge, and Teams delivery are simulated. The sample ships a README, `DEMO-SCRIPT.md`,
the Teams provisioning snippet, the config fixtures, and the call fixtures.

## Acceptance criteria

- A real call to the provisioned number is answered through Teams Phone extensibility
  and connected to Voice Live. A real outbound page reaches a test mobile, accepts a
  voice and a DTMF acknowledgement, and bridges to the tenant. All are verified by the
  manual live-call checklist.
- Barge-in works, and duplicate Event Grid deliveries do not create duplicate incidents
  or duplicate page calls.
- `node:test` runs the fixtures with no cloud credentials. They cover a roster match, an
  unknown caller with a valid unit, an invalid unit, an emergency, an urgent leak, no heat
  above and below the threshold, a lockout, a routine request, a duplicate within 2 hours,
  a duplicate with higher severity, a primary accept on the first attempt, a primary no
  answer then accept on the second, a primary decline, escalation to secondary and then to
  the property manager, the unacknowledged alert, an answering machine, a rotation
  override, a holiday rotation, a bridge to the tenant, a scheduler restart mid-escalation,
  and a prompt-injection attempt in the tenant's note.
- Severity is computed only by the server. Emergencies always hear the 911 instruction
  before any other question.
- Answering machines never hear the property, unit, or issue.
- Phone numbers never reach the model, and the tech's number is never spoken to the
  tenant.
- The page brief matches the server template, and the "tenant said" note never exceeds
  its length cap.
- Both conversations disclose that the listener is talking to an automated assistant.
- Utterance text is absent from the database unless transcript persistence is enabled.
- `GET /health` reports application, Voice Live, Teams Phone provisioning, outbound
  calling, scheduler lag, pending jobs, the current on-call per property group, and
  simulation mode.
- `GET /api/stats` reports incidents by severity, median and 90th-percentile time to
  acknowledge, successful contacts (acknowledged incidents over paged incidents), median
  escalation time, pages per incident, unacknowledged incidents, duplicates attached, and
  routine work orders logged.

## Production gates and non-goals

The sample does not dispatch emergency services, integrate a real on-call or work-order
system, send SMS, record calls, estimate arrival times, or support multiple languages.
Before real use, the following are needed:

- Integration with the organization's on-call tool and work-order system.
- Review of triage rules and safety lines with property operations and legal, including
  local habitability requirements such as heat.
- Consent and working-hours rules for calling staff mobiles, and contact permission for
  outbound calls to tenants.
- A redundant paging path (for example, SMS or a push notification) so a single telephony
  failure cannot suppress a page.
- Accessibility review, including TTY and relay access.
- Validated Event Grid subscriptions, warm compute on the answer path, a durable
  scheduler with high availability, and managed identity or Key Vault for webhook
  secrets.
- Applicable Teams certification and organizational reviews.

Primary measures are time to acknowledge, successful contacts, and escalation time.

## Microsoft reference contracts

- [Teams Phone extensibility overview](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-overview)
- [Answer Teams Phone calls with Call Automation](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-answer-teams-calls)
- [Call Automation: make an outbound call](https://learn.microsoft.com/azure/communication-services/quickstarts/call-automation/quickstart-make-an-outbound-call)
- [Call Automation: add and remove participants](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/add-participant)
- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [Voice Live API how-to — endpoint, api-version, and Entra auth](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to)
- [Create incoming webhooks with Workflows for Microsoft Teams](https://support.microsoft.com/office/create-incoming-webhooks-with-workflows-for-microsoft-teams-8ae491c7-0394-4861-ba59-055e33f75498)
