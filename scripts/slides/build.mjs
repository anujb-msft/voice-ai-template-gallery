/**
 * Builds each template's one-slide value proposition, the PDF behind the
 * gallery's slide button: docs/templates/<id>/slides/<id>.pdf.
 *
 *   npm run build [-- --only=<template-id>]
 *   npm run check     rebuilds in memory and exits 1 if a committed PDF is stale
 *
 * Every word comes from the template's manifest (template.json), set in the
 * template's own palette: business.roi leads as "Potential outcomes", with
 * business.application, buyer and metrics, and technical.systems and
 * complexity. The picture is the console still stills/<id>.jpg (stills.json).
 * A template with no still yet is skipped; its manifest keeps the PDF pending.
 * Builds are byte-for-byte reproducible, which is what lets `check` work.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const templatesDir = join(repoRoot, "docs", "templates");
const plan = JSON.parse(readFileSync(join(here, "stills.json"), "utf8"));

// Recorded as the PDF's creation date. It is fixed rather than the build time
// so that rebuilding unchanged inputs gives identical bytes.
const CREATED = new Date("2026-10-20T00:00:00Z");
// The overview reel's end-card credit line (scripts/video/reel/overview.mjs).
const PRODUCTS = "Teams Phone extensibility · Azure AI Voice Live · Azure OpenAI GPT Realtime";
const DISCLAIMER = "Illustrative sample, not a production service · No performance commitments · Fictional people and data";

const PAGE_W = 960;
const PAGE_H = 540;
const MARGIN = 48;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const MAIN_TOP = 128;
const FOOTER_Y = 512;
const REGULAR = "Helvetica";
const BOLD = "Helvetica-Bold";
// Helvetica's vertical metrics per point of font size. pdfkit puts the top of
// a line's capitals at the y it is given.
const CAP = 0.718;
const INK = 0.925; // capitals plus descenders
const X_MIDDLE = 0.457; // top of capitals to the middle of the lowercase letters

const FACT = { size: 11, lead: 14.5 };
const CHIP = { size: 9.5, padX: 8, height: 18, gap: 6, rowGap: 6 };
const LEVELS = ["Low", "Medium", "High"];

// Glyphs the standard PDF fonts can show beyond Latin-1: the rest of
// Windows-1252. Anything else would print as a blank.
const CP1252_EXTRAS = new Set([
  0x152, 0x153, 0x160, 0x161, 0x178, 0x17d, 0x17e, 0x192, 0x2c6, 0x2dc, 0x2013, 0x2014, 0x2018, 0x2019,
  0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x20ac, 0x2122,
]);

function printable(text, what) {
  for (const char of text) {
    const code = char.codePointAt(0);
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || CP1252_EXTRAS.has(code)) continue;
    const name = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
    throw new Error(`${what}: "${char}" (${name}) is outside the slide fonts' Windows-1252 character set.`);
  }
  return text;
}

function rgb(color) {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) throw new Error(`Expected a #rrggbb colour, got "${color}".`);
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function mix(from, to, amount) {
  const a = rgb(from);
  const b = rgb(to);
  return `#${a.map((channel, i) => Math.round(channel + (b[i] - channel) * amount).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(color) {
  const [r, g, b] = rgb(color).map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

// Slide colours from the template palette, held to WCAG contrast: 4.5:1 for
// text, 3:1 for the accent shapes that carry meaning (bar, chips, meter).
function palette(template) {
  const { bg, panel, accent, ink } = template.colors;
  const require = (ratio, minimum, what) => {
    if (ratio < minimum) {
      throw new Error(`${template.id}: ${what} contrast is ${ratio.toFixed(2)}:1, below ${minimum}:1.`);
    }
  };
  require(contrast(ink, bg), 4.5, "ink on bg");
  require(contrast(ink, panel), 4.5, "ink on panel");
  require(contrast(accent, bg), 3, "accent on bg");
  require(contrast(accent, panel), 3, "accent on panel");
  // Secondary text: ink faded toward the page as far as 4.5:1 on both surfaces allows.
  let muted = ink;
  for (let step = 20; step > 0; step--) {
    const candidate = mix(ink, bg, step / 50);
    if (contrast(candidate, bg) >= 4.5 && contrast(candidate, panel) >= 4.5) {
      muted = candidate;
      break;
    }
  }
  return {
    bg,
    panel,
    accent,
    ink,
    muted,
    kicker: contrast(accent, bg) >= 4.5 ? accent : muted,
    frame: mix(ink, bg, 0.8),
    rule: mix(ink, panel, 0.82),
    idle: mix(accent, panel, 0.72),
  };
}

// Greedy word wrap at spaces. Returns null if a single word is wider than the measure.
function wrap(doc, text, width) {
  const lines = [];
  let current = "";
  for (const word of text.trim().split(/\s+/)) {
    if (doc.widthOfString(word) > width) return null;
    const candidate = current ? `${current} ${word}` : word;
    if (current && doc.widthOfString(candidate) > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// wrap(), narrowing the measure by up to 15% where that avoids a one-word last line.
function wrapEven(doc, text, width) {
  const lines = wrap(doc, text, width);
  if (!lines || lines.length < 2 || lines.at(-1).includes(" ")) return lines;
  for (let narrower = width - 4; narrower >= width * 0.85; narrower -= 4) {
    const attempt = wrap(doc, text, narrower);
    if (!attempt || attempt.length > lines.length) break;
    if (attempt.at(-1).includes(" ")) return attempt;
  }
  return lines;
}

// Height from the top of the first line's capitals to the last line's descenders.
function blockHeight(lines, lead, size) {
  return (lines - 1) * lead + size * INK;
}

// pdfkit 0.20.2 copies the info strings into the XMP metadata without XML
// escaping, so a name such as "Lookup & Update" would corrupt the packet.
function escapeXmpInfo(doc) {
  const addInfo = doc._addInfo;
  doc._addInfo = function addEscapedInfo() {
    const info = this.info;
    const escape = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    this.info = Object.fromEntries(
      Object.entries(info).map(([key, value]) => [key, typeof value === "string" ? escape(value) : value]),
    );
    try {
      addInfo.call(this);
    } finally {
      this.info = info;
    }
  };
}

function renderSlide(template, still) {
  const t = template;
  const where = `docs/templates/${t.id}/template.json`;
  const pal = palette(t);
  const radius = Math.min(16, Math.max(4, Number.parseFloat(t.radius) || 8));
  const stillPath = join(here, "stills", `${t.id}.jpg`);
  if (!existsSync(stillPath)) throw new Error(`scripts/slides/stills/${t.id}.jpg is missing; run npm run stills.`);
  const level = LEVELS.indexOf(t.technical.complexity) + 1;
  if (!level) throw new Error(`${where}: technical.complexity must be one of ${LEVELS.join(", ")}.`);
  const measures = t.business.metrics.split(" · ");
  const systems = t.technical.systems.split(" · ");

  const doc = new PDFDocument({
    size: [PAGE_W, PAGE_H],
    margin: 0,
    pdfVersion: "1.7",
    tagged: true,
    lang: "en-US",
    displayTitle: true,
    // Uncompressed streams keep the bytes independent of the zlib build; the
    // still, which is most of the file, is embedded as JPEG either way.
    compress: false,
    info: {
      Title: `${t.name}: value proposition`,
      Author: "Voice AI template gallery",
      Subject: t.business.roi,
      Keywords: [...t.tags, "voice AI"].join(", "),
      Creator: "scripts/slides/build.mjs",
      CreationDate: CREATED,
      ModDate: CREATED,
    },
  });
  escapeXmpInfo(doc);
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.on("pageAdded", () => {
    throw new Error(`${where}: the slide content ran onto a second page.`);
  });

  // Reading order is drawing order. Text sits in structure elements; shapes
  // and the background are artifacts that assistive technology skips.
  const root = doc.struct("Document");
  doc.addStructure(root);
  const artifact = (draw) => {
    doc.markContent("Artifact", { type: "Layout" });
    draw();
    doc.endMarkedContent();
  };
  const put = (type, options, draw) => {
    if (typeof options === "function") [draw, options] = [options, {}];
    root.add(doc.struct(type, options, draw));
  };
  const list = (items, drawItem) => {
    const element = doc.struct("L");
    root.add(element);
    items.forEach((item, index) => {
      const entry = doc.struct("LI");
      element.add(entry);
      drawItem(item, index, (draw) => entry.add(doc.struct("LBody", draw)));
      entry.end();
    });
    element.end();
  };
  const set = (font, size) => doc.font(font).fontSize(size);
  const line = (text, x, y, { font = REGULAR, size, color, spacing = 0, width = Infinity, what }) => {
    printable(text, `${where} ${what}`);
    set(font, size).fillColor(color);
    const needed = doc.widthOfString(text, { characterSpacing: spacing });
    if (needed > width + 0.01) {
      throw new Error(`${where}: ${what} "${text.trim()}" needs ${needed.toFixed(1)}pt but has ${width.toFixed(1)}pt.`);
    }
    doc.text(text, x, y, { characterSpacing: spacing, lineBreak: false });
  };
  // Wrapped lines end in a space so extracted text keeps its word breaks.
  const lines = (texts, x, y, lead, style) =>
    texts.forEach((text, i) => line(i < texts.length - 1 ? `${text} ` : text, x, y + i * lead, style));
  const heading = (text, x, y, width, size = 9) =>
    put("H2", { actual: text }, () =>
      line(text.toUpperCase(), x, y, { font: BOLD, size, color: pal.muted, spacing: size * 0.12, width, what: "label" }),
    );

  // Measure the facts band first: its height decides how much the still gets.
  const band = { padX: 18, bottom: FOOTER_Y - 18 };
  const columns = [
    { label: "Who it’s for", width: 168 },
    { label: "Success measures", width: 180 },
    { label: "System touchpoints", width: 288 },
    { label: "Build complexity", width: 124 },
  ];
  const gutter =
    (CONTENT_W - 2 * band.padX - columns.reduce((sum, column) => sum + column.width, 0)) / (columns.length - 1);
  columns.reduce((x, column) => {
    column.x = x;
    return x + column.width + gutter;
  }, MARGIN + band.padX);

  const bulletIndent = 13;
  set(REGULAR, FACT.size);
  const buyer = wrapEven(doc, t.business.buyer, columns[0].width);
  const measureLines = measures.map((measure) => wrap(doc, measure, columns[1].width - bulletIndent));
  if (!buyer || measureLines.includes(null)) throw new Error(`${where}: a word in business.buyer or metrics is too long.`);
  set(REGULAR, CHIP.size);
  let chipX = 0;
  let chipRow = 0;
  const chips = systems.map((label) => {
    const width = doc.widthOfString(label) + 2 * CHIP.padX;
    if (width > columns[2].width) throw new Error(`${where}: technical.systems entry "${label}" is too long.`);
    if (chipX > 0 && chipX + width > columns[2].width) {
      chipRow += 1;
      chipX = 0;
    }
    const chip = { label, x: chipX, row: chipRow, width };
    chipX += width + CHIP.gap;
    return chip;
  });
  const measureGap = 3;
  const contentHeight = Math.max(
    blockHeight(buyer.length, FACT.lead, FACT.size),
    blockHeight(measureLines.flat().length, FACT.lead, FACT.size) + (measures.length - 1) * measureGap,
    (chipRow + 1) * CHIP.height + chipRow * CHIP.rowGap - 4,
    12 * INK + 9 + 8,
  );
  band.top = band.bottom - (33 + contentHeight + 16);
  const labelY = band.top + 16;
  const contentY = labelY + 17;

  // The main area: the console still on the right, as large as the height
  // allows, and the outcome and application text in the column it leaves.
  const mainBottom = band.top - 22;
  const captionGap = 7;
  const captionSize = 8.5;
  let stillH = mainBottom - MAIN_TOP - captionGap - captionSize * INK;
  let stillW = (stillH * 16) / 9;
  if (stillW > 460) {
    stillW = 460;
    stillH = (stillW * 9) / 16;
  }
  if (stillW < 360) throw new Error(`${where}: the facts band leaves only ${stillW.toFixed(0)}pt for the still.`);
  const stillX = PAGE_W - MARGIN - stillW;
  const leftW = stillX - 32 - MARGIN;
  const barW = 4;
  const roiX = MARGIN + barW + 14;
  const roiW = MARGIN + leftW - roiX;

  // The hero outcome takes the largest size that fits: up to 26pt on three
  // lines if it can stay at 22pt or more, otherwise up to 24pt on four.
  const fitted = (() => {
    for (const [maxLines, largest, smallest] of [[3, 26, 22], [4, 24, 19]]) {
      for (let roiSize = largest; roiSize >= smallest; roiSize--) {
        set(BOLD, roiSize);
        const roi = wrapEven(doc, t.business.roi, roiW);
        if (!roi || roi.length > maxLines) continue;
        for (const appSize of [12, 11.5, 11]) {
          set(REGULAR, appSize);
          const app = wrapEven(doc, t.business.application, leftW);
          if (!app) continue;
          const roiLead = roiSize * 1.18;
          const appLead = appSize * 1.45;
          const roiY = MAIN_TOP + 22;
          const whatY = roiY + blockHeight(roi.length, roiLead, roiSize) + 24;
          const appY = whatY + 17;
          if (appY + blockHeight(app.length, appLead, appSize) <= mainBottom) {
            return { roi, roiSize, roiLead, roiY, whatY, app, appSize, appLead, appY };
          }
        }
      }
    }
    throw new Error(`${where}: business.roi and business.application do not fit beside the still; shorten them.`);
  })();

  const titleSize = [30, 28, 26, 24].find((size) => set(BOLD, size).widthOfString(t.name) <= CONTENT_W);
  if (!titleSize) throw new Error(`${where}: name is too long for the slide title.`);

  // Background and header.
  artifact(() => doc.rect(0, 0, PAGE_W, PAGE_H).fill(pal.bg));
  put("P", { actual: t.language }, () =>
    line(t.language.toUpperCase(), MARGIN, 38, {
      font: BOLD, size: 10, color: pal.kicker, spacing: 1.4, width: CONTENT_W, what: "language",
    }),
  );
  put("H1", () =>
    line(t.name, MARGIN, 56, { font: BOLD, size: titleSize, color: pal.ink, width: CONTENT_W, what: "name" }),
  );
  put("P", () => line(t.useCase, MARGIN, 94, { size: 14, color: pal.muted, width: CONTENT_W, what: "useCase" }));

  // Left column: potential outcomes, then what it does.
  heading("Potential outcomes", MARGIN, MAIN_TOP, leftW);
  artifact(() =>
    doc
      .roundedRect(MARGIN, fitted.roiY - 3, barW, blockHeight(fitted.roi.length, fitted.roiLead, fitted.roiSize) + 6, 2)
      .fill(pal.accent),
  );
  put("P", () =>
    lines(fitted.roi, roiX, fitted.roiY, fitted.roiLead, {
      font: BOLD, size: fitted.roiSize, color: pal.ink, what: "business.roi",
    }),
  );
  heading("What it does", MARGIN, fitted.whatY, leftW);
  put("P", () =>
    lines(fitted.app, MARGIN, fitted.appY, fitted.appLead, {
      size: fitted.appSize, color: pal.ink, what: "business.application",
    }),
  );

  // The console still, captioned as the simulation it is.
  put("Figure", { alt: still.alt, bbox: [stillX, MAIN_TOP, stillX + stillW, MAIN_TOP + stillH] }, () => {
    doc.save();
    doc.roundedRect(stillX, MAIN_TOP, stillW, stillH, radius).clip();
    doc.image(stillPath, stillX, MAIN_TOP, { cover: [stillW, stillH], align: "center", valign: "center" });
    doc.restore();
  });
  artifact(() =>
    doc
      .roundedRect(stillX + 0.5, MAIN_TOP + 0.5, stillW - 1, stillH - 1, radius - 0.5)
      .lineWidth(1)
      .stroke(pal.frame),
  );
  const caption = `From the demo film · Console in simulation mode${still.teamsCard ? " · Teams card simulated" : ""}`;
  put("P", () =>
    line(caption, stillX, MAIN_TOP + stillH + captionGap, {
      size: captionSize, color: pal.muted, width: stillW, what: "caption",
    }),
  );

  // The facts band.
  artifact(() => {
    doc.roundedRect(MARGIN, band.top, CONTENT_W, band.bottom - band.top, radius).fill(pal.panel);
    doc.lineWidth(0.75);
    for (const column of columns.slice(1)) {
      const x = column.x - gutter / 2;
      doc.moveTo(x, band.top + 14).lineTo(x, band.bottom - 14).stroke(pal.rule);
    }
  });
  const [who, measured, touchpoints, complexity] = columns;

  heading(who.label, who.x, labelY, who.width, 8.5);
  put("P", () => lines(buyer, who.x, contentY, FACT.lead, { size: FACT.size, color: pal.ink, what: "business.buyer" }));

  heading(measured.label, measured.x, labelY, measured.width, 8.5);
  let measureY = contentY;
  list(measureLines, (wrapped, _index, body) => {
    const top = measureY;
    artifact(() => doc.circle(measured.x + 2.5, top + FACT.size * X_MIDDLE, 2.2).fill(pal.accent));
    body(() =>
      lines(wrapped, measured.x + bulletIndent, top, FACT.lead, {
        size: FACT.size, color: pal.ink, what: "business.metrics",
      }),
    );
    measureY += wrapped.length * FACT.lead + measureGap;
  });

  heading(touchpoints.label, touchpoints.x, labelY, touchpoints.width, 8.5);
  list(chips, (chip, _index, body) => {
    const x = touchpoints.x + chip.x;
    const y = contentY - 4 + chip.row * (CHIP.height + CHIP.rowGap);
    artifact(() =>
      doc
        .roundedRect(x, y, chip.width, CHIP.height, Math.min(radius, CHIP.height / 2))
        .lineWidth(0.75)
        .fillAndStroke(pal.bg, pal.accent),
    );
    body(() =>
      line(chip.label, x + CHIP.padX, y + (CHIP.height - CHIP.size * CAP) / 2, {
        size: CHIP.size, color: pal.ink, what: "technical.systems",
      }),
    );
  });

  heading(complexity.label, complexity.x, labelY, complexity.width, 8.5);
  put("P", () =>
    line(t.technical.complexity, complexity.x, contentY, {
      font: BOLD, size: 12, color: pal.ink, width: complexity.width, what: "technical.complexity",
    }),
  );
  artifact(() => {
    const meterY = contentY + 12 * INK + 9;
    LEVELS.forEach((_, i) => {
      doc.roundedRect(complexity.x + i * 34, meterY, 30, 8, Math.min(radius, 4)).fill(i < level ? pal.accent : pal.idle);
    });
  });

  // Footer: what it runs on, and what it is not.
  set(REGULAR, 8);
  const disclaimerW = doc.widthOfString(DISCLAIMER);
  if (doc.widthOfString(PRODUCTS) + 24 + disclaimerW > CONTENT_W) throw new Error("The footer lines overlap.");
  put("P", () => line(PRODUCTS, MARGIN, FOOTER_Y, { size: 8, color: pal.muted, what: "credit line" }));
  put("P", () =>
    line(DISCLAIMER, PAGE_W - MARGIN - disclaimerW, FOOTER_Y, { size: 8, color: pal.muted, what: "disclaimer" }),
  );

  root.end();
  doc.end();
  return finished;
}

function option(name) {
  const arg = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
}

const only = option("only");
const check = process.argv.includes("--check");
const ids = readdirSync(templatesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(templatesDir, entry.name, "template.json")))
  .map((entry) => entry.name)
  .sort();
const stills = new Map(plan.stills.map((still) => [still.id, still]));
for (const id of stills.keys()) {
  if (!ids.includes(id)) throw new Error(`stills.json has a still for "${id}", which is not a template.`);
}
const targets = ids.filter((id) => !only || id === only);
if (!targets.length) throw new Error(`There is no template "${only}".`);

let problems = 0;
for (const id of targets) {
  const out = join(templatesDir, id, "slides", `${id}.pdf`);
  const shown = relative(repoRoot, out).split(sep).join("/");
  const still = stills.get(id);
  // A template has no slide until its still is picked (README.md), and its
  // manifest keeps the PDF pending until then.
  if (!still) {
    if (only) throw new Error(`stills.json has no still for ${id}; add one first (see README.md).`);
    if (existsSync(out)) {
      problems += 1;
      console.error(`NO STILL ${shown}: stills.json has no still to build it from. Add one, or delete the PDF.`);
    } else {
      console.log(`no slide ${shown}: stills.json has no still for it yet`);
    }
    continue;
  }
  const template = JSON.parse(readFileSync(join(templatesDir, id, "template.json"), "utf8"));
  const pdf = await renderSlide(template, still);
  if (check) {
    const current = existsSync(out) ? readFileSync(out) : null;
    if (current && current.equals(pdf)) {
      console.log(`current  ${shown}`);
    } else {
      problems += 1;
      console.error(`${current ? "STALE   " : "MISSING "} ${shown}`);
    }
  } else {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, pdf);
    console.log(`${shown}  ${Math.round(pdf.length / 1024)} KB`);
  }
}
if (problems) {
  console.error(`\n${problems} slide PDF(s) don't match their manifest and still. Run npm run build in scripts/slides, review, and commit them.`);
  process.exit(1);
}
