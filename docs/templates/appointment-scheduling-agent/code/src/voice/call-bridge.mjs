import { WebSocketServer } from "ws";
import { VoiceLiveSession, buildInstructions } from "./voice-live.mjs";
import { hangUp } from "./acs.mjs";

export async function dispatchTool(flow, callId, name, args = {}) {
  switch (name) {
    case "verify_patient": {
      const fullName = args.fullName ?? [args.firstName, args.lastName].filter(Boolean).join(" ");
      return flow.verifyPatient(callId, { fullName, dob: args.dob, proxyName: args.proxyName ?? null });
    }
    case "redeem_handoff":
      return flow.redeemHandoff(callId, args);
    case "list_upcoming":
      return flow.listUpcoming(callId, args);
    case "note_reason":
      return flow.noteReason(callId, args.text ?? args.reason ?? "");
    case "choose_visit_type":
      return flow.chooseVisitType(callId, args.code ?? args.visitTypeCode ?? args.visitType, { selfPayAcknowledged: Boolean(args.selfPayAcknowledged) });
    case "search_slots":
      return flow.searchSlots(callId, toPreferences(args));
    case "hold_slot":
      return flow.holdSlot(callId, args.optionId ?? args.optionIndex ?? args.option);
    case "book":
      return flow.book(callId, { holdId: await ensureHold(flow, callId, args), confirmation: confirmationFrom(args), reason: args.reason ?? null, idempotencyKey: args.idempotencyKey ?? null });
    case "reschedule":
      return flow.reschedule(callId, { holdId: await ensureHold(flow, callId, args), appointmentHandle: args.appointmentHandle ?? args.appointmentId ?? null, confirmation: confirmationFrom(args), reason: args.reason ?? null, idempotencyKey: args.idempotencyKey ?? null });
    case "propose_cancel":
      return flow.proposeCancel(callId, { appointmentHandle: args.appointmentHandle ?? args.appointmentId ?? null, reasonCode: args.reasonCode ?? "patient_requested" });
    case "cancel":
      return flow.cancel(callId, { proposalId: args.proposalId, confirmation: confirmationFrom(args), idempotencyKey: args.idempotencyKey ?? null });
    case "add_waitlist":
      return flow.addWaitlist(callId, args.preferences ?? toPreferences(args));
    case "request_callback":
      return flow.requestCallback(callId, args.queue ?? "scheduling_team");
    case "transfer":
      return flow.transfer(callId, args.destination ?? "scheduling_team", args.reason ?? "caller_request");
    case "repeat_last":
      return flow.repeatLast(callId);
    case "end_call":
      return flow.endCall(callId, args.reason ?? "agent_ended");
    default:
      return { ok: false, error: `Unknown tool ${name}` };
  }
}

async function ensureHold(flow, callId, args) {
  if (args.holdId) return args.holdId;
  const held = flow.get?.(callId)?.held?.holdId;
  if (held) return held;
  if (!args.optionId) return null;
  const result = await flow.holdSlot(callId, args.optionId);
  return result?.holdId ?? null;
}

function confirmationFrom(args) {
  if (args.confirmation) return args.confirmation;
  if (args.confirmed === true) return "yes";
  if (args.confirmed === false) return "no";
  return "";
}

function toPreferences(args = {}) {
  const providerText = String(args.providerPreference ?? "").toLowerCase();
  return {
    providerId: args.providerId ?? (providerText.includes("patel") ? "prov-patel" : providerText.includes("nguyen") ? "prov-nguyen" : undefined),
    usualDoctor: Boolean(args.usualDoctor) || /usual|primary|my doctor/.test(providerText),
    location: args.location,
    timeOfDay: args.timeOfDay ?? (args.dayPart === "any" ? undefined : args.dayPart),
    date: args.date,
    department: args.department,
    more: args.more,
  };
}

class CallBridge {
  constructor({ callId, acsSocket, flow }) { this.callId = callId; this.acs = acsSocket; this.flow = flow; }
  async start() {
    const call = this.flow.get(this.callId);
    const patient = call?.patientId ? this.flow.schedule?.getPatient?.(call.patientId) : null;
    this.voice = new VoiceLiveSession({
      instructions: buildInstructions({ locale: patient?.preferredLanguage === "es" ? "es-US" : "en-US", handoff: call?.handoff }),
      onAgentAudio: (b) => this.#toCaller(b),
      onEvent: (e) => this.#onVoiceEvent(e),
      onToolCall: (name, args) => this.#onToolCall(name, args),
    });
    await this.voice.connect();
    this.flow.registerAgent(this.callId, { instruct: (text) => this.voice.instruct(text), nudge: (text, opts) => this.voice.nudge(text, opts) });
    this.flow.answered(this.callId);
  }
  #toCaller(base64Pcm) { if (this.acs.readyState === this.acs.OPEN) this.acs.send(JSON.stringify({ kind: "AudioData", audioData: { data: base64Pcm } })); }
  #stopCallerPlayback() { if (this.acs.readyState === this.acs.OPEN) this.acs.send(JSON.stringify({ kind: "StopAudio", stopAudio: {} })); }
  #onVoiceEvent(e) { if (e.kind === "user_speech_started") { this.#stopCallerPlayback(); this.voice.cancelResponse(); } else if (e.kind === "user_transcript") this.flow.pushTranscript(this.callId, "caller", e.text); else if (e.kind === "agent_transcript") this.flow.pushTranscript(this.callId, "agent", e.text); }
  async #onToolCall(name, args) { const r = await dispatchTool(this.flow, this.callId, name, args); this.flow.recordAgentAction(this.callId, { tool: name, ok: !r?.error && r?.ok !== false, detail: r?.reason ?? r?.error ?? null }); if (name === "end_call") setTimeout(() => this.stop(), 3500); return r; }
  handleAcsMessage(raw) { let msg; try { msg = JSON.parse(raw); } catch { return; } if (msg.kind === "AudioData" && msg.audioData?.data && !msg.audioData.silent) this.voice?.writeCallerAudio(msg.audioData.data); }
  stop() { this.flow.unregisterAgent(this.callId); this.voice?.close(); try { this.acs.close(); } catch {} hangUp(this.flow.get(this.callId)?.callConnectionId); }
}
export const activeBridges = new Map();
export function attachMediaBridge(flow, path = "/ws/media") {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", async (socket, req) => {
    const callId = new URL(req.url, "http://localhost").searchParams.get("call");
    if (!callId || !flow.get(callId)) return socket.close();
    const bridge = new CallBridge({ callId, acsSocket: socket, flow }); activeBridges.set(callId, bridge);
    socket.on("message", (raw) => bridge.handleAcsMessage(raw));
    socket.on("close", () => { bridge.voice?.close(); flow.unregisterAgent(callId); activeBridges.delete(callId); });
    try { await bridge.start(); } catch { socket.close(); }
  });
  return wss;
}
