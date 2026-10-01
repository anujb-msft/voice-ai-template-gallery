const $ = (id) => document.getElementById(id);
let currentIncidentId = null;
const pretty = (v) => JSON.stringify(v, null, 2);

async function json(url, options = {}) {
  const res = await fetch(url, { headers: { "content-type": "application/json" }, ...options });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}
async function refresh() {
  $("health").textContent = pretty(await json("/health"));
  $("stats").textContent = pretty(await json("/api/stats"));
  if (currentIncidentId) $("incident").textContent = pretty(await json(`/api/incidents/${currentIncidentId}`));
}
function line(target, payload) {
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString()} ${target}: ${JSON.stringify(payload)}`;
  $("timeline").prepend(li);
}
async function connectWs() {
  const { url } = await json("/api/negotiate", { method: "POST", body: JSON.stringify({ incidentId: "*" }) });
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${url}`);
  ws.onmessage = (event) => { const msg = JSON.parse(event.data); line(msg.target, msg.arguments?.[0] ?? msg); refresh(); };
}
$("start").onclick = async () => {
  const transcript = $("transcript").value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const data = await json("/api/simulate/intake", { method: "POST", body: JSON.stringify({ fromPhone: $("fromPhone").value, transcript, pageOutcomes: ["no-answer"] }) });
  currentIncidentId = data.submitted?.incidentId;
  $("incident").textContent = pretty(data.incident);
  await refresh();
};
for (const btn of document.querySelectorAll("button[data-outcome]")) {
  btn.onclick = async () => {
    if (!currentIncidentId) return;
    const data = await json(`/api/simulate/page/${currentIncidentId}`, { method: "POST", body: JSON.stringify({ outcome: btn.dataset.outcome }) });
    $("incident").textContent = pretty(data.incident);
    await refresh();
  };
}
$("advance").onclick = async () => { await json("/api/simulate/clock/advance", { method: "POST", body: JSON.stringify({ minutes: 3 }) }); await refresh(); };
connectWs();
refresh();
setInterval(refresh, 5000);
