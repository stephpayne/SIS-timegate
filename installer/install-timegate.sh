#!/bin/sh
# =============================================================================
# Timegate installer (POSIX sh)
#
# Injects the Timegate runtime into an UNZIPPED SCORM package, then zips it.
#
#   Usage:  ./install-timegate.sh  /path/to/unzipped-scorm-folder
#
# The runtime that ships lives in ../src (timegate.js, timegate.css,
# timegate.config.json). It is deployed into the package under ONE
# version-free folder name -- DEPLOY_DIR below. Because nothing here is named
# after a version, bumping Timegate never changes a single path in this script.
# See ../MAINTAINING.md.
# =============================================================================
set -e

# ---- The ONE place the in-package folder name is defined ---------------------
DEPLOY_DIR="timegate"

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SRC_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/../src" && pwd)"

ROOT_DIR="$1"
if [ -z "$ROOT_DIR" ]; then
  echo "Usage: $0 <path-to-unzipped-scorm-folder>"
  exit 1
fi
ROOT_DIR="$(CDPATH= cd -- "$ROOT_DIR" && pwd)"
MANIFEST="$ROOT_DIR/imsmanifest.xml"
if [ ! -f "$MANIFEST" ]; then
  echo "imsmanifest.xml not found in $ROOT_DIR"
  echo "(Point this at the UNZIPPED SCORM folder, where imsmanifest.xml lives.)"
  exit 1
fi

PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then PYTHON_BIN="python3";
elif command -v python >/dev/null 2>&1; then PYTHON_BIN="python"; fi
if [ -z "$PYTHON_BIN" ]; then echo "Python is required to run this installer."; exit 1; fi

# ---- 1. Copy the runtime into <scorm>/<DEPLOY_DIR>/ --------------------------
# js/css always refresh; config is copied only if absent, so a config you have
# already customized inside the package is preserved on re-run.
mkdir -p "$ROOT_DIR/$DEPLOY_DIR"
cp "$SRC_DIR/timegate.js"  "$ROOT_DIR/$DEPLOY_DIR/timegate.js"
cp "$SRC_DIR/timegate.css" "$ROOT_DIR/$DEPLOY_DIR/timegate.css"
if [ ! -f "$ROOT_DIR/$DEPLOY_DIR/timegate.config.json" ]; then
  cp "$SRC_DIR/timegate.config.json" "$ROOT_DIR/$DEPLOY_DIR/timegate.config.json"
fi

# ---- 2. Inject into launch HTML + register in manifest -----------------------
TIMEGATE_ROOT="$ROOT_DIR" TIMEGATE_DIR="$DEPLOY_DIR" "$PYTHON_BIN" - <<'PY'
import os, re, sys
import xml.etree.ElementTree as ET

root_dir = os.environ['TIMEGATE_ROOT']
deploy   = os.environ['TIMEGATE_DIR']
manifest_path = os.path.join(root_dir, 'imsmanifest.xml')

ns = {
    'imscp': 'http://www.imsproject.org/xsd/imscp_rootv1p1p2',
    'adlcp': 'http://www.adlnet.org/xsd/adlcp_rootv1p2',
}
try:
    tree = ET.parse(manifest_path)
except Exception as e:
    print('Failed to parse imsmanifest.xml:', e); sys.exit(1)

root = tree.getroot()
scorm_attr = '{%s}scormtype' % ns['adlcp']
resource = next((r for r in root.findall('.//imscp:resource', ns)
                 if r.get(scorm_attr) == 'sco'), None)
if resource is None:
    print('No SCO resource found in manifest.'); sys.exit(1)

launch_href = resource.get('href')
if not launch_href:
    print('SCO resource does not specify href.'); sys.exit(1)

launch_path = os.path.join(root_dir, launch_href)
if not os.path.exists(launch_path):
    print('Launch file not found:', launch_path); sys.exit(1)

launch_dir = os.path.dirname(launch_path)
rel_js  = os.path.relpath(os.path.join(root_dir, deploy, 'timegate.js'),  launch_dir).replace(os.sep, '/')
rel_css = os.path.relpath(os.path.join(root_dir, deploy, 'timegate.css'), launch_dir).replace(os.sep, '/')

with open(launch_path, 'r', encoding='utf-8') as f:
    html = f.read()
if 'data-timegate="true"' not in html:
    inject_css = '  <link rel="stylesheet" href="%s" data-timegate="true">' % rel_css
    inject_js  = '  <script defer src="%s" data-timegate="true"></script>' % rel_js
    if '</head>' in html:
        html = html.replace('</head>', inject_css + '\n' + inject_js + '\n</head>', 1)
    elif '</body>' in html:
        html = html.replace('</body>', inject_css + '\n' + inject_js + '\n</body>', 1)
    else:
        html += '\n' + inject_css + '\n' + inject_js + '\n'
    with open(launch_path, 'w', encoding='utf-8') as f:
        f.write(html)

timegate_files = ['%s/timegate.js' % deploy, '%s/timegate.css' % deploy, '%s/timegate.config.json' % deploy]

raw = open(manifest_path, 'rb').read()
manifest_text = raw.decode('utf-8', errors='surrogateescape')
newline = '\r\n' if b'\r\n' in raw else '\n'

resource_re = re.compile(r'<(?P<prefix>\w+:)?resource\b[^>]*>', re.IGNORECASE)
scorm_re = re.compile(r'\b[\w:]*scormtype\s*=\s*["\']sco["\']', re.IGNORECASE)
href_re = re.compile(r'\bhref\s*=\s*["\']%s["\']' % re.escape(launch_href))

resource_match = None
for m in resource_re.finditer(manifest_text):
    tag = m.group(0)
    if not scorm_re.search(tag): continue
    if launch_href and not href_re.search(tag): continue
    resource_match = m; break
if resource_match is None:
    print('Failed to locate SCO resource in manifest text.'); sys.exit(1)

prefix = resource_match.group('prefix') or ''
close_tag = '</%sresource>' % prefix
close_idx = manifest_text.find(close_tag, resource_match.end())
if close_idx == -1:
    print('Failed to locate closing tag for SCO resource.'); sys.exit(1)

resource_block = manifest_text[resource_match.end():close_idx]
missing = [h for h in timegate_files
           if not re.search(r'\bhref\s*=\s*["\']%s["\']' % re.escape(h), resource_block)]

if missing:
    indent = '  '
    for m in re.finditer(r'^(?P<indent>[ \t]*)<%sfile\b' % re.escape(prefix), resource_block, re.MULTILINE):
        indent = m.group('indent')
    space_before_slash = True
    sample = None
    for m in re.finditer(r'<%sfile\b[^>]*?/>' % re.escape(prefix), resource_block):
        sample = m
    if sample:
        space_before_slash = ' />' in sample.group(0)

    def tag(href):
        return ('%s<%sfile href="%s" />' if space_before_slash else '%s<%sfile href="%s"/>') % (indent, prefix, href)

    tail = re.search(r'[ \t]*$', resource_block).group(0)
    insert_pos = close_idx - len(tail)
    before = manifest_text[:insert_pos]
    lead = newline if not before.endswith(('\n', '\r\n')) else ''
    insertion = lead + newline.join(tag(h) for h in missing) + newline
    manifest_text = manifest_text[:insert_pos] + insertion + manifest_text[insert_pos:]
    with open(manifest_path, 'wb') as f:
        f.write(manifest_text.encode('utf-8', errors='surrogateescape'))

print('Timegate runtime installed into %s/ and registered in manifest (launch: %s)' % (deploy, launch_href))
PY

# ---- 3. Zip the package (write to temp, then move; mounts are slow) ----------
if ! command -v zip >/dev/null 2>&1; then
  echo "zip command not found; runtime is installed but no zip was produced."
  exit 0
fi
BASE_NAME="$(basename "$ROOT_DIR")"
OUTPUT_ZIP="$(dirname "$ROOT_DIR")/${BASE_NAME}-timegate.zip"
TMP_ZIP="$(mktemp -d)/${BASE_NAME}-timegate.zip"
echo "Creating zip: $OUTPUT_ZIP"
( cd "$ROOT_DIR" && zip -r -q "$TMP_ZIP" . -x "*.DS_Store" -x "__MACOSX/*" )
mv "$TMP_ZIP" "$OUTPUT_ZIP"
echo "Done."
