# FiveCut for Linux

GitHub Actions produces a self-contained x86-64 portable archive. It contains:

- the FiveCut offline web application and local API server;
- a pinned Electron runtime;
- an isolated desktop window and automatic Downloads handling; and
- the AI-agent CLI, schemas, skill, and examples.

After extracting the release:

```sh
cd FiveCut
./fivecut
```

Nothing is installed system-wide. Run `./install.sh` if you also want a
`fivecut` terminal command and an application-menu entry.

Projects, imported media, and preferences stay in FiveCut's local Electron
profile. The optional Creator Library uses the internet only in non-offline
development builds; release builds use the bundled collection.

The launcher prefers Chromium's unprivileged user-namespace sandbox. On hosts
such as Ubuntu 24.04 that explicitly block it for portable applications, it
uses Chromium's portable compatibility mode. In both cases the FiveCut
renderer remains isolated from Node.js and navigation is restricted to the
local server; external links open in the system browser.
