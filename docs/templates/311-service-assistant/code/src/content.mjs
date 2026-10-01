import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.mjs";
import { norm } from "./fixtures.mjs";

export class ContentIndex {
  constructor(root, { now = () => Date.now(), expiryGraceDays = config.contentExpiryGraceDays } = {}) {
    this.root = root;
    this.now = now;
    this.expiryGraceDays = expiryGraceDays;
    this.articles = loadArticles(root, now, expiryGraceDays);
  }

  search(query, locale = "en-US", limit = 3) {
    const lang = locale.slice(0, 2);
    const words = new Set(norm(query).split(" ").filter((w) => w.length > 2));
    const scored = this.articles
      .filter((a) => a.locale === lang)
      .map((a) => {
        const hay = norm(`${a.title} ${a.topic} ${a.body}`);
        let score = 0;
        for (const w of words) if (hay.includes(w)) score += 1;
        return { ...a, score };
      })
      .filter((a) => a.score > 0 && a.freshness !== "expired")
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored.map(publicArticle);
  }

  summary() {
    const out = {};
    for (const article of this.articles) {
      out[article.locale] ??= { fresh: 0, stale: 0, expired: 0, total: 0 };
      out[article.locale][article.freshness] += 1;
      out[article.locale].total += 1;
    }
    return out;
  }
}

function loadArticles(root, now, expiryGraceDays) {
  const articles = [];
  for (const locale of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    for (const file of readdirSync(join(root, locale)).filter((f) => f.endsWith(".md"))) {
      const raw = readFileSync(join(root, locale, file), "utf8");
      const { meta, body } = parseFrontMatter(raw);
      const freshness = freshnessOf(meta.lastReviewed, now(), expiryGraceDays);
      articles.push({ ...meta, locale, body: body.trim(), freshness });
    }
  }
  return articles;
}

function parseFrontMatter(raw) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/m.exec(raw);
  if (!match) return { meta: {}, body: raw };
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
    freshness: a.freshness,
    passage: a.body,
    spokenCitation: `${a.source}${a.freshness === "stale" ? ", last reviewed earlier this year" : ""}`,
  };
}
