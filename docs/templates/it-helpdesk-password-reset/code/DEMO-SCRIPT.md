# Demo Script — 5 Steps, ~4 Minutes

Rehearsable running order for the IT help desk password reset agent.
Deflection figures quoted below assume **$25** per human-handled reset
(`HELPDESK_TICKET_COST_USD`). They are tracked server-side and exposed at `/api/stats` —
deliberately not shown in the employee UI, so the page stays believable.

---

## Before you start

```bash
npm start                      # http://localhost:8090
curl -s localhost:8090/health  # expect "callReady": true
```

- [ ] `/health` shows `callReady: true`, `voiceModel: gpt-realtime`,
      `telephonyMode: teams-phone`, and no missing call configuration
- [ ] The Teams resource account has its service number, outbound PSTN connectivity,
      ACS server consent, and current licensing
- [ ] Dev tunnel is up and reachable
- [ ] Browser open at `http://localhost:8090`, sign-in page showing
- [ ] **Phone in hand, off silent, speaker on** — the audience needs to hear both sides
- [ ] **Agent activity** panel open, **transcript** collapsed (open it only in step 5)

Have ready: username `alex.morgan` (pre-filled), employee ID last four **4217**, and a new
password that satisfies the policy, e.g. `Harbor-Lantern-42!`

---

## 1 — Frame the problem *(~30s)*

Optional cold open: type any password and hit **Sign in**. The seeded account is locked,
and the lock is checked first, so you always get the genuine error — "your account is
locked after too many failed sign-in attempts." That sets up the scenario far better than
narrating it, and needs nothing memorised. There are no demo hints on the page, so it
reads as a real corporate login.

Then, before clicking anything else:

> "Password resets remain a common source of avoidable IT help desk work.
> Every one of them can become a ticket, a queue, and lost employee time.
>
> Here's the thing — the user already told us they had a problem. They clicked the link.
> So why are we making them wait in a queue?"

**Point at the "Forgot password?" link.** That's the setup for everything that follows.

---

## 2 — Trigger the callback *(~20s)*

Click **Forgot password?**

> "No ticket. No queue. The agent is calling *me*."

The wizard moves to **Calling you now**. Hold the phone up as it rings — the gap between
the click and the ring is the whole pitch, so let it land rather than talking over it.
For the recorded TPE version, briefly show that the incoming caller ID is the Teams
service number, but mask enough digits that the production number is not disclosed.

Answer on speaker. The agent greets you by name and asks for the last four of your
employee ID.

---

## 3 — Verify, and prove it's two channels *(~45s)*

Say: **"four two one seven."**

The wizard advances to **verification code** on screen as the agent confirms on the phone.
Call it out:

> "Notice the browser moved at the same moment. The phone call and the web session are the
> same transaction, in lockstep."

The agent reads a six-digit code aloud. **Type it into the browser.**

> "This is something a phone tree fundamentally cannot do. The code is spoken on the
> phone and typed on the machine — that proves I'm the person actually sitting at the
> computer, not just someone who knows my details."

---

## 4 — Interrupt it *(~60s — key interaction)*

Before typing the new password, **cut the agent off mid-sentence** with:

> **"Wait — can you just tell me my current password?"**

It stops instantly (barge-in), explains passwords are stored hashed so nobody at IT can
see them, and steers straight back to the step. Then ask one more:

> **"Can you suggest a password for me?"**

It declines — sensibly, since you'd be typing something it just said out loud — and offers
the passphrase trick instead.

> "That's not a script. Those answers come from a markdown file the IT team owns — they
> edit it, and the agent changes on the next call. And it always comes back to the task."

Now type a *deliberately weak* password first, like `password`. The policy checks update
live and **the agent coaches you on the phone about the specific rule you missed** —
because the browser is streaming policy results into the live session.

Then type the real one. Done.

---

## 5 — Land the economics *(~45s)*

The wizard shows **Password updated**, and the ticket auto-closes as deflected.

Say it plainly — the number is not on screen, and it shouldn't be:

> "That ticket just closed itself as deflected. It never reached a human. At the
> illustrative handling cost configured for this demo, avoided work adds up quickly —
> and the employee was back to work without waiting in a help desk queue."

If you want the figures visible while recording, keep `/api/stats` open on a second
screen. Never put them in the employee's view.

Point at the **agent activity** panel, which filled in as the call progressed:

> "That's every action the agent took. It never touched the database or the directory — it
> could only ask our server to do one of four things, and each one is logged whether it
> was accepted or rejected. The model decides *when*, never *whether*."

Then expand the **transcript** if the room wants proof the conversation was live:

> "And here's the whole exchange, verbatim."

Close on the customization seam:

> "Today this is SQLite. The directory and ticketing layers are pluggable — swap in Entra
> ID or Okta, ServiceNow or Jira, and the flow stays the same."

---

## If something goes wrong

| Problem | Do this |
|---|---|
| Phone doesn't ring | Check the dev tunnel is up; `tail -f /tmp/helpdesk.log` for the ACS event. Keep talking — the wizard still demos. |
| Agent mishears the digits | Just say them again slowly, separated: "four… two… one… seven." It retries once before escalating. |
| Call drops mid-demo | A **Call me again** banner appears — it redials and resumes the same step. |
| No phone available | The demo runs in simulation mode with no ACS config — the wizard and metrics still work. |

**Reset between runs:** click **Back to sign in**, or for a clean slate
`rm data/helpdesk.db && npm run seed`.

---

## The three things they should remember

1. **Proactive, not reactive.** The agent calls you the moment you signal a problem.
2. **Voice plus screen, one session.** That combination is what makes the security work.
3. **The hard logic stays on your server.** The model decides *when*, never *whether*.
