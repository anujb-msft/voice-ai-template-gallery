/**
 * Audit sink.
 *
 * The reminder flow only ever talks to this interface, which is what lets the
 * whole policy run, and be tested, with no database and no cloud credentials.
 * `src/db.mjs` provides the SQLite implementation the server uses.
 *
 * Timestamps come from the flow's injected clock, so the audit trail reads in
 * demo time on stage. Utterance text is passed separately from events on
 * purpose: transcripts are off by default, events never are.
 */
export class MemoryAudit {
  name = "memory";

  constructor() {
    this.calls = new Map();
    this.events = [];
    this.transcripts = [];
  }

  startCall(call) {
    this.calls.set(call.id, { ...call, simulated: Boolean(call.simulated) });
  }

  updateCall(id, patch) {
    const existing = this.calls.get(id);
    if (existing) this.calls.set(id, { ...existing, ...patch });
  }

  recordEvent(callId, source, kind, detail = null, at = new Date().toISOString()) {
    this.events.push({ callId, source, kind, detail: detail == null ? null : String(detail), at });
  }

  recordTranscript(callId, role, text, at = new Date().toISOString()) {
    this.transcripts.push({ callId, role, text, at });
  }

  eventsFor(callId) {
    return this.events.filter((e) => e.callId === callId).map(({ source, kind, detail, at }) => ({ source, kind, detail, at }));
  }

  /** Forget simulated calls and everything recorded about them. Calls from a real phone stay. */
  reset() {
    const gone = new Set([...this.calls.values()].filter((c) => c.simulated).map((c) => c.id));
    for (const id of gone) this.calls.delete(id);
    this.events = this.events.filter((e) => !gone.has(e.callId));
    this.transcripts = this.transcripts.filter((t) => !gone.has(t.callId));
    return gone.size;
  }

  stats() {
    return summarizeCalls([...this.calls.values()]);
  }
}

const VOICEMAIL = new Set(["voicemail_left", "voicemail_hangup"]);
const CALLBACK_ONLY = new Set(["wrong_party", "unauthorized_proxy", "unverified"]);
const NOT_ANSWERED = new Set(["busy", "no_answer", "bad_number", "not_placed", "create_call_failed"]);

/**
 * The presenter console's metrics strip, from call rows ({ outcome, verified }).
 * "Reached" counts only verified right-party contacts: a call someone else
 * answered is not a reached patient. A transfer ACS accepted and then reported
 * failed ends as transfer_failed, so it is never counted as handed off.
 */
export function summarizeCalls(rows) {
  const byOutcome = {};
  for (const row of rows) {
    const key = row.outcome ?? "in_progress";
    byOutcome[key] = (byOutcome[key] ?? 0) + 1;
  }
  const count = (...outcomes) => outcomes.reduce((n, o) => n + (byOutcome[o] ?? 0), 0);
  const of = (set) => rows.filter((r) => set.has(r.outcome)).length;
  return {
    calls: rows.length,
    placed: rows.filter((r) => r.outcome !== "not_placed").length,
    answered: rows.filter((r) => r.outcome !== "not_placed" && !NOT_ANSWERED.has(r.outcome) && !VOICEMAIL.has(r.outcome)).length,
    reached: rows.filter((r) => r.verified === true || r.verified === 1).length,
    confirmed: count("confirmed"),
    cancelled: count("cancelled"),
    reschedulesHandedOff: count("reschedule_handoff", "reschedule_callback"),
    privacySafeVoicemails: of(VOICEMAIL),
    callbackOnly: of(CALLBACK_ONLY),
    notPlaced: count("not_placed"),
    optedOut: count("opted_out"),
    nurseTransfers: count("nurse_transfer"),
    transfersFailed: count("transfer_failed"),
    retriesScheduled: count("busy", "no_answer"),
    byOutcome,
  };
}
