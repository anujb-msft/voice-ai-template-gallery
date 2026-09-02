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
npm test           # 58 cases, no Azure and no network required
```

For real calls, follow the setup and Teams Phone provisioning guidance in
[`code/README.md`](./code/README.md). To present it, use
[`code/DEMO-SCRIPT.md`](./code/DEMO-SCRIPT.md).

Do not commit `.env`, generated `data/`, logs, or `node_modules/`.
