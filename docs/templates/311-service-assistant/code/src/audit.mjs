export class MemoryAudit {
  name = "memory";

  constructor() {
    this.calls = new Map();
    this.events = [];
    this.transcripts = [];
  }

  startCall(call) {
    this.calls.set(call.id, { ...call });
  }

  updateCall(id, patch) {
    const existing = this.calls.get(id);
    if (existing) this.calls.set(id, { ...existing, ...patch });
  }

  recordEvent(callId, source, kind, detail = null) {
    this.events.push({ callId, source, kind, detail: detail == null ? null : String(detail), at: new Date().toISOString() });
  }

  recordTranscript(callId, role, text) {
    this.transcripts.push({ callId, role, text, at: new Date().toISOString() });
  }

  eventsFor(callId) {
    return this.events.filter((e) => e.callId === callId);
  }

  stats(cases = []) {
    const calls = [...this.calls.values()];
    const events = this.events;
    const tally = (items, key) => items.reduce((acc, item) => ((acc[item[key] ?? "none"] = (acc[item[key] ?? "none"] ?? 0) + 1), acc), {});
    const count = (kind) => events.filter((e) => e.kind === kind).length;
    const byDetail = (kind) => events.filter((e) => e.kind === kind).reduce((acc, e) => ((acc[e.detail ?? "none"] = (acc[e.detail ?? "none"] ?? 0) + 1), acc), {});
    return {
      calls: calls.length,
      containment: calls.length ? calls.filter((c) => !String(c.outcome ?? "").startsWith("transferred")).length / calls.length : 0,
      requestsByType: tally(cases, "type"),
      requestsByDepartment: tally(cases, "department"),
      duplicatesMerged: count("duplicate_attached"),
      emergencyRedirects: byDetail("emergency_redirect"),
      transfersByReason: byDetail("transfer_started"),
      callsByLanguage: tally(calls, "language"),
      averageHandleTimeMs: avg(calls.map((c) => c.durationMs).filter((n) => Number.isFinite(n))),
      guidedFlowStarts: count("guided_started"),
      guidedFlowCompletions: count("guided_completed"),
      smsLinksSent: count("sms_link_sent"),
    };
  }
}

function avg(values) {
  if (!values.length) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}
