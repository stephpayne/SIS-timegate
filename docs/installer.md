# Timegate installer

## Normal workflow

Install Python 3.10 or newer and keep this checkout together. No Python packages,
PowerShell on Mac, Node, ZIP utilities, or network connection are needed to build.
Node is only needed for development tests.

- **Mac:** open `installer/launchers/mac.command`.
- **Windows:** open `installer/launchers/windows.cmd` (Windows PowerShell is used for the interface).
- **Raycast:** use the forwarding launcher described in [Raycast setup](raycast-setup.md).

Select the original ZIP, set minimum and optional maximum minutes, choose the
persistence mode, then review and create. Leave advanced settings at standard
unless you have a reviewed JSON profile. Telemetry is off by default. The output
is `<source>-timegate.zip` beside the original; replacement requires confirmation.

**Local storage only** is selected by default in the interactive interfaces.
It keeps Timegate state out of the LMS shared `suspend_data` field. The authored
course still uses its normal LMS storage, and completion still reports to the LMS.
Resume requires the same browser profile, device, origin, course key, and LMS
attempt marked as a resume. Unavailable browser storage blocks Timegate completion
rather than silently switching storage modes.

## Shared CLI

Run from the repository directory. On Windows, use `py -3` in place of `python3`
if that is how Python is installed.

```sh
python3 installer/timegate.py inspect /path/to/course.zip
python3 installer/timegate.py preview /path/to/course.zip --minutes 30 --maximum 90 --storage localStorage
python3 installer/timegate.py build /path/to/course.zip --minutes 30 --maximum 90 --storage localStorage
```

For the specified employee course:

```sh
python3 installer/timegate.py build \
  /Users/jackcasica/Downloads/sexual-harassment-prevention-plan-for-employees-scorm12-khtl5CtX.zip \
  --minutes 30 --maximum 90 --storage localStorage
```

Use `--maximum none` for no maximum, `--output /path/to/result.zip` for another
output location, and `--replace` only when intentionally replacing an output.
Unpacked directories are also accepted and preserved by the normal build command.
`defaults` prints canonical defaults; `validate /path/to/config.json` validates a
configuration. Commands return JSON on success and a nonzero exit code on failure.

## Advanced profiles

A profile is JSON with a `timegate` object containing overrides. Example:

```json
{
  "timegate": {
    "audioCuesEnabled": false,
    "inactivityForceExitEnabled": false
  }
}
```

Choose the profile in the interface or pass `--profile /path/to/profile.json`.
Settings are applied in this order, with later entries taking priority:

1. Canonical defaults in `src/timegate.config.json`.
2. Existing package configuration, or an explicit `--config` replacement.
3. Profile `timegate` settings.
4. Explicit minimum, maximum, and storage choices.

The CLI retains canonical `dual` storage when no package/profile/flag selects
another mode. Both interactive interfaces explicitly select local storage only
by default. Existing valid relay settings survive repackaging.

Telemetry requires an explicit `observability` profile object with `endpoint`,
`source_key_id`, `pilot_token`, and `paycom_course_id`, or the CLI's
`--observability` switch and pilot values. Merely setting pilot environment
variables does not enable telemetry. See [observability](observability.md).
Review and build receipts omit tokens and relay credentials; these values still
ship inside a package when the corresponding feature is intentionally enabled.

## Package guarantees and scope

The engine stages the course privately, validates configuration and recognizable
single-SCO Rise structure, installs the runtime, checks script order and manifest
references, verifies ZIP bytes and unrelated course-file preservation, then
publishes the output atomically. The source ZIP is never changed. Unsafe archive
paths, symlinks, duplicate names, partial installs, and ambiguous package structures
are rejected. Failed validation leaves any previous output intact.

Timegate-only builds support SCORM 1.2 and 2004. Optional observability currently
supports SCORM 1.2 only and rejects previously instrumented observability packages.
Complete Timegate-only installs can be repackaged without duplicate tags; course
identity and valid existing settings are preserved.

## Migration and maintenance

The old top-level installer scripts have been removed. Update saved shortcuts to
`launchers/mac.command`, `launchers/windows.cmd`, or the Raycast launcher in
`launchers/raycast.sh`. Existing Raycast registrations should keep their registered
filename and point directly to `installer/launchers/mac.command`.

For command-line automation, use `python3 installer/timegate.py build SOURCE`.
Python callers import `installer.core.package`, `installer.core.config`, or
`installer.core.observability`. To extract an observability descriptor, use
`python3 -B -m installer.core.observability /path/to/unpacked-course` from the repo.

The legacy `--in-place` mode updates an unpacked source after ZIP verification;
those individual source-file updates are not a transaction. Prefer the normal ZIP
workflow. All packaging logic belongs in `core/`; adapters handle prompts and launch only.

Run `npm run test:all` for regression coverage. CI also exercises packaging on
Windows. Native Windows dialog behavior needs a Windows desktop smoke test;
PowerShell parsing and CLI parity on Mac cannot establish that UI behavior.
