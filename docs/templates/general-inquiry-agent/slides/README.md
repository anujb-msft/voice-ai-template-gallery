# Slide deliverables

- [`general-inquiry-agent.pdf`](./general-inquiry-agent.pdf) — one-slide value proposition, for business decision-makers
- `general-inquiry-agent.pptx` — editable deck, pending
- `preview.webp` — slide preview image, pending

The gallery card's **PDF** button and the template page open the slide. It leads with
the potential outcomes, then says what the agent does, who it's for, how success is
measured, the systems it touches, and how complex it is to build, beside a still of the
template's console.

## Production details

- **Text and colors:** generated from [`template.json`](../template.json) by
  [`scripts/slides`](../../../../scripts/slides/). Edit the manifest, not the PDF, then
  run `npm run build -- --only=general-inquiry-agent` there and commit the slide. CI fails while
  it is out of date.
- **Picture:** the console in simulation mode at 0:45 in the
  [overview film](https://github.com/anujb-msft/voice-ai-template-gallery/releases/download/demo-films/overview.mp4),
  cut at the moment and crop in `scripts/slides/stills.json`.
- **Format:** a tagged 16:9 PDF, with alternate text for the picture and sanitized
  document metadata.

The editable deck and preview image are pending. Don't substitute empty or fabricated
files: add only reviewed, template-specific materials with sanitized document metadata,
and update the matching statuses in `template.json`.
