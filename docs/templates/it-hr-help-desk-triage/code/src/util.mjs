import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
export function clip(value, limit) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}
export function normalise(text) { return ` ${String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}@.' -]+/gu, " ").replace(/\s+/g, " ")} `; }
export function listFiles(dir, suffix = ".md") { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(suffix)).map((e) => join(dir, e.name)); }
export function maskPhone(phone) { if (!phone) return "anonymous"; const s = String(phone); return `${s.slice(0, 1)}${"•".repeat(Math.max(0, s.length - 3))}${s.slice(-2)}`; }
export function isAffirmative(text) { return /\b(yes|yeah|yep|correct|confirm|confirmed|please|ok|okay|sure|file it|go ahead)\b/i.test(text) && !/\b(no|nope|not|maybe|wait)\b/i.test(text); }
export function isNegative(text) { return /\b(no|nope|not now|maybe|wait|cancel)\b/i.test(text); }
