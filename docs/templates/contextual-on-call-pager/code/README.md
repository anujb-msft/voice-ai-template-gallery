# Contextual On-Call Pager voice sample

A runnable Node.js 22 demo for the **Contextual On-Call Pager** template. Contoso Property Management tenants call an after-hours maintenance line, the server identifies the unit, computes severity with local rules, and pages the current on-call technician until somebody acknowledges.

The app is demo-grade, not an emergency dispatch or production paging system.

## What the demo shows

- AI disclosure in the first tenant and technician turns.
- Server-owned tenant roster lookup, triage, deduplication, on-call rotation, escalation, Teams notification payloads, and tenant status calls.
- Voice Live `gpt-realtime` direct mode over WebSocket (`api-version=2026-04-10`) for real calls.
- Full offline typed-transcript simulation with simulated outbound pages, acknowledgement, decline, voicemail, bridge-to-tenant, and clock advancement.
- SQLite persistence for incidents, page attempts, scheduler jobs, and audit events. Full transcripts are not stored unless `PERSIST_TRANSCRIPTS=true`.

## Quick start (offline first)

```bash
npm install --registry https://packagefeedproxy.microsoft.io/npm/ --no-audit --no-fund
npm test
npm run check
npm start
```

Open <http://127.0.0.1:8095>. The console runs a leak report and lets you accept, decline, no-answer, voicemail, bridge, or advance the simulated clock.

API-only smoke path:

```bash
curl http://127.0.0.1:8095/health
curl -X POST http://127.0.0.1:8095/api/simulate/intake \
  -H 'content-type: application/json' \
  -d '{"fromPhone":"+15551230001","pageOutcomes":["accept"],"transcript":["yes unit 4B at Maple Court","water is coming through the kitchen ceiling","permission to enter, lockbox at back door","call me at 555-123-0001"]}'
```

## Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Defaults to `8095`. |
| `PUBLIC_BASE_URL` | Public HTTPS URL for Event Grid, ACS callbacks, and media WebSocket. |
| `ACS_ENDPOINT` | Preferred ACS endpoint for `DefaultAzureCredential`. |
| `ACS_CONNECTION_STRING` | Quick-start fallback when keyless ACS auth is not configured. |
| `ACS_OUTBOUND_CALLER_ID` | Number presented for outbound technician and tenant status calls. |
| `VOICE_LIVE_ENDPOINT` | Azure AI Voice Live endpoint. |
| `VOICE_LIVE_API_KEY` | Optional API-key fallback; otherwise Entra auth is used. |
| `VOICE_LIVE_MODEL` | Defaults to `gpt-realtime`. |
| `VOICE_LIVE_API_VERSION` | Defaults to `2026-04-10`. |
| `VOICE_LIVE_VOICE`, `LOCALE` | Single demo voice/locale pair. |
| `TEAMS_WORKFLOW_URL` | Teams Workflows webhook for technician cards. Empty simulates delivery. |
| `TEAMS_OPS_WORKFLOW_URL` | Teams Workflows webhook for unacknowledged ops alerts. Empty simulates delivery. |
| `DEMO_NOW` | Pins on-call rotation and simulated scheduler clock. |
| `INTAKE_TIME_BUDGET_MS`, `PAGE_TIME_BUDGET_MS`, `CALL_TIME_BUDGET_MS` | Call caps. |
| `PERSIST_TRANSCRIPTS` | Opt-in transcript persistence. Defaults off. |
| `DB_PATH` | Defaults to `./data/pager.db` (runtime only; `data/` is gitignored). |

## Live setup

1. Provision a Teams Phone resource account or ACS fallback number.
2. Run `scripts/provision-teams-phone.ps1` as the checklist for Teams Phone extensibility, Event Grid, and callback URLs.
3. Assign the managed identity or developer account:
   - ACS access through `ACS_ENDPOINT` / DefaultAzureCredential.
   - Cognitive Services User and Foundry User roles for Voice Live with scope `https://ai.azure.com/.default`.
4. Set `PUBLIC_BASE_URL` to a dev tunnel or public host and keep `ACS_OUTBOUND_CALLER_ID` aligned with the service number.
5. Configure Teams Workflow incoming webhooks if you want real card delivery.

## Architecture

```text
Tenant PSTN / Teams Phone resource account
  -> ACS Call Automation callbacks + PCM16 24 kHz media WebSocket
  <-> Node.js pager service
      <-> Voice Live gpt-realtime direct WebSocket
      <-> config fixtures: properties, tenants, triage, on-call, escalation
      <-> SQLite incidents, attempts, scheduler jobs, audit events
      <-> local WebSocket presenter console
  -> ACS outbound page to technician
  -> optional AddParticipant bridge to tenant
  -> ACS outbound status call to tenant
  -> Teams Workflows cards
```

`src/flow.mjs` owns the state machine and imports no Azure or Express code. Voice, server, database, notification, and dialer dependencies are injected so tests run with no cloud credentials.

## Tests

```bash
npm test        # node:test fixtures, no cloud credentials
npm run check   # syntax checks all modules/scripts/tests
npm run smoke   # starts a temporary server and validates WebSocket upgrades
```

Coverage includes roster matching, unknown/invalid unit validation, triage variants, duplicates, escalation, acknowledgement, voicemail privacy, bridge requests, scheduler restart persistence, handoff payloads, stats, and prompt-injection note sanitization.

## Security notes before production

- This demo does not dispatch emergency services, estimate arrival time, send SMS, record calls, or integrate a real work-order system.
- Phone numbers are server-owned and not included in model tools or Teams card payloads. The technician number is never spoken to the tenant.
- Answering machines receive only a callback prompt with no property, unit, or issue details.
- Replace local fixtures with an approved on-call/work-order integration and legal-reviewed triage rules.
- Add redundant paging, access control for the console, high-availability scheduler storage, Key Vault for webhook secrets, and compliance review before real use.
