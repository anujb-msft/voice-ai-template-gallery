/**
 * Presenter kit — shared building blocks for the template demo consoles.
 *
 * VENDORED FILE. The canonical copy lives in scripts/presenter-kit/. Edit it
 * there and run `node scripts/sync-presenter-kit.js`; CI fails when a copy in
 * a template drifts. Each template keeps its own domain panels in app.js and
 * its own scripted beats in beats.js.
 *
 * The console is a viewer of the server's state machine, never a second copy
 * of it. Everything here is presentation: hub plumbing, a race-free call
 * session, a demo director that types (and optionally speaks) the scripted
 * caller lines, and the shared visuals — stack strip, Teams toast, gauge,
 * checklist, decision trail, metrics, demo clock.
 *
 * Rules it follows (ARCHITECTURE.md): talks only to its own origin, makes no
 * third-party requests, and uses on-device browser voices only unless the
 * presenter opts in with `?voices=online`.
 */

// ----------------------------------------------------------------- basics

export const $ = (id) => document.getElementById(id);

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Briefly highlight an element that just changed — a metric, a result. */
export function flash(el) {
  if (!el) return;
  el.classList.remove("pk-flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("pk-flash");
}

const blank =  (value) => value == null || value === "" || (Array.isArray(value) && !value.length);

async function readJson(res) {
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text.slice(0, 200) };
  }
  if (!res.ok) {
    const reason = body?.error ?? body?.message ?? body?.reason ?? `${res.status} ${res.statusText}`;
    const error = new Error(typeof reason === "string" ? reason : JSON.stringify(reason));
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body;
}

/** GET same-origin JSON. Throws with the server's `error` message on a non-2xx. */
export async function getJson(url) {
  return readJson(await fetch(url, { headers: { Accept: "application/json" } }));
}

/** POST same-origin JSON. Throws with the server's `error` message on a non-2xx. */
export async function postJson(url, body) {
  return readJson(
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
  );
}

let notifyHost = null;

/** Corner toast for errors and confirmations. Tone: info | ok | warn | err. */
export function notify(message, tone = "info", ms = 4500) {
  if (!notifyHost) {
    notifyHost = document.createElement("div");
    notifyHost.className = "pk-notify";
    notifyHost.setAttribute("role", "status");
    notifyHost.setAttribute("aria-live", "polite");
    document.body.append(notifyHost);
  }
  const item = document.createElement("div");
  item.className = "pk-notify-item";
  item.dataset.tone = tone;
  item.textContent = message;
  notifyHost.append(item);
  setTimeout(() => {
    item.classList.add("out");
    setTimeout(() => item.remove(), 300);
  }, ms);
}

// -------------------------------------------------------------------- hub

let lastHubAt = 0;

/**
 * Connects to the template's WebSocket hub (`{ target, arguments: [payload] }`
 * frames) and reconnects forever. A dropped console must never look like a
 * dropped call, so an outage shows a banner instead of an error.
 *
 * @param {(target: string, payload: object) => void} onMessage
 */
export function connectHub(onMessage, { path = "/ws/hub?user=*", onOpen = null } = {}) {
  let socket = null;
  let closed = false;
  let attempts = 0;
  let banner = null;

  const showUp = (up) => {
    document.body.dataset.hub = up ? "up" : "down";
    if (up) {
      banner?.remove();
      banner = null;
    } else if (!banner) {
      banner = document.createElement("div");
      banner.className = "pk-reconnect";
      banner.textContent = "Reconnecting to the demo server…";
      document.body.append(banner);
    }
  };

  const open = () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${proto}//${location.host}${path}`);
    socket.addEventListener("open", () => {
      const reconnected = attempts > 0;
      attempts = 0;
      showUp(true);
      onOpen?.({ reconnected });
    });
    socket.addEventListener("message", (event) => {
      lastHubAt = performance.now();
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      const target = frame.target ?? frame.type;
      const payload = Array.isArray(frame.arguments) ? frame.arguments[0] : (frame.payload ?? frame.data);
      if (!target) return;
      try {
        onMessage(target, payload ?? {});
      } catch (error) {
        console.error("[presenter-kit] hub handler failed", target, error);
      }
    });
    socket.addEventListener("close", () => {
      if (closed) return;
      attempts += 1;
      // Only show the banner when the outage outlives a quick reconnect.
      setTimeout(() => {
        if (!closed && socket?.readyState !== WebSocket.OPEN) showUp(false);
      }, 1500);
      setTimeout(open, Math.min(400 * attempts, 4000));
    });
  };

  open();
  return {
    close() {
      closed = true;
      socket?.close();
    },
  };
}

/** Resolves once the hub has been quiet for `quietMs`, or after `maxMs`. */
export async function hubQuiet(quietMs = 650, maxMs = 8000) {
  const started = performance.now();
  await sleep(Math.min(quietMs, 200));
  while (performance.now() - started < maxMs) {
    if (performance.now() - lastHubAt >= quietMs) return true;
    await sleep(60);
  }
  return false;
}

// ------------------------------------------------------------ call session

const FINISHED = /^(ended|transferred|closed|completed?|hung_?up|failed|done|finished|cancell?ed|abandoned|voicemail)$/i;

/**
 * Which call the console is showing.
 *
 * Fixes the race every hand-rolled console has: hub messages for a new call
 * (the greeting, usually) arrive *before* the POST that started it returns,
 * so a console filtering on "the current call id" drops them. `start()`
 * buffers everything while the request is in flight and replays the frames
 * that belong to the new call.
 *
 * Calls this console did not start — a real phone call in live mode, or a
 * second browser tab — are followed only when nothing else is on screen, and
 * the room voice is muted for them. Payloads without a `callId` are
 * console-wide and always delivered.
 */
export function createCallSession({
  onMessage,
  onFollow = null,
  voice = null,
  stateTargets = ["state", "snapshot", "call", "status"],
  stateOf = (payload) => payload?.state ?? payload?.status,
  isFinished = (state) => FINISHED.test(String(state ?? "")),
} = {}) {
  let buffer = null;
  const retired = new Set();

  const track = (target, payload) => {
    if (!stateTargets.includes(target)) return;
    if (payload?.callId && payload.callId !== session.id) return;
    const state = stateOf(payload);
    if (!blank(state)) session.finished = isFinished(state);
  };

  const deliver = (target, payload) => {
    track(target, payload);
    onMessage?.(target, payload);
  };

  const session = {
    id: null,
    finished: true,
    /** True when the call was not started from this console (a real call). */
    followed: false,

    /** Feed every hub frame through here. */
    handle(target, payload) {
      if (buffer) {
        buffer.push([target, payload]);
        return;
      }
      const id = payload?.callId ?? null;
      if (id && id !== session.id) {
        if (!onFollow || !session.finished || retired.has(id)) return;
        if (session.id) retired.add(session.id);
        session.id = id;
        session.finished = false;
        session.followed = true;
        if (voice) voice.muted = true;
        onFollow(id, target, payload);
      }
      deliver(target, payload);
    },

    /**
     * Run the request that starts a call. The request must resolve to an
     * object with `callId` (or `snapshot.callId` / `snapshot.id` / `id`).
     */
    async start(request) {
      buffer = [];
      try {
        const result = await request();
        const id = result?.callId ?? result?.snapshot?.callId ?? result?.snapshot?.id ?? result?.id ?? null;
        if (session.id && session.id !== id) retired.add(session.id);
        session.id = id;
        session.finished = false;
        session.followed = false;
        if (voice) voice.muted = false;
        const backlog = buffer;
        buffer = null;
        for (const [target, payload] of backlog) {
          if (!payload?.callId || payload.callId === id) deliver(target, payload);
        }
        return result;
      } catch (error) {
        buffer = null;
        throw error;
      }
    },

    /** Mark the call finished (hangup, or a state the default matcher misses). */
    end() {
      session.finished = true;
    },

    /** Forget everything — after a demo reset. */
    reset() {
      if (session.id) retired.add(session.id);
      session.id = null;
      session.finished = true;
      session.followed = false;
      if (voice) voice.muted = false;
    },
  };
  return session;
}

/**
 * The standard simulate routes (ARCHITECTURE.md §5) as director steps:
 * POST {base}, {base}/:id/say | dtmf | silence | hangup. Template-specific
 * step types go in `actions`, keyed by `step.action ?? step.type`.
 */
export function createSimulator({
  session,
  base = "/api/simulate",
  startBody = () => ({}),
  onSnapshot = () => {},
  actions = {},
} = {}) {
  const callId = () => {
    if (!session.id) throw new Error("Start a call first.");
    return session.id;
  };
  const done = (result) => {
    if (result?.snapshot) onSnapshot(result.snapshot);
    return result;
  };

  const api = {
    start: async (step = {}) => done(await session.start(() => postJson(base, startBody(step)))),
    say: async (text) => done(await postJson(`${base}/${callId()}/say`, { text })),
    dtmf: async (digit) => done(await postJson(`${base}/${callId()}/dtmf`, { digit: String(digit) })),
    silence: async () => done(await postJson(`${base}/${callId()}/silence`, {})),
    hangup: async () => {
      const result = done(await postJson(`${base}/${callId()}/hangup`, {}));
      session.end();
      return result;
    },
    async perform(step) {
      switch (step.type) {
        case "start":
          return api.start(step);
        case "say":
          return api.say(step.text);
        case "dtmf":
          return api.dtmf(step.digit);
        case "silence":
          return api.silence();
        case "hangup":
          return api.hangup();
        default: {
          const name = step.action ?? step.type;
          const handler = actions[name];
          if (!handler) throw new Error(`No handler for demo step "${name}".`);
          return handler(step);
        }
      }
    },
  };
  return api;
}

// ------------------------------------------------------------------- mode

/** Accepts the three `/health` shapes the templates use. */
export function isLive(health) {
  if (typeof health?.callReady === "boolean") return health.callReady;
  if (typeof health?.mode === "string") return health.mode === "live";
  if (typeof health?.simulationMode === "boolean") return !health.simulationMode;
  return false;
}

export function renderMode(el, health, { liveLabel = "live · Teams Phone" } = {}) {
  const live = isLive(health);
  const missing = health?.missingConfig ?? [];
  el.classList.add("pk-mode");
  el.dataset.live = String(live);
  el.textContent = live ? liveLabel : "simulation mode";
  el.title = live
    ? "Answering real calls through Teams Phone extensibility, with Azure Communication Services as the media bridge."
    : `Typed caller, the real policy code, a mock Teams client. Set ${
        missing.length ? missing.join(", ") : "the Azure settings"
      } to answer real calls.`;
  return live;
}

// ------------------------------------------------------------------ chips

const TONES = [
  ["ok", /(transferred|confirmed|booked|completed?|resolved|accepted|created|verified|committed|sent|success|done|answered|delivered|redeemed)/i],
  ["err", /(fallback|failed|error|refused|denied|rejected|blocked|expired|emergency)/i],
  ["warn", /(confirm|clarif|verif|waiting|pending|hold|stale|after.?hours|messag|escalat|paging)/i],
  ["accent", /(greet|classif|listen|active|talk|answer|lookup|search|transferring|in.?progress|ringing|intake|triage|collect)/i],
];

/** Best-guess tone for a state or event name. Pass an explicit tone to override. */
export function toneOf(name) {
  const text = String(name ?? "");
  for (const [tone, pattern] of TONES) if (pattern.test(text)) return tone;
  return "muted";
}

export function setStateChip(el, state, tone = toneOf(state)) {
  el.classList.add("state-chip");
  el.textContent = state ? String(state).replace(/_/g, " ") : "no call";
  el.dataset.tone = state ? tone : "idle";
}

export function chip(text, tone = "muted") {
  return `<span class="pk-chip" data-tone="${escapeHtml(tone)}">${escapeHtml(text)}</span>`;
}

// ---------------------------------------------------------------- visuals

/** Thin progress bar for a time budget. */
export function renderBudget(el, { elapsedMs = 0, budgetMs = 0 } = {}) {
  if (!budgetMs) {
    el.hidden = true;
    return;
  }
  if (!el.pkBudget) {
    el.classList.add("pk-budget");
    el.innerHTML = `<div class="pk-budget-bar"><span></span></div><span class="pk-budget-label"></span>`;
    el.pkBudget = { fill: el.querySelector(".pk-budget-bar span"), label: el.querySelector(".pk-budget-label") };
  }
  el.hidden = false;
  const ratio = Math.min(elapsedMs / budgetMs, 1);
  el.pkBudget.fill.style.width = `${ratio * 100}%`;
  el.pkBudget.fill.dataset.tone = ratio >= 1 ? "err" : ratio > 0.7 ? "warn" : "accent";
  el.pkBudget.label.textContent = `${Math.round(elapsedMs / 1000)}s / ${Math.round(budgetMs / 1000)}s`;
}

/**
 * A window that can still be undone — a transfer about to dispatch, a booking
 * about to commit — as a draining bar with a live seconds readout. It ticks
 * from a timer, not a CSS transition, because the OS often asks for reduced
 * motion (RDP sessions, dev boxes) and the kit then turns transitions off.
 *
 *   const win = createCountdown($("window"));
 *   win.start(1200, (left) => `Dispatching in ${left}`);  // left is "1.2s"
 *   win.stop("warn", "Cancelled — the caller changed their mind");  // freezes
 *   win.finish("ok", "Handed over");  // full bar
 *   win.hide();
 */
export function createCountdown(el, { tickMs = 100 } = {}) {
  el.classList.add("pk-countdown");
  el.innerHTML = `<div class="pk-countdown-bar"><span></span></div><span class="pk-countdown-label"></span>`;
  const fill = el.querySelector(".pk-countdown-bar span");
  const label = el.querySelector(".pk-countdown-label");
  let timer = null;
  let running = false;

  const halt = () => {
    clearInterval(timer);
    timer = null;
    running = false;
  };
  const show = (tone, text, ratio) => {
    el.hidden = false;
    el.dataset.tone = tone;
    label.textContent = text;
    if (ratio != null) fill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  };

  return {
    /** True until stop, finish or hide — it may read 0.0s while the server dispatches. */
    get running() {
      return running;
    },
    /** `words(left, leftMs)` writes the label on every tick; `left` reads like "0.8s". */
    start(ms, words, { tone = "accent" } = {}) {
      halt();
      const ends = performance.now() + ms;
      const tick = () => {
        const leftMs = Math.max(0, ends - performance.now());
        show(tone, words(`${(leftMs / 1000).toFixed(1)}s`, leftMs), ms > 0 ? leftMs / ms : 0);
        if (!leftMs) clearInterval(timer);
      };
      running = true;
      tick();
      timer = setInterval(tick, tickMs);
    },
    /** Freeze the bar where it is, with the reason. No-op when hidden. */
    stop(tone, text) {
      if (el.hidden) return;
      halt();
      show(tone, text, null);
    },
    /** Fill the bar and say how it ended. */
    finish(tone, text) {
      halt();
      show(tone, text, 1);
    },
    hide() {
      halt();
      el.hidden = true;
    },
  };
}

/**
 * What the AI decided, in one glance: a headline, the reason, and a verdict
 * chip. Leave `headline` empty to show the placeholder.
 */
export function renderDecision(el, { headline = "", why = "", verdict = "", tone = "muted", empty = "Nothing decided yet." } = {}) {
  el.classList.add("pk-decision");
  if (blank(headline)) {
    el.innerHTML = `<p class="pk-empty">${escapeHtml(empty)}</p>`;
    return;
  }
  el.innerHTML = `<p class="pk-headline">${escapeHtml(headline)}</p>${
    why ? `<p class="pk-why">${escapeHtml(why)}</p>` : ""
  }${verdict ? `<span class="pk-verdict" data-tone="${escapeHtml(tone)}">${escapeHtml(verdict)}</span>` : ""}`;
}

/**
 * A value against a gate — confidence vs threshold, minutes vs SLA. The gate
 * is the point: it shows the *server* decided, not the model.
 */
export function renderGauge(
  el,
  { value = null, gate = null, min = 0, max = 1, label = "gate", format = (v) => Number(v).toFixed(2), passes } = {},
) {
  if (!el.pkGauge) {
    el.classList.add("pk-gauge");
    el.innerHTML = `
      <div class="pk-gauge-bar"><span class="pk-gauge-fill"></span><span class="pk-gauge-gate"></span></div>
      <div class="pk-gauge-legend"><span class="pk-gauge-value"></span><span class="pk-gauge-label muted"></span></div>`;
    el.pkGauge = {
      fill: el.querySelector(".pk-gauge-fill"),
      gate: el.querySelector(".pk-gauge-gate"),
      value: el.querySelector(".pk-gauge-value"),
      label: el.querySelector(".pk-gauge-label"),
    };
  }
  const g = el.pkGauge;
  const pct = (v) => `${Math.max(0, Math.min(1, (v - min) / (max - min))) * 100}%`;
  const pass = value != null && gate != null && (passes ? passes(value, gate) : value >= gate);
  g.fill.style.width = value == null ? "0" : pct(value);
  g.fill.dataset.tone = value == null || gate == null ? "accent" : pass ? "ok" : "warn";
  g.gate.hidden = gate == null;
  if (gate != null) g.gate.style.left = pct(gate);
  g.value.textContent = value == null ? "—" : format(value);
  g.label.innerHTML = gate == null ? escapeHtml(label) : `${escapeHtml(label)} <b>${escapeHtml(format(gate))}</b>`;
  return pass;
}

/** Definition list. Rows are `[label, value, { html, tone }]`; falsy rows are skipped. */
export function renderFacts(el, rows) {
  el.classList.add("pk-facts");
  el.innerHTML = rows
    .filter(Boolean)
    .map(([label, value, opts = {}]) => {
      const shown = blank(value) ? "—" : opts.html ? value : escapeHtml(value);
      return `<div${opts.tone ? ` data-tone="${escapeHtml(opts.tone)}"` : ""}><dt>${escapeHtml(label)}</dt><dd>${shown}</dd></div>`;
    })
    .join("");
}

const CHECK_ICONS = { ok: "✓", err: "✕", warn: "!", idle: "○", accent: "•" };

/**
 * Policy gates as a checklist: `{ label, detail, tone }` where tone is
 * ok | warn | err | idle. Use it to show *why* the agent may (not) act.
 */
export function renderChecks(el, items) {
  el.classList.add("pk-checks");
  el.innerHTML = items
    .filter(Boolean)
    .map(({ label, detail = "", tone = "idle" }) => {
      const icon = CHECK_ICONS[tone] ?? CHECK_ICONS.idle;
      return `<li data-tone="${escapeHtml(tone)}"><span class="pk-check-icon" aria-hidden="true">${icon}</span>
        <span><strong>${escapeHtml(label)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</span></li>`;
    })
    .join("");
}

/**
 * Options the agent can choose between — routes, queues, slots, locations.
 * Items: `{ label, meta, status, tone, active }`.
 */
export function renderList(el, items, { empty = "Nothing to show." } = {}) {
  el.classList.add("pk-list");
  if (!items.length) {
    el.innerHTML = `<li class="pk-empty">${escapeHtml(empty)}</li>`;
    return;
  }
  el.innerHTML = items
    .map(
      ({ label, meta = "", status = "", tone = "muted", active = false }) =>
        `<li${active ? ' data-active="true"' : ""}>
          <span>${escapeHtml(label)}${meta ? ` <small>${escapeHtml(meta)}</small>` : ""}</span>
          ${status ? `<span class="pk-status" data-tone="${escapeHtml(tone)}">${escapeHtml(status)}</span>` : ""}
        </li>`,
    )
    .join("");
}

/** The metrics footer. Items are `[label, value]`. */
export function renderMetrics(el, items) {
  el.classList.add("pk-metrics");
  el.innerHTML = items
    .filter(Boolean)
    .map(([label, value]) => `<div><b>${escapeHtml(blank(value) ? "—" : value)}</b>${escapeHtml(label)}</div>`)
    .join("");
}

// -------------------------------------------------------------- transcript

/**
 * Chat-style transcript. Agent lines are spoken through `voice` (if any);
 * caller lines are spoken by the director *before* they are sent, so they are
 * never spoken twice.
 */
export function createTranscript(list, { voice = null, labels = {}, empty = "" } = {}) {
  list.classList.add("pk-transcript");
  const names = { caller: "Caller", agent: "Agent", system: "", ...labels };
  const scroll = () => {
    list.scrollTop = list.scrollHeight;
  };
  const clearEmpty = () => list.querySelector(".pk-empty")?.remove();

  const api = {
    add(role, text, { speak = true, label } = {}) {
      if (blank(text)) return null;
      clearEmpty();
      const li = document.createElement("li");
      li.className = role;
      const who = label ?? names[role] ?? role;
      li.innerHTML = `${who ? `<span class="who">${escapeHtml(who)}</span>` : ""}${escapeHtml(text)}`;
      list.append(li);
      scroll();
      if (speak && role === "agent") voice?.speak("agent", text);
      return li;
    },
    system(text) {
      return api.add("system", text, { speak: false });
    },
    /** A tool call the agent made, shown inline: ⚙ lookup_case · SR-26-0193 */
    tool(name, detail = "", tone = "accent") {
      clearEmpty();
      const li = document.createElement("li");
      li.className = "tool";
      li.innerHTML = `<span class="pk-tool" data-tone="${escapeHtml(tone)}">⚙ ${escapeHtml(name)}</span>${
        detail ? ` <span class="muted">${escapeHtml(detail)}</span>` : ""
      }`;
      list.append(li);
      scroll();
      return li;
    },
    clear(message = empty) {
      list.innerHTML = message ? `<li class="pk-empty">${escapeHtml(message)}</li>` : "";
    },
  };
  api.clear();
  return api;
}

// ------------------------------------------------------------------ trail

const GOOD = /(confirmed|succeeded|simulated|created|booked|resolved|accepted|verified|completed|committed|sent|delivered|redeemed)/i;
const BAD = /(failed|rejected|expired|fallback|denied|refused|error|blocked|declined|emergency)/i;
const WARN = /(clarif|retry|stale|caveat|warn|pending|hold|human_requested|after_hours|guard|low_confidence|changed|diverted|no_input|out_of_scope)/i;

/**
 * The audit trail as it happens. Matching rules may be strings or RegExps.
 * `timeZone` (a zone name, or a function returning one) shows the times in
 * the zone the policy runs in — the demo clock's — rather than the laptop's.
 */
export function createTrail(list, { good = [], bad = [], warn = [], empty = "Nothing yet.", timeZone = null } = {}) {
  list.classList.add("pk-trail");
  const hit = (rules, kind) => rules.some((r) => (r instanceof RegExp ? r.test(kind) : r === kind));
  const toneFor = (kind) =>
    hit(bad, kind) ? "err"
      : hit(good, kind) ? "ok"
        : hit(warn, kind) ? "warn"
          : BAD.test(kind) ? "err"
            : GOOD.test(kind) ? "ok"
              : WARN.test(kind) ? "warn"
                : "";

  const api = {
    add({ source = "", kind = "", detail = "", at } = {}) {
      list.querySelector(".pk-empty")?.remove();
      const li = document.createElement("li");
      li.dataset.source = source;
      li.dataset.kind = kind;
      const tone = toneFor(kind);
      if (tone) li.dataset.tone = tone;
      const time = new Date(at ?? Date.now());
      const zone = (typeof timeZone === "function" ? timeZone() : timeZone) || undefined;
      const options = { hour: "2-digit", minute: "2-digit", second: "2-digit" };
      let clock = "";
      if (!Number.isNaN(time.getTime())) {
        try {
          clock = time.toLocaleTimeString([], { ...options, timeZone: zone });
        } catch {
          clock = time.toLocaleTimeString([], options); // unknown zone name
        }
      }
      const text = typeof detail === "string" ? detail : detail == null ? "" : JSON.stringify(detail);
      li.innerHTML = `<span class="at">${escapeHtml(clock)}</span><span class="kind">${escapeHtml(
        kind,
      )}</span><span class="detail">${escapeHtml(text)}</span>`;
      list.append(li);
      list.scrollTop = list.scrollHeight;
      return li;
    },
    clear() {
      list.innerHTML = empty ? `<li class="pk-empty">${escapeHtml(empty)}</li>` : "";
    },
  };
  api.clear();
  return api;
}

// ---------------------------------------------------------------- Teams

/**
 * The mock Teams incoming-call toast: what the person who picks up sees.
 * `callerHtml` is trusted markup built by the template (escape your values).
 */
export function renderTeamsToast(
  el,
  {
    queue = "",
    subtitle = "",
    topic = "",
    context = "",
    sentiment = "",
    callerHtml = "",
    avatar,
    tags = [],
    status = "Incoming call",
  } = {},
) {
  el.hidden = false;
  el.classList.add("pk-toast");
  const initial = escapeHtml(String(avatar ?? queue ?? "?").trim().charAt(0).toUpperCase() || "?");
  el.innerHTML = `
    <div class="pk-toast-head">
      <span class="pk-avatar">${initial}</span>
      <div><strong>${escapeHtml(queue)}</strong><span class="muted">${escapeHtml(subtitle)}</span></div>
      <span class="pk-ringing">${escapeHtml(status)}</span>
    </div>
    ${topic ? `<p class="pk-topic">${escapeHtml(topic)}</p>` : ""}
    ${context ? `<p class="pk-context">${escapeHtml(context)}</p>` : ""}
    ${tags.length ? `<div class="pk-tags">${tags.map((t) => (typeof t === "string" ? chip(t) : chip(t.text, t.tone))).join("")}</div>` : ""}
    ${sentiment ? `<p class="pk-sentiment">${escapeHtml(sentiment)}</p>` : ""}
    ${callerHtml ? `<div class="pk-caller-card">${callerHtml}</div>` : ""}
    <div class="pk-toast-actions"><button class="pk-accept" type="button" tabindex="-1" disabled>Accept</button></div>`;
  el.classList.remove("pk-arrive");
  void el.offsetWidth; // restart the arrival animation
  el.classList.add("pk-arrive");
}

/** Hide the toast and show the placeholder element, if any. */
export function clearTeamsToast(el, placeholder = null) {
  el.hidden = true;
  el.innerHTML = "";
  if (placeholder) placeholder.hidden = false;
}

/** The literal VoIP headers behind the toast. Pairs are `[key, value]`; empty values are dropped. */
export function renderHeaders(pre, pairs) {
  pre.classList.add("pk-headers");
  const rows = pairs.filter(([, v]) => !blank(v) && v !== false);
  pre.innerHTML = rows.length
    ? rows
        .map(([k, v]) => `<b>${escapeHtml(k)}</b>: ${escapeHtml(typeof v === "string" ? v : JSON.stringify(v))}`)
        .join("\n")
    : "—";
}

// ------------------------------------------------------------ stack strip

/**
 * The Microsoft voice stack the template runs on, in call order. In
 * simulation mode every node says honestly what is standing in for it.
 */
export function voiceStack({
  caller = "Caller",
  callerLive = "PSTN · any phone",
  callerSim = "typed in this console",
  voiceLive = "gpt-realtime",
  tools = "Template tools",
  toolsLive = "",
  toolsSim = "real policy code",
  agent = "Teams agent",
  agentLive = "context in VoIP headers",
  agentSim = "mock toast",
} = {}) {
  return [
    { id: "caller", title: caller, live: callerLive, sim: callerSim },
    { id: "teams-phone", title: "Teams Phone", live: "service number", sim: "not connected", brand: "teams", simOff: true },
    { id: "acs", title: "Call Automation", live: "ACS media bridge", sim: "not connected", simOff: true },
    { id: "voice-live", title: "Voice Live", live: voiceLive, sim: "offline stand-in" },
    { id: "tools", title: tools, live: toolsLive || toolsSim, sim: toolsSim },
    { id: "teams-agent", title: agent, live: agentLive, sim: agentSim, brand: "teams" },
  ];
}

const TOOL_EVENT =
  /(tool|lookup|search|create|book|ticket|case|quote|price|crm|hris|page|propos|commit|transfer|verif|redeem|hold|cite|kb|lead|confirm|cancel|resched|incident|update|draft|route|dtmf)/i;

export function mountStack(el, { live = false, nodes = voiceStack() } = {}) {
  el.classList.add("pk-stack");
  el.setAttribute("aria-label", "Voice stack");
  const nodeEl = (id) => el.querySelector(`[data-node="${id}"]`);

  const render = (isLiveNow) => {
    el.dataset.live = String(isLiveNow);
    el.innerHTML = nodes
      .map(
        (n, i) => `${i ? '<span class="pk-stack-arrow" aria-hidden="true"></span>' : ""}
        <div class="pk-node" data-node="${escapeHtml(n.id)}"${n.brand ? ` data-brand="${escapeHtml(n.brand)}"` : ""}${
          !isLiveNow && n.simOff ? ' data-off="true"' : ""
        }>
          <strong>${escapeHtml(n.title)}</strong><span>${escapeHtml(isLiveNow ? n.live : n.sim)}</span>
        </div>`,
      )
      .join("");
  };
  render(live);

  const api = {
    setLive: render,
    pulse(id) {
      const node = nodeEl(id);
      if (!node) return;
      node.classList.remove("pulse");
      void node.offsetWidth; // restart the animation
      node.classList.add("pulse");
    },
    async flow(ids, gap = 120) {
      for (const id of ids) {
        api.pulse(id);
        await sleep(gap);
      }
    },
    note(id, text) {
      const span = nodeEl(id)?.querySelector("span");
      if (span) span.textContent = text;
    },
    /** Default animation for hub traffic; call it from your hub handler. */
    onHub(target, payload = {}) {
      if (target === "transcript") {
        if (payload.role === "caller") api.flow(["caller", "teams-phone", "acs", "voice-live"]);
        else if (payload.role === "agent") api.flow(["voice-live", "acs", "teams-phone", "caller"]);
      } else if (target === "event" && TOOL_EVENT.test(payload.kind ?? "")) {
        api.flow(["voice-live", "tools"]);
      } else if (target === "handoff") {
        api.flow(["tools", "acs", "teams-agent"]);
      }
    },
  };
  return api;
}

// ------------------------------------------------------------- demo clock

/**
 * The server's demo clock: `GET {url}` → `{ now, timeZone, preset, presets,
 * adjustable }`; `POST {url}` with `{ preset }` or `{ at }` moves it
 * (simulation only — the server answers 403 in live mode). Lets one running
 * server show both the in-hours and the after-hours path on stage.
 */
export function mountClock(el, { url = "/api/demo/clock", onChange = () => {} } = {}) {
  el.classList.add("pk-clock");
  el.innerHTML = `<span class="pk-clock-time" title="Demo clock — the time the template's policy code sees"></span><span class="pk-clock-presets"></span>`;
  const timeEl = el.querySelector(".pk-clock-time");
  const presetsEl = el.querySelector(".pk-clock-presets");
  let state = null;
  let fetchedAt = 0;
  let format = null;

  const tick = () => {
    if (!state || !format) return;
    timeEl.textContent = format.format(new Date(state.now + (performance.now() - fetchedAt)));
  };

  const apply = (data) => {
    state = { ...data, now: typeof data.now === "number" ? data.now : Date.parse(data.now) };
    fetchedAt = performance.now();
    const options = { weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" };
    try {
      format = new Intl.DateTimeFormat(undefined, { ...options, timeZone: state.timeZone });
    } catch {
      format = new Intl.DateTimeFormat(undefined, options);
    }
    el.hidden = false;
    el.dataset.pinned = String(Boolean(state.preset && state.preset !== "real"));
    presetsEl.innerHTML =
      state.adjustable === false
        ? ""
        : (state.presets ?? [])
            .map(
              (p) =>
                `<button type="button" data-preset="${escapeHtml(p.id)}" aria-pressed="${p.id === state.preset}">${escapeHtml(
                  p.label,
                )}</button>`,
            )
            .join("");
    tick();
    onChange(state);
    return state;
  };

  presetsEl.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-preset]");
    if (!button) return;
    try {
      apply(await postJson(url, { preset: button.dataset.preset }));
    } catch (error) {
      notify(error.message, "err");
    }
  });
  setInterval(tick, 10_000);

  const api = {
    async refresh() {
      try {
        return apply(await getJson(url));
      } catch {
        el.hidden = true;
        return null;
      }
    },
    async set(body) {
      return apply(await postJson(url, body));
    },
    get state() {
      return state;
    },
  };
  api.refresh();
  return api;
}

// ------------------------------------------------------------------ voice

const AGENT_VOICE = /(aria|jenny|ava|emma|zira|samantha|karen|moira|tessa|susan|hazel|sonia|libby|michelle|allison|victoria|paulina|helena|dalia|female)/i;
const CALLER_VOICE = /(guy|davis|david|mark|daniel|alex|fred|tom|george|ryan|eric|aaron|james|oliver|rishi|jorge|pablo|raul|male)/i;

/**
 * Browser speech so the room *hears* a voice product, not a chat box.
 * Modes: off | agent | both (agent + caller). The real call uses Voice Live;
 * this is a presenter aid. On-device voices only, unless the page is opened
 * with `?voices=online` (online voices send the synthetic lines to the
 * browser vendor's speech service — in Edge that is the Azure neural voices).
 */
export function createVoice(select, { lang = "en-US", storageKey = "pk-voice" } = {}) {
  const synth = globalThis.speechSynthesis;
  const supported = Boolean(synth && globalThis.SpeechSynthesisUtterance);
  const allowOnline = new URLSearchParams(location.search).get("voices") === "online";
  const voices = { agent: null, caller: null };
  let language = lang;
  let mode = "off";
  let generation = 0;
  let queue = Promise.resolve();
  let pending = 0;

  try {
    mode = localStorage.getItem(storageKey) ?? (allowOnline ? "both" : "off");
  } catch {
    mode = "off";
  }

  const pick = () => {
    if (!supported) return;
    const wanted = language.toLowerCase();
    const all = synth.getVoices().filter((v) => allowOnline || v.localService);
    const norm = (v) => String(v.lang ?? "").toLowerCase().replace("_", "-");
    const exact = all.filter((v) => norm(v) === wanted);
    const pool = exact.length ? exact : all.filter((v) => norm(v).startsWith(wanted.split("-")[0]));
    const best = (re) =>
      pool.find((v) => re.test(v.name) && /natural|neural|premium|enhanced/i.test(v.name)) ?? pool.find((v) => re.test(v.name));
    voices.agent = best(AGENT_VOICE) ?? pool[0] ?? null;
    voices.caller =
      best(CALLER_VOICE) ?? pool.find((v) => v !== voices.agent) ?? voices.agent;
    if (select) {
      const none = !voices.agent;
      select.disabled = none;
      select.title = none
        ? `No ${allowOnline ? "" : "on-device "}voice for ${language} in this browser.`
        : `Browser speech for the room — agent: ${voices.agent.name}${
            voices.caller && voices.caller !== voices.agent ? `, caller: ${voices.caller.name}` : ""
          }. Real calls use Voice Live.`;
    }
  };

  if (select) {
    select.classList.add("pk-voice");
    select.innerHTML = `
      <option value="off">Voice off</option>
      <option value="agent">Speak agent</option>
      <option value="both">Speak agent + caller</option>`;
    select.value = supported ? mode : "off";
    select.disabled = !supported;
    select.addEventListener("change", () => {
      mode = select.value;
      try {
        localStorage.setItem(storageKey, mode);
      } catch {
        /* private mode */
      }
      if (mode === "off") api.cancel();
    });
  }
  if (supported) {
    pick();
    synth.addEventListener?.("voiceschanged", pick);
  } else {
    mode = "off";
  }

  const utter = (role, text) =>
    new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = voices[role] ?? voices.agent;
      if (v) {
        u.voice = v;
        u.lang = v.lang;
      } else {
        u.lang = language;
      }
      if (role === "caller" && voices.caller === voices.agent) u.pitch = 0.75;
      u.rate = role === "caller" ? 1.06 : 1.0;
      // onend is unreliable in some browsers; never let the director hang on it.
      const timer = setTimeout(resolve, 2500 + text.length * 90);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      u.onend = finish;
      u.onerror = finish;
      synth.speak(u);
    });

  const speakNow = async (role, text, gen) => {
    // Sentence by sentence: long utterances get cut off in some browsers.
    const parts = String(text).match(/[^.!?]+[.!?]*\s*/g) ?? [String(text)];
    for (const part of parts) {
      if (gen !== generation) return;
      const clean = part.trim();
      if (clean) await utter(role, clean);
    }
  };

  const api = {
    get mode() {
      return mode;
    },
    /** Set while following a real call: the room hears the real audio instead. */
    muted: false,
    speak(role, text) {
      if (!supported || api.muted || mode === "off" || blank(text) || !voices.agent) return Promise.resolve();
      if (role !== "agent" && mode !== "both") return Promise.resolve();
      const gen = generation;
      pending += 1;
      const run = queue
        .then(() => speakNow(role, text, gen))
        .finally(() => {
          pending -= 1;
        });
      queue = run.catch(() => {});
      return run;
    },
    async idle() {
      while (pending > 0) await queue;
    },
    cancel() {
      generation += 1;
      synth?.cancel();
    },
    /** Switch language mid-demo (a Spanish-speaking caller, say). */
    setLang(next) {
      language = next || lang;
      pick();
    },
  };
  return api;
}

// --------------------------------------------------------------- director

const STOPPED = "presenter-kit:stopped";

function describe(step) {
  if (step.label) return step.label;
  switch (step.type) {
    case "start":
      return "Answer a new call";
    case "say":
      return `Caller says “${step.text}”`;
    case "dtmf":
      return `Caller presses ${step.digit} on the keypad`;
    case "silence":
      return "Caller says nothing";
    case "hangup":
      return "Caller hangs up";
    case "wait":
      return `Pause ${Math.round((step.ms ?? 1000) / 1000)}s`;
    default:
      return step.action ?? step.type;
  }
}

/**
 * The demo script, on screen. Numbered beats; each beat is a list of steps.
 * Next ▶ (or →, PageDown, a presenter clicker) runs one step. Auto-play runs
 * the rest of the beat, waiting for the hub to go quiet and the agent to
 * finish speaking between steps. 1–9 jump to a beat, PageUp goes back, Esc
 * stops, N hides or shows the narration.
 *
 * Beat:  { title, talk, after?, prepare?: async () => void, steps: Step[] }
 * Step:  { type: "start" | "say" | "dtmf" | "silence" | "hangup" | "action" | "note" | "wait",
 *          text?, digit?, action?, label?, cue?, ms?, chain? }
 *   talk  — narration shown while the beat runs (written for the room)
 *   cue   — narration for one step, shown while that step is next
 *   after — narration once the beat is done (what to point at)
 *   chain — run straight after the previous step, without waiting for Next
 *           (for timing-sensitive moments such as a mind change)
 *
 * `perform(step)` executes call steps (see createSimulator). The director
 * handles say (typewriter + caller voice), note and wait itself.
 */
export function createDirector(
  root,
  { beats = [], perform, voice = null, sayInput = null, settleMs = 650, dwellMs = 900, onBeat = null } = {},
) {
  let beatIndex = 0;
  let stepIndex = 0;
  let prepared = false;
  let busy = false;
  let auto = false;
  let token = 0;
  let loads = 0;
  let notes = true;

  try {
    notes = localStorage.getItem("pk-notes") !== "off";
  } catch {
    notes = true;
  }

  root.classList.add("pk-director");
  root.innerHTML = `
    <div class="pk-director-head">
      <span class="pk-director-title">Demo script</span>
      <ol class="pk-beats"></ol>
      <div class="pk-director-actions">
        <button type="button" class="ghost pk-notes" title="Show or hide the narration (N)">Notes</button>
        <button type="button" class="ghost pk-auto" title="Play the rest of this beat">Auto-play</button>
        <button type="button" class="primary pk-next" title="Run the next step (→ or PageDown)">Next ▶</button>
      </div>
    </div>
    <div class="pk-director-body">
      <p class="pk-talk"></p>
      <p class="pk-upnext"></p>
    </div>`;

  const beatsEl = root.querySelector(".pk-beats");
  const nextBtn = root.querySelector(".pk-next");
  const autoBtn = root.querySelector(".pk-auto");
  const notesBtn = root.querySelector(".pk-notes");
  const talkEl = root.querySelector(".pk-talk");
  const upNextEl = root.querySelector(".pk-upnext");

  beatsEl.innerHTML = beats
    .map(
      (beat, i) =>
        `<li><button type="button" data-beat="${i}" title="${escapeHtml(beat.title)} (key ${i + 1})"><b>${
          i + 1
        }</b><span>${escapeHtml(beat.title)}</span></button></li>`,
    )
    .join("");

  const stopped = () => Object.assign(new Error("stopped"), { code: STOPPED });
  const check = (t) => {
    if (t !== token) throw stopped();
  };

  // If every title can't fit, the strip keeps only the current beat's title and
  // scrolls sideways to keep it in view. It never scrolls the page.
  const fitBeats = () => {
    beatsEl.dataset.compact = "false";
    if (beatsEl.scrollWidth > beatsEl.clientWidth + 1) beatsEl.dataset.compact = "true";
    const current = beatsEl.querySelector('[aria-current="step"]');
    if (!current) return;
    const strip = beatsEl.getBoundingClientRect();
    const box = current.getBoundingClientRect();
    if (box.left < strip.left) beatsEl.scrollLeft -= strip.left - box.left + 8;
    else if (box.right > strip.right) beatsEl.scrollLeft += box.right - strip.right + 8;
  };
  if (typeof ResizeObserver === "function") new ResizeObserver(fitBeats).observe(beatsEl);

  const render = () => {
    const beat = beats[beatIndex];
    const steps = beat?.steps ?? [];
    const finished = stepIndex >= steps.length;
    for (const button of beatsEl.querySelectorAll("button")) {
      const i = Number(button.dataset.beat);
      button.dataset.state = i === beatIndex ? (finished ? "done" : "current") : i < beatIndex ? "done" : "";
      button.setAttribute("aria-current", i === beatIndex ? "step" : "false");
    }
    fitBeats();
    const last = beatIndex >= beats.length - 1;
    nextBtn.disabled = busy || (finished && last);
    nextBtn.textContent = busy ? "Running…" : finished ? (last ? "Script complete" : "Next beat ▶") : "Next ▶";
    autoBtn.textContent = auto ? "Stop" : "Auto-play";
    autoBtn.disabled = (!auto && busy) || (finished && last);
    notesBtn.setAttribute("aria-pressed", String(notes));
    root.dataset.notes = String(notes);
    const step = steps[stepIndex];
    talkEl.textContent = step?.cue ?? (finished ? (beat?.after ?? beat?.talk ?? "") : (beat?.talk ?? ""));
    talkEl.hidden = !talkEl.textContent;
    upNextEl.innerHTML = step
      ? `<span>Next</span> ${escapeHtml(describe(step))}`
      : last
        ? `<span>Done</span> That's the script. Press 1 to start again.`
        : `<span>Up next</span> Beat ${beatIndex + 2} — ${escapeHtml(beats[beatIndex + 1].title)}`;
    root.dataset.busy = String(busy);
  };

  const typeInto = async (input, text, t) => {
    input.value = "";
    const perChar = Math.max(12, Math.min(34, 1100 / Math.max(text.length, 1)));
    for (const ch of text) {
      check(t);
      input.value += ch;
      await sleep(perChar);
    }
    await sleep(160);
  };

  const execute = async (step, t) => {
    switch (step.type) {
      case "note":
        return;
      case "wait":
        await sleep(step.ms ?? 1000);
        check(t);
        return;
      case "say": {
        if (step.chain) {
          // Timing-sensitive: send first, let the room hear it alongside.
          const sent = perform(step);
          voice?.speak("caller", step.text);
          await sent;
          return;
        }
        if (sayInput) await typeInto(sayInput, step.text, t);
        await voice?.speak("caller", step.text);
        check(t);
        try {
          await perform(step);
        } finally {
          if (sayInput) sayInput.value = "";
        }
        return;
      }
      default:
        await perform(step);
    }
  };

  const runStep = async (t) => {
    const beat = beats[beatIndex];
    // A beat jump while a request is in flight must not advance the new beat.
    const loadedAt = loads;
    const moved = () => {
      if (loadedAt !== loads) throw stopped();
    };
    busy = true;
    render();
    try {
      if (!prepared) {
        await beat.prepare?.();
        moved();
        prepared = true;
      }
      await execute(beat.steps[stepIndex], t);
      moved();
      stepIndex += 1;
      // Chained steps are timing-sensitive; run them before anyone can blink.
      while (beat.steps[stepIndex]?.chain) {
        check(t);
        await execute(beat.steps[stepIndex], t);
        moved();
        stepIndex += 1;
      }
      return true;
    } catch (error) {
      auto = false;
      if (error?.code !== STOPPED) notify(error?.message ?? String(error), "err", 6000);
      return false;
    } finally {
      busy = false;
      render();
    }
  };

  const settle = async (t) => {
    await hubQuiet(settleMs, 8000);
    await voice?.idle();
    check(t);
    await sleep(dwellMs);
    check(t);
  };

  const api = {
    load(index) {
      if (index < 0 || index >= beats.length) return;
      api.stop();
      loads += 1;
      beatIndex = index;
      stepIndex = 0;
      prepared = false;
      render();
      onBeat?.(beats[index], index);
    },
    async next() {
      if (busy) return;
      const beat = beats[beatIndex];
      if (!beat) return;
      if (stepIndex >= beat.steps.length) {
        if (beatIndex < beats.length - 1) api.load(beatIndex + 1);
        return;
      }
      await runStep(token);
    },
    async autoplay() {
      if (auto) return api.stop();
      if (busy) return;
      if (stepIndex >= (beats[beatIndex]?.steps.length ?? 0)) {
        if (beatIndex >= beats.length - 1) return;
        api.load(beatIndex + 1);
      }
      auto = true;
      const t = ++token;
      render();
      try {
        while (auto && t === token && stepIndex < beats[beatIndex].steps.length) {
          if (!(await runStep(t))) break;
          if (stepIndex >= beats[beatIndex].steps.length) break;
          await settle(t);
        }
      } catch (error) {
        if (error?.code !== STOPPED) notify(error?.message ?? String(error), "err", 6000);
      } finally {
        auto = false;
        render();
      }
    },
    stop() {
      auto = false;
      token += 1;
      voice?.cancel();
      render();
    },
    toggleNotes() {
      notes = !notes;
      try {
        localStorage.setItem("pk-notes", notes ? "on" : "off");
      } catch {
        /* private mode */
      }
      render();
    },
    get beat() {
      return beats[beatIndex];
    },
    get index() {
      return beatIndex;
    },
    get running() {
      return busy || auto;
    },
  };

  nextBtn.addEventListener("click", () => api.next());
  autoBtn.addEventListener("click", () => api.autoplay());
  notesBtn.addEventListener("click", () => api.toggleNotes());
  beatsEl.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-beat]");
    if (button) api.load(Number(button.dataset.beat));
  });

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const el = event.target instanceof Element ? event.target : null;
    const typing = Boolean(el?.closest("input, textarea, select, [contenteditable='true']"));
    const emptyField = typing && el.matches("input, textarea") && !el.value;
    if (event.key === "ArrowRight" || event.key === "PageDown") {
      if (typing && !emptyField) return;
      event.preventDefault();
      api.next();
    } else if (event.key === "PageUp") {
      if (typing && !emptyField) return;
      event.preventDefault();
      api.load(Math.max(0, beatIndex - (stepIndex === 0 ? 1 : 0)));
    } else if (event.key === "Escape") {
      api.stop();
    } else if (!typing && /^[1-9]$/.test(event.key)) {
      api.load(Number(event.key) - 1);
    } else if (!typing && (event.key === "n" || event.key === "N")) {
      api.toggleNotes();
    }
  });

  render();
  return api;
}
