import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.mjs";
import { norm } from "./fixtures.mjs";

// Words that say nothing about the topic. Without this, "what are the counter
// hours" matches every article that contains "the".
const STOPWORDS = new Set(
  (
    "the and what are when where how for you your can does with about there this that have has had need want would like please tell " +
    "know any our from will get also its which who why was were been much many some more most could should may might did not but all " +
    "out just into than then them they their his her she him one two hi hello hey thanks thank okay yes " +
    "que los las del una uno unos unas por para con cuando donde como cual cuales hay son esta este esto estan necesito quiero sobre " +
    "mis sus tiene tengo puede puedo usted ustedes hola gracias buenos buenas dias tardes"
  ).split(" "),
);

export class ContentIndex {
  constructor(root, { now = () => Date.now(), expiryGraceDays = config.contentExpiryGraceDays } = {}) {
    this.root = root;
    this.now = now;
    this.expiryGraceDays = expiryGraceDays;
    this.articles = loadArticles(root);
  }

  /** Judged on every lookup, so a demo clock (or a long-running server) sees today's freshness. */
  freshness(article, nowMs = this.now()) {
    return freshnessOf(article.lastReviewed, nowMs, this.expiryGraceDays);
  }

  /** Approved passages, best match first. Expired articles are never returned. */
  search(query, locale = "en-US", limit = 3) {
    return this.lookup(query, locale, limit).passages;
  }

  /** The same search, plus the expired articles that matched and were held back. */
  lookup(query, locale = "en-US", limit = 3) {
    const lang = String(locale).slice(0, 2);
    const words = queryWords(query);
    const nowMs = this.now();
    const scored = this.articles
      .filter((a) => a.locale === lang)
      .map((a) => {
        const hay = norm(`${a.title} ${a.topic} ${a.body}`);
        let score = 0;
        for (const w of words) if (hay.includes(w)) score += 1;
        return { ...a, score, freshness: this.freshness(a, nowMs) };
      })
      .filter((a) => a.score > 0)
      .sort((a, b) => b.score - a.score);
    // Only the closest expired matches are worth naming as withheld.
    const expired = scored.filter((a) => a.freshness === "expired");
    const top = expired[0]?.score;
    return {
      words: [...words],
      passages: scored.filter((a) => a.freshness !== "expired").slice(0, limit).map(publicArticle),
      withheld: expired.filter((a) => a.score === top).slice(0, limit).map(publicArticle),
    };
  }

  summary() {
    const out = {};
    const nowMs = this.now();
    for (const article of this.articles) {
      out[article.locale] ??= { fresh: 0, stale: 0, expired: 0, total: 0 };
      out[article.locale][this.freshness(article, nowMs)] += 1;
      out[article.locale].total += 1;
    }
    return out;
  }
}

function queryWords(query) {
  return new Set(norm(query).split(" ").filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

function loadArticles(root) {
  const articles = [];
  for (const locale of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    for (const file of readdirSync(join(root, locale)).filter((f) => f.endsWith(".md"))) {
      const raw = readFileSync(join(root, locale, file), "utf8");
      const { meta, body } = parseFrontMatter(raw);
      articles.push({ ...meta, locale, body: body.trim() });
    }
  }
  return articles;
}

function parseFrontMatter(raw) {
  // Normalize CRLF so Windows checkouts (core.autocrlf=true) parse the same as LF.
  const text = raw.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/m.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > -1) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: match[2] };
}

export function freshnessOf(lastReviewed, nowMs, expiryGraceDays) {
  const reviewed = Date.parse(lastReviewed);
  if (!Number.isFinite(reviewed)) return "expired";
  const ageDays = (nowMs - reviewed) / 86400000;
  if (ageDays <= 180) return "fresh";
  if (ageDays <= 180 + expiryGraceDays) return "stale";
  return "expired";
}

function publicArticle(a) {
  return {
    id: a.id,
    title: a.title,
    topic: a.topic,
    owner: a.owner,
    source: a.source,
    shortUrl: a.shortUrl,
    lastReviewed: a.lastReviewed,
    freshness: a.freshness,
    passage: a.body,
    spokenCitation: `${a.source}${a.freshness === "stale" ? (a.locale === "es" ? ", revisado a principios de este año" : ", last reviewed earlier this year") : ""}`,
  };
}
