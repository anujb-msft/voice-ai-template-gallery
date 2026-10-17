import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEMO_EMPLOYEES,
  MemoryAudit,
  MemoryDirectory,
  MemoryTicketing,
  computeStats,
  hashPassword,
  medianSeconds,
  validatePasswordPolicy,
  verifyPassword,
} from "../src/store.mjs";

/**
 * The password policy and the stores the simulation runs on. The live SQLite
 * providers reuse the same policy function, so these rules are the rules a
 * real reset is held to.
 */

const ALEX = DEMO_EMPLOYEES.find((e) => e.username === "alex.morgan");
const JORDAN = DEMO_EMPLOYEES.find((e) => e.username === "jordan.patel");

const RULES = {
  length: "It needs to be at least 12 characters long.",
  upper: "It needs at least one capital letter.",
  lower: "It needs at least one lowercase letter.",
  number: "It needs at least one number.",
  symbol: "It needs at least one symbol.",
  common: "That password is on the commonly-used blocklist.",
  username: "It can't contain your username.",
  name: "It can't contain part of your name.",
};

// ------------------------------------------------------------ password policy

test("the demo's first try fails on exactly two rules: too short, and it contains the name", () => {
  assert.deepEqual(validatePasswordPolicy("Alex-2026!", ALEX), { ok: false, failures: [RULES.length, RULES.name] });
});

test("the passwords the scripted demo sets all pass", () => {
  assert.equal(validatePasswordPolicy("Harbor-Lantern-42!", ALEX).ok, true);
  assert.equal(validatePasswordPolicy("Granite-Harbor-73!", ALEX).ok, true);
  assert.equal(validatePasswordPolicy("Copper-Kettle-58!", JORDAN).ok, true);
});

test("each character rule is reported on its own, in speakable words", () => {
  assert.deepEqual(validatePasswordPolicy("lantern-harbor-42!", ALEX).failures, [RULES.upper]);
  assert.deepEqual(validatePasswordPolicy("LANTERN-HARBOR-42!", ALEX).failures, [RULES.lower]);
  assert.deepEqual(validatePasswordPolicy("Lantern-Harbor-xx!", ALEX).failures, [RULES.number]);
  assert.deepEqual(validatePasswordPolicy("LanternHarbor42x", ALEX).failures, [RULES.symbol]);
  assert.deepEqual(validatePasswordPolicy("", ALEX).failures, [RULES.length, RULES.upper, RULES.lower, RULES.number, RULES.symbol]);
});

test("a common password is refused even when it is long enough", () => {
  assert.ok(validatePasswordPolicy("Password1", JORDAN).failures.includes(RULES.common));
  assert.ok(validatePasswordPolicy("CHANGEME", JORDAN).failures.includes(RULES.common));
});

test("a password can't contain the username or any part of the name", () => {
  assert.deepEqual(validatePasswordPolicy("x-jordan.patel-9X", JORDAN).failures, [RULES.username, RULES.name]);
  assert.deepEqual(validatePasswordPolicy("Morgan-Lantern-42!", ALEX).failures, [RULES.name]);
  // A two-letter fragment is not a name match.
  assert.equal(validatePasswordPolicy("Al-Lantern-Harbor-42!", ALEX).ok, true);
});

test("passwords are stored salted and checked in constant time", () => {
  const stored = hashPassword("Harbor-Lantern-42!");
  assert.notEqual(stored, hashPassword("Harbor-Lantern-42!"));
  assert.equal(verifyPassword("Harbor-Lantern-42!", stored), true);
  assert.equal(verifyPassword("harbor-lantern-42!", stored), false);
  assert.equal(verifyPassword("anything", null), false);
  assert.equal(verifyPassword("anything", "not-a-hash"), false);
});

// ------------------------------------------------------------------ directory

test("sign-in tells a locked account from a wrong password", async () => {
  const directory = new MemoryDirectory();
  assert.deepEqual(await directory.authenticate("alex.morgan", "whatever"), { ok: false, reason: "locked" });
  assert.deepEqual(await directory.authenticate("jordan.patel", "whatever"), { ok: false, reason: "bad_password" });
  assert.deepEqual(await directory.authenticate("nobody", "whatever"), { ok: false, reason: "unknown_user" });
});

test("a new password must pass the policy; a good one unlocks the account and signs in", async () => {
  const directory = new MemoryDirectory();
  const rejected = await directory.setPassword(ALEX.id, "Alex-2026!");
  assert.deepEqual(rejected, { ok: false, reason: "policy", failures: [RULES.length, RULES.name] });
  assert.equal((await directory.findById(ALEX.id)).locked, true);

  assert.deepEqual(await directory.setPassword(ALEX.id, "Harbor-Lantern-42!"), { ok: true });
  assert.equal((await directory.findById(ALEX.id)).locked, false);
  assert.equal((await directory.authenticate("Alex.Morgan", "Harbor-Lantern-42!")).ok, true);
});

test("restore puts one employee back to the fixture, so a scripted run behaves the same every time", async () => {
  const directory = new MemoryDirectory();
  await directory.setPassword(ALEX.id, "Harbor-Lantern-42!");
  await directory.setPassword(JORDAN.id, "Copper-Kettle-58!");
  directory.restore("alex.morgan");
  assert.equal((await directory.findById(ALEX.id)).locked, true);
  assert.equal((await directory.authenticate("alex.morgan", "Harbor-Lantern-42!")).ok, false);
  assert.equal((await directory.authenticate("jordan.patel", "Copper-Kettle-58!")).ok, true);

  directory.reset();
  assert.equal((await directory.authenticate("jordan.patel", "Copper-Kettle-58!")).ok, false);
});

test("a directory record never carries the password hash out of the store", async () => {
  const directory = new MemoryDirectory({ phone: "+14255550100" });
  await directory.setPassword(JORDAN.id, "Copper-Kettle-58!");
  const user = await directory.findByUsername("jordan.patel");
  assert.equal("passwordHash" in user, false);
  assert.equal(user.phone, "+14255550100");
});

// ------------------------------------------------------------------- tickets

test("tickets are numbered from the start again after a reset", async () => {
  const ticketing = new MemoryTicketing();
  assert.deepEqual(await ticketing.openTicket({ userId: ALEX.id }), { id: "INC0007001" });
  assert.deepEqual(await ticketing.openTicket({ userId: JORDAN.id }), { id: "INC0007002" });
  await ticketing.closeTicket("INC0007001", { deflected: true, summary: "done" });
  await ticketing.closeTicket("INC0007002", { deflected: false, summary: "escalated" });
  assert.equal((await ticketing.getTicket("INC0007001")).status, "closed_deflected");
  assert.equal((await ticketing.getTicket("INC0007002")).status, "closed_escalated");
  assert.deepEqual(await ticketing.deflectionStats(), { total: 2, deflected: 1 });

  ticketing.reset();
  assert.deepEqual(await ticketing.openTicket({ userId: ALEX.id }), { id: "INC0007001" });
});

// --------------------------------------------------------------------- stats

test("the median ignores missing values and rounds", () => {
  assert.equal(medianSeconds([]), null);
  assert.equal(medianSeconds([null, undefined]), null);
  assert.equal(medianSeconds([40, 10, 20]), 20);
  assert.equal(medianSeconds([10, 21]), 16);
});

test("the metrics are computed from the audit, so each number traces back to a session", () => {
  const sessions = [
    { id: "a", verified: true, outcome: "reset_completed", secondsToReset: 50 },
    { id: "b", verified: false, outcome: "verification_failed" },
    { id: "c", verified: false, outcome: "escalated:other_account_request", handedOff: true },
    { id: "d", verified: true, outcome: "reset_completed", secondsToReset: 70, handedOff: true },
  ];
  const events = [{ kind: "refused" }, { kind: "refused" }, { kind: "verification_failed" }, { kind: "kb_answer" }, { kind: "state" }];
  assert.deepEqual(computeStats(sessions, events), {
    callbacks: 4,
    verified: 2,
    resetsCompleted: 2,
    refused: 3,
    handedOff: 2,
    kbAnswers: 1,
    medianSecondsToReset: 60,
  });
});

test("the demo reset forgets simulated sessions and keeps a real call's record", () => {
  const audit = new MemoryAudit();
  audit.startSession({ id: "sim", simulated: true });
  audit.startSession({ id: "live", simulated: false });
  audit.recordEvent("sim", { kind: "refused" });
  audit.recordEvent("live", { kind: "kb_answer" });
  audit.reset();
  assert.deepEqual([...audit.sessions.keys()], ["live"]);
  assert.deepEqual(
    audit.events.map((e) => e.sessionId),
    ["live"],
  );
  assert.equal(audit.stats().kbAnswers, 1);
});
