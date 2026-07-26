from __future__ import annotations

import json
import mimetypes
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .model import FiveCutError, atomic_write_json, sha256_file

VIDEO_EXTENSIONS = {
    ".3g2",
    ".3gp",
    ".avi",
    ".flv",
    ".m2ts",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp4",
    ".mpeg",
    ".mpg",
    ".mts",
    ".webm",
    ".wmv",
}
AUDIO_EXTENSIONS = {
    ".aac",
    ".aif",
    ".aiff",
    ".flac",
    ".m4a",
    ".mp3",
    ".ogg",
    ".opus",
    ".wav",
    ".wma",
}
IMAGE_EXTENSIONS = {
    ".avif",
    ".bmp",
    ".gif",
    ".heic",
    ".jpeg",
    ".jpg",
    ".png",
    ".svg",
    ".tif",
    ".tiff",
    ".webp",
}
SUBTITLE_EXTENSIONS = {".ass", ".srt", ".ssa", ".vtt"}
FONT_EXTENSIONS = {".otf", ".ttc", ".ttf", ".woff", ".woff2"}
IGNORED_DIRECTORIES = {
    ".fivecut",
    ".git",
    ".next",
    ".tools",
    "node_modules",
    "release",
    "renders",
    "target",
}


def _kind_for_path(path: Path) -> str | None:
    suffix = path.suffix.lower()
    if suffix in VIDEO_EXTENSIONS:
        return "video"
    if suffix in AUDIO_EXTENSIONS:
        return "audio"
    if suffix in IMAGE_EXTENSIONS:
        return "image"
    if suffix in SUBTITLE_EXTENSIONS:
        return "subtitle"
    if suffix in FONT_EXTENSIONS:
        return "font"
    return None


def _parse_rate(raw: str | None) -> float | None:
    if not raw or raw in {"0/0", "N/A"}:
        return None
    if "/" in raw:
        numerator, denominator = raw.split("/", 1)
        try:
            denominator_value = float(denominator)
            if denominator_value == 0:
                return None
            return float(numerator) / denominator_value
        except ValueError:
            return None
    try:
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
            "-of",
            "json",
            str(path),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        return {
            "probeError": completed.stderr.strip() or "ffprobe failed",
            "streams": [],
        }
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {"probeError": "ffprobe returned invalid JSON", "streams": []}
    streams = payload.get("streams") if isinstance(payload.get("streams"), list) else []
    format_info = payload.get("format") if isinstance(payload.get("format"), dict) else {}
    video_stream = next(
        (stream for stream in streams if stream.get("codec_type") == "video"), None
    )
    audio_streams = [
        stream for stream in streams if stream.get("codec_type") == "audio"
    ]
    subtitle_streams = [
        stream for stream in streams if stream.get("codec_type") == "subtitle"
    ]
    duration_raw = format_info.get("duration")
    if duration_raw is None and video_stream:
        duration_raw = video_stream.get("duration")
    try:
        duration = max(0.0, float(duration_raw)) if duration_raw is not None else None
    except (TypeError, ValueError):
        duration = None
    result: dict[str, Any] = {
        "duration": duration,
        "format": format_info.get("format_name"),
        "bitRate": int(format_info["bit_rate"])
        if str(format_info.get("bit_rate", "")).isdigit()
        else None,
        "hasVideo": video_stream is not None,
        "hasAudio": bool(audio_streams),
        "audioStreamCount": len(audio_streams),
        "subtitleStreamCount": len(subtitle_streams),
        "streams": [],
    }
    if video_stream:
        result.update(
            {
                "width": video_stream.get("width"),
                "height": video_stream.get("height"),
                "videoCodec": video_stream.get("codec_name"),
                "pixelFormat": video_stream.get("pix_fmt"),
                "frameRate": _parse_rate(
                    video_stream.get("avg_frame_rate")
                    or video_stream.get("r_frame_rate")
                ),
            }
        )
    if audio_streams:
        first_audio = audio_streams[0]
        result.update(
            {
                "audioCodec": first_audio.get("codec_name"),
                "sampleRate": int(first_audio["sample_rate"])
                if str(first_audio.get("sample_rate", "")).isdigit()
                else None,
                "channels": first_audio.get("channels"),
            }
        )
    for stream in streams:
        result["streams"].append(
            {
                key: stream.get(key)
                for key in (
                    "index",
                    "codec_type",
                    "codec_name",
                    "width",
                    "height",
                    "sample_rate",
                    "channels",
                    "duration",
                )
                if stream.get(key) is not None
            }
        )
    return result


def _slug(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-._")
    return normalized[:72] or "asset"


def scan_directory(
    root: Path,
    *,
    output: Path | None = None,
    include_hashes: bool = True,
) -> dict[str, Any]:
    root = root.resolve()
    if not root.is_dir():
        raise FiveCutError(f"Not a directory: {root}", code="NOT_A_DIRECTORY")
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise FiveCutError(
            "ffprobe is required to scan media. Install FFmpeg first.",
            code="FFPROBE_NOT_FOUND",
        )
    assets: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix().lower()):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if any(part in IGNORED_DIRECTORIES for part in relative.parts):
            continue
        kind = _kind_for_path(path)
        if not kind:
            continue
        digest = sha256_file(path) if include_hashes else None
        asset_id = f"{_slug(path.stem)}-{(digest or sha256_file(path))[:10]}"
        stat = path.stat()
        item: dict[str, Any] = {
            "id": asset_id,
            "kind": kind,
            "path": relative.as_posix(),
            "size": stat.st_size,
            "modifiedAt": datetime.fromtimestamp(
                stat.st_mtime, tz=timezone.utc
            ).isoformat(),
            "mimeType": mimetypes.guess_type(path.name)[0],
        }
        if digest:
            item["sha256"] = digest
        if kind in {"video", "audio"}:
            item.update(_probe(path, ffprobe))
        elif kind == "image" and path.suffix.lower() == ".svg":
            item["format"] = "svg"
        assets.append({key: value for key, value in item.items() if value is not None})
    index = {
        "format": "fivecut-media-index",
        "version": "1.0.0",
        "root": ".",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "assetCount": len(assets),
        "assets": assets,
    }
    target = output or root / ".fivecut" / "media-index.json"
    atomic_write_json(target, index)
    return index


def index_asset_to_project_asset(item: dict[str, Any]) -> dict[str, Any]:
    result = {
        key: item[key]
        for key in (
            "id",
            "kind",
            "path",
            "sha256",
            "duration",
            "width",
            "height",
            "hasAudio",
        )
        if key in item
    }
    return result
