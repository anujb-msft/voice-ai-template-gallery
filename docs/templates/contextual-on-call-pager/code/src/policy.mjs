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

export class PagerPolicy {
  constructor({ properties, tenants, oncall, triage, escalation }) {
    this.organization = properties.organization ?? "Contoso Property Management";
    this.properties = properties.properties;
    this.tenants = tenants.tenants.map((t) => ({ ...t, phone: normalisePhone(t.phone) }));
    this.oncall = oncall;
    this.triage = triage;
    this.escalation = escalation;
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

  onCallChain(group, at = new Date()) {
    const date = isoDate(at);
    const override = this.oncall.overrides.find((o) => o.group === group && o.date === date);
    const rotation = override ?? [...(this.oncall.rotations[group] ?? [])].filter((r) => r.startsOn <= date).sort((a, b) => b.startsOn.localeCompare(a.startsOn))[0];
    if (!rotation) throw new Error(`No on-call rotation for ${group}`);
    const property = this.properties.find((p) => p.group === group);
    return {
      primary: this.#tech(rotation.primary),
      secondary: this.#tech(rotation.secondary),
      propertyManager: this.#tech(property?.managerId),
      source: override ? `override:${override.reason}` : `rotation:${rotation.startsOn}`,
    };
  }

  levelContact(propertyId, level, at = new Date()) {
    const prop = this.property(propertyId);
    if (!prop) throw new Error(`Unknown property ${propertyId}`);
    return this.onCallChain(prop.group, at)[level];
  }

  #tech(id) {
    const tech = this.technicians.get(id);
    if (!tech) throw new Error(`Unknown on-call contact ${id}`);
    return { id: tech.id, name: tech.name, teamsUserId: tech.teamsUserId, mobile: tech.mobile };
  }
}

export function sanitizeTenantSaid(text, max = 160) {
  const cleaned = String(text ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/ignore (all|previous|above).{0,80}/gi, "[instruction removed]")
    .replace(/system prompt|developer message|tool call/gi, "[unsafe request removed]")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

export function buildPageBrief(incident, { includeTenantSaid = true } = {}) {
  const reported = new Date(incident.reportedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const parts = [
    `${title(incident.severity)}: ${incident.issueTypeLabel ?? incident.issueType ?? incident.issue} at ${incident.propertyName}, unit ${incident.unit}, reported ${reported}.`,
    `Tenant ${incident.permissionToEnter ? "gave" : "did not give"} permission to enter${incident.accessNotes ? `; access notes: ${incident.accessNotes}` : ""}.`,
  ];
  if (includeTenantSaid && incident.tenantSaid) parts.push(`Tenant said ${incident.tenantSaid}.`);
  parts.push("Press 1 or say 'I've got it' to accept.");
  return parts.join(" ");
}

export function buildVoicemailPrompt() {
  return "Contoso maintenance has an urgent page for you. Please call the maintenance line.";
}

function publicTenant(t) { return t ? { propertyId: t.propertyId, unit: t.unit } : null; }
function isoDate(value) { return new Date(value).toISOString().slice(0, 10); }
function title(value) { return String(value ?? "").replace(/^./, (c) => c.toUpperCase()); }
