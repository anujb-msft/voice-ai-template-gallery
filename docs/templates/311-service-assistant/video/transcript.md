# Transcript — 311 Service Assistant

**Runtime:** 5:44 (344 seconds)

**Production disclosure:** Every voice in this film is synthetic, performed by Azure
OpenAI GPT Realtime through Azure AI Voice Live. Callers, companies and phone numbers are
fictional. The console footage is the template's own demo console running in simulation
mode; it is not a recording of a production deployment.

This transcript matches [`captions.vtt`](./captions.vtt), which splits long lines into
shorter cues. Timestamps are global (`mm:ss.mmm`) from the start of the film.

| Timecode | Speaker | Line |
|---|---|---|
| 00:03.000 | Narrator | One number for everything a city does: potholes, trash, questions, and sometimes an emergency. |
| 00:09.860 | Narrator | A phone tree makes residents pick a branch, and a language. This assistant just listens. |
| 00:22.130 | Narrator | Residents call a Teams phone number, through Teams Phone extensibility. |
| 00:26.470 | Narrator | Azure Communication Services Call Automation bridges the audio to Voice Live, where GPT Realtime holds the conversation. |
| 00:34.650 | Narrator | The city's server decides, and hands off to a Teams call queue with context. |
| 00:41.683 | Narrator | First, Alex Chen reports a pothole the way people actually talk. |
| 00:47.090 | Agent | City of Contoso 311. I'm an automated assistant. For emergencies, hang up and dial 911. How can I help? Para español, hable en español. |
| 00:59.211 | Alex | Hi, there's a big pothole on Oak Avenue, right at the corner of Fifth Street. |
| 01:04.505 | Agent | I have the pothole at Oak Avenue and 5th Street. Is that right? |
| 01:09.666 | Narrator | The server, not the model, found that corner on the city's map. Nothing is filed until Alex confirms. |
| 01:17.653 | Alex | Yes, that's right. |
| 01:19.369 | Agent | I've filed a pothole report at Oak Avenue and 5th Street with Public Works. Your case number is S R, 2 6, 0 1 9 3. Again, S R, 2 6, 0 1 9 3. |
| 01:34.483 | Agent | Would you like text updates on this case, or is there anything else? |
| 01:39.425 | Alex | Yes, text me updates please. |
| 01:42.571 | Agent | Done. I've texted your case number to the number you're calling from. Is there anything else I can help you with? |
| 01:49.664 | Narrator | A text goes out only with consent. The model never sees Alex's number. |
| 01:55.469 | Alex | No, that's all, thanks. |
| 01:58.425 | Agent | Thank you for calling City of Contoso 311. Goodbye. |
| 02:04.460 | Narrator | Some calls must never become a service request. Sam Rivera smells gas in his kitchen, and he's called 311. |
| 02:12.201 | Sam | Hi, I smell gas in my kitchen and I'm not sure what to do. |
| 02:16.730 | Agent | This sounds like a gas emergency. Please leave the building now and don't switch anything on or off. Once you're outside, call the gas utility at 555-0109, or dial 911. |
| 02:30.414 | Narrator | That was the server's rule, not the model's judgment. It checks every caller turn first: no questions, no case. |
| 02:39.302 | Narrator | Lucía Ortega calls the same number, in Spanish. |
| 02:43.670 | Agent | City of Contoso 311. I'm an automated assistant. For emergencies, hang up and dial 911. How can I help? Para español, hable en español. |
| 02:55.783 | Lucía | Hola, necesito que recojan un colchón y un sofá viejo. |
| 03:00.128 | Agent | Puedo programar la recogida de un colchón y un sofá. ¿Cuál es la dirección de recogida? |
| 03:07.051 | Narrator | Nobody pressed 2. The server heard Spanish and switched the same agent's language and voice, under the same rules. |
| 03:15.073 | Lucía | En el 1200 de Maple Street. |
| 03:17.861 | Agent | La recogida está programada para el sábado 3 de octubre en 1200 Maple Street. Su número de caso es S R, 2 6, 0 1 9 4. Repito, S R, 2 6, 0 1 9 4. |
| 03:35.786 | Agent | ¿Quiere recibir actualizaciones por mensaje de texto sobre este caso, o hay algo más? |
| 03:43.396 | Narrator | Later, Sam calls back with questions. The model may answer them only from articles the city has approved. |
| 03:50.251 | Sam | And what are the counter hours at City Hall? |
| 03:52.880 | Agent | I don't have approved information on that, so I won't guess. Would you like me to connect you with 311 staff? |
| 04:00.057 | Narrator | The only match was an expired notice, so the server withheld it. |
| 04:04.730 | Sam | No, that's all. |
| 04:06.403 | Agent | Thank you for calling City of Contoso 311. Goodbye. |
| 04:12.433 | Narrator | Next, a complaint. The server's policy is to apologize, promise nothing, and offer a report or a person. |
| 04:20.921 | Resident | I want to make a complaint. The trash trucks have skipped my street three weeks in a row and nobody has called me back. |
| 04:28.515 | Agent | I'm sorry about that. I can hear how frustrating it is. I can file a missed-pickup report now, or connect you with a 311 staff member who can look into it. Which would you prefer? |
| 04:39.997 | Resident | I'd like to talk to a person, please. |
| 04:42.920 | Agent | I'm connecting you with 311 staff now. |
| 04:46.956 | Narrator | The server checked the hours and picked the Teams queue. Staff see the topic, a summary and the caller's mood. |
| 04:56.083 | Narrator | Five calls, one number. The model held each conversation; the city's server decided every outcome, and audited it. |
| 05:05.360 | Narrator | The model converses and calls tools. Every line the caller hears is written by the server. |
| 05:12.210 | Narrator | The server checks the place, the rules and the hours before it files, texts or transfers. |
| 05:20.170 | Narrator | Making it yours is mostly configuration: request rules, departments and hours, emergency phrases, and approved articles. |
| 05:27.810 | Narrator | The spec and this demo script give your coding agent the context for the rest. |
| 05:35.050 | Narrator | 311 Service Assistant. Run it in simulation, then connect it to your city's Teams number. |
