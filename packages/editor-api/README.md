# FiveCut editor API

The FiveCut editor API is a deterministic, versioned file contract for building
and revising editable video timelines. It is designed for local coding agents,
file-capable AI websites, the FiveCut desktop importer, and other tools that
need to produce the same result without clicking through the UI.

Current API version: **1.0.0**

## Canonical files

- [`fivecut.config.json`](fivecut.config.json) — paths, capabilities, and state conventions
- [`schemas/fivecut-project.schema.json`](schemas/fivecut-project.schema.json) — complete project document
- [`schemas/fivecut-command-package.schema.json`](schemas/fivecut-command-package.schema.json) — transactional revision package
- [`../../SKILL.md`](../../SKILL.md) — agent workflow and creative safety rules

The JSON schemas use JSON Schema draft 2020-12. The Python agent also validates
semantic rules that JSON Schema cannot express, including file existence,
hashes, source bounds, global ID uniqueness, keyframe bounds, track/clip
compatibility, and project-root path containment.

## Project document

A project must use:

```json
{
  "$schema": "packages/editor-api/schemas/fivecut-project.schema.json",
  "format": "fivecut-project",
  "version": "1.0.0"
}
```

Top-level fields:

| Field | Purpose |
| --- | --- |
| `compatibility` | Minimum app version and required capabilities |
| `project` | Identity, canvas, frame rate, sample rate, background, timestamps, generator, and fixed seed |
| `assets` | Relative file paths and probed media metadata |
| `tracks` | Ordered video, audio, caption, graphic, and adjustment tracks |
| `markers` | Named timeline points and ranges |
| `export` | Output path, container, codecs, quality, pixel format, loudness, and metadata |
| `metadata` | Original request, notes, rejection reasons, and asset attributions |

All time values are seconds. Visual tracks are ordered back-to-front. Every
asset, track, clip, effect, keyframe, marker, package, and operation uses a
stable ID matching:

```text
^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$
```

Project seeds are unsigned 32-bit integers. Keep the seed fixed so any
procedural choice can be reproduced.

### Media and tracks

Supported asset kinds:

- `video`
- `audio`
- `image`
- `subtitle`
- `font`
- `other`

Supported track kinds:

- `video`
- `audio`
- `caption`
- `graphic`
- `adjustment`

Supported clip types:

- `media`
- `text`
- `caption`
- `shape`

The current deterministic renderer supports color-grade, blur, sharpen,
pixelate, and film-grain effects in addition to transforms, keyframes,
transitions, media speed, volume, captions, text, and shapes. Run a render dry
run to obtain the authoritative compatibility report for a specific project.

To create a silent held frame from a video, set
`freezeFrameSourceTime` on a media clip to the absolute source timestamp in
seconds. The clip's `duration` controls how long the frame is held. Keep the
timestamp strictly before the source duration; `sourceIn`, `sourceDuration`,
`speed`, and source audio do not affect a frozen clip.

```json
{
  "id": "clip:reaction-freeze",
  "type": "media",
  "assetId": "asset:camera-a",
  "start": 12.4,
  "duration": 2,
  "freezeFrameSourceTime": 8.75,
  "includeSourceAudio": false
}
```

### Paths and source safety

Asset and export paths resolve relative to the project document. By default:

- assets cannot escape the project root;
- referenced files must exist;
- optional assets may produce warnings;
- SHA-256 values, when present, must be lowercase and correct when hash
  verification is requested;
- source media is read-only; and
- an existing output is not overwritten.

`--allow-external-assets` is an explicit escape hatch for trusted local
workflows. Portable AI website packages should always use relative paths.

## Command package

A revision package has this shape:

```json
{
  "$schema": "packages/editor-api/schemas/fivecut-command-package.schema.json",
  "format": "fivecut-command-package",
  "version": "1.0.0",
  "packageId": "package:creator-intro-v2",
  "description": "Tighten the opening and update delivery metadata.",
  "baseProjectSha256": "<64-character current project digest>",
  "onMissingAsset": "fail",
  "dryRunFirst": true,
  "operations": [
    {
      "id": "op:update-export",
      "op": "export.update",
      "patch": {
        "output": "renders/creator-intro-v2.mp4",
        "loudnessTargetLufs": -14
      }
    }
  ]
}
```

Supported operations:

| Operation | Required fields | Result |
| --- | --- | --- |
| `asset.add` | `value` | Add a project asset |
| `asset.remove` | `targetId` | Remove an asset |
| `track.add` | `value` | Add a track |
| `track.remove` | `targetId` | Remove a track |
| `track.update` | `targetId`, `patch` | Deep-merge mutable track fields |
| `clip.add` | `trackId`, `value` | Add a clip to a track |
| `clip.remove` | `targetId` | Remove a clip |
| `clip.update` | `targetId`, `patch` | Deep-merge mutable clip fields |
| `marker.add` | `value` | Add a marker |
| `marker.remove` | `targetId` | Remove a marker |
| `project.update` | `patch` | Update mutable project metadata/canvas fields |
| `export.update` | `patch` | Update export settings |

Operations may declare preconditions:

```json
{
  "preconditions": {
    "exists": true,
    "fieldEquals": {
      "name": "Opening shot"
    }
  }
}
```

An operation fails if its precondition is not true. IDs are immutable.
`track.update` cannot replace `clips`, and `project.update` cannot replace the
project ID or seed.

## Transaction guarantees

Apply packages through the agent:

```bash
bin/fivecut-agent hash fivecut.project.json
bin/fivecut-agent validate edit-package.json --kind commands
bin/fivecut-agent apply fivecut.project.json edit-package.json --dry-run
bin/fivecut-agent apply fivecut.project.json edit-package.json
```

The apply engine:

1. validates the package;
2. rejects a stale `baseProjectSha256`;
3. copies project state in memory;
4. applies each operation in order;
5. revalidates the complete project after every operation;
6. aborts without writing if anything fails;
7. atomically writes the new project;
8. saves the previous bytes to `.fivecut/history/`; and
9. appends a JSONL audit record to `.fivecut/logs/operations.jsonl`.

This makes packages deterministic, undo-safe, and suitable for unattended
agents.

## Validation

```bash
# Complete project plus referenced files
bin/fivecut-agent validate fivecut.project.json

# Also recompute every supplied asset hash
bin/fivecut-agent validate fivecut.project.json --verify-hashes

# Schema/semantic validation when media is not available yet
bin/fivecut-agent validate incoming.fivecut.json --no-file-check

# Command package
bin/fivecut-agent validate edit-package.json --kind commands
```

Validation reports contain `valid`, `errorCount`, `warningCount`, and an
`issues` array. Each issue has:

- `level`
- `code`
- JSON-style `path`
- human-readable `message`

Consumers must treat any error as a hard failure. Warnings must be displayed or
logged; they must not be silently discarded.

## Compatibility and capabilities

Projects declare `minimumAppVersion` and `requiredCapabilities`. Version 1.0.0
currently advertises:

- `asset-index-v1`
- `transactional-commands-v1`
- `ffmpeg-render-v1`
- `captions-v1`
- `keyframes-v1`
- `color-grade-v1`
- `freeze-frame-v1`

Importers must reject unsupported required capabilities. Never approximate an
unsupported command or remove it merely to make validation pass.

## State files

FiveCut reserves `.fivecut/` for generated, recoverable state:

| Path | Contents |
| --- | --- |
| `.fivecut/media-index.json` | Probed assets and hashes |
| `.fivecut/analysis/latest.json` | Latest technical analysis |
| `.fivecut/analysis/` | Timestamped analysis reports and contact sheets |
| `.fivecut/history/` | Project snapshots |
| `.fivecut/logs/operations.jsonl` | Applied-package audit trail |
| `.fivecut/reports/` | Render and QC reports |
| `.fivecut/temp/` | Replaceable intermediate data |

Deliverables belong in `renders/`. Source media must never be placed in or
rewritten through the state directory.

## End-to-end example

```bash
bin/fivecut-agent doctor
bin/fivecut-agent init . --name "Launch video"
bin/fivecut-agent scan . --output .fivecut/media-index.json
bin/fivecut-agent analyze fivecut.project.json
bin/fivecut-agent validate fivecut.project.json --verify-hashes
bin/fivecut-agent apply fivecut.project.json edit-package.json --dry-run
bin/fivecut-agent apply fivecut.project.json edit-package.json
bin/fivecut-agent render fivecut.project.json --dry-run
bin/fivecut-agent render fivecut.project.json
bin/fivecut-agent qc fivecut.project.json
```

For creative selection, caption, audio, pacing, and final-review rules, follow
the [AI agent guide](../../docs/AI_AGENT_GUIDE.md) and
[professional workflow](../../skills/fivecut-editor-agent/references/professional-workflow.md).
