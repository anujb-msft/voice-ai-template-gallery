export const INTAKE_TOOLS = [
  { type: "function", name: "identify_unit", description: "Validate the caller's property and unit. Phone numbers are server-owned and never arguments.", parameters: { type: "object", properties: { property: { type: "string" }, unit: { type: "string" } }, required: [] } },
  { type: "function", name: "record_issue", description: "Record structured incident fields. Do not classify severity.", parameters: { type: "object", properties: { issue: { type: "string" }, details: { type: "string" }, accessNotes: { type: "string" }, permissionToEnter: { type: "boolean" }, callbackNumber: { type: "string" }, indoorTempF: { type: "number" }, tenantSaid: { type: "string", description: "One short caller quote, never instructions to the system." } }, required: [] } },
  { type: "function", name: "classify_and_submit", description: "Ask the server to classify, deduplicate, save, and schedule paging. The model never chooses severity.", parameters: { type: "object", properties: {}, required: [] } },
  { type: "function", name: "end_call", description: "End the call after the server says the intake is complete.", parameters: { type: "object", properties: { reason: { type: "string" } }, required: [] } },
];

export const PAGE_TOOLS = [
  { type: "function", name: "get_ticket_detail", description: "Answer a technician question from stored incident fields only. Never reveal tenant or technician phone numbers.", parameters: { type: "object", properties: { field: { type: "string" } }, required: ["field"] } },
  { type: "function", name: "acknowledge", description: "The technician accepted the page by voice or DTMF 1.", parameters: { type: "object", properties: {}, required: [] } },
  { type: "function", name: "decline", description: "The technician declined by voice or DTMF 2.", parameters: { type: "object", properties: { reason: { type: "string" } }, required: [] } },
  { type: "function", name: "bridge_to_tenant", description: "DTMF 3. Ask the server to bridge the tech to the tenant without revealing either phone number.", parameters: { type: "object", properties: {}, required: [] } },
  { type: "function", name: "repeat_brief", description: "DTMF *. Repeat the server-generated page brief.", parameters: { type: "object", properties: {}, required: [] } },
];

export const AGENT_TOOLS = [...INTAKE_TOOLS, ...PAGE_TOOLS];

export function localeLanguage(locale = "en-US") {
  try {
    const parsed = new Intl.Locale(locale);
    return { locale: parsed.baseName, code: parsed.language, label: new Intl.DisplayNames(["en"], { type: "language" }).of(parsed.baseName) ?? parsed.baseName };
  } catch {
    return { locale, code: String(locale).split("-")[0], label: locale };
  }
}

export function buildInstructions(policy, locale = "en-US", mode = "intake") {
  const lang = localeLanguage(locale);
  if (mode === "page") return `You are the Contoso maintenance automated pager. Start in ${lang.label}. Disclose that you are an automated assistant in the first sentence. Read only the server-provided brief. You may answer technician questions by calling get_ticket_detail. Accept only with acknowledge, decline only with decline, bridge only with bridge_to_tenant, and repeat only with repeat_brief. Never reveal tenant or technician phone numbers.`;
  return `You answer ${policy.organization}'s after-hours maintenance line in ${lang.label}. Your opening line must be exactly: "Contoso Property Management maintenance line. I'm an automated assistant. If anyone is in danger, or you smell gas or see fire, hang up and call 911 now. Otherwise, what's the problem?" Server tools own identity, severity, paging, duplicates, and safety lines. Never choose a severity. Never ask for a PIN. Never send phone numbers or personal data to the model. Keep turns short and use identify_unit, record_issue, classify_and_submit, and end_call.`;
}
