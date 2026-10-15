# Raycast setup

Use a small launcher in a folder registered with Raycast. The launcher runs the
installer from this checkout, so updates take effect without copying the full
installer again.

## Install the launcher

1. Keep the repository at `~/Code/SIS-timegate`, or set `TIMEGATE_PROJECT_ROOT`
   in the launcher to its actual absolute path.
2. Copy `installer/launchers/raycast.sh` into your registered Raycast script
   folder. Replace an existing Timegate launcher at its existing path to avoid
   duplicate commands.
3. Make it executable with `chmod +x /path/to/your/launcher.sh`.
4. In Raycast, run **Reload Script Commands** if the command is not visible.
5. Run **Timegate Installer**, choose the original SCORM ZIP, enter the time
   limits, and choose **Local storage only** or **LMS + browser**.
6. Check the persistence mode in the confirmation before creating the package.

The launcher requires this checkout and Python 3.10 or newer. Telemetry is off unless
an advanced profile explicitly enables it. Switching branches changes the installer and runtime used for new
packages; it does not change packages already created.

## Existing local installation

The installed launcher on this machine is
`/Users/jackcasica/Downloads/time-gate-installer.sh`. It delegates to
`/Users/jackcasica/Code/SIS-timegate/installer/launchers/mac.command`.
Raycast has Downloads registered as a script folder. Keep one registered
Timegate launcher to avoid selecting a stale copy.

Both Raycast and the Mac double-click launcher use `installer/launchers/mac.command`.
See [the installer guide](installer.md) for profiles and the shared CLI.

## Unattended packaging

Set `TIMEGATE_INPUT_ZIP`, `TIMEGATE_MINUTES`, and optionally
`TIMEGATE_MAX_MINUTES`. Set `TIMEGATE_STORAGE_MODE=localStorage` explicitly for
local storage only. Unattended calls retain `dual` when storage mode is omitted.
Existing output ZIPs are protected unless `TIMEGATE_REPLACE=1` is supplied.

Local storage only requires the same browser profile, device, origin, course key,
and resumed LMS attempt to recover saved Timegate state. Course completion is
still sent to the LMS.
