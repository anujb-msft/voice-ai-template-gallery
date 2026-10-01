# Appointment Scheduling Agent sample

Runnable Node.js 22 demo for Contoso Health's inbound scheduling line. It works fully in simulation mode with no Azure credentials: typed utterances drive the same verification, eligibility, slot search, hold, booking, reschedule, cancellation, waitlist, audit, and WebSocket console paths used by a live call.

## Quick start

```bash
npm install --registry https://packagefeedproxy.microsoft.io/npm/ --no-audit --no-fund
npm start
curl http://127.0.0.1:8100/health
```

Open `http://127.0.0.1:8100`, click **Simulate booking call**, then type `first` and `yes`. `npm run smoke` checks the local WebSocket hub while the server is running. Runtime SQLite files are created under `data/` and are intentionally gitignored.

## Scripts

- `npm start` — `node src/server.mjs` on port 8100.
- `npm run dev` — watch mode.
- `npm test` — `node --test test/*.test.mjs`.
- `npm run check` — syntax checks source, voice, scripts, and tests.
- `npm run tunnel` — dev tunnel for ACS callbacks.
- `npm run smoke` — local WebSocket smoke test.

## Architecture

`src/flow.mjs` is the server-owned state machine and imports no Express or Azure modules. It enforces verification, safety lockouts, ordered eligibility rules, explicit read-back confirmation, idempotency, and handoff redemption. `src/schedule-store.mjs` is copied from the reminder sample and extended with slot search, five-minute occupancy holds, booking, atomic rescheduling, cancellation compatibility, and waitlist writes. `src/server.mjs` hosts Event Grid and ACS callbacks, offline simulation APIs, stats/health, and the presenter console. `src/voice/*` contains the ACS/Voice Live bridge used only when live configuration is present.

## Shared schedule store

`fixtures/appointments-seed.json` and the adapter schema are shared with the reminder sample. Set both samples to the same `SCHEDULE_DB_PATH` to demo reminder-to-scheduling transfer. Handoff tokens in `handoff_tokens` are single-use, time-limited, and bound to the call/session correlation ID.

## Live mode

Set `PUBLIC_BASE_URL`, `ACS_ENDPOINT` or `ACS_CONNECTION_STRING`, `ACS_CALLER_ID`, `TEAMS_RESOURCE_ACCOUNT_ID`, `VOICE_LIVE_ENDPOINT`, and optionally `VOICE_LIVE_API_KEY`. DefaultAzureCredential is preferred for keyless ACS and Voice Live access. Configure the Teams resource account/auto attendant with the provided PowerShell script, expose port 8100 through a tunnel, and point Event Grid at `/api/events`.

SMS is stubbed unless `SMS_ENABLED=true`; even then live sends should be constrained with `SMS_ALLOWED_NUMBERS` for demos.

## FHIR R4 adapter mapping (documentation only)

A production adapter should implement the same interface as `ScheduleAdapter`:

- `searchSlots` → FHIR `Slot` search joined to `Schedule.actor` (`Practitioner`/`Location`), filtered by visit type, role, location, and horizon.
- `holdSlot` → scheduling-system hold or tentative `Appointment` with expiration metadata; conflicts must map to `slot_taken`.
- `bookAppointment` → confirmed `Appointment` create/update from the held slot.
- `rescheduleAppointment` → transaction/bundle that books the new appointment before cancelling the old one.
- `cancelAppointment` → `Appointment.status=cancelled` plus cancellation reason.
- `addWaitlist` → local request queue or FHIR `Appointment`/`Task` depending on the scheduling system.

This sample intentionally does not implement a live FHIR client.
