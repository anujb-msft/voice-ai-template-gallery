import jwt from "jsonwebtoken";
import { WebSocketServer } from "ws";
import { config } from "./config.mjs";

/**
 * Realtime fan-out for reset sessions.
 *
 * Two interchangeable transports:
 *
 *  - `azure-signalr` — Azure SignalR Service in *Serverless* mode. The browser
 *    talks straight to the service; this server only mints tokens and pushes
 *    messages over the REST API. This is the shape you want in production.
 *
 *  - `local-ws`      — a plain WebSocket hub built into this process, used when
 *    AZURE_SIGNALR_CONNECTION_STRING is not set, so the template runs with no
 *    Azure SignalR dependency at all.
 *
 * Every message is addressed to a *user id*, which here is the reset session id.
 * That keeps each caller's wizard isolated without any group bookkeeping.
 */

function parseConnectionString(cs) {
  const parts = Object.fromEntries(
    cs
      .split(";")
      .filter(Boolean)
      .map((kv) => {
        const i = kv.indexOf("=");
        return [kv.slice(0, i).trim().toLowerCase(), kv.slice(i + 1).trim()];
      }),
  );
  const endpoint = (parts.endpoint ?? "").replace(/\/$/, "");
  const accessKey = parts.accesskey ?? "";
  if (!endpoint || !accessKey) throw new Error("Malformed AZURE_SIGNALR_CONNECTION_STRING");
  return { endpoint, accessKey };
}

class AzureSignalRHub {
  transport = "azure-signalr";

  constructor(connectionString, hub) {
    const { endpoint, accessKey } = parseConnectionString(connectionString);
    this.endpoint = endpoint;
    this.accessKey = accessKey;
    this.hub = hub;
  }

  #token(audience, userId, ttlSeconds = 3600) {
    const claims = userId ? { nameid: userId } : {};
    return jwt.sign(claims, this.accessKey, { audience, expiresIn: ttlSeconds, algorithm: "HS256" });
  }

  /** Returned to the browser; @microsoft/signalr connects directly to the service with it. */
  negotiate(userId) {
    const url = `${this.endpoint}/client/?hub=${encodeURIComponent(this.hub)}`;
    return { url, accessToken: this.#token(url, userId), transport: this.transport };
  }

  async send(userId, target, payload) {
    const url = `${this.endpoint}/api/v1/hubs/${encodeURIComponent(this.hub)}/users/${encodeURIComponent(userId)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#token(url)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ target, arguments: [payload] }),
    });
    // 202 Accepted is the success path; 404 means "no connected client", which is benign.
    if (!res.ok && res.status !== 404) {
      throw new Error(`SignalR send failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }
}

class LocalWebSocketHub {
  transport = "local-ws";
  /** @type {Map<string, Set<import("ws").WebSocket>>} */
  #clients = new Map();

  attach(httpServer, path = "/ws/hub") {
    const wss = new WebSocketServer({ server: httpServer, path });
    wss.on("connection", (socket, req) => {
      const userId = new URL(req.url, "http://localhost").searchParams.get("user");
      if (!userId) return socket.close();
      if (!this.#clients.has(userId)) this.#clients.set(userId, new Set());
      this.#clients.get(userId).add(socket);
      socket.on("close", () => {
        const set = this.#clients.get(userId);
        set?.delete(socket);
        if (set && set.size === 0) this.#clients.delete(userId);
      });
    });
  }

  negotiate(userId) {
    return { url: `/ws/hub?user=${encodeURIComponent(userId)}`, accessToken: null, transport: this.transport };
  }

  async send(userId, target, payload) {
    const msg = JSON.stringify({ target, arguments: [payload] });
    for (const socket of this.#clients.get(userId) ?? []) {
      if (socket.readyState === socket.OPEN) socket.send(msg);
    }
  }
}

export function createHub() {
  if (config.signalr.connectionString) {
    return new AzureSignalRHub(config.signalr.connectionString, config.signalr.hub);
  }
  return new LocalWebSocketHub();
}
