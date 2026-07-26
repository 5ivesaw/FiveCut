<p align="center">
  <img src="apps/web/public/logos/fivecut/icon.svg" alt="FiveCut chainsaw mark" width="104">
</p>

<h1 align="center">FiveCut</h1>

<p align="center">
  A local-first, creator-focused desktop video editor with a documented AI editing API.
</p>

> FiveCut is under active development. Core editing comes from the mature
> OpenCut v0.3 editor; desktop packaging, automated releases, and the agent API
> are being completed and tested in this repository.

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

## AI editing API

The stable contract lives in [`packages/editor-api`](packages/editor-api).
Agents should read [`SKILL.md`](SKILL.md) and use `fivecut-agent` to scan media,
validate projects, apply hash-guarded command packages, and render with FFmpeg.
All AI operations are designed to be deterministic, logged, and recoverable.

Detailed agent documentation and import UI are being completed as part of the
first FiveCut release.

## Automated builds

- `FiveCut CI` checks the Rust core, web editor, and agent contracts.
- `Build FiveCut release` creates a portable Linux artifact.
- Pushing a `v*` tag publishes the artifact and checksum as a GitHub Release.

## Attribution

FiveCut is an independent fork based on
[OpenCut](https://github.com/OpenCut-app/OpenCut) and remains MIT-licensed.
See [NOTICE.md](NOTICE.md) for asset and third-party notices.
