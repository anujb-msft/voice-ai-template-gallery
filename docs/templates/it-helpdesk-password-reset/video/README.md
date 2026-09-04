# Video deliverables

Required production filenames:

- [`demo.mp4`](./demo.mp4) — narrated password-reset workflow demonstration
- [`poster.webp`](./poster.webp) — video poster image
- [`captions.vtt`](./captions.vtt) — captions aligned to the final recording
- [`transcript.md`](./transcript.md) — reviewed transcript aligned to the final recording

The reviewed 3:30 cut is published in this folder with its matching poster, captions,
and transcript. It is a fully original 1920×1080 motion-graphics production: no supplied
recording or rough-cut footage is reused. All 25 spoken cues use native Azure AI Voice
Live audio (`azure-realtime` with `azure-realtime-native` voices), and the mix contains
no continuous music, drone, room tone, or noise bed.

The film is an illustrative demonstration of a reference implementation, not evidence of
a production deployment. Its employee and agent conversation is dramatized with
synthetic voices and disclosed on screen.

## Production details

- **Runtime:** 210.000 seconds (3:30), 1920×1080, 30 fps, H.264 High with
  48 kHz stereo AAC-LC audio.
- **Voice:** 25 cues generated through Azure AI Voice Live using
  `azure-realtime` and `azure-realtime-native`: `andrew` for narration, `ava`
  for the agent, and `emma` for the employee.
- **Mix:** No continuous music, drone, room tone, or noise bed. Only
  event-locked ring, tick, chime, and ledger-stamp effects remain.
- **Originality:** Every frame was newly authored from repository-owned UI,
  code, diagrams, or motion graphics. No supplied recording or earlier rough
  cut is present.
- **Branding:** Teams Phone Extensibility is the customer-facing telephony
  brand. ACS Call Automation appears only as the implementation layer used by
  the sample.

The captions and transcript include every narrator, agent, and employee line.
The poster is a purpose-built still from the same visual system as the film.
