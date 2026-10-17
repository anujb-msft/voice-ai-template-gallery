# IT / HR Help Desk Triage

One internal Contoso phone line for routine IT and HR questions. The sample classifies a caller's topic, answers only from approved IT/HR knowledge, verifies identity before personal answers or tickets, files demo tickets, attaches known outages, and sends sensitive HR matters to a protected confidential path.

> Illustrative demo only. The ITSM, HRIS, directory, OTP sender, taxonomy, routing table, and knowledge articles are fixtures.

## What the demo shows

- AI disclosure in the first line: callers hear that this is an automated assistant.
- Identity from Teams sign-in for callers in the Teams app. A phone caller's caller ID is only a hint: anything personal waits for a one-time code sent to the employee on record.
- Offline typed-transcript mode that drives the same state machine as a live call.
- Two-stage classification with a confidence gate and one clarifying question.
- Server-owned tools for answers, verification, tickets, routing, reset handoff, and confidential HR.
- Privacy guard: sensitive HR segments are redacted and never written to transcript storage or handoff context.
- Known outage banner and parent incident attachment.
- Teams Phone `TransferCallToParticipant` handoff context with destination-specific fields.
- A presenter console with a scripted seven-beat demo, a mock of the Teams incoming-call toast with the VoIP headers on the wire, and a mock employee chat where simulated one-time codes and tickets appear instead of being sent.

## Quick start (offline first)

```bash
npm install
npm start      # http://127.0.0.1:8098
```

Open <http://127.0.0.1:8098> and press **→** (or **Next ▶**) to run the scripted demo one step at a time. [`DEMO-SCRIPT.md`](./DEMO-SCRIPT.md) is the running order, the narration, and the presenter setup. You can also pick a caller, press **Answer a call**, and type your own lines.

Try these yourself. Choose **Business hours** on the demo clock first: with no `DEMO_NOW` the clock starts at real time, and the confidential HR line's hours and the Outlook outage follow it.

| Caller | Utterance | Expected result |
| --- | --- | --- |
| Sam Rivera · Teams | `My VPN keeps disconnecting` | Fresh IT answer from `it-vpn-001` |
| Sam Rivera · Teams | `How much PTO do I have?` | Personal HRIS answer, because Teams sign-in identifies Sam |
| Sam's mobile · phone call | `How much PTO do I have?`, then `sam.rivera@contoso.com`, then `123456` | Verifies first; the code appears in the mock chat, then the HRIS answer |
| Sam Rivera · Teams | `My laptop screen is flickering and I can't work`, then `yes` | P2 IT ticket with read-back and confirmation |
| Sam Rivera · Teams | `Outlook won't open` | Attached to active incident `INC-004700` |
| Sam Rivera · Teams | `I clicked a phishing link`, then `yes` | P1 ticket and IT on-call transfer |
| Sam Rivera · Teams | `My manager has been making comments about me` | Confidential HR transfer; transcript segment redacted |

### Demo controls

Simulation mode only: the `POST` routes return `403` while the server answers real calls, so they can never touch a live call.

| Route | What it does |
| --- | --- |
| `GET /api/demo/clock` | The demo clock: `now`, `timeZone`, the current `preset`, and the presets. |
| `POST /api/demo/clock` | `{ "preset": "business-hours" }` (10:30 AM Pacific), `{ "preset": "after-hours" }` (7:30 PM), `{ "preset": "real" }`, or `{ "at": "<ISO 8601>" }`. Support hours, the Outlook outage, article review dates, and code expiry all follow it, and open calls move with it. |
| `POST /api/demo/reset` | Clears simulated calls, tickets (the next one is `INC-004821` again), HR callback cases, outage sign-ups, one-time codes, and metrics, and restores the starting clock. Anything a real call created is kept. |
| `GET /api/stats` | The audit metrics. `story` holds the numbers the console ends on: calls, answered, tickets filed, duplicates avoided, verified by code, wrong codes refused, sensitive routed privately (a count below `STATS_MIN_COUNT` shows as `<5`), and handed off. |

The console's simulator uses `POST /api/simulate` (with `teamsUserId` or `fromPhone`) and `POST /api/simulate/:id/say|dtmf|silence|hangup`. Simulated calls send nothing: no code, ticket message, or transfer leaves the server.

## Validation

```bash
npm test         # 47 node:test cases; no Azure and no network required
npm run check    # syntax check of src/, scripts/ and public/
npm run smoke    # boots its own simulation server on port 8198; no running server needed
```

`npm run smoke` drives both WebSocket upgrades, the hub frames a simulated call produces (including the mock chat and handoffs with their VoIP headers), the simulator controls, the demo clock, and the reset.

## Configuration

Copy `.env.example` to `.env` for live calls. Defaults run offline.

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interface the server listens on |
| `PORT` | `8098` | Local HTTP/WebSocket port |
| `PUBLIC_BASE_URL` | empty | HTTPS URL reachable by ACS/Event Grid |
| `ACS_ENDPOINT` | empty | Preferred keyless ACS auth with `DefaultAzureCredential` |
| `ACS_CONNECTION_STRING` | empty | Fallback when keyless auth is not available |
| `VOICE_LIVE_ENDPOINT` | empty | Azure AI Services endpoint |
| `VOICE_LIVE_API_KEY` | empty | Optional fallback; Entra auth is preferred |
| `VOICE_LIVE_MODEL` | `gpt-realtime` | Voice Live direct mode |
| `VOICE_LIVE_API_VERSION` | `2026-04-10` | Required API version |
| `TICKET_ADAPTER` | `sqlite` | `sqlite` or `memory`; either way **Reset demo** clears simulated tickets |
| `OTP_CHANNEL` | `teams` | Where one-time codes go: `teams`, `email`, or `sms`. Simulated calls never send one; real delivery is a stub until you wire `OtpSender.deliver` |
| `PASSWORD_RESET_TARGET` | empty | Empty means file a ticket instead of reset handoff |
| `CLASSIFIER_CONFIDENCE_MIN` | `0.7` | Below this the server asks one clarifying question |
| `DEMO_NOW` | empty | Simulation mode only: pins the starting demo clock (support hours, outage, article freshness, code expiry), which the console's clock and **Reset demo** return to. Ignored on live calls. Try `2026-05-15T10:30:00-07:00` |
| `CALL_TIME_BUDGET_MS` | `360000` | Six-minute cap |
| `WRAP_UP_MS` | `300000` | When the agent starts offering a ticket or a person |
| `TRANSCRIPT_RETENTION` | `false` | HR-sensitive text is never persisted even when enabled |
| `STATS_MIN_COUNT` | `5` | Confidential HR counts below this are reported as `<` and this number, for example `<5` |
| `DB_PATH` | `./data/triage.db` | SQLite audit and ticket store; `:memory:` keeps nothing on disk |

Committed fixtures live under `config/` and `kb/`. Runtime SQLite files are created under `data/`, which is gitignored.

## Project layout

```text
config/                     taxonomy, sensitive topics, priority matrix, outages, routing, and the
                            directory, HRIS and ITSM fixtures
kb/                         approved IT and HR articles, each with an owner and a review date
public/
  index.html, styles.css    the presenter console
  app.js                    the console: renders what the server decided, never decides itself
  beats.js                  the scripted demo: seven beats, with the narration
  presenter-kit.js, .css    vendored shared console kit; do not edit here. Edit
                            scripts/presenter-kit/ at the repo root, then run
                            node scripts/sync-presenter-kit.js
scripts/
  provision-teams-phone.ps1 Teams Phone resource account and call queues
  smoke-websockets.mjs      npm run smoke: boots its own server on port 8198
src/
  flow.mjs                  the triage state machine and every policy decision
  policy.mjs                taxonomy, sensitive guard, priority matrix, outages, routing, knowledge
  offline.mjs               typed utterances to the same server tools the model uses
  server.mjs                Express, the hub, simulation and demo controls, ACS callbacks
  adapters/                 directory, HRIS, one-time codes, tickets (memory and SQLite)
  voice/                    ACS media bridge to Voice Live
test/triage.test.mjs        node:test suite
```

## Live setup

1. Provision a Teams Phone resource account and the five call queues in `config/routing.json` with `scripts/provision-teams-phone.ps1`. The password reset assistant is optional; see `PASSWORD_RESET_TARGET`.
2. Link the Teams Phone resource account to ACS through Teams Phone extensibility, or use an ACS number fallback.
3. Assign the app identity ACS permissions and Azure AI **Cognitive Services User** plus **Foundry User** roles.
4. Set `ACS_ENDPOINT`, `PUBLIC_BASE_URL`, and `VOICE_LIVE_ENDPOINT`.
5. Replace placeholder Teams object IDs in `config/routing.json`.
6. Wire `OtpSender.deliver` in `src/adapters/otp.mjs` (Microsoft Graph for Teams chat, or Azure Communication Services for SMS or email) before relying on phone-caller verification. Until then a real phone caller's code is generated and logged as undelivered, never sent.

With Azure configured, the console's mode chip says **live · Teams Phone**, the demo clock and reset are switched off, and the console follows real calls; see [`DEMO-SCRIPT.md`](./DEMO-SCRIPT.md#taking-a-real-call).

## Architecture

`src/flow.mjs` owns the state machine and imports no Azure or Express modules. `src/offline.mjs` maps typed utterances to the same server tools the model uses. `src/server.mjs` hosts Express, `/health`, `/api/stats`, the demo controls, the local WebSocket presenter console, Event Grid intake, ACS callbacks, and simulation APIs. `src/voice/*` bridges ACS bidirectional media to Voice Live as PCM16 24 kHz and supports barge-in.

## Tests

`node:test` covers offline fixture routing, sensitive guard, verification, personal answers, tickets, priority matrix, outage attachment, password reset handoff/fallback, DTMF, time caps, health, stats suppression, privacy guards, the mock-chat code and handoff frames the console shows, and the demo clock and reset. No cloud credentials are required.

## Security notes before production

Replace fixture adapters with least-privilege directory, HRIS, OTP, and ITSM integrations. Review the sensitive categories and safety text with HR, legal, employee relations, and qualified EAP/clinical partners. Do not persist raw audio. Use managed identity or Key Vault for secrets, validate Teams queue membership, and complete privacy/works-council/records review before handling real employee HR matters.
