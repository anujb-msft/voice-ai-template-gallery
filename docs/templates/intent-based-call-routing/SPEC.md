# Intent-Based Call Routing — Sample Specification

**Status:** implementation guide for an illustrative, demo-grade sample. This is not a
production contact center or a Teams Unify-certified solution.

## Scope decisions

These ten choices were proposed for review and are recorded here as the working
assumptions. Changing any row changes the sections below.

| # | Decision | Choice |
|---|---|---|
| 1 | Entry point | Teams Phone resource account via Teams Phone extensibility, with a plain ACS number as a documented fallback |
| 2 | Route catalogue | Generic Sales, Support, Billing, Reception |
| 3 | Handoff mechanism | Blind transfer; the agent leaves once the transfer succeeds |
| 4 | Transfer targets | Teams Call Queue and individual Teams user |
| 5 | Confirmation | Always confirm the destination, except an explicit human request |
| 6 | Caller identification | Caller-ID lookup in a seeded demo directory, passed as unverified context |
| 7 | Business hours | Per-route hours in configuration, with an after-hours fallback |
| 8 | Language | English demo, with locale and voice configurable in one place |
| 9 | Presenter surface | Console plus a mock Teams agent view showing the received context |
| 10 | Audit and metrics | SQLite audit of calls, tool calls, and transfers, plus a stats endpoint |

## Implementation decisions

A second round of refinements, also proposed for review. Two of these corrected real
defects in the existing password-reset sample, which have been fixed in the same pass.

| # | Decision | Choice |
|---|---|---|
| 1 | Voice Live model | `gpt-realtime`, configurable; `gpt-realtime-1.5` newer, `gpt-realtime-mini` cheaper |
| 2 | Session mode | Direct model mode, with a documented path to Foundry agent mode |
| 3 | Credentials | `DefaultAzureCredential` preferred, API key documented as a quick-start fallback |
| 4 | Offline runnability | Full local mode — a typed transcript drives the real state machine |
| 5 | Verification | Automated fixtures and `node:test`, plus a manual live-call checklist |
| 6 | Classification | Tool call plus model-reported confidence; below threshold forces a clarifier |
| 7 | DTMF | Keys 1–4 accepted as an always-on backup, announced only if the caller struggles |
| 8 | No-input policy | Two reprompts, then reception |
| 9 | Transcript retention | Events and summaries at rest; full transcript in memory unless opted in |
| 10 | Sentiment | Sent only when the caller states frustration explicitly |

`gpt-realtime-2` is **not** in the Voice Live natively supported model table, and the
current WebSocket transport api-version is `2026-04-10`. The password-reset sample pinned
both incorrectly and has been corrected.

## Experience decisions

A third round covering conversation edges and demo ergonomics.

| # | Decision | Choice |
|---|---|---|
| 1 | Fictional org | Contoso, matching the password-reset sample |
| 2 | AI disclosure | The agent says it is an automated assistant in its opening line |
| 3 | Confidence threshold | `0.75`, flat across routes, configurable |
| 4 | Out-of-scope questions | One polite deflection, then back to routing — this is not an FAQ bot |
| 5 | Changing their mind | Re-classification allowed until the transfer actually begins |
| 6 | Time budget | 90 seconds to a confirmed route, then automatic reception fallback |
| 7 | Realtime transport | Local WebSocket only; no SignalR dependency |
| 8 | Default port | `8091`, so it runs alongside the password-reset sample on `8090` |
| 9 | Gallery card | Visual scene updated to depict the routing flow when the sample lands |
| 10 | Transfer audio | A spoken “connecting you now”, no hold tone |

## Goal

Build a runnable inbound voice agent that answers a Teams Phone service number, asks the
caller why they are calling, confirms a bounded intent, and transfers the call to the
right Teams destination with useful handoff context. The sample should demonstrate
natural conversation without allowing the model to invent routes or control arbitrary
phone targets.

The initial route catalogue is deliberately small and configurable:

| Route ID | Caller need | Teams destination |
|---|---|---|
| `sales` | Buy, renew, or discuss a product | Sales Call Queue |
| `support` | Get help with an existing product or service | Support Call Queue |
| `billing` | Discuss an invoice, charge, or payment | Billing Call Queue |
| `reception` | Human request, unclear intent, or fallback | General reception queue |

Each route declares its Teams target, business hours, and after-hours behavior. A route
may target a Call Queue or a named Teams user; `reception` is the required fallback and
must be reachable whenever the service is running. After-hours behavior is one of two
declared options, both of which stay within those two target types: transfer to an
alternate route, or take a short spoken message that the agent summarizes into the audit
log before ending the call.

## Caller experience

1. The caller dials a Teams Phone service number assigned to a resource account. The
   resource account is linked to Azure Communication Services (ACS) through Teams Phone
   extensibility; an Auto Attendant may transfer into the same entry point. A plain ACS
   number is a documented fallback for environments without a Teams tenant — only the
   provisioning steps differ, not call handling.
2. Event Grid delivers the `IncomingCall` event. The Node.js service answers through ACS
   Call Automation and starts bidirectional media streaming. Before greeting, the server
   looks the calling number up in a seeded demo directory.
3. Azure AI Voice Live greets the caller, disclosing that it is an automated assistant in
   the same breath as the question: **“You’ve reached Contoso — I’m an automated
   assistant. Tell me briefly what you’re calling about.”** A matched caller is greeted
   by name; an unmatched caller gets the neutral greeting.
4. The agent maps the caller’s words to one allowlisted route, reporting its own
   confidence. Below `0.75`, or on silence or an unusable answer, it asks one short
   clarifying question — at most twice, offering the keypad on the second attempt — and
   then falls back to reception. Keys 1–4 are always accepted. A question no route covers
   gets one polite deflection back to routing rather than an answer; this is a router,
   not an FAQ bot. It confirms the destination: **“It sounds like technical support. Is
   that right?”**
5. After explicit confirmation, the agent says **“Connecting you now”** and the server
   transfers the call to the configured Teams target. Until the transfer actually begins,
   the caller may still change their mind and the agent re-classifies. An explicit
   request for a person skips classification and confirmation entirely: asking someone to
   confirm that they want a human is the exact frustration this template exists to
   remove.
6. If the confirmed route is outside its configured hours, the server applies that
   route’s after-hours behavior instead, and the agent says so before transferring.
7. The receiving Teams user sees the call topic, conversation context, and any caller
   details resolved by lookup. If a transfer fails, the agent stays with the caller,
   retries once, then uses the fallback queue or explains that no transfer is available.
8. A server-side budget of 90 seconds from answer to confirmed route is enforced
   throughout. If it expires in any state before transfer, the call goes to reception
   with whatever context exists, so a confused conversation can never trap the caller.

## Architecture and implementation shape

```text
PSTN caller
   → Teams Phone service number / resource account   (fallback: plain ACS number)
   → ACS Call Automation (Event Grid, callbacks, call control, media streaming)
   ↔ Node.js 22 routing service
       ↔ Azure AI Voice Live API over WebSocket
       ↔ allowlisted route policy + business hours + seeded caller directory
       ↔ SQLite audit log + stats endpoint
       ↔ presenter console and mock Teams agent view over a local WebSocket
   → ACS transfer to Teams Call Queue or Teams user
       + Teams custom call context
```

Reuse the password-reset sample’s Express server, configuration pattern, ACS-to-Voice
Live media bridge, PCM16 24-kHz path, barge-in handling, SQLite event log, health
endpoint, local realtime fallback, and simulation-mode conventions. The Voice Live
session runs in direct model mode, so the prompt, tools, and turn detection stay in this
repository and are reviewable; the README documents what changes to move to Foundry agent
mode, which requires Entra ID. Replace the outbound callback and reset workflow with an
inbound, idempotent state machine:

`ringing → greeting → classifying → confirming → transferring → transferred | fallback | ended`

An after-hours route short-circuits the transfer leg as `confirming → messaging → ended`,
and `confirming → classifying` re-opens when a caller changes their mind in time.

The model changes state only through server-owned tools:

- `propose_route(routeId, confidence, callTopic, callSummary, sentiment)` records a
  candidate route; the server rejects unknown IDs, normalizes context limits, and forces
  a clarifying question when confidence is below the configured threshold.
- `confirm_route(routeId)` is accepted only after the caller explicitly confirms the
  currently proposed route; the server resolves the real Teams target and starts
  transfer. A fresh `propose_route` is still accepted between confirmation and the
  moment the ACS transfer is dispatched, which is what lets a caller change their mind;
  after dispatch the route is frozen.
- `request_human(reason)` selects `reception` without further classification.
- `take_message(callTopic, callSummary)` is enabled only when the server has already
  decided the call is after hours for the confirmed route.
- `end_call()` closes calls that the caller no longer wants routed.

The route configuration owns Teams application identifiers, business hours, and
fallbacks. Those values are never exposed to the model and no tool accepts a raw phone
number, URL, or Teams object ID. The caller directory is likewise server-side: the model
may be told a caller’s display name for the greeting, but it cannot query the directory,
and it never receives or emits a phone number.

## Teams handoff contract

Use `TransferCallToParticipant` for the MVP so the voice agent leaves after a successful
handoff. Teams Call Queues are targeted with `MicrosoftTeamsAppIdentifier` and the
configured queue application object ID; an individual Teams user is targeted with
`MicrosoftTeamsUserIdentifier` and their Entra object ID. Attach the Teams Phone
extensibility custom context schema through VoIP headers:

- `CustomContext.CallDetails.SessionId` — preserve the value received from an Auto
  Attendant when present; otherwise retain the ACS correlation ID in the audit record.
- `CustomContext.CallDetails.CallTopic` — confirmed intent, no more than 48 characters.
- `CustomContext.CallDetails.CallContext` — one- or two-sentence conversation summary.
- `CustomContext.CallDetails.CallSentiment` — sent only when the caller states
  frustration explicitly, never inferred, so the receiving agent is not primed by a guess.
- `CustomContext.CallerDetails` — populated from the seeded caller directory when the
  calling number matches. Caller ID is not authentication, so the handoff must mark these
  details as unverified and the agent must never treat a match as proof of identity.

Every ACS operation uses an operation context so callback events can be correlated with
the state-machine transition that initiated them.

## Demo surface and configuration

The local presenter console shows call state, live transcript, proposed route, confirmed
route, business-hours decision, transfer result, and the exact context sent to Teams.
Beside it, a mock Teams agent view renders that context pane as the receiving agent would
see it, so the payoff of the handoff is visible without a second tenant. Both panels are
clearly marked as demo surfaces, show no secrets, and never claim a transfer completed
while in simulation mode.

Configuration covers `PORT` (`8091`, so the sample runs alongside the password-reset
demo on `8090`), `PUBLIC_BASE_URL`, `ACS_CONNECTION_STRING`, an Event Grid incoming-call
endpoint, `CONFIDENCE_THRESHOLD` (`0.75`), `ROUTE_TIME_BUDGET_MS` (`90000`), and a single
`LOCALE`/`VOICE` pair so the English demo can be repointed without touching prompts or
code. The presenter console and mock Teams view are served over a plain local WebSocket;
unlike the password-reset sample there is no SignalR option, because a single-presenter
demo does not need one. Voice Live uses `VOICE_LIVE_ENDPOINT`,
`VOICE_LIVE_MODEL` (`gpt-realtime`), and `VOICE_LIVE_API_VERSION` (`2026-04-10`), and
authenticates with `DefaultAzureCredential` when no key is present — Microsoft recommends
Entra ID, which needs the **Cognitive Services User** and **Foundry User** roles and the
`https://ai.azure.com/.default` token scope. An API key remains supported for quick
starts. Two non-secret data files carry the rest: `config/routes.json` with placeholder
Teams application IDs, business hours, and after-hours behavior per route, and
`config/callers.json` with a handful of fictional Contoso directory entries.

With no Azure subscription at all, the sample still runs end to end: a typed transcript
is fed to the same state machine, so route selection, confirmation, business hours,
context assembly, the console, and the mock Teams view all behave normally and the
transfer is rendered as visibly simulated. Only the audio path and the real Teams
transfer are stubbed.

Shipped alongside `src/`: a README, a `DEMO-SCRIPT.md` walkthrough, a PowerShell snippet
for `Set-CsOnlineApplicationInstance` and the Teams Phone extensibility assignment, and
the checked-in call fixtures. When the sample lands, this template’s gallery card gets a
visual scene depicting the routing flow, replacing the current placeholder artwork.

## Acceptance criteria

- A real inbound call to the provisioned Teams Phone service number is answered through
  Teams Phone extensibility and connected to Voice Live; the documented ACS-number
  fallback reaches the same state machine. This is verified by a manual live-call
  checklist, not by automation.
- Voice input and output support interruption, and the app handles duplicate Event Grid
  deliveries without creating duplicate sessions.
- `node:test` runs the checked-in fixtures with no cloud credentials, covering every
  route, an ambiguous request, a low-confidence proposal, an immediate human request, a
  DTMF selection, two consecutive no-inputs, an out-of-scope question, a caller who
  changes their mind after confirming, an expired time budget, a known and an unknown
  caller number, an after-hours call, a rejected route ID, and a failed transfer.
- No call transfers before caller confirmation, except an explicit human request; after
  two unresolved clarification attempts the call falls back to reception, and the
  90-second budget forces the same fallback from any pre-transfer state.
- The opening line discloses that the caller is talking to an automated assistant, a
  question no route covers gets exactly one deflection, and a caller who changes their
  mind before the transfer starts is re-classified rather than transferred to the stale
  destination.
- A successful transfer reaches the configured Teams target and includes the normalized
  topic, summary, available session context, and unverified caller details; sentiment is
  present only when the caller stated it.
- The presenter console, mock Teams view, and audit log show every proposed, accepted,
  rejected, retried, and completed action, including the confidence that drove each
  decision.
- Utterance text is absent from the database unless transcript persistence is explicitly
  enabled.
- `GET /health` distinguishes application readiness, Voice Live readiness, Teams Phone
  provisioning, and simulation mode; `GET /api/stats` reports call, route, clarification,
  fallback, and transfer counts from the SQLite audit log.

## Production gates and non-goals

The sample does not implement caller authentication, a real CRM integration,
multilingual routing, call recording, emergency calling, workforce management, or
production-scale queue selection; its caller directory is a static fixture. Transcripts
stay in memory by default and only summaries and route decisions reach disk, so enabling
transcript persistence is a deliberate, reviewable choice. Before real
use: validate Event Grid subscription requests, keep the answer path on warm compute,
deduplicate events, rate-limit public endpoints, use managed identity or Key Vault,
minimize transcript retention and handoff PII, enforce tenant and target allowlists, test
prompt-injection attempts, and complete applicable Teams certification and organizational
reviews.

Primary measures are confirmed-route accuracy against the fixture set, clarification and
fallback rate, transfer completion rate, time to confirmed route, and handoff-context
completeness.

## Microsoft reference contracts

- [Teams Phone extensibility overview](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-overview)
- [Answer Teams Phone calls with Call Automation](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-answer-teams-calls)
- [Teams Phone extensibility IVR and transfer](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-interactive-voice-response)
- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [Voice Live API how-to — endpoint, api-version, and Entra auth](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to)
