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

export class DepartmentDirectory {
  constructor(departments, holidays = []) {
    this.departments = departments;
    this.holidays = holidays;
    this.byId = new Map(departments.map((d) => [d.id, d]));
  }
  static load(departmentsPath, holidaysPath) { return new DepartmentDirectory(readJson(departmentsPath), readJson(holidaysPath)); }
  get(id) { return this.byId.get(id) ?? null; }
  owning(typeId) { return this.departments.find((d) => d.requestTypes?.includes(typeId)) ?? this.get("311-live"); }
  isHoliday(date) { return this.holidays.some((h) => h.date === isoDate(date)); }
  isOpen(id, date = new Date()) {
    const d = this.get(id);
    if (!d || this.isHoliday(date)) return false;
    const day = date.getDay();
    if (!d.hours.days.includes(day)) return false;
    const minutes = date.getHours() * 60 + date.getMinutes();
    const [oh, om] = d.hours.open.split(":").map(Number);
    const [ch, cm] = d.hours.close.split(":").map(Number);
    return minutes >= oh * 60 + om && minutes <= ch * 60 + cm;
  }
  nextBusinessPhrase(id) {
    const name = this.get(id)?.displayName ?? "that department";
    return `${name} will follow up on the next business day.`;
  }
  target(id) { return this.get(id)?.teamsQueue ?? null; }
  openSummary(date = new Date()) {
    return Object.fromEntries(this.departments.map((d) => [d.id, this.isOpen(d.id, date)]));
  }
}

export function isoDate(date) { return date.toISOString().slice(0, 10); }
export function norm(value) { return String(value ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim(); }
