import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import { config, referenceNow } from "./config.mjs";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const resolvePath = (p) => (isAbsolute(p) ? p : join(PKG_ROOT, p));
const MS_PER_DAY = 86_400_000;

export class ContentIndex {
  constructor(articles, { minScore = config.content.minScore, expiryGraceDays = config.content.expiryGraceDays, now = referenceNow } = {}) {
    this.articles = articles;
    this.minScore = minScore;
    this.expiryGraceDays = expiryGraceDays;
    this.now = now;
  }

  static load(path = config.content.articlesPath, opts = {}) {
    const dir = resolvePath(path);
    const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    return new ContentIndex(files.map((f) => parseArticle(readFileSync(join(dir, f), "utf8"), f)), opts);
  }

  summary(at = this.now()) {
    const counts = { fresh: 0, stale: 0, expired: 0 };
    for (const a of this.articles) counts[this.freshness(a, at).status] += 1;
    return { articleCount: this.articles.length, staleCount: counts.stale, expiredCount: counts.expired, topics: [...new Set(this.articles.map((a) => a.topic))].sort() };
  }

  freshness(article, at = this.now()) {
    const today = dateOnly(at);
    const reviewBy = dateOnly(article.reviewBy);
    const overdueDays = Math.floor((today - reviewBy) / MS_PER_DAY);
    if (overdueDays <= 0) return { status: "fresh", overdueDays: 0 };
    if (overdueDays <= this.expiryGraceDays) return { status: "stale", overdueDays };
    return { status: "expired", overdueDays };
  }

  search(query, { topic = null, limit = 3, at = this.now() } = {}) {
    const terms = tokenize(query).filter((t) => !STOP.has(t));
    const topicFilter = topic && topic !== "any" ? topic : null;
    const allMatches = [];

    for (const article of this.articles) {
      if (topicFilter && article.topic !== topicFilter) continue;
      const score = scoreArticle(article, terms);
      if (score <= 0) continue;
      const fresh = this.freshness(article, at);
      allMatches.push({ article, score, freshness: fresh.status });
    }

    allMatches.sort((a, b) => b.score - a.score || a.article.id.localeCompare(b.article.id));
    const expiredMatch = allMatches.some((m) => m.freshness === "expired" && m.score >= this.minScore);
    const topExpired = allMatches[0]?.freshness === "expired" && allMatches[0].score >= this.minScore;
    const scored = topExpired ? [] : allMatches.filter((m) => m.freshness !== "expired");
    if (!scored.length || scored[0].score < this.minScore) {
      return { miss: true, expiredMatch, passages: [], query, topic: topicFilter };
    }

    return {
      miss: false,
      expiredMatch,
      query,
      topic: topicFilter ?? scored[0].article.topic,
      passages: scored.slice(0, limit).map(({ article, score, freshness }) => ({
        articleId: article.id,
        title: article.title,
        topic: article.topic,
        section: article.sections[0]?.heading ?? "Overview",
        source: article.source,
        shortUrl: article.shortUrl,
        freshness,
        score: Number(score.toFixed(2)),
        reviewBy: article.reviewBy,
        lastReviewed: article.lastReviewed,
        owner: article.owner,
        text: article.sections[0]?.text ?? article.body,
      })),
    };
  }
}

function scoreArticle(article, terms) {
  if (!terms.length) return 0;
  let score = 0;
  const title = ` ${article.title.toLowerCase()} `;
  const tags = ` ${article.tags.join(" ").toLowerCase()} `;
  const topicWords = ` ${article.topic.replace(/-/g, " ")} `;
  const body = ` ${article.body.toLowerCase()} `;
  for (const term of terms) {
    if (title.includes(term)) score += 5;
    if (tags.includes(term)) score += 3;
    if (topicWords.includes(term)) score += 2;
    const matches = body.match(new RegExp(`\\b${escapeRegExp(term)}\\b`, "g"));
    if (matches) score += Math.min(matches.length, 4);
  }
  return score;
}

export function parseArticle(raw, filename = "article.md") {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/m.exec(raw);
  if (!match) throw new Error(`${filename} needs YAML front matter`);
  const meta = parseFrontMatter(match[1]);
  const body = match[2].trim();
  for (const key of ["id", "title", "topic", "owner", "source", "shortUrl", "lastReviewed", "reviewBy"]) {
    if (!meta[key]) throw new Error(`${filename} missing ${key}`);
  }
  return { ...meta, tags: meta.tags ?? [], body, sections: splitSections(body), filename };
}

function parseFrontMatter(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (/^\[.*\]$/.test(value)) {
      value = value.slice(1, -1).split(",").map((v) => v.trim()).filter(Boolean);
    }
    out[key] = value;
  }
  return out;
}

function splitSections(body) {
  const chunks = body.split(/^##\s+/m).filter(Boolean);
  if (!chunks.length) return [{ heading: "Overview", text: body }];
  return chunks.map((chunk) => {
    const [heading, ...rest] = chunk.split(/\r?\n/);
    return { heading: heading.trim(), text: rest.join("\n").trim().replace(/\s+/g, " ") };
  });
}

export function inferTopic(text) {
  const t = String(text ?? "").toLowerCase();
  if (/\b(hour|open|close|address|location|where|library|city hall|centre|center)\b/.test(t)) return "hours-locations";
  if (/\b(permit|licen[cs]e|dog|parking|yard|garage sale)\b/.test(t)) return "permits-licences";
  if (/\b(recycl|trash|waste|garbage|bulky|pickup|sofa|mattress|holiday schedule)\b/.test(t)) return "waste-recycling";
  if (/\b(eligib|discount|assistance|senior|income|benefit|recreation|garden)\b/.test(t)) return "benefits-eligibility";
  return null;
}

export function isServiceRequest(text) {
  return /\b(report|file|submit|request|complaint).{0,30}\b(pothole|missed|pickup|graffiti|streetlight|noise|service request)\b/i.test(String(text ?? ""));
}

export function hasPersonalEligibilityDetails(text) {
  return /\b(i am|i'm|my income|i make|household|i earn|i live|my age|i'm)\b/i.test(String(text ?? "")) && /\b(\d{2,}|income|earn|make|eligible|qualify|discount)\b/i.test(String(text ?? ""));
}

export function sanitizeForAudit(text) {
  return String(text ?? "")
    .replace(/\b\d{2,}\b/g, "[number]")
    .replace(/\$\s?\d[\d,]*/g, "[amount]")
    .slice(0, 160);
}

function tokenize(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((t) => t.length > 1).flatMap((t) => t.includes("-") ? [t, ...t.split("-")] : [t]);
}

const STOP = new Set(["the", "a", "an", "is", "are", "do", "does", "what", "where", "when", "how", "can", "i", "to", "for", "of", "and", "about", "with", "that", "this", "it", "there", "who", "tell", "me", "mayor", "private", "driver", "ignore", "previous", "instructions", "phone", "number"]);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const dateOnly = (value) => {
  if (value instanceof Date) return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const [y, m, d] = String(value).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
};
