# Transcript — Appointment Reminder Agent

**Runtime:** 5:27 (327 seconds)

**Production disclosure:** Every voice in this film is synthetic, performed by Azure
OpenAI GPT Realtime through Azure AI Voice Live. Callers, companies and phone numbers are
fictional. The console footage is the template's own demo console running in simulation
mode; it is not a recording of a production deployment.

This transcript matches [`captions.vtt`](./captions.vtt), which splits long lines into
shorter cues. Timestamps are global (`mm:ss.mmm`) from the start of the film.

| Timecode | Speaker | Line |
|---|---|---|
| 00:03.000 | Narrator | Two days before a visit, Contoso Health calls each patient with a reminder. |
| 00:08.180 | Narrator | A recording reads the visit to whoever picks up, and any change means calling back. This agent checks it's Jordan first, then settles it on the call. |
| 00:23.230 | Narrator | Your server decides who to call, and when. Then Azure Communication Services Call Automation dials from the clinic's number. |
| 00:31.270 | Narrator | Voice Live, with GPT Realtime, holds the conversation, while your reminder policy decides what may be said and what may change. |
| 00:39.560 | Narrator | New times go to the scheduling desk in Teams, with context. Patients who call back on the clinic's Teams Phone number reach the same agent. |
| 00:50.282 | Narrator | Ten in the morning, two days before Jordan's imaging visit. Before dialing, the server checks consent, calling hours and the reminder window. |
| 01:00.455 | Jordan | Hello? |
| 01:01.285 | Agent | Hi, this is Contoso Health's automated assistant, calling with an appointment reminder. Am I speaking with Jordan? |
| 01:10.053 | Jordan | Yes, this is Jordan. |
| 01:12.102 | Agent | Thanks, Jordan. To protect your privacy, please tell me your date of birth. |
| 01:17.907 | Narrator | A name is a claim, not proof. Until the date of birth matches a record the model never sees, every appointment tool stays blocked. |
| 01:27.164 | Jordan | March 12th, 1984. |
| 01:29.977 | Agent | You have an imaging appointment with Dr. Lee on Thursday, May 21 at 9:30 AM, at the Northgate clinic. Will you be able to make it? |
| 01:40.632 | Narrator | It matched, so only now does the visit come up. Only an explicit yes confirms it, and the server writes that to the schedule. |
| 01:49.058 | Jordan | Yes, I'll be there. |
| 01:50.972 | Agent | You're confirmed. Please do not eat or drink anything except water for 8 hours before your appointment, and arrive 15 minutes early. We'll see you then. Goodbye. |
| 02:03.046 | Narrator | The prep instructions come from config, not the model. And the trail shows the order: identity verified, details shared, then confirmed. |
| 02:13.218 | Narrator | Every missed visit is a slot another patient could have had. Avery Stone can't make this one. |
| 02:19.782 | Avery | I need to cancel. |
| 02:21.322 | Agent | I can cancel your primary care appointment on Thursday, May 21 at 10:15 AM. Should I cancel it? |
| 02:29.784 | Narrator | That's a proposal, not a cancellation. It's read back, and the schedule stays as it was until Avery gives a clear yes. |
| 02:37.936 | Avery | Yes, please cancel it. |
| 02:40.289 | Agent | Your appointment is cancelled, and the time is now open for another patient. To book a new visit, call us at 206-555-0100. Goodbye. |
| 02:53.666 | Narrator | Dr. Patel's ten-fifteen is open again, with two days left to fill it. |
| 03:00.154 | Narrator | Riley wants a different time. The agent has no tool that can book one. That's a job for a person. |
| 03:07.168 | Narrator | Because Riley is verified, the server may hand the call to a person at the scheduling desk, in Teams. |
| 03:14.062 | Riley | Can I come next week instead? |
| 03:15.972 | Agent | I'll connect you with our scheduling team to find a new time. Your current appointment stays booked until you choose a new one. Please hold. |
| 03:25.059 | Narrator | Before anyone picks up, the scheduler sees who's calling and why. That context rides in VoIP headers, with a single-use patient reference: no date of birth, no phone number. |
| 03:38.158 | Narrator | Anyone in the house can play back a voicemail. This is the third and last try to reach Camila. |
| 03:44.520 | Narrator | Call Automation has no answering-machine detection, so the server judges the greeting itself: its words, its length, a beep. |
| 03:52.956 | Camila's voicemail | Hi, you've reached Camila. Please leave a message after the tone. |
| 03:56.849 | Agent | This is Contoso Health calling for Camila with an appointment reminder. Please call us back at 602-555-0100. Thank you. |
| 04:07.652 | Narrator | A first name and a callback number, nothing about the visit. Earlier tries hang up without a message. |
| 04:15.624 | Narrator | Now it's eight-thirty in the evening, and Noah Martin is still due a reminder. |
| 04:22.984 | Narrator | The server checks calling hours in Noah's own time zone. Too late, so nothing is dialed, and the model never hears about it. |
| 04:32.281 | Narrator | Every call is audited, even the ones never placed, and the same log feeds these numbers. |
| 04:39.637 | Narrator | A date of birth is a knowledge check, not strong authentication. So it grants very little: one appointment's details, and a confirm or a cancel after a clear yes. |
| 04:50.247 | Narrator | And the model cannot dial, transfer or book. Phone numbers, Teams IDs and times all come from your server. |
| 04:59.807 | Narrator | Making it yours starts in config: the reminder window, calling hours, every line the server says, and each clinic's callback number. |
| 05:07.947 | Narrator | Then point the desk at your Teams user, and have your coding agent connect your own scheduling system. |
| 05:16.307 | Narrator | Appointment Reminder Agent. Run it in simulation in two minutes, then connect your clinic's number and your Teams scheduling desk. |
