#!/usr/bin/env node
/** Generate browser and machine-readable indexes for the static template catalog. */
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const docsDir = path.join(root, "docs");
const templatesDir = path.join(docsDir, "templates");
const dataDir = path.join(docsDir, "data");
const allowedTemplateFields = new Set([
  "$schema", "id", "name", "language", "useCase", "assistant", "headline", "prompt",
  "description", "tags", "colors", "onAccent", "font", "radius", "readiness",
  "business", "technical", "paths", "assets"
]);
const requiredStrings = [
  "id", "name", "language", "useCase", "assistant", "headline", "prompt", "description",
  "onAccent", "font", "radius", "readiness"
];

function fail(file, message) {
  throw new Error(`${path.relative(root, file)}: ${message}`);
}

function requireExactKeys(value, allowed, file, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(file, `${label} contains unsupported fields: ${unknown.join(", ")}`);
}

/**
 * Best-effort repository metadata used only to build a real "open on GitHub"
 * link for each template folder. This is site configuration, not template
 * business data, so it is never duplicated into template.json manifests.
 * Resolution order (first match wins):
 *   1. docs/data/repo.config.json — an explicit, maintainer-owned override.
 *   2. When INCLUDE_REPOSITORY_METADATA=1, the GITHUB_REPOSITORY CI variable
 *      (owner/repo), plus GITHUB_REF_NAME for the branch.
 * Returns null when no source is available; callers fall back to a relative
 * folder link instead of a github.com URL.
 */
function resolveRepository() {
  const overrideFile = path.join(dataDir, "repo.config.json");
  if (fs.existsSync(overrideFile)) {
    try {
      const override = JSON.parse(fs.readFileSync(overrideFile, "utf8"));
      const resolved = safeRepository(override.owner, override.name, override.branch);
      if (resolved) return resolved;
      console.warn(`Ignoring ${path.relative(root, overrideFile)}: owner/name are missing or not valid GitHub segments`);
    } catch (error) {
      console.warn(`Ignoring invalid ${path.relative(root, overrideFile)}: ${error.message}`);
    }
  }

  if (process.env.INCLUDE_REPOSITORY_METADATA !== "1") return null;

  const slug = process.env.GITHUB_REPOSITORY;
  if (isNonEmptyString(slug) && slug.includes("/")) {
    const [owner, name] = slug.split("/");
    const resolved = safeRepository(owner, name, process.env.GITHUB_REF_NAME);
    if (resolved) return resolved;
  }

  return null;
}

/**
 * Accepts only values that are safe to interpolate into a github.com tree URL,
 * so a stray config value can never produce a broken or misleading link.
 */
function safeRepository(owner, name, branch) {
  const segment = /^[A-Za-z0-9._-]+$/;
  const branchPattern = /^[A-Za-z0-9._\-/]+$/;
  if (!isNonEmptyString(owner) || !isNonEmptyString(name)) return null;
  if (!segment.test(owner.trim()) || !segment.test(name.trim())) return null;
  const resolvedBranch = isNonEmptyString(branch) && branchPattern.test(branch.trim()) ? branch.trim() : "main";
  return { owner: owner.trim(), name: name.trim(), branch: resolvedBranch };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Manifest paths are declared relative to docs/ and are resolved by the
 * browser against the Pages base URL, so a leading slash or a `..` segment
 * would break under a project subpath (and could reach outside the published
 * site). Reject both before anything is written.
 */
function isDocsRelative(value) {
  if (!isNonEmptyString(value) || value.startsWith("/") || value.includes("\\")) return false;
  return !value.split("/").includes("..");
}

/**
 * JSON is not a strict subset of JavaScript source, and this data is written
 * into a script file. Escaping `<` and the U+2028/U+2029 line separators keeps
 * the output safe to parse (and safe to inline) regardless of manifest copy.
 */
function toScriptLiteral(value) {
  return JSON.stringify(value, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function validateTemplate(template, file, folder) {
  if (!template || Array.isArray(template) || typeof template !== "object") {
    fail(file, "manifest must be a JSON object");
  }
  requireExactKeys(template, [...allowedTemplateFields], file, "manifest");
  for (const field of requiredStrings) {
    if (!isNonEmptyString(template[field])) fail(file, `missing non-empty ${field}`);
  }
  if (template.id !== folder) fail(file, "id must match its folder name");
  if (!Array.isArray(template.tags) || template.tags.length === 0 || !template.tags.every(isNonEmptyString)) {
    fail(file, "tags must be a non-empty string array");
  }
  requireExactKeys(template.colors ?? {}, ["bg", "panel", "accent", "ink"], file, "colors");
  if (!template.colors || !["bg", "panel", "accent", "ink"].every((key) => isNonEmptyString(template.colors[key]))) {
    fail(file, "colors must include bg, panel, accent, and ink");
  }
  for (const section of ["business", "technical"]) {
    if (!template[section] || Array.isArray(template[section]) || typeof template[section] !== "object") {
      fail(file, `${section} must be an object`);
    }
  }
  requireExactKeys(template.business, ["buyer", "application", "roi", "metrics"], file, "business");
  if (!["buyer", "application", "roi", "metrics"].every((key) => isNonEmptyString(template.business[key]))) {
    fail(file, "business must include buyer, application, roi, and metrics");
  }
  requireExactKeys(template.technical, ["complexity", "systems", "build"], file, "technical");
  if (!["complexity", "systems", "build"].every((key) => isNonEmptyString(template.technical[key]))) {
    fail(file, "technical must include complexity, systems, and build");
  }
  if (!template.paths || !Object.values(template.paths).every(isNonEmptyString)) fail(file, "paths must be a string map");
  for (const [key, value] of Object.entries(template.paths)) {
    if (!isDocsRelative(value)) fail(file, `paths.${key} must stay inside docs/ (got "${value}")`);
    if (!fs.existsSync(path.join(docsDir, value))) fail(file, `paths.${key} points at a missing file: ${value}`);
  }
  if (!template.assets || !Array.isArray(template.assets.expected) || template.assets.expected.length < 5) {
    fail(file, "assets.expected must list the expected deliverables");
  }
  requireExactKeys(template.assets, ["expected"], file, "assets");
  for (const asset of template.assets.expected) {
    if (!asset || Array.isArray(asset) || typeof asset !== "object") {
      fail(file, "every expected asset must be an object");
    }
    requireExactKeys(asset, ["path", "status", "description"], file, "expected asset");
    if (!asset || !isNonEmptyString(asset.path) || !["ready", "pending"].includes(asset.status) || !isNonEmptyString(asset.description)) {
      fail(file, "every expected asset requires path, description, and a ready or pending status");
    }
    if (!isDocsRelative(asset.path)) fail(file, `expected asset must stay inside docs/ (got "${asset.path}")`);
    if (!asset.path.startsWith(`templates/${folder}/`)) {
      fail(file, `expected asset must live in its own folder (got "${asset.path}")`);
    }
    // The declared status is the site's only source of truth for whether a
    // deliverable renders as a real link or a "Pending" tag, so it has to
    // agree with what is actually committed. This also blocks placeholder
    // stand-ins (an empty demo.mp4, a fake poster) from shipping as pending.
    const onDisk = fs.existsSync(path.join(docsDir, asset.path));
    if (asset.status === "ready" && !onDisk) fail(file, `asset is marked ready but missing: ${asset.path}`);
    if (asset.status === "pending" && onDisk) fail(file, `asset is marked pending but present on disk: ${asset.path}`);
  }
}

function main() {
  if (!fs.existsSync(templatesDir)) throw new Error("docs/templates does not exist");
  const templates = fs.readdirSync(templatesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ folder: entry.name, file: path.join(templatesDir, entry.name, "template.json") }))
    .filter(({ file }) => fs.existsSync(file))
    .map(({ folder, file }) => {
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        fail(file, `invalid JSON (${error.message})`);
      }
      validateTemplate(manifest, file, folder);
      return manifest;
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  if (templates.length !== 11) throw new Error(`expected 11 template manifests, found ${templates.length}`);
  const ids = new Set(templates.map((template) => template.id));
  if (ids.size !== templates.length) throw new Error("template ids must be unique");

  fs.mkdirSync(dataDir, { recursive: true });
  const json = `${JSON.stringify(templates, null, 2)}\n`;
  fs.writeFileSync(path.join(dataDir, "templates.json"), json);

  const repository = resolveRepository();
  fs.writeFileSync(
    path.join(dataDir, "templates.js"),
    `/* Generated by scripts/generate-template-index.js. Do not edit manually. */\n` +
      `window.VOICE_AI_TEMPLATES = ${toScriptLiteral(templates)};\n` +
      `/* Optional repository metadata ({owner, name, branch}) for "open on GitHub"\n` +
      ` * links; null when unresolved (falls back to a relative folder link). */\n` +
      `window.VOICE_AI_REPO = ${toScriptLiteral(repository)};\n`
  );
  console.log(
    `Wrote ${templates.length} templates to docs/data/templates.{json,js}` +
      (repository ? ` (repo: ${repository.owner}/${repository.name}@${repository.branch})` : " (repo: unresolved, using relative links)")
  );
}

try {
  main();
} catch (error) {
  console.error(`Template index generation failed: ${error.message}`);
  process.exitCode = 1;
}
