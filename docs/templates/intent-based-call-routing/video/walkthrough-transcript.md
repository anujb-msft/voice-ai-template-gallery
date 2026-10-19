# Transcript — Intent-Based Call Routing: full walkthrough

**Runtime:** 6:17 (378 seconds)

**Production disclosure:** Every voice in this film is synthetic, performed by Azure
OpenAI GPT Realtime through Azure AI Voice Live. Callers, companies and phone numbers are
fictional. The console footage is the template's own demo console running in simulation
mode; it is not a recording of a production deployment.

The walkthrough's subtitles are burned in. Timestamps are global (`mm:ss.mmm`) from the
start of the walkthrough.

| Timecode | Speaker | Line |
|---|---|---|
| 00:03.000 | Narrator | Every call to a main line starts with a reason. |
| 00:07.230 | Narrator | A phone menu makes the caller translate that reason into a number. This agent just asks. |
| 00:20.430 | Narrator | Calls arrive on a Teams phone number, through Teams Phone extensibility. |
| 00:24.890 | Narrator | Azure Communication Services Call Automation bridges the audio to Voice Live, where GPT Realtime holds the conversation. |
| 00:33.070 | Narrator | Your server decides where the call goes, and Teams receives it with context. |
| 00:39.734 | Narrator | Dana calls Contoso's main line. There's no menu. She just says what she needs. |
| 00:45.189 | Agent | Hi Dana, you've reached Contoso — I'm the automated assistant. What can I help you with today? |
| 00:52.053 | Dana | I was charged twice on my invoice |
| 00:54.937 | Agent | It sounds like Billing is the right team for that — shall I put you through? |
| 00:59.621 | Narrator | The model proposes Billing, with a confidence score. The server, not the model, checks it against the gate. |
| 01:07.573 | Narrator | Even above the gate, the agent confirms before it transfers. Watch the Teams panel. |
| 01:13.215 | Dana | yes please |
| 01:14.942 | Agent | Connecting you now to Billing. |
| 01:18.252 | Narrator | Billing's Teams client rings with the reason for the call and who's calling, flagged as unverified. That context travels in the call's VoIP headers. |
| 01:28.738 | Narrator | Some requests really are ambiguous. Priya was charged for a renewal she didn't order. Is that Sales, or Billing? |
| 01:37.131 | Agent | Hi Priya, you've reached Contoso — I'm the automated assistant. What can I help you with today? |
| 01:43.913 | Priya | I was charged for a renewal I did not order |
| 01:47.335 | Agent | Sorry, I want to make sure I get you to the right place. Could you tell me a bit more about what you need? |
| 01:53.860 | Narrator | Sales scored 0.6, under the 0.75 gate. So instead of guessing, the agent asks one question. |
| 02:02.535 | Priya | the charge on my card is wrong |
| 02:05.142 | Agent | It sounds like Billing is the right team for that — shall I put you through? |
| 02:09.808 | Priya | yes |
| 02:11.619 | Agent | Connecting you now to Billing. |
| 02:14.921 | Narrator | A wrong transfer costs far more than one clarifying question. And the gate is a number in config, not a line in a prompt. |
| 02:24.368 | Narrator | The quickest way to lose a caller is to make them argue with a bot. |
| 02:28.978 | Agent | Thanks for calling Contoso — I'm the automated assistant. What can I help you with today? |
| 02:35.097 | Caller | can I just talk to a person |
| 02:37.530 | Agent | Connecting you now to Reception. |
| 02:40.764 | Narrator | Asking for a person goes straight to Reception. No gate, and no “are you sure?” |
| 02:47.920 | Narrator | Callers change their minds. Marcus has a question about his invoice. |
| 02:54.734 | Agent | Hi Marcus, you've reached Contoso — I'm the automated assistant. What can I help you with today? |
| 03:01.313 | Marcus | I have a question about my invoice |
| 03:04.195 | Agent | It sounds like Billing is the right team for that — shall I put you through? |
| 03:08.892 | Narrator | Watch the bar under the gauge. The transfer waits about a second before it dispatches, and Marcus is about to change his mind. |
| 03:16.477 | Marcus | yes please |
| 03:18.726 | Agent | Connecting you now to Billing. |
| 03:21.018 | Marcus | no wait, the portal is down |
| 03:23.512 | Agent | It sounds like Support is the right team for that — shall I put you through? |
| 03:28.286 | Narrator | The transfer to Billing was cancelled before it left, and Support is offered instead. |
| 03:33.621 | Marcus | yes |
| 03:34.544 | Agent | Connecting you now to Support. |
| 03:37.578 | Narrator | Cancelled inside the window, re-proposed, and re-confirmed. The trail shows billing, then support. |
| 03:46.141 | Narrator | Same server, 7:30 in the evening. Billing keeps office hours. |
| 03:51.268 | Agent | Hi Dana, you've reached Contoso — I'm the automated assistant. What can I help you with today? |
| 03:58.110 | Dana | I have a question about my invoice |
| 04:00.670 | Agent | It sounds like Billing is the right team for that — shall I put you through? |
| 04:05.351 | Narrator | Billing is still the right team, but it's closed. The server checks the hours, and Billing's after-hours rule is to take a message. |
| 04:13.645 | Dana | yes |
| 04:14.486 | Agent | Billing is closed at the moment. I can take a short message and make sure it reaches them — what would you like me to pass on? |
| 04:21.832 | Dana | please call me back about the duplicate charge |
| 04:24.585 | Agent | Thanks — I've passed that on to Billing, and they'll see it when they're back. Goodbye for now. |
| 04:30.362 | Narrator | No transfer into an empty queue. The message waits in the audit log, with its topic, for Billing in the morning. |
| 04:38.588 | Narrator | And when speech doesn't work at all, a bad line, a noisy room, the keypad is always there. |
| 04:45.705 | Agent | Thanks for calling Contoso — I'm the automated assistant. What can I help you with today? |
| 04:51.854 | Agent | Sorry, I want to make sure I get you to the right place. Could you tell me a bit more about what you need? |
| 04:58.363 | Agent | Sorry — I want to get this right. Could you tell me a bit more? Or use the keypad: 1 for Sales, 2 for Support, 3 for Billing, 4 for Reception. |
| 05:10.504 | Narrator | A keypress is unambiguous, so it routes without asking again. |
| 05:15.242 | Agent | Connecting you now to Support. |
| 05:18.271 | Narrator | And every call is audited: transfers, clarifying questions, people requested, and how long it took to route. |
| 05:27.963 | Narrator | Under the hood, the model's only power is to propose a route from a fixed list. |
| 05:33.223 | Narrator | The server applies the confidence gate, the office hours, and the confirmation. Then Call Automation transfers the call to the Teams queue, with its context. |
| 05:42.613 | Narrator | Every failure path ends with a person, never a loop. |
| 05:48.533 | Narrator | Making it yours is mostly configuration. Your teams, how they're described, their hours and after-hours rules all live in routes.json, and the gate is one environment variable. |
| 06:00.123 | Narrator | The spec, the tests and this demo script give your coding agent the context to change the rest. |
| 06:08.203 | Narrator | Intent-based call routing. Run it in simulation in two minutes, then connect it to your own Teams number. |
