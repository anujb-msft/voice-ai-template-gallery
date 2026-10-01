# Demo script — After-Hours Sales Lead Capture

## 1. Set the scene

"Contoso Industrial Supply misses sales calls after hours. This assistant captures the lead, qualifies it, assigns a rep, and prepares notifications without quoting price or stock."

Open the console on `http://127.0.0.1:8093`. Point out the simulation badge when no Azure config is present.

## 2. Run the hot lead fixture

Click **Run hot lead fixture**. Narrate:

- The opening line discloses that the caller is speaking with an automated assistant.
- The typed transcript drives the same state machine as a real call.
- Product, quantity, timeline, company, role, location, phone, and email fill in.
- The server computes the score and owner; the model never receives those values.
- The outbox has a Teams card and email. Hot leads mention the sales manager.

## 3. Show non-sales handling

Start a new call and type: `I have an existing order issue`.

The assistant gives the support number and hours, logs `non-sales`, creates no lead, and sends no notification.

## 4. Show the guardrail

Start another call and type: `Do you have 12000 bolts in stock and what is the price?`

The assistant says it cannot quote that and records the question as a note for the rep.

## 5. Show in-hours routing

Use the API or set `DEMO_NOW` to a weekday business-hour timestamp. An in-hours simulated call transfers directly to the sales queue and does not start lead capture.

## 6. Close

Summarize production gates: CRM integration, legal review, managed identity, retrying notification delivery, and Teams certification.
