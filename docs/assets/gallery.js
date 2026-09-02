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

  // Template folders use descriptive ids while the decorative scene library
  // retains shorter legacy keys.
  var LEGACY_KEY_BY_ID = {
    "intent-based-call-routing": "intent-routing",
    "customer-record-lookup-update": "crm-lookup-update",
    "311-service-assistant": "311-assistant",
    "general-inquiry-agent": "general-inquiry",
    "appointment-reminder-agent": "appointment-reminder",
    "after-hours-sales-lead-capture": "sales-lead-capture",
    "appointment-scheduling-agent": "appointment-scheduling",
    "it-hr-help-desk-triage": "help-desk-triage",
    "bid-price-lookup-agent": "bid-price-lookup",
    "contextual-on-call-pager": "on-call-pager",
  };

  function legacyKeyOf(template) {
    if (VISUAL_SCENES[template.id]) return template.id;
    return LEGACY_KEY_BY_ID[template.id] || template.id;
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
      label: "GitHub Copilot CLI",
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

  function videoReference(template) {
    var pending = pendingAsset(template, function (asset) {
      return /\.mp4$/i.test(asset.path);
    });
    if (pending === null) return { href: discoverySearchLinks(template).video };
    if (pending) return { pending: true };
    return { href: (template.paths && template.paths.page ? template.paths.page : "") + "video/demo.mp4" };
  }

  function deckReference(template) {
    var pending = pendingAsset(template, function (asset) {
      return /\.pptx$/i.test(asset.path);
    });
    if (pending === null) return { href: discoverySearchLinks(template).deck };
    if (pending) return { pending: true };
    return { href: (template.paths && template.paths.page ? template.paths.page : "") + "slides/" + template.id + ".pptx" };
  }

  function references(template) {
    return {
      repo: repoReference(template),
      video: videoReference(template),
      deck: deckReference(template),
    };
  }

  function paletteStyle(template) {
    return (
      "--t-bg:" +
      template.colors.bg +
      ";--t-panel:" +
      template.colors.panel +
      ";--t-accent:" +
      template.colors.accent +
      ";--t-ink:" +
      template.colors.ink +
      ";--t-on-accent:" +
      template.onAccent +
      ";--t-font:" +
      template.font +
      ";--t-radius:" +
      template.radius
    );
  }

  function seedOf(template) {
    var total = 0;
    for (var index = 0; index < template.id.length; index += 1) {
      total += template.id.charCodeAt(index);
    }
    return (total % 17) / 7 + 0.4;
  }

  function waveBars(seed, count) {
    var bars = "";
    for (var index = 0; index < count; index += 1) {
      var height = 20 + Math.abs(Math.sin((index + 1) * seed)) * 74;
      bars += '<i style="--h:' + height.toFixed(0) + '%"></i>';
    }
    return bars;
  }

  /**
   * Kept intentionally short: the business and technical fields already
   * appear in full in the business-case and technical-fit cards next to
   * this command, so the prompt only needs to state the action, the
   * workflow to build, and the opening line an agent should implement.
   */
  function implementationBrief(template) {
    var brief = decisionBriefOf(template);
    return (
      'Implement a proof-of-concept for the "' +
      template.name +
      '" voice agent (' +
      template.language +
      ") in this repository.\n\n" +
      "Goal: " +
      brief.application +
      "\nBuild scope: " +
      brief.build +
      '\nOpening line: "' +
      template.prompt +
      '"\n\nRequirements:\n' +
      "- Reuse the existing stack's components, conventions, and build system.\n" +
      "- Cover listening, thinking, speaking, confirmation, transfer, and failure states.\n" +
      "- Use synthetic data and document the identity, consent, retention, audit, and abuse controls required for production.\n" +
      "- Test with representative calls and run existing checks before sharing the result."
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
      'a[href], button:not([disabled]), select, textarea, input, [tabindex]:not([tabindex="-1"])'
    );
  }

  var state = { query: "", sort: "name" };
  var active = null;
  var lastFocused = null;
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
    var labels = { repo: "GitHub", video: "Video", deck: "PPTX" };
    var titles = {
      repo: "Open the GitHub repository folder for ",
      video: "Watch the video walkthrough for ",
      deck: "Open the presentation slides for ",
    };
    if (ref && ref.pending) {
      return (
        '<span class="reference-link reference-link--pending" title="' +
        escapeHtml(labels[kind]) +
        " for " +
        escapeHtml(templateName) +
        " is not recorded yet" +
        '" aria-disabled="true">' +
        referenceIconMarkup(kind) +
        escapeHtml(labels[kind]) +
        ' <span class="reference-pending-tag">Pending</span>' +
        "</span>"
      );
    }
    return (
      '<a class="reference-link" href="' +
      ref.href +
      '" target="_blank" rel="noreferrer" title="' +
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

  // Compact, decorative line-icon glyphs (24x24 viewBox) giving each scene a
  // recognizable, at-a-glance symbol on top of its node/card labels. Purely
  // decorative — the containing figure already carries the full text
  // description via aria-label/aria-hidden, so every glyph is aria-hidden.
  var SCENE_ICONS = {
    routing:
      '<svg class="visual-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="3"/><circle cx="19" cy="5" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="19" cy="19" r="2"/><path d="M8 12h4M12 12 17 5M12 12h5M12 12 17 19"/></svg>',
    records:
      '<svg class="visual-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2.2"/><path d="M5.5 17c.5-2.5 2.3-4 3.5-4s3 1.5 3.5 4"/><path d="M14 9h4M14 13h4"/></svg>',
    civic:
      '<svg class="visual-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 21V9l8-5 8 5v12"/><path d="M9 21v-6h6v6"/><path d="M4 21h16"/></svg>',
    inquiry:
      '<svg class="visual-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 5h16v11H9l-4 3v-3H4z"/><path d="M9.6 9.2c0-1.2 1-2 2.3-2 1.3 0 2.3.8 2.3 1.9 0 1-1.2 1.4-1.2 2.4"/><path d="M12.2 13.8h.01"/></svg>',
    reminder:
      '<svg class="visual-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3.5c-3 0-4.5 2.3-4.5 5.5 0 4-1.5 5.5-1.5 5.5h12s-1.5-1.5-1.5-5.5c0-3.2-1.5-5.5-4.5-5.5z"/><path d="M10 17a2 2 0 0 0 4 0"/></svg>',
    leads:
      '<svg class="visual-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="9" cy="8" r="3"/><path d="M3.5 20c.5-3.5 2.8-5.5 5.5-5.5s5 2 5.5 5.5"/><path d="M18 8v6M15 11h6"/></svg>',
    scheduling:
      '<svg class="visual-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/></svg>',
    helpdesk:
      '<svg class="visual-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="3" y="13" width="4" height="5" rx="1.3"/><rect x="17" y="13" width="4" height="5" rx="1.3"/><path d="M19 18v1a3 3 0 0 1-3 3h-2"/></svg>',
    pricing:
      '<svg class="visual-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12.6 3.5h6.4a1.5 1.5 0 0 1 1.5 1.5v6.4a1.5 1.5 0 0 1-.44 1.06l-8.6 8.6a1.5 1.5 0 0 1-2.12 0l-6.4-6.4a1.5 1.5 0 0 1 0-2.12l8.6-8.6c.28-.28.66-.44 1.06-.44z"/><circle cx="16.5" cy="7.5" r="1.4" fill="currentColor" stroke="none"/></svg>',
    pager:
      '<svg class="visual-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="7" width="16" height="12" rx="2"/><path d="M8 7V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><rect x="7" y="10.5" width="10" height="3" rx="0.6"/><path d="M8 16.5h.01M12 16.5h.01M16 16.5h.01"/></svg>',
    reset:
      '<svg class="visual-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7.6 4.5c-1.7 0-3.1 1.4-3.1 3.1 0 7.3 5.9 13.2 13.2 13.2 1.7 0 3.1-1.4 3.1-3.1v-2c0-.7-.5-1.3-1.1-1.5l-2.8-.8a1.7 1.7 0 0 0-1.7.4l-.9 1a11 11 0 0 1-5-5l1-.9a1.7 1.7 0 0 0 .4-1.7l-.8-2.8a1.6 1.6 0 0 0-1.5-1.1H7.6Z"/><path d="M15.2 4.8c1.9.4 3.4 1.9 3.8 3.8M17 2.7c3 .6 5.4 3 6 6" opacity="0.85"/></svg>'
  };

  // Each entry drives the "Agent Visual System" illustration in styles.css
  // (`.agent-visual` / `.visual-scene[data-scene]`). `dataScene` must match one
  // of the data-scene selectors defined there; `content` is the literal markup
  // rendered inside that scene's grid using its component vocabulary
  // (.visual-node / .visual-card / .visual-badge / .visual-record / .visual-calendar).
  var VISUAL_SCENES = {
    "intent-routing": {
      dataScene: "routing",
      ariaLabel: "A caller describes a need, an intent hub identifies it, and the call branches to sales, support, or billing.",
      outcomes: ["Sales", "Support", "Billing"],
      summary: "Identify the reason and choose a team.",
      thumbnailContent:
        '<span class="visual-node" data-step="caller">Caller</span>' +
        '<span class="visual-node" data-step="intent">' +
        SCENE_ICONS.routing +
        "Intent</span>" +
        '<span class="visual-outcomes" data-step="routes">' +
        '<span class="visual-badge">3 teams</span>' +
        "</span>",
      content:
        '<span class="visual-node" data-step="caller">Caller<br><small>“I need an order update.”</small></span>' +
        '<span class="visual-node visual-node--focal" data-step="intent">' +
        SCENE_ICONS.routing +
        "Intent hub<br><small>Detect need</small></span>" +
        '<span class="visual-outcomes" data-step="route-options">' +
        '<span class="visual-badge" data-route="sales">Sales · new order</span>' +
        '<span class="visual-badge" data-route="support">Support · delivery</span>' +
        '<span class="visual-badge" data-route="billing">Billing · invoice</span>' +
        "</span>" +
        '<i class="visual-route visual-route--inbound" aria-hidden="true" style="left:28%;top:50%;width:12%"></i>' +
        '<i class="visual-route visual-route--branch" aria-hidden="true" style="left:65%;top:27%;width:9%;height:46%;border-left:0"></i>'
    },
    "crm-lookup-update": {
      dataScene: "records",
      ariaLabel: "A caller is matched to a CRM identity, their account context is reviewed, and a confirmed call outcome is written back to the record.",
      outcomes: ["CRM updated"],
      summary: "Customer context becomes a current record.",
      thumbnailContent:
        '<span class="visual-record" data-step="identity">' +
        SCENE_ICONS.records +
        "<strong>Caller matched</strong>CRM identity</span>" +
        '<span class="visual-record" data-step="writeback"><strong>Call outcome</strong>Write-back saved</span>',
      content:
        '<span class="visual-record" data-step="identity">' +
        SCENE_ICONS.records +
        "<strong>Jordan Lee</strong>Verified caller</span>" +
        '<span class="visual-record" data-step="context"><strong>Gold account</strong>Open order · 2 cases</span>' +
        '<span class="visual-record" data-step="outcome"><strong>Call outcome</strong>Delivery address changed</span>' +
        '<span class="visual-record" data-step="writeback"><strong>CRM write-back</strong>Owner notified · saved</span>' +
        '<i class="visual-route" aria-hidden="true" style="left:45%;top:50%;width:12%"></i>'
    },
    "311-assistant": {
      dataScene: "civic",
      ariaLabel: "A resident reports a pothole, the location is marked on a civic service map, and a street-maintenance request is created.",
      outcomes: ["Service case"],
      summary: "Turn a civic report into a tracked request.",
      thumbnailContent:
        '<span class="visual-node" data-step="report">' +
        SCENE_ICONS.civic +
        "311 report</span>" +
        '<span class="visual-badge" data-step="case">Service case</span>',
      content:
        '<span class="visual-node" data-step="report">' +
        SCENE_ICONS.civic +
        "Resident report<br><small>Pothole on Pine St.</small></span>" +
        '<span class="visual-card visual-map" data-step="locate" data-layer="request-map">' +
        "<strong>Locate request</strong>Map tile · Pine &amp; 4th" +
        '<span class="visual-calendar visual-map-tiles" aria-hidden="true">' +
        '<span class="visual-calendar-cell"></span><span class="visual-calendar-cell"></span><span class="visual-calendar-cell visual-calendar-cell--marked"></span>' +
        '<span class="visual-calendar-cell"></span><span class="visual-calendar-cell"></span><span class="visual-calendar-cell"></span>' +
        "</span></span>" +
        '<span class="visual-badge" data-step="case">Street maintenance · Case 311-204</span>'
    },
    "general-inquiry": {
      dataScene: "inquiry",
      ariaLabel: "A caller asks about office hours, the agent extracts the approved answer from the knowledge base, and responds with the source context.",
      outcomes: ["Clear answer"],
      summary: "Answer common questions without a queue.",
      thumbnailContent:
        '<span class="visual-card" data-step="question">' +
        SCENE_ICONS.inquiry +
        "Hours?</span>" +
        '<span class="visual-badge" data-step="answer">Approved answer</span>',
      content:
        '<span class="visual-card" data-step="question">' +
        SCENE_ICONS.inquiry +
        "<strong>Caller asks</strong>&ldquo;What are your holiday hours?&rdquo;</span>" +
        '<span class="visual-record" data-step="extract"><strong>Answer extracted</strong>Knowledge base · Holiday schedule</span>' +
        '<span class="visual-card visual-card--answer" data-step="answer"><strong>Clear response</strong>“Open 9–3 on Monday.”</span>' +
        '<span class="visual-badge" data-source="approved">Approved source</span>'
    },
    "appointment-reminder": {
      dataScene: "reminder",
      ariaLabel: "An outbound reminder reaches a patient, presents a Tuesday appointment, and records the patient's confirmation.",
      outcomes: ["Confirm", "Change", "Cancel"],
      summary: "Record the patient's appointment choice.",
      thumbnailContent:
        '<span class="visual-card" data-step="reminder">' +
        SCENE_ICONS.reminder +
        "Tue · 2 PM</span>" +
        '<span class="visual-badge" data-response="confirmed">Confirmed</span>',
      content:
        '<span class="visual-card visual-card--reminder" data-step="reminder">' +
        SCENE_ICONS.reminder +
        "<strong>Upcoming visit</strong>Tue · 2:00 PM · Dr. Patel</span>" +
        '<span class="visual-badge-row" data-step="response-options">' +
        '<span class="visual-badge" data-response="confirmed">✓ Confirmed</span>' +
        '<span class="visual-badge" data-response="change">Change time</span>' +
        '<span class="visual-badge" data-response="cancel">Cancel</span>' +
        "</span>" +
        '<span class="visual-node visual-node--focal" data-step="recorded">Confirmation<br>recorded</span>'
    },
    "sales-lead-capture": {
      dataScene: "leads",
      ariaLabel: "An after-hours caller describes a quote need, the agent captures the contact and requirements, and a qualified lead is assigned for sales follow-up.",
      outcomes: ["Sales follow-up"],
      summary: "Capture the need and hand it to sales.",
      thumbnailContent:
        '<span class="visual-node" data-step="incoming">' +
        SCENE_ICONS.leads +
        "Night call</span>" +
        '<span class="visual-record" data-step="capture"><strong>Lead</strong>Need captured</span>' +
        '<span class="visual-badge" data-step="handoff">Sales</span>',
      content:
        '<span class="visual-node" data-step="incoming">' +
        SCENE_ICONS.leads +
        "After-hours call<br><small>“Need a bulk quote.”</small></span>" +
        '<span class="visual-record" data-step="capture"><strong>Qualified lead</strong>Maya Chen · 500 units<br>Dallas delivery</span>' +
        '<span class="visual-card visual-card--handoff" data-step="handoff"><strong>Sales follow-up</strong>CRM lead · Morning callback</span>' +
        '<i class="visual-route" aria-hidden="true" style="left:29%;top:55%;width:42%"></i>'
    },
    "appointment-scheduling": {
      dataScene: "scheduling",
      ariaLabel: "A patient selects a Tuesday 10:30 appointment from available slots and receives a booked-visit confirmation.",
      outcomes: ["Booked visit"],
      summary: "Match the caller to an available appointment.",
      thumbnailContent:
        '<span class="visual-calendar" aria-hidden="true">' +
        '<span class="visual-calendar-cell"></span><span class="visual-calendar-cell visual-calendar-cell--marked"></span><span class="visual-calendar-cell"></span>' +
        "</span>" +
        '<span class="visual-node" data-step="booked">' +
        SCENE_ICONS.scheduling +
        "Booked</span>",
      content:
        '<span class="visual-card visual-card--visit" data-step="need"><strong>Visit needed</strong>Annual checkup · New patient</span>' +
        '<span class="visual-calendar" data-step="slot-selection" aria-label="Available appointment slots; Tuesday 10:30 is selected">' +
        '<span class="visual-calendar-cell"></span>' +
        '<span class="visual-calendar-cell"></span>' +
        '<span class="visual-calendar-cell visual-calendar-cell--marked"></span>' +
        '<span class="visual-calendar-cell"></span>' +
        '<span class="visual-calendar-cell"></span>' +
        '<span class="visual-calendar-cell"></span>' +
        "</span>" +
        '<span class="visual-node visual-node--focal" data-step="booked">' +
        SCENE_ICONS.scheduling +
        "Tue · 10:30<br><small>Visit booked</small></span>"
    },
    "help-desk-triage": {
      dataScene: "helpdesk",
      ariaLabel: "An employee request is understood, then triaged either to an IT access ticket or to HR benefits guidance.",
      outcomes: ["IT ticket", "HR guidance"],
      summary: "Separate technical requests from people support.",
      thumbnailContent:
        '<span class="visual-icon" aria-hidden="true">' +
        SCENE_ICONS.helpdesk +
        "</span>" +
        '<span class="visual-outcomes" data-step="triage"><span class="visual-badge">IT or HR</span></span>',
      content:
        '<span class="visual-icon" aria-hidden="true">' +
        SCENE_ICONS.helpdesk +
        "</span>" +
        '<span class="visual-outcomes" data-step="triage">' +
        '<span class="visual-card visual-card--request"><strong>Employee request</strong>“I cannot access benefits.”</span>' +
        '<span class="visual-badge" data-route="it">IT · Access ticket</span>' +
        '<span class="visual-badge" data-route="hr">HR · Benefits guidance</span>' +
        "</span>"
    },
    "bid-price-lookup": {
      dataScene: "pricing",
      ariaLabel: "A buyer requests a live corn bid for Omaha, the pricing feed is checked, and the current price quote is spoken back.",
      outcomes: ["Bid / price"],
      summary: "Return the current price for the requested market.",
      thumbnailContent:
        '<span class="visual-card" data-step="request">Corn · Omaha</span>' +
        '<span class="visual-card visual-card--focal" data-step="quote">$4.82</span>' +
        '<span class="visual-badge" data-freshness="live">Live</span>',
      content:
        '<span class="visual-card" data-step="request"><strong>Buyer asks</strong>Corn · Omaha terminal</span>' +
        '<span class="visual-card visual-card--focal" data-step="quote">' +
        SCENE_ICONS.pricing +
        "<strong>Live bid</strong>$4.82 / bu</span>" +
        '<span class="visual-card" data-step="source"><strong>Pricing feed</strong>Updated 10:42 AM</span>' +
        '<i class="visual-route" aria-hidden="true" style="left:30%;top:52%;width:40%"></i>'
    },
    "on-call-pager": {
      dataScene: "pager",
      ariaLabel: "A water-pressure alert is summarized, sent to the primary on-call responder, and escalates to the backup responder if it is not acknowledged.",
      outcomes: ["Pager call"],
      summary: "Reach the right responder with the issue details.",
      thumbnailContent:
        '<span class="visual-node" data-step="alert">New alert</span>' +
        '<span class="visual-card" data-step="page">' +
        SCENE_ICONS.pager +
        "Page on-call</span>",
      content:
        '<span class="visual-node" data-step="alert">Water pressure low<br><small>Voicemail summarized</small></span>' +
        '<span class="visual-record" data-step="roster"><strong>Primary on-call</strong>Alex Morgan · Utilities</span>' +
        '<span class="visual-card visual-card--pager" data-step="page">' +
        SCENE_ICONS.pager +
        "<strong>Pager call</strong>Issue context delivered</span>" +
        '<span class="visual-badge" data-step="escalation">No acknowledgment → Page backup</span>' +
        '<i class="visual-route" aria-hidden="true" style="left:50%;top:18%;height:64%"></i>'
    },
    "it-helpdesk-password-reset": {
      dataScene: "password-reset",
      ariaLabel: "An employee's forgot-password click triggers an immediate callback; voice and browser code verification and live policy coaching complete the reset, and the ticket closes as deflected.",
      outcomes: ["Ticket deflected"],
      summary: "Call back, verify, coach, and deflect the ticket.",
      thumbnailContent:
        '<span class="visual-node" data-step="callback">' +
        SCENE_ICONS.reset +
        "Callback</span>" +
        '<span class="visual-badge" data-response="confirmed">Deflected</span>',
      content:
        '<span class="visual-card" data-step="trigger"><strong>Forgot password?</strong>Employee clicks reset</span>' +
        '<span class="visual-node visual-node--focal" data-step="callback">' +
        SCENE_ICONS.reset +
        "Agent calls back<br><small>No queue, no ticket</small></span>" +
        '<span class="visual-record" data-step="verify"><strong>Identity verified</strong>Spoken code · typed in browser</span>' +
        '<span class="visual-badge-row" data-step="coaching">' +
        '<span class="visual-badge" data-response="confirmed">Policy coached · passed</span>' +
        "</span>" +
        '<span class="visual-card visual-card--focal" data-step="deflected"><strong>Ticket deflected</strong>Auto-closed · cost avoided</span>' +
        '<i class="visual-route" aria-hidden="true" style="left:50%;top:10%;height:72%"></i>'
    }
  };

  var THUMBNAIL_EMBLEMS = {
    routing:
      '<svg class="thumbnail-svg" viewBox="0 0 120 84" aria-hidden="true">' +
      '<circle class="thumb-soft" cx="22" cy="42" r="10"/>' +
      '<path class="thumb-line" d="M32 42h22M54 42C67 42 67 18 82 18M54 42h28M54 42c13 0 13 24 28 24"/>' +
      '<path class="thumb-accent" d="m82 12 12 6-12 6Z"/><path class="thumb-mark" d="m82 36 12 6-12 6ZM82 60l12 6-12 6Z"/>' +
      "</svg>",
    records:
      '<svg class="thumbnail-svg" viewBox="0 0 120 84" aria-hidden="true">' +
      '<rect class="thumb-panel" x="28" y="13" width="62" height="58" rx="12"/>' +
      '<circle class="thumb-soft" cx="48" cy="34" r="8"/><path class="thumb-mark" d="M38 54c2-8 7-12 14-12s12 4 14 12"/>' +
      '<path class="thumb-accent-line" d="M82 22c19 5 23 29 7 40"/><path class="thumb-accent" d="m82 58 8 4-2-9Z"/>' +
      "</svg>",
    civic:
      '<svg class="thumbnail-svg" viewBox="0 0 120 84" aria-hidden="true">' +
      '<path class="thumb-line thumb-dashed" d="M14 27h92M14 57h92M40 10v64M79 10v64"/>' +
      '<path class="thumb-accent" d="M60 13c-12 0-21 9-21 21 0 16 21 37 21 37s21-21 21-37c0-12-9-21-21-21Z"/>' +
      '<circle class="thumb-cutout" cx="60" cy="34" r="8"/>' +
      "</svg>",
    inquiry:
      '<svg class="thumbnail-svg" viewBox="0 0 120 84" aria-hidden="true">' +
      '<path class="thumb-panel" d="M15 14h66a12 12 0 0 1 12 12v20a12 12 0 0 1-12 12H43L27 70v-12a12 12 0 0 1-12-12V26a12 12 0 0 1 12-12Z"/>' +
      '<text class="thumb-symbol" x="52" y="45">?</text>' +
      '<path class="thumb-accent" d="M75 48h22a9 9 0 0 1 9 9v5a9 9 0 0 1-9 9H88l-8 7v-7h-5a9 9 0 0 1-9-9v-5a9 9 0 0 1 9-9Z"/>' +
      "</svg>",
    reminder:
      '<svg class="thumbnail-svg" viewBox="0 0 120 84" aria-hidden="true">' +
      '<path class="thumb-panel" d="M38 57h44c-6-7-8-15-8-25 0-10-6-17-14-17s-14 7-14 17c0 10-2 18-8 25Z"/>' +
      '<path class="thumb-line" d="M51 64c2 6 16 6 18 0M34 21c-6 6-9 13-9 21M86 21c6 6 9 13 9 21"/>' +
      '<circle class="thumb-accent" cx="84" cy="57" r="15"/><path class="thumb-cutout-line" d="m77 57 5 5 10-11"/>' +
      "</svg>",
    leads:
      '<svg class="thumbnail-svg" viewBox="0 0 120 84" aria-hidden="true">' +
      '<path class="thumb-panel" d="M39 9c-15 6-20 24-11 37 7 10 20 14 31 9-12-2-20-12-20-24 0-9 5-17 13-22-4-1-9-1-13 0Z"/>' +
      '<path class="thumb-mark" d="M35 62h50l-7 13H42Z"/>' +
      '<path class="thumb-accent" d="M62 34c8 10 11 15 11 21a11 11 0 0 1-22 0c0-6 3-11 11-21Z"/>' +
      "</svg>",
    scheduling:
      '<svg class="thumbnail-svg" viewBox="0 0 120 84" aria-hidden="true">' +
      '<rect class="thumb-panel" x="24" y="10" width="72" height="64" rx="10"/><path class="thumb-line" d="M24 28h72M42 10v12M78 10v12"/>' +
      '<g class="thumb-grid"><rect x="34" y="37" width="12" height="10" rx="3"/><rect x="54" y="37" width="12" height="10" rx="3"/><rect x="74" y="37" width="12" height="10" rx="3"/><rect x="34" y="54" width="12" height="10" rx="3"/><rect x="74" y="54" width="12" height="10" rx="3"/></g>' +
      '<rect class="thumb-accent" x="52" y="52" width="16" height="14" rx="4"/>' +
      "</svg>",
    helpdesk:
      '<svg class="thumbnail-svg" viewBox="0 0 120 84" aria-hidden="true">' +
      '<path class="thumb-line" d="M14 42h35M49 42c13 0 10-22 24-22h9M49 42c13 0 10 22 24 22h9"/><circle class="thumb-accent" cx="49" cy="42" r="7"/>' +
      '<rect class="thumb-panel" x="81" y="8" width="28" height="28" rx="6"/><path class="thumb-mark" d="m88 29 14-14M91 15l11 11"/>' +
      '<circle class="thumb-soft" cx="95" cy="64" r="15"/><circle class="thumb-cutout" cx="95" cy="59" r="5"/><path class="thumb-cutout" d="M86 72c2-6 5-9 9-9s7 3 9 9Z"/>' +
      "</svg>",
    pricing:
      '<svg class="thumbnail-svg" viewBox="0 0 120 84" aria-hidden="true">' +
      '<path class="thumb-panel" d="m29 18 43-8 27 27-43 37-36-36Z"/><circle class="thumb-cutout" cx="42" cy="30" r="6"/>' +
      '<text class="thumb-symbol thumb-symbol--small" x="57" y="53">$</text>' +
      '<path class="thumb-accent-line" d="m54 62 12-8 10 4 16-17"/><path class="thumb-accent" d="m87 40 7-2-2 8Z"/>' +
      "</svg>",
    pager:
      '<svg class="thumbnail-svg" viewBox="0 0 120 84" aria-hidden="true">' +
      '<path class="thumb-accent" d="m28 18 21 39H7Z"/><path class="thumb-cutout-line" d="M28 31v12M28 49h.01"/>' +
      '<path class="thumb-line" d="M54 31c11 5 11 17 0 22M66 22c23 10 23 30 0 40"/><path class="thumb-line thumb-dashed" d="M80 14c33 15 33 41 0 56"/>' +
      "</svg>",
    "password-reset":
      '<svg class="thumbnail-svg" viewBox="0 0 120 84" aria-hidden="true">' +
      '<path class="thumb-soft" d="M20 20c-4 0-7 3-7 7 0 20 16 36 36 36 4 0 7-3 7-7v-5.7c0-2-1.3-3.7-3.2-4.2l-7.9-2.3a4.3 4.3 0 0 0-4.5 1.2l-2.4 2.8a28.6 28.6 0 0 1-13.4-13.4l2.8-2.4a4.3 4.3 0 0 0 1.2-4.5l-2.3-7.9A4.4 4.4 0 0 0 22 20Z"/>' +
      '<path class="thumb-line thumb-dashed" d="M42 30c13 0 20 5 26 13"/>' +
      '<rect class="thumb-panel" x="66" y="9" width="40" height="30" rx="6"/>' +
      '<path class="thumb-line" d="M66 19h40"/>' +
      '<path class="thumb-line" d="M81 30v-4a5 5 0 0 1 10 0v4"/>' +
      '<rect class="thumb-mark" x="79" y="30" width="14" height="10" rx="2"/>' +
      '<circle class="thumb-accent" cx="90" cy="63" r="15"/><path class="thumb-cutout-line" d="m83 63 5 5 10-11"/>' +
      "</svg>"
  };

  function visualSceneMarkup(template, variant) {
    var scene = VISUAL_SCENES[legacyKeyOf(template)];
    if (variant === "thumbnail") {
      return (
        '<figure class="agent-visual agent-visual--thumbnail" aria-hidden="true">' +
        '<div class="thumbnail-emblem" data-thumbnail="' +
        scene.dataScene +
        '">' +
        THUMBNAIL_EMBLEMS[scene.dataScene] +
        "</div></figure>"
      );
    }
    var content =
      scene.content;
    var accessibility =
      ' role="img" aria-label="' + escapeHtml(scene.ariaLabel) + '"';
    return (
      '<figure class="agent-visual agent-visual--' +
      variant +
      '"' +
      accessibility +
      '><div class="visual-scene" data-scene="' +
      scene.dataScene +
      '">' +
      content +
      "</div></figure>"
    );
  }

  function thumbnail(template) {
    var scene = VISUAL_SCENES[legacyKeyOf(template)];
    return (
      '<div class="plate-thumb" style="' +
      paletteStyle(template) +
      '" role="img" aria-label="Workflow miniature: ' +
      escapeHtml(scene.ariaLabel) +
      '">' +
      '<div class="thumb-head"><span>' +
      escapeHtml(template.assistant) +
      '</span><span class="thumb-dot"></span></div>' +
      '<div class="thumb-body">' +
      visualSceneMarkup(template, "thumbnail") +
      "</div>" +
      '<div class="thumb-foot"><span>' +
      escapeHtml(scene.summary) +
      "</span></div>" +
      "</div>"
    );
  }

  function stage(template) {
    return (
      '<div class="stage" style="' +
      paletteStyle(template) +
      '">' +
      '<div class="stage-header">' +
      '<span class="stage-agent">' +
      escapeHtml(template.assistant) +
      " voice template" +
      '</span><span class="stage-timing"><span>Implementation</span>' +
      escapeHtml(template.technical.complexity) +
      " complexity" +
      "</span></div>" +
      '<div class="stage-visual">' +
      visualSceneMarkup(template, "stage") +
      "</div>" +
      '<blockquote class="stage-quote"><p>&ldquo;' +
      escapeHtml(template.prompt) +
      "&rdquo;</p></blockquote>" +
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

  function plateMarkup(template, position) {
    var brief = decisionBriefOf(template);
    return (
      '<article class="plate" id="plate-' +
      template.id +
      '" data-open="' +
      template.id +
      '">' +
      '<div class="plate-number"><strong>' +
      (position + 1) +
      "</strong></div>" +
      '<figure class="plate-figure-cell">' +
      thumbnail(template) +
      "</figure>" +
      '<div class="plate-content">' +
      "<h3>" +
      escapeHtml(template.name) +
      "</h3>" +
      '<p class="plate-language">' +
      escapeHtml(template.language) +
      " &middot; " +
      escapeHtml(template.useCase) +
      "</p>" +
      '<p class="plate-description">' +
      escapeHtml(brief.application) +
      "</p>" +
      '<div class="card-decision-facts">' +
      '<div class="card-roi"><span>Potential outcomes</span><strong>' +
      escapeHtml(brief.roi) +
      "</strong></div>" +
      '<div class="card-technical">' +
      '<div class="complexity complexity--' +
      brief.complexity.toLowerCase() +
      '"><span>Complexity</span><strong>' +
      brief.complexity +
      "</strong></div>" +
      '<div class="launch-effort"><span>Readiness</span><strong>Illustrative</strong>' +
      '<small>Validate before use</small>' +
      "</div></div></div>" +
      '<div class="plate-actions">' +
      '<button class="plate-open" type="button" data-open="' +
      template.id +
      '">Build this agent' +
      "</button>" +
      referenceMarkup(template) +
      "</div>" +
      "</div>" +
      "</article>"
    );
  }

  function renderCatalogue() {
    var list = visible();
    catalogueEl.innerHTML = list.map(plateMarkup).join("");
    var isEmpty = list.length === 0;
    emptyEl.hidden = !isEmpty;
    emptyEl.setAttribute("aria-hidden", String(!isEmpty));
    statusEl.textContent =
      list.length +
      (list.length === 1 ? " template shown" : " templates shown") +
      " of " +
      CATALOG.length;
  }

  function renderCommand() {
    if (!active) return;
    var agent = AGENTS[agentSelect.value] || AGENTS.claude;
    $("#commandLabel").textContent = agent.label;
    $("#commandText").textContent = agent.build(implementationBrief(active));
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

  function openPlate(id) {
    var template = CATALOG.filter(function (item) {
      return item.id === id;
    })[0];
    if (!template) return;
    if (viewerEl.hidden) lastFocused = document.activeElement;
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
    $("#viewerKicker").textContent =
      "Voice AI template \u00b7 " + template.assistant;
    $("#viewerTitle").textContent = template.name;
    $("#viewerSub").textContent = template.language + " \u2014 " + template.useCase;
    $("#viewerPosition").textContent = (position + 1) + " / " + pool.length;
    $("#viewerStage").innerHTML = stage(template);
    $("#viewerStage").setAttribute("style", paletteStyle(template));
    $("#viewerCaption").textContent =
      template.useCase;
    $("#businessCase").innerHTML =
      '<div class="detail-row"><span>Application</span><strong>' +
      escapeHtml(brief.application) +
      '</strong></div><div class="detail-row"><span>Success measures</span><strong>' +
      escapeHtml(brief.metrics) +
      "</strong></div>";
    $("#technicalFit").innerHTML =
      '<div class="technical-summary"><div class="complexity complexity--' +
      brief.complexity.toLowerCase() +
      '"><span>Implementation complexity</span><strong>' +
      brief.complexity +
      '</strong></div><div class="launch-effort"><span>Readiness</span><strong>Illustrative</strong>' +
      '<small>Validate before use</small>' +
      '</div></div><div class="detail-row"><span>System touchpoints</span><strong>' +
      escapeHtml(brief.systems) +
      '</strong></div><div class="detail-row"><span>Initial build scope</span><strong>' +
      escapeHtml(brief.build) +
      "</strong></div>";
    $("#repoAction").innerHTML = referenceMarkup(template, ["repo"]);
    $("#viewerLinks").innerHTML = referenceMarkup(template, ["video", "deck"]);
    $("#acceptanceList").innerHTML = acceptanceChecks(template)
      .map(function (check) {
        return "<li>" + escapeHtml(check) + "</li>";
      })
      .join("");
    renderCommand();
    viewerEl.hidden = false;
    document.body.style.overflow = "hidden";
    sheetEl.scrollTop = 0;
    var close = viewerEl.querySelector("[data-close-viewer].close");
    if (close) close.focus();
  }

  function closePlate() {
    if (viewerEl.hidden) return;
    viewerEl.hidden = true;
    active = null;
    syncHash(null);
    document.body.style.overflow = "";
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
  }

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

  function trapFocus(event) {
    if (event.key !== "Tab" || viewerEl.hidden) return;
    var focusable = focusableIn(sheetEl);
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
    if (event.target.closest("a[href]")) return;
    var opener = event.target.closest("[data-open]");
    if (opener) {
      openPlate(opener.getAttribute("data-open"));
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

  agentSelect.addEventListener("change", renderCommand);

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

  document.addEventListener("keydown", function (event) {
    if (viewerEl.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closePlate();
      return;
    }
    trapFocus(event);
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
  window.addEventListener("hashchange", function () {
    var id = window.location.hash.slice(1);
    if (!id) {
      closePlate();
      return;
    }
    if (!active || active.id !== id) openPlate(id);
  });

  renderCatalogue();

  // Deep-link support: open the requested plate once the catalogue has
  // rendered, so `#<template-id>` links open their interstitial on load.
  var initialHash = window.location.hash.slice(1);
  if (initialHash) openPlate(initialHash);
})();
