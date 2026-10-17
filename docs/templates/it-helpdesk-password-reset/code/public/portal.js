/*
 * The employee's reset page.
 *
 * Sign in, choose "Forgot password?", and the IT assistant calls back. From
 * then on this page moves in step with the call: the server pushes every
 * change over the realtime hub, and the page decides nothing itself. It never
 * receives the verification code or the employee ID digits; it only learns
 * that a code exists. The new password goes from here straight to the server,
 * and nobody on the call hears it.
 *
 * /portal.html?session=<id> follows a reset that is already in progress.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    loginCard: $("loginCard"),
    loginForm: $("loginForm"),
    username: $("username"),
    password: $("password"),
    loginError: $("loginError"),
    loginInfo: $("loginInfo"),
    forgot: $("forgotLink"),
    resetCard: $("resetCard"),
    steps: $("steps"),
    spinner: $("spinner"),
    statusLabel: $("statusLabel"),
    statusHint: $("statusHint"),
    simNote: $("simNote"),
    reconnect: $("reconnect"),
    reconnectTitle: $("reconnectTitle"),
    reconnectHint: $("reconnectHint"),
    callAgain: $("callAgain"),
    panelCode: $("panelCode"),
    codeInput: $("codeInput"),
    codeHint: $("codeHint"),
    codeError: $("codeError"),
    panelPassword: $("panelPassword"),
    newPassword: $("newPassword"),
    policy: $("policy"),
    savePassword: $("savePassword"),
    passwordError: $("passwordError"),
    panelDone: $("panelDone"),
    panelStop: $("panelStop"),
    stopText: $("stopText"),
    restart: $("restart"),
    restartStop: $("restartStop"),
    talkToPerson: $("talkToPerson"),
    activity: $("activity"),
    activityEmpty: $("activityEmpty"),
    transcript: $("transcript"),
  };

  /** The rules in the order the assistant reads them, keyed by the server's failure strings. */
  const POLICY_RULES = [
    ["At least 12 characters", "It needs to be at least 12 characters long."],
    ["An uppercase letter", "It needs at least one capital letter."],
    ["A lowercase letter", "It needs at least one lowercase letter."],
    ["A number", "It needs at least one number."],
    ["A symbol", "It needs at least one symbol."],
    ["Not a common password", "That password is on the commonly-used blocklist."],
    ["Not your username", "It can't contain your username."],
    ["Not your name", "It can't contain part of your name."],
  ];

  const TOOL_LABELS = {
    confirm_identity: "Checked the employee ID digits",
    issue_verification_code: "Issued a one-time code",
    refuse_request: "Refused a request",
    request_human: "Asked for a person",
    answer_question: "Answered from the knowledge base",
    escalate: "Handed to the IT service desk",
    end_call: "Ended the call",
  };

  const RESUMABLE = ["calling", "verify_identity", "voice_code", "choose_password"];
  const IN_PROGRESS = ["verify", "code", "password"];

  /** The reset this page follows: { id, seq, snap, simulated, socket, hub, closed, retry, failed }. */
  let current = null;

  // -------------------------------------------------------------- helpers

  const show = (el, on = true) => {
    el.hidden = !on;
  };

  function message(el, text) {
    el.textContent = text ?? "";
    el.hidden = !text;
  }

  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const resetPath = (suffix = "") => `/api/reset/${encodeURIComponent(current.id)}${suffix}`;

  /** GET, or POST a JSON body. Never throws: a failure comes back as { ok: false, data: { error } }. */
  async function api(path, body) {
    try {
      const res = await fetch(
        path,
        body === undefined
          ? {}
          : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      );
      let data = {};
      try {
        data = (await res.json()) ?? {};
      } catch {
        data = {};
      }
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: { error: "Can't reach the server. Check your connection and try again." } };
    }
  }

  // -------------------------------------------------------------- sign in

  els.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    message(els.loginError, "");
    message(els.loginInfo, "");
    const r = await api("/api/login", { username: els.username.value.trim(), password: els.password.value });
    if (r.ok && r.data.ok) {
      message(els.loginInfo, `Welcome back, ${r.data.user.displayName}. You're signed in.`);
    } else if (r.data.reason === "locked") {
      message(els.loginError, "Your account is locked. Choose “Forgot password?” and we'll call you to reset it.");
    } else {
      message(els.loginError, r.ok ? "That username and password don't match." : (r.data.error ?? "Something went wrong. Try again."));
    }
  });

  els.forgot.addEventListener("click", async (event) => {
    event.preventDefault();
    message(els.loginError, "");
    message(els.loginInfo, "");
    const username = els.username.value.trim();
    if (!username) {
      message(els.loginError, "Enter your username, then choose “Forgot password?”.");
      return;
    }
    const r = await api("/api/reset/start", { username });
    if (!r.ok) {
      message(els.loginError, r.data.error ?? "Something went wrong. Try again in a minute.");
      return;
    }
    if (r.data.pending) {
      // The same answer whether or not the account exists.
      message(els.loginInfo, "If that username belongs to a Contoso account, we're calling the number on file.");
      return;
    }
    await follow(r.data.sessionId, { callingNumber: r.data.callingNumber });
  });

  // ------------------------------------------------------- the reset page

  async function follow(id, { callingNumber = null } = {}) {
    const r = await api(`/api/reset/${encodeURIComponent(id)}`);
    if (!r.ok) {
      message(els.loginError, "That reset has finished or expired. Start again with “Forgot password?”.");
      return;
    }
    leave();
    current = { id, seq: -1, snap: null, simulated: Boolean(r.data.simulated), socket: null, hub: null, closed: false, retry: 0, failed: null };
    els.loginCard.hidden = true;
    els.resetCard.hidden = false;
    clearFeeds();
    renderPolicy(null);
    show(els.simNote, current.simulated);
    render(r.data);
    if (callingNumber && r.data.state === "calling") els.statusHint.textContent = `Answer your phone — we're calling ${callingNumber}.`;
    history.replaceState(null, "", `?session=${encodeURIComponent(id)}`);
    connect(current);
  }

  /** Stop following the current reset, if any. */
  function leave() {
    if (!current) return;
    current.closed = true;
    try {
      current.socket?.close();
      current.hub?.stop();
    } catch {
      /* already closed */
    }
    current = null;
  }

  function backToSignIn() {
    leave();
    history.replaceState(null, "", location.pathname);
    els.resetCard.hidden = true;
    els.loginCard.hidden = false;
    els.password.value = "";
    message(els.loginError, "");
    message(els.loginInfo, "");
  }

  els.restart.addEventListener("click", backToSignIn);
  els.restartStop.addEventListener("click", backToSignIn);

  /** Draw a snapshot from the server. A snapshot older than the one on screen is dropped. */
  function render(snap) {
    const cur = current;
    if (!cur || !snap || snap.callId !== cur.id) return;
    if (typeof snap.seq === "number") {
      if (snap.seq <= cur.seq) return;
      cur.seq = snap.seq;
    }
    const prev = cur.snap;
    cur.snap = snap;
    const live = !snap.callEnded;
    if (cur.failed && (snap.state !== "calling" || !live)) cur.failed = null;

    // Progress comes from what has been proven, so an escalation mid-way shows where it stopped.
    const done = [snap.verified, snap.codeVerified, snap.outcome === "reset_completed"];
    const next = done.indexOf(false);
    const stopped = snap.ui === "refused" || snap.ui === "escalated";
    const transferFailed = Boolean(snap.escalation?.transferFailed);
    [...els.steps.children].forEach((li, i) => {
      li.classList.toggle("done", done[i]);
      li.classList.toggle("active", i === next && live && IN_PROGRESS.includes(snap.ui));
      li.classList.toggle("stopped", i === next && stopped);
    });

    els.statusLabel.textContent = snap.label;
    els.statusHint.textContent =
      snap.ui === "escalated" && !transferFailed
        ? `${snap.hint} They have the details of this call, so you won't need to start over.`
        : snap.callEnded && RESUMABLE.includes(snap.state)
          ? "The call ended before we finished."
          : snap.hint;
    show(els.spinner, live && ["waiting", "verify", "code"].includes(snap.ui));

    show(els.panelCode, snap.ui === "code");
    show(els.panelPassword, snap.ui === "password");
    show(els.panelDone, snap.ui === "done");
    show(els.panelStop, stopped);
    els.stopText.textContent =
      snap.ui === "refused"
        ? `${snap.hint}${snap.ticketId ? ` Your request is ${snap.ticketId}.` : ""}`
        : transferFailed
          ? `The IT service desk will follow up${snap.ticketId ? ` on ticket ${snap.ticketId}` : ""}. Nothing else is needed on this page.`
          : `An IT specialist has taken over${snap.ticketId ? ` ticket ${snap.ticketId}` : ""}. Nothing else is needed on this page.`;
    show(els.talkToPerson, live && IN_PROGRESS.includes(snap.ui));

    if (snap.ui === "code" && prev?.ui !== "code") {
      els.codeInput.value = "";
      message(els.codeError, "");
      els.codeHint.textContent = "Listen for your code on the call.";
      if (live) els.codeInput.focus();
    }
    if (snap.ui === "password" && prev?.ui !== "password") {
      els.newPassword.value = "";
      message(els.passwordError, "");
      renderPolicy(null);
      if (live) els.newPassword.focus();
    }
    // The page moves with the call: while the call is down, nothing can be typed.
    els.codeInput.disabled = !live;
    els.newPassword.disabled = !live;
    if (!live) els.savePassword.disabled = true;

    const resumable = snap.callEnded && RESUMABLE.includes(snap.state);
    if (resumable) {
      els.reconnectTitle.textContent = snap.endReason === "hung_up" ? "The call ended" : "The call dropped";
      els.reconnectHint.textContent = `You can pick up right where you left off: ${snap.label.toLowerCase()}.`;
      els.callAgain.disabled = false;
    }
    show(els.reconnect, resumable || Boolean(cur.failed));
  }

  function renderPolicy(failures) {
    els.policy.replaceChildren(
      ...POLICY_RULES.map(([label, failure]) => {
        const li = document.createElement("li");
        li.className = failures == null ? "pending" : failures.includes(failure) ? "bad" : "ok";
        li.textContent = label;
        return li;
      }),
    );
  }

  function codeError({ reason, attemptsLeft }) {
    switch (reason) {
      case "mismatch":
        return `That code didn't match${attemptsLeft ? ` (${attemptsLeft} ${attemptsLeft === 1 ? "try" : "tries"} left)` : ""}. Listen as the assistant reads it again.`;
      case "expired":
        return "That code expired — listen for a fresh one.";
      case "cancelled":
        return "Too many wrong tries, so that code was cancelled — listen for a new one.";
      case "no_code":
        return "Wait for the assistant to read you a code.";
      default:
        return "That step is already finished.";
    }
  }

  // -------------------------------------------------- the employee's input

  els.codeInput.addEventListener("input", async () => {
    const digits = els.codeInput.value.replace(/\D/g, "").slice(0, 6);
    els.codeInput.value = digits;
    if (digits) message(els.codeError, "");
    if (digits.length < 6 || !current) return;
    const cur = current;
    els.codeInput.disabled = true;
    const r = await api(resetPath("/code"), { code: digits });
    if (current !== cur) return;
    els.codeInput.disabled = Boolean(cur.snap?.callEnded);
    // On success the state frame moves the page on.
    if (r.ok && r.data.ok) return;
    els.codeInput.value = "";
    message(els.codeError, r.ok ? codeError(r.data) : (r.data.error ?? "Something went wrong. Try again."));
    if (!els.codeInput.disabled) els.codeInput.focus();
  });

  let checkTimer = null;
  let checkSeq = 0;

  els.newPassword.addEventListener("input", () => {
    message(els.passwordError, "");
    clearTimeout(checkTimer);
    checkSeq += 1;
    els.savePassword.disabled = true;
    const value = els.newPassword.value;
    if (!value) {
      renderPolicy(null);
      return;
    }
    checkTimer = setTimeout(() => checkPassword(value), 200);
  });

  els.newPassword.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !els.savePassword.disabled) els.savePassword.click();
  });

  /** The server checks the policy as the employee types, so the assistant can coach. */
  async function checkPassword(value) {
    if (!current) return;
    const mine = ++checkSeq;
    const r = await api(resetPath("/check-password"), { password: value });
    if (mine !== checkSeq || !current || !r.ok || r.data.reason === "wrong_state") return;
    renderPolicy(r.data.failures ?? []);
    els.savePassword.disabled = !r.data.ok || Boolean(current.snap?.callEnded);
  }

  els.savePassword.addEventListener("click", async () => {
    if (!current) return;
    els.savePassword.disabled = true;
    const r = await api(resetPath("/password"), { password: els.newPassword.value });
    // On success the state frame moves the page on.
    if (r.ok && r.data.ok) return;
    const failures = r.data.failures ?? [];
    if (failures.length) renderPolicy(failures);
    message(
      els.passwordError,
      failures.length ? failures.join(" ") : r.data.reason === "wrong_state" ? "That step is already finished." : (r.data.error ?? "That didn't work. Try again."),
    );
  });

  els.callAgain.addEventListener("click", async () => {
    if (!current) return;
    const cur = current;
    els.callAgain.disabled = true;
    const r = await api(resetPath("/recall"), {});
    if (current !== cur) return;
    if (!r.ok) {
      els.reconnectHint.textContent = r.data.error ?? "We couldn't call you back. Try again in a moment.";
      els.callAgain.disabled = false;
      return;
    }
    cur.failed = null;
    show(els.reconnect, false);
    // A simulated callback has already been answered; its state frames have drawn the step.
    if (!r.data.simulated) els.statusHint.textContent = `Answer your phone — we're calling ${r.data.callingNumber} again.`;
  });

  els.talkToPerson.addEventListener("click", async () => {
    if (!current) return;
    els.talkToPerson.disabled = true;
    const r = await api(resetPath("/escalate"), {});
    els.talkToPerson.disabled = false;
    if (r.ok && r.data.snapshot) render(r.data.snapshot);
  });

  // --------------------------------------------------------------- feeds

  function clearFeeds() {
    els.activity.replaceChildren(els.activityEmpty);
    els.activityEmpty.hidden = false;
    els.transcript.replaceChildren();
  }

  function addActivity({ tool, ok = true, at }) {
    els.activityEmpty.hidden = true;
    const row = document.createElement("div");
    row.className = ok ? "act" : "act rejected";
    const when = document.createElement("time");
    when.textContent = at ? time(at) : "";
    const what = document.createElement("span");
    what.textContent = TOOL_LABELS[tool] ?? tool;
    const name = document.createElement("code");
    name.textContent = tool;
    row.append(when, what, name);
    els.activity.append(row);
    els.activity.scrollTop = els.activity.scrollHeight;
  }

  /** Lines arrive redacted: a code or ID digits read on the call show as "[code withheld]". */
  function addLine({ role, text }) {
    const line = document.createElement("p");
    line.className = role === "agent" ? "line agent" : "line caller";
    const who = document.createElement("b");
    who.textContent = role === "agent" ? "Assistant" : "You";
    line.append(who, document.createTextNode(` ${text}`));
    els.transcript.append(line);
    els.transcript.scrollTop = els.transcript.scrollHeight;
  }

  // ------------------------------------------------------------ realtime

  function dispatch(cur, target, payload) {
    if (current !== cur || !payload) return;
    switch (target) {
      case "state":
        render(payload);
        break;
      case "transcript":
        addLine(payload);
        break;
      case "activity":
        addActivity(payload);
        break;
      case "codeIssued":
        // The page learns that a code exists and how long it lasts. Never the code.
        els.codeHint.textContent = `A code was just read to you on the call. It's good for ${cur.snap?.code?.ttlMinutes ?? 5} minutes.`;
        break;
      case "callFailed":
        cur.failed = payload.message ?? "The call could not be placed.";
        els.reconnectTitle.textContent = "We couldn't reach your phone";
        els.reconnectHint.textContent = cur.failed;
        els.callAgain.disabled = false;
        show(els.reconnect, true);
        break;
      default:
        // "event", "policy", "handoff", "callEnded" and "stats" are for the presenter console;
        // the state frame carries everything this page shows.
        break;
    }
  }

  async function connect(cur) {
    const n = await api("/api/negotiate", { sessionId: cur.id });
    if (cur.closed) return;
    if (n.ok && n.data.transport === "azure-signalr" && window.signalR) {
      connectSignalR(cur, n.data);
      return;
    }
    connectWebSocket(cur, n.ok && n.data.url ? n.data.url : `/ws/hub?user=${encodeURIComponent(cur.id)}`);
  }

  /** The built-in hub. It replays everything this reset has sent so far, so the feeds start clean on every connect. */
  function connectWebSocket(cur, path) {
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`);
    cur.socket = socket;
    socket.onopen = () => {
      cur.retry = 0;
      clearFeeds();
    };
    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      dispatch(cur, msg.target, msg.arguments?.[0]);
    };
    socket.onclose = () => {
      if (cur.closed || current !== cur) return;
      cur.retry = Math.min(cur.retry + 1, 5);
      setTimeout(() => {
        if (!cur.closed && current === cur) connectWebSocket(cur, path);
      }, 400 * 2 ** cur.retry);
    };
  }

  /** Azure SignalR Service in Serverless mode: the page talks straight to the service. */
  async function connectSignalR(cur, { url, accessToken }) {
    const hub = new window.signalR.HubConnectionBuilder()
      .withUrl(url, { accessTokenFactory: () => accessToken })
      .withAutomaticReconnect()
      .build();
    cur.hub = hub;
    for (const target of ["state", "transcript", "activity", "codeIssued", "callFailed"]) {
      hub.on(target, (payload) => dispatch(cur, target, payload));
    }
    hub.onreconnected(async () => {
      const r = await api(`/api/reset/${encodeURIComponent(cur.id)}`);
      if (r.ok) render(r.data);
    });
    try {
      await hub.start();
    } catch {
      // The server always runs the built-in hub too.
      cur.hub = null;
      if (!cur.closed) connectWebSocket(cur, `/ws/hub?user=${encodeURIComponent(cur.id)}`);
    }
  }

  // ------------------------------------------------------------------ boot

  renderPolicy(null);
  const resume = new URLSearchParams(location.search).get("session");
  if (resume) follow(resume);
})();
