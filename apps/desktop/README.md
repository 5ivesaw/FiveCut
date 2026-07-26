# FiveCut desktop

The published Linux build wraps FiveCut's local standalone server in an
Electron window. The server binds only to `127.0.0.1`, the renderer has no Node
access, external navigation opens in the system browser, and the editor works
without an internet connection.

`main.cjs` is copied into the portable bundle by
`.github/workflows/release.yml`. GitHub Actions runs that packaged application
under Xvfb before it can be published.
