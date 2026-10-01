# IT/HR Help Desk Triage

One internal Contoso phone line for routine IT and HR questions. The sample classifies a caller's topic, answers only from approved IT/HR knowledge, verifies identity before personal answers or tickets, files demo tickets, attaches known outages, and sends sensitive HR matters to a protected confidential path.

> Illustrative demo only. The ITSM, HRIS, directory, OTP sender, taxonomy, routing table, and knowledge articles are fixtures.

## What the demo shows

- AI disclosure in the first line: callers hear that this is an automated assistant.
- Offline typed-transcript mode that drives the same state machine as a live call.
- Two-stage classification with a confidence gate and one clarifying question.
- Server-owned tools for answers, verification, tickets, routing, reset handoff, and confidential HR.
- Privacy guard: sensitive HR segments are redacted and never written to transcript storage or handoff context.
- Known outage banner and parent incident attachment.
- Teams Phone `TransferCallToParticipant` handoff context with destination-specific fields.

## Quick start (offline first)

```bash
npm install --registry https://packagefeedproxy.microsoft.io/npm/ --no-audit --no-fund
npm start
# open http://127.0.0.1:8098
```

Try:

| Utterance | Expected result |
| --- | --- |
| `My VPN keeps disconnecting` | Fresh IT answer from `it-vpn-001` |
| `How much PTO do I have?` | Teams caller gets a personal HRIS answer; PSTN caller verifies first |
| `My laptop screen is flickering and I can't work` then `yes` | P2 IT ticket with read-back and confirmation |
| `Outlook won't open` | Attached to active incident `INC-004700` |
| `I clicked a phishing link` then `yes` | P1 ticket and IT on-call transfer |
| `My manager has been making comments about me` | Confidential HR transfer; transcript segment redacted |

Run validation:

```bash
npm test
npm run check
npm run smoke   # with the server already running
```

## Configuration

Copy `.env.example` to `.env` for live calls. Defaults run offline.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8098` | Local HTTP/WebSocket port |
| `PUBLIC_BASE_URL` | empty | HTTPS URL reachable by ACS/Event Grid |
| `ACS_ENDPOINT` | empty | Preferred keyless ACS auth with `DefaultAzureCredential` |
| `ACS_CONNECTION_STRING` | empty | Fallback when keyless auth is not available |
| `VOICE_LIVE_ENDPOINT` | empty | Azure AI Services endpoint |
| `VOICE_LIVE_API_KEY` | empty | Optional fallback; Entra auth is preferred |
| `VOICE_LIVE_MODEL` | `gpt-realtime` | Voice Live direct mode |
| `VOICE_LIVE_API_VERSION` | `2026-04-10` | Required API version |
| `PASSWORD_RESET_TARGET` | empty | Empty means file a ticket instead of reset handoff |
| `CLASSIFIER_CONFIDENCE_MIN` | `0.7` | Below this the server asks one clarifying question |
| `DEMO_NOW` | empty | Pins freshness, outage, and hours checks |
| `CALL_TIME_BUDGET_MS` | `360000` | Six-minute cap |
| `TRANSCRIPT_RETENTION` | `false` | HR-sensitive text is never persisted even when enabled |

Committed fixtures live under `config/` and `kb/`. Runtime SQLite files are created under `data/`, which is gitignored.

## Live setup

1. Provision a Teams Phone resource account and five call queues (see `scripts/provision-teams-phone.ps1`).
2. Link the Teams Phone resource account to ACS through Teams Phone extensibility, or use an ACS number fallback.
3. Assign the app identity ACS permissions and Azure AI **Cognitive Services User** plus **Foundry User** roles.
4. Set `ACS_ENDPOINT`, `PUBLIC_BASE_URL`, and `VOICE_LIVE_ENDPOINT`.
5. Replace placeholder Teams object IDs in `config/routing.json`.

## Architecture

`src/flow.mjs` owns the state machine and imports no Azure or Express modules. `src/offline.mjs` maps typed utterances to the same server tools the model uses. `src/server.mjs` hosts Express, `/health`, `/api/stats`, the local WebSocket presenter console, Event Grid intake, ACS callbacks, and simulation APIs. `src/voice/*` bridges ACS bidirectional media to Voice Live as PCM16 24 kHz and supports barge-in.

## Tests

`node:test` covers offline fixture routing, sensitive guard, verification, personal answers, tickets, priority matrix, outage attachment, password reset handoff/fallback, DTMF, time caps, health, stats suppression, and privacy guards. No cloud credentials are required.

## Security notes before production

Replace fixture adapters with least-privilege directory, HRIS, OTP, and ITSM integrations. Review the sensitive categories and safety text with HR, legal, employee relations, and qualified EAP/clinical partners. Do not persist raw audio. Use managed identity or Key Vault for secrets, validate Teams queue membership, and complete privacy/works-council/records review before handling real employee HR matters.
