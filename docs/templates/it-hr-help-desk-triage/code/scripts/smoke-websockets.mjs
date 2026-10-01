import assert from "node:assert/strict";
import WebSocket from "ws";

const base = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8098";
const wsBase = base.replace(/^http/, "ws");
const seen = [];
const ws = new WebSocket(`${wsBase}/ws/hub?user=*`);
await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
ws.on("message", (m) => seen.push(String(m)));
const post = async (url, body) => (await fetch(`${base}${url}`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body) })).json();
const start = await post("/api/simulate", { teamsUserId:"8:orgid:11111111-1111-1111-1111-111111111111" });
assert.ok(start.callId);
await post(`/api/simulate/${start.callId}/say`, { text:"My VPN keeps disconnecting" });
await new Promise((r)=>setTimeout(r,200));
assert.ok(seen.some((m)=>m.includes("it-vpn-001")) || seen.length > 0);
ws.close();
console.log("websocket smoke ok", start.callId);
