from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .model import FiveCutError, atomic_write_json, load_json, project_sha256
from .render import _number, _timeline_duration


def _parse_rate(raw: Any) -> float | None:
    if not isinstance(raw, str) or raw in {"", "0/0", "N/A"}:
        return None
    try:
        if "/" in raw:
            numerator, denominator = raw.split("/", 1)
            denominator_value = float(denominator)
            return float(numerator) / denominator_value if denominator_value else None
        return float(raw)
    except ValueError:
        return None


def _probe(path: Path, ffprobe: str) -> dict[str, Any]:
    completed = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-count_frames",
            "-of",
            "json",
            str(path),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise FiveCutError(
            completed.stderr.strip() or "ffprobe failed.",
            code="QC_PROBE_FAILED",
        )
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise FiveCutError("ffprobe returned invalid JSON.", code="QC_PROBE_FAILED") from error
    if not isinstance(value, dict):
        raise FiveCutError("ffprobe returned an invalid root.", code="QC_PROBE_FAILED")
    return value


def _extract_events(stderr: str) -> dict[str, Any]:
    black_segments = [
        {
            "start": float(start),
            "end": float(end),
            "duration": float(duration),
        }
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
    frozen_segments = []
    for index, start in enumerate(freeze_starts):
        if index < len(freeze_ends):
            end, duration = freeze_ends[index]
            frozen_segments.append(
                {"start": start, "end": end, "duration": duration}
            )
        else:
            frozen_segments.append({"start": start, "end": None, "duration": None})
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
    silent_segments = []
    for index, start in enumerate(silence_starts):
        if index < len(silence_ends):
            end, duration = silence_ends[index]
            silent_segments.append(
                {"start": start, "end": end, "duration": duration}
            )
        else:
            silent_segments.append({"start": start, "end": None, "duration": None})
    mean_volume = re.findall(r"mean_volume:\s*(-?inf|-?[0-9.]+)\s*dB", stderr)
    max_volume = re.findall(r"max_volume:\s*(-?inf|-?[0-9.]+)\s*dB", stderr)
    return {
        "blackSegments": black_segments,
        "frozenSegments": frozen_segments,
        "silentSegments": silent_segments,
        "meanVolumeDb": mean_volume[-1] if mean_volume else None,
        "maxVolumeDb": max_volume[-1] if max_volume else None,
    }


def qc_project(
    project_path: Path,
    *,
    output_override: Path | None = None,
    quick: bool = False,
) -> dict[str, Any]:
    project_path = project_path.resolve()
    project = load_json(project_path)
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        raise FiveCutError(
            "FFmpeg and ffprobe are required for quality control.",
            code="FFMPEG_NOT_FOUND",
        )
    raw_output = output_override or Path(str(project.get("export", {}).get("output", "")))
    output = (
        raw_output.resolve()
        if raw_output.is_absolute()
        else (project_path.parent / raw_output).resolve()
    )
    if not output.is_file():
        raise FiveCutError(f"Rendered output not found: {output}", code="OUTPUT_NOT_FOUND")

    probe = _probe(output, ffprobe)
    streams = probe.get("streams", [])
    format_info = probe.get("format", {})
    video_stream = next(
        (
            stream
            for stream in streams
            if isinstance(stream, dict) and stream.get("codec_type") == "video"
        ),
        None,
    )
    audio_stream = next(
        (
            stream
            for stream in streams
            if isinstance(stream, dict) and stream.get("codec_type") == "audio"
        ),
        None,
    )
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    issues: list[dict[str, str]] = []

    def issue(level: str, code: str, message: str) -> None:
        issues.append({"level": level, "code": code, "message": message})

    if not video_stream:
        issue("error", "MISSING_VIDEO_STREAM", "The output has no video stream.")
    if not audio_stream:
        issue("error", "MISSING_AUDIO_STREAM", "The output has no audio stream.")

    canvas = project.get("project", {}).get("canvas", {})
    expected_width = canvas.get("width")
    expected_height = canvas.get("height")
    expected_fps = (
        _number(canvas.get("fps", {}).get("numerator"), 30)
        / _number(canvas.get("fps", {}).get("denominator"), 1)
    )
    if video_stream:
        if (
            video_stream.get("width") != expected_width
            or video_stream.get("height") != expected_height
        ):
            issue(
                "error",
                "WRONG_RESOLUTION",
                f"Expected {expected_width}x{expected_height}, got "
                f"{video_stream.get('width')}x{video_stream.get('height')}.",
            )
        actual_fps = _parse_rate(
            video_stream.get("avg_frame_rate") or video_stream.get("r_frame_rate")
        )
        if actual_fps is None or abs(actual_fps - expected_fps) > 0.01:
            issue(
                "error",
                "WRONG_FRAME_RATE",
                f"Expected {expected_fps:.6f} fps, got {actual_fps}.",
            )

    expected_duration = _timeline_duration(project)
    export = project.get("export", {})
    export_start = _number(export.get("start"), 0)
    expected_duration = _number(
        export.get("duration"), max(0, expected_duration - export_start)
    )
    try:
        actual_duration = float(format_info.get("duration"))
    except (TypeError, ValueError):
        actual_duration = None
    tolerance = max(0.15, 2 / max(expected_fps, 1))
    if actual_duration is None:
        issue("error", "MISSING_DURATION", "The output duration could not be read.")
    elif abs(actual_duration - expected_duration) > tolerance:
        issue(
            "error",
            "WRONG_DURATION",
            f"Expected {expected_duration:.3f}s, got {actual_duration:.3f}s.",
        )

    analysis: dict[str, Any] = {
        "blackSegments": [],
        "frozenSegments": [],
        "silentSegments": [],
        "meanVolumeDb": None,
        "maxVolumeDb": None,
    }
    decode_command = [
        ffmpeg,
        "-hide_banner",
        "-nostdin",
        "-v",
        "info" if not quick else "error",
        "-i",
        str(output),
    ]
    if not quick:
        decode_command.extend(
            [
                "-vf",
                "blackdetect=d=0.5:pix_th=0.10,freezedetect=n=-60dB:d=2",
                "-af",
                "silencedetect=n=-50dB:d=2,volumedetect",
            ]
        )
    decode_command.extend(["-f", "null", "-"])
    decoded = subprocess.run(
        decode_command,
        check=False,
        capture_output=True,
        text=True,
    )
    if decoded.returncode != 0:
        issue(
            "error",
            "DECODE_FAILED",
            f"Full output decode failed with exit code {decoded.returncode}.",
        )
    if not quick:
        analysis = _extract_events(decoded.stderr)
        if analysis["blackSegments"]:
            issue(
                "warning",
                "BLACK_SEGMENTS",
                f"Detected {len(analysis['blackSegments'])} black segment(s) of 0.5s or longer.",
            )
        if analysis["frozenSegments"]:
            issue(
                "warning",
                "FROZEN_SEGMENTS",
                f"Detected {len(analysis['frozenSegments'])} frozen segment(s) of 2s or longer.",
            )
        if analysis["silentSegments"]:
            issue(
                "warning",
                "SILENT_SEGMENTS",
                f"Detected {len(analysis['silentSegments'])} silent segment(s) of 2s or longer.",
            )
        maximum = analysis.get("maxVolumeDb")
        if maximum not in {None, "-inf"}:
            try:
                if float(maximum) >= 0:
                    issue(
                        "warning",
                        "AUDIO_AT_CEILING",
                        f"Maximum sample level is {maximum} dB; inspect for clipping.",
                    )
            except ValueError:
                pass

    error_count = sum(item["level"] == "error" for item in issues)
    warning_count = sum(item["level"] == "warning" for item in issues)
    report = {
        "format": "fivecut-qc-report",
        "version": "1.0.0",
        "timestamp": timestamp,
        "status": "passed" if error_count == 0 else "failed",
        "projectPath": str(project_path),
        "projectSha256": project_sha256(project_path),
        "output": str(output),
        "outputBytes": output.stat().st_size,
        "quick": quick,
        "expected": {
            "width": expected_width,
            "height": expected_height,
            "fps": expected_fps,
            "duration": expected_duration,
        },
        "actual": {
            "width": video_stream.get("width") if video_stream else None,
            "height": video_stream.get("height") if video_stream else None,
            "fps": (
                _parse_rate(
                    video_stream.get("avg_frame_rate")
                    or video_stream.get("r_frame_rate")
                )
                if video_stream
                else None
            ),
            "duration": actual_duration,
            "videoCodec": video_stream.get("codec_name") if video_stream else None,
            "audioCodec": audio_stream.get("codec_name") if audio_stream else None,
            "audioSampleRate": (
                int(audio_stream["sample_rate"])
                if audio_stream and str(audio_stream.get("sample_rate", "")).isdigit()
                else None
            ),
        },
        "analysis": analysis,
        "errorCount": error_count,
        "warningCount": warning_count,
        "issues": issues,
        "decodeStderr": decoded.stderr[-40_000:] if decoded.returncode else "",
    }
    report_path = (
        project_path.parent / ".fivecut" / "reports" / f"qc-{timestamp}.json"
    )
    atomic_write_json(report_path, report)
    report["reportPath"] = str(report_path)
    return report
