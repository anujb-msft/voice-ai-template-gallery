# 311 Service Assistant

This gallery package presents an inbound voice agent for a city's 311 line. In one
conversation, in English or Spanish, a resident can ask a civic question and hear the answer
with its source, report a pothole or a missed pickup, book a bulk-item pickup, or check on a
case. Each report gets a case number, a department and a response target and, with the
caller's consent, a confirmation text. When the caller needs a person, the call goes to a
Teams call queue with the topic and context already on the staff member's screen. It runs on
Teams Phone extensibility for the phone channel, with Azure Communication Services Call
Automation and the Azure AI Voice Live API.

The interesting part is not the model. It is the policy the server enforces around it: a gas
leak stops the conversation in code, nothing is filed until a verified location has been read
back and confirmed, answers come only from reviewed content, and office hours decide whether a
person can be reached.

## Package contents

- [`code/`](./code/) — runnable source implementation, presenter console, setup
  instructions, configuration example, presenter demo script, fictional city data and
  approved answers in English and Spanish, a script that prints the Teams Phone
  provisioning steps, and tests.
- [`SPEC.md`](./SPEC.md) — the agreed caller experience, architecture, Teams handoff
  contract, demo surface, acceptance criteria, and production gates.
- [`video/`](./video/) — recording, poster, caption, and transcript delivery scaffolding.
  No media binary is included yet.
- [`slides/`](./slides/) — the one-slide value proposition (PDF), generated from
  `template.json`. The editable deck and its preview image are not included yet.
- [`media/`](./media/) — gallery thumbnail and conceptual architecture illustration.
- [`template.json`](./template.json) — business and technical metadata, GitHub
  Pages-safe relative paths, and expected asset status.

## Run the implementation

It runs with no Azure subscription, for the fictional City of Contoso. A typed transcript
drives the same state machine a real call would; only the voice model and the audio path are
stubbed.

```bash
cd code
npm install
npm start          # http://127.0.0.1:8096
```

Open <http://127.0.0.1:8096> and press **→** to run the scripted demo one step at a time;
[`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md) is the running order and narration.

```bash
npm test           # no Azure and no network required
```

## Common flows to test

Start each flow with **Reset demo**, the clock on **Business hours** and the default caller
ID (Alex Chen). Click **Answer a call** and type into "What does the caller say?"; → separates
the caller's turns.

| Flow | Say or type | Expected behavior |
| --- | --- | --- |
| Pothole report | `Hi, there's a big pothole on Oak Avenue, right at the corner of Fifth Street.` → `Yes, that's right.` → `Yes, text me updates please.` | Reads the place back as Oak Avenue and 5th Street and files nothing until the caller confirms. Case SR-26-0193 goes to Public Works with a 5-business-day target, and the confirmation text appears on the simulated phone panel without being sent |
| Gas leak | `Hi, I smell gas in my kitchen and I'm not sure what to do.` | **Emergency rule fired**: leave the building, then call the gas utility at 555-0109 or dial 911. No questions and no case, and the call ends |
| Civic question | `When is trash pickup on Maple Street?` | Zone A, Tuesday, from approved content, ending with "Source: Sanitation service guide." |
| No approved answer | `What are the counter hours at City Hall?` → `Yes, please.` | The only matching article has expired, so the agent says it won't guess and offers 311 staff, then transfers to the 311 Live Agent Queue |
| Spanish caller | `Hola, necesito que recojan un colchón y un sofá viejo.` → `En el 1200 de Maple Street.` | Switches to Spanish (es-US): asks for the address, then books the pickup for Saturday, October 3 (*el sábado 3 de octubre*) with a case number |
| Travel-lane hazard | `There's a large pothole in the travel lane at Oak and 5th, cars are swerving around it.` → `Yes, that's right.` | A priority case with a 24-hour target, then a transfer to Public Works. On **After hours** there is no transfer: "Public Works will follow up on the next business day." Typed right after the pothole report, without a reset, it joins SR-26-0193 and raises that case to priority |
| Complaint | `I want to make a complaint. The trash trucks have skipped my street three weeks in a row and nobody has called me back.` → `I'd like to talk to a person, please.` | An apology with no promises and a choice of a report or a person, then the 311 Live Agent Queue. The Teams toast shows the complaint topic and "Caller sounds frustrated" |
| Human escape | `Can I talk to a person?`, or keypad **0** | Straight to the 311 Live Agent Queue. On **After hours**, the caller hears that 311 staff take calls weekdays from 7 a.m. to 7 p.m. and is not transferred |
| Unverified location | `There's a big pothole.` → `Maple and Pine.` → `Elm and Birch.` | "I couldn't verify that location…" and nothing is filed. The second place that can't be verified goes to 311 staff |

In simulation a keyword stand-in plays the voice model, so every run is the same. On a live
call the model words its own questions, while the emergency rule, the location read-back, the
content checks, office hours and the Teams handoff context come from the same server code.

For real calls, follow the setup and Teams Phone provisioning guidance in
[`code/README.md`](./code/README.md#connecting-it-to-a-real-phone-number). To present it, use
[`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md).

Do not commit `.env`, generated `data/`, logs, or `node_modules/`.
