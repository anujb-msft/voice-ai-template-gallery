# Bid / Price Lookup Agent

An inbound Teams Phone bid line for a grain co-op. A grower calls, asks "what's corn
paying at Riverside?" in their own words, and hears today's cash bid (the price, the
basis against the futures month, and the time it was taken) instead of a recording
that someone re-records every morning.

The point is not that a model can read a number aloud. It is that the model never
decides the number. The server formats every price, decides whether it may be called
current, refuses to quote at all when the feed is down, and sends anything that sounds
like a contract to a merchandiser, with the caller's question and last quote already on
the merchandiser's screen.

Built on [Azure Communication Services Call Automation](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation),
the [Azure AI Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live),
and Teams Phone extensibility.

> Illustrative sample, not a pricing system. Contoso Grain Co-op, its locations, bids
> and futures are fictional fixtures in `config/`. Replace them with a licensed
> market-data feed before real use, and read
> [Security notes before production](#security-notes-before-production) before pointing
> this at a real phone number.

## What the demo shows

- **The server says the number.** The model passes on the commodity and the location
  the caller named. The server returns the sentence to read: cash bid, basis, futures
  month and "as of" time. The model never sees the raw numbers it could rephrase.
- **One question, never a guess.** A missing or unknown commodity, or a location that
  matches two elevators ("the river elevator": Riverbend or Riverside?), gets one short
  clarifying question. The answer fills only the gap that was asked about.
- **Freshness is a server rule.** Futures more than 20 minutes old are quoted with
  "These prices may be delayed." After the close, on a market holiday, or past a
  240-minute hard limit, the agent gives the last settlement and says so. A repeat
  re-checks the price first; it is never a replay.
- **Feed down means no number.** When the pricing feed fails, the agent says so plainly
  and offers the merchandiser now or a callback. The server has no number to hand over,
  and the agent is told never to invent one.
- **No advice, no contracts.** "Should I sell now?" is declined. "Lock in 5,000
  bushels" is a hard stop: nothing is locked, and the call goes to the location's
  merchandiser.
- **Context that survives the handoff.** The topic, the last quote, the caller's own
  words and the reason travel to Teams as VoIP headers, and the console shows the
  literal headers next to a mock Teams incoming-call toast.
- **Honest hours.** Outside a merchandiser's hours the agent gives the hours instead of
  transferring the caller to an empty desk.

## Quick start

Runs with no Azure subscription at all.

```bash
npm install
npm start
# open http://127.0.0.1:8094
```

The console runs a scripted demo: press **→** (or **Next ▶**) and it plays five short
beats, typing (and, if you like, speaking) the caller's lines. [DEMO-SCRIPT.md](DEMO-SCRIPT.md)
is the running order, with what to say at each step.

Or drive it yourself: pick a **Caller ID**, click **Answer a call**, and type what the
caller says. A typed transcript drives *the same flow* a real call would: the same
location matching, the same freshness policy, the same handoff assembly. Only the model
and the audio path are stubbed. The clock in the header moves the time the pricing
policy sees, and **Take the feed down** simulates an outage.

Try these, on the default **Prices fresh** clock unless the row says otherwise:

| Type this | What you should see |
| --- | --- |
| `What's corn paying at Riverside?` | $4.12 for November delivery, 35 under December futures, as of 10:42 AM |
| `All locations for corn` | Five quotes, highest first, from Prairie Center at $4.18 to Fairview at $4.10 |
| `What's the bid at Fairview?` | "Which commodity at Fairview — corn, soybeans, or wheat?" |
| `Corn at the river elevator?` | "Did you mean Riverbend or Riverside?" |
| `Soybeans at Riverside?` on **Prices stale** | $10.11, then "These prices may be delayed." |
| `Corn at Riverside?` on **Market closed** | "As of the last close, corn at Riverside for November delivery was $4.08…" |
| A quote, then `Should I sell now?` | "I can't advise on that, but the merchandiser can talk it through with you." |
| A quote, then `Okay, lock in 5,000 bushels at that price.` | Nothing is locked: the call goes to the Riverside merchandiser, with the context |
| A quote, then keypad `*` or `0` | The quote again, re-checked first; or the merchandiser |
| **Take the feed down**, then `Wheat at Lake Mills?` | No number: the Lake Mills merchandiser now, or a callback (offered only when there is a caller ID) |
| A quote on **After hours**, then `I want to sell.` | The merchandiser's hours instead of a transfer |

Run the tests — they need no Azure and no network:

```bash
npm test        # 44 cases across the call flow, the pricing policy and the Teams handoff
npm run check
npm run smoke   # boots the server on port 8194 and checks both WebSockets and the demo controls
```

`npm run smoke` starts its own server in simulation mode and drives simulated calls
while it listens on the console's WebSocket. Then it starts the server again, configured
as if it answered real calls with placeholder settings, and checks that every demo
control refuses with `403`. It stops at once if something is already listening on 8194.

### Demo controls

In simulation mode the console can move the clock the pricing policy sees and take the
price feed down, so one running server shows live, delayed and last-close prices, a feed
outage and closed merchandisers:

| Endpoint | What it does |
| --- | --- |
| `GET /api/demo/clock` | The demo clock, its time zone, the market state and the presets |
| `POST /api/demo/clock` | `{ "preset": "prices-fresh" \| "prices-stale" \| "after-close" \| "after-hours" \| "real" }` or `{ "at": "<ISO 8601>" }` |
| `GET /api/demo/feed` | Whether the price feed is up, with its health |
| `POST /api/demo/feed` | `{ "up": false }` takes the price feed down; `{ "up": true }` brings it back |
| `POST /api/demo/reset` | Forget the simulated calls, clear them from the audit, restore the starting clock and bring the feed back up |
| `GET /api/stats` | The numbers in the console's footer: calls, quotes, clarifying questions, caveats, refusals, handoffs and callbacks |

The presets are on Tuesday, September 8, 2026, the morning the fixture bid sheet was
posted, in Central Time:

| Preset | Clock | What a quote does |
| --- | --- | --- |
| `prices-fresh` | 10:45 AM | Live: the futures are minutes old. The default |
| `prices-stale` | 11:20 AM | Delayed: the futures are past the 20-minute window, so the quote carries the caveat |
| `after-close` | 2:00 PM | Last close: the futures market closed at 1:20 PM |
| `after-hours` | 6:30 PM | Last close, and the merchandisers are closed, so the agent gives their hours instead of transferring |
| `real` | Now | The fixtures are dated, so quotes come out as last-close prices |

All three `POST`s return `403` while the server answers real calls: a live call is always
priced on the real time and the real feed, and a reset never deletes a real call's audit
record. Set `DEMO_NOW` to a preset or an ISO 8601 time to start the server with the clock
already there.

## How it works

```
PSTN caller
   │  Event Grid: Microsoft.Communication.IncomingCall
   ▼
ACS Call Automation ──── answerCall + bidirectional media streaming ────┐
   │                                                                    │
   │  PCM16 24 kHz mono (pcm24KMono)                                    │
   ▼                                                                    │
this server ──── WebSocket, PCM16 forwarded verbatim ────► Voice Live ──┘
   │                                                         (gpt-realtime)
   │  get_bid / list_bids / repeat_last / transfer_to_merchandiser / …
   ▼
BidLookupFlow ◄──── PriceBook: bid sheet + futures + market hours (config/)
   │
   └──── TransferCallToParticipant + VoIP custom context ────► Teams merchandiser
                                                                (user or call queue)
```

### The server says the number

`src/flow.mjs` owns the call and `src/pricing.mjs` owns every price; neither imports
anything from Azure, Express or SQLite. The model's tools take only what the caller
said (a commodity, a location, a delivery month) and give back the sentence to read and
the flags to act on. They never return the raw cash bid, basis or futures price, never a
Teams object ID, and no tool has a field for a phone number or a Teams target. Tests
assert all three.

```
ringing → greeting → listening ⇄ quoting
                        ├→ transferring → transferred
                        │       └→ listening again, if the transfer does not connect
                        └→ ended   (goodbye, callback logged, after hours, silence, time budget)
```

| Rule | Where it is enforced |
| --- | --- |
| Which locations, commodities and delivery months exist | `config/locations.json` and `config/bids.json`, loaded by `LocationDirectory` and `PriceBook` |
| An unclear commodity or location gets one question | `LocationDirectory.match` reports a missing, unknown or ambiguous location; `PriceBook.quote` turns that, or a missing commodity, into `clarify: true` with the one question to ask |
| Cash bid = futures + basis, said as one sentence | `PriceBook#formatQuote` |
| Live, delayed with a caveat, or last close | `PriceBook#formatQuote`, from the futures timestamps, `FUTURES_STALE_MINUTES`, `FUTURES_HARD_LIMIT_MINUTES`, and the session hours and holidays in `config/market.json` |
| A repeat is re-checked, never replayed | `BidLookupFlow#recheck` |
| No feed, no number | `BidLookupFlow#feedDown` |
| No advice, and nothing is ever locked | No tool can lock, book or contract a price. `BidLookupFlow.adviceBoundary` declines advice, and `transferToMerchandiser` with `contract_request` hands a lock request to a person |
| Whether a merchandiser is open | `LocationDirectory.isMerchandiserOpen`, in the location's own time zone |
| How long a real call may take | `CALL_TIME_BUDGET_MS`, default 3 minutes |
| A transfer that does not connect | `BidLookupFlow.transferFailed`: a callback offer, or the hours when there is no caller ID |

The freshness policy, as the caller hears it:

| Situation | What the agent says |
| --- | --- |
| Market open, futures under 20 minutes old, today's bid sheet | The cash bid, the basis against the futures month, and the "as of" time |
| Futures between 20 and 240 minutes old, or no bid sheet posted today | The same, then "These prices may be delayed." |
| Market closed, a market holiday, or futures over 240 minutes old | "As of the last close, … was …", from the settlement price. Never called current |
| Price feed down | No number. The merchandiser now, or a callback; the hours if the merchandiser is closed |

Because the audit sink, the transfer function and the clock are all injected, the whole
flow is testable with plain `node --test`, with no mocks of the Azure SDK and no
subscription.

Every time the flow wants the agent to speak, it passes the exact sentence along with the
instruction. On a live call the bridge tells Voice Live to say exactly that sentence; the
offline console shows it verbatim. That is why simulation mode produces a readable
conversation without a model, and why the model is never the source of a price.

### What Teams receives

Only **VoIP headers** are used. SIP headers are a PSTN-side mechanism and do not reach a
Teams identifier, so context sent that way would vanish silently.

| Header | Contents |
| --- | --- |
| `CallDetails.SessionId` | The Auto Attendant session id when this line sits behind one, otherwise the ACS correlation id |
| `CallDetails.CallTopic` | What the caller wants, such as `Lock a price: corn – Riverside`, clipped to the Teams 48-character limit |
| `CallDetails.CallContext` | The last quote, up to three of the caller's own lines, and the reason |
| `CallDetails.LocationId` | The location whose merchandiser is taking the call |
| `CallDetails.TransferReason` | `contract_request`, `sell_request`, `advice_request`, `feed_outage`, `caller_requested` or `dtmf_0` |

The console's **VoIP headers on the wire** panel is built on the server by the same
`buildCustomCallingContext` the transfer uses, so what it shows is what Teams receives.

A merchandiser who is a named person is addressed as a Teams *user*
(`{ microsoftTeamsUserId }`); a merchandiser call queue is a resource account, addressed
as a Teams *app* (`{ teamsAppId }`). Both take a Microsoft Entra object ID, which is why
`locations.json` holds object IDs and never phone numbers.

## Configuration

Copy `.env.example` to `.env`. Everything has a working default except the three values
that make real calls possible.

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8094` | Where the server and the console listen |
| `ACS_ENDPOINT` | — | Required to answer real calls. Keyless, via `DefaultAzureCredential` |
| `ACS_CONNECTION_STRING` | — | Fallback if you cannot use Entra. `ACS_ENDPOINT` wins if both are set |
| `PUBLIC_BASE_URL` | — | Must be reachable by Event Grid and ACS |
| `VOICE_LIVE_ENDPOINT` | — | Azure AI Services resource |
| `VOICE_LIVE_API_KEY` | *(empty)* | Leave empty to use Entra, which is recommended |
| `VOICE_LIVE_MODEL` | `gpt-realtime` | The realtime model |
| `VOICE_LIVE_API_VERSION` | `2026-04-10` | Voice Live WebSocket API version |
| `VOICE_LIVE_VOICE` | `en-US-Ava:DragonHDLatestNeural` | Azure TTS voice; set this alongside `LOCALE` |
| `LOCALE` | `en-US` | Opening/model language and speech-recognition hint; callers may explicitly request a switch |
| `TEAMS_CLOUD` | `public` | `public`, `dod` or `gcch`: the Teams cloud of the call queue targets |
| `PRICE_FEED` | `fixture` | Names the price source on the price card and in `/health`. Only the fixture feed ships |
| `FUTURES_STALE_MINUTES` | `20` | Older futures are quoted with "These prices may be delayed." |
| `FUTURES_HARD_LIMIT_MINUTES` | `240` | Older futures are never quoted as current; the last close is used |
| `CALL_TIME_BUDGET_MS` | `180000` | Real calls only; then the agent closes politely |
| `LOCATIONS_PATH`, `BIDS_PATH`, `FUTURES_PATH`, `MARKET_PATH` | `./config/*.json` | Point these at `*.local.json` copies to keep your own IDs and bids out of git |
| `DB_PATH` | `./data/bid-price-lookup.db` | The SQLite audit log |
| `PERSIST_TRANSCRIPTS` | `false` | Calls, events and quotes are always stored; utterances are not |
| `DEMO_NOW` | *(empty)* | Simulation only. Starts the demo clock at a preset (`prices-fresh`, `prices-stale`, `after-close`, `after-hours`, `real`) or an ISO 8601 time; empty means `prices-fresh`. Ignored on real calls |

Until all three call variables are set, the server logs `SIMULATION MODE` and runs the
offline console. `GET /health` breaks readiness out per subsystem, because "not ready" is
rarely uniform: Voice Live can be configured while ACS is not, and both can be configured
while `locations.json` still holds the placeholder object IDs.

```jsonc
{
  "mode": "simulation",
  "voiceLive": { "ready": false, "auth": "entra", "model": "gpt-realtime" },
  "telephony": { "ready": false, "auth": "none", "missing": ["ACS_ENDPOINT", "PUBLIC_BASE_URL"] },
  "teams":     { "ready": false, "unprovisionedLocations": ["riverside", "riverbend", "fairview", "prairie-center", "lake-mills"] },
  "feed":      { "ok": true, "up": true, "source": "fixture", "futuresAgeMinutes": 9, "staleAfterMinutes": 20, "marketSessionState": "open" },
  "clock":     { "preset": "prices-fresh", "now": "2026-09-08T15:45:00.000Z", "pinned": true }
}
```

The `teams` line answers "why did my transfer fail?" before anyone has to read a log, and
the `feed` line answers "why did it say the prices may be delayed?".

### Keyless auth

Both Azure connections default to Entra, so no key needs to live on disk.

**ACS.** Set `ACS_ENDPOINT` and leave `ACS_CONNECTION_STRING` unset. The signed-in
identity needs **Communication and Email Service Owner** on the ACS resource. Locally that
identity comes from `az login`; in Azure, use a managed identity.

**Voice Live.** Assign the same identity both roles on the AI Services resource:

- **Cognitive Services User**
- **Foundry User**

The server then acquires a token for the `https://ai.azure.com/.default` scope through
`DefaultAzureCredential`. Setting `VOICE_LIVE_API_KEY` overrides this.

### Locations, bids and the market

`config/locations.json` is the directory the agent can quote for and transfer to. Adding a
location is a config change, not a prompt rewrite: the list of locations given to the model
is generated from this file.

```jsonc
{
  "id": "riverbend",
  "displayName": "Riverbend",
  "aliases": ["riverbend", "river bend", "east elevator", "east"],  // what callers say
  "timeZone": "America/Chicago",
  "hours": { "days": [1, 2, 3, 4, 5], "open": "08:00", "close": "17:00" },
  "merchandiser": {                                                 // the model never sees this
    "displayName": "Riverbend merchandiser queue",
    "type": "callQueue",                                            // callQueue | user
    "objectId": "<entra-object-id>"
  }
}
```

- `config/bids.json` is the morning bid sheet: a basis in cents for each location,
  commodity and delivery month, against a futures contract, and the time it was posted.
- `config/futures.json` is the futures snapshot, with an `asOf` time per contract. The
  cash bid is the futures price plus the basis: `last` while the market is open, `settle`
  for a last-close quote.
- `config/market.json` holds the futures session hours, the time zone and the market
  holidays.

## Connecting it to a real phone number

Inbound uses **Teams Phone extensibility**: the caller dials a Teams service number on a
resource account, Teams routes the call to your linked ACS resource, and this sample
answers it with Call Automation.

```
PSTN caller → Teams service number → Teams resource account → linked ACS resource
            → Microsoft.Communication.IncomingCall (Event Grid) → this sample
```

> **The number is the part that trips people up.** Teams Phone extensibility requires a
> Teams *service* number, from Microsoft Calling Plan, Operator Connect, or Direct
> Routing. **A phone number purchased in Azure Communication Services cannot be assigned
> to a Teams resource account**: there is no cmdlet or portal path that converts one.
> Acquiring a Microsoft number also needs at least one Calling Plan license in the tenant,
> and toll-free needs funded pay-as-you-go billing. The free `PHONESYSTEM_VIRTUALUSER`
> license is right for the resource account itself but does not let you acquire a number.
>
> If you only hold an ACS number you can still exercise the whole flow: calls to it reach
> this sample as ordinary Call Automation calls. They arrive without the Teams resource
> account identity, and the server logs them as `acs-direct` rather than
> `teams-phone-extensibility`, so the difference is never silent.

1. **Provision.** An ACS resource, an Azure AI Services resource, and a Teams tenant with
   a service number on a resource account.
2. **Register a calling bot** and create the resource account against its application ID,
   so the account is yours rather than a first-party Auto Attendant.
3. **Bind the resource account to ACS.** `Set-CsOnlineApplicationInstance -AcsResourceId
   <immutable GUID>`, then `Sync-CsOnlineApplicationInstance`. See
   [`scripts/provision-teams-phone.ps1`](scripts/provision-teams-phone.ps1), which also
   prints the remaining Azure-side steps.
4. **Grant ACS server consent** for that resource account via the `teamsExtension`
   assignment API. The Teams-side binding alone is only half of it.
5. **Collect object IDs.** Put the Entra object ID of each location's merchandiser in
   `locations.json`: a call queue's resource account (`"type": "callQueue"`; the script
   reads these back), or a person with Enterprise Voice (`"type": "user"`; for example
   `az ad user show --id <upn> --query id -o tsv`). To keep your own IDs out of git, copy
   the file to `config/locations.local.json` and set `LOCATIONS_PATH`;
   `config/*.local.json` is gitignored.
6. **Expose this server.** `npm run tunnel`, then set `PUBLIC_BASE_URL`.
7. **Subscribe to `IncomingCall`.** Create an Event Grid subscription on the ACS resource
   with a webhook endpoint of `<PUBLIC_BASE_URL>/api/events`, filtered to
   `Microsoft.Communication.IncomingCall`. The server answers the validation handshake
   automatically. Set the calling webhook on your Azure Bot to `https://eventgrid.azure.net`.
8. **Check `/health`,** then call the number. `telephony` and `teams` should both report
   ready.

### Live call test matrix

These phrases exercise the common paths on a real Voice Live call. The model chooses its
own words around the tool results, so the wording can vary; the prices, the caveats, the
refusals and the handoffs come from the server.

| Flow | Say or do | Expected behavior |
| --- | --- | --- |
| Quote | `What's corn paying at Riverside?` | Reads the server's sentence: cash bid, basis against the futures month, "as of" time |
| Follow-up | `And beans?` | Soybeans at the same location |
| Clarify | `What's the bid at Fairview?` | Asks which commodity, then quotes the one you name |
| Repeat | `Say that again?`, or press `*` | Re-checks the price, then reads it again, with a caveat if it went stale |
| Advice | `Should I sell now?` | Declines to advise, then offers the merchandiser |
| Lock a price | `Lock in 5,000 bushels at that price.` | Says it cannot lock a price, then transfers to the merchandiser with the context |
| A person | Press `0` after a quote | Transfers to that location's merchandiser |
| After hours | Any transfer outside the merchandiser's hours | Gives the hours and closes, without transferring |
| Transfer recovery | Accept a transfer while the Teams target is unavailable | Offers a callback, or gives the hours when there is no caller ID |

## Project layout

```
src/
  flow.mjs        the call state machine — no Azure, Express or SQLite imports
  pricing.mjs     locations, the fixture feed and the price book: matching, freshness, phrases
  handoff.mjs     merchandiser target → Teams identifier, context → VoIP headers
  agent.mjs       the tool schema and standing instructions given to the model
  offline.mjs     keyword parser that stands in for the model, used only by the console
  audit.mjs       in-memory audit sink and the stats (the interface the flow depends on)
  db.mjs          the SQLite implementation of that same interface
  realtime.mjs    WebSocket hub that pushes state to the console
  config.mjs      environment settings and per-subsystem readiness
  server.mjs      Event Grid intake, ACS callbacks, simulation API, demo clock and feed
  voice/
    voice-live.mjs  the Voice Live WebSocket session
    acs.mjs         answer, transfer, DTMF, hang up
    call-bridge.mjs binds one call to one Voice Live session
config/
  locations.json  locations, aliases, hours and merchandiser targets
  bids.json       the morning bid sheet: basis by location, commodity and delivery month
  futures.json    the futures snapshot
  market.json     futures session hours and market holidays
public/           the presenter console
  app.js          the panels: call, quote, merchandiser toast, decision trail, metrics
  beats.js        the scripted demo and its narration — edit this to adapt the demo
  presenter-kit.* shared console building blocks, vendored: edit scripts/presenter-kit/
                  at the repository root, then run `node scripts/sync-presenter-kit.js`
scripts/
  smoke-websockets.mjs      boots the server and checks the WebSockets and the demo controls
  provision-teams-phone.ps1 binds a Teams resource account to ACS and reads back object IDs
test/             44 cases, no Azure required
```

`flow.mjs`, `pricing.mjs`, `handoff.mjs`, `agent.mjs`, `offline.mjs` and `audit.mjs`
import no third-party packages. That is deliberate: the parts you most need to read and
trust are the parts that run without installing anything.

## Operational notes

- **Event Grid delivers duplicates by design.** The server de-duplicates on event id
  before answering, so a redelivery does not answer the same call twice.
- **DTMF is always on.** Continuous recognition starts on `CallConnected`: `*` repeats the
  last answer, re-checked first, and `0` asks for the merchandiser. The keypad is mentioned
  aloud only after a silence or a key that does nothing.
- **The second silence on a call ends it politely**, and so does `CALL_TIME_BUDGET_MS` on
  a real call. Simulated calls are exempt from the budget, because the presenter talks to
  the room between lines.
- **The transfer is blind.** The agent's job ends once the context is delivered. Staying on
  the line would put a silent third party on every handoff.
- **`CallTransferFailed` reopens the call.** With a caller ID the agent offers a callback;
  without one it gives the merchandiser's hours and closes. The caller is never left in
  silence.
- **The model can't hang up on a transfer.** While a transfer is in progress or complete,
  `end_call` is refused and the bridge closes without hanging up, so an early goodbye
  can't drop the caller on the way to a person.
- **Barge-in** sends `StopAudio` to ACS and `response.cancel` to Voice Live, so the agent
  stops mid-word rather than talking over the caller.
- **Voice Live allows one in-flight response.** A state change and a tool result can both
  want the agent to speak, so requests are coalesced in `voice-live.mjs`.
- **A callback is a logged request.** It is recorded in the audit log with the caller's
  number masked, and the agent promises no time. Connect it to your own task list before
  you rely on it.

## Security notes before production

- **Use a licensed market-data provider**, and check that its terms allow spoken quotes.
- **Review the disclaimer and the no-advice language** with your legal and compliance
  teams.
- **Caller ID is not authentication.** It is used only to offer a callback. Authenticate
  patrons before exposing contract-specific or account-specific information.
- **The model cannot choose a destination or a price.** It passes on what the caller said;
  the server picks the Teams target from an allowlist and formats every number. Keep it
  that way: a tool that accepts a phone number turns a prompt injection into a toll-fraud
  vector.
- **Transcripts are off by default.** Calls, events and quotes are persisted because they
  are the audit trail; utterance text reaches disk only if you set `PERSIST_TRANSCRIPTS`,
  and only with retention you have approved.
- **Disclose the assistant.** The opening line says it is automated. Several jurisdictions
  require this; all callers deserve it.
- **Phone numbers are masked** in the console, the audit database, and the logs.
- **Keep secrets out of the repository.** Prefer managed identity; otherwise use Key
  Vault, and never commit `.env`.
- **Before you take real traffic,** add rate limits, warm compute, monitoring, durable
  Event Grid de-duplication (the sample's is in memory), and a Teams certification review.
- The locations, bids, futures and object IDs are fictional placeholders. Replace them.

## Microsoft references

- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [How to use the Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to)
- [Call Automation overview](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation)
- [Passing contextual data with custom headers](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/custom-context)
- [Teams interop with Call Automation](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/teams-interop-call-automation)
- [Bidirectional media streaming](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/audio-streaming-quickstart)
- [Teams Phone extensibility FAQ](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-faq)
- [Teams Phone extensibility quickstart](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-quickstart)
