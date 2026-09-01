#!/bin/sh
# =============================================================================
# Timegate + SCORM observability installer (POSIX sh)
#
# Installs the fail-open runtimes into an UNZIPPED Rise SCORM 1.2 package,
# validates the result, then creates a sibling <package>-timegate.zip.
#
# Values may be provided by flags, environment variables, or interactive
# prompts. Prefer environment variables for the pilot token so it is not
# exposed in the process list.
# =============================================================================
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
INSTRUMENTER="$SCRIPT_DIR/instrument_package.py"
CONFIG_VALIDATOR="$SCRIPT_DIR/timegate_config.py"
COURSE_DESCRIPTOR="$SCRIPT_DIR/course_descriptor.py"

TELEMETRY_ENDPOINT="${SCORM_TELEMETRY_ENDPOINT:-}"
SOURCE_KEY_ID="${SCORM_SOURCE_KEY_ID:-}"
PILOT_TOKEN="${SCORM_PILOT_TOKEN:-}"
PAYCOM_ID="${PAYCOM_COURSE_ID:-}"
TIMEGATE_CONFIG=""
ROOT_DIR=""

usage() {
  cat <<EOF
Usage: $0 [options] <path-to-unzipped-scorm-folder>

Options:
  --telemetry-endpoint URL  Worker webhook URL (HTTPS; localhost may use HTTP)
  --source-key-id ID        Allowlisted observability source-key ID
  --pilot-token TOKEN       Course-scoped pilot token (environment preferred)
  --paycom-course-id ID     Paycom Course ID used for correlation
  --timegate-config FILE    Generated/custom Timegate configuration
  -h, --help                Show this help

Environment alternatives:
  SCORM_TELEMETRY_ENDPOINT, SCORM_SOURCE_KEY_ID, SCORM_PILOT_TOKEN,
  PAYCOM_COURSE_ID
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --telemetry-endpoint)
      [ "$#" -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }
      TELEMETRY_ENDPOINT="$2"
      shift 2
      ;;
    --source-key-id)
      [ "$#" -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }
      SOURCE_KEY_ID="$2"
      shift 2
      ;;
    --pilot-token)
      [ "$#" -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }
      PILOT_TOKEN="$2"
      shift 2
      ;;
    --paycom-course-id)
      [ "$#" -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }
      PAYCOM_ID="$2"
      shift 2
      ;;
    --timegate-config)
      [ "$#" -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }
      TIMEGATE_CONFIG="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$ROOT_DIR" ]; then
        echo "Only one package folder may be supplied." >&2
        usage >&2
        exit 2
      fi
      ROOT_DIR="$1"
      shift
      ;;
  esac
done

if [ -z "$ROOT_DIR" ]; then
  usage >&2
  exit 2
fi
if [ ! -d "$ROOT_DIR" ]; then
  echo "Package folder not found: $ROOT_DIR" >&2
  exit 1
fi
ROOT_DIR="$(CDPATH= cd -- "$ROOT_DIR" && pwd)"
if [ ! -f "$ROOT_DIR/imsmanifest.xml" ]; then
  echo "imsmanifest.xml not found in $ROOT_DIR" >&2
  echo "Point this at the UNZIPPED SCORM folder where the manifest lives." >&2
  exit 1
fi

PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1 && \
   python3 -c 'import sys; raise SystemExit(sys.version_info < (3, 9))' >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1 && \
     python -c 'import sys; raise SystemExit(sys.version_info < (3, 9))' >/dev/null 2>&1; then
  PYTHON_BIN="python"
fi
if [ -z "$PYTHON_BIN" ]; then
  echo "Python 3.9 or newer is required to run this installer." >&2
  exit 1
fi
if [ ! -f "$INSTRUMENTER" ]; then
  echo "Package instrumenter not found: $INSTRUMENTER" >&2
  exit 1
fi
if [ ! -f "$CONFIG_VALIDATOR" ]; then
  echo "Timegate configuration validator not found: $CONFIG_VALIDATOR" >&2
  exit 1
fi
if [ ! -f "$COURSE_DESCRIPTOR" ]; then
  echo "Course descriptor extractor not found: $COURSE_DESCRIPTOR" >&2
  exit 1
fi

if [ -z "$TELEMETRY_ENDPOINT" ]; then
  if [ -t 0 ]; then
    printf "Telemetry endpoint: " >&2
    IFS= read -r TELEMETRY_ENDPOINT
  else
    echo "Telemetry endpoint is required." >&2
    exit 2
  fi
fi
if [ -z "$SOURCE_KEY_ID" ]; then
  if [ -t 0 ]; then
    printf "Source-key ID: " >&2
    IFS= read -r SOURCE_KEY_ID
  else
    echo "Source-key ID is required." >&2
    exit 2
  fi
fi
if [ -z "$PILOT_TOKEN" ]; then
  if [ -t 0 ]; then
    printf "Pilot token: " >&2
    stty -echo 2>/dev/null || true
    IFS= read -r PILOT_TOKEN
    stty echo 2>/dev/null || true
    printf "\n" >&2
  else
    echo "Pilot token is required." >&2
    exit 2
  fi
fi
if [ -z "$PAYCOM_ID" ]; then
  if [ -t 0 ]; then
    printf "Paycom Course ID: " >&2
    IFS= read -r PAYCOM_ID
  else
    echo "Paycom Course ID is required." >&2
    exit 2
  fi
fi

if [ -n "$TIMEGATE_CONFIG" ]; then
  if [ ! -f "$TIMEGATE_CONFIG" ]; then
    echo "Timegate config not found: $TIMEGATE_CONFIG" >&2
    exit 1
  fi
  TIMEGATE_CONFIG="$(CDPATH= cd -- "$(dirname -- "$TIMEGATE_CONFIG")" && pwd)/$(basename "$TIMEGATE_CONFIG")"
fi

echo "Inspecting and instrumenting the package..."
if [ -n "$TIMEGATE_CONFIG" ]; then
  SCORM_TELEMETRY_ENDPOINT="$TELEMETRY_ENDPOINT" \
  SCORM_SOURCE_KEY_ID="$SOURCE_KEY_ID" \
  SCORM_PILOT_TOKEN="$PILOT_TOKEN" \
  PAYCOM_COURSE_ID="$PAYCOM_ID" \
    "$PYTHON_BIN" -B "$INSTRUMENTER" \
      --source-root "$PROJECT_ROOT" \
      --timegate-config "$TIMEGATE_CONFIG" \
      "$ROOT_DIR"
else
  SCORM_TELEMETRY_ENDPOINT="$TELEMETRY_ENDPOINT" \
  SCORM_SOURCE_KEY_ID="$SOURCE_KEY_ID" \
  SCORM_PILOT_TOKEN="$PILOT_TOKEN" \
  PAYCOM_COURSE_ID="$PAYCOM_ID" \
    "$PYTHON_BIN" -B "$INSTRUMENTER" \
      --source-root "$PROJECT_ROOT" \
      "$ROOT_DIR"
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "zip command not found; runtimes are installed but no ZIP was produced."
  exit 0
fi

BASE_NAME="$(basename "$ROOT_DIR")"
OUTPUT_ZIP="$(dirname "$ROOT_DIR")/${BASE_NAME}-timegate.zip"
ZIP_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/timegate-zip.XXXXXX")"
cleanup_zip_temp() {
  rm -rf "$ZIP_TEMP_DIR"
}
trap cleanup_zip_temp EXIT HUP INT TERM
TMP_ZIP="$ZIP_TEMP_DIR/${BASE_NAME}-timegate.zip"

echo "Creating ZIP: $OUTPUT_ZIP"
(
  cd "$ROOT_DIR"
  zip -r -q "$TMP_ZIP" . -x "*.DS_Store" -x "__MACOSX/*"
)
mv "$TMP_ZIP" "$OUTPUT_ZIP"
echo "Done."
