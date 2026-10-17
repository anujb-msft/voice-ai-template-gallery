import { readFileSync } from "node:fs";

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export class RequestCatalog {
  constructor(types) {
    this.types = types;
    this.byId = new Map(types.map((t) => [t.id, t]));
  }
  static load(path) { return new RequestCatalog(readJson(path)); }
  get(id) { return this.byId.get(id) ?? null; }
  ids() { return [...this.byId.keys()]; }
  /** What the caller hears: "pothole", "bache". */
  label(id, locale = "en-US") {
    const type = this.get(id);
    const lang = String(locale).slice(0, 2);
    return type?.label?.[lang] ?? type?.label?.en ?? String(id).replaceAll("-", " ");
  }
  match(text, locale = "en") {
    const t = norm(text);
    let best = null;
    for (const type of this.types) {
      for (const lang of [locale.slice(0,2), "en", "es"]) {
        for (const name of type.names?.[lang] ?? []) {
          if (t.includes(norm(name))) {
            const score = norm(name).split(" ").length;
            if (!best || score > best.score) best = { type, score };
          }
        }
      }
    }
    return best?.type ?? null;
  }
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formatters = new Map();

/**
 * The calendar date, weekday and minute of the day in a time zone. Office
 * hours are judged in the city's zone, never the zone of the machine the
 * server happens to run on.
 */
export function zonedParts(date, timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    formatters.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, day: WEEKDAYS.indexOf(p.weekday), minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

export class DepartmentDirectory {
  constructor(departments, holidays = []) {
    this.departments = departments;
    this.holidays = holidays;
    this.byId = new Map(departments.map((d) => [d.id, d]));
    this.timeZone = departments.find((d) => d.hours?.timeZone)?.hours.timeZone ?? "America/Los_Angeles";
  }
  static load(departmentsPath, holidaysPath) { return new DepartmentDirectory(readJson(departmentsPath), readJson(holidaysPath)); }
  get(id) { return this.byId.get(id) ?? null; }
  owning(typeId) { return this.departments.find((d) => d.requestTypes?.includes(typeId)) ?? this.get("311-live"); }
  holidayOn(date, timeZone = this.timeZone) { const day = zonedParts(date, timeZone).date; return this.holidays.find((h) => h.date === day) ?? null; }
  isHoliday(date, timeZone = this.timeZone) { return Boolean(this.holidayOn(date, timeZone)); }
  isOpen(id, date = new Date()) {
    const d = this.get(id);
    if (!d) return false;
    const zone = d.hours.timeZone ?? this.timeZone;
    if (this.isHoliday(date, zone)) return false;
    const { day, minutes } = zonedParts(date, zone);
    if (!d.hours.days.includes(day)) return false;
    return minutes >= toMinutes(d.hours.open) && minutes <= toMinutes(d.hours.close);
  }

  /** The name the agent says: "Public Works", "Obras Públicas", "a 311 agent". */
  spokenName(id, locale = "en-US") {
    const d = this.get(id);
    const lang = String(locale).slice(0, 2);
    return d?.spoken?.[lang] ?? d?.spoken?.en ?? d?.displayName ?? (lang === "es" ? "ese departamento" : "that department");
  }
  /** "weekdays from 8 a.m. to 5 p.m." / "de lunes a viernes, de 8 a. m. a 5 p. m." */
  hoursPhrase(id, locale = "en-US") {
    const hours = this.get(id)?.hours;
    if (!hours) return "";
    const es = String(locale).startsWith("es");
    const days = hours.days.length === 7 ? (es ? "todos los días" : "every day") : sameDays(hours.days, [1, 2, 3, 4, 5]) ? (es ? "de lunes a viernes" : "weekdays") : hours.days.map((d) => (es ? DIAS : DAYS)[d]).join(", ");
    return es ? `${days}, de ${clock(hours.open, true)} a ${clock(hours.close, true)}` : `${days} from ${clock(hours.open)} to ${clock(hours.close)}`;
  }
  /** Said when a transfer would land on a closed queue. */
  closedPhrase(id, locale = "en-US") {
    const name = this.spokenName(id, locale);
    return String(locale).startsWith("es")
      ? `${capitalize(name)} atiende ${this.hoursPhrase(id, locale)}, así que no puedo comunicarle en este momento.`
      : `${capitalize(name)} can take calls ${this.hoursPhrase(id, locale)}, so I can't connect you right now.`;
  }
  nextBusinessPhrase(id, locale = "en-US") {
    const name = capitalize(this.spokenName(id, locale));
    return String(locale).startsWith("es") ? `${name} le dará seguimiento el próximo día hábil.` : `${name} will follow up on the next business day.`;
  }
  /** The date `count` business days after `date` in the city's zone, skipping weekends and holidays. */
  addBusinessDays(date, count) {
    const day = new Date(`${zonedParts(date, this.timeZone).date}T12:00:00Z`);
    let added = 0;
    while (added < count) {
      day.setUTCDate(day.getUTCDate() + 1);
      const iso = day.toISOString().slice(0, 10);
      if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6 && !this.holidays.some((h) => h.date === iso)) added += 1;
    }
    return day.toISOString().slice(0, 10);
  }
  target(id) { return this.get(id)?.teamsQueue ?? null; }
  openSummary(date = new Date()) {
    return Object.fromEntries(this.departments.map((d) => [d.id, this.isOpen(d.id, date)]));
  }
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}
function clock(hhmm, es = false) {
  const [h, m] = String(hhmm).split(":").map(Number);
  const suffix = h < 12 ? (es ? "a. m." : "a.m.") : es ? "p. m." : "p.m.";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""} ${suffix}`;
}
function sameDays(a, b) { return a.length === b.length && a.every((d) => b.includes(d)); }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

export function isoDate(date) { return date.toISOString().slice(0, 10); }
export function norm(value) { return String(value ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim(); }
