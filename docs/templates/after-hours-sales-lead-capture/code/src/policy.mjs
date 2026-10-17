// Server-owned policy: sales hours, on-call cover, follow-up deadlines, the
// product catalog, lead scoring and the rep roster. Everything here is pure and
// takes `now` as an argument, so the demo clock drives every decision and the
// tests can pin time.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import { config } from "./config.mjs";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const resolvePath = (p) => (isAbsolute(p) ? p : join(PKG_ROOT, p));

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_INDEX = Object.fromEntries(SHORT_DAYS.map((d, i) => [d, i]));
const MINUTE = 60_000;

const US_STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", IL: "Illinois", IN: "Indiana",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MO: "Missouri", NC: "North Carolina",
  NJ: "New Jersey", NY: "New York", OH: "Ohio", OR: "Oregon", PA: "Pennsylvania", TN: "Tennessee",
  TX: "Texas", VA: "Virginia", WA: "Washington", WI: "Wisconsin",
};
const STATE_CODE_RE = new RegExp(`\\b(${Object.keys(US_STATES).join("|")})\\b`);
const STATE_NAME_RE = new RegExp(`\\b(${Object.values(US_STATES).join("|")})\\b`, "i");
const STATE_BY_NAME = Object.fromEntries(Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code]));

function readJson(path) {
  return JSON.parse(readFileSync(resolvePath(path), "utf8"));
}

function toMinutes(hhmm) {
  const [h, m = 0] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

// ---------------------------------------------------------------------------
// Time-zone helpers (Intl only, no dependencies)
// ---------------------------------------------------------------------------

const formatters = new Map();
function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of `date` in `timeZone`. `minutes` is minutes since local midnight. */
export function localParts(date, timeZone) {
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(new Date(date)).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return {
    day: DAY_INDEX[parts.weekday],
    year: Number(parts.year),
    month: Number(parts.month),
    dayOfMonth: Number(parts.day),
    hour,
    minute,
    second: Number(parts.second),
    minutes: hour * 60 + minute,
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function zoneOffsetMs(date, timeZone) {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.dayOfMonth, p.hour, p.minute, p.second);
  const t = date.getTime();
  return asUtc - (t - (((t % 1000) + 1000) % 1000));
}

/** The instant when the local wall clock in `timeZone` reads `dateStr` plus `minutes`. */
export function zonedInstant(dateStr, minutes, timeZone) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d) + minutes * MINUTE;
  const first = wall - zoneOffsetMs(new Date(wall), timeZone);
  return new Date(wall - zoneOffsetMs(new Date(first), timeZone));
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 480 → "8 AM", 510 → "8:30 AM", 1260 → "9 PM". */
export function clockLabel(minutes) {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")} ${suffix}` : `${h12} ${suffix}`;
}

// ---------------------------------------------------------------------------
// Sales hours, follow-up deadlines and on-call cover
// ---------------------------------------------------------------------------

export class HoursPolicy {
  constructor(doc) {
    Object.assign(this, doc);
    this.timeZone = doc.timeZone ?? "UTC";
    this.weeklyHours = doc.weeklyHours ?? [];
    this.holidays = new Set(doc.holidays ?? []);
    this.onCall = doc.onCall ?? null;
  }

  static load(path = config.paths.hours) {
    return new HoursPolicy(readJson(path));
  }

  isHoliday(now = new Date()) {
    return this.holidays.has(localParts(now, this.timeZone).date);
  }

  /** Opening and closing minutes for a local date, or null when sales is closed all day. */
  hoursOn(dateStr) {
    if (this.holidays.has(dateStr)) return null;
    const row = this.weeklyHours.find((h) => h.day === weekdayOf(dateStr));
    return row ? { open: toMinutes(row.open), close: toMinutes(row.close) } : null;
  }

  isSalesOpen(now = new Date()) {
    const p = localParts(now, this.timeZone);
    const day = this.hoursOn(p.date);
    return Boolean(day && p.minutes >= day.open && p.minutes < day.close);
  }

  /** The next instant the sales line is open: `now` itself while open. */
  nextOpen(now = new Date()) {
    if (this.isSalesOpen(now)) return new Date(now);
    const p = localParts(now, this.timeZone);
    for (let i = 0; i <= 21; i++) {
      const date = addDays(p.date, i);
      const day = this.hoursOn(date);
      if (!day) continue;
      if (i === 0 && p.minutes >= day.open) continue;
      return zonedInstant(date, day.open, this.timeZone);
    }
    return null;
  }

  /** Adds minutes of open sales time, skipping nights, weekends and holidays. */
  addBusinessMinutes(now = new Date(), minutes = 0) {
    let remaining = minutes;
    let cursor = new Date(now);
    for (let guard = 0; guard < 60; guard++) {
      const start = this.nextOpen(cursor);
      if (!start) return null;
      const p = localParts(start, this.timeZone);
      const close = zonedInstant(p.date, this.hoursOn(p.date).close, this.timeZone);
      const available = (close.getTime() - start.getTime()) / MINUTE;
      if (remaining <= available) return new Date(start.getTime() + remaining * MINUTE);
      remaining -= available;
      cursor = close;
    }
    return null;
  }

  /** Closing time of the nth business day after today's local date. */
  closeOfBusinessDay(now = new Date(), n = 1) {
    const today = localParts(now, this.timeZone).date;
    let count = 0;
    for (let i = 1; i <= 30; i++) {
      const date = addDays(today, i);
      const day = this.hoursOn(date);
      if (!day) continue;
      count += 1;
      if (count === n) return zonedInstant(date, day.close, this.timeZone);
    }
    return null;
  }

  /**
   * Follow-up deadline for a score, in business time: hot leads within the first
   * hour of selling time, warm by the close of the next business day, cold by the
   * close of the second.
   */
  followUpDue(score, now = new Date()) {
    if (score === "hot") return this.addBusinessMinutes(now, 60);
    return this.closeOfBusinessDay(now, score === "warm" ? 1 : 2);
  }

  /** "8 AM tomorrow", "8 AM today" or "8 AM Tuesday"; null while sales is open. */
  openingPhrase(now = new Date()) {
    if (this.isSalesOpen(now)) return null;
    const next = this.nextOpen(now);
    if (!next) return null;
    const today = localParts(now, this.timeZone).date;
    const p = localParts(next, this.timeZone);
    const when = p.date === today ? "today" : p.date === addDays(today, 1) ? "tomorrow" : DAY_NAMES[p.day];
    return `${clockLabel(p.minutes)} ${when}`;
  }

  /** "Thursday 9 AM" in the sales time zone. */
  dueLabel(date) {
    if (!date) return null;
    const p = localParts(new Date(date), this.timeZone);
    return `${DAY_NAMES[p.day]} ${clockLabel(p.minutes)}`;
  }

  /** "Mon–Fri, 8 AM to 6 PM" for the console. */
  hoursLabel() {
    const rows = [...this.weeklyHours].sort((a, b) => a.day - b.day);
    if (!rows.length) return "No sales hours configured";
    const same = rows.every((r) => r.open === rows[0].open && r.close === rows[0].close);
    const contiguous = rows.every((r, i) => i === 0 || r.day === rows[i - 1].day + 1);
    const span = (r) => `${clockLabel(toMinutes(r.open))} to ${clockLabel(toMinutes(r.close))}`;
    if (same && contiguous) {
      const days = rows.length === 1 ? SHORT_DAYS[rows[0].day] : `${SHORT_DAYS[rows[0].day]}–${SHORT_DAYS[rows.at(-1).day]}`;
      return `${days}, ${span(rows[0])}`;
    }
    return rows.map((r) => `${SHORT_DAYS[r.day]} ${span(r)}`).join("; ");
  }

  /**
   * Whether an on-call sales rep can take a live call right now. Cover starts
   * when sales closes (or at `onCall.from`) and ends at `onCall.until`, on the
   * listed weekdays, and never on holidays.
   */
  onCallCoverage(now = new Date()) {
    const salesOpen = this.isSalesOpen(now);
    const onCall = this.onCall;
    const base = { covered: false, salesOpen, repId: onCall?.rep ?? null, until: null, untilLabel: null };
    if (salesOpen) return { ...base, reason: "Sales is open" };
    if (!onCall?.rep) return { ...base, reason: "No on-call cover is configured" };
    const p = localParts(now, this.timeZone);
    if (this.holidays.has(p.date)) return { ...base, reason: "No on-call cover on holidays" };
    const days = onCall.days ?? [1, 2, 3, 4, 5];
    if (!days.includes(p.day)) return { ...base, reason: `No on-call cover on ${DAY_NAMES[p.day]}s` };
    const from = onCall.from ? toMinutes(onCall.from) : this.hoursOn(p.date)?.close ?? 0;
    const until = toMinutes(onCall.until ?? "21:00");
    const untilLabel = clockLabel(until);
    if (p.minutes < from) return { ...base, untilLabel, reason: `On-call cover starts at ${clockLabel(from)}` };
    if (p.minutes >= until) return { ...base, untilLabel, reason: `On-call cover ends at ${untilLabel}` };
    return {
      ...base,
      covered: true,
      until: zonedInstant(p.date, until, this.timeZone).toISOString(),
      untilLabel,
      reason: `On call until ${untilLabel}`,
    };
  }

  nextBusinessOpen(now = new Date()) {
    let d = new Date(now);
    for (let i = 0; i < 14; i++) {
      const p = localParts(d, this.timeZone);
      const row = this.weeklyHours.find((h) => h.day === p.day);
      if (row && !this.isHoliday(d)) return row.open;
      d = new Date(d.getTime() + 24 * 60 * MINUTE);
    }
    return "next business day";
  }
}

/**
 * Whether to page the on-call rep for a lead captured outside sales hours.
 * The server decides from the score, urgency, the caller's request and the
 * cover rota; the model never does. Every answer carries a plain-English reason.
 */
export function decidePage({ score, urgent = false, askedForPerson = false, coverage = null, repName = "the on-call rep" } = {}) {
  const hot = score === "hot";
  const facts = {
    hot,
    urgent: Boolean(urgent),
    askedForPerson: Boolean(askedForPerson),
    covered: Boolean(coverage?.covered),
    coverageReason: coverage?.reason ?? null,
    repName,
    untilLabel: coverage?.untilLabel ?? null,
  };
  const page = (code, reason) => ({ page: true, code, reason, ...facts });
  const queue = (code, reason) => ({ page: false, code, reason, ...facts });
  if (!coverage || coverage.salesOpen) return queue("sales_open", "Sales is open, so the lead owner follows up during business hours");
  if (!urgent && !askedForPerson) {
    return queue("not_needed", hot
      ? "Hot, but nothing needs a person tonight, so it goes to the morning queue"
      : "Nothing needs a person tonight, so it goes to the morning queue");
  }
  if (!coverage.covered) return queue("no_cover", `${coverage.reason}, so it goes to the morning queue`);
  const onCall = `${repName} is on call until ${coverage.untilLabel}`;
  if (hot && urgent) return page("hot_urgent", `Hot and urgent, and ${onCall}`);
  if (askedForPerson && (hot || score === "warm")) return page("asked_for_person", `Caller asked for a person, and ${onCall}`);
  if (score === "warm") return queue("warm_waits", "Warm, and on-call is paged only for hot leads that can't wait, so it goes to the morning queue");
  return queue("not_qualified", "On-call is kept for qualified leads, so it goes to the morning queue");
}

const URGENCY_RE = /\b(asap|urgent(?:ly)?|right away|immediately|tonight|first thing|(?:by|before|for) (?:today|tomorrow|the morning)|tomorrow morning|(?:line|machine|plant|production|press|conveyor)(?: (?:is|went|has gone))? down|(?:ran|run|running) out)\b/i;

/** Finds the first urgency cue in any of the texts: "line is down", "by tomorrow", "tonight"… */
export function classifyUrgency(...texts) {
  for (const text of texts.flat()) {
    const m = String(text ?? "").match(URGENCY_RE);
    if (m) return { urgent: true, cue: m[1].toLowerCase() };
  }
  return { urgent: false, cue: null };
}

// ---------------------------------------------------------------------------
// Product catalog
// ---------------------------------------------------------------------------

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-insensitive pattern for a catalog term that also accepts its plural. */
function termPattern(term) {
  const words = String(term ?? "").toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const last = words.pop();
  const stem = last.replace(/(x|ch|sh|ss)es$/, "$1").replace(/([^s])s$/, "$1");
  const parts = [...words.map(escapeRegExp), `${escapeRegExp(stem)}(?:es|s)?`];
  return new RegExp(`\\b${parts.join("\\s+")}\\b`, "i");
}

export class Catalog {
  constructor(doc) {
    this.lines = doc.lines ?? [];
    this.patterns = new Map(this.lines.map((l) => [
      l.id,
      [l.name, l.id, ...(l.aliases ?? []), ...(l.skuFamilies ?? [])].map(termPattern).filter(Boolean),
    ]));
  }

  static load(path = config.paths.catalog) {
    return new Catalog(readJson(path));
  }

  /** Lines mentioned in the text, earliest mention first. No prices or stock. */
  lookup(query) {
    const q = String(query ?? "").trim();
    if (!q) return [];
    const hits = [];
    this.lines.forEach((line, order) => {
      const at = Math.min(...this.patterns.get(line.id).map((re) => q.search(re)).filter((i) => i >= 0));
      if (Number.isFinite(at)) hits.push({ line, at, order });
    });
    return hits.sort((a, b) => a.at - b.at || a.order - b.order).map((h) => publicCatalogLine(h.line));
  }

  findLine(value) {
    return this.lookup(value)[0] ?? null;
  }

  /** The SKU family the caller named ("hex bolts"), if any. */
  skuFamilyIn(text, lineId) {
    const line = this.lines.find((l) => l.id === lineId);
    return line?.skuFamilies?.find((f) => termPattern(f).test(String(text ?? ""))) ?? null;
  }
}

function publicCatalogLine(l) {
  return {
    id: l.id,
    name: l.name,
    skuFamilies: l.skuFamilies,
    minimumOrderQuantity: l.minimumOrderQuantity,
    typicalLeadTime: l.typicalLeadTime,
  };
}

// ---------------------------------------------------------------------------
// Rep roster
// ---------------------------------------------------------------------------

export class RepRoster {
  constructor(doc) {
    this.manager = doc.manager;
    this.reps = doc.reps ?? [];
  }

  static load(path = config.paths.reps) {
    return new RepRoster(readJson(path));
  }

  activeReps() {
    return this.reps.filter((r) => r.active);
  }

  find(id) {
    return this.reps.find((r) => r.id === id) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Lead scoring
// ---------------------------------------------------------------------------

const fmt = (n) => Number(n).toLocaleString("en-US");
const quote = (s) => `"${String(s).trim()}"`;

export class QualificationPolicy {
  constructor(doc, catalog) {
    this.rules = doc;
    this.catalog = catalog;
    this.maxPoints = ["productInterest", "quantity", "timeline", "role"]
      .reduce((sum, rule) => sum + Math.max(0, ...Object.values(doc[rule] ?? {})), 0);
  }

  static load(path = config.paths.qualification, catalog = Catalog.load()) {
    return new QualificationPolicy(readJson(path), catalog);
  }

  score(fields) {
    const breakdown = [];
    let points = 0;
    const add = (rule, reason, value) => {
      points += value;
      breakdown.push({ rule, reason, points: value });
    };
    const product = this.catalog.findLine(fields.productInterest ?? "");
    add("productInterest", product ? product.id : "other", product ? this.rules.productInterest.catalogLine : this.rules.productInterest.other);
    const quantity = Number(fields.quantity ?? 0);
    const moq = product?.minimumOrderQuantity ?? null;
    const quantityClass = moq == null || !quantity ? "unknown" : quantity >= moq ? "atOrAboveMoq" : "belowMoq";
    add("quantity", quantityClass, this.rules.quantity[quantityClass]);
    const timeline = classifyTimeline(fields.timeline);
    add("timeline", timeline, this.rules.timeline[timeline] ?? 0);
    const role = classifyRole(fields.role);
    add("role", role, this.rules.role[role] ?? 0);
    const score = points >= this.rules.thresholds.hot ? "hot" : points >= this.rules.thresholds.warm ? "warm" : "cold";
    return { score, points, breakdown, productLine: product?.id ?? null };
  }

  /** The same score, explained rule by rule in plain English for the console. */
  explain(fields = {}) {
    const scored = this.score(fields);
    const product = scored.productLine ? this.catalog.lines.find((l) => l.id === scored.productLine) : null;
    const reasonOf = (rule) => scored.breakdown.find((b) => b.rule === rule);
    const max = (rule) => Math.max(0, ...Object.values(this.rules[rule] ?? {}));
    const quantity = Number(fields.quantity ?? 0);
    const rows = [
      {
        rule: "productInterest",
        label: "Product",
        detail: product
          ? `${product.name} is a catalog line`
          : fields.productInterest ? `${quote(fields.productInterest)} isn't a catalog line` : "No product yet",
      },
      {
        rule: "quantity",
        label: "Quantity",
        detail: !quantity
          ? "No quantity yet, so it scores as unknown"
          : !product
            ? `${fmt(quantity)}, with no catalog minimum to compare`
            : quantity >= product.minimumOrderQuantity
              ? `${fmt(quantity)} meets the ${fmt(product.minimumOrderQuantity)} minimum order`
              : `${fmt(quantity)} is below the ${fmt(product.minimumOrderQuantity)} minimum order`,
      },
      {
        rule: "timeline",
        label: "Timeline",
        detail: {
          within30Days: `${quote(fields.timeline)} is within 30 days`,
          within90Days: `${quote(fields.timeline)} is within 90 days`,
          later: `${quote(fields.timeline)} is more than 90 days out`,
        }[reasonOf("timeline").reason] ?? (fields.timeline ? `${quote(fields.timeline)} gives no clear date` : "No timeline yet"),
      },
      {
        rule: "role",
        label: "Decision role",
        detail: {
          decisionMaker: `${quote(fields.role)} makes the buying decision`,
          influencer: `${quote(fields.role)} influences the decision`,
        }[reasonOf("role").reason] ?? (fields.role ? `${quote(fields.role)} has no buying role` : "No role yet"),
      },
    ].map((row) => ({ ...row, points: reasonOf(row.rule).points, max: max(row.rule) }));
    const { hot, warm } = this.rules.thresholds;
    return {
      score: scored.score,
      points: scored.points,
      maxPoints: this.maxPoints,
      thresholds: { hot, warm },
      productLine: scored.productLine,
      rows,
      summary: `${scored.points} of ${this.maxPoints} points. Hot starts at ${hot}, warm at ${warm}.`,
    };
  }
}

/** Checked longest horizon first, so "a few months" is not read as "a month". */
export function classifyTimeline(text = "") {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return "unknown";
  if (/\b(?:60|90|sixty|ninety)\b|quarter|\b(?:few|couple of|two|three|2|3) months\b/.test(t)) return "within90Days";
  if (/\b(?:today|tonight|tomorrow|this week|next week|two weeks|2 weeks|asap|urgent(?:ly)?|immediately|right away|first thing|30|thirty|month)\b/.test(t)) return "within30Days";
  if (/\b(?:later|next year|someday|some day|exploring|research(?:ing)?|no rush|(?:six|nine|twelve|6|9|12) months)\b/.test(t)) return "later";
  return "unknown";
}

const ROLE_DEFERS_RE = /\b(?:not (?:the )?(?:decision|my call|me|up to me|the one)|recommends?|(?:boss|someone else|they|he|she|my \w+) (?:decides|signs off|approves|makes the (?:call|decision)))\b/;
const ROLE_DECIDES_RE = /\b(?:owner|founder|president|director|vp|vice president|chief|ceo|cfo|coo|buyer|procurement|purchasing|decision[- ]?maker|final say|my call|i (?:decide|approve)|signs? off|makes? the (?:final )?(?:call|decision))\b/;
const ROLE_INFLUENCES_RE = /\b(?:manager|engineer|operations|influencer?|supervisor|lead|specialist|planner|technician|coordinator)\b/;

/** Deferring ("not my call", "I recommend") wins over a senior-sounding title. */
export function classifyRole(text = "") {
  const t = String(text ?? "").toLowerCase();
  if (!t.trim()) return "unknown";
  if (ROLE_DEFERS_RE.test(t)) return "influencer";
  if (ROLE_DECIDES_RE.test(t)) return "decisionMaker";
  if (ROLE_INFLUENCES_RE.test(t)) return "influencer";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Contact details
// ---------------------------------------------------------------------------

export function normalisePhone(phone) {
  const raw = String(phone ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (raw.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

export function maskPhone(phone) {
  const n = normalisePhone(phone);
  if (!n) return "anonymous";
  const d = n.replace(/\D/g, "");
  return `+${"•".repeat(Math.max(0, d.length - 2))}${d.slice(-2)}`;
}

/** "+14255550193" → "425-555-0193", the digit groups the agent reads back. */
export function phoneGroups(phone) {
  const n = normalisePhone(phone);
  if (!n) return null;
  const d = n.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return `${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
  return n;
}

export function normaliseEmail(email) {
  const v = String(email ?? "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
}

/** Two-letter codes must be capitalized ("CA"); full names match in any case ("california"). */
export function stateFromText(text) {
  const raw = String(text ?? "");
  const code = raw.match(STATE_CODE_RE);
  const name = raw.match(STATE_NAME_RE);
  if (code && (!name || code.index <= name.index)) return code[1];
  if (name) return STATE_BY_NAME[name[1].toLowerCase()];
  return null;
}
