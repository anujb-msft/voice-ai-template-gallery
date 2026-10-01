const base = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8096";
async function post(path, body) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}
const start = await post("/api/simulate", { fromPhone: "+15550123" });
await post(`/api/simulate/${start.callId}/say`, { text: "There is a large pothole in the travel lane at Oak and 5th" });
const done = await fetch(`${base}/api/calls/${start.callId}`).then((r) => r.json());
if (!done.lastCase && done.state !== "transferred") throw new Error("simulated call did not file or transfer");
console.log(`smoke ok: ${start.callId} ${done.lastCase?.id ?? done.state}`);
