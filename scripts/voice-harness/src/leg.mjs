import { EventEmitter } from "node:events";
import { FRAME_MS, Segmenter, durationMs, rms, silence, toFrames } from "./audio.mjs";
import { identifyLanguage, synthesize, transcribe } from "./speech.mjs";
import { deferred, dominantLocale, languageOf, sleep, withTimeout } from "./util.mjs";

const TONES = {
  0: "zero",
  1: "one",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine",
  "*": "asterisk",
  "#": "pound",
};

/** Shorter bursts are clicks or line noise, not speech. */
const MIN_UTTERANCE_MS = 250;
/** Audio is sent slightly ahead of real time so playback never starves. */
const LEAD_FRAMES = 10;

/**
 * One harness call: the phone the "caller" is holding. It speaks synthesised
 * lines into the call over bidirectional media streaming, listens to the far
 * end, cuts what it hears into utterances, and transcribes them.
 */
export class Leg extends EventEmitter {
  constructor({ id, client, direction, remote, log = () => {} }) {
    super();
    this.setMaxListeners(50);
    Object.assign(this, { id, client, direction, remote, log });
    this.t0 = Date.now();
    /** ms from dialing or answering until media reached the harness. */
    this.mediaAt = null;
    this.callConnectionId = null;
    this.connected = deferred();
    this.disconnected = deferred();
    this.media = deferred();
    this.ended = false;
    this.socket = null;
    this.ears = new Segmenter();
    this.utterances = [];
    this.cursor = 0;
    this.current = null;
    this.speaking = false;
    this.muteUntil = 0;
    this.lastFrameAt = 0;
    this.lastLoudAt = 0;
    /** Last far-end sound, heard even while the harness talks: times how fast the agent yields to a barge-in. */
    this.farLoudAt = 0;
    this.sayStartedAt = 0;
    this.timeline = [];
    /** What the agent has said since the caller last spoke or pressed a key (at `replyFrom`), one entry per turn. */
    this.reply = [];
    this.replyFrom = -Infinity;
    this.audio = { frames: 0, silentFrames: 0, loudFrames: 0, peakRms: 0 };
    this.ops = 0;
    this.pending = new Map();
    this.identifyFailed = false;
  }

  get elapsed() {
    return Date.now() - this.t0;
  }

  note(entry) {
    this.timeline.push({ at: this.elapsed, ...entry });
  }

  /** The caller just spoke or pressed a key: what the agent says from now on is its reply. */
  #awaitReply() {
    this.reply = [];
    this.replyFrom = this.elapsed;
  }

  connection() {
    if (!this.callConnectionId) throw new Error("the call has no connection id yet");
    return this.client.getCallConnection(this.callConnectionId);
  }

  /** Call Automation callbacks for this leg (CloudEvents). */
  onCallback(event) {
    const type = String(event.type ?? "").split(".").pop();
    const data = event.data ?? {};
    const reason = data.resultInformation?.message;
    this.note({ who: "acs", event: type, ...(reason && !/^(success|ok)|completed successfully/i.test(reason) ? { detail: reason } : {}) });
    switch (type) {
      case "CallConnected":
        this.callConnectionId ??= data.callConnectionId;
        this.connected.resolve();
        break;
      case "CreateCallFailed":
      case "AnswerFailed":
        this.connected.reject(new Error(`${type}: ${reason ?? "no detail"}`));
        this.#end();
        break;
      case "CallDisconnected":
        this.connected.reject(new Error("the call ended before it connected"));
        this.#end();
        break;
      case "SendDtmfTonesCompleted":
        this.pending.get(data.operationContext)?.resolve();
        break;
      case "SendDtmfTonesFailed":
        this.pending.get(data.operationContext)?.reject(new Error(reason ?? "DTMF failed"));
        break;
      default:
        break;
    }
    this.emit("callback", type, data);
    this.emit("change");
  }

  #end() {
    if (this.ended) return;
    this.ended = true;
    this.#close(this.ears.flush());
    clearInterval(this.gapTimer);
    this.disconnected.resolve();
    for (const p of this.pending.values()) p.reject(new Error("the call ended"));
    this.emit("change");
  }

  attachMedia(socket) {
    this.socket = socket;
    this.mediaAt ??= this.elapsed;
    this.note({ who: "acs", event: "MediaConnected" });
    this.media.resolve();
    socket.on("message", (raw) => this.#onMedia(raw));
    socket.on("close", () => {
      this.note({ who: "acs", event: "MediaClosed" });
      this.#close(this.ears.flush());
      clearInterval(this.gapTimer);
      this.emit("change");
    });
    socket.on("error", () => socket.close());
    this.gapTimer = setInterval(() => this.#fillGaps(), 100);
  }

  #onMedia(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.kind === "AudioMetadata") {
      this.metadata = msg.audioMetadata;
      return;
    }
    if (msg.kind !== "AudioData") return;
    const data = msg.audioData ?? {};
    if (data.silent || !data.data) this.#feed(silence(FRAME_MS), true);
    else this.#feed(Buffer.from(data.data, "base64"), false);
  }

  /** If media pauses mid-utterance, count the gap as silence so the utterance still ends. */
  #fillGaps() {
    if (!this.lastFrameAt || this.ended) return;
    const gap = Date.now() - this.lastFrameAt;
    if (gap < 400 || !this.ears.active) return;
    for (let i = 0; i < Math.floor(gap / FRAME_MS); i++) this.#feed(silence(FRAME_MS), true);
  }

  #feed(frame, silent) {
    const now = Date.now();
    this.lastFrameAt = now;
    this.audio.frames++;
    if (silent) this.audio.silentFrames++;
    else {
      const level = rms(frame);
      this.audio.peakRms = Math.max(this.audio.peakRms, Math.round(level));
      if (level >= this.ears.threshold) {
        this.audio.loudFrames++;
        this.farLoudAt = now;
      }
    }
    // While the harness talks, it is not listening; nothing it says is ever
    // mistaken for the agent, even if the far end echoes it back.
    const muted = this.speaking || now < this.muteUntil;
    const ev = this.ears.push(frame, { silent: silent || muted });
    if (this.ears.lastLoud) this.lastLoudAt = now;
    if (ev?.type === "start") {
      this.current = { startedAt: now - (this.ears.clock - ev.at) };
      this.emit("change");
    } else if (ev?.type === "end") this.#close(ev);
  }

  #close(ev) {
    if (!ev) return;
    this.current = null;
    const ms = durationMs(ev.pcm);
    if (ms >= MIN_UTTERANCE_MS) {
      const u = { at: this.elapsed - Math.round(ms), ms: Math.round(ms), endedAt: Date.now(), text: null, locale: null };
      const spoken = identifyLanguage(ev.pcm).catch((e) => {
        if (!this.identifyFailed) this.log(`language identification failed: ${e.message}`);
        this.identifyFailed = true;
        return null;
      });
      u.done = Promise.all([transcribe(ev.pcm), spoken]).then(
        ([english, heard]) => {
          u.locale = heard?.locale ?? null;
          // The English model drops or mangles other languages, so when the
          // agent was not speaking English keep what the multilingual model heard.
          u.text = u.locale && languageOf(u.locale) !== "en" && heard.text ? heard.text : english;
        },
        (e) => {
          u.text = "";
          u.error = e.message;
          this.log(`transcription failed: ${e.message}`);
        },
      );
      this.utterances.push(u);
    }
    this.emit("change");
  }

  #changed(ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.off("change", done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(20, ms));
      this.on("change", done);
    });
  }

  /**
   * The agent's next turn: everything it says until it has been quiet for
   * `gapMs` after its last utterance closed. Noise that transcribes to nothing
   * does not count as a turn. Returns "" if the agent says nothing in time.
   */
  async hear({ timeoutMs = 20000, gapMs = 900, maxTurnMs = 60000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (!(this.utterances.length > this.cursor || this.current)) {
        if (this.ended || Date.now() >= deadline) return "";
        await this.#changed(Math.min(500, deadline - Date.now()));
      }
      const turnEnds = Date.now() + maxTurnMs;
      for (;;) {
        const last = this.utterances.at(-1);
        const quietFor = this.current || !last ? 0 : Date.now() - last.endedAt;
        const closed = !this.current && this.utterances.length > this.cursor;
        if ((closed && quietFor >= gapMs) || this.ended || Date.now() >= turnEnds) break;
        await this.#changed(closed ? gapMs - quietFor : 250);
      }
      const batch = this.utterances.slice(this.cursor);
      this.cursor = this.utterances.length;
      await Promise.all(batch.map((u) => u.done));
      const text = batch
        .map((u) => u.text)
        .filter(Boolean)
        .join(" ")
        .trim();
      if (text) {
        const locale = dominantLocale(batch.map((u) => ({ locale: u.locale, text: u.text, durationMilliseconds: u.ms })));
        this.note({ who: "agent", text, ...(locale ? { locale } : {}) });
        // A turn can open with words the agent began before the caller's last
        // line or key press; those are not part of the reply to it.
        const reply = batch
          .filter((u) => u.at >= this.replyFrom)
          .map((u) => u.text)
          .filter(Boolean)
          .join(" ")
          .trim();
        if (reply) this.reply.push(reply);
        return text;
      }
      if (this.ended || Date.now() >= deadline) return "";
    }
  }

  /** Waits until the far end has not made a sound for `ms`. */
  async quiet(ms = 700, maxWaitMs = 12000) {
    const until = Date.now() + maxWaitMs;
    while (Date.now() < until && !this.ended) {
      const quietFor = Date.now() - this.lastLoudAt;
      if (!this.current && quietFor >= ms) return true;
      await this.#changed(Math.min(ms - quietFor, 200));
    }
    return false;
  }

  /** Waits until the far end has been talking for `minMs`, so a barge-in lands mid-sentence. */
  async talking({ minMs = 800, timeoutMs = 20000 } = {}) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until && !this.ended) {
      const since = this.current?.startedAt;
      if (since && Date.now() - since >= minMs) return true;
      await this.#changed(since ? since + minMs - Date.now() : Math.min(250, until - Date.now()));
    }
    return false;
  }

  /** Speaks a line into the call as the caller, at real-time pace. `waitQuietMs: 0` barges in over the agent. */
  async say(text, { waitQuietMs = 700, rate } = {}) {
    if (this.ended) throw new Error(`cannot say "${text}": the call has ended`);
    const [pcm] = await Promise.all([synthesize(text, { rate }), this.media.promise]);
    if (waitQuietMs > 0) await this.quiet(waitQuietMs);
    if (this.ended) throw new Error(`cannot say "${text}": the call has ended`);

    this.note({ who: "caller", text });
    this.#awaitReply();
    const frames = toFrames(Buffer.concat([pcm, silence(120)]));
    this.speaking = true;
    const start = Date.now();
    this.sayStartedAt = start;
    try {
      for (let i = 0; i < frames.length; i++) {
        if (this.ended || this.socket?.readyState !== 1) break;
        const wait = start + (i - LEAD_FRAMES) * FRAME_MS - Date.now();
        if (wait > 2) await sleep(wait);
        this.socket.send(JSON.stringify({ kind: "AudioData", audioData: { data: frames[i].toString("base64") } }));
      }
      await sleep(Math.max(0, start + frames.length * FRAME_MS - Date.now()));
    } finally {
      this.speaking = false;
      this.muteUntil = Date.now() + 150;
    }
  }

  /** Presses keys on the caller's keypad. Resolves once ACS confirms the tones were sent. */
  async dtmf(digits, { waitQuietMs = 400, timeoutMs = 15000 } = {}) {
    const tones = [...String(digits)].map((d) => TONES[d]);
    if (!tones.length || tones.some((t) => !t)) throw new Error(`unsupported DTMF input "${digits}"`);
    await this.quiet(waitQuietMs);
    const operationContext = `dtmf-${this.id}-${++this.ops}`;
    const sent = deferred();
    this.pending.set(operationContext, sent);
    this.note({ who: "caller", dtmf: String(digits) });
    this.#awaitReply();
    try {
      await this.connection()
        .getCallMedia()
        .sendDtmfTones(tones, { phoneNumber: this.remote }, { operationContext });
      await withTimeout(sent.promise, timeoutMs, `ACS did not confirm DTMF "${digits}"`);
    } finally {
      this.pending.delete(operationContext);
    }
  }

  async hangup() {
    if (this.ended || !this.callConnectionId) return;
    this.note({ who: "caller", event: "hang up" });
    try {
      await this.connection().hangUp(true);
    } catch (e) {
      this.log(`hang up: ${e.message}`);
    }
    await withTimeout(this.disconnected.promise, 10000).catch(() => {});
  }

  /** Everything the agent has said so far (closed turns only). */
  transcript() {
    return this.timeline
      .filter((e) => e.who === "agent")
      .map((e) => e.text)
      .join(" \n");
  }
}
