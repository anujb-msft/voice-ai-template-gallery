# Appointment Reminder Agent

This gallery package presents an outbound voice agent that calls patients about two days
before an appointment. It makes sure it is speaking with the patient, or someone the
patient has authorized, then lets them confirm, cancel, or ask for a different time. A
request for a new time goes to the clinic's scheduling desk in Teams, with the appointment
passed along in the transfer. Calls are placed with Azure Communication Services Call
Automation and spoken through the Azure AI Voice Live API. Teams Phone extensibility is the
phone channel for patients who call the clinic's Teams Phone number back.

The interesting part is not the conversation. It is what the server will not let the call
do: say anything about the appointment before the date of birth matches, leave more than a
callback request with a voicemail or with whoever else answers, dial outside calling hours
or after an opt-out, or book a time on its own.

## Package contents

- [`code/`](./code/) — runnable source implementation, setup and phone connection
  instructions, configuration example, presenter demo script, offline terminal harness,
  smoke test, and tests.
- [`SPEC.md`](./SPEC.md) — the agreed patient journey, architecture, dialing policy,
  Teams handoff contract, and acceptance criteria.
- [`video/`](./video/) — recording, poster, caption, and transcript delivery scaffolding.
  No media binary is included yet.
- [`slides/`](./slides/) — the one-slide value proposition (PDF), generated from
  `template.json`. The editable deck and its preview image are not included yet.
- [`media/`](./media/) — gallery thumbnail and conceptual architecture illustration.
- [`template.json`](./template.json) — business and technical metadata, GitHub
  Pages-safe relative paths, and expected asset status.

## Run the implementation

It runs with no Azure subscription. A typed transcript drives the same state machine a
real call would — only the model and the audio path are stubbed.

```bash
cd code
npm install
npm start          # http://127.0.0.1:8099
```

Open <http://127.0.0.1:8099> and press **→** to run the scripted demo one step at a time;
[`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md) is the running order and narration.

```bash
npm test           # no Azure and no network required
```

## Common flows to test

In the console, choose the **Patient to remind**, set **Language** to **English** (Jordan
and Camila prefer Spanish), leave **Who picks up** on **A person** unless the row says
otherwise, press **Place the call**, and type the patient's lines. Press **Reset demo**
before each row: a confirmed appointment is not called again.

| Flow | Say or type | Expected behavior |
| --- | --- | --- |
| Confirm | Jordan R.: `Yes, this is Jordan.` → `March 12th, 1984.` → `Yes, I'll be there.` | Asks for the date of birth before saying anything about the appointment, then gives the details, records the confirmation, and reads the fasting instructions |
| Cancel | Avery S.: `Yes, speaking.` → `June 9th, 1979.` → `I need to cancel.` → `Yes, please cancel it.` | Reads the cancellation back and waits for a yes; the schedule panel then shows the appointment cancelled and its slot free again |
| New time | Riley D.: `Yes, this is Riley.` → `August 14th, 2002.` → `Can I come next week instead?` | Hands the call to the scheduling desk with the appointment in the Teams VoIP headers; the current appointment stays booked, and the agent books nothing |
| Someone else answers | Camila L.: `No, this is her sister.` | Asks only that Camila call the clinic back; no department, provider, or time is mentioned |
| Voicemail | Camila L., with **Who picks up** on **Voicemail · last attempt** | Leaves a callback request and nothing else. On **Voicemail · early attempt** it hangs up without a message and schedules a retry |
| Wrong date of birth | Jordan R.: `Yes, this is Jordan.` → `January 1st, 1990.` → `January 1st, 1990.` | Allows one more try, then gives the clinic's number and ends the call without revealing the appointment |
| Medical question | Jordan R.: `Yes, this is Jordan.` → `March 12th, 1984.` → `I have a fever, should I still come?` → `Yes.` | Gives no medical advice and offers the nurse line; `Yes.` transfers the call there |
| Opt out | Avery S.: `Please stop calling me.` | Confirms and records the opt-out before the call ends; placing the call to Avery again is refused |
| Calling hours | Press **Too late to call · 8:30 PM** on the demo clock, then place the call to Noah M. (A-20425) | The server does not dial and shows why: the 8:00 AM–8:00 PM calling hours, Noah's local time, and the next allowed time |

On a live call the model's wording can vary; the dial gates, the identity check, the
schedule changes, and the handoff are decided by the server. If nobody at the scheduling
desk answers a live transfer, the agent apologizes once, says the request for a new time is
saved, and ends the call. See the
[`code/README.md` live call test matrix](./code/README.md#live-call-test-matrix) for setup
details and test-environment caveats.

For real calls, follow the setup and Teams Phone provisioning guidance in
[`code/README.md`](./code/README.md), including the security notes to read before calling
real patients. To present it, use [`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md).

Do not commit `.env`, generated `data/`, logs, or `node_modules/`.
