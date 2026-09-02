# Intent-Based Call Routing — Sample Specification

**Status:** implementation guide for an illustrative, demo-grade sample. This is not a
production contact center or a Teams Unify-certified solution.

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

## Caller experience

1. The caller dials a Teams Phone service number assigned to a resource account. The
   resource account is linked to Azure Communication Services (ACS) through Teams Phone
   extensibility; an Auto Attendant may transfer into the same entry point.
2. Event Grid delivers the `IncomingCall` event. The Node.js service answers through ACS
   Call Automation and starts bidirectional media streaming.
3. Azure AI Voice Live greets the caller: **“Tell me briefly what you’re calling about.”**
4. The agent maps the caller’s words to one allowlisted route. If the request is
   ambiguous, it asks one short clarifying question. It then confirms the destination:
   **“It sounds like technical support. Is that right?”**
5. After explicit confirmation, the server transfers the call to the configured Teams
   Call Queue. A human request goes directly to `reception`.
6. The receiving Teams user sees the call topic and concise conversation context. If a
   transfer fails, the agent stays with the caller, retries once, then uses the fallback
   queue or explains that no transfer is available.

## Architecture and implementation shape

```text
PSTN caller
   → Teams Phone service number / resource account
   → ACS Call Automation (Event Grid, callbacks, call control, media streaming)
   ↔ Node.js 22 routing service
       ↔ Azure AI Voice Live API over WebSocket
       ↔ allowlisted route policy + SQLite audit log
       ↔ presenter console over SignalR/local WebSocket
   → ACS transfer to Teams Call Queue or Teams user
       + Teams custom call context
```

Reuse the password-reset sample’s Express server, configuration pattern, ACS-to-Voice
Live media bridge, PCM16 24-kHz path, barge-in handling, SQLite event log, health
endpoint, local realtime fallback, and simulation-mode conventions. Replace its outbound
callback and reset workflow with an inbound, idempotent state machine:

`ringing → greeting → classifying → confirming → transferring → transferred | fallback | ended`

The model changes state only through server-owned tools:

- `propose_route(routeId, callTopic, callSummary, sentiment)` records a candidate route;
  the server rejects unknown IDs and normalizes context limits.
- `confirm_route(routeId)` is accepted only after the caller explicitly confirms the
  currently proposed route; the server resolves the real Teams target and starts transfer.
- `request_human(reason)` selects `reception` without further classification.
- `end_call()` closes calls that the caller no longer wants routed.

The route configuration owns Teams application identifiers, business hours, and
fallbacks. Those values are never exposed to the model and no tool accepts a raw phone
number, URL, or Teams object ID.

## Teams handoff contract

Use `TransferCallToParticipant` for the MVP so the voice agent leaves after a successful
handoff. Teams Call Queues are targeted with `MicrosoftTeamsAppIdentifier` and the
configured queue application object ID. Attach the Teams Phone extensibility custom
context schema through VoIP headers:

- `CustomContext.CallDetails.SessionId` — preserve the value received from an Auto
  Attendant when present; otherwise retain the ACS correlation ID in the audit record.
- `CustomContext.CallDetails.CallTopic` — confirmed intent, no more than 48 characters.
- `CustomContext.CallDetails.CallContext` — one- or two-sentence conversation summary.
- `CustomContext.CallDetails.CallSentiment` — only when supported by observed dialog.
- Caller details — only when supplied by a trusted system; never infer identity from the
  phone number.

Every ACS operation uses an operation context so callback events can be correlated with
the state-machine transition that initiated them.

## Demo surface and configuration

The local presenter console shows call state, live transcript, proposed route, confirmed
route, transfer result, and the exact context sent to Teams. It must be clearly marked as
a demo console and must not display secrets or claim a transfer completed when running
in simulation mode.

Expected configuration includes `PUBLIC_BASE_URL`, `ACS_CONNECTION_STRING`, Voice Live
endpoint/auth/model/voice settings, an Event Grid incoming-call endpoint, and a
non-secret `config/routes.json` containing placeholder Teams queue application IDs.
Without cloud configuration, checked-in call fixtures drive the same state machine and
render a visibly simulated transfer.

## Acceptance criteria

- A real inbound call to the provisioned Teams Phone service number is answered through
  Teams Phone extensibility and connected to Voice Live.
- Voice input and output support interruption, and the app handles duplicate Event Grid
  deliveries without creating duplicate sessions.
- Checked-in fixtures cover every route, an ambiguous request, an immediate human
  request, a rejected route ID, and a failed transfer.
- No call transfers before caller confirmation; after one unresolved clarification the
  call falls back to reception.
- A successful transfer reaches the configured Teams target and includes the normalized
  topic, summary, sentiment, and available session context.
- The presenter console and audit log show every proposed, accepted, rejected, retried,
  and completed action.
- `GET /health` distinguishes application readiness, Voice Live readiness, Teams Phone
  provisioning, and simulation mode.

## Production gates and non-goals

The sample does not implement caller authentication, CRM lookup, multilingual routing,
call recording, emergency calling, workforce management, or production-scale queue
selection. Before real use: validate Event Grid subscription requests, keep the answer
path on warm compute, deduplicate events, rate-limit public endpoints, use managed
identity or Key Vault, minimize transcript retention and handoff PII, enforce tenant and
target allowlists, test prompt-injection attempts, and complete applicable Teams
certification and organizational reviews.

Primary measures are confirmed-route accuracy against the fixture set, clarification and
fallback rate, transfer completion rate, time to confirmed route, and handoff-context
completeness.

## Microsoft reference contracts

- [Teams Phone extensibility overview](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-overview)
- [Answer Teams Phone calls with Call Automation](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-answer-teams-calls)
- [Teams Phone extensibility IVR and transfer](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-interactive-voice-response)
- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
