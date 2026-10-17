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

  /**
   * Forget simulated calls and everything recorded about them — the demo
   * console's reset between run-throughs. Calls from a real phone stay.
   */
  reset() {
    const gone = new Set([...this.calls.values()].filter((c) => c.simulated).map((c) => c.id));
    for (const id of gone) this.calls.delete(id);
    this.events = this.events.filter((e) => !gone.has(e.callId));
    this.transcripts = this.transcripts.filter((t) => !gone.has(t.callId));
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
      transfers: count("transfer_succeeded") + count("transfer_simulated"),
      failedTransfers: count("transfer_failed"),
      messagesTaken: count("message_taken"),
      humanRequests: count("human_requested"),
      medianSecondsToRoute: medianSeconds(
        calls.filter((c) => String(c.outcome ?? "").startsWith("transferred:")).map((c) => c.durationMs),
      ),
    };
  }
}

/** Median of a list of durations in milliseconds, in seconds to one decimal place. */
export function medianSeconds(durationsMs) {
  const sorted = durationsMs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  const ms = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(ms / 100) / 10;
}
