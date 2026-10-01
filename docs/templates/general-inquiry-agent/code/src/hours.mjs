import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import { config, referenceNow } from "./config.mjs";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const resolvePath = (p) => (isAbsolute(p) ? p : join(PKG_ROOT, p));
const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

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
    const { day, minutes } = localParts(at, this.timeZone);
    return this.staffedHours.some((w) => (w.days ?? []).includes(day) && minutes >= toMinutes(w.open) && minutes < toMinutes(w.close));
  }

  decision(at = this.now()) {
    if (this.isStaffed(at)) return { staffed: true, message: "Connecting you now", nextStaffed: null };
    return { staffed: false, message: this.afterHoursMessage, nextStaffed: this.nextStaffed(at) };
  }

  nextStaffed(at = this.now()) {
    for (let i = 0; i < 14; i += 1) {
      const probe = addDays(at, i);
      const { day } = localParts(probe, this.timeZone);
      const window = this.staffedHours.find((w) => (w.days ?? []).includes(day));
      if (!window) continue;
      if (i === 0 && localParts(at, this.timeZone).minutes >= toMinutes(window.close)) continue;
      return `${dayName(day)} ${window.open}`;
    }
    return null;
  }
}

function localParts(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { day: DAY_INDEX[parts.weekday], minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
const toMinutes = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + (m ?? 0); };
const addDays = (d, n) => new Date(d.getTime() + n * 86_400_000);
const dayName = (d) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d];
