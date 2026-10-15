#!/usr/bin/env python3
"""Install Timegate and SCORM observability into an unpacked Rise course."""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import zipfile
import stat
import hashlib
from pathlib import PurePosixPath
import urllib.parse
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from .observability import DescriptorError, extract_course_descriptor
from .config import (
    TimegateConfigError,
    derive_timegate_course_key,
    load_timegate_config,
    validate_timegate_config,
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
    html: str,
    js_src: str,
    css_href: str,
    state: str,
    storage_mode: str,
) -> str:
    if state == "complete":
        timegate_tag_pattern = re.compile(
            r"<script\b"
            r"(?=[^>]*\bsrc\s*=\s*[\"']"
            + re.escape(js_src)
            + r"[\"'])"
            r"(?=[^>]*\bdata-timegate\s*=\s*[\"']true[\"'])"
            r"[^>]*>",
            re.IGNORECASE,
        )
        matches = list(timegate_tag_pattern.finditer(html))
        if len(matches) != 1:
            raise InstrumentationError(
                "Expected exactly one existing Timegate script marker"
            )
        match = matches[0]
        storage_marker = re.compile(
            r"\s+data-timegate-storage-mode(?:\s*=\s*(?:"
            r'"[^"]*"|\'[^\']*\'|[^\s>]+))?',
            re.IGNORECASE,
        )
        updated_tag = storage_marker.sub("", match.group(0))
        if storage_mode == "localStorage":
            updated_tag = re.sub(
                r"(?P<close>\s*/?>)$",
                r' data-timegate-storage-mode="localStorage"\g<close>',
                updated_tag,
                count=1,
            )
        return html[: match.start()] + updated_tag + html[match.end() :]
    if OBSERVABILITY_END in html:
        anchor_start = html.index(OBSERVABILITY_END)
        anchor_end = anchor_start + len(OBSERVABILITY_END)
    else:
        anchors = list(re.finditer(
            r"<script\b(?=[^>]*\bsrc\s*=\s*[\"'][^\"']*lms-interface\.js[\"'])[^>]*>\s*</script>",
            html, re.IGNORECASE,
        ))
        if len(anchors) != 1:
            raise InstrumentationError("Expected exactly one synchronous lms-interface.js bootstrap")
        anchor_start, anchor_end = anchors[0].span()
    line_start = html.rfind("\n", 0, anchor_start) + 1
    indent_match = re.match(r"[ \t]*", html[line_start:anchor_start])
    indent = indent_match.group(0) if indent_match else ""
    block = (
        f'\n{indent}<link rel="stylesheet" href="{css_href}" '
        'data-timegate="true">\n'
        f'{indent}<script src="{js_src}" data-timegate="true"'
        + (
            ' data-timegate-storage-mode="localStorage"'
            if storage_mode == "localStorage"
            else ""
        )
        + '></script>'
    )
    return html[:anchor_end] + block + html[anchor_end:]


def _verify_rendered(
    driver_html: str,
    content_html: str,
    manifest_text: str,
    expected_config_json: str,
    expected_timegate_js: str,
    expected_timegate_css: str,
    expected_storage_mode: str,
    telemetry: bool = True,
) -> None:
    expected_driver = (
        driver_html.count(OBSERVABILITY_START),
        driver_html.count(OBSERVABILITY_END),
        driver_html.count('data-sis-observability="config"'),
        driver_html.count('data-sis-observability="host"'),
    )
    if expected_driver != ((1, 1, 1, 1) if telemetry else (0, 0, 0, 0)):
        raise InstrumentationError(
            "Rendered launch HTML did not contain one observability block"
        )
    expected_content = (
        content_html.count(CONTENT_PROBE_START),
        content_html.count(CONTENT_PROBE_END),
        content_html.count('data-sis-observability="content-probe"'),
    )
    if expected_content != ((1, 1, 1) if telemetry else (0, 0, 0)):
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
    if telemetry and (host_tag is None or re.search(
        r"\s(?:async|defer)(?=\s|=|/?>)",
        host_tag.group(0),
        re.IGNORECASE,
    )):
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
    storage_marker_count = len(
        re.findall(
            r"\bdata-timegate-storage-mode(?:\s*=\s*(?:"
            r'"[^"]*"|\'[^\']*\'|[^\s>]+))?',
            timegate_tag.group(0),
            re.IGNORECASE,
        )
    )
    storage_marker_value = scripts[0].get("data-timegate-storage-mode")
    if expected_storage_mode == "localStorage":
        if storage_marker_count != 1 or storage_marker_value != "localStorage":
            raise InstrumentationError(
                "Local-only Timegate packages require exactly one synchronous "
                "storage marker"
            )
    elif storage_marker_count != 0:
        raise InstrumentationError(
            "Non-local Timegate packages may not retain a local-only storage marker"
        )
    anchor_tag = host_tag if telemetry else lms_tag
    if not (lms_tag.start() <= anchor_tag.start() < timegate_tag.start()):
        raise InstrumentationError(
            "Rendered launch script order must be lms-interface, host, Timegate"
        )
    if re.search(
        r"<script\b",
        driver_html[anchor_tag.end() : timegate_tag.start()],
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
    if telemetry and (bootstrap_index is None or probe_index > bootstrap_index.start()):
        raise InstrumentationError(
            "The content probe must load before the Rise bootstrap"
        )
    if expected_config_json not in driver_html:
        raise InstrumentationError(
            "Rendered launch HTML does not contain the exact generated config"
        )
    for href in TIMEGATE_FILES + (OBSERVABILITY_FILES if telemetry else ()):
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


def inspect_root(root: Path) -> dict[str, Any]:
    """Read just the identity needed by Timegate; telemetry has stricter metadata."""
    root = root.resolve()
    manifest = ET.parse(root / 'imsmanifest.xml').getroot()
    resources = [e for e in manifest.iter() if e.tag.rsplit('}', 1)[-1] == 'resource'
                 and (_attribute(e, 'scormtype') or '').lower() == 'sco']
    launch = _sco_launch_path(root / 'imsmanifest.xml')
    version = next((e.text or '' for e in manifest.iter()
                    if e.tag.rsplit('}', 1)[-1] == 'schemaversion'), '').strip()
    if version not in {'1.2', '2004', 'CAM 1.3', '2004 2nd Edition', '2004 3rd Edition', '2004 4th Edition'}:
        raise InstrumentationError(f'Unsupported SCORM version: {version}')
    driver = _read_text(_resolve_inside(root, launch, 'SCO launch href'))
    match = re.search(r'<script\b[^>]*\bid=["\']__DRIVER_CONFIG__["\'][^>]*>(.*?)</script>', driver, re.S | re.I)
    if not match:
        raise InstrumentationError('Rise driver config is missing')
    config = json.loads(match.group(1))
    title = next((e.text for e in manifest.iter() if e.tag.rsplit('}', 1)[-1] == 'title' and e.text), root.name)
    return dict(title=title, scormVersion=version, manifestIdentifier=manifest.get('identifier', ''),
                scoResourceIdentifier=resources[0].get('identifier', ''), scoLaunchPath=launch,
                packageVersion=config.get('coursePackageVersion', ''))


def instrument_package(
    package_root: Path, source_root: Path,
    endpoint: str | None = None, source_key_id: str = '', pilot_token: str = '',
    paycom_course_id: str = '', timegate_config: Path | None = None,
) -> dict[str, Any]:
    """Apply one validated installation to a private staging directory."""
    root, source = package_root.resolve(), source_root.resolve()
    telemetry = endpoint is not None
    if telemetry:
        endpoint = _validate_endpoint(endpoint)
        source_key_id = _validate_identifier('Source-key ID', source_key_id, 64)
        pilot_token = _validate_token(pilot_token)
        paycom_course_id = _validate_identifier('Paycom Course ID', paycom_course_id)
    info = inspect_root(root)
    manifest_path = root / 'imsmanifest.xml'
    driver_path = _resolve_inside(root, info['scoLaunchPath'], 'SCO launch href')
    content_path = _resolve_inside(root, 'scormcontent/index.html', 'Rise content path')
    driver, content, manifest = _read_text(driver_path), _read_text(content_path), _read_text(manifest_path)
    js, css = (_relative_asset_path(root / name, driver_path) for name in TIMEGATE_FILES[:2])
    _reject_existing_observability(root, driver, content, manifest)
    state = _existing_timegate_state(root, driver, manifest, js, css)
    # A configuration file alone is a supported legacy pre-install input.
    config_only = (root / TIMEGATE_FILES[2]).is_file() and not any(
        (root / p).exists() for p in TIMEGATE_FILES[:2]) and not any(_timegate_tags(driver)) and not any(
            _manifest_href_count(manifest, p) for p in TIMEGATE_FILES)
    if config_only:
        state = 'absent'
    if state == 'partial':
        raise InstrumentationError('The package contains a partial Timegate installation (stale, incomplete, or duplicate markers).')
    descriptor = extract_course_descriptor(root) if telemetry else info
    existing_config = root / TIMEGATE_FILES[2]
    selected = timegate_config or (existing_config if existing_config.exists() else source / 'src/timegate.config.json')
    try:
        effective = load_timegate_config(selected)
    except TimegateConfigError as exc:
        raise InstrumentationError(f"Invalid Timegate configuration: {exc}") from exc
    effective = {**load_timegate_config(source / 'src/timegate.config.json'), **effective}
    validate_timegate_config(effective)
    if effective.get('courseKey') is None:
        effective['courseKey'] = derive_timegate_course_key(
            manifest_identifier=info['manifestIdentifier'], sco_resource_identifier=info['scoResourceIdentifier'],
            sco_launch_path=info['scoLaunchPath'], package_version=info['packageVersion'],
            runtime_data_path=root / 'scormcontent/runtime-data.js')
    files = TIMEGATE_FILES + (OBSERVABILITY_FILES if telemetry else ())
    destinations = {p: _destination_inside(root, p) for p in files}
    source_files = {p: source / 'src' / p.removeprefix('timegate/') for p in files if p != TIMEGATE_FILES[2]}
    for path in source_files.values():
        if not path.is_file():
            raise InstrumentationError(f'Required runtime source file is missing: {path}')
    version = _read_text(source / 'VERSION').strip()
    if not version or len(version) > 64:
        raise InstrumentationError('VERSION must contain 1 to 64 characters')
    rendered_config = ''
    if telemetry:
        descriptor = {**descriptor, 'paycomCourseId': paycom_course_id}
        config = dict(enabled=True, endpoint=endpoint, source=dict(keyId=source_key_id, token=pilot_token),
                      course=descriptor, instrumentationVersion=version, timegateVersion=version,
                      corsFallbackBaseDelayMs=15000, corsFallbackJitterMs=5000)
        rendered_config = _safe_inline_json(config)
        driver = _inject_after_lms_interface(driver, config, _relative_asset_path(destinations[OBSERVABILITY_FILES[0]], driver_path))
        content = _inject_content_probe(content, _relative_asset_path(destinations[OBSERVABILITY_FILES[1]], content_path))
    driver = _inject_timegate(driver, js, css, state, effective['storageMode'])
    manifest_bytes = _register_manifest_files(manifest_path, info['scoLaunchPath'], files)
    _verify_rendered(driver, content, manifest_bytes.decode('utf-8'), rendered_config,
                     js, css, effective['storageMode'], telemetry)
    # No package writes occur until all rendered changes have passed validation.
    for name, dest in destinations.items():
        dest.parent.mkdir(parents=True, exist_ok=True)
        payload = (json.dumps(effective, ensure_ascii=False, indent=2) + '\n').encode() if name == TIMEGATE_FILES[2] else source_files[name].read_bytes()
        _atomic_write(dest, payload)
    _atomic_write(driver_path, driver.encode('utf-8'))
    if telemetry:
        _atomic_write(content_path, content.encode('utf-8'))
    _atomic_write(manifest_path, manifest_bytes)
    _verify_rendered(_read_text(driver_path), _read_text(content_path), _read_text(manifest_path),
                     rendered_config, js, css, effective['storageMode'], telemetry)
    return descriptor


def extract_source(source: Path, stage: Path) -> Path:
    """Extract without traversal, links, ambiguous names, or input mutation."""
    if source.is_dir():
        if any(p.is_symlink() for p in source.rglob('*')):
            raise InstrumentationError('Package directories may not contain symbolic links')
        shutil.copytree(source, stage, dirs_exist_ok=True)
    else:
        with zipfile.ZipFile(source) as archive:
            seen = set()
            for entry in archive.infolist():
                path = PurePosixPath(entry.filename)
                parts = path.parts
                if (path.is_absolute() or not parts or '..' in parts or '\\' in entry.filename
                        or any(':' in p for p in parts) or any(p.rstrip(' .') != p for p in parts)
                        or stat.S_ISLNK(entry.external_attr >> 16)):
                    raise InstrumentationError('ZIP contains an unsafe path or symbolic link')
                normalized = str(path).casefold()
                if normalized in seen:
                    raise InstrumentationError('ZIP contains duplicate or case-colliding paths')
                seen.add(normalized)
            archive.extractall(stage)
    manifests = [p for p in stage.rglob('imsmanifest.xml') if '__MACOSX' not in p.parts]
    if len(manifests) != 1:
        raise InstrumentationError(f'Expected exactly one imsmanifest.xml; found {len(manifests)}')
    return manifests[0].parent


def inspect_package(source: Path) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix='timegate-inspect-') as temp:
        return inspect_root(extract_source(source.resolve(), Path(temp)))


def build_package(source: Path, source_root: Path, output: Path | None = None,
                  *, replace: bool = False, config_path: Path | None = None,
                  overrides: dict[str, Any] | None = None,
                  telemetry: dict[str, str] | None = None, in_place: bool = False) -> dict[str, Any]:
    """Build privately, verify the actual ZIP, then atomically publish it."""
    source, source_root = source.resolve(), source_root.resolve()
    output = (output or source.with_name(source.stem + '-timegate.zip')).absolute()
    if output.resolve() == source:
        raise InstrumentationError('Output must differ from the source')
    if source.is_dir() and output.resolve().is_relative_to(source):
        raise InstrumentationError('Output must be outside the source directory')
    if output.exists() and not replace:
        raise InstrumentationError('Output already exists; use --replace explicitly')
    if not output.parent.is_dir():
        raise InstrumentationError('Output parent directory does not exist')
    if in_place and not source.is_dir():
        raise InstrumentationError('--in-place requires an unpacked directory')
    with tempfile.TemporaryDirectory(prefix='.timegate-', dir=output.parent) as temp:
        work = Path(temp)
        root = extract_source(source, work / 'source')
        info = inspect_root(root)
        source_package_root = source / root.relative_to(work / 'source')
        before = {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob('*') if p.is_file()}
        chosen = config_path or (root / TIMEGATE_FILES[2] if (root / TIMEGATE_FILES[2]).exists() else source_root / 'src/timegate.config.json')
        config = {**load_timegate_config(source_root / 'src/timegate.config.json'), **load_timegate_config(chosen)}
        config.update(overrides or {})
        validate_timegate_config(config)
        effective_path = work / 'config.json'
        effective_path.write_text(json.dumps(config), encoding='utf-8')
        descriptor = instrument_package(root, source_root, timegate_config=effective_path, **(telemetry or {}))
        updated = {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob('*') if p.is_file()}
        permitted = set(TIMEGATE_FILES) | {info['scoLaunchPath'], 'imsmanifest.xml'}
        if telemetry:
            permitted.update((*OBSERVABILITY_FILES, 'scormcontent/index.html'))
        if any(name not in permitted and updated.get(name) != value for name, value in before.items()):
            raise InstrumentationError('Build changed unrelated course content')
        if set(updated) - set(before) - permitted:
            raise InstrumentationError('Build added unexpected files')
        staged_zip = work / 'package.zip'
        with zipfile.ZipFile(staged_zip, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name, value in sorted(updated.items()):
                archive.writestr(name, value)
        with zipfile.ZipFile(staged_zip) as archive:
            if archive.testzip() is not None or set(archive.namelist()) != set(updated):
                raise InstrumentationError('ZIP integrity verification failed')
            for name, value in updated.items():
                if archive.read(name) != value:
                    raise InstrumentationError('ZIP content verification failed')
        effective = load_timegate_config(root / TIMEGATE_FILES[2])
        # Readback is verified before publishing; no partial output on failure.
        if replace:
            os.replace(staged_zip, output)
        else:
            os.link(staged_zip, output)  # atomic no-clobber, including a competing build
        if in_place:
            # Legacy core entry points update unpacked inputs after ZIP verification.
            for name in permitted:
                if name in updated:
                    dest = _destination_inside(source_package_root, name)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    _atomic_write(dest, updated[name])
        # Credentials remain in the explicitly configured package, never in this receipt.
        public_settings = {k: v for k, v in effective.items() if k not in {'seatTimeRelayKey', 'seatTimeRelayUrl'}}
        return dict(output=str(output), title=info['title'], scormVersion=info['scormVersion'],
                    settings=public_settings, version=_read_text(source_root / 'VERSION').strip(),
                    telemetryEnabled=bool(telemetry), verified=True,
                    sha256=hashlib.sha256(output.read_bytes()).hexdigest(), warnings=descriptor.get('warnings', []))
