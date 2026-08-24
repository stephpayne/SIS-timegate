#!/usr/bin/env python3
"""Parse and validate Timegate configuration before packaging."""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any


BOOLEAN_FIELDS = frozenset(
    {
        "countWhileMediaPlaying",
        "debug",
        "disableVideoSkip",
        "enforceCompletion",
        "gentleNudgeEnabled",
        "hideWhenComplete",
        "inactivityForceExitEnabled",
        "launchModalEnabled",
    }
)

NUMBER_RANGES = {
    "minRequiredMinutes": (0, 600),
    "idleTimeoutSeconds": (1, 3600),
    "backgroundGraceSeconds": (0, 3600),
    "inactivityForceExitMinutes": (1, 240),
    "inactivityWarningSeconds": (0, 600),
    "gentleNudgeSeconds": (0, 600),
}

ENUM_FIELDS = {
    "position": frozenset({"bottom-left", "bottom-right"}),
    "storageMode": frozenset({"dual", "localStorage", "suspend_data"}),
}

ALLOWED_FIELDS = frozenset(
    {
        *BOOLEAN_FIELDS,
        *NUMBER_RANGES,
        *ENUM_FIELDS,
        "courseKey",
        "maxAllowedMinutes",
    }
)


class TimegateConfigError(ValueError):
    """Raised when a Timegate configuration cannot be packaged safely."""


def _sha256_hex(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def derive_timegate_course_key(
    *,
    manifest_identifier: str,
    sco_resource_identifier: str,
    sco_launch_path: str,
    package_version: str,
    runtime_data_path: Path | str,
) -> str:
    identity_values = (
        manifest_identifier,
        sco_resource_identifier,
        sco_launch_path.replace("\\", "/"),
        package_version,
    )
    if any(not value.strip() for value in identity_values):
        raise TimegateConfigError(
            "cannot derive courseKey from incomplete package identity"
        )
    runtime_path = Path(runtime_data_path)
    try:
        runtime_digest = _sha256_hex(runtime_path.read_bytes())
    except OSError as exc:
        raise TimegateConfigError(
            f"could not derive courseKey from {runtime_path}: {exc}"
        ) from exc
    component_hashes = [
        _sha256_hex(value.encode("utf-8"))
        for value in (*identity_values, runtime_digest)
    ]
    material = "timegate-course-key-v1\n" + "\n".join(component_hashes)
    return "tg-pkg-v1-" + _sha256_hex(material.encode("utf-8"))


def _strip_json_comments(text: str) -> str:
    output: list[str] = []
    in_string = False
    escaped = False
    in_line_comment = False
    in_block_comment = False
    index = 0

    while index < len(text):
        character = text[index]
        following = text[index + 1] if index + 1 < len(text) else ""

        if in_line_comment:
            if character in "\r\n":
                in_line_comment = False
                output.append(character)
            index += 1
            continue

        if in_block_comment:
            if character == "*" and following == "/":
                in_block_comment = False
                index += 2
            else:
                if character in "\r\n":
                    output.append(character)
                index += 1
            continue

        if in_string:
            output.append(character)
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            index += 1
            continue

        if character == '"':
            in_string = True
            output.append(character)
            index += 1
            continue
        if character == "/" and following == "/":
            in_line_comment = True
            index += 2
            continue
        if character == "/" and following == "*":
            in_block_comment = True
            index += 2
            continue

        output.append(character)
        index += 1

    if in_block_comment:
        raise TimegateConfigError("contains an unterminated block comment")
    return "".join(output)


def _strip_trailing_commas(text: str) -> str:
    output: list[str] = []
    in_string = False
    escaped = False

    for index, character in enumerate(text):
        if in_string:
            output.append(character)
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue

        if character == '"':
            in_string = True
            output.append(character)
            continue

        if character == ",":
            following = index + 1
            while following < len(text) and text[following].isspace():
                following += 1
            if following < len(text) and text[following] in "}]":
                continue

        output.append(character)

    return "".join(output)


def parse_timegate_config(text: str) -> dict[str, Any]:
    try:
        parsed = json.loads(
            _strip_trailing_commas(
                _strip_json_comments(text.lstrip("\ufeff"))
            )
        )
    except (json.JSONDecodeError, TimegateConfigError) as exc:
        raise TimegateConfigError(f"is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise TimegateConfigError("must contain a JSON object")
    return parsed


def _require_number(
    config: dict[str, Any], field: str, minimum: float, maximum: float
) -> None:
    if field not in config:
        return
    value = config[field]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TimegateConfigError(f"{field} must be a number")
    if not math.isfinite(value) or value < minimum or value > maximum:
        raise TimegateConfigError(
            f"{field} must be between {minimum:g} and {maximum:g}"
        )


def validate_timegate_config(config: dict[str, Any]) -> dict[str, Any]:
    unknown = sorted(set(config) - ALLOWED_FIELDS)
    if unknown:
        raise TimegateConfigError(
            "contains unsupported fields: " + ", ".join(unknown)
        )

    if "minRequiredMinutes" not in config:
        raise TimegateConfigError("minRequiredMinutes is required")

    for field, (minimum, maximum) in NUMBER_RANGES.items():
        _require_number(config, field, minimum, maximum)

    for field in BOOLEAN_FIELDS:
        if field in config and not isinstance(config[field], bool):
            raise TimegateConfigError(f"{field} must be true or false")

    for field, allowed in ENUM_FIELDS.items():
        if field in config and config[field] not in allowed:
            raise TimegateConfigError(
                f"{field} must be one of: {', '.join(sorted(allowed))}"
            )

    if "courseKey" in config:
        course_key = config["courseKey"]
        if course_key is not None and (
            not isinstance(course_key, str) or not course_key.strip()
        ):
            raise TimegateConfigError("courseKey must be a non-empty string")
        if isinstance(course_key, str) and len(course_key) > 256:
            raise TimegateConfigError("courseKey must not exceed 256 characters")

    maximum = config.get("maxAllowedMinutes")
    if maximum is not None:
        if isinstance(maximum, bool) or not isinstance(maximum, (int, float)):
            raise TimegateConfigError("maxAllowedMinutes must be a number or null")
        if not math.isfinite(maximum) or maximum < 0 or maximum > 600:
            raise TimegateConfigError(
                "maxAllowedMinutes must be between 0 and 600 or null"
            )
        if maximum <= config["minRequiredMinutes"]:
            raise TimegateConfigError(
                "maxAllowedMinutes must be greater than minRequiredMinutes"
            )

    return config


def load_timegate_config(path: Path | str) -> dict[str, Any]:
    config_path = Path(path)
    try:
        source = config_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise TimegateConfigError(f"could not read {config_path}: {exc}") from exc
    return validate_timegate_config(parse_timegate_config(source))
