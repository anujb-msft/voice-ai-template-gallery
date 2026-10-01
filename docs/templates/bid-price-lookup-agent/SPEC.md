# Bid / Price Lookup Agent — Sample Specification

**Status:** implementation guide for an illustrative, demo-grade sample. This is not a
production pricing system. Its bid sheet and futures snapshot are local fixtures, and
its freshness thresholds and disclaimer wording are examples to replace with the
organization's own.

Rows marked † were not asked individually. They are inherited from the gallery baseline
shared with the intent-based call routing sample, or are defaults to confirm during
review.

## Scope decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Entry point † | Teams Phone resource account via Teams Phone extensibility, with a plain ACS number as a documented fallback |
| 2 | Scenario | Contoso Grain Co-op, a grain elevator cooperative posting cash bids for corn, soybeans, and wheat at five locations. Cash bid = futures + basis |
| 3 | Pricing data | A local bid sheet fixture (basis per location, commodity, and delivery month) plus a futures snapshot fixture. A pluggable feed adapter interface is documented for a real market-data provider |
| 4 | Freshness | Every price is spoken with its as-of time. Futures older than 20 minutes during the session, or a bid sheet not updated today, get a spoken caveat. Past the hard limit, or after the market closes, the agent speaks the last close labeled "as of close" |
| 5 | Authorization | Posted bids are public and need no authentication. A patron path (account number plus DTMF PIN, for contract-specific information) is a documented extension only and is not built |
| 6 | Location selection | The caller says a location name. Fuzzy matching uses aliases such as town names and "the north elevator". The agent confirms when the match is ambiguous and remembers the last location for follow-up questions in the same call |
| 7 | Price phrasing | The server formats a fixed phrase, for example "Corn at Riverside for November delivery is $4.12, that's 35 under December futures, as of 10:42 AM." The model reads it verbatim and never generates numbers |
| 8 | Range | Spot or nearby plus up to three posted delivery months. "All locations for corn" returns the top five sorted by price. No competitor comparisons |
| 9 | Disclaimer | Spoken once per call: "Bids are subject to change without notice. Confirm with the merchandiser before selling." The agent never advises whether to sell and never predicts markets |
| 10 | Handoff | Hours-aware. "I want to sell" or "book a contract", or pricing data unavailable, transfers to the location's merchandiser (a per-location Teams user or queue in config). After hours, the agent gives the merchandiser hours and closes |

## Implementation decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Voice Live model † | `gpt-realtime`, configurable |
| 2 | Session mode † | Direct model mode, with a documented path to Foundry agent mode |
| 3 | Credentials † | `DefaultAzureCredential` preferred, with an API key as the quick-start fallback |
| 4 | Offline runnability † | Full local mode, where a typed transcript drives the real state machine, location matching, price formatting, and freshness rules |
| 5 | Verification † | Automated fixtures with `node:test`, plus a manual live-call checklist |
| 6 | Price math † | Deterministic server-side: cash bid = futures settle or last + basis, rounded to the cent. Basis is spoken in cents "over" or "under" the reference contract |
| 7 | Feed adapter † | A `PriceFeed` interface with `getBidSheet()` and `getFutures(symbols)`. The sample ships a `FixtureFeed`. A live adapter is documented, not built |
| 8 | No-input policy † | Two reprompts, then a polite close |
| 9 | Transcript retention † | Events and quoted prices are stored at rest. The full transcript stays in memory unless persistence is opted in |
| 10 | Handoff mechanics † | Blind `TransferCallToParticipant` to the location's merchandiser target, carrying `CallTopic` and `CallContext` |

## Experience decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Fictional org † | Contoso Grain Co-op |
| 2 | AI disclosure † | The agent says it is an automated assistant in its opening line |
| 3 | Pacing | Answer-first, no small talk. After each quote, the agent asks "anything else?" |
| 4 | Call cap | 3 minutes, configurable, then the agent closes politely |
| 5 | Repeat and pace † | "Repeat that" replays the last server phrase verbatim. "Slower" lowers the speaking rate for the rest of the call |
| 6 | DTMF † | `0` transfers to the last-mentioned location's merchandiser in hours. `*` repeats the last quote |
| 7 | Realtime transport † | Local WebSocket only, with no SignalR dependency |
| 8 | Default port † | `8094`, so it runs alongside the password-reset (`8090`), routing (`8091`), general inquiry (`8092`), and after-hours lead capture (`8093`) samples |
| 9 | Gallery card † | Visual scene updated to depict the location, commodity, and quote flow when the sample lands |
| 10 | Transfer audio † | A spoken "connecting you with the Riverside merchandiser now", with no hold tone |

## Goal

Build a runnable inbound voice agent that answers Contoso Grain Co-op's bid line. It
should tell callers the current cash bid for a commodity at a location, state how fresh
that price is, and hand off to a merchandiser when the caller wants to sell. This
replaces a manually updated voicemail recording and the repetitive price calls to
location staff.

The agent is a price reader, not a merchandiser. Every number it speaks comes from a
server-formatted phrase. It never computes, rounds, or estimates a price, never says
whether a price is good, and never predicts the market.

The demo data lives in `config/`:

| File | Contents |
|---|---|
| `locations.json` | Location ID, display name, aliases, merchandiser Teams target, merchandiser hours, and time zone |
| `bids.json` | Bid sheet: `updatedAt`, and per location, commodity, and delivery month, the basis in cents and the reference futures contract |
| `futures.json` | Futures snapshot: contract symbol, last price, settle, `asOf`, and market session state |
| `market.json` | Session hours, holiday dates, the 20-minute soft staleness limit, and the hard limit |

An example bid sheet entry:

```json
{
  "updatedAt": "2026-09-08T06:30:00-05:00",
  "bids": [
    { "location": "riverside", "commodity": "corn", "delivery": "2026-11",
      "reference": "ZCZ26", "basisCents": -35 }
  ]
}
```

## Caller experience

1. The caller dials the Contoso Grain Co-op bid line, which is a Teams Phone resource
   account linked to ACS through Teams Phone extensibility. The documented ACS number
   fallback only changes provisioning.
2. Event Grid delivers `IncomingCall`. The server answers through Call Automation,
   starts bidirectional media streaming, and opens a Voice Live session.
3. The agent greets the caller: **"Contoso Grain Co-op bid line. I'm an automated
   assistant. Bids are subject to change without notice. Confirm with the merchandiser
   before selling. Which commodity and location?"**
4. The caller asks, for example, "What's corn at Riverside?" The agent calls
   `get_bid`. If the location is ambiguous, the agent asks **"Did you mean Riverside or
   Riverbend?"** A follow-up such as "and beans?" reuses the last location.
5. The agent reads the server phrase verbatim: **"Corn at Riverside for November
   delivery is $4.12, that's 35 under December futures, as of 10:42 AM."** When the
   caller asks for other months, it reads up to three posted months.
6. If futures are older than 20 minutes during the session, or the bid sheet was not
   updated today, the phrase includes a caveat: **"These prices may be delayed."** After
   the hard limit, or after the close, the agent reads the close: **"As of yesterday's
   close, corn at Riverside was $4.08."**
7. "All locations for corn" returns the top five locations sorted by price, each read in
   the same fixed form.
8. If the caller wants to sell or book a contract, or the pricing data is unavailable,
   the agent checks the merchandiser hours. In hours, it says **"Connecting you with the
   Riverside merchandiser now"** and transfers. After hours, it gives the hours and
   closes.
9. If the caller asks "should I sell?" or "where's the market going?", the agent says
   **"I can't advise on that, but the merchandiser can talk it through with you."** It
   then offers a transfer in hours.
10. After each answer, the agent asks "anything else?". The 3-minute cap
    (`CALL_TIME_BUDGET_MS`) or two no-inputs end the call politely.

## Architecture and implementation shape

```text
PSTN caller
   → Teams Phone service number / resource account   (fallback: plain ACS number)
   → ACS Call Automation (Event Grid, callbacks, call control, media streaming)
   ↔ Node.js 22 bid service
       ↔ Azure AI Voice Live API over WebSocket
       ↔ PriceFeed adapter (FixtureFeed: bids.json + futures.json)
       ↔ locations + market hours + freshness rules
       ↔ SQLite audit log (calls, quotes, caveats, transfers)
       ↔ presenter console over a local WebSocket
   → ACS transfer to location merchandiser (Teams user or Call Queue)
```

Reuse the password-reset sample's Express server, configuration pattern, ACS-to-Voice
Live media bridge, PCM16 24-kHz path, barge-in handling, SQLite event log, health
endpoint, and simulation-mode conventions. The state machine is:

`ringing → greeting → listening → quoting → listening … → (transferring → transferred) | closing → ended`

The model changes state only through server-owned tools:

- `get_bid(commodity, location?, month?)` resolves the location (or reuses the last
  one), computes the bid, applies the freshness rules, and returns `phrase`,
  `freshness` (`live`, `delayed`, or `close`), and `ambiguous` with candidate names when
  a match is unclear. The model receives the phrase, not the raw numbers.
- `list_bids(commodity, month?)` returns up to five phrases sorted by price.
- `transfer_to_merchandiser(location?, reason)` checks merchandiser hours. It either
  transfers or returns the after-hours phrase. The model never sees the Teams target.
- `repeat_last()` returns the last phrase.
- `end_call(reason)` closes the call.

Location matching normalizes case and punctuation and then checks exact names, aliases,
and a bounded edit distance. More than one candidate within the threshold returns
`ambiguous`. The price phrase formatter is the only place numbers are turned into
words. It speaks dollars and cents, basis in cents over or under the named contract
month, and the as-of time in the location's time zone.

## Teams handoff contract

Transfers use `TransferCallToParticipant` to the location's merchandiser in
`config/locations.json`. The target is either a Teams user (`MicrosoftTeamsUserIdentifier`)
or a Call Queue resource account (`MicrosoftTeamsAppIdentifier`). The Teams Phone
extensibility custom context carries:

- `CallDetails.SessionId`: the Auto Attendant session ID when present, and otherwise the
  ACS correlation ID, which is kept in the audit record.
- `CallDetails.CallTopic`: for example `Sell corn – Riverside`, up to 48 characters.
- `CallDetails.CallContext`: the last quote the caller heard, with its as-of time, and
  the reason for the transfer.

After hours, no transfer is attempted. The agent speaks the merchandiser hours from
config.

## Demo surface and configuration

The presenter console shows call state, the live transcript, the resolved location and
any alternatives, the computed bid with its futures and basis components, the freshness
decision, and the exact phrase sent to the model. A bid board view shows the current
sheet with a **Make stale** control that ages the futures snapshot, and a **Feed down**
toggle that simulates an outage. The console is marked as a demo surface.

Configuration covers `PORT` (`8094`), `PUBLIC_BASE_URL`, `ACS_ENDPOINT` (with
`ACS_CONNECTION_STRING` as the fallback), `VOICE_LIVE_ENDPOINT`, `VOICE_LIVE_MODEL`
(`gpt-realtime`), and `VOICE_LIVE_API_VERSION` (`2026-04-10`), with Entra auth using the
**Cognitive Services User** and **Foundry User** roles and the
`https://ai.azure.com/.default` scope. It also covers `PRICE_FEED` (`fixture`),
`FUTURES_STALE_MINUTES` (`20`), `FUTURES_HARD_LIMIT_MINUTES`, `DEMO_NOW` (pins the clock
so fixtures produce deterministic freshness), `CALL_TIME_BUDGET_MS` (`180000`), and a
single `LOCALE`/`VOICE` pair.

With no Azure subscription, the typed-transcript mode drives the same state machine,
matching, formatting, and freshness rules. Only audio and the transfer are simulated.
The sample ships a README, `DEMO-SCRIPT.md`, the Teams provisioning snippet, the config
fixtures, and the call fixtures.

## Acceptance criteria

- A real call to the provisioned number is answered through Teams Phone extensibility
  and connected to Voice Live. The ACS number fallback reaches the same state machine.
  An in-hours transfer reaches the merchandiser target. All are verified by the manual
  live-call checklist.
- Barge-in works, and duplicate Event Grid deliveries do not create duplicate sessions.
- `node:test` runs the fixtures with no cloud credentials. They cover a single quote, a
  follow-up that reuses the location, an alias match, an ambiguous location, an unknown
  location, an unknown commodity, a deferred month, an unposted month, all locations for
  a commodity, stale futures, a bid sheet not updated today, the hard limit falling back
  to the close, after the market closes, a holiday, a feed outage with transfer in hours,
  a feed outage after hours, a sell request in hours, a sell request after hours, a
  "should I sell" question, a repeat request, `*` and `0` DTMF, two no-inputs, an expired
  call cap, and a caller prompt-injection attempt asking for a different price.
- Every spoken price matches the server phrase exactly. The model never speaks a number
  that did not come from a tool result.
- Every quote includes its as-of time. The disclaimer is spoken exactly once per call.
- The agent never advises on selling, never predicts markets, and never compares
  competitors.
- The opening line discloses that the caller is talking to an automated assistant.
- Utterance text is absent from the database unless transcript persistence is enabled.
- `GET /health` reports application, Voice Live, Teams Phone provisioning, feed status,
  bid sheet age, futures age, market session state, and simulation mode.
- `GET /api/stats` reports calls, calls automated (no transfer), quotes by commodity and
  location, delayed and close-price quotes, feed outages, transfers by reason, and
  estimated staff minutes saved (calls automated × a configurable minutes-per-call).

## Production gates and non-goals

The sample does not connect to a real market-data feed, authenticate patrons, show
contract balances, book contracts, send prices by SMS, record calls, or support multiple
languages. Before real use, the following are needed:

- A licensed market-data feed with redistribution rights for spoken quotes, and an
  exchange delay disclosure if the data is delayed.
- Legal and compliance review of the disclaimer wording and of the no-advice boundary.
- Merchandiser sign-off on the bid sheet publishing process and freshness thresholds.
- Patron authentication before exposing any contract-specific information.
- Accessibility review, including TTY and relay access.
- Validated Event Grid subscriptions, warm compute on the answer path, rate limits, and
  managed identity or Key Vault for feed credentials.
- Applicable Teams certification and organizational reviews.

Primary measures are calls automated, staff time saved, and price freshness at the time
of quote.

## Microsoft reference contracts

- [Teams Phone extensibility overview](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-overview)
- [Answer Teams Phone calls with Call Automation](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-answer-teams-calls)
- [Teams Phone extensibility IVR and transfer](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-interactive-voice-response)
- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [Voice Live API how-to — endpoint, api-version, and Entra auth](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to)
- [Call Automation transfer to a participant](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/actions-for-call-control#transfer-a-participant-in-a-call)
