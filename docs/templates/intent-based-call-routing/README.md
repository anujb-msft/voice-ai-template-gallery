# Intent-Based Call Routing

This gallery package presents an inbound voice agent that answers the main line, asks the
caller one open question, and connects them to the right team — with the topic, a summary
and the caller's record already on the receiving agent's screen. It runs on Azure
Communication Services Call Automation, the Azure AI Voice Live API, and Teams Phone
extensibility.

The interesting part is not the classification. It is the confidence gate, the mind-change
window, and the fact that every failure path ends with a person rather than a loop.

## Package contents

- [`code/`](./code/) — runnable source implementation, setup instructions, configuration
  example, presenter demo script, Teams provisioning script, and tests.
- [`SPEC.md`](./SPEC.md) — the agreed caller journey, architecture, routing policy,
  Teams handoff contract, and acceptance criteria.
- [`video/`](./video/) — recording, poster, caption, and transcript delivery scaffolding.
  No media binary is included yet.
- [`slides/`](./slides/) — presentation delivery scaffolding. No presentation binary is
  included yet.
- [`media/`](./media/) — gallery thumbnail and conceptual architecture illustration.
- [`template.json`](./template.json) — business and technical metadata, GitHub
  Pages-safe relative paths, and expected asset status.

## Run the implementation

It runs with no Azure subscription. A typed transcript drives the same state machine a
real call would — only the classifier and the audio path are stubbed.

```bash
cd code
npm install
npm start          # http://127.0.0.1:8091
```

```bash
npm test           # 63 cases, no Azure and no network required
```

## Common flows to test

| Flow | Say or type | Expected behavior |
| --- | --- | --- |
| Billing | `I was charged twice on my credit card` → `yes` | Offers Billing, waits for confirmation, then transfers |
| Support | `The customer portal is down and shows an error` → `yes` | Offers Support, then transfers after confirmation |
| Sales | `I need pricing for about 100 seats` → `yes` | Offers Sales, then transfers after confirmation |
| Human escape | `Can I just speak to a person?` | Goes directly to Reception without another question or confirmation |
| Ambiguous intent | `I was charged for a renewal I didn't order` | Clarifies rather than guessing when confidence falls below the `0.75` gate |
| Mind change | Confirm Billing, then immediately interrupt with `No, wait — the portal is down` | Cancels the pending transfer and reclassifies to Support |
| Keypad | Press or type `1`, `2`, `3`, or `4` | Commits Sales, Support, Billing, or Reception without spoken confirmation |
| Out of scope | `What are your store hours?` | Declines to invent an answer; a second unrelated question falls back to Reception |
| Language switch | On a live call, say `Please continue in French` | Switches explicitly; a new call still starts in the configured `LOCALE` |
| Transfer recovery | Confirm a route whose Teams target is unavailable | Retries once, tries Reception, then gives an honest apology instead of leaving silence |

Live confidence scores can vary because the model proposes them; the server-side gate
and every resulting state transition are deterministic. See the
[`code/README.md` live call matrix](./code/README.md#live-call-test-matrix) for setup
details and test-environment caveats.

For real calls, follow the setup and Teams Phone provisioning guidance in
[`code/README.md`](./code/README.md). To present it, use
[`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md).

Do not commit `.env`, generated `data/`, logs, or `node_modules/`.
