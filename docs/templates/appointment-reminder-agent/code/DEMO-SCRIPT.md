# Demo script

1. Start the sample: `npm start` and open <http://127.0.0.1:8099>.
2. Show `/health`: simulation mode, Voice Live model `gpt-realtime`, schedule database path, dry-run campaign, and `DEMO_NOW`.
3. Click **Dry run**. Point out Jordan Rivera is scheduled while non-consenting, SMS-preferred, TTY, bad-number, and cutoff examples are skipped with reasons.
4. Click **Simulate Jordan confirm**. The transcript shows the AI disclosure, name check, DOB verification, appointment details only after verification, confirmation write, and prep instructions.
5. Run cancellation from the terminal:
   `node src/offline.mjs --appointment A-20418 --transcript cancel`.
   Show `/api/stats` and the released slot count.
6. Set `SCHEDULING_AGENT_TARGET` for a live handoff demo or leave it empty to show the callback fallback: `node src/offline.mjs --appointment A-20418 --transcript reschedule`.
7. Show voicemail behavior by posting `/api/simulate` with `outcome:"voicemail"` and attempt 3 in tests: no details are spoken, only name and callback number.
8. Close by highlighting production gates: legal/compliance review, allow-listed live numbers only, no raw audio storage, and shared `ScheduleAdapter` for the scheduling sample.
