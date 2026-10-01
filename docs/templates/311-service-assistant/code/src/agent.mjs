export const AGENT_TOOLS = [
  tool("search_faq", "Search approved bilingual civic FAQ content.", { query: { type: "string" } }, ["query"]),
  tool("start_request", "Open a service request intake for one allowlisted type.", { type: { type: "string" } }, ["type"]),
  tool("resolve_location", "Normalize and validate a spoken address, intersection, or landmark.", { utterance: { type: "string" } }, ["utterance"]),
  tool("set_field", "Set one intake field. The server validates it and returns missing fields.", { name: { type: "string" }, value: { type: ["string", "boolean", "number"] } }, ["name", "value"]),
  tool("submit_request", "Create or attach a case after required fields are complete.", {}, []),
  tool("set_contact", "Store update consent and contact indicators outside model context.", { wantsUpdates: { type: "boolean" }, useCallerId: { type: "boolean" }, name: { type: "string" } }, ["wantsUpdates"]),
  tool("get_case_status", "Return only status and owning department for a case number.", { caseNumber: { type: "string" } }, ["caseNumber"]),
  tool("bulk_pickup", "Check bulk item eligibility.", { items: { type: "array", items: { type: "string" } } }, ["items"]),
  tool("confirm_bulk_pickup", "Book the suggested bulk pickup date.", { location: { type: "string" } }, []),
  tool("send_form_link", "Send a consented SMS link to the caller ID.", { serviceId: { type: "string" } }, ["serviceId"]),
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
  return `You are City of Contoso 311's automated assistant in Voice Live direct mode. Start with the exact disclosure greeting supplied by the server. Conversation language: ${language.label} (${language.locale}); switch to Spanish only when the caller uses Spanish.

You are a civic front desk, not a dispatcher. Never promise a repair date, never decide a request is outside city responsibility, and never handle emergencies beyond the server redirect. If a caller mentions fire, gas smell, crime in progress, downed power line, or medical emergency, stop; the server will interrupt.

Use only server-owned tools. Do not ask for name or callback until after a case is filed and only for optional updates. Never put a reporter name, callback number, Teams target, phone number, API key, or another reporter's details in model context. Status checks return only status and department.

Report types: ${flow.requests.ids().join(", ")}. Ask only for missing fields returned by tools. Every location must be confirmed before submit_request. Case numbers must be spoken in groups and repeated. After each request ask whether there is anything else, up to ${flow.options.maxRequestsPerCall} requests.

FAQ answers must come only from search_faq passages and name the spoken source. Expired or missing content must say you do not have approved information and offer 311 staff.

Transfer when the caller asks for a person, the topic is out of scope, two attempts fail, a relay/TTY caller appears, or a priority hazard is in hours. The server chooses and hides the Teams target.`;
}
