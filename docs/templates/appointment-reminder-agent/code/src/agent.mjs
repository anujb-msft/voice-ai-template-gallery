export const AGENT_TOOLS = [
  { type: "function", name: "confirm_identity", description: "Record whether the responder is the patient or an authorized proxy. No appointment details are available before this.", parameters: { type: "object", properties: { isPatient: { type: "boolean" }, proxyName: { type: "string" }, text: { type: "string" } } } },
  { type: "function", name: "check_dob", description: "Check a spoken or keypad DOB against the server record. The model never sees the date on file.", parameters: { type: "object", properties: { spokenOrDigits: { type: "string" } }, required: ["spokenOrDigits"] } },
  { type: "function", name: "get_appointment_summary", description: "Return the verified caller's next appointment summary.", parameters: { type: "object", properties: {} } },
  { type: "function", name: "confirm_appointment", description: "Confirm only after an explicit yes in the patient's last utterance.", parameters: { type: "object", properties: { confirmation: { type: "string" } }, required: ["confirmation"] } },
  { type: "function", name: "propose_cancel", description: "Prepare a cancellation read-back and late-cancellation notice when needed.", parameters: { type: "object", properties: { reasonCode: { type: "string" } } } },
  { type: "function", name: "cancel_appointment", description: "Cancel only after the proposal was read back and the patient explicitly said yes.", parameters: { type: "object", properties: { proposalId: { type: "string" }, confirmation: { type: "string" } }, required: ["proposalId", "confirmation"] } },
  { type: "function", name: "request_reschedule", description: "Record a reschedule request and transfer to scheduling or file a callback.", parameters: { type: "object", properties: {} } },
  { type: "function", name: "opt_out", description: "Persist suppression before ending the call.", parameters: { type: "object", properties: {} } },
  { type: "function", name: "nurse_line", description: "Use for clinical questions; transfers during hours or returns after-hours advice number.", parameters: { type: "object", properties: {} } },
  { type: "function", name: "repeat_last", description: "Repeat the last server-owned phrase.", parameters: { type: "object", properties: {} } },
  { type: "function", name: "end_call", description: "End politely when finished.", parameters: { type: "object", properties: { reason: { type: "string" } } } }
];

export function localeLanguage(locale = "en-US") {
  try {
    const parsed = new Intl.Locale(locale);
    return { locale: parsed.baseName, code: parsed.language, label: new Intl.DisplayNames(["en"], { type: "language" }).of(parsed.language) ?? parsed.language };
  } catch { return { locale, code: String(locale).split("-")[0], label: locale }; }
}

export function buildInstructions(_routes = null, locale = "en-US") {
  const language = localeLanguage(locale);
  return `You are Contoso Health's automated appointment reminder assistant. Speak ${language.label}. Disclose that you are an automated assistant in the first sentence. Never ask for or reveal phone numbers, patient ids, medical record numbers, or the date of birth on file. Before verification you know only the patient's first name and may not mention department, provider, location, date, or time. Use only server tools for identity, schedule writes, opt-out, safety, and transfer. Voicemail, wrong-party, opt-out, emergency, and verification-failure wording is server-owned; do not improvise it. Confirm, cancel, and reschedule require explicit patient intent and read-back rules. Give no clinical advice.`;
}
