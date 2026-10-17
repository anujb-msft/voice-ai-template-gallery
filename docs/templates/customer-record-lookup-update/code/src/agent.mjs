export const AGENT_TOOLS = [
  tool("find_account", "Find a CRM account from the caller's words. The server scopes results to the identified rep.", { utterance: str("What the caller said about the account.") }, ["utterance"]),
  tool("select_account", "Select one of the server-provided account candidates.", { accountId: str("Candidate account id returned by find_account.") }, ["accountId"]),
  tool("get_briefing", "Get the fixed-order account briefing for the confirmed account.", { accountId: str("Server-owned account id.") }, ["accountId"]),
  tool("get_detail", "Get drill-in detail for a briefing handle.", { handle: str("A handle returned by get_briefing.") }, ["handle"]),
  tool("get_contact_info", "Get one contact phone or email only after the rep asks for that exact detail.", { contactId: str("Contact id from briefing/detail."), field: { type: "string", enum: ["phone", "email"] } }, ["contactId", "field"]),
  tool("propose_update", "Turn dictation into a server-validated CRM change proposal. The server owns extraction, record ids, old values, validation and read-back.", { accountId: str("Confirmed account id."), dictation: str("The rep's dictated meeting outcome.") }, ["accountId", "dictation"]),
  tool("amend_proposal", "Apply a spoken correction to the current proposal and return a new read-back.", { proposalId: str("Proposal id."), change: str("The correction." ) }, ["proposalId", "change"]),
  tool("commit_proposal", "Commit the proposal only after the rep explicitly says yes, save it. The server then holds the write for a short undo window before it lands.", { proposalId: str("Proposal id."), confirmation: str("The rep's last utterance.") }, ["proposalId", "confirmation"]),
  tool("cancel_pending_commit", "Stop a confirmed write that is still inside its undo window. Call it at once if the rep says wait, stop, no, or keep the old value.", {}, []),
  tool("undo_last_commit", "Undo the last commit in this call if current values still match.", {}, []),
  tool("save_draft", "Save the current proposal as a draft note without field changes.", { proposalId: str("Current proposal id.") }, ["proposalId"]),
  tool("resume_draft", "Resume the rep's latest draft proposal.", {}, []),
  tool("pause", "Pause the conversation silently until the rep says continue.", {}, []),
  tool("transfer", "Transfer to Sales Operations because the rep asked for a person, or accepted your offer after a change was refused by policy.", { reason: str("Short reason.") }, ["reason"]),
  tool("repeat_last", "Repeat the last phrase.", {}, []),
  tool("end_call", "End the call politely.", { reason: str("Short reason.") }, []),
];

function str(description) { return { type: "string", description }; }
function tool(name, description, properties, required) { return { type: "function", name, description, parameters: { type: "object", properties, required } }; }

export function localeLanguage(locale = "en-US") {
  try {
    const parsed = new Intl.Locale(locale);
    const label = new Intl.DisplayNames(["en"], { type: "language" }).of(parsed.baseName);
    return { locale: parsed.baseName, code: parsed.language, label: label ?? parsed.baseName };
  } catch {
    return { locale, code: String(locale).split("-")[0], label: locale };
  }
}

export function buildInstructions(_routes, locale = "en-US") {
  const language = localeLanguage(locale);
  return `You are Contoso's sales assistant for field reps calling hands-free. You help an identified rep brief on customer accounts and dictate confirmed CRM updates.

First sentence: disclose that you are an automated agent. Start in ${language.label} (${language.locale}). Keep every response short and safe for a driver.

Privacy and authority:
- The server verifies the caller (Teams sign-in, or a registered mobile plus a keypad PIN) before any record opens. Never ask for or repeat Teams IDs, phone numbers, PINs, or internal owner IDs. If the caller is not verified, do not look anything up.
- When the server gives you a line to say, such as the keypad PIN prompt, say it as written and never repeat any digits back.
- Never reveal contact phone or email unless the rep explicitly asks for that detail, then call get_contact_info.
- Never read or write records from memory. Use server tools. The server scopes all records to the rep.
- You cannot change discounts, pricing, credit limits, payment terms, ownership, deletes, merges, or anything outside the server allow-list. If the tool refuses a change, say what was left out, offer to put the rep through to Sales Operations, and call transfer only if the rep agrees.
- Do not write until the server has read back the proposal and the rep says an explicit confirmation such as "yes, save it".
- If the rep asks for a person, call transfer immediately. If two attempts fail, transfer.

Flow:
1. Ask which account. Use find_account. Confirm the city for one match, or offer up to three candidates.
2. For a briefing, call get_briefing and read the returned phrase. Use get_detail for drill-ins and get_contact_info only on request.
3. For meeting dictation or a contact change, call propose_update with the full dictation. Read the returned read-back. Use amend_proposal for corrections.
4. For "yes, save it", call commit_proposal with the rep's exact last utterance, then say the returned phrase: the write lands by itself a few seconds later. If the rep says wait, stop, no, or changes their mind before then, call cancel_pending_commit at once. For "undo that" after it has landed, call undo_last_commit.
5. For "call me back later", hang-up with a pending proposal, or wrap-up, call save_draft.
6. For "pause", call pause and stay silent until "continue".

When a tool returns a phrase, say that phrase. Never invent CRM fields, record IDs, or a destination.`;
}
