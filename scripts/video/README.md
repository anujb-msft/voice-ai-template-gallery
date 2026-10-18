# Template demo films

Builds the narrated demo film published under each template's **Video** button.
The film is too large to commit, so it is an asset (`<id>.mp4`) on the
repository's [`demo-films`](https://github.com/anujb-msft/voice-ai-template-gallery/releases/tag/demo-films) GitHub Release,
and the gallery streams it from there: the **Video** button opens an in-page
player, and the template page plays it inline. Its `poster.webp`, `captions.vtt`,
`transcript.md` and `README.md` are committed in `docs/templates/<id>/video/`.

Each film opens with a few HyperFrames scenes (the call, the template, how it
works), then shows the template's **own console** running its demo script in
simulation mode, and closes with what's under the hood and how to make it yours.
Every voice in it, the narrator's, the agent's and each caller's, is performed by
**Azure OpenAI GPT Realtime** (`gpt-realtime`, through Azure AI Voice Live), and
every line is burned in as a subtitle.

```text
films/<id>.mjs ─┐                                                             ┌─ demo-films release: <id>.mp4
                ├─ check ─ capture ───────────── compose ─────────────────── publish
beats.js ───────┘          console in simulation   scenes + edited console    └─ docs/templates/<id>/video/
                           + GPT Realtime voices   + mastered voice mix
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
npm run compose -- <id>           # scenes, edit, voices, render, mix → ~/cvp-video-work/films/<id>/
npm run publish -- <id>           # film to the demo-films release, companions into docs/templates/<id>/video/
```

Film one capture at a time. Each console renders on a software GPU that takes
about ten cores, so parallel captures drop frames and the console looks choppy.
To prepare several templates at once, rehearse them in parallel first with
`npm run capture -- <id> --dpr 1 --max-passes 1 --out /tmp/rehearsal`. That
performs and caches every voice line, so each filmed capture then needs only
one pass.

`publish` uploads `demo.mp4` to the `demo-films` release as `<id>.mp4`
(creating the release on first use, replacing an earlier cut) and checks that
the public download serves exactly that file. It copies the poster, captions,
transcript and notes into `docs/templates/<id>/video/`, removes any committed
`demo.mp4`, and marks `video/demo.mp4` (with its release `url`) and
`video/poster.webp` ready in that template's `template.json`. Then it
regenerates `docs/data/` and bumps the `?v=` cache key on every page that loads
`data/templates.js`. Review the film before you publish it: the upload is public
as soon as it lands.

| Command | Does |
| --- | --- |
| `npm run check -- <id> \| --all [--steps]` | Validates film scripts, prints where each narration line lands, estimates runtime. |
| `npm run capture -- <id> [--beats 1,3] [--out DIR] [--dpr 2] [--max-passes 4]` | Boots the console in simulation mode on the film's port and plays the filmed beats, screen-recording at 2× and logging when every line is spoken. Re-plays until every line comes from the voice cache (`--max-passes`, default 4). |
| `npm run compose -- <id> [--no-render] [--snap 12,40.5] [--draft] [--crf N] [--workers N]` | Lays out the film, writes the HyperFrames project, renders it, mixes and masters the voices, muxes `demo.mp4` and writes the companions. `--no-render --snap …` previews frames. |
| `npm run publish -- <id> [...] [--from DIR] [--github OWNER/NAME] [--release TAG] [--no-upload]` | Uploads composed films to the release (default `demo-films`, on the checkout's `origin`), copies their companions into the gallery, marks them ready and regenerates the catalogue. `--no-upload` points the docs at films already on the release. |
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

Nothing here talks to a real phone number: every call in a film is a scripted
simulation with synthetic voices and fictional people, as each film's closing
card says.
