// The film as a HyperFrames composition (index.html): the scenes around the
// console, the console itself under a moving camera with chapter titles, and
// burned-in subtitles. Every animation sits on one paused GSAP timeline at
// absolute film seconds. Pure: buildComposition() returns the page as a string.
//
// Scene order: open (the incoming call) -> title -> how -> console -> hood ->
// yours -> close. Content comes from the film script's `scenes` and the
// template's template.json (name, tags, colours); timing comes from compose.mjs.

const r3 = (n) => Math.round(n * 1000) / 1000;
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const firstName = (name) => String(name ?? "").split(/\s+/)[0];
const initials = (name) =>
  String(name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");

export const SITE = "anujb-msft.github.io/voice-ai-template-gallery";
export const DISCLOSURE =
  "Voices are synthetic, performed by Azure OpenAI GPT Realtime. Callers, companies and numbers are fictional. Console recorded in simulation mode.";
export const TEAMS = "#7b83eb";
export const EASE = { in: "power3.out", move: "power2.inOut", soft: "sine.inOut" };

function luminance(hex) {
  const [r, g, b] = String(hex)
    .replace("#", "")
    .match(/\w\w/g)
    .map((h) => parseInt(h, 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Animation ops, replayed into a GSAP timeline in the page. */
export class Ops {
  list = [];
  set(target, vars, at) {
    this.list.push(["set", target, vars, null, r3(at)]);
  }
  tween(target, from, to, at) {
    this.list.push(["fromTo", target, from, to, r3(at)]);
  }
  fadeIn(target, at, { dur = 0.6, y = 26, x = 0, scale = null, ease = EASE.in } = {}) {
    const from = { opacity: 0, y, x };
    const to = { opacity: 1, y: 0, x: 0, duration: dur, ease };
    if (scale != null) {
      from.scale = scale;
      to.scale = 1;
    }
    this.tween(target, from, to, at);
  }
  fade(target, from, to, at, dur, ease = EASE.soft) {
    this.tween(target, { opacity: from }, { opacity: to, duration: dur, ease }, at);
  }
}

const PHONE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.6 3.2h3.1l1.7 4.3-2.2 1.4a11.6 11.6 0 0 0 6.9 6.9l1.4-2.2 4.3 1.7v3.1a2 2 0 0 1-2.1 2A17.3 17.3 0 0 1 3.6 5.3a2 2 0 0 1 2-2.1z"/></svg>';
const SKIP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 5.2v13.6L11.6 12zM12.4 5.2v13.6L21.5 12z"/></svg>';
const CHEVRON = '<svg viewBox="0 0 12 20" aria-hidden="true"><path d="M2 2l8 8-8 8"/></svg>';

// ------------------------------------------------------------------ scenes

/** Where the scene's lines are, and a time a fraction of the way through one. */
const lineAt = (scene, i) => scene.lines[Math.min(i, scene.lines.length - 1)];
const through = (line, f) => line.at + (line.end - line.at) * f;

function openScene(film, template, scene, plan, ops) {
  const s = film.scenes.open;
  const call = s.call ?? {};
  // Menu lines are strings ("For sales, press 1.") or {key, text} for anything that isn't a keypress.
  const menu = (s.menu ?? []).map((line) =>
    typeof line === "string" ? { text: line, key: line.match(/press\s+([0-9*#])/i)?.[1] ?? "…" } : { key: "…", ...line },
  );
  const who = s.bubble?.who ?? firstName(call.name);
  const reason = s.bubble === false ? "" : (s.bubble?.text ?? plan.reason ?? "");
  const html = `
  <section id="s-open" class="clip scene" data-start="${r3(scene.start)}" data-duration="${r3(scene.end - scene.start)}">
    <div class="synth"><span class="dot"></span>Synthetic voices · fictional callers</div>
    <div class="phone">
      <div class="phone-top"><span class="live"></span>${esc(call.label ?? "Incoming call")}</div>
      <div class="avatar-wrap"><span class="ring"></span><span class="ring"></span><span class="ring"></span><div class="avatar">${esc(call.initials ?? initials(call.name))}</div></div>
      <div class="caller-name">${esc(call.name)}</div>
      ${call.detail ? `<div class="caller-detail">${esc(call.detail)}</div>` : ""}
      ${call.number ? `<div class="caller-number">${esc(call.number)}</div>` : ""}
      ${call.line ? `<div class="caller-line">${esc(call.line)}</div>` : ""}
      <div class="phone-actions"><span class="btn decline">${PHONE_ICON}</span><span class="btn accept">${PHONE_ICON}</span></div>
    </div>
    ${
      menu.length
        ? `<div class="ivr">
      <div class="ivr-head">${esc(s.menuTitle ?? "The usual phone menu")}</div>
      ${menu.map((item) => `<div class="ivr-line"><span class="key">${esc(item.key)}</span><span class="txt">${esc(item.text)}<i class="st"></i></span></div>`).join("\n      ")}
    </div>`
        : ""
    }
    ${reason ? `<div class="reason${menu.length ? "" : " solo"}"><div class="who">${esc(who)}</div><div class="said">“${esc(reason.replace(/[.!]$/, ""))}.”</div></div>` : ""}
  </section>`;

  const t0 = scene.start;
  const dur = scene.end - t0;
  ops.fadeIn("#s-open .phone", t0 + 0.15, { dur: 0.9, y: 50, scale: 0.97 });
  ops.fadeIn("#s-open .synth", t0 + 0.6, { dur: 0.6, y: -10 });
  const reps = Math.ceil(dur / 1.8) + 1;
  ["1", "2", "3"].forEach((n, i) =>
    ops.tween(`#s-open .ring:nth-child(${n})`, { scale: 1, opacity: 0.6 }, { scale: 2.15, opacity: 0, duration: 1.8, ease: "power1.out", repeat: reps }, t0 + 0.3 + i * 0.6),
  );
  ops.tween("#s-open .live", { opacity: 1 }, { opacity: 0.25, duration: 0.55, ease: "sine.inOut", repeat: Math.ceil(dur / 0.55), yoyo: true }, t0 + 0.2);
  ops.tween("#s-open .btn.accept", { scale: 1 }, { scale: 1.09, duration: 0.6, ease: "sine.inOut", repeat: Math.ceil(dur / 0.6), yoyo: true }, t0 + 0.4);

  // The menu arrives with the line about menus; a strike lands on the last sentence, then the caller's reason.
  const l2 = lineAt(scene, 1) ?? lineAt(scene, 0);
  let strike = l2 ? through(l2, 0.62) : t0 + dur * 0.6;
  if (l2) {
    const text = l2.text;
    const last = text.slice(0, -1).search(/[.!?]\s+[^.!?]*[.!?]?$/);
    if (last > 0) strike = through(l2, (last + 1) / text.length);
  }
  if (menu.length) {
    const from = l2 ? l2.at - 0.1 : t0 + 1;
    ops.fadeIn("#s-open .ivr-head", from, { dur: 0.5, y: 0, x: -20 });
    menu.forEach((_, i) => ops.fadeIn(`#s-open .ivr-line:nth-of-type(${i + 2})`, from + 0.2 + i * Math.min(0.42, (strike - from - 0.6) / menu.length), { dur: 0.5, y: 0, x: -24 }));
    menu.forEach((_, i) => ops.tween(`#s-open .ivr-line:nth-of-type(${i + 2}) .st`, { scaleX: 0 }, { scaleX: 1, duration: 0.32, ease: "power2.in" }, strike + i * 0.07));
    ops.fade("#s-open .ivr", 1, 0.32, strike + 0.4, 0.6);
  }
  if (reason) ops.fadeIn("#s-open .reason", strike + 0.5, { dur: 0.8, y: 34, scale: 0.98 });
  return html;
}

function titleScene(film, template, scene, plan, ops) {
  const s = film.scenes.title ?? {};
  const name = s.title ?? template.name;
  const size = Math.min(108, Math.floor(1660 / (0.55 * name.length)));
  const chips = s.chips ?? template.tags ?? [];
  const eyebrow = s.eyebrow ?? `Voice AI template${template.assistant ? ` · ${template.assistant}` : ""}`;
  const html = `
  <section id="s-title" class="clip scene" data-start="${r3(scene.start)}" data-duration="${r3(scene.end - scene.start)}">
    <div class="center">
      <div class="eyebrow">${esc(eyebrow)}</div>
      <h1 style="font-size:${size}px">${esc(name)}</h1>
      <div class="bar"></div>
      <p class="promise">${esc(s.promise ?? template.headline)}</p>
      <div class="chips">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</div>
    </div>
  </section>`;
  const t0 = scene.start;
  ops.fadeIn("#s-title .eyebrow", t0 + 0.35, { dur: 0.6, y: 14 });
  ops.fadeIn("#s-title h1", t0 + 0.5, { dur: 0.9, y: 44 });
  ops.tween("#s-title .bar", { scaleX: 0 }, { scaleX: 1, duration: 0.7, ease: EASE.move }, t0 + 0.95);
  ops.fadeIn("#s-title .promise", t0 + 1.1, { dur: 0.8, y: 22 });
  chips.forEach((_, i) => ops.fadeIn(`#s-title .chip:nth-child(${i + 1})`, t0 + 1.5 + i * 0.09, { dur: 0.5, y: 14 }));
  return html;
}

function howScene(film, template, scene, plan, ops) {
  const s = film.scenes.how;
  const stages = s.stages ?? [];
  const html = `
  <section id="s-how" class="clip scene" data-start="${r3(scene.start)}" data-duration="${r3(scene.end - scene.start)}">
    <div class="head"><div class="eyebrow">${esc(s.eyebrow ?? "How it works")}</div><h2>${esc(s.title ?? "From a phone call to the right outcome")}</h2></div>
    <div class="pipeline">
      ${stages
        .map(
          (st, i) =>
            `${i ? `<div class="arrow" id="ar-${i}"><span class="fill"></span><span class="chev">${CHEVRON}</span><span class="chev lit">${CHEVRON}</span></div>` : ""}<div class="stage${st.brand ? " brand" : ""}" id="st-${i}"><span class="glow"></span><div class="num">${i + 1}</div><div class="label">${esc(st.label)}</div><div class="detail">${esc(st.detail ?? "")}</div></div>`,
        )
        .join("\n      ")}
    </div>
  </section>`;
  const t0 = scene.start;
  ops.fadeIn("#s-how .head", t0 + 0.3, { dur: 0.7, y: 20 });
  // Stages arrive dim and brighten as the narration reaches them.
  const shown = stages.map((_, i) => t0 + 0.45 + i * 0.06);
  stages.forEach((_, i) => ops.tween(`#st-${i}`, { opacity: 0, y: 24 }, { opacity: 0.38, y: 0, duration: 0.5, ease: EASE.in }, shown[i]));
  // Each stage lights with the line that names it: given, or spread evenly over the lines.
  const L = scene.lines.length;
  const groups = new Map();
  stages.forEach((st, i) => {
    const line = st.line ?? (L ? Math.floor((i * L) / stages.length) : 0);
    groups.set(line, [...(groups.get(line) ?? []), i]);
  });
  const lit = [];
  for (const [line, members] of groups) {
    const l = lineAt(scene, line);
    members.forEach((i, k) => (lit[i] = l ? through(l, 0.05 + (0.7 * k) / members.length) : t0 + 1 + i * 0.6));
  }
  let prev = t0;
  stages.forEach((_, i) => {
    const at = Math.max(lit[i], prev + 0.25, shown[i] + 0.55);
    prev = at;
    ops.fade(`#st-${i}`, 0.38, 1, at, 0.4, "power2.out");
    ops.fade(`#st-${i} .glow`, 0, 1, at, 0.45, "power2.out");
    ops.tween(`#st-${i} .num`, { scale: 1 }, { scale: 1.18, duration: 0.25, ease: "power2.out", yoyo: true, repeat: 1 }, at);
    if (i) {
      ops.tween(`#ar-${i} .fill`, { scaleX: 0 }, { scaleX: 1, duration: 0.4, ease: "power2.inOut" }, at - 0.35);
      ops.fade(`#ar-${i} .chev.lit`, 0, 1, at - 0.05, 0.2, "none");
    }
  });
  return html;
}

function hoodScene(film, template, scene, plan, ops) {
  const s = film.scenes.hood;
  const points = s.points ?? [];
  const html = `
  <section id="s-hood" class="clip scene" data-start="${r3(scene.start)}" data-duration="${r3(scene.end - scene.start)}">
    <div class="head"><div class="eyebrow">${esc(s.eyebrow ?? "Under the hood")}</div><h2>${esc(s.title)}</h2></div>
    <div class="rows">
      ${points.map((p, i) => `<div class="row" id="pt-${i}"><div class="k">${esc(p.k)}</div><div class="v">${esc(p.v)}</div></div>`).join("\n      ")}
    </div>
  </section>`;
  const t0 = scene.start;
  ops.fadeIn("#s-hood .head", t0 + 0.3, { dur: 0.7, y: 20 });
  const first = scene.lines[0]?.at ?? t0 + 0.8;
  const last = scene.lines.at(-1)?.end ?? scene.end - 1;
  const span = Math.max(1, last - first - 1.2);
  points.forEach((p, i) => ops.fadeIn(`#pt-${i}`, p.line != null ? lineAt(scene, p.line).at + 0.1 : first + 0.1 + (i * span) / Math.max(1, points.length), { dur: 0.6, y: 0, x: -30 }));
  return html;
}

function yoursScene(film, template, scene, plan, ops) {
  const s = film.scenes.yours;
  const files = s.files ?? [];
  const prompt = s.prompt ?? "";
  const context = s.context ?? ["SPEC.md", "DEMO-SCRIPT.md", "test/"];
  const chars = [...prompt].map((c, i) => `<span class="ch" id="ch-${i}">${esc(c)}</span>`).join("");
  const html = `
  <section id="s-yours" class="clip scene" data-start="${r3(scene.start)}" data-duration="${r3(scene.end - scene.start)}">
    <div class="head"><div class="eyebrow">${esc(s.eyebrow ?? "Make it yours")}</div><h2>${esc(s.title ?? "Configuration first. Your coding agent for the rest.")}</h2></div>
    <div class="cols">
      <div class="files">
        ${files.map((f, i) => `<div class="file" id="f-${i}"><div class="path">${esc(f.path)}</div><div class="note">${esc(f.note ?? "")}</div></div>`).join("\n        ")}
      </div>
      <div class="agent">
        <div class="bar"><i></i><i></i><i></i><span>${esc(s.agentLabel ?? "Your coding agent")}</span></div>
        <div class="body">
          <div class="prompt"><span class="caret">›</span><span class="typed">${chars}<span class="cursor"></span></span></div>
          <div class="ctx">${context.map((c) => `<span>${esc(c)}</span>`).join("")}</div>
        </div>
      </div>
    </div>
  </section>`;
  const t0 = scene.start;
  ops.fadeIn("#s-yours .head", t0 + 0.3, { dur: 0.7, y: 20 });
  const l1 = lineAt(scene, 0);
  const l2 = lineAt(scene, 1) ?? l1;
  const fileSpan = l1 ? Math.max(1.5, (l1.end - l1.at) * 0.75) : 3;
  files.forEach((_, i) => ops.fadeIn(`#f-${i}`, (l1?.at ?? t0 + 0.8) + 0.1 + (i * fileSpan) / Math.max(1, files.length), { dur: 0.55, y: 0, x: -26 }));
  const agentAt = Math.max(t0 + 1, (l2?.at ?? t0 + 2) - 0.9);
  ops.fadeIn("#s-yours .agent", agentAt, { dur: 0.7, y: 30, scale: 0.98 });
  const typeFrom = agentAt + 0.8;
  const typeEnd = Math.min(scene.end - 1.6, typeFrom + prompt.length / 26);
  const step = (typeEnd - typeFrom) / Math.max(1, prompt.length);
  [...prompt].forEach((_, i) => ops.set(`#ch-${i}`, { display: "inline" }, typeFrom + i * step));
  ops.tween("#s-yours .cursor", { opacity: 1 }, { opacity: 0, duration: 0.5, ease: "steps(1)", repeat: Math.ceil((scene.end - t0) / 0.5), yoyo: true }, t0);
  context.forEach((_, i) => ops.fadeIn(`#s-yours .ctx span:nth-child(${i + 1})`, typeEnd + 0.3 + i * 0.12, { dur: 0.45, y: 10 }));
  return html;
}

function closeScene(film, template, scene, plan, ops) {
  const s = film.scenes.close ?? {};
  const name = s.title ?? template.name;
  const size = Math.min(96, Math.floor(1660 / (0.55 * name.length)));
  const html = `
  <section id="s-close" class="clip scene" data-start="${r3(scene.start)}" data-duration="${r3(scene.end - scene.start)}">
    <div class="center">
      <div class="eyebrow">${esc(s.eyebrow ?? "Voice AI template gallery")}</div>
      <h1 style="font-size:${size}px">${esc(name)}</h1>
      ${s.run ? `<div class="run"><span class="dollar">$</span><span>${esc(s.run)}</span></div>` : ""}
      <div class="url">${esc(s.url ?? SITE)}</div>
    </div>
    <div class="disclosure">${esc(s.disclosure ?? DISCLOSURE)}</div>
  </section>`;
  const t0 = scene.start;
  ops.fadeIn("#s-close .eyebrow", t0 + 0.35, { dur: 0.6, y: 14 });
  ops.fadeIn("#s-close h1", t0 + 0.5, { dur: 0.9, y: 40 });
  if (s.run) ops.fadeIn("#s-close .run", t0 + 1.0, { dur: 0.7, y: 20 });
  ops.fadeIn("#s-close .url", t0 + 1.3, { dur: 0.7, y: 16 });
  const after = (scene.lines.at(-1)?.end ?? t0 + 2) + 0.2;
  ops.fadeIn("#s-close .disclosure", Math.min(after, scene.end - 2.4), { dur: 0.8, y: 0 });
  return html;
}

const SCENES = { open: openScene, title: titleScene, how: howScene, hood: hoodScene, yours: yoursScene, close: closeScene };

// ----------------------------------------------------------------- console

/** Camera transforms for a shot: the centred rig's scale and the pan to the shot's centre. */
function rig(shot, c) {
  const s = 1920 / (shot.w * c.dpr);
  const cx = shot.x + shot.w / 2;
  const cy = shot.y + (shot.w * 9) / 16 / 2;
  return { scale: s, x: -cx * c.dpr, y: -cy * c.dpr };
}

function consoleLayer(film, template, plan, ops) {
  const c = plan.console;
  const est = c.establish ?? {};
  const estTo = c.start + Math.max(1.6, (c.moves[1]?.at ?? 2.4) + 0.3);
  // Each call's title is a slate in the band above the console, shown while the
  // camera holds that beat's "top" shot (the first waits for the establishing title).
  const noun = film.console?.chapterNoun ?? "Call";
  const hold = film.console?.chapterHold ?? 4.8;
  const chapters = c.chapters
    .map((ch, i) => {
      const next = c.chapters[i + 1];
      const end = next ? next.at - 0.3 : (c.closingAt ?? c.length);
      let k = c.moves.findIndex((m) => m.why === `beat ${ch.number}`);
      if (k < 0) k = Math.max(0, c.moves.findLastIndex((m) => m.at <= ch.at + 0.4));
      const move = c.moves[k];
      const arrive = move.at + move.dur;
      const leave = c.moves[k + 1]?.at ?? end;
      const from = Math.max(ch.at, arrive - 0.5, i === 0 ? estTo - c.start - 0.1 : 0);
      const to = Math.min(end, leave + 0.15, from + hold);
      ch.from = c.start + from;
      ch.to = c.start + Math.max(to, from + 1.2);
      // Centre it in the band when the shot leaves room above the console; otherwise it rides the top corner.
      const zoom = 1920 / move.shot.w;
      const band = -move.shot.y * zoom;
      const top = band >= 96 ? Math.round((band - 66) / 2) : 36;
      const left = band >= 96 ? Math.max(40, Math.round(-move.shot.x * zoom)) : 56;
      const eyebrow = ch.total > 1 ? `${noun} ${ch.index} of ${ch.total}` : `The ${noun.toLowerCase()}`;
      return `<div class="chapter clip" id="chap-${i}" data-start="${r3(ch.from)}" data-duration="${r3(ch.to - ch.from)}"><div class="tag" style="left:${left}px;top:${top}px"><div class="n">${esc(eyebrow)}</div><div class="t">${esc(ch.title)}</div></div></div>`;
    })
    .join("\n    ");
  // A skip (a later call's greeting, say) is a hard cut in the footage: the frame dips to its
  // background across it, under a centred card that says the film is skipping ahead (and past what).
  const skips = (c.skips ?? []).map((s, i) => ({ ...s, i, cut: c.start + s.at }));
  const skipHtml = skips
    .map(
      (s) =>
        `<div class="skip clip" id="skip-${s.i}" data-start="${r3(s.cut - 1.2)}" data-duration="1.9"><div class="card"><div class="n">${SKIP_ICON}<span>Skipping ahead</span></div>${s.label ? `<div class="t">${esc(s.label)}</div>` : ""}</div></div>`,
    )
    .join("\n    ");
  const html = `
  <div id="console">
    <div id="cam"><div id="pan">
      <div id="screen" style="width:${c.width}px;height:${c.height}px"><video id="footage" class="clip" src="${esc(c.video)}" muted playsinline data-start="${r3(c.start)}" data-duration="${r3(c.length)}" data-media-start="0"></video></div>
    </div></div>
    <div id="dip"></div>
    ${chapters}
    ${skipHtml}
    <div id="est" class="clip" data-start="${r3(c.start)}" data-duration="${r3(estTo - c.start)}">
      <div class="eyebrow">${esc(est.eyebrow ?? "The template's own console")}</div>
      <div class="est-title">${esc(est.title ?? "Simulation mode")}</div>
      <div class="est-sub">${esc(est.sub ?? "Scripted calls, voiced by Azure OpenAI GPT Realtime")}</div>
    </div>
  </div>`;

  ops.fade("#console", 0, 1, c.start, 0.6, "power1.out");
  ops.fade("#console", 1, 0, c.start + c.length - 0.5, 0.5, "power1.in");
  ops.fadeIn("#est", c.start + 0.35, { dur: 0.6, y: 0, x: -24 });
  ops.fade("#est", 1, 0, estTo - 0.5, 0.45);
  c.chapters.forEach((ch, i) => {
    ops.fadeIn(`#chap-${i} .tag`, ch.from, { dur: 0.55, y: 0, x: -36 });
    ops.fade(`#chap-${i} .tag`, 1, 0, Math.max(ch.from + 0.6, ch.to - 0.45), 0.4);
  });
  for (const s of skips) {
    // Mostly before the cut, where the console is still, so what follows it is seen at once.
    ops.fade("#dip", 0, 0.96, s.cut - 1.4, 0.35, "power1.in");
    ops.fade("#dip", 0.96, 0, s.cut + 0.35, 0.4, "power1.out");
    ops.fadeIn(`#skip-${s.i} .card`, s.cut - 1.2, { dur: 0.3, y: 14 });
    ops.fade(`#skip-${s.i} .card`, 1, 0, s.cut + 0.3, 0.35);
  }

  // The camera: each move eases the rig to its shot; a long hold drifts in slowly.
  const moves = c.moves;
  let state = rig(moves[0].shot, c);
  ops.set("#cam", { scale: state.scale }, 0);
  ops.set("#pan", { x: state.x, y: state.y }, 0);
  moves.forEach((m, i) => {
    const target = rig(m.shot, c);
    const at = c.start + m.at;
    if (i > 0) {
      ops.tween("#cam", { scale: state.scale }, { scale: target.scale, duration: m.dur, ease: EASE.move }, at);
      ops.tween("#pan", { x: state.x, y: state.y }, { x: target.x, y: target.y, duration: m.dur, ease: EASE.move }, at);
    }
    state = { ...target };
    const holdFrom = at + (i > 0 ? m.dur : 0);
    const holdTo = c.start + (moves[i + 1]?.at ?? c.length);
    const hold = holdTo - holdFrom;
    if (hold > 1.2) {
      const drifted = state.scale * (1 + (c.drift - 1) * Math.min(1, hold / 8));
      ops.tween("#cam", { scale: state.scale }, { scale: drifted, duration: hold, ease: EASE.soft }, holdFrom);
      state.scale = drifted;
    }
  });
  return html;
}

// --------------------------------------------------------------- subtitles

function subtitles(plan, ops) {
  const cues = plan.cues;
  return cues
    .map((cue, i) => {
      const id = `sub-${i}`;
      const dur = cue.end - cue.at;
      const gapBefore = i ? cue.at - cues[i - 1].end : Infinity;
      const gapAfter = i < cues.length - 1 ? cues[i + 1].at - cue.end : Infinity;
      if (gapBefore > 0.2) ops.fade(`#${id}`, 0, 1, cue.at, Math.min(0.18, dur / 4), "none");
      if (gapAfter > 0.2) ops.fade(`#${id}`, 1, 0, cue.end - Math.min(0.18, dur / 4), Math.min(0.18, dur / 4), "none");
      const label = cue.role === "narrator" ? "" : `<b>${esc(cue.speaker)}</b>`;
      return `<div class="sub clip" id="${id}" data-start="${r3(cue.at)}" data-duration="${r3(dur)}"><div class="pill${cue.role === "narrator" ? " narr" : ""}">${label}${esc(cue.text)}</div></div>`;
    })
    .join("\n  ");
}

// -------------------------------------------------------------------- page

function styles(template, plan) {
  const k = template.colors;
  const c = plan.console;
  return `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { margin: 0; background: #000; }
  #root {
    --bg: ${k.bg}; --panel: ${k.panel}; --accent: ${k.accent}; --ink: ${k.ink}; --on-accent: ${template.onAccent ?? k.bg};
    --muted: color-mix(in srgb, var(--ink) 66%, var(--bg));
    --line: color-mix(in srgb, var(--ink) 15%, transparent);
    --teams: ${TEAMS};
    --sans: "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    --mono: "Cascadia Mono", "Cascadia Code", Consolas, monospace;
    --shadow: ${plan.light ? "rgba(40,30,20,.16)" : "rgba(0,0,0,.45)"};
    position: relative; width: 1920px; height: 1080px; overflow: hidden;
    background: var(--bg); color: var(--ink); font-family: var(--sans);
    -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision;
  }
  .clip { position: absolute; inset: 0; }
  .scene { opacity: 0; z-index: 2; }
  .eyebrow { font-weight: 650; font-size: 22px; line-height: 1; letter-spacing: .18em; text-transform: uppercase; color: var(--accent); }
  .head { position: absolute; left: 120px; right: 120px; top: 104px; }
  .head h2 { margin-top: 20px; font-weight: 650; font-size: 60px; line-height: 1.08; letter-spacing: -.012em; max-width: 1600px; }
  .center { position: absolute; inset: 0 140px 70px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }

  /* background */
  #bg { position: absolute; inset: 0; overflow: hidden; z-index: 0; }
  #bg .glow { position: absolute; width: 1500px; height: 1500px; border-radius: 50%;
    background: radial-gradient(circle, color-mix(in srgb, var(--accent) ${plan.light ? 16 : 20}%, transparent) 0%, transparent 64%); }
  #bg .g1 { left: -520px; top: -700px; }
  #bg .g2 { right: -600px; bottom: -760px; opacity: .75; }
  #bg .grid { position: absolute; inset: 0; opacity: ${plan.light ? 0.5 : 0.4};
    background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px);
    background-size: 64px 64px; background-position: -1px -1px;
    -webkit-mask-image: radial-gradient(ellipse 72% 62% at 50% 46%, #000 20%, transparent 100%); }
  #bg .vig { position: absolute; inset: 0; background: radial-gradient(ellipse 90% 80% at 50% 50%, transparent 55%, ${plan.light ? "rgba(60,40,20,.10)" : "rgba(0,0,0,.45)"} 100%); }

  /* open */
  #s-open .synth { position: absolute; right: 90px; top: 70px; display: flex; gap: 12px; align-items: center; font-size: 20px; font-weight: 500; color: var(--muted); }
  #s-open .synth .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
  #s-open .phone { position: absolute; left: 230px; top: 140px; width: 500px; height: 780px; border-radius: 48px; padding-top: 58px;
    display: flex; flex-direction: column; align-items: center; background: linear-gradient(180deg, color-mix(in srgb, var(--panel) 90%, var(--ink) 6%), var(--panel));
    border: 1px solid var(--line); box-shadow: 0 60px 140px var(--shadow), inset 0 1px 0 color-mix(in srgb, var(--ink) 8%, transparent); }
  #s-open .phone-top { display: flex; gap: 12px; align-items: center; font-size: 20px; font-weight: 650; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
  #s-open .live { width: 12px; height: 12px; border-radius: 50%; background: #3fcf7f; }
  #s-open .avatar-wrap { position: relative; width: 168px; height: 168px; margin-top: 58px; }
  #s-open .ring { position: absolute; inset: 0; border-radius: 50%; border: 3px solid var(--accent); opacity: 0; }
  #s-open .avatar { position: absolute; inset: 0; border-radius: 50%; display: grid; place-items: center; font-size: 60px; font-weight: 650; color: var(--on-accent);
    background: linear-gradient(140deg, var(--accent), color-mix(in srgb, var(--accent) 58%, var(--bg))); }
  #s-open .caller-name { margin-top: 44px; font-size: 46px; font-weight: 650; letter-spacing: -.01em; }
  #s-open .caller-detail { margin-top: 8px; font-size: 26px; color: var(--muted); }
  #s-open .caller-number { margin-top: 26px; font: 500 26px var(--mono); letter-spacing: .02em; }
  #s-open .caller-line { margin-top: 20px; padding: 9px 20px; border-radius: 999px; border: 1px solid var(--line); font-size: 20px; font-weight: 600; color: var(--muted); }
  #s-open .phone-actions { margin-top: auto; margin-bottom: 58px; display: flex; gap: 130px; }
  #s-open .btn { width: 90px; height: 90px; border-radius: 50%; display: grid; place-items: center; }
  #s-open .btn svg { width: 40px; height: 40px; fill: #fff; }
  #s-open .decline { background: #e5484d; } #s-open .decline svg { transform: rotate(135deg); }
  #s-open .accept { background: #2f9e62; }
  #s-open .ivr { position: absolute; left: 900px; top: 196px; width: 800px; }
  #s-open .ivr-head { font-size: 22px; font-weight: 650; letter-spacing: .18em; text-transform: uppercase; color: var(--muted); opacity: 0; }
  #s-open .ivr-line { display: flex; align-items: center; gap: 24px; margin-top: 22px; font-size: 38px; opacity: 0; }
  #s-open .ivr-line .key { flex: 0 0 58px; height: 58px; border-radius: 14px; display: grid; place-items: center; border: 1px solid var(--line);
    background: color-mix(in srgb, var(--panel) 70%, transparent); font: 600 28px var(--mono); color: var(--muted); }
  #s-open .ivr-line .txt { position: relative; }
  #s-open .ivr-line .st { position: absolute; left: -6px; right: -6px; top: 54%; height: 5px; border-radius: 3px; background: var(--accent); transform: scaleX(0); transform-origin: 0 50%; }
  #s-open .reason { position: absolute; left: 900px; top: 640px; width: 820px; padding: 34px 44px 38px; border-radius: 30px; opacity: 0;
    background: var(--panel); border: 1px solid color-mix(in srgb, var(--accent) 50%, transparent); box-shadow: 0 34px 90px var(--shadow); }
  #s-open .reason.solo { top: 380px; }
  #s-open .reason::before { content: ""; position: absolute; left: -15px; top: 52px; width: 28px; height: 28px; transform: rotate(45deg);
    background: var(--panel); border-left: 1px solid color-mix(in srgb, var(--accent) 50%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--accent) 50%, transparent); }
  #s-open .reason .who { font-size: 22px; font-weight: 650; letter-spacing: .16em; text-transform: uppercase; color: var(--accent); }
  #s-open .reason .said { margin-top: 14px; font-size: 50px; line-height: 1.16; font-weight: 600; letter-spacing: -.01em; }

  /* title */
  #s-title h1 { margin-top: 30px; font-weight: 700; line-height: 1.02; letter-spacing: -.022em; }
  #s-title .bar { width: 140px; height: 6px; margin-top: 42px; border-radius: 3px; background: var(--accent); }
  #s-title .promise { margin-top: 38px; max-width: 1320px; font-size: 40px; line-height: 1.3; color: var(--muted); }
  #s-title .chips { margin-top: 52px; display: flex; flex-wrap: wrap; gap: 14px; justify-content: center; max-width: 1500px; }
  #s-title .chip { padding: 12px 24px; border-radius: 999px; border: 1px solid var(--line); background: color-mix(in srgb, var(--panel) 65%, transparent); font-size: 22px; font-weight: 600; }

  /* how */
  #s-how .pipeline { position: absolute; left: 110px; right: 110px; top: 360px; display: flex; align-items: stretch; }
  #s-how .stage { position: relative; flex: 1 1 0; min-width: 0; min-height: 330px; padding: 30px 26px; border-radius: 26px; background: var(--panel); border: 1px solid var(--line); opacity: 0; }
  #s-how .stage .glow { position: absolute; inset: -1px; border-radius: 26px; border: 2px solid var(--accent); opacity: 0;
    box-shadow: 0 0 0 7px color-mix(in srgb, var(--accent) 13%, transparent), 0 28px 70px color-mix(in srgb, var(--accent) 22%, transparent); }
  #s-how .stage.brand .glow { border-color: var(--teams); box-shadow: 0 0 0 7px rgb(123 131 235 / .16), 0 28px 70px rgb(123 131 235 / .28); }
  #s-how .num { width: 46px; height: 46px; border-radius: 50%; display: grid; place-items: center; font: 700 22px var(--mono);
    color: var(--accent); background: color-mix(in srgb, var(--accent) 17%, transparent); }
  #s-how .brand .num { color: ${TEAMS}; background: rgb(123 131 235 / .18); }
  #s-how .label { margin-top: 28px; font-size: 30px; font-weight: 650; line-height: 1.14; }
  #s-how .detail { margin-top: 14px; font-size: 21px; line-height: 1.36; color: var(--muted); }
  #s-how .arrow { flex: 0 0 52px; position: relative; align-self: center; height: 4px; margin: 0 4px 0 8px; border-radius: 2px; background: var(--line); }
  #s-how .arrow .fill { position: absolute; inset: 0; border-radius: 2px; background: var(--accent); transform: scaleX(0); transform-origin: 0 50%; }
  #s-how .arrow .chev { position: absolute; right: -10px; top: -9px; width: 13px; height: 22px; }
  #s-how .arrow .chev svg { width: 13px; height: 22px; fill: none; stroke: var(--line); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
  #s-how .arrow .chev.lit { opacity: 0; } #s-how .arrow .chev.lit svg { stroke: var(--accent); }

  /* hood */
  #s-hood .rows { position: absolute; left: 120px; right: 120px; top: 280px; bottom: 210px; display: flex; flex-direction: column; justify-content: center; gap: 14px; }
  #s-hood .row { display: grid; grid-template-columns: 400px 1fr; gap: 40px; align-items: center; padding: 26px 40px; border-radius: 20px; opacity: 0;
    background: color-mix(in srgb, var(--panel) 82%, transparent); border: 1px solid var(--line); }
  #s-hood .k { font: 600 29px var(--mono); color: var(--accent); }
  #s-hood .v { font-size: 30px; line-height: 1.3; }

  /* yours */
  #s-yours .cols { position: absolute; left: 120px; right: 120px; top: 312px; display: grid; grid-template-columns: 1fr 1fr; gap: 64px; }
  #s-yours .file { padding: 16px 0 18px; border-bottom: 1px solid var(--line); opacity: 0; }
  #s-yours .path { font: 600 27px var(--mono); }
  #s-yours .note { margin-top: 6px; font-size: 22px; color: var(--muted); }
  #s-yours .agent { align-self: start; border-radius: 22px; overflow: hidden; opacity: 0; background: #0e1116; color: #e6edf3;
    border: 1px solid rgba(255,255,255,.1); box-shadow: 0 40px 100px var(--shadow); }
  #s-yours .agent .bar { display: flex; gap: 10px; align-items: center; padding: 18px 22px; background: #161b22; border-bottom: 1px solid rgba(255,255,255,.08); }
  #s-yours .agent .bar i { width: 13px; height: 13px; border-radius: 50%; background: #3a4048; }
  #s-yours .agent .bar span { margin-left: 12px; font-size: 19px; font-weight: 600; color: #9aa4af; letter-spacing: .04em; }
  #s-yours .agent .body { padding: 30px 32px 34px; min-height: 300px; }
  #s-yours .prompt { display: flex; gap: 16px; font-size: 31px; line-height: 1.4; }
  #s-yours .caret { color: var(--accent); font-weight: 700; }
  #s-yours .ch { display: none; }
  #s-yours .cursor { display: inline-block; width: 3px; height: 34px; margin-left: 2px; vertical-align: -6px; background: #e6edf3; }
  #s-yours .ctx { margin-top: 30px; display: flex; flex-wrap: wrap; gap: 10px; }
  #s-yours .ctx span { padding: 7px 14px; border-radius: 8px; background: #1f2630; font: 500 19px var(--mono); color: #9aa4af; opacity: 0; }

  /* close */
  #s-close h1 { margin-top: 28px; font-weight: 700; line-height: 1.04; letter-spacing: -.02em; }
  #s-close .run { margin-top: 48px; display: inline-flex; gap: 18px; padding: 20px 32px; border-radius: 16px; background: #0e1116; color: #e6edf3;
    font: 500 30px var(--mono); border: 1px solid rgba(255,255,255,.1); box-shadow: 0 30px 80px var(--shadow); }
  #s-close .dollar { color: var(--accent); }
  #s-close .url { margin-top: 34px; font-size: 30px; font-weight: 600; color: var(--accent); }
  #s-close .disclosure { position: absolute; left: 220px; right: 220px; bottom: 70px; text-align: center; font-size: 21px; line-height: 1.45; color: var(--muted); opacity: 0; }

  /* console */
  #console { position: absolute; inset: 0; opacity: 0; z-index: 1; }
  #cam { position: absolute; left: 960px; top: 540px; transform-origin: 0 0; }
  #pan { position: absolute; left: 0; top: 0; }
  #screen { position: absolute; left: 0; top: 0; overflow: hidden; border-radius: 26px;
    box-shadow: 0 70px 180px var(--shadow), 0 0 0 2px var(--line); background: var(--bg); }
  #screen video { display: block; width: 100%; height: 100%; }
  #dip { position: absolute; inset: 0; z-index: 4; background: var(--bg); opacity: 0; }
  .skip.clip { z-index: 6; display: flex; align-items: center; justify-content: center; }
  .skip .card { display: flex; flex-direction: column; align-items: center; gap: 18px; text-align: center; color: var(--ink); }
  .skip .n { display: flex; align-items: center; gap: 14px; font-size: 22px; font-weight: 700; line-height: 1; letter-spacing: .2em; text-transform: uppercase; color: var(--accent); }
  .skip svg { flex: none; width: 30px; height: 30px; fill: currentColor; }
  .skip .t { font-size: 54px; font-weight: 700; line-height: 1.1; letter-spacing: -.015em; }
  .chapter.clip { z-index: 5; }
  .chapter .tag { position: absolute; display: flex; align-items: baseline; gap: 20px; max-width: 1640px; padding: 13px 30px 15px 24px; border-radius: 16px; color: #fff;
    background: rgba(12,12,16,.94); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,.08); border-left: 6px solid var(--accent); box-shadow: 0 18px 50px rgba(0,0,0,.35); }
  .chapter .n { flex: none; font-size: 17px; font-weight: 700; line-height: 1; letter-spacing: .18em; text-transform: uppercase; color: color-mix(in srgb, var(--accent) 70%, white); }
  .chapter .t { font-size: 34px; font-weight: 650; line-height: 1.12; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #est.clip { inset: 0 auto 0 120px; width: 660px; display: flex; flex-direction: column; justify-content: center; }
  #est .est-title { margin-top: 22px; font-size: 64px; font-weight: 700; line-height: 1.05; letter-spacing: -.015em; }
  #est .est-sub { margin-top: 20px; font-size: 30px; line-height: 1.35; color: var(--muted); }

  /* subtitles */
  .sub.clip { inset: auto 0 54px 0; display: flex; justify-content: center; z-index: 50; }
  .sub .pill { max-width: 1500px; padding: 13px 30px 15px; border-radius: 16px; background: rgba(10,10,12,.8); color: #fff;
    font-size: 34px; font-weight: 600; line-height: 1.32; text-align: center; box-shadow: 0 12px 34px rgba(0,0,0,.28); }
  .sub b { display: inline-block; margin-right: 16px; font-size: 22px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase;
    vertical-align: 4px; color: color-mix(in srgb, var(--accent) 55%, white); }
  #black { position: absolute; inset: 0; background: #000; z-index: 100; }
  `;
}

/**
 * index.html for the film. `plan`: { total, light, reason, scenes: {name: {start, end, lines:[{at,end,text}]}},
 * console: {start, length, video, width, height, dpr, moves, chapters, skips, closingAt, drift, establish}, cues }.
 */
export function buildComposition({ film, template, plan }) {
  const ops = new Ops();
  const order = ["open", "title", "how", "hood", "yours", "close"];
  const sections = [];
  for (const name of order) {
    const scene = plan.scenes[name];
    if (!scene) continue;
    sections.push(SCENES[name](film, template, scene, plan, ops));
    const fadeIn = name === "open" ? 0.01 : 0.5;
    ops.fade(`#s-${name}`, 0, 1, scene.start, fadeIn, "power1.out");
    if (name !== "close") ops.fade(`#s-${name}`, 1, 0, scene.end - 0.5, 0.5, "power1.in");
  }
  const consoleHtml = plan.console ? consoleLayer(film, template, plan, ops) : "";
  const subs = subtitles(plan, ops);

  ops.tween("#bg .g1", { x: 0, y: 0 }, { x: 220, y: 140, duration: plan.total, ease: "sine.inOut" }, 0);
  ops.tween("#bg .g2", { x: 0, y: 0 }, { x: -240, y: -120, duration: plan.total, ease: "sine.inOut" }, 0);
  ops.fade("#black", 1, 0, 0, 0.9, "power1.out");
  ops.fade("#black", 0, 1, plan.total - 1.3, 1.3, "power1.in");

  const html = `<!doctype html>
<html lang="${esc(film.lang ?? "en-US")}">
<head>
<meta charset="utf-8" />
<title>${esc(template.name)} · demo film</title>
<style>${styles(template, plan)}</style>
</head>
<body>
<div id="root" class="${plan.light ? "light" : "dark"}" data-composition-id="root" data-width="1920" data-height="1080" data-start="0" data-duration="${r3(plan.total)}">
  <div id="bg"><div class="glow g1"></div><div class="glow g2"></div><div class="grid"></div><div class="vig"></div></div>
  ${sections.join("\n")}
  ${consoleHtml}
  ${subs}
  <div id="black"></div>
</div>
<script src="gsap.min.js"></script>
<script>
  const OPS = ${JSON.stringify(ops.list)};
  const tl = gsap.timeline({ paused: true });
  for (const [method, target, a, b, at] of OPS) {
    if (method === "set") tl.set(target, { ...a, immediateRender: at === 0 }, at);
    else tl.fromTo(target, a, { ...b, immediateRender: at === 0 }, at);
  }
  window.__timelines = window.__timelines || {};
  window.__timelines["root"] = tl;
</script>
</body>
</html>
`;
  return { html, ops: ops.list.length };
}

export const isLight = (template) => luminance(template.colors.bg) > 0.4;
