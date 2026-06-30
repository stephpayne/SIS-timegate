# Changelog

All notable changes to Timegate are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-06-30

### Added
- Time-gating runtime (`timegate.js`, `timegate.css`) that enforces a minimum seat
  time before a SCORM course can be marked complete, with a learner-facing timer.
- Two-stage inactivity handling: a gentle "still here?" nudge before a firm
  countdown to session end, with configurable timings.
- Same-origin video controls: playback counts toward the floor time, and forward-skipping
  can be disabled.
- Dual-mode resume storage (`localStorage` and SCORM `suspend_data`) for reliable
  resume across sessions.
- Double-click installers for Windows (`Launch-Timegate-Installer.cmd` →
  `Timegate-Installer.ps1`) and macOS (`Timegate-Installer.command`), with standard
  and advanced configuration modes. The original package is never modified, and the
  output is verified before completion.
- Command-line packagers (`install-timegate.ps1`, `install-timegate.sh`) that run the
  same injection against an unzipped course folder.
- Configuration via `src/timegate.config.json`, with `minRequiredMinutes` as the
  per-course value and documented defaults for all other behavior.
