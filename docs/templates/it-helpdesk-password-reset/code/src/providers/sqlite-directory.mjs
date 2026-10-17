import { getDb, nowIso } from "../db.mjs";
import { hashPassword, verifyPassword, validatePasswordPolicy } from "../store.mjs";

// The policy lives in store.mjs so the simulation and live calls share it.
export { hashPassword, verifyPassword };

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

  #row(username) {
    return getDb().prepare("SELECT * FROM users WHERE lower(username) = lower(?)").get(String(username ?? "").trim());
  }

  async findByUsername(username) {
    return toUser(this.#row(username));
  }

  async findById(id) {
    return toUser(getDb().prepare("SELECT * FROM users WHERE id = ?").get(id));
  }

  async authenticate(username, password) {
    const row = this.#row(username);
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
    return validatePasswordPolicy(password, user);
  }

  async setPassword(id, password) {
    const user = await this.findById(id);
    if (!user) return { ok: false, reason: "unknown_user" };
    const policy = this.validatePasswordPolicy(password, user);
    if (!policy.ok) return { ok: false, reason: "policy", failures: policy.failures };
    getDb()
      .prepare("UPDATE users SET password_hash = ?, locked = 0, last_reset_at = ? WHERE id = ?")
      .run(hashPassword(password), nowIso(), id);
    return { ok: true };
  }

  async unlockAccount(id) {
    getDb().prepare("UPDATE users SET locked = 0 WHERE id = ?").run(id);
  }
}
