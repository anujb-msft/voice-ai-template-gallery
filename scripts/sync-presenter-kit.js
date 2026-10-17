#!/usr/bin/env node
/**
 * Vendor the presenter kit into every runnable template's console.
 *
 *   node scripts/sync-presenter-kit.js          copy scripts/presenter-kit/* into docs/templates/<id>/code/public/
 *   node scripts/sync-presenter-kit.js --check  exit 1 if any vendored copy has drifted (CI)
 *
 * Each template is a self-contained download, so the kit is copied rather
 * than shared at runtime. This script keeps the copies identical; edit the
 * canonical files in scripts/presenter-kit/ and re-run it.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const kitDir = path.join(__dirname, "presenter-kit");
const templatesDir = path.join(root, "docs", "templates");
const files = ["presenter-kit.js", "presenter-kit.css"];
const check = process.argv.includes("--check");

// Compare as LF so a Windows checkout with core.autocrlf does not report drift.
const normalize = (text) => text.replace(/\r\n?/g, "\n");

function targets() {
  return fs
    .readdirSync(templatesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(templatesDir, entry.name, "code", "public"))
    .filter((dir) => fs.existsSync(dir));
}

function main() {
  const kit = Object.fromEntries(files.map((name) => [name, normalize(fs.readFileSync(path.join(kitDir, name), "utf8"))]));
  const drift = [];
  let written = 0;

  for (const dir of targets()) {
    for (const name of files) {
      const file = path.join(dir, name);
      const current = fs.existsSync(file) ? normalize(fs.readFileSync(file, "utf8")) : null;
      if (current === kit[name]) continue;
      if (check) {
        drift.push(path.relative(root, file).split(path.sep).join("/"));
      } else {
        fs.writeFileSync(file, kit[name]);
        written += 1;
      }
    }
  }

  if (check) {
    if (drift.length) {
      console.error("Presenter kit copies are out of date. Run `node scripts/sync-presenter-kit.js`:");
      for (const file of drift) console.error(`  ${file}`);
      process.exit(1);
    }
    console.log(`Presenter kit is in sync across ${targets().length} templates.`);
    return;
  }
  console.log(`Presenter kit synced to ${targets().length} templates (${written} files written).`);
}

main();
