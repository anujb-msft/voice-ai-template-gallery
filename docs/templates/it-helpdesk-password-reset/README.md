# IT Help Desk Password Reset

This gallery package presents an outbound voice agent that calls an employee back after
they select **Forgot password?**. The phone conversation and browser-based reset wizard
stay synchronized while the employee completes identity verification and sets a new
password without speaking it aloud. Completed resets deflect routine service-desk tickets.

## Package contents

- [`code/`](./code/) — runnable source implementation, setup instructions, configuration
  example, demo script, and knowledge base.
- [`video/`](./video/) — recording, poster, caption, and transcript delivery scaffolding.
  No media binary is included yet.
- [`slides/`](./slides/) — presentation delivery scaffolding. No presentation binary is
  included yet.
- [`media/`](./media/) — gallery thumbnail and conceptual architecture illustration.

## Run the implementation

Follow the full setup and configuration guidance in [`code/README.md`](./code/README.md).
From the `code` directory, install dependencies, copy `.env.example` to `.env`, configure
the required services, seed the demo data, and start the app:

```bash
cd code
npm ci
cp .env.example .env
npm run seed
npm start
```

Do not commit `.env`, generated `data/`, logs, or `node_modules/`.
