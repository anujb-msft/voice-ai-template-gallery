# Demo script — Contextual On-Call Pager

## 1. Set the scene

"This is Contoso Property Management's after-hours maintenance line. The sample is running locally with no cloud credentials. Typed transcript mode drives the same server triage, scheduler, on-call lookup, and acknowledgement logic used by live calls."

Open <http://127.0.0.1:8095> and point out the **Demo surface** label.

## 2. Tenant intake

Click **Start intake + first page** with the default leak transcript.

Call out:

- The opening line discloses an automated assistant and gives the 911 safety instruction.
- Caller ID matched Alice Rivera to Maple Court unit 4B, but the unit is still confirmed.
- The model did not choose severity. The server matched `urgent:active_leak`.
- The callback number is masked in stored state and read back in digit groups.

## 3. First page and escalation

The first page is set to **no answer**. Show the incident timeline and pending scheduler job.

Click **Advance clock 3 min**. The second primary attempt runs.

Click **Tech declines**. Explain that decline escalates immediately to the next level.

## 4. Acknowledgement

Click **Tech accepts**.

Point out:

- Pending jobs are cancelled.
- The tenant receives a status call: "A technician has your request and will call you shortly."
- The state moves through acknowledged, tenantNotified, and closed.

## 5. Privacy branch

Run another simulation and choose **Voicemail**.

Show that the page prompt is only: "Contoso maintenance has an urgent page for you. Please call the maintenance line." It does not include property, unit, issue, callback number, or tenant details.

## 6. Bridge branch

Run another simulation and choose **Bridge to tenant**.

Explain that live mode uses ACS `AddParticipant` to add the tenant to the technician's call while keeping both phone numbers out of the model and spoken prompts.

## 7. Health and metrics

Open `/health` and `/api/stats`.

Highlight:

- Simulation mode and missing live configuration.
- Voice Live model/API version.
- Scheduler lag, pending jobs, and current on-call contacts.
- Incidents by severity, time-to-acknowledge metrics, successful contacts, pages per incident, duplicates, and routine work orders.
