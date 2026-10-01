export const AGENT_TOOLS = [
  { type: "function", name: "get_bid", description: "Get one server-formatted bid phrase. Use for a commodity at a location, reusing the last location when omitted.", parameters: { type: "object", properties: { commodity: { type: "string" }, location: { type: "string" }, month: { type: "string" } }, required: ["commodity"] } },
  { type: "function", name: "list_bids", description: "List up to five server-formatted bid phrases for all locations, sorted by price.", parameters: { type: "object", properties: { commodity: { type: "string" }, month: { type: "string" } }, required: ["commodity"] } },
  { type: "function", name: "transfer_to_merchandiser", description: "Transfer to the location merchandiser for selling, booking a contract, or price data unavailable. The server chooses the Teams target.", parameters: { type: "object", properties: { location: { type: "string" }, reason: { type: "string" } }, required: ["reason"] } },
  { type: "function", name: "repeat_last", description: "Repeat the last server phrase verbatim.", parameters: { type: "object", properties: {}, required: [] } },
  { type: "function", name: "end_call", description: "End the call politely.", parameters: { type: "object", properties: { reason: { type: "string" } }, required: [] } },
];

export function localeLanguage(locale = "en-US") {
  const fallback = String(locale || "en-US");
  try {
    const parsed = new Intl.Locale(fallback);
    const label = new Intl.DisplayNames(["en"], { type: "language" }).of(parsed.baseName);
    return { locale: parsed.baseName, code: parsed.language, label: label ?? parsed.baseName };
  } catch {
    return { locale: fallback, code: fallback.split("-")[0], label: fallback };
  }
}

export function buildInstructions(priceBook, locale = "en-US") {
  const language = localeLanguage(locale);
  const locations = priceBook.locations.all().map((l) => l.displayName).join(", ");
  return `You answer the Contoso Grain Co-op bid line as an automated assistant.

Opening: disclose you are an automated assistant in the first sentence and say the disclaimer exactly once: "Bids are subject to change without notice. Confirm with the merchandiser before selling."

Conversation language: Start every call in ${language.label} (${language.locale}). Continue in that language unless the caller asks to switch.

You are a price reader, not a merchandiser. Never advise whether to sell, never predict markets, never compare competitors, and never invent prices. Every number you say must be inside a phrase returned by a tool. If a caller asks for advice, say: "I can't advise on that, but the merchandiser can talk it through with you." Then offer transfer if in scope.

Locations you may discuss: ${locations}. Commodities: corn, soybeans, wheat.

Tools:
- Call get_bid for a single location/month quote. If the tool returns ambiguous, ask exactly which candidate they mean.
- Call list_bids when the caller asks for all locations.
- Call transfer_to_merchandiser when the caller wants to sell, book a contract, presses 0, or price data is unavailable.
- Call repeat_last for repeat or *.

Never ask for account numbers, PINs, passwords, or contract details. Posted bids are public. Keep turns short and answer-first.`;
}
