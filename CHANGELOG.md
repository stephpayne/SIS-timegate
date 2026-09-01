# Changelog

All notable changes to Timegate are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/).

## [1.4.0] - 2026-08-24

### Changed
- Timegate now installs a synchronous provisional LMS gate before configuration
  loading, so early course completion and termination calls cannot bypass the
  minimum-time policy.
- Completion delivery is transactional: terminal status remains pending until
  both `SetValue` and `Commit` succeed, failed delivery is retried, and a later
  incomplete/reset status cancels stale queued completion.
- SCORM 2004 completion and success statuses are reset independently, and Rise
  driver completion is not accepted until LMS read-back and Commit both succeed.
- Learner backup state is keyed only after a successful LMS initialization and
  verified learner identity. Fresh attempts do not import resume-only local
  state, and the default dual mode now prevents secondary tabs from overwriting
  the primary tab's timer or pending completion state.
- Normal, inactivity, and maximum-time exits write the active time for the
  current LMS session, persist resume data, verify commit results, and terminate
  at most once. Deferred Finish requests survive a resume launch, while failed
  finalization remains pending for retry instead of closing inaccurately.
- Invalid or unavailable Timegate configuration now blocks completion and emits
  an explicit diagnostic instead of silently falling back to a zero-minute gate.
- Package installers validate configuration semantics, generate a stable
  package-specific `courseKey`, verify exact injected asset paths and synchronous
  launch order, and reject stale or partial installations.
- Observability distinguishes queued, written, and committed completion and no
  longer certifies a Timegate-gated status as an LMS completion. Reloaded
  telemetry waits for live learner and completion state, and page-exit snapshots
  include last-chance LMS finalization failures. Durability warnings resolve only
  after a confirmed recovery write.

### Added
- Regression coverage for production load order, stale completion reset,
  failed completion replay, learner isolation, persistence failures, maximum
  termination, SCORM 2004 completion/session-time semantics, duplicate LMS
  initialization, malformed suspend data, deferred Finish recovery, fail-closed
  missing configuration, and competing browser tabs.

## [1.3.0] - 2026-08-24

### Added
- An animated launch-modal handoff that shows the learner-facing timer moving
  into its persistent corner position, followed by a short live-timer highlight.
- An accessible `What's this?` explainer inside the timer indicator with click,
  keyboard, touch, reduced-motion, and reduced-transparency support.

## [1.2.0] - 2026-08-14

### Added
- Optional per-course `maxAllowedMinutes` enforcement based on cumulative active
  time, with a visible countdown after the minimum is met and a persisted SCORM
  session lockout when the maximum is reached.
- Maximum-time configuration and validation in both desktop installers.
- A distinct `maximum_time_reached` observability event and diagnostic issue.

## [1.1.0] - 2026-07-28

### Added
- Fail-open SCORM 1.2 observability modules for the Rise driver and content
  frame, with cumulative, revisioned learner-session snapshots and bounded
  privacy-safe diagnostics.
- Guarded `sis:timegate` lifecycle events so observability can use Timegate's
  canonical active/idle clock without changing completion behavior.
- A standard-library Python Rise course descriptor extractor with a canonical
  structure hash and explicit metadata-mismatch warnings.
- Deterministic observability injection, validation, and pilot configuration in
  the POSIX and macOS package builders.
- A local SCORM 1.2 LMS harness and runtime/package contract tests.

### Security
- Telemetry excludes learner names, answer text, correct answers, raw suspend
  and launch data, comments, URL tokens, cookies, and arbitrary request bodies.
- Delivery, storage, diagnostic, and memory limits remain bounded when the
  telemetry endpoint is unavailable.

## [1.0.1] - 2026-07-07

### Fixed
- The inactivity force-exit clock no longer runs while the course tab is hidden
  (e.g. the learner switched to another window). The nudge and countdown
  warnings are invisible in a hidden tab, so learners were being exited with no
  visible warning and reported it as a crash. Seat time was already paused for
  hidden tabs, so this change gives up no seat-time protection.

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
