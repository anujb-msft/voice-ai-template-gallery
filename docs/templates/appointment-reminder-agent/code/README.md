# Appointment Reminder Agent

Runnable Node.js sample for the Contoso Health outbound appointment reminder voice template. It demonstrates a safe-by-default campaign scheduler, consent and calling-window gates, voicemail handling, right-party verification, confirm/cancel/reschedule tools, SQLite schedule writes, and a local presenter console.

## Quick start (offline first)

```bash
npm install --registry https://packagefeedproxy.microsoft.io/npm/ --no-audit --no-fund
npm test
npm run check
npm start
curl http://127.0.0.1:8099/health
node src/offline.mjs --appointment A-20418 --transcript confirm
```

Open <http://127.0.0.1:8099> for the demo board. The default `DEMO_NOW` is `2026-05-19T10:00:00-07:00`, which places Jordan Rivera's sample appointment inside the 48-hour reminder window.

## What the demo shows

- A dry-run dial plan with skip reasons for no consent, wrong channel, TTY, holidays, cutoff, retry spacing, bad numbers, and opt-outs.
- Answered calls with AI disclosure before identity verification.
- Server-side DOB/proxy verification before appointment details are spoken.
- Confirm, cancel with released slot, late-cancel notice, reschedule handoff/callback, clinical-question routing, emergency wording, DTMF, opt-out, retries, and voicemail-last-attempt behavior.
- SQLite audit and schedule state through `/api/stats`.

## Environment

Key variables: `PORT` (default `8099`), `PUBLIC_BASE_URL`, `ACS_ENDPOINT` or `ACS_CONNECTION_STRING`, `ACS_CALLER_ID`, `TEAMS_RESOURCE_ACCOUNT_ID`, `VOICE_LIVE_ENDPOINT`, `VOICE_LIVE_MODEL` (`gpt-realtime`), `VOICE_LIVE_API_VERSION` (`2026-04-10`), `SCHEDULE_DB_PATH` (`./data/schedule.db`), `SCHEDULING_AGENT_TARGET`, `CAMPAIGN_ENABLED=false`, `CAMPAIGN_DRY_RUN=true`, `ALLOWED_TEST_NUMBERS`, `HANDOFF_TOKEN_SECRET`, `DEMO_NOW`, and `CALL_TIME_BUDGET_MS`.

Live dialing is blocked by defaults: enable the campaign only after ACS, Event Grid, a public HTTPS tunnel, caller ID, and an allow-list of presenter-owned test numbers are configured.

## Architecture

`src/flow.mjs` is the unit-testable state machine and imports no Azure or Express modules. `src/schedule-store.mjs` owns the shared SQLite schema and idempotent seed from `fixtures/appointments-seed.json`. `src/server.mjs` hosts Express, health/stats endpoints, Event Grid callbacks, offline simulation, and the local WebSocket console. `src/voice/*` bridges ACS PCM16 24 kHz media to Voice Live direct model mode and maps model tool calls to server-owned flow methods.

## Tests and checks

`npm test` runs `node:test` with no cloud credentials. `npm run check` syntax-checks source, scripts, and tests. `npm run smoke` checks the local WebSocket hub when the server is running.

## Security notes before production

This sample is fictional and not legal advice. Before real use, review outbound calling laws, HIPAA/privacy, caller ID branding, consent revocation, voicemail wording, proxy rules, accessibility paths, clinical safety phrases, credential storage, Event Grid validation, and least-privilege access to the real scheduling system. Audio is not stored; transcripts are off by default and masked when enabled.
