# Appointment Scheduling Agent demo script

1. Start the server: `npm start`.
2. Open `http://127.0.0.1:8100` and show `/health` is in simulation mode.
3. Click **Reset data**.
4. Click **Simulate booking call**. The transcript verifies Jordan Rivera, notes a rash, selects a primary-care visit, checks eligibility, and offers slots.
5. Click **Simulate competing caller**, then type `first`. The agent reports `slot_taken`, demonstrating the occupancy race.
6. Click **Reset data**, run the simulated call again, type `first`, then `yes`. Show the booked appointment on the provider grid and `bookingsByVoice` in stats.
7. Optional: issue a handoff token from the reminder sample against the same `SCHEDULE_DB_PATH`, then POST it as `callContext` to `/api/simulate` to skip verification and reschedule.
8. For live mode, configure ACS, Voice Live, Teams resource account, and the public tunnel, then call the ACS number or Teams auto attendant.
