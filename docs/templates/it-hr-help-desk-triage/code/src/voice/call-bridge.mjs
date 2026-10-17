import { WebSocketServer } from "ws";
import { VoiceLiveSession, buildInstructions } from "./voice-live.mjs";
import { hangUp } from "./acs.mjs";
import { config } from "../config.mjs";
import { STATES, forModel } from "../flow.mjs";
import { settleClarification, handleCallbackOffer } from "../offline.mjs";

const log = (...a) => console.log(new Date().toISOString(), "[bridge]", ...a);

/** Only the sensitive-topic guard sends a call to confidential HR; resets have their own tool. */
const SERVER_ONLY_DESTINATIONS = new Set(["confidential-hr", "password-reset-agent"]);

/** Tool results go to the model, so they get the same redaction as anything it is asked to say. */
function forModelDeep(value) {
  if (typeof value === "string") return forModel(value);
  if (Array.isArray(value)) return value.map(forModelDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, forModelDeep(v)]));
  return value;
}

/**
 * Bridges one ACS call to one Voice Live session and wires both into the
 * triage flow.
 *
 *   Employee (Teams or phone)
 *      ⇅  ACS bidirectional media streaming (WebSocket, PCM16 24 kHz mono)
 *   this process
 *      ⇅  Voice Live (WebSocket, PCM16 24 kHz mono — forwarded verbatim)
 *   gpt-realtime
 *
 * The bridge translates tool calls into flow methods and nothing else. It
 * makes no policy decisions of its own, which is why the flow can be tested
 * without it.
 */
class CallBridge {
  constructor({ callId, acsSocket, flow }) {
    this.callId = callId;
    this.acs = acsSocket;
    this.flow = flow;
    /** Lines the flow speaks during a tool call travel back in that tool's result. */
    this.collecting = null;
    this.outbound = [];
    this.flushQueued = false;
  }

  async start() {
    this.voice = new VoiceLiveSession({
      instructions: buildInstructions(this.flow.routing, config.locale),
      onAgentAudio: (base64Pcm) => this.#toCaller(base64Pcm),
      onEvent: (e) => this.#onVoiceEvent(e),
      onToolCall: (name, args) => this.#onToolCall(name, args),
    });

    await this.voice.connect();

    this.flow.registerAgent(this.callId, { say: (text) => this.#say(text) });

    // The flow's greeting, with the automated-assistant disclosure and any
    // outage banner, is the agent's first line.
    this.flow.answered(this.callId);
  }

  /**
   * Every line that carries policy comes from the flow. During a tool call it
   * rides back in the result's `say`; anything else (the greeting, the
   * sensitive-topic path, a failed transfer) is spoken at once, cutting off
   * whatever the model had started. Lines from one turn are batched so the
   * second does not cancel the first.
   */
  #say(text) {
    const line = forModel(text).trim();
    if (!line) return;
    if (this.collecting) {
      this.collecting.push(line);
      return;
    }
    this.outbound.push(line);
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      const lines = this.outbound.splice(0);
      if (!lines.length || !this.voice || this.voice.closed) return;
      this.voice.cancelResponse();
      this.voice.nudge(`Say exactly this to the caller now, then wait for their reply: "${lines.join(" ")}"`);
    });
  }

  /** Both legs are PCM16 24 kHz mono, so the base64 payload is forwarded verbatim. */
  #toCaller(base64Pcm) {
    if (this.acs.readyState !== this.acs.OPEN) return;
    this.acs.send(JSON.stringify({ kind: "AudioData", audioData: { data: base64Pcm } }));
  }

  #stopCallerPlayback() {
    if (this.acs.readyState === this.acs.OPEN) {
      this.acs.send(JSON.stringify({ kind: "StopAudio", stopAudio: {} }));
    }
  }

  #onVoiceEvent(e) {
    switch (e.kind) {
      case "user_speech_started":
        // Barge-in: flush whatever ACS still has buffered so the agent stops instantly.
        this.#stopCallerPlayback();
        this.voice.cancelResponse();
        break;
      case "user_transcript":
        this.#onCallerTurn(e.text);
        break;
      case "agent_transcript":
        this.flow.pushTranscript(this.callId, "agent", e.text);
        break;
      case "error":
        log("voice error", JSON.stringify(e.error));
        break;
    }
  }

  /**
   * The flow hears every caller turn first, so the sensitive-topic guard runs
   * before the model can act on it. The after-hours callback question belongs
   * to the server alone.
   */
  #onCallerTurn(text) {
    const said = String(text ?? "").trim();
    const call = this.flow.get(this.callId);
    if (!said || !call) return;
    const result = this.flow.ingestUtterance(this.callId, said);
    if (result?.handled || result?.ok === false) return;
    if (call.state === STATES.AFTER_HOURS_OFFER) handleCallbackOffer(this.flow, this.callId, said);
  }

  async #onToolCall(name, args) {
    const call = this.flow.get(this.callId);
    // Once the guard has taken a call, the model has nothing left to do on it.
    if (!call || call.sensitive) return { ok: false, reason: "handled_by_server" };

    const said = [];
    this.collecting = said;
    let result;
    try {
      result = this.#invokeTool(name, args ?? {});
    } catch (e) {
      result = { ok: false, error: e.message };
    } finally {
      this.collecting = null;
    }

    this.flow.recordAgentAction(this.callId, {
      tool: name,
      ok: !result?.error && result?.ok !== false,
      detail: result?.error ?? result?.reason ?? null,
    });
    const safe = forModelDeep(result ?? {});
    return said.length ? { ...safe, say: said.join(" ") } : safe;
  }

  #invokeTool(name, args) {
    const { flow, callId: id } = this;
    switch (name) {
      case "classify": return this.#classify(args.utterance);
      case "answer_question": return flow.answerQuestion(id, args.topicId, { locale: args.locale ?? null });
      case "start_verification": return flow.startVerification(id, args.email);
      case "check_code": return flow.checkCode(id, args.code);
      case "get_personal_answer": return flow.getPersonalAnswer(id, args.kind);
      case "propose_ticket": return flow.proposeTicket(id, args);
      case "file_ticket": return flow.fileTicket(id, args.proposalId, args.confirmation);
      case "get_my_tickets": return args.ticketNumber ? flow.getTicketStatus(id, args.ticketNumber) : flow.getMyTickets(id);
      case "send_link": return flow.sendLink(id, args.target);
      case "handoff_password_reset": return flow.handoffPasswordReset(id, args.intent);
      case "route": return this.#route(args);
      case "end_call":
        setTimeout(() => this.stop(), 4000);
        flow.endCall(id, args.reason ?? "agent_ended");
        return { ending: true };
      default:
        return { error: `Unknown tool ${name}` };
    }
  }

  /** One clarifying question at most: the answer settles the topic, or the call goes to a person. */
  #classify(utterance) {
    const call = this.flow.get(this.callId);
    if (call?.state === STATES.CLARIFYING && call.pendingClarification) {
      const settled = settleClarification(this.flow, this.callId, utterance);
      if (!settled.clarified) return settled;
      const topic = this.flow.taxonomy.get(settled.topicId);
      return { ok: true, clarified: true, topicId: topic.id, label: topic.label, domain: topic.domain, action: topic.action?.type ?? null };
    }
    const c = this.flow.classifyFor(this.callId, utterance);
    if (c.needsClarification) return this.flow.askClarification(this.callId, utterance, c);
    return { ...c, action: this.flow.taxonomy.get(c.topicId)?.action?.type ?? null };
  }

  /** The model may ask for people; the server chooses which people. */
  #route({ destination, reason = null }) {
    const person = reason === "asked_for_person";
    const allowed = !person && this.flow.routing.get(destination) && !SERVER_ONLY_DESTINATIONS.has(destination);
    return this.flow.route(this.callId, allowed ? destination : this.flow.personQueue(this.callId), person ? "asked_for_person" : null);
  }

  handleAcsMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.kind === "AudioMetadata") {
      log("acs audio metadata", JSON.stringify(msg.audioMetadata));
      return;
    }
    if (msg.kind === "AudioData" && msg.audioData?.data && !msg.audioData.silent) {
      this.voice?.writeCallerAudio(msg.audioData.data);
    }
  }

  stop() {
    this.flow.unregisterAgent(this.callId);
    this.voice?.close();
    try {
      this.acs.close();
    } catch {}
    hangUp(this.flow.get(this.callId)?.callConnectionId);
  }
}

/** @type {Map<string, CallBridge>} */
export const activeBridges = new Map();

/**
 * Returns the server so the caller can route upgrades to it. Deliberately
 * `noServer`: two WebSocketServers sharing one HTTP server both receive every
 * upgrade event, and `ws` aborts the handshake — destroying the socket — for
 * any path a given server does not own, so whichever is registered first
 * kills the other's connections.
 */
export function attachMediaBridge(flow, path = "/ws/media") {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", async (socket, req) => {
    const callId = new URL(req.url, "http://localhost").searchParams.get("call");
    if (!callId || !flow.get(callId)) {
      log("rejecting media socket with unknown call", callId);
      return socket.close();
    }

    log("media socket connected for call", callId);
    const bridge = new CallBridge({ callId, acsSocket: socket, flow });
    activeBridges.set(callId, bridge);

    socket.on("message", (raw) => bridge.handleAcsMessage(raw));
    socket.on("close", () => {
      log("media socket closed for call", callId);
      bridge.voice?.close();
      flow.unregisterAgent(callId);
      activeBridges.delete(callId);
    });
    socket.on("error", (e) => log("media socket error", e.message));

    try {
      await bridge.start();
    } catch (e) {
      log("failed to start Voice Live session:", e.message);
      socket.close();
    }
  });

  log(`ACS media bridge listening on ${path}`);
  return wss;
}
