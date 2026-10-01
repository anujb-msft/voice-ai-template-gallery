import WebSocket from "ws";

const base = process.env.BASE_URL ?? "http://127.0.0.1:8097";
const wsBase = base.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

async function post(path, body = {}) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

const hub = new WebSocket(`${wsBase}/ws/hub?user=*`);
await new Promise((resolve, reject) => { hub.once("open", resolve); hub.once("error", reject); });
const call = await post("/api/simulate", { repId: "rep-alex" });
for (const text of [
  "Brief me on Fabrikam",
  "Log the Fabrikam meeting. Dana agreed to the renewal at 240k, moving to Closed Won pending signature, close date June 15th. Remind me to send the contract Friday.",
  "yes, save it"
]) await post(`/api/simulate/${call.callId}/say`, { text });
const stats = await (await fetch(`${base}/api/stats`)).json();
hub.close();
if (stats.confirmedCommits < 1) throw new Error("offline call did not commit");
console.log(`smoke ok: call ${call.callId}, commits ${stats.confirmedCommits}`);
