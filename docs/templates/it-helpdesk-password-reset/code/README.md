# IT Help Desk — Proactive Password Reset Voice Agent

A reference demo showing how a voice agent can **prevent** inbound IT help desk
volume instead of just absorbing it.

An employee clicks *Forgot password?* on the sign-in page. Instead of opening a ticket
and waiting in a phone queue, the agent **calls them back immediately** and walks them
through a guided reset — while a live web wizard stays in lockstep with the conversation
over SignalR.

> [!WARNING]
> This package is intentionally demo-grade. It has no end-user authentication or
> production abuse controls and must not be exposed to real users or data without the
> security work listed below.

---

## What the demo shows

| | |
|---|---|
| **Proactive outbound** | The agent calls the employee. No queue, no ticket, no hold music. |
| **Multi-modal, one session** | The phone call and the browser wizard are the *same* transaction, kept in sync in real time. |
| **Security that voice alone can't do** | A code is spoken on the call and typed in the browser — proving the caller is the person at the computer. Passwords are only ever typed, never spoken. |
| **Live agent coaching** | As the user types a new password, policy results stream to the model, which coaches them conversationally instead of just rejecting input. |
| **Deflection economics** | Every completed reset closes its ticket as *deflected* and updates a running cost-avoided counter. |

---

## Architecture

```
   Employee's browser                     Employee's phone
        │  ▲                                    │  ▲
        │  │ SignalR (live wizard state)        │  │ PSTN
        ▼  │                                    ▼  │
   ┌────────────────────────────────────────────────────────┐
   │                  this Node.js server                   │
   │                                                        │
   │   flow.mjs ── state machine, one definition drives:    │
   │      • the browser wizard                              │
   │      • the agent's per-step instructions               │
   │      • the SQLite audit trail                          │
   │                                                        │
   │   providers/ ── swap these for your real systems       │
   │      directory.mjs  → Entra ID / Okta / AD             │
   │      ticketing.mjs  → ServiceNow / Jira / Zendesk      │
   └────────────────────────────────────────────────────────┘
        │  ▲                                    │  ▲
        │  │ WebSocket, PCM16 24 kHz mono       │  │ WebSocket
        ▼  │ (ACS bidirectional streaming)      ▼  │
   Azure Communication Services          Azure AI Voice Live
      Call Automation                      (gpt-realtime-2)
```

**The agent can only change state by calling tools.** All security-sensitive logic
(identity checks, code generation, password policy, ticket closure) lives on the server
in `flow.mjs`. The model decides *when*, never *whether*.

### The reset flow

| Step | Phone | Browser |
|---|---|---|
| 1. Identity | Agent greets by name, asks for last 4 of employee ID | "Verifying your identity" |
| 2. Presence | Agent reads a 6-digit code aloud | User types the code |
| 3. Password | Agent reads the policy, coaches on failures in real time | User types the new password |
| Done | Agent confirms and ends the call | Ticket auto-closed as deflected |

Two failed identity attempts call `escalate`, which closes the ticket as *not* deflected
and hands off to a human — so the metrics stay honest.

---

## Quick start

Requires Node.js 22 or newer.

```bash
npm ci
cp .env.example .env      # fill in the values below
npm run seed
npm start                 # http://localhost:8090
```

`npm run seed` creates random demo passwords and prints them once. The seeded account
`alex.morgan` is **locked**, and the lock is checked before the password, so typing
*anything* into the sign-in form surfaces the lockout error. Then click
**Forgot password?** and answer your phone.

The sign-in page carries no demo instructions or metrics by design: it has to look like a
real corporate login for the demo to land.

Presenting this? See **[DEMO-SCRIPT.md](DEMO-SCRIPT.md)** for a rehearsable five-step
running order with talk track and fallbacks.

Without ACS/Voice Live configured the app still runs in **simulation mode** — the wizard
and metrics work, no call is placed. That is enough to demo the UX.

### Configuration

| Variable | Notes |
|---|---|
| `HOST` | Bind address. Defaults to `127.0.0.1`; set it explicitly for a container or remote development environment. |
| `PUBLIC_BASE_URL` | Public HTTPS URL ACS can reach. `devtunnel host -p 8090 --allow-anonymous` (create the port with `--protocol http`, not `https`). |
| `ACS_CONNECTION_STRING` | Azure Communication Services resource. |
| `ACS_CALLER_ID` | **Must be a geographic number.** Toll-free ACS numbers cannot place outbound calls. |
| `VOICE_LIVE_ENDPOINT` | `https://<resource>.services.ai.azure.com` — an Azure AI Services resource (`kind=AIServices`) with a custom domain. |
| `VOICE_LIVE_MODEL` | `gpt-realtime-2`. Available in **eastus2, swedencentral, francecentral** — *not* westus2. |
| `AZURE_SIGNALR_CONNECTION_STRING` | Optional. Must be **Serverless** service mode. Leave empty to use the built-in WebSocket hub. |
| `DEMO_PHONE_NUMBER` | The number the demo always calls, regardless of the directory record. |
| `HELPDESK_TICKET_COST_USD` | Loaded cost per human-handled reset. Used by the deflection stats at `GET /api/stats`. |

Check your wiring at `GET /health`:

```json
{ "realtime": "azure-signalr", "voiceModel": "gpt-realtime-2", "callReady": true }
```

---

## Customising for a real environment

The template is deliberately built around two seams. **Nothing outside `src/providers/`
needs to change** to integrate real systems.

### 1. Identity — `src/providers/directory.mjs`

Implement `findByUsername`, `findById`, `authenticate`, `validatePasswordPolicy`,
`setPassword`, `unlockAccount`, then register it in `createDirectoryProvider`.

Stubs and the relevant API calls are already sketched in comments for **Microsoft Entra ID**
(Graph `PATCH /users/{id}` with `passwordProfile`) and **Okta**
(`POST /api/v1/users/{id}/lifecycle/reset_password`).

Note `validatePasswordPolicy` returns **human-readable failure strings**, not error codes —
they are fed straight to the model so it can coach naturally. Keep them speakable.

### 2. Ticketing — `src/providers/ticketing.mjs`

Implement `openTicket`, `closeTicket`, `deflectionStats`. A **ServiceNow** stub with the
relevant `/api/now/table/incident` calls is included in comments.

### 3. What the agent knows — `knowledge/password-reset-faq.md`

Callers interrupt. "How do I know this is really IT?", "Can't you just tell me my current
password?", "Will this sign me out on my phone?" — an agent that ploughs through the script
ignoring these is exactly why people phone the help desk instead.

The FAQ is authored as **markdown, not code**. Edit the file and the agent's answers change
on the next call — it is re-read on save, no restart needed. `src/knowledge.mjs` parses
`###` headings into question/answer pairs and injects them into the session instructions;
author-only sections are stripped, so you can keep notes in the file.

The agent is instructed to answer in its own words in one or two sentences, then steer
straight back to the current step — and to **escalate rather than invent** anything the
file doesn't cover. The startup log prints how many answers loaded.

The file's last section lists good questions to ask live during a demo.

The FAQ sits in the prompt verbatim, which is deliberate: answers stay exact and auditable
with no retrieval step to fail mid-call. If yours grows past a few thousand words, replace
the body of `knowledgeBase()` with a retrieval call — nothing else changes.

### 4. The conversation — `src/flow.mjs`

`STEPS` is the single source of truth. Each step carries both the UI copy and the
`agentInstructions` sent to the model on entry. Add or reorder steps here and the phone
call, the browser and the audit log all follow automatically.

To change what the agent is *able* to do, edit `AGENT_TOOLS` in `src/voice/voice-live.mjs`
and handle the new tool in `CallBridge.#onToolCall`.

Directory records may carry a `phoneticName`; when present the agent is explicitly told how
to pronounce the employee's name.

---

## Why WebSocket and not WebRTC

Voice Live does offer a WebRTC transport, and we evaluated it here. The conclusion for a
**server-side PSTN bridge** is that WebSocket is the right choice:

- **ACS Call Automation only speaks WebSocket.** `MediaStreamingOptions.transportType` has
  exactly one permitted value, `"websocket"`. There is no WebRTC or RTP option, so the
  ACS leg is fixed regardless.
- **The formats line up exactly.** ACS `pcm24KMono` and Voice Live `pcm16` are both PCM16
  24 kHz mono, so audio is forwarded **verbatim** — no Opus transcode, no resampling, no
  jitter buffer, and less added latency.
- **WebRTC's advantages don't apply here.** NAT traversal, congestion control and packet
  loss concealment matter on a lossy last mile. ACS already terminates the PSTN leg; this
  hop is server-to-server inside Azure.
- **It isn't the supported server-side pattern.** Voice Live WebRTC is a public *preview*
  aimed at browser and mobile clients connecting directly. Microsoft publishes no
  server-side RTP bridge guidance, and in testing the preview signalling channel closed
  within seconds of SDP negotiation, taking the media session with it.

Use Voice Live WebRTC when a **browser or mobile app** talks to the model directly. Use
WebSocket, as here, when a **server** bridges telephony audio.

---

## Project layout

```
knowledge/
  password-reset-faq.md   ← the agent's spoken answers, edit freely
src/
  knowledge.mjs           loads the FAQ into the agent's instructions
  server.mjs              HTTP routes, static hosting, ACS callbacks
  config.mjs              env config + readiness checks
  db.mjs                  SQLite schema and migrations
  flow.mjs                the reset state machine (start here)
  realtime.mjs            Azure SignalR (serverless) + local WebSocket fallback
  providers/
    directory.mjs         ← swap for Entra / Okta / AD
    sqlite-directory.mjs  reference implementation + password policy
    ticketing.mjs         ← swap for ServiceNow / Jira / Zendesk
  voice/
    acs.mjs               outbound call placement
    call-bridge.mjs       ACS ⇄ Voice Live audio bridge, tool dispatch
    voice-live.mjs        Voice Live session, tools, instruction injection
public/                   sign-in page and live reset wizard
scripts/
  seed.mjs                sample users
  ws-test.mjs             Voice Live connectivity check, no phone call needed
```

## Operational notes

- **Deflection is tracked, not displayed.** Completed resets close their ticket as
  deflected and the numbers are available at `GET /api/stats`, but nothing is shown in the
  employee's UI — a real user resetting their password should not be told what they cost
  the help desk. Use the slide in [`../slides/`](../slides/) to frame the economics
  instead, and query the endpoint if you want live figures on a second screen.
- **Two demo-only panels sit below the wizard**, both badged as such and both worth
  removing for a real deployment. The **agent activity** log lists every tool the model
  reached for and whether it was accepted — the governance story made visible, and immune
  to speech recognition errors, so it is shown by default. The **call transcript** proves
  the conversation is genuinely live, but recognition slips appear verbatim, so it stays
  collapsed. Storing transcripts also brings privacy and retention obligations.
- **Barge-in** is handled: when the caller starts speaking, the bridge sends ACS a
  `StopAudio` frame and cancels the in-flight model response, so the agent stops instantly
  rather than talking over them.
- **Session correlation** rides in the media streaming transport URL query string
  (`?session=<id>`), which is how one audio socket is matched to one browser wizard.
- **`npm run ws-test`-style check:** `node scripts/ws-test.mjs` verifies Voice Live auth,
  the model, speech output and tool calling without placing a call. Run it first when
  debugging.
- The `data/` directory and `.env` are gitignored. Delete `data/helpdesk.db` and re-run
  `npm run seed` to reset the demo.

## Security notes before production

This is demo-grade. Before real use: put real authentication on the reset endpoints
(currently any caller who knows a `sessionId` can drive a flow), rate-limit
`/api/reset/start`, move the ACS and Voice Live keys to Key Vault or managed identity,
serve over your own TLS rather than a dev tunnel, and add fraud controls around
callback-number changes — an attacker who can change the callback number defeats the
entire out-of-band check.
