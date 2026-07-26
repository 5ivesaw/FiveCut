from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from tools.fivecut_agent.cli import _init_project
from tools.fivecut_agent.model import (
    FiveCutError,
    atomic_write_json,
    errors,
    load_json,
    project_sha256,
    validate_command_package,
    validate_project,
)
from tools.fivecut_agent.operations import (
    apply_package,
    list_history,
    restore_history,
)
from tools.fivecut_agent.qc import qc_project
from tools.fivecut_agent.render import render_project


class AgentContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="fivecut-tests-")
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _project(self) -> Path:
        (self.root / "image.png").write_bytes(b"not decoded by contract tests")
        project_path = self.root / "fivecut.project.json"
        atomic_write_json(
            project_path,
            {
                "format": "fivecut-project",
                "version": "1.0.0",
                "project": {
                    "id": "project:test",
                    "name": "Contract test",
                    "seed": 7,
                    "canvas": {
                        "width": 1920,
                        "height": 1080,
                        "fps": {"numerator": 30, "denominator": 1},
                    },
                    "background": {"color": "#111111"},
                },
                "assets": [
                    {"id": "asset:image", "kind": "image", "path": "image.png"}
                ],
                "tracks": [
                    {
                        "id": "track:video",
                        "kind": "video",
                        "name": "Video",
                        "clips": [
                            {
                                "id": "clip:image",
                                "type": "media",
                                "assetId": "asset:image",
                                "start": 0,
                                "duration": 2,
                            }
                        ],
                    }
                ],
                "markers": [],
                "export": {
                    "output": "renders/test.mp4",
                    "container": "mp4",
                    "videoCodec": "h264",
                    "audioCodec": "aac",
                    "quality": "high",
                },
            },
        )
        return project_path

    def test_transaction_and_restore_are_hash_guarded(self) -> None:
        project_path = self._project()
        before_hash = project_sha256(project_path)
        package_path = self.root / "edit.json"
        atomic_write_json(
            package_path,
            {
                "format": "fivecut-command-package",
                "version": "1.0.0",
                "packageId": "package:test",
                "baseProjectSha256": before_hash,
                "operations": [
                    {
                        "id": "operation:rename",
                        "op": "project.update",
                        "patch": {"name": "Updated safely"},
                    }
                ],
            },
        )
        dry_run = apply_package(project_path, package_path, dry_run=True)
        self.assertEqual(dry_run["status"], "dry-run-passed")
        self.assertEqual(project_sha256(project_path), before_hash)
        applied = apply_package(project_path, package_path, dry_run=False)
        self.assertEqual(applied["status"], "applied")
        self.assertNotEqual(project_sha256(project_path), before_hash)
        snapshots = list_history(project_path)["snapshots"]
        self.assertEqual(len(snapshots), 1)
        restored = restore_history(
            project_path,
            self.root / snapshots[0]["path"],
            expected_current_sha256=applied["afterSha256"],
        )
        self.assertEqual(restored["afterSha256"], before_hash)

    def test_stale_package_is_rejected(self) -> None:
        project_path = self._project()
        package_path = self.root / "stale.json"
        atomic_write_json(
            package_path,
            {
                "format": "fivecut-command-package",
                "version": "1.0.0",
                "packageId": "package:stale",
                "baseProjectSha256": "0" * 64,
                "operations": [
                    {
                        "id": "operation:rename",
                        "op": "project.update",
                        "patch": {"name": "Must not apply"},
                    }
                ],
            },
        )
        with self.assertRaisesRegex(FiveCutError, "Project changed"):
            apply_package(project_path, package_path, dry_run=False)
        self.assertEqual(load_json(project_path)["project"]["name"], "Contract test")

    def test_duplicate_command_ids_are_invalid(self) -> None:
        issues = validate_command_package(
            {
                "format": "fivecut-command-package",
                "version": "1.0.0",
                "packageId": "package:duplicate",
                "operations": [
                    {
                        "id": "same",
                        "op": "project.update",
                        "patch": {"name": "One"},
                    },
                    {
                        "id": "same",
                        "op": "project.update",
                        "patch": {"name": "Two"},
                    },
                ],
            }
        )
        self.assertTrue(any(issue.code == "DUPLICATE_OPERATION_ID" for issue in issues))

    def test_missing_asset_is_reported(self) -> None:
        project_path = self._project()
        (self.root / "image.png").unlink()
        issues = validate_project(
            load_json(project_path),
            project_path=project_path,
            check_files=True,
        )
        self.assertTrue(errors(issues))
        self.assertTrue(any(issue.code == "MISSING_ASSET" for issue in issues))

    def test_freeze_frame_requires_an_in_range_video_timestamp(self) -> None:
        project_path = self._project()
        project = load_json(project_path)
        clip = project["tracks"][0]["clips"][0]
        clip["freezeFrameSourceTime"] = 0.5
        issues = validate_project(project, project_path=project_path, check_files=False)
        self.assertTrue(
            any(issue.code == "FREEZE_FRAME_REQUIRES_VIDEO" for issue in issues)
        )

        project["assets"][0]["kind"] = "video"
        project["assets"][0]["duration"] = 1
        clip["freezeFrameSourceTime"] = 1
        issues = validate_project(project, project_path=project_path, check_files=False)
        self.assertTrue(
            any(issue.code == "FREEZE_FRAME_OUT_OF_RANGE" for issue in issues)
        )


@unittest.skipUnless(
    shutil.which("ffmpeg") and shutil.which("ffprobe"),
    "FFmpeg integration test",
)
class AgentRenderTests(unittest.TestCase):
    def test_render_effects_caption_keyframes_and_qc(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fivecut-render-") as temporary:
            root = Path(temporary)
            source = root / "source.mp4"
            subprocess.run(
                [
                    str(shutil.which("ffmpeg")),
                    "-hide_banner",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=320x180:rate=24:duration=1",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=48000:duration=1",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-shortest",
                    str(source),
                ],
                check=True,
            )
            _init_project(
                root,
                name="Render test",
                project_file="fivecut.project.json",
                width=None,
                height=None,
                fps=None,
                auto_sequence=True,
                force=False,
            )
            project_path = root / "fivecut.project.json"
            project = load_json(project_path)
            video_clip = project["tracks"][0]["clips"][0]
            video_clip["transitionIn"] = {"type": "fade", "duration": 0.2}
            video_clip["effects"] = [
                {
                    "id": "effect:warm",
                    "type": "color-grade",
                    "params": {
                        "brightness": 0.02,
                        "contrast": 1.05,
                        "saturation": 1.1,
                    },
                }
            ]
            video_clip["keyframes"] = [
                {
                    "id": "keyframe:move-start",
                    "property": "transform.positionX",
                    "time": 0,
                    "value": -5,
                    "interpolation": "ease-in-out",
                },
                {
                    "id": "keyframe:move-end",
                    "property": "transform.positionX",
                    "time": 1,
                    "value": 5,
                    "interpolation": "ease-in-out",
                },
            ]
            project["tracks"][0]["clips"].append(
                {
                    "id": "clip:freeze",
                    "type": "media",
                    "assetId": video_clip["assetId"],
                    "start": 1,
                    "duration": 1,
                    "freezeFrameSourceTime": 0.5,
                    "includeSourceAudio": False,
                }
            )
            project["tracks"][2]["clips"].append(
                {
                    "id": "caption:test",
                    "type": "caption",
                    "text": "FiveCut test",
                    "start": 0.1,
                    "duration": 0.8,
                    "style": {
                        "fontFamily": "DejaVu Sans",
                        "fontSize": 24,
                        "fontWeight": "bold",
                        "color": "#FFFFFF",
                        "outlineColor": "#000000",
                        "outlineWidth": 2,
                        "alignment": "center",
                        "position": "bottom",
                        "marginY": 20,
                    },
                }
            )
            atomic_write_json(project_path, project)
            rendered = render_project(project_path)
            self.assertEqual(rendered["status"], "rendered")
            self.assertTrue(Path(rendered["output"]).is_file())
            qc = qc_project(project_path, quick=True)
            self.assertEqual(qc["status"], "passed")
            self.assertEqual(qc["errorCount"], 0)


if __name__ == "__main__":
    unittest.main()
