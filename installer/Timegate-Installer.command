#!/bin/bash
# Timegate Installer for macOS
# Double-click this file on a Mac. It creates a separate Timegate ZIP beside the original SCORM ZIP.

set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
RUNTIME_SOURCE="$PROJECT_ROOT/src"
CORE_INSTALLER="$SCRIPT_DIR/install-timegate.sh"

show_error() {
  osascript - "$1" <<'APPLESCRIPT'
on run argv
  display dialog (item 1 of argv) with title "Timegate Installer" buttons {"OK"} default button "OK" with icon stop
end run
APPLESCRIPT
}

show_info() {
  osascript - "$1" <<'APPLESCRIPT'
on run argv
  display dialog (item 1 of argv) with title "Timegate Installer" buttons {"OK"} default button "OK" with icon note
end run
APPLESCRIPT
}

choose_scorm_zip() {
  osascript <<'APPLESCRIPT'
try
  set chosenFile to choose file with prompt "Choose a SCORM ZIP"
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
  set response to display dialog "Required floor time in minutes:" with title "Timegate Installer" default answer "20" buttons {"Cancel", "Continue"} default button "Continue"
  return text returned of response
on error number -128
  return ""
end try
APPLESCRIPT
)"
    if [ -z "$value" ]; then
      return 1
    fi

    if printf '%s' "$value" | grep -Eq '^[0-9]+$' && [ "$value" -ge 1 ] && [ "$value" -le 600 ]; then
      printf '%s' "$value"
      return 0
    fi

    show_error "Enter a whole number from 1 to 600."
  done
}

choose_settings_mode() {
  osascript <<'APPLESCRIPT'
try
  set response to display dialog "Use the standard Timegate settings, or edit the advanced settings first?" with title "Timegate Installer" buttons {"Cancel", "Advanced Settings...", "Use Standard Settings"} default button "Use Standard Settings"
  return button returned of response
on error number -128
  return "Cancel"
end try
APPLESCRIPT
}

write_default_config() {
  local config_path="$1"
  local minutes="$2"

  cat > "$config_path" <<EOF
{
  "minRequiredMinutes": $minutes,
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

validate_json() {
  local config_path="$1"
  if ! plutil -lint "$config_path" >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

# TextEdit can silently replace straight quotes with curly "smart" quotes, which
# are not valid JSON. Convert them back before validating so a normal edit does
# not fail for an invisible reason.
normalize_smart_quotes() {
  perl -CSD -i -pe "s/\x{201C}/\"/g; s/\x{201D}/\"/g; s/\x{2018}/'/g; s/\x{2019}/'/g;" "$1" 2>/dev/null || true
}

confirm_build() {
  osascript - "$1" "$2" "$3" <<'APPLESCRIPT'
on run argv
  set theMinutes to item 1 of argv
  set theSettings to item 2 of argv
  set theOutput to item 3 of argv
  set msg to "Ready to create the Timegate package."
  set msg to msg & return & return & "Required floor time: " & theMinutes & " minutes"
  set msg to msg & return & "Settings: " & theSettings
  set msg to msg & return & return & "A new file will be created here:" & return & theOutput
  set msg to msg & return & return & "Your original SCORM ZIP is not changed."
  set msg to msg & return & return & "Create it now?"
  try
    set response to display dialog msg with title "Timegate Installer" buttons {"Cancel", "Create Package"} default button "Create Package"
    return button returned of response
  on error number -128
    return "Cancel"
  end try
end run
APPLESCRIPT
}

if [ ! -f "$RUNTIME_SOURCE/timegate.js" ] || [ ! -f "$CORE_INSTALLER" ]; then
  show_error "This launcher must stay in the Timegate project installer folder. The required src or installer files are missing."
  exit 1
fi

INPUT_ZIP="$(choose_scorm_zip)"
if [ -z "$INPUT_ZIP" ]; then
  exit 0
fi

case "$INPUT_ZIP" in
  *.zip|*.ZIP) ;;
  *)
    show_error "Choose a .zip SCORM package."
    exit 1
    ;;
esac

MINUTES="$(ask_minutes)" || exit 0
MODE="$(choose_settings_mode)"
if [ "$MODE" = "Cancel" ]; then
  exit 0
fi
if [ "$MODE" = "Advanced Settings..." ]; then
  SETTINGS_LABEL="Custom (advanced)"
else
  SETTINGS_LABEL="Standard"
fi

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/timegate.XXXXXX")"
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

MANIFEST_COUNT="$(find "$EXTRACT_DIR" -type f -name "imsmanifest.xml" | wc -l | tr -d ' ')"
if [ "$MANIFEST_COUNT" -eq 0 ]; then
  show_error "Timegate could not find imsmanifest.xml inside that ZIP. It does not appear to be a SCORM package."
  exit 1
fi

if [ "$MANIFEST_COUNT" -gt 1 ]; then
  show_error "This ZIP has more than one imsmanifest.xml, so Timegate cannot safely choose the course root."
  exit 1
fi

MANIFEST_PATH="$(find "$EXTRACT_DIR" -type f -name "imsmanifest.xml" -print -quit)"
SCORM_ROOT="$(dirname "$MANIFEST_PATH")"
PACKAGE_TIMEGATE_DIR="$SCORM_ROOT/timegate"
PACKAGE_CONFIG="$PACKAGE_TIMEGATE_DIR/timegate.config.json"
mkdir -p "$PACKAGE_TIMEGATE_DIR"
write_default_config "$PACKAGE_CONFIG" "$MINUTES"

if [ "$MODE" = "Advanced Settings..." ]; then
  show_info "TextEdit will open the advanced settings. Change only values you understand, then save and close the TextEdit window. Timegate checks the file before packaging."

  while true; do
    if ! open -W -a TextEdit "$PACKAGE_CONFIG"; then
      show_error "TextEdit did not open. No package was created."
      exit 1
    fi

    normalize_smart_quotes "$PACKAGE_CONFIG"

    if validate_json "$PACKAGE_CONFIG"; then
      break
    fi

    RETRY="$(osascript <<'APPLESCRIPT'
try
  set response to display dialog "The settings file is not valid yet. Common causes: a text value needs straight double quotes, or an extra comma follows the last setting. Open it again to fix?" with title "Timegate Installer" buttons {"Cancel", "Edit Again"} default button "Edit Again" with icon caution
  return button returned of response
on error number -128
  return "Cancel"
end try
APPLESCRIPT
)"
    if [ "$RETRY" != "Edit Again" ]; then
      exit 0
    fi
  done
fi

INPUT_DIR="$(dirname "$INPUT_ZIP")"
INPUT_FILENAME="$(basename "$INPUT_ZIP")"
INPUT_STEM="${INPUT_FILENAME%.*}"
case "$INPUT_STEM" in
  *-timegate) OUTPUT_STEM="$INPUT_STEM" ;;
  *) OUTPUT_STEM="$INPUT_STEM-timegate" ;;
esac
OUTPUT_ZIP="$INPUT_DIR/$OUTPUT_STEM.zip"

DECISION="$(confirm_build "$MINUTES" "$SETTINGS_LABEL" "$OUTPUT_ZIP")"
if [ "$DECISION" != "Create Package" ]; then
  exit 0
fi

if [ -f "$OUTPUT_ZIP" ]; then
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

if ! "$CORE_INSTALLER" "$SCORM_ROOT"; then
  show_error "Timegate could not be added to this package. No output ZIP was created."
  exit 1
fi

GENERATED_ZIP="$(dirname "$SCORM_ROOT")/$(basename "$SCORM_ROOT")-timegate.zip"
if [ ! -f "$GENERATED_ZIP" ]; then
  show_error "The core installer finished but did not create its ZIP output."
  exit 1
fi

cp -f "$GENERATED_ZIP" "$OUTPUT_ZIP"

if ! unzip -l "$OUTPUT_ZIP" | grep -q "timegate/timegate.js" || \
   ! unzip -l "$OUTPUT_ZIP" | grep -q "timegate/timegate.css" || \
   ! unzip -l "$OUTPUT_ZIP" | grep -q "timegate/timegate.config.json"; then
  rm -f "$OUTPUT_ZIP"
  show_error "The output ZIP was missing required Timegate files, so it was removed. No usable package was created."
  exit 1
fi

show_info "Timegate is installed.

Created:
$OUTPUT_ZIP

Your original SCORM ZIP was not changed."

open -R "$OUTPUT_ZIP"
