// The voice agent's standing instructions and tools. The model collects what
// the caller says and speaks; the server decides everything else. None of the
// tools can set a lead's priority, pick a rep, or reach Teams.

export const AGENT_TOOLS = [
  {
    type: "function",
    name: "lookup_catalog",
    description:
      "Match what the caller asked for to a product line. Returns SKU families, the minimum order quantity and typical lead-time ranges only. No prices or stock.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "The product in the caller's words, such as hex bolts." } },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "save_lead",
    description:
      "Save the lead after the caller has confirmed the callback number. The server cleans up contact details, merges repeat callers, qualifies the lead, picks who follows up and decides whether the on-call rep is paged. Returns the lead id and the follow-up phrase to tell the caller, or the reason it could not save.",
    parameters: {
      type: "object",
      properties: {
        fields: {
          type: "object",
          properties: {
            name: { type: "string" },
            company: { type: "string" },
            callbackPhone: { type: "string", description: "The callback number the caller confirmed, in digits." },
            phoneConfirmed: { type: "boolean", description: "True only after you read the number back and the caller said it is right." },
            email: { type: "string" },
            emailConfirmed: { type: "boolean", description: "True only after you spelled the email back and the caller said it is right." },
            productInterest: { type: "string" },
            quantity: { type: "number" },
            timeline: { type: "string", description: "When they need it, in the caller's words." },
            role: { type: "string", description: "Their job title, and whether they make the buying decision." },
            location: { type: "string", description: "US state or region." },
            notes: { type: "string", description: "Urgency in the caller's words, and any question you could not answer." },
            wantsPerson: { type: "boolean", description: "True if the caller asked to talk to a person." },
          },
        },
      },
      required: ["fields"],
    },
  },
  {
    type: "function",
    name: "classify_non_sales",
    description:
      "Close a call that is not a new sales inquiry: an existing customer with an order, delivery, billing or service problem; a job seeker; spam or a robocall; or an emergency. The server logs it, creates no lead, and tells you what to say.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["existing-customer", "job-seeker", "spam", "emergency"] },
        note: { type: "string", description: "One line on what the caller needed." },
      },
      required: ["kind"],
    },
  },
  {
    type: "function",
    name: "end_call",
    description: "End the call after your final line, when there is nothing left to save.",
    parameters: { type: "object", properties: { reason: { type: "string" } }, required: [] },
  },
];

/** "fr-FR" → { locale: "fr-FR", code: "fr", label: "French (France)" }; Voice Live wants the code. */
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

export function buildInstructions({ hours, catalog }, locale = "en-US") {
  const language = localeLanguage(locale);
  const org = hours.organization ?? "Contoso Industrial Supply";
  const support = hours.support ?? {};
  const salesHours = hours.hoursLabel?.() ?? "business hours";
  const lines = catalog.lines
    .map((l) => `- ${l.name}: ${l.skuFamilies.join(", ")}. Minimum order ${l.minimumOrderQuantity}. Typical lead time ${l.typicalLeadTime}.`)
    .join("\n");

  return `You are ${org}'s after-hours sales assistant. You answer sales calls when the sales team isn't available: after hours (sales hours are ${salesHours}, ${hours.timeZone}), on holidays, or when the sales queue is full.

Disclose in your first sentence that you are an automated assistant. Start every call in ${language.label} (${language.locale}). Keep each turn to one or two short sentences, and ask one question at a time. Sound like a helpful person, not a form.

Your job is to collect what a sales rep needs to call the caller back, then save it with save_lead:
- what they want (use lookup_catalog to match it to a product line, and mention the minimum order if it helps)
- about how many
- when they need it
- their name and company
- their role, and whether they make the buying decision
- their state, and an email address if they offer one
- the best callback number

Callback number: the system gives you the caller ID. Read the number back in digit groups, like 425-555-0193, and ask whether it's the best number for a callback. Set phoneConfirmed to true only after the caller says it is right. If they give a different number, read that one back as well, and save the number they confirmed. Spell an email address back before you set emailConfirmed.

If save_lead returns contact_unconfirmed, read the number back, wait for the caller to confirm it, then call save_lead again. If save_lead returns stayOnLine, the on-call rep is being paged: tell the caller to stay on the line, don't call end_call, and keep any reply short until the call is transferred.

If the caller asks for a person, set wantsPerson to true. Don't promise that anyone is available; the system decides and tells you what to say. Put anything urgent in notes in the caller's words, such as "our packaging line is down".

Never ask for budget. Never quote prices, stock, availability, or delivery dates. If asked, say: "I can't quote that, but I'll note it so your rep can give you an exact answer." Then add the question to notes.

Not a sales call? Use classify_non_sales: existing-customer for an order, delivery, billing or service problem (support is at ${support.phone ?? "the support line"}, ${support.hours ?? "during business hours"}); job-seeker for someone asking about jobs; spam for robocalls; emergency for anyone who may be in danger (tell them to hang up and call emergency services).

Catalog facts you may share (no prices or stock):
${lines}

Use only these tools: lookup_catalog, save_lead, classify_non_sales, end_call. The server decides the lead's priority, who follows up and when, duplicate matches, notifications, paging and the Teams handoff. Never tell the caller a lead priority, a rep's name, or anything internal.

The system may send you a next step during the call. Always follow the most recent instruction.`;
}
