import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config, nowDate } from "./config.mjs";
import { readJson, listFiles, normalise } from "./util.mjs";

export class Taxonomy {
  constructor(data) { this.topics = data.topics; this.byId = new Map(this.topics.map((t) => [t.id, t])); }
  static load(path = config.paths.taxonomy) { return new Taxonomy(readJson(path)); }
  get(id) { return this.byId.get(id); }
  classify(utterance, { confidenceMin = config.classifierConfidenceMin } = {}) {
    const t = normalise(utterance);
    const scored = this.topics.map((topic) => ({ topic, hits: topic.keywords.filter((k) => t.includes(normalise(k).trim())).length })).filter((x) => x.hits > 0).sort((a,b)=>b.hits-a.hits);
    if (!scored.length) return { domain: "unclear", confidence: 0, topicId: null, needsClarification: true };
    const [best, second] = scored;
    const confidence = best.topic.domain === "both" && best.hits >= 2 ? 0.92 : (second ? (second.hits === best.hits ? 0.45 : second.hits / best.hits >= 0.5 ? 0.6 : 0.82) : Math.min(0.98, 0.72 + best.hits * 0.12));
    return { domain: best.topic.domain, confidence, topicId: best.topic.id, needsClarification: confidence < confidenceMin };
  }
}

export class SensitiveGuard {
  constructor(data) { this.data = data; }
  static load(path = config.paths.sensitive) { return new SensitiveGuard(readJson(path)); }
  check(text) {
    const t = normalise(text);
    const risk = this.data.riskOfHarm.find((p) => t.includes(normalise(p).trim()));
    const phrase = this.data.phrases.find((p) => t.includes(normalise(p).trim()));
    return { sensitive: Boolean(risk || phrase), riskOfHarm: Boolean(risk), phrase: phrase ?? risk ?? null, safetyText: this.data.safety.en, acknowledgement: this.data.acknowledgement.en, afterHours: this.data.afterHours.en };
  }
}

export class PriorityMatrix {
  constructor(data) { this.data = data; }
  static load(path = config.paths.priority) { return new PriorityMatrix(readJson(path)); }
  priority({ impact = "me", blocked = false, securityCategory = null }) {
    if (securityCategory && this.data.securityIncidentCategories.includes(securityCategory)) return "P1";
    return this.data.matrix[impact]?.[blocked ? "blocked" : "not_blocked"] ?? "P4";
  }
}

export class OutagePolicy {
  constructor(data) { this.incidents = data.incidents; }
  static load(path = config.paths.outages) { return new OutagePolicy(readJson(path)); }
  active(at = nowDate()) { return this.incidents.filter((i) => new Date(i.activeFrom) <= at && at <= new Date(i.activeUntil)); }
  match(text, at = nowDate()) { const t = normalise(text); return this.active(at).find((i) => i.keywords.some((k) => t.includes(normalise(k).trim()))) ?? null; }
  banner(at = nowDate()) { return this.active(at).map((i) => i.banner).join(" "); }
}

export class RoutingPolicy {
  constructor(data) { this.organization = data.organization; this.destinations = data.destinations; this.fallbackDestination = data.fallbackDestination; this.byId = new Map(this.destinations.map((d) => [d.id, d])); }
  static load(path = config.paths.routing) { return new RoutingPolicy(readJson(path)); }
  get(id) { return this.byId.get(id); }
  routeForDigit(digit) { if (digit === "0") return this.fallbackDestination; return this.destinations.find((d) => d.dtmf === digit)?.id ?? null; }
  isOpen(id, at = nowDate()) {
    const d = this.get(id); if (!d) return false;
    const iso = at.toISOString().slice(0,10); if (d.holidays?.includes(iso)) return false;
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: d.hours.timeZone, hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit" }).formatToParts(at);
    const week = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 }[parts.find((p)=>p.type==="weekday").value];
    const hh = `${parts.find((p)=>p.type==="hour").value}:${parts.find((p)=>p.type==="minute").value}`;
    return d.hours.days.includes(week) && d.hours.open <= hh && (d.hours.close === "24:00" || hh < d.hours.close);
  }
}

function parseHeader(file) {
  const raw = readFileSync(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/m.exec(raw);
  if (!m) throw new Error(`missing front matter: ${file}`);
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":"); if (idx < 0) continue;
    const k = line.slice(0, idx).trim(); let v = line.slice(idx+1).trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1,-1).split(",").map((x)=>x.trim()).filter(Boolean);
    meta[k] = v;
  }
  return { ...meta, body: m[2].trim(), file };
}

export class KnowledgeBase {
  constructor(root = config.paths.kbRoot) {
    this.articles = [];
    for (const domain of ["it", "hr"]) this.articles.push(...listFiles(join(root, domain)).map(parseHeader));
    this.byId = new Map(this.articles.map((a) => [a.id, a]));
  }
  answer(articleId, { locale = "en", caller = null, at = nowDate() } = {}) {
    const a = this.byId.get(articleId); if (!a) return { available: false, reason: "missing" };
    if (new Date(a.reviewBy) < at) return { available: false, reason: "stale", article: a };
    if (a.audience === "managers" && caller?.role !== "manager") return { available: false, reason: "out_of_audience", article: a };
    if (a.audience !== "all" && a.audience !== "managers") return { available: false, reason: "out_of_audience", article: a };
    const locales = Array.isArray(a.locales) ? a.locales : [a.locales];
    const wanted = locale.startsWith("es") ? "ES" : "EN";
    const marker = new RegExp(`${wanted}:\\s*([\\s\\S]*?)(?:\\n\\n[A-Z]{2}:|$)`, "m");
    if (!locales.includes(locale.slice(0,2))) {
      const en = /EN:\s*([\s\S]*?)(?:\n\n[A-Z]{2}:|$)/m.exec(a.body)?.[1]?.trim() ?? a.body;
      return { available: true, englishOnly: true, article: a, text: `This answer is only available in English. ${en}` };
    }
    return { available: true, article: a, text: marker.exec(a.body)?.[1]?.trim() ?? a.body };
  }
  health(at = nowDate()) {
    const byDomain = { IT: { fresh: 0, stale: 0 }, HR: { fresh: 0, stale: 0 } };
    for (const a of this.articles) byDomain[a.domain][new Date(a.reviewBy) < at ? "stale" : "fresh"]++;
    return byDomain;
  }
}
