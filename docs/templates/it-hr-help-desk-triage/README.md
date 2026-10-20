# IT / HR Help Desk Triage

This gallery package presents one internal help line for both IT and HR. The voice agent
works out which team an employee needs, answers routine questions only from approved IT
and HR articles, files and looks up tickets, and hands sensitive or unresolved issues to a
person, with the reason for the call traveling in the handoff and limited to what that
team should see. It runs on Teams Phone extensibility (the phone channel) with Azure
Communication Services Call Automation and the Azure AI Voice Live API.

The interesting part is not the model. It is the policy the demo proves: nothing personal
is read out before the caller is verified (by Teams sign-in, or by a one-time code when
caller ID is only a phone number), a sensitive HR matter gets no follow-up questions, stays
out of the transcript, and reaches HR labeled only "Confidential HR", and a request that
could be IT or HR gets one clarifying question instead of a guess.

## Package contents

- [`code/`](./code/) — runnable source implementation with its presenter console, setup
  instructions, configuration example, fixture data and approved articles, presenter demo
  script, Teams provisioning script, and tests.
- [`SPEC.md`](./SPEC.md) — the agreed caller journey, scope and privacy decisions,
  architecture, Teams handoff contract, and acceptance criteria.
- [`video/`](./video/) — recording, poster, caption, and transcript delivery scaffolding.
  No media binary is included yet.
- [`slides/`](./slides/) — the one-slide value proposition (PDF), generated from
  `template.json`. The editable deck and its preview image are not included yet.
- [`media/`](./media/) — gallery thumbnail and conceptual architecture illustration.
- [`template.json`](./template.json) — business and technical metadata, GitHub
  Pages-safe relative paths, and expected asset status.

## Run the implementation

It runs with no Azure subscription. A typed transcript drives the same state machine a
real call would; a scripted offline router stands in for the model, and one-time codes,
tickets, and transfers appear on screen instead of being sent.

```bash
cd code
npm install
npm start          # http://127.0.0.1:8098
```

Open <http://127.0.0.1:8098> and press **→** to run the scripted demo one step at a time;
[`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md) is the running order and narration.

```bash
npm test           # no Azure and no network required
```

## Common flows to test

In the console, pick the caller named in each row, choose **Business hours** on the demo
clock (again after **Reset demo**; one row uses **After hours**), press **Answer a call**,
and type each line; → separates the caller's turns. Every row is a new call.

| Flow | Say or type | Expected behavior |
| --- | --- | --- |
| Approved answer | **Sam Rivera · Teams**: `My VPN keeps disconnecting` | Answers from the approved VPN article and names it as the source; no ticket and no transfer |
| Ticket, confirmed first | **Sam Rivera · Teams**: `My laptop screen keeps flickering and I can't work` → `Yes, file it` | Reads the ticket back (laptop display, Sam's Surface Laptop, priority 2 because Sam is blocked) and files only after the yes: `INC-004821` on a fresh start or after **Reset demo**, with the ticket card in the employee's mock Teams chat |
| Ticket status | **Maria Lopez · Teams**: `What's happening with INC-004610?` → `What about INC-004700?` → `Outlook won't open for me either` | Won't read out `INC-004610` because it isn't Maria's, reads the Outlook major incident, then adds Maria to `INC-004700` instead of filing a duplicate |
| Phone caller verification | **Sam's mobile · phone call**: `What's happening with INC-004610?` → `sam.rivera@contoso.com` → `654321` → `123456` | Caller ID matches Sam, but it isn't trusted: the simulated code `123456` appears in the mock Teams chat, `654321` is refused, `123456` verifies Sam, and only then is the status read out |
| Code fallback | **Sam's mobile · phone call**: `What's happening with INC-004610?` → `sam.rivera@contoso.com` → `654321` → `111111` | After the second wrong code, nothing personal is shared and the call goes to the IT Service Desk marked "Couldn't verify caller" |
| Sensitive HR | **Sam Rivera · Teams**: `My manager keeps making comments about me and I don't know what to do` | Asks nothing more, shows `[private HR matter — not recorded]` in place of the words, and transfers to Confidential HR; the mock Teams toast and the headers carry no topic or summary beyond "Confidential HR" |
| Sensitive HR after hours | Choose **After hours**, then **Sam Rivera · Teams**: `My manager keeps making comments about me and I don't know what to do` → `yes` | The confidential HR line is closed, so the agent offers the ethics hotline or a next-business-day callback; `yes` files the callback request, which carries nothing the caller said |
| IT or HR? | **Maria Lopez · Teams**: `I can't get into the payroll system and my pay is wrong` → `It's my paycheck, the amount is wrong` | Asks one question, "Is this about a system account, or about your pay?", then transfers to Payroll |
| Ask for a person | **Maria Lopez · Teams**: `The printer on my floor keeps jamming` → `I already tried all that. Can I talk to someone?` (or press keypad **0** instead) | Transfers to the IT Service Desk; the mock Teams toast shows the topic and that printer troubleshooting was already tried |

On a live call the model words the replies and decides when to call each server tool;
classification, the identity check, ticket rules, the confidential HR guard, and support
hours are still enforced on the server.

For real calls, follow the setup and Teams Phone provisioning guidance in
[`code/README.md`](./code/README.md). To present it, use
[`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md).

Do not commit `.env`, generated `data/`, logs, or `node_modules/`.
