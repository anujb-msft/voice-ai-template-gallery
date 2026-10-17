/**
 * One SQLite handle, two possible drivers.
 *
 * The server prefers better-sqlite3. It is a native module, so it loads lazily
 * here and never at import time: if its build step failed on an unusual
 * platform, the demo still starts on Node's built-in node:sqlite with one log
 * line. Tests and the offline runner ask for node:sqlite directly, so they need
 * no `npm install` at all.
 *
 * Both drivers are wrapped to the small surface the stores use: prepare()
 * (get/all/run), exec(), pragma() and transaction(). Neither driver binds
 * booleans or undefined, so callers pass numbers and null.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
let warned = false;

export const isMemoryPath = (path) => !path || path === ":memory:";

/**
 * @param {string} path a file path, or ":memory:"
 * @param {{ driver?: "auto" | "better-sqlite3" | "node:sqlite", log?: (line: string) => void }} [options]
 */
export async function openDatabase(path = ":memory:", { driver = "auto", log = console.log } = {}) {
  if (!isMemoryPath(path)) mkdirSync(dirname(path), { recursive: true });
  if (driver !== "node:sqlite") {
    try {
      const { default: Database } = await import("better-sqlite3");
      return wrapBetter(new Database(path));
    } catch (error) {
      if (driver === "better-sqlite3") throw error;
      if (!warned) {
        warned = true;
        log(`[db] better-sqlite3 unavailable (${error.code ?? error.message}); using node:sqlite`);
      }
    }
  }
  return wrapNode(path);
}

function wrapBetter(db) {
  return {
    driver: "better-sqlite3",
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    pragma: (text) => db.pragma(text),
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
  };
}

function wrapNode(path) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    throw new Error("No SQLite driver: run npm install, or use Node.js 22.13 or later");
  }
  const db = new DatabaseSync(path);
  let depth = 0;
  return {
    driver: "node:sqlite",
    prepare(sql) {
      const statement = db.prepare(sql);
      // better-sqlite3 ignores named parameters a statement does not use.
      statement.setAllowUnknownNamedParameters?.(true);
      return statement;
    },
    exec: (sql) => db.exec(sql),
    pragma: (text) => db.prepare(`PRAGMA ${text}`).all(),
    transaction(fn) {
      return (...args) => {
        const savepoint = depth > 0 ? `sp_${depth}` : null;
        db.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
        depth += 1;
        try {
          const result = fn(...args);
          depth -= 1;
          db.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
          return result;
        } catch (error) {
          depth -= 1;
          db.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
          throw error;
        }
      };
    },
    close: () => db.close(),
  };
}
