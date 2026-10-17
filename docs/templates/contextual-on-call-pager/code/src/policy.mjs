import { readFileSync } from "node:fs";
import { config } from "./config.mjs";

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function normalisePhone(phone) {
  const raw = String(phone ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  if (raw.startsWith("+") && digits) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return digits ? `+${digits}` : null;
}

export function maskPhone(phone) {
  const digits = String(phone ?? "").replace(/\D+/g, "");
  if (!digits) return null;
  return `•••-${digits.slice(-4)}`;
}

export function groupedDigits(phone) {
  const digits = String(phone ?? "").replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  return digits.replace(/(.{1,3})/g, "$1 ").trim();
}

const norm = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const containsAny = (text, keywords = []) => keywords.find((k) => text.includes(norm(k)));
const severityRank = { routine: 0, urgent: 1, emergency: 2 };
export const outranks = (a, b) => (severityRank[a] ?? -1) > (severityRank[b] ?? -1);

export const DEFAULT_TIME_ZONE = "America/Los_Angeles";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The wall-clock date and time of `at` where the buildings are. Rotations and
 * overrides are written as local dates, so the pager turns over at local
 * midnight: 11:42 PM on Wednesday is still Wednesday's rotation, even though
 * it is already Thursday in UTC.
 */
export function localParts(at, timeZone = DEFAULT_TIME_ZONE) {
  const parts = {};
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (const { type, value } of format.formatToParts(new Date(at))) parts[type] = value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** `toLocaleString` in the buildings' time zone, with plain spaces (ICU puts a narrow one before AM/PM). */
export function formatLocal(at, timeZone = DEFAULT_TIME_ZONE, options = {}) {
  return new Date(at).toLocaleString("en-US", { timeZone, ...options }).replace(/[\u202f\u00a0]/g, " ");
}

/** "2026-09-28" → "Mon, Sep 28". */
export function dayLabel(isoDay) {
  return new Date(`${isoDay}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** When the office picks up a routine work order logged at `at`. */
export function nextBusinessDay(at, timeZone = DEFAULT_TIME_ZONE) {
  const { weekday, hour } = localParts(at, timeZone);
  const day = WEEKDAYS.indexOf(weekday);
  if (day >= 1 && day <= 5 && hour < 8) return "this morning";
  if (day === 5 || day === 6 || day === 0) return "Monday morning";
  return "tomorrow morning";
}

export class PagerPolicy {
  constructor({ properties, tenants, oncall, triage, escalation }) {
    this.organization = properties.organization ?? "Contoso Property Management";
    this.properties = properties.properties;
    this.tenants = tenants.tenants.map((t) => ({ ...t, phone: normalisePhone(t.phone) }));
    this.oncall = oncall;
    this.triage = triage;
    this.escalation = escalation;
    this.timeZone = oncall.timeZone ?? DEFAULT_TIME_ZONE;
    this.technicians = new Map(oncall.technicians.map((t) => [t.id, t]));
  }

  static load(paths = config.paths) {
    return new PagerPolicy({
      properties: readJson(paths.properties),
      tenants: readJson(paths.tenants),
      oncall: readJson(paths.oncall),
      triage: readJson(paths.triage),
      escalation: readJson(paths.escalation),
    });
  }

  groups() { return [...new Set(this.properties.map((p) => p.group))]; }
  property(id) { return this.properties.find((p) => p.id === id) ?? null; }
  propertyByName(name) {
    const n = norm(name);
    return this.properties.find((p) => p.id === n || norm(p.name) === n || p.aliases?.some((a) => norm(a) === n || n.includes(norm(a)))) ?? null;
  }
  tenantByPhone(phone) { return this.tenants.find((t) => t.phone === normalisePhone(phone)) ?? null; }
  tenantByUnit(propertyId, unit) { return this.tenants.find((t) => t.propertyId === propertyId && norm(t.unit) === norm(unit)) ?? null; }

  identifyUnit({ fromPhone = null, property = null, unit = null } = {}) {
    const matched = this.tenantByPhone(fromPhone);
    if (matched && !property && !unit) {
      const prop = this.property(matched.propertyId);
      return { ok: true, source: "callerId", tenant: publicTenant(matched), property: prop, unit: matched.unit, prompt: `Is this about unit ${matched.unit} at ${prop.name}?` };
    }
    const prop = property ? this.propertyByName(property) : matched ? this.property(matched.propertyId) : null;
    const finalUnit = unit ?? matched?.unit;
    if (!prop) return { ok: false, reason: "unknown_property", message: "I could not find that property." };
    if (!finalUnit) return { ok: false, reason: "missing_unit", message: "Please tell me the unit number." };
    const tenant = this.tenantByUnit(prop.id, finalUnit);
    if (!tenant) return { ok: false, reason: "invalid_unit", property: prop.name, unit: finalUnit, message: `I could not validate unit ${finalUnit} at ${prop.name}.` };
    return { ok: true, source: matched ? "callerIdConfirmed" : "stated", tenant: publicTenant(tenant), property: prop, unit: tenant.unit, prompt: `Thank you — I have ${prop.name}, unit ${tenant.unit}.` };
  }

  classify(fields) {
    const text = norm([fields.issue, fields.details, fields.tenantSaid].filter(Boolean).join(" "));
    const emergencyKeyword = containsAny(text, this.triage.emergency.keywords);
    if (emergencyKeyword) return { severity: "emergency", issueType: "emergency", matchedRule: `emergency:${emergencyKeyword}`, safetyLine: this.triage.emergency.safetyLine };

    const activeLeak = containsAny(text, this.triage.urgent.activeLeak);
    if (activeLeak) return { severity: "urgent", issueType: "active_leak", matchedRule: `urgent:active_leak:${activeLeak}`, safetyLine: this.triage.urgent.safetyLines.active_leak };
    const lockout = containsAny(text, this.triage.urgent.lockout);
    if (lockout) return { severity: "urgent", issueType: "lockout", matchedRule: `urgent:lockout:${lockout}`, safetyLine: this.triage.urgent.safetyLines.lockout };
    const power = containsAny(text, this.triage.urgent.noPower);
    if (power) return { severity: "urgent", issueType: "no_power", matchedRule: `urgent:no_power:${power}`, safetyLine: this.triage.urgent.safetyLines.no_power };
    const heat = containsAny(text, this.triage.urgent.noHeat);
    if (heat) {
      const temp = Number(fields.indoorTempF ?? fields.temperatureF);
      if (Number.isFinite(temp) && temp <= this.triage.noHeatThresholdF) {
        return { severity: "urgent", issueType: "no_heat", matchedRule: `urgent:no_heat:${temp}F`, safetyLine: this.triage.urgent.safetyLines.no_heat };
      }
      return { severity: "routine", issueType: "no_heat", matchedRule: Number.isFinite(temp) ? `routine:no_heat_above_threshold:${temp}F` : "routine:no_heat_missing_temperature", safetyLine: null, missingSlots: Number.isFinite(temp) ? [] : ["indoorTempF"] };
    }
    const routine = containsAny(text, this.triage.routine.keywords);
    return { severity: "routine", issueType: routine ? "routine_maintenance" : "routine_other", matchedRule: routine ? `routine:${routine}` : "routine:default", safetyLine: null };
  }

  /**
   * Who is on call for `group` at `at`, and why. An override for the local
   * date wins over the rotation; otherwise the latest rotation that has
   * started. Before the first rotation starts, the earliest one on file
   * answers, so the pager never has nobody to call. `why` is the
   * plain-English reason the console shows.
   */
  onCallChain(group, at = new Date()) {
    const local = localParts(at, this.timeZone);
    const override = this.oncall.overrides.find((o) => o.group === group && o.date === local.date);
    const rotations = [...(this.oncall.rotations[group] ?? [])].sort((a, b) => b.startsOn.localeCompare(a.startsOn));
    const rotation = rotations.find((r) => r.startsOn <= local.date) ?? null;
    const earliest = rotations.at(-1) ?? null;
    const chosen = override ?? rotation ?? earliest;
    if (!chosen) throw new Error(`No on-call rotation for ${group}`);
    const property = this.properties.find((p) => p.group === group);
    return {
      group,
      primary: this.#tech(chosen.primary),
      secondary: this.#tech(chosen.secondary),
      propertyManager: this.#tech(property?.managerId),
      source: override ? `override:${override.reason}` : rotation ? `rotation:${rotation.startsOn}` : `rotation:${earliest.startsOn}:earliest`,
      why: override
        ? `${title(override.reason)} override for ${dayLabel(override.date)} — replaces the ${group} rotation`
        : rotation
          ? `${title(group)} rotation since ${dayLabel(rotation.startsOn)}`
          : `Earliest ${group} rotation on file (starts ${dayLabel(earliest.startsOn)})`,
      localDate: local.date,
      localTime: formatLocal(at, this.timeZone, { weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" }),
      weekend: local.weekday === "Sat" || local.weekday === "Sun",
      timeZone: this.timeZone,
    };
  }

  onCallForProperty(propertyId, at = new Date()) {
    const prop = this.property(propertyId);
    if (!prop) throw new Error(`Unknown property ${propertyId}`);
    return this.onCallChain(prop.group, at);
  }

  levelContact(propertyId, level, at = new Date()) {
    return this.onCallForProperty(propertyId, at)[level];
  }

  #tech(id) {
    const tech = this.technicians.get(id);
    if (!tech) throw new Error(`Unknown on-call contact ${id}`);
    return { id: tech.id, name: tech.name, teamsUserId: tech.teamsUserId, mobile: tech.mobile };
  }
}

/** Seven or more digits, with the separators people dictate them with: a phone number, never page material. */
const PHONE_LIKE = /(?<![\w+])\+?\(?\d(?:[\s().-]{0,2}\d){6,}/g;

/**
 * The tenant's words as they may appear on a page: one line, capped, with
 * instruction-like text and phone numbers removed. A live model fills these
 * fields, so the server scrubs them rather than trusting the prompt.
 */
export function sanitizeTenantSaid(text, max = 160) {
  const cleaned = String(text ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/ignore (all|previous|above).{0,80}/gi, "[instruction removed]")
    .replace(/system prompt|developer message|tool call/gi, "[unsafe request removed]")
    .replace(PHONE_LIKE, "[number removed]")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The page brief, built by the server from captured fields — never by the
 * model. A short read-aloud: what, where, how bad, when, the tenant's
 * own words (sanitized and capped), and whether the technician may go in.
 * Phone numbers are never part of it.
 */
export function buildPageBrief(incident, { includeTenantSaid = true, timeZone = DEFAULT_TIME_ZONE } = {}) {
  const reported = formatLocal(incident.reportedAt, timeZone, { hour: "numeric", minute: "2-digit" });
  const temp = indoorTemp(incident);
  const parts = [
    `${title(incident.severity)}: ${issueWords(incident)} at ${incident.propertyName}, unit ${incident.unit}${
      temp ? `, ${temp} degrees inside` : ""
    }, reported ${reported}.`,
  ];
  if (includeTenantSaid && incident.tenantSaid) parts.push(`Tenant said: ${sentence(incident.tenantSaid)}`);
  const notes = incident.accessNotes && incident.accessNotes !== "none" ? ` Access: ${sentence(incident.accessNotes)}` : "";
  parts.push(`${incident.permissionToEnter ? "You may enter." : "No permission to enter."}${notes}`);
  parts.push("Press 1 or say 'I've got it' to accept.");
  return parts.join(" ");
}

/**
 * What an answering machine hears: nothing about the building, the unit, the
 * problem or the tenant — a voicemail box can be shared, or played back on
 * speaker. Only a callback prompt and a short reference that matches the
 * incident in the audit trail.
 */
export function buildVoicemailPrompt(incident = null) {
  const prompt = "Contoso maintenance has an urgent page for you. Please call the maintenance line.";
  return incident?.id ? `${prompt} Reference ${incidentReference(incident.id).split("").join(" ")}.` : prompt;
}

/** A four-digit reference for an incident id — speakable, and meaningless on its own. */
export function incidentReference(id) {
  let hash = 0;
  for (const ch of String(id ?? "")) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return String(1000 + (hash % 9000));
}

/** Roughly how long `text` takes to read aloud, in seconds. */
export function spokenSeconds(text) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 2.6));
}

function issueWords(incident) {
  const keyword = /emergency:([^:]+)$/.exec(incident.matchedRule ?? "")?.[1];
  if (incident.severity === "emergency" && keyword) return keyword;
  return incident.issueTypeLabel ?? incident.issueType ?? incident.issue;
}
function indoorTemp(incident) {
  return incident.issueType === "no_heat" ? (/no_heat(?:_above_threshold)?:(\d+)F/.exec(incident.matchedRule ?? "")?.[1] ?? null) : null;
}
function sentence(text) {
  const t = String(text ?? "").trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}
function publicTenant(t) { return t ? { propertyId: t.propertyId, unit: t.unit } : null; }
function title(value) { return String(value ?? "").replace(/^./, (c) => c.toUpperCase()); }
