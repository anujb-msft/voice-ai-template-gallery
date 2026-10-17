import { WebSocketServer } from "ws";
import { VoiceLiveSession, buildInstructions } from "./voice-live.mjs";
import { hangUp } from "./acs.mjs";
import { config } from "../config.mjs";
import { STATES } from "../flow.mjs";

const log = (...a) => console.log(new Date().toISOString(), "[bridge]", ...a);

/** Tool results go back to the model, so the handoff context and snapshots stay on the server. */
const SERVER_ONLY = new Set(["context", "handoff", "snapshot", "voipHeaders", "sms", "to"]);

/** Once a transfer has started, the call is on its way to a person and is not the agent's to end. */
const HANDED_OFF = new Set([STATES.TRANSFERRING, STATES.TRANSFERRED]);

/**
 * Bridges one ACS call to one Voice Live session and wires both into the 311
 * flow.
 *
 *   PSTN caller
 *      ⇅  ACS bidirectional media streaming (WebSocket, PCM16 24 kHz mono)
 *   this process
 *      ⇅  Voice Live (WebSocket, PCM16 24 kHz mono — forwarded verbatim)
 *   gpt-realtime
 *
 * The bridge translates tool calls into flow methods and nothing else. Every
 * line the caller hears is written by the flow; the model is told to say it
 * word for word.
 */
class CallBridge {
  constructor({ callId, acsSocket, flow }) {
    this.callId = callId;
    this.acs = acsSocket;
    this.flow = flow;
    this.inTool = 0;
    this.toolSay = [];
    this.stopped = false;
  }

  async start() {
    this.voice = new VoiceLiveSession({
      instructions: buildInstructions(this.flow, config.locale),
      onAgentAudio: (base64Pcm) => this.#toCaller(base64Pcm),
      onEvent: (e) => this.#onVoiceEvent(e),
      onToolCall: (name, args) => this.#onToolCall(name, args),
    });
    await this.voice.connect();

    this.flow.registerAgent(this.callId, {
      instruct: (prefix, text) => this.#instruct(prefix, text),
      setLocale: (locale, voice) => this.voice.setLocale(locale, buildInstructions(this.flow, locale), voice),
      finished: (state, outcome, lastSpoken) => this.#finished(state, lastSpoken),
    });

    // The flow speaks the opening; the bridge never greets on its own.
    this.flow.answered(this.callId);
  }

  /**
   * A line said while a tool call is in flight rides back on the tool result
   * (`say`), so the model hears it with the result instead of racing it.
   */
  #instruct(prefix, text) {
    const line = `${prefix}\n${text}`;
    if (this.inTool > 0) {
      this.toolSay.push(text);
      this.voice.instruct(line, { respond: false });
      return;
    }
    this.voice.instruct(line);
  }

  /** On a closing state, hang up once the last line has had time to play. */
  #finished(state, lastSpoken) {
    if (state !== "ended") return;
    const ms = Math.min(30000, 4000 + String(lastSpoken ?? "").length * 70);
    setTimeout(() => this.stop(), ms).unref?.();
  }

  #toCaller(base64Pcm) {
    if (this.acs.readyState !== this.acs.OPEN) return;
    this.acs.send(JSON.stringify({ kind: "AudioData", audioData: { data: base64Pcm } }));
  }

  #stopCallerPlayback() {
    if (this.acs.readyState === this.acs.OPEN) this.acs.send(JSON.stringify({ kind: "StopAudio", stopAudio: {} }));
  }

  #onVoiceEvent(e) {
    switch (e.kind) {
      case "user_speech_started":
        // Barge-in: flush whatever ACS still has buffered so the agent stops instantly.
        this.#stopCallerPlayback();
        this.voice.cancelResponse();
        break;
      case "user_transcript": {
        // The emergency rule and the language switch run on every caller turn.
        const result = this.flow.observeCaller(this.callId, e.text);
        if (result?.category) this.voice.cancelResponse();
        break;
      }
      case "error":
        log("voice error", JSON.stringify(e.error));
        break;
    }
  }

  async #onToolCall(name, args) {
    this.inTool += 1;
    let result;
    try {
      result = await this.#invokeTool(name, args ?? {});
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    // The flow batches speech in a microtask; let it land before reading it.
    await new Promise((resolve) => setImmediate(resolve));
    this.inTool -= 1;
    const say = this.inTool === 0 ? this.toolSay.splice(0) : [];
    const clean = Object.fromEntries(Object.entries(result ?? {}).filter(([k]) => !SERVER_ONLY.has(k)));
    return say.length ? { ...clean, say: say.join(" ") } : clean;
  }

  async #invokeTool(name, args) {
    const id = this.callId;
    switch (name) {
      case "search_faq":
        return this.flow.searchFaq(id, args.query);
      case "start_request":
        return this.flow.startRequest(id, args.type);
      case "resolve_location":
        return this.flow.resolveLocation(id, args.utterance, { readBack: true });
      case "confirm_location":
        return this.flow.confirmLocation(id, args.yes !== false);
      case "set_field":
        return this.flow.setField(id, args.name, args.value);
      case "submit_request":
        return this.flow.submitRequest(id);
      case "set_contact":
        if (args.wantsUpdates) return this.flow.acceptUpdates(id);
        this.flow.setContact(id, { wantsUpdates: false });
        return this.flow.anythingElse(id);
      case "get_case_status":
        return this.flow.getCaseStatus(id, args.caseNumber);
      case "bulk_pickup":
        return this.flow.bulkPickup(id, args.items ?? []);
      case "confirm_bulk_pickup":
        return this.flow.confirmBulkPickup(id, args.location);
      case "send_form_link":
        return this.flow.sendFormLink(id, args.serviceId);
      case "log_complaint":
        return this.flow.complaint(id, args.text);
      case "transfer": {
        const call = this.flow.get(id);
        const reason = args.reason ?? (call?.complaint ? "complaint" : "caller_requested");
        return this.flow.transfer(id, { reason, departmentId: args.department ?? "311-live" });
      }
      case "repeat_last":
        return this.flow.repeatLast(id);
      case "end_call":
        // A goodbye now would close the call before the transfer the caller was promised.
        if (HANDED_OFF.has(this.flow.get(id)?.state)) return { ok: false, reason: "transfer_in_progress" };
        return this.flow.goodbye(id);
      default:
        return { ok: false, error: `Unknown tool ${name}` };
    }
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
    if (this.stopped) return;
    this.stopped = true;
    this.flow.unregisterAgent(this.callId);
    this.voice?.close();
    try {
      this.acs.close();
    } catch {}
    // A call handed to a person belongs to Teams now, so it is not ours to hang up.
    const call = this.flow.get(this.callId);
    if (call && !HANDED_OFF.has(call.state)) hangUp(call.callConnectionId);
  }
}

/** @type {Map<string, CallBridge>} */
export const activeBridges = new Map();

/**
 * Returns the server so the caller can route upgrades to it. Deliberately
 * `noServer`: two WebSocketServers sharing one HTTP server both receive every
 * upgrade event, and `ws` aborts the handshake for any path a given server does
 * not own, so the server routes upgrades by path instead.
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
