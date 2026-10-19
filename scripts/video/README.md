# Template demo films

Builds the demo films published under each template's **Video** button, and the
[overview film](#the-overview-film) at the top of the gallery. Each template has two:

- **Its film**, which the **Video** button plays: two to three minutes, styled like
  a product film. It opens cold on a call, then shows the template's console at the
  moments that say what it does. See [Short films](#short-films).
- **Its walkthrough**, which the film is cut from: the full narrated demo, five to six
  and a half minutes, where every scripted call plays out from start to finish.

Films are too large to commit, so each is an asset on the repository's
[`demo-films`](https://github.com/anujb-msft/voice-ai-template-gallery/releases/tag/demo-films)
GitHub Release: `<id>.mp4` and `<id>-walkthrough.mp4`.
The Pages build copies the film into the site
([`scripts/mirror-hosted-films.js`](../mirror-hosted-films.js)), and the gallery
plays that same-origin copy first and the release second: the **Video** button
opens an in-page player, and the template page plays it inline. The film's
`poster.webp`, `captions.vtt`, `transcript.md` and `README.md` are committed in
`docs/templates/<id>/video/`, with the walkthrough's transcript beside them as
`walkthrough-transcript.md`. The film's `README.md` links the walkthrough.

The walkthrough opens with a few HyperFrames scenes (the call, the template, how it
works), then shows the template's **own console** running its demo script in
simulation mode, and closes with what's under the hood and how to make it yours.
Every voice in both films, the narrator's, the agent's and each caller's, is
performed by **Azure OpenAI GPT Realtime** (`gpt-realtime`, through Azure AI Voice
Live). The calls' lines are burned in as subtitles, and so is the walkthrough's
narration.

```text
films/<id>.mjs ─┐                                        reel/<id>.mjs ─┐                ┌─ demo-films release: <id>.mp4, <id>-walkthrough.mp4
                ├─ check ─ capture ───────────── compose ───────────────┴─ reel ──────── publish
beats.js ───────┘          console in simulation   walkthrough:            short film:   └─ docs/templates/<id>/video/
                           + GPT Realtime voices   scenes + console        takes + cards
                                                   + mastered voices       + score
```

## Requirements

Linux, WSL or macOS, with:

- **Node.js 22+** and **ffmpeg/ffprobe** on `PATH`.
- **Azure CLI**, signed in (`az login`) to an account that can use an Azure AI
  Services (Foundry) resource with Voice Live. Voices are keyless: an Entra token
  for `https://ai.azure.com`.
- `VOICE_LIVE_ENDPOINT` set to that resource's endpoint, e.g.
  `https://<name>.cognitiveservices.azure.com`.
- The HyperFrames headless Chrome: `npx hyperframes browser ensure`.
- `npm ci` here, and in each template's `code/` folder you capture.
- To publish, the **GitHub CLI** signed in (`gh auth login`) with write access to
  the repository.

## Make a film

```bash
cd scripts/video
npm ci && npx hyperframes browser ensure
(cd ../../docs/templates/<id>/code && npm ci)

npm run check -- <id>             # validate the film script, see the step map and estimated runtime
npm run capture -- <id>           # play and record the console (~1 minute per beat, per pass)
npm run compose -- <id>           # the walkthrough: scenes, edit, voices, render, mix → ~/cvp-video-work/films/<id>/
npm run reel -- <id>              # the film, cut from the walkthrough → ~/cvp-video-work/reel/<id>/
npm run publish -- <id>           # both to the demo-films release, companions into docs/templates/<id>/video/
```

Film one capture at a time. Each console renders on a software GPU that takes
about ten cores, so parallel captures drop frames and the console looks choppy.
To prepare several templates at once, rehearse them in parallel first with
`npm run capture -- <id> --dpr 1 --max-passes 1 --out /tmp/rehearsal`. That
performs and caches every voice line, so each filmed capture then needs only
one pass.

`publish` uploads the film to the `demo-films` release as `<id>.mp4` and the
walkthrough beside it as `<id>-walkthrough.mp4` (creating the release on first use,
replacing an earlier cut, skipping a file the release already holds) and checks that
each public download serves exactly that file. It copies the film's poster, captions,
transcript and notes into `docs/templates/<id>/video/`, with the walkthrough's
transcript as `walkthrough-transcript.md`, removes any committed `demo.mp4`, and
marks `video/demo.mp4` (with its release `url`) and `video/poster.webp` ready in that
template's `template.json`. Then it regenerates `docs/data/` and bumps the `?v=` cache
key on every page that loads `data/templates.js`. Until `reel` has built a template's
film, `publish` sends its walkthrough alone, as `<id>.mp4`. Review both films before
you publish: the uploads are public as soon as they land.

The gallery plays the site's own copy of a film, which only the
**Deploy GitHub Pages** workflow refreshes, so a new cut reaches the gallery once
you push the docs changes to `main`. When there is nothing to push, as after
re-mixing the overview film, run `gh workflow run pages.yml`. `publish` reminds
you after every upload.

| Command | Does |
| --- | --- |
| `npm run check -- <id> \| --all [--steps]` | Validates film scripts, prints where each narration line lands, estimates runtime. |
| `npm run capture -- <id> [--beats 1,3] [--out DIR] [--dpr 2] [--max-passes 4]` | Boots the console in simulation mode on the film's port and plays the filmed beats, screen-recording at 2× and logging when every line is spoken. Re-plays until every line comes from the voice cache (`--max-passes`, default 4). |
| `npm run compose -- <id> [--no-render] [--snap 12,40.5] [--draft] [--crf N] [--workers N]` | Lays out the walkthrough, writes the HyperFrames project, renders it, mixes and masters the voices, muxes `demo.mp4` and writes the companions. `--no-render --snap …` previews frames. |
| `npm run publish -- <id> [...] [--from DIR] [--films DIR] [--github OWNER/NAME] [--release TAG] [--no-upload]` | Uploads each template's film and walkthrough to the release (default `demo-films`, on the checkout's `origin`), copies the companions into the gallery, marks the film ready and regenerates the catalogue. `--no-upload` points the docs at films already on the release. |
| `npm run reel -- [<id>\|overview] [--snap t1,t2\|auto] [--no-render] [--draft] [--no-music] [--force] [--workers N]` | Builds a template's [short film](#short-films), or the [overview film](#the-overview-film) (the default), from the composed walkthroughs. `--snap auto` previews a frame from every section; `--force` re-renders an unchanged picture. |
| `npm run publish -- --reel overview [--github OWNER/NAME] [--no-upload]` | Uploads the overview film to the release and copies its companions into `docs/overview/`. |
| `npm run stage -- <id> <port>` | Serves a console in simulation mode, as the capture does. |
| `npm run voice -- --voice cedar --text "…"` | Performs one line with GPT Realtime: a quick check that voices work. |

| Env | Default |
| --- | --- |
| `VOICE_LIVE_ENDPOINT` | required |
| `VOICE_LIVE_MODEL`, `VOICE_LIVE_API_VERSION` | `gpt-realtime`, `2026-04-10` |
| `REPO` | this checkout (the one whose `docs/templates/<id>/code` has `node_modules`) |
| `VOICE_CACHE`, `MIX_CACHE` | `~/.cache/voice-ai-films/{voices,mix}` |
| `CHROME` | the HyperFrames headless Chrome |
| `RENDER_WORKERS` | `auto` (HyperFrames render workers; each is a Chrome) |
| `HYPERFRAMES_EXTRACT_CACHE_DIR` | `off`: footage frames (~4–5 GB a film) go to the render's work dir beside the output, not a RAM-backed `/tmp`. Set a directory to cache them across renders. |

## Short films

The films in [`reel/`](reel/) are styled like product films: a black stage, each
console in a floating device, kinetic type, and an original score
([`src/score.mjs`](src/score.mjs)) under the voices. They reuse the console footage
and voice lines the walkthroughs recorded, so compose those first
(`npm run compose -- <id> --no-render` is enough). The fields are documented at the
top of [`reel/overview.mjs`](reel/overview.mjs).

Beside `<id>.mp4`, `reel` writes `poster.webp` (the title card, which the player
shows before it starts), `share.jpg` (a 1200×675 link preview), `captions.vtt`,
`transcript.md`, `README.md` and `reel.json`. The picture renders only when the page
or its takes change; a new mix or score reuses the render. `--no-music` drops the
score.

### A template's film

`reel/<id>.mjs` names its template in `film` and tells that one template's story,
in takes cut from its walkthrough at the pauses between sentences.
[`reel/intent-based-call-routing.mjs`](reel/intent-based-call-routing.mjs) is the
reference.

| Section | On screen | Heard |
| --- | --- | --- |
| `open` | A cold open: one call, the console in its device, a headline | the call |
| `title` | The template's name and its promise | the narrator |
| `chapters` | One-line cards, each followed by a clip or two of the console proving it | the calls |
| `trust` | Where the model's job ends and the server's begins, and three points | the narrator |
| `yours` | The files to change, and a prompt typed to a coding agent | the narrator |
| `end` | The name, the run command, the synthetic-voice disclosure | the narrator |

```bash
npm run reel -- <id> --no-render --snap auto   # lay it out, preview a frame from every section
npm run reel -- <id>                           # → ~/cvp-video-work/reel/<id>/<id>.mp4
npm run publish -- <id>                        # film and walkthrough to the release
```

Keep it to two or three minutes: each clip cut to the lines that prove its headline.
The walkthrough is where every call plays out in full.

### The overview film

[`reel/overview.mjs`](reel/overview.mjs) cuts one short film across every
template for the top of the gallery.

```bash
npm run reel -- overview              # → ~/cvp-video-work/reel/overview/overview.mp4
npm run publish -- --reel overview    # film to the demo-films release, companions into docs/overview/
```

It also writes `hero.webp`, the gallery's front-page still: a console at work near
the end of the open (`hero.before` in the reel script). `docs/index.html` names
`share.jpg` in `og:image`. `publish --reel` uploads `overview.mp4` and copies the
companions into `docs/overview/`. `docs/index.html` and
`scripts/mirror-hosted-films.js` already name these files and the release download,
so a new cut needs no code change. Update the runtime written in `docs/index.html`
if the cut changes length. Then push, or redeploy Pages if there's nothing to push,
as described above.

## How it works

- **Film scripts** (`films/`) say who speaks with which voice, what the narrator
  says around each demo beat, and what the scenes show. See
  [`films/README.md`](films/README.md).
- **Voices** (`src/realtime.mjs`, `src/voices.mjs`). Each line is one short
  Voice Live session with the line's voice and a delivery note. The model's own
  transcript is compared with the script and the line is retried when it drifts.
  Lines are cached by model, voice, style, language and text.
- **Capture** (`src/capture.mjs`, `src/stage.mjs`, `src/steady-ids.mjs`,
  `src/shim.js`). The console's server boots in simulation mode with in-memory
  stores and nothing from your shell or `.env`; it refuses to film a live
  server. Its `randomUUID()` and `randomInt()` are seeded, so ids and codes that
  reach a spoken line (the on-call pager's voicemail reference, the password
  reset's one-time code) are the same on every pass and the voice cache can
  settle. Puppeteer presses the console's own **Next**, the shim
  plays each line's recording for its real length, and the console holds still
  while the narrator speaks. A binary timecode painted into every frame re-syncs
  the screencast to the voice log.
- **Edit** (`src/edit.mjs`). Stillness is trimmed, every line is placed on the
  film clock, and a camera plan follows whoever is speaking, with the film's own
  shots where the narration points at a panel.
- **Compose** (`src/compose.mjs`, `src/scenes.mjs`, `src/soundtrack.mjs`). The
  scenes and the edited console are one HyperFrames composition, rendered
  silently; the voices are loudness-matched, mixed at their film times, mastered
  to −16 LUFS and muxed in.
- **Reel** (`src/reel.mjs`, `src/score.mjs`). Cuts takes from the walkthroughs'
  edited footage at the pauses between sentences, lays them on one clock with the
  cards and the narrator, and writes the score's sections to that clock. The voices
  are mixed over the score and mastered to −16 LUFS, like a film.

Nothing here talks to a real phone number: every call in a film is a scripted
simulation with synthetic voices and fictional people, as each film's closing
card says.
