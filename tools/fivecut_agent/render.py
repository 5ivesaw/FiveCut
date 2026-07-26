from __future__ import annotations

import json
import math
import os
import shlex
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .model import (
    FiveCutError,
    atomic_write_json,
    errors,
    issue_report,
    load_json,
    project_sha256,
    validate_project,
)


@dataclass(frozen=True)
class RenderPlan:
    command: list[str]
    output: Path
    temporary_output: Path
    duration: float
    compatibility: dict[str, Any]


def _number(value: Any, default: float) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = float(value)
        if math.isfinite(number):
            return number
    return default


def _filter_path(path: Path) -> str:
    return (
        str(path)
        .replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace(",", "\\,")
        .replace(";", "\\;")
        .replace("[", "\\[")
        .replace("]", "\\]")
    )


def _filter_text(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace("%", "\\%")
        .replace(",", "\\,")
        .replace(";", "\\;")
        .replace("[", "\\[")
        .replace("]", "\\]")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\n", "\\n")
    )


def _ff_color(value: Any, default: str = "#000000") -> str:
    raw = value if isinstance(value, str) else default
    if raw.startswith("#"):
        return f"0x{raw[1:]}"
    return raw


def _timeline_duration(project: dict[str, Any]) -> float:
    end = 0.0
    for track in project.get("tracks", []):
        if not isinstance(track, dict):
            continue
        for clip in track.get("clips", []):
            if isinstance(clip, dict):
                end = max(
                    end,
                    _number(clip.get("start"), 0)
                    + _number(clip.get("duration"), 0),
                )
    export = project.get("export", {})
    export_start = _number(export.get("start"), 0)
    export_duration = export.get("duration")
    if isinstance(export_duration, (int, float)) and not isinstance(
        export_duration, bool
    ):
        return max(0.0, export_start + float(export_duration))
    return end


def _asset_paths(
    project: dict[str, Any], project_path: Path
) -> tuple[dict[str, dict[str, Any]], dict[str, Path]]:
    assets: dict[str, dict[str, Any]] = {}
    paths: dict[str, Path] = {}
    for asset in project.get("assets", []):
        if not isinstance(asset, dict) or not isinstance(asset.get("id"), str):
            continue
        assets[asset["id"]] = asset
        raw_path = Path(str(asset.get("path", "")))
        paths[asset["id"]] = (
            raw_path.resolve()
            if raw_path.is_absolute()
            else (project_path.parent / raw_path).resolve()
        )
    return assets, paths


def compatibility_report(
    project: dict[str, Any],
    *,
    project_path: Path,
    ffmpeg: str | None = None,
) -> dict[str, Any]:
    detected_ffmpeg = ffmpeg or shutil.which("ffmpeg")
    problems: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []

    def problem(code: str, path: str, message: str) -> None:
        problems.append({"code": code, "path": path, "message": message})

    if not detected_ffmpeg:
        problem("FFMPEG_NOT_FOUND", "$", "FFmpeg is required for rendering.")

    total_duration = _timeline_duration(project)
    if total_duration <= 0:
        problem("EMPTY_TIMELINE", "$.tracks", "The timeline has no renderable duration.")

    assets, asset_paths = _asset_paths(project, project_path)
    visual_count = 0
    audio_count = 0
    for track_index, track in enumerate(project.get("tracks", [])):
        if not isinstance(track, dict):
            continue
        track_path = f"$.tracks[{track_index}]"
        clips = track.get("clips", [])
        if track.get("kind") == "adjustment" and clips:
            problem(
                "UNSUPPORTED_ADJUSTMENT_TRACK",
                track_path,
                "FFmpeg export does not yet support adjustment-track clips; put effects on clips.",
            )
        for clip_index, clip in enumerate(clips):
            if not isinstance(clip, dict):
                continue
            clip_path = f"{track_path}.clips[{clip_index}]"
            clip_type = clip.get("type")
            if clip_type == "media":
                asset = assets.get(str(clip.get("assetId")))
                if not asset:
                    continue
                if track.get("kind") in {"video", "graphic"} and not track.get(
                    "hidden", False
                ):
                    visual_count += 1
                if (
                    not track.get("muted", False)
                    and (
                        track.get("kind") == "audio"
                        or (
                            asset.get("kind") == "video"
                            and asset.get("hasAudio", False)
                            and clip.get("includeSourceAudio", True)
                        )
                    )
                ):
                    audio_count += 1
                if asset.get("kind") == "subtitle":
                    problem(
                        "SUBTITLE_AS_MEDIA",
                        clip_path,
                        "Import subtitle cues as caption clips before rendering.",
                    )
            elif clip_type in {"text", "caption", "shape"} and not track.get(
                "hidden", False
            ):
                visual_count += 1

            transform = clip.get("transform", {})
            for axis in ("scaleX", "scaleY"):
                frames = [
                    frame
                    for frame in clip.get("keyframes", [])
                    if isinstance(frame, dict)
                    and frame.get("property") == f"transform.{axis}"
                ]
                values = [_number(transform.get(axis), 1)] + [
                    _number(frame.get("value"), 1) for frame in frames
                ]
                if min(values, default=1) < 0 < max(values, default=1):
                    problem(
                        "UNSUPPORTED_ANIMATED_FLIP",
                        f"{clip_path}.keyframes",
                        "A scale animation cannot cross zero; split the clip at the flip.",
                    )

            if clip_type in {"text", "caption"}:
                font_asset_id = clip.get("style", {}).get("fontFileAssetId")
                if font_asset_id and font_asset_id not in asset_paths:
                    problem(
                        "MISSING_FONT_ASSET",
                        f"{clip_path}.style.fontFileAssetId",
                        f"Font asset '{font_asset_id}' does not exist.",
                    )

    export = project.get("export", {})
    container = export.get("container")
    video_codec = export.get("videoCodec")
    audio_codec = export.get("audioCodec")
    allowed_combinations = {
        "mp4": ({"h264", "h265"}, {"aac"}),
        "webm": ({"vp9"}, {"opus"}),
        "mov": ({"h264", "h265", "prores"}, {"aac", "pcm"}),
    }
    if container in allowed_combinations:
        video_allowed, audio_allowed = allowed_combinations[container]
        if video_codec not in video_allowed:
            problem(
                "INCOMPATIBLE_VIDEO_CODEC",
                "$.export.videoCodec",
                f"{video_codec} is not supported in {container} exports.",
            )
        if audio_codec not in audio_allowed:
            problem(
                "INCOMPATIBLE_AUDIO_CODEC",
                "$.export.audioCodec",
                f"{audio_codec} is not supported in {container} exports.",
            )

    if visual_count == 0 and total_duration > 0:
        warnings.append(
            {
                "code": "BACKGROUND_ONLY",
                "path": "$.tracks",
                "message": "No visible clips exist; export will contain only the background.",
            }
        )
    if audio_count == 0 and total_duration > 0:
        warnings.append(
            {
                "code": "SILENT_EXPORT",
                "path": "$.tracks",
                "message": "No audible clips exist; export will contain a silent audio stream.",
            }
        )

    return {
        "format": "fivecut-render-compatibility",
        "version": "1.0.0",
        "compatible": not problems,
        "ffmpeg": detected_ffmpeg,
        "duration": total_duration,
        "visualClipCount": visual_count,
        "audioClipCount": audio_count,
        "errors": problems,
        "warnings": warnings,
        "capabilities": {
            "media": ["video", "audio", "image"],
            "generated": ["text", "caption", "shape"],
            "transitions": [
                "none",
                "fade",
                "dissolve",
                "slide-left",
                "slide-right",
                "zoom",
            ],
            "effects": [
                "color-grade",
                "blur",
                "sharpen",
                "pixelate",
                "film-grain",
                "vignette",
                "grayscale",
                "crop",
            ],
            "keyframes": [
                "opacity",
                "volumeDb",
                "transform.positionX",
                "transform.positionY",
                "transform.scaleX",
                "transform.scaleY",
                "transform.rotation",
            ],
        },
    }


def _interpolated_expression(
    clip: dict[str, Any],
    property_name: str,
    default: float,
    *,
    time_expression: str,
) -> str:
    frames: list[tuple[float, float, str]] = []
    for frame in clip.get("keyframes", []):
        if not isinstance(frame, dict) or frame.get("property") != property_name:
            continue
        frames.append(
            (
                _number(frame.get("time"), 0),
                _number(frame.get("value"), default),
                str(frame.get("interpolation", "linear")),
            )
        )
    frames.sort(key=lambda item: item[0])
    if not frames:
        return f"{default:.8f}"
    if frames[0][0] > 0:
        frames.insert(0, (0.0, default, "linear"))

    expression = f"{frames[-1][1]:.8f}"
    for index in range(len(frames) - 2, -1, -1):
        start_time, start_value, interpolation = frames[index]
        end_time, end_value, _ = frames[index + 1]
        span = max(0.000001, end_time - start_time)
        progress = (
            f"max(0,min(1,(({time_expression})-{start_time:.8f})/{span:.8f}))"
        )
        if interpolation == "hold":
            segment = f"{start_value:.8f}"
        else:
            if interpolation == "ease-in":
                eased = f"({progress})*({progress})"
            elif interpolation == "ease-out":
                eased = f"1-(1-({progress}))*(1-({progress}))"
            elif interpolation == "ease-in-out":
                eased = f"({progress})*({progress})*(3-2*({progress}))"
            else:
                eased = progress
            segment = (
                f"{start_value:.8f}+({end_value:.8f}-{start_value:.8f})*({eased})"
            )
        expression = (
            f"if(lt(({time_expression}),{end_time:.8f}),({segment}),({expression}))"
        )
    return expression


def _transition_opacity(clip: dict[str, Any], base_expression: str) -> str:
    duration = _number(clip.get("duration"), 0)
    factors = [f"({base_expression})"]
    transition_in = clip.get("transitionIn")
    if isinstance(transition_in, dict) and transition_in.get("type") in {
        "fade",
        "dissolve",
    }:
        transition_duration = _number(transition_in.get("duration"), 0)
        if transition_duration > 0:
            factors.append(f"min(1,T/{transition_duration:.8f})")
    transition_out = clip.get("transitionOut")
    if isinstance(transition_out, dict) and transition_out.get("type") in {
        "fade",
        "dissolve",
    }:
        transition_duration = _number(transition_out.get("duration"), 0)
        if transition_duration > 0:
            factors.append(
                f"min(1,max(0,({duration:.8f}-T)/{transition_duration:.8f}))"
            )
    return "*".join(factors)


def _effect_filters(clip: dict[str, Any]) -> list[str]:
    filters: list[str] = []
    for effect in clip.get("effects", []):
        if not isinstance(effect, dict) or effect.get("enabled", True) is False:
            continue
        effect_type = effect.get("type")
        params = effect.get("params") if isinstance(effect.get("params"), dict) else {}
        if effect_type == "crop":
            width = max(1, int(_number(params.get("width"), 1920)))
            height = max(1, int(_number(params.get("height"), 1080)))
            x = int(_number(params.get("x"), 0))
            y = int(_number(params.get("y"), 0))
            filters.append(f"crop={width}:{height}:{x}:{y}")
        elif effect_type == "color-grade":
            brightness = max(-1, min(1, _number(params.get("brightness"), 0)))
            contrast = max(0, min(4, _number(params.get("contrast"), 1)))
            saturation = max(0, min(4, _number(params.get("saturation"), 1)))
            gamma = max(0.1, min(10, _number(params.get("gamma"), 1)))
            filters.append(
                f"eq=brightness={brightness:.6f}:contrast={contrast:.6f}:"
                f"saturation={saturation:.6f}:gamma={gamma:.6f}"
            )
            temperature = max(-1, min(1, _number(params.get("temperature"), 0)))
            tint = max(-1, min(1, _number(params.get("tint"), 0)))
            if temperature or tint:
                filters.append(
                    "colorbalance="
                    f"rs={temperature * 0.18 + tint * 0.07:.6f}:"
                    f"gs={-tint * 0.08:.6f}:"
                    f"bs={-temperature * 0.18 + tint * 0.07:.6f}"
                )
        elif effect_type == "blur":
            sigma = max(0, min(100, _number(params.get("sigma"), 4)))
            filters.append(f"gblur=sigma={sigma:.6f}")
        elif effect_type == "sharpen":
            amount = max(0, min(5, _number(params.get("amount"), 1)))
            filters.append(f"unsharp=5:5:{amount:.6f}:5:5:0")
        elif effect_type == "pixelate":
            size = max(2, min(200, int(_number(params.get("size"), 12))))
            filters.extend(
                [
                    f"scale=iw/{size}:ih/{size}:flags=neighbor",
                    f"scale=iw*{size}:ih*{size}:flags=neighbor",
                ]
            )
        elif effect_type == "film-grain":
            amount = max(0, min(100, _number(params.get("amount"), 8)))
            filters.append(f"noise=alls={amount:.6f}:allf=u")
        elif effect_type == "vignette":
            angle = max(0.05, min(1.5, _number(params.get("angle"), 0.35)))
            filters.append(f"vignette=angle={angle:.6f}")
        elif effect_type == "grayscale":
            filters.append("hue=s=0")
    return filters


def _atempo_filters(speed: float) -> list[str]:
    speed = max(0.05, min(20, speed))
    factors: list[float] = []
    while speed > 2:
        factors.append(2)
        speed /= 2
    while speed < 0.5:
        factors.append(0.5)
        speed /= 0.5
    factors.append(speed)
    return [f"atempo={factor:.8f}" for factor in factors]


def _visual_chain(
    input_index: int,
    clip: dict[str, Any],
    *,
    canvas_width: int,
    canvas_height: int,
    fps: float,
    is_image: bool,
    output_label: str,
) -> tuple[str, str, str]:
    start = _number(clip.get("start"), 0)
    duration = _number(clip.get("duration"), 0)
    source_in = 0 if is_image else _number(clip.get("sourceIn"), 0)
    speed = _number(clip.get("speed"), 1)
    source_duration = (
        duration
        if is_image
        else _number(clip.get("sourceDuration"), duration * speed)
    )
    transform = clip.get("transform") if isinstance(clip.get("transform"), dict) else {}
    scale_x_default = _number(transform.get("scaleX"), 1)
    scale_y_default = _number(transform.get("scaleY"), 1)
    scale_x = _interpolated_expression(
        clip,
        "transform.scaleX",
        scale_x_default,
        time_expression="t",
    )
    scale_y = _interpolated_expression(
        clip,
        "transform.scaleY",
        scale_y_default,
        time_expression="t",
    )
    zoom_factor = "1"
    transition_in = clip.get("transitionIn")
    if isinstance(transition_in, dict) and transition_in.get("type") == "zoom":
        transition_duration = _number(transition_in.get("duration"), 0)
        if transition_duration > 0:
            zoom_factor = (
                f"(0.82+0.18*min(1,max(0,t/{transition_duration:.8f})))"
            )
    transition_out = clip.get("transitionOut")
    if isinstance(transition_out, dict) and transition_out.get("type") == "zoom":
        transition_duration = _number(transition_out.get("duration"), 0)
        if transition_duration > 0:
            zoom_factor = (
                f"({zoom_factor})*(0.82+0.18*min(1,max(0,"
                f"({duration:.8f}-t)/{transition_duration:.8f})))"
            )

    fit_width = (
        f"if(gte(iw/ih,{canvas_width}/{canvas_height}),"
        f"{canvas_width},{canvas_height}*iw/ih)"
    )
    fit_height = (
        f"if(gte(iw/ih,{canvas_width}/{canvas_height}),"
        f"{canvas_width}*ih/iw,{canvas_height})"
    )
    filters = [
        f"trim=start={source_in:.8f}:duration={source_duration:.8f}",
        f"setpts=(PTS-STARTPTS)/{speed:.8f}",
        f"trim=duration={duration:.8f}",
        f"fps={fps:.8f}",
    ]
    filters.extend(_effect_filters(clip))
    filters.append(
        "scale="
        f"w='max(2,trunc(({fit_width})*abs({scale_x})*({zoom_factor})/2)*2)':"
        f"h='max(2,trunc(({fit_height})*abs({scale_y})*({zoom_factor})/2)*2)':"
        "eval=frame"
    )
    if scale_x_default < 0:
        filters.append("hflip")
    if scale_y_default < 0:
        filters.append("vflip")
    rotation = _interpolated_expression(
        clip,
        "transform.rotation",
        _number(transform.get("rotation"), 0),
        time_expression="t",
    )
    if rotation != "0.00000000":
        filters.append(
            f"rotate=angle='({rotation})*PI/180':ow=rotw(iw):oh=roth(ih):c=none"
        )
    opacity = _interpolated_expression(
        clip, "opacity", _number(clip.get("opacity"), 1), time_expression="T"
    )
    opacity = _transition_opacity(clip, opacity)
    filters.extend(
        [
            "format=rgba",
            f"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*({opacity})'",
            f"setpts=PTS+{start:.8f}/TB",
        ]
    )

    position_x = _interpolated_expression(
        clip,
        "transform.positionX",
        _number(transform.get("positionX"), 0),
        time_expression=f"(t-{start:.8f})",
    )
    position_y = _interpolated_expression(
        clip,
        "transform.positionY",
        _number(transform.get("positionY"), 0),
        time_expression=f"(t-{start:.8f})",
    )
    base_x = f"(W-w)/2+({position_x})"
    base_y = f"(H-h)/2+({position_y})"
    for field, direction in (("transitionIn", "in"), ("transitionOut", "out")):
        transition = clip.get(field)
        if not isinstance(transition, dict):
            continue
        transition_type = transition.get("type")
        transition_duration = _number(transition.get("duration"), 0)
        if transition_duration <= 0:
            continue
        local_time = f"(t-{start:.8f})"
        if direction == "out":
            progress = (
                f"min(1,max(0,({local_time}-"
                f"{duration - transition_duration:.8f})/{transition_duration:.8f}))"
            )
        else:
            progress = f"min(1,max(0,{local_time}/{transition_duration:.8f}))"
        if transition_type == "slide-left":
            offset = (
                f"W*(1-({progress}))" if direction == "in" else f"-W*({progress})"
            )
            base_x = f"({base_x})+({offset})"
        elif transition_type == "slide-right":
            offset = (
                f"-W*(1-({progress}))" if direction == "in" else f"W*({progress})"
            )
            base_x = f"({base_x})+({offset})"
    return (
        f"[{input_index}:v]{','.join(filters)}[{output_label}]",
        base_x,
        base_y,
    )


def _audio_chain(
    input_index: int,
    clip: dict[str, Any],
    *,
    output_label: str,
) -> str:
    start = _number(clip.get("start"), 0)
    duration = _number(clip.get("duration"), 0)
    speed = _number(clip.get("speed"), 1)
    source_in = _number(clip.get("sourceIn"), 0)
    source_duration = _number(clip.get("sourceDuration"), duration * speed)
    volume_db = _interpolated_expression(
        clip, "volumeDb", _number(clip.get("volumeDb"), 0), time_expression="t"
    )
    filters = [
        f"atrim=start={source_in:.8f}:duration={source_duration:.8f}",
        "asetpts=PTS-STARTPTS",
        *_atempo_filters(speed),
        f"atrim=duration={duration:.8f}",
        f"volume='pow(10,({volume_db})/20)':eval=frame",
    ]
    transition_in = clip.get("transitionIn")
    if isinstance(transition_in, dict) and transition_in.get("type") in {
        "fade",
        "dissolve",
    }:
        transition_duration = _number(transition_in.get("duration"), 0)
        if transition_duration > 0:
            filters.append(f"afade=t=in:st=0:d={transition_duration:.8f}")
    transition_out = clip.get("transitionOut")
    if isinstance(transition_out, dict) and transition_out.get("type") in {
        "fade",
        "dissolve",
    }:
        transition_duration = _number(transition_out.get("duration"), 0)
        if transition_duration > 0:
            filters.append(
                f"afade=t=out:st={max(0, duration-transition_duration):.8f}:"
                f"d={transition_duration:.8f}"
            )
    filters.append(f"adelay={max(0, round(start * 1000))}:all=1")
    return f"[{input_index}:a]{','.join(filters)}[{output_label}]"


def _text_filter(
    input_label: str,
    output_label: str,
    clip: dict[str, Any],
    *,
    font_path: Path | None,
) -> str:
    start = _number(clip.get("start"), 0)
    end = start + _number(clip.get("duration"), 0)
    style = clip.get("style") if isinstance(clip.get("style"), dict) else {}
    font_size = max(1, _number(style.get("fontSize"), 64))
    margin_x = max(0, int(_number(style.get("marginX"), 60)))
    margin_y = max(0, int(_number(style.get("marginY"), 80)))
    alignment = style.get("alignment", "center")
    position = style.get("position", "bottom")
    if alignment == "left":
        x = str(margin_x)
    elif alignment == "right":
        x = f"w-text_w-{margin_x}"
    else:
        x = "(w-text_w)/2"
    y = {
        "top": str(margin_y),
        "upper-third": f"h*0.25-text_h/2+{margin_y}",
        "center": "(h-text_h)/2",
        "lower-third": f"h*0.75-text_h/2-{margin_y}",
        "bottom": f"h-text_h-{margin_y}",
    }.get(str(position), f"h-text_h-{margin_y}")
    options = [
        f"text='{_filter_text(str(clip.get('text', '')))}'",
        "expansion=none",
        f"fontsize={font_size:.4f}",
        f"fontcolor={_ff_color(style.get('color'), '#FFFFFF')}",
        f"x='{x}'",
        f"y='{y}'",
        f"enable='between(t,{start:.8f},{end:.8f})'",
    ]
    if font_path:
        options.append(f"fontfile='{_filter_path(font_path)}'")
    else:
        options.append(
            f"font='{_filter_text(str(style.get('fontFamily', 'DejaVu Sans')))}'"
        )
    if style.get("fontWeight") == "bold":
        options.append("borderw=1")
    outline_width = max(0, _number(style.get("outlineWidth"), 2))
    if outline_width:
        options.extend(
            [
                f"borderw={outline_width:.4f}",
                f"bordercolor={_ff_color(style.get('outlineColor'), '#000000')}",
            ]
        )
    if style.get("backgroundColor"):
        options.extend(
            [
                "box=1",
                f"boxcolor={_ff_color(style['backgroundColor'])}",
                "boxborderw=16",
            ]
        )
    return f"[{input_label}]drawtext={':'.join(options)}[{output_label}]"


def _shape_filter(
    input_label: str, output_label: str, clip: dict[str, Any]
) -> str:
    start = _number(clip.get("start"), 0)
    end = start + _number(clip.get("duration"), 0)
    metadata = clip.get("metadata") if isinstance(clip.get("metadata"), dict) else {}
    transform = clip.get("transform") if isinstance(clip.get("transform"), dict) else {}
    width = max(1, _number(metadata.get("width"), 400))
    height = max(1, _number(metadata.get("height"), 200))
    x = f"(w-{width:.4f})/2+{_number(transform.get('positionX'), 0):.4f}"
    y = f"(h-{height:.4f})/2+{_number(transform.get('positionY'), 0):.4f}"
    opacity = max(0, min(1, _number(clip.get("opacity"), 1)))
    color = f"{_ff_color(metadata.get('color'), '#F97316')}@{opacity:.4f}"
    return (
        f"[{input_label}]drawbox=x='{x}':y='{y}':w={width:.4f}:h={height:.4f}:"
        f"color={color}:t=fill:enable='between(t,{start:.8f},{end:.8f})'"
        f"[{output_label}]"
    )


def build_render_plan(
    project_path: Path,
    *,
    output_override: Path | None = None,
    overwrite: bool = False,
    allow_external_assets: bool = False,
) -> RenderPlan:
    project_path = project_path.resolve()
    project = load_json(project_path)
    validation = validate_project(
        project,
        project_path=project_path,
        check_files=True,
        verify_hashes=False,
        allow_external_assets=allow_external_assets,
    )
    if errors(validation):
        raise FiveCutError(
            json.dumps(issue_report(validation), indent=2),
            code="INVALID_PROJECT",
        )
    report = compatibility_report(project, project_path=project_path)
    if not report["compatible"]:
        raise FiveCutError(
            json.dumps(report, indent=2), code="RENDER_INCOMPATIBLE"
        )
    ffmpeg = str(report["ffmpeg"])
    canvas = project["project"]["canvas"]
    width = int(canvas["width"])
    height = int(canvas["height"])
    fps = int(canvas["fps"]["numerator"]) / int(canvas["fps"]["denominator"])
    sample_rate = int(canvas.get("sampleRate", 48000))
    total_duration = float(report["duration"])
    export = project["export"]
    export_start = _number(export.get("start"), 0)
    export_duration = _number(
        export.get("duration"), max(0.0, total_duration - export_start)
    )
    raw_output = output_override or Path(str(export["output"]))
    output = (
        raw_output.resolve()
        if raw_output.is_absolute()
        else (project_path.parent / raw_output).resolve()
    )
    if (
        not allow_external_assets
        and not output.is_relative_to(project_path.parent.resolve())
    ):
        raise FiveCutError(
            "Export output is outside the project directory.",
            code="OUTPUT_OUTSIDE_PROJECT",
        )
    if output.exists() and not (overwrite or export.get("overwrite", False)):
        raise FiveCutError(
            f"Output exists and overwrite is disabled: {output}",
            code="OUTPUT_EXISTS",
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output.stem}.fivecut-", suffix=output.suffix, dir=output.parent
    )
    os.close(descriptor)
    temporary_output = Path(temporary_name)
    temporary_output.unlink(missing_ok=True)

    assets, asset_paths = _asset_paths(project, project_path)
    command = [ffmpeg, "-hide_banner", "-nostdin", "-v", "warning"]
    clip_inputs: dict[str, int] = {}
    input_index = 0
    for track in project.get("tracks", []):
        if not isinstance(track, dict):
            continue
        for clip in sorted(
            (item for item in track.get("clips", []) if isinstance(item, dict)),
            key=lambda item: (_number(item.get("start"), 0), str(item.get("id", ""))),
        ):
            if clip.get("type") != "media":
                continue
            asset = assets.get(str(clip.get("assetId")))
            if not asset:
                continue
            path = asset_paths[asset["id"]]
            if asset.get("kind") == "image":
                command.extend(["-loop", "1", "-framerate", f"{fps:.8f}"])
            command.extend(["-i", str(path)])
            clip_inputs[str(clip["id"])] = input_index
            input_index += 1

    graph: list[str] = [
        f"color=c={_ff_color(project['project']['background']['color'])}:"
        f"s={width}x{height}:r={fps:.8f}:d={total_duration:.8f},"
        "format=rgba[base_0]"
    ]
    current_video = "base_0"
    video_step = 0
    audio_labels: list[str] = []
    for track in project.get("tracks", []):
        if not isinstance(track, dict):
            continue
        track_hidden = bool(track.get("hidden", False))
        track_muted = bool(track.get("muted", False))
        for clip in sorted(
            (item for item in track.get("clips", []) if isinstance(item, dict)),
            key=lambda item: (_number(item.get("start"), 0), str(item.get("id", ""))),
        ):
            clip_type = clip.get("type")
            if clip_type == "media":
                asset = assets.get(str(clip.get("assetId")))
                if not asset:
                    continue
                input_number = clip_inputs[str(clip["id"])]
                if (
                    not track_hidden
                    and track.get("kind") in {"video", "graphic"}
                    and asset.get("kind") in {"video", "image"}
                ):
                    video_step += 1
                    clip_label = f"vclip_{video_step}"
                    next_video = f"vbase_{video_step}"
                    chain, x, y = _visual_chain(
                        input_number,
                        clip,
                        canvas_width=width,
                        canvas_height=height,
                        fps=fps,
                        is_image=asset.get("kind") == "image",
                        output_label=clip_label,
                    )
                    graph.append(chain)
                    start = _number(clip.get("start"), 0)
                    end = start + _number(clip.get("duration"), 0)
                    graph.append(
                        f"[{current_video}][{clip_label}]overlay=x='{x}':y='{y}':"
                        f"eof_action=pass:shortest=0:eval=frame:"
                        f"enable='between(t,{start:.8f},{end:.8f})'[{next_video}]"
                    )
                    current_video = next_video
                should_include_audio = (
                    not track_muted
                    and not clip.get("muted", False)
                    and (
                        (
                            track.get("kind") == "audio"
                            and asset.get("kind") in {"audio", "video"}
                        )
                        or (
                            track.get("kind") in {"video", "graphic"}
                            and asset.get("kind") == "video"
                            and asset.get("hasAudio", False)
                            and clip.get("includeSourceAudio", True)
                        )
                    )
                )
                if should_include_audio:
                    audio_label = f"aclip_{len(audio_labels) + 1}"
                    graph.append(
                        _audio_chain(input_number, clip, output_label=audio_label)
                    )
                    audio_labels.append(audio_label)
            elif not track_hidden and clip_type in {"text", "caption"}:
                video_step += 1
                next_video = f"vbase_{video_step}"
                font_asset_id = clip.get("style", {}).get("fontFileAssetId")
                font_path = asset_paths.get(str(font_asset_id)) if font_asset_id else None
                graph.append(
                    _text_filter(
                        current_video,
                        next_video,
                        clip,
                        font_path=font_path,
                    )
                )
                current_video = next_video
            elif not track_hidden and clip_type == "shape":
                video_step += 1
                next_video = f"vbase_{video_step}"
                graph.append(_shape_filter(current_video, next_video, clip))
                current_video = next_video

    graph.append(f"[{current_video}]format=yuv420p[vout]")
    if audio_labels:
        joined = "".join(f"[{label}]" for label in audio_labels)
        audio_filter = (
            f"{joined}amix=inputs={len(audio_labels)}:duration=longest:"
            "dropout_transition=0:normalize=0"
        )
        loudness = export.get("loudnessTargetLufs")
        if isinstance(loudness, (int, float)) and not isinstance(loudness, bool):
            audio_filter += f",loudnorm=I={float(loudness):.4f}:TP=-1:LRA=11"
        graph.append(f"{audio_filter},apad=whole_dur={total_duration:.8f}[aout]")
    else:
        graph.append(
            f"anullsrc=r={sample_rate}:cl=stereo:d={total_duration:.8f}[aout]"
        )

    command.extend(["-filter_complex", ";".join(graph), "-map", "[vout]", "-map", "[aout]"])
    video_codecs = {
        "h264": "libx264",
        "h265": "libx265",
        "vp9": "libvpx-vp9",
        "prores": "prores_ks",
    }
    audio_codecs = {"aac": "aac", "opus": "libopus", "pcm": "pcm_s24le"}
    video_codec = str(export["videoCodec"])
    quality = str(export["quality"])
    command.extend(["-c:v", video_codecs[video_codec]])
    if video_codec in {"h264", "h265"}:
        crf = {"draft": "28", "standard": "23", "high": "18", "master": "14"}[quality]
        preset = "veryfast" if quality == "draft" else "medium"
        command.extend(["-crf", crf, "-preset", preset])
    elif video_codec == "vp9":
        crf = {"draft": "38", "standard": "32", "high": "24", "master": "18"}[quality]
        command.extend(["-crf", crf, "-b:v", "0", "-row-mt", "1"])
    else:
        profile = {"draft": "0", "standard": "1", "high": "2", "master": "3"}[quality]
        command.extend(["-profile:v", profile])
    if export.get("videoBitrate"):
        command.extend(["-b:v", str(export["videoBitrate"])])
    pixel_format = export.get(
        "pixelFormat", "yuv422p10le" if video_codec == "prores" else "yuv420p"
    )
    command.extend(["-pix_fmt", str(pixel_format), "-c:a", audio_codecs[str(export["audioCodec"])]] )
    if export.get("audioBitrate") and export["audioCodec"] != "pcm":
        command.extend(["-b:a", str(export["audioBitrate"])])
    command.extend(
        [
            "-ar",
            str(sample_rate),
            "-r",
            f"{fps:.8f}",
            "-ss",
            f"{export_start:.8f}",
            "-t",
            f"{export_duration:.8f}",
            "-map_metadata",
            "-1",
        ]
    )
    for key, value in sorted(export.get("metadata", {}).items()):
        command.extend(["-metadata", f"{key}={value}"])
    command.extend(["-movflags", "+faststart", "-y", str(temporary_output)])
    return RenderPlan(
        command=command,
        output=output,
        temporary_output=temporary_output,
        duration=export_duration,
        compatibility=report,
    )


def render_project(
    project_path: Path,
    *,
    output_override: Path | None = None,
    dry_run: bool = False,
    overwrite: bool = False,
    allow_external_assets: bool = False,
) -> dict[str, Any]:
    project_path = project_path.resolve()
    plan = build_render_plan(
        project_path,
        output_override=output_override,
        overwrite=overwrite,
        allow_external_assets=allow_external_assets,
    )
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    report: dict[str, Any] = {
        "format": "fivecut-render-report",
        "version": "1.0.0",
        "timestamp": timestamp,
        "projectPath": str(project_path),
        "projectSha256": project_sha256(project_path),
        "output": str(plan.output),
        "duration": plan.duration,
        "command": shlex.join(plan.command),
        "compatibility": plan.compatibility,
        "dryRun": dry_run,
    }
    if dry_run:
        plan.temporary_output.unlink(missing_ok=True)
        report["status"] = "dry-run-passed"
        return report

    completed = subprocess.run(
        plan.command,
        check=False,
        capture_output=True,
        text=True,
    )
    report["ffmpegExitCode"] = completed.returncode
    report["stderr"] = completed.stderr[-40_000:]
    if completed.returncode != 0 or not plan.temporary_output.is_file():
        plan.temporary_output.unlink(missing_ok=True)
        report["status"] = "failed"
        _write_render_report(project_path, timestamp, report)
        raise FiveCutError(
            f"FFmpeg render failed with exit code {completed.returncode}. "
            f"See .fivecut/reports/render-{timestamp}.json",
            code="RENDER_FAILED",
        )
    os.replace(plan.temporary_output, plan.output)
    report["status"] = "rendered"
    report["bytes"] = plan.output.stat().st_size
    _write_render_report(project_path, timestamp, report)
    return report


def _write_render_report(
    project_path: Path, timestamp: str, report: dict[str, Any]
) -> None:
    atomic_write_json(
        project_path.parent
        / ".fivecut"
        / "reports"
        / f"render-{timestamp}.json",
        report,
    )
