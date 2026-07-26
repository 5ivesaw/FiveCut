# FiveCut project-format reference

Use the canonical schemas:

- `packages/editor-api/schemas/fivecut-project.schema.json`
- `packages/editor-api/schemas/fivecut-command-package.schema.json`

## Invariants

- Use `format: "fivecut-project"` and `version: "1.0.0"`.
- Express all timeline and source times in seconds.
- Use a fixed integer `project.seed`.
- Resolve asset and export paths relative to the project JSON.
- Treat track array order as back-to-front for visual compositing.
- Give assets, tracks, clips, effects, keyframes, markers, packages, and
  operations stable IDs.
- Keep source ranges within the probed asset duration.
- Keep transition duration at or below half the clip duration.
- Keep keyframe times relative to clip start and within clip duration.
- Use `freezeFrameSourceTime` for a silent held video frame. It is an absolute
  source timestamp, must be strictly before the asset end, and requires the
  `freeze-frame-v1` capability.

## Recommended directory

```text
project/
├── fivecut.project.json
├── assets/
│   ├── video/
│   ├── audio/
│   ├── images/
│   ├── subtitles/
│   └── fonts/
├── instructions/
├── renders/
└── .fivecut/
    ├── media-index.json
    ├── history/
    ├── logs/
    ├── reports/
    └── temp/
```

## Command packages

Use command packages for changes to an existing project. Set
`baseProjectSha256` to the exact hash reported by `fivecut-agent hash`. List
operations in dependency order: add assets, add tracks, add/update clips, add
markers, then update export settings.

Every package applies as one transaction. A failed operation invalidates the
entire package.
