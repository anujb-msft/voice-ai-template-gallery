let callId = null;
const $ = (id) => document.getElementById(id);

async function post(url, body = {}) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}
async function refresh(snapshot = null) {
  if (callId && !snapshot) snapshot = await fetch(`/api/calls/${callId}`).then((r) => r.json());
  if (snapshot) {
    $("state").textContent = JSON.stringify({ state: snapshot.state, language: snapshot.language, current: snapshot.current, lastCase: snapshot.lastCase, outcome: snapshot.outcome }, null, 2);
    $("transcript").innerHTML = snapshot.transcript.map((t) => `<li class="${t.role}"><b>${t.role}</b>: ${escapeHtml(t.text)}</li>`).join("");
  }
  const cases = await fetch("/api/cases").then((r) => r.json());
  $("cases").innerHTML = cases.map((c) => `<article><b>${c.id}</b> ${c.type} — ${c.status} (${c.meToo ?? 1} reports)<br>${escapeHtml(c.location?.normalized ?? c.location ?? "")}</article>`).join("") || "No cases yet.";
  $("stats").textContent = JSON.stringify(await fetch("/api/stats").then((r) => r.json()), null, 2);
}

$("start").onclick = async () => { const r = await post("/api/simulate", { fromPhone: "+15550123" }); callId = r.callId; await refresh(r.snapshot); };
$("say").onclick = async () => { if (!callId) return; const text = $("utterance").value; $("utterance").value = ""; const r = await post(`/api/simulate/${callId}/say`, { text }); await refresh(r.snapshot); };
document.querySelectorAll("[data-dtmf]").forEach((b) => b.onclick = async () => { if (!callId) return; const r = await post(`/api/simulate/${callId}/dtmf`, { digit: b.dataset.dtmf }); await refresh(r.snapshot); });
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
refresh();
