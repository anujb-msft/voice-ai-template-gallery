# Transcript — Contextual On-Call Pager: full walkthrough

**Runtime:** 5:47 (347 seconds)

**Production disclosure:** Every voice in this film is synthetic, performed by Azure
OpenAI GPT Realtime through Azure AI Voice Live. Callers, companies and phone numbers are
fictional. The console footage is the template's own demo console running in simulation
mode; it is not a recording of a production deployment.

The walkthrough's subtitles are burned in. Timestamps are global (`mm:ss.mmm`) from the
start of the walkthrough.

| Timecode | Speaker | Line |
|---|---|---|
| 00:03.000 | Narrator | It's 11:42 at night, and Contoso is paging its on-call technician. |
| 00:08.680 | Narrator | Most pages are a number to call back. This one arrives with the answers. |
| 00:20.040 | Narrator | Tenants call the maintenance line's Teams number. Call Automation answers, and places each page. |
| 00:26.280 | Narrator | Voice Live, with GPT Realtime, talks to both. Your server decides who to wake, and writes the brief. |
| 00:35.277 | Narrator | Here's where that page starts. Wednesday, 11:42 at night, Alice Rivera calls the after-hours line. |
| 00:42.960 | Agent | Contoso Property Management maintenance line. I'm an automated assistant. If anyone is in danger, or you smell gas or see fire, hang up and call 911 now. Otherwise, what's the problem? |
| 00:56.519 | Alice | Water is pouring through my kitchen ceiling and it's spreading fast. |
| 01:00.750 | Agent | Understood — an active leak. Is this about unit 4B at Maple Court? |
| 01:07.264 | Narrator | The agent fills in fields. The server's triage rules call an active leak urgent; the model never picks a severity. |
| 01:15.645 | Alice | Yes, 4B. You can go in — the spare key is in the lockbox by the back door. |
| 01:21.767 | Agent | Is the number ending 0101 the best one to call you back on? |
| 01:27.053 | Alice | Yes, that's my cell. |
| 01:29.420 | Agent | I'm contacting the on-call technician now. You'll get a call back when they have it. If you can do so safely, shut off the nearest water valve while we contact the technician. |
| 01:40.591 | Narrator | The rotation says Morgan. The Teams card already has the unit, the problem and the way in, and no phone numbers. |
| 01:48.364 | Narrator | Listen for the brief. The server writes it from those fields; the model only reads it. |
| 01:54.492 | Morgan | Morgan Lee here. |
| 01:56.169 | Agent | This is the Contoso Property Management pager, an automated assistant, with an urgent page for Morgan Lee. |
| 02:02.475 | Agent | Urgent: active leak at Maple Court, unit 4B, reported 11:42 PM. Tenant said: Water is pouring through my kitchen ceiling and it's spreading fast. You may enter. Access: The spare key is in the lockbox by the back door. Press 1 or say 'I've got it' to accept. |
| 02:21.388 | Morgan | I've got it — on my way. |
| 02:23.518 | Agent | Thanks, Morgan. I'll tell the tenant you have it. The access details are on your Teams card. |
| 02:29.640 | Agent | A technician has your request and will call you shortly. |
| 02:34.709 | Narrator | Same night, at Pine Terrace, where Omar Diaz is on call. Dee Nguyen's heat is out, and it's getting cold. |
| 02:42.779 | Dee | The heat is out in unit 11 at Pine Terrace and it's 52 degrees in here. You can let yourself in. |
| 02:49.733 | Agent | Understood — no heat. Is the number ending 0103 the best one to call you back on? |
| 02:56.782 | Narrator | 52 degrees is under the 55-degree no-heat line in config, so it's urgent. |
| 03:02.403 | Dee | Yes. |
| 03:03.405 | Agent | I'm contacting the on-call technician now. You'll get a call back when they have it. Please avoid unsafe heating sources such as ovens or outdoor heaters indoors. |
| 03:15.973 | Narrator | No answer. The server's timer allows two tries per level, three minutes apart. The demo clock skips ahead. |
| 03:28.232 | Priya | I've got it. |
| 03:29.342 | Agent | Thanks, Priya. I'll tell the tenant you have it. The access details are on your Teams card. |
| 03:34.792 | Agent | A technician has your request and will call you shortly. |
| 03:39.165 | Narrator | Two misses, then the secondary. Priya's acknowledgement canceled the 20-minute operations alert. |
| 03:47.044 | Narrator | Thursday night. Priya swapped shifts with Morgan, so when Ben Carter is locked out at Maple Court, the page goes to her. |
| 03:54.439 | Agent | Contoso maintenance has an urgent page for you. Please call the maintenance line. Reference 2 4 6 0. |
| 04:02.701 | Narrator | Anyone near the phone could hear that. So the server keeps the building, the unit and the problem off voicemail. |
| 04:12.102 | Narrator | Saturday, 10:15 at night, and Grace Kim's bedroom heat is out. Is that worth waking a technician? |
| 04:19.948 | Grace | The heat is out in my bedroom, but it's about 64 degrees inside. |
| 04:24.963 | Agent | Understood — no heat. Is this about unit 7 at Pine Terrace? |
| 04:30.033 | Narrator | 64 degrees is above the 55-degree line, so the server calls it routine. The model doesn't get a vote. |
| 04:37.314 | Grace | Yes, unit 7. You can go in, I'm home all weekend. |
| 04:41.892 | Agent | Is the number ending 0104 the best one to call you back on? |
| 04:47.465 | Grace | Yes. |
| 04:48.483 | Agent | This isn't urgent enough to page the on-call technician, so I've logged a work order for the office. They'll follow up Monday morning. If it drops to 55 degrees or below inside, call us back and we'll page the on-call technician. |
| 05:03.377 | Narrator | Nobody woke up, and the work order keeps every detail. |
| 05:08.627 | Narrator | The model listens, fills in fields, and reads the brief it's handed. It never picks a severity or a person. |
| 05:16.027 | Narrator | Your server classifies, picks the on-call chain, writes the brief and runs the timers. |
| 05:23.567 | Narrator | Most changes are configuration: triage rules, rotations and swaps, escalation timers, buildings. |
| 05:30.507 | Narrator | The spec and this demo script give your coding agent the context for the rest. |
| 05:37.747 | Narrator | Contextual on-call pager. Run it in simulation in two minutes, then connect it to your own Teams number. |
