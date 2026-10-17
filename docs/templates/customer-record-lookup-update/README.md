# Customer Record Lookup & Update

This gallery package presents a hands-free CRM line for field sales reps. A rep calls from
Teams or from a registered mobile and is verified before anything is read out, hears a
short briefing on one of their own customer accounts, and dictates what happened in a
meeting. The agent writes that back to the record only after reading it back, hearing an
explicit "yes, save it", and letting a short undo window run out; every write leaves
field-level audit rows. It runs on Teams Phone extensibility for the phone channel, with
Azure Communication Services Call Automation and the Azure AI Voice Live API.

The interesting part is not reading a record aloud. It is the policy around it: identity
before disclosure, an allow-list of the fields a phone call may change, a server-owned
undo window in which "wait, no" means nothing is written, and a handoff to Sales
Operations, context attached, when a request isn't the agent's to handle.

## Package contents

- [`code/`](./code/) — runnable source implementation, setup instructions, configuration
  example, seeded fictional customer records, presenter demo script, Teams provisioning
  script, and tests.
- [`SPEC.md`](./SPEC.md) — the agreed scope, caller experience, architecture, Teams
  handoff contract, acceptance criteria, and production gates.
- [`video/`](./video/) — recording, poster, caption, and transcript delivery scaffolding.
  No media binary is included yet.
- [`slides/`](./slides/) — presentation delivery scaffolding. No presentation binary is
  included yet.
- [`media/`](./media/) — gallery thumbnail and conceptual architecture illustration.
- [`template.json`](./template.json) — business and technical metadata, GitHub
  Pages-safe relative paths, and expected asset status.

## Run the implementation

It runs with no Azure subscription. A typed transcript drives the same state machine a
real call would — only the speech model and the audio path are stubbed.

```bash
cd code
npm install
npm start          # http://127.0.0.1:8097
```

Open <http://127.0.0.1:8097> and press **→** to run the scripted demo one step at a time;
[`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md) is the running order and narration.

```bash
npm test           # no Azure and no network required
```

## Common flows to test

In the console, pick a **Caller ID**, click **Answer a call**, and type the caller's
lines. Rows use an **Alex (Teams)** call unless they say otherwise, and the first five can
run in order on one call.

| Flow | Say or type | Expected behavior |
| --- | --- | --- |
| Briefing | `Brief me on Fabrikam` → `What's Dana's number?` | Tier, last touch, three open deals, a task due today and the key contact, with no phone number; the number is read out, and shown on the record card, only once asked |
| Save | `Log the Fabrikam meeting. Dana agreed to the renewal at 240k, moving to Closed Won pending signature, close date June 15th. Remind me to send the contract Friday.` → `Yes` → `Yes, save it.` | Reads back a meeting, four deal changes and a task due Friday, June 12. The bare `Yes` writes nothing; "yes, save it" starts a six-second undo window, then "Saved to Fabrikam's record." with a before → after diff and audit rows |
| Undo | After the save: `Undo that` | "Undone. Fabrikam's record is back to how it was." |
| Mind change | `Update Fabrikam: Dana has a new mobile, 425 555 0143.` → `Yes, save it.` → within six seconds, `Wait, no — keep the old number.` | Stopped inside the undo window: nothing is written, and Dana's number is still the one ending 0120 |
| Policy refusal | `Raise Fabrikam's credit limit to 500k and move them to net 60 payment terms.` → `Yes, put me through.` | Refused by server policy with nothing written, then a transfer to Contoso Sales Operations with the topic "Fabrikam – credit limit, payment terms" and the request in the VoIP headers |
| Human escape | On a new call: `I need a person` | Straight to Contoso Sales Operations, with no further questions |
| Verification fails | On an **Alex (mobile)** call, the keypad's **PIN wrong** key (`135790`) | No record opened and nothing read out; a handoff with the topic "Unverified caller – no records opened" |
| Someone else's account | On a new call: `Brief me on Tailspin`, twice | Another rep's account stays closed ("I couldn't find an account by that name on your list"); after the second miss, a person |
| Date rules | With the header clock on the **Demo day** preset: `Move the Fabrikam renewal close date to June 1st.` | "The close date can't be in the past, so I left it alone. Nothing was written." On **Real time**, `Brief me on Fabrikam` calls the same task overdue |

The undo window is six seconds; to type a whole sentence inside it, start the server with
`COMMIT_UNDO_MS=10000`. On a live call the model words its own replies around the
server's lines, so the phrasing varies; who is verified, what is refused, and when a
write lands are decided by the server and do not. See the
[`code/README.md` live call matrix](./code/README.md#live-call-test-matrix) for setup
details and live-only paths such as transfer recovery.

For real calls, follow the setup and Teams Phone provisioning guidance in
[`code/README.md`](./code/README.md). To present it, use
[`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md).

Do not commit `.env`, generated `data/`, logs, or `node_modules/`.
