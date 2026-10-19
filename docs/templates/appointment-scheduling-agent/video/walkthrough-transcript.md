# Transcript — Appointment Scheduling Agent: full walkthrough

**Runtime:** 5:32 (333 seconds)

**Production disclosure:** Every voice in this film is synthetic, performed by Azure
OpenAI GPT Realtime through Azure AI Voice Live. Callers, companies and phone numbers are
fictional. The console footage is the template's own demo console running in simulation
mode; it is not a recording of a production deployment.

The walkthrough's subtitles are burned in. Timestamps are global (`mm:ss.mmm`) from the
start of the walkthrough.

| Timecode | Speaker | Line |
|---|---|---|
| 00:03.000 | Narrator | Jordan Rivera has had a cough for a week. He wants to see his usual doctor, and soon. |
| 00:08.560 | Narrator | Too often, that means a phone menu, a queue, and a callback later. This agent books it on the call. |
| 00:21.830 | Narrator | Patients call the clinic's Teams Phone number. |
| 00:24.660 | Narrator | Azure Communication Services Call Automation answers and bridges the audio to Voice Live, where GPT Realtime holds the conversation. |
| 00:33.320 | Narrator | Your scheduling policy decides what's bookable and writes only on the caller's yes. Otherwise, a person in a Teams call queue takes over. |
| 00:43.744 | Narrator | Tuesday morning. Jordan calls Contoso Health about a cough. The model can find him a time, but only the server can book it. |
| 00:51.775 | Agent | Thanks for calling Contoso Health. I'm an automated scheduling assistant. To get started, what's the patient's full name and date of birth? |
| 01:02.535 | Jordan | Jordan Rivera, 03/12/1984 |
| 01:07.601 | Agent | Thanks, Jordan. What kind of visit do you need, and what's it for? |
| 01:12.606 | Narrator | Four checks stand between this call and the schedule. Identity is first: a name and date of birth that match, never caller ID. |
| 01:21.099 | Jordan | I've had a cough for a week and I'd like to see my usual doctor, mornings if possible. |
| 01:27.431 | Agent | Dr. Patel has today at 11 a.m., or Thursday, May 21st, at 8:30 a.m. Would either of those work? |
| 01:36.319 | Jordan | The first one. |
| 01:37.722 | Agent | To confirm: a new-problem visit with Dr. Patel on Tuesday, May 19th, at 11 a.m., at the Northgate clinic. Shall I book it? |
| 01:48.439 | Narrator | That time is now held for five minutes and read back: the active proposal, P1. Only Jordan's own yes can write it. |
| 01:57.396 | Jordan | Yes, please. |
| 01:59.394 | Agent | You're booked with Dr. Patel today at 11 a.m., at the Northgate clinic. Please arrive 15 minutes early and bring a list of your medications. Your confirmation number is A-2-0-4-4-0. Thanks for calling Contoso Health. |
| 02:15.961 | Narrator | Four green checks, and the server wrote the booking. The model never called a booking tool. It doesn't have one. |
| 02:24.531 | Narrator | Two people, one time. Avery Stone is on the phone; the front desk is at a keyboard. |
| 02:31.513 | Avery | A follow-up with Dr. Patel, please. |
| 02:34.157 | Agent | Dr. Patel has today at 11:30 a.m., or tomorrow at 1 p.m. Would either of those work? |
| 02:41.816 | Avery | The first one. |
| 02:42.919 | Agent | To confirm: a follow-up visit with Dr. Patel on Tuesday, May 19th, at 11:30 a.m., at the Northgate clinic. Shall I book it? |
| 02:53.737 | Narrator | Before Avery can say yes, the front desk books that same time. Watch its cell in the grid. |
| 03:01.930 | Avery | Yes, book it. |
| 03:03.593 | Agent | Sorry, that time was just taken, so I haven't booked anything. Dr. Patel still has today at 11:45 a.m., or tomorrow at 1 p.m. Would either of those work? |
| 03:15.457 | Narrator | The server refused the write and voided P1. It never moves a yes onto another time. |
| 03:21.611 | Avery | The first one. |
| 03:22.719 | Agent | To confirm: a follow-up visit with Dr. Patel on Tuesday, May 19th, at 11:45 a.m., at the Northgate clinic. Shall I book it? |
| 03:32.714 | Avery | Yes. |
| 03:33.730 | Agent | You're booked with Dr. Patel today at 11:45 a.m., at the Northgate clinic. Please arrive 15 minutes early. Your confirmation number is A-2-0-4-4-2. Thanks for calling Contoso Health. |
| 03:49.846 | Narrator | Booked after a race: a fresh pick and a fresh yes. No double booking, and no silent swap. |
| 03:58.324 | Narrator | Jordan calls back about a mole. Whether that's bookable by voice is a config rule, not the model's judgment. |
| 04:05.276 | Jordan | I'd like a skin check for a mole. |
| 04:07.916 | Agent | Dermatology visits need a referral from your primary care provider, and I don't see an active one on file. I can book you a visit with Dr. Patel, your primary care doctor, or connect you with our referral coordinator. Which would you prefer? |
| 04:22.384 | Narrator | Eligibility is red on the referral rule, so the server offers no times. There's nothing to say yes to. |
| 04:28.899 | Jordan | Connect me with the referral coordinator. |
| 04:31.462 | Agent | I'm connecting you with our referral coordinator now. |
| 04:35.555 | Narrator | The coordinator's Teams client rings with the topic and what's already checked, so Jordan won't start over. |
| 04:42.349 | Narrator | The VoIP headers carry only the fields this queue may see. Jordan's date of birth isn't one. |
| 04:49.350 | Narrator | The model can verify a caller, search the schedule and hold a time. Booking, moving and cancelling aren't its tools. |
| 04:57.390 | Narrator | One code path writes to the schedule, and only on the caller's own yes to the time just read back. |
| 05:05.290 | Narrator | Making it yours starts in config: visit types, eligibility rules, providers and their hours, and the Teams queues for each handoff. |
| 05:13.460 | Narrator | Then have your coding agent connect your own scheduling system, behind the same adapter. |
| 05:20.700 | Narrator | Appointment Scheduling Agent. Run it in simulation with no Azure subscription, then connect your Teams Phone number and your scheduling queues. |
