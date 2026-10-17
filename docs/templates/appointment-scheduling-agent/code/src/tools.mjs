/**
 * The only path from a model tool call to the scheduling flow, shared by the
 * live call bridge and the offline driver so both take exactly the same path.
 *
 * Kept free of transport imports so tests drive it without the WebSocket or
 * Azure SDKs.
 */
import { WRITE_ACTIONS } from "./agent.mjs";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** search_slots arguments, as the schedule store's preference filter. */
export function toPreferences(args = {}) {
  const prefs = {};
  const said = String(args.providerPreference ?? "").trim().toLowerCase();
  if (args.providerId) prefs.providerId = String(args.providerId);
  else if (/\b(usual|regular|primary|pcp|own doctor|my doctor)\b/.test(said)) prefs.usualDoctor = true;
  else if (said && !/\b(any|anyone|whoever|first available)\b/.test(said)) prefs.providerName = said;
  if (args.location) prefs.location = String(args.location);
  if (args.dayPart === "morning" || args.dayPart === "afternoon") prefs.timeOfDay = args.dayPart;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(args.date ?? ""))) prefs.date = String(args.date);
  const weekday = WEEKDAYS.indexOf(String(args.weekday ?? "").trim().toLowerCase());
  if (weekday >= 0) prefs.weekday = weekday;
  return prefs;
}

/**
 * Runs one tool call. book, reschedule and cancel are not tools, so a model
 * that names one anyway is refused here and the attempt is logged; the flow
 * writes only on the caller's own confirmation (see src/agent.mjs).
 */
export function dispatchTool(flow, callId, name, args = {}) {
  const a = args && typeof args === "object" ? args : {};
  if (WRITE_ACTIONS.includes(name)) return flow.refuseModelWrite(callId, name);
  switch (name) {
    case "verify_patient":
      return flow.verifyPatient(callId, {
        fullName: a.fullName,
        firstName: a.firstName,
        lastName: a.lastName,
        dob: a.dob,
        proxyName: a.proxyName,
      });
    case "redeem_handoff":
      return flow.handoffStatus(callId);
    case "list_upcoming":
      return flow.listUpcoming(callId);
    case "note_reason":
      return flow.noteReason(callId, a.text);
    case "choose_visit_type":
      return flow.chooseVisitType(callId, a.code, { selfPayAcknowledged: a.selfPayAcknowledged === true });
    case "search_slots":
      return flow.searchSlots(callId, {
        preferences: toPreferences(a),
        more: a.more === true,
        appointmentHandle: a.appointmentHandle ?? null,
      });
    case "hold_slot":
      return flow.holdSlot(callId, { optionId: a.optionId ?? null, optionIndex: a.optionIndex ?? null });
    case "propose_cancel":
      return flow.proposeCancel(callId, { appointmentHandle: a.appointmentHandle ?? null, reasonCode: a.reasonCode });
    case "add_waitlist":
      return flow.addWaitlist(callId);
    case "request_callback":
      return flow.requestCallback(callId, {
        queue: a.queue,
        preferredTime: a.preferredTime,
        callbackNumber: a.callbackNumber,
      });
    case "transfer":
      return flow.requestTransfer(callId, a.destination, a.reason ?? "agent_requested");
    case "repeat_last":
      return flow.repeatLast(callId);
    case "end_call":
      // Refused while the call is on its way to a person; see SchedulingFlow.agentEndCall.
      return flow.agentEndCall(callId, a.reason ?? null);
    default:
      return { ok: false, error: `Unknown tool ${name}` };
  }
}
