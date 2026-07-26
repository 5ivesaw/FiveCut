<p align="center">
  <img src="apps/web/public/logos/fivecut/icon.svg" alt="FiveCut chainsaw mark" width="104">
</p>

<h1 align="center">FiveCut</h1>

<p align="center">
  A local-first, creator-focused desktop video editor with a documented AI editing API.
</p>

> FiveCut is under active development. Core editing comes from the mature
> OpenCut v0.3 editor, while FiveCut adds a local desktop release, creator
> assets, effects, and a deterministic external-AI project API.

## What already works

- Multi-track video, image, text, graphic, effect, and audio timelines
- Frame-accurate trimming, splitting, snapping, ripple editing, and undo/redo
- GPU preview/export, masks, keyframes, captions, speed, volume, and blend modes
- FiveCut transition presets and non-destructive color/effect adjustments
- Local project/media storage with no account or hosted database required
- Offline backgrounds and sound effects
- Optional Openverse image, music, and SFX search; selected media is cached locally
- Versioned JSON project and command-package schemas for AI agents

## Privacy and offline behavior

Editing, project storage, preview, and export are local. The Creator Library is
the only editor feature that intentionally needs the internet, and the editor
falls back to its built-in assets when it is unavailable. Set
`FIVECUT_OFFLINE=1` to prevent remote catalog searches.

## Development

Requirements: Bun 1.2.18, Rust stable, `wasm32-unknown-unknown`, wasm-pack, and
FFmpeg.

```bash
bun install
bun run build:wasm
bun run build:web
```

Run the web shell locally:

```bash
bun run dev:web
```

The local editor opens at `http://localhost:3000/projects`.

## Linux desktop release

Download `FiveCut-linux-x64.tar.gz` from
[GitHub Releases](https://github.com/5ivesaw/FiveCut/releases), then:

```bash
tar -xzf FiveCut-linux-x64.tar.gz
cd FiveCut
./fivecut
```

The archive contains its own Electron runtime and local FiveCut server. Run
`./install.sh` only if you also want a `fivecut` terminal command and an
application-menu entry.

## AI editing API

The stable contract lives in [`packages/editor-api`](packages/editor-api).
Agents should read [`SKILL.md`](SKILL.md) and use `fivecut-agent` to scan media,
validate projects, apply hash-guarded command packages, and render with FFmpeg.
All AI operations are designed to be deterministic, logged, and recoverable.

External AI sites can return a complete `fivecut-project` JSON file. Use
**Import AI edit** on FiveCut's Projects screen, select that file and its
referenced media, and FiveCut validates paths, hashes, capabilities, timing, and
media before storing the editable project. No built-in LLM or API key is
required.

## Automated builds

- `FiveCut CI` checks the Rust core, web editor, and agent contracts.
- `Build FiveCut release` creates and smoke-tests a portable Linux desktop
  artifact on a virtual display.
- Pushing a `v*` tag publishes the artifact and checksum as a GitHub Release.

## Attribution

FiveCut is an independent fork based on
[OpenCut](https://github.com/OpenCut-app/OpenCut) and remains MIT-licensed.
See [NOTICE.md](NOTICE.md) for asset and third-party notices.
