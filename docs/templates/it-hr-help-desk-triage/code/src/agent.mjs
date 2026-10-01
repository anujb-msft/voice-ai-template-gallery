export const AGENT_TOOLS = [
  { type:"function", name:"classify", description:"Classify a final caller utterance into a fixed IT/HR topic.", parameters:{ type:"object", properties:{ utterance:{ type:"string" } }, required:["utterance"] } },
  { type:"function", name:"answer_question", description:"Return an approved KB answer for a topic.", parameters:{ type:"object", properties:{ topicId:{ type:"string" }, question:{ type:"string" } }, required:["topicId"] } },
  { type:"function", name:"start_verification", description:"Start PSTN verification using a work email.", parameters:{ type:"object", properties:{ email:{ type:"string" } }, required:["email"] } },
  { type:"function", name:"check_code", description:"Check a one-time code. The model sees only success or failure.", parameters:{ type:"object", properties:{ code:{ type:"string" } }, required:["code"] } },
  { type:"function", name:"get_personal_answer", description:"Get the verified caller's own HRIS answer.", parameters:{ type:"object", properties:{ kind:{ enum:["pto_balance","next_pay_date","benefits_window","manager_name"] } }, required:["kind"] } },
  { type:"function", name:"propose_ticket", description:"Build a ticket proposal for read-back.", parameters:{ type:"object", properties:{ topicId:{ type:"string" }, description:{ type:"string" }, impact:{ enum:["me","team","site"] }, blocked:{ type:"boolean" } }, required:["topicId","description"] } },
  { type:"function", name:"file_ticket", description:"File a proposed ticket after explicit confirmation.", parameters:{ type:"object", properties:{ proposalId:{ type:"string" }, confirmation:{ type:"string" } }, required:["proposalId","confirmation"] } },
  { type:"function", name:"get_my_tickets", description:"Read statuses for the verified caller's own tickets.", parameters:{ type:"object", properties:{} } },
  { type:"function", name:"send_link", description:"Send a Teams chat link for an article or ticket.", parameters:{ type:"object", properties:{ target:{ type:"string" } }, required:["target"] } },
  { type:"function", name:"handoff_password_reset", description:"Transfer to password reset assistant or file fallback ticket.", parameters:{ type:"object", properties:{ intent:{ enum:["unlock","mfa_reregister"] } }, required:["intent"] } },
  { type:"function", name:"route", description:"Transfer to a configured destination.", parameters:{ type:"object", properties:{ destination:{ type:"string" }, reason:{ type:"string" } }, required:["destination"] } },
  { type:"function", name:"end_call", description:"End the call politely.", parameters:{ type:"object", properties:{ reason:{ type:"string" } } } }
];
export function localeLanguage(locale = "en-US") { return { code: locale.split("-")[0] || "en" }; }
export function buildInstructions(routing, locale = "en-US") {
  const destinations = (routing?.destinations ?? []).map((d)=>`${d.id}: ${d.label}`).join("; ");
  return `You are the Contoso IT and HR help line automated assistant. Disclose you are automated in the opening line. Use server-owned tools only. Never ask for or repeat Teams IDs, phone numbers, OTPs, employee IDs, device serial numbers, or sensitive HR details. Sensitive HR is handled by the server. Locale: ${locale}. Destinations: ${destinations}.`;
}
