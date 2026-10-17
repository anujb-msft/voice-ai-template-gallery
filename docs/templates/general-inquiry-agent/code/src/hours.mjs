import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import { config, referenceNow } from "./config.mjs";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const resolvePath = (p) => (isAbsolute(p) ? p : join(PKG_ROOT, p));
const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * When the information desk can take a transfer. The clock is injected, so the
 * same policy answers for the real time, a pinned demo clock, or a test.
 */
export class StaffedHours {
  constructor(doc, { now = referenceNow } = {}) {
    this.organization = doc.organization ?? "City of Contoso";
    this.timeZone = doc.timeZone ?? "UTC";
    this.queue = doc.queue;
    this.staffedHours = doc.staffedHours ?? [];
    this.afterHoursMessage = doc.afterHoursMessage ?? "Our information desk is closed right now. Please call back during staffed hours.";
    this.now = now;
  }

  static load(path = config.hoursPath, opts = {}) {
    return new StaffedHours(JSON.parse(readFileSync(resolvePath(path), "utf8")), opts);
  }

  isStaffed(at = this.now()) {
    return scheduleAt(this.staffedHours, at, this.timeZone).open;
  }

  /**
   * The transfer decision. Staffed: connect now. Otherwise the after-hours
   * message and when the desk next opens, for the agent to speak.
   */
  decision(at = this.now()) {
    const state = scheduleAt(this.staffedHours, at, this.timeZone);
    const facts = {
      timeZone: this.timeZone,
      localTime: localTime(at, this.timeZone),
      hoursText: describeWeeklyHours(this.staffedHours),
      queue: this.queue?.displayName ?? null,
    };
    if (state.open) {
      return { staffed: true, open: true, message: "Connecting you now", nextStaffed: null, nextOpening: null, closesAt: state.closesAt, ...facts };
    }
    return {
      staffed: false,
      open: false,
      message: this.afterHoursMessage,
      nextStaffed: this.nextStaffed(at),
      nextOpening: state.nextOpening,
      closesAt: null,
      ...facts,
    };
  }

  /** The next staffed start, as "Thursday 08:00". */
  nextStaffed(at = this.now()) {
    const next = nextOpening(this.staffedHours, at, this.timeZone);
    return next ? `${DAY_NAMES[next.day]} ${next.window.open}` : null;
  }
}

/**
 * Open or closed at `at` for a set of weekly windows
 * ({ days: [0-6], open: "HH:MM", close: "HH:MM" }, read in `timeZone`), with
 * the closing time or the next opening in words an agent can speak.
 */
export function scheduleAt(windows, at, timeZone) {
  const { day, minutes } = localParts(at, timeZone);
  const current = windows.find((w) => (w.days ?? []).includes(day) && minutes >= toMinutes(w.open) && minutes < toMinutes(w.close));
  if (current) return { open: true, closesAt: spokenTime(current.close), nextOpening: null };
  const next = nextOpening(windows, at, timeZone);
  return { open: false, closesAt: null, nextOpening: next ? `${whenDay(next.inDays, next.day)} at ${spokenTime(next.window.open)}` : null };
}

/** The first window that starts after `at`, looking up to a week ahead. */
export function nextOpening(windows, at, timeZone) {
  const { day: today, minutes } = localParts(at, timeZone);
  for (let inDays = 0; inDays <= 7; inDays += 1) {
    const day = (today + inDays) % 7;
    const starts = windows
      .filter((w) => (w.days ?? []).includes(day) && (inDays > 0 || toMinutes(w.open) > minutes))
      .sort((a, b) => toMinutes(a.open) - toMinutes(b.open));
    if (starts.length) return { day, inDays, window: starts[0] };
  }
  return null;
}

/** "Mon-Fri 08:00-17:00; Sat 09:00-12:00" → weekly windows. */
export function parseWeeklyHours(text) {
  if (!text) return [];
  return String(text)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = /^([A-Za-z]{3})(?:\s*-\s*([A-Za-z]{3}))?\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(part);
      const from = DAY_INDEX[titleCase(m?.[1])];
      const to = DAY_INDEX[titleCase(m?.[2] ?? m?.[1])];
      if (!m || from == null || to == null) throw new Error(`Cannot read opening hours "${part}" (expected e.g. "Mon-Fri 08:00-17:00")`);
      const days = [];
      for (let d = from; ; d = (d + 1) % 7) {
        days.push(d);
        if (d === to) break;
      }
      return { days, open: m[3].padStart(5, "0"), close: m[4].padStart(5, "0") };
    });
}

/** Weekly windows as a console label: "Weekdays 8 a.m.–5 p.m.". */
export function describeWeeklyHours(windows) {
  return windows.map((w) => `${dayRange(w.days ?? [])} ${spokenTime(w.open)}–${spokenTime(w.close)}`).join("; ");
}

/** The calendar date at `at` in `timeZone`, as YYYY-MM-DD. */
export function localDate(at, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function localTime(at, timeZone) {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", hour: "numeric", minute: "2-digit" })
    .format(at)
    .replace(/\s?([AP])M$/, (_, x) => ` ${x.toLowerCase()}.m.`);
}

/** "08:00" → "8 a.m.", "17:30" → "5:30 p.m.", "12:00" → "noon". */
export function spokenTime(hhmm) {
  const [h, m = 0] = String(hhmm).split(":").map(Number);
  if (h === 12 && m === 0) return "noon";
  const suffix = h < 12 ? "a.m." : "p.m.";
  const hour = h % 12 || 12;
  return m ? `${hour}:${String(m).padStart(2, "0")} ${suffix}` : `${hour} ${suffix}`;
}

function whenDay(inDays, day) {
  if (inDays === 0) return "today";
  return inDays === 7 ? `next ${DAY_NAMES[day]}` : DAY_NAMES[day];
}

function dayRange(days) {
  const set = [...new Set(days)].sort((a, b) => a - b);
  const key = set.join(",");
  if (key === "1,2,3,4,5") return "Weekdays";
  if (key === "0,6") return "Weekends";
  if (set.length === 7) return "Every day";
  const consecutive = set.length >= 2 && set.every((d, i) => i === 0 || d === set[i - 1] + 1);
  if (consecutive) return `${SHORT_DAYS[set[0]]}–${SHORT_DAYS[set.at(-1)]}`;
  return set.map((d) => SHORT_DAYS[d]).join(", ");
}

function localParts(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { day: DAY_INDEX[parts.weekday], minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + (m ?? 0);
};
const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);
