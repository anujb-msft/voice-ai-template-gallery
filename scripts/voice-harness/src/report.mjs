import fs from "node:fs";
import path from "node:path";
import { languageOf, redactDeep, redactPhones } from "./util.mjs";

const ICON = { pass: "✅", warn: "⚠️", fail: "❌", error: "💥", skip: "⏭️" };

const clock = (ms) => {
  const s = Math.max(0, ms) / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};

function line(e) {
  if (e.who === "agent") return `**agent${e.locale && languageOf(e.locale) !== "en" ? ` (${e.locale})` : ""}:** ${e.text}`;
  if (e.who === "caller" && e.dtmf) return `**caller (keypad):** ${e.dtmf}`;
  if (e.who === "caller" && e.text) return `**caller:** ${e.text}`;
  if (e.who === "caller") return `*caller: ${e.event}*`;
  return `*${e.event}${e.detail ? `: ${e.detail}` : ""}*`;
}

export function summarize(run) {
  const counts = { pass: 0, warn: 0, fail: 0, error: 0, skip: 0 };
  for (const s of run.suites) {
    if (s.error && !s.scenarios.length) counts.error++;
    for (const sc of s.scenarios) counts[sc.status]++;
  }
  return counts;
}

export function toMarkdown(run) {
  const counts = summarize(run);
  const out = [
    `# Voice harness run ${run.id}`,
    "",
    `${counts.pass} passed, ${counts.warn} passed with warnings, ${counts.fail} failed, ${counts.error} errored, ${counts.skip} skipped.`,
    "",
    "| Template | Scenario | Result | Checks | Time |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const s of run.suites) {
    const name = s.suite ?? s.template;
    if (s.error && !s.scenarios.length) out.push(`| ${name} | (suite) | ${ICON.error} ${s.error} | | |`);
    for (const sc of s.scenarios) {
      const ok = sc.checks.filter((c) => c.ok).length;
      out.push(
        `| ${name} | ${sc.name} | ${ICON[sc.status]} ${sc.status}${sc.reason ? `: ${sc.reason}` : ""} | ${sc.checks.length ? `${ok}/${sc.checks.length}` : ""} | ${sc.durationMs ? `${Math.round(sc.durationMs / 1000)} s` : ""} |`,
      );
    }
  }
  for (const s of run.suites) {
    out.push("", `## ${s.title}`, "");
    if (s.error) out.push(`> Suite error: ${s.error}`, "");
    for (const sc of s.scenarios.filter((x) => x.status !== "skip")) {
      out.push(`### ${ICON[sc.status]} ${sc.name}: ${sc.title}`, "");
      if (sc.error) out.push(`> ${sc.error}`, "");
      for (const c of sc.checks) out.push(`- ${c.ok ? "✓" : c.soft ? "~" : "✗"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
      if (sc.timeline?.length) {
        out.push("", "<details><summary>Call timeline</summary>", "");
        for (const e of sc.timeline) out.push(`- \`${clock(e.at)}\`${sc.audio?.length > 1 ? ` [${e.leg}]` : ""} ${line(e)}`);
        out.push("", "</details>");
      }
      if (sc.serverTranscript?.length) {
        out.push("", "<details><summary>What the template heard and said</summary>", "");
        // Templates name the speaker differently (role, speaker, who).
        for (const m of sc.serverTranscript) {
          out.push(`- **${m.role ?? m.speaker ?? m.who ?? "?"}:** ${m.text ?? m.content ?? JSON.stringify(m)}`);
        }
        out.push("", "</details>");
      }
      if (sc.events?.length) {
        out.push("", "<details><summary>Recorded events</summary>", "");
        for (const e of sc.events) out.push(`- \`${e.kind}\`${e.detail ? ` ${String(e.detail).slice(0, 200)}` : ""}`);
        out.push("", "</details>");
      }
      out.push("");
    }
  }
  return redactPhones(out.join("\n"));
}

export function writeReport(run, dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "report.json"), `${JSON.stringify(redactDeep(run), null, 2)}\n`);
  const md = path.join(dir, "report.md");
  fs.writeFileSync(md, `${toMarkdown(run)}\n`);
  return md;
}
