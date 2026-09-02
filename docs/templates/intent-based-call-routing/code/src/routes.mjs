import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import { config } from "./config.mjs";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const resolvePath = (p) => (isAbsolute(p) ? p : join(PKG_ROOT, p));

const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + (m ?? 0);
}

/** Weekday and minute-of-day for `date` as observed in `timeZone`. */
function localParts(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    day: DAY_INDEX[parts.weekday],
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/**
 * The routing policy.
 *
 * This is the allowlist. The model proposes a route *id* and nothing else — it
 * never sees or supplies a Teams object id, a phone number, or a URL, so a
 * confused or adversarial caller cannot talk the agent into dialling somewhere
 * it was not configured to reach.
 */
export class RoutePolicy {
  constructor(doc) {
    const routes = doc?.routes ?? [];
    if (!routes.length) throw new Error("routes.json contains no routes");

    this.organization = doc.organization ?? "the organisation";
    this.fallbackRouteId = doc.fallbackRouteId ?? "reception";
    this.byId = new Map();
    this.byDtmf = new Map();

    for (const route of routes) {
      if (!route.id) throw new Error("every route needs an id");
      if (this.byId.has(route.id)) throw new Error(`duplicate route id: ${route.id}`);
      if (!route.target?.objectId) throw new Error(`route ${route.id} has no target objectId`);
      this.byId.set(route.id, route);
      if (route.dtmf) this.byDtmf.set(String(route.dtmf), route.id);
    }

    if (!this.byId.has(this.fallbackRouteId)) {
      throw new Error(`fallbackRouteId ${this.fallbackRouteId} is not a defined route`);
    }
    if (!this.isOpen(this.fallbackRouteId, new Date())) {
      // Not fatal, but it means a late caller can be left with nowhere to go.
      console.warn(`[routes] fallback route ${this.fallbackRouteId} is currently closed`);
    }
  }

  static load(path = config.routing.routesPath) {
    return new RoutePolicy(JSON.parse(readFileSync(resolvePath(path), "utf8")));
  }

  get ids() {
    return [...this.byId.keys()];
  }

  get(routeId) {
    return this.byId.get(routeId) ?? null;
  }

  has(routeId) {
    return this.byId.has(routeId);
  }

  routeForDigit(digit) {
    return this.byDtmf.get(String(digit)) ?? null;
  }

  isOpen(routeId, now = new Date()) {
    const route = this.get(routeId);
    if (!route) return false;
    const hours = route.hours ?? {};
    if (hours.alwaysOpen) return true;
    const { day, minutes } = localParts(now, hours.timeZone ?? "UTC");
    if (!(hours.days ?? []).includes(day)) return false;
    return minutes >= toMinutes(hours.open ?? "00:00") && minutes < toMinutes(hours.close ?? "24:00");
  }

  /**
   * Turn a confirmed route id into what should actually happen now.
   *
   * Returns either a transfer target or an instruction to take a message. The
   * `route` hop is followed at most once so a misconfigured pair of routes
   * cannot loop.
   */
  resolve(routeId, now = new Date()) {
    const route = this.get(routeId);
    if (!route) return { ok: false, reason: "unknown_route" };

    if (this.isOpen(routeId, now)) {
      return { ok: true, action: "transfer", routeId, target: route.target, afterHours: false };
    }

    const after = route.afterHours ?? { behavior: "route", routeId: this.fallbackRouteId };

    if (after.behavior === "message") {
      return { ok: true, action: "message", routeId, afterHours: true };
    }

    const altId = after.routeId ?? this.fallbackRouteId;
    const alt = this.get(altId);
    if (!alt) return { ok: false, reason: "unknown_after_hours_route" };

    return {
      ok: true,
      action: "transfer",
      routeId: altId,
      target: alt.target,
      afterHours: true,
      divertedFrom: routeId,
    };
  }

  /** The menu the model is given. Descriptions only — never targets. */
  menu() {
    return [...this.byId.values()].map((r) => ({
      id: r.id,
      label: r.label ?? r.id,
      description: r.description ?? "",
      dtmf: r.dtmf ?? null,
    }));
  }

  menuText() {
    return this.menu()
      .map((r) => `- ${r.id} (${r.label}): ${r.description}${r.dtmf ? ` Keypad ${r.dtmf}.` : ""}`)
      .join("\n");
  }
}

/**
 * Seeded caller directory.
 *
 * A caller-ID match is a convenience, never proof. Everything this returns is
 * marked unverified and is passed to Teams that way.
 */
export class CallerDirectory {
  constructor(doc) {
    this.byPhone = new Map();
    for (const caller of doc?.callers ?? []) {
      if (caller.phone) this.byPhone.set(normalisePhone(caller.phone), caller);
    }
  }

  static load(path = config.routing.callersPath) {
    return new CallerDirectory(JSON.parse(readFileSync(resolvePath(path), "utf8")));
  }

  lookup(phone) {
    if (!phone) return null;
    const hit = this.byPhone.get(normalisePhone(phone));
    return hit ? { ...hit, verified: false } : null;
  }
}

export function normalisePhone(phone) {
  return String(phone).replace(/[^\d+]/g, "");
}

/** Never log or display a caller's full number — the last two digits are enough to tell demo callers apart. */
export function maskPhone(phone) {
  if (!phone) return "anonymous";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length <= 2) return "•".repeat(digits.length) || "anonymous";
  const plus = String(phone).trim().startsWith("+") ? "+" : "";
  return `${plus}${"•".repeat(digits.length - 2)}${digits.slice(-2)}`;
}
