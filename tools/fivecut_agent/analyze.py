from __future__ import annotations

import json
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .model import FiveCutError, atomic_write_json, load_json, project_sha256


def _asset_paths(
    project: dict[str, Any], project_path: Path
) -> list[tuple[dict[str, Any], Path]]:
    result: list[tuple[dict[str, Any], Path]] = []
    for asset in project.get("assets", []):
        if not isinstance(asset, dict) or asset.get("kind") not in {"video", "audio"}:
            continue
        raw_path = Path(str(asset.get("path", "")))
        path = (
            raw_path.resolve()
            if raw_path.is_absolute()
            else (project_path.parent / raw_path).resolve()
        )
        result.append((asset, path))
    return result


def _events(stderr: str) -> dict[str, Any]:
    scene_times = sorted(
        {
            round(float(value), 6)
            for value in re.findall(r"pts_time:([0-9.]+)", stderr)
        }
    )
    silence_starts = [
        float(value) for value in re.findall(r"silence_start:\s*([0-9.]+)", stderr)
    ]
    silence_ends = [
        (float(end), float(duration))
        for end, duration in re.findall(
            r"silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)",
            stderr,
        )
    ]
    silence = []
    for index, start in enumerate(silence_starts):
        if index < len(silence_ends):
            end, duration = silence_ends[index]
            silence.append({"start": start, "end": end, "duration": duration})
        else:
            silence.append({"start": start, "end": None, "duration": None})
    black = [
        {"start": float(start), "end": float(end), "duration": float(duration)}
        for start, end, duration in re.findall(
            r"black_start:([0-9.]+)\s+black_end:([0-9.]+)\s+black_duration:([0-9.]+)",
            stderr,
        )
    ]
    freeze_starts = [
        float(value) for value in re.findall(r"freeze_start:\s*([0-9.]+)", stderr)
    ]
    freeze_ends = [
        (float(end), float(duration))
        for end, duration in re.findall(
            r"freeze_end:\s*([0-9.]+)\s*\|\s*freeze_duration:\s*([0-9.]+)",
            stderr,
        )
    ]
    frozen = []
    for index, start in enumerate(freeze_starts):
        if index < len(freeze_ends):
            end, duration = freeze_ends[index]
            frozen.append({"start": start, "end": end, "duration": duration})
        else:
            frozen.append({"start": start, "end": None, "duration": None})
    integrated = re.findall(r"\bI:\s*(-?inf|-?[0-9.]+)\s*LUFS", stderr)
    loudness_range = re.findall(r"\bLRA:\s*([0-9.]+)\s*LU", stderr)
    true_peak = re.findall(r"\bPeak:\s*(-?inf|-?[0-9.]+)\s*dBFS", stderr)
    return {
        "sceneChanges": scene_times,
        "silence": silence,
        "blackSegments": black,
        "frozenSegments": frozen,
        "integratedLoudnessLufs": integrated[-1] if integrated else None,
        "loudnessRangeLu": loudness_range[-1] if loudness_range else None,
        "truePeakDbfs": true_peak[-1] if true_peak else None,
    }


def _contact_sheet(
    ffmpeg: str,
    path: Path,
    target: Path,
    *,
    duration: float,
    frame_count: int,
) -> str | None:
    if duration <= 0 or frame_count <= 0:
        return None
    columns = 4
    rows = max(1, (frame_count + columns - 1) // columns)
    interval = max(0.1, duration / frame_count)
    target.parent.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-nostdin",
            "-v",
            "error",
            "-i",
            str(path),
            "-vf",
            (
                f"fps=1/{interval:.8f},scale=320:-2,"
                f"tile={columns}x{rows}:nb_frames={frame_count}:padding=4:margin=4"
            ),
            "-frames:v",
            "1",
            "-y",
            str(target),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    return str(target) if completed.returncode == 0 and target.is_file() else None


def analyze_project(
    project_path: Path,
    *,
    asset_ids: set[str] | None = None,
    scene_threshold: float = 0.35,
    thumbnails: int = 12,
    quick: bool = False,
) -> dict[str, Any]:
    project_path = project_path.resolve()
    project = load_json(project_path)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise FiveCutError("FFmpeg is required for analysis.", code="FFMPEG_NOT_FOUND")
    scene_threshold = max(0.05, min(0.95, scene_threshold))
    analyses: list[dict[str, Any]] = []
    for asset, path in _asset_paths(project, project_path):
        asset_id = str(asset.get("id"))
        if asset_ids and asset_id not in asset_ids:
            continue
        if not path.is_file():
            analyses.append(
                {
                    "assetId": asset_id,
                    "path": str(path),
                    "status": "missing",
                    "error": "Asset does not exist.",
                }
            )
            continue
        has_video = asset.get("kind") == "video"
        has_audio = asset.get("kind") == "audio" or bool(asset.get("hasAudio", False))
        command = [
            ffmpeg,
            "-hide_banner",
            "-nostdin",
            "-v",
            "info",
            "-i",
            str(path),
        ]
        if not quick and has_video:
            command.extend(
                [
                    "-vf",
                    (
                        "blackdetect=d=0.25:pix_th=0.10,"
                        "freezedetect=n=-60dB:d=1,"
                        f"select='gt(scene,{scene_threshold:.6f})',showinfo"
                    ),
                ]
            )
        elif has_video:
            command.extend(["-vf", "select='eq(n,0)',showinfo"])
        if not quick and has_audio:
            command.extend(
                [
                    "-af",
                    "silencedetect=n=-42dB:d=0.35,ebur128=peak=true",
                ]
            )
        command.extend(["-f", "null", "-"])
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
        )
        analysis = {
            "assetId": asset_id,
            "path": str(path),
            "status": "analyzed" if completed.returncode == 0 else "failed",
            "duration": asset.get("duration"),
            "width": asset.get("width"),
            "height": asset.get("height"),
            "frameRate": asset.get("frameRate"),
            "hasAudio": has_audio,
            **_events(completed.stderr),
        }
        if completed.returncode != 0:
            analysis["error"] = completed.stderr[-4000:]
        if has_video and thumbnails > 0:
            sheet = (
                project_path.parent
                / ".fivecut"
                / "analysis"
                / "thumbnails"
                / f"{asset_id}.jpg"
            )
            generated = _contact_sheet(
                ffmpeg,
                path,
                sheet,
                duration=float(asset.get("duration", 0) or 0),
                frame_count=min(40, thumbnails),
            )
            analysis["contactSheet"] = (
                str(Path(generated).relative_to(project_path.parent))
                if generated
                else None
            )
        analyses.append(analysis)
    requested_missing = sorted(
        (asset_ids or set()) - {str(item.get("assetId")) for item in analyses}
    )
    if requested_missing:
        raise FiveCutError(
            f"Unknown or non-audiovisual asset IDs: {', '.join(requested_missing)}",
            code="UNKNOWN_ASSET",
        )
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    report = {
        "format": "fivecut-analysis-report",
        "version": "1.0.0",
        "timestamp": timestamp,
        "projectPath": str(project_path),
        "projectSha256": project_sha256(project_path),
        "quick": quick,
        "sceneThreshold": scene_threshold,
        "assetCount": len(analyses),
        "failedCount": sum(item["status"] != "analyzed" for item in analyses),
        "assets": analyses,
        "guidance": [
            "Scene and silence detections are evidence, not automatic creative decisions.",
            "Review contact sheets and preserve intentional pauses before making cuts.",
            "Verify dialogue and proper names before creating captions.",
        ],
    }
    target = (
        project_path.parent
        / ".fivecut"
        / "analysis"
        / f"analysis-{timestamp}.json"
    )
    atomic_write_json(target, report)
    atomic_write_json(
        project_path.parent / ".fivecut" / "analysis" / "latest.json", report
    )
    report["reportPath"] = str(target)
    return report
