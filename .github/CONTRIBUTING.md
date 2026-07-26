# Contributing to FiveCut

Thanks for helping make FiveCut better. Open an issue before a large change so
the approach can be discussed before significant work begins.

## Local setup

Install Bun 1.2.18, Rust stable, the `wasm32-unknown-unknown` target,
`wasm-pack`, and FFmpeg. Then run:

```bash
bun install --frozen-lockfile
bun run build:wasm
bun run dev:web
```

The editor is available at `http://localhost:3000/projects`. See
[`apps/desktop/README.md`](../apps/desktop/README.md) for the desktop wrapper.

## Before opening a pull request

Run the checks relevant to your change:

```bash
bun test
bun run lint:web
cargo test --workspace --locked
python3 -m unittest discover -s tools/fivecut_agent/tests -v
python3 tools/validate_site.py
```

Keep edits focused, add tests for behavior changes, preserve source-media
safety, and update schemas and documentation when changing the external project
format. Pull requests must pass the GitHub Actions quality gates.

FiveCut is based on OpenCut. Retain required MIT attribution when reusing or
porting upstream work, and document the source and license of newly bundled
assets.
