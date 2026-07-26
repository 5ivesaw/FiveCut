from __future__ import annotations

import copy
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .model import (
    FiveCutError,
    atomic_write_bytes,
    atomic_write_json,
    errors,
    issue_report,
    load_json,
    project_sha256,
    validate_command_package,
    validate_project,
)


def _deep_merge(target: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(target)
    for key, value in patch.items():
        if (
            isinstance(value, dict)
            and isinstance(result.get(key), dict)
        ):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def _find_by_id(items: list[Any], target_id: str) -> tuple[int, dict[str, Any]] | None:
    for index, item in enumerate(items):
        if isinstance(item, dict) and item.get("id") == target_id:
            return index, item
    return None


def _find_clip(
    project: dict[str, Any], target_id: str
) -> tuple[dict[str, Any], int, dict[str, Any]] | None:
    for track in project.get("tracks", []):
        if not isinstance(track, dict):
            continue
        clips = track.get("clips", [])
        if not isinstance(clips, list):
            continue
        found = _find_by_id(clips, target_id)
        if found:
            index, clip = found
            return track, index, clip
    return None


def _target_for_operation(
    project: dict[str, Any], operation: dict[str, Any]
) -> dict[str, Any] | None:
    op = operation["op"]
    target_id = operation.get("targetId")
    if op.startswith("asset.") and target_id:
        found = _find_by_id(project.get("assets", []), target_id)
        return found[1] if found else None
    if op.startswith("track.") and target_id:
        found = _find_by_id(project.get("tracks", []), target_id)
        return found[1] if found else None
    if op.startswith("clip.") and target_id:
        found_clip = _find_clip(project, target_id)
        return found_clip[2] if found_clip else None
    if op.startswith("marker.") and target_id:
        found = _find_by_id(project.get("markers", []), target_id)
        return found[1] if found else None
    if op == "project.update":
        value = project.get("project")
        return value if isinstance(value, dict) else None
    if op == "export.update":
        value = project.get("export")
        return value if isinstance(value, dict) else None
    return None


def _check_preconditions(
    project: dict[str, Any], operation: dict[str, Any]
) -> None:
    preconditions = operation.get("preconditions")
    if not isinstance(preconditions, dict):
        return
    target = _target_for_operation(project, operation)
    expected_exists = preconditions.get("exists")
    if expected_exists is not None and (target is not None) != expected_exists:
        raise FiveCutError(
            f"Operation '{operation['id']}' failed its exists precondition.",
            code="PRECONDITION_FAILED",
        )
    field_equals = preconditions.get("fieldEquals")
    if isinstance(field_equals, dict):
        if target is None:
            raise FiveCutError(
                f"Operation '{operation['id']}' has field preconditions but no target.",
                code="PRECONDITION_FAILED",
            )
        for key, expected in field_equals.items():
            if target.get(key) != expected:
                raise FiveCutError(
                    f"Operation '{operation['id']}' expected {key}={expected!r}, "
                    f"got {target.get(key)!r}.",
                    code="PRECONDITION_FAILED",
                )


def _remove_by_id(
    items: list[Any], target_id: str, *, operation_id: str
) -> None:
    found = _find_by_id(items, target_id)
    if not found:
        raise FiveCutError(
            f"Operation '{operation_id}' could not find '{target_id}'.",
            code="TARGET_NOT_FOUND",
        )
    items.pop(found[0])


def apply_operation(project: dict[str, Any], operation: dict[str, Any]) -> None:
    _check_preconditions(project, operation)
    op = operation["op"]
    operation_id = operation["id"]
    target_id = operation.get("targetId")

    if op == "asset.add":
        project.setdefault("assets", []).append(copy.deepcopy(operation["value"]))
    elif op == "asset.remove":
        _remove_by_id(project["assets"], target_id, operation_id=operation_id)
    elif op == "track.add":
        value = copy.deepcopy(operation["value"])
        value.setdefault("clips", [])
        project.setdefault("tracks", []).append(value)
    elif op == "track.remove":
        _remove_by_id(project["tracks"], target_id, operation_id=operation_id)
    elif op == "track.update":
        found = _find_by_id(project["tracks"], target_id)
        if not found:
            raise FiveCutError(
                f"Operation '{operation_id}' could not find track '{target_id}'.",
                code="TARGET_NOT_FOUND",
            )
        immutable = {"id", "clips"}
        if immutable.intersection(operation["patch"]):
            raise FiveCutError(
                "track.update cannot replace id or clips.",
                code="IMMUTABLE_FIELD",
            )
        project["tracks"][found[0]] = _deep_merge(found[1], operation["patch"])
    elif op == "clip.add":
        found = _find_by_id(project["tracks"], operation["trackId"])
        if not found:
            raise FiveCutError(
                f"Operation '{operation_id}' could not find track "
                f"'{operation['trackId']}'.",
                code="TARGET_NOT_FOUND",
            )
        found[1].setdefault("clips", []).append(copy.deepcopy(operation["value"]))
    elif op == "clip.remove":
        found_clip = _find_clip(project, target_id)
        if not found_clip:
            raise FiveCutError(
                f"Operation '{operation_id}' could not find clip '{target_id}'.",
                code="TARGET_NOT_FOUND",
            )
        found_clip[0]["clips"].pop(found_clip[1])
    elif op == "clip.update":
        found_clip = _find_clip(project, target_id)
        if not found_clip:
            raise FiveCutError(
                f"Operation '{operation_id}' could not find clip '{target_id}'.",
                code="TARGET_NOT_FOUND",
            )
        if "id" in operation["patch"]:
            raise FiveCutError("clip.update cannot replace id.", code="IMMUTABLE_FIELD")
        found_clip[0]["clips"][found_clip[1]] = _deep_merge(
            found_clip[2], operation["patch"]
        )
    elif op == "marker.add":
        project.setdefault("markers", []).append(copy.deepcopy(operation["value"]))
    elif op == "marker.remove":
        _remove_by_id(
            project.setdefault("markers", []), target_id, operation_id=operation_id
        )
    elif op == "project.update":
        if {"id", "seed"}.intersection(operation["patch"]):
            raise FiveCutError(
                "project.update cannot replace id or seed.",
                code="IMMUTABLE_FIELD",
            )
        project["project"] = _deep_merge(project["project"], operation["patch"])
    elif op == "export.update":
        project["export"] = _deep_merge(project["export"], operation["patch"])
    else:
        raise FiveCutError(f"Unsupported operation: {op}", code="UNKNOWN_OPERATION")


def apply_package(
    project_path: Path,
    package_path: Path,
    *,
    dry_run: bool,
    allow_external_assets: bool = False,
) -> dict[str, Any]:
    project_path = project_path.resolve()
    package_path = package_path.resolve()
    project = load_json(project_path)
    package = load_json(package_path)
    package_issues = validate_command_package(package)
    if errors(package_issues):
        raise FiveCutError(
            json.dumps(issue_report(package_issues), indent=2),
            code="INVALID_COMMAND_PACKAGE",
        )
    current_hash = project_sha256(project_path)
    expected_hash = package.get("baseProjectSha256")
    if expected_hash and expected_hash != current_hash:
        raise FiveCutError(
            f"Project changed: package expects {expected_hash}, current hash is "
            f"{current_hash}. Regenerate the package against current state.",
            code="STALE_PROJECT",
        )

    working = copy.deepcopy(project)
    operation_results: list[dict[str, Any]] = []
    for operation in package["operations"]:
        apply_operation(working, operation)
        issues = validate_project(
            working,
            project_path=project_path,
            check_files=True,
            allow_external_assets=allow_external_assets,
        )
        operation_errors = errors(issues)
        if package.get("onMissingAsset", "fail") == "fail":
            missing_optional = [
                issue for issue in issues if issue.code == "MISSING_OPTIONAL_ASSET"
            ]
            operation_errors.extend(missing_optional)
        if operation_errors:
            raise FiveCutError(
                f"Operation '{operation['id']}' would make the project invalid:\n"
                f"{json.dumps(issue_report(operation_errors), indent=2)}",
                code="OPERATION_VALIDATION_FAILED",
            )
        operation_results.append(
            {"id": operation["id"], "op": operation["op"], "status": "validated"}
        )

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    state_root = project_path.parent / ".fivecut"
    report = {
        "format": "fivecut-apply-report",
        "version": "1.0.0",
        "timestamp": timestamp,
        "packageId": package["packageId"],
        "projectPath": str(project_path),
        "beforeSha256": current_hash,
        "dryRun": dry_run,
        "operationCount": len(operation_results),
        "operations": operation_results,
    }
    if dry_run:
        report["afterSha256"] = ""
        report["status"] = "dry-run-passed"
        return report

    history_path = (
        state_root / "history" / f"{timestamp}-{current_hash[:12]}.fivecut.json"
    )
    atomic_write_bytes(history_path, project_path.read_bytes())
    atomic_write_json(project_path, working)
    after_hash = project_sha256(project_path)
    report["afterSha256"] = after_hash
    report["historyPath"] = str(history_path.relative_to(project_path.parent))
    report["status"] = "applied"

    log_path = state_root / "logs" / "operations.jsonl"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(log_path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    return report


def list_history(project_path: Path) -> dict[str, Any]:
    project_path = project_path.resolve()
    history_root = project_path.parent / ".fivecut" / "history"
    snapshots: list[dict[str, Any]] = []
    if history_root.is_dir():
        for path in sorted(history_root.glob("*.fivecut.json"), reverse=True):
            snapshots.append(
                {
                    "path": str(path.relative_to(project_path.parent)),
                    "bytes": path.stat().st_size,
                    "sha256": project_sha256(path),
                }
            )
    return {
        "format": "fivecut-history-list",
        "version": "1.0.0",
        "projectPath": str(project_path),
        "currentSha256": project_sha256(project_path),
        "snapshots": snapshots,
    }


def restore_history(
    project_path: Path,
    snapshot_path: Path,
    *,
    expected_current_sha256: str | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    project_path = project_path.resolve()
    snapshot_path = snapshot_path.resolve()
    history_root = (project_path.parent / ".fivecut" / "history").resolve()
    if not snapshot_path.is_relative_to(history_root):
        raise FiveCutError(
            "Only snapshots inside .fivecut/history may be restored.",
            code="INVALID_HISTORY_PATH",
        )
    snapshot = load_json(snapshot_path)
    issues = validate_project(
        snapshot,
        project_path=project_path,
        check_files=True,
        allow_external_assets=False,
    )
    if errors(issues):
        raise FiveCutError(
            json.dumps(issue_report(issues), indent=2),
            code="INVALID_HISTORY_SNAPSHOT",
        )
    current_hash = project_sha256(project_path)
    if expected_current_sha256 and current_hash != expected_current_sha256:
        raise FiveCutError(
            f"Project changed: expected {expected_current_sha256}, got {current_hash}.",
            code="STALE_PROJECT",
        )
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    report: dict[str, Any] = {
        "format": "fivecut-restore-report",
        "version": "1.0.0",
        "timestamp": timestamp,
        "projectPath": str(project_path),
        "snapshotPath": str(snapshot_path),
        "beforeSha256": current_hash,
        "snapshotSha256": project_sha256(snapshot_path),
        "dryRun": dry_run,
    }
    if dry_run:
        report["status"] = "dry-run-passed"
        return report
    safety_path = history_root / f"{timestamp}-{current_hash[:12]}.fivecut.json"
    atomic_write_bytes(safety_path, project_path.read_bytes())
    atomic_write_json(project_path, snapshot)
    report["afterSha256"] = project_sha256(project_path)
    report["safetySnapshotPath"] = str(safety_path.relative_to(project_path.parent))
    report["status"] = "restored"
    return report
