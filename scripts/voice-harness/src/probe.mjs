import WebSocket from "ws";
import { sleep } from "./util.mjs";

/**
 * Watches a running template from the inside: its local console hub
 * (`/ws/hub`, every message for every call) and its read-only REST API.
 * Assertions run against what the server recorded, not against what the
 * agent happened to say.
 */
export class TemplateProbe {
  /**
   * @param {object} o
   * @param {string} o.baseUrl   e.g. http://127.0.0.1:8091
   * @param {string} [o.idKey]   field the hub stamps on each message ("callId"; the pager uses "id")
   * @param {(id:string)=>string} [o.recordPath]  REST path of one call
   * @param {(id:string)=>string} [o.eventsPath]  REST path of its audit events
   */
  constructor({ baseUrl, idKey = "callId", recordPath, eventsPath, hub = true }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.idKey = idKey;
    this.recordPath = recordPath ?? ((id) => `/api/calls/${encodeURIComponent(id)}`);
    this.eventsPath = eventsPath ?? ((id) => `/api/calls/${encodeURIComponent(id)}/events`);
    this.useHub = hub;
    this.messages = [];
    this.known = new Set();
  }

  async connect() {
    if (!this.useHub) return;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.baseUrl.replace(/^http/, "ws")}/ws/hub`);
      ws.once("open", resolve);
      ws.once("error", reject);
      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        const payload = msg.arguments?.[0] ?? {};
        this.messages.push({ at: Date.now(), target: msg.target, id: payload[this.idKey] ?? null, payload });
      });
      this.ws = ws;
    });
  }

  close() {
    this.ws?.close();
  }

  /** Start of a scenario: ids already seen belong to earlier calls. */
  mark() {
    for (const m of this.messages) if (m.id) this.known.add(m.id);
    return this.messages.length;
  }

  newIds(since = 0, target = null) {
    const ids = [];
    for (const m of this.messages.slice(since)) {
      if (m.id && !this.known.has(m.id) && (!target || m.target === target) && !ids.includes(m.id)) ids.push(m.id);
    }
    return ids;
  }

  /** The id of the first call (or record) that appears after `since`. */
  async waitForNewId({ since = 0, timeoutMs = 20000, target = null } = {}) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const hit = this.messages
        .slice(since)
        .find((m) => m.id && !this.known.has(m.id) && (!target || m.target === target));
      if (hit) return hit.id;
      await sleep(200);
    }
    return null;
  }

  /** Hub messages for one id, optionally of one kind (e.g. "transcript", "event", "state"). */
  messagesFor(id, target = null) {
    return this.messages.filter((m) => m.id === id && (!target || m.target === target));
  }

  async get(path) {
    const res = await fetch(`${this.baseUrl}${path}`);
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, ok: res.ok, body };
  }

  async post(path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, ok: res.ok, body: json };
  }

  async record(id) {
    const r = await this.get(this.recordPath(id));
    return r.ok ? r.body : null;
  }

  async events(id) {
    const r = await this.get(this.eventsPath(id));
    return Array.isArray(r.body) ? r.body : [];
  }

  async health() {
    try {
      const r = await this.get("/health");
      return r.ok ? r.body : null;
    } catch {
      return null;
    }
  }
}
