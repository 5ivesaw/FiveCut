---
name: fivecut-editor-agent
description: Inspect media and autonomously create, revise, validate, render, and quality-check deterministic FiveCut video projects. Use when an AI coding agent is asked to edit video from a project directory, organize footage, cut mistakes or silence, synchronize audio, create captions, add intentional transitions/effects/music/graphics, import an AI-chat command package, recover a project safely, or export a finished video through FiveCut.
---

# FiveCut Editor Agent

Use FiveCut's versioned project contract and `fivecut-agent` command line. Keep
all decisions reproducible, all mutations transactional, and all renders logged.

## Start every job

1. Run `fivecut-agent doctor`.
2. Locate `fivecut.project.json`. If it does not exist, run
   `fivecut-agent init . --name "<project name>"`.
3. Run `fivecut-agent scan .` to index video, audio, images, subtitles, and
   fonts. Never guess durations, frame rates, stream layouts, or file names.
4. Read the user's request and `.fivecut/media-index.json`.
5. Inspect existing state with `fivecut-agent inspect fivecut.project.json`.
6. Validate before changing anything:
   `fivecut-agent validate fivecut.project.json --verify-hashes`.

Read [references/project-format.md](references/project-format.md) when creating
or editing project JSON. Read
[references/professional-workflow.md](references/professional-workflow.md)
before making creative selections, captions, audio decisions, or final QC.

## Build the edit

Follow this order:

1. Preserve originals. Reference media; never rewrite source files.
2. Establish the delivery format, canvas, frame rate, target duration, audience,
   platform, and requested style from the prompt and source media.
3. Build a selects pass. Prefer technically usable, relevant, emotionally clear
   material. Record rejection reasons in project metadata.
4. Build the story/rough cut before adding polish.
5. Remove false starts, mistakes, accidental gaps, and silence that harms
   pacing. Preserve intentional pauses and natural breaths.
6. Synchronize external audio by waveform or a known sync point. Never align by
   file start time unless evidence supports it.
7. Mix dialogue first, then music, ambience, and effects. Avoid clipping,
   masking speech, abrupt cuts, and inconsistent loudness.
8. Generate captions from verified speech timing. Correct names, punctuation,
   reading speed, line breaks, and shot-boundary timing.
9. Add transitions, zooms, motion, graphics, color, and sound effects only when
   they support meaning, continuity, rhythm, or emphasis.
10. Configure export explicitly. Do not rely on implicit codec or output
    defaults.

## Mutate safely

Prefer a `fivecut-command-package` over editing an existing project in place.

1. Get the current hash with `fivecut-agent hash fivecut.project.json`.
2. Put that value in `baseProjectSha256`.
3. Give every operation and created object a stable, descriptive ID.
4. Dry-run first:
   `fivecut-agent apply fivecut.project.json edit-package.json --dry-run`.
5. Apply only after the dry-run validates:
   `fivecut-agent apply fivecut.project.json edit-package.json`.
6. Re-run validation and inspection.

The apply command must reject stale hashes, missing required assets, duplicate
IDs, invalid source ranges, out-of-bounds keyframes, incompatible tracks, and
unsupported schema versions. It writes a recoverable history snapshot and a
JSONL audit log before replacing project state.

## Render and verify

1. Run `fivecut-agent render fivecut.project.json --dry-run` and review the
   compatibility report.
2. Resolve every error. Never silently omit an unsupported effect, keyframe,
   missing font, caption, or media file.
3. Render with `fivecut-agent render fivecut.project.json`.
4. Run `fivecut-agent qc fivecut.project.json`.
5. Inspect the QC report for black frames, frozen frames, silence, clipping,
   missing streams, wrong duration/resolution/frame rate, caption overflow, and
   output decode errors.
6. Fix issues and render again. Deliver only after QC passes or clearly report
   a limitation that requires human judgment.

## AI-chat package workflow

When media is uploaded to an AI chat website:

1. Return either a complete `fivecut-project` document or a
   `fivecut-command-package` document.
2. Use schema version `1.0.0` and seconds for every time value.
3. Reference assets by stable IDs and original relative file names.
4. Include SHA-256 values when the chat surface provides file bytes.
5. Include an explicit fixed `project.seed`.
6. Do not embed invented analysis results. Put uncertain decisions in metadata
   notes and use conservative edits.
7. Validate the JSON against the schemas in `packages/editor-api/schemas`.

The same package must produce the same project state in the desktop importer and
the local CLI.

## Non-negotiable rules

- Never modify, delete, move, or overwrite source media.
- Never overwrite a render unless the project or user explicitly enables it.
- Never use an absolute/external asset path unless the user explicitly permits
  external assets.
- Never download an asset without retaining its source and license metadata.
- Never add random effects to make an edit appear busy.
- Never claim professional timing or QC without validating the rendered output.
- Never continue after a compatibility error by dropping the unsupported
  operation.
- Keep intermediate files under `.fivecut/`; keep deliverables under `renders/`.
