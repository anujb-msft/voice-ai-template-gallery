/**
 * Audit sink.
 *
 * The state machine only ever talks to this interface, which is what lets the
 * whole routing flow run — and be tested — with no database and no cloud
 * credentials. `src/db.mjs` provides the SQLite implementation the server uses.
 *
 * Utterance text is passed separately from events on purpose: transcripts are
 * suppressed by default, events never are.
 */
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
    this.events.push({
      callId,
      source,
      kind,
      detail: detail == null ? null : String(detail),
      at: new Date().toISOString(),
    });
  }

  recordTranscript(callId, role, text) {
    this.transcripts.push({ callId, role, text, at: new Date().toISOString() });
  }

  eventsFor(callId) {
    return this.events.filter((e) => e.callId === callId);
  }

  stats() {
    const calls = [...this.calls.values()];
    const tally = (key) =>
      calls.reduce((acc, c) => {
        const k = c[key] ?? "none";
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {});

    const count = (kind) => this.events.filter((e) => e.kind === kind).length;

    return {
      calls: calls.length,
      byOutcome: tally("outcome"),
      byRoute: tally("confirmedRouteId"),
      clarifications: count("clarification"),
      fallbacks: count("fallback"),
      transfers: count("transfer_succeeded"),
      failedTransfers: count("transfer_failed"),
      messagesTaken: count("message_taken"),
    };
  }
}
