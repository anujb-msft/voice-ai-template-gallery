# After-Hours Sales Lead Capture

This gallery package presents an inbound voice agent for the hours when the sales team
isn't there. In sales hours it stays out of the way and sends the caller straight to the
sales queue in Teams. After hours it says up front that it's an automated assistant,
qualifies the caller — what they need, how many, by when, and whether they make the
buying decision — reads the callback number back, and saves a scored lead with an owner,
a callback deadline and a follow-up message for the morning. It runs on Teams Phone
extensibility for the phone channel, with Azure Communication Services Call Automation
and the Azure AI Voice Live API.

The interesting part is not the conversation. It is the policy around it: the server's
clock decides whether the assistant answers at all, the callback number is read back so
the caller can correct it, and a written on-call policy decides whether a hot lead is
worth paging someone tonight — and shows its reason.

## Package contents

- [`code/`](./code/) — runnable source implementation, setup instructions, configuration
  example, presenter demo script, Teams Phone provisioning checklist script, and tests.
- [`SPEC.md`](./SPEC.md) — the agreed caller journey, architecture, qualification and
  follow-up policy, Teams handoff contract, and acceptance criteria.
- [`video/`](./video/) — recording, poster, caption, and transcript delivery scaffolding.
  No media binary is included yet.
- [`slides/`](./slides/) — the one-slide value proposition (PDF), generated from
  `template.json`. The editable deck and its preview image are not included yet.
- [`media/`](./media/) — gallery thumbnail and conceptual architecture illustration.
- [`template.json`](./template.json) — business and technical metadata, GitHub
  Pages-safe relative paths, and expected asset status.

## Run the implementation

It runs with no Azure subscription. A typed conversation drives the same state machine a
real call would — only the agent and the audio path are stubbed.

```bash
cd code
npm install
npm start          # http://127.0.0.1:8093
```

Open <http://127.0.0.1:8093> and press **→** to run the scripted demo one step at a time;
[`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md) is the running order and narration.

```bash
npm test           # no Azure and no network required
```

## Common flows to test

Press **Reset demo** before each flow, so a repeat call from the same number isn't merged
into an earlier lead. Then pick the demo clock preset and the **Caller ID** shown, press
**Answer a call**, and type each line in turn.

| Flow | Say or type | Expected behavior |
| --- | --- | --- |
| After-hours capture | **After hours**, Dana Morgan: `Hi, this is Dana Morgan from Northwind Traders. We need about 12,000 hex bolts by the end of the month.` → `Yes, I'm the purchasing manager, so it's my call.` → `Yes, that's the best number.` | Says it's automated and reads the number back, then saves a hot lead (8 of 8, each point explained in the lead panel) for Ava Chen to call back within an hour of opening, with the sales manager @-mentioned. Not paged: nothing needs a person tonight |
| In sales hours | **Business hours**, Pat Kim: press **Answer a call** | Transfers straight to the sales queue with the call's context in VoIP headers. The assistant never speaks, and no lead is captured |
| Read-back correction | **After hours**, Casey Quinn: `Hi, this is Casey Quinn with Fabrikam. We're looking at about 200 brass fittings next quarter.` → `Not me, I'm the maintenance engineer. I recommend what we buy.` → `No, that's the front desk. Please use my mobile, 425-555-0147.` → `Yes, that's right.` | Reads the new number back too, and saves only the confirmed 425-555-0147 on a warm lead (4 of 8) due by the next business day |
| Price question | **After hours**, Pat Kim: `How much do 5,000 hex bolts cost?` | "I can't quote that, but I'll note it so your rep can give you an exact answer." The question is noted for the rep, and qualifying carries on |
| Not a sales call | **After hours**, Lee Park: `Hi, I'm calling about an existing order. It was supposed to arrive today and it hasn't.` Or Pat Kim: `Hi, are you hiring? I'd like to apply for a job.` | Gives the support number and its hours, or points to the careers page. No lead is created |
| Human escape | **After hours**, Sam Rivera: `This is Sam Rivera, operations director at Tailwind Traders. Our packaging line is down and we need 2,000 cartons by tomorrow morning. Can I talk to someone tonight?` → `Yes, that's my cell.` Or Dana Morgan: press keypad `0`, then her three lines above | Confirms the number first and saves the lead, then pages Ben Ortiz, the on-call rep, in Teams and hands the call over with the reason he was paged |
| Page not answered | **After hours**, Sam Rivera: his two lines above, then **Simulate no answer** while Ben is paged | "I'm sorry, our on-call rep didn't pick up." The lead stays saved for a callback within an hour of opening |
| After on-call cover ends | **Late night**, Robin Diaz: `Hi, this is Robin Diaz, maintenance supervisor at Wide World Importers. Our conveyor line is down and we need 6,000 lock nuts first thing tomorrow. Is anyone there tonight?` → `Yes, that's the right number.` | Says honestly that no one is on call, and saves the hot lead to the morning queue with the reason it wasn't paged |
| Silence | **After hours**, Pat Kim: press **Silence** three times | Two prompts to try again, then goodbye. A partial lead is saved from the caller ID, marked as not read back. With **Unknown number**, no lead is saved |

On a live call the model does the talking, so the wording varies; the sales hours, the
score, the owner, the deadline and the paging decision still come from the server. See
the [`code/README.md` live call matrix](./code/README.md#live-call-test-matrix) for setup
details and test-environment caveats.

For real calls, follow the setup and Teams Phone provisioning guidance in
[`code/README.md`](./code/README.md). To present it, use
[`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md).

Do not commit `.env`, generated `data/`, logs, or `node_modules/`.
