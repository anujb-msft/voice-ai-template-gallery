# Transcript — Bid / Price Lookup Agent: full walkthrough

**Runtime:** 5:06 (307 seconds)

**Production disclosure:** Every voice in this film is synthetic, performed by Azure
OpenAI GPT Realtime through Azure AI Voice Live. Callers, companies and phone numbers are
fictional. The console footage is the template's own demo console running in simulation
mode; it is not a recording of a production deployment.

The walkthrough's subtitles are burned in. Timestamps are global (`mm:ss.mmm`) from the
start of the walkthrough.

| Timecode | Speaker | Line |
|---|---|---|
| 00:03.000 | Narrator | A grain co-op's bid line is usually a recording, made once in the morning, while prices move all day. |
| 00:09.370 | Narrator | Growers press through a menu for a number that may already be stale. This agent just answers. |
| 00:22.050 | Narrator | Growers call a Teams phone number, through Teams Phone extensibility. |
| 00:26.410 | Narrator | Azure Communication Services Call Automation bridges the audio to Voice Live, where GPT Realtime holds the conversation. |
| 00:34.590 | Narrator | Your server prices every quote. To sell or lock a price, the merchandiser takes the call in Teams. |
| 00:43.411 | Narrator | Dale Meyer sells grain at the co-op's Riverside elevator. He calls for today's corn bid. |
| 00:49.886 | Agent | Contoso Grain Co-op bid line. I'm an automated assistant. Bids are subject to change without notice. Confirm with the merchandiser before selling. Which commodity and location? |
| 01:02.373 | Dale | What's corn paying at Riverside? |
| 01:04.998 | Agent | Corn at Riverside for November delivery is $4.12, that's 35 under December futures, as of 10:42 AM. Anything else? |
| 01:15.239 | Narrator | Every word of that quote was written by your server. The agent only read it. |
| 01:20.370 | Dale | And beans? |
| 01:21.882 | Agent | Soybeans at Riverside for November delivery are $10.11, that's 18 under November futures, as of 10:41 AM. Anything else? |
| 01:32.804 | Dale | That's all, thanks. |
| 01:35.057 | Agent | Thanks for calling Contoso Grain Co-op. Goodbye. |
| 01:39.596 | Narrator | The model never sees a raw bid, basis or futures price, so it has no number of its own to invent. |
| 01:48.170 | Narrator | Prices age, and a stale price is a wrong one. Your server decides whether a quote may still be called current. |
| 01:56.190 | Caller | Soybeans at Riverside? |
| 01:57.939 | Agent | Soybeans at Riverside for November delivery are $10.11, that's 18 under November futures, as of 10:41 AM. Anything else? |
| 02:08.860 | Narrator | At 10:45, those futures are four minutes old, inside the twenty-minute window. So the quote is live. |
| 02:16.095 | Narrator | The clock jumps to 11:20, and the caller asks again. |
| 02:22.264 | Caller | Say that again? |
| 02:23.627 | Agent | Soybeans at Riverside for November delivery are $10.11, that's 18 under November futures, as of 10:41 AM. These prices may be delayed. Anything else? |
| 02:34.875 | Narrator | A repeat is never a replay. The server checked again, found thirty-nine-minute-old futures, and added the caveat. |
| 02:42.337 | Narrator | Now it's two in the afternoon, after the 1:20 close. |
| 02:48.219 | Caller | Repeat that, please. |
| 02:51.082 | Agent | As of the last close, soybeans at Riverside for November delivery were $10.05, that's 18 under November futures. Anything else? |
| 03:01.394 | Narrator | No live price exists now, so the agent gives the last settlement, and says so. |
| 03:08.346 | Narrator | Three answers to one question, each decided by policy code. The trail shows why. |
| 03:16.302 | Narrator | Dale calls back. Reading a bid is the agent's job. Advising on it, or locking it in, belongs to the merchandiser. |
| 03:24.223 | Dale | Corn at Riverside for December? |
| 03:26.607 | Agent | Corn at Riverside for December delivery is $4.14, that's 33 under December futures, as of 10:42 AM. Anything else? |
| 03:36.970 | Dale | Should I lock that in now, or wait? |
| 03:40.051 | Agent | I can't advise on that, but the merchandiser can talk it through with you. |
| 03:45.076 | Narrator | No tool on this line can lock, book or contract a price. Watch the Teams panel. |
| 03:51.109 | Dale | Okay, lock in 5,000 bushels at that price. |
| 03:55.462 | Agent | I can't lock in or book a price on this line — only a merchandiser can. Connecting you with the Riverside merchandiser now. |
| 04:04.426 | Narrator | Nothing was locked. The Riverside merchandiser's Teams client rings with Dale's last quote, his own words and the reason. |
| 04:13.683 | Narrator | The model held the conversation. Your server decided every quote, caveat, refusal and handoff, and counted them. |
| 04:22.377 | Narrator | Under the hood, the model only converses. It passes on what the grower asked, and reads back the server's sentence. |
| 04:29.467 | Narrator | The server decides the rest: the location, whether a price is live, delayed or missing, and that every lock request goes to a person. |
| 04:39.557 | Narrator | Making it yours is mostly configuration: your elevators, merchandisers and hours, your bid sheet, market hours and freshness window. |
| 04:47.607 | Narrator | A licensed feed replaces one fixture class, and the spec and tests give your coding agent the rules that must hold. |
| 04:56.817 | Narrator | Bid and price lookup. Run it in simulation in two minutes, then connect it to your own Teams number. |
