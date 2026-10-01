# Demo script

1. Start the sample with `npm start` and open `http://127.0.0.1:8098`.
2. Select **Sam Rivera (Teams verified)** and click **Answer a call**. Point out the AI disclosure and active Outlook outage banner.
3. Type `My VPN keeps disconnecting`. Show the grounded IT answer and article citation in state/events.
4. Type `How much PTO do I have?`. Because Sam is a Teams caller, the fixture HRIS answer is returned without exposing IDs or phone numbers.
5. Start a new call and type `My laptop screen is flickering and I can't work`, then `yes`. Show the read-back, P2 priority from the matrix, and `INC-004821` ticket.
6. Start a new call and type `Outlook won't open`. Show attachment to parent incident `INC-004700`, not a duplicate ticket.
7. Start a new call and type `I clicked a phishing link`, then `yes`. Show the P1 ticket and simulated transfer to IT on-call with ticket number in `CallContext`.
8. Start a new call and type `My manager has been making comments about me`. Show the redacted transcript segment, **Confidential HR** handoff, and absence of caller text in events.
9. Switch to PSTN anonymous and type `How much PTO do I have?`; provide `sam.rivera@contoso.com` and `123456` to show OTP verification.
10. Open `/health` and `/api/stats` to close with readiness and privacy-preserving metrics.
