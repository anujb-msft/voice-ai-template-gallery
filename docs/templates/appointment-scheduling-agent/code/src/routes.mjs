import { fixtures } from "./config.mjs";

/**
 * The handoff destinations in config/routing.json: who a call can go to, the
 * Teams call topic they see, when they are staffed, and the only context
 * fields allowed to travel with the call.
 */
export class SchedulingRoutes {
  constructor(doc = fixtures.routing) { this.doc = doc; }

  get(destination) { return this.doc.destinations?.[destination] ?? null; }

  label(destination) { return this.get(destination)?.label ?? destination; }

  /** The Teams call topic, made specific to the reason where routing.json names one. */
  topicFor(destination, reason = null) {
    const route = this.get(destination);
    if (!route) return "Scheduling";
    return (reason && route.reasonTopics?.[reason]) || route.topic;
  }

  /**
   * The CallContext for a handoff: only the fields routing.json lists for the
   * destination, and only those with a value, so nothing else leaks into the
   * VoIP headers and a failed verification carries no patient details at all.
   */
  context(destination, values = {}) {
    const route = this.get(destination);
    if (!route) throw new Error(`unknown destination ${destination}`);
    return Object.fromEntries((route.fields ?? [])
      .filter((field) => values[field] != null && values[field] !== "")
      .map((field) => [field, values[field]]));
  }

  /** Whether a destination is staffed at `date`. A destination with no hours always is. */
  isOpen(destination, date = new Date()) {
    const hours = this.get(destination)?.hours;
    if (!hours) return true;
    const at = zoned(date, hours.timeZone);
    if ((hours.closed ?? []).includes(at.dateKey)) return false;
    if (!(hours.days ?? [1, 2, 3, 4, 5]).includes(at.weekday)) return false;
    return at.minutes >= toMinutes(hours.open) && at.minutes < toMinutes(hours.close);
  }

  menu() {
    return Object.entries(this.doc.destinations).map(([id, r]) => ({ id, label: r.label ?? id, topic: r.topic, fields: r.fields }));
  }
}

export function maskPhone(phone) {
  if (!phone) return "anonymous";
  const digits = String(phone).replace(/\D/g, "");
  return `${String(phone).trim().startsWith("+") ? "+" : ""}${"•".repeat(Math.max(0, digits.length - 2))}${digits.slice(-2)}`;
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zoned(date, timeZone = "America/Los_Angeles") {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, weekday: WEEKDAYS[parts.weekday], minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + (m || 0);
}
