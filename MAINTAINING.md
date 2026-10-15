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

The installer reads defaults from `src/timegate.config.json`; no launcher owns a
copy. Keep shared defaults aligned with `DEFAULT_CONFIG` in `src/timegate.js`.
The packaging default-contract test checks parity, excluding the per-course time
limits. The browser's zero-minute placeholder does not replace a missing config.

All launcher validation goes through `installer/core/config.py`. Keep it aligned
with runtime validation. Missing or invalid core settings must never silently
weaken completion enforcement. An explicit `minRequiredMinutes: 0` is supported
for maximum-only courses. Add changes to `CHANGELOG.md`.

Audio- and seat-time-only settings are exceptions to global runtime blocking.
Packagers reject invalid optional settings before writes, but malformed audio
configuration that reaches the browser disables only sound. A malformed relay
setting disables only the reporter and emits a diagnostic. Neither path may set
`configurationBlocked` or change LMS completion behavior.

Seat-time configuration has an additional parity contract. Keep the runtime and
shared Python validator aligned on these limits:

- `seatTimeReportingEnabled` is boolean.
- `seatTimeRelayUrl` is a string of at most 2,048 characters.
- `seatTimeRelayKey` is a string of at most 512 characters.
- `courseId` is a string of at most 256 characters.
- When reporting is enabled, the URL, key, and Clean Course ID are all nonempty.
  The URL uses HTTPS, except for HTTP loopback endpoints used only in development.

The generated defaults stay disabled with all three string values empty. Do not
add relay keys to command-line arguments, environment variables, review text, or
installer output. `courseId` is relay data; never substitute the generated
`courseKey`.

Audio configuration has one package-level capability flag:

- `audioCuesEnabled` is boolean. `true` offers learner controls; it does not grant
  playback consent.
- Learner playback always starts off unless that verified learner and course
  already have an explicit local preference.
- Store the preference only in learner-and-course-scoped browser `localStorage`,
  never unresolved state, persisted learner state, LMS `suspend_data`,
  observability snapshots, or relay payloads.
- Audio failures are fail-open. They must never delay or alter timing, completion,
  persistence, ownership, finalization, termination, or seat-time delivery.
- Keep cues synthesized through Web Audio. Adding `<audio>` elements would make
  Timegate's media detector mistake its own feedback for course media.

## Values that are not release numbers

- **`STATE_VERSION`** in `src/timegate.js` is the saved-state schema version. Change
  it only when the structure of persisted learner state changes. Changing it
  invalidates existing saved state.
- **`INSTANCE_KEY`** and **`SUSPEND_DATA_KEY`** are storage namespaces. Do not change
  them as part of a release, because existing learner progress would no longer be
  found.

## LMS reporting invariants

- Load `lms-interface.js`, the optional observability host, and Timegate synchronously in
  that order. Timegate's provisional gate must run before any course bootstrap.
- Do not clear queued completion until terminal `SetValue` calls and `Commit`
  return normalized success. A later incomplete/reset status supersedes the queue.
- Treat SCORM 2004 `completion_status` and `success_status` independently. A reset
  of one must not erase a queued write for the other.
- Return synthetic queued success only after the pending completion or Finish is
  durably stored. Persist deferred Finish state until finalization and termination
  are both acknowledged.
- Persist the inactivity relaunch notice before Finish/Terminate, hydrate it only
  for a verified learner/course resume, and never replay a failed inactivity
  termination against the newly initialized LMS session.
- Only the current learner/course lock owner may force an inactivity exit, present
  or acknowledge its relaunch notice, or resume tracking. Ownership takeover may
  hydrate local state only when the LMS reports `resume`.
- Reconcile dual-storage conflicts by monotonic `persistenceRevision` before the
  legacy timestamp fallback. Keep the LMS form of the inactivity marker compact
  and omit null optional fields so the notice does not consume avoidable
  `suspend_data` headroom.
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

## Seat-time relay invariants

- Use the current launch's canonical Timegate active clock. Background time counts
  only through `backgroundGraceSeconds`; do not create an independent timer with
  different idle, media, focus, or primary-tab rules.
- Do not send until the LMS has initialized and learner identity is verified. Keep
  the relay's Clean `courseId` separate from package-state `courseKey`.
- Fresh GUI and Raycast packages must keep relay reporting disabled. The Windows
  GUI may preserve the four validated seat-time fields from an existing package,
  but must not display or log their URL, key, or course ID.
- Persist the latest snapshot before transmission in a bounded outbox scoped to
  relay, course, learner, and attempt. The outbox uses per-attempt/revision
  `localStorage` records so tab handoff cannot overwrite another attempt. Serialize
  delivery and clear only the exact revision acknowledged with `{ "ok": true }`;
  an older response must not clear or overwrite newer seat time. If `localStorage`
  is unavailable, disable delivery and emit only a privacy-safe diagnostic.
- Freeze an attempt on lock loss, inactivity or maximum exit, successful
  termination, and `pagehide`; start a new attempt after ownership returns.
  `activeSeconds` is the canonical Timegate active delta for that owned segment,
  including configured background grace. `totalSeconds` is segment wall time and
  `idleSeconds = totalSeconds - activeSeconds`. Preserve monotonic active, idle,
  and total maxima if the system wall clock moves backward.
- Persist a confirmed completion timestamp with same-learner Timegate state. Send
  it only with `completed: true`; send explicit `null` otherwise so the relay can
  clear a stale Airtable value after a reset.
- Treat relay delivery as fail-open for LMS behavior. Fetch, beacon, CORS, storage,
  relay, and seat-time configuration failures remain retryable or diagnostic only;
  they never set global configuration blocking, mutate LMS state, or attest SCORM
  completion.
- The packaged shared key and CORS policy do not authenticate the learner, course,
  or elapsed time. Rotate any exposed key, including the value shared in the
  implementation thread, before production.
- Before an assigned-learner canary, use synthetic reordered and concurrent
  submissions to prove the relay applies revisions atomically and monotonically.
  `{ "ok": true }` must mean the revision was durably applied or an equal/higher
  valid revision already covers it. Never order by client `reportedAt`; prevent a
  legacy request without `revision` from overwriting a revisioned row. Then require
  one assigned-learner LMS canary before rollout to verify the real course origin
  and readable CORS, exact identifiers, one row per attempt, explicit-null
  completion clearing, and the intended Airtable Enrollment link projection.

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
