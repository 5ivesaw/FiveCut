# FiveCut WebAssembly core

Shared video-editor logic compiled to WebAssembly for FiveCut. The package keeps
the `opencut-wasm` compatibility name while the upstream migration remains in
progress.

## Install

```bash
npm install opencut-wasm
```

## Usage

```ts
import { formatTimecode, mediaTimeFromSeconds } from "opencut-wasm";

const ticks = mediaTimeFromSeconds(1.5);
const label = formatTimecode({ ticks });
```

The generated `pkg` directory includes TypeScript declarations for every
export.

## Source

Functions are implemented in Rust under [`rust/crates/`](../crates/). This
package is compiled output; do not edit it directly.

## Local development

The web app depends on the published `opencut-wasm` package by default. If you are editing the WASM source in this repo and want `apps/web` to use your local build instead:

```bash
# From the repo root
bun run build:wasm

cd rust/wasm/pkg
bun link

cd ../../../apps/web
bun link opencut-wasm
```

While you work, rebuild on changes from the repo root:

```bash
bun dev:wasm
```
