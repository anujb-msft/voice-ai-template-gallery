import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import { config } from "./config.mjs";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const resolvePath = (p) => (isAbsolute(p) ? p : join(PKG_ROOT, p));
const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const STATE_NAMES = new Set(["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "IL", "IN", "MA", "MI", "MN", "MO", "NC", "NJ", "NY", "OH", "OR", "PA", "TN", "TX", "VA", "WA", "WI"]);

function readJson(path) { return JSON.parse(readFileSync(resolvePath(path), "utf8")); }
function toMinutes(hhmm) { const [h, m = 0] = String(hhmm).split(":").map(Number); return h * 60 + m; }
function localParts(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date).map((p) => [p.type, p.value]));
  return { day: DAY_INDEX[parts.weekday], minutes: Number(parts.hour) * 60 + Number(parts.minute), date: `${parts.year}-${parts.month}-${parts.day}` };
}

export class HoursPolicy {
  constructor(doc) { Object.assign(this, doc); this.timeZone = doc.timeZone ?? "UTC"; this.weeklyHours = doc.weeklyHours ?? []; this.holidays = new Set(doc.holidays ?? []); }
  static load(path = config.paths.hours) { return new HoursPolicy(readJson(path)); }
  isHoliday(now = new Date()) { return this.holidays.has(localParts(now, this.timeZone).date); }
  isSalesOpen(now = new Date()) {
    if (this.isHoliday(now)) return false;
    const parts = localParts(now, this.timeZone);
    const row = this.weeklyHours.find((h) => h.day === parts.day);
    return Boolean(row && parts.minutes >= toMinutes(row.open) && parts.minutes < toMinutes(row.close));
  }
  nextBusinessOpen(now = new Date()) {
    let d = new Date(now);
    for (let i = 0; i < 14; i++) {
      const p = localParts(d, this.timeZone);
      const row = this.weeklyHours.find((h) => h.day === p.day);
      if (row && !this.isHoliday(d)) return row.open;
      d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
    }
    return "next business day";
  }
}

export class Catalog {
  constructor(doc) { this.lines = doc.lines ?? []; }
  static load(path = config.paths.catalog) { return new Catalog(readJson(path)); }
  lookup(query) {
    const q = String(query ?? "").toLowerCase();
    return this.lines.filter((l) => [l.name, l.id, ...(l.aliases ?? [])].some((v) => q.includes(String(v).toLowerCase()) || String(v).toLowerCase().includes(q))).map(publicCatalogLine);
  }
  findLine(value) { return this.lookup(value)[0] ?? null; }
}
function publicCatalogLine(l) { return { id: l.id, name: l.name, skuFamilies: l.skuFamilies, minimumOrderQuantity: l.minimumOrderQuantity, typicalLeadTime: l.typicalLeadTime }; }

export class RepRoster {
  constructor(doc) { this.manager = doc.manager; this.reps = doc.reps ?? []; }
  static load(path = config.paths.reps) { return new RepRoster(readJson(path)); }
  activeReps() { return this.reps.filter((r) => r.active); }
}

export class QualificationPolicy {
  constructor(doc, catalog) { this.rules = doc; this.catalog = catalog; }
  static load(path = config.paths.qualification, catalog = Catalog.load()) { return new QualificationPolicy(readJson(path), catalog); }
  score(fields) {
    const breakdown = [];
    let points = 0;
    const add = (rule, reason, value) => { points += value; breakdown.push({ rule, reason, points: value }); };
    const product = this.catalog.findLine(fields.productInterest ?? "");
    add("productInterest", product ? product.id : "other", product ? this.rules.productInterest.catalogLine : this.rules.productInterest.other);
    const quantity = Number(fields.quantity ?? 0);
    const moq = product?.minimumOrderQuantity ?? null;
    add("quantity", moq == null || !quantity ? "unknown" : quantity >= moq ? "atOrAboveMoq" : "belowMoq", moq == null || !quantity ? this.rules.quantity.unknown : quantity >= moq ? this.rules.quantity.atOrAboveMoq : this.rules.quantity.belowMoq);
    const timeline = classifyTimeline(fields.timeline);
    add("timeline", timeline, this.rules.timeline[timeline] ?? 0);
    const role = classifyRole(fields.role);
    add("role", role, this.rules.role[role] ?? 0);
    const score = points >= this.rules.thresholds.hot ? "hot" : points >= this.rules.thresholds.warm ? "warm" : "cold";
    return { score, points, breakdown, productLine: product?.id ?? null };
  }
}

export function classifyTimeline(text = "") {
  const t = String(text).toLowerCase();
  if (/this week|asap|urgent|immediately|30|month|two weeks|next week/.test(t)) return "within30Days";
  if (/60|90|quarter|next quarter|few months/.test(t)) return "within90Days";
  if (/later|next year|someday|exploring|research/.test(t)) return "later";
  return "unknown";
}
export function classifyRole(text = "") {
  const t = String(text).toLowerCase();
  if (/owner|founder|president|director|vp|chief|buyer|procurement|purchasing|decision/.test(t)) return "decisionMaker";
  if (/manager|engineer|operations|influence|recommend/.test(t)) return "influencer";
  return "unknown";
}

export function normalisePhone(phone) {
  const raw = String(phone ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (raw.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}
export function maskPhone(phone) { const n = normalisePhone(phone); if (!n) return "anonymous"; const d = n.replace(/\D/g, ""); return `+${"•".repeat(Math.max(0, d.length - 2))}${d.slice(-2)}`; }
export function normaliseEmail(email) { const v = String(email ?? "").trim().toLowerCase(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null; }
export function stateFromText(text) { const upper = String(text ?? "").toUpperCase(); return [...STATE_NAMES].find((s) => new RegExp(`\b${s}\b`).test(upper)) ?? null; }
