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

function formatMonth(yyyyMm) {
  const [year, month] = String(yyyyMm).split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function dollars(value) {
  return `$${Number(value).toFixed(2)}`;
}

function basisPhrase(cents, futuresMonth) {
  if (cents === 0) return `even with ${futuresMonth} futures`;
  return `${Math.abs(cents)} ${cents > 0 ? "over" : "under"} ${futuresMonth} futures`;
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
    return `${loc.displayName}'s merchandiser is available ${hours.open} to ${hours.close} ${loc.timeZone ?? "local time"}, Monday through Friday.`;
  }
}

export class FixtureFeed {
  constructor({ bidsPath = config.pricing.bidsPath, futuresPath = config.pricing.futuresPath, marketPath = config.pricing.marketPath } = {}) {
    this.bidsPath = bidsPath;
    this.futuresPath = futuresPath;
    this.marketPath = marketPath;
    this.feedDown = false;
    this.staleOffsetMinutes = 0;
  }
  getBidSheet() {
    if (this.feedDown) throw new Error("price feed unavailable");
    return loadJson(this.bidsPath);
  }
  getFutures(symbols = []) {
    if (this.feedDown) throw new Error("price feed unavailable");
    const doc = loadJson(this.futuresPath);
    const wanted = new Set(symbols);
    const contracts = wanted.size ? doc.contracts.filter((c) => wanted.has(c.symbol)) : doc.contracts;
    return { ...doc, contracts: contracts.map((c) => this.staleOffsetMinutes ? { ...c, asOf: new Date(Date.parse(c.asOf) - this.staleOffsetMinutes * 60_000).toISOString() } : c) };
  }
  getMarket() { return loadJson(this.marketPath); }
  setFeedDown(value) { this.feedDown = Boolean(value); }
  makeStale(minutes = 60) { this.staleOffsetMinutes = Number(minutes) || 60; }
}

export class PriceBook {
  constructor({ locations = LocationDirectory.load(), feed = new FixtureFeed(), now = () => new Date(config.pricing.demoNow), options = {} } = {}) {
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
        source: config.pricing.feed,
        bidSheetUpdatedAt: bidSheet.updatedAt,
        bidSheetAgeMinutes: Math.max(0, Math.round((now - Date.parse(bidSheet.updatedAt)) / 60_000)),
        futuresAsOf: new Date(minAsOf).toISOString(),
        futuresAgeMinutes: Math.max(0, Math.round((now - minAsOf) / 60_000)),
        marketSessionState: this.marketState(now, market),
      };
    } catch (e) {
      return { ok: false, source: config.pricing.feed, error: e.message };
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

  quote({ commodity, location, month = null, lastLocationId = null }) {
    const cleanCommodity = this.commodity(commodity);
    if (!cleanCommodity) return { ok: false, reason: "unknown_commodity", message: `I can quote corn, soybeans, or wheat.` };

    const locMatch = this.locations.match(location, { lastLocationId });
    if (!locMatch.ok) {
      return locMatch.reason === "ambiguous"
        ? { ok: false, ambiguous: true, candidates: locMatch.candidates.map((l) => l.displayName), message: `Did you mean ${locMatch.candidates.map((l) => l.displayName).join(" or ")}?` }
        : { ok: false, reason: locMatch.reason, message: `I don't have a location matching ${location ?? "that"}.` };
    }

    try {
      const bidSheet = this.feed.getBidSheet();
      const posted = bidSheet.bids.filter((b) => b.location === locMatch.location.id && b.commodity === cleanCommodity);
      if (!posted.length) return { ok: false, reason: "unknown_commodity", message: `I don't have ${cleanCommodity} posted at ${locMatch.location.displayName}.` };
      const selected = this.#selectBid(posted, month);
      if (!selected) return { ok: false, reason: "unposted_month", message: `${locMatch.location.displayName} does not have ${cleanCommodity} posted for ${month}.` };
      const futures = this.feed.getFutures([selected.reference]);
      const contract = futures.contracts.find((c) => c.symbol === selected.reference);
      if (!contract) return { ok: false, reason: "missing_futures", message: `I don't have the reference futures for that bid right now.` };
      const detail = this.#formatQuote({ bid: selected, contract, bidSheet, location: locMatch.location, commodity: cleanCommodity });
      return { ok: true, ...detail, locationId: locMatch.location.id, locationName: locMatch.location.displayName, commodity: cleanCommodity, reusedLocation: locMatch.reused ?? false };
    } catch (e) {
      return { ok: false, reason: "feed_unavailable", message: "Pricing data is unavailable right now.", error: e.message, locationId: locMatch.location.id, locationName: locMatch.location.displayName };
    }
  }

  list({ commodity, month = null }) {
    const cleanCommodity = this.commodity(commodity);
    if (!cleanCommodity) return { ok: false, reason: "unknown_commodity", message: `I can quote corn, soybeans, or wheat.` };
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
      results.sort((a, b) => b.cashBid - a.cashBid);
      const top = results.slice(0, 5);
      return { ok: true, commodity: cleanCommodity, phrases: top.map((r) => r.phrase), quotes: top, phrase: top.map((r) => r.phrase).join(" ") };
    } catch (e) {
      return { ok: false, reason: "feed_unavailable", message: "Pricing data is unavailable right now.", error: e.message };
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
    const marketState = this.marketState(now, market);
    const asOf = new Date(contract.asOf);
    const ageMinutes = Math.max(0, Math.round((now - asOf) / 60_000));
    const sheetLocal = localParts(new Date(bidSheet.updatedAt), location.timeZone ?? market.timeZone ?? "UTC").date;
    const nowLocal = localParts(now, location.timeZone ?? market.timeZone ?? "UTC").date;
    let freshness = "live";
    let caveat = "";
    let priceBase = contract.last;
    let asOfText = formatTime(asOf, location.timeZone ?? market.timeZone ?? "UTC");

    if (marketState !== "open" || ageMinutes > this.options.hardLimitMinutes) {
      freshness = "close";
      priceBase = contract.settle;
      asOfText = "the last close";
    } else if (ageMinutes > this.options.softStaleMinutes || sheetLocal !== nowLocal) {
      freshness = "delayed";
      caveat = " These prices may be delayed.";
    }

    const cashBid = Math.round((Number(priceBase) + bid.basisCents / 100) * 100) / 100;
    const commodityName = commodity === "soybeans" ? "Soybeans" : commodity.charAt(0).toUpperCase() + commodity.slice(1);
    const monthName = formatMonth(bid.delivery);
    const basis = basisPhrase(bid.basisCents, contract.month);
    const phrase = freshness === "close"
      ? `As of ${asOfText}, ${commodityName.toLowerCase()} at ${location.displayName} for ${monthName} delivery was ${dollars(cashBid)}, that's ${basis}.`
      : `${commodityName} at ${location.displayName} for ${monthName} delivery is ${dollars(cashBid)}, that's ${basis}, as of ${asOfText}.${caveat}`;
    return { phrase, freshness, cashBid, basisCents: bid.basisCents, reference: bid.reference, futuresMonth: contract.month, asOf: contract.asOf, delivery: bid.delivery, locationId: location.id, locationName: location.displayName, commodity };
  }
}
