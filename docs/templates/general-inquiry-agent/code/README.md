# General Inquiry Agent sample

Runnable Node.js 22 sample for the **General Inquiry Agent** voice template. It answers a City of Contoso municipal information line from approved local Markdown content only, records citations, enforces stale/expired content policy, and transfers to a Teams Call Queue when a person is needed.

The sample runs fully offline: typed transcript input drives the same state machine, retrieval, citations, freshness checks, hours decisions, and handoff payloads that a live ACS + Voice Live call uses. Only audio and the real transfer are simulated when Azure settings are absent.

## What the demo shows

- AI disclosure in the opening line.
- Grounded answers from `content/articles/*.md` only.
- Stale answer caveat and expired-content refusal.
- General eligibility answers with the required staff-decision disclaimer.
- No caller lookup and no personal details passed to the model or Teams.
- DTMF `0`, human requests, no-input handling, call cap, and after-hours close.
- Blind `TransferCallToParticipant` context with `SessionId`, `CallTopic`, `CallContext`, and optional `CallSentiment`.
- Local WebSocket presenter console; no SignalR dependency.

## Quick start — offline first

```bash
npm install --registry https://packagefeedproxy.microsoft.io/npm/ --no-audit --no-fund
npm test
npm run check
npm start
```

Open <http://127.0.0.1:8092>, click **Start call**, and type caller questions such as:

- `What hours is City Hall open?`
- `Can I get help with a bulky sofa pickup?`
- `Do I need a yard sale permit?`
- `I'm 67 and my income is 67000, do I qualify for the senior discount?`
- `0`

You can also run an end-to-end typed transcript through the API:

```bash
curl -s http://127.0.0.1:8092/api/simulate \
  -H 'content-type: application/json' \
  -d '{"turns":["What hours is City Hall open?","Where did that come from?","That is all"]}'
```

## Scripts

- `npm start` — start the Express server on port `8092`.
- `npm run dev` — start with Node watch mode.
- `npm test` — run `node:test` fixtures with no cloud credentials.
- `npm run check` — syntax-check source, scripts, and tests.
- `npm run smoke` — start a throwaway server and verify both WebSocket endpoints upgrade.
- `npm run tunnel` — open a dev tunnel on port `8092` for ACS callbacks.

## Environment variables

Copy `.env.example` to `.env` for local live-call configuration.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8092` | HTTP and WebSocket port. |
| `PUBLIC_BASE_URL` | empty | Public HTTPS URL used by ACS callbacks and `wss://` media. |
| `ACS_ENDPOINT` | empty | Preferred keyless ACS endpoint, used with `DefaultAzureCredential`. |
| `ACS_CONNECTION_STRING` | empty | Quick-start fallback when keyless ACS is not configured. |
| `VOICE_LIVE_ENDPOINT` | empty | Azure AI Voice Live endpoint. |
| `VOICE_LIVE_API_KEY` | empty | Quick-start fallback; Entra auth is preferred. |
| `VOICE_LIVE_MODEL` | `gpt-realtime` | Voice Live direct model. |
| `VOICE_LIVE_API_VERSION` | `2026-04-10` | WebSocket API version required by the spec. |
| `VOICE_LIVE_VOICE` | `en-US-Ava:DragonHDLatestNeural` | Demo voice. |
| `LOCALE` | `en-US` | Spoken language hint. |
| `DEMO_NOW` / `DEMO_TODAY` | empty | Pin time for deterministic demos and tests. |
| `CALL_TIME_BUDGET_MS` | `300000` | Five-minute default call cap. |
| `RETRIEVAL_MIN_SCORE` | `2.5` | Minimum keyword score for approved answers. |
| `CONTENT_EXPIRY_GRACE_DAYS` | `90` | Stale grace period after `reviewBy`. |
| `PERSIST_TRANSCRIPTS` | `false` | When false, utterance text stays in memory only. |
| `DB_PATH` | `./data/general-inquiry.db` | Runtime SQLite path; `data/` is intentionally gitignored. |

## Live setup outline

1. Provision a Teams Phone resource account and connect it to ACS through Teams Phone extensibility. A plain ACS number can also reach the same state machine for fallback demos.
2. Set `PUBLIC_BASE_URL` to a reachable HTTPS tunnel or hosted URL.
3. Configure `ACS_ENDPOINT` and assign the app identity the needed ACS Call Automation permissions, or set `ACS_CONNECTION_STRING` for a quick start.
4. Configure `VOICE_LIVE_ENDPOINT`; prefer managed identity / `DefaultAzureCredential` with Cognitive Services User and Foundry User roles. Use `VOICE_LIVE_API_KEY` only for local quick starts.
5. Replace the placeholder Teams Call Queue application ID in `config/hours.json`.
6. Run `scripts/provision-teams-phone.ps1` as a checklist starter, then verify a manual live call.

## Architecture

```text
Teams Phone / ACS number
  → ACS Call Automation + bidirectional PCM16 24 kHz media
  ↔ Node.js inquiry service
      ↔ Azure AI Voice Live gpt-realtime (direct mode)
      ↔ Markdown content index + freshness evaluator
      ↔ staffed-hours and Teams handoff policy
      ↔ SQLite audit log + /health + /api/stats
      ↔ local WebSocket presenter console
  → blind Teams Call Queue transfer with context
```

`src/flow.mjs` has no Azure or Express imports. It is the policy boundary for retrieval, citations, stale/expired guards, transfer decisions, no-inputs, DTMF, and call-cap behavior.

## Tests

`npm test` covers the spec fixture list: fresh/stale/expired retrieval, misses, out-of-scope service requests, eligibility disclaimers, personal-detail guard, citations, multi-question calls, repeat/slower, DTMF `0`, staffed and after-hours human requests, no-inputs, call cap, failed transfer, invalid `record_answer`, and prompt-injection attempts.

## Security notes before production

- Move retrieval to Azure AI Search or another governed content system.
- Establish accountable owners and review SLAs for every article.
- Evaluate answer accuracy against a larger question set.
- Add prompt-injection tests for caller speech and content.
- Validate Teams Phone extensibility, Event Grid, rate limits, warm compute, Key Vault / managed identity, and organizational certification requirements.
- Keep transcripts off by default unless retention, masking, and consent requirements are approved.
