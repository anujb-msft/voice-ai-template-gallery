const $ = (id) => document.getElementById(id);
const api = async (path, body) => {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
};

let sessionId = null;
let connection = null;

// ------------------------------------------------------------------ sign-in

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const result = await api("/api/login", {
    username: $("username").value,
    password: $("password").value,
  });
  const err = $("loginError");
  if (result.ok) {
    err.hidden = true;
    alert(`Signed in as ${result.user.displayName}`);
    return;
  }
  err.hidden = false;
  err.textContent =
    result.reason === "locked"
      ? "Your account is locked after too many failed sign-in attempts. Use “Forgot password?” to reset it."
      : "That username or password isn't right.";
});

$("forgotLink").addEventListener("click", async (e) => {
  e.preventDefault();
  const username = $("username").value.trim();
  if (!username) return;

  const result = await api("/api/reset/start", { username });
  if (!result.sessionId) return;

  sessionId = result.sessionId;
  $("loginCard").hidden = true;
  $("resetCard").hidden = false;

  if (result.simulated) {
    setStatus("Simulation mode", `No call placed. Missing config: ${result.missing.join(", ")}.`, false);
  } else if (result.callingNumber) {
    setStatus("Calling you now", `We're calling ${result.callingNumber}. Answer to continue.`, true);
  }

  await connectRealtime();
  render(await api(`/api/reset/${sessionId}`));
});

// ----------------------------------------------------------------- realtime

async function connectRealtime() {
  const info = await api("/api/negotiate", { sessionId });

  if (info.transport === "azure-signalr") {
    connection = new signalR.HubConnectionBuilder()
      .withUrl(info.url, { accessTokenFactory: () => info.accessToken })
      .withAutomaticReconnect()
      .build();
    connection.on("state", render);
    connection.on("transcript", addTranscript);
    connection.on("activity", addActivity);
    connection.on("policy", renderPolicy);
    connection.on("codeIssued", () => setStatus("Listen for your code", "The assistant is reading you a 6-digit code.", false));
    connection.on("callFailed", onCallFailed);
    connection.on("callEnded", onCallEnded);
    await connection.start();
    return;
  }

  // Built-in WebSocket fallback — same message shape, no Azure SignalR needed.
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${proto}//${location.host}${info.url}`);
  const handlers = {
    state: render,
    transcript: addTranscript,
    activity: addActivity,
    policy: renderPolicy,
    codeIssued: () => setStatus("Listen for your code", "The assistant is reading you a 6-digit code.", false),
    callFailed: onCallFailed,
    callEnded: onCallEnded,
  };
  socket.onmessage = (ev) => {
    const { target, arguments: args } = JSON.parse(ev.data);
    handlers[target]?.(args[0]);
  };
  connection = socket;
}

// ------------------------------------------------------------------ render

// ------------------------------------------------------- call interruptions

/**
 * A dropped call does not destroy the reset session, so both of these offer a
 * redial that resumes at the step the caller was on rather than starting over.
 */
function showReconnect(title, hint) {
  $("reconnectTitle").textContent = title;
  $("reconnectHint").textContent = hint;
  $("reconnect").hidden = false;
  $("callAgain").disabled = false;
  $("callAgain").textContent = "Call me again";
}

function hideReconnect() {
  $("reconnect").hidden = true;
}

function onCallEnded(d = {}) {
  $("spinner").hidden = true;
  if (d.resumable === false) return; // finished or escalated — nothing to resume
  showReconnect(
    "The call ended before we finished",
    d.label ? `We were on "${d.label}". Call me back to carry on.` : "Call me back to carry on where we left off.",
  );
}

function onCallFailed(d = {}) {
  setStatus("We couldn't reach you", d.message ?? "The call didn't connect.", false);
  showReconnect("We couldn't reach you", "Check your phone is available, then try again.");
}

$("callAgain").addEventListener("click", async () => {
  const btn = $("callAgain");
  btn.disabled = true;
  btn.textContent = "Calling…";
  try {
    const result = await api(`/api/reset/${sessionId}/recall`, {});
    if (result.error) {
      showReconnect("That didn't work", result.error);
      return;
    }
    hideReconnect();
    setStatus(
      "Calling you now",
      result.simulated ? "Simulation mode — no call placed." : `We're calling ${result.callingNumber}. Answer to continue.`,
      !result.simulated,
    );
  } catch {
    showReconnect("That didn't work", "We couldn't place the call. Try again in a moment.");
  }
});

function setStatus(label, hint, spinning) {
  $("statusLabel").textContent = label;
  $("statusHint").textContent = hint;
  $("spinner").hidden = !spinning;
}

function render(snap) {
  if (!snap) return;
  hideReconnect();
  setStatus(snap.label, snap.hint, snap.ui === "waiting" || snap.ui === "verify");

  document.querySelectorAll(".steps li").forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle("active", n === snap.order);
    li.classList.toggle("done", n < snap.order || snap.ui === "done");
  });

  $("panelCode").hidden = snap.ui !== "code";
  $("panelPassword").hidden = snap.ui !== "password";
  $("panelDone").hidden = snap.ui !== "done";

  if (snap.ui === "code") $("codeInput").focus();
  if (snap.ui === "password") $("newPassword").focus();
  if (snap.ui === "done") $("spinner").hidden = true;
}

/**
 * Human-readable labels for the tools the agent is allowed to call. Anything not
 * listed still renders, so a partner adding a tool sees it without extra wiring.
 */
const TOOL_LABELS = {
  confirm_identity: "Verified identity",
  issue_verification_code: "Issued verification code",
  escalate: "Escalated to a human",
  end_call: "Ended the call",
};

function addActivity({ tool, ok, detail }) {
  $("activityEmpty")?.remove();
  const row = document.createElement("div");
  row.className = `act ${ok ? "ok" : "bad"}`;
  row.innerHTML =
    `<span class="mark">${ok ? "✓" : "✕"}</span>` +
    `<span class="what"></span><code class="tool"></code>`;
  row.querySelector(".what").textContent =
    (TOOL_LABELS[tool] ?? tool) + (detail ? ` — ${detail}` : "");
  row.querySelector(".tool").textContent = tool;
  $("activity").append(row);
  $("activity").scrollTop = $("activity").scrollHeight;
}

function addTranscript({ role, text }) {
  const line = document.createElement("div");
  line.className = `line ${role}`;
  line.innerHTML = `<span class="who">${role === "agent" ? "Agent" : "You"}</span><span class="what"></span>`;
  line.querySelector(".what").textContent = text;
  $("transcript").append(line);
  $("transcript").scrollTop = $("transcript").scrollHeight;
}

const POLICY_RULES = [
  "At least 12 characters",
  "An uppercase letter",
  "A lowercase letter",
  "A number",
  "A symbol",
  "Not a common or personal password",
];

function renderPolicy(result) {
  const list = $("policy");
  list.innerHTML = "";
  // The server returns only what's *wrong*, so anything not mentioned passed.
  const failedText = (result.failures ?? []).join(" ").toLowerCase();
  const checks = [
    !failedText.includes("12 characters"),
    !failedText.includes("capital"),
    !failedText.includes("lowercase"),
    !failedText.includes("number"),
    !failedText.includes("symbol"),
    !failedText.includes("blocklist") && !failedText.includes("your name") && !failedText.includes("username"),
  ];
  POLICY_RULES.forEach((rule, i) => {
    const li = document.createElement("li");
    li.textContent = rule;
    if (checks[i]) li.classList.add("ok");
    list.append(li);
  });
  $("savePassword").disabled = !result.ok;
}

// ------------------------------------------------------------ step inputs

$("codeInput").addEventListener("input", async (e) => {
  const code = e.target.value.replace(/\D/g, "").slice(0, 6);
  e.target.value = code;
  if (code.length !== 6) return;

  const result = await api(`/api/reset/${sessionId}/code`, { code });
  $("codeError").hidden = result.ok;
  if (!result.ok) e.target.value = "";
});

let checkTimer;
$("newPassword").addEventListener("input", (e) => {
  clearTimeout(checkTimer);
  const password = e.target.value;
  if (!password) return renderPolicy({ ok: false, failures: POLICY_RULES });
  // Debounced so the agent gets coherent coaching, not a keystroke firehose.
  checkTimer = setTimeout(
    async () => renderPolicy(await api(`/api/reset/${sessionId}/check-password`, { password })),
    400,
  );
});

$("savePassword").addEventListener("click", async () => {
  const result = await api(`/api/reset/${sessionId}/password`, { password: $("newPassword").value });
  const err = $("passwordError");
  err.hidden = result.ok;
  if (!result.ok) err.textContent = (result.failures ?? ["That password was rejected."]).join(" ");
});

$("restart").addEventListener("click", () => location.reload());

renderPolicy({ ok: false, failures: POLICY_RULES });
