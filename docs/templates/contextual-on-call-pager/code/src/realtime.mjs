import { WebSocketServer } from "ws";

/**
 * Realtime fan-out to the presenter console: a plain WebSocket hub in this
 * process, addressed by call id, so the sample needs no Azure SignalR service.
 * Swap it for Azure SignalR Service in serverless mode for a production console;
 * `send(userId, target, payload)` is the only shape the flow depends on.
 */
export class LocalWebSocketHub {
  transport = "local-ws";
  #clients = new Map();
  #backlog = new Map();

  /** `noServer`: the HTTP server routes upgrades by path to exactly one WebSocketServer. */
  attach() {
    const wss = new WebSocketServer({ noServer: true });
    wss.on("connection", (socket, req) => {
      const userId = new URL(req.url, "http://localhost").searchParams.get("user") ?? "*";
      if (!this.#clients.has(userId)) this.#clients.set(userId, new Set());
      this.#clients.get(userId).add(socket);
      for (const msg of this.#backlog.get(userId) ?? []) socket.send(msg);
      socket.on("close", () => {
        const set = this.#clients.get(userId);
        set?.delete(socket);
        if (set?.size === 0) this.#clients.delete(userId);
      });
      socket.on("error", () => socket.close());
    });
    return wss;
  }

  negotiate(userId = "*") {
    return { url: `/ws/hub?user=${encodeURIComponent(userId)}`, transport: this.transport };
  }

  /** Sent to the console watching this call and to any console watching everything ("*"). */
  send(userId, target, payload) {
    const msg = JSON.stringify({ target, arguments: [{ callId: userId, ...payload }] });
    const backlog = this.#backlog.get(userId) ?? [];
    backlog.push(msg);
    if (backlog.length > 300) backlog.shift();
    this.#backlog.set(userId, backlog);
    for (const key of [userId, "*"]) {
      for (const socket of this.#clients.get(key) ?? []) if (socket.readyState === socket.OPEN) socket.send(msg);
    }
  }

  forget(userId) {
    this.#backlog.delete(userId);
  }
}

export function createHub() {
  return new LocalWebSocketHub();
}
