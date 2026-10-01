# Presenter walkthrough

## Setup

```bash
npm install --registry https://packagefeedproxy.microsoft.io/npm/ --no-audit --no-fund
npm start
```

Open <http://127.0.0.1:8097>. Keep the console visible; it is labeled as a demo surface.

## Talk track

1. **Start** — Click **Start simulated Alex call**. Point out the opening disclosure: “I'm the Contoso sales assistant, an automated agent.”
2. **Briefing** — Type `Brief me on Fabrikam`. The server scopes records to Alex, confirms Fabrikam in Seattle, and returns account tier, last touch, open opportunities, due tasks, and key contact.
3. **Contact gating** — Type `What's Dana's number?`. Explain that contact details are only returned after a direct request.
4. **Dictated update** — Type:
   `Log the Fabrikam meeting. Dana agreed to the renewal at 240k, moving to Closed Won pending signature, close date June 15th. Remind me to send the contract Friday.`
   Show the proposal read-back: activity, opportunity diffs, and task.
5. **Amendment** — Type `Actually keep it in Negotiation.` The server rebuilds the proposal and removes the stage write.
6. **Refusal** — Type `Give them a 10 percent discount.` The console shows a refused write; no transfer is triggered.
7. **Commit** — Type `yes, save it`. Show `/api/stats` and the proposal commit ID.
8. **Undo** — Type `undo that`. Show the CRM values revert and the undo count increment.
9. **Draft** — Start another proposal, then type `call me back later`; restart the call and type `resume my draft`.
10. **Handoff** — Type `I need a person`. Explain the blind Teams transfer carries `SessionId`, `CallTopic` (≤48 chars), and `CallContext` without PINs or contact details.

## What to emphasize

- Voice Live and ACS are simulated only in offline mode; CRM authorization, validation, proposal, commit, undo, draft, and stats are real code paths.
- The model proposes actions; the server owns records, old values, allow-list validation, and writes.
- Utterance text is not written to SQLite unless `TRANSCRIPT_RETENTION=true`.
