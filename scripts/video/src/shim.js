// Injected into the console page before any of its scripts run (film capture).
//
// The presenter kit normally reads console lines aloud with browser speech.
// capture.mjs hooks the kit's speakNow() (see hookKit) so each whole line comes
// here instead, with its role and language. We "speak" it for exactly as long
// as its GPT Realtime recording lasts and log when it starts, so the soundtrack
// can be laid against the screen recording afterwards. Caller lines start when
// the console starts typing them, the way live captions appear while someone
// talks.
(() => {
  const now = () => performance.timeOrigin + performance.now();
  const send = (event) => {
    try {
      window.__filmLog?.(JSON.stringify(event));
    } catch {
      /* not exposed (screenshot tools) */
    }
  };
  window.__filmMark = (kind, data = {}) => send({ kind, at: now(), ...data });

  // ---- a timecode in every frame. The screencast delivers frames late, by
  // more when the page is busy, so capture.mjs reads this strip back to know
  // when each frame's content was current, then crops it off. A canvas, so the
  // activity watcher below never sees it change.
  const clock = window.__FILM_CLOCK__;
  if (clock) {
    const startClock = () => {
      const canvas = document.createElement("canvas");
      canvas.width = clock.bits;
      canvas.height = 1;
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.cssText =
        `position:fixed;left:0;bottom:0;margin:0;border:0;width:${clock.bits * clock.block}px;height:${clock.height}px;` +
        "z-index:2147483647;pointer-events:none;image-rendering:pixelated;";
      document.documentElement.appendChild(canvas);
      const g = canvas.getContext("2d");
      const img = g.createImageData(clock.bits, 1);
      const paint = () => {
        // [white, black] markers, 24 bits of the time in ms, even parity.
        const code = Math.round(now()) % 2 ** 24;
        const bits = [1, 0];
        let parity = 0;
        for (let i = 23; i >= 0; i--) {
          const b = Math.floor(code / 2 ** i) % 2;
          parity ^= b;
          bits.push(b);
        }
        bits.push(parity);
        bits.forEach((b, i) => {
          img.data.fill(b ? 255 : 0, i * 4, i * 4 + 3);
          img.data[i * 4 + 3] = 255;
        });
        g.putImageData(img, 0, 0);
        requestAnimationFrame(paint);
      };
      requestAnimationFrame(paint);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startClock);
    else startClock();
  }

  try {
    localStorage.setItem("pk-voice", "both");
    localStorage.setItem("pk-notes", window.__FILM_NOTES__ === "on" ? "on" : "off");
  } catch {
    /* ignore */
  }

  // ---- hub activity, mirroring presenter-kit hubQuiet()
  let lastHubAt = 0;
  const NativeWS = window.WebSocket;
  window.WebSocket = class extends NativeWS {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", () => {
        lastHubAt = performance.now();
      });
    }
  };
  window.__filmHubQuiet = async (quietMs = 650, maxMs = 8000) => {
    const started = performance.now();
    await new Promise((r) => setTimeout(r, Math.min(quietMs, 200)));
    while (performance.now() - started < maxMs) {
      if (performance.now() - lastHubAt >= quietMs) return true;
      await new Promise((r) => setTimeout(r, 60));
    }
    return false;
  };

  // ---- when typing into each field began
  const typedAt = new WeakMap();
  const watchInputs = () => {
    for (const el of document.querySelectorAll("input, textarea")) {
      const v = el.value ?? "";
      const seen = typedAt.get(el);
      if (v && (!seen || !seen.value)) {
        typedAt.set(el, { value: v, at: now() });
        noteChange(el, "typing");
      } else if (!v) typedAt.set(el, { value: "", at: 0 });
      else if (seen) seen.value = v;
    }
    requestAnimationFrame(watchInputs);
  };
  const norm = (s) => String(s).replace(/\s+/g, " ").trim().toLowerCase();
  const typedFor = (text) => {
    const want = norm(text);
    for (const el of document.querySelectorAll("input, textarea")) {
      if (norm(el.value ?? "") === want) return typedAt.get(el)?.at || 0;
    }
    return 0;
  };

  // ---- what is changing on the console, and where, for the film's camera.
  // Clocks, timers and progress bars change every second. A change that only
  // alters digits, or only restyles an element with no text, is a tick rather
  // than news, so it doesn't pull the camera.
  const REGIONS = "main.grid section.card, #stack, #metrics, #director, header.top";
  const regionOf = (el) => {
    const box = el?.closest?.(REGIONS);
    if (!box) return null;
    if (box.matches("section.card")) return [...box.classList].find((c) => c !== "card") ?? "card";
    return box.id || "top";
  };
  const digitless = (s) => String(s ?? "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  // An element's words as last seen, digits masked. A timer label rewritten
  // with the same words (even via several mutations) compares equal: a tick.
  const lastWords = new WeakMap();
  const seedWords = () => {
    for (const el of document.querySelectorAll("body *")) lastWords.set(el, digitless(el.textContent));
  };
  const visible = (el) => {
    const r = el?.getBoundingClientRect?.();
    return r && r.width > 1 && r.height > 1 ? r : null;
  };
  const pending = new Map();
  const flush = () => {
    for (const p of pending.values()) send({ kind: "activity", region: p.region, at: p.at, what: p.what, change: p.change, rect: p.rect });
    pending.clear();
  };
  let flushTimer = null;
  // "content" is new words, a new row, a card appearing; "state" is a class or
  // data-state flip (a status pill, a highlighted card). The camera follows content.
  const CONTENT = new Set(["added", "text", "typing", "hidden", "open", "aria-hidden"]);
  function noteChange(el, what) {
    const region = regionOf(el);
    const r = visible(el);
    if (!region || !r) return;
    const change = CONTENT.has(what) ? "content" : "state";
    const rect = { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
    const key = `${region}|${change}`;
    const p = pending.get(key);
    if (!p) pending.set(key, { region, change, at: now(), what, rect });
    else {
      const x = Math.min(p.rect.x, rect.x);
      const y = Math.min(p.rect.y, rect.y);
      p.rect = { x, y, w: Math.max(p.rect.x + p.rect.w, rect.x + rect.w) - x, h: Math.max(p.rect.y + p.rect.h, rect.y + rect.h) - y };
      if (what === "typing" || what === "added") p.what = what;
    }
    flushTimer ??= setTimeout(() => {
      flushTimer = null;
      flush();
    }, 220);
  }
  const watchActivity = () => {
    seedWords();
    new MutationObserver((records) => {
      const hosts = new Map();
      for (const r of records) {
        if (r.type === "attributes") {
          // A restyled element with no words is a progress bar or a pulse.
          if (r.attributeName === "style" && !(r.target.textContent ?? "").trim()) continue;
          noteChange(r.target, r.attributeName);
          continue;
        }
        const host = r.type === "characterData" ? r.target.parentElement : r.target;
        if (!host) continue;
        const added = hosts.get(host) ?? [];
        for (const n of r.addedNodes ?? []) if (n.nodeType === 1) added.push(n);
        hosts.set(host, added);
      }
      for (const [host, added] of hosts) {
        const words = digitless(host.textContent);
        const before = lastWords.get(host);
        lastWords.set(host, words);
        for (const n of added) for (const el of [n, ...n.querySelectorAll("*")]) lastWords.set(el, digitless(el.textContent));
        if (before === words) continue;
        const shown = added.filter((n) => n.isConnected && visible(n));
        if (shown.length) for (const n of shown) noteChange(n, "added");
        else noteChange(host, "text");
      }
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "open", "data-state", "data-status", "aria-hidden", "aria-expanded", "disabled"],
    });
    requestAnimationFrame(watchInputs);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchActivity);
  else watchActivity();

  // ---- lines from the hooked presenter kit (it queues them one at a time)
  let current = null;
  let queued = 0;
  window.__filmVoiceIdle = () => queued === 0;

  window.__filmUtter = (role, text, lang) =>
    new Promise((resolve) => {
      queued += 1;
      const line = { done: false, timer: null };
      line.end = () => {
        if (line.done) return;
        line.done = true;
        clearTimeout(line.timer);
        if (current === line) current = null;
        queued = Math.max(0, queued - 1);
        resolve();
      };
      current = line;
      const called = now();
      const typed = role === "caller" ? typedFor(text) : 0;
      (async () => {
        let reply = { ms: Math.max(900, text.length * 62), cached: false };
        try {
          reply = { ...reply, ...JSON.parse(await window.__filmSpeak(JSON.stringify({ role, lang, text }))) };
        } catch (e) {
          console.error("film voice:", e);
        }
        if (line.done) return; // cut while it was being performed
        const ready = now();
        // A caller's recording starts with the typewriter (unless we had to wait
        // for it to be performed); an agent's starts when the kit asks for it.
        const at = role === "caller" && typed && reply.cached ? typed : ready;
        line.speak = { kind: "speak", role, lang, text, at, calledAt: called, readyAt: ready, ms: reply.ms, cached: reply.cached, key: reply.key, speaker: reply.speaker, voice: reply.voice };
        send(line.speak);
        const tail = role === "caller" ? 260 : 340;
        line.timer = setTimeout(line.end, Math.max(0, at + reply.ms + tail - now()));
      })();
    });

  // ---- browser speech: voices for the kit to pick, and cancel()
  const LANGS = ["en-US", "en-GB", "es-US", "es-MX", "es-ES", "fr-FR", "fr-CA", "de-DE", "pt-BR", "it-IT", "zh-CN", "ja-JP", "ko-KR", "vi-VN", "hi-IN"];
  const voices = [];
  for (const lang of LANGS) {
    voices.push(
      { name: `Aria (film agent, ${lang})`, lang, localService: true, default: lang === "en-US", voiceURI: `film-agent-${lang}` },
      { name: `Guy (film caller, ${lang})`, lang, localService: true, default: false, voiceURI: `film-caller-${lang}` },
    );
  }

  class FilmUtterance extends EventTarget {
    constructor(text = "") {
      super();
      Object.assign(this, { text, voice: null, lang: "", pitch: 1, rate: 1, volume: 1, onend: null, onerror: null, onstart: null });
    }
  }

  const synth = {
    speaking: false,
    pending: false,
    paused: false,
    onvoiceschanged: null,
    getVoices: () => voices.slice(),
    addEventListener() {},
    removeEventListener() {},
    // Only reached if the kit was not hooked: never hang, but say so.
    speak(u) {
      send({ kind: "unhooked", at: now(), text: String(u?.text ?? "") });
      setTimeout(() => u?.onend?.call(u, { type: "end", utterance: u }), 0);
    },
    cancel() {
      const line = current;
      if (line && !line.done) {
        if (line.speak) send({ kind: "cut", at: now(), key: line.speak.key, text: line.speak.text });
        line.end();
      }
    },
    pause() {},
    resume() {},
  };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = FilmUtterance;
})();
