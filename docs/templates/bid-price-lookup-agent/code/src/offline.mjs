import { normalize } from "./pricing.mjs";

/**
 * Simulation mode has no model: this parser turns typed (or scripted) caller lines into the same flow
 * calls the Voice Live tools make. It only extracts commodity, location and month; every number the
 * caller hears still comes from the server-formatted quote.
 */
export function registerSimulatedAgent(_flow, _callId) {
  // The flow already puts each server phrase on the transcript, exactly as the model would say it.
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_ABBREVIATIONS = { jan: "january", feb: "february", mar: "march", apr: "april", jun: "june", jul: "july", aug: "august", sep: "september", sept: "september", oct: "october", nov: "november", dec: "december" };
const TERMINAL_STATES = new Set(["transferred", "ended"]);

export function parseCommodity(text) {
  const t = normalize(text);
  if (/\b(corn|maize)\b/.test(t)) return "corn";
  if (/\b(soybeans?|beans?|soys)\b/.test(t)) return "soybeans";
  if (/\bwheat\b/.test(t)) return "wheat";
  return null;
}

export function parseMonth(text) {
  const t = normalize(text);
  if (/\b(spot|nearby|current)\b/.test(t)) return "spot";
  for (const m of MONTHS) {
    if (!new RegExp(`\\b${m}\\b`).test(t)) continue;
    if (m === "may" && /\bmay (i|we|be|have)\b/.test(t)) continue;
    return m;
  }
  for (const [short, m] of Object.entries(MONTH_ABBREVIATIONS)) {
    if (new RegExp(`\\b${short}\\b`).test(t)) return m;
  }
  const ym = /\b(20\d{2})[- ](0[1-9]|1[0-2])\b/.exec(t);
  return ym ? `${ym[1]}-${ym[2]}` : null;
}

export function parseLocation(text, priceBook) {
  const t = normalize(text);
  for (const loc of priceBook.locations.all()) {
    const names = [loc.displayName, loc.id, ...(loc.aliases ?? [])].map(normalize).sort((a, b) => b.length - a.length);
    for (const name of names) {
      if (name && new RegExp(`\\b${name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`).test(t)) return name;
    }
  }
  // "The river elevator" names two locations; the price book asks which one instead of guessing.
  if (/\briver\b/.test(t)) return "river";
  return null;
}

const said = (text) => String(text ?? "").trim();

export function wantsAdvice(text) {
  return /\b(should (i|we)|do you think|is (it|this|that) a good|good (price|time)|better price|market (going|headed|doing)|forecast|predict|or wait|wait (for|until|and see)|hold off)\b/i.test(said(text));
}
export function wantsContract(text) { return /\b(lock(ed|ing)?|hedg(e|ed|ing)|contract(s|ed|ing)?|book(ed|ing)?)\b/i.test(said(text)); }
export function wantsSell(text) { return /\b(sell|selling|sold)\b/i.test(said(text)); }
export function wantsCallback(text) {
  const t = said(text);
  if (/\b(i'?ll|i will|we'?ll|we will) call( you)? back\b/i.test(t)) return false;
  return /\b(call(s|ing)? me back|call ?back|have (them|someone|somebody|him|her|the merchandiser|a merchandiser) call)\b/i.test(t);
}
export function wantsPerson(text) { return /\b(merchandiser|person|human|someone|somebody|operator|representative|transfer|connect( me)?|talk to|speak (to|with))\b/i.test(said(text)); }
export function wantsTransfer(text) { return wantsContract(text) || wantsSell(text) || wantsPerson(text); }
export function wantsAllLocations(text) {
  return /\b(all (the )?(locations|elevators)|every (location|elevator)|each location|everywhere|best\b[\w\s]{0,20}\b(price|bid)s?|highest\b[\w\s]{0,20}\b(price|bid)s?|top bids|bid board)\b/i.test(said(text));
}
export function wantsRepeat(text) { return /\b(repeat|again|come again|one more time|slower|pardon)\b/i.test(said(text)) || said(text) === "*"; }
export function isAffirmative(text) {
  return /^(yes|yeah|yep|yup|sure|ok(ay)?|please( do)?|go ahead|do it|do that|that works|sounds good|alright|all right|absolutely|definitely)\b/i.test(said(text));
}
export function wantsToEnd(text) {
  const t = said(text);
  return /^(no|nope|nah)\b[\s,.!]*(thanks?|thank you)?[.!]*$/i.test(t)
    || /^(thanks|thank you)[.!]*$/i.test(t)
    || /\b(that'?s (all|it|everything)|nothing else|i'?m (good|done|all set)|all set|good ?bye|bye|hang up|never ?mind|no,? thanks?|no,? thank you)\b/i.test(t);
}

/** One caller line in simulation. Guardrails come first, so "lock that in" is never read as a quote request. */
export function handleUtterance(flow, callId, text) {
  const call = flow.get(callId);
  if (!call) return { ok: false, reason: "unknown_call" };
  if (TERMINAL_STATES.has(call.state)) return { ok: false, reason: "call_ended", message: "This call has already ended." };
  const line = said(text);
  if (!line) return flow.noInput(callId);
  flow.pushTranscript(callId, "caller", line);
  if (/^[0-9*#]$/.test(line)) return flow.dtmf(callId, line);

  const commodity = parseCommodity(line);
  const location = parseLocation(line, flow.priceBook);
  const month = parseMonth(line);
  const pending = call.pending;

  if (wantsAdvice(line)) return flow.adviceBoundary(callId);
  if (wantsContract(line)) return flow.transferToMerchandiser(callId, { location, reason: "contract_request" });
  if (wantsSell(line)) return flow.transferToMerchandiser(callId, { location, reason: "sell_request" });
  if (wantsCallback(line)) return flow.requestCallback(callId, { location });
  if (wantsPerson(line)) return flow.transferToMerchandiser(callId, { location, reason: "caller_requested" });

  if (pending?.kind === "offer") {
    if (isAffirmative(line)) return flow.acceptOffer(callId);
    if (wantsToEnd(line)) return flow.endCall(callId, "caller_done");
  }
  if (pending?.kind === "quote" && pending.suggestMonth && isAffirmative(line) && !commodity && !location) {
    return flow.getBid(callId, { month: pending.suggestMonth });
  }
  if (wantsRepeat(line) && !commodity && !location) return flow.repeatLast(callId);
  if (wantsToEnd(line) && !commodity && !location) return flow.endCall(callId, "caller_done");
  if (wantsAllLocations(line)) return flow.listBids(callId, { commodity, month });
  if (pending?.kind === "transfer" && location) return flow.transferToMerchandiser(callId, { location });
  if (pending?.kind === "list" && (commodity || month)) return flow.listBids(callId, { commodity, month });
  if (commodity || location || month) return flow.getBid(callId, { commodity, location, month });
  return flow.noInput(callId);
}