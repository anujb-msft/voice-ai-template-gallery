import { randomBytes } from "node:crypto";
import { db, nowIso } from "../src/db.mjs";
import { hashPassword } from "../src/providers/sqlite-directory.mjs";
import { config } from "../src/config.mjs";

const demoPassword = () => `${randomBytes(12).toString("base64url")}Aa1!`;

/**
 * Seeds the sample workforce. Swap this out entirely once you point the
 * DirectoryProvider at Entra ID, Okta or Active Directory.
 */
const users = [
  {
    id: "u-alex",
    username: "alex.morgan",
    display_name: "Alex Morgan",
    // Real directories carry a phonetic field; the agent is told to use it.
    phonetic_name: null,
    email: "alex.morgan@example.com",
    phone: config.demo.defaultPhone,
    department: "Field Operations",
    employee_id: "E-104217",
    password: demoPassword(),
    locked: 1,
  },
  {
    id: "u-jordan",
    username: "jordan.patel",
    display_name: "Jordan Patel",
    phonetic_name: null,
    email: "jordan.patel@example.com",
    phone: config.demo.defaultPhone,
    department: "Finance",
    employee_id: "E-100892",
    password: demoPassword(),
    locked: 0,
  },
];

const insert = db.prepare(`
  INSERT INTO users (id, username, display_name, phonetic_name, email, phone, department, employee_id, password_hash, locked, last_reset_at)
  VALUES (@id, @username, @display_name, @phonetic_name, @email, @phone, @department, @employee_id, @password_hash, @locked, @last_reset_at)
  ON CONFLICT(id) DO UPDATE SET
    username = excluded.username, display_name = excluded.display_name,
    phonetic_name = excluded.phonetic_name, email = excluded.email,
    phone = excluded.phone, department = excluded.department, employee_id = excluded.employee_id,
    password_hash = excluded.password_hash, locked = excluded.locked
`);

for (const u of users) {
  insert.run({
    ...u,
    password_hash: hashPassword(u.password),
    last_reset_at: nowIso(),
  });
}

console.log(`Seeded ${users.length} users into ${config.dbPath}\n`);
for (const u of users) {
  console.log(`  ${u.display_name}`);
  console.log(`    username     ${u.username}`);
  console.log(`    password     ${u.password}${u.locked ? "   (account is LOCKED — use this one for the demo)" : ""}`);
  console.log(`    employee ID  ${u.employee_id}   -> agent will ask for the last four: ${u.employee_id.slice(-4)}`);
  console.log(`    callback to  ${u.phone}\n`);
}
