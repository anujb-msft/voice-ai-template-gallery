# Contextual On-Call Pager

This gallery package presents an after-hours maintenance line for Contoso Property
Management, a fictional landlord. A tenant calls late at night and describes the problem
in their own words. The voice agent captures what is wrong, where, a short quote from the
tenant, whether the technician may go in, and a callback number, and tells the tenant what
happens next. The server then calls whoever is on call tonight with a short spoken brief
built from those fields, and escalates from the primary to the secondary to the property
manager if nobody accepts. The tenant's call comes in through Teams Phone extensibility;
Azure Communication Services Call Automation answers it and places the pages, and the
Azure AI Voice Live API handles the conversation on both calls.

The interesting part is not the summary. It is the paging policy the server enforces: the
rotation says who is on call and why, escalation runs on a timer, a voicemail hears no
private details, and a problem that can wait becomes a work order instead of a page.

## Package contents

- [`code/`](./code/) — runnable source implementation with a presenter console, setup
  instructions, configuration example, paging policy files, presenter demo script, a Teams
  Phone provisioning checklist script, and tests.
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
real call would — only the model and the phone network are stubbed.

```bash
cd code
npm install
npm start          # http://127.0.0.1:8095
```

Open <http://127.0.0.1:8095> and press **→** to run the scripted demo one step at a time;
[`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md) is the running order and narration.

```bash
npm test           # no Azure and no network required
```

## Common flows to test

Start each flow with **Reset demo**, then pick the clock preset in the header and the
**Caller ID** named in the first column, click **Answer a call**, and type each line into
the box. Once a page rings, the same box speaks for the technician, and the keypad sends
the technician's keys.

| Flow | Say or type | Expected behavior |
| --- | --- | --- |
| Urgent leak, accepted — *Weeknight on call*, Alice Rivera | `Water is pouring through my kitchen ceiling and it's spreading fast.` → `Yes, 4B. You can go in — the spare key is in the lockbox by the back door.` → `Yes, that's my cell.` → `Morgan Lee here.` → `I've got it.` | Urgent: an active leak. Morgan Lee, on call from the central rotation, is paged with the brief and accepts, and the tenant is called back: "A technician has your request and will call you shortly." |
| Nobody answers — *Weeknight on call*, Dee Nguyen | `The heat is out in unit 11 at Pine Terrace and it's 52 degrees in here. You can let yourself in.` → `Yes.` → **Silence** → **Skip to the next page** → **Silence** → **Skip to the next page** → `Priya Shah here.` → `I've got it.` | 52 °F is below the 55 °F no-heat line, so urgent. Omar Diaz is paged twice, 3 minutes apart on the demo clock, then "Omar Diaz didn't answer 2 attempts. Escalating to the secondary, Priya Shah", who accepts |
| Technician declines — *Weeknight on call*, Alice Rivera | The first three lines of *Urgent leak, accepted* → `Morgan Lee here.` → press **2** | "Morgan Lee declined. Escalating to the secondary, Priya Shah, now." — without waiting for the timer |
| Voicemail stays private — *Swap night*, Ben Carter | `I'm locked out of my apartment and my keys are inside.` → `Yes, 2A. I'm waiting in the lobby by the front door.` → `Yes.` → **Voicemail picks up** | The swap override puts Priya Shah first tonight, so she is paged. Her voicemail hears only "Contoso maintenance has an urgent page for you. Please call the maintenance line." and a reference; the console lists what was left out, and her second attempt is due 3 minutes later |
| Can wait for the office — *Weekend*, Grace Kim | `The heat is out in my bedroom, but it's about 64 degrees inside.` → `Yes, unit 7. You can go in, I'm home all weekend.` → `Yes.` | Above the 55 °F line, so nobody is paged: "I've logged a work order for the office. They'll follow up Monday morning." |
| Asking for the tenant's number — *Weeknight on call*, Ben Carter | `No power in unit 2A at Maple Court since the storm. You can go in, and please call me back on this number.` → `Morgan here.` → `What's the tenant's phone number?` → press **3** | "I can't share phone numbers. Press 3 and I'll connect you to the tenant." Then "Connecting you to Ben now — neither of you will see the other's number." |
| Gas — *Weeknight on call*, Alice Rivera | `I smell gas in the kitchen.` | The safety line first — "…hang up and call 911 now. I'm also paging the on-call technician now." — then an emergency page to Morgan Lee |
| Asking for a person — *Weeknight on call*, Alice Rivera | `Can I talk to a real person?` → **Silence** → **Silence** | "The office is closed, so I can't put you through to a person — but this line pages the on-call technician for urgent problems, and they'll call you back." Two silences end the call, and nobody is paged |
| Unit not on file — *Weeknight on call*, Unknown number | `Water is leaking from the ceiling in unit 9 at Maple Court.` → `4B` → `Yes` → `Yes` | "I could not validate unit 9 at Maple Court. What's the unit number at Maple Court?" The agent takes 4B instead and pages Morgan Lee |

On a live call the agent's wording comes from the model and varies, and recognizing a
voicemail greeting is the model's judgment; the severity, who is paged, the timers, the
brief and the voicemail prompt come from the server. The clock presets are simulation
only — a live page runs on the real time. See the
[`code/README.md` live call matrix](./code/README.md#live-call-test-matrix) for setup
details and test-environment caveats.

For real calls, follow the setup and Teams Phone provisioning guidance in
[`code/README.md`](./code/README.md). To present it, use
[`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md).

Do not commit `.env`, generated `data/`, logs, or `node_modules/`.
