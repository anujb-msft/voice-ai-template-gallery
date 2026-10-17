import { randomInt } from "node:crypto";

/**
 * One-time codes for callers whose number proves nothing (PSTN).
 *
 * Simulated calls always get the fixed demo code and nothing leaves the
 * process: the presenter console shows it in a mock Teams chat instead. Real
 * calls get a random code, but delivery is still a stub — wire `deliver` to
 * Microsoft Graph (Teams chat) or Azure Communication Services SMS before you
 * rely on it.
 */
export class OtpSender {
  constructor({ code = "123456", now = Date.now, ttlMs = 5 * 60_000, deliver = null } = {}) {
    this.code = code;
    this.now = now;
    this.ttlMs = ttlMs;
    this.deliver = deliver;
    this.sent = [];
  }

  send(employee, channel = "teams", { simulated = false } = {}) {
    const sentAt = this.now();
    const record = {
      email: employee.workEmail,
      channel,
      code: simulated ? this.code : String(randomInt(0, 1_000_000)).padStart(6, "0"),
      sentAt,
      expiresAt: sentAt + this.ttlMs,
      simulated,
    };
    if (!simulated) this.deliver?.(employee, record);
    this.sent.push(record);
    if (this.sent.length > 100) this.sent.shift();
    return record;
  }

  reset() {
    this.sent = [];
  }
}
