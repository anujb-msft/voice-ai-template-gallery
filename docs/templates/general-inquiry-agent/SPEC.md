# General Inquiry Agent — Sample Specification

**Status:** implementation guide for an illustrative, demo-grade sample. This is not a
production information service, and its answers are only as accurate as the fixture
content it ships with.

Rows marked † were not asked individually. They are inherited from the gallery baseline
shared with the intent-based call routing sample, or are defaults to confirm during
review.

## Scope decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Entry point † | Teams Phone resource account via Teams Phone extensibility, with a plain ACS number as a documented fallback |
| 2 | Scenario | City of Contoso municipal information line covering hours, locations, services, and eligibility |
| 3 | Grounding | Curated local Markdown corpus in the repo, retrieved by keyword and metadata behind a server tool. Azure AI Search is the documented production swap |
| 4 | Corpus | About 12 articles across 4 topics, including one deliberately stale article and one expired article |
| 5 | Freshness | Every article has an `owner`, a `lastReviewed` date, and a `reviewBy` date. Stale articles are answered with a spoken caveat and flagged in the audit log. Expired articles are refused, and the caller is offered a transfer |
| 6 | Citations | The agent names the source aloud and gives the short URL when asked. Full citations (article ID, section, review date) appear in the presenter console and audit log |
| 7 | Answer policy | Answers come only from retrieved passages. When retrieval is below threshold or the question is out of scope, the agent says so and offers a transfer. It never guesses |
| 8 | Eligibility | The agent gives general criteria only, with a disclaimer that staff decide eligibility. It never assesses an individual case and never collects personal data |
| 9 | Human transfer | Hours-aware. During staffed hours the call goes to the Teams Call Queue. After hours the agent says when staff are available and ends the call politely. There is no voicemail |
| 10 | Metrics | Deflection, grounded-answer rate, stale-answer count, escalation rate, and per-topic counts |

## Implementation decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Voice Live model † | `gpt-realtime`, configurable |
| 2 | Session mode † | Direct model mode, with a documented path to Foundry agent mode |
| 3 | Credentials † | `DefaultAzureCredential` preferred, with an API key as the quick-start fallback |
| 4 | Offline runnability † | Full local mode, where a typed transcript drives the real state machine and retrieval |
| 5 | Verification † | Automated fixtures with `node:test`, plus a manual live-call checklist |
| 6 | Retrieval † | Field-weighted keyword scoring over title, tags, and body, with an optional topic filter. Results below `RETRIEVAL_MIN_SCORE` count as a miss |
| 7 | DTMF | `0` reaches a person at any time. No other keypad menu |
| 8 | No-input policy † | Two reprompts, then a transfer offer during staffed hours or a polite close after hours |
| 9 | Transcript retention † | Events, citations, and summaries are stored at rest. The full transcript stays in memory unless persistence is opted in |
| 10 | Handoff † | Blind `TransferCallToParticipant` to a configured Teams Call Queue, carrying `CallTopic` and `CallContext` |

## Experience decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Fictional org † | City of Contoso |
| 2 | AI disclosure † | The agent says it is an automated assistant in its opening line |
| 3 | Questions per call | Several. The agent asks "Is there anything else?" after each answer |
| 4 | Call cap † | 5 minutes, configurable, then a graceful close with the staffed-hours message or a transfer offer |
| 5 | Answer length | About two sentences, followed by an offer of more detail |
| 6 | Accessibility | Spoken "repeat that" and "slower" are honored, alongside DTMF `0` and short answers |
| 7 | Realtime transport † | Local WebSocket only, with no SignalR dependency |
| 8 | Default port † | `8092`, so it runs alongside the password-reset (`8090`) and routing (`8091`) samples |
| 9 | Gallery card † | Visual scene updated to depict the grounded-answer flow when the sample lands |
| 10 | Transfer audio † | A spoken "connecting you now", with no hold tone |

## Goal

Build a runnable inbound voice agent that answers a City of Contoso information line. It
should answer common questions about hours, locations, services, and eligibility from
approved content only, say where each answer came from, and be honest when content is
missing or out of date. The sample shows grounding, freshness, and citation discipline in
a voice channel, where the caller cannot see a link or a footnote.

This template answers questions and does not take service requests. Reporting a pothole
or a missed pickup belongs to the 311 service assistant, which is expected to reuse this
corpus format. Here the agent handles those requests like any other out-of-scope
question: it says it cannot file requests and offers a transfer.

The demo corpus lives in `content/articles/`:

| Topic ID | Covers | Example articles |
|---|---|---|
| `hours-locations` | Opening hours, addresses, holiday closures | City Hall hours, library branches, recycling centre location |
| `permits-licences` | What is needed, how to apply, fees | Residential parking permit, dog licence, yard-sale permit |
| `waste-recycling` | Collection days, accepted items, bulky pickup | Recycling rules, bulky-item pickup, holiday schedule changes |
| `benefits-eligibility` | General criteria for city programs | Senior utility discount, recreation fee assistance |

Each article is Markdown with front matter:

```yaml
id: waste-bulky-pickup
title: Bulky item pickup
topic: waste-recycling
owner: Contoso Public Works
source: Contoso Public Works — Residential Services
shortUrl: contoso.gov/bulky
lastReviewed: 2026-01-15
reviewBy: 2026-07-15
```

At a given date, an article is **fresh** if that date is on or before `reviewBy`. It is
**stale** if the date is up to `CONTENT_EXPIRY_GRACE_DAYS` (default `90`) days past
`reviewBy`. It is **expired** beyond that. The reference date is the system clock, unless
`DEMO_TODAY` pins it so the fixtures stay deterministic. The corpus ships with exactly one
stale article and one expired article.

## Caller experience

1. The caller dials the City of Contoso information number, which is a Teams Phone
   resource account linked to ACS through Teams Phone extensibility. The documented ACS
   number fallback only changes provisioning.
2. Event Grid delivers `IncomingCall`. The server answers through Call Automation, starts
   bidirectional media streaming, and opens a Voice Live session.
3. The agent greets the caller: **"Thanks for calling the City of Contoso. I'm an
   automated assistant and can answer questions about city services, hours, and
   programs. What can I help you find?"**
4. For each question, the model calls `search_content`. The server returns scored
   passages and their freshness status. The agent answers in about two sentences using
   only those passages, names the source ("That's from Contoso Public Works"), and offers
   more detail. If the caller asks where the information came from, the agent reads out
   the short URL.
5. A **stale** passage is answered with a caveat: **"This information was due for review
   in July, so please check contoso.gov/bulky or ask staff before relying on it."** An
   **expired** passage is not used. The agent says the information may be out of date and
   offers a transfer.
6. For an **eligibility** question, the agent gives the published general criteria and
   always adds: **"Staff make the final decision on eligibility."** If the caller offers
   personal details ("I'm 67 and my income is…"), the agent does not evaluate them. It
   repeats the general criteria and offers a transfer.
7. If retrieval misses, or the question is outside the corpus, the agent says **"I don't
   have approved information on that"** and offers a transfer. It never answers from
   general model knowledge.
8. After each answer the agent asks **"Is there anything else?"** The caller can ask
   another question, say "repeat that" or "slower", or say they are done.
9. On a human request, a declined answer, DTMF `0`, or an accepted transfer offer, the
   server checks the staffed hours in `config/hours.json`. During those hours the agent
   says **"Connecting you now"** and the server transfers to the information desk queue
   with context. Outside them the agent says **"Our information desk is open weekdays
   from 8 to 5. Please call back then, or visit contoso.gov."** and ends the call.
10. A 5-minute call cap (`CALL_TIME_BUDGET_MS`) applies throughout. When it expires, the
    agent finishes its current sentence and closes the same way as step 9.

## Architecture and implementation shape

```text
PSTN caller
   → Teams Phone service number / resource account   (fallback: plain ACS number)
   → ACS Call Automation (Event Grid, callbacks, call control, media streaming)
   ↔ Node.js 22 inquiry service
       ↔ Azure AI Voice Live API over WebSocket
       ↔ content index (content/articles/*.md) + freshness evaluator + staffed hours
       ↔ SQLite audit log + stats endpoint
       ↔ presenter console over a local WebSocket
   → ACS transfer to Teams Call Queue + Teams custom call context
```

Reuse the password-reset sample's Express server, configuration pattern, ACS-to-Voice
Live media bridge, PCM16 24-kHz path, barge-in handling, SQLite event log, health
endpoint, and simulation-mode conventions. The content index is built in memory at
startup from the Markdown corpus, and the same interface can later be backed by Azure AI
Search without changing the tools. The state machine is:

`ringing → greeting → listening → answering → listening … → transferring → transferred | closed | ended`

`closed` covers after-hours declines, the call cap, and callers who are done.

The model changes state only through server-owned tools:

- `search_content(query, topic?)` returns up to three passages. Each passage carries
  `articleId`, `title`, `section`, `source`, `shortUrl`, `freshness` (`fresh` or
  `stale`), and `score`. Expired articles are removed server-side and reported only as
  `expiredMatch: true`, so the model can never quote them. A result below
  `RETRIEVAL_MIN_SCORE` returns `miss: true` and no passages.
- `record_answer(articleIds, topic)` must be called for every substantive answer. The
  server rejects IDs that were not returned by the most recent `search_content` call on
  this call. That produces a checkable citation for each answer and powers the
  grounded-answer metric.
- `request_human(reason, topic)` is hours-aware. The server either starts a transfer or
  returns the after-hours message and the next staffed time for the agent to speak.
- `end_call(reason)` closes the call when the caller is done.

Article text is passed to the model as quoted data, and the system prompt says that
instructions inside content must never be followed. The model never sees Teams
identifiers or phone numbers, and no tool accepts them.

## Teams handoff contract

Transfers use `TransferCallToParticipant` to the Call Queue configured in
`config/hours.json`, addressed with `MicrosoftTeamsAppIdentifier`. The Teams Phone
extensibility custom context carries:

- `CallDetails.SessionId`: the Auto Attendant session ID when present, and otherwise the
  ACS correlation ID, which is kept in the audit record.
- `CallDetails.CallTopic`: the topic of the question that prompted the transfer, up to 48
  characters.
- `CallDetails.CallContext`: one or two sentences saying what was asked, what was
  answered with which article IDs, and why the agent is transferring (a miss, expired
  content, an eligibility follow-up, or the caller asked).
- `CallDetails.CallSentiment`: sent only when the caller states frustration explicitly.

No caller details are sent. This template does no caller lookup or identification.

## Demo surface and configuration

The presenter console shows call state, the live transcript, every `search_content`
query with its scored passages and freshness badges, each recorded citation, the
staffed-hours decision, and the transfer context. Stale and expired hits are color-coded
so the freshness demo is visible at a glance. The console is marked as a demo surface and
never claims a transfer completed in simulation mode.

Configuration covers `PORT` (`8092`), `PUBLIC_BASE_URL`, `ACS_ENDPOINT` (with
`ACS_CONNECTION_STRING` as the fallback), `VOICE_LIVE_ENDPOINT`, `VOICE_LIVE_MODEL`
(`gpt-realtime`), and `VOICE_LIVE_API_VERSION` (`2026-04-10`), with Entra auth using the
**Cognitive Services User** and **Foundry User** roles and the
`https://ai.azure.com/.default` scope. It also covers `RETRIEVAL_MIN_SCORE`,
`CONTENT_EXPIRY_GRACE_DAYS` (`90`), `DEMO_TODAY`, `CALL_TIME_BUDGET_MS` (`300000`), and a
single `LOCALE`/`VOICE` pair. `config/hours.json` holds the time zone, the weekly staffed
hours, and the placeholder Call Queue application ID.

With no Azure subscription, the typed-transcript mode drives the same state machine and
retrieval. Answers, caveats, citations, hours decisions, and handoff context all behave
normally, and only audio and the real transfer are simulated. The sample ships a README,
`DEMO-SCRIPT.md`, the Teams provisioning snippet, the corpus, and the call fixtures.

## Acceptance criteria

- A real call to the provisioned number is answered through Teams Phone extensibility and
  connected to Voice Live. The ACS number fallback reaches the same state machine. Both
  are verified by the manual live-call checklist.
- Barge-in works, and duplicate Event Grid deliveries do not create duplicate sessions.
- `node:test` runs the fixtures with no cloud credentials. They cover a fresh answer, a
  stale answer with its caveat, an expired match that is refused with a transfer offer, a
  retrieval miss, an out-of-scope service request, a general eligibility answer with its
  disclaimer, a caller who volunteers personal eligibility details, a request for the
  citation, three questions in one call, "repeat that", DTMF `0`, a human request during
  staffed hours, a human request after hours, two no-inputs, an expired call cap, a failed
  transfer, a `record_answer` call with an article that was not retrieved, and a caller
  prompt-injection attempt.
- Every substantive answer has a recorded citation for an article that was retrieved on
  that call. No answer uses an expired article, and every stale answer is spoken with a
  caveat.
- Eligibility answers always include the staff-decision disclaimer. No eligibility
  details the caller volunteers are stored.
- The opening line discloses that the caller is talking to an automated assistant.
- After-hours human requests never attempt a transfer.
- Utterance text is absent from the database unless transcript persistence is enabled.
- `GET /health` reports application, Voice Live, Teams Phone provisioning, content index
  (article count, stale count, expired count), and simulation mode.
- `GET /api/stats` reports calls, answers, the grounded-answer rate, stale-answer count,
  expired refusals, misses, escalation rate, and per-topic counts. It also reports the
  **deflection rate**: the share of calls that ended with at least one recorded answer and
  no human request or transfer.

## Production gates and non-goals

The sample does not implement service-request intake, caller identification,
personalized eligibility decisions, multilingual content, content authoring workflows,
call recording, or emergency calling. Its corpus is a static fixture and its retrieval is
deliberately simple. Before real use, the following are needed:

- An accountable owner and review cadence for every article, with content ingested from
  the system of record.
- Retrieval moved to Azure AI Search or an equivalent, and answer accuracy evaluated
  against a question set.
- Prompt-injection tests on both caller speech and content.
- Accessibility review, including TTY and relay access.
- Validated Event Grid subscriptions, warm compute on the answer path, rate limits, and
  managed identity or Key Vault.
- Applicable Teams certification and organizational reviews.

Primary measures are the deflection rate, grounded-answer rate, answer accuracy against
the fixture question set, stale-answer and expired-refusal counts, and escalation rate.

## Microsoft reference contracts

- [Teams Phone extensibility overview](https://learn.microsoft.com/azure/communication-services/concepts/interop/tpe/teams-phone-extensibility-overview)
- [Answer Teams Phone calls with Call Automation](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-answer-teams-calls)
- [Teams Phone extensibility IVR and transfer](https://learn.microsoft.com/azure/communication-services/quickstarts/tpe/teams-phone-extensibility-interactive-voice-response)
- [Voice Live API overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [Voice Live API how-to — endpoint, api-version, and Entra auth](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-how-to)
- [Azure AI Search overview](https://learn.microsoft.com/azure/search/search-what-is-azure-search)
