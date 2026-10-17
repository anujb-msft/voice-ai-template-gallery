export class MemoryAudit {
  name = "memory";

  constructor({ persistTranscripts = false } = {}) {
    this.persistTranscripts = persistTranscripts;
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
    this.events.push({ callId, source, kind, detail: detail == null ? null : String(detail), meta, at: new Date().toISOString() });
  }

  recordTranscript(callId, role, text) {
    if (!this.persistTranscripts) return;
    this.transcripts.push({ callId, role, text, at: new Date().toISOString() });
  }

  eventsFor(callId) {
    return this.events.filter((e) => e.callId === callId);
  }

  /** Drop simulated calls and everything recorded about them; real calls stay. */
  reset() {
    const simulated = new Set([...this.calls.values()].filter((c) => c.simulated).map((c) => c.id));
    for (const id of simulated) this.calls.delete(id);
    this.events = this.events.filter((e) => !simulated.has(e.callId));
    this.transcripts = this.transcripts.filter((t) => !simulated.has(t.callId));
    return { removed: simulated.size };
  }

  stats() {
    return computeStats([...this.calls.values()], this.events);
  }
}

export function computeStats(calls, events) {
  const count = (kind) => events.filter((e) => e.kind === kind).length;
  const callsN = calls.length;
  const answers = count("answer_recorded");
  // A transfer ACS accepted and then reported failed never reached a person.
  const transfers = count("transfer_succeeded") + count("transfer_simulated")
    - events.filter((e) => e.kind === "transfer_failed" && e.meta?.accepted).length;
  const humanRequests = count("human_requested");
  const callsWithAnswer = new Set(events.filter((e) => e.kind === "answer_recorded").map((e) => e.callId));
  const callsWithHuman = new Set(events.filter((e) => e.kind === "human_requested" || e.kind.startsWith("transfer_")).map((e) => e.callId));
  const deflected = calls.filter((c) => callsWithAnswer.has(c.id) && !callsWithHuman.has(c.id)).length;
  const topics = {};
  for (const e of events.filter((e) => e.kind === "answer_recorded" || e.kind === "expired_refusal" || e.kind === "retrieval_miss")) {
    const topic = e.meta?.topic ?? "unknown";
    topics[topic] = (topics[topic] ?? 0) + 1;
  }
  return {
    calls: callsN,
    answers,
    groundedAnswerRate: answers ? 1 : 0,
    staleAnswerCount: count("stale_answer"),
    expiredRefusals: count("expired_refusal"),
    misses: count("retrieval_miss"),
    transfers,
    failedTransfers: count("transfer_failed"),
    humanRequests,
    afterHoursClosures: count("after_hours_closed"),
    offersDeclined: count("offer_declined"),
    escalationRate: callsN ? Number((humanRequests / callsN).toFixed(3)) : 0,
    deflectionRate: callsN ? Number((deflected / callsN).toFixed(3)) : 0,
    perTopicCounts: topics,
  };
}
