from __future__ import annotations

import argparse
import json
import platform
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path
from typing import Any

from . import __version__
from .analyze import analyze_project
from .model import (
    FiveCutError,
    atomic_write_json,
    errors,
    issue_report,
    load_json,
    project_sha256,
    validate_command_package,
    validate_project,
)
from .operations import apply_package, list_history, restore_history
from .qc import qc_project
from .render import render_project
from .scanner import index_asset_to_project_asset, scan_directory


def _print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def _slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-._").lower()
    return slug[:72] or "untitled"


def _command_output(command: list[str]) -> tuple[int, str]:
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
    )
    return completed.returncode, (completed.stdout or completed.stderr).strip()


def doctor() -> dict[str, Any]:
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    checks: list[dict[str, Any]] = []
    checks.append(
        {
            "name": "python",
            "status": "pass" if sys.version_info >= (3, 11) else "fail",
            "version": platform.python_version(),
            "required": ">=3.11",
        }
    )
    encoder_names = [
        "libx264",
        "libx265",
        "libvpx-vp9",
        "prores_ks",
        "aac",
        "libopus",
        "pcm_s24le",
    ]
    filter_names = [
        "overlay",
        "drawtext",
        "drawbox",
        "amix",
        "loudnorm",
        "blackdetect",
        "freezedetect",
        "silencedetect",
    ]
    ffmpeg_version = None
    available_encoders: list[str] = []
    available_filters: list[str] = []
    if ffmpeg:
        _, version_output = _command_output([ffmpeg, "-version"])
        ffmpeg_version = version_output.splitlines()[0] if version_output else None
        _, encoder_output = _command_output([ffmpeg, "-hide_banner", "-encoders"])
        _, filter_output = _command_output([ffmpeg, "-hide_banner", "-filters"])
        available_encoders = [
            name for name in encoder_names if re.search(rf"\b{re.escape(name)}\b", encoder_output)
        ]
        available_filters = [
            name for name in filter_names if re.search(rf"\b{re.escape(name)}\b", filter_output)
        ]
    checks.extend(
        [
            {
                "name": "ffmpeg",
                "status": "pass" if ffmpeg else "fail",
                "path": ffmpeg,
                "version": ffmpeg_version,
            },
            {
                "name": "ffprobe",
                "status": "pass" if ffprobe else "fail",
                "path": ffprobe,
            },
            {
                "name": "render-filters",
                "status": "pass"
                if set(filter_names).issubset(available_filters)
                else "fail",
                "available": available_filters,
                "missing": sorted(set(filter_names) - set(available_filters)),
            },
            {
                "name": "export-encoders",
                "status": "pass"
                if {"libx264", "aac"}.issubset(available_encoders)
                else "fail",
                "available": available_encoders,
                "missingOptional": sorted(set(encoder_names) - set(available_encoders)),
            },
        ]
    )
    required_names = {"python", "ffmpeg", "ffprobe", "render-filters", "export-encoders"}
    ready = all(
        check["status"] == "pass"
        for check in checks
        if check["name"] in required_names
    )
    return {
        "format": "fivecut-doctor-report",
        "version": "1.0.0",
        "fivecutAgentVersion": __version__,
        "ready": ready,
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "checks": checks,
    }


def _init_project(
    directory: Path,
    *,
    name: str,
    project_file: str,
    width: int | None,
    height: int | None,
    fps: float | None,
    auto_sequence: bool,
    force: bool,
) -> dict[str, Any]:
    root = directory.resolve()
    if not root.is_dir():
        raise FiveCutError(f"Not a directory: {root}", code="NOT_A_DIRECTORY")
    project_path = (root / project_file).resolve()
    if not project_path.is_relative_to(root):
        raise FiveCutError(
            "The project file must stay inside the project directory.",
            code="PROJECT_OUTSIDE_DIRECTORY",
        )
    if project_path.exists() and not force:
        raise FiveCutError(
            f"Project already exists: {project_path}",
            code="PROJECT_EXISTS",
        )
    index = scan_directory(root)
    project_assets = [
        index_asset_to_project_asset(asset) for asset in index.get("assets", [])
    ]
    first_video = next(
        (
            asset
            for asset in index.get("assets", [])
            if asset.get("kind") == "video" and asset.get("width") and asset.get("height")
        ),
        None,
    )
    canvas_width = width or int(first_video.get("width", 1920) if first_video else 1920)
    canvas_height = height or int(
        first_video.get("height", 1080) if first_video else 1080
    )
    detected_fps = fps or (
        float(first_video.get("frameRate", 30)) if first_video else 30.0
    )
    detected_fps = max(1, min(240, detected_fps))
    rate = Fraction(detected_fps).limit_denominator(1001)
    now = datetime.now(timezone.utc).isoformat()
    project_slug = _slug(name)
    tracks: list[dict[str, Any]] = [
        {"id": "track:video-main", "kind": "video", "name": "Main Video", "clips": []},
        {"id": "track:graphics", "kind": "graphic", "name": "Graphics", "clips": []},
        {"id": "track:captions", "kind": "caption", "name": "Captions", "clips": []},
        {"id": "track:music", "kind": "audio", "name": "Music and SFX", "clips": []},
    ]
    if auto_sequence:
        cursor = 0.0
        for asset in index.get("assets", []):
            if asset.get("kind") != "video" or not asset.get("duration"):
                continue
            duration = float(asset["duration"])
            tracks[0]["clips"].append(
                {
                    "id": f"clip:{asset['id']}",
                    "type": "media",
                    "name": Path(str(asset["path"])).stem,
                    "assetId": asset["id"],
                    "start": cursor,
                    "duration": duration,
                    "sourceIn": 0,
                    "sourceDuration": duration,
                    "speed": 1,
                    "includeSourceAudio": bool(asset.get("hasAudio", False)),
                    "transform": {
                        "positionX": 0,
                        "positionY": 0,
                        "scaleX": 1,
                        "scaleY": 1,
                        "rotation": 0,
                    },
                    "effects": [],
                    "keyframes": [],
                }
            )
            cursor += duration
    project = {
        "$schema": "packages/editor-api/schemas/fivecut-project.schema.json",
        "format": "fivecut-project",
        "version": "1.0.0",
        "compatibility": {
            "minimumAppVersion": "0.1.0",
            "requiredCapabilities": ["ffmpeg-render-v1"],
        },
        "project": {
            "id": f"project:{project_slug}",
            "name": name,
            "description": "",
            "intent": "",
            "seed": 42,
            "canvas": {
                "width": canvas_width,
                "height": canvas_height,
                "fps": {
                    "numerator": rate.numerator,
                    "denominator": rate.denominator,
                },
                "sampleRate": 48000,
            },
            "background": {"color": "#111111"},
            "createdAt": now,
            "updatedAt": now,
            "generator": f"fivecut-agent/{__version__}",
        },
        "assets": project_assets,
        "tracks": tracks,
        "markers": [],
        "export": {
            "output": f"renders/{project_slug}.mp4",
            "container": "mp4",
            "videoCodec": "h264",
            "audioCodec": "aac",
            "quality": "high",
            "pixelFormat": "yuv420p",
            "audioBitrate": "192k",
            "loudnessTargetLufs": -14,
            "overwrite": False,
            "metadata": {"title": name, "encoder": f"FiveCut {__version__}"},
        },
        "metadata": {
            "request": "",
            "notes": [
                "Source files were indexed without modification.",
                "Review technical metadata and creative intent before editing.",
            ],
            "attributions": [],
        },
    }
    issues = validate_project(
        project,
        project_path=project_path,
        check_files=True,
        verify_hashes=True,
    )
    if errors(issues):
        raise FiveCutError(
            json.dumps(issue_report(issues), indent=2), code="INIT_VALIDATION_FAILED"
        )
    atomic_write_json(project_path, project)
    return {
        "format": "fivecut-init-report",
        "version": "1.0.0",
        "status": "created",
        "projectPath": str(project_path),
        "projectSha256": project_sha256(project_path),
        "assetCount": len(project_assets),
        "autoSequencedClipCount": len(tracks[0]["clips"]),
        "canvas": project["project"]["canvas"],
    }


def inspect_project(project_path: Path, *, verify_hashes: bool) -> dict[str, Any]:
    project_path = project_path.resolve()
    project = load_json(project_path)
    validation = validate_project(
        project,
        project_path=project_path,
        check_files=True,
        verify_hashes=verify_hashes,
    )
    asset_by_id = {
        asset["id"]: asset
        for asset in project.get("assets", [])
        if isinstance(asset, dict) and isinstance(asset.get("id"), str)
    }
    referenced_assets: set[str] = set()
    track_reports: list[dict[str, Any]] = []
    timeline_end = 0.0
    for track in project.get("tracks", []):
        if not isinstance(track, dict):
            continue
        clips = sorted(
            (clip for clip in track.get("clips", []) if isinstance(clip, dict)),
            key=lambda clip: (float(clip.get("start", 0)), str(clip.get("id", ""))),
        )
        gaps: list[dict[str, float]] = []
        overlaps: list[dict[str, Any]] = []
        cursor = 0.0
        previous_id: str | None = None
        for clip in clips:
            start = float(clip.get("start", 0))
            end = start + float(clip.get("duration", 0))
            if start > cursor + 0.000001:
                gaps.append({"start": cursor, "duration": start - cursor})
            elif start < cursor - 0.000001:
                overlaps.append(
                    {
                        "firstClipId": previous_id,
                        "secondClipId": clip.get("id"),
                        "duration": cursor - start,
                    }
                )
            cursor = max(cursor, end)
            previous_id = str(clip.get("id", ""))
            if isinstance(clip.get("assetId"), str):
                referenced_assets.add(clip["assetId"])
        timeline_end = max(timeline_end, cursor)
        track_reports.append(
            {
                "id": track.get("id"),
                "name": track.get("name"),
                "kind": track.get("kind"),
                "clipCount": len(clips),
                "duration": cursor,
                "muted": bool(track.get("muted", False)),
                "hidden": bool(track.get("hidden", False)),
                "locked": bool(track.get("locked", False)),
                "gaps": gaps,
                "overlaps": overlaps,
            }
        )
    assets_by_kind: dict[str, int] = {}
    for asset in asset_by_id.values():
        kind = str(asset.get("kind"))
        assets_by_kind[kind] = assets_by_kind.get(kind, 0) + 1
    return {
        "format": "fivecut-inspection-report",
        "version": "1.0.0",
        "projectPath": str(project_path),
        "projectSha256": project_sha256(project_path),
        "name": project.get("project", {}).get("name"),
        "intent": project.get("project", {}).get("intent"),
        "canvas": project.get("project", {}).get("canvas"),
        "timelineDuration": timeline_end,
        "assetCount": len(asset_by_id),
        "assetsByKind": assets_by_kind,
        "referencedAssetCount": len(referenced_assets),
        "unreferencedAssets": sorted(set(asset_by_id) - referenced_assets),
        "tracks": track_reports,
        "export": project.get("export"),
        "validation": issue_report(validation),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fivecut-agent",
        description="Deterministic local editing API for FiveCut.",
    )
    parser.add_argument("--version", action="version", version=__version__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("doctor", help="Check local editing and export dependencies.")

    init_parser = subparsers.add_parser("init", help="Create a project and media index.")
    init_parser.add_argument("directory", nargs="?", default=".")
    init_parser.add_argument("--name", required=True)
    init_parser.add_argument("--project-file", default="fivecut.project.json")
    init_parser.add_argument("--width", type=int)
    init_parser.add_argument("--height", type=int)
    init_parser.add_argument("--fps", type=float)
    init_parser.add_argument("--auto-sequence", action="store_true")
    init_parser.add_argument("--force", action="store_true")

    scan_parser = subparsers.add_parser("scan", help="Index project media.")
    scan_parser.add_argument("directory", nargs="?", default=".")
    scan_parser.add_argument("--output", type=Path)
    scan_parser.add_argument("--no-hashes", action="store_true")

    inspect_parser = subparsers.add_parser("inspect", help="Summarize project state.")
    inspect_parser.add_argument("project", type=Path)
    inspect_parser.add_argument("--verify-hashes", action="store_true")

    analyze_parser = subparsers.add_parser(
        "analyze", help="Detect scenes, silence, freezes, black frames, and loudness."
    )
    analyze_parser.add_argument("project", type=Path)
    analyze_parser.add_argument("--asset", action="append", dest="assets")
    analyze_parser.add_argument("--scene-threshold", type=float, default=0.35)
    analyze_parser.add_argument("--thumbnails", type=int, default=12)
    analyze_parser.add_argument("--quick", action="store_true")

    validate_parser = subparsers.add_parser("validate", help="Validate project JSON.")
    validate_parser.add_argument("document", type=Path)
    validate_parser.add_argument(
        "--kind", choices=["auto", "project", "commands"], default="auto"
    )
    validate_parser.add_argument("--verify-hashes", action="store_true")
    validate_parser.add_argument("--no-file-check", action="store_true")
    validate_parser.add_argument("--allow-external-assets", action="store_true")

    hash_parser = subparsers.add_parser("hash", help="Hash a project document.")
    hash_parser.add_argument("project", type=Path)

    apply_parser = subparsers.add_parser(
        "apply", help="Transactionally apply an AI command package."
    )
    apply_parser.add_argument("project", type=Path)
    apply_parser.add_argument("package", type=Path)
    apply_parser.add_argument("--dry-run", action="store_true")
    apply_parser.add_argument("--allow-external-assets", action="store_true")

    history_parser = subparsers.add_parser("history", help="List undo snapshots.")
    history_parser.add_argument("project", type=Path)

    restore_parser = subparsers.add_parser(
        "restore", help="Restore an undo snapshot safely."
    )
    restore_parser.add_argument("project", type=Path)
    restore_parser.add_argument("snapshot", type=Path)
    restore_parser.add_argument("--expected-current-sha256")
    restore_parser.add_argument("--dry-run", action="store_true")

    render_parser = subparsers.add_parser("render", help="Render with FFmpeg.")
    render_parser.add_argument("project", type=Path)
    render_parser.add_argument("--output", type=Path)
    render_parser.add_argument("--dry-run", action="store_true")
    render_parser.add_argument("--overwrite", action="store_true")
    render_parser.add_argument("--allow-external-assets", action="store_true")

    qc_parser = subparsers.add_parser("qc", help="Decode and inspect a rendered output.")
    qc_parser.add_argument("project", type=Path)
    qc_parser.add_argument("--output", type=Path)
    qc_parser.add_argument("--quick", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == "doctor":
            report = doctor()
            _print_json(report)
            return 0 if report["ready"] else 2
        if arguments.command == "init":
            report = _init_project(
                Path(arguments.directory),
                name=arguments.name,
                project_file=arguments.project_file,
                width=arguments.width,
                height=arguments.height,
                fps=arguments.fps,
                auto_sequence=arguments.auto_sequence,
                force=arguments.force,
            )
        elif arguments.command == "scan":
            report = scan_directory(
                Path(arguments.directory),
                output=arguments.output,
                include_hashes=not arguments.no_hashes,
            )
        elif arguments.command == "inspect":
            report = inspect_project(
                arguments.project, verify_hashes=arguments.verify_hashes
            )
        elif arguments.command == "analyze":
            report = analyze_project(
                arguments.project,
                asset_ids=set(arguments.assets) if arguments.assets else None,
                scene_threshold=arguments.scene_threshold,
                thumbnails=arguments.thumbnails,
                quick=arguments.quick,
            )
        elif arguments.command == "validate":
            document = load_json(arguments.document)
            kind = arguments.kind
            if kind == "auto":
                kind = (
                    "commands"
                    if document.get("format") == "fivecut-command-package"
                    else "project"
                )
            issues = (
                validate_command_package(document)
                if kind == "commands"
                else validate_project(
                    document,
                    project_path=arguments.document.resolve(),
                    check_files=not arguments.no_file_check,
                    verify_hashes=arguments.verify_hashes,
                    allow_external_assets=arguments.allow_external_assets,
                )
            )
            report = issue_report(issues)
            report.update(
                {
                    "format": "fivecut-validation-report",
                    "version": "1.0.0",
                    "document": str(arguments.document.resolve()),
                    "documentKind": kind,
                }
            )
            _print_json(report)
            return 0 if report["valid"] else 2
        elif arguments.command == "hash":
            report = {
                "format": "fivecut-hash-report",
                "version": "1.0.0",
                "projectPath": str(arguments.project.resolve()),
                "sha256": project_sha256(arguments.project),
            }
        elif arguments.command == "apply":
            report = apply_package(
                arguments.project,
                arguments.package,
                dry_run=arguments.dry_run,
                allow_external_assets=arguments.allow_external_assets,
            )
        elif arguments.command == "history":
            report = list_history(arguments.project)
        elif arguments.command == "restore":
            report = restore_history(
                arguments.project,
                arguments.snapshot,
                expected_current_sha256=arguments.expected_current_sha256,
                dry_run=arguments.dry_run,
            )
        elif arguments.command == "render":
            report = render_project(
                arguments.project,
                output_override=arguments.output,
                dry_run=arguments.dry_run,
                overwrite=arguments.overwrite,
                allow_external_assets=arguments.allow_external_assets,
            )
        elif arguments.command == "qc":
            report = qc_project(
                arguments.project,
                output_override=arguments.output,
                quick=arguments.quick,
            )
        else:
            parser.error("Unknown command.")
            return 2
        _print_json(report)
        return 0
    except FiveCutError as error:
        print(
            json.dumps(
                {
                    "format": "fivecut-error",
                    "version": "1.0.0",
                    "status": "error",
                    "code": error.code,
                    "message": str(error),
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1
    except KeyboardInterrupt:
        print(
            '{"format":"fivecut-error","version":"1.0.0",'
            '"status":"error","code":"INTERRUPTED","message":"Interrupted."}',
            file=sys.stderr,
        )
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
