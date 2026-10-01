const $ = (id) => document.getElementById(id);
const state = { callId: null };

async function boot() {
  const health = await fetch("/health").then((r) => r.json());
  $("mode").textContent = health.simulationMode ? "simulation" : `live · ${health.voiceLive.model}`;
  $("mode").title = health.simulationMode ? `Missing: ${health.missingConfig.join(", ")}` : "Ready for live calls";
  connectHub();
  refreshStats();
}

function connectHub() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws/hub?user=*`);
  ws.addEventListener("message", (event) => {
    const { target, arguments: [payload] = [] } = JSON.parse(event.data);
    if (!payload || (state.callId && payload.callId !== state.callId)) return;
    if (target === "state") render(payload);
    if (target === "transcript") addTranscript(payload.role, payload.text);
    if (target === "event") addEvent(payload);
    if (target === "search") addSearch(payload);
    if (target === "citation") addCitation(payload);
    if (target === "handoff") renderHandoff(payload);
  });
  ws.addEventListener("close", () => setTimeout(connectHub, 1500));
}

function render(snap) {
  if (!snap) return;
  $("stateChip").textContent = snap.state;
  $("stateChip").dataset.state = snap.state;
  $("topic").textContent = snap.lastTopic ?? "—";
  $("answers").textContent = snap.answers?.length ?? 0;
  const active = !["closed", "ended", "transferred"].includes(snap.state);
  for (const id of ["sayInput", "sayBtn", "silence", "dtmf0", "hangup"]) $(id).disabled = !active;
  if (active) $("sayInput").focus();
  if (!active) refreshStats();
}

function addTranscript(role, text) {
  const li = document.createElement("li");
  li.className = role;
  li.innerHTML = `<span>${escapeHtml(role)}</span>${escapeHtml(text)}`;
  $("transcript").querySelector(".empty")?.remove();
  $("transcript").append(li);
  $("transcript").scrollTop = $("transcript").scrollHeight;
}

function addEvent({ source, kind, detail }) {
  const li = document.createElement("li");
  li.innerHTML = `<b>${escapeHtml(kind)}</b> <span>${escapeHtml(source)}</span> ${escapeHtml(detail ?? "")}`;
  $("events").querySelector(".empty")?.remove();
  $("events").append(li);
}

function addSearch(search) {
  $("searches").querySelector(".empty")?.remove();
  const div = document.createElement("article");
  div.className = "search-card";
  div.innerHTML = `<h3>${escapeHtml(search.query)}</h3><p>${search.miss ? "Miss" : "Hit"}${search.expiredMatch ? " · expired match hidden" : ""}</p>
    ${(search.passages ?? []).map((p) => `<div class="passage ${p.freshness}"><b>${escapeHtml(p.title)}</b> <span>${escapeHtml(p.freshness)}</span><br><small>${escapeHtml(p.articleId)} · ${escapeHtml(p.source)} · score ${p.score}</small><p>${escapeHtml(p.text ?? "")}</p></div>`).join("")}`;
  $("searches").prepend(div);
}

function addCitation(c) {
  const div = document.createElement("div");
  div.className = "citation";
  div.textContent = `Recorded citation: ${c.articleIds.join(", ")}${c.stale ? " (stale caveat)" : ""}`;
  $("searches").prepend(div);
}

function renderHandoff(context) {
  $("handoff").classList.remove("empty");
  $("handoff").innerHTML = `<b>${escapeHtml(context.callTopic)}</b><pre>${escapeHtml(JSON.stringify(context, null, 2))}</pre>`;
}

async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return res.json();
}

$("newCall").addEventListener("click", async () => {
  for (const id of ["transcript", "events"]) $(id).innerHTML = "";
  $("searches").innerHTML = `<p class="empty">No searches yet.</p>`;
  $("handoff").className = "handoff empty";
  $("handoff").textContent = "No transfer yet.";
  const { callId, snapshot } = await post("/api/simulate", {});
  state.callId = callId;
  render(snapshot);
});

$("sayForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("sayInput").value.trim();
  if (!text || !state.callId) return;
  $("sayInput").value = "";
  render((await post(`/api/simulate/${state.callId}/say`, { text })).snapshot);
});
$("silence").addEventListener("click", async () => render((await post(`/api/simulate/${state.callId}/silence`)).snapshot));
$("dtmf0").addEventListener("click", async () => render((await post(`/api/simulate/${state.callId}/dtmf`, { digit: "0" })).snapshot));
$("hangup").addEventListener("click", async () => render((await post(`/api/simulate/${state.callId}/hangup`)).snapshot));
$("statsBtn").addEventListener("click", refreshStats);

async function refreshStats() {
  const s = await fetch("/api/stats").then((r) => r.json());
  $("metrics").innerHTML = Object.entries(s).map(([k, v]) => `<div><b>${escapeHtml(typeof v === "object" ? JSON.stringify(v) : v)}</b><span>${escapeHtml(k)}</span></div>`).join("");
}

function escapeHtml(v) { return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
boot();
