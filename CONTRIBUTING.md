# Contributing

Thank you for your interest in the Voice AI Template Gallery.

This guide covers how to propose, build, and submit a template. Read
[ARCHITECTURE.md](ARCHITECTURE.md) first: it defines the standards every template must
meet, and this guide links to the relevant sections as you go. Coding agents such as
GitHub Copilot should also follow
[Instructions for coding agents](#instructions-for-coding-agents-github-copilot).

Everyone who takes part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
For help using the samples, see [SUPPORT.md](SUPPORT.md).

## Contents

- [Before opening an issue](#before-opening-an-issue)
- [Ways to contribute](#ways-to-contribute)
- [Development setup](#development-setup)
- [Adding a template](#adding-a-template)
- [Manifest reference](#manifest-reference)
- [Pull request checklist](#pull-request-checklist)
- [Content and security rules](#content-and-security-rules)
- [Instructions for coding agents (GitHub Copilot)](#instructions-for-coding-agents-github-copilot)
- [Microsoft Contributor License Agreement](#microsoft-contributor-license-agreement)

## Before opening an issue

Search existing issues before filing a new one. For bugs, include the affected template,
reproduction steps, expected behavior, actual behavior, and relevant environment details.
Do not include credentials, personal data, customer data, or security vulnerability
details in a public issue.

Report security issues through the process in [SECURITY.md](SECURITY.md).

## Ways to contribute

- **Fixes and documentation.** Open a focused pull request, and link the issue it
  resolves if there is one.
- **Gallery site.** Changes to `docs/assets/` follow
  [ARCHITECTURE.md §2](ARCHITECTURE.md#2-gallery-site): ES5, no build step, no
  third-party requests, and a `?v=` bump for each changed file that `docs/index.html`
  loads.
- **Known deviations.** [ARCHITECTURE.md §7](ARCHITECTURE.md#7-known-deviations) lists
  where existing templates fall short of the standards. Fix one deviation per pull
  request, and update or remove its row in the same change. Lockfiles are the exception:
  fix them all together in one pull request.
- **New templates.** Open a proposal issue first, as described in
  [Adding a template](#adding-a-template), and wait for a maintainer to confirm the id
  and port before you build.
- **Changes to the standards.** Open an issue that explains the problem and the rule you
  propose. Once it is agreed, update [ARCHITECTURE.md](ARCHITECTURE.md) in the same pull
  request as the change.

## Development setup

You need:

- [Node.js](https://nodejs.org/) 22 or later.
- Python 3, or any other static file server, to preview the gallery.
- Git.

Building, testing, and demonstrating a template all work offline in simulation mode,
with no Azure subscription. Answering real phone calls also needs Azure Communication
Services, an Azure AI Services resource for Voice Live, the
[Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli), and the
[Dev Tunnels CLI](https://learn.microsoft.com/azure/developer/dev-tunnels/get-started).
Each package's `code/README.md` covers that setup.

### Preview the gallery

From the repository root:

```bash
node scripts/generate-template-index.js
python3 -m http.server 4173 --directory docs
```

Open <http://localhost:4173/>. The generator validates every manifest and rebuilds
`docs/data/templates.json` and `docs/data/templates.js`, so rerun it after any manifest
change. Template pages are served at `http://localhost:4173/templates/<id>/`.

### Run the reference sample

[Intent-Based Call Routing](docs/templates/intent-based-call-routing/) is the reference
implementation, and every new template starts as a copy of it.

```bash
cd docs/templates/intent-based-call-routing/code
npm test   # the policy core's tests need no install
npm ci
npm start  # http://127.0.0.1:8091
```

With no Azure settings, the server starts in simulation mode. It prints a
`SIMULATION MODE` banner that names the missing settings, and the operator console badge
reads "simulation — no Azure configured". Open <http://127.0.0.1:8091>, pick a calling
number, click **Answer a call**, and type what the caller says:

| Type | What happens |
|---|---|
| `I was charged twice on my invoice` | 0.95 confidence; the agent offers Billing and transfers once you confirm |
| `I was charged for a renewal I did not order` | Below the confidence gate, so the agent asks a clarifying question |
| `can I just talk to a person` | Straight to Reception, with no confirmation |
| `3` | Keypad shortcut; commits with no spoken confirmation |

Billing is open weekdays from 09:00 to 17:00 Pacific time (`config/routes.json`). Outside
those hours, confirming Billing or pressing `3` takes a message instead of transferring.

`GET /health` reports the mode, whether the server can take real calls, and any missing
settings. The console drives each simulated call through the `/api/simulate` routes.

## Adding a template

A template is a folder, `docs/templates/<id>/`, that holds a gallery manifest, a page
stub, a specification, a runnable sample, and media and presentation drafts.
[ARCHITECTURE.md §3](ARCHITECTURE.md#3-template-package-standard) defines its contents.
Start every template as a copy of the reference. Do not start from scratch, and do not
copy a template listed under [known deviations](ARCHITECTURE.md#7-known-deviations).

### 1. Propose the template

Open an issue titled `Template proposal: <Name>` that gives:

- **Id**: lowercase words joined by hyphens, for example `parcel-delivery-update`. The
  id names the folder, the page URL, and the CI job, so treat it as permanent.
- **Name**: the display name, in title case.
- **Direction**: Inbound or Outbound.
- **Language category**: one of the categories listed under
  [Manifest reference](#manifest-reference), or a new one you propose.
- **Industry or sector**: the first tag, for example Logistics.
- **Problem**: what the caller and the business need, in two or three sentences.
- **Buyer** and **success measures**.
- **Systems** the agent reads or changes.
- **Ports**: the next free demo port from 8101 up, and a smoke-test port of the demo
  port plus 100. Neither may appear in the [Ports](ARCHITECTURE.md#ports) table.

Wait for a maintainer to confirm the id and port before you start, so that two
contributors don't claim the same ones.

### 2. Copy the reference

From the repository root, on a branch that is up to date with `main`:

```bash
ID=your-template-id
mkdir -p docs/templates/$ID
git archive HEAD:docs/templates/intent-based-call-routing | tar -x -C docs/templates/$ID
```

`git archive` copies only tracked files, so no `node_modules/`, `data/`, or `.env`
comes along. Then replace the reference's identity everywhere it appears:

| Replace | With | Where |
|---|---|---|
| `intent-based-call-routing` | Your id | `index.html`, `template.json`, `code/package.json`, `code/package-lock.json` (both `name` fields), `slides/README.md`, and the `<title>` of both SVGs in `media/` |
| `Intent-Based Call Routing` | Your name | `template.json`, `README.md`, `SPEC.md`, `code/README.md`, `code/scripts/provision-teams-phone.ps1` |
| `Intent-based call routing demo` | `<Name> demo` | `code/src/server.mjs` |
| `intent-based call routing agent` | A description of your agent | `code/DEMO-SCRIPT.md` |
| `8091` | Your demo port | `README.md`, `SPEC.md`, `code/README.md`, `code/DEMO-SCRIPT.md`, the `tunnel` script in `code/package.json`, `code/.env.example`, `code/src/config.mjs` |
| `8199` | Your smoke port | `code/scripts/smoke-websockets.mjs` |

Also:

- Edit the two `name` fields in `code/package-lock.json` by hand. Keep the rest of the
  lockfile unless you change dependencies. If you do regenerate it, check that every
  `resolved` URL points at `https://registry.npmjs.org/`
  ([platform](ARCHITECTURE.md#platform)).
- Reword the passages in `code/src/config.mjs` and `SPEC.md` that place the sample
  alongside the password-reset sample on port 8090.
- Rewrite, rather than rename, everything that describes call routing: the
  `Call routing` tag, the console title in `code/public/index.html`, the routing
  vocabulary in `code/src/`, `code/test/`, and `code/config/`, and the video and slide
  drafts.
- Leave `index.html` alone apart from `data-template-id`. The page renders entirely from
  the manifest ([template pages](ARCHITECTURE.md#template-pages)).

When you are done, this prints nothing:

```bash
grep -rniI -e 8091 -e 8199 -e intent-based docs/templates/$ID
```

`grep -rniI routing docs/templates/$ID` then finds the routing vocabulary that is left
to rewrite.

### 3. Write SPEC.md first

`SPEC.md` is the template's decision record. Write it before the code, and open a draft
pull request if you want early review. Keep the reference's title format,
`# <Name> — Sample Specification`, its **Status:** line stating that the sample is
illustrative and demo-grade, and its eleven sections in order
([documentation](ARCHITECTURE.md#documentation)):

1. Scope decisions
2. Implementation decisions
3. Experience decisions
4. Goal
5. Caller experience
6. Architecture and implementation shape
7. Teams handoff contract
8. Demo surface and configuration
9. Acceptance criteria
10. Production gates and non-goals
11. Microsoft reference contracts

Write decisions, not options. People and coding agents build what the specification
says, so "consider clarifying when confidence is low" produces guesswork, while this
produces a behavior you can test:

> The agent maps the caller's words to one allowlisted route, reporting its own
> confidence. Below `0.75`, or on silence or an unusable answer, it asks one short
> clarifying question — at most twice, offering the keypad on the second attempt — and
> then falls back to reception.

### 4. Fill in the manifest

Edit `template.json` field by field using the [Manifest reference](#manifest-reference),
then [check the theme contrast](#check-theme-contrast). Keep the five expected assets
`pending` until the real files exist.

### 5. Build the sample

Adapt `code/` to your scenario, keeping the reference's architecture
([§4](ARCHITECTURE.md#4-runnable-sample-architecture)):

- Keep the policy core free of npm imports, so `npm test` runs before `npm ci`. Only
  `src/config.mjs` reads `process.env` ([layering](ARCHITECTURE.md#layering)).
- Keep simulation mode working end to end with no Azure settings
  ([offline-first simulation](ARCHITECTURE.md#offline-first-simulation)).
- Put policy data in `code/config/*.json` with fictional values. Real identifiers belong
  in git-ignored `code/config/*.local.json` files.
- Inject the clock, and honor `DEMO_NOW` for repeatable demos
  ([time](ARCHITECTURE.md#time)).
- Let the model talk and the server decide: every tool call goes through a guarded
  method that can refuse it
  ([the model talks, the server decides](ARCHITECTURE.md#the-model-talks-the-server-decides)).
- Keep the reference's call intake, media path, and routes
  ([event intake](ARCHITECTURE.md#event-intake),
  [media and voice](ARCHITECTURE.md#media-and-voice),
  [HTTP and WebSocket surface](ARCHITECTURE.md#http-and-websocket-surface)).
- For an Outbound template, ship with campaigns disabled and dry run on, and fail closed
  ([outbound and campaign safety](ARCHITECTURE.md#outbound-and-campaign-safety)).
- Mask phone numbers, and keep transcript storage opt-in
  ([data privacy and security](ARCHITECTURE.md#data-privacy-and-security)).
- Document every environment variable in `code/.env.example` and in the specification's
  "Demo surface and configuration" section.
- Cover the policy core with unit tests, and point the smoke test at your smoke port
  ([testing](ARCHITECTURE.md#5-testing)).
- Explain any new dependency in the pull request description. The reference's six
  dependencies cover most scenarios.
- Update `README.md`, `code/README.md`, `code/DEMO-SCRIPT.md`, the video and slide
  drafts, and both SVGs in `media/`
  ([media and deliverables](ARCHITECTURE.md#media-and-deliverables)).
- Add a row for your template to the [Ports](ARCHITECTURE.md#ports) table.

### 6. Register the gallery card scene

Each gallery card shows an animated scene and a thumbnail emblem, defined in
`docs/assets/gallery.js` and styled in `docs/assets/gallery.css`
([gallery card scenes](ARCHITECTURE.md#gallery-card-scenes)). A template without its
own scene shows the routing scene. Model yours on the password-reset scene:

1. In `gallery.js`, add a comma after the last entry in `VISUAL_SCENES` (today,
   `"it-helpdesk-password-reset"`), then add yours before the closing `};`. Replace every
   label and `data-step` name with your scenario's. Screen readers announce `ariaLabel`
   in place of the scene, so make it one sentence that describes the whole flow.

   ```js
       "your-template-id": {
         dataScene: "your-template-id",
         ariaLabel: "A caller asks for help; the agent looks up the record, confirms the change, and the outcome is logged.",
         outcomes: ["Outcome logged"],
         summary: "Ask, look up, confirm, and log the outcome.",
         thumbnailContent:
           '<span class="visual-node" data-step="agent">' +
           SCENE_ICONS.routing +
           "Agent</span>" +
           '<span class="visual-badge" data-response="confirmed">Confirmed</span>',
         content:
           '<span class="visual-card" data-step="ask"><strong>Caller asks</strong>Short detail</span>' +
           '<span class="visual-node visual-node--focal" data-step="act">' +
           SCENE_ICONS.routing +
           "Agent acts<br><small>Short detail</small></span>" +
           '<span class="visual-record" data-step="record"><strong>Record found</strong>Short detail</span>' +
           '<span class="visual-badge-row" data-step="confirm">' +
           '<span class="visual-badge" data-response="confirmed">Confirmed</span>' +
           "</span>" +
           '<span class="visual-card visual-card--focal" data-step="outcome"><strong>Outcome</strong>Short detail</span>' +
           '<i class="visual-route" aria-hidden="true" style="left:50%;top:10%;height:72%"></i>'
       }
   ```

2. Add a comma after the last entry in `THUMBNAIL_EMBLEMS` (today, `"password-reset"`),
   then add an emblem whose key equals your `dataScene`. A missing emblem shows up on the
   card as the text `undefined`. Draw a bold, wordless metaphor for the scenario on the
   120 × 84 view box with the existing `thumb-*` classes:

   ```js
       "your-template-id":
         '<svg class="thumbnail-svg" viewBox="0 0 120 84" aria-hidden="true">' +
         '<rect class="thumb-panel" x="28" y="13" width="62" height="58" rx="12"/>' +
         '<path class="thumb-line" d="M40 34h38M40 46h26"/>' +
         '<circle class="thumb-accent" cx="86" cy="62" r="12"/><path class="thumb-cutout-line" d="m80 62 4 4 8-9"/>' +
         "</svg>"
   ```

3. In `gallery.css`, add the next numbered block, for example
   `/* 12. your-template-id */`, after the last numbered scene block and before the
   `/* Independent thumbnail emblems` comment. Copy the three rules of the
   `/* 11. password-reset */` block, changing the selector to
   `.visual-scene[data-scene="your-template-id"]`. Put any narrow-screen fixes in the
   existing `@media (max-width: 600px)` block, and animate only with CSS.
4. Use an existing `SCENE_ICONS` icon (`routing`, `records`, `civic`, `inquiry`,
   `reminder`, `leads`, `scheduling`, `helpdesk`, `pricing`, `pager`, or `reset`). Add a
   new icon only if none fits.
5. Bump all three `?v=` values in `docs/index.html` to today's date in `YYYYMMDD-N`
   form, for example `?v=20261001-1`, so browsers fetch the new files
   ([caching](ARCHITECTURE.md#caching)).

### 7. Add the CI job and Dependabot entry

Every runnable sample has its own CI job
([§6](ARCHITECTURE.md#6-continuous-integration)). In `.github/workflows/validate.yml`,
add a job after the last one. Name it after your template. Job ids must start with a
letter or `_`, so reword an id that starts with a digit.

```yaml
  your-template-demo:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: docs/templates/your-template-id/code
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: docs/templates/your-template-id/code/package-lock.json

      - name: Test the policy core without dependencies
        run: npm test

      - name: Install dependencies
        run: npm ci

      - name: Check server syntax
        run: npm run check

      - name: Smoke test the server and WebSocket endpoints
        run: npm run smoke
```

Then add an entry under `updates:` in `.github/dependabot.yml`:

```yaml
  - package-ecosystem: npm
    directory: /docs/templates/your-template-id/code
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
```

### 8. Verify and open the pull request

From the repository root:

```bash
node scripts/generate-template-index.js
git status --short docs/data
```

Commit both files in `docs/data/`: CI regenerates them and fails if they differ from
what you committed. Don't set `INCLUDE_REPOSITORY_METADATA` when you run the generator.
CI doesn't set it, so data generated with it fails that check.

Then, in your template's `code/` folder:

```bash
npm test
npm ci
npm run check
npm run smoke
```

Preview the gallery, and check your template's card, its **Build this agent** dialog,
and its page three ways: at full width, at 600 px wide, and with reduced motion. To
emulate reduced motion in Edge or Chrome, open DevTools, open the **Rendering** panel,
and set **Emulate CSS media feature prefers-reduced-motion** to `reduce`.

Open the pull request, link the proposal issue, and complete the
[Pull request checklist](#pull-request-checklist).

## Manifest reference

`template.json` describes a template to the gallery.
`scripts/generate-template-index.js` checks each manifest's structure, and CI runs it on
every pull request. Reviewers check the rest of the rules below.
`docs/schemas/template.schema.json` gives editors completion and basic checks. Unknown
fields are errors everywhere except inside `paths`, and every value is plain text, with
no Markdown or HTML. Keep `"$schema": "../../schemas/template.schema.json"` as the first
key, and never add a `source` field: the generator derives it.

In the **Shown on** column, *card* is the gallery card, *dialog* is the
**Build this agent** dialog, *page* is the template page, *prompt* is the GitHub Copilot
prompt the gallery generates, and *theme* means the `--t-*` custom properties that color
the card and page.

| Field | Rule | Reference value | Shown on |
|---|---|---|---|
| `id` | Lowercase words of letters and digits, joined by hyphens. Equals the folder name, and is unique and permanent. | `intent-based-call-routing` | URLs and paths |
| `name` | Title case. | `Intent-Based Call Routing` | Card, dialog, page, prompt; sort order and search |
| `language` | `Inbound · ` or `Outbound · `, then a category from the list below. | `Inbound · Voice Receptionist` | Card, dialog, page, prompt; search |
| `useCase` | A short noun phrase. | `Cross-industry intelligent reception` | Card, dialog, page; search |
| `assistant` | `Inbound` or `Outbound`, matching the first word of `language`. | `Inbound` | Card thumbnail, dialog, page |
| `headline` | One or two short sentences, about 40–60 characters. | `Understand the reason. Route to the right team.` | Page headline, meta description |
| `prompt` | The agent's opening line to the caller, about 35–65 characters. | `Tell me briefly what you are calling about.` | Dialog quote, page, prompt |
| `description` | Two sentences, about 180–215 characters. | `Classifies a caller's stated reason and routes the call to the appropriate team, queue, or self-service flow. The bounded routing policy makes it a practical starting point for evaluating voice automation.` | Page; search |
| `tags` | Three tags: the industry or sector first, then two for the function or capability. | `Cross-industry`, `Call routing`, `Reception` | Page; search |
| `colors` | `bg`, `panel`, `accent`, and `ink`, each a 6-digit hex color. | `#17140f`, `#29231a`, `#e0a63c`, `#f7f0e0` | Theme |
| `onAccent` | The 6-digit hex color of text on `accent`. | `#17140f` | Theme |
| `font` | A system font stack that ends in a generic family. No web fonts. | `'Helvetica Neue', Helvetica, Arial, sans-serif` | Theme |
| `radius` | A CSS length. | `10px` | Theme |
| `readiness` | Starts with `Illustrative workflow;`, then says what to evaluate. | `Illustrative workflow; evaluate intent accuracy, transfer policy, business-hours behavior, and fallback with representative calls.` | Page |
| `business.buyer` | The role that would sponsor the agent. | `Customer service and operations leaders` | Page |
| `business.application` | One sentence on what the agent does for the business. | `Understand why a caller is contacting the organization and route them to the correct team, queue, or self-service flow.` | Card, dialog, page, prompt |
| `business.roi` | One sentence of expected outcomes, with no percentages or amounts. | `Lower receptionist workload, fewer incorrect transfers, and better first-call resolution.` | Card ("Potential outcomes"), page |
| `business.metrics` | Three measures joined by ` · `. | `Transfer accuracy · First-call resolution · Receptionist hours saved` | Dialog, page ("Success measures") |
| `technical.complexity` | Exactly `Low`, `Medium`, or `High`. | `Low` | Card, dialog, page |
| `technical.systems` | Usually three systems the agent touches, joined by ` · `. | `Phone system · Employee directory · Routing rules` | Dialog, page |
| `technical.build` | One sentence listing what to build. | `Intent classification, routing policy, business-hours logic, fallback, and warm transfer.` | Dialog, page, prompt |
| `paths` | The reference's 11 keys, each relative to `docs/` and pointing at a file or folder that exists. | `"readme": "templates/intent-based-call-routing/README.md"` | Page links, prompt |
| `assets.expected` | The reference's five deliverables, each with a `path` that starts with `templates/<id>/`, a `description`, and a `pending` or `ready` status. | `templates/<id>/` followed by `video/demo.mp4`, `video/poster.webp`, `slides/<id>.pptx`, `slides/<id>.pdf`, and `slides/preview.webp` | Page |

Notes:

- The language categories in use are `Inbound · Tier 1 Support`,
  `Inbound · Sales / CRM`, `Inbound · Appointment Scheduling`,
  `Inbound · Voice Receptionist`, `Outbound · Reminders`, and
  `Outbound · Identity Verification`. Reuse one where it fits, and propose any new
  category in the proposal issue.
- Separate list items inside a string with ` · `: a space, a middle dot (U+00B7), and a
  space.
- The generator doesn't check the values of `assistant` and `complexity` yet, so a typo
  passes validation and then shows up in the gallery. Copy them exactly.
- Keep every `paths` key and all five expected assets, even while the files are drafts.
  Paths use `/`, never start with `/`, and never contain `..`.
- Change an asset's status from `pending` to `ready` in the commit that adds the file.
  The generator fails when a `ready` asset is missing or a `pending` one exists.

### Common generator errors

The generator stops at the first problem and prints
`Template index generation failed: docs/templates/<id>/template.json: <message>`.

| Message | Fix |
|---|---|
| `manifest contains unsupported fields: …` | Remove the listed fields, including any `source`. Errors in nested sections name `colors`, `business`, `technical`, `assets`, or `expected asset` instead of `manifest`. |
| `missing non-empty <field>` | Add the field as a non-empty string. |
| `id must match its folder name` | Make `id` and the folder name identical. |
| `tags must be a non-empty string array` | Give `tags` as an array of strings. |
| `colors must include bg, panel, accent, and ink` | Add the missing colors. |
| `business must include buyer, application, roi, and metrics` | Add the missing fields. |
| `technical must include complexity, systems, and build` | Add the missing fields. |
| `paths.<key> must stay inside docs/ (got "…")` | Make the path relative to `docs/`, with `/` separators and no `..`. |
| `paths.<key> points at a missing file: …` | Create the file, or fix the path. |
| `assets.expected must list the expected deliverables` | Restore all five expected assets from the reference. |
| `every expected asset requires path, description, and a ready or pending status` | Complete the entry. |
| `expected asset must live in its own folder (got "…")` | Start the asset path with `templates/<id>/`. |
| `asset is marked ready but missing: …` | Add the file, or set its status back to `pending`. |
| `asset is marked pending but present on disk: …` | Set its status to `ready`. |
| `invalid JSON (…)` | Fix the syntax. JSON allows no comments or trailing commas. |
| `template ids must be unique` | Choose an id that no other template uses. |
| CI step **Verify generated data is current** fails | Run the generator, and commit both files in `docs/data/`. |

### Check theme contrast

Run this from the repository root, with your id in the path:

```bash
node -e 'const t=require("./docs/templates/your-template-id/template.json");const L=h=>{const c=h.match(/\w\w/g).map(x=>parseInt(x,16)/255).map(v=>v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2]};const r=(a,b)=>{const[x,y]=[L(a),L(b)].sort((p,q)=>q-p);return ((x+.05)/(y+.05)).toFixed(2)};const c=t.colors;console.log({inkBg:r(c.ink,c.bg),inkPanel:r(c.ink,c.panel),onAccent:r(t.onAccent,c.accent),accentBg:r(c.accent,c.bg),accentPanel:r(c.accent,c.panel)})'
```

Every ratio must meet its minimum
([theme and accessibility](ARCHITECTURE.md#theme-and-accessibility)):

| Ratio | Pair | Minimum |
|---|---|---|
| `inkBg` | `ink` text on `bg` | 7:1 |
| `inkPanel` | `ink` text on `panel` | 7:1 |
| `onAccent` | `onAccent` text on `accent` | 4.5:1 |
| `accentBg` | `accent` on `bg` | 4.5:1 |
| `accentPanel` | `accent` on `panel` | 3:1 |

The reference prints:

```text
{
  inkBg: '16.18',
  inkPanel: '13.70',
  onAccent: '8.47',
  accentBg: '8.47',
  accentPanel: '7.18'
}
```

## Pull request checklist

Copy this list into the pull request description, and check each item that applies.

- [ ] The change is focused, and the description links its issue.
- [ ] I ran `node scripts/generate-template-index.js` and committed any changes in
      `docs/data/`.
- [ ] `npm test`, `npm run check`, and `npm run smoke` pass in every `code/` folder I
      changed.
- [ ] The description explains any new dependency.
- [ ] For a new template: the proposal issue confirmed the id and port, and I added a
      Ports row, a CI job, and a Dependabot entry.
- [ ] I bumped the `?v=` value in `docs/index.html` for every file it references that I
      changed. A new template changes all three.
- [ ] I checked the card, the **Build this agent** dialog, and the page at full width,
      at 600 px, and with reduced motion.
- [ ] All names, numbers, and data are fictional, and nothing contains a secret, tenant
      identifier, or tunnel URL.
- [ ] If the change alters a standard or fixes a known deviation, I updated
      `ARCHITECTURE.md`.
- [ ] I signed the Microsoft CLA, if the bot asked.

## Content and security rules

All sample names and data must be fictional. Do not add customer names, internal URLs,
credentials, tenant identifiers, production endpoints, or unsupported deployment and
performance claims.

- Use the fictional organizations Contoso and Fabrikam, `contoso.com` addresses, and
  phone numbers in the 555-0100 to 555-0199 range, such as `+14255550101`.
- Keep real values only in the git-ignored `code/.env` and `code/config/*.local.json`
  files. Never commit `code/data/`, which holds the local database.
- Keep tunnel URLs, resource names, and tenant and subscription ids out of commits,
  screenshots, logs, and pull request text. A dev tunnel URL is public: anyone who has it
  can reach your server.
- Record videos and capture screenshots with fictional data only. Never commit a
  placeholder or fabricated file in place of a real deliverable.
- Don't state performance, accuracy, or cost figures that the sample doesn't measure.
- Report vulnerabilities through [SECURITY.md](SECURITY.md), not in a public issue.

## Instructions for coding agents (GitHub Copilot)

These rules apply to GitHub Copilot and any other coding agent working in this
repository, in addition to the rest of this guide.

1. Read [ARCHITECTURE.md](ARCHITECTURE.md), this guide, and the template's `SPEC.md`
   before changing anything. Treat the decisions in `SPEC.md` as requirements. Where the
   specification is silent, follow the reference implementation and say so in the pull
   request description.
2. Start new templates from `docs/templates/intent-based-call-routing/`. Never copy
   `it-helpdesk-password-reset`, or any pattern listed under
   [known deviations](ARCHITECTURE.md#7-known-deviations).
3. Keep the policy core free of npm imports, and keep simulation mode working with no
   Azure settings. `npm test`, `npm run check`, and `npm run smoke` must pass.
4. Never edit `docs/data/` by hand. Run `node scripts/generate-template-index.js`, and
   commit its output.
5. Write gallery site code as ES5 (`var` and `function`, no build step), and pass every
   catalogue value you place in HTML through `escapeHtml()`.
6. Use fictional data only. Never commit credentials, keys, connection strings, tenant
   identifiers, or tunnel URLs, even as examples.
7. Don't regenerate `package-lock.json` unless the pull request changes dependencies.
8. Don't invent standards, and don't change `FEATURED_TEMPLATE_ID`. If `ARCHITECTURE.md`
   and the reference implementation disagree, don't pick one silently: describe the
   disagreement in the pull request description so a maintainer can resolve it.
9. Keep each pull request to one template or one fix. In the description, list the
   commands you ran and their results, and complete the
   [Pull request checklist](#pull-request-checklist).

## Microsoft Contributor License Agreement

Most contributions require you to agree to a Contributor License Agreement (CLA)
declaring that you have the right to, and actually do, grant us the rights to use your
contribution. For details, visit [https://cla.microsoft.com](https://cla.microsoft.com).

When you submit a pull request, a CLA bot will automatically determine whether you need
to provide a CLA and decorate the pull request appropriately. Follow the instructions
provided by the bot. You will only need to do this once across all repositories using
the Microsoft CLA.
