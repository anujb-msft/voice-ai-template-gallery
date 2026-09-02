# Demo Script — 6 Beats, ~6 Minutes

A rehearsable running order for the intent-based call routing agent. Every beat runs in
**simulation mode**, so no Azure subscription, phone number or Teams tenant is needed —
and nothing can go wrong on stage because of a network.

The argument you are making is *not* "a model can classify a sentence". Everyone believes
that already. It is: **the interesting part is what happens when it is unsure, when the
caller changes their mind, and when the human on the other end picks up.**

---

## Before you start

```bash
npm install
TRANSFER_DELAY_MS=6000 npm start   # http://127.0.0.1:8091
curl -s 127.0.0.1:8091/health      # expect "mode": "simulation"
```

The default mind-change window is 1.2 seconds, which is right for a real caller who only
has to *speak*, and much too short for a presenter who has to *type*. Widen it to six
seconds for the demo and say so out loud in beat 5 — the fact that it is one environment
variable is itself part of the point.

- [ ] Browser at `http://127.0.0.1:8091`, window wide enough to show all four panels
- [ ] **Calling number** set to `+1 425 555 0101` (Dana Whitfield, Northwind Traders)
- [ ] Decision trail scrolled to the top
- [ ] Rehearse beat 5 once — it is the only one with a timing element

Utterances to have ready (copy these exactly; the offline classifier is keyword-based):

| Beat | Type this |
| --- | --- |
| 2 | `I was charged twice on my invoice` → `yes please` |
| 3 | `I was charged for a renewal I did not order` |
| 4 | `can I just talk to a person` |
| 5 | `I was charged twice on my invoice` → *immediately* `no wait, the portal is down` |
| 6 | `2` |

---

## 1 — The problem with the thing we all already have *(~45s)*

Don't touch anything yet. Point at the empty console.

> "Every company has this. You call the main line, and a recording reads you a menu you
> have to translate your problem into. Press 1 for sales. Press 2 for support. Except
> your problem isn't a number — it's a sentence.
>
> So people mash zero. And when they finally reach a human, that human says: 'so what's
> this about?' The caller explains it for the second time. Sometimes the third."

Click **Answer a call**.

The agent greets Dana by name and asks one open question. Let the audience read it.

> "One question. No menu. And notice the first line — it says it's an automated
> assistant. That isn't decoration. In a growing number of jurisdictions it's the law,
> and everywhere else it's just the decent thing to do."

---

## 2 — The confident path *(~60s)*

Type: `I was charged twice on my invoice`

Point at the **Routing decision** panel. The confidence meter lands on **0.95** with the
gate drawn at **0.75**.

> "It's proposing Billing at 0.95. But look at where that decision is being made."

This is the most important sentence in the demo:

> "The model didn't route this call. The model *proposed* an id from a list of four, and
> a number. My server compared that number to a threshold I set, checked whether Billing
> was open, and decided. The model can't dial. There is no tool it can call that accepts
> a phone number — so a prompt injection can't turn this into toll fraud."

The agent confirms out loud rather than transferring silently. Type: `yes please`

The state chip goes **transferring**, then **transferred**.

Move to **What the Teams agent sees**. The mock Teams toast shows the topic and the
summary, and below it are the literal VoIP headers on the wire.

> "That's what the agent picks up to. Topic, summary, the caller's record. Nobody has to
> say 'so what's this about?' — the whole point.
>
> And look at that one: `verified: false`. We matched the number to a directory, and we
> pass the match along marked unverified, because caller ID is not authentication. If
> that flag isn't in the payload, someone downstream will eventually treat a spoofed
> number as identity."

---

## 3 — The unsure path *(~60s)*

**This is the beat that separates a demo from a product.** Click **Answer a call** again.

Type: `I was charged for a renewal I did not order`

> "Is that Billing, or is that Sales? Honestly — it's both. Somebody was charged, and it
> was for a renewal."

Confidence lands at **0.6**. The gate is at 0.75. The agent asks a clarifying question
instead of picking.

> "Most demos hide this case, because a wrong confident answer looks better on stage than
> an honest question. But a wrong confident route is the expensive failure: now the caller
> is in the wrong queue, waited nine minutes, and has to start over.
>
> This is one number in a config file. Raise it and the agent asks more and misroutes
> less. Lower it and the reverse. That's a business decision — so it lives where the
> business can change it, not inside a prompt."

Now type: `the charge on my card is wrong`

It clears the gate, offers Billing, and the trail shows the clarification that got it
there.

---

## 4 — "Just get me a person" *(~40s)*

Click **Answer a call**. Type: `can I just talk to a person`

Straight to Reception. No confirmation, no retry, no "let me just try one more thing".

> "That's the number one complaint about every system like this — it won't let you out.
>
> So there's no gate on that path at all. It doesn't have to clear a confidence
> threshold. The agent doesn't get a chance to talk you out of it. Ask for a human, get
> a human."

Point at the decision trail: `human_requested → explicit_request`.

> "And it's logged as an explicit request, not as a failure — because it isn't one.
> If that line starts showing up on a third of your calls, that's the signal to go read
> those transcripts."

---

## 5 — The mind change *(~60s)*

The one that needs rehearsing. Click **Answer a call**.

Type: `I was charged twice on my invoice`, then `yes please`.

The state chip goes **transferring**. **Now type quickly:** `no wait, the portal is down`

The pending transfer is cancelled and the agent re-opens with Support.

> "Between 'connecting you now' and the actual connection there's a window — I've widened
> it to six seconds so I can type; in production it's about a second, because a real
> caller only has to speak. People change their mind in exactly that gap. They remember
> the thing they actually called about.
>
> If you commit the instant the caller says yes, that correction lands on a confused human
> in the wrong department. The gap costs you a second and saves you a transfer."

If the timing gets away from you, say so — *"and if you miss the window, the transfer
goes through, which is exactly what should happen"* — and move on. It recovers fine.

---

## 6 — Everything else fails toward a person *(~45s)*

Click **Answer a call**, then press **2** on the keypad.

> "The keypad still works. It's always live — we just don't announce it up front, because
> announcing it is how you end up back at the menu we were trying to delete. It only gets
> offered out loud after speech has failed twice."

Then, without starting a new call, walk the list on the **Where calls can go** panel and
close on the failure paths:

> "Two unclear turns — a person. Ninety seconds elapsed without a decision — a person.
> A question the agent has no route for — a person. The transfer itself fails — retry
> once, then the fallback queue, then a person.
>
> There is no path through this state machine that loops. Every dead end is a human, and
> every one of them is written down in that trail with the reason."

Click **Refresh metrics**.

> "Median seconds to route, clarification rate, how often callers asked for a human. Those
> are the three numbers that tell you whether this is working — and they come out of the
> same audit trail, not a separate analytics pipeline."

---

## If someone asks

**"Is this actually running Azure?"**
Not right now — it's in simulation mode, which is why it can't fail on stage. Set three
environment variables and the identical state machine runs against Voice Live for speech
and ACS Call Automation for the call. The classifier and the audio path are the only
stubs; everything you just watched decide is the real code.

**"How is the context actually delivered?"**
VoIP custom headers on the transfer. Not SIP — SIP headers are a PSTN-side mechanism and
never reach a Teams identifier, so the call would connect and the agent would still answer
blind. That distinction is the single most common way this gets built wrong.

**"What about sentiment?"**
It's in the payload, but only when the caller *said* they were unhappy. We don't infer it
from tone of voice. Inferring emotion from audio and then routing on it is a decision you
should make deliberately, with your legal team, not by accident because the API offered it.

**"How long to add a fifth department?"**
One JSON object — an id, a description, a Teams object ID and opening hours. The menu the
model sees is generated from that file, so there's no prompt to rewrite and no code to
touch.

**"Where does this break?"**
Accents and background noise degrade the transcript before they degrade the routing, so
your confidence threshold is doing more work than it looks like. And the directory lookup
is caller-ID-based, which is worth almost nothing on a spoofed call — hence
`verified: false` everywhere it appears.
