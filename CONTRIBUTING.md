# Contributing

Thank you for your interest in the Voice AI Template Gallery.

## Before opening an issue

Search existing issues before filing a new one. For bugs, include the affected
template, reproduction steps, expected behavior, actual behavior, and relevant
environment details. Do not include credentials, personal data, customer data, or
security vulnerability details in a public issue.

Report security issues through the process in [SECURITY.md](SECURITY.md).

## Pull requests

Keep changes focused and update the source manifest rather than generated catalogue
files. When a template manifest changes, run:

```bash
node scripts/generate-template-index.js
```

For changes to the runnable password-reset demo, also run its checks from
`docs/templates/it-helpdesk-password-reset/code/`:

```bash
npm ci
npm run check
```

All sample names and data must be fictional. Do not add customer names, internal URLs,
credentials, tenant identifiers, production endpoints, or unsupported deployment and
performance claims.

## Microsoft Contributor License Agreement

Most contributions require you to agree to a Contributor License Agreement (CLA)
declaring that you have the right to, and actually do, grant us the rights to use your
contribution. For details, visit [https://cla.microsoft.com](https://cla.microsoft.com).

When you submit a pull request, a CLA bot will automatically determine whether you need
to provide a CLA and decorate the pull request appropriately. Follow the instructions
provided by the bot. You will only need to do this once across all repositories using
the Microsoft CLA.
