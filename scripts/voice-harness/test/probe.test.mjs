import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { WebSocketServer } from "ws";
import { TemplateProbe } from "../src/probe.mjs";
import { sleep } from "../src/util.mjs";

// A stand-in template: a read-only REST API and a console hub that pushes
// SignalR-style messages ({ target, arguments: [payload] }) for every call.
const routes = {
  "/health": [200, { ok: true, callReady: true }],
  "/api/calls/c1": [200, { state: "done" }],
  "/api/calls/c1/events": [200, [{ kind: "call_started" }, { kind: "call_ended" }]],
  "/api/calls/missing": [404, { error: "not found" }],
  "/api/calls/missing/events": [404, { error: "not found" }],
  "/api/pages/p%2F1": [200, { id: "p/1", status: "acked" }],
  "/api/pages/p%2F1/log": [200, { events: [{ kind: "paged" }] }],
  "/text": [200, "plain text"],
};

let server;
let baseUrl;
const sockets = new Set();
const hub = new WebSocketServer({ noServer: true });

function broadcast(target, payload) {
  for (const ws of sockets) ws.send(JSON.stringify({ type: 1, target, arguments: [payload] }));
}

async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(10);
  }
}

before(async () => {
  server = http.createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: req.url, got: JSON.parse(body) }));
      });
      return;
    }
    const [status, body] = routes[req.url] ?? [404, { error: "no route" }];
    res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws/hub") return socket.destroy();
    hub.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const ws of sockets) ws.terminate();
  hub.close();
  await new Promise((resolve) => server.close(resolve));
});

test("the hub tells this scenario's call apart from calls that were already running", async () => {
  const probe = new TemplateProbe({ baseUrl: `${baseUrl}/` });
  await probe.connect();
  try {
    await until(() => sockets.size === 1);
    broadcast("call", { callId: "earlier" });
    for (const ws of sockets) ws.send("not json");
    await until(() => probe.messages.length === 1);

    const mark = probe.mark();
    assert.equal(mark, 1);
    broadcast("transcript", { callId: "earlier", text: "still talking" });
    broadcast("transcript", { callId: "mine", role: "assistant", text: "Hello" });
    broadcast("state", { callId: "other", state: "ringing" });
    broadcast("status", { note: "no id" });
    await until(() => probe.messages.length === 5);

    assert.equal(await probe.waitForNewId({ since: mark, timeoutMs: 500 }), "mine");
    assert.equal(await probe.waitForNewId({ since: mark, timeoutMs: 500, target: "state" }), "other");
    assert.equal(await probe.waitForNewId({ since: mark, timeoutMs: 200, target: "nope" }), null);
    assert.deepEqual(probe.newIds(mark), ["mine", "other"]);
    assert.deepEqual(
      probe.messagesFor("mine", "transcript").map((m) => m.payload.text),
      ["Hello"],
    );
    assert.equal(probe.messagesFor("earlier").length, 2);
  } finally {
    probe.close();
  }
});

test("idKey reads a template's own id field (the pager stamps `id`)", async () => {
  const probe = new TemplateProbe({ baseUrl, idKey: "id" });
  await probe.connect();
  try {
    await until(() => sockets.size >= 1);
    broadcast("page", { id: "page-7", callId: "ignored" });
    await until(() => probe.messages.length === 1);
    assert.equal(await probe.waitForNewId({ timeoutMs: 500 }), "page-7");
  } finally {
    probe.close();
  }
});

test("REST reads: records, audit events, health, and raw bodies", async () => {
  const probe = new TemplateProbe({ baseUrl, hub: false });
  await probe.connect();
  assert.equal(probe.ws, undefined, "hub:false opens no socket");
  assert.deepEqual(await probe.record("c1"), { state: "done" });
  assert.deepEqual(
    (await probe.events("c1")).map((e) => e.kind),
    ["call_started", "call_ended"],
  );
  assert.equal(await probe.record("missing"), null);
  assert.deepEqual(await probe.events("missing"), []);
  assert.deepEqual(await probe.health(), { ok: true, callReady: true });
  assert.deepEqual(await probe.get("/text"), { status: 200, ok: true, body: "plain text" });
  assert.deepEqual(await probe.post("/api/reset/start", { username: "alex.morgan" }), {
    status: 201,
    ok: true,
    body: { path: "/api/reset/start", got: { username: "alex.morgan" } },
  });
});

test("custom record and event paths; a non-array events body reads as no events", async () => {
  const probe = new TemplateProbe({
    baseUrl,
    hub: false,
    recordPath: (id) => `/api/pages/${encodeURIComponent(id)}`,
    eventsPath: (id) => `/api/pages/${encodeURIComponent(id)}/log`,
  });
  assert.deepEqual(await probe.record("p/1"), { id: "p/1", status: "acked" });
  assert.deepEqual(await probe.events("p/1"), []);
});

test("health is null when nothing is listening", async () => {
  const probe = new TemplateProbe({ baseUrl: "http://127.0.0.1:9", hub: false });
  assert.equal(await probe.health(), null);
});
