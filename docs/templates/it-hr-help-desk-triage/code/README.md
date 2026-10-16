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
- Teams Phone `TransferCallToParticipant` handoff context with destination-specific fields, sent as VoIP headers with keys Call Automation accepts.
- A server-side routing gate on every transfer (destination, call state, hours, confidential HR), with a callback offer when a queue is closed or a transfer fails.

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
| `0` | Keypad transfer to the IT service desk (HR shared services after an HR question), or a callback offer when that queue is closed |
| With `DEMO_NOW=2026-05-17T04:00:00Z` (a Saturday evening in Los Angeles): `My manager has been making comments about me` then `yes` | Closed-line offer, then a confidential HR callback case that holds only "Confidential HR" |

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

## Transfers, callbacks, and audit events

Every transfer passes a server-side routing gate before anything is sent to ACS, whether it comes from the model's `route` tool, keypad `0`, a P1 ticket, the password-reset handoff, or the confidential HR path. The gate refuses an unknown destination, a call that has finished or is already transferring, keypad `0` while a one-time code is outstanding, anything but confidential HR once the call is confidential, a destination that already failed on this call, a model `route` call after a failed transfer until the caller has answered the callback offer, and a closed queue. "Routing gate and transfer outcomes" in [`../SPEC.md`](../SPEC.md) has the rules.

| Audit event | Recorded when |
| --- | --- |
| `transfer_rejected` | The gate refuses a transfer. The detail is only `<destination>: <reason>` |
| `transfer` | A transfer passes the gate and its handoff context is built |
| `transfer_requested` | Call Automation accepted the transfer request. The call stays `transferring` |
| `transfer_succeeded` | `CallTransferAccepted` arrived, so the call is `transferred` |
| `transfer_failed` | Call Automation rejected the request, or `CallTransferFailed` arrived. The detail is only the ACS status and message |
| `callback_requested` | `request_callback` filed a confidential HR case or a callback request |
| `tool_rejected` | A live model tool call returned a refusal, for example `route: closed` |

Besides `route(destination, reason)`, the model has `request_callback(destination)`, which it calls only after the caller agrees to a callback, and `end_call(reason)`, which is refused with `transfer_in_progress` while a transfer is still ringing, and with `awaiting_callback_answer` after a failed transfer until the caller has answered the callback offer.

When a transfer fails, the caller hears one apology and a callback offer, for example "I'm sorry, I can't connect you to the IT service desk right now. I can ask the IT service desk to call you back. Would you like that?" A confidential call is only offered a confidential HR callback. Before the apology, the model gets a system note that the transfer failed, so it doesn't carry on as if the caller were still being transferred. Until the caller answers, the model can't transfer them elsewhere or end the call, but keypad `0` still works. If the caller accepts, the server files the request and hangs up 12 seconds later. If the caller doesn't answer the offer within 30 seconds, the server says goodbye and hangs up. The window restarts whenever the agent speaks or the caller starts to speak.

Handoff context goes out as VoIP headers. Call Automation rejects keys containing "." or "_", so the Teams field names are sent with hyphens: `CallDetails-SessionId`, `CallDetails-CallTopic`, `CallDetails-CallContext`, `CallDetails-DestinationId`, and `CallDetails-Confidential`. If your Teams integration expects a different serialization, `voipKey` in `src/handoff.mjs` is the one place to change it.

## Tests

`node:test` covers offline fixture routing, sensitive guard, verification, personal answers, tickets, priority matrix, outage attachment, password reset handoff/fallback, DTMF, time caps, health, stats suppression, and privacy guards. It also covers the routing gate, rejected and failed transfers with fake Call Automation clients, `CallTransferAccepted` and `CallTransferFailed` handling, callbacks, `end_call` during a transfer and before the caller answers a callback offer, model routes held until the caller answers that offer, the answer window restarting when the caller starts to speak, VoIP header keys, and server lines reaching the model. `test/voice-live.test.mjs` drives a Voice Live session over a fake socket: a server line that a tool-only response didn't speak rides the next response once, and a note raised during a tool call goes in after that tool's output. No cloud credentials are required.

## Security notes before production

Replace fixture adapters with least-privilege directory, HRIS, OTP, and ITSM integrations. Review the sensitive categories and safety text with HR, legal, employee relations, and qualified EAP/clinical partners. Do not persist raw audio. Use managed identity or Key Vault for secrets, validate Teams queue membership, and complete privacy/works-council/records review before handling real employee HR matters.
