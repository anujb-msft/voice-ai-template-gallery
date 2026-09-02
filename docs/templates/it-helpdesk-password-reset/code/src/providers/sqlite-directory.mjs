import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { db, nowIso } from "../db.mjs";

const COMMON_PASSWORDS = new Set([
  "password", "password1", "welcome1", "letmein", "qwerty123",
  "contoso123", "changeme", "summer2026", "winter2026", "admin123",
]);

export function hashPassword(plain) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(plain, salt, 64).toString("hex")}`;
}

export function verifyPassword(plain, stored) {
  if (!stored) return false;
  const [salt, key] = stored.split(":");
  if (!salt || !key) return false;
  const a = Buffer.from(key, "hex");
  const b = scryptSync(plain, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

const toUser = (row) =>
  row && {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    phoneticName: row.phonetic_name,
    email: row.email,
    phone: row.phone,
    department: row.department,
    employeeId: row.employee_id,
    locked: !!row.locked,
  };

/** Reference DirectoryProvider backed by the local SQLite table. @implements {import("./directory.mjs").DirectoryProvider} */
export class SqliteDirectoryProvider {
  name = "sqlite";

  async findByUsername(username) {
    return toUser(
      db.prepare("SELECT * FROM users WHERE lower(username) = lower(?)").get(String(username ?? "").trim()),
    );
  }

  async findById(id) {
    return toUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id));
  }

  async authenticate(username, password) {
    const row = db
      .prepare("SELECT * FROM users WHERE lower(username) = lower(?)")
      .get(String(username ?? "").trim());
    if (!row) return { ok: false, reason: "unknown_user" };
    if (row.locked) return { ok: false, reason: "locked" };
    if (!verifyPassword(password, row.password_hash)) return { ok: false, reason: "bad_password" };
    return { ok: true, user: toUser(row) };
  }

  /**
   * Password policy, expressed as data so the voice agent can read the rules
   * aloud and coach the user in real time rather than just rejecting input.
   */
  validatePasswordPolicy(password, user) {
    const pw = String(password ?? "");
    const failures = [];
    if (pw.length < 12) failures.push("It needs to be at least 12 characters long.");
    if (!/[A-Z]/.test(pw)) failures.push("It needs at least one capital letter.");
    if (!/[a-z]/.test(pw)) failures.push("It needs at least one lowercase letter.");
    if (!/[0-9]/.test(pw)) failures.push("It needs at least one number.");
    if (!/[^A-Za-z0-9]/.test(pw)) failures.push("It needs at least one symbol.");
    if (COMMON_PASSWORDS.has(pw.toLowerCase())) failures.push("That password is on the commonly-used blocklist.");
    if (user?.username && pw.toLowerCase().includes(user.username.toLowerCase())) {
      failures.push("It can't contain your username.");
    }
    if (user?.displayName) {
      for (const part of user.displayName.split(/\s+/).filter((p) => p.length >= 3)) {
        if (pw.toLowerCase().includes(part.toLowerCase())) {
          failures.push("It can't contain part of your name.");
          break;
        }
      }
    }
    return { ok: failures.length === 0, failures };
  }

  async setPassword(id, password) {
    const user = await this.findById(id);
    if (!user) return { ok: false, reason: "unknown_user" };
    const policy = this.validatePasswordPolicy(password, user);
    if (!policy.ok) return { ok: false, reason: "policy", failures: policy.failures };
    db.prepare("UPDATE users SET password_hash = ?, locked = 0, last_reset_at = ? WHERE id = ?").run(
      hashPassword(password),
      nowIso(),
      id,
    );
    return { ok: true };
  }

  async unlockAccount(id) {
    db.prepare("UPDATE users SET locked = 0 WHERE id = ?").run(id);
  }
}
