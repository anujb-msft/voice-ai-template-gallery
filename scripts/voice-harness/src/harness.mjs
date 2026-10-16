import http from "node:http";
import { CallAutomationClient } from "@azure/communication-call-automation";
import { WebSocketServer } from "ws";
import { getCredential } from "./azure.mjs";
import { config } from "./config.mjs";
import { Leg } from "./leg.mjs";
import { deferred, redactPhones, sleep, withTimeout } from "./util.mjs";

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

const phoneOf = (identifier) => identifier?.phoneNumber?.value ?? identifier?.rawId?.replace(/^4:/, "") ?? null;

/**
 * The harness's own phone line: a small web server that receives Event Grid
 * and Call Automation callbacks for HARNESS_NUMBER, plus the media WebSocket
 * for every call it is on. It places calls (`dial`) and answers them
 * (`expectIncoming`); a call nobody is expecting is rejected.
 */
export class Harness {
  constructor({ log = (m) => console.log(m) } = {}) {
    this.log = log;
    this.client = new CallAutomationClient(config.acsEndpoint, getCredential());
    this.legs = new Map();
    this.waiters = [];
    this.unclaimed = [];
    this.seen = new Set();
    this.seq = 0;
  }

  async start() {
    this.server = http.createServer((req, res) =>
      this.#route(req, res).catch((e) => {
        this.log(`harness: ${req.method} ${req.url} failed: ${e.message}`);
        if (!res.headersSent) send(res, 500, { error: e.message });
      }),
    );
    const media = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url, "http://localhost");
      const leg = this.legs.get(url.searchParams.get("leg") ?? "");
      if (url.pathname !== "/ws/media" || !leg) return socket.destroy();
      media.handleUpgrade(req, socket, head, (ws) => leg.attachMedia(ws));
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(config.harnessPort, "127.0.0.1", resolve);
    });
  }

  async stop() {
    await Promise.all([...this.legs.values()].map((l) => l.hangup().catch(() => {})));
    await new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server?.closeAllConnections?.();
  }

  async #route(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, service: "voice-harness", legs: this.legs.size });
    }
    if (req.method === "POST" && url.pathname === "/api/events") {
      const body = await readJson(req);
      const events = Array.isArray(body) ? body : [body];
      const validation = events.find((e) => e?.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent");
      if (validation) return send(res, 200, { validationResponse: validation.data.validationCode });
      send(res, 200);
      for (const e of events) {
        if (e?.eventType === "Microsoft.Communication.IncomingCall") await this.#incoming(e);
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/callbacks") {
      const body = await readJson(req);
      send(res, 200);
      const leg = this.legs.get(url.searchParams.get("leg") ?? "");
      for (const e of Array.isArray(body) ? body : [body]) leg?.onCallback(e);
      return;
    }
    send(res, 404, { error: "not found" });
  }

  #newLeg(direction, remote) {
    const id = `${Date.now().toString(36)}${(++this.seq).toString(36)}`;
    const leg = new Leg({ id, client: this.client, direction, remote, log: this.log });
    this.legs.set(id, leg);
    leg.disconnected.promise.then(() => setTimeout(() => this.legs.delete(id), 30000));
    return leg;
  }

  #callbackUrl(leg) {
    return `${config.harnessPublicUrl}/api/callbacks?leg=${leg.id}`;
  }

  #mediaOptions(leg) {
    return {
      transportUrl: `${config.harnessPublicUrl.replace(/^http/, "ws")}/ws/media?leg=${leg.id}`,
      transportType: "websocket",
      contentType: "audio",
      audioChannelType: "mixed",
      startMediaStreaming: true,
      enableBidirectional: true,
      audioFormat: "pcm24KMono",
    };
  }

  /** Places a call from HARNESS_NUMBER and waits until it is answered with media flowing. */
  async dial(target = config.templateNumber, { timeoutMs = 45000 } = {}) {
    const leg = this.#newLeg("outbound", target);
    this.log(`dialing ${redactPhones(target)}`);
    const result = await this.client.createCall(
      {
        targetParticipant: { phoneNumber: target },
        sourceCallIdNumber: { phoneNumber: config.harnessNumber },
      },
      this.#callbackUrl(leg),
      { mediaStreamingOptions: this.#mediaOptions(leg) },
    );
    leg.callConnectionId = result.callConnectionProperties?.callConnectionId ?? null;
    try {
      await this.#ready(leg, timeoutMs, "the call was not answered");
    } catch (e) {
      // Never leave a half-set-up call ringing or connected (and billing).
      await leg.hangup().catch(() => {});
      throw e;
    }
    return leg;
  }

  /**
   * Answers the next call to HARNESS_NUMBER, optionally only from `from`.
   * `ringMs` lets it ring first; `reject` declines it instead.
   */
  async expectIncoming({ from = null, timeoutMs = 90000, ringMs = 0, reject = false, signal = null } = {}) {
    if (signal?.aborted) throw new Error("the scenario ended before a call came in");
    const waiter = { from, ringMs, reject, call: deferred() };
    // A scenario that ends early must stop waiting, or this waiter would take the next scenario's call.
    const cancel = () => waiter.call.reject(new Error("the scenario ended before a call came in"));
    signal?.addEventListener("abort", cancel, { once: true });
    const queued = this.unclaimed.find((c) => !from || c.from === from);
    if (queued) {
      clearTimeout(queued.timer);
      this.unclaimed = this.unclaimed.filter((c) => c !== queued);
      this.#take(waiter, queued);
    } else this.waiters.push(waiter);
    let leg = null;
    try {
      leg = await withTimeout(waiter.call.promise, timeoutMs, "no call came in to the harness number");
      if (leg) await this.#ready(leg, 30000, "the answered call never connected");
      return leg;
    } catch (e) {
      waiter.abandoned = true;
      await leg?.hangup().catch(() => {});
      throw e;
    } finally {
      signal?.removeEventListener("abort", cancel);
      this.waiters = this.waiters.filter((w) => w !== waiter);
    }
  }

  async #ready(leg, timeoutMs, message) {
    await withTimeout(leg.connected.promise, timeoutMs, message);
    await withTimeout(leg.media.promise, 15000, "media streaming never connected to the harness");
  }

  async #incoming(event) {
    const data = event.data ?? {};
    const key = event.id ?? data.correlationId;
    if (key && this.seen.has(key)) return;
    if (key) this.seen.add(key);
    // Event Grid retries failed deliveries; a call that rang while no harness was up is long gone.
    if (event.eventTime && Date.now() - Date.parse(event.eventTime) > 30000) return;
    const call = { from: phoneOf(data.from), context: data.incomingCallContext };
    const to = phoneOf(data.to);
    if (to && to !== config.harnessNumber) return;

    const waiter = this.waiters.find((w) => !w.from || w.from === call.from);
    if (waiter) {
      this.waiters = this.waiters.filter((w) => w !== waiter);
      return this.#take(waiter, call);
    }
    // A template can ring before the scenario starts waiting; hold the call briefly.
    this.unclaimed.push(call);
    call.timer = setTimeout(() => {
      this.unclaimed = this.unclaimed.filter((c) => c !== call);
      this.log(`harness: rejecting an unexpected call from ${redactPhones(call.from ?? "unknown")}`);
      this.client.rejectCall(call.context).catch(() => {});
    }, 10000);
  }

  async #take(waiter, call) {
    if (waiter.reject) {
      await this.client.rejectCall(call.context).catch(() => {});
      return waiter.call.resolve(null);
    }
    if (waiter.ringMs) await sleep(waiter.ringMs);
    if (waiter.abandoned) return void (await this.client.rejectCall(call.context).catch(() => {}));
    const leg = this.#newLeg("inbound", call.from);
    try {
      const result = await this.client.answerCall(call.context, this.#callbackUrl(leg), {
        mediaStreamingOptions: this.#mediaOptions(leg),
      });
      leg.callConnectionId = result.callConnectionProperties?.callConnectionId ?? null;
      // The scenario stopped waiting while this call was ringing: hang it up once it connects.
      if (waiter.abandoned) {
        withTimeout(leg.connected.promise, 30000)
          .then(() => leg.hangup())
          .catch(() => {});
        return;
      }
      waiter.call.resolve(leg);
    } catch (e) {
      waiter.call.reject(new Error(`answering failed: ${e.message}`));
    }
  }
}
