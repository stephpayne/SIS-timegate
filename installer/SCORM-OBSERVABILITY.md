# SCORM observability packaging

The POSIX and macOS packagers install Timegate plus the fail-open SCORM 1.2
observability runtime. Start from an untouched Rise export whenever possible.
The output remains a separate `<course>-timegate.zip`; the macOS launcher never
changes the selected ZIP.

## Required pilot values

- **Telemetry endpoint:** the worker's `ingestScormTelemetry` HTTPS URL.
  `http://localhost` is accepted only for local testing. Credentials, query
  strings, and fragments are rejected.
- **Source-key ID:** the allowlist key configured in the worker.
- **Pilot token:** a rotatable, course-scoped abuse-control token. It is embedded
  in the downloadable package and is not a production-grade secret.
- **Paycom Course ID:** the exact existing Paycom course identifier used for
  server-side correlation.

The macOS launcher prompts for all four values and hides the token. The POSIX
packager accepts the same values from environment variables:

```sh
SCORM_TELEMETRY_ENDPOINT="https://worker.example/ingestScormTelemetry" \
SCORM_SOURCE_KEY_ID="rise-pilot" \
SCORM_PILOT_TOKEN="replace-with-pilot-token" \
PAYCOM_COURSE_ID="12345" \
  installer/install-timegate.sh /path/to/unpacked-rise-course
```

The equivalent flags are available from `install-timegate.sh --help`; the
environment form is preferred for the token because command arguments can be
visible to other local processes.

## Package contract

The packager:

1. Requires a single-SCO SCORM 1.2 manifest and a recognizable Rise driver.
2. Extracts a privacy-minimized `CourseDescriptor`.
3. Requires synchronous `lms-interface.js`, then injects synchronous `host.js`
   and Timegate in that order before any later course script.
4. Injects `content-probe.js` before the Rise `lib/dist` bootstrap.
5. Registers the Timegate and observability assets exactly once in the SCO
   resource.
6. Verifies the generated inline configuration, script order, files, and
   manifest before creating the ZIP.

An already or partially observability-instrumented package is rejected. A
complete prior Timegate installation may be extended; its existing
`timegate.config.json` is preserved unless a replacement is explicitly passed.
A partial Timegate installation is rejected.

The inline host configuration is:

```text
{
  enabled,
  endpoint,
  source: { keyId, token },
  course: { ...CourseDescriptor, paycomCourseId },
  instrumentationVersion,
  timegateVersion,
  corsFallbackBaseDelayMs,
  corsFallbackJitterMs
}
```

If a normal CORS request is delivered but its response is hidden by the LMS
browser context, the host waits 15–20 seconds before one `no-cors` fallback.
The fallback is skipped when a newer cumulative revision already exists, which
prevents routine browser ambiguity from racing two copies of the same snapshot.

`CourseDescriptor` contains only SCORM/package/course IDs, the course title,
completion policy, navigation mode, lesson/block/quiz/question IDs and types,
media duration, Continue-gate IDs, passing/retry settings, warnings, and a
canonical SHA-256 structure hash. It does not contain authored prose, question
or answer text, correct responses, author IDs, tenant IDs, filenames, or
service URLs.

Run the extractor directly when diagnosing a package:

```sh
python3 installer/course_descriptor.py /path/to/unpacked-rise-course
```

## Tests

Run the synthetic packaging tests:

```sh
python3 -B -m unittest discover -s installer/tests -v
```

Set `SCORM_SAMPLE_ROOT` to run the attached fire-safety package contract. The
test makes its own temporary copy and never modifies the supplied package:

```sh
SCORM_SAMPLE_ROOT="/path/to/fire-safety-package" \
  python3 -B -m unittest discover -s installer/tests -v
```
