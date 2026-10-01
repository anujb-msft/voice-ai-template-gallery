export const SYSTEM_PROMPT = `You are Contoso Health's appointment scheduling voice assistant. You must use only server-owned tools for verification, eligibility, slot search, holds, booking, rescheduling, cancellation, waitlist, callback, transfer, repeat, and end-call. Never ask for or repeat phone numbers, dates of birth, MRNs, insurance details, or stored reason text back to the model context.`;

export const TOOLS = [
  "verify_patient", "redeem_handoff", "list_upcoming", "note_reason", "choose_visit_type", "search_slots", "hold_slot", "book", "reschedule", "propose_cancel", "cancel", "add_waitlist", "request_callback", "transfer", "repeat_last", "end_call"
];

const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = (description, extra = {}) => ({ type: "string", description, ...extra });
const bool = (description) => ({ type: "boolean", description });

export const TOOL_DEFINITIONS = {
  verify_patient: {
    description: "Verify an existing patient or authorized proxy using caller-provided full name and date of birth. Caller ID never counts as verification.",
    parameters: object({
      firstName: string("Patient first/given name as spoken by the caller."),
      lastName: string("Patient last/family name as spoken by the caller."),
      fullName: string("Full patient name if the model captured it as one phrase."),
      dob: string("Date of birth exactly as spoken or keyed, e.g. MMDDYYYY or YYYY-MM-DD."),
      proxyName: string("Optional proxy/caregiver full name if someone else is calling."),
    }, ["dob"]),
  },
  redeem_handoff: {
    description: "Redeem the reminder agent patientRef for a reschedule transfer. Success skips normal verification; failure must fall back to verify_patient.",
    parameters: object({
      patientRef: string("Opaque handoff token from CallContext."),
      appointmentId: string("Appointment id from CallContext."),
      sessionId: string("Transferred call/session correlation id that the token is bound to."),
      intent: string("Inbound intent, usually reschedule.", { enum: ["reschedule", "book", "cancel"] }),
    }, ["patientRef"]),
  },
  list_upcoming: {
    description: "List upcoming appointments for the verified patient as opaque appointment handles and spoken summaries.",
    parameters: object({
      includeCancelled: bool("Whether to include cancelled appointments; normally false."),
    }),
  },
  note_reason: {
    description: "Store the visit reason server-side and run emergency/urgent phrase checks. The reason text is not returned to model context.",
    parameters: object({ text: string("Caller-provided reason for visit or symptom description.") }, ["text"]),
  },
  choose_visit_type: {
    description: "Select the visit type code and run ordered server-side eligibility rules before any slot search.",
    parameters: object({
      code: string("Visit type code.", { enum: ["NEW_PROBLEM", "FOLLOW_UP", "ANNUAL_PHYSICAL", "DERM_SKIN_CHECK", "DERM_NEW_PROBLEM", "XRAY", "ULTRASOUND", "MRI"] }),
      selfPayAcknowledged: bool("True only if the caller explicitly accepts self-pay for inactive insurance."),
    }, ["code"]),
  },
  search_slots: {
    description: "Search available slots for the verified patient and eligible visit type, applying provider/location/day/time preferences.",
    parameters: object({
      visitType: string("Optional visit type code if not already selected."),
      department: string("Preferred department, e.g. Primary Care, Dermatology, Imaging."),
      providerPreference: string("Natural language provider preference, e.g. my usual doctor, Dr. Patel, any provider."),
      providerId: string("Exact provider id when known."),
      location: string("Preferred clinic/location id."),
      dayPart: string("Preferred time of day.", { enum: ["morning", "afternoon", "any"] }),
      date: string("Preferred date in YYYY-MM-DD when stated."),
      more: bool("True when caller asks for more options."),
    }),
  },
  hold_slot: {
    description: "Place a five-minute hold on an offered option before read-back. Returns slot_taken if another caller got it first.",
    parameters: object({ optionId: string("Opaque option id returned by search_slots."), optionIndex: { type: "integer", description: "Zero-based offered option index when selected by keypad." } }, ["optionId"]),
  },
  book: {
    description: "Book a held slot only after the caller gives an explicit yes to the full read-back.",
    parameters: object({
      holdId: string("Hold id returned by hold_slot."),
      optionId: string("Original option id if the client tracks that instead of holdId."),
      confirmed: bool("True only for an explicit yes; false for maybe/no/unclear."),
      confirmation: string("Caller's last utterance confirming or declining the read-back."),
      idempotencyKey: string("Optional idempotency key for a repeated booking request."),
    }, ["confirmed"]),
  },
  reschedule: {
    description: "Atomically book the held new slot and cancel the old appointment only after explicit read-back confirmation.",
    parameters: object({
      holdId: string("Hold id for the new slot."),
      appointmentHandle: string("Opaque appointment handle returned by list_upcoming or handoff."),
      confirmed: bool("True only for an explicit yes to the reschedule read-back."),
      confirmation: string("Caller's last utterance confirming or declining."),
      idempotencyKey: string("Optional idempotency key for repeat calls."),
    }, ["confirmed"]),
  },
  propose_cancel: {
    description: "Prepare a cancellation read-back, including late-cancellation notice when applicable. Does not cancel yet.",
    parameters: object({ appointmentHandle: string("Opaque appointment handle to cancel."), reasonCode: string("Cancellation reason code, e.g. schedule_conflict, feeling_sick, transportation, patient_requested.") }),
  },
  cancel: {
    description: "Cancel an appointment only after propose_cancel and an explicit yes to the read-back.",
    parameters: object({ proposalId: string("Cancellation proposal id returned by propose_cancel."), confirmed: bool("True only for explicit yes."), confirmation: string("Caller confirmation utterance."), idempotencyKey: string("Optional idempotency key.") }, ["proposalId", "confirmed"]),
  },
  add_waitlist: {
    description: "Add the verified patient to the waitlist when no acceptable slot is available.",
    parameters: object({ preferences: { type: "object", description: "Preferred providers, locations, dates, or day parts.", additionalProperties: true } }),
  },
  request_callback: {
    description: "File a callback request for registration, scheduling, referral coordination, or after-hours human help.",
    parameters: object({ queue: string("Callback queue.", { enum: ["registration_callback", "scheduling_team", "referral_coordinator"] }), preferredTime: string("Caller-stated preferred callback time."), callbackNumber: string("Caller-provided callback number for new-patient registration only.") }, ["queue"]),
  },
  transfer: {
    description: "Escalate or transfer to an allowlisted destination with minimal CallContext.",
    parameters: object({ destination: string("Allowlisted destination.", { enum: ["scheduling_team", "nurse_line", "referral_coordinator", "registration_callback"] }), reason: string("Short reason code for the transfer.") }, ["destination"]),
  },
  repeat_last: {
    description: "Repeat the last agent phrase or offered options.",
    parameters: object({}),
  },
  end_call: {
    description: "End the call politely and release any active hold.",
    parameters: object({ reason: string("Outcome reason, e.g. completed, caller_hung_up, call_cap, agent_ended.") }),
  },
};

export function describeTools() { return TOOLS.map((name) => ({ name, strict: true, ...TOOL_DEFINITIONS[name] })); }

export const AGENT_TOOLS = TOOLS.map((name) => ({
  type: "function",
  name,
  description: TOOL_DEFINITIONS[name].description,
  parameters: TOOL_DEFINITIONS[name].parameters,
}));

export function localeLanguage(locale = "en-US") {
  return String(locale).toLowerCase().startsWith("es") ? "es" : "en";
}

export function buildInstructions(context = {}) {
  const locale = typeof context === "string" ? context : context?.locale ?? "en-US";
  const language = localeLanguage(locale) === "es" ? "Spanish" : "English";
  const handoff = context?.handoff?.ok ? `\nThe caller arrived from a reminder handoff for ${context.handoff.appointmentSummary}; start by helping reschedule it.` : "";
  return `${SYSTEM_PROMPT}\nSpeak ${language}. Open with the required AI disclosure and wait for the caller.${handoff}`;
}
