# Film scripts

One file per template, `films/<template-id>.mjs`, default-exporting a plain
object. It says who speaks with which GPT Realtime voice, what the narrator
says around each beat of the template's own demo script (`code/public/beats.js`),
and what the HyperFrames scenes before and after the console show.

`films/intent-based-call-routing.mjs` is the reference. Check a script before
capturing it:

```bash
node src/check.mjs <template-id>     # step map, problems, estimated runtime
node src/check.mjs --all
```

## The film

| Scene | What's on screen | Narration |
| --- | --- | --- |
| `open` | A phone ringing with the call; optionally the "old way" list, struck through; then a quote bubble | 1–2 lines. Line 2's last sentence times the strike |
| `title` | Template name, one-line promise, chips | none |
| `how` | The pipeline, one stage lighting up as the narration reaches it | 2–3 lines |
| console | The template's console in simulation mode, captured live: an establishing title, then each filmed beat with a chapter slate, the camera following the conversation | the beats' `intro`, `cues`, `post`, `after` |
| `hood` | A principle and up to 6 key/value rows | 2–3 lines |
| `yours` | The files to change, and a prompt typed into "Your coding agent" | 2 lines: line 1 for the files, line 2 for the agent |
| `close` | Name, the run command, the gallery URL, the synthetic-voice disclosure | 1 line |

Every line spoken in the film, by the narrator, agent or caller, is performed
by Azure OpenAI GPT Realtime (`gpt-realtime` on Voice Live), and burned in as a
subtitle.

## Schema

```js
export default {
  id: "template-id",              // must match the file name and docs/templates/<id>
  port: 18101,                    // a free 18xxx port for the capture server
  lang: "en-US",

  cast: {
    narrator: { voice: "cedar" },                // optional; cedar is the default
    agent: { name: "Agent", voice: "marin" },    // the template's voice agent
    callers: {
      dana: { name: "Dana Whitfield", voice: "coral", style: "Who she is and how she sounds on a phone call." },
    },
  },

  beats: {
    1: {                          // console beat number, 1-based, as on screen
      caller: "dana",             // who performs this beat's caller lines
      lang: "es-US",              // optional: the caller's language for this beat
      intro: "Before the beat starts.",
      cues: { 3: "Before step 3 runs." },
      post: { 2: "After step 2 has settled." },
      after: "After the beat ends.",
      shots: { "post 2": "decision" }, // optional camera direction; "decision!" or {x, y, w, hold: true} holds while people speak
      skip: 2,                    // optional: fast-forward over steps 1–2, or [from, to], or [[1, 1], [8, 8]]; whole presses only
      skipLabel: "Avery is verified", // optional: the skip card's title under "Skipping ahead"; one per jump for a list
    },
  },

  lines: [{ match: "Hello, this is", caller: "sam" }], // optional per-line caller override
  edit: { beats: [1, 2, 4] },     // which beats the film shows, in order (default: all)

  console: {                      // optional
    establish: { eyebrow: "The template's own console", title: "Simulation mode", sub: "…" },
    chapterNoun: "Call",          // the slate reads "Call 2 of 5"
    chapterHold: 4.8,
  },
  capture: { path: "/", env: {}, notes: "off", extraHeight: 260 }, // optional
  camera: {},                     // optional overrides of CAMERA in src/edit.mjs
  poster: 3,                      // optional poster time (s); default: the title card

  scenes: {
    open: {
      call: { name: "Dana Whitfield", detail: "Northwind Traders", number: "+1 (425) 555-0101", line: "Contoso · Main line", label: "Incoming call" },
      menuTitle: "The usual phone menu",
      menu: ["For sales, press 1.", { key: "♪", text: "Your call is important to us." }],
      bubble: { who: "Dana", text: "I was charged twice" },   // or false; default: the first caller line
      narration: ["Line one.", "Line two. Its last sentence strikes the menu."],
    },
    title: { title: "Template Name", promise: "One line.", chips: ["Optional", "Defaults to tags"], eyebrow: "Optional" },
    how: {
      eyebrow: "How it works", title: "From a phone call to the right outcome",
      stages: [{ label: "Teams Phone", detail: "…", brand: true, line: 0 }], // 3–7; brand lights Teams surfaces
      narration: ["…", "…"],
    },
    hood: { eyebrow: "Under the hood", title: "The principle", points: [{ k: "key", v: "value" }], narration: ["…"] },
    yours: {
      title: "Configuration first. Your coding agent for the rest.",
      files: [{ path: "config/routes.json", note: "…" }],   // up to 6
      prompt: "A change a developer would ask their coding agent for.", // under 140 characters
      context: ["SPEC.md", "DEMO-SCRIPT.md", "test/"], agentLabel: "Your coding agent", // name files the template has
      narration: ["Line one, as the files appear.", "Line two, as the prompt types."],
    },
    close: { narration: ["…"], run: "cd code && npm install && npm start", url: "…", disclosure: "…" },
  },
};
```

## How narration and the console meet

The capture plays the console's own demo script, one press of **Next** at a
time, and **holds the console still while the narrator speaks**:

- `intro` plays once the beat is loaded, before its first step.
- `cues[s]` plays before step `s`; `post[s]` after step `s` and everything it
  triggered has settled (the agent finished speaking, the panels stopped moving).
- Steps are numbered from 1 in `beats.js` order, chained steps included
  (`node src/check.mjs <id>` prints the numbers). Chained steps (`⤷`) run with
  the step before them in one press, so a cue on a chained step plays before
  that whole group, and a post after it.
- `after` plays when the beat has finished.

Write cues as a presenter would: say what to watch for, then let the console
show it. Don't read out what the subtitles already say, and keep each line
under about 30 words. Every narrator line adds its own length, plus about
0.75 s, to the console's runtime.

A beat can fast-forward over steps the film has already shown, such as a second
caller's greeting and identity check. Set `skip` to the steps (`2` for steps
1–2, or `[3, 5]`) and they still run in the capture, so the console's state is
real, but the film cuts from just before the first skipped press to just before
whatever follows the last one. A "Skipping ahead" card, titled `skipLabel`,
covers the cut. For more than one jump in a beat, list the ranges in step order,
as in `skip: [[1, 1], [8, 8]]`, and give `skipLabel` one title per jump. A skip
must cover whole presses. The first press's cues and the last press's posts are
still heard; anything else said inside the skip is cut, and
`node src/check.mjs` fails a cue or post that lands there. Give a beat that
skips from step 1 an intro, so the card doesn't land on the chapter slate.

Agent lines come from the template's simulation and are voiced as they appear.
Caller lines are the `say` steps in `beats.js`, performed in the beat caller's
voice and style (or a `lines` override, for a beat where someone else picks up).

## Voices

GPT Realtime's native voices: `alloy`, `ash`, `ballad`, `coral`, `echo`,
`sage`, `shimmer`, `verse`, `marin`, `cedar`. The narrator is `cedar` and the
agent `marin`; give callers the others, and a `style` that describes a real
person on a phone call, not an actor.

## House rules

- **Channels.** Teams Phone extensibility is the phone channel: calls arrive on,
  or go out from, a Teams phone number. Azure Communication Services Call
  Automation is the media bridge underneath it. Never make ACS the headline.
  Voice Live, with GPT Realtime, holds the conversation.
- **Succinct.** About five minutes; up to six and a half for the more
  sophisticated templates. Choose beats with `edit.beats`, cut any beat that
  repeats an earlier lesson, and `skip` the steps within a beat that do.
- **True to the template.** Claim only what the code does. Name the policy the
  server enforces, and say plainly where the model's job ends.
- **Plain voice-over.** Warm, confident, specific. No "seamless", "leverage",
  "revolutionary" or "game-changing". Spell times and numbers the way they're
  said ("7:30 in the evening").
