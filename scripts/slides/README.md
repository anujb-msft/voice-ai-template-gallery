# Template value slides

Builds each template's one-slide value proposition, `docs/templates/<id>/slides/<id>.pdf`:
the file the gallery sheet's **PDF** link and the template page's **Open the slide
(PDF)** link open. The slide is for business decision-makers evaluating Microsoft voice
AI. It leads with the potential outcomes, then says what the agent does, who it's for,
how success is measured, the systems it touches, and how complex it is to build, beside
a still of the template's demo console.

The slides are generated, never drawn by hand: every word comes from the template's
`template.json`, set in its own colors, so a manifest edit and its slide stay in step.
The editable deck (`<id>.pptx`) and its `preview.webp` are separate deliverables that
this script doesn't make.

## What's on a slide

| Part | Source |
|---|---|
| Kicker, title, subtitle | `language`, `name`, `useCase` |
| **Potential outcomes**, the headline | `business.roi` |
| **What it does** | `business.application` |
| The picture | `stills/<id>.jpg`, captioned "From the demo film · Console in simulation mode", plus "Teams card simulated" when `stills.json` marks the frame as showing the console's mock Teams card |
| **Who it's for** | `business.buyer` |
| **Success measures** | `business.metrics`, one bullet each |
| **System touchpoints** | `technical.systems`, one chip each |
| **Build complexity** | `technical.complexity`, with a three-step meter |
| Footer | The products the templates run on (Teams Phone extensibility, Azure AI Voice Live, Azure OpenAI GPT Realtime), and a disclaimer: an illustrative sample, not a production service; no performance commitments; fictional people and data |
| Colors and corners | `colors` and `radius` |
| Document title, subject, and keywords | `name`, `business.roi`, and `tags` |

The type is Helvetica, a standard PDF font that every viewer has, rather than the
manifest's `font`. The page is 16:9, 960 × 540 pt.

## Commands

You need Node.js 22 or later, and ffmpeg for `npm run stills`:

```bash
cd scripts/slides
npm ci
npm run build                     # rebuild every slide
npm run build -- --only=<id>      # rebuild one
npm run check                     # fail if a committed slide is out of date
npm run stills                    # re-cut the console stills; needs ffmpeg
```

Rebuild after editing a `template.json`, `stills.json`, or a still, look at the slides
it rewrote, and commit them. CI's `slides` job runs `npm run check`, which rebuilds every
slide in memory and fails when a committed one differs.

That works because the build is byte-for-byte reproducible: the creation date is fixed
and the streams are uncompressed, so the same inputs give the same file on any machine.
`pdfkit` is pinned to an exact version for the same reason. Upgrade it on purpose, then
rebuild and commit every slide.

## When the text doesn't fit

The build never lets text overflow, and shrinks it only within set limits. When
something doesn't fit, it stops and names the field:

- `business.roi` takes the largest size that fits, from 26 pt down to 22 pt on up to
  three lines, then from 24 pt down to 19 pt on four, and `business.application` from
  12 pt down to 11 pt. Both must fit in the column beside the still. Shorten them if
  they don't.
- `name` must fit the title on one line at 24 pt or larger, and `useCase` the subtitle
  at 14 pt.
- The facts band grows to fit its tallest column, and the still shrinks to make room.
  If the still would be narrower than 360 pt, shorten `business.buyer`,
  `business.metrics`, or `technical.systems`.
- Each `technical.systems` entry must fit one chip, and each word of `business.buyer`
  and `business.metrics` must fit its column.
- Text must be in Windows-1252, the standard PDF fonts' character set: Latin letters
  and accents, curly quotes, dashes, and `·`, but not, for example, CJK or emoji.
- A theme that meets the gallery's
  [contrast rules](../../ARCHITECTURE.md#theme-and-accessibility) passes. The slide
  needs 4.5:1 for `ink` and 3:1 for `accent`, on both `bg` and `panel`.

## Accessibility

Each slide is a tagged PDF: headings, paragraphs, lists for the success measures and
systems, and a figure whose alternate text is the still's `alt`, in reading order, with
the language set to `en-US` and the document title shown in the viewer's title bar.
Decorative shapes are marked as artifacts, so assistive technology skips them.
Secondary text is faded only as far as 4.5:1 contrast allows.

## Console stills

Each slide's picture is `stills/<id>.jpg`, a frame of the template's console running in
simulation mode, cut from a demo film at the moment `stills.json` names. Every current
still comes from the overview film, `overview.mp4` on the
[`demo-films`](https://github.com/anujb-msft/voice-ai-template-gallery/releases/tag/demo-films)
release, named by `source` and pinned by its sha256. `npm run stills` downloads each
film once into the OS temp folder, refuses one whose sha256 differs, and re-cuts the
stills. `--reel=path/to/overview.mp4` uses a local copy of the overview film, and
`--only=<id>` re-cuts one still.

Each entry in `stills.json` has:

- `id`: the template id.
- `at`: seconds into the film.
- `crop`: `[x, y, width, height]` of the console in the 1920 × 1080 frame. Keep it close
  to 16:9: the slide fills a 16:9 frame and trims the rest.
- `teamsCard`: `true` when the frame shows the console's mock Teams card, so the
  caption says it's simulated.
- `alt`: what the frame shows, for screen readers: the decision on screen and why, in a
  sentence or two.
- Optionally, `film` and `sha256`: cut this still from another film, such as the
  template's own demo film, instead of the overview film.

If the overview film is re-cut, its moments move, and `npm run stills` refuses it. The
committed stills and slides stay as they are until someone updates `source.sha256`,
re-picks each still's `at` and `crop` against the new cut, and then re-cuts the stills,
rebuilds the slides, and checks both.

## Adding a template's slide

A new template has no slide at first. `npm run build` and `npm run check` skip a
template that has no still in `stills.json`, and its manifest keeps the
`slides/<id>.pdf` asset `pending`, so the **PDF** link in its gallery sheet shows
*Pending*. A slide that is committed without a still fails the check.

Once the template's demo film is published:

1. Find a moment in the film where the console shows the template's key decision. It
   isn't in the overview film, so use its own: `<id>.mp4` on the `demo-films` release.
   To look at a frame, run `ffmpeg -ss <seconds> -i <id>.mp4 -frames:v 1 frame.png`.
2. Add an entry to `stills.json` with `id`, `at`, `crop`, `teamsCard`, and `alt`, plus
   `film`, the film's release download URL, and `sha256`, the output of
   `sha256sum <id>.mp4`.
3. Run `npm run stills -- --only=<id>`, and look at `stills/<id>.jpg`.
4. Run `npm run build -- --only=<id>`, and look at the slide at full size.
5. In `template.json`, set the `slides/<id>.pdf` asset's status to `ready`, and its
   description to the one the other templates use. Then run
   `node scripts/generate-template-index.js` from the repository root, and commit the
   still, `stills.json`, the slide, the manifest, and `docs/data/`.

## Files

| File | Purpose |
|---|---|
| `build.mjs` | Builds the slides, or checks them with `--check` |
| `extract-stills.mjs` | Cuts the console stills from the films |
| `stills.json` | Each still's film, moment, crop, Teams-card flag, and alternate text |
| `stills/<id>.jpg` | The committed stills |
