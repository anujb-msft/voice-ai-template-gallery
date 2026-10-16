import fs from "node:fs";
import path from "node:path";
import { TEMPLATES_DIR } from "./config.mjs";

/** Templates the harness can start: the ones with a server. */
export function runnableTemplates(dir = TEMPLATES_DIR) {
  return fs
    .readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, "code", "src", "server.mjs")))
    .sort();
}

/**
 * Node 24 before 24.22 aborts while loading a native addon compiled against
 * Node 24.19+ headers (better-sqlite3's prebuilt binaries are), because the
 * addon calls node::RemoveEnvironmentCleanupHook.
 */
const CLEANUP_HOOK = "RemoveEnvironmentCleanupHook";

export function addonCrashRisk(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  return major === 24 && minor < 22;
}

/** Native addons in a node_modules folder (package/build/Release/*.node, scoped packages too). */
export function nativeAddons(nodeModules) {
  const ls = (d) => {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  };
  const packages = ls(nodeModules).flatMap((p) =>
    p.startsWith("@") ? ls(path.join(nodeModules, p)).map((s) => path.join(p, s)) : [p],
  );
  return packages.flatMap((p) => {
    const release = path.join(nodeModules, p, "build", "Release");
    return ls(release)
      .filter((f) => f.endsWith(".node"))
      .map((f) => path.join(release, f));
  });
}

/** The addons in `nodeModules` that would crash on an affected Node 24. */
export function crashProneAddons(nodeModules) {
  return nativeAddons(nodeModules).filter((file) => fs.readFileSync(file).includes(CLEANUP_HOOK));
}
