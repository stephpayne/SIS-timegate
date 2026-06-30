# Maintaining Timegate

Use this guide when changing Timegate runtime behavior, installer behavior, or
release metadata.

## Versioning

The version number is stored in one place: `VERSION`.

Timegate uses version-free runtime filenames and deployment paths so course
packages, installer scripts, and manifests stay consistent between releases.

### Rules

1. **`VERSION` is the source of truth.** It contains one value, such as `1.0.0`.
2. **Do not use version numbers in file or folder names.** Runtime files remain
   `timegate.js`, `timegate.css`, and `timegate.config.json`.
3. **Keep the in-package folder name stable.** The installers define it once as
   `timegate`. Do not rename it without updating the installer, manifest
   registration, and injected CSS/JS paths.
4. **Use `CHANGELOG.md` to document releases.** Do not add release numbers to
   deployed paths or folder names.

A normal release updates `VERSION` and `CHANGELOG.md`.

## Release process

1. Make the runtime or installer change in `src/` and/or `installer/`.
2. Update `VERSION` using semantic versioning: `MAJOR.MINOR.PATCH` for breaking
   changes, features, and fixes.
3. Add a dated entry at the top of `CHANGELOG.md`.
4. When a default setting changes, update every default copy listed below.

## Changing default settings

The runtime configuration file is `src/timegate.config.json`. It supports `//`
comments and trailing commas. `minRequiredMinutes` is the per-course value. The
remaining values are shared defaults.

Keep these four locations aligned when changing a default:

1. `DEFAULT_CONFIG` in `src/timegate.js`
2. `src/timegate.config.json`
3. `Get-DefaultSettings` in `installer/Timegate-Installer.ps1`
4. `write_default_config` in `installer/Timegate-Installer.command`

Then add the change to `CHANGELOG.md`.

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

## Scope: single-SCO packages

The installers gate the first SCO resource in the manifest (the course launch
file). This fits single-SCO exports such as Articulate Rise. In a package with
multiple SCOs, only the first SCO would be gated; multi-SCO support is not part of
this release.

## Known limitation

Timegate can detect and control only same-origin video. Embedded third-party video,
including YouTube or Vimeo, cannot be detected for playback activity or forward-skip
prevention. See the README for the recommended configuration when a course includes
embedded video.

## Version control

Keep the project in Git. Commit related runtime, installer, configuration,
`VERSION`, and `CHANGELOG.md` changes together.

Do not commit generated `*-timegate.zip` files.
