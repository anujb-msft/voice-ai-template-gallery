# Voice AI Template Gallery

A static gallery of illustrative voice AI scenarios, implementation briefs, and
supporting assets. The catalogue is organized around business outcomes, system
touchpoints, and implementation complexity.

Every template ships a runnable Node.js sample in its `code/` folder. Each sample runs
offline in simulation mode and can connect to Azure services once configured.
[Intent-Based Call Routing](docs/templates/intent-based-call-routing/) is the reference
implementation, and [ARCHITECTURE.md](ARCHITECTURE.md) defines the standards every
template follows.

> [!IMPORTANT]
> These templates are samples, not production services. All people, sample
> organizations, scenario measurements, and outcomes are fictional or illustrative.
> Before using a template with real people or data, complete the appropriate security,
> privacy, accessibility, responsible AI, legal, and regulatory reviews.

## Browse locally

Serve the `docs/` directory with any static file server:

```bash
python3 -m http.server 4173 --directory docs
```

Then open <http://localhost:4173/>.

## Update the catalogue

Each template owns its source manifest at
`docs/templates/<template-id>/template.json`. After editing a manifest, regenerate the
checked-in browser data:

```bash
node scripts/generate-template-index.js
```

The generator validates manifest fields, paths, and expected-asset status before
writing `docs/data/templates.json` and `docs/data/templates.js`. Commit both files; CI
fails if they're out of date.

## Repository layout

| Path | Purpose |
| --- | --- |
| `docs/` | GitHub Pages site and template packages |
| `docs/templates/<template-id>/` | Manifest, documentation, media, and runnable sample |
| `docs/data/` | Generated catalogue data; don't edit by hand |
| `docs/schemas/template.schema.json` | Template manifest schema |
| `scripts/generate-template-index.js` | Catalogue validator and data generator |
| `.github/workflows/validate.yml` | Catalogue and sample checks for pull requests |
| `.github/workflows/pages.yml` | GitHub Pages deployment |
| `ARCHITECTURE.md` | Architectural standards for the site and templates |
| `CONTRIBUTING.md` | How to contribute fixes and new templates |

## Runnable samples

Each sample's `code/README.md` explains setup. Samples start in simulation mode, so you
can try them without Azure resources. Once configured, they connect to Azure
Communication Services and Azure AI Voice Live. They're demo-grade and deliberately not
production-ready: review each guide's documented limitations before running a sample
outside a local development environment. To try the reference sample, see
[Run the reference sample](CONTRIBUTING.md#run-the-reference-sample).

## Contributing and support

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute fixes or new templates and
[ARCHITECTURE.md](ARCHITECTURE.md) for the standards they follow. See
[SUPPORT.md](SUPPORT.md) for support expectations and [SECURITY.md](SECURITY.md) for
reporting security issues.

## Trademarks

This project may contain trademarks or logos for projects, products, or services.
Authorized use of Microsoft trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks).
Use of Microsoft trademarks or logos in modified versions of this project must not
cause confusion or imply Microsoft sponsorship. Any use of third-party trademarks or
logos is subject to those third parties' policies.
