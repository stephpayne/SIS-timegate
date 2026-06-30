# Timegate

A drop-in time-gating add-on for SCORM courses. It enforces a required floor time
before a course can be marked complete, shows a learner-facing timer, and handles
inactivity with a gentle "still here?" prompt before any firm action.

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
│   └── timegate.config.json
└── installer/          Builds the time-gated package
    ├── Launch-Timegate-Installer.cmd   Windows launcher (double-click)
    ├── Timegate-Installer.ps1          Windows installer interface
    ├── Timegate-Installer.command      macOS installer (double-click)
    ├── install-timegate.ps1            Core packager (Windows)
    └── install-timegate.sh             Core packager (macOS/Linux)
```

## Adding Timegate to a course

Double-click the installer for your platform, select the zipped SCORM package, and
follow the prompts. No unzipping or command line is required.

- **Windows:** `installer/Launch-Timegate-Installer.cmd`
- **macOS:** `installer/Timegate-Installer.command` (on first run, if macOS blocks
  it, right-click the file and choose Open)

In the installer:

1. **Select the SCORM ZIP.** The original export is not modified.
2. **Set the required floor time** in minutes — the minimum time learners should
   spend in the course.
3. **Adjust Advanced Settings** only if the course requires an exception to the
   standard behavior. The defaults suit most courses.
4. **Review and confirm.** The installer writes a separate `<course>-timegate.zip`
   beside the original and verifies that it contains the runtime files.
5. **Upload the `-timegate.zip`** to the LMS. After uploading, launch the course,
   close it, and reopen it to confirm the timer resumes.

The runtime is deployed into a fixed `timegate/` folder inside the package. The
folder name does not change between releases, so manifest references remain valid.

### Running the core packager directly

The double-click installers wrap two scripts that can also be run against an
already-unzipped course folder:

- macOS/Linux: `installer/install-timegate.sh /path/to/unzipped-course`
- Windows: `installer\install-timegate.ps1 -Package C:\path\to\unzipped-course`

## Settings

Settings live in `src/timegate.config.json`. `minRequiredMinutes` is the per-course
value; the remaining settings are shared defaults documented inline. The file
supports `//` comments and trailing commas, which are stripped before the course
reads it. See `MAINTAINING.md` for guidance on changing defaults.

## Known limitation: cross-origin video

Timegate counts video and audio as activity only for media it can access in the page
(same-origin). Third-party embeds such as YouTube or Vimeo are cross-origin, so
their playback is not detected: it does not count toward the floor time, and the
inactivity flow may trigger during playback. For courses with embedded third-party
video, raise `inactivityForceExitMinutes` above the longest video or set
`inactivityForceExitEnabled` to `false`. Course-hosted (same-origin) video is
preferred.
