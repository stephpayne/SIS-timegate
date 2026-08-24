from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from collections import Counter
from pathlib import Path


INSTALLER_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = INSTALLER_DIR.parent
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(INSTALLER_DIR))

from course_descriptor import DescriptorError, extract_course_descriptor  # noqa: E402
from instrument_package import (  # noqa: E402
    InstrumentationError,
    instrument_package,
)
from timegate_config import derive_timegate_course_key  # noqa: E402


def _write_synthetic_package(root: Path) -> None:
    (root / "scormdriver").mkdir(parents=True)
    (root / "scormcontent" / "lib" / "dist").mkdir(parents=True)
    manifest = """<?xml version="1.0"?>
<manifest identifier="manifest-package-v1"
 xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
 xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="org"><organization identifier="org">
    <title>Synthetic Course</title>
  </organization></organizations>
  <resources><resource identifier="sco" type="webcontent"
    adlcp:scormtype="sco" href="scormdriver/indexAPI.html">
    <file href="scormdriver/indexAPI.html" />
    <file href="scormcontent/index.html" />
  </resource></resources>
</manifest>
"""
    driver = """<!doctype html>
<html><head>
<script id="__DRIVER_CONFIG__" type="application/json">
{"coursePackageVersion":"driver-v1","lmsTarget":"scorm12","resetLearnerData":false,
"quizId":null,"storylineId":null,"completionPercentage":100,
"reporting":"completed-incomplete"}
</script>
<script src="driverOptions.js"></script>
<script src="lms-interface.js"></script>
<script src="course-start.js"></script>
</head><body></body></html>
"""
    content = """<!doctype html>
<html><head>
  <script src="lib/dist/bootstrap123.js"></script>
</head><body><div id="app"></div></body></html>
"""
    runtime = {
        "course": {
            "id": "rise-course-id",
            "title": "Do not copy this authored title",
            "author": "SECRET-AUTHOR",
            "tenantId": "SECRET-TENANT",
            "navigationMode": "free",
            "lessons": [
                {
                    "id": "lesson-1",
                    "type": "blocks",
                    "title": "Authored lesson title",
                    "items": [
                        {
                            "id": "video-block",
                            "type": "multimedia",
                            "family": "multimedia",
                            "variant": "video",
                            "settings": {"forwardSeekRestricted": True},
                            "items": [
                                {
                                    "id": "video-item",
                                    "media": {
                                        "video": {
                                            "duration": 12,
                                            "key": "SECRET-FILENAME.mp4",
                                        }
                                    },
                                }
                            ],
                        },
                        {
                            "id": "continue-block",
                            "type": "divider",
                            "family": "continue",
                            "variant": "continue",
                            "items": [{"id": "complete-item", "type": ""}],
                        },
                    ],
                },
                {
                    "id": "quiz-1",
                    "type": "quiz",
                    "settings": {
                        "passingScore": 80,
                        "retryCount": "-1",
                        "passToContinue": True,
                    },
                    "items": [
                        {
                            "id": "question-1",
                            "type": "MULTIPLE_CHOICE",
                            "title": "SECRET-QUESTION",
                            "answers": [
                                {
                                    "id": "answer-1",
                                    "title": "SECRET-ANSWER",
                                    "correct": True,
                                }
                            ],
                            "correct": "answer-1",
                        }
                    ],
                },
            ],
        },
        "settings": {
            "coursePackageVersion": "runtime-v0",
            "exporterAuthId": "SECRET-EXPORTER",
            "s3Metadata": {"tenant-id": "SECRET-TENANT"},
        },
    }
    encoded_runtime = base64.b64encode(
        json.dumps(runtime, separators=(",", ":")).encode()
    ).decode()
    (root / "imsmanifest.xml").write_text(manifest, encoding="utf-8")
    (root / "scormdriver" / "indexAPI.html").write_text(driver, encoding="utf-8")
    (root / "scormdriver" / "driverOptions.js").write_text(
        "function loadDriverOptions(scope) { scope.FORCED_COMMIT_TIME = 20000; }\n",
        encoding="utf-8",
    )
    (root / "scormdriver" / "lms-interface.js").write_text("", encoding="utf-8")
    (root / "scormdriver" / "course-start.js").write_text("", encoding="utf-8")
    (root / "scormcontent" / "index.html").write_text(content, encoding="utf-8")
    (root / "scormcontent" / "runtime-data.js").write_text(
        f'__jsonp("runtime-data.js","{encoded_runtime}");\n',
        encoding="utf-8",
    )
    (root / "scormcontent" / "lib" / "dist" / "bootstrap123.js").write_text(
        "", encoding="utf-8"
    )


def _write_synthetic_scorm_2004_package(root: Path) -> None:
    _write_synthetic_package(root)
    manifest_path = root / "imsmanifest.xml"
    manifest_path.write_text(
        """<?xml version="1.0"?>
<manifest identifier="manifest-package-2004-v1" version="1.3"
 xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
 xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>2004 4th Edition</schemaversion>
  </metadata>
  <organizations default="org"><organization identifier="org">
    <title>Synthetic SCORM 2004 Course</title>
  </organization></organizations>
  <resources><resource identifier="sco" type="webcontent"
    adlcp:scormType="sco" href="scormdriver/indexAPI.html">
    <file href="scormdriver/indexAPI.html" />
    <file href="scormcontent/index.html" />
  </resource></resources>
</manifest>
""",
        encoding="utf-8",
    )
    driver_path = root / "scormdriver" / "indexAPI.html"
    driver_path.write_text(
        driver_path.read_text(encoding="utf-8").replace(
            '"lmsTarget":"scorm12"', '"lmsTarget":"scorm2004_4"'
        ),
        encoding="utf-8",
    )


class CourseDescriptorTests(unittest.TestCase):
    def test_missing_required_metadata_fails_before_instrumentation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _write_synthetic_package(root)
            manifest_path = root / "imsmanifest.xml"
            manifest_path.write_text(
                manifest_path.read_text().replace(
                    'identifier="manifest-package-v1"', 'identifier=""', 1
                ),
                encoding="utf-8",
            )
            driver_path = root / "scormdriver" / "indexAPI.html"
            driver_before = driver_path.read_bytes()

            with self.assertRaisesRegex(
                DescriptorError,
                "manifestIdentifier must be a non-empty string",
            ):
                instrument_package(
                    root,
                    PROJECT_ROOT,
                    "https://worker.example.test/ingestScormTelemetry",
                    "rise-pilot",
                    "pilot-token-12345",
                    "paycom-course-123",
                )

            self.assertEqual(driver_path.read_bytes(), driver_before)
            self.assertFalse((root / "timegate").exists())

    def test_minimized_descriptor_is_stable_and_excludes_authored_content(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _write_synthetic_package(root)
            first = extract_course_descriptor(root)
            second = extract_course_descriptor(root)
            driver_path = root / "scormdriver" / "indexAPI.html"
            driver_path.write_text(
                driver_path.read_text().replace("driver-v1", "driver-v2"),
                encoding="utf-8",
            )
            reexported = extract_course_descriptor(root)

        self.assertEqual(first, second)
        self.assertEqual(first["packageVersion"], "driver-v1")
        self.assertEqual(reexported["packageVersion"], "driver-v2")
        self.assertEqual(first["structureHash"], reexported["structureHash"])
        self.assertEqual(first["completionPolicy"]["triggerType"], "progress")
        self.assertEqual(first["forcedCommitIntervalSeconds"], 20)
        self.assertEqual(first["lessons"][1]["quiz"]["retryLimit"], None)
        self.assertEqual(
            [warning["code"] for warning in first["warnings"]],
            [
                "PACKAGE_VERSION_MISMATCH",
                "QUIZ_PRESENT_NOT_COMPLETION_TRIGGER",
            ],
        )
        serialized = json.dumps(first)
        for prohibited in (
            "SECRET-AUTHOR",
            "SECRET-TENANT",
            "SECRET-EXPORTER",
            "SECRET-FILENAME",
            "SECRET-QUESTION",
            "SECRET-ANSWER",
        ):
            self.assertNotIn(prohibited, serialized)

    def test_attached_sample_matches_minimized_contract(self) -> None:
        configured = os.environ.get("SCORM_SAMPLE_ROOT")
        if not configured:
            self.skipTest("Set SCORM_SAMPLE_ROOT to run the attached-sample contract")
        sample = Path(configured)
        if not sample.is_dir():
            self.skipTest(f"SCORM_SAMPLE_ROOT does not exist: {sample}")

        with tempfile.TemporaryDirectory() as directory:
            sample_copy = Path(directory) / "sample-course"
            shutil.copytree(sample, sample_copy)
            descriptor = extract_course_descriptor(sample_copy)
        contract = json.loads(
            (FIXTURE_DIR / "fire-safety-descriptor-contract.json").read_text()
        )
        blocks = [
            block
            for lesson in descriptor["lessons"]
            for block in lesson["blocks"]
        ]
        media = [
            {
                "type": asset["type"],
                "durationSeconds": asset.get("durationSeconds"),
                "forwardSeekRestricted": block["forwardSeekRestricted"],
            }
            for block in blocks
            for asset in block["media"]
        ]
        quiz = next(
            lesson["quiz"]
            for lesson in descriptor["lessons"]
            if "quiz" in lesson
        )
        actual = {
            "blockCount": len(blocks),
            "completionPolicy": {
                key: descriptor["completionPolicy"][key]
                for key in (
                    "completionPercentage",
                    "reporting",
                    "triggerId",
                    "triggerType",
                )
            },
            "continueGateCount": sum(
                len(block["continueGates"]) for block in blocks
            ),
            "forcedCommitIntervalSeconds": descriptor[
                "forcedCommitIntervalSeconds"
            ],
            "lessonTypeCounts": dict(
                Counter(lesson["type"] for lesson in descriptor["lessons"])
            ),
            "media": media,
            "navigationMode": descriptor["navigationMode"],
            "packageVersion": descriptor["packageVersion"],
            "quiz": {
                key: quiz[key]
                for key in (
                    "passingScore",
                    "questionCount",
                    "unlimitedRetries",
                )
            },
            "riseCourseId": descriptor["riseCourseId"],
            "runtimePackageVersion": descriptor["runtimePackageVersion"],
            "scormVersion": descriptor["scormVersion"],
            "structureHash": descriptor["structureHash"],
            "warningCodes": [
                warning["code"] for warning in descriptor["warnings"]
            ],
        }
        self.assertEqual(actual, contract)


class PackageInstrumentationTests(unittest.TestCase):
    def test_worker_credential_limits_are_enforced_before_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(
                InstrumentationError, "Source-key ID must contain 1 to 64"
            ):
                instrument_package(
                    root,
                    PROJECT_ROOT,
                    "https://worker.example.test/ingestScormTelemetry",
                    "x" * 65,
                    "pilot-token-12345",
                    "paycom-course-123",
                )
            with self.assertRaisesRegex(
                InstrumentationError, "Pilot token must contain 16 to 512"
            ):
                instrument_package(
                    root,
                    PROJECT_ROOT,
                    "https://worker.example.test/ingestScormTelemetry",
                    "rise-pilot",
                    "too-short",
                    "paycom-course-123",
                )
            self.assertEqual(list(root.iterdir()), [])

    def test_partial_observability_footprint_is_rejected_without_writes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _write_synthetic_package(root)
            partial_asset = (
                root / "timegate" / "observability" / "host.js"
            )
            partial_asset.parent.mkdir(parents=True)
            partial_asset.write_text("partial", encoding="utf-8")
            driver_path = root / "scormdriver" / "indexAPI.html"
            driver_before = driver_path.read_bytes()

            with self.assertRaisesRegex(
                InstrumentationError, "partially instrumented"
            ):
                instrument_package(
                    root,
                    PROJECT_ROOT,
                    "https://worker.example.test/ingestScormTelemetry",
                    "rise-pilot",
                    "pilot-token-12345",
                    "paycom-course-123",
                )

            self.assertEqual(driver_path.read_bytes(), driver_before)
            self.assertFalse(
                (
                    root
                    / "timegate"
                    / "observability"
                    / "content-probe.js"
                ).exists()
            )

    def test_complete_timegate_install_is_extended_and_config_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _write_synthetic_package(root)
            timegate_dir = root / "timegate"
            timegate_dir.mkdir()
            shutil.copyfile(
                PROJECT_ROOT / "src" / "timegate.js",
                timegate_dir / "timegate.js",
            )
            shutil.copyfile(
                PROJECT_ROOT / "src" / "timegate.css",
                timegate_dir / "timegate.css",
            )
            existing_config = '{"minRequiredMinutes":42,"debug":true}\n'
            (timegate_dir / "timegate.config.json").write_text(
                existing_config, encoding="utf-8"
            )
            driver_path = root / "scormdriver" / "indexAPI.html"
            driver = driver_path.read_text()
            driver = driver.replace(
                '<script src="lms-interface.js"></script>',
                '<script src="lms-interface.js"></script>\n'
                '<link rel="stylesheet" href="../timegate/timegate.css" '
                'data-timegate="true">\n'
                '<script src="../timegate/timegate.js" '
                'data-timegate="true"></script>',
            )
            driver_path.write_text(driver, encoding="utf-8")
            manifest_path = root / "imsmanifest.xml"
            manifest = manifest_path.read_text()
            manifest = manifest.replace(
                "</resource>",
                '<file href="timegate/timegate.js" />\n'
                '<file href="timegate/timegate.css" />\n'
                '<file href="timegate/timegate.config.json" />\n'
                "</resource>",
            )
            manifest_path.write_text(manifest, encoding="utf-8")

            instrument_package(
                root,
                PROJECT_ROOT,
                "https://worker.example.test/ingestScormTelemetry",
                "rise-pilot",
                "pilot-token-12345",
                "paycom-course-123",
            )

            installed_config = json.loads(
                (timegate_dir / "timegate.config.json").read_text()
            )
            self.assertEqual(installed_config["minRequiredMinutes"], 42)
            self.assertIs(installed_config["debug"], True)
            self.assertRegex(
                installed_config["courseKey"],
                r"^tg-pkg-v1-[0-9a-f]{64}$",
            )
            updated_driver = driver_path.read_text()
            self.assertLess(
                updated_driver.index('data-sis-observability="host"'),
                updated_driver.index('data-timegate="true"'),
            )
            self.assertLess(
                updated_driver.index('data-timegate="true"'),
                updated_driver.index('src="course-start.js"'),
            )

    def test_complete_footprint_with_stale_asset_references_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _write_synthetic_package(root)
            timegate_dir = root / "timegate"
            timegate_dir.mkdir()
            for name in ("timegate.js", "timegate.css", "timegate.config.json"):
                shutil.copyfile(PROJECT_ROOT / "src" / name, timegate_dir / name)

            driver_path = root / "scormdriver" / "indexAPI.html"
            driver = driver_path.read_text()
            driver = driver.replace(
                "</head>",
                '<link data-timegate="true" rel="stylesheet" '
                'href="../stale/timegate.css">\n'
                '<script data-timegate="true" '
                'src="../stale/timegate.js"></script>\n'
                "</head>",
            )
            driver_path.write_text(driver, encoding="utf-8")
            manifest_path = root / "imsmanifest.xml"
            manifest = manifest_path.read_text().replace(
                "</resource>",
                '<file href="timegate/timegate.js" />\n'
                '<file href="timegate/timegate.css" />\n'
                '<file href="timegate/timegate.config.json" />\n'
                "</resource>",
            )
            manifest_path.write_text(manifest, encoding="utf-8")
            driver_before = driver_path.read_bytes()

            with self.assertRaisesRegex(
                InstrumentationError, "partial Timegate installation"
            ):
                instrument_package(
                    root,
                    PROJECT_ROOT,
                    "https://worker.example.test/ingestScormTelemetry",
                    "rise-pilot",
                    "pilot-token-12345",
                    "paycom-course-123",
                )

            self.assertEqual(driver_path.read_bytes(), driver_before)
            self.assertFalse((timegate_dir / "observability").exists())

            deferred_driver = driver_path.read_text().replace(
                "../stale/timegate.css", "../timegate/timegate.css"
            ).replace(
                "../stale/timegate.js", "../timegate/timegate.js"
            ).replace(
                '<script data-timegate="true" ',
                '<script data-timegate="true" defer ',
            )
            driver_path.write_text(deferred_driver, encoding="utf-8")
            deferred_before = driver_path.read_bytes()
            with self.assertRaisesRegex(
                InstrumentationError,
                "Timegate runtime must execute synchronously",
            ):
                instrument_package(
                    root,
                    PROJECT_ROOT,
                    "https://worker.example.test/ingestScormTelemetry",
                    "rise-pilot",
                    "pilot-token-12345",
                    "paycom-course-123",
                )
            self.assertEqual(driver_path.read_bytes(), deferred_before)
            self.assertFalse((timegate_dir / "observability").exists())

    def test_deferred_lms_bootstrap_is_rejected_before_writes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _write_synthetic_package(root)
            driver_path = root / "scormdriver" / "indexAPI.html"
            driver_path.write_text(
                driver_path.read_text().replace(
                    '<script src="lms-interface.js"></script>',
                    '<script defer src="lms-interface.js"></script>',
                ),
                encoding="utf-8",
            )
            driver_before = driver_path.read_bytes()

            with self.assertRaisesRegex(
                InstrumentationError,
                "lms-interface.js must execute synchronously",
            ):
                instrument_package(
                    root,
                    PROJECT_ROOT,
                    "https://worker.example.test/ingestScormTelemetry",
                    "rise-pilot",
                    "pilot-token-12345",
                    "paycom-course-123",
                )

            self.assertEqual(driver_path.read_bytes(), driver_before)
            self.assertFalse((root / "timegate").exists())

    def test_semantically_invalid_timegate_configs_are_rejected_before_writes(
        self,
    ) -> None:
        cases = (
            (
                "numeric string",
                {"minRequiredMinutes": 1, "idleTimeoutSeconds": "oops"},
                "idleTimeoutSeconds must be a number",
            ),
            (
                "zero idle timeout",
                {"minRequiredMinutes": 1, "idleTimeoutSeconds": 0},
                "idleTimeoutSeconds must be between 1 and 3600",
            ),
            (
                "boolean string",
                {"minRequiredMinutes": 1, "enforceCompletion": "false"},
                "enforceCompletion must be true or false",
            ),
            (
                "unknown storage mode",
                {"minRequiredMinutes": 1, "storageMode": "remote"},
                "storageMode must be one of",
            ),
            (
                "inverted limits",
                {"minRequiredMinutes": 20, "maxAllowedMinutes": 20},
                "maxAllowedMinutes must be greater",
            ),
            (
                "misspelled setting",
                {"minRequiredMinutes": 1, "enforceCompletions": True},
                "contains unsupported fields",
            ),
            (
                "missing floor",
                {"enforceCompletion": True},
                "minRequiredMinutes is required",
            ),
        )
        for label, config, expected_error in cases:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                root = Path(directory) / "course"
                root.mkdir()
                _write_synthetic_package(root)
                custom_config = Path(directory) / "timegate.json"
                custom_config.write_text(json.dumps(config), encoding="utf-8")
                driver_path = root / "scormdriver" / "indexAPI.html"
                driver_before = driver_path.read_bytes()

                with self.assertRaisesRegex(
                    InstrumentationError, expected_error
                ):
                    instrument_package(
                        root,
                        PROJECT_ROOT,
                        "https://worker.example.test/ingestScormTelemetry",
                        "rise-pilot",
                        "pilot-token-12345",
                        "paycom-course-123",
                        custom_config,
                    )

                self.assertEqual(driver_path.read_bytes(), driver_before)
                self.assertFalse((root / "timegate").exists())

    def test_powershell_config_validator_rejects_boolean_and_enum_strings(
        self,
    ) -> None:
        powershell = (
            shutil.which("pwsh")
            or shutil.which("powershell.exe")
            or shutil.which("powershell")
        )
        if powershell is None:
            self.skipTest("PowerShell is not installed")

        cases = (
            (
                {"minRequiredMinutes": 1, "enforceCompletion": "false"},
                "enforceCompletion must be true or false",
            ),
            (
                {"minRequiredMinutes": 1, "storageMode": "remote"},
                "storageMode must be one of",
            ),
            (
                [{"minRequiredMinutes": 1}],
                "must contain a JSON object",
            ),
        )
        command = (
            "& { param($supportPath, $configPath, $expected) "
            ". $supportPath; try { Assert-TimegateConfig $configPath; exit 2 } "
            "catch { if ($_.Exception.Message -notmatch $expected) { "
            "Write-Error $_; exit 3 }; exit 0 } }"
        )
        with tempfile.TemporaryDirectory() as directory:
            for index, (config, expected) in enumerate(cases):
                with self.subTest(expected=expected):
                    config_path = Path(directory) / f"invalid-{index}.json"
                    config_path.write_text(
                        json.dumps(config), encoding="utf-8"
                    )
                    result = subprocess.run(
                        [
                            powershell,
                            "-NoProfile",
                            "-NonInteractive",
                            "-Command",
                            command,
                            str(INSTALLER_DIR / "timegate_config.ps1"),
                            str(config_path),
                            expected,
                        ],
                        check=False,
                        capture_output=True,
                        text=True,
                    )
                    self.assertEqual(
                        result.returncode,
                        0,
                        f"stdout:\n{result.stdout}\n"
                        f"stderr:\n{result.stderr}",
                    )

    def test_instrumentation_contract_and_duplicate_rejection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "course"
            root.mkdir()
            _write_synthetic_package(root)
            custom_config = Path(directory) / "timegate.json"
            custom_config.write_text(
                '{"minRequiredMinutes":7,"maxAllowedMinutes":20}\n',
                encoding="utf-8",
            )

            descriptor = instrument_package(
                root,
                PROJECT_ROOT,
                "https://worker.example.test/ingestScormTelemetry",
                "rise-pilot",
                "pilot-1234567890</script><script>alert(1)</script>",
                "paycom-course-123",
                custom_config,
            )
            driver = (root / "scormdriver" / "indexAPI.html").read_text()
            content = (root / "scormcontent" / "index.html").read_text()
            manifest = (root / "imsmanifest.xml").read_text()

            self.assertEqual(descriptor["paycomCourseId"], "paycom-course-123")
            self.assertLess(
                driver.index("lms-interface.js"),
                driver.index('data-sis-observability="host"'),
            )
            self.assertLess(
                driver.index('data-sis-observability="host"'),
                driver.index('data-timegate="true"'),
            )
            self.assertLess(
                driver.index('data-timegate="true"'),
                driver.index('src="course-start.js"'),
            )
            host_tag = next(
                line
                for line in driver.splitlines()
                if 'data-sis-observability="host"' in line
            )
            timegate_tag = next(
                line
                for line in driver.splitlines()
                if "<script" in line and 'data-timegate="true"' in line
            )
            self.assertNotIn(" defer", host_tag)
            self.assertNotIn(" async", host_tag)
            self.assertNotIn(" defer", timegate_tag)
            self.assertNotIn(" async", timegate_tag)
            self.assertLess(
                content.index('data-sis-observability="content-probe"'),
                content.index("lib/dist/bootstrap123.js"),
            )
            self.assertNotIn("</script><script>alert(1)", driver)
            self.assertIn(r"pilot-1234567890\u003c/script\u003e", driver)
            config_match = re.search(
                r"window\.__SIS_OBSERVABILITY_CONFIG__ = (\{.*\});",
                driver,
            )
            self.assertIsNotNone(config_match)
            config = json.loads(config_match.group(1))
            self.assertEqual(config["course"], descriptor)
            self.assertEqual(config["source"]["keyId"], "rise-pilot")
            self.assertEqual(config["corsFallbackBaseDelayMs"], 15_000)
            self.assertEqual(config["corsFallbackJitterMs"], 5_000)
            self.assertEqual(
                config["source"]["token"],
                "pilot-1234567890</script><script>alert(1)</script>",
            )
            installed_timegate_config = json.loads(
                (root / "timegate" / "timegate.config.json").read_text()
            )
            self.assertEqual(
                installed_timegate_config["minRequiredMinutes"], 7
            )
            self.assertEqual(
                installed_timegate_config["maxAllowedMinutes"], 20
            )
            self.assertRegex(
                installed_timegate_config["courseKey"],
                r"^tg-pkg-v1-[0-9a-f]{64}$",
            )
            for href in (
                "timegate/timegate.js",
                "timegate/timegate.css",
                "timegate/timegate.config.json",
                "timegate/observability/host.js",
                "timegate/observability/content-probe.js",
            ):
                self.assertEqual(manifest.count(f'href="{href}"'), 1)
                self.assertTrue((root / href).is_file())

            driver_before_replay = (
                root / "scormdriver" / "indexAPI.html"
            ).read_bytes()
            with self.assertRaisesRegex(
                InstrumentationError, "already instrumented"
            ):
                instrument_package(
                    root,
                    PROJECT_ROOT,
                    "https://worker.example.test/ingestScormTelemetry",
                    "rise-pilot",
                    "pilot-token-12345",
                    "paycom-course-123",
                )
            self.assertEqual(
                (root / "scormdriver" / "indexAPI.html").read_bytes(),
                driver_before_replay,
            )

    def test_generated_course_key_is_stable_specific_and_preserves_explicit_key(
        self,
    ) -> None:
        def package(directory: Path, name: str, version: str = "driver-v1") -> str:
            root = directory / name
            root.mkdir()
            _write_synthetic_package(root)
            if version != "driver-v1":
                driver_path = root / "scormdriver" / "indexAPI.html"
                driver_path.write_text(
                    driver_path.read_text().replace("driver-v1", version),
                    encoding="utf-8",
                )
            instrument_package(
                root,
                PROJECT_ROOT,
                "https://worker.example.test/ingestScormTelemetry",
                "rise-pilot",
                "pilot-token-12345",
                "paycom-course-123",
            )
            config = json.loads(
                (root / "timegate" / "timegate.config.json").read_text()
            )
            return config["courseKey"]

        with tempfile.TemporaryDirectory() as directory:
            temp_root = Path(directory)
            first_key = package(temp_root, "first-copy")
            second_key = package(temp_root, "second-copy")
            newer_key = package(temp_root, "newer-package", "driver-v2")

            self.assertRegex(first_key, r"^tg-pkg-v1-[0-9a-f]{64}$")
            self.assertEqual(first_key, second_key)
            self.assertNotEqual(first_key, newer_key)

            explicit_root = temp_root / "explicit-key"
            explicit_root.mkdir()
            _write_synthetic_package(explicit_root)
            explicit_config = temp_root / "explicit.json"
            explicit_config.write_text(
                '{"minRequiredMinutes":7,'
                '"courseKey":"publisher-selected-key"}\n',
                encoding="utf-8",
            )
            instrument_package(
                explicit_root,
                PROJECT_ROOT,
                "https://worker.example.test/ingestScormTelemetry",
                "rise-pilot",
                "pilot-token-12345",
                "paycom-course-123",
                explicit_config,
            )
            self.assertEqual(
                json.loads(
                    (
                        explicit_root
                        / "timegate"
                        / "timegate.config.json"
                    ).read_text()
                )["courseKey"],
                "publisher-selected-key",
            )

    def test_posix_packager_creates_timegate_zip(self) -> None:
        if shutil.which("zip") is None:
            self.skipTest("zip is not installed")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "synthetic-course"
            root.mkdir()
            _write_synthetic_package(root)
            environment = {
                **os.environ,
                "SCORM_TELEMETRY_ENDPOINT": (
                    "https://worker.example.test/ingestScormTelemetry"
                ),
                "SCORM_SOURCE_KEY_ID": "rise-pilot",
                "SCORM_PILOT_TOKEN": "pilot-token-12345",
                "PAYCOM_COURSE_ID": "paycom-course-123",
            }
            result = subprocess.run(
                [str(INSTALLER_DIR / "install-timegate.sh"), str(root)],
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            output = root.with_name(f"{root.name}-timegate.zip")
            self.assertTrue(output.is_file())

    def test_powershell_packager_accepts_single_sco_scorm_2004_package(
        self,
    ) -> None:
        powershell = (
            shutil.which("pwsh")
            or shutil.which("powershell.exe")
            or shutil.which("powershell")
        )
        if powershell is None:
            self.skipTest("PowerShell is not installed")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "scorm-2004-course"
            root.mkdir()
            _write_synthetic_scorm_2004_package(root)

            result = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-NonInteractive",
                    "-File",
                    str(INSTALLER_DIR / "install-timegate.ps1"),
                    "-Package",
                    str(root),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(
                result.returncode,
                0,
                f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}",
            )

            output = root.with_name(f"{root.name}-timegate.zip")
            self.assertTrue(output.is_file())
            self.assertTrue(zipfile.is_zipfile(output))

            with zipfile.ZipFile(output) as archive:
                self.assertIsNone(archive.testzip())
                entries = archive.namelist()
                self.assertEqual(entries.count("imsmanifest.xml"), 1)
                for asset in (
                    "timegate/timegate.js",
                    "timegate/timegate.css",
                    "timegate/timegate.config.json",
                ):
                    self.assertEqual(entries.count(asset), 1)

                manifest = archive.read("imsmanifest.xml").decode("utf-8-sig")
                driver = (
                    archive.read("scormdriver/indexAPI.html")
                    .decode("utf-8-sig")
                    .replace("\r\n", "\n")
                )

            self.assertIn(
                "<schemaversion>2004 4th Edition</schemaversion>", manifest
            )
            self.assertEqual(manifest.count('adlcp:scormType="sco"'), 1)
            for asset in (
                "timegate/timegate.js",
                "timegate/timegate.css",
                "timegate/timegate.config.json",
            ):
                self.assertEqual(manifest.count(f'href="{asset}"'), 1)
            self.assertEqual(
                driver.count('href="../timegate/timegate.css"'), 1
            )
            self.assertEqual(driver.count('src="../timegate/timegate.js"'), 1)

            self.assertIn(
                '<script src="lms-interface.js"></script>\n'
                '  <link rel="stylesheet" '
                'href="../timegate/timegate.css" data-timegate="true">\n'
                '  <script src="../timegate/timegate.js" '
                'data-timegate="true"></script>\n'
                '<script src="course-start.js"></script>',
                driver,
            )
            timegate_tag = re.search(
                r'<script\b[^>]*\bdata-timegate="true"[^>]*>', driver
            )
            self.assertIsNotNone(timegate_tag)
            self.assertNotRegex(timegate_tag.group(0), r"\s(?:async|defer)\b")

    def test_powershell_packager_rejects_stale_markers_and_invalid_config(self) -> None:
        powershell = (
            shutil.which("pwsh")
            or shutil.which("powershell.exe")
            or shutil.which("powershell")
        )
        if powershell is None:
            self.skipTest("PowerShell is not installed")

        with tempfile.TemporaryDirectory() as directory:
            stale_root = Path(directory) / "stale-course"
            stale_root.mkdir()
            _write_synthetic_package(stale_root)
            stale_driver = stale_root / "scormdriver" / "indexAPI.html"
            stale_driver.write_text(
                stale_driver.read_text().replace(
                    "</head>",
                    '<link data-timegate="true" rel="stylesheet" '
                    'href="../stale/timegate.css">\n'
                    '<script data-timegate="true" '
                    'src="../stale/timegate.js"></script>\n'
                    "</head>",
                ),
                encoding="utf-8",
            )
            stale_before = stale_driver.read_bytes()

            stale_result = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-NonInteractive",
                    "-File",
                    str(INSTALLER_DIR / "install-timegate.ps1"),
                    "-Package",
                    str(stale_root),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(stale_result.returncode, 0)
            self.assertIn("stale, incomplete, or duplicate", stale_result.stdout)
            self.assertEqual(stale_driver.read_bytes(), stale_before)
            self.assertFalse((stale_root / "timegate").exists())
            self.assertFalse(
                stale_root.with_name(f"{stale_root.name}-timegate.zip").exists()
            )

            stale_driver.write_text(
                stale_driver.read_text().replace(
                    "../stale/timegate.css", "../timegate/timegate.css"
                ).replace(
                    "../stale/timegate.js", "../timegate/timegate.js"
                ).replace(
                    '<script data-timegate="true" ',
                    '<script data-timegate="true" defer ',
                ),
                encoding="utf-8",
            )
            deferred_timegate_before = stale_driver.read_bytes()
            deferred_timegate_result = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-NonInteractive",
                    "-File",
                    str(INSTALLER_DIR / "install-timegate.ps1"),
                    "-Package",
                    str(stale_root),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(deferred_timegate_result.returncode, 0)
            self.assertIn(
                "Timegate must execute synchronously",
                deferred_timegate_result.stdout,
            )
            self.assertEqual(
                stale_driver.read_bytes(), deferred_timegate_before
            )
            self.assertFalse((stale_root / "timegate").exists())

            invalid_root = Path(directory) / "invalid-config-course"
            invalid_root.mkdir()
            _write_synthetic_package(invalid_root)
            invalid_config = invalid_root / "timegate" / "timegate.config.json"
            invalid_config.parent.mkdir()
            invalid_config.write_text(
                '{"minRequiredMinutes":1,"idleTimeoutSeconds":"oops"}',
                encoding="utf-8",
            )
            invalid_driver = invalid_root / "scormdriver" / "indexAPI.html"
            invalid_before = invalid_driver.read_bytes()

            invalid_result = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-NonInteractive",
                    "-File",
                    str(INSTALLER_DIR / "install-timegate.ps1"),
                    "-Package",
                    str(invalid_root),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(invalid_result.returncode, 0)
            self.assertIn("Invalid Timegate configuration", invalid_result.stdout)
            self.assertIn("idleTimeoutSeconds must be a number", invalid_result.stdout)
            self.assertEqual(invalid_driver.read_bytes(), invalid_before)
            self.assertFalse((invalid_root / "timegate" / "timegate.js").exists())
            self.assertFalse(
                invalid_root.with_name(f"{invalid_root.name}-timegate.zip").exists()
            )

            deferred_root = Path(directory) / "deferred-lms-course"
            deferred_root.mkdir()
            _write_synthetic_package(deferred_root)
            deferred_driver = deferred_root / "scormdriver/indexAPI.html"
            deferred_driver.write_text(
                deferred_driver.read_text().replace(
                    '<script src="lms-interface.js"></script>',
                    '<script async src="lms-interface.js"></script>',
                ),
                encoding="utf-8",
            )
            deferred_before = deferred_driver.read_bytes()
            deferred_result = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-NonInteractive",
                    "-File",
                    str(INSTALLER_DIR / "install-timegate.ps1"),
                    "-Package",
                    str(deferred_root),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(deferred_result.returncode, 0)
            self.assertIn(
                "lms-interface.js must appear exactly once and execute synchronously",
                deferred_result.stdout,
            )
            self.assertEqual(deferred_driver.read_bytes(), deferred_before)
            self.assertFalse((deferred_root / "timegate").exists())

            multi_root = Path(directory) / "multi-sco-course"
            multi_root.mkdir()
            _write_synthetic_package(multi_root)
            multi_manifest = multi_root / "imsmanifest.xml"
            multi_manifest.write_text(
                multi_manifest.read_text().replace(
                    "</resources>",
                    '<resource identifier="sco-2" type="webcontent" '
                    'adlcp:scormtype="sco" '
                    'href="scormdriver/indexAPI.html"></resource>'
                    "</resources>",
                ),
                encoding="utf-8",
            )
            multi_driver = multi_root / "scormdriver/indexAPI.html"
            multi_before = multi_driver.read_bytes()
            multi_result = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-NonInteractive",
                    "-File",
                    str(INSTALLER_DIR / "install-timegate.ps1"),
                    "-Package",
                    str(multi_root),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(multi_result.returncode, 0)
            self.assertIn(
                "Expected exactly one SCO resource; found 2",
                multi_result.stdout,
            )
            self.assertEqual(multi_driver.read_bytes(), multi_before)
            self.assertFalse((multi_root / "timegate").exists())

    def test_powershell_packager_creates_exact_asset_references(self) -> None:
        powershell = (
            shutil.which("pwsh")
            or shutil.which("powershell.exe")
            or shutil.which("powershell")
        )
        if powershell is None:
            self.skipTest("PowerShell is not installed")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "powershell-course"
            root.mkdir()
            _write_synthetic_package(root)
            descriptor = extract_course_descriptor(root)
            expected_course_key = derive_timegate_course_key(
                manifest_identifier=descriptor["manifestIdentifier"],
                sco_resource_identifier=descriptor[
                    "scoResourceIdentifier"
                ],
                sco_launch_path=descriptor["scoLaunchPath"],
                package_version=descriptor["packageVersion"],
                runtime_data_path=root / "scormcontent/runtime-data.js",
            )
            result = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-NonInteractive",
                    "-File",
                    str(INSTALLER_DIR / "install-timegate.ps1"),
                    "-Package",
                    str(root),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(
                result.returncode,
                0,
                f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}",
            )
            driver = (root / "scormdriver" / "indexAPI.html").read_text()
            self.assertEqual(
                driver.count(
                    'src="../timegate/timegate.js" data-timegate="true"'
                ),
                1,
            )
            self.assertEqual(
                driver.count(
                    'href="../timegate/timegate.css" data-timegate="true"'
                ),
                1,
            )
            self.assertLess(
                driver.index('data-timegate="true"'),
                driver.index('src="course-start.js"'),
            )
            installed_config = json.loads(
                (root / "timegate/timegate.config.json").read_text()
            )
            self.assertEqual(
                installed_config["courseKey"], expected_course_key
            )
            self.assertTrue(
                root.with_name(f"{root.name}-timegate.zip").is_file()
            )

            explicit_root = Path(directory) / "powershell-explicit-key"
            explicit_root.mkdir()
            _write_synthetic_package(explicit_root)
            explicit_config = (
                explicit_root / "timegate/timegate.config.json"
            )
            explicit_config.parent.mkdir()
            explicit_config.write_text(
                '{"minRequiredMinutes":1,'
                '"courseKey":"publisher-selected-key"}\n',
                encoding="utf-8",
            )
            explicit_result = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-NonInteractive",
                    "-File",
                    str(INSTALLER_DIR / "install-timegate.ps1"),
                    "-Package",
                    str(explicit_root),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(
                explicit_result.returncode,
                0,
                f"stdout:\n{explicit_result.stdout}\n"
                f"stderr:\n{explicit_result.stderr}",
            )
            self.assertEqual(
                json.loads(explicit_config.read_text())["courseKey"],
                "publisher-selected-key",
            )


if __name__ == "__main__":
    unittest.main()
