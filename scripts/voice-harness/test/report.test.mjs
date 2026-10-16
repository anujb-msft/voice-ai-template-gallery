import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { summarize, toMarkdown, writeReport } from "../src/report.mjs";

const run = {
  id: "2026-10-15T09-00-00",
  suites: [
    {
      template: "it-helpdesk-password-reset",
      suite: "it-helpdesk-password-reset",
      title: "IT help desk password reset",
      error: null,
      scenarios: [
        {
          name: "demo-script",
          title: "The full demo",
          status: "pass",
          durationMs: 61400,
          checks: [{ name: "the template called the harness number", ok: true, soft: false, detail: "from +18665550142" }],
          timeline: [
            { at: 1500, leg: 1, who: "agent", text: "Hi Alex, I'm calling from 425-555-0123." },
            { at: 4000, leg: 1, who: "caller", text: "Four two one seven." },
            { at: 6000, leg: 1, who: "agent", locale: "fr-CA", text: "Le code est cinq deux cinq." },
            { at: 7000, leg: 1, who: "agent", locale: "en-US", text: "Go ahead and type it." },
            { at: 9000, leg: 1, who: "caller", dtmf: "1" },
            { at: 9500, leg: 1, who: "caller", event: "hung up" },
            { at: 9600, leg: 1, event: "call ended", detail: "by the agent" },
          ],
          audio: ["leg-1.wav"],
          events: [{ kind: "identity_confirmed", detail: "4217" }],
          serverTranscript: [{ role: "assistant", text: "Hi Alex" }, { speaker: "caller", content: "4217" }],
        },
        {
          name: "wrong-code",
          title: "A wrong code",
          status: "warn",
          checks: [{ name: "agent said /didn't match/i", ok: false, soft: true, detail: "Let's try again" }],
        },
        { name: "transfer", title: "Warm transfer", status: "skip", reason: "needs Teams", checks: [] },
      ],
    },
    { template: "general-inquiry-agent", suite: "general-inquiry-agent", title: "General inquiry", error: "port 8091 is in use", scenarios: [] },
  ],
};

test("summarize counts scenarios by result, and a suite that could not start as an error", () => {
  assert.deepEqual(summarize(run), { pass: 1, warn: 1, fail: 0, error: 1, skip: 1 });
});

test("the markdown report has a results table, checks, and the call timeline", () => {
  const md = toMarkdown(run);
  assert.match(md, /^# Voice harness run 2026-10-15T09-00-00$/m);
  assert.match(md, /1 passed, 1 passed with warnings, 0 failed, 1 errored, 1 skipped\./);
  assert.match(md, /\| it-helpdesk-password-reset \| demo-script \| ✅ pass \| 1\/1 \| 61 s \|/);
  assert.match(md, /\| it-helpdesk-password-reset \| transfer \| ⏭️ skip: needs Teams \| {2}\| {2}\|/);
  assert.match(md, /\| general-inquiry-agent \| \(suite\) \| 💥 port 8091 is in use \|/);
  assert.match(md, /^- ~ agent said \/didn't match\/i: Let's try again$/m, "soft failures are marked ~");
  assert.match(md, /^- `00:01\.5` \*\*agent:\*\* Hi Alex/m);
  assert.match(md, /^- `00:06\.0` \*\*agent \(fr-CA\):\*\* Le code est/m, "speech outside English is labelled");
  assert.match(md, /^- `00:07\.0` \*\*agent:\*\* Go ahead/m, "English is not");
  assert.match(md, /^- `00:09\.0` \*\*caller \(keypad\):\*\* 1$/m);
  assert.match(md, /^- `00:09\.5` \*caller: hung up\*$/m);
  assert.match(md, /^- `00:09\.6` \*call ended: by the agent\*$/m);
  assert.match(md, /^- \*\*assistant:\*\* Hi Alex$/m);
  assert.match(md, /^- \*\*caller:\*\* 4217$/m);
  assert.match(md, /^- `identity_confirmed` 4217$/m);
  assert.ok(!md.includes("### ⏭️"), "skipped scenarios get no detail section");
});

test("reports never contain a full phone number", () => {
  const md = toMarkdown(run);
  assert.ok(!/\d{10}|555-0123|555-0142/.test(md));
  assert.match(md, /•••-•••-0123/);
  assert.match(md, /•••-•••-0142/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-harness-report-"));
  try {
    const file = writeReport(run, dir);
    assert.equal(file, path.join(dir, "report.md"));
    const json = fs.readFileSync(path.join(dir, "report.json"), "utf8");
    assert.ok(!json.includes("555-0123") && !json.includes("+18665550142"));
    assert.equal(JSON.parse(json).suites[0].scenarios[0].durationMs, 61400, "numbers are kept");
    assert.ok(!fs.readFileSync(file, "utf8").includes("555-0123"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
