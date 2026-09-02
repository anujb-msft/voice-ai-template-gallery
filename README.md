# Voice AI Template Gallery

A static gallery of illustrative voice AI scenarios, implementation briefs, and
supporting assets. The catalogue is organized around business outcomes, system
touchpoints, and implementation complexity.

One template, [IT Help Desk Password Reset](docs/templates/it-helpdesk-password-reset/),
currently includes a runnable Node.js reference demo. The remaining template packages
define the intended workflow, configuration surface, and deliverable structure for
future implementations.

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
writing `docs/data/templates.json` and `docs/data/templates.js`.

## Repository layout

| Path | Purpose |
| --- | --- |
| `docs/` | GitHub Pages site and template packages |
| `docs/templates/<template-id>/` | Manifest, documentation, media, and optional runnable code |
| `docs/schemas/template.schema.json` | Template manifest schema |
| `scripts/generate-template-index.js` | Catalogue validator and data generator |
| `.github/workflows/pages.yml` | GitHub Pages deployment |

## Runnable reference demo

The password-reset package is a local reference demo that can optionally connect to
Azure Communication Services, Azure AI Voice Live, and Azure SignalR. It is deliberately
not production-ready. Follow its
[setup guide](docs/templates/it-helpdesk-password-reset/code/README.md) and review the
documented security limitations before running it outside a local development
environment.

## Contributing and support

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance,
[SUPPORT.md](SUPPORT.md) for support expectations, and [SECURITY.md](SECURITY.md) for
reporting security issues.

## Trademarks

This project may contain trademarks or logos for projects, products, or services.
Authorized use of Microsoft trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks).
Use of Microsoft trademarks or logos in modified versions of this project must not
cause confusion or imply Microsoft sponsorship. Any use of third-party trademarks or
logos is subject to those third parties' policies.
