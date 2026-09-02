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

  function paletteStyle() {
    var colors = template.colors || {};
    return (
      "--t-bg:" + colors.bg + ";--t-panel:" + colors.panel + ";--t-accent:" + colors.accent +
      ";--t-ink:" + colors.ink + ";--t-on-accent:" + (template.onAccent || colors.ink) +
      ";--t-font:" + (template.font || "inherit") + ";--t-radius:" + (template.radius || "10px")
    );
  }

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
   * A template ships runnable code when its manifest declares
   * `paths.codePackage` (the imported package manifest). Folders that only
   * carry documentation omit that path and stay pending.
   */
  function codeDeliverable() {
    var shipsCode = !!(template.paths && template.paths.codePackage);
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
    var pending = pendingAsset(function (asset) {
      return /\.mp4$/i.test(asset.path);
    });
    return deliverableRow({
      title: "Video walkthrough",
      pending: pending !== false,
      planHref: relativeToPage(template.paths.videoReadme),
      href: relativeToPage(template.paths.page) + "video/demo.mp4",
      actionLabel: "Watch the demo",
      note: pending === false
        ? "A narrated demonstration recording is available."
        : "The narrated demo recording and poster image are planned but not yet produced.",
    });
  }

  function slidesDeliverable() {
    var pending = pendingAsset(function (asset) {
      return /\.pptx$/i.test(asset.path);
    });
    return deliverableRow({
      title: "Presentation slides",
      pending: pending !== false,
      planHref: relativeToPage(template.paths.slidesReadme),
      href: relativeToPage(template.paths.page) + "slides/" + template.id + ".pptx",
      actionLabel: "Open the slides",
      note: pending === false
        ? "An editable presentation deck is available."
        : "The editable deck, PDF export, and preview image are planned but not yet produced.",
    });
  }

  function detailRow(label, value) {
    return '<div class="tpl-detail-row"><span>' + escapeHtml(label) + "</span><strong>" + escapeHtml(value) + "</strong></div>";
  }

  function render() {
    var repo = repoAction();
    var galleryHash = "../../#" + encodeURIComponent(template.id);

    mount.innerHTML =
      '<a class="tpl-back" href="../../">&larr; Back to the full catalogue</a>' +
      '<article class="tpl" style="' + paletteStyle() + '">' +
        '<header class="tpl-head">' +
          '<p class="tpl-kicker">Voice AI template \u00b7 ' + escapeHtml(template.assistant) + "</p>" +
          "<h1>" + escapeHtml(template.name) + "</h1>" +
          '<p class="tpl-sub">' + escapeHtml(template.language) + " \u2014 " + escapeHtml(template.useCase) + "</p>" +
          '<p class="tpl-headline">' + escapeHtml(template.headline) + "</p>" +
          '<ul class="tpl-tags">' +
            template.tags.map(function (tag) { return "<li>" + escapeHtml(tag) + "</li>"; }).join("") +
          "</ul>" +
        "</header>" +

        '<section class="tpl-section" aria-labelledby="tpl-overview-heading">' +
          '<h2 id="tpl-overview-heading">Overview</h2>' +
          "<p>" + escapeHtml(template.description) + "</p>" +
          '<blockquote class="tpl-prompt">&ldquo;' + escapeHtml(template.prompt) + '&rdquo;</blockquote>' +
        "</section>" +

        '<div class="tpl-grid">' +
          '<section class="tpl-card" aria-labelledby="tpl-business-heading">' +
            '<h2 id="tpl-business-heading">Business case</h2>' +
            detailRow("Buyer", template.business.buyer) +
            detailRow("Application", template.business.application) +
            detailRow("Potential outcomes", template.business.roi) +
            detailRow("Success measures", template.business.metrics) +
          "</section>" +
          '<section class="tpl-card" aria-labelledby="tpl-technical-heading">' +
            '<h2 id="tpl-technical-heading">Technical fit</h2>' +
            detailRow("Complexity", template.technical.complexity) +
            detailRow("System touchpoints", template.technical.systems) +
            detailRow("Initial build scope", template.technical.build) +
            detailRow("Readiness", template.readiness) +
          "</section>" +
        "</div>" +

        '<section class="tpl-section" aria-labelledby="tpl-deliverables-heading">' +
          '<h2 id="tpl-deliverables-heading">Deliverables</h2>' +
          '<ul class="tpl-deliverables">' +
            codeDeliverable() +
            videoDeliverable() +
            slidesDeliverable() +
          "</ul>" +
        "</section>" +

        '<div class="tpl-actions">' +
          '<a class="tpl-action tpl-action--primary" href="' + escapeHtml(repo.href) + '"' +
            (repo.href.indexOf("http") === 0 ? ' target="_blank" rel="noreferrer"' : "") +
            ">" + escapeHtml(repo.label) + "</a>" +
          '<a class="tpl-action tpl-action--secondary" href="' + escapeHtml(galleryHash) + '">Open in the gallery</a>' +
        "</div>" +
      "</article>";
  }

  render();
})();
