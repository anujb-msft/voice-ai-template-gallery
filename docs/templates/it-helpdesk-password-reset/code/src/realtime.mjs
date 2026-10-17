import { WebSocketServer } from "ws";

/**
 * Realtime fan-out, addressed by reset session (call) id.
 *
 *  - `local-ws`: a plain WebSocket hub inside this process. The presenter
 *    console always listens here (`?user=*` hears every call), so the template
 *    runs with no Azure SignalR dependency and no second service to provision.
 *
 *  - `azure-signalr`: Azure SignalR Service in *Serverless* mode, used for the
 *    employee's reset page when AZURE_SIGNALR_CONNECTION_STRING is set. The
 *    browser talks straight to the service; this server only mints tokens and
 *    pushes messages over the REST API. This is the shape you want in
 *    production.
 *
 * The flow only ever calls `send(userId, target, payload)`, so it can't tell
 * which transport carried a message.
 */
export class LocalWebSocketHub {
  transport = "local-ws";

  /** @type {Map<string, Set<import("ws").WebSocket>>} */
  #clients = new Map();
  /** Every message per call, so a reset page opened mid-call is not blank. */
  #backlog = new Map();

  /**
   * Returns the server so the caller can route upgrades. Deliberately
   * `noServer`: attaching two WebSocketServers to one HTTP server does not work,
   * because each aborts the handshake for paths it does not own.
   */
  attach() {
    const wss = new WebSocketServer({ noServer: true });

    wss.on("connection", (socket, req) => {
      const userId = new URL(req.url, "http://localhost").searchParams.get("user") || "*";
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
    return { url: `/ws/hub?user=${encodeURIComponent(userId)}`, accessToken: null, transport: this.transport };
  }

  /** Sent to the page watching this call and to any console watching every call. */
  send(userId, target, payload) {
    const msg = JSON.stringify({ target, arguments: [{ callId: userId, ...payload }] });

    const backlog = this.#backlog.get(userId) ?? [];
    backlog.push(msg);
    if (backlog.length > 200) backlog.shift();
    this.#backlog.set(userId, backlog);

    for (const key of new Set([userId, "*"])) {
      for (const socket of this.#clients.get(key) ?? []) {
        if (socket.readyState === socket.OPEN) socket.send(msg);
      }
    }
  }

  forget(userId) {
    this.#backlog.delete(userId);
  }

  reset() {
    this.#backlog.clear();
  }
}

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

export class AzureSignalRHub {
  transport = "azure-signalr";

  /** @param {object} jwt the `jsonwebtoken` module, loaded only when SignalR is configured */
  constructor(connectionString, hub, jwt) {
    const { endpoint, accessKey } = parseConnectionString(connectionString);
    this.endpoint = endpoint;
    this.accessKey = accessKey;
    this.hub = hub;
    this.jwt = jwt;
  }

  #token(audience, userId, ttlSeconds = 3600) {
    const claims = userId ? { nameid: userId } : {};
    return this.jwt.sign(claims, this.accessKey, { audience, expiresIn: ttlSeconds, algorithm: "HS256" });
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
        Authorization: "Bearer " + this.#token(url),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ target, arguments: [{ callId: userId, ...payload }] }),
    });
    // 202 Accepted is the success path; 404 means "no connected client", which is benign.
    if (!res.ok && res.status !== 404) {
      throw new Error(`SignalR send failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }
}

/** The local hub for the console, plus Azure SignalR for reset pages when configured. */
export class Hub {
  constructor({ local = new LocalWebSocketHub(), signalr = null, log = () => {} } = {}) {
    this.local = local;
    this.signalr = signalr;
    this.log = log;
  }

  get transport() {
    return this.signalr?.transport ?? this.local.transport;
  }

  attach() {
    return this.local.attach();
  }

  /** What the employee's reset page connects to. */
  negotiate(userId) {
    return (this.signalr ?? this.local).negotiate(userId);
  }

  async send(userId, target, payload) {
    this.local.send(userId, target, payload);
    if (!this.signalr) return;
    try {
      await this.signalr.send(userId, target, payload);
    } catch (e) {
      this.log(`[hub] ${e.message}`);
    }
  }

  forget(userId) {
    this.local.forget(userId);
  }

  reset() {
    this.local.reset();
  }
}

/** jsonwebtoken is loaded only when Azure SignalR is configured. */
export async function createHub({ connectionString = "", hub = "helpdesk", log = () => {} } = {}) {
  let signalr = null;
  if (connectionString) {
    try {
      const { default: jwt } = await import("jsonwebtoken");
      signalr = new AzureSignalRHub(connectionString, hub, jwt);
    } catch (e) {
      log(`[hub] Azure SignalR is off (${e.message}); reset pages use the built-in WebSocket hub`);
    }
  }
  return new Hub({ signalr, log });
}
