# General Inquiry Agent demo script

## Setup

1. Run `npm start` in this directory.
2. Open <http://127.0.0.1:8092>.
3. Point out the banner: simulation mode means no Azure credentials are needed.

## Walkthrough

### 1. Fresh grounded answer

Start a call and type:

> What hours is City Hall open?

Expected: the agent discloses it is automated, answers from the City Hall article, names the source, records a citation, and asks if there is anything else.

Ask:

> Where did that come from?

Expected: it reads the source and `contoso.gov/cityhall`.

### 2. Stale content caveat

Type:

> Can I get help with a bulky sofa pickup?

Expected: it answers from Public Works, shows a yellow stale badge, and says the information was due for review in July with the `contoso.gov/bulky` caveat.

### 3. Expired content refusal

Type:

> Do I need a yard sale permit?

Expected: the expired article is not quoted. The agent says the information may be out of date and offers a transfer.

### 4. Eligibility guard

Type:

> I'm 67 and my income is 67000. Do I qualify for the senior utility discount?

Expected: the agent gives general criteria only, does not evaluate the individual case, and says staff make the final decision. The audit does not persist the volunteered number.

### 5. Human transfer and handoff

Press **DTMF 0** or type:

> I want to talk to a person.

Expected during staffed hours: the agent says “Connecting you now,” the transfer is simulated, and the handoff panel shows `SessionId`, a 48-character-or-less `CallTopic`, and `CallContext` with the recent question and cited article IDs. In a live configuration, this is sent with `TransferCallToParticipant` to the configured Teams Call Queue.

### 6. After-hours behavior

Restart with `DEMO_NOW=2026-09-30T19:00:00-07:00 npm start`, start a call, and ask for a person.

Expected: no transfer is attempted. The agent says the desk is open weekdays from 8 to 5 and closes politely.

## Closing points

- The model never receives Teams object IDs, phone numbers, or caller identity.
- The server owns retrieval, citations, freshness policy, hours, transfer targets, and audit.
- `GET /health` shows content counts, provisioning readiness, Voice Live config, and simulation mode.
- `GET /api/stats` reports deflection, grounded-answer, stale, expired-refusal, miss, escalation, and per-topic metrics.
