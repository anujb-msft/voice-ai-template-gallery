export const AGENT_TOOLS = [
  { type:"function", name:"lookup_catalog", description:"Look up product line information. Returns SKU families, MOQ, and typical lead-time ranges only — no price or stock.", parameters:{ type:"object", properties:{ query:{ type:"string" } }, required:["query"] } },
  { type:"function", name:"save_lead", description:"Save a captured sales lead. The server normalizes contacts, deduplicates, qualifies, assigns internally, and creates notifications. The model receives only the lead id and SLA phrase.", parameters:{ type:"object", properties:{ fields:{ type:"object", additionalProperties:true } }, required:["fields"] } },
  { type:"function", name:"classify_non_sales", description:"Log and close a non-sales call: existing customer/order issue, spam, or emergency.", parameters:{ type:"object", properties:{ kind:{ type:"string", enum:["existing-customer","spam","emergency"] }, note:{ type:"string" } }, required:["kind"] } },
  { type:"function", name:"end_call", description:"End the call once complete.", parameters:{ type:"object", properties:{ reason:{ type:"string" } }, required:[] } },
];

export function localeLanguage(locale = "en-US") {
  const fallback = String(locale || "en-US");
  try { const parsed = new Intl.Locale(fallback); const label = new Intl.DisplayNames(["en"], { type:"language" }).of(parsed.baseName); return { locale:parsed.baseName, code:parsed.language, label:label ?? parsed.baseName }; }
  catch { return { locale:fallback, code:fallback.split("-")[0], label:fallback }; }
}

export function buildInstructions({ hours, catalog }, locale = "en-US") {
  const language = localeLanguage(locale);
  const lines = catalog.lines.map((l)=>`- ${l.name}: ${l.skuFamilies.join(", ")}; MOQ ${l.minimumOrderQuantity}; typical lead time ${l.typicalLeadTime}`).join("\n");
  return `You are Contoso Industrial Supply's after-hours sales lead capture assistant.

Disclose in the first sentence that you are an automated assistant. Start every call in ${language.label} (${language.locale}). Keep turns short and conversational.

Goal: capture a sales lead for a callback. Ask for product interest, quantity or volume, timeline, company, role, location or state, callback phone, and email. Confirm phone by reading it back in groups. Spell back email before saving.

Never ask for budget. Never quote prices, stock, availability, or delivery commitments. If asked, say: "I can't quote that, but I'll note it so your rep can give you an exact answer." Then include it in notes.

Non-sales: existing customers with order/service issues get support at ${hours.support.phone}, ${hours.support.hours}. Emergencies should hang up and call emergency services. Spam or robocalls should be closed politely.

Available catalog facts only (no pricing or stock):
${lines}

Use only these tools: lookup_catalog, save_lead, classify_non_sales, end_call. The server computes score, owner, SLA, duplicate matches, notifications, and handoff context. Never tell the caller a score or owner name.`;
}
