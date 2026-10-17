# AGENTS.md — Appointment Scheduling Agent

Guidance for coding agents, and the developers driving them, who change this sample.
Read all of it before you edit `src/`, `config/`, `public/` or `test/`. `README.md` is
the developer guide; `DEMO-SCRIPT.md` is the presenter's running order.

## What this is

The scheduling line for Contoso Health, a fictional clinic group. A caller gives a
name and date of birth, says what the visit is for in their own words, hears two
times, and books one by saying yes. On a real call, Teams Phone extensibility
delivers the call, Azure Communication Services Call Automation answers it and
bridges the audio, and the Azure AI Voice Live API is the voice. With no Azure
settings the server runs in **simulation mode**: typed caller lines drive the same
state machine, and the console in `public/` plays a scripted demo of it.

Identity, eligibility, the times offered, holds, consent and handoffs are decided by
policy code on the server. The model talks and proposes; it never decides whether
anything is written.

## The booking invariant — never weaken it

It is the point of this template, and the tests and the console exist to prove it.
Every change must keep all three true:

1. **Model tools can never book.** The model can verify, search and *propose* a
   time (`hold_slot`); `book`, `reschedule` and `cancel` are not tools.
2. **Only the caller's trusted confirmation of the ACTIVE proposal may write**: a
   yes the server reads in the caller's own transcript, or keypad 1, while that
   proposal is the one on the table.
3. **After `slot_taken`, the caller makes a fresh selection and gives fresh
   consent.** The earlier yes is void. The server never silently books a different slot.

Where it is enforced — change these only together with the tests that pin them:

| Guarantee | Code | Tests |
| --- | --- | --- |
| No write tools | `WRITE_ACTIONS` in `src/agent.mjs`. `dispatchTool` in `src/tools.mjs` refuses those names before anything else, through `SchedulingFlow.refuseModelWrite`, which logs `write_refused` and writes nothing | `test/agent-tools.test.mjs`, `test/flow.test.mjs` |
| One write path | `SchedulingFlow#commit` (`src/flow.mjs`) is the only caller of `bookAppointment`, `rescheduleAppointment` and `cancelAppointment`. Only `callerSaid` (a yes) and `dtmf` (key 1) reach it | "the schedule is written in exactly one place…" in `test/agent-tools.test.mjs` |
| Checked again at the write | `#commit` re-checks the active proposal, identity, that it isn't already confirmed, and eligibility. Its idempotency key is `call:<id>:<kind>:<holdId>`, so a retry can't write twice | `test/flow.test.mjs`, `test/schedule-store.test.mjs` |
| No silent swap | `ScheduleAdapter.bookAppointment` (`src/schedule-store.mjs`) returns `slot_taken` when the held time is gone. `#writeFailed` → `#raceLost` voids the proposal, releases the hold, leaves that time out and offers fresh ones | the `slot_taken:` tests in `test/flow.test.mjs` and `test/schedule-store.test.mjs` |

Don't add a tool that writes to the schedule, takes a confirmation flag, or accepts a
phone number or a Teams target: the model names a destination id from
`config/routing.json`, and the server resolves it. The demo-only
`SchedulingFlow.takeSlotForDemo` books as the front desk (a fictional patient), never
for the caller, and is reachable only in simulation.

## Run and verify

```bash
npm test          # 54 cases on Node's built-in node:sqlite: no npm install, Azure or network
npm run check     # node --check on src/, scripts/, test/ and public/*.js
npm run smoke     # after npm install: boots its own server on port 8200, checks both WebSockets and the demo controls
npm run rehearse  # after npm install: plays the beats as the console does on port 8300, three ways; pins what each shows
npm run offline -- --script race     # one beat in the terminal: book | book-whatever | race | referral | identity-fails
npm run offline -- --phone +12065550142 --say "Jordan Rivera, 03/12/1984|A follow-up with Dr. Patel."
npm start         # http://127.0.0.1:8100 — the console, in simulation mode without a .env
```

Node 22 or later. CI runs Node 22, so use nothing newer.

## Where things live

```
src/
  flow.mjs            the state machine: every check, proposal, refusal and write
  schedule-store.mjs  the schedule (SQLite): search, hold, book, reschedule, cancel, waitlist,
                      handoff tokens, the console's grid and stats, reseed, the demo's takeSlot
  tools.mjs           the only path from a model tool call to the flow
  agent.mjs           the tool schema and the standing instructions (LOCALE-aware)
  routes.mjs          handoff destinations, opening hours and the context allowlist
  handoff.mjs         destination → Teams identifier; context → VoIP headers
  offline.mjs         the simulated agent and the offline CLI; SCRIPTS mirror the beats
  config.mjs          env vars, config files, clock presets, /health readiness
  sqlite.mjs          better-sqlite3 when it loads, node:sqlite otherwise
  audit.mjs, db.mjs   the audit sink: in memory, and SQLite
  realtime.mjs        the console's WebSocket hub
  server.mjs          Event Grid intake, ACS callbacks, simulation API, demo controls
  voice/              Call Automation and Voice Live; used only on real calls
config/               policy as data: visit types, eligibility wording, providers, clinics,
                      referrals, orders, prep, safety words, routing
fixtures/             the seeded schedule, shared with the appointment reminder sample
public/               the console: index.html, app.js, styles.css, beats.js; presenter-kit.* vendored
scripts/              smoke-websockets.mjs, rehearse.mjs, provision-teams-phone.ps1;
                      presenter-kit-rehearsal.mjs vendored
test/                 harness.mjs and the *.test.mjs files
```

## Rules

- **Policy modules stay on the Node standard library.** Nothing in `flow.mjs`,
  `routes.mjs`, `handoff.mjs`, `agent.mjs`, `tools.mjs`, `audit.mjs`, `offline.mjs`,
  `schedule-store.mjs`, `sqlite.mjs` or `config.mjs` imports a package at the top
  level: `dotenv` and `better-sqlite3` load lazily with `await import()`, and the
  store falls back to `node:sqlite`. Express, `ws` and the Azure SDKs belong in
  `server.mjs`, `realtime.mjs` and `src/voice/`.
- **Tests run before `npm ci`.** A test must never import express, `ws`,
  better-sqlite3, `@azure/*`, `src/voice/*` or `src/server.mjs`. Build on
  `test/harness.mjs`: it pins the shipped seed, routing, policy values and clock, so a
  developer's `.env` can't turn a test red. Add a test for any policy you change.
- **The clock is injected.** Openings, lead times, "today", hold expiry, business
  hours and token expiry read the `now` that `SchedulingFlow` and `ScheduleAdapter`
  are given (the server passes its demo clock). Don't call `Date.now()` or
  `new Date()` to make a decision; timestamps on records are fine.
- **Demo controls are simulation-only.** `/api/simulate…`, `POST /api/demo/clock`,
  `/api/demo/reset`, `/api/demo/take-slot` and `/api/demo/tool` return 403 while the
  server answers real calls, because a simulated booking would land in the real
  schedule. Put any new demo route behind `simulationOnly()`. Reset reseeds the
  schedule only when it is the in-memory demo copy, never a file.
- **The beats and the offline scripts move together.** Each beat in `public/beats.js`
  is a script in `src/offline.mjs` (`SCRIPTS`), step for step, and
  `test/beats.test.mjs` runs them and pins how each ends and the final metrics. Change
  both, then update `DEMO-SCRIPT.md`, which quotes the narration in `beats.js`.
- **The presenter kit is vendored.** Never edit `public/presenter-kit.js`,
  `public/presenter-kit.css` or `scripts/presenter-kit-rehearsal.mjs`: change
  `scripts/presenter-kit/` at the repository root and run
  `node scripts/sync-presenter-kit.js`, or CI fails on drift. Template UI goes in
  `public/app.js` and `public/styles.css`.
- **The console talks only to its own origin.** No CDNs, web fonts, analytics or
  third-party requests.
- **A caller on the way to a person is never dropped.** The model's `end_call` goes
  through `SchedulingFlow.agentEndCall`, which refuses it while the call is escalating
  or transferred; the caller hanging up still ends the call. A failed transfer is
  retried once, then diverted or apologized for with the number to call back.
  `src/voice/call-bridge.mjs` hangs up only after a closing line has played (25 s at
  most) and never hangs up a call that is with a person.
- **Error text stays in the server log.** A failed transfer or write shows fixed
  wording on the console and in the audit; the ACS or store message goes to
  `console.error` only, because it can carry phone numbers and patient details.
- **One `upgrade` listener.** The console hub and the ACS media socket share one HTTP
  server through a single `upgrade` handler that routes by pathname (`noServer: true`).
  Never attach a second `WebSocketServer` to it.
- **Voice Live:** model `gpt-realtime`, api-version `2026-04-10`. `LOCALE` reaches both
  the standing instructions and the transcription language hint.
- **Privacy defaults stay on.** Dates of birth and phone numbers are masked before a
  caller line is kept, transcripts are stored only with `TRANSCRIPT_RETENTION=true`,
  a failed identity check reads the same whether or not the patient exists, and
  caller ID is never proof of identity.
- **Fictional data only:** Contoso Health, 555-01xx numbers, `contoso.com` addresses,
  no internal URLs. Write files with LF line endings. Never commit `.env`, `data/`,
  logs or `node_modules/`.

## Common changes

- **A visit type.** Add it to `config/visit-types.json` (spoken name, duration,
  department, provider roles, prep code; `requiresReferral`, `requiresOrder` or
  `frequencyMonths` switch on the matching eligibility check), add its code to
  `VISIT_TYPE_CODES` in `src/agent.mjs`, and give a provider in
  `config/providers.json` a `weeklyTemplate` block that serves it. The offline
  driver's words for it live in `chooseCode` in `src/flow.mjs`.
- **An eligibility rule.** The checks run in a fixed order in `evaluateEligibility`
  (`src/flow.mjs`): insurance, visit frequency, referral, order. Their wording and
  the alternatives offered come from `config/eligibility.json`. A new kind of check
  needs code there and a test in `test/flow.test.mjs`.
- **A handoff destination.** `config/routing.json`: `type`, `target` (a Teams object
  ID; the shipped ones are placeholders), `topic` and `reasonTopics`, `hours` and
  `afterHoursLine`, and `fields`, the allowlist of context keys that reach the VoIP
  headers. `scripts/provision-teams-phone.ps1` reads back the object IDs.
- **A real scheduling system.** Implement the `ScheduleAdapter` methods the flow calls
  (see the FHIR mapping in `README.md`). A time that is gone must come back as
  `slot_taken`, and a hold must never book any time but its own.
- **The demo.** Edit `public/beats.js` and `SCRIPTS` in `src/offline.mjs` together,
  run `npm test`, then update `DEMO-SCRIPT.md` and run `npm run rehearse`. It prints the
  outcomes it reached: check them against the script, then paste them over its pins in
  `scripts/rehearse.mjs`.

Before you hand back: `npm test`, `npm run check`, `npm run smoke` and `npm run rehearse`
pass, and `README.md`, `.env.example` and `DEMO-SCRIPT.md` still match what the code does.
