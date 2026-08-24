# Maintaining Timegate

Use this guide when changing Timegate runtime behavior, installer behavior, or
release metadata.

## Versioning

The release version is authoritative in `VERSION`. The private npm manifests
mirror that value so test tooling and dependency metadata identify the same
release.

Timegate uses version-free runtime filenames and deployment paths so course
packages, installer scripts, and manifests stay consistent between releases.

### Rules

1. **`VERSION` is the source of truth.** It contains one value, such as `1.0.0`.
2. **Keep `package.json` and `package-lock.json` synchronized with `VERSION`.**
   They are mirrors for local and CI tooling, not independent release sources.
3. **Do not use version numbers in file or folder names.** Runtime files remain
   `timegate.js`, `timegate.css`, and `timegate.config.json`.
4. **Keep the in-package folder name stable.** The installers define it once as
   `timegate`. Do not rename it without updating the installer, manifest
   registration, and injected CSS/JS paths.
5. **Use `CHANGELOG.md` to document releases.** Do not add release numbers to
   deployed paths or folder names.

A normal release updates `VERSION`, both npm manifests, and `CHANGELOG.md`.

## Release process

1. Make the runtime or installer change in `src/` and/or `installer/`.
2. Update `VERSION` using semantic versioning: `MAJOR.MINOR.PATCH` for breaking
   changes, features, and fixes.
3. Mirror the same value in `package.json` and `package-lock.json`.
4. Add a dated entry at the top of `CHANGELOG.md`.
5. When a default setting changes, update every default copy listed below.

## Changing default settings

The runtime configuration file is `src/timegate.config.json`. It supports `//`
comments and trailing commas. `minRequiredMinutes` and `maxAllowedMinutes` are
per-course values. The remaining values are shared defaults.

Keep these four locations aligned when changing a default:

1. `DEFAULT_CONFIG` in `src/timegate.js`
2. `src/timegate.config.json`
3. `Get-DefaultSettings` in `installer/Timegate-Installer.ps1`
4. `write_default_config` in `installer/Timegate-Installer.command`

The per-course floor and maximum also appear as primary controls in both GUI
installers. Keep their validation, review text, and generated configuration in
sync with the runtime rules (`maxAllowedMinutes` is either `null` or greater than
`minRequiredMinutes`).

Then add the change to `CHANGELOG.md`.

Configuration validation is intentionally fail-closed. Keep the runtime validator,
the Python packager validator, and the PowerShell validator aligned. An absent or
invalid value must never be coerced into a setting that weakens completion
enforcement. `minRequiredMinutes: 0` remains an explicit supported value for
maximum-only courses; it is distinct from a missing or invalid setting.

The GUI installers carry their own copy of the defaults, so they must be kept in
sync with the runtime configuration whenever a default changes. A future refactor
could have both installers read from `src/timegate.config.json` directly.

## Values that are not release numbers

- **`STATE_VERSION`** in `src/timegate.js` is the saved-state schema version. Change
  it only when the structure of persisted learner state changes. Changing it
  invalidates existing saved state.
- **`INSTANCE_KEY`** and **`SUSPEND_DATA_KEY`** are storage namespaces. Do not change
  them as part of a release, because existing learner progress would no longer be
  found.

## LMS reporting invariants

- Load `lms-interface.js`, the observability host, and Timegate synchronously in
  that order. Timegate's provisional gate must run before any course bootstrap.
- Do not clear queued completion until terminal `SetValue` calls and `Commit`
  return normalized success. A later incomplete/reset status supersedes the queue.
- Treat SCORM 2004 `completion_status` and `success_status` independently. A reset
  of one must not erase a queued write for the other.
- Return synthetic queued success only after the pending completion or Finish is
  durably stored. Persist deferred Finish state until finalization and termination
  are both acknowledged.
- Resolve learner identity only after successful LMS initialization. Never read or
  merge an anonymous local backup into learner-scoped state.
- Only the tab holding the verified learner/course lock may persist or release a
  completion queue; secondary tabs must not overwrite the primary tab's state.
- Write only the current launch's active seconds to `session_time`; cumulative
  active time remains in the Timegate state namespace.
- Finalize resume data and session time before one successful termination. Do not
  report synthetic gated success as an LMS write in observability.
- On a resumed observability document, require both an exact learner match and a
  live canonical completion read before releasing stored telemetry. Live LMS state
  always overrides a restored completion claim.

## Scope: single-SCO packages

The installers require exactly one SCO resource in the manifest. This fits
single-SCO exports such as Articulate Rise. Multi-SCO packages are rejected rather
than producing a package where only one launch is gated.

## Known limitation

Timegate can detect and control only same-origin video. Embedded third-party video,
including YouTube or Vimeo, cannot be detected for playback activity or forward-skip
prevention. See the README for the recommended configuration when a course includes
embedded video.

## Version control

Keep the project in Git. Commit related runtime, installer, configuration,
`VERSION`, and `CHANGELOG.md` changes together.

Do not commit generated `*-timegate.zip` files.
