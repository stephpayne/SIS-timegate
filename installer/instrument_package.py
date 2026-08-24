#!/usr/bin/env python3
"""Install Timegate and SCORM observability into an unpacked Rise course."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.parse
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from course_descriptor import DescriptorError, extract_course_descriptor
from timegate_config import (
    TimegateConfigError,
    derive_timegate_course_key,
    load_timegate_config,
)


TIMEGATE_FILES = (
    "timegate/timegate.js",
    "timegate/timegate.css",
    "timegate/timegate.config.json",
)
OBSERVABILITY_FILES = (
    "timegate/observability/host.js",
    "timegate/observability/content-probe.js",
)

OBSERVABILITY_START = "<!-- SIS observability:start -->"
OBSERVABILITY_END = "<!-- SIS observability:end -->"
CONTENT_PROBE_START = "<!-- SIS content probe:start -->"
CONTENT_PROBE_END = "<!-- SIS content probe:end -->"


class InstrumentationError(ValueError):
    """Raised when a package cannot be instrumented deterministically."""


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise InstrumentationError(f"Could not read {path}: {exc}") from exc


def _resolve_inside(package_root: Path, relative_path: str, label: str) -> Path:
    candidate_path = Path(relative_path)
    if candidate_path.is_absolute() or "?" in relative_path or "#" in relative_path:
        raise InstrumentationError(f"{label} must be a package-relative file path")
    candidate = (package_root / candidate_path).resolve()
    try:
        candidate.relative_to(package_root)
    except ValueError as exc:
        raise InstrumentationError(f"{label} escapes the package root") from exc
    return candidate


def _destination_inside(package_root: Path, relative_path: str) -> Path:
    destination = package_root / relative_path
    if destination.is_symlink():
        raise InstrumentationError(
            f"Runtime destination may not be a symbolic link: {relative_path}"
        )
    parent = destination.parent.resolve()
    try:
        parent.relative_to(package_root)
    except ValueError as exc:
        raise InstrumentationError(
            f"Runtime destination escapes the package root: {relative_path}"
        ) from exc
    return destination


def _attribute(element: ET.Element, name: str) -> str | None:
    wanted = name.lower()
    for key, value in element.attrib.items():
        if key.rsplit("}", 1)[-1].lower() == wanted:
            return value
    return None


def _sco_launch_path(manifest_path: Path) -> str:
    try:
        root = ET.parse(manifest_path).getroot()
    except (OSError, ET.ParseError) as exc:
        raise InstrumentationError(
            f"Could not parse {manifest_path}: {exc}"
        ) from exc
    resources = [
        element
        for element in root.iter()
        if element.tag.rsplit("}", 1)[-1].lower() == "resource"
        and (_attribute(element, "scormtype") or "").lower() == "sco"
    ]
    if len(resources) != 1:
        raise InstrumentationError(
            f"Expected exactly one SCO resource; found {len(resources)}"
        )
    launch_path = _attribute(resources[0], "href")
    if not launch_path:
        raise InstrumentationError("The SCO resource has no launch href")
    return launch_path.replace("\\", "/")


def _manifest_href_count(manifest_text: str, href: str) -> int:
    pattern = (
        r"<(?:\w+:)?file\b[^>]*\bhref\s*=\s*[\"']"
        + re.escape(href)
        + r"[\"'][^>]*/?>"
    )
    return len(re.findall(pattern, manifest_text, re.IGNORECASE))


def _register_manifest_files(
    manifest_path: Path, launch_href: str, file_hrefs: tuple[str, ...]
) -> bytes:
    raw = manifest_path.read_bytes()
    text = raw.decode("utf-8", errors="surrogateescape")
    newline = "\r\n" if b"\r\n" in raw else "\n"

    resource_re = re.compile(
        r"<(?P<prefix>\w+:)?resource\b[^>]*>", re.IGNORECASE
    )
    scorm_re = re.compile(
        r"\b[\w:]*scormtype\s*=\s*[\"']sco[\"']", re.IGNORECASE
    )
    href_re = re.compile(
        r"\bhref\s*=\s*[\"']%s[\"']" % re.escape(launch_href),
        re.IGNORECASE,
    )
    resource_match = next(
        (
            match
            for match in resource_re.finditer(text)
            if scorm_re.search(match.group(0))
            and href_re.search(match.group(0))
        ),
        None,
    )
    if resource_match is None:
        raise InstrumentationError(
            "Could not locate the launched SCO resource in manifest text"
        )

    prefix = resource_match.group("prefix") or ""
    close_tag = f"</{prefix}resource>"
    close_index = text.find(close_tag, resource_match.end())
    if close_index < 0:
        raise InstrumentationError("Could not locate the SCO resource closing tag")

    resource_body = text[resource_match.end() : close_index]
    missing = [
        href
        for href in file_hrefs
        if not re.search(
            r"\bhref\s*=\s*[\"']%s[\"']" % re.escape(href),
            resource_body,
            re.IGNORECASE,
        )
    ]
    if not missing:
        return raw

    indent = "  "
    file_pattern = re.compile(
        r"^(?P<indent>[ \t]*)<%sfile\b"
        % re.escape(prefix),
        re.MULTILINE,
    )
    matches = list(file_pattern.finditer(resource_body))
    if matches:
        indent = matches[-1].group("indent")

    space_before_slash = True
    samples = list(
        re.finditer(r"<%sfile\b[^>]*?/>" % re.escape(prefix), resource_body)
    )
    if samples:
        space_before_slash = " />" in samples[-1].group(0)

    def file_tag(href: str) -> str:
        closing = " />" if space_before_slash else "/>"
        return f'{indent}<{prefix}file href="{href}"{closing}'

    trailing_space = re.search(r"[ \t]*$", resource_body)
    trailing_count = len(trailing_space.group(0)) if trailing_space else 0
    insert_at = close_index - trailing_count
    lead = "" if text[:insert_at].endswith(("\n", "\r\n")) else newline
    insertion = lead + newline.join(file_tag(href) for href in missing) + newline
    updated = text[:insert_at] + insertion + text[insert_at:]
    return updated.encode("utf-8", errors="surrogateescape")


def _validate_identifier(label: str, value: str, max_length: int = 128) -> str:
    if not value or len(value) > max_length:
        raise InstrumentationError(
            f"{label} must contain 1 to {max_length} characters"
        )
    if not re.fullmatch(r"[A-Za-z0-9._:@/-]+", value):
        raise InstrumentationError(
            f"{label} may contain letters, numbers, dot, underscore, colon, "
            "at sign, slash, and hyphen"
        )
    return value


def _validate_token(value: str) -> str:
    if len(value) < 16 or len(value) > 512:
        raise InstrumentationError("Pilot token must contain 16 to 512 characters")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise InstrumentationError("Pilot token may not contain control characters")
    return value


def _validate_endpoint(value: str) -> str:
    if not value or len(value) > 2048:
        raise InstrumentationError(
            "Telemetry endpoint must contain 1 to 2048 characters"
        )
    parsed = urllib.parse.urlsplit(value)
    local_hosts = {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise InstrumentationError(
            "Telemetry endpoint must be an absolute HTTP(S) URL"
        )
    if parsed.scheme != "https" and parsed.hostname not in local_hosts:
        raise InstrumentationError(
            "Telemetry endpoint must use HTTPS except for localhost testing"
        )
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise InstrumentationError(
            "Telemetry endpoint may not contain credentials, a query, or a fragment"
        )
    return value


def _safe_inline_json(value: dict[str, Any]) -> str:
    rendered = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return (
        rendered.replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


def _relative_asset_path(asset: Path, document: Path) -> str:
    return os.path.relpath(asset, document.parent).replace(os.sep, "/")


class _TimegateTagParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.scripts: list[dict[str, str | None]] = []
        self.stylesheets: list[dict[str, str | None]] = []

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        attributes = {name.lower(): value for name, value in attrs}
        if "data-timegate" not in attributes:
            return
        if tag.lower() == "script":
            self.scripts.append(attributes)
        elif tag.lower() == "link":
            self.stylesheets.append(attributes)

    def handle_startendtag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        self.handle_starttag(tag, attrs)


def _timegate_tags(
    driver_html: str,
) -> tuple[list[dict[str, str | None]], list[dict[str, str | None]]]:
    parser = _TimegateTagParser()
    parser.feed(driver_html)
    parser.close()
    return parser.scripts, parser.stylesheets


def _existing_timegate_state(
    root: Path,
    driver_html: str,
    manifest_text: str,
    expected_js_src: str,
    expected_css_href: str,
) -> str:
    scripts, stylesheets = _timegate_tags(driver_html)
    js_marker = len(scripts)
    css_marker = len(stylesheets)
    manifest_counts = [
        _manifest_href_count(manifest_text, href) for href in TIMEGATE_FILES
    ]
    asset_states = [(root / href).is_file() for href in TIMEGATE_FILES]
    footprint = (
        js_marker
        or css_marker
        or any(manifest_counts)
        or any(asset_states)
    )
    complete = (
        js_marker == 1
        and css_marker == 1
        and (scripts[0].get("data-timegate") or "").lower() == "true"
        and (stylesheets[0].get("data-timegate") or "").lower() == "true"
        and "stylesheet" in (stylesheets[0].get("rel") or "").lower().split()
        and scripts[0].get("src") == expected_js_src
        and stylesheets[0].get("href") == expected_css_href
        and manifest_counts == [1, 1, 1]
        and all(asset_states)
    )
    if complete:
        return "complete"
    if footprint:
        return "partial"
    return "absent"


def _reject_existing_observability(
    root: Path, driver_html: str, content_html: str, manifest_text: str
) -> None:
    def attribute_count(html: str, value: str) -> int:
        return len(
            re.findall(
                r"\bdata-sis-observability\s*=\s*[\"']"
                + re.escape(value)
                + r"[\"']",
                html,
                re.IGNORECASE,
            )
        )

    marker_counts = [
        driver_html.count(OBSERVABILITY_START),
        driver_html.count(OBSERVABILITY_END),
        attribute_count(driver_html, "config"),
        attribute_count(driver_html, "host"),
        content_html.count(CONTENT_PROBE_START),
        content_html.count(CONTENT_PROBE_END),
        attribute_count(content_html, "content-probe"),
    ]
    manifest_counts = [
        _manifest_href_count(manifest_text, href)
        for href in OBSERVABILITY_FILES
    ]
    assets = [(root / href).exists() for href in OBSERVABILITY_FILES]
    extra_footprint = (
        "__SIS_OBSERVABILITY_CONFIG__" in driver_html
        or "timegate/observability" in driver_html
        or "timegate/observability" in content_html
        or (root / "timegate" / "observability").exists()
    )
    if (
        any(marker_counts)
        or any(manifest_counts)
        or any(assets)
        or extra_footprint
    ):
        complete = (
            marker_counts == [1, 1, 1, 1, 1, 1, 1]
            and manifest_counts == [1, 1]
            and all(assets)
        )
        state = "already instrumented" if complete else "partially instrumented"
        raise InstrumentationError(
            f"The package is {state} for observability. Start from a clean "
            "Rise export rather than layering or repairing instrumentation."
        )


def _inject_after_lms_interface(
    html: str, config: dict[str, Any], host_src: str
) -> str:
    anchor = re.compile(
        r"<script\b(?=[^>]*\bsrc\s*=\s*[\"'][^\"']*"
        r"lms-interface\.js[\"'])[^>]*>\s*</script>",
        re.IGNORECASE,
    )
    matches = list(anchor.finditer(html))
    if len(matches) != 1:
        raise InstrumentationError(
            "Expected exactly one lms-interface.js script in the SCO launch HTML"
        )
    line_start = html.rfind("\n", 0, matches[0].start()) + 1
    indent_match = re.match(r"[ \t]*", html[line_start : matches[0].start()])
    indent = indent_match.group(0) if indent_match else ""
    block = (
        f"\n{indent}{OBSERVABILITY_START}\n"
        f'{indent}<script id="__SIS_OBSERVABILITY_CONFIG__" '
        f'data-sis-observability="config">\n'
        f"{indent}  window.__SIS_OBSERVABILITY_CONFIG__ = "
        f"{_safe_inline_json(config)};\n"
        f"{indent}</script>\n"
        f'{indent}<script src="{host_src}" '
        f'data-sis-observability="host"></script>\n'
        f"{indent}{OBSERVABILITY_END}"
    )
    match = matches[0]
    return html[: match.end()] + block + html[match.end() :]


def _inject_content_probe(html: str, probe_src: str) -> str:
    anchor = re.compile(
        r"<script\b(?=[^>]*\bsrc\s*=\s*[\"'][^\"']*"
        r"lib/dist/[^/\"']+\.js[\"'])[^>]*>\s*</script>",
        re.IGNORECASE,
    )
    matches = list(anchor.finditer(html))
    if len(matches) != 1:
        raise InstrumentationError(
            "Expected exactly one Rise lib/dist bootstrap script in "
            "scormcontent/index.html"
        )
    line_start = html.rfind("\n", 0, matches[0].start()) + 1
    indent_match = re.match(r"[ \t]*", html[line_start : matches[0].start()])
    indent = indent_match.group(0) if indent_match else ""
    block = (
        f"{indent}{CONTENT_PROBE_START}\n"
        f'{indent}<script src="{probe_src}" '
        f'data-sis-observability="content-probe"></script>\n'
        f"{indent}{CONTENT_PROBE_END}\n"
    )
    match = matches[0]
    return html[: match.start()] + block + html[match.start() :]


def _inject_timegate(
    html: str, js_src: str, css_href: str, state: str
) -> str:
    if state == "complete":
        return html
    if html.count(OBSERVABILITY_END) != 1:
        raise InstrumentationError(
            "Timegate must be injected after one observability host block"
        )
    anchor_start = html.index(OBSERVABILITY_END)
    anchor_end = anchor_start + len(OBSERVABILITY_END)
    line_start = html.rfind("\n", 0, anchor_start) + 1
    indent_match = re.match(r"[ \t]*", html[line_start:anchor_start])
    indent = indent_match.group(0) if indent_match else ""
    block = (
        f'\n{indent}<link rel="stylesheet" href="{css_href}" '
        'data-timegate="true">\n'
        f'{indent}<script src="{js_src}" data-timegate="true"></script>'
    )
    return html[:anchor_end] + block + html[anchor_end:]


def _verify_rendered(
    driver_html: str,
    content_html: str,
    manifest_text: str,
    expected_config_json: str,
    expected_timegate_js: str,
    expected_timegate_css: str,
) -> None:
    expected_driver = (
        driver_html.count(OBSERVABILITY_START),
        driver_html.count(OBSERVABILITY_END),
        driver_html.count('data-sis-observability="config"'),
        driver_html.count('data-sis-observability="host"'),
    )
    if expected_driver != (1, 1, 1, 1):
        raise InstrumentationError(
            "Rendered launch HTML did not contain one observability block"
        )
    expected_content = (
        content_html.count(CONTENT_PROBE_START),
        content_html.count(CONTENT_PROBE_END),
        content_html.count('data-sis-observability="content-probe"'),
    )
    if expected_content != (1, 1, 1):
        raise InstrumentationError(
            "Rendered content HTML did not contain one content-probe block"
        )
    host_tag = re.search(
        r"<script\b[^>]*\bdata-sis-observability=[\"']host[\"'][^>]*>",
        driver_html,
        re.IGNORECASE,
    )
    lms_tag = re.search(
        r"<script\b(?=[^>]*\bsrc\s*=\s*[\"'][^\"']*"
        r"lms-interface\.js[\"'])[^>]*>",
        driver_html,
        re.IGNORECASE,
    )
    timegate_tag = re.search(
        r"<script\b[^>]*\bdata-timegate=[\"']true[\"'][^>]*>",
        driver_html,
        re.IGNORECASE,
    )
    if host_tag is None or re.search(
        r"\s(?:async|defer)(?=\s|=|/?>)",
        host_tag.group(0),
        re.IGNORECASE,
    ):
        raise InstrumentationError(
            "The observability host must execute synchronously"
        )
    if lms_tag is None or re.search(
        r"\s(?:async|defer)(?=\s|=|/?>)",
        lms_tag.group(0),
        re.IGNORECASE,
    ):
        raise InstrumentationError(
            "lms-interface.js must execute synchronously"
        )
    if timegate_tag is None or re.search(
        r"\s(?:async|defer)(?=\s|=|/?>)",
        timegate_tag.group(0),
        re.IGNORECASE,
    ):
        raise InstrumentationError(
            "The Timegate runtime must execute synchronously"
        )
    scripts, stylesheets = _timegate_tags(driver_html)
    if len(scripts) != 1 or len(stylesheets) != 1:
        raise InstrumentationError(
            "Rendered launch HTML must contain exactly one Timegate script "
            "and stylesheet marker"
        )
    if (
        (scripts[0].get("data-timegate") or "").lower() != "true"
        or (stylesheets[0].get("data-timegate") or "").lower() != "true"
        or "stylesheet"
        not in (stylesheets[0].get("rel") or "").lower().split()
        or scripts[0].get("src") != expected_timegate_js
        or stylesheets[0].get("href") != expected_timegate_css
    ):
        raise InstrumentationError(
            "Rendered Timegate tags must reference the exact packaged assets"
        )
    if not lms_tag.start() < host_tag.start() < timegate_tag.start():
        raise InstrumentationError(
            "Rendered launch script order must be lms-interface, host, Timegate"
        )
    if re.search(
        r"<script\b",
        driver_html[host_tag.end() : timegate_tag.start()],
        re.IGNORECASE,
    ):
        raise InstrumentationError(
            "No course script may execute between the observability host "
            "and Timegate"
        )
    bootstrap_index = re.search(
        r"\bsrc\s*=\s*[\"'][^\"']*lib/dist/[^/\"']+\.js[\"']",
        content_html,
        re.IGNORECASE,
    )
    probe_index = content_html.find('data-sis-observability="content-probe"')
    if bootstrap_index is None or probe_index > bootstrap_index.start():
        raise InstrumentationError(
            "The content probe must load before the Rise bootstrap"
        )
    if expected_config_json not in driver_html:
        raise InstrumentationError(
            "Rendered launch HTML does not contain the exact generated config"
        )
    for href in (*TIMEGATE_FILES, *OBSERVABILITY_FILES):
        if _manifest_href_count(manifest_text, href) != 1:
            raise InstrumentationError(
                f"Manifest must register {href} exactly once"
            )


def _atomic_write(path: Path, value: bytes) -> None:
    mode = path.stat().st_mode if path.exists() else 0o644
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    try:
        with os.fdopen(file_descriptor, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, mode)
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except OSError:
            pass
        raise


def instrument_package(
    package_root: Path,
    source_root: Path,
    endpoint: str,
    source_key_id: str,
    pilot_token: str,
    paycom_course_id: str,
    timegate_config: Path | None = None,
) -> dict[str, Any]:
    root = package_root.resolve()
    source = source_root.resolve()
    if not root.is_dir():
        raise InstrumentationError(f"Package root is not a directory: {root}")

    endpoint = _validate_endpoint(endpoint)
    source_key_id = _validate_identifier(
        "Source-key ID", source_key_id, max_length=64
    )
    pilot_token = _validate_token(pilot_token)
    paycom_course_id = _validate_identifier(
        "Paycom Course ID", paycom_course_id
    )

    source_files = {
        "timegate/timegate.js": source / "src" / "timegate.js",
        "timegate/timegate.css": source / "src" / "timegate.css",
        "timegate/timegate.config.json": (
            timegate_config.resolve()
            if timegate_config
            else source / "src" / "timegate.config.json"
        ),
        "timegate/observability/host.js": (
            source / "src" / "observability" / "host.js"
        ),
        "timegate/observability/content-probe.js": (
            source / "src" / "observability" / "content-probe.js"
        ),
    }
    missing = [str(path) for path in source_files.values() if not path.is_file()]
    if missing:
        raise InstrumentationError(
            "Required runtime source files are missing: " + ", ".join(missing)
        )

    manifest_path = _resolve_inside(root, "imsmanifest.xml", "Manifest path")
    launch_href = _sco_launch_path(manifest_path)
    driver_path = _resolve_inside(root, launch_href, "SCO launch href")
    content_path = _resolve_inside(
        root, "scormcontent/index.html", "Rise content path"
    )
    if not driver_path.is_file():
        raise InstrumentationError(f"SCO launch file does not exist: {driver_path}")
    if not content_path.is_file():
        raise InstrumentationError(
            f"Rise content launch file does not exist: {content_path}"
        )

    driver_html = _read_text(driver_path)
    content_html = _read_text(content_path)
    manifest_text = _read_text(manifest_path)
    expected_timegate_js = _relative_asset_path(
        root / TIMEGATE_FILES[0], driver_path
    )
    expected_timegate_css = _relative_asset_path(
        root / TIMEGATE_FILES[1], driver_path
    )
    _reject_existing_observability(
        root, driver_html, content_html, manifest_text
    )
    timegate_state = _existing_timegate_state(
        root,
        driver_html,
        manifest_text,
        expected_timegate_js,
        expected_timegate_css,
    )
    if timegate_state == "partial":
        raise InstrumentationError(
            "The package contains a partial Timegate installation. Start from "
            "a clean Rise export or a complete Timegate package."
        )
    if timegate_state == "complete":
        lms_index = driver_html.find("lms-interface.js")
        timegate_index = driver_html.find('data-timegate="true"')
        if lms_index < 0 or timegate_index < lms_index:
            raise InstrumentationError(
                "The existing Timegate injection order is not compatible"
            )

    descriptor = extract_course_descriptor(root)
    try:
        derived_course_key = derive_timegate_course_key(
            manifest_identifier=descriptor["manifestIdentifier"],
            sco_resource_identifier=descriptor["scoResourceIdentifier"],
            sco_launch_path=descriptor["scoLaunchPath"],
            package_version=descriptor["packageVersion"],
            runtime_data_path=root / "scormcontent/runtime-data.js",
        )
    except TimegateConfigError as exc:
        raise InstrumentationError(
            f"Could not derive Timegate courseKey: {exc}"
        ) from exc

    effective_config_path = source_files["timegate/timegate.config.json"]
    if timegate_state == "complete" and timegate_config is None:
        effective_config_path = root / "timegate/timegate.config.json"
    try:
        effective_timegate_config = load_timegate_config(
            effective_config_path
        )
    except TimegateConfigError as exc:
        raise InstrumentationError(
            f"Invalid Timegate configuration: {exc}"
        ) from exc
    generated_course_key = effective_timegate_config.get("courseKey") is None
    if generated_course_key:
        effective_timegate_config["courseKey"] = derived_course_key
    rendered_timegate_config = (
        json.dumps(
            effective_timegate_config,
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    ).encode("utf-8")

    descriptor_with_paycom = {**descriptor, "paycomCourseId": paycom_course_id}
    version = _read_text(source / "VERSION").strip()
    if not version or len(version) > 64:
        raise InstrumentationError("VERSION must contain 1 to 64 characters")
    config = {
        "enabled": True,
        "endpoint": endpoint,
        "source": {"keyId": source_key_id, "token": pilot_token},
        "course": descriptor_with_paycom,
        "instrumentationVersion": version,
        "timegateVersion": version,
        "corsFallbackBaseDelayMs": 15_000,
        "corsFallbackJitterMs": 5_000,
    }
    rendered_config = _safe_inline_json(config)

    destinations = {
        relative_path: _destination_inside(root, relative_path)
        for relative_path in source_files
    }
    host_asset = destinations[OBSERVABILITY_FILES[0]]
    probe_asset = destinations[OBSERVABILITY_FILES[1]]
    updated_driver = _inject_after_lms_interface(
        driver_html,
        config,
        _relative_asset_path(host_asset, driver_path),
    )
    updated_driver = _inject_timegate(
        updated_driver,
        expected_timegate_js,
        expected_timegate_css,
        timegate_state,
    )
    updated_content = _inject_content_probe(
        content_html, _relative_asset_path(probe_asset, content_path)
    )
    updated_manifest = _register_manifest_files(
        manifest_path,
        launch_href,
        (*TIMEGATE_FILES, *OBSERVABILITY_FILES),
    )
    updated_manifest_text = updated_manifest.decode(
        "utf-8", errors="surrogateescape"
    )
    _verify_rendered(
        updated_driver,
        updated_content,
        updated_manifest_text,
        rendered_config,
        expected_timegate_js,
        expected_timegate_css,
    )

    for relative_path, source_path in source_files.items():
        destination = destinations[relative_path]
        destination.parent.mkdir(parents=True, exist_ok=True)
        if relative_path == "timegate/timegate.config.json":
            if generated_course_key:
                _atomic_write(destination, rendered_timegate_config)
            elif not (
                timegate_state == "complete"
                and destination.is_file()
                and timegate_config is None
            ):
                shutil.copyfile(source_path, destination)
            continue
        shutil.copyfile(source_path, destination)

    _atomic_write(driver_path, updated_driver.encode("utf-8"))
    _atomic_write(content_path, updated_content.encode("utf-8"))
    _atomic_write(manifest_path, updated_manifest)

    for relative_path in (*TIMEGATE_FILES, *OBSERVABILITY_FILES):
        if not (root / relative_path).is_file():
            raise InstrumentationError(
                f"Installed package is missing {relative_path}"
            )
    try:
        installed_timegate_config = load_timegate_config(
            root / "timegate/timegate.config.json"
        )
    except TimegateConfigError as exc:
        raise InstrumentationError(
            f"Installed Timegate configuration is invalid: {exc}"
        ) from exc
    if installed_timegate_config.get("courseKey") != effective_timegate_config.get(
        "courseKey"
    ):
        raise InstrumentationError(
            "Installed Timegate configuration did not preserve its courseKey"
        )
    _verify_rendered(
        _read_text(driver_path),
        _read_text(content_path),
        _read_text(manifest_path),
        rendered_config,
        expected_timegate_js,
        expected_timegate_css,
    )
    return descriptor_with_paycom


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Install Timegate and SCORM observability into a Rise package."
    )
    parser.add_argument("package", type=Path, help="Unpacked SCORM package root")
    parser.add_argument(
        "--source-root",
        type=Path,
        required=True,
        help="SIS-timegate repository root",
    )
    parser.add_argument(
        "--telemetry-endpoint",
        default=os.environ.get("SCORM_TELEMETRY_ENDPOINT", ""),
    )
    parser.add_argument(
        "--source-key-id",
        default=os.environ.get("SCORM_SOURCE_KEY_ID", ""),
    )
    parser.add_argument(
        "--pilot-token",
        default=os.environ.get("SCORM_PILOT_TOKEN", ""),
    )
    parser.add_argument(
        "--paycom-course-id",
        default=os.environ.get("PAYCOM_COURSE_ID", ""),
    )
    parser.add_argument(
        "--timegate-config",
        type=Path,
        help="Use this generated/custom Timegate config",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv or sys.argv[1:])
    try:
        descriptor = instrument_package(
            args.package,
            args.source_root,
            args.telemetry_endpoint,
            args.source_key_id,
            args.pilot_token,
            args.paycom_course_id,
            args.timegate_config,
        )
        print(
            "Installed Timegate and SCORM observability "
            f"(course: {descriptor['riseCourseId']}, "
            f"package: {descriptor['packageVersion']}, "
            f"structure: {descriptor['structureHash']})"
        )
        for warning in descriptor["warnings"]:
            print(f"Descriptor warning: {warning['code']}")
        return 0
    except (DescriptorError, InstrumentationError, OSError) as exc:
        print(f"Package instrumentation failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
