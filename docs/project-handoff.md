# Project handoff

This checkout was prepared for local retirement on October 15, 2026. The code,
installer, automated tests, and maintenance documentation are preserved in Git.
The release version remains 1.4.0; subsequent changes are marked Unreleased.

## Retained implementation

- Browser and LMS persistence modes, learner support reports, optional audio,
  inactivity handling, and optional seat-time reporting.
- One Python packaging engine with Mac, Windows, and Raycast launchers. Start
  with [the installer guide](installer.md); obsolete top-level scripts were removed.
- Rise session-time normalization, deferred completion recovery after driver
  unload, and retained-parent-API wrapper cleanup, with browser regressions.

## Validation boundaries

Automated local coverage does not establish Paycom server persistence or
production acceptance. The Rise repairs remain candidates for a controlled
target-LMS test. Investigations did not prove the cause of historical LMS time
overreporting. Do not treat generated candidate packages as deployed releases.

Local storage resume requires the same browser profile and device. A configured
maximum limits Timegate's local attempt clock; it does not impose an aggregate
LMS time cap across devices, launches, or reset state. Completion is safe to close
only after the required LMS completion and finalization operations succeed.

Native Windows dialogs still require a Windows desktop smoke test. CI exercises
PowerShell parsing and shared packaging on Windows.

## Excluded artifacts

The owner authorized deletion of generated packages, course media, learner
investigation data, and local verification artifacts rather than remote archival.
They are excluded under `output/` and are not part of this source repository.
Dependencies, caches, and test reports are also excluded and can be recreated.

Any separately installed Raycast shortcut depends on a local checkout and will
need a restored checkout or an updated path after the project folder is removed.
