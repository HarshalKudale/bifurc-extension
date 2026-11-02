# Bifurc Companion

[![CI](https://github.com/HarshalKudale/bifurc-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/HarshalKudale/bifurc-extension/actions/workflows/ci.yml)
[![Chrome users](https://img.shields.io/chrome-web-store/users/dcifgipphabedoiemccjpocgiganpjhi)](https://chromewebstore.google.com/detail/dcifgipphabedoiemccjpocgiganpjhi)
[![Firefox users](https://img.shields.io/amo/users/bifurc-companion)](https://addons.mozilla.org/firefox/addon/bifurc-companion/)
[![License](https://img.shields.io/badge/license-Bifurc%20(non--commercial)-blue)](LICENSE)

The browser extension for [Bifurc](https://github.com/HarshalKudale/bifurc). It sends your browser's traffic
through the Bifurc desktop app's proxy, so you can capture, mock and rewrite requests, HTTPS included, without
installing a certificate.

## Install

- [Chrome Web Store](https://chromewebstore.google.com/detail/dcifgipphabedoiemccjpocgiganpjhi) (also Edge, Brave)
- [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/bifurc-companion/)

You also need the [Bifurc desktop app](https://github.com/HarshalKudale/bifurc). **Routing HTTPS pages through
the engine needs Bifurc 0.6.2 or later.**

## Load it unpacked

The extension is plain JavaScript with no build step; the files at the repo root are what the browser loads.

- Chrome / Edge: `chrome://extensions`, turn on Developer mode, Load unpacked, pick this folder.
- Firefox: `about:debugging`, This Firefox, Load Temporary Add-on, pick `manifest.json`.

## Package and test

```
npm run package:chrome     # dist/bifurc-companion-chrome-<version>.zip
npm run package:firefox    # dist/bifurc-companion-firefox-<version>.zip
```

The end-to-end test starts a scratch Bifurc engine and a Chromium browser with the extension loaded:

```
cd scripts/e2e && npm install && node run.mjs
```

Set `BIFURC_BIN` to the folder with `bifurc-engine` and `bifurc` (see the header of `scripts/e2e/run.mjs`).

## Contributing, security, license

- [CONTRIBUTING.md](CONTRIBUTING.md) and the [CLA](CLA.md)
- [SECURITY.md](SECURITY.md)
- [LICENSE](LICENSE): free for personal and non-commercial use. Commercial or enterprise use needs written
  permission, and redistribution is not allowed. See also [TRADEMARKS.md](TRADEMARKS.md).

## Support Bifurc

Bifurc is free and maintained by one person.
[Ko-fi](https://ko-fi.com/codewrath) and
[GitHub Sponsors](https://github.com/sponsors/HarshalKudale). A star on the repo
helps too.

Contact: contact@bifurc.app
