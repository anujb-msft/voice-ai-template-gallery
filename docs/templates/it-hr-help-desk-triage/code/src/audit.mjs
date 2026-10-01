import { config } from "./config.mjs";

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
  recordEvent(callId, source, kind, detail = null) { this.events.push({ callId, source, kind, detail: detail == null ? null : String(detail), at: new Date().toISOString() }); }
  recordTranscript(callId, role, text, { sensitive = false } = {}) { if (!this.retainTranscripts || sensitive) return; this.transcripts.push({ callId, role, text, at: new Date().toISOString() }); }
  eventsFor(callId) { return this.events.filter((e) => e.callId === callId); }
  stats(ticketStats = {}) {
    const calls = [...this.calls.values()];
    const events = (kind) => this.events.filter((e) => e.kind === kind).length;
    const tally = (field) => calls.reduce((a, c) => { const k = c[field] ?? "none"; a[k] = (a[k] ?? 0) + 1; return a; }, {});
    const confidential = events("confidential_hr");
    return {
      calls: calls.length,
      mix: tally("domain"),
      tier1Deflection: events("answered") + events("personal_answer"),
      routingAccuracy: null,
      averageTimeToResolutionMs: avg(calls.map((c) => c.durationMs).filter(Boolean)),
      answersByArticle: this.#eventTally("answered"),
      ticketsByCategory: ticketStats.byCategory ?? {},
      ticketsByPriority: ticketStats.byPriority ?? {},
      outageAttachments: events("outage_attached"),
      resetHandoffs: events("password_reset_handoff"),
      transfersByDestination: this.#eventTally("transfer"),
      outOfScopeRedirects: events("out_of_scope"),
      verificationOutcomes: this.#eventTally("verification"),
      confidentialHr: confidential < this.statsMinCount ? "<5" : confidential,
    };
  }
  #eventTally(kind) { return this.events.filter((e) => e.kind === kind).reduce((a, e) => { const k = e.detail ?? "none"; a[k] = (a[k] ?? 0) + 1; return a; }, {}); }
}
function avg(xs) { return xs.length ? Math.round(xs.reduce((a,b)=>a+b,0)/xs.length) : null; }
