export class MemoryAudit {
  name = "memory";
  constructor() { this.calls = new Map(); this.events = []; this.transcripts = []; }
  startCall(call) { this.calls.set(call.id, { ...call }); }
  updateCall(id, patch) { const c = this.calls.get(id); if (c) this.calls.set(id, { ...c, ...patch }); }
  recordEvent(callId, source, kind, detail = null) { this.events.push({ callId, source, kind, detail: detail == null ? null : String(detail), created_at: new Date().toISOString() }); }
  recordTranscript(callId, role, text) { this.transcripts.push({ callId, role, text, created_at: new Date().toISOString() }); }
  eventsFor(callId) { return this.events.filter((e) => e.callId === callId); }
}
