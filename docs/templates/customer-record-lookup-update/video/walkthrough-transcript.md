# Transcript — Customer Record Lookup & Update: full walkthrough

**Runtime:** 5:45 (345 seconds)

**Production disclosure:** Every voice in this film is synthetic, performed by Azure
OpenAI GPT Realtime through Azure AI Voice Live. Callers, companies and phone numbers are
fictional. The console footage is the template's own demo console running in simulation
mode; it is not a recording of a production deployment.

The walkthrough's subtitles are burned in. Timestamps are global (`mm:ss.mmm`) from the
start of the walkthrough.

| Timecode | Speaker | Line |
|---|---|---|
| 00:03.000 | Narrator | Field reps live between meetings, and the CRM lives on a laptop. |
| 00:08.100 | Narrator | So the briefing gets skipped, and the notes wait until tonight. Alex just calls the record desk. |
| 00:20.010 | Narrator | Reps call the record desk straight from Teams, or dial its Teams number from their mobile, through Teams Phone extensibility. |
| 00:27.160 | Narrator | Azure Communication Services Call Automation bridges the audio to Voice Live, where GPT Realtime holds the conversation. |
| 00:35.340 | Narrator | Your server verifies the rep, reads and writes the CRM, and passes what it can't change to Sales Operations in Teams. |
| 00:44.592 | Narrator | Alex is on his way to see Fabrikam, and calls the record desk from his mobile. |
| 00:49.960 | Agent | This is the Contoso sales assistant, an automated agent. Please enter your six-digit Contoso sales PIN. |
| 00:58.021 | Narrator | Caller ID matches his registered mobile, but that's only a hint. Nothing opens until your server checks his PIN against a stored hash. |
| 01:06.710 | Agent | Thanks, Alex, you're verified. Which account? |
| 01:11.247 | Alex | Brief me on Fabrikam |
| 01:13.047 | Agent | Fabrikam, Strategic tier, your account. Last touch was a call on May 2 about pilot rollout. 3 open deals: enterprise renewal at about 250 thousand, in Negotiation, closing June 30, renewal services add-on at about 42 thousand, in Proposal, closing July 10, and analytics expansion at about 80 thousand, in Proposal, closing August 18. One task is due today: send the security questionnaire. Your contact is Dana Ruiz, VP of Operations. |
| 01:47.148 | Narrator | Your server wrote that briefing, from accounts Alex owns or works on. Phone numbers stay off it until he asks. |
| 01:54.523 | Alex | What's Dana's number? |
| 01:56.238 | Agent | Dana Ruiz's number is 206 555 0120. |
| 02:04.201 | Narrator | Straight after the meeting, Alex calls back from Teams. His Teams sign-in verifies him, so there's no PIN. |
| 02:11.467 | Agent | Hi Alex, I'm the Contoso sales assistant, an automated agent. Which account? |
| 02:17.931 | Alex | Log the Fabrikam meeting. Dana agreed to the renewal at 240k, moving to Closed Won pending signature, close date June 15th. Remind me to send the contract Friday. |
| 02:28.470 | Agent | Here's what I have for Fabrikam. A meeting activity with Dana Ruiz, today. Enterprise renewal: stage from Negotiation to Closed Won, amount from 250 thousand to 240 thousand, close date from June 30 to June 15, and next step from Security questionnaire to Pending signature. A task for you to send the contract, due Friday, June 12. Save it? |
| 02:51.586 | Narrator | The model only passed Alex's words along. Your server picked out each field, checked it against your allow-list, and wrote that read-back. |
| 02:59.686 | Narrator | A bare yes wouldn't count. Even after “yes, save it”, your server holds the write for six seconds, and “wait” still stops it. |
| 03:08.394 | Alex | Yes, save it. |
| 03:09.842 | Agent | Saving in six seconds. Say "wait" to stop it. |
| 03:14.847 | Agent | Saved to Fabrikam's record. |
| 03:18.253 | Narrator | Nobody objected, so your server wrote it all in one commit, an audit row per field. “Undo that” would still reverse it. |
| 03:27.632 | Narrator | Now Alex asks for changes only Sales Operations may make. What a call can change is set by your server, not the prompt. |
| 03:36.257 | Alex | Raise Fabrikam's credit limit to 500k and move them to net 60 payment terms. |
| 03:41.324 | Agent | The credit limit and the payment terms aren't on the list of things I can change by phone, so nothing was written. Contoso Sales Operations can change them. Want me to put you through with the details? |
| 03:52.064 | Narrator | Your server refused both fields, whatever the model made of them. And your routing config decides who picks up. |
| 03:58.998 | Alex | Yes, put me through. |
| 04:00.417 | Agent | Putting you through to Contoso Sales Operations with the details. |
| 04:05.568 | Narrator | Sales Operations' Teams queue rings, with the account, the request and the refusal in the VoIP headers. No PIN, no phone numbers. |
| 04:16.338 | Narrator | Last call: someone has Alex's phone, but not his PIN. |
| 04:21.089 | Agent | This is the Contoso sales assistant, an automated agent. Please enter your six-digit Contoso sales PIN. |
| 04:29.151 | Agent | I couldn't verify you, so I can't open any records. I'll put you through to Contoso Sales Operations. |
| 04:36.574 | Narrator | No second try, and no record opened. Sales Operations gets only the failed check and the number's last four digits. |
| 04:46.281 | Narrator | These numbers come straight from the audit log. The model talked; your server decided who was verified, what was read out and what was written. |
| 04:56.137 | Narrator | The model holds the conversation and passes the rep's words to server tools. Fields, record IDs and transfer targets come from your server. |
| 05:05.267 | Narrator | Your server verifies the caller, scopes every record, checks each field against the allow-list, holds the undo window, and writes the audit rows. |
| 05:15.947 | Narrator | Making it yours is mostly configuration: the fields a call may change, your reps, and who answers for Sales Operations. |
| 05:23.737 | Narrator | Your CRM plugs in behind one adapter. The spec, the tests and this demo script give your coding agent the rest. |
| 05:33.707 | Narrator | Customer record lookup and update. Run it in simulation in two minutes, then connect your own Teams number and CRM. |
