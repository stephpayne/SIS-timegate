#!/bin/sh
# Install Timegate into a SCORM package and build a zip output.
set -e

# Resolve key paths relative to this script.
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
MANIFEST="$ROOT_DIR/imsmanifest.xml"

if [ ! -f "$MANIFEST" ]; then
  echo "imsmanifest.xml not found in $ROOT_DIR"
  exit 1
fi

# Locate Python for manifest parsing and HTML injection.
PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
fi

if [ -z "$PYTHON_BIN" ]; then
  echo "Python is required to run this installer."
  exit 1
fi

# Patch launch HTML and manifest via embedded Python.
TIMEGATE_ROOT="$ROOT_DIR" "$PYTHON_BIN" - <<'PY'
import os
import re
import sys
import xml.etree.ElementTree as ET

root_dir = os.environ.get('TIMEGATE_ROOT')
manifest_path = os.path.join(root_dir, 'imsmanifest.xml')

ns = {
    'imscp': 'http://www.imsproject.org/xsd/imscp_rootv1p1p2',
    'adlcp': 'http://www.adlnet.org/xsd/adlcp_rootv1p2',
}

try:
    tree = ET.parse(manifest_path)
except Exception as e:
    print('Failed to parse imsmanifest.xml:', e)
    sys.exit(1)

root = tree.getroot()
scorm_attr = '{%s}scormtype' % ns['adlcp']
resource = None
for res in root.findall('.//imscp:resource', ns):
    if res.get(scorm_attr) == 'sco':
        resource = res
        break

if resource is None:
    print('No SCO resource found in manifest.')
    sys.exit(1)

launch_href = resource.get('href')
if not launch_href:
    print('SCO resource does not specify href.')
    sys.exit(1)

launch_path = os.path.join(root_dir, launch_href)
if not os.path.exists(launch_path):
    print('Launch file not found:', launch_path)
    sys.exit(1)

launch_dir = os.path.dirname(launch_path)
rel_js = os.path.relpath(os.path.join(root_dir, 'timegate-overhaul', 'timegate.js'), launch_dir).replace(os.sep, '/')
rel_css = os.path.relpath(os.path.join(root_dir, 'timegate-overhaul', 'timegate.css'), launch_dir).replace(os.sep, '/')

with open(launch_path, 'r', encoding='utf-8') as f:
    html = f.read()

if 'data-timegate="true"' not in html:
    inject_css = f'  <link rel="stylesheet" href="{rel_css}" data-timegate="true">'
    inject_js = f'  <script defer src="{rel_js}" data-timegate="true"></script>'

    if '</head>' in html:
        html = html.replace('</head>', inject_css + '\n' + inject_js + '\n</head>', 1)
    elif '</body>' in html:
        html = html.replace('</body>', inject_css + '\n' + inject_js + '\n</body>', 1)
    else:
        html += '\n' + inject_css + '\n' + inject_js + '\n'

    with open(launch_path, 'w', encoding='utf-8') as f:
        f.write(html)

# Update manifest to include timegate assets without reserializing the XML.
timegate_files = [
    'timegate-overhaul/timegate.js',
    'timegate-overhaul/timegate.css',
    'timegate-overhaul/timegate.config.json',
]

try:
    raw_manifest = open(manifest_path, 'rb').read()
    manifest_text = raw_manifest.decode('utf-8', errors='surrogateescape')
except Exception as e:
    print('Failed to read imsmanifest.xml:', e)
    sys.exit(1)

newline = '\r\n' if b'\r\n' in raw_manifest else '\n'

resource_re = re.compile(r'<(?P<prefix>\w+:)?resource\b[^>]*>', re.IGNORECASE)
scorm_re = re.compile(r'\b[\w:]*scormtype\s*=\s*["\']sco["\']', re.IGNORECASE)
href_re = re.compile(r'\bhref\s*=\s*["\']%s["\']' % re.escape(launch_href))

resource_match = None
for match in resource_re.finditer(manifest_text):
    tag = match.group(0)
    if not scorm_re.search(tag):
        continue
    if launch_href and not href_re.search(tag):
        continue
    resource_match = match
    break

if resource_match is None:
    print('Failed to locate SCO resource in manifest text.')
    sys.exit(1)

prefix = resource_match.group('prefix') or ''
close_tag = f'</{prefix}resource>'
close_idx = manifest_text.find(close_tag, resource_match.end())
if close_idx == -1:
    print('Failed to locate closing tag for SCO resource in manifest text.')
    sys.exit(1)

resource_block = manifest_text[resource_match.end():close_idx]
missing = []
for href in timegate_files:
    href_pat = re.compile(r'\bhref\s*=\s*["\']%s["\']' % re.escape(href))
    if not href_pat.search(resource_block):
        missing.append(href)

if missing:
    file_re = re.compile(r'^(?P<indent>[ \t]*)<%sfile\b' % re.escape(prefix), re.MULTILINE)
    indent = None
    for m in file_re.finditer(resource_block):
        indent = m.group('indent')
    if indent is None:
        indent = '  '

    sample_re = re.compile(r'<%sfile\b[^>]*?/>' % re.escape(prefix))
    sample_match = None
    for m in sample_re.finditer(resource_block):
        sample_match = m
    space_before_slash = True
    if sample_match:
        space_before_slash = ' />' in sample_match.group(0)

    def make_file_tag(href_value: str) -> str:
        if space_before_slash:
            return f'{indent}<{prefix}file href="{href_value}" />'
        return f'{indent}<{prefix}file href="{href_value}"/>'

    tail_ws_match = re.search(r'[ \t]*$', resource_block)
    tail_ws = tail_ws_match.group(0) if tail_ws_match else ''
    insert_pos = close_idx - len(tail_ws)
    before_insert = manifest_text[:insert_pos]
    needs_leading_newline = not before_insert.endswith(('\n', '\r\n'))

    insertion_lines = [make_file_tag(href) for href in missing]
    insertion = ('%s' % newline if needs_leading_newline else '') + newline.join(insertion_lines) + newline

    manifest_text = manifest_text[:insert_pos] + insertion + manifest_text[insert_pos:]

    try:
        with open(manifest_path, 'wb') as f:
            f.write(manifest_text.encode('utf-8', errors='surrogateescape'))
    except Exception as e:
        print('Failed to write imsmanifest.xml:', e)
        sys.exit(1)

print('Timegate installed into:', launch_href)
PY

# Zip the SCORM package contents into the parent folder.
ZIP_BIN=""
if command -v zip >/dev/null 2>&1; then
  ZIP_BIN="zip"
fi

if [ -z "$ZIP_BIN" ]; then
  echo "zip command not found; skipping zip step."
  exit 0
fi

# Build output zip name (same parent directory as the package folder).
BASE_NAME="$(basename "$ROOT_DIR")"
OUTPUT_ZIP="$ROOT_DIR/../${BASE_NAME}-timegate.zip"

echo "Creating zip: $OUTPUT_ZIP"
cd "$ROOT_DIR"
zip -r -q "$OUTPUT_ZIP" . -x "*.DS_Store" -x "__MACOSX/*"
echo "Zip complete."
