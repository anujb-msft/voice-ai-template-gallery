# Transcript — General Inquiry Agent: full walkthrough

**Runtime:** 5:15 (316 seconds)

**Production disclosure:** Every voice in this film is synthetic, performed by Azure
OpenAI GPT Realtime through Azure AI Voice Live. Callers, companies and phone numbers are
fictional. The console footage is the template's own demo console running in simulation
mode; it is not a recording of a production deployment.

The walkthrough's subtitles are burned in. Timestamps are global (`mm:ss.mmm`) from the
start of the walkthrough.

| Timecode | Speaker | Line |
|---|---|---|
| 00:03.000 | Narrator | A city's information line hears the same few questions all day: hours, permits, pickups, programs. |
| 00:10.490 | Narrator | Usually that means a menu, then a queue. This agent answers from the city's approved content. |
| 00:23.180 | Narrator | Residents call a Teams phone number, through Teams Phone extensibility. |
| 00:27.520 | Narrator | Azure Communication Services Call Automation bridges the audio to Voice Live, where GPT Realtime holds the conversation. |
| 00:35.700 | Narrator | Your server supplies the approved content, and hands off to a Teams call queue with context. |
| 00:43.363 | Narrator | Wednesday, 10 in the morning. A resident calls the City of Contoso's information line. |
| 00:49.308 | Agent | Thanks for calling the City of Contoso. I'm an automated assistant and can answer questions about city services, hours, and programs. What can I help you find? |
| 01:00.315 | Resident | What are City Hall's hours? |
| 01:02.294 | Agent | City Hall public counters are open Monday through Friday from 8:00 a.m. to 5:00 p.m. City Hall is open right now, until 5 p.m. That's from Contoso Customer Service — City Hall guide. Is there anything else? |
| 01:17.339 | Narrator | That's an approved article, with an owner and a review date. Whether it's open now came from the server's clock, not the model. |
| 01:25.822 | Resident | Where did that come from? |
| 01:27.637 | Agent | That came from Contoso Customer Service — City Hall guide. The short URL is contoso.gov/cityhall. Is there anything else? |
| 01:38.476 | Resident | Thanks, that's all. |
| 01:40.144 | Agent | Thanks for calling the City of Contoso. Goodbye. |
| 01:45.430 | Narrator | Every article has a review date. The yard-sale permit article is six months past it, and a resident is asking. |
| 01:52.771 | Resident | Do I need a permit for a yard sale? |
| 01:55.604 | Agent | I found something on that, but it's past its review date and may be out of date, so I can't give it to you as an answer. I can't confirm the current rules, but staff can, or you can check contoso.gov. Would you like me to connect you? |
| 02:11.186 | Narrator | The server held it back. The model was told only that an out-of-date match exists. There was nothing to paraphrase. |
| 02:18.762 | Resident | No thanks, I'll check the website. |
| 02:21.382 | Agent | Thanks for calling the City of Contoso. Goodbye. |
| 02:26.659 | Narrator | Seven in the evening. City Hall and the information desk have both closed, and a resident wants to talk to a person. |
| 02:33.992 | Resident | Can I talk to a person? |
| 02:35.725 | Agent | I can't connect you right now — the information desk is closed and opens again Thursday at 8 a.m. Our information desk is open weekdays from 8 to 5. Please call back then, or visit contoso.gov. Goodbye. |
| 02:50.524 | Narrator | The server checked the desk's staffed hours. No transfer into an empty queue, and no promise of a callback the city can't keep. |
| 03:00.829 | Narrator | Back to business hours. Whether a caller qualifies for a city program is for staff to decide, not the model. |
| 03:07.992 | Resident | I'm 67 — do I qualify for the senior utility discount? |
| 03:12.940 | Agent | The senior utility discount is for City of Contoso utility customers who are 65 or older and meet the published household income guideline. That's from Contoso Benefits Office — Utility discount. Staff make the final decision on eligibility. I can't check your situation on this line, but staff can. Would you like me to connect you? |
| 03:35.115 | Resident | Yes, please. |
| 03:36.924 | Agent | Connecting you now with the Contoso information desk. I'll pass along what you asked so you don't have to repeat it. |
| 03:44.034 | Narrator | The desk's Teams client rings with the topic and what was already covered, in VoIP headers. Even there, the age is masked. |
| 03:54.284 | Narrator | Not every call is a question. This line can't file service requests, and the agent won't pretend it can. |
| 04:01.611 | Caller | I want to report a pothole on Elm Street. |
| 04:04.604 | Agent | I can't file service requests on this line, and I don't have approved information on that. Staff at the information desk can help. Would you like me to connect you? |
| 04:14.803 | Caller | Can I talk to a person, please? |
| 04:17.058 | Agent | Connecting you now with the Contoso information desk. I'll pass along what you asked so you don't have to repeat it. |
| 04:25.727 | Narrator | Every call is audited: answers, refusals, handoffs and after-hours closures, from the same log a real deployment writes. |
| 04:35.503 | Narrator | On a live call, the model searches the city's content and words the answer. It doesn't set the rules. |
| 04:42.303 | Narrator | Freshness, opening hours, what's masked and the transfer are decided in code, on the server's clock, and every decision is audited. |
| 04:52.133 | Narrator | Making it yours is mostly content: your articles, with owners and review dates, plus your hours and two thresholds. |
| 04:59.683 | Narrator | The spec and this demo script give your coding agent the context for the rest. |
| 05:06.923 | Narrator | General Inquiry Agent. Run it in simulation, then connect it to your own Teams number. |
