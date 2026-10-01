const $ = (id) => document.getElementById(id);
const state = { callId: null };

async function boot() {
  const health = await fetch("/health").then((r) => r.json());
  $("mode").textContent = health.callReady ? `live · ${health.voiceLive.model}` : "simulation — no Azure configured";
  $("mode").dataset.live = String(health.callReady);
  connectHub();
  await renderBoard();
  await refreshStats();
}

function connectHub() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${proto}//${location.host}/ws/hub?user=*`);
  socket.addEventListener("message", (event) => {
    const { target, arguments: [payload] = [] } = JSON.parse(event.data);
    if (!payload || (state.callId && payload.callId !== state.callId)) return;
    if (target === "state") render(payload);
    if (target === "transcript") addTranscript(payload.role, payload.text);
    if (target === "event") addEvent(payload);
    if (target === "handoff") renderHandoff(payload);
  });
  socket.addEventListener("close", () => setTimeout(connectHub, 1500));
}

function render(snapshot) {
  if (!snapshot) return;
  $("stateChip").textContent = snapshot.state;
  $("stateChip").dataset.state = snapshot.state;
  const q = snapshot.lastQuote ?? {};
  $("factLocation").textContent = q.locationName ?? snapshot.lastLocationId ?? "—";
  $("factCommodity").textContent = q.commodity ?? "—";
  $("factFreshness").textContent = q.freshness ?? "—";
  $("factReference").textContent = q.reference ?? "—";
  $("factBasis").textContent = q.basisCents == null ? "—" : `${Math.abs(q.basisCents)} ${q.basisCents >= 0 ? "over" : "under"}`;
  const wrap = $("budgetWrap");
  wrap.hidden = false;
  const ratio = Math.min(snapshot.elapsedMs / snapshot.budgetMs, 1);
  $("budgetFill").style.width = `${ratio * 100}%`;
  $("budgetLabel").textContent = `${Math.round(snapshot.elapsedMs / 1000)}s / ${snapshot.budgetMs / 1000}s`;
  setCallControls(!["transferred", "ended"].includes(snapshot.state));
  if (["transferred", "ended"].includes(snapshot.state)) refreshStats();
}

async function renderBoard() {
  const board = await fetch("/api/bid-board").then((r) => r.json());
  $("bidBoard").innerHTML = ["corn", "soybeans", "wheat"].flatMap((c) => (board[c] ?? []).slice(0, 5).map((q) => `<li><span>${escapeHtml(q.locationName)} · ${escapeHtml(c)}</span><span>${escapeHtml(q.phrase.match(/\$\d+\.\d{2}/)?.[0] ?? "—")}</span></li>`)).join("");
}

function renderHandoff(context) {
  $("toastEmpty").hidden = true;
  $("toast").hidden = false;
  $("toastTopic").textContent = context.callTopic;
  $("toastContext").textContent = context.callContext ?? "";
  $("headers").innerHTML = [["CallDetails.SessionId", context.sessionId], ["CallDetails.CallTopic", context.callTopic], ["CallDetails.CallContext", context.callContext], ["CallDetails.LocationId", context.locationId], ["CallDetails.TransferReason", context.reason]].filter(([, v]) => v).map(([k, v]) => `<b>${escapeHtml(k)}</b>: ${escapeHtml(v)}`).join("\n");
}

function addTranscript(role, text) { const li = document.createElement("li"); li.className = role; li.innerHTML = `<span class="who">${role}</span>${escapeHtml(text)}`; $("transcript").querySelector(".empty")?.remove(); $("transcript").append(li); $("transcript").scrollTop = $("transcript").scrollHeight; }
function addEvent({ source, kind, detail, at }) { const li = document.createElement("li"); li.dataset.source = source; li.dataset.kind = kind; li.innerHTML = `<span class="at">${new Date(at).toLocaleTimeString()}</span><span class="kind">${escapeHtml(kind)}</span><span class="detail">${escapeHtml(detail ?? "")}</span>`; $("events").querySelector(".empty")?.remove(); $("events").append(li); }
async function refreshStats() { const s = await fetch("/api/stats").then((r) => r.json()); $("metrics").innerHTML = [["Calls", s.calls], ["Automated", s.callsAutomated], ["Saved minutes", s.estimatedStaffMinutesSaved], ["Delayed quotes", s.delayedQuotes], ["Close quotes", s.closePriceQuotes], ["Feed outages", s.feedOutages]].map(([l, v]) => `<div><b>${v}</b>${l}</div>`).join(""); }
function setCallControls(active) { for (const id of ["sayInput", "sayBtn", "silence", "hangup"]) $(id).disabled = !active; for (const b of document.querySelectorAll("[data-dtmf]")) b.disabled = !active; if (active) $("sayInput").focus(); }
async function post(url, body) { return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }).then((r) => r.json()); }

$("newCall").addEventListener("click", async () => { $("transcript").innerHTML = ""; $("events").innerHTML = ""; $("headers").textContent = "—"; $("toast").hidden = true; $("toastEmpty").hidden = false; const { callId, snapshot } = await post("/api/simulate", {}); state.callId = callId; render(snapshot); });
$("sayForm").addEventListener("submit", async (e) => { e.preventDefault(); const text = $("sayInput").value.trim(); if (!text) return; $("sayInput").value = ""; render((await post(`/api/simulate/${state.callId}/say`, { text })).snapshot); });
for (const b of document.querySelectorAll("[data-dtmf]")) b.addEventListener("click", async () => render((await post(`/api/simulate/${state.callId}/dtmf`, { digit: b.dataset.dtmf })).snapshot));
$("silence").addEventListener("click", async () => render((await post(`/api/simulate/${state.callId}/silence`)).snapshot));
$("hangup").addEventListener("click", async () => render((await post(`/api/simulate/${state.callId}/hangup`)).snapshot));
$("staleBtn").addEventListener("click", async () => { await post("/api/demo/make-stale", { minutes: 60 }); await renderBoard(); });
$("feedDownBtn").addEventListener("click", async () => { await post("/api/demo/feed-down", { down: true }); await renderBoard().catch(() => {}); });
$("statsBtn").addEventListener("click", refreshStats);
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
boot();
