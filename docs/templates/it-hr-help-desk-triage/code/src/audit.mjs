import { config } from "./config.mjs";

/**
 * Builds the `/api/stats` shape from raw counts, so the in-memory and SQLite
 * stores report the same thing. Confidential HR counts below the minimum are
 * suppressed everywhere they could appear, including the transfer tally.
 */
export function buildStats({ calls, mix, durations = [], count, tally, transferred = {}, ticketStats = {}, statsMinCount = config.statsMinCount }) {
  const confidential = count("confidential_hr");
  const suppressed = confidential < statsMinCount;
  // Counted from how calls ended, not from transfer attempts: a transfer that
  // Call Automation reports as failed clears the outcome, so it never counts.
  const transfers = { ...transferred };
  const handedOff = Object.entries(transfers).filter(([k]) => k !== "confidential-hr").reduce((n, [, v]) => n + v, 0);
  if (suppressed) delete transfers["confidential-hr"];
  const verification = {
    required: count("verification_required"),
    sent: count("code_sent"),
    verified: count("verified"),
    refused: count("code_refused"),
    expired: count("code_expired"),
    unknownEmail: count("unknown_email"),
  };
  const small = (n) => (suppressed ? `<${statsMinCount}` : n);
  return {
    calls,
    mix,
    tier1Deflection: count("answered") + count("personal_answer"),
    routingAccuracy: null,
    averageTimeToResolutionMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    answersByArticle: tally("answered"),
    ticketsByCategory: ticketStats.byCategory ?? {},
    ticketsByPriority: ticketStats.byPriority ?? {},
    outageAttachments: count("outage_attached"),
    resetHandoffs: count("password_reset_handoff"),
    transfersByDestination: transfers,
    outOfScopeRedirects: count("out_of_scope"),
    verificationOutcomes: verification,
    confidentialHr: small(confidential),
    /** The numbers the presenter console ends on. */
    story: {
      calls,
      answered: count("answered") + count("personal_answer") + count("ticket_status"),
      ticketsFiled: count("ticket_created"),
      duplicatesAvoided: count("outage_attached"),
      verifiedByCode: verification.verified,
      codesRefused: verification.refused,
      sensitiveRouted: small(confidential),
      handedOff,
    },
  };
}

export class MemoryAudit {
  name = "memory";
  constructor({ retainTranscripts = config.transcriptRetention, statsMinCount = config.statsMinCount } = {}) {
    this.retainTranscripts = retainTranscripts;
    this.statsMinCount = statsMinCount;
    this.calls = new Map();
    this.events = [];
    this.transcripts = [];
  }
  startCall(call) { this.calls.set(call.id, { ...call }); }
  updateCall(id, patch) { const c = this.calls.get(id); if (c) this.calls.set(id, { ...c, ...patch }); }
  recordEvent(callId, source, kind, detail = null, at = new Date().toISOString()) {
    this.events.push({ callId, source, kind, detail: detail == null ? null : String(detail), at });
  }
  recordTranscript(callId, role, text, { sensitive = false } = {}) {
    if (!this.retainTranscripts || sensitive) return;
    this.transcripts.push({ callId, role, text, at: new Date().toISOString() });
  }
  eventsFor(callId) { return this.events.filter((e) => e.callId === callId); }
  stats(ticketStats = {}) {
    const calls = [...this.calls.values()];
    const count = (kind) => this.events.filter((e) => e.kind === kind).length;
    const tally = (kind) => this.events.filter((e) => e.kind === kind).reduce((acc, e) => {
      const key = e.detail ?? "none";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    const mix = calls.reduce((acc, c) => { const key = c.domain ?? "none"; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {});
    const transferred = calls.reduce((acc, c) => {
      const destination = /^transferred:(.+)$/.exec(c.outcome ?? "")?.[1];
      if (destination) acc[destination] = (acc[destination] ?? 0) + 1;
      return acc;
    }, {});
    return buildStats({ calls: calls.length, mix, durations: calls.map((c) => c.durationMs).filter(Boolean), count, tally, transferred, ticketStats, statsMinCount: this.statsMinCount });
  }
  /** Demo reset: drop simulated calls and everything recorded about them. */
  reset() {
    const simulated = new Set([...this.calls.values()].filter((c) => c.simulation).map((c) => c.id));
    for (const id of simulated) this.calls.delete(id);
    this.events = this.events.filter((e) => !simulated.has(e.callId));
    this.transcripts = this.transcripts.filter((t) => !simulated.has(t.callId));
    return { removed: simulated.size };
  }
}
