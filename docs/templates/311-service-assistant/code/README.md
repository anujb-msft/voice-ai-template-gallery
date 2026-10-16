# 311 Service Assistant sample

Demo-grade Node.js 22 sample for the **City of Contoso 311** voice template. It answers approved civic FAQs, files six service request types, checks case status, schedules a guided bulk-item pickup, and transfers priority hazards or callers who need a person with Teams Phone handoff context.

This is not a production 311 system. The catalog, address data, departments, case store, and duplicate rules are local fixtures.

## What the demo shows

- Voice Live `gpt-realtime` direct mode with `api-version=2026-04-10`.
- Opening AI disclosure: “I'm an automated assistant.”
- Server-owned tools for FAQ search, location validation, intake fields, duplicate checks, case creation, status, guided pickup, SMS consent, transfer, repeat, and end call.
- Full offline typed-transcript simulation using the same flow as live calls.
- SQLite audit and case store under `data/`; committed fixtures stay in `config/` and `content/`.
- Local WebSocket presenter console with call state, transcript, cases, and metrics.

## Quick start (offline first)

```bash
npm install --registry https://packagefeedproxy.microsoft.io/npm/ --no-audit --no-fund
npm test
npm run check
npm start
```

Open <http://127.0.0.1:8096>, click **Start simulated call**, and type:

> There is a large pothole in the travel lane at Oak and 5th

Or run the HTTP smoke path while the server is running:

```bash
npm run smoke
```

`GET /health` reports simulation mode when Azure settings are absent.

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `8096` | HTTP and WebSocket port |
| `PUBLIC_BASE_URL` | empty | Public HTTPS base for Event Grid callbacks and ACS media WebSocket |
| `ACS_ENDPOINT` | empty | Preferred keyless ACS endpoint for `DefaultAzureCredential` |
| `ACS_CONNECTION_STRING` | empty | ACS fallback for local quick starts |
| `ACS_SMS_FROM` | empty | ACS SMS sender for consented form links |
| `VOICE_LIVE_ENDPOINT` | empty | Voice Live endpoint |
| `VOICE_LIVE_API_KEY` | empty | Optional API-key fallback; otherwise Entra auth is used |
| `VOICE_LIVE_MODEL` | `gpt-realtime` | Voice Live model |
| `VOICE_LIVE_API_VERSION` | `2026-04-10` | Voice Live WebSocket API version |
| `LOCALES` | `en-US,es-US` | Supported caller locales |
| `CASE_STORE` | `sqlite` | Case store adapter shipped in this sample |
| `GEOCODER` | `fixture` | Fixture geocoder adapter shipped in this sample |
| `DUPLICATE_RADIUS_M` | `50` | Duplicate radius |
| `DUPLICATE_WINDOW_DAYS` | `7` | Duplicate window |
| `MAX_REQUESTS_PER_CALL` | `3` | Anything else loop cap |
| `CASE_RETENTION_DAYS` | `365` | Demo retention setting |
| `CONTENT_EXPIRY_GRACE_DAYS` | `90` | Stale-to-expired grace period |
| `DEMO_NOW` | empty | Pins clock for demos/tests |
| `CALL_TIME_BUDGET_MS` | `300000` | Five-minute call cap |
| `PERSIST_TRANSCRIPTS` | `false` | Keeps utterance text out of SQLite by default |

## Live setup

1. Provision ACS Call Automation and Teams Phone extensibility. Use `ACS_ENDPOINT` with managed identity where possible.
2. Assign the app identity **Cognitive Services User** and **Foundry User** roles for Voice Live keyless auth (`https://ai.azure.com/.default`).
3. Host the app behind HTTPS and set `PUBLIC_BASE_URL`.
4. Configure Event Grid `IncomingCall` to `POST /api/events`.
5. Verify `config/departments.json` contains real Teams queue resource account object IDs.
6. Call the Teams Phone resource account. Plain ACS number fallback uses the same `/api/events` path.

## Architecture

```text
Teams Phone / ACS number
  -> ACS Call Automation + bidirectional media (PCM16 24 kHz)
  <-> Node.js 311 service
      <-> Voice Live gpt-realtime direct mode
      <-> server-owned state machine and tools
      <-> content/articles + freshness rules
      <-> fixture geocoder + intake schemas + SQLite cases
      <-> local WebSocket presenter console
  -> TransferCallToParticipant with CallTopic and CallContext
```

The model never receives Teams targets, phone numbers, callback numbers, or reporter names. `set_contact` stores only consent indicators in the tool result.

Handoff fields are sent as VoIP headers with hyphenated keys such as `CallDetails-CallTopic`, because Call Automation rejects keys containing "." or "_" (see `voipKey` in `src/handoff.mjs`). A transfer is only marked `transferred` when the `CallTransferAccepted` callback arrives. The audit events are `transfer_started`, `transfer_requested` (ACS accepted the request), `transfer_succeeded`, and `transfer_failed` (a refused request or `CallTransferFailed`, with the ACS error or result code). After a failure the agent apologises, reads back any case filed on the call or offers to file one, and returns to listening without retrying. While the transfer is out, the agent's `end_call` is refused, so only the transfer's outcome or the caller hanging up ends the call.

## Tests

```bash
npm test
npm run check
```

The `node:test` suite runs without cloud credentials and covers emergency redirects, FAQ freshness, all request types, location matching, duplicates, status privacy, guided pickup, transfer handoff, refused and failed transfers, VoIP header keys, DTMF, call budget, and prompt-injection guards.

## Security notes before production

- Replace fixtures with authoritative 311/Open311, GIS, and department systems.
- Review emergency language with PSAP and gas utility owners.
- Complete legal, records-retention, SMS consent, accessibility, and language-access reviews.
- Store secrets in managed identity or Key Vault; do not use API keys in production.
- Add rate limits, warm answer-path hosting, monitoring, and Event Grid validation controls.
