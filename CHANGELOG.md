# Changelog

All notable changes to Timegate are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Learner-opt-in Web Audio cues for inactivity nudges and warnings, live minimum-
  time milestones, confirmed LMS completion, and terminal inactivity/maximum
  exits, with a persistent accessible mute control and learner-and-course-scoped
  preference.
- Audio cue arbitration, primary-tab and visibility fencing, live-only transition
  guards, and fail-open browser coverage that keeps sound isolated from LMS state.
- Optional, disabled-by-default seat-time relay settings with matching runtime,
  Python, and PowerShell validation; generated GUI and Raycast configurations
  remain disabled until a reviewed per-course opt-in.
- Verified-learner, primary-tab seat-time reporting with canonical active-time
  segments, revisioned store-before-send retries, lifecycle checkpoints, and
  persisted completion confirmation timestamps.
- Packaging coverage for HTTPS and loopback-development endpoints, required relay
  identity fields, bounded strings, custom-config preservation, and disabled
  Timegate-only output.
- Windows GUI updates preserve an existing validated seat-time configuration
  without displaying its relay URL, key, or course ID; fresh packages remain off.
- A learner- and course-scoped, one-time relaunch explanation after inactivity
  termination, persisted before LMS Finish/Terminate and cleared on acknowledgement.
- A persistent learner-facing **Course status and support** surface that separates
  minimum time, authored-course completion, LMS saving/retry, finalization, and
  confirmed completion; only the confirmed state tells the learner it is safe to
  close the course.
- A learner-copyable Support Report v1 with a privacy-safe support code, opaque
  correlation identifiers, Timegate timing, completion-handshake and persistence
  outcomes, coarse browser capabilities, sanitized issue codes, and a bounded
  event timeline.
- Problem-state banners and locally available support-report actions for LMS save
  failures, delayed completion, configuration or persistence failures, and
  inactivity/maximum exits. Every terminal overlay exposes **Copy support report**,
  including after LMS termination.
- Explicit-action clipboard copying with an identical preview, a read-only
  selectable-text fallback when browser clipboard access is unavailable or
  denied, and a minimal fallback artifact when full report generation fails.
- Bounded `suspend_data` failure reasons, field lengths, and numeric LMS error
  codes in learner support reports, without exposing the stored course data.

### Changed
- Minimum-time success is no longer presented as course completion. Confirmed
  completion requires the canonical status write, commit, immediate readback of
  the applicable canonical terminal status, an empty related outcome queue,
  current-session time and persistence finalization, and any deferred termination.
- Fresh and ab-initio launches never hydrate a prior attempt and report no resume
  source. LMS `suspend_data` compaction preserves core timing and the pending
  completion queue ahead of optional support diagnostics and the support attempt
  ID.
- Learner reports summarize optional observability using exactly `enabled`,
  `deliveryState`, and `revision`; prior-device diagnostics are advertised only
  after a succeeded delivery.
- Rise progress saves retain Timegate's LMS checkpoint when the shared
  `suspend_data` value fits, including during the asynchronous configuration
  load on resume. When it does not, the original course write takes
  priority and Timegate keeps the failure visible while preserving its browser
  backup where available. Explicit course resets pass through unchanged, and
  Timegate never writes over an empty LMS read unless its success is confirmed.
- Local-storage-only packages declare their policy synchronously at launch,
  leave Rise's `suspend_data` untouched, and fail closed when browser storage is
  unavailable instead of silently reverting to LMS persistence.

### Security
- Relay documentation now makes the learner-visible shared-key and CORS limits
  explicit, requires exposed-key rotation, and keeps relay delivery separate from
  LMS completion evidence.
- Learner support reports use a bounded allowlist and exclude learner identity,
  employee data, answers, credentials, URLs, raw LMS/browser storage, and arbitrary
  diagnostics. Copied SCORM error codes are numeric-only. Reports are never sent
  automatically, and their checksum is truncation detection rather than proof of
  authenticity or completion.

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
