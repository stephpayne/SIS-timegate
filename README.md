# Timegate Overhaul Copy (Global Timer Overlay)

Timegate adds a persistent, bottom-right timer overlay to SCORM packages and can optionally gate SCORM completion until a minimum time is met.

## Quick Start (Publishers)
1. Unzip the SCORM package.
2. Copy the `timegate-overhaul/` folder into the SCORM root (same level as `imsmanifest.xml`).
3. Edit `timegate-overhaul/timegate.config.json` and set `minRequiredMinutes`.
4. Run the installer for your OS:
   - macOS: `timegate-overhaul/install-timegate.command`
   - Linux/macOS: `timegate-overhaul/install-timegate.sh`
   - Windows: `timegate-overhaul/install-timegate.ps1`
5. The installer creates `<folder>-timegate.zip` in the parent folder of the SCORM package.
6. Upload that zip to your LMS.

## Configuration
Edit `timegate-overhaul/timegate.config.json`:
- `minRequiredMinutes` (number): required time for the course.
- `enforceCompletion` (boolean): gate SCORM completion until time met.
- `idleTimeoutSeconds` (number): stop counting after idle timeout.
- `backgroundGraceSeconds` (number): keep counting briefly after the tab/window loses the foreground before pausing.
- `countWhileMediaPlaying` (boolean): count while audio/video is playing.
- `hideWhenComplete` (boolean): hide overlay after minimum met.
- `position` (`bottom-right` | `bottom-left`): overlay position.
- `debug` (boolean): enable console logging.
- `storageMode` (`localStorage` | `suspend_data` | `dual`): choose persistence strategy.

## Notes
- The shipped default uses `suspend_data` persistence. You can switch to `localStorage` or `dual` in `timegate.config.json` if you want different attempt-state behavior.
- The timer label and normal-state display mode are fixed by the runtime and are not intended to be publisher-edited.
- Completion gating only affects SCORM reporting; it does not block course UI.
