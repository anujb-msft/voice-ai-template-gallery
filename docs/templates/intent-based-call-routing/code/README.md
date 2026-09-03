# Intent-Based Call Routing

An inbound Teams Phone receptionist. Someone calls the main line, says why they are
calling in their own words, and gets connected to the right team — with a topic, a
summary and their caller record already on the receiving agent's screen.

The point is not that a model can classify a sentence. It is everything around that:
what happens when it is unsure, when the caller changes their mind, when the queue is
closed, when the transfer fails, and how the receiving human avoids asking "so what's
this about?" for the second time.

Built on [Azure Communication Services Call Automation](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation),
the [Azure AI Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live),
and Teams Phone extensibility.

> Illustrative sample. The routes, the caller directory and the organisation are
> fictional. Read [Security notes before production](#security-notes-before-production)
> before pointing this at a real phone number.

## What the demo shows

- **No menu.** The caller is asked one open question. There is no "press 1 for sales".
- **An explicit confidence gate.** The model reports how sure it is; the *server*
  decides whether that clears 0.75. Below the line it asks a question instead of
  guessing, and the console draws the number against the gate so you can see it happen.
- **Asking for a person works immediately.** No confirmation, no "let me just try one
  more thing". That is the single most common complaint about systems like this.
- **A mind-change window.** Between "connecting you now" and the actual transfer there
  is a short, configurable gap. Say "wait, actually…" inside it and the route re-opens.
- **Context that survives the handoff.** The topic, summary, route and caller record
  travel to Teams as VoIP headers, and the console shows the literal headers next to a
  mock Teams incoming-call toast.
- **Honest failure.** Two unclear turns, an expired time budget, an out-of-scope
  question, or a failed transfer all end with a person — never with a loop.

## Quick start

Runs with no Azure subscription at all.

```bash
npm install
npm start
# open http://127.0.0.1:8091
```

Pick a calling number, click **Answer a call**, and type what the caller says. A typed
transcript drives *the same state machine* a real call would: the same allowlist, the
same confidence gate, the same business hours, the same handoff assembly. Only the
classifier and the audio path are stubbed.

Try these:

| Type this | What you should see |
| --- | --- |
| `I was charged twice on my invoice` | 0.95 confidence, Billing offered, confirm to transfer |
| `I was charged for a renewal I did not order` | below the gate — a clarifying question instead |
| `can I just talk to a person` | straight to Reception, no confirmation |
| `3` | keypad shortcut, commits with no spoken confirmation |
| *Silence* twice, then again | two clarifications, then a person |
| Confirm Billing, then immediately `no, my portal is broken` | the pending transfer is cancelled |

Run the tests — they need no Azure and no network:

```bash
npm test     # 63 cases across the state machine and the Teams handoff
npm run check
```

## How it works

```
PSTN caller
   │  Event Grid: Microsoft.Communication.IncomingCall
   ▼
ACS Call Automation ──── answerCall + bidirectional media streaming ────┐
   │                                                                    │
   │  PCM16 24 kHz mono (pcm24KMono)                                     │
   ▼                                                                    │
this server ──── WebSocket, PCM16 forwarded verbatim ────► Voice Live ──┘
   │                                                         (gpt-realtime)
   │  propose_route / confirm_route / request_human / …
   ▼
RoutingFlow ──── TransferCallToParticipant + VoIP custom context ────► Teams
                                                             Call Queue or user
```

### The decision lives on the server

`src/flow.mjs` owns every decision that matters and imports nothing from Azure,
Express or SQLite. The model's only power is to *propose* a route id from a fixed
list. It never sees a Teams object ID, a phone number, or a URL — there is no tool
that accepts one, and a test asserts that.

```
ringing → greeting → classifying → confirming → transferring → transferred
                          ↑____________|                     ↘ fallback
                                                             ↘ messaging → ended
```

| Rule | Where it is enforced |
| --- | --- |
| Which destinations exist | `config/routes.json`, loaded into an allowlist |
| Whether the model is confident enough | `RoutingFlow#proposeRoute` |
| Whether a queue is open | `RoutePolicy.isOpen`, in the queue's own time zone |
| How many clarifications before a human | `MAX_CLARIFICATIONS`, default 2 |
| How long the whole thing may take | `ROUTE_TIME_BUDGET_MS`, default 90s |
| Retry, divert, then admit failure | `RoutingFlow#dispatchTransfer` |

Because the audit sink, the transfer function and the clock are all injected, the
entire flow is testable with plain `node --test` — no mocks of the Azure SDK, no
subscription, and the tests run before `npm install` finishes.

Every instruction the flow sends the agent carries an example of what a well-behaved
model would say. The real agent ignores it and works from the prompt; the offline
console speaks it verbatim. That is why simulation mode produces a readable
conversation without a model, and why the prompts are self-documenting when you read
`flow.mjs`.

### What Teams receives

Only **VoIP headers** are used. SIP headers are a PSTN-side mechanism and do not reach
a Teams identifier, so context sent that way would vanish silently — the caller would
still be transferred, but the agent would answer blind.

| Header | Contents |
| --- | --- |
| `CallDetails.SessionId` | The Auto Attendant session id when this line sits behind one, otherwise the ACS correlation id |
| `CallDetails.CallTopic` | The confirmed intent, clipped to the Teams 48-character limit |
| `CallDetails.CallContext` | One sentence of what the caller needs |
| `CallDetails.CallSentiment` | Only when the caller *said* they were unhappy — never inferred from tone |
| `CallDetails.RouteId` / `AfterHours` | Which route was chosen, and whether it was a diversion |
| `CallerDetails` | The caller record, serialised whole so `verified: false` cannot be separated from the name |

Call queues and auto attendants are resource accounts, so they are addressed as Teams
*apps* (`{ teamsAppId }`); a named specialist is addressed as a Teams *user*
(`{ microsoftTeamsUserId }`). Both take a Microsoft Entra object ID, which is why
`routes.json` holds object IDs and never phone numbers.

## Configuration

Copy `.env.example` to `.env`. Everything has a working default except the three
values that make real calls possible.

| Variable | Default | Notes |
| --- | --- | --- |
| `ACS_ENDPOINT` | — | Required to answer real calls. Keyless, via `DefaultAzureCredential` |
| `ACS_CONNECTION_STRING` | — | Fallback if you cannot use Entra. `ACS_ENDPOINT` wins if both are set |
| `PUBLIC_BASE_URL` | — | Must be reachable by Event Grid and ACS |
| `VOICE_LIVE_ENDPOINT` | — | Azure AI Services resource |
| `VOICE_LIVE_API_KEY` | *(empty)* | Leave empty to use Entra, which is recommended |
| `LOCALE` | `en-US` | Opening/model language and speech-recognition hint; callers may explicitly request a switch |
| `VOICE_LIVE_VOICE` | `en-US-Ava:DragonHDLatestNeural` | Azure TTS voice; set this alongside `LOCALE` |
| `CONFIDENCE_THRESHOLD` | `0.75` | Below this the agent must ask, not guess |
| `ROUTE_TIME_BUDGET_MS` | `90000` | Answer to confirmed route; expiry goes to a person |
| `MAX_CLARIFICATIONS` | `2` | Then a person |
| `TRANSFER_DELAY_MS` | `1200` | The mind-change window. `0` transfers immediately |
| `PERSIST_TRANSCRIPTS` | `false` | Decisions are always stored; utterances are not |

With all three call variables unset the server logs `SIMULATION MODE` and runs the
offline console. `GET /health` breaks readiness out per subsystem, because "not ready"
is rarely uniform — Voice Live can be configured while ACS is not, and both can be
configured while `routes.json` still holds the placeholder object IDs:

```jsonc
{
  "mode": "simulation",
  "voiceLive": { "ready": false, "auth": "entra", "model": "gpt-realtime" },
  "telephony": { "ready": false, "auth": "none", "missing": ["ACS_ENDPOINT", "PUBLIC_BASE_URL"] },
  "teams":     { "ready": false, "unprovisionedRoutes": ["sales", "support", "billing", "reception"] }
}
```

That last line answers "why did my transfer fail?" before anyone has to read a log.

### Keyless auth

Both Azure connections default to Entra, so no key needs to live on disk.

**ACS.** Set `ACS_ENDPOINT` and leave `ACS_CONNECTION_STRING` unset. The signed-in
identity needs **Communication and Email Service Owner** on the ACS resource. Locally
that identity comes from `az login`; in Azure, use a managed identity.

**Voice Live.** Assign the same identity both roles on the AI Services resource:

- **Cognitive Services User**
- **Foundry User**

The server then acquires a token for the `https://ai.azure.com/.default` scope through
`DefaultAzureCredential`. Setting `VOICE_LIVE_API_KEY` overrides this.

### Routes

`config/routes.json` is the whole routing policy. Adding a destination is a config
change, not a prompt rewrite — the menu given to the model is generated from this file.

```jsonc
{
  "id": "billing",
  "dtmf": "3",
  "label": "Billing",
  "description": "Invoices, charges, refunds, payment methods…",  // the model sees this
  "target": {                                                     // the model never does
    "type": "callQueue",                                          // callQueue | autoAttendant | user
    "displayName": "Contoso Billing",
    "objectId": "<entra-object-id>"
  },
  "hours": { "timeZone": "America/Los_Angeles", "days": [1,2,3,4,5], "open": "09:00", "close": "17:00" },
  "afterHours": { "behavior": "message" }                         // or { "behavior": "route", "routeId": "reception" }
}
```

`fallbackRouteId` is where every giving-up path leads. Keep it open 24×7.

## Connecting it to a real phone number

Inbound uses **Teams Phone extensibility**: the caller dials a Teams service number
on a resource account, Teams routes the call to your linked ACS resource, and this
sample answers it with Call Automation.

```
PSTN caller → Teams service number → Teams resource account → linked ACS resource
            → Microsoft.Communication.IncomingCall (Event Grid) → this sample
```

> **The number is the part that trips people up.** Teams Phone extensibility requires
> a Teams *service* number, from Microsoft Calling Plan, Operator Connect, or Direct
> Routing. **A phone number purchased in Azure Communication Services cannot be
> assigned to a Teams resource account** — there is no cmdlet or portal path that
> converts one. Acquiring a Microsoft number also needs at least one Calling Plan
> licence in the tenant, and toll-free needs funded pay-as-you-go billing. The free
> `PHONESYSTEM_VIRTUALUSER` licence is right for the resource account itself but does
> not let you acquire a number.
>
> If you only hold an ACS number you can still exercise the whole state machine —
> calls to it reach this sample as ordinary Call Automation calls. They arrive
> without the Teams resource account identity, and the server logs them as
> `acs-direct` rather than `teams-phone-extensibility` so the difference is never
> silent.

1. **Provision.** An ACS resource, an Azure AI Services resource, and a Teams tenant
   with a service number on a resource account.
2. **Register a calling bot** and create the resource account against its application
   ID, so the account is yours rather than a first-party Auto Attendant.
3. **Bind the resource account to ACS.** `Set-CsOnlineApplicationInstance -AcsResourceId
   <immutable GUID>` then `Sync-CsOnlineApplicationInstance`. Note this is *not*
   `Set-CsTeamsAcsFederationConfiguration`, which governs a different feature — ACS
   users talking to Teams users — and does nothing for phone extensibility. See
   [`scripts/provision-teams-phone.ps1`](scripts/provision-teams-phone.ps1).
4. **Grant ACS server consent** for that resource account via the `teamsExtension`
   assignment API. The Teams-side binding alone is only half of it.
5. **Collect object IDs.** Get the Entra object ID of each call queue's resource
   account and put it in `routes.json`. These are the *transfer targets*, separate
   from the inbound resource account. To keep your own IDs out of git, copy it to
   `config/routes.local.json` and set `ROUTES_PATH` — `config/*.local.json` is
   gitignored. If your tenant has no call queues yet, a `"type": "user"` target
   pointing at any Teams user with Enterprise Voice is enough to see a transfer.
6. **Expose this server.** `npm run tunnel`, then set `PUBLIC_BASE_URL`.
7. **Subscribe to `IncomingCall`.** Create an Event Grid system topic on the ACS
   resource with a webhook subscription to `<PUBLIC_BASE_URL>/api/events`, filtered to
   `Microsoft.Communication.IncomingCall`. The server answers the validation handshake
   automatically. Set the Azure Bot calling webhook to `https://eventgrid.azure.net`.
8. **Check `/health`,** then call the number.

### Live call test matrix

These phrases exercise the common paths through a real Voice Live call. Confidence
is model-generated in live mode, so the exact score can vary; the `0.75` gate and
the behavior on either side of it are deterministic.

| Flow | Say or do | Expected behavior |
| --- | --- | --- |
| Billing | `I was charged twice on my credit card` → `yes` | Offers Billing, waits for confirmation, then transfers |
| Support | `The customer portal is down and shows an error` → `yes` | Offers Support, then transfers after confirmation |
| Sales | `I need pricing for about 100 seats` → `yes` | Offers Sales, then transfers after confirmation |
| Human escape | `Can I just speak to a person?` | Goes directly to Reception without another question or confirmation |
| Ambiguous intent | `I was charged for a renewal I didn't order` | Should clarify whether the issue is the purchase or the charge when confidence falls below the gate; answer `The charge on my card is wrong` for Billing |
| Mind change | Start with the Billing phrase, confirm, then immediately interrupt with `No, wait — the portal is down` | Cancels the pending transfer and reclassifies to Support; the default window is 1.2 seconds |
| Keypad | Press `1`, `2`, `3`, or `4` | Commits Sales, Support, Billing, or Reception without spoken confirmation; unmapped digits are ignored |
| Out of scope | `What are your store hours?` | Declines to invent an answer and asks what team you need; a second unrelated factual question falls back to Reception |
| Language switch | `Please continue in French` | Switches because the caller explicitly requested it; a new call still starts in `LOCALE` |
| Transfer recovery | Confirm any offered route while its Teams target is unavailable | Retries once, tries the fallback route, then gives an honest apology instead of leaving the caller in silence |

The physical destinations come from the file selected by `ROUTES_PATH`. If several
routes point to the same Teams user during initial testing, the spoken decision and
handoff context still differ, but every accepted route rings that same user. Likewise,
after-hours behavior only appears when the active route has real business hours; a
local test file with `alwaysOpen: true` deliberately disables it.

## Project layout

```
src/
  flow.mjs        the state machine — no Azure, Express or SQLite imports
  routes.mjs      the route allowlist, business hours, and caller directory
  handoff.mjs     route target → Teams identifier, context → VoIP headers
  agent.mjs       the tool schema and standing instructions given to the model
  offline.mjs     keyword classifier + simulated agent, used only by the console
  audit.mjs       in-memory audit sink (the interface the flow depends on)
  db.mjs          the SQLite implementation of that same interface
  realtime.mjs    WebSocket hub that pushes state to the console
  server.mjs      Event Grid intake, ACS callbacks, simulation API
  voice/
    voice-live.mjs  the Voice Live WebSocket session
    acs.mjs         answer, transfer, DTMF, hang up
    call-bridge.mjs binds one call to one Voice Live session
config/
  routes.json     the routing policy
  callers.json    fictional caller directory
public/           the presenter console
test/             63 cases, no Azure required
```

`flow.mjs`, `routes.mjs`, `handoff.mjs`, `agent.mjs`, `offline.mjs` and `audit.mjs`
import no third-party packages. That is deliberate: the parts you most need to read
and trust are the parts that run without installing anything.

## Operational notes

- **Event Grid delivers duplicates by design.** The server de-duplicates on event id
  before answering, so a redelivery does not answer the same call twice.
- **DTMF is always on but never announced up front.** Continuous recognition starts on
  `CallConnected`; the keypad is only *offered* aloud after speech has failed twice.
- **The transfer is blind.** The agent's job ends once the context is delivered.
  Staying on the line would put a silent third party on every routed call.
- **`CallTransferFailed` re-enters the flow's own retry ladder** rather than starting a
  second, competing recovery path.
- **Barge-in** sends `StopAudio` to ACS and `response.cancel` to Voice Live, so the
  agent stops mid-word rather than talking over the caller.
- **Voice Live allows one in-flight response.** A state transition and a tool result
  can both want the agent to speak, so requests are coalesced in `voice-live.mjs`.

## Security notes before production

- **Caller ID is not authentication.** A directory match personalises the greeting and
  enriches the handoff, and is marked `verified: false` everywhere it appears —
  including in the header Teams receives. Do not let a match release account details.
- **The model cannot choose a destination.** It proposes an id from an allowlist. Keep
  it that way; a tool that accepts a phone number turns a prompt injection into a
  toll-fraud vector.
- **Sentiment is enum-constrained in the tool schema**, but "only when the caller says
  so" is enforced by the prompt, not the server. If you act on sentiment downstream,
  treat it as a hint from a model, not a measurement.
- **Transcripts are off by default.** Route decisions and summaries are persisted
  because they are the audit trail; utterance text reaches disk only if you set
  `PERSIST_TRANSCRIPTS`.
- **Disclose the assistant.** The opening line says it is automated. Several
  jurisdictions require this; all callers deserve it.
- **Phone numbers are masked** in the console, the audit database, and the logs.
- The seeded callers, routes and object IDs are fictional placeholders. Replace them.

## Microsoft references

- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [How to use the Voice Live API](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to)
- [Call Automation overview](https://learn.microsoft.com/azure/communication-services/concepts/call-automation/call-automation)
- [Passing contextual data with custom headers](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/custom-context)
- [Teams interop with Call Automation](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/teams-interop-call-automation)
- [Bidirectional media streaming](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/audio-streaming-quickstart)
