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

### Raycast installer

For Timegate without telemetry, follow the [Raycast setup guide](docs/raycast-setup.md).
Install the small launcher once so Raycast uses the maintained installer in this
checkout, including its local storage only option.

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

Timegate treats a missing, malformed, or semantically invalid core configuration
as a reporting fault: completion stays blocked and the learner is told to contact
the training administrator. It never substitutes an implicit zero-minute gate.
Optional audio and seat-time settings fail independently and never change LMS
completion behavior. See `MAINTAINING.md` for guidance on changing defaults.

## Course status and learner support report

Timegate treats meeting the minimum time, finishing the authored course, and
saving completion to the LMS as separate milestones. A compact information
control beside the timer opens **Course status** as a dialog on desktop or a
bottom sheet on narrow screens. It shows the current status, active time, required
minimum, configured maximum, and relevant support actions.

The learner-facing states have deliberately different meanings:

| Status | Meaning | Safe to close as complete |
| --- | --- | --- |
| Time requirement in progress | The learner has not yet reached the minimum. | No |
| Course finished; waiting for time | The course requested completion before the minimum was reached. | No |
| Minimum time met | The time requirement is satisfied, but the course has not requested completion. The learner should finish any remaining activities. | No |
| Saving or still saving completion | Timegate received the completion request, but an LMS write, commit, canonical terminal-status readback, related outcome, or finalization step is pending or retrying. | No |
| Completion accepted; finalizing | The completion status was accepted, but course time, persistence, or termination still needs to finish saving. | No |
| Completion confirmed | The completion write, commit, immediate canonical readback, all related queued outcomes, current-session time and persistence, and any deferred termination succeeded. | Yes |

Configuration, missing-LMS, secondary-tab, inactivity-exit, and maximum-time
states remain action-required rather than completion states. Green/success
treatment and **You may close the course** wording are reserved for confirmed
completion. A browser-visible SCORM readback is the strongest confirmation the
course can obtain, but the LMS enrollment record remains authoritative.

When saving fails or remains pending, Timegate keeps a visible status message and
asks the learner to leave the course open while it retries. If a real completion
request is pending, the support surface can offer **Try saving again** through the
same throttled replay path. That action cannot create a completion request, bypass
course requirements, or mark the learner complete by itself. Inactivity,
maximum-time, and configuration overlays all expose **Copy support report**, which
continues to work after LMS termination because report generation is local and
read-only.

### Copying or downloading a support report

**Copy support report** and **Download support report** each freeze the current
status into a bounded plain-text artifact containing a human-readable header and
versioned JSON. Its support code and opaque attempt, launch, and report identifiers
let Training Support correlate a report with available system records even though
the support code is not displayed in the learner-facing panel. The attempt identifier is stable across
same-device resumes; a cross-device resume can receive a replacement when limited
LMS `suspend_data` headroom requires omitting that optional identifier. The report
also includes Timegate timing, the completion-handshake results, persistence
outcomes, coarse browser capabilities, sanitized issue codes, and a short
allowlisted event timeline. The preview is exactly the text Timegate attempts to
copy and is limited to 12 KiB.

Before copying, Timegate explains that the report does **not** include the
learner's name, email, employee ID, answers, password, browser history, credentials,
URLs, raw LMS/browser storage, stack traces, or arbitrary error text. Any copied
SCORM error code is numeric-only. Creating or copying the report does not write to
the LMS, change completion, or automatically email, upload, or otherwise transmit
anything. Optional observability is summarized only as `enabled`, `deliveryState`,
and `revision`; its internal transport snapshot is never exposed to the learner.
Prior-device diagnostics are described as available only after observability
delivery succeeded.

The report and its checksum are diagnostic aids, not proof of learner identity,
attendance, or completion. The checksum can reveal accidental truncation or
editing, but it is not an authenticity signature. Support must corroborate the
artifact against the authoritative LMS record and, when available, server-side
observability.

Copying uses the browser clipboard only after the learner activates the button and
confirms success with **Copied to clipboard.** Downloading saves the same report as
a timestamped UTF-8 text file whose name contains no support code or learner
identity. Learners are directed to send either artifact to `training@sis.us`. If
clipboard or download access is unavailable, Timegate reveals the same report in a
read-only selectable field for manual copying or saving; those browser limitations
are not reported as course or LMS failures. If full report generation fails, a
minimal artifact still provides the support code, current state, course and runtime
versions, and a generation-failure code. Expanded report text is cleared when the
support surface closes or the course becomes hidden and is not stored as an
artifact.

## Optional sound cues

Updated packages offer brief synthesized sound cues when `audioCuesEnabled` is
`true`. Sound still starts off for every course. A learner can opt in from the
launch acknowledgement. The choice is stored only in learner-and-course-scoped
browser `localStorage`; it is never written to LMS `suspend_data` or included in
seat-time reporting. No audio control is shown beside the timer. Timegate does not
offer or inherit the preference until the LMS has verified the current learner
identity.

The cue set is intentionally sparse:

- one quiet cue when the gentle inactivity nudge appears;
- two rounded tones when the final inactivity countdown begins;
- separate rising cues for reaching the minimum active time and for confirmed LMS
  completion; and
- one descending tone when inactivity or the configured maximum ends the session.

Minimum time and completion remain distinct: the minimum cue never claims that the
course is complete, and the completion cue plays only after the exact requested
terminal status and current session are confirmed. Cues play only for live
transitions in the visible primary tab. They do not replay after hydration or
relaunch, never tick with the countdown, and cannot reset inactivity or affect
timing, persistence, completion, termination, or relay delivery. The runtime uses
Web Audio rather than media elements or remote files, so cue playback adds no
package asset or network dependency. Unsupported or blocked audio silently falls
back to the existing visual and accessible text.

## Inactivity exit and relaunch

When the visible course reaches `inactivityForceExitMinutes`, Timegate saves the
current session, requests a suspended exit, and calls the LMS termination method.
It does not close the browser window. The open page is covered with instructions
to relaunch the course from the LMS.

Before termination, Timegate stores a small inactivity-exit notice with the
learner's course state. On the next verified resume launch for that learner and
course, the ordinary launch acknowledgement is replaced with a one-time explanation
and a **Resume course** button. Acknowledging the message clears it from both LMS
`suspend_data` and the learner-scoped local backup when those stores are available.
Fresh or ab-initio attempts never hydrate the prior attempt and report no resume
source. Different learners, different courses, maximum-time lockouts, and
configuration failures do not display the inactivity relaunch notice.

Only the tab holding the learner/course lock can issue or acknowledge this exit.
A secondary tab waits for ownership and imports local state only for an LMS resume,
so a fresh attempt cannot inherit an older termination. In dual-storage mode,
Timegate reconciles the LMS and local copies by a monotonic persistence revision.
Within `suspend_data`, core timing and the pending completion queue take priority;
optional support diagnostics are omitted first, followed by the support attempt
ID if more headroom is needed. Timegate also stores a compact LMS notice when it
fits. If an acknowledgement cannot be written to any configured store, tracking
resumes and Timegate retries the clear; the notice can appear again on a later
launch until a write succeeds.

Rise can replace the entire `suspend_data` value when it records course progress.
Timegate preserves its sibling checkpoint on those writes when the combined value
fits, including while its configuration loads on a resume launch. If it does not
fit, the authored course write takes priority, the browser
backup retains Timegate state on that device, and the support report identifies
the LMS state-save failure and the relevant field lengths. A browser-only write
does not confirm LMS completion or make the course safe to close.
An intentional empty course reset passes through unchanged. Timegate also leaves
the LMS field untouched when it cannot confirm an empty read succeeded.

The Mac and Raycast installers offer **Local storage only** or **LMS + browser**
after the time limits, and show the selected mode before packaging. Local storage
only is the default button in that dialog. For unattended Raycast packaging, set
`TIMEGATE_STORAGE_MODE=localStorage`; omitting it retains the existing `dual`
default. The Mac advanced settings can override the selection, and confirmation
shows the final configuration value.

Packages configured with `storageMode: "localStorage"` declare that policy on
the Timegate script tag so it is available before configuration loads. In this
mode, Rise exclusively owns `cmi.suspend_data`; Timegate stores its timer and
pending state in learner-and-course-scoped browser storage. If browser storage is
unavailable, Timegate fails closed instead of falling back to `suspend_data`.
Resume is therefore limited to the same browser profile, device, origin, course
key, and LMS attempt marked as a resume.

## Optional seat-time relay

Timegate can send current-launch seat-time snapshots to an approved relay. The
feature is off by default. A package opts in only when
`seatTimeReportingEnabled` is `true` and all three per-course values are present:

- `seatTimeRelayUrl`: an absolute HTTPS endpoint. Plain HTTP is accepted only for
  loopback development (`localhost`, `127.0.0.1`, or `::1`).
- `seatTimeRelayKey`: the relay's shared integration key.
- `courseId`: the course's Clean Course ID. This is relay data and is distinct
  from the installer-generated `courseKey` used to isolate local Timegate state.

Fresh GUI configurations include these fields but leave them disabled and empty;
the interfaces do not expose relay controls. When the Windows GUI updates a
package that already has a valid seat-time configuration, it preserves those four
fields and shows only the on/off state during review. The Raycast Timegate-only
workflow always emits disabled defaults and does not accept or print relay
credentials. Use a reviewed custom configuration for an intentional pilot.

`activeSeconds` comes from Timegate's canonical active clock for the current
primary-tab ownership segment. It counts the configured background-grace interval
after focus is lost, then pauses while the page remains in the background. It also
pauses after the inactivity timeout and in a secondary tab; accessible same-origin
media can continue to count when `countWhileMediaPlaying` is enabled.
`totalSeconds` is that segment's wall-clock time, and `idleSeconds` is the
non-active remainder. Lock loss or a BFCache page transition closes the segment;
ownership recovery starts a new collision-resistant `attemptId`.

Before transmission, the latest attempt snapshot is stored in a bounded outbox
scoped to the relay, course, verified learner, and attempt. Delivery is serialized,
and only an acknowledgement for the exact current revision clears that snapshot.
Network errors, unreadable responses, `{ "ok": false }`, and page-exit uncertainty
remain retryable. Relay reporting is fail-open with respect to the LMS: it must
never write, clear, release, or block SCORM completion. Packagers reject invalid
relay settings before changing a course. If malformed seat-time-only settings
nevertheless reach the browser, the reporter disables itself and emits a diagnostic
without setting Timegate's global configuration-blocked state.

The outbox requires usable browser `localStorage`; if it is unavailable, reporting
stays off for that launch and Timegate emits a privacy-safe diagnostic. Pending
entries contain timing and opaque scope identifiers, never the relay key or raw
learner identity. They expire after seven days and are bounded to the 25 most
recent attempts.

The request remains JSON sent as `text/plain` and retains the relay's existing
fields. It adds `contractVersion`, integer `revision`, and `reportedAt`.
`completionTimestamp` is a persisted confirmation time when `completed` is true
and explicit `null` otherwise, so a reset can clear a stale relay value. The relay
must accept these additions and make `{ "ok": true }` mean that the exact revision
was durably applied or an equal/higher valid revision already covers it.

The shared key ships in the course and is visible to learners; it is not a secret
or proof of employee identity, course identity, or reported time. CORS is also not
authentication. Use a key dedicated to this integration, rotate it if exposed, and
rotate the value shown in the supplied implementation thread before any production
launch.

Local and packaging tests do not prove end-to-end delivery. Before a learner
canary, use synthetic contract tests to verify that relay revision ordering is
atomic and monotonic, including reordered or concurrent submissions; client
`reportedAt` values must never determine ordering. A legacy request without a
revision must not overwrite a revisioned row. Then use one assigned-learner LMS
canary to verify the real course origin and readable CORS, exact learner and Clean
Course IDs, one row per attempt, nullable completion-time behavior, and the expected
Enrollment link projection in Airtable. Do not treat a relay response or Airtable
row as LMS completion evidence.

## Known limitation: cross-origin video

Timegate counts video and audio as activity only for media it can access in the page
(same-origin). Third-party embeds such as YouTube or Vimeo are cross-origin, so
their playback is not detected: it does not count toward the floor time, and the
inactivity flow may trigger during playback. For courses with embedded third-party
video, raise `inactivityForceExitMinutes` above the longest video or set
`inactivityForceExitEnabled` to `false`. Course-hosted (same-origin) video is
preferred.
