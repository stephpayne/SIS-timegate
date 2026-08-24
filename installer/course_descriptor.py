#!/usr/bin/env python3
"""Extract a privacy-minimized structural descriptor from a Rise SCORM package."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable


DESCRIPTOR_SCHEMA_VERSION = 1


class DescriptorError(ValueError):
    """Raised when a package cannot be described safely."""


class _JsonScriptParser(HTMLParser):
    def __init__(self, script_id: str) -> None:
        super().__init__(convert_charrefs=False)
        self.script_id = script_id
        self.in_target = False
        self.parts: list[str] = []

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        if tag.lower() != "script":
            return
        values = dict(attrs)
        self.in_target = values.get("id") == self.script_id

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "script":
            self.in_target = False

    def handle_data(self, data: str) -> None:
        if self.in_target:
            self.parts.append(data)


def _local_name(value: str) -> str:
    return value.rsplit("}", 1)[-1].lower()


def _attribute(element: ET.Element, name: str) -> str | None:
    wanted = name.lower()
    for key, value in element.attrib.items():
        if _local_name(key) == wanted:
            return value
    return None


def _children(element: ET.Element, name: str) -> Iterable[ET.Element]:
    wanted = name.lower()
    return (child for child in element if _local_name(child.tag) == wanted)


def _first_child_text(element: ET.Element, name: str) -> str | None:
    child = next(_children(element, name), None)
    if child is None or child.text is None:
        return None
    text = child.text.strip()
    return text or None


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise DescriptorError(f"Could not read {path}: {exc}") from exc


def _resolve_inside(package_root: Path, relative_path: str, label: str) -> Path:
    candidate_path = Path(relative_path)
    if candidate_path.is_absolute() or "?" in relative_path or "#" in relative_path:
        raise DescriptorError(f"{label} must be a package-relative file path")
    candidate = (package_root / candidate_path).resolve()
    try:
        candidate.relative_to(package_root)
    except ValueError as exc:
        raise DescriptorError(f"{label} escapes the package root") from exc
    return candidate


def _parse_manifest(package_root: Path) -> dict[str, Any]:
    path = package_root / "imsmanifest.xml"
    try:
        manifest = ET.parse(path).getroot()
    except (OSError, ET.ParseError) as exc:
        raise DescriptorError(f"Could not parse {path}: {exc}") from exc

    metadata = next(_children(manifest, "metadata"), None)
    scorm_version = (
        _first_child_text(metadata, "schemaversion")
        if metadata is not None
        else None
    )
    if scorm_version != "1.2":
        raise DescriptorError(
            f"Only SCORM 1.2 packages are supported; found {scorm_version or 'unknown'}"
        )

    resources = [
        element
        for element in manifest.iter()
        if _local_name(element.tag) == "resource"
        and (_attribute(element, "scormtype") or "").lower() == "sco"
    ]
    if len(resources) != 1:
        raise DescriptorError(
            f"Expected exactly one SCO resource; found {len(resources)}"
        )
    resource = resources[0]
    launch_path = _attribute(resource, "href")
    if not launch_path:
        raise DescriptorError("The SCO resource has no launch href")

    organizations = next(_children(manifest, "organizations"), None)
    organization = None
    if organizations is not None:
        default_id = _attribute(organizations, "default")
        candidates = list(_children(organizations, "organization"))
        organization = next(
            (
                candidate
                for candidate in candidates
                if default_id and _attribute(candidate, "identifier") == default_id
            ),
            candidates[0] if candidates else None,
        )

    return {
        "scormVersion": scorm_version,
        "manifestIdentifier": _attribute(manifest, "identifier") or "",
        "organizationIdentifier": (
            _attribute(organization, "identifier") if organization is not None else ""
        )
        or "",
        "title": (
            _first_child_text(organization, "title")
            if organization is not None
            else None
        )
        or "",
        "scoResourceIdentifier": _attribute(resource, "identifier") or "",
        "scoLaunchPath": launch_path.replace("\\", "/"),
    }


def _parse_json_script(html: str, script_id: str) -> dict[str, Any]:
    parser = _JsonScriptParser(script_id)
    parser.feed(html)
    raw = "".join(parser.parts).strip()
    if not raw:
        raise DescriptorError(f"Could not find JSON script #{script_id}")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise DescriptorError(f"Invalid JSON in script #{script_id}: {exc}") from exc
    if not isinstance(value, dict):
        raise DescriptorError(f"Script #{script_id} must contain a JSON object")
    return value


def _parse_runtime_data(path: Path) -> dict[str, Any]:
    source = _read_text(path)
    match = re.fullmatch(
        r'\s*__jsonp\(\s*["\'][^"\']+["\']\s*,\s*["\']'
        r"(?P<payload>[A-Za-z0-9+/=_-]+)"
        r'["\']\s*\)\s*;?\s*',
        source,
        re.DOTALL,
    )
    if not match:
        raise DescriptorError(f"Unsupported runtime-data wrapper in {path}")
    payload = match.group("payload")
    try:
        decoded = base64.b64decode(payload, altchars=b"-_", validate=True)
        value = json.loads(decoded)
    except (ValueError, json.JSONDecodeError) as exc:
        raise DescriptorError(f"Could not decode {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise DescriptorError(f"Decoded {path} is not a JSON object")
    return value


def _parse_forced_commit_seconds(path: Path) -> int | None:
    source = _read_text(path)
    match = re.search(r"\bFORCED_COMMIT_TIME\s*=\s*(\d+)\b", source)
    if not match:
        return None
    milliseconds = int(match.group(1))
    if milliseconds <= 0 or milliseconds % 1000:
        return None
    return milliseconds // 1000


def _as_string(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _as_number(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def _media_records(value: Any) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []

    def visit(node: Any, owner_id: str = "") -> None:
        if isinstance(node, list):
            for child in node:
                visit(child, owner_id)
            return
        if not isinstance(node, dict):
            return

        current_id = _as_string(node.get("id")) or owner_id
        media = node.get("media")
        if isinstance(media, dict):
            for media_type in ("video", "audio"):
                asset = media.get(media_type)
                if not isinstance(asset, dict):
                    continue
                duration = _as_number(asset.get("duration"))
                record: dict[str, Any] = {
                    "id": current_id,
                    "type": media_type,
                }
                if duration is not None and duration >= 0:
                    record["durationSeconds"] = duration
                found.append(record)
        for child in node.get("items") or []:
            visit(child, current_id)

    visit(value)
    return found


def _continue_gate_records(block: dict[str, Any]) -> list[dict[str, str]]:
    if block.get("family") != "continue" and block.get("variant") != "continue":
        return []
    records: list[dict[str, str]] = []
    for item in block.get("items") or []:
        if not isinstance(item, dict):
            continue
        records.append(
            {
                "id": _as_string(block.get("id")),
                "completionItemId": _as_string(item.get("id")),
            }
        )
    return records


def _block_record(block: dict[str, Any]) -> dict[str, Any]:
    settings = block.get("settings")
    if not isinstance(settings, dict):
        settings = {}
    return {
        "id": _as_string(block.get("id")),
        "type": _as_string(block.get("type")),
        "family": _as_string(block.get("family")),
        "variant": _as_string(block.get("variant")),
        "forwardSeekRestricted": settings.get("forwardSeekRestricted") is True,
        "media": _media_records(block),
        "continueGates": _continue_gate_records(block),
    }


def _quiz_record(lesson: dict[str, Any]) -> dict[str, Any]:
    settings = lesson.get("settings")
    if not isinstance(settings, dict):
        settings = {}
    retry_value = settings.get("retryCount")
    try:
        retry_count = int(retry_value)
    except (TypeError, ValueError):
        retry_count = 0
    unlimited = retry_count < 0
    questions = [
        {
            "id": _as_string(question.get("id")),
            "type": _as_string(question.get("type")),
        }
        for question in (lesson.get("items") or [])
        if isinstance(question, dict)
    ]
    return {
        "id": _as_string(lesson.get("id")),
        "passingScore": _as_number(settings.get("passingScore")),
        "retryLimit": None if unlimited else retry_count,
        "unlimitedRetries": unlimited,
        "passToContinue": settings.get("passToContinue") is True,
        "questionCount": len(questions),
        "questions": questions,
    }


def _lesson_records(runtime: dict[str, Any]) -> list[dict[str, Any]]:
    course = runtime.get("course")
    if not isinstance(course, dict):
        raise DescriptorError("runtime-data.js has no course object")
    lessons = course.get("lessons")
    if not isinstance(lessons, list):
        raise DescriptorError("runtime-data.js has no course lessons")

    records: list[dict[str, Any]] = []
    for lesson in lessons:
        if not isinstance(lesson, dict):
            continue
        lesson_type = _as_string(lesson.get("type"))
        record: dict[str, Any] = {
            "id": _as_string(lesson.get("id")),
            "type": lesson_type,
            "blocks": [],
        }
        if lesson_type == "blocks":
            record["blocks"] = [
                _block_record(block)
                for block in (lesson.get("items") or [])
                if isinstance(block, dict)
            ]
        if lesson_type == "quiz":
            record["quiz"] = _quiz_record(lesson)
        records.append(record)
    return records


def _completion_policy(driver: dict[str, Any]) -> dict[str, Any]:
    quiz_id = driver.get("quizId")
    storyline_id = driver.get("storylineId")
    if isinstance(quiz_id, str) and quiz_id:
        trigger_type, trigger_id = "quiz", quiz_id
    elif isinstance(storyline_id, str) and storyline_id:
        trigger_type, trigger_id = "storyline", storyline_id
    else:
        trigger_type, trigger_id = "progress", None
    return {
        "reporting": _as_string(driver.get("reporting")),
        "completionPercentage": _as_number(driver.get("completionPercentage")),
        "resetLearnerData": driver.get("resetLearnerData") is True,
        "triggerType": trigger_type,
        "triggerId": trigger_id,
    }


def _require_descriptor_string(value: Any, path: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise DescriptorError(
            f"Course descriptor field {path} must be a non-empty string"
        )


def _validate_descriptor_strings(descriptor: dict[str, Any]) -> None:
    for key in (
        "manifestIdentifier",
        "navigationMode",
        "organizationIdentifier",
        "packageVersion",
        "riseCourseId",
        "runtimePackageVersion",
        "scoLaunchPath",
        "scoResourceIdentifier",
        "scormVersion",
        "title",
    ):
        _require_descriptor_string(descriptor.get(key), key)

    completion_policy = descriptor["completionPolicy"]
    for key in ("reporting", "triggerType"):
        _require_descriptor_string(
            completion_policy.get(key), f"completionPolicy.{key}"
        )

    for lesson_index, lesson in enumerate(descriptor["lessons"]):
        lesson_path = f"lessons[{lesson_index}]"
        for key in ("id", "type"):
            _require_descriptor_string(lesson.get(key), f"{lesson_path}.{key}")
        for block_index, block in enumerate(lesson["blocks"]):
            block_path = f"{lesson_path}.blocks[{block_index}]"
            for key in ("family", "id", "type", "variant"):
                _require_descriptor_string(block.get(key), f"{block_path}.{key}")
            for gate_index, gate in enumerate(block["continueGates"]):
                gate_path = f"{block_path}.continueGates[{gate_index}]"
                for key in ("completionItemId", "id"):
                    _require_descriptor_string(gate.get(key), f"{gate_path}.{key}")
            for media_index, media in enumerate(block["media"]):
                media_path = f"{block_path}.media[{media_index}]"
                for key in ("id", "type"):
                    _require_descriptor_string(media.get(key), f"{media_path}.{key}")

        quiz = lesson.get("quiz")
        if isinstance(quiz, dict):
            _require_descriptor_string(quiz.get("id"), f"{lesson_path}.quiz.id")
            for question_index, question in enumerate(quiz["questions"]):
                question_path = (
                    f"{lesson_path}.quiz.questions[{question_index}]"
                )
                for key in ("id", "type"):
                    _require_descriptor_string(
                        question.get(key), f"{question_path}.{key}"
                    )


def _canonical_hash(structure: dict[str, Any]) -> str:
    canonical = json.dumps(
        structure, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def extract_course_descriptor(package_root: Path | str) -> dict[str, Any]:
    root = Path(package_root).resolve()
    if not root.is_dir():
        raise DescriptorError(f"Package root is not a directory: {root}")

    manifest = _parse_manifest(root)
    launch_path = _resolve_inside(root, manifest["scoLaunchPath"], "SCO launch href")
    driver = _parse_json_script(_read_text(launch_path), "__DRIVER_CONFIG__")
    runtime = _parse_runtime_data(
        _resolve_inside(
            root, "scormcontent/runtime-data.js", "Rise runtime-data path"
        )
    )
    driver_options_path = launch_path.parent / "driverOptions.js"
    forced_commit_seconds = (
        _parse_forced_commit_seconds(driver_options_path)
        if driver_options_path.is_file()
        else None
    )

    course = runtime.get("course")
    settings = runtime.get("settings")
    if not isinstance(course, dict) or not isinstance(settings, dict):
        raise DescriptorError("runtime-data.js is missing course or settings metadata")

    driver_version = _as_string(driver.get("coursePackageVersion"))
    runtime_version = _as_string(settings.get("coursePackageVersion"))
    if not driver_version:
        raise DescriptorError("The launched driver config has no coursePackageVersion")

    lessons = _lesson_records(runtime)
    completion_policy = _completion_policy(driver)
    warnings: list[dict[str, Any]] = []
    if runtime_version and runtime_version != driver_version:
        warnings.append(
            {
                "code": "PACKAGE_VERSION_MISMATCH",
                "driverPackageVersion": driver_version,
                "runtimePackageVersion": runtime_version,
            }
        )
    quiz_ids = [
        lesson["id"] for lesson in lessons if lesson.get("type") == "quiz"
    ]
    if quiz_ids and completion_policy["triggerType"] != "quiz":
        warnings.append(
            {
                "code": "QUIZ_PRESENT_NOT_COMPLETION_TRIGGER",
                "quizIds": quiz_ids,
                "authoritativeTriggerType": completion_policy["triggerType"],
            }
        )

    descriptor: dict[str, Any] = {
        "schemaVersion": DESCRIPTOR_SCHEMA_VERSION,
        **manifest,
        "riseCourseId": _as_string(course.get("id")),
        "packageVersion": driver_version,
        "runtimePackageVersion": runtime_version,
        "navigationMode": _as_string(course.get("navigationMode")),
        "forcedCommitIntervalSeconds": forced_commit_seconds,
        "completionPolicy": completion_policy,
        "lessons": lessons,
        "warnings": warnings,
    }
    _validate_descriptor_strings(descriptor)
    structural_projection = {
        key: descriptor[key]
        for key in (
            "schemaVersion",
            "scormVersion",
            "navigationMode",
            "forcedCommitIntervalSeconds",
            "completionPolicy",
            "lessons",
        )
    }
    descriptor["structureHash"] = _canonical_hash(structural_projection)
    return descriptor


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract a minimized CourseDescriptor from a Rise SCORM 1.2 folder."
    )
    parser.add_argument("package", type=Path, help="Unzipped package root")
    parser.add_argument(
        "--output",
        type=Path,
        help="Write JSON to this path instead of standard output",
    )
    parser.add_argument(
        "--compact", action="store_true", help="Emit compact canonical JSON"
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv or sys.argv[1:])
    try:
        descriptor = extract_course_descriptor(args.package)
        if args.compact:
            rendered = json.dumps(
                descriptor,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        else:
            rendered = json.dumps(
                descriptor, ensure_ascii=False, indent=2, sort_keys=True
            )
        rendered += "\n"
        if args.output:
            args.output.write_text(rendered, encoding="utf-8")
        else:
            sys.stdout.write(rendered)
        return 0
    except (DescriptorError, OSError) as exc:
        print(f"Course descriptor extraction failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
