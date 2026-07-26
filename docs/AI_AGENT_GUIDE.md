# FiveCut AI agent guide

FiveCut lets an external AI system create a complete, editable video project
without embedding an LLM, account, or API key in the editor. The same versioned
JSON contract works with:

- a local coding agent operating in the project directory; and
- a file-capable AI website that returns a project or command package for import.

Start with [`SKILL.md`](../SKILL.md). It defines the professional workflow and
safety rules an agent must follow. This guide explains the concrete files and
commands.

## Requirements

- Python 3.11 or newer
- FFmpeg and FFprobe
- the `fivecut-agent` launcher from `bin/`

The portable FiveCut release includes the agent files. From a source checkout,
run commands from the repository root as `bin/fivecut-agent`. If the release
installer added FiveCut to `PATH`, use `fivecut-agent`.

Check the environment before doing any work:

```bash
bin/fivecut-agent doctor
```

The command returns JSON and exits with status `0` only when the required
runtime, filters, and H.264/AAC encoders are available.

## Recommended project directory

```text
creator-video/
├── fivecut.project.json
├── assets/
│   ├── video/
│   ├── audio/
│   ├── images/
│   ├── subtitles/
│   └── fonts/
├── instructions/
│   └── brief.md
├── renders/
└── .fivecut/
    ├── media-index.json
    ├── analysis/
    ├── history/
    ├── logs/
    ├── reports/
    └── temp/
```

Keep source files inside the project directory. FiveCut rejects paths that
escape the project root unless `--allow-external-assets` is explicitly passed.
The agent must reference source media rather than modifying it.

## Local agent workflow

### 1. Initialize and inspect

Put all supplied media in the project directory, then run:

```bash
bin/fivecut-agent doctor
bin/fivecut-agent init . --name "Creator video"
bin/fivecut-agent scan . --output .fivecut/media-index.json
bin/fivecut-agent analyze fivecut.project.json
bin/fivecut-agent inspect fivecut.project.json --verify-hashes
bin/fivecut-agent validate fivecut.project.json --verify-hashes
```

`init` detects the first video’s canvas and frame rate, indexes source hashes,
and creates empty video, graphics, caption, and audio tracks. Add
`--auto-sequence` only when a chronological string-out is actually wanted.

`analyze` records scene changes, silence, black and frozen intervals, loudness,
and a contact sheet under `.fivecut/analysis/`. `--quick` reduces analysis cost;
`--asset <asset-id>` can be repeated to analyze selected assets.

### 2. Plan before mutating

The agent should read:

- the user brief;
- `.fivecut/media-index.json`;
- `.fivecut/analysis/latest.json`;
- the current project inspection report; and
- [`skills/fivecut-editor-agent/references/professional-workflow.md`](../skills/fivecut-editor-agent/references/professional-workflow.md).

Technical detections are evidence, not creative decisions. A silence interval
does not automatically mean “delete this.” The agent should first establish the
audience, delivery format, duration, story, pacing, visual language, caption
style, and audio priorities.

### 3. Apply changes transactionally

For an existing project, generate a `fivecut-command-package` instead of
rewriting the project in place:

```bash
bin/fivecut-agent hash fivecut.project.json
bin/fivecut-agent validate edit-package.json --kind commands
bin/fivecut-agent apply fivecut.project.json edit-package.json --dry-run
bin/fivecut-agent apply fivecut.project.json edit-package.json
bin/fivecut-agent validate fivecut.project.json --verify-hashes
bin/fivecut-agent inspect fivecut.project.json --verify-hashes
```

Put the current project digest in `baseProjectSha256`. If another process
changes the project, FiveCut rejects the package as stale. Each successful apply
stores the previous project under `.fivecut/history/` and appends a structured
entry to `.fivecut/logs/operations.jsonl`.

Every operation is validated in order against the complete project invariants.
If one operation fails, FiveCut rejects the whole package and does not partially
apply it.

### 4. Render and quality-check

```bash
bin/fivecut-agent render fivecut.project.json --dry-run
bin/fivecut-agent render fivecut.project.json
bin/fivecut-agent qc fivecut.project.json
```

The dry run creates a compatibility report without launching FFmpeg. Rendering
fails rather than silently dropping unsupported media, effects, captions,
keyframes, or codecs. Reports are stored under `.fivecut/reports/`.

QC verifies output decoding, streams, duration, resolution, frame rate, black
and frozen segments, long silence, and maximum audio volume. `--quick` skips the
slower signal analysis but still checks the file structure and delivery format.

The agent should inspect the finished video as well as the machine report.
Creative judgment, spelling, performance choice, and whether a pause feels
intentional cannot be proved by a detector alone.

## AI website workflow

A website such as ChatGPT or Claude does not need to control the FiveCut UI.
Give it:

1. the editing request;
2. the relevant project schema;
3. media names and probed metadata;
4. the existing project when revising an edit; and
5. [`SKILL.md`](../SKILL.md).

Ask it to return exactly one of:

- a complete `fivecut-project` JSON document for a new edit; or
- a `fivecut-command-package` JSON document for a revision.

Suggested prompt:

```text
Create a deterministic FiveCut 1.0.0 edit from the supplied brief and media
index. Follow SKILL.md. Return only a valid fivecut-project JSON document.
Reference assets by their provided relative paths and IDs; do not invent files,
durations, hashes, analysis, or transcript timing. Use intentional effects and
explicit export settings. Put any uncertainty in metadata.notes.
```

For a freeze frame, create a video media clip with
`freezeFrameSourceTime` set to an absolute source timestamp in seconds and use
the clip `duration` as the hold length. Frozen clips are always silent. Require
the `freeze-frame-v1` capability when the result depends on this behavior.

In the FiveCut Projects screen, choose **Import AI edit**, select the returned
JSON document, and then select the referenced media. FiveCut checks the schema,
version, paths, hashes, capabilities, media types, source ranges, track
compatibility, timing, and duplicate IDs before saving anything. A failed import
does not create a partial project.

An AI website may not have source file bytes. It should omit unknown hashes
instead of inventing them. The local importer or agent can add verified hashes
after receiving the actual files.

## Recovery

List snapshots:

```bash
bin/fivecut-agent history fivecut.project.json
```

Dry-run a restore using a path returned by `history`:

```bash
bin/fivecut-agent restore \
  fivecut.project.json \
  .fivecut/history/20260726T120000.000000Z-abcd1234.fivecut.json \
  --expected-current-sha256 <current-project-sha256> \
  --dry-run
```

Remove `--dry-run` only after the report passes. Restore first creates a safety
snapshot of the current project, so undoing a restore remains possible.

## Exit codes and errors

All commands write structured JSON. Normal success exits `0`. Validation and
doctor readiness failures exit `2`. Operational failures exit `1` and use:

```json
{
  "format": "fivecut-error",
  "version": "1.0.0",
  "status": "error",
  "code": "STALE_PROJECT",
  "message": "Project changed: package expects …"
}
```

An agent must stop on a non-zero exit, report the exact error, and repair the
input. It must never hide an error by dropping the affected operation.

## Canonical references

- [Project and command API](../packages/editor-api/README.md)
- [Project schema](../packages/editor-api/schemas/fivecut-project.schema.json)
- [Command package schema](../packages/editor-api/schemas/fivecut-command-package.schema.json)
- [Project-format invariants](../skills/fivecut-editor-agent/references/project-format.md)
- [Professional editing workflow](../skills/fivecut-editor-agent/references/professional-workflow.md)
