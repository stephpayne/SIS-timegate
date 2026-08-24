# Timegate

A drop-in time-gating add-on for SCORM courses. It enforces a required floor time
before a course can be marked complete, can enforce an optional cumulative active-
time maximum, shows a learner-facing timer, and handles inactivity with a gentle
"still here?" prompt before any firm action. The launch acknowledgement visually
hands the timer into its corner position, where learners can open a `What's this?`
explainer at any time.

The current version is recorded in [`VERSION`](./VERSION), with release notes in
[`CHANGELOG.md`](./CHANGELOG.md).

## Project layout

```
timegate/
├── VERSION             Single source of truth for the version number
├── README.md           This file
├── CHANGELOG.md        Release notes (newest first)
├── MAINTAINING.md      How to change settings and cut a release
├── src/                Runtime that ships into a course
│   ├── timegate.js
│   ├── timegate.css
│   ├── timegate.config.json
│   └── observability/
│       ├── host.js
│       └── content-probe.js
└── installer/          Builds the time-gated package
    ├── course_descriptor.py
    ├── instrument_package.py
    ├── timegate_config.py             Shared POSIX/macOS config validation
    ├── timegate_config.ps1            Windows config/path validation
    ├── Launch-Timegate-Installer.cmd   Windows launcher (double-click)
    ├── Timegate-Installer.ps1          Windows installer interface
    ├── Timegate-Installer.command      macOS installer (double-click)
    ├── install-timegate.ps1            Core packager (Windows)
    └── install-timegate.sh             Core packager (macOS/Linux)
```

## Adding Timegate to a course

Double-click the installer for your platform, select the zipped SCORM package,
and follow the prompts. No unzipping or command line is required.

- **macOS observability pilot:** `installer/Timegate-Installer.command` (on
  first run, if macOS blocks it, right-click the file and choose Open)
- **Windows Timegate only:** `installer/Launch-Timegate-Installer.cmd`.
  Observability parity is intentionally deferred until after the controlled
  pilot.

In the installer:

1. **Select the SCORM ZIP.** The original export is not modified.
2. **Set the required floor time** in minutes — the minimum time learners should
   spend in the course. Optionally set a greater maximum active time; leaving it
   blank allows unlimited time.
3. **For an observability pilot, enter the worker endpoint, source-key ID,
   course-scoped pilot token, and exact Paycom Course ID.**
4. **Adjust Advanced Settings** only if the course requires an exception to the
   standard behavior. The defaults suit most courses.
5. **Review and confirm.** The installer writes a separate `<course>-timegate.zip`
   beside the original and verifies that it contains the runtime files.
6. **Upload the `-timegate.zip`** to the LMS. After uploading, launch the course,
   close it, and reopen it to confirm the timer resumes.

The runtime is deployed into a fixed `timegate/` folder inside the package. The
folder name does not change between releases, so manifest references remain valid.
See
[`installer/SCORM-OBSERVABILITY.md`](./installer/SCORM-OBSERVABILITY.md)
for the pilot package contract, privacy boundary, and non-interactive options.

### Running the core packager directly

The packagers can also be run against an already-unzipped course folder:

- macOS/Linux observability pilot:
  `installer/install-timegate.sh --help`
- Windows: `installer\install-timegate.ps1 -Package C:\path\to\unzipped-course`

## Verification

Install the pinned browser-test dependency, install Chromium once, then run the
Node and Playwright suites:

```sh
npm ci
npx playwright install chromium
npm run test:all
```

Packaging and attached-sample descriptor commands are documented in
[`installer/SCORM-OBSERVABILITY.md`](./installer/SCORM-OBSERVABILITY.md).

## Settings

Settings live in `src/timegate.config.json`. `minRequiredMinutes` and the optional
`maxAllowedMinutes` are per-course values; the remaining settings are shared
defaults documented inline. A maximum must be greater than the floor, and `null`
disables it. The file supports `//` comments and trailing commas, which are stripped
before the course reads it. Installers validate every setting and add a stable,
package-specific `courseKey` used to isolate learner backup state.

Timegate treats a missing, malformed, or semantically invalid configuration as a
reporting fault: completion stays blocked and the learner is told to contact the
training administrator. It never substitutes an implicit zero-minute gate. See
`MAINTAINING.md` for guidance on changing defaults.

## Known limitation: cross-origin video

Timegate counts video and audio as activity only for media it can access in the page
(same-origin). Third-party embeds such as YouTube or Vimeo are cross-origin, so
their playback is not detected: it does not count toward the floor time, and the
inactivity flow may trigger during playback. For courses with embedded third-party
video, raise `inactivityForceExitMinutes` above the longest video or set
`inactivityForceExitEnabled` to `false`. Course-hosted (same-origin) video is
preferred.
