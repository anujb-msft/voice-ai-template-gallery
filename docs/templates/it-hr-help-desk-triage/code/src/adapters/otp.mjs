export class OtpSender {
  constructor({ code = "123456", now = Date.now, ttlMs = 5 * 60_000 } = {}) { this.code = code; this.now = now; this.ttlMs = ttlMs; this.sent = []; }
  send(employee, channel = "teams") { const record = { email: employee.workEmail, channel, code: this.code, expiresAt: this.now() + this.ttlMs }; this.sent.push(record); return record; }
}
