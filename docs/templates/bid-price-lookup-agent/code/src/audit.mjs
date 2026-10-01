export class MemoryAudit {
  name = "memory";
  constructor() {
    this.calls = new Map();
    this.events = [];
    this.transcripts = [];
  }
  startCall(call) { this.calls.set(call.id, { ...call }); }
  updateCall(id, patch) { const c = this.calls.get(id); if (c) this.calls.set(id, { ...c, ...patch }); }
  recordEvent(callId, source, kind, detail = null) { this.events.push({ callId, source, kind, detail: detail == null ? null : String(detail), at: new Date().toISOString() }); }
  recordQuote(callId, quote) { this.recordEvent(callId, "system", "quote", JSON.stringify({ commodity: quote.commodity, locationId: quote.locationId, freshness: quote.freshness })); }
  recordTranscript(callId, role, text) { this.transcripts.push({ callId, role, text, at: new Date().toISOString() }); }
  eventsFor(callId) { return this.events.filter((e) => e.callId === callId); }
  stats({ minutesPerAutomatedCall = 3 } = {}) {
    const calls = [...this.calls.values()];
    const quoteEvents = this.events.filter((e) => e.kind === "quote").map((e) => JSON.parse(e.detail));
    const countBy = (items, key) => items.reduce((acc, item) => { const k = item[key] ?? "none"; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
    const callsAutomated = calls.filter((c) => c.outcome && !String(c.outcome).startsWith("transferred")).length;
    return {
      calls: calls.length,
      callsAutomated,
      estimatedStaffMinutesSaved: callsAutomated * minutesPerAutomatedCall,
      quotesByCommodity: countBy(quoteEvents, "commodity"),
      quotesByLocation: countBy(quoteEvents, "locationId"),
      delayedQuotes: quoteEvents.filter((q) => q.freshness === "delayed").length,
      closePriceQuotes: quoteEvents.filter((q) => q.freshness === "close").length,
      feedOutages: this.events.filter((e) => e.kind === "feed_outage").length,
      transfersByReason: countBy(this.events.filter((e) => e.kind === "transfer_started").map((e) => ({ reason: e.detail })), "reason"),
      byOutcome: countBy(calls, "outcome"),
    };
  }
}
