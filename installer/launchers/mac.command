#!/bin/bash
# Mac and Raycast interface. All package operations belong to timegate.py.
set -euo pipefail
ROOT="${TIMEGATE_PROJECT_ROOT:-$(cd -- "$(dirname -- "$0")/../.." && pwd)}"
PYTHON=""
for candidate in python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 python; do
  if command -v "$candidate" >/dev/null && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3,10))' 2>/dev/null; then
    PYTHON="$candidate"; break
  fi
done
if [ -z "$PYTHON" ]; then
  printf 'Timegate requires Python 3.10 or newer. Install Python and retry.\n' >&2
  exit 1
fi
CLI="$ROOT/installer/timegate.py"
# Passing arguments provides a direct route to the same CLI, without dialogs.
if [ "$#" -gt 0 ]; then exec "$PYTHON" -B "$CLI" "$@"; fi
WORK="$(mktemp -d "${TMPDIR:-/tmp}/timegate-ui.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
message() {
  osascript - "$1" <<'APPLESCRIPT'
on run argv
  display dialog (item 1 of argv) with title "Timegate Installer" buttons {"OK"} default button "OK"
end run
APPLESCRIPT
}
run_engine() {
  if ! "$PYTHON" -B "$CLI" "$@" > "$WORK/result.json" 2> "$WORK/error.txt"; then
    if [ -n "${TIMEGATE_INPUT_ZIP:-}" ]; then cat "$WORK/error.txt" >&2; else message "$(cat "$WORK/error.txt")"; fi
    exit 1
  fi
}
if [ -n "${TIMEGATE_INPUT_ZIP:-}" ]; then
  INPUT="$TIMEGATE_INPUT_ZIP"
  : "${TIMEGATE_MINUTES:?TIMEGATE_MINUTES is required}"
  MINIMUM="$TIMEGATE_MINUTES"
  MAXIMUM="${TIMEGATE_MAX_MINUTES:-none}"
  STORAGE="${TIMEGATE_STORAGE_MODE:-dual}"
  PROFILE="${TIMEGATE_PROFILE:-}"
else
  INPUT="$(osascript <<'APPLESCRIPT'
try
  return POSIX path of (choose file with prompt "Choose the original SCORM ZIP" of type {"zip"})
on error number -128
  return ""
end try
APPLESCRIPT
)"
  [ -n "$INPUT" ] || exit 0
  run_engine inspect "$INPUT"
  IDENTITY="$("$PYTHON" -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["title"]+" (SCORM "+d["scormVersion"]+")")' "$WORK/result.json")"
  run_engine defaults
  FLOOR="$("$PYTHON" -c 'import json,sys; print(json.load(open(sys.argv[1]))["minRequiredMinutes"])' "$WORK/result.json")"
  MINIMUM="$(osascript - "$IDENTITY" "$FLOOR" <<'APPLESCRIPT'
on run argv
  try
    set response to display dialog (item 1 of argv) & return & return & "Minimum required time in minutes:" with title "Timegate Installer" default answer (item 2 of argv) buttons {"Cancel", "Continue"} default button "Continue"
    return text returned of response
  on error number -128
    return ""
  end try
end run
APPLESCRIPT
)"
  [ -n "$MINIMUM" ] || exit 0
  MAXIMUM="$(osascript <<'APPLESCRIPT'
try
  set response to display dialog "Maximum active time in minutes (blank for no maximum):" with title "Timegate Installer" default answer "" buttons {"Cancel", "Continue"} default button "Continue"
  return text returned of response
on error number -128
  return "__CANCEL__"
end try
APPLESCRIPT
)"
  [ "$MAXIMUM" != '__CANCEL__' ] || exit 0
  MAXIMUM="${MAXIMUM:-none}"
  CHOICE="$(osascript <<'APPLESCRIPT'
try
  set response to display dialog "Where should Timegate save its timer and pending state?" & return & return & "Local storage only: resume requires the same browser and device with saved browser data." & return & return & "LMS + browser: also uses the LMS shared suspend-data field." & return & return & "Course completion is reported to the LMS in either mode." with title "Timegate Installer" buttons {"Cancel", "LMS + browser", "Local storage only"} default button "Local storage only"
  return button returned of response
on error number -128
  return "Cancel"
end try
APPLESCRIPT
)"
  case "$CHOICE" in
    'Local storage only') STORAGE=localStorage ;;
    'LMS + browser') STORAGE=dual ;;
    *) exit 0 ;;
  esac
  PROFILE="$(osascript <<'APPLESCRIPT'
try
  set response to display dialog "Use standard settings or choose an advanced JSON profile? Telemetry is off unless enabled in the profile. Time and storage choices above take priority." with title "Timegate Installer" buttons {"Cancel", "Advanced settings…", "Standard settings"} default button "Standard settings"
  if button returned of response is "Advanced settings…" then
    return POSIX path of (choose file with prompt "Choose the advanced JSON profile")
  end if
  if button returned of response is "Cancel" then return "__CANCEL__"
  return ""
on error number -128
  return "__CANCEL__"
end try
APPLESCRIPT
)"
  [ "$PROFILE" != '__CANCEL__' ] || exit 0
fi
ARGS=("$INPUT" --minutes "$MINIMUM" --maximum "$MAXIMUM" --storage "$STORAGE")
[ -z "$PROFILE" ] || ARGS+=(--profile "$PROFILE")
run_engine preview "${ARGS[@]}"
OUTPUT="$("$PYTHON" -c 'import json,sys; print(json.load(open(sys.argv[1]))["output"])' "$WORK/result.json")"
if [ -z "${TIMEGATE_INPUT_ZIP:-}" ]; then
  REVIEW="$("$PYTHON" -c 'import json,sys; d=json.load(open(sys.argv[1])); s=d["settings"]; print(d["title"]+" (SCORM "+d["scormVersion"]+")"); print("Minimum: "+str(s["minRequiredMinutes"])+" minutes\nMaximum: "+str(s["maxAllowedMinutes"])+"\nPersistence: "+s["storageMode"]+"\nTelemetry: "+("on" if d["telemetryEnabled"] else "off")+"\n\nOutput:\n"+d["output"])' "$WORK/result.json")"
  DECISION="$(osascript - "$REVIEW" <<'APPLESCRIPT'
on run argv
  try
    set response to display dialog (item 1 of argv) with title "Timegate Installer" buttons {"Cancel", "Create Package"} default button "Create Package"
    return button returned of response
  on error number -128
    return "Cancel"
  end try
end run
APPLESCRIPT
)"
  [ "$DECISION" = 'Create Package' ] || exit 0
fi
if [ -f "$OUTPUT" ]; then
  if [ -n "${TIMEGATE_INPUT_ZIP:-}" ]; then
    [ "${TIMEGATE_REPLACE:-0}" = 1 ] || { printf 'Output exists; set TIMEGATE_REPLACE=1 to replace it.\n' >&2; exit 1; }
  else
    DECISION="$(osascript - "$OUTPUT" <<'APPLESCRIPT'
on run argv
  try
    set response to display dialog "Replace the existing output?" & return & (item 1 of argv) with title "Timegate Installer" buttons {"Cancel", "Replace"} default button "Cancel"
    return button returned of response
  on error number -128
    return "Cancel"
  end try
end run
APPLESCRIPT
)"
    [ "$DECISION" = Replace ] || exit 0
  fi
  ARGS+=(--replace)
fi
run_engine build "${ARGS[@]}"
if [ -n "${TIMEGATE_INPUT_ZIP:-}" ]; then cat "$WORK/result.json"; else
  message "Verified Timegate package created: $OUTPUT"
  open -R "$OUTPUT"
fi
