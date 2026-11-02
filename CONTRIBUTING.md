# Contributing to Bifurc Companion

Bifurc Companion is a free project maintained by one person. PRs are welcome but may take a while to review, and some will
be declined to keep the scope small. Open an issue before starting anything bigger than a bug fix.

## Before you open a pull request

1. Read the [LICENSE](LICENSE). Bifurc is free for personal and non-commercial use; you may change your own copy
   and send changes upstream, but not distribute changed versions.
2. Sign the [CLA](CLA.md). A bot asks you on your first PR.
3. Keep the change focused: one logical change per PR, explain the user impact, no unrelated cleanup.
4. Add no new telemetry or network calls without discussing it in an issue first.

## Development

The extension is plain JavaScript with no build step: the files at the repo root are what the browser loads.

- Load it unpacked: `chrome://extensions` (Developer mode, Load unpacked) or `about:debugging` in Firefox.
- Check your change: `node --check` on each `.js` file you touched, and `npx web-ext lint --source-dir .`.
- Package it: `npm run package:chrome` or `npm run package:firefox`.
- The end-to-end test is in `scripts/e2e`; it needs the Bifurc desktop app.

Changing a file the extension ships means a version bump in `manifest.json` (the maintainer does this at release).
The app repo's [CONTRIBUTING.md](https://github.com/HarshalKudale/bifurc/blob/master/CONTRIBUTING.md) covers the
rest.

## Commits and PRs

Write a short, plain subject line that says what changed. Fork the repo, branch from `master`, and open the PR
against `master`. CI must pass.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## Need help?

See [SUPPORT.md](SUPPORT.md), or write to **contact@bifurc.app**.
