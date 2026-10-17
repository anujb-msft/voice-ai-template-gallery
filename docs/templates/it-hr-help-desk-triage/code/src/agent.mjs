/**
 * The voice model's tool surface. Every tool is a TriageFlow method: the model
 * proposes, the server decides who the caller is, what may be read out, the
 * ticket category and priority, and where the call goes.
 */
export const AGENT_TOOLS = [
  { type: "function", name: "classify", description: "Classify the caller's request into a fixed IT or HR topic. Call this first for every new request. If the result has clarify: true, the server has already asked the one clarifying question; pass the caller's answer to classify again.", parameters: { type: "object", properties: { utterance: { type: "string" } }, required: ["utterance"] } },
  { type: "function", name: "answer_question", description: "Read the approved answer for a topic whose action is answer. Never answer from your own knowledge.", parameters: { type: "object", properties: { topicId: { type: "string" }, locale: { type: "string", description: "Only when the caller asked for another language, for example es." } }, required: ["topicId"] } },
  { type: "function", name: "start_verification", description: "Send a one-time code to the caller's work email address so a phone caller can prove who they are.", parameters: { type: "object", properties: { email: { type: "string" } }, required: ["email"] } },
  { type: "function", name: "check_code", description: "Check the six digits the caller read back. You only learn whether it matched.", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
  { type: "function", name: "get_personal_answer", description: "The verified caller's own HR record: PTO balance, next pay date, benefits window or manager.", parameters: { type: "object", properties: { kind: { enum: ["pto_balance", "next_pay_date", "benefits_window", "manager_name"] } }, required: ["kind"] } },
  { type: "function", name: "propose_ticket", description: "Build a ticket for read-back. The server picks the category and priority.", parameters: { type: "object", properties: { topicId: { type: "string" }, description: { type: "string" }, impact: { enum: ["me", "team", "site"] }, blocked: { type: "boolean" } }, required: ["topicId", "description"] } },
  { type: "function", name: "file_ticket", description: "File the proposed ticket. Pass the caller's own words; nothing is filed without a clear yes.", parameters: { type: "object", properties: { proposalId: { type: "string" }, confirmation: { type: "string" } }, required: ["proposalId", "confirmation"] } },
  { type: "function", name: "get_my_tickets", description: "Ticket status for the caller. Pass ticketNumber when the caller names one, such as INC-004700; omit it to read all of their open tickets.", parameters: { type: "object", properties: { ticketNumber: { type: "string" } } } },
  { type: "function", name: "send_link", description: "Send the caller a Teams chat link to the article or ticket just discussed.", parameters: { type: "object", properties: { target: { type: "string", description: "An article id or a ticket number." } }, required: ["target"] } },
  { type: "function", name: "handoff_password_reset", description: "Account unlock or MFA re-registration: hand off to the password reset assistant, or file a ticket when none is configured.", parameters: { type: "object", properties: { intent: { enum: ["unlock", "mfa_reregister"] } }, required: ["intent"] } },
  { type: "function", name: "route", description: "Transfer to people. Use it when a topic's action is queue, or with reason asked_for_person when the caller asks for a person. The server may choose a different queue.", parameters: { type: "object", properties: { destination: { type: "string" }, reason: { type: "string" } }, required: ["destination"] } },
  { type: "function", name: "end_call", description: "End the call politely once the caller has nothing else.", parameters: { type: "object", properties: { reason: { type: "string" } } } },
];

export function localeLanguage(locale = "en-US") {
  return { code: locale.split("-")[0] || "en" };
}

export function buildInstructions(routing, locale = "en-US") {
  const destinations = (routing?.destinations ?? []).map((d) => `${d.id}: ${d.label}`).join("; ");
  return [
    `You are the ${routing?.organization ?? "Contoso"} IT and HR help line's automated assistant, on a phone call with an employee. The server has already greeted the caller and said that you are automated.`,
    "The server owns every decision: who the caller is, what may be read out, ticket category and priority, and where the call goes. Use only the tools; never answer policy or account questions from your own knowledge.",
    "For each new request, call classify, then the tool for the topic's action: answer → answer_question, personal → get_personal_answer, ticket → propose_ticket, handoff → handoff_password_reset, queue → route.",
    "When a tool result includes say, speak exactly that text to the caller and add no facts of your own. If a result has needsVerification, the server has already asked for the work email.",
    "Never ask for or repeat Teams IDs, phone numbers, one-time codes, employee IDs, device serial numbers, or the details of a sensitive HR matter. Sensitive HR is handled by the server; do not ask follow-up questions about it.",
    "Keep every reply short and plain: this is a phone call.",
    `Locale: ${locale}. Destinations: ${destinations}.`,
  ].join("\n");
}
