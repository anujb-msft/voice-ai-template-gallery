import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import { config } from "./config.mjs";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const resolvePath = (p) => (isAbsolute(p) ? p : join(PKG_ROOT, p));
const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const COMMODITY_ALIASES = new Map([
  ["corn", "corn"],
  ["maize", "corn"],
  ["soybeans", "soybeans"],
  ["soybean", "soybeans"],
  ["beans", "soybeans"],
  ["bean", "soybeans"],
  ["soys", "soybeans"],
  ["wheat", "wheat"],
]);
const COMMODITY_CHOICES = "corn, soybeans, or wheat";

function loadJson(path) {
  return JSON.parse(readFileSync(resolvePath(path), "utf8"));
}

export function normalize(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function toMinutes(hhmm) {
  const [h, m = 0] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

export function localParts(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    day: DAY_INDEX[parts.weekday],
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function isOpen(hours, now, timeZone) {
  const { day, minutes } = localParts(now, timeZone);
  if (!(hours?.days ?? []).includes(day)) return false;
  return minutes >= toMinutes(hours.open ?? "00:00") && minutes < toMinutes(hours.close ?? "24:00");
}

function formatTime(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "08:00" → "8 AM", "13:20" → "1:20 PM": how a time of day is said out loud. */
function clockPhrase(hhmm) {
  const [h, m = 0] = String(hhmm).split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  const suffix = h % 24 >= 12 ? "PM" : "AM";
  return m ? `${hour}:${String(m).padStart(2, "0")} ${suffix}` : `${hour} ${suffix}`;
}

function daysPhrase(days = [], names = DAY_NAMES) {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const consecutive = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (sorted.length > 2 && consecutive) return `${names[sorted[0]]} through ${names[sorted.at(-1)]}`;
  return andList(sorted.map((d) => names[d]));
}

/** "America/Chicago" → "Central Time". */
function zonePhrase(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longGeneric" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? timeZone;
  } catch {
    return timeZone ?? "local time";
  }
}

function formatDayTime(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function formatMonth(yyyyMm) {
  const [year, month] = String(yyyyMm).split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function monthLabel(month) {
  const text = String(month ?? "").trim();
  if (/^\d{4}-\d{2}$/.test(text)) return formatMonth(text);
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "that month";
}

function dollars(value) {
  return `$${Number(value).toFixed(2)}`;
}

function basisPhrase(cents, futuresMonth) {
  if (cents === 0) return `even with ${futuresMonth} futures`;
  return `${Math.abs(cents)} ${cents > 0 ? "over" : "under"} ${futuresMonth} futures`;
}

function ageLabel(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function orList(items) {
  const list = [...items];
  if (list.length <= 2) return list.join(" or ");
  return `${list.slice(0, -1).join(", ")}, or ${list.at(-1)}`;
}

export function andList(items) {
  const list = [...items];
  if (list.length <= 2) return list.join(" and ");
  return `${list.slice(0, -1).join(", ")}, and ${list.at(-1)}`;
}

function editDistance(a, b) {
  if (!a || !b) return Math.max(a.length, b.length);
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** A question back to the caller instead of a guess. The message is the exact question to ask. */
function clarify(reason, message, extra = {}) {
  return { ok: false, clarify: true, reason, message, ...extra };
}

export class LocationDirectory {
  constructor(doc) {
    this.organization = doc.organization ?? "Contoso Grain Co-op";
    this.defaultLocationId = doc.defaultLocationId ?? doc.locations?.[0]?.id;
    this.byId = new Map((doc.locations ?? []).map((l) => [l.id, l]));
    if (!this.byId.size) throw new Error("locations.json contains no locations");
  }

  static load(path = config.pricing.locationsPath) {
    return new LocationDirectory(loadJson(path));
  }

  all() { return [...this.byId.values()]; }
  get(id) { return this.byId.get(id) ?? null; }
  names() { return this.all().map((l) => l.displayName); }

  match(input, { lastLocationId = null } = {}) {
    if (!input && lastLocationId) return { ok: true, location: this.get(lastLocationId), reused: true };
    const q = normalize(input);
    if (!q) return { ok: false, reason: "missing_location" };

    const scored = [];
    for (const loc of this.all()) {
      const names = [loc.displayName, loc.id, ...(loc.aliases ?? [])].map(normalize);
      let score = Infinity;
      for (const name of names) {
        if (q === name) score = Math.min(score, 0);
        else if (name.includes(q) || q.includes(name)) score = Math.min(score, Math.abs(name.length - q.length) <= 3 ? 1 : 2);
        else score = Math.min(score, editDistance(q, name));
      }
      if (score <= 2) scored.push({ loc, score });
    }
    scored.sort((a, b) => a.score - b.score || a.loc.displayName.localeCompare(b.loc.displayName));
    if (!scored.length) return { ok: false, reason: "unknown_location", input };
    const best = scored[0].score;
    const candidates = scored.filter((s) => s.score <= best + 1).map((s) => s.loc);
    if (candidates.length > 1 && best > 0) return { ok: false, reason: "ambiguous", candidates };
    return { ok: true, location: scored[0].loc };
  }

  isMerchandiserOpen(id, now = new Date()) {
    const loc = this.get(id);
    return Boolean(loc && isOpen(loc.hours, now, loc.timeZone ?? "UTC"));
  }

  hoursPhrase(id) {
    const loc = this.get(id);
    const hours = loc?.hours;
    if (!loc || !hours) return "The merchandiser is closed right now.";
    return `The ${loc.displayName} merchandiser is available ${clockPhrase(hours.open)} to ${clockPhrase(hours.close)} ${zonePhrase(loc.timeZone)}, ${daysPhrase(hours.days)}.`;
  }

  /** The same hours, compact, for a screen: "Mon–Fri · 8 AM–5 PM". */
  hoursLabel(id) {
    const hours = this.get(id)?.hours;
    if (!hours) return "";
    const short = DAY_NAMES.map((d) => d.slice(0, 3));
    return `${daysPhrase(hours.days, short).replace(" through ", "–")} · ${clockPhrase(hours.open)}–${clockPhrase(hours.close)}`;
  }
}

export class FixtureFeed {
  constructor({ bidsPath = config.pricing.bidsPath, futuresPath = config.pricing.futuresPath, marketPath = config.pricing.marketPath } = {}) {
    this.bidsPath = bidsPath;
    this.futuresPath = futuresPath;
    this.marketPath = marketPath;
    this.feedDown = false;
  }
  get isDown() { return this.feedDown; }
  getBidSheet() {
    if (this.feedDown) throw new Error("price feed unavailable");
    return loadJson(this.bidsPath);
  }
  getFutures(symbols = []) {
    if (this.feedDown) throw new Error("price feed unavailable");
    const doc = loadJson(this.futuresPath);
    const wanted = new Set(symbols);
    return { ...doc, contracts: wanted.size ? doc.contracts.filter((c) => wanted.has(c.symbol)) : doc.contracts };
  }
  getMarket() { return loadJson(this.marketPath); }
  setFeedDown(value) { this.feedDown = Boolean(value); }
}

export class PriceBook {
  constructor({ locations = LocationDirectory.load(), feed = new FixtureFeed(), now = () => new Date(), options = {} } = {}) {
    this.locations = locations;
    this.feed = feed;
    this.now = now;
    this.options = {
      softStaleMinutes: config.pricing.futuresStaleMinutes,
      hardLimitMinutes: config.pricing.futuresHardLimitMinutes,
      minutesPerAutomatedCall: config.pricing.minutesPerAutomatedCall,
      ...options,
    };
  }

  health() {
    try {
      const bidSheet = this.feed.getBidSheet();
      const futures = this.feed.getFutures();
      const market = this.feed.getMarket();
      const now = this.now();
      const minAsOf = Math.min(...futures.contracts.map((c) => Date.parse(c.asOf)));
      return {
        ok: true,
        up: true,
        source: config.pricing.feed,
        bidSheetUpdatedAt: bidSheet.updatedAt,
        bidSheetAgeMinutes: Math.max(0, Math.round((now - Date.parse(bidSheet.updatedAt)) / 60_000)),
        futuresAsOf: new Date(minAsOf).toISOString(),
        futuresAgeMinutes: Math.max(0, Math.round((now - minAsOf) / 60_000)),
        staleAfterMinutes: this.options.softStaleMinutes,
        marketSessionState: this.marketState(now, market),
      };
    } catch (e) {
      return { ok: false, up: false, source: config.pricing.feed, error: e.message };
    }
  }

  commodity(input) {
    const text = normalize(input);
    for (const [alias, value] of COMMODITY_ALIASES) {
      if (text === alias || text.includes(alias)) return value;
    }
    return null;
  }

  availableCommodities() { return [...new Set(this.feed.getBidSheet().bids.map((b) => b.commodity))].sort(); }

  marketState(now = this.now(), market = this.feed.getMarket()) {
    const parts = localParts(now, market.timeZone ?? "UTC");
    if ((market.holidays ?? []).includes(parts.date)) return "holiday";
    return isOpen(market.sessionHours, now, market.timeZone ?? "UTC") ? "open" : "closed";
  }

  /**
   * One server-formatted quote. Anything unclear comes back as `clarify: true` with the one question
   * to ask; a feed failure comes back without a number. The agent never computes a price itself.
   */
  quote({ commodity, location, month = null, lastLocationId = null } = {}) {
    const cleanCommodity = this.commodity(commodity);
    if (normalize(commodity) && !cleanCommodity) {
      return clarify("unknown_commodity", `We don't post bids for that. I can quote ${COMMODITY_CHOICES} — which one?`);
    }

    let loc = null;
    let reused = false;
    if (normalize(location)) {
      const match = this.locations.match(location);
      if (!match.ok && match.reason === "ambiguous") {
        const names = match.candidates.map((l) => l.displayName);
        return clarify("ambiguous", `Did you mean ${orList(names)}?`, { ambiguous: true, candidates: names, commodity: cleanCommodity });
      }
      if (!match.ok) {
        return clarify("unknown_location", `I don't have that location. We post bids for ${andList(this.locations.names())}. Which one?`, { commodity: cleanCommodity });
      }
      loc = match.location;
    } else if (lastLocationId && this.locations.get(lastLocationId)) {
      loc = this.locations.get(lastLocationId);
      reused = true;
    }

    if (!cleanCommodity) {
      return loc
        ? clarify("missing_commodity", `Which commodity at ${loc.displayName} — ${COMMODITY_CHOICES}?`, { locationId: loc.id, locationName: loc.displayName })
        : clarify("missing_commodity", `Which commodity — ${COMMODITY_CHOICES}?`);
    }
    if (!loc) {
      return clarify("missing_location", `Which location? We post bids for ${andList(this.locations.names())}.`, { commodity: cleanCommodity });
    }

    const base = { locationId: loc.id, locationName: loc.displayName, commodity: cleanCommodity };
    try {
      const bidSheet = this.feed.getBidSheet();
      const posted = bidSheet.bids
        .filter((b) => b.location === loc.id && b.commodity === cleanCommodity)
        .sort((a, b) => a.delivery.localeCompare(b.delivery));
      if (!posted.length) {
        return { ok: false, reason: "not_posted", message: `${loc.displayName} doesn't have a ${cleanCommodity} bid posted right now.`, ...base };
      }
      const selected = this.#selectBid(posted, month);
      if (!selected) {
        const months = posted.map((b) => formatMonth(b.delivery));
        const offer = months.length === 1 ? `Only ${months[0]} is posted there. Would you like the ${months[0]} bid?` : `I have ${orList(months)} — which one?`;
        return clarify("unposted_month", `${loc.displayName} doesn't have ${cleanCommodity} posted for ${monthLabel(month)}. ${offer}`, { ...base, months });
      }
      const futures = this.feed.getFutures([selected.reference]);
      const contract = futures.contracts.find((c) => c.symbol === selected.reference);
      if (!contract) {
        return { ok: false, reason: "missing_futures", message: "I don't have the reference futures for that bid right now, so I can't give you a price.", ...base };
      }
      const detail = this.#formatQuote({ bid: selected, contract, bidSheet, location: loc, commodity: cleanCommodity });
      return { ok: true, ...detail, ...base, reusedLocation: reused };
    } catch (e) {
      return { ok: false, reason: "feed_unavailable", message: "Pricing data is unavailable right now.", error: e.message, ...base };
    }
  }

  list({ commodity, month = null } = {}) {
    const cleanCommodity = this.commodity(commodity);
    if (!cleanCommodity) {
      return normalize(commodity)
        ? clarify("unknown_commodity", `We don't post bids for that. I can quote ${COMMODITY_CHOICES} — which one?`)
        : clarify("missing_commodity", `Which commodity — ${COMMODITY_CHOICES}?`);
    }
    try {
      const bidSheet = this.feed.getBidSheet();
      const results = [];
      for (const loc of this.locations.all()) {
        const posted = bidSheet.bids.filter((b) => b.location === loc.id && b.commodity === cleanCommodity);
        const selected = this.#selectBid(posted, month);
        if (!selected) continue;
        const futures = this.feed.getFutures([selected.reference]);
        const contract = futures.contracts.find((c) => c.symbol === selected.reference);
        if (!contract) continue;
        results.push(this.#formatQuote({ bid: selected, contract, bidSheet, location: loc, commodity: cleanCommodity }));
      }
      if (!results.length) {
        return { ok: false, reason: "unposted_month", message: `No location has ${cleanCommodity} posted for ${monthLabel(month)}.`, commodity: cleanCommodity };
      }
      results.sort((a, b) => b.cashBid - a.cashBid);
      const top = results.slice(0, 5);
      return { ok: true, commodity: cleanCommodity, phrases: top.map((r) => r.phrase), quotes: top, phrase: top.map((r) => r.phrase).join(" ") };
    } catch (e) {
      return { ok: false, reason: "feed_unavailable", message: "Pricing data is unavailable right now.", error: e.message, commodity: cleanCommodity };
    }
  }

  #selectBid(posted, month) {
    const sorted = [...posted].sort((a, b) => a.delivery.localeCompare(b.delivery));
    if (!month || /spot|nearby|current/i.test(String(month))) return sorted[0] ?? null;
    const m = normalize(month);
    return sorted.find((b) => b.delivery === month || normalize(formatMonth(b.delivery)) === m || normalize(`${formatMonth(b.delivery)} ${b.delivery.slice(0, 4)}`) === m) ?? null;
  }

  #formatQuote({ bid, contract, bidSheet, location, commodity }) {
    const now = this.now();
    const market = this.feed.getMarket();
    const timeZone = location.timeZone ?? market.timeZone ?? "UTC";
    const marketState = this.marketState(now, market);
    const asOf = new Date(contract.asOf);
    const ageMinutes = Math.max(0, Math.round((now - asOf) / 60_000));
    const sheetAt = new Date(bidSheet.updatedAt);
    const sheetToday = localParts(sheetAt, timeZone).date === localParts(now, timeZone).date;
    const soft = this.options.softStaleMinutes;
    const hard = this.options.hardLimitMinutes;

    // The server, not the model, decides whether a number may be called current.
    let freshnessReason = "fresh";
    if (marketState === "holiday") freshnessReason = "holiday";
    else if (marketState !== "open") freshnessReason = "market_closed";
    else if (ageMinutes > hard) freshnessReason = "hard_limit";
    else if (ageMinutes > soft) freshnessReason = "stale_futures";
    else if (!sheetToday) freshnessReason = "stale_bid_sheet";
    const freshness = freshnessReason === "fresh" ? "live" : freshnessReason.startsWith("stale_") ? "delayed" : "close";

    const sheetLocal = sheetToday ? formatTime(sheetAt, timeZone) : formatDayTime(sheetAt, timeZone);
    const freshnessWhy = {
      fresh: `Futures are ${ageLabel(ageMinutes)} old — inside the ${soft}-minute window.`,
      stale_futures: `Futures are ${ageLabel(ageMinutes)} old — past the ${soft}-minute window, so the agent must say the prices may be delayed.`,
      stale_bid_sheet: `The bid sheet was last posted ${sheetLocal}, not today, so the agent must say the prices may be delayed.`,
      market_closed: "The futures market is closed, so the agent quotes the last settlement, not a live price.",
      holiday: "Today is an exchange holiday, so the agent quotes the last settlement, not a live price.",
      hard_limit: `Futures are ${ageLabel(ageMinutes)} old — past the ${hard}-minute hard limit, so the agent quotes the last settlement only.`,
    }[freshnessReason];

    const futuresBasis = freshness === "close" ? "settle" : "last";
    const futuresPrice = Number(futuresBasis === "settle" ? contract.settle : contract.last);
    const asOfLocal = freshness === "close" ? "the last close" : formatTime(asOf, timeZone);
    const caveat = freshness === "delayed" ? " These prices may be delayed." : "";

    const cashBid = Math.round((futuresPrice + bid.basisCents / 100) * 100) / 100;
    const commodityName = commodity.charAt(0).toUpperCase() + commodity.slice(1);
    // "Corn is", but "soybeans are": the phrase is read aloud verbatim, so it has to sound right.
    const plural = /s$/.test(commodity);
    const monthName = formatMonth(bid.delivery);
    const basis = basisPhrase(bid.basisCents, contract.month);
    const phrase = freshness === "close"
      ? `As of ${asOfLocal}, ${commodity} at ${location.displayName} for ${monthName} delivery ${plural ? "were" : "was"} ${dollars(cashBid)}, that's ${basis}.`
      : `${commodityName} at ${location.displayName} for ${monthName} delivery ${plural ? "are" : "is"} ${dollars(cashBid)}, that's ${basis}, as of ${asOfLocal}.${caveat}`;
    return {
      phrase,
      freshness,
      freshnessReason,
      freshnessWhy,
      cashBid,
      basisCents: bid.basisCents,
      basisText: basis,
      reference: bid.reference,
      futuresSymbol: contract.symbol,
      futuresMonth: contract.month,
      futuresPrice,
      futuresBasis,
      asOf: contract.asOf,
      asOfLocal,
      ageMinutes,
      staleGateMinutes: soft,
      hardLimitMinutes: hard,
      marketState,
      bidSheetUpdatedAt: bidSheet.updatedAt,
      bidSheetLocal: sheetLocal,
      source: `Bid sheet ${sheetLocal} · ${contract.symbol} futures · ${config.pricing.feed} feed`,
      delivery: bid.delivery,
      deliveryMonth: monthName,
      locationId: location.id,
      locationName: location.displayName,
      commodity,
    };
  }
}