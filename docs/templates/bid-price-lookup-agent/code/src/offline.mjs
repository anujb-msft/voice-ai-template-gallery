import { normalize } from "./pricing.mjs";

export function registerSimulatedAgent(_flow, _callId) {
  // Flow.#speak records the same transcript line the real model would have spoken.
}

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
  for (const m of ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]) {
    if (t.includes(m)) return m;
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
  if (/\briver\b/.test(t)) return "river";
  return null;
}

export function wantsTransfer(text) { return /\b(sell|sold|contract|book|merchandiser|person|human|operator|transfer)\b/i.test(text); }
export function wantsAdvice(text) { return /\b(should i|market going|forecast|predict|good price|better price|wait)\b/i.test(text); }
export function wantsAllLocations(text) { return /\b(all locations|every location|best price|top bids|bid board)\b/i.test(text); }
export function wantsRepeat(text) { return /\b(repeat|say that again|again|slower)\b/i.test(text) || String(text).trim() === "*"; }

export function handleUtterance(flow, callId, text) {
  const said = String(text ?? "").trim();
  if (!said) return flow.noInput(callId);
  flow.pushTranscript(callId, "caller", said);
  if (said === "*" || wantsRepeat(said)) return flow.repeatLast(callId);
  if (/^[0-9]$/.test(said)) return flow.dtmf(callId, said);
  if (wantsAdvice(said)) return flow.adviceBoundary(callId);
  const commodity = parseCommodity(said);
  const location = parseLocation(said, flow.priceBook);
  const month = parseMonth(said);
  if (wantsTransfer(said)) return flow.transferToMerchandiser(callId, { location, reason: /contract|book|sell|sold/i.test(said) ? "sell_request" : "caller_requested" });
  if (wantsAllLocations(said) && commodity) return flow.listBids(callId, { commodity, month });
  if (commodity) return flow.getBid(callId, { commodity, location, month });
  return flow.noInput(callId);
}
