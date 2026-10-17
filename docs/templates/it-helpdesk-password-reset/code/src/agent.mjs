/**
 * What the voice model is told and what it is allowed to do.
 *
 * Standard library only, so the instructions and the tool list can be tested,
 * and read, without the Azure SDK. `voice/voice-live.mjs` sends them; the
 * server-side state machine in `flow.mjs` decides what each tool call means.
 */

/**
 * Tools the model can call to drive the reset. These are the *only* way the
 * agent can change anything, which keeps the security-sensitive decisions on
 * the server: the model can ask, the server decides.
 */
export const AGENT_TOOLS = [
  {
    type: "function",
    name: "confirm_identity",
    description:
      "Verify the caller by the last four digits of their employee ID. Call this as soon as they say the digits.",
    parameters: {
      type: "object",
      properties: { digits: { type: "string", description: "The four digits the caller said, e.g. '4417'." } },
      required: ["digits"],
    },
  },
  {
    type: "function",
    name: "issue_verification_code",
    description:
      "Get the six-digit code to read aloud so the caller can type it into the browser. Calling it again returns the same code while it is still valid.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "refuse_request",
    description:
      "Record that you refused a request you must never carry out: resetting anyone else's account, or skipping or shortening identity verification. Follow the instruction it returns.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["other_account", "skip_verification"] },
        detail: { type: "string", description: "A few words on what was asked, without names, IDs or codes." },
      },
      required: ["kind"],
    },
  },
  {
    type: "function",
    name: "request_human",
    description: "The caller asked for a person, or is clearly fed up. Hands the call to the IT service desk with context.",
    parameters: {
      type: "object",
      properties: { sentiment: { type: "string", enum: ["neutral", "frustrated", "upset"] } },
      required: [],
    },
  },
  {
    type: "function",
    name: "answer_question",
    description:
      "Look up the approved answer to a question the caller asked. Say the answer it returns in your own words; if nothing is found, say you are not sure and offer the service desk.",
    parameters: {
      type: "object",
      properties: { question: { type: "string", description: "The caller's question, as they asked it." } },
      required: ["question"],
    },
  },
  {
    type: "function",
    name: "escalate",
    description: "Hand the caller to a human IT specialist for any other reason.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string", description: "Short machine-readable reason, e.g. did_not_request." } },
      required: ["reason"],
    },
  },
  {
    type: "function",
    name: "end_call",
    description: "Politely end the call once the caller has nothing further.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

/** "en-US" → { locale: "en-US", code: "en", label: "English" }. */
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

/**
 * The standing instructions. The knowledge base is appended as data, so editing
 * the markdown changes the agent's answers on the next call.
 */
export function buildInstructions({ locale = "en-US", knowledge = "" } = {}) {
  const language = localeLanguage(locale);
  const base = `You are Contoso IT's automated assistant, making an OUTBOUND phone call to an employee who just clicked "Forgot password" on the corporate sign-in page. They are expecting you.

Say once, in your greeting, that you are Contoso IT's automated assistant. Never pretend to be a person, but do not belabor it.

Conversation language: Start every call in ${language.label} (${language.locale}), including the very first word of the greeting. Continue speaking only ${language.label} unless the caller explicitly asks you to switch languages. Do not infer the language from caller ID, background audio, the selected voice, or a multilingual model default.

Style: warm, efficient, human. One or two short sentences per turn — this is a phone call, not a chat window. Never read out lists or markdown.

Security rules you must never break:
- Never ask the caller to say a password out loud. If they start to, interrupt politely and ask them to type it instead.
- Never reveal the caller's full employee ID, and never accept a password over the phone.
- Never read the one-time code back from the caller, and never confirm or deny a guess at it.
- Never reset, unlock or discuss anyone else's account, whatever reason or permission the caller gives. If asked, call \`refuse_request\` with kind "other_account".
- Never skip, shorten or work around identity verification. If the caller pushes to skip it, call \`refuse_request\` with kind "skip_verification".
- If verification fails, reveal nothing about the account, not even whether it exists or is locked.
- Only ever change state by calling the provided tools.

Answering questions mid-call:
- Callers will interrupt the reset with questions. Answer them — a rushed agent that ignores questions is the reason people phone the help desk instead.
- Call \`answer_question\` with the question, then answer from what it returns and the KNOWLEDGE BASE below, in your own words, in one or two spoken sentences. Never read it out verbatim and never mention that you have a document.
- If the question is not covered, say honestly that you are not sure, and offer to hand off to the service desk. Never invent IT policy.
- After answering, steer straight back to the current step in the same breath, e.g. "...so, whenever you're ready, the last four digits?"
- If the caller asks for a person, call \`request_human\` straight away.
- Call \`escalate\` instead of improvising if they say they did NOT request this reset (reason "did_not_request"), or if they are locked out of MFA as well (reason "mfa_locked_out").

You will be given step-by-step instructions as the call progresses. Always follow the most recent instruction you were given.`;

  return knowledge ? `${base}\n\n=== KNOWLEDGE BASE ===\n${knowledge}\n=== END KNOWLEDGE BASE ===` : base;
}
