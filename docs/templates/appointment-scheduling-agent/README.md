# Appointment Scheduling Agent

This gallery package presents an inbound voice agent for a clinic's scheduling line. It
confirms who the patient is from their name and date of birth, asks what the visit is
for, offers two times that fit the visit type, the provider and the caller's preferred
time of day, holds the one the caller picks and reads it back, and books it when the
caller says yes. When a person is needed, it hands the call to the right Teams queue with
the topic and what has already been checked attached. It answers on Teams Phone
extensibility, the phone channel, with Azure Communication Services Call Automation for
call control and the Azure AI Voice Live API for the conversation.

The interesting part is not the model. It is that the model can't book: the server checks
identity and eligibility itself, writes only when the caller says yes to the one time just
read back, and if that time is taken in the meantime, refuses the write and asks for a
fresh pick and a fresh yes instead of booking a different time.

## Package contents

- [`code/`](./code/) — runnable source implementation, setup instructions, configuration
  example, presenter demo script, Teams provisioning script, tests, and an `AGENTS.md`
  for coding agents.
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

It runs with no Azure subscription. A typed transcript drives the same server-side flow a
real call would, on a fictional clinic's seeded schedule; only the model, the audio path
and the Teams transfer are simulated.

```bash
cd code
npm install
npm start          # http://127.0.0.1:8100
```

Open <http://127.0.0.1:8100> and press **→** to run the scripted demo one step at a time;
[`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md) is the running order and narration.

```bash
npm test           # no Azure and no network required
```

## Common flows to test

In the console, pick a **Caller ID**, click **Answer a call**, and type each line. Each
row starts from **Reset demo** on the default **Tue 9:50 AM** demo clock unless it says
otherwise.

| Flow | Say or type | Expected behavior |
| --- | --- | --- |
| Book | As **Jordan Rivera**: `Jordan Rivera, 03/12/1984` → `I've had a cough for a week and I'd like to see my usual doctor, mornings if possible.` → `The first one.` → `Yes, please.` | Verifies Jordan, offers two morning times with Dr. Patel, holds and reads back the first, and books it only on the yes, with a confirmation number; all four checks pass |
| Book with no time offered | As **Mia Chen**: `Mia Chen, 02/18/1991` → `Just book me whatever you have.` | Refuses: nothing is booked until she has heard a specific time and said yes to it, and the refused write is counted |
| Model tries to book | As **Mia Chen**: `Mia Chen, 02/18/1991` → `A follow-up with Dr. Patel.`, then click **Model calls “book”** | The model has no booking tool: the tool call is refused (`model_cannot_book`), nothing is written, and the agent repeats the two times |
| Time taken mid-call | As **Avery Stone**: `Avery Stone, 06/09/1979` → `A follow-up with Dr. Patel, please.` → `The first one.`, click **Front desk books it**, then `Yes, book it.` → `The first one.` → `Yes.` | The yes to the taken time is refused (`slot_taken`) and nothing is written; two fresh times are offered, and only a fresh pick and a fresh yes book |
| Referral required | As **Jordan Rivera**: `Jordan Rivera, 03/12/1984` → `I'd like a skin check for a mole.` → `Connect me with the referral coordinator.` | Offers no dermatology times because no referral is on file, then transfers to the referral coordinator with the topic `Scheduling – referral needed` and `REFERRAL_REQUIRED` in the call context |
| Identity not confirmed | As **Jordan Rivera**: `Jordan Rivera, 03/21/1984` → `Jordan Rivera, 12/03/1984` | Asks once more, then says it can't discuss appointments and transfers to the scheduling team marked `verified: no`; nothing about appointments is disclosed |
| Human escape | `Can I talk to a person?` at any point, or keypad **0** | Goes straight to the scheduling team; a time on hold travels in the call context as `heldSlot` |
| After hours | Click **Fri 6:30 PM** (`fri-evening`) on the demo clock, then as **Jordan Rivera**: `Can I talk to a person?` | The team is closed, so a callback request is filed for his number; from **Unknown number**, the caller is told to call back at 206-555-0100 during business hours |
| Safety words | `I have chest pain.` | Scheduling stops: it says to hang up and call 911 if this is an emergency, then transfers to the nurse line. On **Fri 6:30 PM** it gives the after-hours nurse line, 206-555-0199, instead |

On a live call the model words each reply and decides when to call its tools, so the
wording and the times it searches for can vary; the identity check, eligibility, the hold
and every write are decided by the server the same way. The
[`code/README.md` quick start](./code/README.md#quick-start) has more flows, including
rescheduling and cancelling.

For real calls, follow the setup and Teams Phone provisioning guidance in
[`code/README.md`](./code/README.md). To present it, use
[`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md).

Do not commit `.env`, generated `data/`, logs, or `node_modules/`.
