# Third-party notices

## YunX

Repository: https://github.com/CYQawa/YunX

Source revision: cc9afe24c9409b239c361263b976f7aad77d1d9e

Copyright (C) 2026 CYQawa.

The blue-cloud protocol in `src/lanzou.mjs` is a JavaScript adaptation of:

- `app/src/main/kotlin/com/yunx/app/data/network/LanzouApi.kt`
- `app/src/main/kotlin/com/yunx/app/data/network/LanzouConstants.kt`

The implementation adapts account login, the challenge-cookie string transformation,
session-parameter parsing, directory tasks, multipart upload, share-folder pagination,
per-member share resolution and download-node handling. It does not use YunX as a
hosted API and does not include the Android UI or Android download manager.

Modifications: port to Node.js, cookie-domain handling through tough-cookie, bounded
responses, streaming upload, abort support and desktop task integration.

This application is distributed under GNU AGPL version 3 or later. The full license
is included in `LICENSE`. Corresponding source is the application project, including
`src/`, `ui/`, `scripts/`, `tests/`, the package manifest and lockfile. Keep these
sources available alongside any distributed binary.

## Runtime dependencies

- Electron: MIT; Chromium and other component notices ship with the runtime.
- tough-cookie: BSD-3-Clause; see its package license.
- yazl: MIT; see its package license.
- yauzl: MIT; see its package license.
- Transitive dependency license files are retained in their distributed packages.

## Warranty

Provided without warranty. Platform interfaces and availability can change.
