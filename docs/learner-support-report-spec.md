# Timegate Learner Support Report specification

Status: Implemented locally; target-LMS validation pending

## Decision summary

Timegate will provide a learner-copyable **Support report** that explains the
state of the Timegate-to-LMS completion handshake without exposing credentials,
raw learner identity, course answers, or raw browser/LMS storage.

The report must be available in every Timegate package, including packages with
remote observability disabled or broken. Optional observability may enrich the
report through a separate public, allowlisted projection. The existing remote
observability snapshot must never be copied to the learner because it contains
internal transport credentials and the raw LMS learner identifier.

The report is diagnostic information, not proof of identity, attendance, or
course completion. Support must corroborate it against the authoritative LMS
record and, when present, server-side observability.

## Problem

A minimum-time confirmation means only that the active-time requirement was met.
It does not mean that:

- the original course emitted its completion signal;
- Timegate delivered that signal to the LMS;
- the LMS committed the update; or
- the authoritative LMS enrollment now shows a completion date.

A learner screenshot can therefore prove the time milestone while leaving the
actual failure point unknown. The support report must distinguish each step.

## Goals

1. Let a learner copy one bounded text artifact into email, chat, or a support
   ticket without installing tools or opening browser developer features.
2. Distinguish "minimum met," "course completion not received," "completion
   queued," "LMS save retrying," and "completion confirmed."
3. Work locally when the network, relay, or optional observability service is
   unavailable.
4. Correlate the learner's report with server telemetry when telemetry exists.
5. Preserve the existing rules for completion, timing, persistence, ownership,
   inactivity, maximum-time exit, and relay delivery.
6. Be safe to inspect and copy on a shared or managed device.

## Non-goals

- The report does not mark a learner complete or authorize a manual completion.
- The report is not tamper-proof and must not be treated as compliance evidence.
- It does not contain a full browser console, stack traces, HTTP bodies, authored
  course prose, question text, answers, or correct responses.
- It does not replace LMS readback, assigned-learner canaries, or server logs.
- Copying the report never sends it automatically.

## Learner-visible completion states

Timegate uses a distinct, non-terminal treatment for the minimum milestone and
derives one of the following states using the precedence shown.

| State | Condition | Learner-facing wording | Completion-safe to close |
| --- | --- | --- | --- |
| `configuration_error` | Core configuration cannot be verified | Course reporting is unavailable. Contact training@sis.us. | No |
| `maximum_reached` | The cumulative maximum was reached | Maximum course time reached. Contact training@sis.us. | No |
| `session_ended_inactivity` | Timegate ended the session for inactivity | This session ended after inactivity. Relaunch it from the LMS. | No |
| `secondary_session` | This tab does not own the learner/course lock | This course is active in another tab. Return to that tab or close it first. | No |
| `lms_unavailable` | The SCORM API is missing or initialization failed | The course is not connected to the LMS. Keep it open and contact training@sis.us. | No |
| `completion_saved_finalizing` | Completion write, commit, and canonical terminal-status readback succeeded, but a related outcome, session-time, persistence, or termination finalization is still pending or failed | Your completion was accepted. Keep this course open while the session finishes saving. | No |
| `completion_confirmed` | Canonical completion write, commit, immediate canonical readback, all related queued outcomes, and current-session finalization succeeded | The LMS accepted your completion and course time. You may close the course. | Yes |
| `completion_retrying` | A course completion signal exists, but the last write, commit, exact-status readback, or finalization failed | We're still saving your completion. Keep this course open. | No |
| `completion_saving` | A course completion signal is queued and an eligible save is pending or in flight | Saving your completion… | No |
| `completion_held_for_time` | The course requested completion before the minimum was met | Course finished. Keep this course open until the time requirement is met. | No |
| `minimum_met_course_not_finished` | Minimum met, but no course completion signal has been observed | Minimum time met. Finish any remaining course activities. | No |
| `time_in_progress` | Minimum not met and no completion signal exists | Time requirement in progress. | No |

"Completion-safe to close" is deliberately narrow. A learner may still close an
ordinary incomplete attempt and resume later, but Timegate must not imply that a
completion has been recorded unless the handshake is confirmed.

## How the report surfaces

### Normal access

- Add a compact persistent information button adjacent to the timer. Its visual
  icon may be smaller than the interaction target, which remains at least 44 by
  44 CSS pixels.
- Activating it opens a modal dialog on desktop and a bottom sheet on narrow
  screens. It must not replace the timer's existing elapsed/minimum/maximum
  carousel interaction.
- The first content in the panel is the current learner-visible completion state,
  followed by active time, minimum time, and maximum time when configured.
- Keep the visible surface concise: current status, timing, a short help sentence,
  and relevant actions. Do not expose the support code, LMS connection details,
  or a detailed report-contents description in the learner-facing panel. Direct
  the learner to send the copied or downloaded report to `training@sis.us`.
- The report is generated from a frozen snapshot at the moment the learner
  activates the copy button. The preview and copied text must be identical.

### Proactive access during a problem

Show a persistent, non-dismissed status banner and expose the copy action directly
when any of the following occurs:

- the first LMS completion write or commit failure;
- completion remains pending for 10 seconds after the gate becomes eligible;
- LMS initialization or core persistence fails;
- termination is deferred because completion is still pending;
- a configuration error or maximum-time exit occurs.
- optional course-progress enrichment reaches 100% but no completion signal is
  observed after a 10-second grace period.

Use this wording for a retryable completion problem:

> We're still saving your completion. Keep this course open while we retry. If
> this message remains, send the support report to training@sis.us.

Do not tell the learner to retake the course, refresh the page, clear browser
storage, or start a new attempt. Those actions can destroy the evidence needed for
recovery.

When a real pending completion exists, the panel may also show **Try saving
again**. That action invokes only the existing throttled, single-flight replay
path. It must not synthesize a completion signal, bypass course requirements, or
appear when no course completion request exists. Disable it while a replay is in
flight.

### Confirmed completion

After successful completion delivery, show a persistent confirmation:

> Completion saved at 2:14 PM. You may close the course.

The panel may offer **Copy completion support report**, but it must still say that
the report is diagnostic and that the LMS record is authoritative.

### Terminal overlays

Every full-screen terminal overlay, including inactivity, maximum-time, and
configuration exits, must include **Copy support report**. The action must
continue working after SCORM termination because report generation is local and
read-only.

### Clipboard and download behavior

1. Use `navigator.clipboard.writeText` only following an explicit learner action.
2. On success, announce through a polite live region:
   "Copied to clipboard. Send the report to training@sis.us." The visible copy
   button changes to **Copied to clipboard.**
3. If clipboard access is unavailable or denied, reveal a read-only, selectable
   text area with **Select all** instructions. Do not treat clipboard denial as a
   Timegate or LMS failure.
4. Offer **Download support report** as a secondary action. Save the same bounded
   UTF-8 plain-text report with a timestamped filename that does not expose the
   support code or learner identity. Downloading must not contact the LMS or any
   external service.
5. If downloading is unavailable, reveal the same read-only report for manual
   saving without treating it as a course or LMS failure.
6. If full generation fails, provide a minimal report containing the support code,
   current state, course identifiers, versions, and generation-failure code.
7. Never automatically email, upload, or otherwise transmit the learner copy.
8. Clear the expanded raw text when the panel closes or the page becomes hidden;
   do not persist the generated artifact itself.

### Accessibility requirements

- Dialog/sheet title: **Course status**.
- Move focus into the surface when it opens, trap focus while modal, restore focus
  to the invoking control when it closes, and support Escape where closing is safe.
- Do not use color alone to distinguish minimum met, retrying, and confirmed.
- Use a polite live region for status transitions and copy success; reserve
  assertive announcements for a terminal or action-required failure.
- All actions must be keyboard operable, have visible focus, and provide at least
  a 44 by 44 CSS-pixel target on touch screens.
- The surface must work without horizontal scrolling at a 320 CSS-pixel viewport,
  at 200% zoom, with reduced motion, and with increased text spacing.
- The raw artifact is not placed in an `aria-live` region. Screen readers should
  hear the human summary, not thousands of characters of JSON.

## Architecture

### Core ownership

The baseline report builder and a bounded critical-event ledger belong to the
Timegate core. They must not depend on:

- the optional observability endpoint;
- the optional seat-time relay;
- `fetch`, `sendBeacon`, or network availability; or
- successful browser storage.

This ensures that diagnostics remain available when the failing component is the
network or telemetry itself.

### Optional observability enrichment

The observability runtime exposes `publicSupportSnapshot()`. It builds a separate
allowlisted object for the learner report and does not return or reuse the existing
transport snapshot.

The copied report uses only the following observability fields at
`payload.observability`: `enabled`, `deliveryState`, and `revision`. The separate
attempt section may include the allowlisted observability session ID for
correlation, and the course section may use privacy-safe descriptor fields.
Sanitized observability issues or milestones may inform core classifications, but
must not expand the copied `payload.observability` object.

`priorDeviceDiagnostics` may be `available_via_observability` only after the
public projection reports a succeeded telemetry delivery. An active session ID,
pending delivery, or failed delivery does not prove that prior diagnostics are
available to support.

### Stable correlation identifiers

- `attemptId`: random UUID created for a fresh LMS attempt. Timegate retains it in
  the learner-scoped local backup and includes it in LMS state only when
  `suspend_data` has sufficient headroom. It therefore survives ordinary
  same-device resume, but a cross-device resume may receive a replacement ID when
  the optional LMS copy had to be omitted.
- `launchId`: random UUID created for each document launch.
- `reportId`: random UUID created each time a learner generates a report.
- `supportCode`: a human-readable, case-insensitive Crockford Base32 rendering of
  at least 50 bits derived from `attemptId`, formatted like
  `TG-7K2M-9Q4D-XP`. It is not a secret.
- `observabilitySessionId`: included only when the optional observability runtime
  is active.
- `relayAttemptId`: included only when a relay attempt exists. It must remain
  clearly separate from the LMS-attempt identifier.

No correlation identifier may be derived directly from an employee code, learner
name, email address, or raw LMS learner ID.

## Clipboard envelope

The copied value is UTF-8 plain text with a short human-readable header and one
canonical JSON object.

```text
TIMEGATE SUPPORT REPORT v1
Support code: TG-7K2M-9Q4D-XP
Status: Completion has not been confirmed
Generated: 2026-09-14T19:42:31.104Z
Diagnostic only; this is not proof of course completion.
-----BEGIN TIMEGATE SUPPORT DATA-----
{"schema":"sis.timegate.support-report","schemaVersion":1,"privacyProfile":"learner-support-minimized-v1","payload":{},"integrity":{}}
-----END TIMEGATE SUPPORT DATA-----
```

Requirements:

- Maximum complete artifact size: 12 KiB UTF-8.
- JSON keys use a fixed canonical order.
- Unknown fields must be ignored by future parsers.
- Required fields must never be removed to meet the limit. Trim the oldest
  timeline events first, then optional environment/enrichment fields.
- Set `payload.report.truncated` and `payload.report.omittedEventCount` whenever
  anything is removed.
- Strings are bounded before serialization; arbitrary exception messages are not
  permitted.

## Version 1 JSON shape

The following example shows a learner who met the minimum and whose course
requested completion, but whose LMS commit has not succeeded.

```json
{
  "schema": "sis.timegate.support-report",
  "schemaVersion": 1,
  "privacyProfile": "learner-support-minimized-v1",
  "payload": {
    "report": {
      "reportId": "343d243a-0b3f-4d33-b11f-2fd690d3be73",
      "supportCode": "TG-7K2M-9Q4D-XP",
      "generatedAt": "2026-09-14T19:42:31.104Z",
      "truncated": false,
      "omittedEventCount": 0
    },
    "summary": {
      "state": "completion_retrying",
      "completionSafeToClose": false,
      "reasonCode": "LMS_COMMIT_FAILED"
    },
    "course": {
      "title": "Workplace Violence Prevention Plan",
      "courseId": "4117",
      "courseKeyFingerprint": "sha256:2d12…e7c4",
      "scormVersion": "1.2",
      "timegateVersion": "1.4.0",
      "packageVersion": "2026.09.08",
      "structureHash": "sha256:fe81…3a20"
    },
    "attempt": {
      "attemptId": "3ef9bdaf-8424-4129-ab45-aa6292211954",
      "launchId": "841611ca-c50d-4ef5-8792-4700ca63bcd8",
      "entryMode": "resume",
      "resumeSource": "lms_suspend_data",
      "lifecycle": "active",
      "launchStartedAt": "2026-09-14T19:22:04.012Z",
      "tabRole": "primary",
      "coordinationScope": "same_browser_only",
      "priorDeviceDiagnostics": "available_via_observability",
      "observabilitySessionId": "767ed87f-2210-4cff-950a-b10afb8874a5"
    },
    "timing": {
      "cumulativeActiveSeconds": 1218,
      "launchActiveSeconds": 438,
      "launchIdleSeconds": 26,
      "minimumRequiredSeconds": 900,
      "minimumMet": true,
      "minimumMetAt": "2026-09-14T19:36:58.871Z",
      "maximumAllowedSeconds": 3600,
      "maximumReached": false,
      "pauseReason": null
    },
    "completion": {
      "courseSignalObserved": true,
      "signalSource": "rise_driver",
      "requestedStatus": "completed",
      "firstRequestedAt": "2026-09-14T19:40:11.003Z",
      "lastRequestedAt": "2026-09-14T19:42:29.902Z",
      "deliveryState": "commit_failed",
      "deliveryAttemptCount": 4,
      "lastWriteResult": true,
      "lastCommitResult": false,
      "lastReadbackStatus": "incomplete",
      "lmsApiAcknowledged": false,
      "serverRecordVerified": "not_available_in_course",
      "pending": true,
      "pendingDurableInLms": true,
      "terminationDeferred": true,
      "lastTerminationResult": null
    },
    "lms": {
      "apiState": "initialized",
      "learnerVerified": true,
      "canonicalStatus": "incomplete",
      "lastErrorCode": "391"
    },
    "persistence": {
      "mode": "dual",
      "revision": 87,
      "lastAttemptAt": "2026-09-14T19:42:29.910Z",
      "lastSuccessAt": "2026-09-14T19:42:29.916Z",
      "lmsState": "written",
      "browserState": "written",
      "hydratedFrom": "suspend_data",
      "lmsFailureReason": null,
      "lmsExistingChars": null,
      "lmsAttemptedChars": null,
      "lmsErrorCode": null
    },
    "relay": {
      "enabled": false,
      "deliveryState": "disabled",
      "relayAttemptId": null
    },
    "observability": {
      "enabled": true,
      "deliveryState": "succeeded",
      "revision": 44
    },
    "environment": {
      "browserFamily": "Chrome",
      "browserMajor": 140,
      "browserEngine": "Chromium",
      "osFamily": "Android",
      "deviceClass": "mobile",
      "online": true,
      "visibility": "visible",
      "capabilities": {
        "localStorage": true,
        "sessionStorage": true,
        "clipboardWrite": true,
        "pageVisibility": true,
        "pagehide": true,
        "fetch": true,
        "sendBeacon": true
      }
    },
    "issues": [
      {
        "code": "LMS_COMMIT_FAILED",
        "severity": "error",
        "active": true,
        "firstSeenAt": "2026-09-14T19:40:11.109Z",
        "lastSeenAt": "2026-09-14T19:42:29.906Z",
        "occurrenceCount": 4
      }
    ],
    "timeline": [
      {
        "sequence": 18,
        "occurredAt": "2026-09-14T19:36:58.871Z",
        "code": "MINIMUM_TIME_MET",
        "result": "success"
      },
      {
        "sequence": 21,
        "occurredAt": "2026-09-14T19:40:11.003Z",
        "code": "COURSE_COMPLETION_REQUESTED",
        "result": "observed"
      },
      {
        "sequence": 22,
        "occurredAt": "2026-09-14T19:40:11.109Z",
        "code": "LMS_COMPLETION_COMMIT",
        "result": "failed"
      }
    ]
  },
  "integrity": {
    "algorithm": "SHA-256",
    "digest": "sha256:72d7…1844",
    "scope": "canonical-payload",
    "meaning": "truncation-detection-only"
  }
}
```

## Field contract

### `report`

- `reportId`: unique per generation; UUID.
- `supportCode`: stable for the LMS attempt; safe for phone/chat transcription.
- `generatedAt`: UTC ISO 8601 timestamp.
- `truncated`: whether optional content was removed.
- `omittedEventCount`: nonnegative integer.

### `summary`

- `state`: one value from the learner-visible state table.
- `completionSafeToClose`: true only for `completion_confirmed`.
- `reasonCode`: allowlisted machine classification or `null`.

### `course`

- Allow: course title, exact operational course ID, SCORM version, Timegate and
  package versions, canonical structure hash, and a one-way course-key
  fingerprint.
- Never expose the raw course key because its fallback can contain an origin,
  route, and document title.

### `attempt`

- Contains only opaque IDs and lifecycle metadata.
- `tabRole` is `primary`, `secondary`, or `uncoordinated` when browser storage is
  unavailable.
- `entryMode` is `fresh`, `resume`, or `unknown`; normalize SCORM-specific values.
- `resumeSource` is `lms_suspend_data`, `local_backup`, or `none`. A fresh or
  ab-initio launch always reports `none` and never hydrates an earlier attempt,
  even if stale LMS or browser state is present.
- `coordinationScope` must currently be `same_browser_only`; the local-storage
  ownership lock cannot coordinate simultaneous sessions on separate devices.
- `priorDeviceDiagnostics` is `available_via_observability` only after the
  correlated observability delivery succeeded. It is `unavailable` when delivery
  is disabled, pending, failed, unconfirmed, or unavailable, even if a session ID
  exists.

### `timing`

- `cumulativeActiveSeconds` is Timegate's persisted active-time counter.
- `launchActiveSeconds` is the SCORM session-time candidate for this launch.
- `launchIdleSeconds` is observational and does not affect completion.
- Include minimum/maximum timestamps only when observed.

### `completion`

This is the principal diagnostic section. The core runtime retains the request
source, first/last request timestamps, delivery attempts, last write, commit and
readback outcomes, and whether the pending state reached LMS-backed storage.
These diagnostics remain available for the current launch and through persistence
backends that retain the optional compact support state.

`lmsApiAcknowledged` means only that the browser-visible SCORM operation returned
success. `serverRecordVerified` must remain `not_available_in_course` unless an
independent, authenticated server-side readback contract is added. Do not describe
a browser runtime acknowledgement as authoritative LMS-record verification.

`signalSource` is one of `scorm_set_value`, `rise_driver`, `lms_readback`, or
`unknown`. `deliveryState` is one of:

- `not_requested`
- `held_for_minimum`
- `queued`
- `write_failed`
- `commit_failed`
- `readback_unconfirmed`
- `confirmed`
- `reset`
- `blocked_configuration`
- `blocked_maximum`
- `blocked_secondary_session`

### `lms`

- `apiState`: `missing`, `found`, `initialized`, `initialization_failed`, or
  `terminated`.
- `learnerVerified` is a boolean only; never include the raw learner value.
- `canonicalStatus` must be normalized to an allowlisted SCORM status.
- `lastErrorCode` is `null` or a bounded digits-only SCORM error-code string.
  Never copy LMS diagnostic text or a nonnumeric error value.

### `persistence`

- Report LMS-backed and browser-backed outcomes separately.
- `pendingDurableInLms` must not be inferred from a successful browser-only write.
- `lmsFailureReason` is `null` after a successful LMS state save. Otherwise it
  identifies a failed LMS read, unsupported existing format, serialization
  failure, payload over the Timegate limit, rejected LMS SetValue, or failed
  LMS Commit.
- `lmsExistingChars` and `lmsAttemptedChars` report bounded character counts,
  not the underlying data. `lmsErrorCode` is a bounded numeric SCORM code when
  the failing LMS operation exposes one.
- Never include raw `suspend_data`, local/session-storage keys, or values.

### `relay`

- Include only enabled/disabled, bounded delivery state, and the opaque relay
  attempt ID when available.
- Never include the relay endpoint, relay key, request body, or raw learner name.
- Relay state must never change `completionSafeToClose`.

### `observability`

- The copied object is always present and has exactly `enabled`, `deliveryState`,
  and `revision`.
- `deliveryState` is `disabled`, `not_attempted`, `pending`, `succeeded`,
  `failed`, `unconfirmed`, or `unavailable`.
- `revision` is a bounded nonnegative integer. It is correlation metadata, not
  proof that the LMS saved completion.
- No endpoint, credential, learner identity, raw transport event, issue payload,
  or diagnostic body may appear in this object.

### `environment`

- Use a coarse, best-effort browser/engine, OS family, and device class rather
  than the raw user-agent string.
- Capability booleans are preferable to browser-version assumptions.
- Do not include IP address, exact device model, referrer, URL, query string,
  installed extensions, screen fingerprint, or browser history.

### `issues` and `timeline`

- Maximum 10 issues and 20 timeline events in the copied artifact.
- Prefer active errors, then active warnings, then completion milestones, then the
  newest remaining events.
- Events are a new, strict allowlist of codes and enum/boolean/numeric results;
  do not copy arbitrary existing event objects.
- Timestamp, sequence, code, result, operation category, and a bounded digits-only
  SCORM error-code string are sufficient. No stack traces, LMS diagnostic text,
  or arbitrary messages.

## Core issue codes

At minimum, support the following classifications:

- `LMS_API_MISSING`
- `LMS_INITIALIZATION_FAILED`
- `LEARNER_IDENTITY_UNVERIFIED`
- `BROWSER_STORAGE_UNAVAILABLE`
- `TIMEGATE_STATE_SAVE_FAILED`
- `COURSE_COMPLETION_NOT_REQUESTED`
- `COMPLETION_HELD_FOR_MINIMUM`
- `COMPLETION_WRITE_FAILED`
- `LMS_COMMIT_FAILED`
- `COMPLETION_READBACK_UNCONFIRMED`
- `COMPLETION_TERMINATION_DEFERRED`
- `LMS_FINALIZATION_FAILED`
- `LMS_TERMINATION_FAILED`
- `SECONDARY_SESSION`
- `CONFIGURATION_INVALID`
- `MAXIMUM_TIME_REACHED`
- `SESSION_ENDED_FOR_INACTIVITY`
- `OBSERVABILITY_UNAVAILABLE`
- `OBSERVABILITY_DELIVERY_FAILED`
- `RELAY_DELIVERY_FAILED`
- `SUPPORT_REPORT_GENERATION_DEGRADED`

An observability or relay issue must never be presented as an LMS completion
failure unless an independent LMS operation failed.

## Privacy and security contract

The report builder uses an allowlist, not a denylist. It must never include:

- learner name, LMS learner ID, employee code, email address, or supervisor;
- source tokens, relay keys, authorization values, cookies, or credentials;
- endpoint URLs, launch URLs, query strings, fragments, referrers, or raw paths;
- raw `suspend_data`, `launch_data`, local storage, or session storage;
- question/answer prose, correct responses, free text, comments, or quiz content;
- arbitrary exception messages, stack traces, console output, HTML, or DOM text;
- raw user-agent strings or exact device fingerprints; or
- external request/response bodies.

The UI must disclose before copying:

> Includes course identifiers, Timegate timing, LMS save results, browser
> capabilities, and recent technical milestones. Does not include your name,
> email, employee ID, answers, password, or browser history.

The SHA-256 digest detects accidental truncation or modification only. A learner
can edit locally generated text, so the digest is not an authenticity signature.
If a server later returns a signed receipt, the report may include its opaque ID,
but report generation and LMS completion must not depend on that receipt.

## Completion-safe close rule

Set `completionSafeToClose` to true only after all applicable browser-visible
steps succeed:

1. The original course emits a canonical completion status.
2. The canonical SCORM status write succeeds.
3. The LMS Commit call succeeds.
4. An immediate canonical GetValue readback returns the exact normalized terminal
   status requested by the course. A different terminal value does not count as
   confirmation. For SCORM 2004 Rise pass/fail helpers, the canonical completion
   readback is `cmi.completion_status=completed`; pass/fail remains a related
   `cmi.success_status` outcome.
5. No related completion or outcome value remains queued.
6. Current-launch session time and Timegate persistence are written and committed.
7. Any deferred Finish/Terminate request succeeds.

A same-launch SCORM readback can still reflect an LMS runtime cache, so this is the
strongest evidence available inside the course, not authoritative server-record
verification. Keep `serverRecordVerified` set to `not_available_in_course` unless
an authenticated server-side readback is added.

## Persistence and lifecycle

- Maintain a bounded in-memory critical-event ledger for the current launch.
- Keep at most 32 core events in memory; copy at most 20.
- A richer local ledger may be kept for seven days and must be scoped to the
  verified learner and course. It must be bounded to 12 KiB per attempt and no
  more than three recent attempts per learner/course.
- Key that local ledger by the random `attemptId`; do not place the raw learner ID
  or raw course key in its storage key.
- Do not put the full event ledger in SCORM `suspend_data`. Canonical Timegate
  timing and the pending completion queue always take priority in its limited
  headroom.
- The stable `attemptId` and compact completion diagnostics are optional within
  LMS `suspend_data`, even when another persistence backend retains them. Under
  headroom pressure, omit the optional diagnostics first and then the support
  attempt ID rather than dropping or weakening the core completion queue.
- A fresh/ab-initio LMS launch creates a new attempt ID, reports `resumeSource` as
  `none`, and must not hydrate the previous attempt's timing, diagnostic, or
  completion state.
- A resumable launch may merge the compact LMS copy with a newer same-device local
  ledger using the existing monotonic revision rule.
- Report generation after termination uses the final frozen runtime snapshot and
  makes no LMS calls.
- Malformed diagnostic state is ignored and classified as degraded; it must never
  reset timing or alter completion.

## Support interpretation

Support should classify an incident from these fields, in order:

1. `timing.minimumMet`
2. `completion.courseSignalObserved`
3. `completion.deliveryState`
4. `completion.lastWriteResult`
5. `completion.lastCommitResult`
6. `completion.lastReadbackStatus`
7. `completion.pendingDurableInLms`
8. `lms.canonicalStatus`
9. `attempt.lifecycle` and `completion.lastTerminationResult`
10. server-side LMS and observability readback using the correlation IDs

Interpretation examples:

- Minimum met + no signal: course requirements were not completed or the course
  failed to emit completion; Timegate cannot distinguish those two without course
  progress enrichment.
- Signal observed + pending: do not tell the learner to repeat the course; preserve
  the attempt and allow retry/relaunch recovery.
- Write or commit failed: LMS/session failure.
- Completion confirmed locally + authoritative LMS incomplete: LMS recording or
  reporting incident requiring server-side investigation.
- LMS complete + downstream record incomplete: downstream synchronization issue,
  not a Timegate or learner failure.

## Acceptance tests

### Artifact contract and privacy

- Generate a valid report with observability enabled, disabled, degraded, and
  absent.
- Verify the exact schema, canonical key order, 12 KiB limit, trimming order,
  truncation counters, and checksum behavior.
- Seed learner names, employee IDs, emails, tokens, URLs, cookies, answers, raw
  storage, and stack traces with unique sentinels; assert that none occur in the
  preview or copied text.
- Assert that optional enrichment cannot add unknown keys or bypass field/string
  bounds.
- Assert that `payload.observability` contains exactly `enabled`, `deliveryState`,
  and `revision`, and that prior-device diagnostics are advertised only after a
  succeeded delivery.
- Assert that copied SCORM error codes are digits-only and LMS diagnostic text is
  excluded.
- Assert that report generation performs no SCORM write/commit/terminate, relay,
  telemetry, or other network request.
- Verify a minimal report remains copyable after config failure, missing SCORM API,
  initialization failure, persistence failure, maximum exit, inactivity exit, and
  completed termination.

### Completion state matrix

- Minimum not met and no course signal.
- Course signal before minimum; durable queue; automatic replay at minimum.
- Minimum met with no course signal.
- SCORM SetValue failure, commit failure, and readback mismatch.
- Retry failure followed by retry success; UI and report transition to confirmed.
- Rise driver completion failure and recovery.
- SCORM 1.2 and SCORM 2004 completion/reset semantics.
- Deferred Finish/Terminate, relaunch recovery, and final termination.
- Status reset cancels stale queued completion and is visible in the report.
- Pagehide, reload, BFCache return, abrupt-relaunch recovery, and clock rollback.
- Local storage unavailable and non-JSON/oversized LMS `suspend_data`.
- `suspend_data` headroom pressure preserves core timing/completion state while
  omitting optional support diagnostics and, if necessary, the support attempt ID.
- Fresh/ab-initio launches ignore stale prior-attempt state and report
  `resumeSource: none`.
- Primary tab, secondary tab, lock takeover, and cross-device resume both with and
  without the optional support attempt ID retained in LMS state.
- Inactivity exit and maximum-time lockout.
- Relay failure while LMS completion succeeds, and LMS failure while relay succeeds.

### Learner interface

- The minimum state never says or exposes an accessible name equivalent to
  "course complete."
- Green/success styling is reserved for confirmed LMS completion; minimum met has
  distinct text and non-terminal styling.
- The retry banner appears on the first operation failure or after 10 seconds of
  eligible pending state and remains until recovery or terminal exit.
- Copy works through Clipboard API and selectable-text fallback.
- Copy success and errors are announced appropriately without reading raw JSON.
- Keyboard, focus restoration, 320-pixel mobile layout, 200% zoom, reduced motion,
  high contrast, and touch-target checks pass.
- The copied artifact exactly matches the preview generated for that action.

### Browser and LMS verification

- Add Playwright Chromium, Firefox, and WebKit projects for the support UI and
  artifact contract.
- Add representative mobile Chrome and mobile Safari viewport/touch coverage,
  including the **Copy support report** action on every terminal overlay.
- Run assigned-learner canaries in each target LMS/browser family covering launch,
  early completion, minimum-first completion, retry, normal exit, relaunch, and
  authoritative LMS completion readback.
- Treat local harness and automated browser success as necessary but not sufficient
  for production LMS validation.

## Rollout sequence

1. Add the core completion diagnostic state, event ledger, stable attempt/launch
   IDs, pure report builder, and privacy/size tests.
2. Add the learner-visible completion state line, status/support surface, copy
   flow, fallback, and accessibility tests.
3. Add the optional observability public projection and server-correlation status;
   never expose the transport snapshot.
4. Validate SCORM 1.2/2004 in the local harness and add Chromium, Firefox, WebKit,
   and mobile-emulation coverage.
5. Package one non-relay and one relay-enabled canary, then test assigned learners
   in the target LMS on desktop and mobile.
6. Roll out broadly only after support can reliably map copied reports to the
   diagnostic categories above and independently verify the corresponding LMS
   record.

## Implementation boundary

This specification does not authorize automatic completion remediation. Any
future support workflow that changes an LMS enrollment must require independent
learner/course identity verification and authoritative LMS readback.
