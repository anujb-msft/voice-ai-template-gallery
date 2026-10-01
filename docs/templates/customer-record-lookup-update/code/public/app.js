let callId = null;
const $ = (id) => document.getElementById(id);

async function json(url, options = {}) {
  const res = await fetch(url, { headers: { "content-type": "application/json" }, ...options });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function refresh() {
  if (callId) {
    const snap = await json(`/api/calls/${callId}`);
    $("snapshot").textContent = JSON.stringify(snap, null, 2);
    $("transcript").innerHTML = snap.transcript.map((t) => `<p><strong>${t.role}</strong> ${escapeHtml(t.text)}</p>`).join("");
    $("transcript").scrollTop = $("transcript").scrollHeight;
  }
  $("stats").textContent = JSON.stringify(await json("/api/stats"), null, 2);
}

$("start").addEventListener("click", async () => {
  const data = await json("/api/simulate", { method: "POST", body: JSON.stringify({ repId: "rep-alex" }) });
  callId = data.callId;
  $("status").textContent = `Call ${callId}`;
  await refresh();
});

$("reset").addEventListener("click", async () => { await json("/api/crm/reset", { method: "POST" }); await refresh(); });
$("sayForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!callId) return;
  const text = $("utterance").value;
  $("utterance").value = "";
  await json(`/api/simulate/${callId}/say`, { method: "POST", body: JSON.stringify({ text }) });
  await refresh();
});

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
refresh();
