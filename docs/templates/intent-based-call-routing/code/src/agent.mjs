/**
 * What the model is allowed to do, and what it is told.
 *
 * Deliberately free of transport imports so the tool surface and the standing
 * instructions can be inspected and tested without installing the WebSocket or
 * Azure SDKs. `src/voice/voice-live.mjs` is what puts these on the wire.
 */


/**
 * The only levers the model has.
 *
 * Note what is absent: there is no tool that takes a phone number, a Teams
 * object id, or a URL. The model may propose an id from a fixed list and
 * nothing more, so the worst a confused — or deliberately misled — agent can do
 * is send someone to the wrong internal queue.
 */
export const AGENT_TOOLS = [
  {
    type: "function",
    name: "propose_route",
    description:
      "Name the destination you believe the caller needs. Call this as soon as you have a view, even a tentative one — report your honest confidence and let the server decide whether it is high enough to act on.",
    parameters: {
      type: "object",
      properties: {
        routeId: { type: "string", description: "One of the route ids you were given. Never invent one." },
        confidence: {
          type: "number",
          description:
            "0 to 1. Your genuine certainty that this is the right team. Use a low number when the caller has been vague — a clarifying question is cheaper than a wrong transfer.",
        },
        callTopic: {
          type: "string",
          description: "Under 48 characters, in the caller's own terms. Shown to the Teams agent before they answer.",
        },
        callSummary: {
          type: "string",
          description: "One sentence explaining what the caller needs, so nobody has to ask them twice.",
        },
        sentiment: {
          type: "string",
          enum: ["frustrated", "angry", "upset", "distressed"],
          description:
            "Only when the caller has explicitly said they are unhappy. Omit it otherwise — do not infer mood from tone of voice.",
        },
      },
      required: ["routeId", "confidence", "callTopic"],
    },
  },
  {
    type: "function",
    name: "confirm_route",
    description:
      "The caller agreed with the destination you just offered. Call this only after they have actually said yes.",
    parameters: {
      type: "object",
      properties: { routeId: { type: "string", description: "The route id you proposed." } },
      required: ["routeId"],
    },
  },
  {
    type: "function",
    name: "request_human",
    description:
      "The caller asked for a person, or is too frustrated to continue. Call this immediately — do not ask them to confirm and do not try one more classifying question.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string", description: "Short machine-readable reason." } },
      required: ["reason"],
    },
  },
  {
    type: "function",
    name: "not_covered",
    description:
      "The caller asked a question none of your routes cover, such as a factual question about products, policy, or hours. Call this instead of answering it yourself.",
    parameters: {
      type: "object",
      properties: { question: { type: "string", description: "What they asked, briefly." } },
      required: ["question"],
    },
  },
  {
    type: "function",
    name: "take_message",
    description:
      "Record the caller's message. Only available after you have been told the team is closed and you have offered to take one.",
    parameters: {
      type: "object",
      properties: {
        callTopic: { type: "string", description: "Under 48 characters." },
        callSummary: { type: "string", description: "One sentence, including anything they asked you to pass on." },
      },
      required: ["callTopic", "callSummary"],
    },
  },
  {
    type: "function",
    name: "end_call",
    description: "End the call once there is nothing further to do.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

/**
 * The standing instructions. The route menu is injected from routes.json, so
 * adding a destination is a config change rather than a prompt rewrite.
 */
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

export function buildInstructions(routes, locale = "en-US") {
  const language = localeLanguage(locale);
  return `You are the automated switchboard for ${routes.organization}. You answer the main line, work out who the caller needs, and connect them. You are a receptionist, not a help desk.

Disclose what you are in your first sentence — say you are ${routes.organization}'s automated assistant. Never pretend to be a person, but do not belabour it either; say it once and move on.

Conversation language: Start every call in ${language.label} (${language.locale}), including the very first word of the greeting. Continue speaking only ${language.label} unless the caller explicitly asks you to switch languages. Do not infer the opening language from caller ID, tenant settings, background audio, the selected voice, or a multilingual model default.

Style: warm, brisk, human. One or two short sentences per turn. This is a phone call, so never read out lists, markdown, or route ids. Ask an open question first ("What can I help you with?") rather than reciting a menu — the whole point of this system is that the caller does not have to listen to one.

DESTINATIONS — you may only ever propose one of these ids:
${routes.menuText()}

How to route:
- Listen to what the caller actually wants, then call \`propose_route\` with your honest confidence. If you are unsure, say so in the number rather than guessing; the server will ask you to clarify instead of transferring.
- When you have a destination, offer it in plain language using the team's name and wait for a yes: "Sounds like Billing can sort that — shall I put you through?" Then call \`confirm_route\`.
- Never state a route id out loud. Say "Billing", not "billing route".
- If the caller asks for a person, or is clearly fed up, call \`request_human\` straight away. Making a frustrated caller answer another question is the exact experience this system exists to remove.
- If they ask something none of your destinations cover, call \`not_covered\`. Do not attempt an answer, do not speculate about products, pricing, policy or opening hours, and never invent anything.
- If the caller changes their mind before the transfer completes, just call \`propose_route\` again with the new destination.
- Keep it moving. If you have gone back and forth more than twice without getting anywhere, hand them to a person rather than persisting.

Caller identity:
- A name from caller ID is a convenience, never proof. Use it to greet them, never to release account information, and never read out an account number.
- Never ask for a password, a PIN, a full card number, or a date of birth. You do not need any of it to transfer a call.

You will be given a fresh instruction after each step. Always follow the most recent one.`;
}
