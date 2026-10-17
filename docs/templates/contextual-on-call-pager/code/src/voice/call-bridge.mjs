import { WebSocketServer } from "ws";
import { VoiceLiveSession, buildInstructions } from "./voice-live.mjs";
import { config } from "../config.mjs";
import { PAGE_TOOLS, INTAKE_TOOLS } from "../agent.mjs";
import { hangUp } from "./acs.mjs";

const log = (...a) => console.log(new Date().toISOString(), "[bridge]", ...a);

// A call the flow is done with (an accept, a decline, a voicemail, the tenant's
// status update) still has a last line to say. The bridge hangs up once it has
// played: time for the reply to start, plus about 65 ms a character of speech,
// and never more than 25 s after the goodbye began. A page handed to the tenant
// (DTMF 3) is the technician's call from then on, so it is never hung up here.
const REPLY_START_MS = 2500;
const MS_PER_CHAR = 65;
const MAX_GOODBYE_MS = 25_000;
const STATUS_CALL_MAX_MS = 40_000;
const END_CALL_GRACE_MS = 5_000;
const speakingMs = (text) => 1500 + String(text ?? "").length * MS_PER_CHAR;

/** The page call's keypad runs the same tools the model calls; the agent then says the result. */
const PAGE_KEYS = { 1: "acknowledge", 2: "decline", 3: "bridge_to_tenant", "*": "repeat_brief" };
/** Tools that would change a page this call has already closed. */
const CLOSING_TOOLS = new Set(["acknowledge", "decline", "bridge_to_tenant", "left_voicemail"]);

class CallBridge {
  constructor({ callId, leg, acsSocket, flow, callConnectionId = null }) {
    this.callId = callId;
    this.leg = leg;
    this.acs = acsSocket;
    this.flow = flow;
    // The call this socket belongs to. A retry pages the same incident on a new
    // call, so the flow's current call for a leg can move on while this one is up.
    this.callConnectionId = callConnectionId;
    this.contactName = null;
    this.voicemailPrompt = null;
    this.hangUpAt = null;
    this.hangUpTimer = null;
    this.goodbyeDeadline = null;
    this.muteTimer = null;
    this.closed = false; // this call accepted, declined or otherwise finished its page
    this.handedOff = false; // DTMF 3: the tenant is being added, and the call is the technician's now
    this.muted = false; // the agent neither hears nor speaks
    this.stopped = false;
  }

  async start() {
    this.callConnectionId ??= this.flow.connectionId(this.leg, this.callId);
    if (this.leg === "status") return this.#startStatus();
    if (this.leg === "page") return this.#startPage();
    return this.#startIntake();
  }

  async #startIntake() {
    await this.#connect(buildInstructions(this.flow.policy, config.locale, "intake"), INTAKE_TOOLS);
    if (this.stopped) return;
    this.flow.answered(this.callId, { speak: false });
    this.voice.nudge("The tenant is on the line. Say your opening line now.");
  }

  /** The call back to the tenant: one server-written update, no tools, then the call ends. */
  async #startStatus() {
    const update = this.flow.statusMessageFor(this.callId);
    const script = `Hi, this is the ${this.flow.policy.organization} maintenance line — I'm an automated assistant, calling about the problem you reported. ${update} Goodbye.`;
    await this.#connect(`${buildInstructions(this.flow.policy, config.locale, "status")}\n\nSay exactly: "${script}"`, []);
    if (this.stopped) return;
    this.voice.nudge("The tenant answered. Say the update now.");
    this.goodbyeDeadline = Date.now() + STATUS_CALL_MAX_MS;
    this.#hangUpAfter(script);
  }

  async #startPage() {
    const org = this.flow.policy.organization;
    const current = this.flow.connectionId("page", this.callId);
    const superseded = Boolean(this.callConnectionId && current && current !== this.callConnectionId);
    const answered = superseded ? null : this.flow.pageAnswered(this.callId, { speak: false });
    if (superseded || (answered?.ignored && answered.outcome !== "answered")) {
      // A late answer to a page the flow has moved past (accepted, declined or rung again):
      // say so and hang up, rather than brief someone on a page that isn't theirs any more.
      this.closed = true;
      const line = `This is the ${org} pager, an automated assistant. This page has already been handled, so there's nothing you need to do. Goodbye.`;
      await this.#connect(`${buildInstructions(this.flow.policy, config.locale, "page")}\n\nThis page is closed: don't read a brief or use a tool. Say exactly: "${line}"`, []);
      if (this.stopped) return;
      this.voice.nudge("The page call connected. Say your line now.");
      this.#hangUpAfter(line);
      return;
    }
    this.contactName = answered?.contactName ?? this.flow.pageSessions.get(this.callId)?.contact?.name ?? null;
    this.voicemailPrompt = this.flow.voicemailPromptFor(this.callId);
    // A person or a voicemail box answered: the greeting is safe for both, and the brief waits for a person.
    const greeting = answered?.greeting ?? `This is the ${org} pager, an automated assistant.`;
    const brief = answered?.brief ?? this.flow.pageBriefFor(this.callId);
    const instructions =
      `${buildInstructions(this.flow.policy, config.locale, "page")}\n\n` +
      `Your first sentence must be exactly: "${greeting}" Then wait for the person to speak. ` +
      `Only after a person speaks, read this server-generated brief exactly: "${brief}" ` +
      "If you hear a voicemail greeting or a beep instead, call left_voicemail and say only the speak line it returns — " +
      "a voicemail box must never hear the property, the unit, the problem or the tenant's words.";
    await this.#connect(instructions, PAGE_TOOLS);
    if (this.stopped) return;
    this.voice.nudge("The page call connected. Say your first sentence now.");
  }

  async #connect(instructions, tools) {
    this.voice = new VoiceLiveSession({
      instructions,
      tools,
      onAgentAudio: (pcm) => this.#toCaller(pcm),
      onEvent: (e) => this.#onVoiceEvent(e),
      onToolCall: (name, args) => this.#onToolCall(name, args),
    });
    await this.voice.connect();
    // The call ended while Voice Live was still connecting, so stop() had no socket to close.
    if (this.stopped) this.voice.ws?.close();
  }

  /** Hang up once `line` has had time to play. */
  #hangUpAfter(line) {
    this.goodbyeDeadline ??= Date.now() + MAX_GOODBYE_MS;
    this.#hangUpNoEarlierThan(Date.now() + REPLY_START_MS + speakingMs(line));
  }

  /** Only ever moves a hang-up later, and never past the goodbye deadline. */
  #hangUpNoEarlierThan(at) {
    if (this.stopped || this.handedOff) return;
    const when = Math.min(at, this.goodbyeDeadline ?? at);
    if (this.hangUpAt != null && when <= this.hangUpAt) return;
    this.hangUpAt = when;
    clearTimeout(this.hangUpTimer);
    this.hangUpTimer = setTimeout(() => this.stop(), Math.max(0, when - Date.now()));
  }

  /** This call finished its page: say `line`, then a goodbye, then hang up. */
  #close(line) {
    this.closed = true;
    this.#hangUpAfter(line ? `${line} Goodbye.` : "Goodbye.");
  }

  /** DTMF 3 worked: say the connecting line, then step out — the agent stops hearing and speaking, and the call stays up. */
  #handOff(line) {
    this.closed = true;
    this.handedOff = true;
    clearTimeout(this.hangUpTimer);
    this.hangUpTimer = null;
    this.hangUpAt = null;
    this.goodbyeDeadline = null;
    clearTimeout(this.muteTimer);
    this.muteTimer = setTimeout(() => this.#mute(), REPLY_START_MS + speakingMs(line));
  }

  #mute() {
    this.muted = true;
    this.voice?.cancelResponse();
    this.#stopCallerPlayback();
  }

  #toCaller(base64Pcm) {
    if (this.muted || this.stopped) return;
    if (this.acs.readyState === this.acs.OPEN) this.acs.send(JSON.stringify({ kind: "AudioData", audioData: { data: base64Pcm } }));
  }
  #stopCallerPlayback() {
    if (this.acs.readyState === this.acs.OPEN) this.acs.send(JSON.stringify({ kind: "StopAudio", stopAudio: {} }));
  }

  #onVoiceEvent(e) {
    if (e.kind === "user_speech_started") {
      if (this.muted) return;
      this.#stopCallerPlayback();
      this.voice.cancelResponse();
    } else if (e.kind === "user_transcript" || e.kind === "agent_transcript") {
      const role = e.kind === "agent_transcript" ? "agent" : "caller";
      this.flow.liveTranscript(this.callId, this.leg, role, e.text, { contactName: this.contactName });
      // A closing line that is still being spoken pushes the hang-up back.
      if (role === "agent" && this.hangUpAt != null) this.#hangUpNoEarlierThan(Date.now() + speakingMs(e.text));
    } else if (e.kind === "error") {
      log("voice error", this.leg, JSON.stringify(e.error));
    }
  }

  async #onToolCall(name, args) {
    let result;
    try {
      result = await this.#runTool(name, args ?? {});
    } catch (e) {
      log("tool failed", this.leg, name, e.message);
      result = { error: e.message };
    }
    // A line the agent still has to say keeps a pending hang-up from cutting it off.
    const line = result?.speak ?? result?.value ?? result?.brief;
    if (line && this.hangUpAt != null) this.#hangUpAfter(line);
    return result;
  }

  async #runTool(name, args) {
    if (this.leg === "intake") {
      switch (name) {
        case "identify_unit": return this.flow.identifyUnit(this.callId, args);
        case "record_issue": return this.flow.recordIssue(this.callId, args);
        case "classify_and_submit": return this.flow.submit(this.callId);
        case "end_call":
          // Time for a goodbye; a closing line that is still playing keeps its later hang-up.
          this.goodbyeDeadline ??= Date.now() + MAX_GOODBYE_MS;
          this.#hangUpNoEarlierThan(Date.now() + END_CALL_GRACE_MS);
          return { ending: true };
      }
      return { error: `Unknown tool ${name}` };
    }
    if (this.leg !== "page" || this.handedOff) return { error: `Unknown tool ${name}` };
    if (this.closed && CLOSING_TOOLS.has(name)) return { ok: false, reason: "page_closed", speak: "This page is already closed, so there's nothing more to do." };
    switch (name) {
      case "get_ticket_detail": return this.flow.getTicketDetail(this.callId, args.field);
      case "repeat_brief": return this.flow.repeatBrief(this.callId);
      case "acknowledge": {
        const result = await this.flow.acknowledge(this.callId);
        if (result.ok) this.#close(result.speak);
        return result;
      }
      case "decline": {
        const result = await this.flow.decline(this.callId, String(args.reason ?? "declined").slice(0, 80));
        this.#close(result.speak ?? "Understood.");
        return result;
      }
      case "bridge_to_tenant": {
        const result = await this.flow.bridgeToTenant(this.callId);
        if (result.bridged) this.#handOff(result.speak);
        else if (result.reason === "bridge_failed" || result.reason === "already_acknowledged") this.#close(result.speak);
        return result;
      }
      case "left_voicemail": {
        // The box hears the safe prompt only; the flow records it and schedules the next page.
        const speak = this.voicemailPrompt ?? this.flow.voicemailPromptFor(this.callId);
        this.flow.pageVoicemail(this.callId);
        this.closed = true;
        this.#hangUpAfter(speak);
        return { ok: true, speak };
      }
    }
    return { error: `Unknown tool ${name}` };
  }

  /** A keypad press on the page call (ContinuousDtmfRecognitionToneReceived). */
  async pressed(digit) {
    const name = PAGE_KEYS[digit];
    if (this.leg !== "page" || this.stopped || this.closed || !name) return { ok: false, ignored: true };
    const result = await this.#onToolCall(name, name === "decline" ? { reason: `pressed ${digit}` } : {});
    const line = result?.speak ?? result?.brief;
    if (line && !this.stopped && !this.muted) {
      this.#stopCallerPlayback();
      this.voice?.cancelResponse();
      this.voice?.nudge(`The technician pressed ${digit}. Say this now, exactly: "${line}"${this.closed && !this.handedOff ? " Then say goodbye." : ""}`);
    }
    return result;
  }

  /** AddParticipantSucceeded: the technician and the tenant are talking, so the agent leaves for good. */
  tenantJoined() {
    if (!this.handedOff || this.stopped) return;
    clearTimeout(this.muteTimer);
    this.#mute();
    this.voice?.close();
  }

  /** AddParticipantFailed: the tenant's line never joined. The agent comes back to say so, then the call ends. */
  tenantMissed(line) {
    if (!this.handedOff || this.stopped) return;
    clearTimeout(this.muteTimer);
    this.handedOff = false;
    this.muted = false;
    if (!this.voice || this.voice.closed) return this.stop();
    this.voice.cancelResponse();
    this.voice.nudge(`The tenant's line didn't join. Say this now, exactly: "${line}" Then say goodbye.`);
    this.#close(line);
  }

  handleAcsMessage(raw) {
    if (this.muted || this.stopped) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.kind === "AudioData" && msg.audioData?.data && !msg.audioData.silent) this.voice?.writeCallerAudio(msg.audioData.data);
  }

  stop({ hangUp: endCall = true } = {}) {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.hangUpTimer);
    clearTimeout(this.muteTimer);
    this.voice?.close();
    try {
      this.acs.close();
    } catch {}
    // A page handed to the tenant is the technician's call now, not ours to end.
    if (endCall && !this.handedOff) void hangUp(this.callConnectionId ?? this.flow.connectionId(this.leg, this.callId));
  }
}

/** Live bridges, by call connection id and by `leg:id` (the newest socket for that leg wins). */
const activeBridges = new Map();

/** The bridge on a call. With a call connection id, a bridge pinned to a different call doesn't count. */
export function bridgeFor(leg, id, callConnectionId = null) {
  const bridge = (callConnectionId && activeBridges.get(callConnectionId)) || activeBridges.get(`${leg}:${id}`);
  if (!bridge || bridge.leg !== leg || bridge.callId !== id) return null;
  if (callConnectionId && bridge.callConnectionId && bridge.callConnectionId !== callConnectionId) return null;
  return bridge;
}

const LEGS = new Set(["intake", "page", "status"]);
const firstHeader = (value) => (Array.isArray(value) ? value[0] : value) || null;

/**
 * The ACS media socket for every leg. `noServer`, because two `ws` servers on
 * one HTTP server each abort the upgrades whose path they don't own: the
 * server's single upgrade listener routes `path` here.
 */
export function attachMediaBridge(flow, path = "/ws/media") {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", async (socket, req) => {
    const url = new URL(req.url, "http://localhost");
    const callId = url.searchParams.get("call");
    const leg = url.searchParams.get("leg") ?? "intake";
    if (!callId || !LEGS.has(leg)) return socket.close();
    if (!config.voiceLive.endpoint) {
      log("VOICE_LIVE_ENDPOINT is not set; closing the media socket");
      return socket.close();
    }
    // ACS names the call on the media handshake, so a retry's socket is never mistaken for the call before it.
    const callConnectionId = firstHeader(req.headers?.["x-ms-call-connection-id"]);
    const bridge = new CallBridge({ callId, leg, acsSocket: socket, flow, callConnectionId });
    const keys = [callConnectionId, `${leg}:${callId}`].filter(Boolean);
    for (const key of keys) activeBridges.set(key, bridge);
    socket.on("message", (raw) => bridge.handleAcsMessage(raw));
    socket.on("close", () => {
      bridge.stop({ hangUp: false });
      for (const key of keys) if (activeBridges.get(key) === bridge) activeBridges.delete(key);
    });
    socket.on("error", (e) => log("socket error", e.message));
    try {
      await bridge.start();
    } catch (e) {
      log("failed to start Voice Live", leg, e.message);
      // A page or a status call with no agent is dead air: end it, so a page escalates instead of waiting.
      bridge.stop({ hangUp: leg !== "intake" });
    }
  });
  log(`ACS media bridge listening on ${path}`);
  return wss;
}
