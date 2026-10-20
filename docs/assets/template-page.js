/**
 * Shared renderer for every thin per-template page (docs/templates/<id>/index.html).
 * Each shell only sets `<body data-template-id="...">` and loads this script
 * after docs/data/templates.js, so there is exactly one rendering
 * implementation for every folder — no per-template markup or runtime
 * directory discovery. All content comes from window.VOICE_AI_TEMPLATES
 * (the folder-owned manifest data) and window.VOICE_AI_REPO (optional
 * repository metadata), both populated by scripts/generate-template-index.js.
 */
(function () {
  "use strict";

  var mount = document.getElementById("template-page");
  if (!mount) return;

  var templateId = document.body.getAttribute("data-template-id");
  var templates = Array.isArray(window.VOICE_AI_TEMPLATES) ? window.VOICE_AI_TEMPLATES : [];
  var template = templates.filter(function (item) {
    return item.id === templateId;
  })[0];

  if (!template) {
    mount.innerHTML =
      '<div class="tpl-error">' +
      "<p>This template could not be loaded.</p>" +
      '<p><a href="../../">Return to the catalogue</a>.</p>' +
      "</div>";
    mount.classList.add("is-rendered");
    return;
  }

  document.title = template.name + " \u2014 Voice AI Agent Templates";
  var descriptionTag = document.querySelector('meta[name="description"]');
  if (descriptionTag) descriptionTag.setAttribute("content", template.headline);

  var REPO =
    window.VOICE_AI_REPO && typeof window.VOICE_AI_REPO.owner === "string" && window.VOICE_AI_REPO.owner &&
    typeof window.VOICE_AI_REPO.name === "string" && window.VOICE_AI_REPO.name
      ? window.VOICE_AI_REPO
      : null;

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Manifest paths are declared relative to the docs/ root (e.g.
   * "templates/<id>/code/README.md"). This page lives inside that same
   * folder, so strip the template's own folder prefix to get a path
   * relative to the page itself. Pure string manipulation of already-known
   * manifest data — never a runtime directory listing or fetch probe.
   */
  function relativeToPage(manifestPath) {
    var prefix = template.paths.page;
    return manifestPath.indexOf(prefix) === 0 ? manifestPath.slice(prefix.length) : manifestPath;
  }

  function isFilm(asset) {
    return /\.mp4$/i.test(asset.path);
  }

  function isPoster(asset) {
    return /\/poster\.webp$/i.test(asset.path);
  }

  /** The first ready asset matching `test`, or null. */
  function readyAsset(test) {
    var expected = template.assets && Array.isArray(template.assets.expected) ? template.assets.expected : [];
    return (
      expected.filter(function (asset) {
        return test(asset) && asset.status === "ready";
      })[0] || null
    );
  }

  /** "#rgb" or "#rrggbb" as [r, g, b]; null for anything else. */
  function hexRgb(value) {
    var match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(typeof value === "string" ? value.trim() : "");
    if (!match) return null;
    var hex = match[1];
    if (hex.length === 3) {
      hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
    }
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }

  /** WCAG relative luminance. */
  function luminance(rgb) {
    var linear = rgb.map(function (channel) {
      var value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  }

  /** The accent, lifted toward white until it glows on black like the films' stage light. */
  function brightRgb(rgb) {
    var lifted = rgb.slice();
    var step = 0;
    while (luminance(lifted) < 0.2 && step < 10) {
      step += 1;
      for (var index = 0; index < 3; index += 1) {
        lifted[index] = Math.round(rgb[index] + (255 - rgb[index]) * (step / 10));
      }
    }
    return lifted;
  }

  /** The template's accent, as in the gallery: --t-accent as written, --glow bright enough for black. */
  function themeStyle() {
    var accent = template.colors && template.colors.accent;
    var rgb = hexRgb(accent);
    if (!rgb) return "";
    return "--t-accent:" + accent.trim() + ";--glow:" + brightRgb(rgb).join(",");
  }

  /** The headline in the films' type: the second sentence, or the turn after a dash, in the gradient. */
  function headlineMarkup(text) {
    var value = String(text || "").trim();
    var split = /^(.+?[.?!])\s+(\S.*)$/.exec(value) || /^(.+?\u2014)(\S.*)$/.exec(value);
    if (!split) return '<span class="gradient">' + escapeHtml(value) + "</span>";
    return escapeHtml(split[1]) + '<br /><span class="gradient">' + escapeHtml(split[2]) + "</span>";
  }

  var METER_LEVELS = { low: 1, medium: 2, high: 3 };

  function meterMarkup(complexity) {
    return (
      '<span class="tpl-meter" data-level="' +
      (METER_LEVELS[String(complexity).toLowerCase()] || 0) +
      '" aria-hidden="true"><i></i><i></i><i></i></span>'
    );
  }

  var MARK =
    '<svg class="tpl-mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
    '<defs><linearGradient id="tplMarkGradient" gradientUnits="userSpaceOnUse" x1="12" y1="0" x2="52" y2="0">' +
    '<stop offset="0" stop-color="#4f8bff"/><stop offset="0.4" stop-color="#8a6cff"/>' +
    '<stop offset="0.7" stop-color="#d16ce0"/><stop offset="1" stop-color="#ff8a65"/></linearGradient></defs>' +
    '<rect width="64" height="64" rx="14" fill="#000"/>' +
    '<path d="M15 27v10M26 19v26M38 12v40M49 23v18" fill="none" stroke="url(#tplMarkGradient)" stroke-width="6" stroke-linecap="round"/>' +
    "</svg>";

  function repoAction() {
    var page = template.paths && template.paths.page;
    if (REPO && page) {
      var branch = REPO.branch || "main";
      return {
        href: "https://github.com/" + REPO.owner + "/" + REPO.name + "/tree/" + branch + "/docs/" + page,
        label: "Open on GitHub",
      };
    }
    // No repository configured: this page already *is* that template's
    // folder, so the sensible relative fallback points at itself rather
    // than a dead or speculative link.
    return { href: "./", label: "This template's folder" };
  }

  /**
   * True when every expected asset matching `test` is still status:
   * "pending"; null when there is nothing to check (no assets manifest, or
   * no matching expected entries at all).
   */
  function pendingAsset(test) {
    var expected = template.assets && Array.isArray(template.assets.expected) ? template.assets.expected : [];
    var matches = expected.filter(test);
    if (!matches.length) return null;
    return matches.every(function (asset) {
      return asset.status === "pending";
    });
  }

  /**
   * Where a ready asset matching `test` is hosted off-site (its manifest
   * `url`, a GitHub Release download the generator has validated); null when
   * it is committed beside the template instead.
   */
  function hostedAsset(test) {
    var expected = template.assets && Array.isArray(template.assets.expected) ? template.assets.expected : [];
    var hosted = expected.filter(function (asset) {
      return test(asset) && asset.status === "ready" && typeof asset.url === "string";
    });
    return hosted.length ? hosted[0].url : null;
  }

  function deliverableRow(config) {
    var status = config.pending
      ? '<span class="tpl-deliverable-status tpl-deliverable-status--pending">Pending</span>'
      : '<span class="tpl-deliverable-status tpl-deliverable-status--ready">Available</span>';
    var action = config.pending
      ? '<a class="tpl-deliverable-link" href="' + escapeHtml(config.planHref) + '">See planned deliverable</a>'
      : '<a class="tpl-deliverable-link" href="' + escapeHtml(config.href) + '">' + escapeHtml(config.actionLabel) + "</a>";
    return (
      '<li class="tpl-deliverable">' +
      '<div class="tpl-deliverable-head"><strong>' + escapeHtml(config.title) + "</strong>" + status + "</div>" +
      "<p>" + escapeHtml(config.note) + "</p>" +
      action +
      "</li>"
    );
  }

  /**
   * A template ships runnable code when the generator finds
   * `code/package.json` in its folder (`source.runnable`). The older
   * `paths.codePackage` manifest entry still counts.
   */
  function codeDeliverable() {
    var shipsCode = !!((template.source && template.source.runnable) || (template.paths && template.paths.codePackage));
    return deliverableRow({
      title: "Runnable implementation",
      pending: !shipsCode,
      planHref: relativeToPage(template.paths.codeReadme),
      href: relativeToPage(template.paths.codeReadme),
      actionLabel: "Read the setup guide",
      note: shipsCode
        ? "The complete source package ships in this folder. Its README covers setup, environment variables, and how to run the agent locally."
        : "No runnable application code ships in this archive. The folder documents the expected setup, environment variables, and test conventions for a first implementation.",
    });
  }

  function videoDeliverable() {
    var pending = pendingAsset(isFilm);
    var hosted = hostedAsset(isFilm);
    if (pending === false && hosted) return filmDeliverable(hosted);
    return deliverableRow({
      title: "Demo film",
      pending: pending !== false,
      planHref: relativeToPage(template.paths.videoReadme),
      href: relativeToPage(template.paths.page) + "video/demo.mp4",
      actionLabel: "Watch the demo",
      note: pending !== false
        ? "The narrated demo recording and poster image are planned but not yet produced."
        : "A narrated demonstration recording is available.",
    });
  }

  /**
   * The hosted film plays at the top of the page; its row keeps the GitHub
   * Release download for a local copy (it is served as an attachment, so
   * opening it saves a file).
   */
  function filmDeliverable(url) {
    var film = template.assets.expected.filter(function (asset) {
      return isFilm(asset) && asset.url === url;
    })[0];
    return (
      '<li class="tpl-deliverable">' +
      '<div class="tpl-deliverable-head"><strong>Demo film</strong>' +
      '<span class="tpl-deliverable-status tpl-deliverable-status--ready">Available</span></div>' +
      "<p>" + escapeHtml(film ? film.description : "A narrated demo film.") + "</p>" +
      '<a class="tpl-deliverable-link" href="' + escapeHtml(url) + '">Download the film (MP4)</a>' +
      "</li>"
    );
  }

  /** The one-slide value proposition, a PDF built by scripts/slides. */
  function slidesDeliverable() {
    var pending = pendingAsset(function (asset) {
      return /\/slides\/[^/]+\.pdf$/i.test(asset.path);
    });
    return deliverableRow({
      title: "Value proposition slide",
      pending: pending !== false,
      planHref: relativeToPage(template.paths.slidesReadme),
      href: relativeToPage(template.paths.page) + "slides/" + template.id + ".pdf",
      actionLabel: "Open the slide (PDF)",
      note: pending === false
        ? "One slide for business decision-makers: the potential outcomes, who it\u2019s for, success measures, system touchpoints, and build complexity."
        : "The one-slide overview (PDF), editable deck, and preview image are planned but not yet produced.",
    });
  }

  function detailRow(label, html) {
    return "<div><dt>" + escapeHtml(label) + "</dt><dd>" + html + "</dd></div>";
  }

  /** The film's running time ("2:13"), read from its manifest description. */
  function runtimeOf(film) {
    var match = film && typeof film.description === "string" ? /\((\d+:\d{2})\)/.exec(film.description) : null;
    return match ? match[1] : "";
  }

  function spokenRuntime(runtime) {
    var parts = runtime.split(":");
    var minutes = Number(parts[0]);
    var seconds = Number(parts[1]);
    var words = [];
    if (minutes) words.push(minutes + (minutes === 1 ? " minute" : " minutes"));
    if (seconds) words.push(seconds + (seconds === 1 ? " second" : " seconds"));
    return words.join(" ");
  }

  var PLAY_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M7 5.3a1.3 1.3 0 0 1 2-1.1l10.4 6.7a1.3 1.3 0 0 1 0 2.2L9 19.8a1.3 1.3 0 0 1-2-1.1Z"/></svg>';

  /**
   * The film in the device frame, as in the gallery: a glass play button over
   * the poster that hands over to the player's own controls once it starts.
   * It plays from the first source that loads: the copy the Pages build
   * mirrors beside this page, then the GitHub Release download (Safari on
   * iPhone may refuse the release download).
   */
  function stageMarkup(film, poster) {
    var posterSrc = poster ? relativeToPage(poster.path) : "";
    if (film) {
      var runtime = runtimeOf(film);
      var sources = [relativeToPage(film.path)];
      if (typeof film.url === "string" && film.url) sources.push(film.url);
      return (
        '<video class="tpl-film" playsinline preload="none"' +
        (posterSrc ? ' poster="' + escapeHtml(posterSrc) + '"' : "") +
        ' aria-label="' + escapeHtml("Narrated demo film: " + template.name) + '">' +
        sources
          .map(function (src) {
            return '<source src="' + escapeHtml(src) + '" type="video/mp4">';
          })
          .join("") +
        "</video>" +
        '<button class="tpl-play" type="button" aria-label="' +
        escapeHtml("Play the film: " + template.name + (runtime ? " (" + spokenRuntime(runtime) + ")" : "")) +
        '"><span class="tpl-glass" aria-hidden="true"></span>' +
        '<span class="tpl-chip" aria-hidden="true">' + PLAY_ICON + "<span>" + escapeHtml(runtime || "Film") + "</span></span>" +
        "</button>"
      );
    }
    var pending = pendingAsset(isFilm) ? '<span class="tpl-chip tpl-chip--pending">Film pending</span>' : "";
    if (posterSrc) {
      return '<img src="' + escapeHtml(posterSrc) + '" width="1920" height="1080" alt="" decoding="async" />' + pending;
    }
    return (
      '<span class="tpl-title-card" aria-hidden="true"><span>' + escapeHtml(template.language) + "</span><strong>" +
      escapeHtml(template.name) + "</strong></span>" + pending
    );
  }

  function render() {
    var repo = repoAction();
    var galleryHash = "../../#" + encodeURIComponent(template.id);
    var film = readyAsset(isFilm);
    var download = film ? (typeof film.url === "string" && film.url ? film.url : relativeToPage(film.path)) : "";
    var tags = Array.isArray(template.tags) ? template.tags : [];

    mount.innerHTML =
      '<article class="tpl" style="' + escapeHtml(themeStyle()) + '">' +
        '<nav class="tpl-bar" aria-label="Gallery">' +
          '<div class="tpl-bar-inner">' +
            '<a class="tpl-brand" href="../../">' + MARK + "<span>Voice AI Templates</span></a>" +
            '<a class="tpl-pill tpl-pill--small" href="../../#templates">All templates</a>' +
          "</div>" +
        "</nav>" +

        '<header class="tpl-hero">' +
          '<div class="tpl-intro">' +
            '<p class="tpl-kicker"><span class="tpl-dot" aria-hidden="true"></span>' + escapeHtml(template.language) + "</p>" +
            '<h1 class="tpl-name">' + escapeHtml(template.name) + "</h1>" +
            '<p class="tpl-headline">' + headlineMarkup(template.headline) + "</p>" +
            '<p class="tpl-sub">' + escapeHtml(template.useCase) + "</p>" +
          "</div>" +
          '<figure class="tpl-stage">' +
            '<div class="tpl-device"><div class="tpl-screen">' + stageMarkup(film, readyAsset(isPoster)) + "</div></div>" +
            (film
              ? '<p class="tpl-film-fallback" hidden>This browser can\u2019t play the film here. <a href="' +
                escapeHtml(download) + '">Download it instead.</a></p>'
              : "") +
            '<figcaption class="tpl-caption"><span>Opening line</span><q>' + escapeHtml(template.prompt) + "</q></figcaption>" +
          "</figure>" +
        "</header>" +

        '<section class="tpl-band" aria-labelledby="tpl-overview-heading">' +
          '<div class="tpl-wrap tpl-overview">' +
            '<h2 class="tpl-eyebrow" id="tpl-overview-heading">Overview</h2>' +
            '<p class="tpl-lede">' + escapeHtml(template.description) + "</p>" +
            (tags.length
              ? '<ul class="tpl-tags" aria-label="Tags">' +
                tags.map(function (tag) { return "<li>" + escapeHtml(tag) + "</li>"; }).join("") +
                "</ul>"
              : "") +
          "</div>" +
        "</section>" +

        '<div class="tpl-band tpl-band--mist">' +
          '<div class="tpl-wrap tpl-cards">' +
            '<section class="tpl-card" aria-labelledby="tpl-business-heading">' +
              '<h2 class="tpl-card-title" id="tpl-business-heading">Business case</h2>' +
              '<dl class="tpl-details">' +
                detailRow("Buyer", escapeHtml(template.business.buyer)) +
                detailRow("Application", escapeHtml(template.business.application)) +
                detailRow("Potential outcomes", escapeHtml(template.business.roi)) +
                detailRow("Success measures", escapeHtml(template.business.metrics)) +
              "</dl>" +
            "</section>" +
            '<section class="tpl-card" aria-labelledby="tpl-technical-heading">' +
              '<h2 class="tpl-card-title" id="tpl-technical-heading">Technical fit</h2>' +
              '<dl class="tpl-details">' +
                detailRow(
                  "Implementation complexity",
                  '<span class="tpl-detail-meter">' + meterMarkup(template.technical.complexity) +
                    escapeHtml(template.technical.complexity) + "</span>"
                ) +
                detailRow("System touchpoints", escapeHtml(template.technical.systems)) +
                detailRow("Initial build scope", escapeHtml(template.technical.build)) +
                detailRow("Readiness", escapeHtml(template.readiness)) +
              "</dl>" +
            "</section>" +
          "</div>" +
        "</div>" +

        '<section class="tpl-band" aria-labelledby="tpl-deliverables-heading">' +
          '<div class="tpl-wrap">' +
            '<h2 class="tpl-title" id="tpl-deliverables-heading">Deliverables</h2>' +
            '<ul class="tpl-deliverables">' +
              codeDeliverable() +
              videoDeliverable() +
              slidesDeliverable() +
            "</ul>" +
            '<div class="tpl-actions">' +
              '<a class="tpl-pill" href="' + escapeHtml(repo.href) + '"' +
                (repo.href.indexOf("http") === 0 ? ' target="_blank" rel="noreferrer"' : "") +
                ">" + escapeHtml(repo.label) + "</a>" +
              '<a class="tpl-pill tpl-pill--quiet" href="' + escapeHtml(galleryHash) + '">Open in the gallery</a>' +
            "</div>" +
          "</div>" +
        "</section>" +
      "</article>";

    mount.classList.add("is-rendered");
    wireFilm();
    watchBar();
  }

  /** The glass button starts the film, then the player's own controls take over. */
  function wireFilm() {
    var film = mount.querySelector(".tpl-film");
    if (!film) return;
    var play = mount.querySelector(".tpl-play");
    var fallback = mount.querySelector(".tpl-film-fallback");

    function handOver() {
      if (play.hidden) return;
      film.controls = true;
      play.hidden = true;
    }

    play.addEventListener("click", function () {
      handOver();
      film.focus({ preventScroll: true });
      var started = film.play();
      // A refused start leaves the controls showing; a failed source is handled below.
      if (started && typeof started.catch === "function") started.catch(function () {});
    });
    film.addEventListener("play", handOver);

    // A source that fails fires its error at itself, without bubbling, and
    // the player tries the next one; only the last failing means nothing plays.
    film.addEventListener(
      "error",
      function (event) {
        if (event.target === film || event.target === film.lastElementChild) {
          fallback.hidden = false;
          handOver();
        }
      },
      true
    );
  }

  /** As in the gallery: dark glass over the black hero, light glass over the pages below. */
  function watchBar() {
    var bar = mount.querySelector(".tpl-bar");
    var hero = mount.querySelector(".tpl-hero");
    if (!bar || !hero) return;
    var queued = false;

    function update() {
      queued = false;
      bar.classList.toggle("is-light", hero.getBoundingClientRect().bottom <= bar.offsetHeight / 2);
    }

    function schedule() {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(update);
    }

    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    update();
  }

  render();
})();
