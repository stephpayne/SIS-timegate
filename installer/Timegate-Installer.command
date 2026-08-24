#!/bin/bash
# Timegate Installer for macOS
# Double-click this file on a Mac. It creates a separate Timegate ZIP beside the original SCORM ZIP.

set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
RUNTIME_SOURCE="$PROJECT_ROOT/src"
CORE_INSTALLER="$SCRIPT_DIR/install-timegate.sh"
CONFIG_VALIDATOR="$SCRIPT_DIR/timegate_config.py"
INSTRUMENTER="$SCRIPT_DIR/instrument_package.py"
COURSE_DESCRIPTOR="$SCRIPT_DIR/course_descriptor.py"

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
    if printf '%s' "$value" | grep -Eq '^[0-9]+$' && \
       [ "$value" -gt "$minimum" ] && [ "$value" -le 600 ]; then
      printf '%s' "$value"
      return 0
    fi
    show_error "Enter a whole number greater than the $minimum-minute floor and no more than 600, or leave it blank for no maximum."
  done
}

ask_telemetry_endpoint() {
  while true; do
    local value
    value="$(osascript <<'APPLESCRIPT'
try
  set response to display dialog "Telemetry webhook endpoint:" with title "Timegate Installer" default answer "https://" buttons {"Cancel", "Continue"} default button "Continue"
  return text returned of response
on error number -128
  return ""
end try
APPLESCRIPT
)"
    if [ -z "$value" ]; then
      return 1
    fi

    if printf '%s' "$value" | grep -Eq '^https://[^/?#]+(/[^?#]*)?$|^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/[^?#]*)?$'; then
      printf '%s' "$value"
      return 0
    fi
    show_error "Use a complete HTTPS URL without a query or fragment. HTTP is accepted only for localhost testing."
  done
}

ask_source_key_id() {
  while true; do
    local value
    value="$(osascript <<'APPLESCRIPT'
try
  set response to display dialog "Observability source-key ID:" with title "Timegate Installer" default answer "rise-pilot" buttons {"Cancel", "Continue"} default button "Continue"
  return text returned of response
on error number -128
  return ""
end try
APPLESCRIPT
)"
    if [ -z "$value" ]; then
      return 1
    fi
    if printf '%s' "$value" | grep -Eq '^[A-Za-z0-9._:@/-]{1,64}$'; then
      printf '%s' "$value"
      return 0
    fi
    show_error "Use 1–64 letters, numbers, dots, underscores, colons, @ signs, slashes, or hyphens."
  done
}

ask_pilot_token() {
  while true; do
    local value
    value="$(osascript <<'APPLESCRIPT'
try
  set response to display dialog "Course-scoped pilot token:" with title "Timegate Installer" default answer "" hidden answer true buttons {"Cancel", "Continue"} default button "Continue"
  return text returned of response
on error number -128
  return ""
end try
APPLESCRIPT
)"
    if [ -z "$value" ]; then
      return 1
    fi
    if [ "${#value}" -ge 16 ] && [ "${#value}" -le 512 ]; then
      printf '%s' "$value"
      return 0
    fi
    show_error "The pilot token must contain 16–512 characters."
  done
}

ask_paycom_course_id() {
  while true; do
    local value
    value="$(osascript <<'APPLESCRIPT'
try
  set response to display dialog "Paycom Course ID:" with title "Timegate Installer" default answer "" buttons {"Cancel", "Continue"} default button "Continue"
  return text returned of response
on error number -128
  return ""
end try
APPLESCRIPT
)"
    if [ -z "$value" ]; then
      return 1
    fi
    if printf '%s' "$value" | grep -Eq '^[A-Za-z0-9._:@/-]{1,128}$'; then
      printf '%s' "$value"
      return 0
    fi
    show_error "Use 1–128 letters, numbers, dots, underscores, colons, @ signs, slashes, or hyphens."
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
  local max_minutes="$3"

  cat > "$config_path" <<EOF
{
  "minRequiredMinutes": $minutes,
  "maxAllowedMinutes": $max_minutes,
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
  osascript - "$1" "$2" "$3" "$4" "$5" "$6" "$7" <<'APPLESCRIPT'
on run argv
  set theMinutes to item 1 of argv
  set theMaximum to item 2 of argv
  set theSettings to item 3 of argv
  set theOutput to item 4 of argv
  set theEndpoint to item 5 of argv
  set theSourceKey to item 6 of argv
  set thePaycomCourse to item 7 of argv
  set msg to "Ready to create the Timegate package."
  set msg to msg & return & return & "Required floor time: " & theMinutes & " minutes"
  if theMaximum is "null" then
    set msg to msg & return & "Maximum active time: none"
  else
    set msg to msg & return & "Maximum active time: " & theMaximum & " minutes"
  end if
  set msg to msg & return & "Settings: " & theSettings
  set msg to msg & return & "Telemetry endpoint: " & theEndpoint
  set msg to msg & return & "Source-key ID: " & theSourceKey
  set msg to msg & return & "Paycom Course ID: " & thePaycomCourse
  set msg to msg & return & "Pilot token: configured (hidden)"
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

if [ ! -f "$RUNTIME_SOURCE/timegate.js" ] || \
   [ ! -f "$RUNTIME_SOURCE/observability/host.js" ] || \
   [ ! -f "$RUNTIME_SOURCE/observability/content-probe.js" ] || \
   [ ! -f "$CONFIG_VALIDATOR" ] || \
   [ ! -f "$INSTRUMENTER" ] || \
   [ ! -f "$COURSE_DESCRIPTOR" ] || \
   [ ! -f "$CORE_INSTALLER" ]; then
  show_error "This launcher must stay in the Timegate project installer folder. Required Timegate or observability files are missing."
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

INPUT_FILENAME="$(basename "$INPUT_ZIP")"
INPUT_STEM="${INPUT_FILENAME%.*}"
case "$INPUT_STEM" in
  *-timegate)
    show_error "Choose the original Rise SCORM export, not an existing -timegate ZIP. This keeps the original package unchanged and avoids layered instrumentation."
    exit 1
    ;;
esac

MINUTES="$(ask_minutes)" || exit 0
MAX_ALLOWED_MINUTES="$(ask_max_minutes "$MINUTES")" || exit 0
TELEMETRY_ENDPOINT="$(ask_telemetry_endpoint)" || exit 0
SOURCE_KEY_ID="$(ask_source_key_id)" || exit 0
PILOT_TOKEN="$(ask_pilot_token)" || exit 0
PAYCOM_COURSE_ID="$(ask_paycom_course_id)" || exit 0
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
PACKAGE_CONFIG="$TEMP_ROOT/timegate.config.json"
write_default_config "$PACKAGE_CONFIG" "$MINUTES" "$MAX_ALLOWED_MINUTES"

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
OUTPUT_STEM="$INPUT_STEM-timegate"
OUTPUT_ZIP="$INPUT_DIR/$OUTPUT_STEM.zip"

DECISION="$(confirm_build \
  "$MINUTES" \
  "$MAX_ALLOWED_MINUTES" \
  "$SETTINGS_LABEL" \
  "$OUTPUT_ZIP" \
  "$TELEMETRY_ENDPOINT" \
  "$SOURCE_KEY_ID" \
  "$PAYCOM_COURSE_ID")"
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

if ! SCORM_TELEMETRY_ENDPOINT="$TELEMETRY_ENDPOINT" \
     SCORM_SOURCE_KEY_ID="$SOURCE_KEY_ID" \
     SCORM_PILOT_TOKEN="$PILOT_TOKEN" \
     PAYCOM_COURSE_ID="$PAYCOM_COURSE_ID" \
     "$CORE_INSTALLER" \
       --timegate-config "$PACKAGE_CONFIG" \
       "$SCORM_ROOT"; then
  show_error "Timegate could not be added to this package. No output ZIP was created."
  exit 1
fi

GENERATED_ZIP="$(dirname "$SCORM_ROOT")/$(basename "$SCORM_ROOT")-timegate.zip"
if [ ! -f "$GENERATED_ZIP" ]; then
  show_error "The core installer finished but did not create its ZIP output."
  exit 1
fi

cp -f "$GENERATED_ZIP" "$OUTPUT_ZIP"

if ! unzip -p "$OUTPUT_ZIP" "timegate/timegate.js" >/dev/null 2>&1 || \
   ! unzip -p "$OUTPUT_ZIP" "timegate/timegate.css" >/dev/null 2>&1 || \
   ! unzip -p "$OUTPUT_ZIP" "timegate/timegate.config.json" >/dev/null 2>&1 || \
   ! unzip -p "$OUTPUT_ZIP" "timegate/observability/host.js" >/dev/null 2>&1 || \
   ! unzip -p "$OUTPUT_ZIP" "timegate/observability/content-probe.js" >/dev/null 2>&1 || \
   ! unzip -p "$OUTPUT_ZIP" "scormdriver/indexAPI.html" | grep -q 'src="../timegate/timegate.js"' || \
   ! unzip -p "$OUTPUT_ZIP" "scormdriver/indexAPI.html" | grep -q 'href="../timegate/timegate.css"' || \
   ! unzip -p "$OUTPUT_ZIP" "scormdriver/indexAPI.html" | grep -q 'data-sis-observability="host"' || \
   ! unzip -p "$OUTPUT_ZIP" "scormcontent/index.html" | grep -q 'data-sis-observability="content-probe"'; then
  rm -f "$OUTPUT_ZIP"
  show_error "The output ZIP was missing required Timegate files, so it was removed. No usable package was created."
  exit 1
fi

show_info "Timegate and SCORM observability are installed.

Created:
$OUTPUT_ZIP

Your original SCORM ZIP was not changed."

open -R "$OUTPUT_ZIP"
