# After-Hours Sales Lead Capture sample

Runnable Node.js 22 demo for the **After-Hours Sales Lead Capture** voice template. It shows how an inbound Teams Phone / ACS call can either transfer directly to the sales queue during business hours or, after hours and on overflow, capture a qualified lead for follow-up.

The sample is demo-grade, not a production CRM. It uses local JSON fixtures and SQLite.

## What the demo shows

- Voice Live `gpt-realtime` direct-mode wiring with ACS bidirectional media (PCM16 24 kHz) and barge-in.
- AI disclosure in the opening line.
- Server-owned tools: catalog lookup, non-sales classification, and lead save.
- Deterministic server-side qualification, dedupe, round-robin rep assignment, SLA phrase, and notification outbox.
- Offline typed-transcript simulation that uses the same state machine as live calls.
- Presenter console at `http://127.0.0.1:8093` showing transcript, lead fields, score breakdown, owner, and outbox.

## Quick start: offline first

```bash
npm install --registry https://packagefeedproxy.microsoft.io/npm/ --no-audit --no-fund
npm test
npm run check
npm start
```

Open `http://127.0.0.1:8093`, click **Run hot lead fixture**, or run:

```bash
curl -s http://127.0.0.1:8093/health
curl -s -X POST http://127.0.0.1:8093/api/simulate   -H 'content-type: application/json'   -d '{"transcript":["This is Dana from Northwind Manufacturing in CA, I am the procurement director.","We need 12000 hex bolts this week. Call me at 425-555-0193 and email dana@northwind.example."]}'
```

## Scripts

- `npm start` — run the Express server on port 8093.
- `npm run dev` — watch mode.
- `npm test` — `node:test` fixture and acceptance coverage with no cloud credentials.
- `npm run check` — syntax check all source and scripts.
- `npm run smoke` — starts a throwaway server, checks WebSocket upgrades, and runs an offline call.
- `npm run tunnel` — dev tunnel helper for live ACS callbacks.

## Configuration

Copy `.env.example` to `.env` for live calls.

Key variables:

- `PORT` defaults to `8093`.
- `PUBLIC_BASE_URL` is the HTTPS dev tunnel or deployed URL.
- `ACS_ENDPOINT` is preferred for keyless ACS auth; `ACS_CONNECTION_STRING` is the fallback.
- `VOICE_LIVE_ENDPOINT`, `VOICE_LIVE_MODEL=gpt-realtime`, `VOICE_LIVE_API_VERSION=2026-04-10`.
- `VOICE_LIVE_API_KEY` is optional; otherwise `DefaultAzureCredential` requests `https://ai.azure.com/.default`.
- `DEDUPE_WINDOW_DAYS=30`, `DEMO_NOW`, `CALL_TIME_BUDGET_MS=360000`.
- `TEAMS_WORKFLOW_URL` and `ACS_EMAIL_SENDER` are live notification settings. Offline mode leaves messages in the outbox.

Committed fixtures live in `config/`: `hours.json`, `reps.json`, `qualification.json`, and `catalog.json`. Runtime SQLite goes under `data/`, which is gitignored.

## Live setup outline

1. Provision ACS Call Automation and assign managed identity roles for ACS and Voice Live.
2. Link a Teams Phone resource account through Teams Phone extensibility. A plain ACS number can also hit the same callback path.
3. Set `config/hours.json` `salesQueue.objectId` to the sales Call Queue application ID.
4. Host a public tunnel: `npm run tunnel`, set `PUBLIC_BASE_URL`, and create an Event Grid subscription to `/api/events`.
5. Start the server and place a test call.

`scripts/provision-teams-phone.ps1` records the manual checklist inputs.

## Architecture

```text
PSTN / Teams Phone
  -> ACS Call Automation + media streaming
  <-> Node.js lead-capture service
       <-> Voice Live gpt-realtime
       <-> JSON policy fixtures
       <-> SQLite lead store + audit + outbox
       <-> local WebSocket presenter console
  -> blind transfer to Teams Sales Queue when in hours
```

`src/flow.mjs` has no Azure, Express, or SQLite imports. The transfer function, clock, store, and presenter hub are injected so tests and offline simulation run without credentials.

## Security notes before production

- Replace the SQLite lead store with the system-of-record CRM and its ownership rules.
- Review consent, recording, retention, accessibility, and follow-up rules for each market.
- Store secrets in managed identity / Key Vault, not `.env`.
- Add rate limits, Event Grid validation, poison-message handling, and delivery retries.
- Keep the model away from personal-data decisions: scoring, dedupe, assignment, and notification routing should remain server-side.
