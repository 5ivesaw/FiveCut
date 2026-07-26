from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

PROJECT_FORMAT = "fivecut-project"
PROJECT_VERSION = "1.0.0"
COMMAND_FORMAT = "fivecut-command-package"
COMMAND_VERSION = "1.0.0"
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
HEX_COLOR_PATTERN = re.compile(r"^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")


@dataclass(frozen=True)
class ValidationIssue:
    level: str
    code: str
    path: str
    message: str

    def as_dict(self) -> dict[str, str]:
        return {
            "level": self.level,
            "code": self.code,
            "path": self.path,
            "message": self.message,
        }


class FiveCutError(RuntimeError):
    def __init__(self, message: str, *, code: str = "FIVECUT_ERROR") -> None:
        super().__init__(message)
        self.code = code


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise FiveCutError(f"File not found: {path}", code="FILE_NOT_FOUND") from error
    except json.JSONDecodeError as error:
        raise FiveCutError(
            f"Invalid JSON at line {error.lineno}, column {error.colno}: {error.msg}",
            code="INVALID_JSON",
        ) from error
    if not isinstance(value, dict):
        raise FiveCutError("The JSON root must be an object", code="INVALID_ROOT")
    return value


def canonical_json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def project_sha256(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def atomic_write_json(path: Path, value: Any) -> None:
    atomic_write_bytes(path, canonical_json_bytes(value))


def atomic_write_bytes(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _issue(
    issues: list[ValidationIssue],
    level: str,
    code: str,
    path: str,
    message: str,
) -> None:
    issues.append(ValidationIssue(level, code, path, message))


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _require_id(
    value: Any, path: str, issues: list[ValidationIssue]
) -> str | None:
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        _issue(
            issues,
            "error",
            "INVALID_ID",
            path,
            "Expected 1-128 characters using letters, digits, '.', '_', ':', or '-'.",
        )
        return None
    return value


def _require_number(
    value: Any,
    path: str,
    issues: list[ValidationIssue],
    *,
    minimum: float | None = None,
    exclusive_minimum: float | None = None,
) -> float | None:
    if not _is_number(value):
        _issue(issues, "error", "INVALID_NUMBER", path, "Expected a finite number.")
        return None
    number = float(value)
    if minimum is not None and number < minimum:
        _issue(
            issues,
            "error",
            "NUMBER_TOO_SMALL",
            path,
            f"Expected a value greater than or equal to {minimum}.",
        )
    if exclusive_minimum is not None and number <= exclusive_minimum:
        _issue(
            issues,
            "error",
            "NUMBER_TOO_SMALL",
            path,
            f"Expected a value greater than {exclusive_minimum}.",
        )
    return number


def _resolve_project_path(
    project_path: Path,
    raw_path: Any,
    issue_path: str,
    issues: list[ValidationIssue],
    *,
    allow_external_assets: bool,
) -> Path | None:
    if not isinstance(raw_path, str) or not raw_path.strip():
        _issue(issues, "error", "INVALID_PATH", issue_path, "Expected a non-empty path.")
        return None
    candidate = Path(raw_path)
    root = project_path.parent.resolve()
    resolved = candidate.resolve() if candidate.is_absolute() else (root / candidate).resolve()
    if not allow_external_assets and not resolved.is_relative_to(root):
        _issue(
            issues,
            "error",
            "PATH_OUTSIDE_PROJECT",
            issue_path,
            "External paths are disabled; copy the asset into the project directory.",
        )
        return None
    return resolved


def validate_project(
    data: dict[str, Any],
    *,
    project_path: Path,
    check_files: bool = True,
    verify_hashes: bool = False,
    allow_external_assets: bool = False,
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    if data.get("format") != PROJECT_FORMAT:
        _issue(
            issues,
            "error",
            "UNSUPPORTED_FORMAT",
            "$.format",
            f"Expected '{PROJECT_FORMAT}'.",
        )
    if data.get("version") != PROJECT_VERSION:
        _issue(
            issues,
            "error",
            "UNSUPPORTED_VERSION",
            "$.version",
            f"Expected version '{PROJECT_VERSION}'.",
        )

    project = data.get("project")
    if not isinstance(project, dict):
        _issue(issues, "error", "MISSING_PROJECT", "$.project", "Expected an object.")
        project = {}
    _require_id(project.get("id"), "$.project.id", issues)
    if not isinstance(project.get("name"), str) or not project.get("name", "").strip():
        _issue(
            issues, "error", "INVALID_NAME", "$.project.name", "Expected a non-empty name."
        )
    seed = project.get("seed")
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= 4_294_967_295:
        _issue(
            issues,
            "error",
            "INVALID_SEED",
            "$.project.seed",
            "Expected an integer from 0 through 4294967295.",
        )
    canvas = project.get("canvas")
    if not isinstance(canvas, dict):
        _issue(issues, "error", "INVALID_CANVAS", "$.project.canvas", "Expected an object.")
        canvas = {}
    width = canvas.get("width")
    height = canvas.get("height")
    if not isinstance(width, int) or isinstance(width, bool) or not 16 <= width <= 16_384:
        _issue(
            issues,
            "error",
            "INVALID_CANVAS_WIDTH",
            "$.project.canvas.width",
            "Expected an integer from 16 through 16384.",
        )
    if not isinstance(height, int) or isinstance(height, bool) or not 16 <= height <= 16_384:
        _issue(
            issues,
            "error",
            "INVALID_CANVAS_HEIGHT",
            "$.project.canvas.height",
            "Expected an integer from 16 through 16384.",
        )
    fps = canvas.get("fps")
    if not isinstance(fps, dict):
        _issue(
            issues, "error", "INVALID_FPS", "$.project.canvas.fps", "Expected an object."
        )
    else:
        for field in ("numerator", "denominator"):
            value = fps.get(field)
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                _issue(
                    issues,
                    "error",
                    "INVALID_FPS",
                    f"$.project.canvas.fps.{field}",
                    "Expected a positive integer.",
                )
    background = project.get("background")
    if not isinstance(background, dict) or not HEX_COLOR_PATTERN.fullmatch(
        str(background.get("color", ""))
    ):
        _issue(
            issues,
            "error",
            "INVALID_BACKGROUND",
            "$.project.background.color",
            "Expected #RRGGBB or #RRGGBBAA.",
        )

    assets = data.get("assets")
    if not isinstance(assets, list):
        _issue(issues, "error", "INVALID_ASSETS", "$.assets", "Expected an array.")
        assets = []
    asset_by_id: dict[str, dict[str, Any]] = {}
    resolved_asset_paths: dict[str, Path] = {}
    all_ids: dict[str, str] = {}
    for index, asset in enumerate(assets):
        path = f"$.assets[{index}]"
        if not isinstance(asset, dict):
            _issue(issues, "error", "INVALID_ASSET", path, "Expected an object.")
            continue
        asset_id = _require_id(asset.get("id"), f"{path}.id", issues)
        if asset_id:
            if asset_id in all_ids:
                _issue(
                    issues,
                    "error",
                    "DUPLICATE_ID",
                    f"{path}.id",
                    f"'{asset_id}' already exists at {all_ids[asset_id]}.",
                )
            all_ids[asset_id] = f"{path}.id"
            asset_by_id[asset_id] = asset
        if asset.get("kind") not in {
            "video",
            "audio",
            "image",
            "subtitle",
            "font",
            "other",
        }:
            _issue(
                issues,
                "error",
                "INVALID_ASSET_KIND",
                f"{path}.kind",
                "Unsupported asset kind.",
            )
        resolved = _resolve_project_path(
            project_path,
            asset.get("path"),
            f"{path}.path",
            issues,
            allow_external_assets=allow_external_assets,
        )
        if asset_id and resolved:
            resolved_asset_paths[asset_id] = resolved
        if check_files and resolved and not resolved.is_file():
            level = "warning" if asset.get("optional") is True else "error"
            _issue(
                issues,
                level,
                "MISSING_OPTIONAL_ASSET" if level == "warning" else "MISSING_ASSET",
                f"{path}.path",
                f"Asset does not exist: {resolved}",
            )
        expected_hash = asset.get("sha256")
        if expected_hash is not None and (
            not isinstance(expected_hash, str)
            or not re.fullmatch(r"[0-9a-f]{64}", expected_hash)
        ):
            _issue(
                issues,
                "error",
                "INVALID_SHA256",
                f"{path}.sha256",
                "Expected a lowercase SHA-256 digest.",
            )
        elif verify_hashes and expected_hash and resolved and resolved.is_file():
            actual_hash = sha256_file(resolved)
            if actual_hash != expected_hash:
                _issue(
                    issues,
                    "error",
                    "ASSET_HASH_MISMATCH",
                    f"{path}.sha256",
                    f"Expected {expected_hash}, got {actual_hash}.",
                )

    tracks = data.get("tracks")
    if not isinstance(tracks, list):
        _issue(issues, "error", "INVALID_TRACKS", "$.tracks", "Expected an array.")
        tracks = []
    for track_index, track in enumerate(tracks):
        track_path = f"$.tracks[{track_index}]"
        if not isinstance(track, dict):
            _issue(issues, "error", "INVALID_TRACK", track_path, "Expected an object.")
            continue
        track_id = _require_id(track.get("id"), f"{track_path}.id", issues)
        if track_id:
            if track_id in all_ids:
                _issue(
                    issues,
                    "error",
                    "DUPLICATE_ID",
                    f"{track_path}.id",
                    f"'{track_id}' already exists at {all_ids[track_id]}.",
                )
            all_ids[track_id] = f"{track_path}.id"
        track_kind = track.get("kind")
        if track_kind not in {"video", "audio", "caption", "graphic", "adjustment"}:
            _issue(
                issues,
                "error",
                "INVALID_TRACK_KIND",
                f"{track_path}.kind",
                "Unsupported track kind.",
            )
        clips = track.get("clips")
        if not isinstance(clips, list):
            _issue(
                issues, "error", "INVALID_CLIPS", f"{track_path}.clips", "Expected an array."
            )
            continue
        for clip_index, clip in enumerate(clips):
            clip_path = f"{track_path}.clips[{clip_index}]"
            if not isinstance(clip, dict):
                _issue(issues, "error", "INVALID_CLIP", clip_path, "Expected an object.")
                continue
            clip_id = _require_id(clip.get("id"), f"{clip_path}.id", issues)
            if clip_id:
                if clip_id in all_ids:
                    _issue(
                        issues,
                        "error",
                        "DUPLICATE_ID",
                        f"{clip_path}.id",
                        f"'{clip_id}' already exists at {all_ids[clip_id]}.",
                    )
                all_ids[clip_id] = f"{clip_path}.id"
            clip_type = clip.get("type")
            if clip_type not in {"media", "text", "caption", "shape"}:
                _issue(
                    issues,
                    "error",
                    "INVALID_CLIP_TYPE",
                    f"{clip_path}.type",
                    "Unsupported clip type.",
                )
            start = _require_number(
                clip.get("start"), f"{clip_path}.start", issues, minimum=0
            )
            duration = _require_number(
                clip.get("duration"),
                f"{clip_path}.duration",
                issues,
                exclusive_minimum=0,
            )
            if clip_type == "media":
                asset_id = _require_id(
                    clip.get("assetId"), f"{clip_path}.assetId", issues
                )
                asset = asset_by_id.get(asset_id or "")
                if asset_id and asset is None:
                    _issue(
                        issues,
                        "error",
                        "UNKNOWN_ASSET",
                        f"{clip_path}.assetId",
                        f"No asset has id '{asset_id}'.",
                    )
                elif asset:
                    kind = asset.get("kind")
                    if track_kind == "audio" and kind not in {"audio", "video"}:
                        _issue(
                            issues,
                            "error",
                            "INCOMPATIBLE_TRACK",
                            clip_path,
                            f"An {kind} asset cannot be placed on an audio track.",
                        )
                    if track_kind in {"video", "graphic"} and kind not in {
                        "video",
                        "image",
                    }:
                        _issue(
                            issues,
                            "error",
                            "INCOMPATIBLE_TRACK",
                            clip_path,
                            f"An {kind} asset cannot be placed on a visual track.",
                        )
                freeze_frame_time = clip.get("freezeFrameSourceTime")
                if freeze_frame_time is not None:
                    freeze_frame_value = _require_number(
                        freeze_frame_time,
                        f"{clip_path}.freezeFrameSourceTime",
                        issues,
                        minimum=0,
                    )
                    if asset and asset.get("kind") != "video":
                        _issue(
                            issues,
                            "error",
                            "FREEZE_FRAME_REQUIRES_VIDEO",
                            f"{clip_path}.freezeFrameSourceTime",
                            "Only video assets can be used for freeze frames.",
                        )
                    if track_kind not in {"video", "graphic"}:
                        _issue(
                            issues,
                            "error",
                            "FREEZE_FRAME_REQUIRES_VISUAL_TRACK",
                            clip_path,
                            "Freeze frames must be placed on a visual track.",
                        )
                    if (
                        asset
                        and _is_number(asset.get("duration"))
                        and freeze_frame_value is not None
                        and freeze_frame_value >= float(asset["duration"])
                    ):
                        _issue(
                            issues,
                            "error",
                            "FREEZE_FRAME_OUT_OF_RANGE",
                            f"{clip_path}.freezeFrameSourceTime",
                            "The freeze-frame timestamp must be before the asset end.",
                        )
                    if clip.get("includeSourceAudio") is True:
                        _issue(
                            issues,
                            "warning",
                            "FREEZE_FRAME_AUDIO_IGNORED",
                            f"{clip_path}.includeSourceAudio",
                            "Freeze frames are silent; source audio will be ignored.",
                        )
                else:
                    source_in = clip.get("sourceIn", 0)
                    source_duration = clip.get(
                        "sourceDuration",
                        (duration or 0) * float(clip.get("speed", 1) or 1),
                    )
                    source_in_value = _require_number(
                        source_in, f"{clip_path}.sourceIn", issues, minimum=0
                    )
                    source_duration_value = _require_number(
                        source_duration,
                        f"{clip_path}.sourceDuration",
                        issues,
                        exclusive_minimum=0,
                    )
                    if (
                        asset
                        and _is_number(asset.get("duration"))
                        and source_in_value is not None
                        and source_duration_value is not None
                        and source_in_value + source_duration_value
                        > float(asset["duration"]) + 0.05
                    ):
                        _issue(
                            issues,
                            "error",
                            "SOURCE_RANGE_EXCEEDS_ASSET",
                            clip_path,
                            "The requested source range extends beyond the asset duration.",
                        )
            elif clip_type in {"text", "caption"} and not isinstance(
                clip.get("text"), str
            ):
                _issue(
                    issues,
                    "error",
                    "MISSING_TEXT",
                    f"{clip_path}.text",
                    "Text and caption clips require text.",
                )
            if track_kind == "caption" and clip_type != "caption":
                _issue(
                    issues,
                    "error",
                    "INCOMPATIBLE_TRACK",
                    clip_path,
                    "Caption tracks may only contain caption clips.",
                )
            for transition_field in ("transitionIn", "transitionOut"):
                transition = clip.get(transition_field)
                if transition is not None:
                    if not isinstance(transition, dict):
                        _issue(
                            issues,
                            "error",
                            "INVALID_TRANSITION",
                            f"{clip_path}.{transition_field}",
                            "Expected an object.",
                        )
                    else:
                        transition_duration = _require_number(
                            transition.get("duration"),
                            f"{clip_path}.{transition_field}.duration",
                            issues,
                            minimum=0,
                        )
                        if (
                            duration is not None
                            and transition_duration is not None
                            and transition_duration > duration / 2
                        ):
                            _issue(
                                issues,
                                "error",
                                "TRANSITION_TOO_LONG",
                                f"{clip_path}.{transition_field}.duration",
                                "A transition cannot exceed half of the clip duration.",
                            )
            keyframes = clip.get("keyframes", [])
            if not isinstance(keyframes, list):
                _issue(
                    issues,
                    "error",
                    "INVALID_KEYFRAMES",
                    f"{clip_path}.keyframes",
                    "Expected an array.",
                )
            else:
                seen_keyframe_ids: set[str] = set()
                for keyframe_index, keyframe in enumerate(keyframes):
                    keyframe_path = f"{clip_path}.keyframes[{keyframe_index}]"
                    if not isinstance(keyframe, dict):
                        _issue(
                            issues,
                            "error",
                            "INVALID_KEYFRAME",
                            keyframe_path,
                            "Expected an object.",
                        )
                        continue
                    keyframe_id = _require_id(
                        keyframe.get("id"), f"{keyframe_path}.id", issues
                    )
                    if keyframe_id in seen_keyframe_ids:
                        _issue(
                            issues,
                            "error",
                            "DUPLICATE_KEYFRAME_ID",
                            f"{keyframe_path}.id",
                            f"Duplicate keyframe id '{keyframe_id}'.",
                        )
                    if keyframe_id:
                        seen_keyframe_ids.add(keyframe_id)
                    key_time = _require_number(
                        keyframe.get("time"),
                        f"{keyframe_path}.time",
                        issues,
                        minimum=0,
                    )
                    if (
                        duration is not None
                        and key_time is not None
                        and key_time > duration
                    ):
                        _issue(
                            issues,
                            "error",
                            "KEYFRAME_OUTSIDE_CLIP",
                            f"{keyframe_path}.time",
                            "Keyframe time exceeds the clip duration.",
                        )

    export = data.get("export")
    if not isinstance(export, dict):
        _issue(issues, "error", "INVALID_EXPORT", "$.export", "Expected an object.")
    else:
        for key, allowed in {
            "container": {"mp4", "webm", "mov"},
            "videoCodec": {"h264", "h265", "vp9", "prores"},
            "audioCodec": {"aac", "opus", "pcm"},
            "quality": {"draft", "standard", "high", "master"},
        }.items():
            if export.get(key) not in allowed:
                _issue(
                    issues,
                    "error",
                    "INVALID_EXPORT_SETTING",
                    f"$.export.{key}",
                    f"Expected one of: {', '.join(sorted(allowed))}.",
                )
        _resolve_project_path(
            project_path,
            export.get("output"),
            "$.export.output",
            issues,
            allow_external_assets=allow_external_assets,
        )
    return issues


def validate_command_package(data: dict[str, Any]) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    if data.get("format") != COMMAND_FORMAT:
        _issue(
            issues,
            "error",
            "UNSUPPORTED_FORMAT",
            "$.format",
            f"Expected '{COMMAND_FORMAT}'.",
        )
    if data.get("version") != COMMAND_VERSION:
        _issue(
            issues,
            "error",
            "UNSUPPORTED_VERSION",
            "$.version",
            f"Expected version '{COMMAND_VERSION}'.",
        )
    _require_id(data.get("packageId"), "$.packageId", issues)
    base_hash = data.get("baseProjectSha256")
    if base_hash is not None and (
        not isinstance(base_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", base_hash)
    ):
        _issue(
            issues,
            "error",
            "INVALID_SHA256",
            "$.baseProjectSha256",
            "Expected a lowercase SHA-256 digest.",
        )
    operations = data.get("operations")
    if not isinstance(operations, list) or not operations:
        _issue(
            issues,
            "error",
            "INVALID_OPERATIONS",
            "$.operations",
            "Expected a non-empty array.",
        )
        return issues
    allowed = {
        "asset.add",
        "asset.remove",
        "track.add",
        "track.remove",
        "track.update",
        "clip.add",
        "clip.remove",
        "clip.update",
        "marker.add",
        "marker.remove",
        "project.update",
        "export.update",
    }
    operation_ids: set[str] = set()
    for index, operation in enumerate(operations):
        path = f"$.operations[{index}]"
        if not isinstance(operation, dict):
            _issue(issues, "error", "INVALID_OPERATION", path, "Expected an object.")
            continue
        operation_id = _require_id(operation.get("id"), f"{path}.id", issues)
        if operation_id in operation_ids:
            _issue(
                issues,
                "error",
                "DUPLICATE_OPERATION_ID",
                f"{path}.id",
                f"Duplicate operation id '{operation_id}'.",
            )
        if operation_id:
            operation_ids.add(operation_id)
        op = operation.get("op")
        if op not in allowed:
            _issue(
                issues,
                "error",
                "UNKNOWN_OPERATION",
                f"{path}.op",
                "Unsupported operation.",
            )
        if op in {"asset.add", "track.add", "clip.add", "marker.add"} and not isinstance(
            operation.get("value"), dict
        ):
            _issue(
                issues,
                "error",
                "MISSING_VALUE",
                f"{path}.value",
                "This operation requires an object value.",
            )
        if op == "clip.add":
            _require_id(operation.get("trackId"), f"{path}.trackId", issues)
        if op in {
            "asset.remove",
            "track.remove",
            "track.update",
            "clip.remove",
            "clip.update",
            "marker.remove",
        }:
            _require_id(operation.get("targetId"), f"{path}.targetId", issues)
        if op in {"track.update", "clip.update", "project.update", "export.update"} and not isinstance(
            operation.get("patch"), dict
        ):
            _issue(
                issues,
                "error",
                "MISSING_PATCH",
                f"{path}.patch",
                "This operation requires an object patch.",
            )
    return issues


def errors(issues: Iterable[ValidationIssue]) -> list[ValidationIssue]:
    return [issue for issue in issues if issue.level == "error"]


def issue_report(issues: Iterable[ValidationIssue]) -> dict[str, Any]:
    all_issues = list(issues)
    return {
        "valid": not errors(all_issues),
        "errorCount": sum(issue.level == "error" for issue in all_issues),
        "warningCount": sum(issue.level == "warning" for issue in all_issues),
        "issues": [issue.as_dict() for issue in all_issues],
    }
