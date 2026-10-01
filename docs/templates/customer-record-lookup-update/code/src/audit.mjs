export class MemoryAudit {
  name = "memory";

  constructor({ persistTranscripts = false, afterCallMinutesBaseline = 6 } = {}) {
    this.persistTranscripts = persistTranscripts;
    this.afterCallMinutesBaseline = afterCallMinutesBaseline;
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
    if (!this.persistTranscripts) return;
    this.transcripts.push({ callId, role, text, at: new Date().toISOString() });
  }

  eventsFor(callId) {
    return this.events.filter((e) => e.callId === callId);
  }

  stats(crm = null) {
    const calls = [...this.calls.values()];
    const count = (kind) => this.events.filter((e) => e.kind === kind).length;
    const committedActivities = crm?.committedActivityCount?.() ?? count("commit");
    return {
      calls: calls.length,
      averageHandleTimeSeconds: average(calls.map((c) => c.durationMs).filter(Number.isFinite), 1000),
      briefings: count("briefing"),
      proposals: count("proposal"),
      confirmedCommits: count("commit"),
      fieldsWrittenByEntity: crm?.fieldsWrittenByEntity?.() ?? {},
      undos: count("undo"),
      draftsSaved: count("draft_saved"),
      draftsResumed: count("draft_resumed"),
      refusedWritesByField: tally(this.events.filter((e) => e.kind === "refused_write").map((e) => e.detail ?? "unknown")),
      transfers: count("transfer"),
      estimatedAfterCallWorkMinutesSaved: this.afterCallMinutesBaseline * committedActivities,
    };
  }
}

function average(values, divisor = 1) {
  if (!values.length) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length / divisor) * 10) / 10;
}

function tally(values) {
  return values.reduce((acc, v) => ((acc[v] = (acc[v] ?? 0) + 1), acc), {});
}
