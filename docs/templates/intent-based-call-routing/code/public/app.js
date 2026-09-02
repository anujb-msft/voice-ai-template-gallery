/**
 * Presenter console.
 *
 * Shows the routing decision as it happens: what the model proposed, how
 * confident it was against the gate, whether the destination was open, and
 * exactly what Teams receives. State arrives over the WebSocket hub, so the
 * console is a viewer of the state machine rather than a second copy of it.
 */

const $ = (id) => document.getElementById(id);

const state = {
  callId: null,
  routes: [],
  threshold: 0.75,
  organization: "Contoso",
};

const CALLERS = [
  { phone: "", label: "Unknown number" },
  { phone: "+14255550101", label: "Dana Whitfield — Northwind Traders" },
  { phone: "+14255550102", label: "Marcus Bell — Fabrikam" },
  { phone: "+14255550103", label: "Priya Raman — Tailwind Logistics" },
];

// ------------------------------------------------------------------ bootstrap

async function boot() {
  const [health, routeDoc] = await Promise.all([
    fetch("/health").then((r) => r.json()),
    fetch("/api/routes").then((r) => r.json()),
  ]);

  state.threshold = health.routing.confidenceThreshold;
  state.routes = routeDoc.routes;
  state.organization = routeDoc.organization;

  $("org").textContent = routeDoc.organization;
  $("gateValue").textContent = state.threshold;
  $("confGate").style.left = `${state.threshold * 100}%`;

  const mode = $("mode");
  mode.textContent = health.callReady
    ? `live · ${health.voiceLive.model}`
    : "simulation — no Azure configured";
  mode.dataset.live = String(health.callReady);
  mode.title = health.callReady
    ? `Voice Live ${health.voiceLive.model} (${health.voiceLive.auth}) · Teams ${health.teams.cloud}${
        health.teams.ready ? "" : ` · unprovisioned routes: ${health.teams.unprovisionedRoutes.join(", ")}`
      }`
    : `Set ${health.missingConfig.join(", ")} to answer real calls.`;

  $("callerSelect").innerHTML = CALLERS.map((c) => `<option value="${c.phone}">${c.label}</option>`).join("");
  renderRoutes(null);
  renderKeys();
  connectHub();
  refreshStats();
}

function renderKeys() {
  $("keys").innerHTML = state.routes
    .filter((r) => r.dtmf)
    .map((r) => `<button type="button" data-digit="${r.dtmf}" title="${r.label}" disabled>${r.dtmf}</button>`)
    .join("");

  for (const button of $("keys").querySelectorAll("button")) {
    button.addEventListener("click", () => post(`/api/simulate/${state.callId}/dtmf`, { digit: button.dataset.digit }));
  }
}

// -------------------------------------------------------------------- realtime

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

  // A dropped console should not look like a dropped call.
  socket.addEventListener("close", () => setTimeout(connectHub, 1500));
}

// --------------------------------------------------------------------- render

function render(snapshot) {
  if (!snapshot) return;

  $("stateChip").textContent = snapshot.state;
  $("stateChip").dataset.state = snapshot.state;

  renderBudget(snapshot);
  renderProposed(snapshot);
  renderRoutes(snapshot);

  $("factConfirmed").textContent = snapshot.confirmedRouteId ?? "—";
  $("factDestination").textContent = snapshot.destination
    ? `${snapshot.destination.displayName ?? snapshot.destination.routeId}${
        snapshot.destination.afterHours ? " (after hours)" : ""
      }`
    : "—";
  $("factHours").textContent = snapshot.destination
    ? snapshot.destination.afterHours
      ? "closed — diverted"
      : "open"
    : "—";
  $("factClarify").textContent = snapshot.clarifications;
  $("factCaller").innerHTML = snapshot.caller
    ? `${escapeHtml(snapshot.caller.name)} <span class="muted">· unverified</span>`
    : `<span class="muted">unknown · ${escapeHtml(snapshot.maskedPhone ?? "anonymous")}</span>`;

  const finished = ["transferred", "ended"].includes(snapshot.state);
  setCallControls(!finished);
  if (finished) refreshStats();
}

function renderBudget(snapshot) {
  const wrap = $("budgetWrap");
  if (!snapshot.budgetMs) return (wrap.hidden = true);
  wrap.hidden = false;

  const ratio = Math.min(snapshot.elapsedMs / snapshot.budgetMs, 1);
  const fill = $("budgetFill");
  fill.style.width = `${ratio * 100}%`;
  fill.className = ratio >= 1 ? "over" : ratio > 0.7 ? "warn" : "";
  $("budgetLabel").textContent = `${(snapshot.elapsedMs / 1000).toFixed(0)}s / ${snapshot.budgetMs / 1000}s`;
}

function renderProposed(snapshot) {
  const proposal = snapshot.proposed;
  const box = $("proposed");
  const fill = $("confFill");

  if (!proposal) {
    // Keep the last confidence visible after confirmation — it is the number
    // the decision was made on.
    if (!snapshot.confirmedRouteId) {
      box.innerHTML = `<p class="empty">Nothing proposed yet.</p>`;
      fill.style.width = "0";
      $("confValue").textContent = "—";
    }
    return;
  }

  const route = state.routes.find((r) => r.id === proposal.routeId);
  const passes = proposal.confidence >= state.threshold;

  box.innerHTML = `
    <p class="route-name">${escapeHtml(route?.label ?? proposal.routeId)}</p>
    <p class="route-why">${escapeHtml(snapshot.topic ?? route?.description ?? "")}</p>
    <span class="verdict ${passes ? "pass" : "fail"}">
      ${passes ? "above the gate — offer it" : "below the gate — ask a question"}
    </span>`;

  fill.style.width = `${Math.min(proposal.confidence, 1) * 100}%`;
  fill.className = `conf-fill${passes ? " pass" : ""}`;
  $("confValue").textContent = proposal.confidence.toFixed(2);
}

function renderRoutes(snapshot) {
  const activeId = snapshot?.destination?.routeId ?? snapshot?.confirmedRouteId ?? snapshot?.proposed?.routeId;

  $("routes").innerHTML = state.routes
    .map(
      (r) => `<li class="${r.id === activeId ? "active" : ""}">
        <span>${escapeHtml(r.label)} <span class="dtmf">${r.dtmf ? `· key ${r.dtmf}` : ""}</span></span>
        <span class="${r.open ? "open" : "closed"}">${r.open ? "open" : "closed"}</span>
      </li>`,
    )
    .join("");
}

/** The mock Teams incoming-call toast, plus the literal headers behind it. */
function renderHandoff(context) {
  $("toastEmpty").hidden = true;
  $("toast").hidden = false;

  const route = state.routes.find((r) => r.id === context.routeId);
  const queue = route?.label ?? context.routeId;

  $("toastQueue").textContent = `${queue} — ${state.organization}`;
  $("toastAvatar").textContent = (queue[0] ?? "?").toUpperCase();
  $("toastFrom").textContent = context.afterHours ? "transferred after hours" : "transferred by the switchboard";
  $("toastTopic").textContent = context.callTopic;
  $("toastContext").textContent = context.callContext ?? "";

  const sentiment = $("toastSentiment");
  sentiment.hidden = !context.callSentiment;
  if (context.callSentiment) sentiment.textContent = `Caller said they are ${context.callSentiment}`;

  const caller = $("toastCaller");
  caller.hidden = !context.callerDetails;
  if (context.callerDetails) {
    const d = context.callerDetails;
    caller.innerHTML = `
      <strong>${escapeHtml(d.name)}</strong>${d.company ? ` · ${escapeHtml(d.company)}` : ""}
      ${d.accountId ? `<br />Account ${escapeHtml(d.accountId)}` : ""}
      ${d.relationship ? `<br />${escapeHtml(d.relationship)}` : ""}
      <span class="unverified">Matched on caller ID — not verified</span>`;
  }

  $("headers").innerHTML = toHeaders(context)
    .map(([key, value]) => `<b>${escapeHtml(key)}</b>: ${escapeHtml(value)}`)
    .join("\n");
}

/** Mirrors src/handoff.mjs so the console shows what actually goes on the wire. */
function toHeaders(context) {
  return [
    ["CallDetails.SessionId", context.sessionId],
    ["CallDetails.CallTopic", context.callTopic],
    ["CallDetails.CallContext", context.callContext],
    ["CallDetails.CallSentiment", context.callSentiment],
    ["CallDetails.RouteId", context.routeId],
    ["CallDetails.AfterHours", context.afterHours ? "true" : null],
    ["CallerDetails", context.callerDetails ? JSON.stringify(context.callerDetails) : null],
  ].filter(([, value]) => value != null && value !== "");
}

function addTranscript(role, text) {
  const list = $("transcript");
  list.querySelector(".empty")?.remove();
  const li = document.createElement("li");
  li.className = role;
  li.innerHTML = `<span class="who">${role}</span>${escapeHtml(text)}`;
  list.append(li);
  list.scrollTop = list.scrollHeight;
}

function addEvent({ source, kind, detail, at }) {
  const list = $("events");
  list.querySelector(".empty")?.remove();
  const li = document.createElement("li");
  li.dataset.source = source;
  li.dataset.kind = kind;
  li.innerHTML = `<span class="at">${new Date(at).toLocaleTimeString()}</span>
    <span class="kind">${escapeHtml(kind)}</span>
    <span class="detail">${escapeHtml(detail ?? "")}</span>`;
  list.append(li);
  list.scrollTop = list.scrollHeight;
}

async function refreshStats() {
  const stats = await fetch("/api/stats").then((r) => r.json());
  const byRoute = Object.entries(stats.byRoute ?? {})
    .filter(([k]) => k !== "none")
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ");

  $("metrics").innerHTML = [
    ["Calls", stats.calls],
    ["Transferred", stats.transfers],
    ["Clarifying questions", stats.clarifications],
    ["Sent to a person", stats.fallbacks],
    ["Messages taken", stats.messagesTaken],
    ["Median seconds to route", stats.medianSecondsToRoute ?? "—"],
  ]
    .map(([label, value]) => `<div><b>${value}</b>${label}</div>`)
    .join("") + (byRoute ? `<div><b>&nbsp;</b>${escapeHtml(byRoute)}</div>` : "");
}

// -------------------------------------------------------------------- actions

function setCallControls(active) {
  for (const id of ["sayInput", "sayBtn", "silence", "hangup"]) $(id).disabled = !active;
  for (const button of $("keys").querySelectorAll("button")) button.disabled = !active;
  if (active) $("sayInput").focus();
}

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

$("newCall").addEventListener("click", async () => {
  $("transcript").innerHTML = "";
  $("events").innerHTML = "";
  $("toast").hidden = true;
  $("toastEmpty").hidden = false;
  $("headers").textContent = "—";
  $("proposed").innerHTML = `<p class="empty">Nothing proposed yet.</p>`;
  $("confFill").style.width = "0";
  $("confValue").textContent = "—";

  const { callId, snapshot } = await post("/api/simulate", { fromPhone: $("callerSelect").value || null });
  state.callId = callId;
  render(snapshot);
  addTranscript("system", "Call answered. Type what the caller says.");
  setCallControls(true);
});

$("sayForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("sayInput").value.trim();
  if (!text || !state.callId) return;
  $("sayInput").value = "";
  render((await post(`/api/simulate/${state.callId}/say`, { text })).snapshot);
});

$("silence").addEventListener("click", async () => {
  addTranscript("system", "— caller says nothing —");
  render((await post(`/api/simulate/${state.callId}/silence`)).snapshot);
});

$("hangup").addEventListener("click", async () => {
  render((await post(`/api/simulate/${state.callId}/hangup`)).snapshot);
  setCallControls(false);
});

$("statsBtn").addEventListener("click", refreshStats);

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

boot();
