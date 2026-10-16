import { describeCallError } from "./call-invite.mjs";

/**
 * Places the reminder calls for one campaign run. Each row is independent: a placement that
 * throws ends that call with outcome create_call_failed (the same outcome as an asynchronous
 * CreateCallFailed callback), is returned in `failed`, and the run moves on to the next row.
 * No attempt is recorded for a failed placement because the patient was never dialed.
 * `inFlight` is a Set of call ids; an id is removed again when its placement fails.
 */
export async function launchReminderCalls({ flow, dialPlan, maxConcurrent, placeCall, inFlight }) {
  const launched = [];
  const failed = [];
  for (const row of dialPlan.filter((r) => r.state === "scheduled").slice(0, maxConcurrent)) {
    let call = null;
    try {
      call = flow.create({ appointmentId: row.appointmentId });
      inFlight.add(call.id);
      await placeCall({ to: call.appointment.patient.phones?.[0]?.number, callId: call.id });
      launched.push(call.id);
    } catch (error) {
      const message = describeCallError(error);
      if (call) {
        inFlight.delete(call.id);
        flow.endCall(call.id, "create_call_failed", `create_call_failed: ${message}`);
      }
      failed.push({ callId: call?.id ?? null, appointmentId: row.appointmentId, error: message });
    }
  }
  return { launched, failed };
}
