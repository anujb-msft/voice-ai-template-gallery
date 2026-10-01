import { fixtures } from "./config.mjs";

export class SchedulingRoutes {
  constructor(doc = fixtures.routing) { this.doc = doc; }
  get(destination) { return this.doc.destinations[destination] ?? null; }
  context(destination, values = {}) {
    const route = this.get(destination);
    if (!route) throw new Error(`unknown destination ${destination}`);
    return Object.fromEntries((route.fields ?? []).map((f) => [f, values[f] ?? null]));
  }
  menu() { return Object.entries(this.doc.destinations).map(([id, r]) => ({ id, topic: r.topic, fields: r.fields })); }
}

export function maskPhone(phone) {
  if (!phone) return "anonymous";
  const digits = String(phone).replace(/\D/g, "");
  return `${String(phone).trim().startsWith("+") ? "+" : ""}${"•".repeat(Math.max(0, digits.length - 2))}${digits.slice(-2)}`;
}
