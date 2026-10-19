# Transcript — After-Hours Sales Lead Capture: full walkthrough

**Runtime:** 5:19 (319 seconds)

**Production disclosure:** Every voice in this film is synthetic, performed by Azure
OpenAI GPT Realtime through Azure AI Voice Live. Callers, companies and phone numbers are
fictional. The console footage is the template's own demo console running in simulation
mode; it is not a recording of a production deployment.

The walkthrough's subtitles are burned in. Timestamps are global (`mm:ss.mmm`) from the
start of the walkthrough.

| Timecode | Speaker | Line |
|---|---|---|
| 00:03.000 | Narrator | Sales teams go home. Buyers keep calling. |
| 00:06.640 | Narrator | After hours, a buyer with a big order usually reaches voicemail, and may call a competitor next. This agent picks up. |
| 00:20.880 | Narrator | Calls arrive on Contoso's sales number in Teams, through Teams Phone extensibility. |
| 00:26.040 | Narrator | After hours, Azure Communication Services Call Automation bridges the audio to Voice Live, where GPT Realtime takes the details. |
| 00:34.310 | Narrator | Your server scores the lead and decides what happens next: a page to the on-call rep in Teams, or the morning queue. |
| 00:43.604 | Narrator | 7:30 on a Wednesday evening, and Contoso's sales team has gone home. Your server checks the clock, so the agent takes the call. |
| 00:51.579 | Agent | Thanks for calling Contoso Industrial Supply. I'm an automated assistant. Our sales team isn't available right now, but I can take your details and have the right person call you back. What are you looking for today? |
| 01:05.795 | Dana | Hi, this is Dana Morgan from Northwind Traders. We need about 12,000 hex bolts by the end of the month. |
| 01:12.610 | Agent | Thanks, Dana. Hex bolts are in our industrial fasteners line, and 12,000 meets the 5,000 minimum order. Will you be the one signing off on this order? |
| 01:22.906 | Narrator | One sentence filled in most of the lead. The server scores each answer against your rules, in plain English. The model never sees the score. |
| 01:31.484 | Dana | Yes, I'm the purchasing manager, so it's my call. |
| 01:35.055 | Agent | I have your number as 425-555-0193. Is that the best number for a callback? |
| 01:43.670 | Narrator | A decision maker: eight of eight. But the server won't save the lead until Dana confirms the callback number. |
| 01:50.516 | Dana | Yes, that's the best number. |
| 01:52.945 | Agent | Thanks, Dana. Our sales team opens at 8 AM tomorrow, and someone will call you within an hour of opening. |
| 02:00.750 | Narrator | Saved. The server picked the owner and the deadline, and queued the follow-up for Teams and email. Nobody was paged: hot isn't urgent. |
| 02:11.215 | Narrator | Same server, 10:30 that morning. Only the clock has changed. |
| 02:17.627 | Narrator | Sales is open, so the server sends the call straight to the sales queue in Teams. No agent, no questions, and caller ID flagged as not verified. |
| 02:28.876 | Narrator | Back to 7:30 in the evening. Ben Ortiz is on call until 9, and your policy decides when he's worth interrupting. |
| 02:36.862 | Sam | This is Sam Rivera, operations director at Tailwind Traders. Our packaging line is down and we need 2,000 cartons by tomorrow morning. Can I talk to someone tonight? |
| 02:47.208 | Agent | Thanks, Sam. Cartons are in our packaging supplies line, and 2,000 meets the 1,000 minimum order. I'll check who's available as soon as I've confirmed your details. I have your number as 425-555-0162. Is that the best number for a callback? |
| 03:03.994 | Narrator | Sam asked for a person, but the model can't promise one. It only notes the request, and the server judges urgency from Sam's own words. |
| 03:13.097 | Narrator | When Sam confirms the number, the server decides whether to page. Watch the Teams panel. |
| 03:19.576 | Sam | Yes, that's my cell. |
| 03:21.600 | Agent | Thanks, Sam. I'm paging our on-call sales rep now, so please stay on the line. |
| 03:30.165 | Narrator | Ben picks up already knowing the score, the urgency and why he was paged. That context travels with the call in VoIP headers. |
| 03:38.830 | Narrator | Hot and urgent, inside on-call cover: that's your server's rule for a page, and the reason is written into the lead's follow-up. |
| 03:48.437 | Narrator | The same kind of call at 10:30 at night: a conveyor line is down, and Robin Diaz needs lock nuts first thing. But on-call cover ended at 9. |
| 03:59.220 | Robin | Yes, that's the right number. |
| 04:01.399 | Agent | There's no one on call right now, so I can't put you through to a person. Thanks, Robin. Our sales team opens at 8 AM tomorrow, and someone will call you within an hour of opening. |
| 04:12.852 | Narrator | Hot and urgent, but outside on-call cover, so no page. The server tells the agent what it can promise, and writes the reason into the follow-up. |
| 04:23.424 | Narrator | Every call is counted in the lead store: leads captured, qualified and routed, live transfers, and pages answered. |
| 04:32.513 | Narrator | Under the hood, the model holds the conversation and fills in the lead. It never sees the score, and it can't promise a person. |
| 04:40.613 | Narrator | Your server checks the hours, scores the lead, insists on a confirmed number, picks the owner and decides whether to page. Every decision lands in the trail. |
| 04:52.373 | Narrator | Making it yours is mostly configuration: sales hours and on-call cover, the scoring rules, your catalog's minimum orders, and your reps. |
| 05:00.533 | Narrator | The spec, the tests and this demo script give your coding agent the context for the rest. |
| 05:08.913 | Narrator | After-hours sales lead capture. Run it in simulation in two minutes, then connect it to your own Teams number. |
