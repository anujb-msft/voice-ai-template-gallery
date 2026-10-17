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

  recordEvent(callId, source, kind, detail = null, meta = null) {
    const event = { callId, source, kind, detail: detail == null ? null : String(detail), at: new Date().toISOString() };
    if (meta) event.meta = { ...meta };
    this.events.push(event);
  }

  recordTranscript(callId, role, text) {
    this.transcripts.push({ callId, role, text, at: new Date().toISOString() });
  }

  eventsFor(callId) {
    return this.events.filter((e) => e.callId === callId);
  }

  /** Demo reset: forget simulated calls and everything recorded about them; real calls stay. */
  reset() {
    const simulated = new Set([...this.calls.values()].filter((c) => c.simulated).map((c) => c.id));
    for (const id of simulated) this.calls.delete(id);
    this.events = this.events.filter((e) => !simulated.has(e.callId));
    this.transcripts = this.transcripts.filter((t) => !simulated.has(t.callId));
  }

  /**
   * Operational metrics. The first block is what the console's footer shows;
   * the rest is the per-type breakdown a 311 supervisor would want.
   */
  stats(cases = []) {
    const calls = [...this.calls.values()];
    const events = this.events;
    const tally = (items, key) => items.reduce((acc, item) => ((acc[item[key] ?? "none"] = (acc[item[key] ?? "none"] ?? 0) + 1), acc), {});
    const count = (kind) => events.filter((e) => e.kind === kind).length;
    const byDetail = (kind) => events.filter((e) => e.kind === kind).reduce((acc, e) => ((acc[e.detail ?? "none"] = (acc[e.detail ?? "none"] ?? 0) + 1), acc), {});
    // A transfer counts as handed off once ACS accepted the request (or the
    // simulation stood in for it). One ACS accepted and later reported failed
    // never reached a person, so it is taken back out.
    const acceptedThenFailed = events.filter((e) => e.kind === "transfer_failed" && e.meta?.accepted).length;
    return {
      calls: calls.length,
      requestsCreated: count("case_created") + count("guided_completed"),
      duplicates: count("duplicate_attached"),
      emergenciesEscalated: count("emergency_redirect"),
      answered: count("faq_answered"),
      handedOff: count("transfer_succeeded") + count("transfer_simulated") - acceptedThenFailed,
      texts: count("sms_simulated") + count("sms_sent"),
      spanishCalls: calls.filter((c) => String(c.language ?? "").startsWith("es")).length,

      containment: calls.length ? calls.filter((c) => !String(c.outcome ?? "").startsWith("transferred")).length / calls.length : 0,
      requestsByType: tally(cases, "type"),
      requestsByDepartment: tally(cases, "department"),
      duplicatesMerged: count("duplicate_attached"),
      emergencyRedirects: byDetail("emergency_redirect"),
      transfersByReason: byDetail("transfer_started"),
      failedTransfers: count("transfer_failed"),
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
