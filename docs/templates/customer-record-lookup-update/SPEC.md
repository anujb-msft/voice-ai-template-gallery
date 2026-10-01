# Customer Record Lookup & Update — Sample Specification

**Status:** implementation guide for an illustrative, demo-grade sample. This is not a
production CRM integration. Its CRM is a local SQLite fixture, and its writable-field
allow-list, validation rules, and after-call-work baseline are examples to replace with
the organization's own.

Rows marked † were not asked individually. They are inherited from the gallery baseline
shared with the intent-based call routing sample, or are defaults to confirm during
review.

## Scope decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Entry point † | Teams Phone resource account via Teams Phone extensibility, with a plain ACS number as a documented fallback |
| 2 | Scenario | A Contoso field sales rep calls a Teams number hands-free from the car. Before a meeting, "brief me on Fabrikam" returns account history, open opportunities, and the last activity. After the meeting, the rep dictates the outcome, which becomes an activity, opportunity updates (stage, amount, close date), and a follow-up task, each confirmed before write-back |
| 3 | System of record | A `CrmAdapter` interface over a local SQLite fixture CRM with accounts, contacts, opportunities, activities, tasks, and owners, seeded with about 8 accounts. A Dynamics 365 Sales adapter over the Dataverse Web API with an on-behalf-of token is documented and stubbed, not built |
| 4 | Identity | The rep calls from the Teams client or a Teams-enrolled mobile, so the caller is a known Entra user identified by the incoming call's Teams user ID. The server maps that user to a CRM owner. PSTN calls from a registered mobile number also require a DTMF PIN. Unknown callers are refused |
| 5 | Access scope | Every CRM call carries the rep's identity. The rep sees only records they could see in the CRM: accounts they own or whose account team they are on |
| 6 | Writable fields | A config allow-list. Activity create: subject, type, notes, date, contacts. Opportunity update: stage, amount, close date, next step. Task create: subject, due date, owner "me". Contact update: phone and email. Everything else, including deletes, owner changes, account merges, pricing, and discounts, is refused with "I can't change that by phone." |
| 7 | Briefing | A fixed-order 30 to 45 second briefing: account name, tier, and owner; the last activity (date, type, one-line summary); up to 3 open opportunities sorted by close date with stage, amount, and close date; overdue or due-today tasks; and the key contact. Drill-ins include "tell me more about the renewal", "who's the contact", and "repeat". Amounts are rounded when spoken |
| 8 | Write-back flow | Free dictation becomes a server-validated change set with an activity, opportunity field diffs (old → new), and a task. The server reads back a compact summary. Nothing is written until the rep says "yes, save it". Voice amendments rebuild the proposal. The commit is one atomic transaction |
| 9 | Account matching | Server-side fuzzy match on name, alias, and phonetic key, limited to the rep's visible accounts. One confident match is confirmed with the city. 2 or 3 candidates are offered with city or tier. No match leads to a spelling prompt. Opportunities with similar names are told apart by name and amount. Calendar context from the next meeting is a documented enhancement |
| 10 | Audit and undo | An audit row per committed field records the rep, record, field, before and after values, call ID, and timestamp. Voice-created activities are tagged "Logged by voice agent" and linked to the call. "Undo that" reverts the last commit within the call. After the call, the console can revert any commit from the audit log |
| 11 | Drafts | If the rep hangs up before confirming, or says "call me back later", the proposal is saved as a draft note on the account with no field changes. On the next call, "resume my draft" reloads it as a proposal |

## Implementation decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Voice Live model † | `gpt-realtime`, configurable |
| 2 | Session mode † | Direct model mode, with a documented path to Foundry agent mode |
| 3 | Credentials † | `DefaultAzureCredential` preferred, with an API key as the quick-start fallback |
| 4 | Offline runnability † | Full local mode, where a typed transcript and a simulated caller identity drive the real state machine, access scoping, account matching, proposal validation, commit, undo, and drafts |
| 5 | Verification † | Automated fixtures with `node:test`, plus a manual live-call checklist |
| 6 | CRM adapter | `CrmAdapter` with `findAccounts`, `getBriefing`, `getOpportunity`, `applyChangeSet`, `revertCommit`, and `saveDraft`, each taking the rep's identity. The sample ships `SqliteCrmAdapter`. `DataverseCrmAdapter` is a documented stub that shows the OBO token exchange and the Web API calls |
| 7 | Validation | The server validates every proposed change against `config/writable-fields.json`, the stage picklist, amount bounds, a close date that is not in the past, and a due date within 90 days. Invalid changes come back to the model with a spoken reason |
| 8 | Transactions | A change set commits as one SQLite transaction. The commit ID groups the audit rows, and undo reverts them in reverse order only if the current values still match the after values. Otherwise it reports a conflict |
| 9 | Personal data | The model never sees the rep's Teams ID, PIN, or phone number. Contact phone and email are given to the model only when the rep asks for them, and are masked in logs |
| 10 | Retention | Raw audio is never stored. The transcript stays in memory unless `TRANSCRIPT_RETENTION` is turned on for compliance. Only confirmed structured fields and the notes text are written to the CRM |
| 11 | Handoff mechanics † | Blind `TransferCallToParticipant` to the sales operations queue on request or after two failures, carrying `CallTopic` and `CallContext` |

## Experience decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Fictional org † | Contoso, with customer accounts such as Fabrikam, Northwind Traders, and Tailspin Toys |
| 2 | AI disclosure † | The agent says it is an automated assistant in its opening line |
| 3 | Hands-free safety | Short responses, with no DTMF required after the PIN. "Pause" holds the session silently until the rep says "continue". Contact details are spoken only on request |
| 4 | Confirmation | Every write needs an explicit "yes, save it" after the read-back. Silence, "maybe", and "I think so" are not confirmation |
| 5 | Call cap | 8 minutes, configurable, with a wrap-up prompt at 7:00 that saves any pending proposal as a draft |
| 6 | Escalation † | Transfer to sales operations when the rep asks for a person or the agent fails twice. Refused write requests are logged for follow-up but not transferred |
| 7 | DTMF † | PIN entry for PSTN callers. `0` transfers to sales operations. `*` repeats the last phrase |
| 8 | Realtime transport † | Local WebSocket only, with no SignalR dependency |
| 9 | Default port † | `8097`, so it runs alongside the other gallery samples on `8090`–`8096` |
| 10 | Gallery card † | Visual scene updated to depict the briefing, dictation, and confirmed write-back flow when the sample lands |

## Goal

Build a runnable voice agent that lets a Contoso sales rep read and update CRM records
by phone without touching a screen. It should brief the rep on an account before a
meeting and turn a spoken post-meeting debrief into a confirmed, auditable CRM update.

The agent is an assistant to the rep, not an autonomous editor. It writes only
allow-listed fields, only to records the rep can already see, and only after the rep
confirms the exact change.

The committed demo fixtures live in `config/`; the runtime SQLite database lives in gitignored `code/data/`:

| File | Contents |
|---|---|
| `config/crm-seed.json` | About 8 accounts with aliases, city, tier, and account team, plus their contacts, opportunities, activities, and tasks |
| `config/reps.json` | Demo reps with Entra object ID, Teams user ID, registered mobile, PIN hash, and CRM owner ID |
| `config/writable-fields.json` | The per-entity allow-list with field types and validation rules |
| `config/picklists.json` | Opportunity stages, activity types, and account tiers, each with spoken names |
| `config/briefing.json` | Briefing sections, order, per-section limits, and the amount-rounding rule |
| `config/routing.json` | The sales operations Teams queue target and its hours |

An example allow-list entry:

```json
{
  "entity": "opportunity",
  "operation": "update",
  "fields": {
    "stage": { "type": "picklist", "picklist": "opportunityStage" },
    "amount": { "type": "currency", "min": 0, "max": 10000000 },
    "closeDate": { "type": "date", "notBefore": "today" },
    "nextStep": { "type": "text", "maxLength": 200 }
  }
}
```

## Caller experience

1. The rep calls the Contoso sales assistant from Teams on a mobile phone. The number is
   a Teams Phone resource account linked to ACS through Teams Phone extensibility. The
   documented ACS number fallback only changes provisioning.
2. Event Grid delivers `IncomingCall`. The server resolves the caller's Teams user ID to
   a rep in `config/reps.json`. A PSTN call from a registered mobile gets a PIN prompt.
   An unknown caller hears **"This line is for Contoso sales staff"** and the call ends.
3. The server answers through Call Automation, starts bidirectional media streaming, and
   opens a Voice Live session. The agent greets the rep: **"Hi Alex, I'm the Contoso
   sales assistant, an automated agent. Which account?"** If a draft exists, it adds
   **"You have an unsaved update for Fabrikam. Say 'resume my draft' to pick it up."**
4. **Briefing.** For "Brief me on Fabrikam", the agent calls `find_account` and confirms
   **"Fabrikam in Seattle?"** Then it calls `get_briefing` and speaks: **"Fabrikam,
   Strategic tier, your account. Last touch was a call on May 2nd about the pilot
   rollout. Two open deals: the renewal at about 250 thousand, in Negotiation, closing
   June 30th, and the analytics expansion at about 80 thousand, in Proposal, closing in
   August. One task is due today: send the security questionnaire. Your contact is Dana
   Ruiz, VP of Operations."**
5. The rep can drill in with "tell me more about the renewal", "who else is on the
   account", or "what's Dana's number". Contact details are spoken only when asked.
6. **Debrief.** After the meeting, the rep says "Log the Fabrikam meeting. Dana agreed to
   the renewal at 240k, moving to Closed Won pending signature, close date June 15th.
   Remind me to send the contract Friday." The agent calls `propose_update`. The server
   builds and validates a change set and returns a read-back: **"Here's what I have: a
   meeting activity with Dana Ruiz, today. The renewal goes from Negotiation to Closed
   Won, amount from 250 thousand to 240 thousand, close date from June 30th to June
   15th. And a task for you, send the contract, due Friday. Save it?"**
7. The rep can amend: "Actually keep it in Negotiation." The agent calls
   `amend_proposal`, and the server rebuilds and re-reads only what changed.
8. A request outside the allow-list, such as "give them a 10 percent discount" or
   "reassign the account to Jordan", is dropped from the proposal, and the agent says
   **"I can't change that by phone. I've left it out."**
9. On **"Yes, save it"**, the agent calls `commit_proposal`. The server writes the change
   set in one transaction and the agent says **"Saved."** "Undo that" right after calls
   `undo_last_commit` and restores the previous values.
10. If the rep says "call me back later", hangs up before confirming, or reaches the
    7:00 wrap-up, the server saves the proposal as a draft note on the account with no
    field changes.
11. The rep can say "pause" and the agent stays silent until "continue". The agent
    transfers to sales operations on request or after two failures. It says **"We're
    almost out of time"** at 7:00, and the 8-minute cap (`CALL_TIME_BUDGET_MS`) or two
    no-inputs end the call politely.

## Architecture and implementation shape

```text
Sales rep (Teams client or Teams-enrolled mobile; registered PSTN mobile + PIN)
   → Teams Phone service number / resource account   (fallback: plain ACS number)
   → ACS Call Automation (Event Grid, callbacks, call control, media streaming)
   ↔ Node.js 22 CRM voice service
       ↔ Azure AI Voice Live API over WebSocket
       ↔ caller identity resolver (Teams user ID → rep → CRM owner; PIN for PSTN)
       ↔ CrmAdapter (SqliteCrmAdapter; DataverseCrmAdapter stub with OBO)
       ↔ account matcher (name, alias, phonetic key; scoped to the rep)
       ↔ proposal builder + validator (writable-fields.json, picklists.json)
       ↔ commit / undo / draft store + field-level audit log (SQLite)
       ↔ stats endpoint
       ↔ presenter console over a local WebSocket
   → ACS transfer to the sales operations queue
```

Reuse the password-reset sample's Express server, configuration pattern, ACS-to-Voice
Live media bridge, PCM16 24-kHz path, barge-in handling, SQLite event log, health
endpoint, and simulation-mode conventions. The state machine is:

`ringing → identifying → (refused → ended) | greeting → listening → (briefing | proposing → confirming → committed) → listening … → (paused → listening) | (transferring → transferred) | (drafting → closing) | closing → ended`

The model changes state only through server-owned tools, each of which runs as the
identified rep:

- `find_account(utterance)` returns a confirmation phrase for one match, 2 or 3
  candidates with city and tier, or `no_match`. Only accounts visible to the rep are
  searched.
- `get_briefing(accountId)` returns the fixed-order briefing phrase and section handles
  for drill-in.
- `get_detail(handle)` returns the detail for one briefing item, such as an
  opportunity, the contact list, or a task.
- `get_contact_info(contactId, field)` returns one phone number or email, only when the
  rep asks.
- `propose_update(accountId, dictation)` has the server extract an activity,
  opportunity diffs, and a task. It validates each against the allow-list and rules,
  and returns a read-back phrase, the list of refused items, and a proposal ID.
- `amend_proposal(proposalId, change)` applies a spoken correction and returns the
  changed read-back.
- `commit_proposal(proposalId, confirmation)` requires an explicit confirmation token
  from the rep's last utterance. It writes in one transaction and returns a commit ID.
- `undo_last_commit()` reverts the call's last commit if the values have not changed
  since, and otherwise reports a conflict.
- `save_draft(proposalId)` and `resume_draft()`.
- `pause()`, `transfer(reason)`, `repeat_last()`, and `end_call(reason)`.

The model extracts fields from dictation through `propose_update`. The server owns
record IDs, old values, validation, and the write. Opportunity names, stage names, and
dates in the read-back are formatted by the server.

## Teams handoff contract

Transfers use `TransferCallToParticipant` to the sales operations Teams queue in
`config/routing.json`. The Teams Phone extensibility custom context carries:

- `CallDetails.SessionId`: the ACS correlation ID, which is kept in the audit record.
- `CallDetails.CallTopic`: for example `Sales rep – Fabrikam renewal update`, up to 48
  characters.
- `CallDetails.CallContext`: the rep's display name, the confirmed account, any pending
  proposal summary or draft ID, refused requests, and the transfer reason. It carries no
  PIN and no contact details.

## Demo surface and configuration

The presenter console shows call state, the identified rep and how they were verified,
the live transcript, account-match candidates, the briefing sections, and the proposal
as a diff table (old → new, with refused items struck out). It shows the commit, undo,
and draft events and the field-level audit log, with a **Revert** control on each
commit. A CRM viewer shows the fixture records updating live. A **Reset data** control
restores the seed. The console is marked as a demo surface.

Configuration covers `PORT` (`8097`), `PUBLIC_BASE_URL`, `ACS_ENDPOINT` (with
`ACS_CONNECTION_STRING` as the fallback), `VOICE_LIVE_ENDPOINT`, `VOICE_LIVE_MODEL`
(`gpt-realtime`), and `VOICE_LIVE_API_VERSION` (`2026-04-10`), with Entra auth using
the **Cognitive Services User** and **Foundry User** roles and the
`https://ai.azure.com/.default` scope. It also covers `CRM_ADAPTER` (`sqlite`), the
Dataverse settings (`DATAVERSE_URL`, `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`) for the
stub, `PIN_REQUIRED_FOR_PSTN` (`true`), `TRANSCRIPT_RETENTION` (`false`),
`AFTER_CALL_MINUTES_BASELINE` (`6`), `DEMO_NOW` (pins "today" for dates and due
tasks), and `CALL_TIME_BUDGET_MS` (`480000`).

With no Azure subscription, the typed-transcript mode drives the same state machine,
identity resolution (by picking a demo rep), access scoping, matching, validation,
commit, undo, and drafts. Only audio and the transfer are simulated. The sample ships a
README, `DEMO-SCRIPT.md`, the Teams provisioning snippet, the seed data, the config
fixtures, and the call fixtures.

## Acceptance criteria

- A real call from a Teams user is answered through Teams Phone extensibility, the rep
  is identified, and the call is connected to Voice Live. The ACS number fallback
  reaches the same state machine with the PIN path. A transfer reaches the sales
  operations queue. All are verified by the manual live-call checklist.
- Barge-in works, and duplicate Event Grid deliveries do not create duplicate sessions.
- `node:test` runs the fixtures with no cloud credentials. They cover a known Teams
  user, a registered PSTN mobile with a correct PIN, a wrong PIN, an unknown caller, a
  briefing for an owned account, a briefing for an account-team account, a request for
  an account the rep cannot see (treated as no match), a single confident match, 2 or 3
  candidates, a spelled name, two opportunities with similar names, each briefing
  drill-in, a contact number on request, a full debrief with an activity, stage,
  amount, close date, and task, an amendment, a refused discount, a refused owner
  change, a refused delete, an invalid stage, a close date in the past, a due date past
  90 days, "maybe" treated as no confirmation, a confirmed commit, undo, undo after a
  conflicting change, a hang-up before confirming that saves a draft, "call me back
  later", "resume my draft", pause and continue, the wrap-up draft at 7:00, an expired
  call cap, `0` and `*` DTMF, two failed attempts, two no-inputs, and a prompt-injection
  attempt asking to read another rep's account or change a field outside the allow-list.
- No CRM write happens without an explicit confirmation in the rep's last utterance, and
  every committed field has an audit row with before and after values.
- The rep can never read or write a record outside their visible scope.
- The model context never contains the rep's Teams ID, PIN, or phone number, and never
  contains contact details the rep did not ask for.
- The opening line discloses that the rep is talking to an automated assistant.
- Utterance text and audio are absent from the database unless `TRANSCRIPT_RETENTION` is
  on.
- `GET /health` reports application, Voice Live, Teams Phone provisioning, CRM adapter
  and seed counts, rep directory, and simulation mode.
- `GET /api/stats` reports calls, average handle time, briefings, proposals, confirmed
  commits, fields written by entity, undos, drafts saved and resumed, refused writes by
  field, transfers, and estimated after-call-work minutes saved
  (`AFTER_CALL_MINUTES_BASELINE` × committed activities).

## Production gates and non-goals

The sample does not connect to a live CRM, read calendars or email, create accounts or
opportunities, change pricing, discounts, or ownership, delete records, place outbound
calls, or record audio. Before real use, the following are needed:

- An implemented and tested CRM adapter, such as Dataverse through the Web API with
  on-behalf-of tokens, so that CRM security roles and field-level security apply to
  every read and write.
- Sales operations sign-off on the writable-field allow-list, stage rules, and
  validation limits.
- Identity review of the Teams user mapping, the PIN policy for PSTN, and the
  lost-device process.
- Data-retention, records, and privacy review of dictated notes, drafts, and optional
  transcripts.
- A driving-safety policy review and user guidance for hands-free use.
- Validated Event Grid subscriptions, warm compute on the answer path, rate limits, and
  managed identity or Key Vault for credentials.
- Applicable Teams certification and organizational reviews.

Primary measures are handle time, record completion, and after-call work saved.

## Microsoft reference contracts

- [Teams Phone extensibility overview](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-overview)
- [Answer Teams Phone calls with Call Automation](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-answer-teams-calls)
- [Teams Phone extensibility IVR and transfer](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-interactive-voice-response)
- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [Voice Live API how-to — endpoint, api-version, and Entra auth](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to)
- [Call Automation transfer to a participant](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/actions-for-call-control#transfer-a-participant-in-a-call)
- [Use the Dataverse Web API](https://learn.microsoft.com/power-apps/developer/data-platform/webapi/overview)
- [Microsoft identity platform on-behalf-of flow](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-on-behalf-of-flow)
- [Dataverse security concepts and field-level security](https://learn.microsoft.com/power-platform/admin/field-level-security)
