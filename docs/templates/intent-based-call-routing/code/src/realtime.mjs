import { WebSocketServer } from "ws";

/**
 * Realtime fan-out to the presenter console.
 *
 * A plain WebSocket hub inside this process, addressed by call id, so the whole
 * template runs with no Azure SignalR dependency and no second service to
 * provision. For a production console you would swap this for Azure SignalR
 * Service in serverless mode; the `send(userId, target, payload)` shape is the
 * same, which is the only thing the flow depends on.
 */
export class LocalWebSocketHub {
  transport = "local-ws";

  /** @type {Map<string, Set<import("ws").WebSocket>>} */
  #clients = new Map();
  /** Every message, so a console opened mid-call is not blank. */
  #backlog = new Map();

  attach(httpServer, path = "/ws/hub") {
    const wss = new WebSocketServer({ server: httpServer, path });

    wss.on("connection", (socket, req) => {
      const userId = new URL(req.url, "http://localhost").searchParams.get("user") ?? "*";
      if (!this.#clients.has(userId)) this.#clients.set(userId, new Set());
      this.#clients.get(userId).add(socket);

      for (const msg of this.#backlog.get(userId) ?? []) socket.send(msg);

      socket.on("close", () => {
        const set = this.#clients.get(userId);
        set?.delete(socket);
        if (set && set.size === 0) this.#clients.delete(userId);
      });
      socket.on("error", () => socket.close());
    });

    return wss;
  }

  negotiate(userId) {
    return { url: `/ws/hub?user=${encodeURIComponent(userId)}`, transport: this.transport };
  }

  /**
   * Sent to the console watching this specific call and to any console watching
   * everything, which is what the demo surface subscribes to.
   */
  send(userId, target, payload) {
    const msg = JSON.stringify({ target, arguments: [{ callId: userId, ...payload }] });

    const backlog = this.#backlog.get(userId) ?? [];
    backlog.push(msg);
    if (backlog.length > 200) backlog.shift();
    this.#backlog.set(userId, backlog);

    for (const key of [userId, "*"]) {
      for (const socket of this.#clients.get(key) ?? []) {
        if (socket.readyState === socket.OPEN) socket.send(msg);
      }
    }
  }

  forget(userId) {
    this.#backlog.delete(userId);
  }
}

export function createHub() {
  return new LocalWebSocketHub();
}
