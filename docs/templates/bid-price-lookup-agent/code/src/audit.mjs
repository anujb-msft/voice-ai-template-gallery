const countBy = (items, pick) =>
  items.reduce((acc, item) => {
    const k = pick(item) ?? "none";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

/** True when nobody had to pick up: the caller got what they needed from the agent alone. */
export function isAutomatedOutcome(outcome) {
  return Boolean(outcome) && !/^(transferred|callback_requested):/.test(String(outcome));
}

/** The in-memory audit used by the tests. `SqliteAudit` in db.mjs has the same shape. */
export class MemoryAudit {
  name = "memory";
  constructor() {
    this.calls = new Map();
    this.events = [];
    this.quotes = [];
    this.transcripts = [];
  }
  startCall(call) { this.calls.set(call.id, { ...call, simulated: Boolean(call.simulated) }); }
  updateCall(id, patch) { const c = this.calls.get(id); if (c) this.calls.set(id, { ...c, ...patch }); }
  recordEvent(callId, source, kind, detail = null) { this.events.push({ callId, source, kind, detail: detail == null ? null : String(detail), at: new Date().toISOString() }); }
  recordQuote(callId, quote) { this.quotes.push({ callId, commodity: quote.commodity, locationId: quote.locationId, freshness: quote.freshness, phrase: quote.phrase, at: new Date().toISOString() }); }
  recordTranscript(callId, role, text) { this.transcripts.push({ callId, role, text, at: new Date().toISOString() }); }
  eventsFor(callId) { return this.events.filter((e) => e.callId === callId); }

  /** Forget the simulated calls (the demo console's reset). Real calls stay. */
  reset() {
    const gone = new Set([...this.calls.values()].filter((c) => c.simulated).map((c) => c.id));
    for (const id of gone) this.calls.delete(id);
    this.events = this.events.filter((e) => !gone.has(e.callId));
    this.quotes = this.quotes.filter((q) => !gone.has(q.callId));
    this.transcripts = this.transcripts.filter((t) => !gone.has(t.callId));
  }

  stats({ minutesPerAutomatedCall = 3 } = {}) {
    const calls = [...this.calls.values()];
    const kinds = (...k) => this.events.filter((e) => k.includes(e.kind)).length;
    const callsAutomated = calls.filter((c) => isAutomatedOutcome(c.outcome)).length;
    const transferred = calls.filter((c) => String(c.outcome ?? "").startsWith("transferred:"));
    return {
      calls: calls.length,
      callsAutomated,
      estimatedStaffMinutesSaved: callsAutomated * minutesPerAutomatedCall,
      quotesGiven: this.quotes.length,
      quotesByCommodity: countBy(this.quotes, (q) => q.commodity),
      quotesByLocation: countBy(this.quotes, (q) => q.locationId),
      delayedQuotes: this.quotes.filter((q) => q.freshness === "delayed").length,
      closePriceQuotes: this.quotes.filter((q) => q.freshness === "close").length,
      clarifications: kinds("clarification"),
      feedOutages: kinds("feed_outage"),
      adviceDeclined: kinds("advice_guard"),
      contractsDeclined: kinds("contract_guard"),
      // Calls that ended with the merchandiser: a transfer that failed and became a callback counts once, as a callback.
      transfers: transferred.length,
      callbacks: kinds("callback_requested"),
      transfersByReason: countBy(transferred, (c) => String(c.outcome).slice("transferred:".length)),
      byOutcome: countBy(calls, (c) => c.outcome),
    };
  }
}