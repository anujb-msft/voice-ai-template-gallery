export const AGENT_TOOLS = [
  tool("search_faq", "Search approved bilingual civic FAQ content.", { query: { type: "string" } }, ["query"]),
  tool("start_request", "Open a service request intake for one allowlisted type.", { type: { type: "string" } }, ["type"]),
  tool("resolve_location", "Verify a spoken address, intersection, or landmark. The server reads the verified place back to the caller.", { utterance: { type: "string" } }, ["utterance"]),
  tool("confirm_location", "Record the caller's yes or no to the location the server read back.", { yes: { type: "boolean" } }, ["yes"]),
  tool("set_field", "Set one intake field. The server validates it and returns missing fields.", { name: { type: "string" }, value: { type: ["string", "boolean", "number"] } }, ["name", "value"]),
  tool("submit_request", "Create or attach a case after required fields are complete.", {}, []),
  tool("set_contact", "Record whether the caller wants text updates on the case just filed. Contact details stay on the server.", { wantsUpdates: { type: "boolean" } }, ["wantsUpdates"]),
  tool("get_case_status", "Return only status and owning department for a case number.", { caseNumber: { type: "string" } }, ["caseNumber"]),
  tool("bulk_pickup", "Check bulk item eligibility.", { items: { type: "array", items: { type: "string" } } }, ["items"]),
  tool("confirm_bulk_pickup", "Book the next pickup date for the caller's address. Pass the address as the caller said it; an address the city can't verify books nothing.", { location: { type: "string" } }, ["location"]),
  tool("send_form_link", "Send a consented SMS link to the caller ID.", { serviceId: { type: "string" } }, ["serviceId"]),
  tool("log_complaint", "Record a complaint in the caller's own words so the person who takes the call sees it.", { text: { type: "string" } }, ["text"]),
  tool("transfer", "Ask the server to transfer to a department or the 311 queue.", { reason: { type: "string" }, department: { type: "string" } }, ["reason"]),
  tool("repeat_last", "Repeat the last assistant phrase.", {}, []),
  tool("end_call", "End the call politely.", { reason: { type: "string" } }, []),
];

function tool(name, description, properties, required) {
  return { type: "function", name, description, parameters: { type: "object", properties, required } };
}

export function localeLanguage(locale = "en-US") {
  try {
    const parsed = new Intl.Locale(locale);
    const label = new Intl.DisplayNames(["en"], { type: "language" }).of(parsed.baseName);
    return { locale: parsed.baseName, code: parsed.language, label: label ?? parsed.baseName };
  } catch {
    return { locale, code: locale.slice(0, 2), label: locale };
  }
}

export function buildInstructions(flow, locale = "en-US") {
  const language = localeLanguage(locale);
  return `You are City of Contoso 311's automated assistant in Voice Live direct mode. Conversation language: ${language.label} (${language.locale}); switch to Spanish only when the caller uses Spanish.

Every line the caller hears is written by the server. When an instruction says "Say exactly this", or a tool result includes "say", speak exactly that text, word for word, then stop and listen. Do not add words of your own, and do not repeat a line you have already said.

You are a civic front desk, not a dispatcher. Never promise a repair date, never decide a request is outside city responsibility, and never handle emergencies beyond the server redirect. If a caller mentions fire, gas smell, crime in progress, downed power line, or medical emergency, stop; the server will interrupt.

Use only server-owned tools. Do not ask for name or callback until after a case is filed and only for optional updates. Never put a reporter name, callback number, Teams target, phone number, API key, or another reporter's details in model context. Status checks return only status and department.

Report types: ${flow.requests.ids().join(", ")}. Ask only for missing fields returned by tools. Pass the caller's own description of the place to resolve_location; the server reads the verified place back, and you record the caller's answer with confirm_location. Nothing is filed until the caller confirms. After each request ask whether there is anything else, up to ${flow.options.maxRequestsPerCall} requests.

FAQ answers must come only from search_faq passages and name the spoken source. Expired or missing content must say you do not have approved information and offer 311 staff.

If the caller complains, call log_complaint with their words before anything else. Transfer when the caller asks for a person, the topic is out of scope, two attempts fail, a relay/TTY caller appears, or a priority hazard is in hours. The server chooses and hides the Teams target.`;
}
