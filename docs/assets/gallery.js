/**
 * GitHub Pages gallery script for the generated voice agent template catalogue.
 * Template content comes from window.VOICE_AI_TEMPLATES, populated by
 * docs/data/templates.js.
 */
(function () {
  "use strict";

  var FEATURED_TEMPLATE_ID = "intent-based-call-routing";

  function compareTemplates(left, right, descending) {
    var leftIsFeatured = left.id === FEATURED_TEMPLATE_ID;
    var rightIsFeatured = right.id === FEATURED_TEMPLATE_ID;
    if (leftIsFeatured !== rightIsFeatured) return leftIsFeatured ? -1 : 1;
    return descending ? right.name.localeCompare(left.name) : left.name.localeCompare(right.name);
  }

  var CATALOG = Array.isArray(window.VOICE_AI_TEMPLATES)
    ? window.VOICE_AI_TEMPLATES.slice().sort(function (left, right) {
        return compareTemplates(left, right, false);
      })
    : [];

  // Optional repository metadata ({owner, name, branch}) written by
  // scripts/generate-template-index.js next to window.VOICE_AI_TEMPLATES.
  // Absent/invalid when unresolved; the GitHub link then falls back to a
  // relative folder link, so this is never required for the gallery to work.
  var REPO =
    window.VOICE_AI_REPO && isNonEmptyString(window.VOICE_AI_REPO.owner) && isNonEmptyString(window.VOICE_AI_REPO.name)
      ? window.VOICE_AI_REPO
      : null;

  function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function decisionBriefOf(template) {
    return {
      buyer: template.business.buyer,
      application: template.business.application,
      roi: template.business.roi,
      metrics: template.business.metrics,
      complexity: template.technical.complexity,
      systems: template.technical.systems,
      build: template.technical.build,
    };
  }

  var AGENTS = {
    claude: {
      label: "Claude Code",
      build: function (brief) {
        return "claude -p " + JSON.stringify(brief);
      },
    },
    codex: {
      label: "Codex CLI",
      build: function (brief) {
        return "codex exec " + JSON.stringify(brief);
      },
    },
    copilot: {
      label: "GitHub Copilot",
      app: true,
      build: function (brief) {
        return "copilot -p " + JSON.stringify(brief);
      },
    },
    cursor: {
      label: "Cursor Agent",
      build: function (brief) {
        return "cursor-agent -p " + JSON.stringify(brief);
      },
    },
    gemini: {
      label: "Gemini CLI",
      build: function (brief) {
        return "gemini -p " + JSON.stringify(brief);
      },
    },
  };

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Discovery-search links are a defensive fallback for malformed external
   * template data that does not declare folder-owned paths or assets.
   */
  function discoverySearchLinks(template) {
    var query = encodeURIComponent(template.name + " " + template.language + " voice AI interface");
    return {
      repo: "https://github.com/search?q=" + query + "&type=repositories",
      video: "https://www.youtube.com/results?search_query=" + query,
      deck: "https://www.slideshare.net/search/slideshow?q=" + query,
    };
  }

  /**
   * True when every expected asset matching `test` is still status:
   * "pending"; null when the template has no asset manifest to check.
   */
  function pendingAsset(template, test) {
    var expected = template.assets && Array.isArray(template.assets.expected) ? template.assets.expected : null;
    if (!expected) return null;
    var matches = expected.filter(test);
    if (!matches.length) return null;
    return matches.every(function (asset) {
      return asset.status === "pending";
    });
  }

  /**
   * The manifest entry of a ready asset matching `test` that is hosted
   * off-site: its `url` is a GitHub Release download the generator has
   * validated, and the Pages build mirrors that file onto this site at its
   * `path` (scripts/mirror-hosted-films.js). Null when the asset is committed
   * beside the template instead.
   */
  function hostedAsset(template, test) {
    var expected = template.assets && Array.isArray(template.assets.expected) ? template.assets.expected : [];
    var hosted = expected.filter(function (asset) {
      return test(asset) && asset.status === "ready" && typeof asset.url === "string";
    });
    return hosted.length ? hosted[0] : null;
  }

  function isFilm(asset) {
    return /\.mp4$/i.test(asset.path);
  }

  /**
   * GitHub link for a template's own folder: an absolute link into the
   * configured repository (window.VOICE_AI_REPO, written by
   * scripts/generate-template-index.js) when available, otherwise a
   * relative folder link that stays valid under a GitHub Pages project
   * subpath (no leading slash). A discovery search is the final fallback for
   * malformed external entries with no folder-owned path.
   */
  function repoReference(template) {
    var page = template.paths && template.paths.page;
    if (!page) return { href: discoverySearchLinks(template).repo };
    if (REPO) {
      var branch = REPO.branch || "main";
      return { href: "https://github.com/" + REPO.owner + "/" + REPO.name + "/tree/" + branch + "/docs/" + page };
    }
    return { href: page };
  }

  /**
   * A hosted film also carries the template id: a plain click plays it in the
   * film player (openFilm) rather than downloading it, which is all a GitHub
   * Release download does when opened directly.
   */
  function videoReference(template) {
    var pending = pendingAsset(template, isFilm);
    if (pending === null) return { href: discoverySearchLinks(template).video };
    if (pending) return { pending: true };
    var hosted = hostedAsset(template, isFilm);
    if (hosted) return { href: hosted.url, film: template.id };
    return { href: (template.paths && template.paths.page ? template.paths.page : "") + "video/demo.mp4" };
  }

  /** The template's one-slide value proposition, a PDF built by scripts/slides. */
  function deckReference(template) {
    var pending = pendingAsset(template, function (asset) {
      return /\/slides\/[^/]+\.pdf$/i.test(asset.path);
    });
    if (pending === null) return { href: discoverySearchLinks(template).deck };
    if (pending) return { pending: true };
    return { href: (template.paths && template.paths.page ? template.paths.page : "") + "slides/" + template.id + ".pdf" };
  }

  function references(template) {
    return {
      repo: repoReference(template),
      video: videoReference(template),
      deck: deckReference(template),
    };
  }

  /** The first ready asset matching `test`, or null. */
  function readyAsset(template, test) {
    var expected = template.assets && Array.isArray(template.assets.expected) ? template.assets.expected : [];
    return (
      expected.filter(function (asset) {
        return test(asset) && asset.status === "ready";
      })[0] || null
    );
  }

  function isPoster(asset) {
    return /\/poster\.webp$/i.test(asset.path);
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

  /**
   * A template's accent as custom properties: --t-accent as written, for dots
   * on light surfaces, and --glow as an "r, g, b" triplet bright enough to read
   * on black. Anything but a hex color keeps the neutral theme.
   */
  function themeStyle(template) {
    var accent = template.colors && template.colors.accent;
    var rgb = hexRgb(accent);
    if (!rgb) return "";
    return "--t-accent:" + accent.trim() + ";--glow:" + brightRgb(rgb).join(",");
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

  function filmLabel(template, runtime) {
    return "Watch the film: " + template.name + (runtime ? " (" + spokenRuntime(runtime) + ")" : "");
  }

  var COUNT_WORDS = [
    "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen", "Twenty",
  ];

  function countWordOf(count) {
    return COUNT_WORDS[count] || String(count);
  }

  /**
   * A docs-relative template path as an agent-readable reference: an
   * absolute GitHub URL when the repository is configured, otherwise the
   * repository-relative path (docs/...).
   */
  function sourceRef(docsPath) {
    if (!REPO) return "docs/" + docsPath;
    var kind = /\/$/.test(docsPath) ? "tree" : "blob";
    return (
      "https://github.com/" + REPO.owner + "/" + REPO.name + "/" + kind + "/" + (REPO.branch || "main") + "/docs/" + docsPath
    );
  }

  /** The template's source and artifacts, most authoritative first. */
  function sourceArtifacts(template) {
    var paths = template.paths || {};
    var source = template.source || {};
    var entries = [];
    function add(label, docsPath) {
      if (docsPath) entries.push({ label: label, ref: sourceRef(docsPath) });
    }
    add("Template folder", paths.page);
    add("Spec (decisions of record)", source.spec);
    add("Overview", paths.readme);
    add("Implementation guide", paths.codeReadme);
    add("Environment variables", paths.codeEnvironment);
    (source.code || []).forEach(function (docsPath) {
      add("Reference implementation", docsPath);
    });
    add("Architecture diagram", paths.architecture);
    add("Demo transcript", paths.transcript);
    add("Slide outline", paths.slidesReadme);
    add("Manifest", paths.manifest);
    return entries;
  }

  /**
   * Points the agent at the template's own source (spec, guides, runnable
   * code, and artifacts) instead of restating it; the business and
   * technical fields also appear in full in the cards next to this command.
   */
  function implementationBrief(template) {
    var brief = decisionBriefOf(template);
    var source = template.source || {};
    var artifacts = sourceArtifacts(template);
    var readFirst = source.spec
      ? "Read the spec first and treat its decisions as requirements; where the spec is silent, follow the implementation guide."
      : "Read the overview and implementation guide first and follow their decisions.";
    var codeNote = source.runnable
      ? "- Start from the runnable reference implementation; keep its offline mode and tests passing.\n"
      : "- Follow the conventions of the runnable reference templates in this gallery.\n";
    return (
      'Implement a proof-of-concept for the "' +
      template.name +
      '" voice agent (' +
      template.language +
      ").\n\n" +
      "Goal: " +
      brief.application +
      "\nBuild scope: " +
      brief.build +
      '\nOpening line: "' +
      template.prompt +
      '"\n\n' +
      (artifacts.length
        ? "Template source and artifacts:\n" +
          artifacts
            .map(function (entry) {
              return "- " + entry.label + ": " + entry.ref;
            })
            .join("\n") +
          "\n\n" +
          readFirst +
          "\n\n"
        : "") +
      "Requirements:\n" +
      "- Reuse the existing stack's components, conventions, and build system.\n" +
      codeNote +
      "- Cover listening, thinking, speaking, confirmation, transfer, and failure states.\n" +
      "- Use synthetic data and document the identity, consent, retention, audit, and abuse controls required for production.\n" +
      "- Test with representative calls and run existing checks before sharing the result."
    );
  }

  var COPILOT_LAUNCHER = "https://github.com/copilot/app/launch?open=";
  /** Stay well under common server request-line limits for the launcher. */
  var COPILOT_LINK_LIMIT = 7000;

  /**
   * GitHub Copilot app deep link that starts a plan-mode session on this
   * gallery's repository with the build prompt prefilled. Returns null when
   * no repository is configured (local builds), where the caller copies the
   * prompt and opens the app's New view instead. The app always confirms
   * before creating the session.
   */
  function copilotAppLink(template, brief) {
    if (!REPO) return null;
    function launch(prompt) {
      var appLink =
        "ghapp://session/new?repo=" +
        encodeURIComponent(REPO.owner + "/" + REPO.name) +
        "&branch=" +
        encodeURIComponent(REPO.branch || "main") +
        "&mode=plan&prompt=" +
        encodeURIComponent(prompt);
      return COPILOT_LAUNCHER + encodeURIComponent(appLink);
    }
    var link = launch(brief);
    if (link.length <= COPILOT_LINK_LIMIT) return link;
    var source = template.source || {};
    var paths = template.paths || {};
    return launch(
      'Implement a proof-of-concept for the "' +
        template.name +
        '" voice agent. Read ' +
        sourceRef(source.spec || paths.readme || paths.page) +
        " and the rest of " +
        sourceRef(paths.page) +
        " (implementation guide, environment variables, architecture, and demo transcript) first, then follow its decisions."
    );
  }

  /** Short, non-duplicative checks; the full business/technical fields are their own cards. */
  function acceptanceChecks(template) {
    return [
      "Completes the workflow end to end with human escalation",
      "Handles transfer, exceptions, and failure recovery",
      "Meets this template's success measures",
      "Follows required identity, privacy, and retention rules",
    ];
  }

  /** Clipboard API first, with a selection fallback and an explicit failure path. */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var field = document.createElement("textarea");
      field.value = text;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.top = "-1000px";
      document.body.appendChild(field);
      field.select();
      var copied = false;
      try {
        copied = document.execCommand("copy");
      } catch (error) {
        copied = false;
      }
      document.body.removeChild(field);
      if (copied) resolve();
      else reject(new Error("The browser blocked the copy request."));
    });
  }

  function focusableIn(container) {
    return container.querySelectorAll(
      'a[href], button:not([disabled]), select, textarea, input, video[controls], [tabindex]:not([tabindex="-1"])'
    );
  }

  var state = { query: "", sort: "name" };
  var active = null;
  var lastFocused = null;
  var filmOpener = null;
  var toastTimer = null;

  function $(selector) {
    return document.querySelector(selector);
  }

  var catalogueEl = $("#catalogue");
  var emptyEl = $("#emptyNotice");
  var statusEl = $("#catalogueStatus");
  var searchInput = $("#searchInput");
  var sortSelect = $("#sortSelect");
  var viewerEl = $("#viewer");
  var sheetEl = $("#viewerSheet");
  var agentSelect = $("#agentSelect");
  var toastEl = $("#toast");
  var filmEl = $("#film");
  var filmSheetEl = $("#filmSheet");
  var filmVideoEl = $("#filmVideo");
  var filmFallbackEl = $("#filmFallback");
  var filmKickerEl = $("#filmKicker");
  var filmDisclosureEl = $("#filmDisclosure");
  var FILM_KICKER = filmKickerEl.textContent;
  var FILM_DISCLOSURE = filmDisclosureEl.textContent;

  function referenceIconMarkup(kind) {
    if (kind === "repo") {
      return (
        '<span class="reference-icon reference-icon--github" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24"><path d="M12 2.6a9.6 9.6 0 0 0-3 18.7c.5.1.7-.2.7-.5v-1.9c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.6 1 1.6 1 .9 1.6 2.4 1.1 2.9.8.1-.7.4-1.1.6-1.4-2.3-.3-4.7-1.1-4.7-4.8 0-1.1.4-1.9 1-2.6-.1-.3-.4-1.3.1-2.6 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.3.2 2.3.1 2.6.6.7 1 1.5 1 2.6 0 3.7-2.4 4.5-4.7 4.8.4.3.7 1 .7 1.9v2.9c0 .4.2.6.7.5A9.6 9.6 0 0 0 12 2.6Z"/></svg>' +
        "</span>"
      );
    }
    if (kind === "video") {
      return (
        '<span class="reference-icon reference-icon--video" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10 5-2.5v9L16 14Z"/><path d="m9 9 4 3-4 3Z"/></svg>' +
        "</span>"
      );
    }
    return (
      '<span class="reference-icon reference-icon--deck" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2.5"/><path d="M12 17v3M8 20h8"/><path d="M7 13V8h2.1a1.8 1.8 0 1 1 0 3.6H7"/></svg>' +
      "</span>"
    );
  }

  function referenceLinkMarkup(kind, ref, templateName) {
    var labels = { repo: "GitHub", video: "Watch the film", deck: "PDF" };
    var pendingLabels = { repo: "GitHub", video: "Film", deck: "PDF" };
    var titles = {
      repo: "Open the GitHub repository folder for ",
      video: "Watch the demo film for ",
      deck: "Open the one-slide overview (PDF) for ",
    };
    if (ref && ref.pending) {
      return (
        '<span class="reference-link reference-link--pending" title="' +
        escapeHtml(pendingLabels[kind]) +
        " for " +
        escapeHtml(templateName) +
        " is not recorded yet" +
        '" aria-disabled="true">' +
        referenceIconMarkup(kind) +
        escapeHtml(pendingLabels[kind]) +
        ' <span class="reference-pending-tag">Pending</span>' +
        "</span>"
      );
    }
    return (
      '<a class="reference-link" href="' +
      escapeHtml(ref.href) +
      '"' +
      (ref.film ? ' data-film="' + escapeHtml(ref.film) + '"' : "") +
      ' target="_blank" rel="noreferrer" title="' +
      titles[kind] +
      escapeHtml(templateName) +
      '">' +
      referenceIconMarkup(kind) +
      labels[kind] +
      "</a>"
    );
  }

  function referenceMarkup(template, kinds) {
    var links = references(template);
    var selectedKinds = kinds || ["repo", "video", "deck"];
    return (
      '<div class="reference-links">' +
      selectedKinds
        .map(function (kind) {
          return referenceLinkMarkup(kind, links[kind], template.name);
        })
        .join("") +
      "</div>"
    );
  }

  function matchesQuery(template) {
    if (!state.query) return true;
    return (
      [
        template.name,
        template.language,
        template.useCase,
        template.description,
        template.tags.join(" "),
      ]
        .join(" ")
        .toLowerCase()
        .indexOf(state.query) !== -1
    );
  }

  function visible() {
    var list = CATALOG.filter(function (template) {
      return matchesQuery(template);
    });
    return list.slice().sort(function (left, right) {
      return compareTemplates(left, right, state.sort === "name-desc");
    });
  }

  function findTemplate(id) {
    return (
      CATALOG.filter(function (item) {
        return item.id === id;
      })[0] || null
    );
  }

  var PLAY_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M7 5.3a1.3 1.3 0 0 1 2-1.1l10.4 6.7a1.3 1.3 0 0 1 0 2.2L9 19.8a1.3 1.3 0 0 1-2-1.1Z"/></svg>';

  var METER_LEVELS = { low: 1, medium: 2, high: 3 };

  function meterMarkup(complexity) {
    return (
      '<span class="meter" data-level="' +
      (METER_LEVELS[String(complexity).toLowerCase()] || 0) +
      '" aria-hidden="true"><i></i><i></i><i></i></span>'
    );
  }

  /** The film's poster frame, or a title card in the films' style until there is one. */
  function artMarkup(template, eager) {
    var poster = readyAsset(template, isPoster);
    if (poster) {
      return (
        '<img src="' +
        escapeHtml(poster.path) +
        '" width="1920" height="1080" alt=""' +
        (eager ? "" : ' loading="lazy"') +
        ' decoding="async" />'
      );
    }
    return (
      '<span class="title-card" aria-hidden="true"><span class="title-card-eyebrow">' +
      escapeHtml(template.language) +
      '</span><span class="title-card-name">' +
      escapeHtml(template.name) +
      "</span></span>"
    );
  }

  /**
   * The link that plays a template's film over the page (data-film) or, for a
   * film committed beside the template, opens it in a new tab. Null while the
   * film is pending or the template has no asset manifest.
   */
  function filmLinkAttributes(template) {
    if (pendingAsset(template, isFilm) !== false) return null;
    var video = videoReference(template);
    var runtime = runtimeOf(readyAsset(template, isFilm));
    return {
      runtime: runtime,
      html:
        ' href="' +
        escapeHtml(video.href) +
        '"' +
        (video.film ? ' data-film="' + escapeHtml(video.film) + '"' : ' target="_blank" rel="noreferrer"') +
        ' aria-label="' +
        escapeHtml(filmLabel(template, runtime)) +
        '"',
    };
  }

  function runtimeChipMarkup(runtime) {
    return (
      '<span class="tile-chip" aria-hidden="true">' + PLAY_ICON + "<span>" + escapeHtml(runtime || "Film") + "</span></span>"
    );
  }

  function pendingChipMarkup(template) {
    return pendingAsset(template, isFilm) ? '<span class="tile-chip tile-chip--pending">Film pending</span>' : "";
  }

  function tileMediaMarkup(template) {
    var link = filmLinkAttributes(template);
    if (!link) return '<div class="tile-media">' + artMarkup(template) + pendingChipMarkup(template) + "</div>";
    return '<a class="tile-media"' + link.html + ">" + artMarkup(template) + runtimeChipMarkup(link.runtime) + "</a>";
  }

  function tileMarkup(template) {
    var id = escapeHtml(template.id);
    var complexity = template.technical.complexity;
    return (
      '<article class="tile" id="plate-' +
      id +
      '" data-open="' +
      id +
      '" style="' +
      escapeHtml(themeStyle(template)) +
      '">' +
      tileMediaMarkup(template) +
      '<div class="tile-body">' +
      '<p class="tile-eyebrow"><span class="dot" aria-hidden="true"></span>' +
      escapeHtml(template.language) +
      "</p>" +
      '<h3 class="tile-title"><button class="tile-open" type="button" data-open="' +
      id +
      '">' +
      escapeHtml(template.name) +
      "</button></h3>" +
      '<p class="tile-tagline">' +
      escapeHtml(template.headline) +
      "</p>" +
      '<p class="tile-meta">' +
      meterMarkup(complexity) +
      escapeHtml(complexity) +
      " complexity</p>" +
      '<div class="tile-actions">' +
      '<button class="pill pill--small" type="button" data-open="' +
      id +
      '" data-open-section="build">Build this agent<span class="sr-only">: ' +
      escapeHtml(template.name) +
      "</span></button>" +
      referenceMarkup(template, ["repo"]) +
      "</div></div></article>"
    );
  }

  var reducedMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

  function motionAllowed() {
    return !(reducedMotion && reducedMotion.matches);
  }

  /**
   * Sections and tiles arrive as they scroll into view, the way the films
   * bring each card on. Tiles entering together cascade. Without
   * IntersectionObserver, or with reduced motion, everything is simply shown.
   */
  var arrivals =
    "IntersectionObserver" in window && motionAllowed()
      ? new window.IntersectionObserver(
          function (entries, observer) {
            var cascade = 0;
            entries.forEach(function (entry) {
              if (!entry.isIntersecting) return;
              observer.unobserve(entry.target);
              if (entry.target.classList.contains("tile")) {
                entry.target.style.setProperty("--delay", Math.min(cascade, 5) * 80 + "ms");
                cascade += 1;
              }
              arrive(entry.target);
            });
          },
          { rootMargin: "0px 0px -8% 0px" }
        )
      : null;

  function arrive(element) {
    element.classList.remove("is-pending");
    element.classList.add("is-arriving");
    element.addEventListener("animationend", function settle(event) {
      if (event.target !== element) return;
      element.removeEventListener("animationend", settle);
      element.classList.remove("is-arriving");
    });
  }

  function inView(element) {
    var rect = element.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.bottom > 0;
  }

  /** Holds `element` back until it scrolls into view; content already on screen stays put. */
  function awaitArrival(element, evenInView) {
    if (!arrivals || (!evenInView && inView(element))) return;
    element.classList.add("is-pending");
    arrivals.observe(element);
  }

  var catalogueShown = false;

  function renderCatalogue() {
    var list = visible();
    if (arrivals) {
      Array.prototype.forEach.call(catalogueEl.children, function (tile) {
        arrivals.unobserve(tile);
      });
    }
    catalogueEl.innerHTML = list.map(tileMarkup).join("");
    var isEmpty = list.length === 0;
    emptyEl.hidden = !isEmpty;
    emptyEl.setAttribute("aria-hidden", String(!isEmpty));
    statusEl.textContent =
      list.length +
      (list.length === 1 ? " template shown" : " templates shown") +
      " of " +
      CATALOG.length;
    // Only the first showing arrives; searching and sorting answer instantly.
    if (!catalogueShown) {
      catalogueShown = true;
      Array.prototype.forEach.call(catalogueEl.children, function (tile) {
        awaitArrival(tile, true);
      });
    }
  }

  function renderCommand() {
    if (!active) return;
    var agent = AGENTS[agentSelect.value] || AGENTS.copilot;
    var brief = implementationBrief(active);
    $("#commandLabel").textContent = agent.label;
    $("#commandText").textContent = agent.build(brief);
    var appButton = $("#openCopilotApp");
    appButton.hidden = !agent.app;
    if (agent.app) {
      appButton.href = copilotAppLink(active, brief) || "ghapp://";
      appButton.dataset.local = REPO ? "" : "true";
    }
  }

  /**
   * Deep-link support for `#<template-id>`. `history.replaceState` updates
   * the address bar without navigating or firing `hashchange`, so opening
   * and closing a plate never triggers its own listener (no history loop);
   * only external changes (back/forward, a pasted/typed hash) reach
   * `hashchange` below.
   */
  function syncHash(id) {
    var current = window.location.hash.slice(1);
    if (id) {
      if (current === id) return;
      window.history.replaceState(window.history.state, "", "#" + id);
    } else if (current) {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
  }

  /** A headline in the films' type: the second sentence, or the turn after a dash, in the gradient. */
  function headlineMarkup(text) {
    var value = String(text || "").trim();
    var split = /^(.+?[.?!])\s+(\S.*)$/.exec(value) || /^(.+?\u2014)(\S.*)$/.exec(value);
    if (!split) return '<span class="gradient">' + escapeHtml(value) + "</span>";
    return escapeHtml(split[1]) + '<br /><span class="gradient">' + escapeHtml(split[2]) + "</span>";
  }

  /** The template's film, framed like the device in the films. */
  function stageMarkup(template) {
    var link = filmLinkAttributes(template);
    var screen = link
      ? '<a class="device-play"' +
        link.html +
        ">" +
        artMarkup(template, true) +
        '<span class="glass-play glass-play--low" aria-hidden="true"></span>' +
        (link.runtime ? runtimeChipMarkup(link.runtime) : "") +
        "</a>"
      : artMarkup(template, true) + pendingChipMarkup(template);
    return '<div class="device"><div class="device-screen">' + screen + "</div></div>";
  }

  function detailRow(label, html) {
    return "<div><dt>" + escapeHtml(label) + "</dt><dd>" + html + "</dd></div>";
  }

  /** Restarts a class-driven animation. */
  function replay(element, className) {
    element.classList.remove(className);
    void element.offsetWidth;
    element.classList.add(className);
  }

  /** Brings the sheet's build section into view and readies the copy button. */
  function showBuild(smooth) {
    var top = Math.max(0, sheetEl.offsetTop + $("#viewerBuild").offsetTop - 16);
    if (smooth && motionAllowed() && typeof viewerEl.scrollTo === "function") {
      viewerEl.scrollTo({ top: top, behavior: "smooth" });
    } else {
      viewerEl.scrollTop = top;
    }
    $("#copyCommand").focus({ preventScroll: true });
  }

  /**
   * Opens a template's sheet, or swaps it in when the sheet is already open.
   * `section` "build" lands on the build brief instead of the film.
   */
  function openPlate(id, section) {
    var template = findTemplate(id);
    if (!template) return;
    var stepping = !viewerEl.hidden;
    if (!stepping) lastFocused = document.activeElement;
    active = template;
    syncHash(template.id);
    var brief = decisionBriefOf(template);
    var pool = visible();
    var position = pool.findIndex(function (item) {
      return item.id === template.id;
    });
    if (position < 0) {
      pool = CATALOG;
      position = pool.findIndex(function (item) {
        return item.id === template.id;
      });
    }
    sheetEl.setAttribute("style", themeStyle(template));
    $("#viewerKicker").innerHTML = '<span class="dot" aria-hidden="true"></span>' + escapeHtml(template.language);
    $("#viewerTitle").textContent = template.name;
    $("#viewerHeadline").innerHTML = headlineMarkup(template.headline);
    $("#viewerSub").textContent = template.useCase;
    $("#viewerPosition").textContent = (position + 1) + " / " + pool.length;
    $("#viewerStage").innerHTML = stageMarkup(template);
    $("#viewerCaption").innerHTML = "<span>Opening line</span><q>" + escapeHtml(template.prompt) + "</q>";
    $("#businessCase").innerHTML =
      detailRow("Application", escapeHtml(brief.application)) +
      detailRow("Potential outcomes", escapeHtml(brief.roi)) +
      detailRow("Success measures", escapeHtml(brief.metrics));
    $("#technicalFit").innerHTML =
      detailRow(
        "Implementation complexity",
        '<span class="detail-meter">' + meterMarkup(brief.complexity) + escapeHtml(brief.complexity) + "</span>"
      ) +
      detailRow("Readiness", 'Illustrative<span class="detail-note">Validate before use</span>') +
      detailRow("System touchpoints", escapeHtml(brief.systems)) +
      detailRow("Initial build scope", escapeHtml(brief.build));
    $("#repoAction").innerHTML = referenceMarkup(template, ["repo"]);
    $("#viewerLinks").innerHTML = referenceMarkup(template, ["video", "deck"]);
    $("#acceptanceList").innerHTML = acceptanceChecks(template)
      .map(function (check) {
        return "<li>" + escapeHtml(check) + "</li>";
      })
      .join("");
    renderCommand();
    // A fresh sheet takes its controls' tone at once; only scrolling fades between tones.
    if (!stepping) controlsEl.classList.toggle("is-dark", section === "build");
    viewerEl.hidden = false;
    document.body.style.overflow = "hidden";
    viewerEl.scrollTop = 0;
    scheduleControls();
    if (stepping) replay(sheetEl, "is-stepping");
    else sheetEl.classList.remove("is-stepping");
    if (section === "build") {
      showBuild(stepping);
      return;
    }
    // Stepping keeps focus on the stepper, unless the focused control was re-rendered away.
    var close = sheetEl.querySelector(".close");
    if (close && (!stepping || !document.activeElement || document.activeElement === document.body)) {
      close.focus({ preventScroll: true });
    }
  }

  function closePlate() {
    if (viewerEl.hidden) return;
    viewerEl.hidden = true;
    active = null;
    syncHash(null);
    document.body.style.overflow = "";
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
  }

  /**
   * Plays a film in place, from the first source that loads: the copy the
   * Pages build mirrors onto this site, then the GitHub Release download.
   * GitHub serves a release download as an attachment, so opening it directly
   * saves a file, and Safari on iPhone may refuse to play it; the same-origin
   * copy is served as video/mp4. The click that opens the player lets it start
   * with sound.
   */
  function playFilm(film, opener) {
    filmOpener = opener || document.activeElement;
    filmKickerEl.textContent = film.kicker || FILM_KICKER;
    filmDisclosureEl.textContent = film.disclosure || FILM_DISCLOSURE;
    $("#filmTitle").textContent = film.title;
    $("#filmDownload").setAttribute("href", film.download);
    $("#filmNotes").setAttribute("href", film.notes);
    filmFallbackEl.hidden = true;
    if (film.poster) filmVideoEl.setAttribute("poster", film.poster);
    else filmVideoEl.removeAttribute("poster");
    filmVideoEl.setAttribute("aria-label", film.label);
    setFilmSources(film.sources);
    filmEl.hidden = false;
    document.body.style.overflow = "hidden";
    $("#filmClose").focus();
    var playing = filmVideoEl.play();
    // A refused autoplay leaves the controls up; a failed load shows the fallback.
    if (playing && typeof playing.catch === "function") playing.catch(function () {});
  }

  /** An empty list stops the player and its download without raising an error. */
  function setFilmSources(sources) {
    filmVideoEl.removeAttribute("src");
    while (filmVideoEl.firstChild) filmVideoEl.removeChild(filmVideoEl.firstChild);
    sources.filter(Boolean).forEach(function (src) {
      var source = document.createElement("source");
      source.setAttribute("src", src);
      source.setAttribute("type", "video/mp4");
      filmVideoEl.appendChild(source);
    });
    filmVideoEl.load();
  }

  function openFilm(id, opener) {
    var template = findTemplate(id);
    var film = template && hostedAsset(template, isFilm);
    if (!film) return;
    var poster = readyAsset(template, isPoster);
    var page = template.paths && template.paths.page ? template.paths.page : "";
    playFilm(
      {
        title: template.name,
        label: "Narrated demo film: " + template.name,
        sources: [film.path, film.url],
        download: film.url,
        notes: REPO
          ? "https://github.com/" + REPO.owner + "/" + REPO.name + "/tree/" + (REPO.branch || "main") + "/docs/" + page + "video"
          : page + "video/transcript.md",
        poster: poster ? poster.path : null,
      },
      opener
    );
  }

  /**
   * The overview reel in the front page's film band. Its links point at the
   * same-origin copy; the section carries the release download and the rest.
   */
  function openReel(link) {
    var reel = $("#reel");
    if (!reel) return;
    var play = $("#reelPlay");
    var copy = play.getAttribute("href");
    var folder = copy.replace(/\/[^/]*$/, "");
    var release = reel.getAttribute("data-film-release");
    var title = reel.getAttribute("data-film-title");
    playFilm(
      {
        kicker: "Overview film",
        title: title,
        label: "Overview film: " + title,
        sources: [copy, release],
        download: release,
        notes: REPO
          ? "https://github.com/" + REPO.owner + "/" + REPO.name + "/tree/" + (REPO.branch || "main") + "/docs/" + folder
          : folder + "/transcript.md",
        poster: reel.getAttribute("data-film-poster"),
        disclosure: reel.getAttribute("data-film-disclosure"),
      },
      // The poster link is hidden from assistive tech, so its focus returns to the play button.
      link && link.getAttribute("aria-hidden") !== "true" ? link : play
    );
  }

  function closeFilm() {
    if (filmEl.hidden) return;
    filmVideoEl.pause();
    setFilmSources([]);
    filmEl.hidden = true;
    if (viewerEl.hidden) document.body.style.overflow = "";
    if (filmOpener && typeof filmOpener.focus === "function") filmOpener.focus();
    filmOpener = null;
  }

  // A source that fails to load fires its error at itself, without bubbling,
  // and the player moves on to the next one. Nothing plays only when the last
  // source fails, or the film itself can't be decoded.
  filmVideoEl.addEventListener(
    "error",
    function (event) {
      if (filmEl.hidden) return;
      if (event.target === filmVideoEl || event.target === filmVideoEl.lastElementChild) filmFallbackEl.hidden = false;
    },
    true
  );

  function stepPlate(delta) {
    if (!active) return;
    var pool = visible();
    var inPool = pool.filter(function (item) {
      return item.id === active.id;
    }).length;
    if (!inPool) pool = CATALOG;
    var current = 0;
    pool.forEach(function (item, index) {
      if (item.id === active.id) current = index;
    });
    var next = pool[(current + delta + pool.length) % pool.length];
    if (next) openPlate(next.id);
  }

  function showToast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toastEl.hidden = true;
    }, 2600);
  }

  function trapFocus(event, container) {
    if (event.key !== "Tab") return;
    var focusable = focusableIn(container);
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  document.addEventListener("click", function (event) {
    // The sheet scrolls inside the scrim, so a click in its gutter lands on the scrim itself.
    if (event.target === viewerEl) {
      closePlate();
      return;
    }
    // Modified clicks keep the link's own behavior: the film file itself.
    var modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
    var filmLink = event.target.closest("a[data-film]");
    if (filmLink && !modified) {
      event.preventDefault();
      openFilm(filmLink.getAttribute("data-film"), filmLink);
      return;
    }
    var reelLink = event.target.closest("a[data-reel]");
    if (reelLink && !modified) {
      event.preventDefault();
      openReel(reelLink);
      return;
    }
    if (event.target.closest("a[href]")) return;
    if (event.target.closest("[data-close-film]")) {
      closeFilm();
      return;
    }
    var chip = event.target.closest("[data-agent]");
    if (chip) {
      chooseAgent(chip.getAttribute("data-agent"));
      return;
    }
    var opener = event.target.closest("[data-open]");
    if (opener) {
      if (opener.getAttribute("data-open")) {
        openPlate(opener.getAttribute("data-open"), opener.getAttribute("data-open-section"));
      }
      return;
    }
    if (event.target.closest("[data-close-viewer]")) {
      closePlate();
      return;
    }
    var stepper = event.target.closest("[data-step]");
    if (stepper) {
      stepPlate(Number(stepper.getAttribute("data-step")));
      return;
    }
  });

  function updateSearch() {
    state.query = searchInput.value.trim().toLowerCase();
    renderCatalogue();
  }

  function updateSort() {
    state.sort = sortSelect.value === "name-desc" ? "name-desc" : "name";
    renderCatalogue();
  }

  searchInput.addEventListener("input", updateSearch);
  searchInput.addEventListener("search", updateSearch);
  sortSelect.addEventListener("change", updateSort);

  /**
   * One coding-agent choice drives both the front page's preview and the
   * sheet's build command. The preview replays its typing on each pick.
   */
  function chooseAgent(key, quiet) {
    var agent = AGENTS[key];
    if (!agent) return;
    Array.prototype.forEach.call(document.querySelectorAll("[data-agent]"), function (chip) {
      chip.setAttribute("aria-pressed", String(chip.getAttribute("data-agent") === key));
    });
    $("#agentDemoLabel").textContent = agent.label;
    $("#agentDemoCommand").textContent = agent.build("").replace(/\s*""$/, "");
    agentSelect.value = key;
    if (!quiet) replay($("#agentDemoBody"), "is-typing");
    renderCommand();
  }

  agentSelect.addEventListener("change", function () {
    chooseAgent(agentSelect.value, true);
  });

  $("#copyCommand").addEventListener("click", function () {
    copyText($("#commandText").textContent)
      .then(function () {
        showToast("Command copied");
      })
      .catch(function (error) {
        showToast("Copy blocked \u2014 select the command manually.");
        if (window.console && window.console.warn) window.console.warn(error);
      });
  });

  // Without a configured repository the link only opens the app's New view,
  // so hand the prompt over via the clipboard.
  $("#openCopilotApp").addEventListener("click", function () {
    if (!active || this.dataset.local !== "true") return;
    copyText(implementationBrief(active))
      .then(function () {
        showToast("Prompt copied \u2014 paste it into the new Copilot session");
      })
      .catch(function () {
        showToast("Copy blocked \u2014 copy the prompt from the command block.");
      });
  });

  document.addEventListener("keydown", function (event) {
    // The film player sits above the plate viewer, so it takes the keys first.
    if (!filmEl.hidden) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeFilm();
      } else {
        trapFocus(event, filmSheetEl);
      }
      return;
    }
    if (viewerEl.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closePlate();
      return;
    }
    trapFocus(event, sheetEl);
    var tag = document.activeElement ? document.activeElement.tagName : "";
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      stepPlate(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      stepPlate(1);
    }
  });

  // React to back/forward navigation or a hand-edited/pasted hash. Opening
  // and closing a plate goes through syncHash()'s replaceState, which does
  // not fire "hashchange" itself, so this listener only ever reacts to
  // changes this script did not just make — no open/close feedback loop.
  // Section anchors (#templates, #reel, #how) close any open sheet.
  window.addEventListener("hashchange", function () {
    var id = window.location.hash.slice(1);
    if (!findTemplate(id)) {
      closePlate();
      return;
    }
    if (!active || active.id !== id) openPlate(id);
  });

  /** Counts and names on the page follow the catalogue, not the copy. */
  function fillFromCatalogue() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-template-count]"), function (element) {
      element.textContent = countWordOf(CATALOG.length);
    });
    var runnable = CATALOG.filter(function (template) {
      return template.source && template.source.runnable;
    }).length;
    var runnableEl = $("[data-runnable]");
    if (runnableEl && !runnable) runnableEl.hidden = true;
    else if (runnableEl && runnable < CATALOG.length) runnableEl.textContent = countWordOf(runnable) + " ready to run.";

    // The film's chapters: each line takes its template's light and name.
    Array.prototype.forEach.call(document.querySelectorAll(".chapter-item[data-open]"), function (button) {
      var template = findTemplate(button.getAttribute("data-open"));
      var item = button.closest("li");
      if (!template) {
        if (item) item.hidden = true;
        return;
      }
      button.setAttribute("style", themeStyle(template));
      var name = button.querySelector("[data-template-name]");
      if (name) name.textContent = template.name;
    });
    Array.prototype.forEach.call(document.querySelectorAll(".chapter"), function (chapter) {
      var shown = Array.prototype.filter.call(chapter.querySelectorAll(".chapter-list > li"), function (item) {
        return !item.hidden;
      });
      if (!shown.length) chapter.hidden = true;
    });

    // The build-brief preview, written from the featured template's own brief.
    var featured = findTemplate(FEATURED_TEMPLATE_ID) || CATALOG[0];
    if (!featured) return;
    var lines = implementationBrief(featured).split("\n");
    $("#agentDemoPrompt").textContent = lines[0];
    $("#agentDemoGoal").textContent =
      lines.filter(function (line) {
        return line.indexOf("Goal: ") === 0;
      })[0] || "";
    $("#agentDemoOpen").setAttribute("data-open", featured.id);
    $("#agentDemo").hidden = false;
    chooseAgent(AGENTS[agentSelect.value] ? agentSelect.value : "copilot", true);
  }

  /** The bar turns dark over the black bands, as it does on apple.com. */
  var navEl = $("#nav");
  var themeColorEl = document.querySelector('meta[name="theme-color"]');
  var darkBands = document.querySelectorAll("[data-nav-dark]");
  var navFrame = 0;

  function updateNav() {
    navFrame = 0;
    var probe = navEl.offsetHeight / 2;
    var dark = Array.prototype.some.call(darkBands, function (band) {
      var rect = band.getBoundingClientRect();
      return rect.top <= probe && rect.bottom >= probe;
    });
    if (navEl.classList.contains("is-dark") === dark) return;
    navEl.classList.toggle("is-dark", dark);
    if (themeColorEl) themeColorEl.setAttribute("content", dark ? "#161617" : "#ffffff");
  }

  function scheduleNav() {
    if (!navFrame) navFrame = window.requestAnimationFrame(updateNav);
  }

  /** The sheet's floating controls turn dark too, over its black build band. */
  var controlsEl = sheetEl.querySelector(".viewer-controls");
  var buildEl = $("#viewerBuild");
  var controlsFrame = 0;

  function updateControls() {
    controlsFrame = 0;
    if (viewerEl.hidden) return;
    var bar = controlsEl.getBoundingClientRect();
    var probe = bar.top + bar.height / 2;
    var band = buildEl.getBoundingClientRect();
    controlsEl.classList.toggle("is-dark", band.top <= probe && band.bottom >= probe);
  }

  function scheduleControls() {
    if (!controlsFrame) controlsFrame = window.requestAnimationFrame(updateControls);
  }

  viewerEl.addEventListener("scroll", scheduleControls, { passive: true });
  window.addEventListener("resize", scheduleControls);

  fillFromCatalogue();
  renderCatalogue();
  Array.prototype.forEach.call(document.querySelectorAll("[data-reveal]"), function (element) {
    awaitArrival(element, false);
  });
  if (navEl) {
    window.addEventListener("scroll", scheduleNav, { passive: true });
    window.addEventListener("resize", scheduleNav);
    updateNav();
  }

  // Deep-link support: open the requested sheet once the catalogue has
  // rendered, so `#<template-id>` links open it on load.
  var initialHash = window.location.hash.slice(1);
  if (findTemplate(initialHash)) openPlate(initialHash);
})();
