import assert from "node:assert/strict";
import { test } from "node:test";
import { config, missingConfig } from "../src/config.mjs";
import { runnableTemplates } from "../src/preflight.mjs";
import { loadSuites, suiteKey } from "../src/runner.mjs";

const suites = await loadSuites();
const runnable = runnableTemplates();

test("missingConfig names every setting a live run needs", () => {
  const all = [
    "ACS_ENDPOINT",
    "TEMPLATE_NUMBER",
    "HARNESS_NUMBER",
    "TEMPLATE_PUBLIC_URL",
    "HARNESS_PUBLIC_URL",
    "VOICE_LIVE_ENDPOINT",
    "SPEECH_ENDPOINT",
  ];
  assert.deepEqual(missingConfig({}), all);
  const full = {
    acsEndpoint: "https://acs.example",
    templateNumber: "+18665550142",
    harnessNumber: "+14255550123",
    templatePublicUrl: "https://t.example",
    harnessPublicUrl: "https://h.example",
    voiceLiveEndpoint: "https://vl.example",
    speechEndpoint: "https://s.example",
  };
  assert.deepEqual(missingConfig(full), []);
  assert.deepEqual(missingConfig({ ...full, harnessNumber: "" }), ["HARNESS_NUMBER"]);
  assert.ok(config.templatePort > 0 && config.harnessPort > 0);
  assert.notEqual(config.templatePort, config.harnessPort);
});

test("every runnable template has a live-call suite", () => {
  assert.ok(runnable.length >= 11, `found ${runnable.length} runnable templates`);
  const covered = new Set(suites.map((s) => s.template));
  assert.deepEqual(
    runnable.filter((t) => !covered.has(t)),
    [],
  );
});

test("suites are well formed", () => {
  const keys = new Set();
  for (const s of suites) {
    const where = `scenarios/${s.file} (${suiteKey(s)})`;
    assert.ok(runnable.includes(s.template), `${where}: no runnable template "${s.template}"`);
    assert.ok(!keys.has(suiteKey(s)), `${where}: two suites share this key; give them distinct ids`);
    keys.add(suiteKey(s));
    assert.ok(typeof s.title === "string" && s.title.trim(), `${where}: title`);
    assert.ok(["inbound", "outbound"].includes(s.direction), `${where}: direction must be inbound or outbound`);
    assert.ok(s.order == null || Number.isFinite(s.order), `${where}: order`);
    assert.ok(s.probe && typeof s.probe === "object", `${where}: probe`);
    assert.ok(s.probe.idKey == null || typeof s.probe.idKey === "string", `${where}: probe.idKey`);
    for (const k of ["recordPath", "eventsPath"]) {
      if (s.probe[k] == null) continue;
      assert.equal(typeof s.probe[k], "function", `${where}: probe.${k} is (id) => path`);
      assert.match(s.probe[k]("id-123"), /^\/\S*id-123/, `${where}: probe.${k}`);
    }
    for (const k of ["prepare", "beforeEach"]) {
      assert.ok(s[k] == null || typeof s[k] === "function", `${where}: ${k}`);
    }
    for (const [k, v] of Object.entries(s.env ?? {})) {
      assert.equal(typeof v, "string", `${where}: env.${k} must be a string ("" unsets it)`);
    }
    const locales = (v, what) =>
      v == null ||
      (Array.isArray(v) && v.length && v.every((l) => /^[a-z]{2,3}-[A-Z]{2}$/.test(l))) ||
      assert.fail(`${where}: ${what} must be a non-empty list of locales like "en-US"`);
    locales(s.languages, "languages");
    assert.ok(Array.isArray(s.scenarios) && s.scenarios.length, `${where}: scenarios`);
    const names = new Set();
    for (const sc of s.scenarios) {
      assert.match(sc.name ?? "", /^[a-z0-9]+(-[a-z0-9]+)*$/, `${where}: scenario name "${sc.name}" (kebab-case)`);
      assert.ok(!names.has(sc.name), `${where}: duplicate scenario "${sc.name}"`);
      names.add(sc.name);
      assert.ok(typeof sc.title === "string" && sc.title.trim(), `${where}: ${sc.name}: title`);
      assert.ok(sc.skip || typeof sc.run === "function", `${where}: ${sc.name}: run(t) or skip`);
      assert.ok(sc.skip == null || typeof sc.skip === "string", `${where}: ${sc.name}: skip is the reason`);
      locales(sc.languages, `${sc.name}: languages`);
      if (sc.timeoutMs != null) {
        assert.ok(sc.timeoutMs >= 30000 && sc.timeoutMs <= 900000, `${where}: ${sc.name}: timeoutMs`);
      }
    }
  }
});

test("suites hand templates no keys or connection strings (live runs are keyless)", () => {
  const SECRET = /(KEY|SECRET|CONNECTION_STRING|PASSWORD|TOKEN)$/;
  for (const s of suites) {
    for (const [k, v] of Object.entries(s.env ?? {})) {
      if (SECRET.test(k)) assert.equal(v, "", `${s.file}: env.${k} must be "" (unset) or absent`);
    }
  }
});

test("suites that pin Voice Live pin gpt-realtime on api-version 2026-04-10", () => {
  for (const s of suites) {
    const env = s.env ?? {};
    if ("VOICE_LIVE_MODEL" in env) assert.equal(env.VOICE_LIVE_MODEL, "gpt-realtime", s.file);
    if ("VOICE_LIVE_API_VERSION" in env) assert.equal(env.VOICE_LIVE_API_VERSION, "2026-04-10", s.file);
  }
});

test("suites run in a stable order: by order, then key", () => {
  const order = suites.map((s) => [s.order ?? 50, suiteKey(s)]);
  const sorted = [...order].sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  assert.deepEqual(order, sorted);
});
