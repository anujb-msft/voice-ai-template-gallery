/**
 * The audit trail of calls and events, and the metrics the console ends on.
 * Events carry no PINs, phone numbers or Teams IDs; transcripts are kept only
 * when TRANSCRIPT_RETENTION is on. Standard library only.
 */
export class MemoryAudit {
  name = "memory";

  constructor({ persistTranscripts = false, now = () => Date.now() } = {}) {
    this.persistTranscripts = persistTranscripts;
    this.now = now;
    this.calls = new Map();
    this.events = [];
    this.transcripts = [];
  }

  /** Demo reset: simulated calls and their events go, so every run starts from zero; a call from a real phone stays. */
  reset() {
    const gone = new Set([...this.calls.values()].filter((c) => c.simulated).map((c) => c.id));
    for (const id of gone) this.calls.delete(id);
    this.events = this.events.filter((e) => !gone.has(e.callId));
    this.transcripts = this.transcripts.filter((t) => !gone.has(t.callId));
  }

  startCall(call) {
    this.calls.set(call.id, { ...call });
  }

  updateCall(id, patch) {
    const existing = this.calls.get(id);
    if (existing) this.calls.set(id, { ...existing, ...patch });
  }

  recordEvent(callId, source, kind, detail = null) {
    this.events.push({ callId, source, kind, detail: detail == null ? null : String(detail), at: new Date(this.now()).toISOString() });
  }

  recordTranscript(callId, role, text) {
    if (!this.persistTranscripts) return;
    this.transcripts.push({ callId, role, text, at: new Date(this.now()).toISOString() });
  }

  eventsFor(callId) {
    return this.events.filter((e) => e.callId === callId);
  }

  stats(crm = null) {
    const calls = [...this.calls.values()];
    const count = (...kinds) => this.events.filter((e) => kinds.includes(e.kind)).length;
    // Each failure (refused at dispatch, or accepted and then not answered) cancels exactly one dispatch.
    const failedTransfers = count("transfer_failed");
    const handoffs = Math.max(0, count("transfer") - failedTransfers);
    return {
      calls: calls.length,
      lookups: count("briefing", "lookup", "contact_lookup"),
      verifications: count("verified"),
      verificationFailures: count("verification_failed", "refused_caller"),
      confirmedWrites: count("commit"),
      undoneWrites: count("commit_cancelled", "undo"),
      cancelledInWindow: count("commit_cancelled"),
      refusals: count("policy_refusal"),
      handoffs,
      failedTransfers,
      averageHandleTimeSeconds: average(calls.map((c) => c.durationMs).filter(Number.isFinite), 1000),
      briefings: count("briefing"),
      proposals: count("proposal"),
      confirmedCommits: count("commit"),
      fieldsWrittenByEntity: crm?.fieldsWrittenByEntity?.() ?? {},
      undos: count("undo"),
      draftsSaved: count("draft_saved"),
      draftsResumed: count("draft_resumed"),
      refusedWritesByField: tally(this.events.filter((e) => e.kind === "refused_write").map((e) => e.detail ?? "unknown")),
      transfers: handoffs,
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
