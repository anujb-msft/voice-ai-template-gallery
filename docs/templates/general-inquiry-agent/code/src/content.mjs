import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import { config, referenceNow } from "./config.mjs";
import { describeWeeklyHours, localDate, parseWeeklyHours, scheduleAt } from "./hours.mjs";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const resolvePath = (p) => (isAbsolute(p) ? p : join(PKG_ROOT, p));
const MS_PER_DAY = 86_400_000;

export class ContentIndex {
  /**
   * `timeZone` is the organization's: review dates are calendar dates there,
   * so an article does not expire hours early because UTC has already ticked
   * over to tomorrow.
   */
  constructor(articles, { minScore = config.content.minScore, expiryGraceDays = config.content.expiryGraceDays, now = referenceNow, timeZone = "UTC" } = {}) {
    this.articles = articles;
    this.minScore = minScore;
    this.expiryGraceDays = expiryGraceDays;
    this.now = now;
    this.timeZone = timeZone;
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

  /** Every article and how fresh it is on the policy's date, for the presenter console. */
  catalog(at = this.now()) {
    return this.articles.map((a) => ({
      id: a.id,
      title: a.title,
      topic: a.topic,
      owner: a.owner,
      shortUrl: a.shortUrl,
      lastReviewed: a.lastReviewed,
      reviewBy: a.reviewBy,
      ...this.freshness(a, at),
    }));
  }

  freshness(article, at = this.now()) {
    const today = dateOnly(calendarDate(at, this.timeZone));
    const reviewBy = dateOnly(article.reviewBy);
    const overdueDays = Math.round((today - reviewBy) / MS_PER_DAY);
    if (overdueDays <= 0) return { status: "fresh", overdueDays: 0, daysToReview: -overdueDays };
    if (overdueDays <= this.expiryGraceDays) return { status: "stale", overdueDays, expiresInDays: this.expiryGraceDays - overdueDays + 1 };
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
      allMatches.push({ article, score, fresh: this.freshness(article, at) });
    }

    allMatches.sort((a, b) => b.score - a.score || a.article.id.localeCompare(b.article.id));
    const isExpired = (m) => m.fresh.status === "expired";
    const expiredMatch = allMatches.some((m) => isExpired(m) && m.score >= this.minScore);
    // Who was held back, for the presenter console and the audit log only. The
    // model gets `expiredMatch` and nothing else, so it can never quote them.
    const withheld = allMatches
      .filter((m) => isExpired(m) && m.score >= this.minScore)
      .slice(0, limit)
      .map(({ article, score, fresh }) => ({
        articleId: article.id,
        title: article.title,
        owner: article.owner,
        source: article.source,
        shortUrl: article.shortUrl,
        lastReviewed: article.lastReviewed,
        reviewBy: article.reviewBy,
        overdueDays: fresh.overdueDays,
        score: Number(score.toFixed(2)),
      }));
    const topExpired = allMatches[0] && isExpired(allMatches[0]) && allMatches[0].score >= this.minScore;
    const scored = topExpired ? [] : allMatches.filter((m) => !isExpired(m));
    if (!scored.length || scored[0].score < this.minScore) {
      return { miss: true, expiredMatch, passages: [], query, topic: topicFilter, withheld };
    }

    return {
      miss: false,
      expiredMatch,
      query,
      topic: topicFilter ?? scored[0].article.topic,
      passages: scored.slice(0, limit).map(({ article, score, fresh }) => ({
        articleId: article.id,
        title: article.title,
        topic: article.topic,
        section: article.sections[0]?.heading ?? "Overview",
        source: article.source,
        shortUrl: article.shortUrl,
        freshness: fresh.status,
        overdueDays: fresh.overdueDays,
        ...(fresh.status === "stale" ? { expiresInDays: fresh.expiresInDays } : {}),
        score: Number(score.toFixed(2)),
        reviewBy: article.reviewBy,
        lastReviewed: article.lastReviewed,
        owner: article.owner,
        // Open or closed now, worked out by the server from the article's own
        // published hours — never by the model.
        ...(article.schedule?.length
          ? { hoursNow: { place: article.place ?? null, ...scheduleAt(article.schedule, asDate(at), this.timeZone), hoursText: describeWeeklyHours(article.schedule) } }
          : {}),
        text: article.sections[0]?.text ?? article.body,
      })),
      withheld,
    };
  }
}

function scoreArticle(article, terms) {
  if (!terms.length) return 0;
  let score = 0;
  const title = article.title.toLowerCase();
  const tags = article.tags.join(" ").toLowerCase();
  const topicWords = article.topic.replace(/-/g, " ");
  const body = article.body.toLowerCase();
  for (const term of terms) {
    // From the start of a word ("park" finds "parking"), never from the middle:
    // "all" must not score against "City Hall", nor "age" against "garage sale".
    const wordStart = new RegExp(`\\b${escapeRegExp(term)}`);
    if (wordStart.test(title)) score += 5;
    if (wordStart.test(tags)) score += 3;
    if (wordStart.test(topicWords)) score += 2;
    const matches = body.match(new RegExp(`\\b${escapeRegExp(term)}\\b`, "g"));
    if (matches) score += Math.min(matches.length, 4);
  }
  return score;
}

export function parseArticle(raw, filename = "article.md") {
  // Normalize CRLF so Windows checkouts (core.autocrlf=true) parse the same as LF.
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/m.exec(raw.replace(/\r\n?/g, "\n"));
  if (!match) throw new Error(`${filename} needs YAML front matter`);
  const meta = parseFrontMatter(match[1]);
  const body = match[2].trim();
  for (const key of ["id", "title", "topic", "owner", "source", "shortUrl", "lastReviewed", "reviewBy"]) {
    if (!meta[key]) throw new Error(`${filename} missing ${key}`);
  }
  const schedule = meta.openHours ? parseWeeklyHours(meta.openHours) : null;
  return { ...meta, tags: meta.tags ?? [], body, sections: splitSections(body), schedule, filename };
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

// "you" and friends carry no topic, and "you" would otherwise prefix-match the
// "youth" tag, so every "Can you…" question scored against fee assistance.
const STOP = new Set(["the", "a", "an", "is", "are", "do", "does", "what", "where", "when", "how", "can", "i", "to", "for", "of", "and", "about", "with", "that", "this", "it", "there", "who", "tell", "me", "you", "your", "my", "we", "our", "us", "please", "mayor", "private", "driver", "ignore", "previous", "instructions", "phone", "number"]);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const asDate = (at) => (at instanceof Date ? at : new Date(at));
// A bare "YYYY-MM-DD" is already a calendar date; anything else is an instant,
// read as a date in the organization's time zone.
const calendarDate = (at, timeZone) => (typeof at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(at) ? at : localDate(asDate(at), timeZone));
const dateOnly = (value) => {
  const [y, m, d] = String(value).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
};
