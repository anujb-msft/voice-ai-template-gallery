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
`SIMULATION MODE` banner that names the missing settings, and the chip at the top right
of the operator console reads "simulation mode". Open <http://127.0.0.1:8091> and press
**→** to run the scripted demo one step at a time, or pick a calling number, click
**Answer a call**, and type what the caller says:

| Type | What happens |
|---|---|
| `I was charged twice on my invoice` | 0.95 confidence; the agent offers Billing and transfers once you confirm |
| `I was charged for a renewal I did not order` | Below the confidence gate, so the agent asks a clarifying question |
| `can I just talk to a person` | Straight to Reception, with no confirmation |
| `3` | Keypad shortcut; commits with no spoken confirmation |

Billing is open weekdays from 09:00 to 17:00 Pacific time (`config/routes.json`). Outside
those hours, confirming Billing or pressing `3` takes a message instead of transferring.
The console's demo clock moves the server between business hours and after hours, so
you can see both without waiting.

`GET /health` reports the mode, whether the server can take real calls, and any missing
settings. The console drives each simulated call through the `/api/simulate` routes.
The scripted beats live in `code/public/beats.js`, and `code/DEMO-SCRIPT.md` is the
presenter's running order for them
([operator console](ARCHITECTURE.md#operator-console)). `npm run rehearse` plays every
beat the way the console does, on its own server, and fails if one would land somewhere
the script doesn't say ([testing](ARCHITECTURE.md#5-testing)).

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
- **Ports**: the next free demo port from 8101 up, a smoke-test port of the demo port
  plus 100, and a rehearsal port of the demo port plus 200. None may appear in the
  [Ports](ARCHITECTURE.md#ports) table.

Wait for a maintainer to confirm the id and port before you start, so that two
contributors don't claim the same ones.

### 2. Copy the reference

From the repository root, on a branch that is up to date with `main`:

```bash
ID=your-template-id
mkdir -p docs/templates/$ID
git archive HEAD:docs/templates/intent-based-call-routing | tar -x -C docs/templates/$ID
rm docs/templates/$ID/video/poster.webp docs/templates/$ID/slides/intent-based-call-routing.pdf
```

`git archive` copies only tracked files, so no `node_modules/`, `data/`, or `.env`
comes along. The `rm` deletes the reference's poster and slide: they show the
reference, and the `grep` at the end of this step skips binary files, so it wouldn't
find them. Then replace the reference's identity everywhere it appears:

| Replace | With | Where |
|---|---|---|
| `intent-based-call-routing` | Your id | `index.html`, `template.json`, `code/package.json`, `code/package-lock.json` (both `name` fields), `slides/README.md`, and the `<title>` of both SVGs in `media/` |
| `Intent-Based Call Routing` | Your name | `template.json`, `README.md`, `SPEC.md`, `code/README.md`, `code/scripts/provision-teams-phone.ps1` |
| `Intent-based call routing demo` | `<Name> demo` | `code/src/server.mjs` |
| `intent-based call routing agent` | A description of your agent | `code/DEMO-SCRIPT.md` |
| `8091` | Your demo port | `README.md`, `SPEC.md`, `code/README.md`, `code/DEMO-SCRIPT.md`, the `tunnel` script in `code/package.json`, `code/.env.example`, `code/src/config.mjs` |
| `8191` | Your smoke port | `code/README.md`, `code/scripts/smoke-websockets.mjs` |
| `8291` | Your rehearsal port | `code/README.md`, `code/DEMO-SCRIPT.md`, `code/scripts/rehearse.mjs` |

Also:

- Edit the two `name` fields in `code/package-lock.json` by hand. Keep the rest of the
  lockfile unless you change dependencies. If you do regenerate it, check that every
  `resolved` URL points at `https://registry.npmjs.org/`
  ([platform](ARCHITECTURE.md#platform)).
- Reword the passages in `code/src/config.mjs` and `SPEC.md` that place the sample
  alongside the password-reset sample on port 8090.
- Rewrite, rather than rename, everything that describes call routing: the
  `Call routing` tag, the console title in `code/public/index.html`, the routing
  vocabulary in `code/src/`, `code/test/`, and `code/config/`, the console panels in
  `code/public/app.js`, the beats in `code/public/beats.js`, the outcome projection in
  `code/scripts/rehearse.mjs`, and the video and slide drafts.
- Empty the pins in `code/scripts/rehearse.mjs` (`const EXPECTED = {};` and
  `const EXPECTED_STATS = null;`), because they're the reference's outcomes. Once your
  beats work, `npm run rehearse` prints the outcomes they reach. Check each against
  `code/DEMO-SCRIPT.md`, then paste them in.
- Leave `code/public/presenter-kit.js`, `presenter-kit.css`, and
  `code/scripts/presenter-kit-rehearsal.mjs` alone. They're vendored copies of
  `scripts/presenter-kit/`, and CI fails if they drift
  ([operator console](ARCHITECTURE.md#operator-console)).
- Leave `index.html` alone apart from `data-template-id`. The page renders entirely from
  the manifest ([template pages](ARCHITECTURE.md#template-pages)).

When you are done, this prints nothing:

```bash
grep -rniI -e 8091 -e 8191 -e 8291 -e intent-based docs/templates/$ID
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
- Inject the clock, and honor `DEMO_NOW` for repeatable demos. If behavior depends on
  time, expose the demo clock in simulation ([time](ARCHITECTURE.md#time)).
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
- Cover the policy core with unit tests, point the smoke test at your smoke port, and
  point the rehearsal at your rehearsal port ([testing](ARCHITECTURE.md#5-testing)).
- Make the console a demo, not just a test harness
  ([operator console](ARCHITECTURE.md#operator-console)). Write the scenario as beats in
  `code/public/beats.js` that each run on their own, explain every decision in plain
  English, show each handoff as the Teams toast your handoff builder produces, and keep
  `code/DEMO-SCRIPT.md` in step with the beats. Pin what each beat leaves on screen in
  `code/scripts/rehearse.mjs`, so `npm run rehearse` keeps the demo and its script in
  step.
- Explain any new dependency in the pull request description. The reference's six
  dependencies cover most scenarios.
- Update `README.md`, `code/README.md`, `code/DEMO-SCRIPT.md`, the video and slide
  drafts, and both SVGs in `media/`
  ([media and deliverables](ARCHITECTURE.md#media-and-deliverables)).
- Add a row for your template to the [Ports](ARCHITECTURE.md#ports) table.

### 6. Add the CI matrix entry and Dependabot directory

One CI matrix runs every sample ([§6](ARCHITECTURE.md#6-continuous-integration)). In
`.github/workflows/validate.yml`, add your id to the `sample` job's `template` list, in
alphabetical order:

```yaml
    strategy:
      fail-fast: false
      matrix:
        template:
          # ...
          - your-template-id
```

Each entry runs `npm test` before `npm ci`, then `npm ci`, `npm test` again,
`npm run check`, `npm run smoke`, and `npm run rehearse`, in your `code/` folder. A test
that needs a native module, such as a SQLite store, must skip itself when the module
isn't installed, so it runs only on the second pass.

Then add your `code/` folder to the `directories` list of the `npm` entry in
`.github/dependabot.yml`:

```yaml
  - package-ecosystem: npm
    directories:
      # ...
      - /docs/templates/your-template-id/code
```

### 7. Verify and open the pull request

From the repository root:

```bash
node scripts/generate-template-index.js
git status --short docs/data
```

Commit both files in `docs/data/`: CI regenerates them and fails if they differ from
what you committed. Don't set `INCLUDE_REPOSITORY_METADATA` when you run the generator.
CI doesn't set it, so data generated with it fails that check. Then bump the
`data/templates.js?v=` key in `docs/index.html` to today's date in `YYYYMMDD-N` form,
for example `?v=20261001-1`, so browsers fetch the new catalogue
([caching](ARCHITECTURE.md#caching)).

Then, in your template's `code/` folder:

```bash
npm test
npm ci
npm run check
npm run smoke
npm run rehearse
```

On Windows, run these in WSL: `npm run check` is a POSIX shell loop, and npm runs
scripts with `cmd.exe` there.

Run `node scripts/sync-presenter-kit.js --check` from the repository root. If your
template has a slide, also run `npm ci` and `npm run check` in `scripts/slides`. Then
start your sample with `npm start`, and present every beat in the console the way the
room will see it. `npm run rehearse` proves where each beat lands, in any order and after
**Reset demo**, but not that the room can follow it.

Preview the gallery, and check your template's tile, its sheet down to the
**Build this agent** band, and its page three ways: at full width, at phone width
(390 px), and with reduced motion. To emulate reduced motion in Edge or Chrome, open
DevTools, open the **Rendering** panel, and set
**Emulate CSS media feature prefers-reduced-motion** to `reduce`.

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

In the **Shown on** column, *tile* is the template's tile in the gallery, *sheet* is the
sheet the tile opens, *page* is the template page, *prompt* is the GitHub Copilot prompt
the gallery generates, *slide* is the template's one-slide value proposition (PDF), and
*films* are the template's films, which `scripts/video` colors from the manifest
([theme](ARCHITECTURE.md#theme-and-accessibility)). Fields marked *not shown* are still
required and validated.

| Field | Rule | Reference value | Shown on |
|---|---|---|---|
| `id` | Lowercase words of letters and digits, joined by hyphens. Equals the folder name, and is unique and permanent. | `intent-based-call-routing` | URLs and paths |
| `name` | Title case. | `Intent-Based Call Routing` | Tile, sheet, page, prompt, slide; sort order and search |
| `language` | `Inbound · ` or `Outbound · `, then a category from the list below. | `Inbound · Voice Receptionist` | Tile, sheet, page, prompt, slide; search |
| `useCase` | A short noun phrase. | `Cross-industry intelligent reception` | Sheet, page, slide; search |
| `assistant` | `Inbound` or `Outbound`, matching the first word of `language`. | `Inbound` | Not shown: `language` starts with it |
| `headline` | One or two short sentences, about 40–60 characters. | `Understand the reason. Route to the right team.` | Tile, sheet, page headline, meta description |
| `prompt` | The agent's opening line to the caller, about 35–65 characters. | `Tell me briefly what you are calling about.` | Sheet and page ("Opening line"), prompt |
| `description` | Two sentences, about 180–215 characters. | `Classifies a caller's stated reason and routes the call to the appropriate team, queue, or self-service flow. The bounded routing policy makes it a practical starting point for evaluating voice automation.` | Page; search |
| `tags` | Three tags: the industry or sector first, then two for the function or capability. | `Cross-industry`, `Call routing`, `Reception` | Page; search |
| `colors` | `bg`, `panel`, `accent`, and `ink`, each a 6-digit hex color. | `#17140f`, `#29231a`, `#e0a63c`, `#f7f0e0` | `accent`: tile, sheet, page; all four: films, slide |
| `onAccent` | The 6-digit hex color of text on `accent`. | `#17140f` | Films |
| `font` | A system font stack that ends in a generic family. No web fonts. | `'Helvetica Neue', Helvetica, Arial, sans-serif` | Not shown |
| `radius` | A CSS length. | `10px` | Slide |
| `readiness` | Starts with `Illustrative workflow;`, then says what to evaluate. | `Illustrative workflow; evaluate intent accuracy, transfer policy, business-hours behavior, and fallback with representative calls.` | Page |
| `business.buyer` | The role that would sponsor the agent. | `Customer service and operations leaders` | Page, slide |
| `business.application` | One sentence on what the agent does for the business. | `Understand why a caller is contacting the organization and route them to the correct team, queue, or self-service flow.` | Sheet, page, prompt, slide |
| `business.roi` | One sentence of expected outcomes, with no percentages or amounts. | `Lower receptionist workload, fewer incorrect transfers, and better first-call resolution.` | Sheet, page ("Potential outcomes"), slide |
| `business.metrics` | Three measures joined by ` · `. | `Transfer accuracy · First-call resolution · Receptionist hours saved` | Sheet, page ("Success measures"), slide |
| `technical.complexity` | Exactly `Low`, `Medium`, or `High`. | `Low` | Tile, sheet, page, slide |
| `technical.systems` | Usually three systems the agent touches, joined by ` · `. | `Phone system · Employee directory · Routing rules` | Sheet, page, slide |
| `technical.build` | One sentence listing what to build. | `Intent classification, routing policy, business-hours logic, fallback, and warm transfer.` | Sheet, page, prompt |
| `paths` | The reference's 11 keys, each relative to `docs/` and pointing at a file or folder that exists. | `"readme": "templates/intent-based-call-routing/README.md"` | Page links, prompt |
| `assets.expected` | The reference's five deliverables, each with a `path` that starts with `templates/<id>/`, a `description`, and a `pending` or `ready` status. A demo film hosted on the `demo-films` GitHub Release also has a `url`. | `templates/<id>/` followed by `video/demo.mp4`, `video/poster.webp`, `slides/<id>.pptx`, `slides/<id>.pdf`, and `slides/preview.webp` | Tile (the poster and film), sheet, page |

Notes:

- The language categories in use are `Inbound · Tier 1 Support`,
  `Inbound · Sales / CRM`, `Inbound · Appointment Scheduling`,
  `Inbound · Voice Receptionist`, `Outbound · Reminders`, and
  `Outbound · Identity Verification`. Reuse one where it fits, and propose any new
  category in the proposal issue.
- Separate list items inside a string with ` · `: a space, a middle dot (U+00B7), and a
  space.
- The generator doesn't check the values of `assistant` and `complexity` yet, so a typo
  passes validation, and a `complexity` typo then shows up in the gallery. Copy them
  exactly.
- Keep every `paths` key and all five expected assets, even while the files are drafts.
  Paths use `/`, never start with `/`, and never contain `..`.
- Change an asset's status from `pending` to `ready` in the commit that adds the file.
  The generator fails when a `ready` asset is missing or a `pending` one exists.
- Demo films are too large to commit, so they live on the repository's `demo-films`
  GitHub Release. A hosted film's entry keeps its `path`, is `ready`, and adds a `url`:
  `https://github.com/<owner>/<repo>/releases/download/demo-films/<id>.mp4`. The Pages
  build copies the film into the site at its `path`, and the gallery and the template
  page play that copy first and the `url` second, so a new cut appears on the site after
  the next Pages deploy. Don't add the `url` by hand:
  `scripts/video/src/publish.mjs` uploads the film, checks the download, and writes the
  entry. It also uploads the template's full walkthrough as `<id>-walkthrough.mp4`,
  which `video/README.md` links; the walkthrough has no `assets.expected` entry. The
  film's `description` it writes carries the runtime, such as `(2:18)`, which the play
  chips on the tile and page show.
- `slides/<id>.pdf`, the template's slide, is generated from the fields marked *slide*
  by [`scripts/slides`](scripts/slides/README.md), which stops and names any field that
  doesn't fit. After you change a manifest that has a slide, run `npm run build` in
  `scripts/slides`, and commit the slide: CI fails while it is out of date. A new
  template gets its slide once its demo film is published
  ([adding a template's slide](scripts/slides/README.md#adding-a-templates-slide)).
  Until then, keep the asset `pending`, and mark `<id>.pdf` pending in
  `slides/README.md`.

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
| `asset url must be a GitHub Release download, …` | Point `url` at `https://github.com/<owner>/<repo>/releases/download/<tag>/<file>`, using only letters, digits, `.`, `_`, and `-` in each part. |
| `asset url must be the same file type as its path: …` | Give the hosted file the same extension as `path`, such as `<id>.mp4` for `video/demo.mp4`. |
| `a hosted asset must be marked ready: …` | Set its status to `ready`, or remove the `url` while the film is pending. |
| `asset is hosted at its url but also committed: …` | Delete the committed file. The release holds the only copy. If you ran `scripts/mirror-hosted-films.js` locally, it put the copies there. |
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
- [ ] If I changed `scripts/slides/` or the manifest of a template that has a slide, I
      ran `npm run build` in `scripts/slides` and committed the slides it rebuilt.
- [ ] `npm test`, `npm run check`, `npm run smoke`, and `npm run rehearse` pass in every
      `code/` folder I changed.
- [ ] Every beat in `code/public/beats.js` runs cleanly in the console, and
      `code/DEMO-SCRIPT.md` matches the beats. I checked every outcome I re-pinned in
      `code/scripts/rehearse.mjs` against `code/DEMO-SCRIPT.md`.
- [ ] I changed the presenter kit and its rehearsal engine only in
      `scripts/presenter-kit/`, then ran `node scripts/sync-presenter-kit.js`.
- [ ] The description explains any new dependency.
- [ ] For a new template: the proposal issue confirmed the id and port, and I added a
      Ports row, a CI matrix entry, and a Dependabot directory.
- [ ] I bumped the `?v=` value in `docs/index.html` for every file it references that I
      changed. A new template changes only `data/templates.js`.
- [ ] I checked the tile, its sheet down to the **Build this agent** band, and the page
      at full width, at 390 px, and with reduced motion.
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
   Azure settings. `npm test`, `npm run check`, `npm run smoke`, and `npm run rehearse`
   must pass. When the rehearsal reports a changed outcome, check each printed outcome
   against `code/DEMO-SCRIPT.md` before you paste it over the pins. If they disagree,
   fix the demo or the script, never only the pins.
4. Never edit `docs/data/` by hand. Run `node scripts/generate-template-index.js`, and
   commit its output. After changing the manifest of a template that has a slide, run
   `npm run build` in `scripts/slides`, and commit the rebuilt `slides/<id>.pdf`. Never
   edit a template's `code/public/presenter-kit.*` or
   `code/scripts/presenter-kit-rehearsal.mjs` either: change `scripts/presenter-kit/`,
   then run `node scripts/sync-presenter-kit.js`.
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
