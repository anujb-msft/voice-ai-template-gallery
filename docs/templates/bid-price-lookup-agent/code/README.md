# Bid Price Lookup Agent sample

Demo-grade Node.js voice template for the **Contoso Grain Co-op bid line**. It answers inbound Teams Phone / ACS calls, discloses that it is automated, reads server-formatted cash bid phrases, applies freshness rules, and transfers sell or outage requests to the configured merchandiser target.

This is not a production pricing system. The bid sheet and futures are local fixtures in `config/`; replace them with a licensed market-data feed before real use.

## What the demo shows

- Voice Live `gpt-realtime` direct mode (`api-version=2026-04-10`) over the ACS media stream.
- Server-owned tools only: the model receives fixed phrases, never raw Teams targets or authority to invent prices.
- Offline typed-transcript mode that drives the same state machine, matching, freshness, quoting, repeat, DTMF, and handoff paths.
- SQLite audit log in `data/` at runtime; committed fixtures stay in `config/`.
- Local WebSocket presenter console with transcript, bid board, freshness, and mock Teams handoff.

## Quick start — offline first

```bash
npm install --registry https://packagefeedproxy.microsoft.io/npm/ --no-audit --no-fund
npm test
npm run check
npm start
```

Open <http://127.0.0.1:8094>, click **Answer demo call**, then try:

- `what's corn at Riverside`
- `and beans?`
- `all locations for corn`
- `should I sell?`
- `I want to sell`

Useful HTTP smoke path:

```bash
curl http://127.0.0.1:8094/health
curl -X POST http://127.0.0.1:8094/api/simulate -H 'content-type: application/json' -d '{}'
```

## Scripts

- `npm start` — Express server and local WebSocket console on port 8094.
- `npm run dev` — Node watch mode.
- `npm test` — dependency-free `node:test` suite for flow, tools, guards, freshness, and handoff.
- `npm run check` — syntax checks source and scripts.
- `npm run smoke` — boots the server and verifies WebSocket upgrades.
- `npm run tunnel` — dev tunnel command for live ACS callbacks.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8094` | Local server port. |
| `PUBLIC_BASE_URL` | empty | HTTPS URL reachable by ACS/Event Grid. |
| `ACS_ENDPOINT` | empty | Preferred keyless ACS endpoint. |
| `ACS_CONNECTION_STRING` | empty | ACS fallback when keyless auth is unavailable. |
| `VOICE_LIVE_ENDPOINT` | empty | Azure AI Voice Live endpoint. |
| `VOICE_LIVE_MODEL` | `gpt-realtime` | Realtime model. |
| `VOICE_LIVE_API_VERSION` | `2026-04-10` | Voice Live WebSocket API version. |
| `VOICE_LIVE_API_KEY` | empty | Optional API-key fallback; otherwise `DefaultAzureCredential`. |
| `PRICE_FEED` | `fixture` | Fixture feed for the sample. |
| `DEMO_NOW` | `2026-09-08T15:42:00Z` | Pins deterministic freshness in offline mode. |
| `CALL_TIME_BUDGET_MS` | `180000` | Three-minute call cap. |
| `FUTURES_STALE_MINUTES` | `20` | Soft freshness caveat threshold. |
| `FUTURES_HARD_LIMIT_MINUTES` | `240` | Hard close-price fallback threshold. |
| `PERSIST_TRANSCRIPTS` | false | Store utterance text only when explicitly enabled. |
| `DB_PATH` | `./data/bid-price-lookup.db` | Runtime SQLite path. |

## Live setup outline

1. Provision ACS, Event Grid, and a public HTTPS tunnel to `/api/events` and `/api/calls/callback`.
2. Assign the app identity **Cognitive Services User** and **Foundry User** on the Voice Live resource; keyless auth uses scope `https://ai.azure.com/.default`.
3. Use `ACS_ENDPOINT` for keyless ACS where possible; use `ACS_CONNECTION_STRING` only as a quick-start fallback.
4. Bind a Teams Phone resource account with `scripts/provision-teams-phone.ps1` and paste merchandiser user / queue object IDs into `config/locations.json`.
5. Start the server, confirm `/health` reports live telephony, Voice Live, feed, and Teams readiness, then dial the Teams service number.

## Architecture

```text
Teams Phone / ACS number
  -> ACS Call Automation + bidirectional PCM16 24 kHz media stream
  <-> Node.js Express service
      <-> Voice Live gpt-realtime direct mode
      <-> PriceBook + FixtureFeed from config/*.json
      <-> SQLite audit log
      <-> local presenter WebSocket
  -> blind TransferCallToParticipant to merchandiser target
```

`src/flow.mjs` has no Azure or Express imports, so tests and offline simulation use the same logic as a live call. `src/voice/*` owns ACS and Voice Live transport only.

## Security notes before production

- Use a licensed market-data provider and verify redistribution rights for spoken quotes.
- Review disclaimer and no-advice language with legal/compliance.
- Authenticate patrons before exposing contract-specific or account-specific information.
- Store secrets in managed identity or Key Vault; do not commit keys.
- Keep transcripts off by default unless retention is explicitly approved.
- Add rate limits, warm compute, Event Grid duplicate handling, monitoring, and Teams certification review.
