#!/bin/sh
# macOS-friendly wrapper that installs Timegate and zips the package.
set -e

# Resolve key paths relative to this script.
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

# Run the shared installer.
"$SCRIPT_DIR/install-timegate.sh"

# The shared installer handles zipping.
