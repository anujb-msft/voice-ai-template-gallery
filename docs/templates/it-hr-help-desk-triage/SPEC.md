# IT / HR Help Desk Triage — Sample Specification

**Status:** implementation guide for an illustrative, demo-grade sample. This is not a
production help desk. Its ITSM, HR case store, and HRIS are local SQLite and JSON
fixtures. Its topic taxonomy, priority matrix, knowledge articles, and routing table are
examples to replace with the organization's own, with sign-off from IT and HR.

Rows marked † were not asked individually. They are inherited from the gallery baseline
shared with the intent-based call routing sample, or are defaults to confirm during
review.

## Scope decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Entry point † | Teams Phone resource account via Teams Phone extensibility, with a plain ACS number as a documented fallback |
| 2 | Scenario | About 5,000 Contoso employees call one internal Teams help line, and the agent decides whether they need IT or HR. It answers routine questions from an approved corpus: VPN, MFA, printers, PTO policy, benefits enrollment dates, and the payroll calendar. It hands account unlock and MFA re-registration to the password-reset sample. Everything else becomes a ticket or a transfer to the right queue |
| 3 | Sensitive HR | Harassment, discrimination, medical leave, accommodations, termination, pay disputes, and similar matters are never discussed in detail. They go straight to a protected confidential HR path |
| 4 | Verification | Tiered by action. Anonymous callers can get general policy answers. Personal answers, ticket creation, and ticket status need Teams identity: the Entra user on a Teams call, or, on PSTN, a directory mobile number plus a one-time code sent by Teams chat or SMS. Unlock and MFA reset reuse the password-reset sample's stronger verification. Confidential HR routing needs no verification, so a barrier never blocks a report |
| 5 | Classification | Two server-side stages. First, a domain (IT, HR, both, or unclear) with a confidence score. Low confidence gets one clarifying question: "Is this about a device or account, or about pay, leave, or benefits?" Then a topic from a config taxonomy of about 20 topics, each mapped to an answer article, a ticket category, or a queue. An HR-sensitive guard runs on every final transcript and overrides everything else. Mixed calls, such as a new hire's laptop and benefits, are handled one topic at a time |
| 6 | Knowledge | Two corpora in the general inquiry sample's format: `kb/it/*.md`, owned by the IT knowledge owner, and `kb/hr/*.md`, owned by HR policy. Each article has an owner, a review-by date, and an audience (all employees, managers, or a region). Stale or out-of-audience articles are never spoken |
| 7 | Personal answers | A read-only `HrisAdapter` fixture gives the verified caller's PTO balance, next pay date, benefits enrollment window status, and manager's name. Salary, performance, and anyone else's data are never exposed |
| 8 | Tickets | A `TicketAdapter` over a local SQLite fixture ITSM. IT tickets are ServiceNow-style incidents and requests with category, priority, summary, the affected asset from the caller's fixture device list, and the caller as requester. HR cases are a separate table with restricted visibility. The agent reads back the summary and priority before filing, and speaks a ticket number such as `INC-004821`. Callers can check the status of their own tickets. A ServiceNow Table API adapter is documented, not built |
| 9 | Priority | A deterministic impact × urgency matrix. The model only fills in the slots. Impact is who is affected: just me, my team, or a site. Urgency is whether the caller is blocked from working. P1 covers a site outage and security incidents: a phishing click, a lost or stolen device, or a suspected compromise |
| 10 | Known outages | A config-driven major-incident banner. The agent announces known outages at the start of the call ("We know Outlook is down; no need to report it") and attaches matching calls to the parent incident instead of filing duplicates |
| 11 | Password-reset handoff | For an unlock or MFA re-registration, the agent confirms the need and blind-transfers to the password-reset agent's Teams resource account with `CallContext` carrying `{intent, employeeHint, sessionId}`. The reset agent still runs its own full verification. The hint only skips its intent question. Triage never performs a reset. If the reset sample is not deployed, the agent files an IT ticket instead |
| 12 | Routing | Five destinations in `config/routing.json`, each with Teams hours and a holiday calendar: IT service desk, IT on-call (P1, 24x7), HR shared services, confidential HR (a protected call queue with restricted membership), and payroll. Facilities, legal, and travel are out of scope. The agent names the right channel and does not transfer |

## Implementation decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Voice Live model † | `gpt-realtime`, configurable |
| 2 | Session mode † | Direct model mode, with a documented path to Foundry agent mode |
| 3 | Credentials † | `DefaultAzureCredential` preferred, with an API key as the quick-start fallback |
| 4 | Offline runnability † | Full local mode, where a typed transcript and a simulated caller identity drive the real state machine, classifier, sensitive guard, knowledge retrieval, HRIS answers, ticket creation, priority matrix, outage banner, routing, and handoffs |
| 5 | Verification † | Automated fixtures with `node:test`, plus a manual live-call checklist |
| 6 | Classifier | `classify(utterance)` returns `{domain, confidence, topicId}`. The sample uses the model's slot output checked against `config/taxonomy.json` keywords and examples, and the server makes the final decision. A labeled fixture set of about 60 utterances measures routing accuracy offline |
| 7 | Sensitive guard | A server-side guard over each final transcript: a keyword and phrase list in `config/sensitive.json` plus the classifier's `hr_sensitive` flag. Either one triggers it. It is checked before any tool result goes back to the model. A separate risk-of-harm list triggers the safety message first |
| 8 | Adapters | `DirectoryAdapter` (employee, mobile number, manager, region, devices), `HrisAdapter` (read-only personal answers), `TicketAdapter` (`createTicket`, `getMyTickets`, `attachToIncident`, `createHrCase`), and `OtpSender` (Teams chat or SMS). Each has a fixture implementation. ServiceNow and Graph adapters are documented stubs |
| 9 | Personal data | The model never sees Teams IDs, phone numbers, one-time codes, employee IDs, or device serial numbers. It gets the caller's first name, spoken answers, and ticket numbers. After the sensitive guard trips, the model gets no further caller words from that segment |
| 10 | Retention | Raw audio is never stored. Transcripts stay in memory by default. When `TRANSCRIPT_RETENTION` is on, IT segments are kept for `TRANSCRIPT_RETENTION_DAYS` (`30`), and HR-sensitive segments are never persisted. The audit log records only a `confidential_hr` event with no text |
| 11 | Handoff mechanics † | Blind `TransferCallToParticipant` with `CallTopic`, `CallContext`, and `SessionId`. Each queue gets only the fields that team needs |

## Experience decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Fictional org † | Contoso, with employees in Seattle, Dublin, and Singapore |
| 2 | AI disclosure † | The agent says it is an automated assistant in its opening line |
| 3 | Languages | English and Spanish, with a corpus per locale. If an article exists only in English, the agent says "This answer is only available in English" and offers to read it in English or send the link |
| 4 | Sensitive wording | A neutral acknowledgment with no follow-up questions: "That's something our HR team should handle directly. I'll connect you to a confidential HR line." |
| 5 | Safety | Any risk-of-harm phrase triggers the crisis-line and emergency message before anything else, then the confidential HR offer. This is not a crisis line |
| 6 | Call cap | 6 minutes, configurable, with a wrap-up at 5:00 that files a ticket for anything still open (if the caller is verified) or offers a callback |
| 7 | Escalation † | Transfer to the right queue when the caller asks for a person or the agent fails twice |
| 8 | DTMF † | One-time code entry for PSTN callers. `0` transfers to the IT service desk, or to HR shared services if the domain is HR. `*` repeats the last phrase |
| 9 | Realtime transport † | Local WebSocket only, with no SignalR dependency |
| 10 | Default port † | `8098`, so it runs alongside the other gallery samples on `8090`–`8097` |
| 11 | Gallery card † | Visual scene updated to depict IT/HR triage, grounded answers, tickets, and the confidential HR path when the sample lands |

## Goal

Build a runnable voice agent that gives Contoso employees one number for IT and HR help.
It should work out which team the caller needs, answer routine questions from approved
content, handle simple personal questions for verified employees, file well-formed
tickets, and route everything else to the right queue.

Privacy is part of the design, not an add-on. Sensitive HR matters get a protected path
that asks nothing, stores nothing, and passes nothing but the words "Confidential HR" to
a restricted queue. The agent never becomes the place where an employee's HR concern is
recorded.

The demo data lives in `config/` and `kb/` (runtime SQLite files are created under gitignored `code/data/`):

| File | Contents |
|---|---|
| `config/taxonomy.json` | About 20 topics with domain, examples, keywords, and an action: `answer` (article ID), `ticket` (category and default impact), `queue` (destination), `handoff` (password reset), or `out_of_scope` (channel text) |
| `config/sensitive.json` | Sensitive-HR phrases and categories, the risk-of-harm phrase list, and the spoken safety, crisis-line, and EAP/ethics hotline text per locale |
| `config/priority-matrix.json` | Impact × urgency → P1–P4, plus the security-incident categories that are always P1 |
| `config/outages.json` | Active major incidents with a spoken banner, the affected service keywords, and a parent incident number |
| `config/routing.json` | The five destinations with Teams targets, hours, holiday calendars, and the `CallContext` fields each one receives, plus the password-reset agent's resource account |
| `kb/it/*.md`, `kb/hr/*.md` | About 10 IT and 10 HR articles in English, some in Spanish, with one stale article and one managers-only article |
| `config/directory.json` | About 12 demo employees with Entra object ID, Teams user ID, mobile number, region, manager, role, and devices |
| `config/hris.json` | PTO balance, pay calendar, and benefits enrollment window per demo employee |
| `config/itsm-seed.json` | Existing tickets for status checks and the parent incident for the outage banner |

An example taxonomy entry and knowledge article header:

```json
{
  "id": "it-vpn-connect",
  "domain": "IT",
  "examples": ["VPN won't connect", "can't get on the VPN from home"],
  "action": { "type": "answer", "articleId": "it-vpn-001",
              "fallback": { "type": "ticket", "category": "Network/VPN", "impact": "me" } }
}
```

```yaml
id: hr-pto-policy-001
title: Paid time off policy
domain: HR
owner: Contoso HR Policy
audience: all
locales: [en, es]
lastReviewed: 2026-02-01
reviewBy: 2026-08-01
```

An article is spoken only when it is fresh (the date is on or before `reviewBy`, using
`DEMO_NOW` if set) and its audience matches the caller. Anonymous callers match only
`all`. A stale or out-of-audience match falls back to the topic's ticket or queue action.

## Caller experience

1. An employee calls the Contoso help line from the Teams client or a phone. The number
   is a Teams Phone resource account linked to ACS through Teams Phone extensibility. The
   documented ACS number fallback only changes provisioning.
2. Event Grid delivers `IncomingCall`. On a Teams call, the server resolves the caller's
   Teams user ID to an employee in `config/directory.json`. A PSTN caller is anonymous
   until they need a verified action.
3. The server answers through Call Automation, starts bidirectional media streaming, and
   opens a Voice Live session. The agent says: **"Hi Sam, this is the Contoso IT and HR
   help line. I'm an automated assistant. Heads up: we know Outlook is down right now
   and the team is on it. What can I help you with?"** The banner is spoken only while
   an outage is active in `config/outages.json`.
4. **Routine answer.** "My VPN keeps disconnecting." The agent calls `classify`, then
   `answer_question`, and speaks the approved steps: **"Here's what usually fixes it,
   from the IT VPN guide…"** Then: **"Did that help? I can also send you the link in
   Teams chat."**
5. **Unclear domain.** "I need access to the payroll system." Confidence is low, so the
   agent asks once: **"Is this about a system account, or about your pay?"** "The
   account." The call continues as an IT access request.
6. **Personal answer.** "How much PTO do I have?" A Teams caller is already verified. A
   PSTN caller hears **"I'll send a code to the mobile number on your employee record.
   What's your work email?"** and enters the code by voice or keypad. Then: **"You have
   62 hours of PTO. Your next pay date is May 29th."**
7. **Ticket.** "My laptop screen is flickering and I can't work." The agent calls
   `propose_ticket`. The server matches the caller's device and applies the priority
   matrix, and the agent reads back: **"I'll file this: laptop display flickering, on
   your Surface Laptop ending in 4471. You're blocked, so that's priority 2. File it?"**
   "Yes." **"Your ticket is I-N-C, 0-0-4-8-2-1. I'll send it to you in Teams chat."**
8. **Outage.** "Outlook won't open." The server matches the active incident, so the
   agent says **"That's the outage I mentioned. I've added you to the incident so
   you'll get the update when it's fixed."** No new ticket is created.
9. **Security incident.** "I think I clicked a phishing link." The matrix makes this P1.
   The agent files the ticket and says **"This is urgent, so I'm connecting you to IT
   on-call now. Don't enter any passwords in the meantime."** It then transfers to IT
   on-call with the ticket number in `CallContext`.
10. **Unlock.** "I'm locked out of my account." The agent says **"I'll connect you to
    our password reset assistant. It will verify you and unlock your account."** It
    transfers with `{intent: "unlock"}`. If the reset agent isn't configured, it files an
    IT ticket instead.
11. **Confidential HR.** "My manager has been making comments about me and I don't know
    what to do." The sensitive guard trips before the model responds. The agent says
    **"That's something our HR team should handle directly. I'll connect you to a
    confidential HR line."** It asks no questions about the matter and transfers to the
    confidential HR queue. After hours, it says **"Our confidential HR line is closed
    right now. You can reach the Contoso ethics hotline any time at the number I'll send
    you, or I can ask HR to call you back next business day."** The callback is created
    only if the caller agrees, and records only the verified identity and "Confidential
    HR".
12. **Safety.** If the caller says anything suggesting risk of harm, the agent first
    says **"If you're in danger or thinking about harming yourself, please call your
    local emergency number or a crisis line now."** It then gives the locale's
    crisis-line number and the EAP number, and offers the confidential HR line.
13. **Out of scope.** "Who do I talk to about my expense report?" **"Travel and expenses
    aren't handled on this line. You can use the Contoso Travel page on the intranet."**
14. **Ticket status.** "What's happening with my printer ticket?" For a verified caller,
    the agent calls `get_my_tickets` and speaks the status and last update.
15. The agent transfers on request or after two failures. It says **"We're almost out of
    time"** at 5:00 and files a ticket for any open topic. The 6-minute cap
    (`CALL_TIME_BUDGET_MS`) or two no-inputs end the call politely.

## Architecture and implementation shape

```text
Employee (Teams client / Teams mobile; PSTN with directory mobile + one-time code)
   → Teams Phone service number / resource account   (fallback: plain ACS number)
   → ACS Call Automation (Event Grid, callbacks, call control, media streaming)
   ↔ Node.js 22 triage service
       ↔ Azure AI Voice Live API over WebSocket
       ↔ sensitive guard (runs first on every final transcript)
       ↔ classifier (domain + topic from taxonomy.json)
       ↔ identity resolver + OtpSender (Teams user ID; directory mobile + code)
       ↔ knowledge index (kb/it, kb/hr; freshness + audience filter; per locale)
       ↔ HrisAdapter (read-only fixture)
       ↔ TicketAdapter (SQLite ITSM + restricted HR case table) + priority matrix
       ↔ outage banner (outages.json)
       ↔ routing resolver (routing.json hours + holidays)
       ↔ SQLite audit log + stats endpoint
       ↔ presenter console over a local WebSocket
   → ACS transfer to IT service desk | IT on-call | HR shared services
                   | confidential HR | payroll | password-reset agent
```

Reuse the password-reset sample's Express server, configuration pattern, ACS-to-Voice
Live media bridge, PCM16 24-kHz path, barge-in handling, SQLite event log, health
endpoint, and simulation-mode conventions. The state machine is:

`ringing → greeting (+ outage banner) → listening → classifying → (clarifying → classifying) | answering | verifying → (personal_answer | proposing_ticket → confirming → filed) | handoff_reset | (sensitive → safety? → confidential_transfer | after_hours_offer) | out_of_scope → listening … → (transferring → transferred) | wrap_up → closing → ended`

The sensitive guard can move any state to `sensitive`. From there, the only exits are
the safety message, a confidential transfer, the after-hours offer, or ending the call.

The model changes state only through server-owned tools:

- `classify(utterance)` returns `{domain, confidence, topicId, needsClarification}` or
  a clarifying phrase. The model never sees the sensitive phrase list.
- `answer_question(topicId, question)` returns a grounded answer and article citation,
  or `unavailable` for a stale, out-of-audience, or missing article, together with the
  fallback action.
- `start_verification()` and `check_code(code)` verify a PSTN caller. The model sees
  only `verified` or `failed`.
- `get_personal_answer(kind)` takes one of `pto_balance`, `next_pay_date`,
  `benefits_window`, or `manager_name`, and needs a verified caller.
- `propose_ticket(topicId, description, impact, blocked)` returns a read-back phrase
  with the matched asset and the priority from the matrix, or `attached_to_incident`
  when an active outage matches.
- `file_ticket(proposalId, confirmation)` requires an explicit confirmation token from
  the caller's last utterance, and returns a spoken ticket number.
- `get_my_tickets()` returns a spoken status summary for a verified caller.
- `send_link(articleId | ticketId)` sends a Teams chat message to a verified caller.
- `handoff_password_reset(intent)` transfers to the reset agent, or files a ticket if
  it is not configured.
- `route(destination, reason)`, `request_callback(destination)`, `transfer(reason)`,
  `repeat_last()`, and `end_call(reason)`.

The server handles the sensitive path, not the model. When the guard trips, the server
suppresses the model's pending response, plays the fixed acknowledgment text, and
performs the confidential transfer or after-hours offer itself.

## Teams handoff contract

Transfers use `TransferCallToParticipant` to the destination in `config/routing.json`.
The Teams Phone extensibility custom context carries:

- `CallDetails.SessionId`: the ACS correlation ID, which is kept in the audit record and
  shared with the password-reset agent.
- `CallDetails.CallTopic`: up to 48 characters, for example `IT – laptop display, P2,
  INC-004821`, `P1 security – phishing click INC-004822`, `Payroll – pay date question`,
  or just `Confidential HR`.
- `CallDetails.CallContext`: only the fields listed for that destination:
  - IT service desk and IT on-call: the verified name, ticket number, priority, topic,
    matched asset, and what the agent already tried.
  - HR shared services and payroll: the verified name, topic, and article cited.
  - Password-reset agent: `{intent: "unlock" | "mfa_reregister", employeeHint,
    sessionId}`, where `employeeHint` is the directory work email and is used only to
    skip the intent question, never to skip verification.
  - Confidential HR: `Confidential HR`, plus the verified name only if the caller agreed
    to share it. It carries no topic text, category, or transcript.

## Demo surface and configuration

The presenter console shows call state, caller identity and how it was verified, the
live transcript, the classifier's domain and confidence, the matched topic and action,
knowledge citations with freshness, the ticket proposal with the priority matrix cell
highlighted, filed tickets, outage attachments, and the routing decision with its hours
check. When the sensitive guard trips, the console shows only a **Confidential HR** badge
and redacts that transcript segment in the console too. An ITSM viewer shows fixture
tickets and HR cases, with HR cases hidden unless an **HR viewer** role is toggled. A
**Reset data** control restores the seed. The console is marked as a demo surface.

Configuration covers `PORT` (`8098`), `PUBLIC_BASE_URL`, `ACS_ENDPOINT` (with
`ACS_CONNECTION_STRING` as the fallback), `VOICE_LIVE_ENDPOINT`, `VOICE_LIVE_MODEL`
(`gpt-realtime`), and `VOICE_LIVE_API_VERSION` (`2026-04-10`), with Entra auth using
the **Cognitive Services User** and **Foundry User** roles and the
`https://ai.azure.com/.default` scope. It also covers `TICKET_ADAPTER` (`sqlite`),
`HRIS_ADAPTER` (`fixture`), `OTP_CHANNEL` (`teams` or `sms`), `PASSWORD_RESET_TARGET`
(empty means file a ticket instead), `CLASSIFIER_CONFIDENCE_MIN` (`0.7`),
`TRANSCRIPT_RETENTION` (`false`), `TRANSCRIPT_RETENTION_DAYS` (`30`),
`STATS_MIN_COUNT` (`5`), `DEMO_NOW` (pins the clock for hours, holidays, freshness,
and pay dates), and `CALL_TIME_BUDGET_MS` (`360000`).

With no Azure subscription, the typed-transcript mode drives the same state machine,
identity (by picking a demo employee or "PSTN anonymous"), classification, the sensitive
guard, knowledge, HRIS, tickets, outages, and routing. Only audio, the one-time code
delivery, and transfers are simulated. The sample ships a README, `DEMO-SCRIPT.md`, the
Teams provisioning snippet for the resource account and five call queues, the knowledge
corpus, the config and data fixtures, the labeled routing set, and the call fixtures.

## Acceptance criteria

- A real call from a Teams user is answered through Teams Phone extensibility, the
  employee is identified, and the call is connected to Voice Live. The ACS number
  fallback reaches the same state machine with the one-time code path. Transfers reach
  each of the five queues and the password-reset agent. All are verified by the manual
  live-call checklist.
- Barge-in works, and duplicate Event Grid deliveries do not create duplicate sessions.
- `node:test` runs the fixtures with no cloud credentials. They cover a Teams caller, an
  anonymous PSTN caller getting a general answer, PSTN verification with a correct code,
  a wrong code, and an expired code, a fresh IT answer, a fresh HR answer, a Spanish
  answer, an English-only fallback in Spanish, a stale article falling back to a ticket,
  a managers-only article for a non-manager, low confidence leading to a clarifying
  question, a mixed IT and HR call handled topic by topic, each personal answer, a
  request for a colleague's PTO or someone's salary (refused), a ticket with read-back
  and confirmation, "maybe" treated as no confirmation, each matrix cell, each P1
  security category transferring to on-call with the ticket number, an outage match
  attaching to the parent incident, ticket status for the caller's own tickets only,
  sending a link, an unlock and an MFA handoff with the right `CallContext`, a missing
  reset target falling back to a ticket, each sensitive category tripping the guard, a
  sensitive phrase mid-way through an IT call, a risk-of-harm phrase giving the safety
  message first, confidential HR in hours and after hours with and without a callback,
  an out-of-scope expense question, a holiday closing a queue, the 5:00 wrap-up filing
  an open ticket, an expired call cap, `0` and `*` DTMF, two failed attempts, two
  no-inputs, and a prompt-injection attempt to read another employee's HR data or to
  summarize a sensitive disclosure.
- The labeled routing fixture of about 60 utterances reaches the configured accuracy
  threshold (`90%` by default), and every sensitive example in it is caught.
- After the sensitive guard trips, no caller text from that segment reaches the model,
  the audit log, the transcript store, the console transcript, `CallContext`, or an HR
  case record.
- No ticket is filed without an explicit confirmation in the caller's last utterance.
  Priority always comes from the matrix, never from the model.
- Personal answers and tickets are available only to a verified caller, and only about
  that caller.
- The model context never contains Teams IDs, phone numbers, one-time codes, employee
  IDs, or device serial numbers.
- The opening line discloses that the caller is talking to an automated assistant.
- Utterance text and audio are absent from the database unless `TRANSCRIPT_RETENTION` is
  on, and HR-sensitive segments are absent even then.
- `GET /health` reports application, Voice Live, Teams Phone provisioning, ticket and HRIS
  adapters, knowledge article counts by domain and freshness, active outages, the
  routing table and current open or closed state per queue, the password-reset target,
  and simulation mode.
- `GET /api/stats` reports calls, the IT vs HR vs both mix, Tier 1 deflection (resolved
  with no ticket or transfer), routing accuracy (from the labeled fixture set and
  re-route events reported by queues), average time to resolution, answers by article,
  tickets by category and priority, outage attachments, reset handoffs, transfers by
  destination, out-of-scope redirects, and verification outcomes. Confidential HR
  appears only as a total, shown as `<5` when fewer than `STATS_MIN_COUNT` calls, with
  no breakdown by time, region, or category.

## Production gates and non-goals

The sample does not connect to a live ITSM, HRIS, or directory, perform password resets
itself, change HR records, take detailed HR complaints, act as a crisis line, place
outbound calls, or record audio. Before real use, the following are needed:

- Named owners in IT and HR for the taxonomy, each knowledge corpus, the priority matrix,
  and the routing table, with a review cadence.
- HR, legal, and employee-relations sign-off on the sensitive categories, the neutral
  wording, the confidential queue's membership, and the after-hours hotline and callback
  process.
- Review by a qualified clinical or employee-assistance partner of the risk-of-harm
  detection and safety message for each locale.
- Implemented and tested adapters for the ITSM (for example the ServiceNow Table API),
  the HRIS, and the directory, running with least-privilege service identities.
- Identity review of the one-time code channel, the directory mobile number source, and
  the handoff trust boundary with the password-reset agent.
- Privacy, works-council, and records review of what each team sees, retention periods,
  and the small-count suppression for confidential HR statistics.
- Security operations sign-off on the P1 security categories and on-call path.
- Validated Event Grid subscriptions, warm compute on the answer path, rate limits, and
  managed identity or Key Vault for credentials.
- Applicable Teams certification and organizational reviews.

Primary measures are Tier 1 deflection, routing accuracy, and resolution time.

## Microsoft reference contracts

- [Teams Phone extensibility overview](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-overview)
- [Answer Teams Phone calls with Call Automation](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-answer-teams-calls)
- [Teams Phone extensibility IVR and transfer](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-interactive-voice-response)
- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [Voice Live API how-to — endpoint, api-version, and Entra auth](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to)
- [Voice Live language support](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-language-support)
- [Call Automation transfer to a participant](https://learn.microsoft.com/azure/communication-services/how-tos/call-automation/actions-for-call-control#transfer-a-participant-in-a-call)
- [Plan Teams auto attendants and call queues](https://learn.microsoft.com/microsoftteams/plan-auto-attendant-call-queue)
- [Create a Teams call queue](https://learn.microsoft.com/microsoftteams/create-a-phone-system-call-queue)
- [Set up holidays in Teams](https://learn.microsoft.com/microsoftteams/set-up-holidays-in-teams)
