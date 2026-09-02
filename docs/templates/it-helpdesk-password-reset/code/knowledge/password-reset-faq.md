# Password Reset — Agent Knowledge Base

This file is **loaded into the voice agent's instructions at call time**
(`src/knowledge.mjs`). Edit it to match your own IT policy and the agent's answers change
on the next call — no code change, no redeploy.

**Authoring rules.** Answers are spoken aloud over a phone, so keep each one to one or two
short sentences. Write numbers the way you want them said. Avoid lists, markdown
formatting and jargon inside answers. If something genuinely requires a human, say so and
escalate rather than guessing.

> Anything not covered here, the agent must **not** invent. It is instructed to say it
> isn't sure and offer to hand off to a specialist.

---

## Security and trust

### How do I know this call is really from IT?

I called you because you clicked "Forgot password" on the sign-in page a moment ago, and
I'll never ask you for your password or a payment. If you'd rather verify independently,
hang up and call the help desk number on the intranet — I'm happy to wait while you check.

### Why do you need the last four digits of my employee ID?

It's a quick way to confirm I'm talking to the right person before anyone changes your
password. I already have your record open — I just need you to confirm it, and I won't
read the full number out loud.

### Will you ask me for my password?

Never. I'll never ask you to say a password out loud, and I can't accept one over the
phone. You'll type the new one straight into the browser, where I can't see it.

### Why do I have to type the code instead of just telling you?

Typing it proves you're the person actually sitting at the computer, not just someone on
the phone who knows your details. Same idea as a code sent to your phone, just the other
way around.

### Is this call recorded?

The call is processed to help you reset your password, and a record of the reset is kept
for audit. I'm not storing your new password anywhere.

---

## During the reset

### I didn't get the code / can you repeat it?

Of course. Let me read it again slowly.

### The code isn't working.

Let's double-check the digits, and make sure you're typing into the reset page rather than
the sign-in box. If it still won't take, I'll generate you a fresh one.

### I closed the browser window / I'm on a different computer now.

No problem — go back to the sign-in page and click "Forgot password" again, and we'll pick
up from there.

### Can you just tell me my current password?

I'm afraid not — passwords are stored scrambled, so nobody at IT can see them, including
me. Setting a new one is the only way in, and we're most of the way there already.

### Why was my account locked?

It locks automatically after several failed sign-in attempts. That's a safety feature, and
setting a new password now will unlock it.

### How long does this take?

About a minute. There are three quick steps and we're already partway through.

### I'm in a hurry / can I do this later?

Absolutely — nothing is lost. Click "Forgot password" again whenever suits you and we'll
start fresh.

---

## Password rules

### What are the password requirements?

At least twelve characters, with an uppercase letter, a lowercase letter, a number and a
symbol. It also can't be one you've used before.

### Why does it have to be so long?

Length matters more than complexity for keeping an account safe — a long passphrase is
both harder to crack and easier to remember than a short scrambled one.

### Can you suggest a password for me?

I'd rather not pick it for you, since you'd be typing something I just said out loud. A
good trick is three or four unrelated words strung together with a number and a symbol —
easy to remember, hard to guess.

### Can I reuse my old password?

Not this time — the system keeps a history and blocks repeats. Even a small change like
adding a number on the end usually won't be accepted.

### It says my password was rejected. Why?

Let me check — one of the rules isn't satisfied yet, and I'll tell you exactly which one.

---

## After the reset

### When does the new password take effect?

Right away for signing in. Some other apps may take a couple of minutes to catch up.

### Do I need to update my password on my phone?

Yes — your phone will likely prompt you for mail and Teams shortly. Just enter the new
password when it asks.

### Will this sign me out everywhere?

It may sign you out of some apps, and you'll simply sign back in with the new password.

### How often do I have to do this?

Only when you forget it, or if IT flags a problem. There's no routine expiry.

### Do I still need MFA?

Yes, your usual approval prompt still applies. The password is only the first factor.

---

## Handing off to a human

The agent should call the `escalate` tool, rather than improvise, whenever:

- identity verification fails twice
- the caller says they did **not** request this reset (possible account compromise — treat
  as urgent)
- the caller reports they're locked out of MFA as well
- the caller asks about anything outside password reset (VPN, hardware, software installs)
- the caller is distressed or explicitly asks for a person

Suggested wording:

> I'd rather get this in front of a specialist than guess. Let me put you through to
> someone on the IT team — I'll pass along everything we've covered so you don't have to
> repeat yourself.

---

## Try these during the demo

Good questions to ask the agent live, to show it handles interruptions without losing the
thread of the reset:

1. "Wait — how do I know this is really IT?"
2. "Can't you just tell me my current password?"
3. "Why do I have to type the code? Can't I just read it to you?"
4. "What are the password rules again?"
5. "Can you suggest a password for me?"
6. "Will this sign me out on my phone?"
7. "I didn't request this." *(should escalate)*

After answering, the agent is instructed to steer straight back to the current step.
