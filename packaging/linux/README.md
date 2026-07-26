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
