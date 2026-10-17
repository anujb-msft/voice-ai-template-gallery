/**
 * Audit sink.
 *
 * The scheduling flow only ever talks to this interface, which is what lets
 * the whole flow run (and be tested) with no database and no cloud
 * credentials. `src/db.mjs` provides the SQLite implementation the server
 * uses.
 *
 * Caller text is passed separately from events on purpose: transcripts are
 * masked by the flow and kept only when TRANSCRIPT_RETENTION is on; events are
 * always kept, and never carry a name, a date of birth or a phone number.
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
   * Forget simulated calls and everything recorded about them: the demo
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
    const byOutcome = {};
    for (const c of calls) {
      const k = c.outcome ?? "in_progress";
      byOutcome[k] = (byOutcome[k] ?? 0) + 1;
    }
    const counts = {};
    for (const e of this.events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    return summarize({
      calls: calls.length,
      verified: calls.filter((c) => c.verified).length,
      byOutcome,
      count: (kind) => counts[kind] ?? 0,
    });
  }
}

const sumWhere = (byOutcome, prefix) =>
  Object.entries(byOutcome).reduce((n, [outcome, count]) => (outcome.startsWith(prefix) ? n + count : n), 0);

/**
 * The metrics strip, shared by both sinks so they cannot disagree.
 *
 * A booking counts once the server has written it (booked:* or
 * rescheduled:*). A refused write is any write the server would not make: a
 * "just book it" with nothing proposed, a model naming a booking tool, or a
 * yes that arrived after the time was taken. A race is resolved when a caller
 * who lost a time picked a fresh one and said yes to it. Handoffs are calls
 * that ended with a person: a Teams transfer or a callback ticket.
 */
export function summarize({ calls, verified, byOutcome, count }) {
  const byDestination = {};
  for (const [outcome, n] of Object.entries(byOutcome)) {
    const match = /^(?:transferred|callback|advised):(.+)$/.exec(outcome);
    if (match) byDestination[match[1]] = (byDestination[match[1]] ?? 0) + n;
  }
  const transfers = sumWhere(byOutcome, "transferred:");
  const callbacks = sumWhere(byOutcome, "callback:");
  return {
    calls,
    verified,
    booked: sumWhere(byOutcome, "booked:") + sumWhere(byOutcome, "rescheduled:"),
    cancelled: sumWhere(byOutcome, "cancelled:"),
    refusedWrites: count("write_refused"),
    racesLost: count("slot_taken"),
    racesResolved: count("race_resolved"),
    takenElsewhere: count("taken_elsewhere"),
    handoffs: transfers + callbacks,
    transfers,
    callbacks,
    advised: sumWhere(byOutcome, "advised:"),
    failedTransfers: count("transfer_failed"),
    eligibilityBlocks: count("eligibility_blocked"),
    identityNotConfirmed: count("identity_not_confirmed"),
    safetyEscalations: count("safety"),
    waitlisted: sumWhere(byOutcome, "waitlisted"),
    byOutcome,
    byDestination,
  };
}
