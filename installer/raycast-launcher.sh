#!/bin/bash

# Raycast Script Command
#
# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Timegate Installer
# @raycast.mode silent
#
# Optional parameters:
# @raycast.icon 🕐
# @raycast.packageName Timegate
# @raycast.description Add Timegate to a SCORM ZIP without telemetry.

# Launch the maintained installer so Raycast always gets the latest options.
set -euo pipefail
PROJECT_ROOT="${TIMEGATE_PROJECT_ROOT:-$HOME/Code/SIS-timegate}"
exec /bin/bash "$PROJECT_ROOT/installer/raycast-timegate-installer.sh" "$@"
