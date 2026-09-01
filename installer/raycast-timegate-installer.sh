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

set -euo pipefail

PROJECT_ROOT="${TIMEGATE_PROJECT_ROOT:-/Users/jackcasica/Code/SIS-timegate}"
PACKAGER="$PROJECT_ROOT/installer/install-timegate.ps1"
CONFIG_VALIDATOR="$PROJECT_ROOT/installer/timegate_config.ps1"
NONINTERACTIVE=false
if [ -n "${TIMEGATE_INPUT_ZIP:-}" ]; then
  NONINTERACTIVE=true
fi

show_error() {
  if [ "$NONINTERACTIVE" = true ]; then
    printf 'Error: %s\n' "$1" >&2
    return
  fi
  osascript - "$1" <<'APPLESCRIPT'
on run argv
  display dialog (item 1 of argv) with title "Timegate Installer" buttons {"OK"} default button "OK" with icon stop
end run
APPLESCRIPT
}

show_info() {
  if [ "$NONINTERACTIVE" = true ]; then
    printf '%s\n' "$1"
    return
  fi
  osascript - "$1" <<'APPLESCRIPT'
on run argv
  display dialog (item 1 of argv) with title "Timegate Installer" buttons {"OK"} default button "OK" with icon note
end run
APPLESCRIPT
}

find_pwsh() {
  local candidate
  for candidate in /opt/homebrew/bin/pwsh /usr/local/bin/pwsh; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  if command -v pwsh >/dev/null 2>&1; then
    command -v pwsh
    return 0
  fi
  return 1
}

choose_scorm_zip() {
  osascript <<'APPLESCRIPT'
try
  set chosenFile to choose file with prompt "Choose the original SCORM ZIP"
  return POSIX path of chosenFile
on error number -128
  return ""
end try
APPLESCRIPT
}

ask_minutes() {
  while true; do
    local value
    value="$(osascript <<'APPLESCRIPT'
try
  set response to display dialog "Minimum required time in minutes:" with title "Timegate Installer" default answer "20" buttons {"Cancel", "Continue"} default button "Continue"
  return text returned of response
on error number -128
  return ""
end try
APPLESCRIPT
)"
    if [ -z "$value" ]; then
      return 1
    fi
    if [[ "$value" =~ ^[0-9]+$ ]] && [ "$value" -ge 1 ] && [ "$value" -le 600 ]; then
      printf '%s' "$value"
      return 0
    fi
    show_error "Enter a whole number from 1 to 600."
  done
}

ask_max_minutes() {
  local minimum="$1"
  while true; do
    local value
    value="$(osascript <<'APPLESCRIPT'
try
  set response to display dialog "Optional maximum active time in minutes (leave blank for no maximum):" with title "Timegate Installer" default answer "" buttons {"Cancel", "Continue"} default button "Continue"
  return text returned of response
on error number -128
  return "__CANCEL__"
end try
APPLESCRIPT
)"
    if [ "$value" = "__CANCEL__" ]; then
      return 1
    fi
    if [ -z "$value" ]; then
      printf 'null'
      return 0
    fi
    if [[ "$value" =~ ^[0-9]+$ ]] && \
       [ "$value" -gt "$minimum" ] && [ "$value" -le 600 ]; then
      printf '%s' "$value"
      return 0
    fi
    show_error "Enter a whole number greater than the $minimum-minute minimum and no more than 600, or leave it blank."
  done
}

confirm_build() {
  osascript - "$1" "$2" "$3" <<'APPLESCRIPT'
on run argv
  set theMinimum to item 1 of argv
  set theMaximum to item 2 of argv
  set theOutput to item 3 of argv
  set msg to "Ready to create the Timegate package."
  set msg to msg & return & return & "Minimum required time: " & theMinimum & " minutes"
  if theMaximum is "null" then
    set msg to msg & return & "Maximum active time: none"
  else
    set msg to msg & return & "Maximum active time: " & theMaximum & " minutes"
  end if
  set msg to msg & return & return & "Created file:" & return & theOutput
  set msg to msg & return & return & "No telemetry will be installed."
  set msg to msg & return & "The original SCORM ZIP will not be changed."
  try
    set response to display dialog msg with title "Timegate Installer" buttons {"Cancel", "Create Package"} default button "Create Package"
    return button returned of response
  on error number -128
    return "Cancel"
  end try
end run
APPLESCRIPT
}

write_config() {
  local config_path="$1"
  local minimum="$2"
  local maximum="$3"
  cat > "$config_path" <<EOF
{
  "minRequiredMinutes": $minimum,
  "maxAllowedMinutes": $maximum,
  "enforceCompletion": true,
  "inactivityForceExitEnabled": true,
  "inactivityForceExitMinutes": 5,
  "inactivityWarningSeconds": 30,
  "gentleNudgeEnabled": true,
  "gentleNudgeSeconds": 60,
  "countWhileMediaPlaying": true,
  "disableVideoSkip": true,
  "idleTimeoutSeconds": 120,
  "backgroundGraceSeconds": 30,
  "launchModalEnabled": true,
  "hideWhenComplete": false,
  "position": "bottom-right",
  "storageMode": "dual",
  "debug": false
}
EOF
}

if [ ! -f "$PACKAGER" ] || [ ! -f "$CONFIG_VALIDATOR" ]; then
  show_error "The Timegate project is missing its packaging files: $PROJECT_ROOT"
  exit 1
fi

PWSH="$(find_pwsh)" || {
  show_error "PowerShell 7 is required. Install it with: brew install --cask powershell"
  exit 1
}

if [ "$NONINTERACTIVE" = true ]; then
  INPUT_ZIP="$TIMEGATE_INPUT_ZIP"
  MINUTES="${TIMEGATE_MINUTES:-}"
  MAX_ALLOWED_MINUTES="${TIMEGATE_MAX_MINUTES:-null}"
  if [ -z "$MINUTES" ]; then
    show_error "TIMEGATE_MINUTES is required with TIMEGATE_INPUT_ZIP."
    exit 2
  fi
else
  INPUT_ZIP="$(choose_scorm_zip)"
  if [ -z "$INPUT_ZIP" ]; then
    exit 0
  fi
  MINUTES="$(ask_minutes)" || exit 0
  MAX_ALLOWED_MINUTES="$(ask_max_minutes "$MINUTES")" || exit 0
fi

if [ ! -f "$INPUT_ZIP" ]; then
  show_error "SCORM ZIP not found: $INPUT_ZIP"
  exit 1
fi

case "$INPUT_ZIP" in
  *.zip|*.ZIP) ;;
  *)
    show_error "Choose a .zip SCORM package."
    exit 1
    ;;
esac

INPUT_FILENAME="$(basename "$INPUT_ZIP")"
INPUT_STEM="${INPUT_FILENAME%.*}"
case "$INPUT_STEM" in
  *-timegate)
    show_error "Choose the original SCORM export, not an existing -timegate ZIP."
    exit 1
    ;;
esac

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/raycast-timegate.XXXXXX")"
cleanup() {
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

EXTRACT_DIR="$TEMP_ROOT/extracted"
mkdir -p "$EXTRACT_DIR"
if ! unzip -q "$INPUT_ZIP" -d "$EXTRACT_DIR"; then
  show_error "Timegate could not unzip that file. Choose a valid SCORM ZIP."
  exit 1
fi

MANIFEST_COUNT="$(find "$EXTRACT_DIR" -type f -name 'imsmanifest.xml' | wc -l | tr -d ' ')"
if [ "$MANIFEST_COUNT" -ne 1 ]; then
  show_error "Expected exactly one imsmanifest.xml; found $MANIFEST_COUNT."
  exit 1
fi

MANIFEST_PATH="$(find "$EXTRACT_DIR" -type f -name 'imsmanifest.xml' -print -quit)"
SCORM_ROOT="$(dirname "$MANIFEST_PATH")"
mkdir -p "$SCORM_ROOT/timegate"
write_config \
  "$SCORM_ROOT/timegate/timegate.config.json" \
  "$MINUTES" \
  "$MAX_ALLOWED_MINUTES"

INPUT_DIR="$(dirname "$INPUT_ZIP")"
OUTPUT_ZIP="$INPUT_DIR/$INPUT_STEM-timegate.zip"

if [ "$NONINTERACTIVE" = false ]; then
  DECISION="$(confirm_build "$MINUTES" "$MAX_ALLOWED_MINUTES" "$OUTPUT_ZIP")"
  if [ "$DECISION" != "Create Package" ]; then
    exit 0
  fi
fi

if [ -f "$OUTPUT_ZIP" ]; then
  if [ "$NONINTERACTIVE" = true ]; then
    if [ "${TIMEGATE_REPLACE:-0}" != "1" ]; then
      show_error "Output already exists. Set TIMEGATE_REPLACE=1 to replace it."
      exit 1
    fi
  else
    REPLACE="$(osascript - "$OUTPUT_ZIP" <<'APPLESCRIPT'
on run argv
  set response to display dialog "A Timegate ZIP already exists here:" & return & return & (item 1 of argv) & return & return & "Replace it?" with title "Timegate Installer" buttons {"Cancel", "Replace"} default button "Replace" with icon caution
  return button returned of response
end run
APPLESCRIPT
)"
    if [ "$REPLACE" != "Replace" ]; then
      exit 0
    fi
  fi
fi

if ! "$PWSH" -NoProfile -File "$PACKAGER" -Package "$SCORM_ROOT"; then
  show_error "Timegate could not be added to this package."
  exit 1
fi

GENERATED_ZIP="$(dirname "$SCORM_ROOT")/$(basename "$SCORM_ROOT")-timegate.zip"
if [ ! -f "$GENERATED_ZIP" ]; then
  show_error "The packager finished but did not create its ZIP output."
  exit 1
fi

cp -f "$GENERATED_ZIP" "$OUTPUT_ZIP"

if ! unzip -tq "$OUTPUT_ZIP" >/dev/null 2>&1 || \
   ! unzip -p "$OUTPUT_ZIP" 'timegate/timegate.js' >/dev/null 2>&1 || \
   ! unzip -p "$OUTPUT_ZIP" 'timegate/timegate.css' >/dev/null 2>&1 || \
   ! unzip -p "$OUTPUT_ZIP" 'timegate/timegate.config.json' >/dev/null 2>&1 || \
   ! unzip -p "$OUTPUT_ZIP" 'scormdriver/indexAPI.html' | grep -q 'src="../timegate/timegate.js"' || \
   ! unzip -p "$OUTPUT_ZIP" 'scormdriver/indexAPI.html' | grep -q 'href="../timegate/timegate.css"'; then
  show_error "The generated ZIP failed Timegate validation."
  exit 1
fi

show_info "Timegate installed without telemetry.

Created:
$OUTPUT_ZIP

The original SCORM ZIP was not changed."

if [ "$NONINTERACTIVE" = false ]; then
  open -R "$OUTPUT_ZIP"
fi
