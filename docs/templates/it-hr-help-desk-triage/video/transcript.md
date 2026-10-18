# Transcript — IT / HR Help Desk Triage

**Runtime:** 5:57 (358 seconds)

**Production disclosure:** Every voice in this film is synthetic, performed by Azure
OpenAI GPT Realtime through Azure AI Voice Live. Callers, companies and phone numbers are
fictional. The console footage is the template's own demo console running in simulation
mode; it is not a recording of a production deployment.

This transcript matches [`captions.vtt`](./captions.vtt), which splits long lines into
shorter cues. Timestamps are global (`mm:ss.mmm`) from the start of the film.

| Timecode | Speaker | Line |
|---|---|---|
| 00:03.000 | Narrator | On a typical help line, employees guess whether a problem belongs to IT, HR or payroll, and often wait in the wrong queue. |
| 00:10.410 | Narrator | Some problems are too personal for a phone menu. Here, employees just say what's wrong. |
| 00:22.370 | Narrator | Employees call the help line from Teams, or from any phone, through Teams Phone extensibility. |
| 00:28.540 | Narrator | Azure Communication Services Call Automation bridges the audio to Voice Live, where GPT Realtime holds the conversation. |
| 00:36.720 | Narrator | Your server decides who's calling, what they may hear, and which Teams queue takes the call. |
| 00:44.202 | Narrator | Sam Rivera calls the help line from Teams. Teams sign-in already says who's calling, so there are no security questions. |
| 00:52.143 | Agent | Hi Sam, this is the Contoso IT and HR help line. I'm an automated assistant. Heads up: we know Outlook is down right now and the team is on it. What can I help you with? |
| 01:04.173 | Sam | My VPN keeps disconnecting |
| 01:06.826 | Agent | From the IT VPN guide: restart GlobalProtect, confirm you are on a trusted network, then choose Refresh connection. If it still disconnects, open a Network/VPN ticket. |
| 01:18.852 | Narrator | That's the approved VPN article, word for word. Answers come from your knowledge base, not from the model's memory. |
| 01:26.481 | Sam | My laptop screen keeps flickering and I can't work |
| 01:29.910 | Agent | Here's the ticket: Laptop display, on your Surface Laptop ending in 4471. You're blocked, so that's priority 2. Should I file it? |
| 01:39.328 | Narrator | Your server drafted that ticket. Sam can't work, so the matrix says P2, and the laptop comes from the directory, not from Sam. |
| 01:48.023 | Sam | Yes, file it |
| 01:49.781 | Agent | Your ticket is INC-004821 — that's I-N-C, 0-0-4-8-2-1. I'll send it to you in Teams chat. Anything else I can help with? |
| 02:02.169 | Narrator | One call, two outcomes: an approved answer, and a ticket filed only on a clear yes. |
| 02:10.281 | Narrator | Now Sam calls from a mobile phone. Caller ID is easy to fake, so even a matching number is only a hint. |
| 02:18.143 | Sam | What's happening with INC-004610? |
| 02:22.557 | Agent | I can help with that once I've confirmed who you are. What's your work email? I'll send a one-time code to your Teams chat. |
| 02:31.075 | Sam | sam.rivera@contoso.com |
| 02:34.805 | Agent | I sent a six-digit code to your Teams chat. Please read it back to me. |
| 02:40.321 | Narrator | Your server made a one-time code for this call. In simulation nothing is sent: it appears in this mock Teams chat. |
| 02:47.756 | Sam | 654321 |
| 02:50.793 | Agent | That code didn't match. Please read the six digits again. |
| 02:55.525 | Narrator | Refused. One more miss, and Sam goes to a person who can verify another way. |
| 03:01.044 | Sam | 123456 |
| 03:03.442 | Agent | Thanks, Sam — you're verified. |
| 03:06.114 | Agent | INC-004610, "Printer on 4th floor jams", is in progress. Latest update: Field services ordered a replacement tray. |
| 03:18.024 | Narrator | Only then is the ticket read out. The code works once, and never reaches the audit log or a console watching a real call. |
| 03:27.843 | Narrator | Some calls need a person straight away, with as little on record as possible. Watch what the agent doesn't do. |
| 03:34.694 | Sam | My manager keeps making comments about me and I don't know what to do |
| 03:39.390 | Agent | That is something our HR team should handle directly. I will connect you to a confidential HR line. |
| 03:46.582 | Narrator | Your server's guard ran first, before any classifier or tool. No questions, no ticket, and the transcript keeps only a placeholder. |
| 03:56.376 | Narrator | The person who picks up sees “Confidential HR”. No topic, no summary, no notes, in the Teams toast or the headers. |
| 04:05.867 | Narrator | Last call of the day, and it's an urgent one. A security incident can't wait in a queue. |
| 04:12.620 | Sam | I think I clicked a phishing link |
| 04:14.799 | Agent | Here's the ticket: Phishing click, on your Surface Laptop ending in 4471. It's a security incident, so that's priority 1. Should I file it? |
| 04:25.339 | Narrator | Security incidents are P1 by rule, in your server's priority matrix. The model never sets a priority. |
| 04:33.349 | Sam | Yes |
| 04:34.214 | Agent | Your ticket is INC-004822 — that's I-N-C, 0-0-4-8-2-2. I'll send it to you in Teams chat. |
| 04:44.677 | Agent | This is urgent, so I'm connecting you to IT on-call now. Don't enter any passwords in the meantime. |
| 04:51.931 | Narrator | IT on-call sees the P1, the ticket number and Sam's laptop before picking up. |
| 04:59.885 | Narrator | Every outcome is counted. Private HR calls show as “fewer than five” until there are enough that nobody can be singled out. |
| 05:08.680 | Narrator | Under the hood, the model converses and proposes. It never sets a priority, and it can't send anyone to a private queue. |
| 05:16.490 | Narrator | Your server decides: the guard runs first, identity and confidence are gated, the matrix sets priority, and each queue gets only its allowed fields. |
| 05:27.490 | Narrator | Making it yours is mostly configuration: your topics and approved articles, your Teams queues and hours, your sensitive phrases and priority rules. |
| 05:36.670 | Narrator | Delivering the one-time code is left as a stub. Your coding agent wires it to Teams chat, with the spec and tests as guardrails. |
| 05:47.270 | Narrator | IT and HR help desk triage. Run it in simulation in two minutes, then connect it to your own Teams number. |
