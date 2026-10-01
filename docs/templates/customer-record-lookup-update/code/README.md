# Customer Record Lookup & Update voice sample

A runnable Node.js 22 demo for the **Customer Record Lookup & Update** template. A Contoso sales rep can call a Teams number, ask for an account briefing, dictate a meeting outcome, hear a compact read-back, and commit an auditable CRM update only after saying **"yes, save it"**.

The sample is demo-grade. The runnable CRM is a local SQLite fixture seeded from `config/crm-seed.json`; `data/` is runtime-only and gitignored. A Dataverse adapter is documented as a stub under `src/providers/dataverse-crm.mjs`.

## Quick start: offline first

```bash
npm install --registry https://packagefeedproxy.microsoft.io/npm/ --no-audit --no-fund
npm test
npm run check
npm start
```

Open <http://127.0.0.1:8097>, click **Start simulated Alex call**, then type:

1. `Brief me on Fabrikam`
2. `Log the Fabrikam meeting. Dana agreed to the renewal at 240k, moving to Closed Won pending signature, close date June 15th. Remind me to send the contract Friday.`
3. `yes, save it`
4. `undo that`

Or run the end-to-end smoke after the server starts:

```bash
npm run smoke
```

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8097` | Local HTTP and WebSocket server. |
| `PUBLIC_BASE_URL` | empty | Required for live ACS callbacks and media WebSocket. |
| `ACS_ENDPOINT` | empty | Preferred keyless Call Automation endpoint. |
| `ACS_CONNECTION_STRING` | empty | Quick-start ACS fallback. |
| `VOICE_LIVE_ENDPOINT` | empty | Required for live `gpt-realtime`. |
| `VOICE_LIVE_API_KEY` | empty | Optional API-key fallback; DefaultAzureCredential is preferred. |
| `VOICE_LIVE_MODEL` | `gpt-realtime` | Direct Voice Live model mode. |
| `VOICE_LIVE_API_VERSION` | `2026-04-10` | WebSocket API version. |
| `CRM_ADAPTER` | `sqlite` | `dataverse` is documented but intentionally stubbed. |
| `CRM_DB_PATH` | `./data/crm.db` | Runtime SQLite database. |
| `DEMO_NOW` | `2026-06-10T12:00:00-07:00` | Pins today for validation and demos. |
| `PIN_REQUIRED_FOR_PSTN` | `true` | Registered PSTN mobile callers must enter a PIN. |
| `TRANSCRIPT_RETENTION` | `false` | Utterance text stays in memory unless enabled. |
| `AFTER_CALL_MINUTES_BASELINE` | `6` | Used by `/api/stats`. |
| `CALL_TIME_BUDGET_MS` | `480000` | 8-minute cap. |

## Live setup

1. Provision an ACS resource and Teams Phone extensibility resource account. `scripts/provision-teams-phone.ps1` is a starting snippet; replace placeholder object IDs in `config/routing.json` with your sales operations queue.
2. Assign roles for keyless auth:
   - ACS: Call Automation access for the server identity.
   - Azure AI: **Cognitive Services User** and **Foundry User** for `https://ai.azure.com/.default`.
3. Run a public tunnel: `npm run tunnel`, set `PUBLIC_BASE_URL`, configure Event Grid to post to `/api/events`.
4. Set `VOICE_LIVE_ENDPOINT` and either rely on `DefaultAzureCredential` or set `VOICE_LIVE_API_KEY` for a quick demo.

## Architecture

```text
Teams Phone / ACS number
  -> ACS Call Automation callbacks + bidirectional media
  -> Node.js Express service on port 8097
      -> Voice Live gpt-realtime direct WebSocket
      -> CustomerRecordFlow state machine (no Express/Azure imports)
      -> SqliteCrmAdapter fixture CRM
      -> SQLite field audit / commits / undo / drafts
      -> local WebSocket presenter console
  -> blind TransferCallToParticipant to sales operations
```

The model never receives Teams IDs, PINs, phone numbers, or hidden CRM fields. It can only call server-owned tools. Contact phone/email is returned only when requested.

## Tests and checks

- `npm test` covers identity, PINs, access scoping, account matching, briefing drill-ins, contact detail gating, proposal validation, allow-list refusals, explicit confirmation, commit audit rows, undo conflicts, drafts, pause/continue, DTMF, handoff payloads, and offline simulation.
- `npm run check` syntax-checks source, tests, and scripts.
- `GET /health` reports application, Voice Live readiness, telephony readiness, Teams target provisioning, CRM seed counts, rep directory, and simulation mode.
- `GET /api/stats` reports calls, handle time, briefings, proposals, commits, fields written, undos, drafts, refused writes, transfers, and estimated after-call-work minutes saved.

## Security notes before production

Replace the fixture CRM with a real adapter that uses delegated user identity and the CRM's own security model. Review writable fields, validation ranges, PIN policy, lost-device response, transcript retention, draft retention, hands-free safety, and Teams certification before real use. Store secrets in managed identity or Key Vault, not `.env`.
