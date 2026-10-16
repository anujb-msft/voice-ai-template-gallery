import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { addonCrashRisk, crashProneAddons, nativeAddons, runnableTemplates } from "../src/preflight.mjs";

test("Node 24 before 24.22 is the runtime that aborts on newer addons", () => {
  for (const v of ["24.0.0", "24.18.1", "24.21.0"]) assert.equal(addonCrashRisk(v), true, v);
  for (const v of ["22.20.0", "24.22.0", "24.30.1", "25.1.0", "20.19.0"]) assert.equal(addonCrashRisk(v), false, v);
});

test("finds native addons, scoped packages included, and the ones that would abort", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-harness-addons-"));
  const addon = (pkg, name, body) => {
    const dir = path.join(root, pkg, "build", "Release");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from(body)]));
  };
  try {
    addon("better-sqlite3", "better_sqlite3.node", "\0_ZN4node28RemoveEnvironmentCleanupHookEPN2v87IsolateEPFvPvES3_\0");
    addon("@scope/fast", "fast.node", "\0napi_remove_env_cleanup_hook\0");
    addon("plain", "notes.txt", "RemoveEnvironmentCleanupHook");
    fs.mkdirSync(path.join(root, ".bin"));
    assert.deepEqual(nativeAddons(root).map((f) => path.relative(root, f)).sort(), [
      path.join("@scope", "fast", "build", "Release", "fast.node"),
      path.join("better-sqlite3", "build", "Release", "better_sqlite3.node"),
    ]);
    assert.deepEqual(
      crashProneAddons(root).map((f) => path.basename(f)),
      ["better_sqlite3.node"],
    );
    assert.deepEqual(nativeAddons(path.join(root, "missing")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runnable templates are the ones with a server", () => {
  const all = runnableTemplates();
  assert.ok(all.includes("intent-based-call-routing"));
  assert.ok(all.includes("it-helpdesk-password-reset"));
  assert.deepEqual(all, [...all].sort());
});
