# General Inquiry Agent

This gallery package presents an inbound voice agent for the City of Contoso information
line. A caller asks about services, policies, locations, hours, or eligibility and gets a
short answer from approved content, with its source named. When the line shouldn't
answer, the agent says what it can't confirm and offers a person, who sees what was
already asked — or, after hours, gives the next opening time. Calls arrive
on the phone channel through Teams Phone extensibility, and the agent runs on Azure
Communication Services Call Automation and the Azure AI Voice Live API.

The interesting part is not the answer. It is the freshness gate that keeps out-of-date
content from ever reaching the model, the server's clock deciding what is open, and the
fact that eligibility is always left to staff.

## Package contents

- [`code/`](./code/) — runnable source implementation, presenter console, approved-content
  fixtures, setup instructions, configuration example, presenter demo script, Teams
  provisioning script, smoke test, and tests.
- [`SPEC.md`](./SPEC.md) — the agreed caller journey, architecture, grounding, freshness
  and citation policy, Teams handoff contract, and acceptance criteria.
- [`video/`](./video/) — recording, poster, caption, and transcript delivery scaffolding.
  No media binary is included yet.
- [`slides/`](./slides/) — the one-slide value proposition (PDF), generated from
  `template.json`. The editable deck and its preview image are not included yet.
- [`media/`](./media/) — gallery thumbnail and conceptual architecture illustration.
- [`template.json`](./template.json) — business and technical metadata, GitHub
  Pages-safe relative paths, and expected asset status.

## Run the implementation

It runs with no Azure subscription. A typed line drives the same state machine, content
index, freshness policy, and staffed hours a real call would — only the model, the audio
path, and the transfer are stubbed.

```bash
cd code
npm install
npm start          # http://127.0.0.1:8092
```

Open <http://127.0.0.1:8092> and press **→** to run the scripted demo one step at a time;
[`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md) is the running order and narration.

```bash
npm test           # no Azure and no network required
```

## Common flows to test

For each flow, click **Answer a call** in the console and type the lines in order. The
demo clock decides both freshness and opening hours, so click **Business hours** in the
console's top bar first; the after-hours row needs **After hours** instead. The scripted
demo sets the clock itself.

| Flow | Say or type | Expected behavior |
| --- | --- | --- |
| Grounded answer | `What are City Hall's hours?` → `Where did that come from?` | Reads the counter hours, says City Hall is open right now until 5 p.m., and names the source, then gives the short URL. The console shows the content id, owner, and review date |
| Due for review | `Can the city pick up an old sofa?` | Answers from the bulky-item article, then adds that it was due for review in July and to check contoso.gov/bulky or ask staff |
| Out of date | `Do I need a permit for a yard sale?` → `Yes, please.` | Doesn't read the expired article out: says it can't confirm the current rules and offers a person, then transfers; the Teams context notes what was withheld |
| Eligibility | `I'm 67 — do I qualify for the senior utility discount?` → `Yes, please.` | Gives the published criteria and says staff make the final decision, then transfers; the Teams context masks the age |
| Human escape | `Can I talk to a person?`, or press `0` | Goes straight to the Contoso information desk, with no question or confirmation first |
| After hours | With **After hours** set: `What are City Hall's hours?` → `Can I talk to a person?` | Says City Hall is closed right now and opens again Thursday at 8 a.m.; asked for a person, it doesn't transfer, but gives the next opening time and the desk's hours and ends the call |
| Out of scope | `Can you recommend a good pizza place?` → `No, thanks.` | Says it has no approved information and won't guess, offers a person, then asks if there is anything else |
| Service request | `I want to report a pothole on Elm Street.` → `Yes, please.` | Says this line can't file service requests and offers a person; the transfer's topic is the caller's own words |
| No input | Click **Silence**, then **Silence** again | A reprompt that mentions pressing 0 for a person, then a transfer to the desk |

On a live call the model words the answers itself, so the sentences vary; which article
is used, whether it may be read out, whether City Hall or the desk is open, and where the
call goes are still decided on the server. The console's metrics update as each call
ends — answered and grounded, with a caveat, refused as out of date, handed to a person,
closed after hours — and **Reset demo** clears them and puts the clock back where it
started. See the [`code/README.md` live call matrix](./code/README.md#live-call-test-matrix)
for what to try on a real number.

For real calls, follow the setup and Teams Phone provisioning guidance in
[`code/README.md`](./code/README.md). To present it, use
[`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md).

Do not commit `.env`, generated `data/`, logs, or `node_modules/`.
