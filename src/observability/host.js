/*
 * SIS SCORM Observability — parent-frame collector.
 *
 * This file intentionally has no dependencies. It must remain fail-open:
 * instrumentation failures are never allowed to alter an LMS or Rise call.
 */
(function () {
  'use strict';

  var GLOBAL_CONFIG = '__SIS_OBSERVABILITY_CONFIG__';
  var GLOBAL_RUNTIME = '__SIS_OBSERVABILITY__';
  var LOADED_FLAG = '__sisObservabilityHostLoaded';
  var WRAPPED_FLAG = '__sisObservabilityWrapped';
  var STORAGE_KEY = '__sis_observability_pending_v1';
  var PROTOCOL_VERSION = 1;
  var DEFAULT_INSTRUMENTATION_VERSION = '0.1.0';
  var MAX_INTERNAL_FAILURES = 3;
  var MAX_EVENTS = 300;
  var MAX_BUFFER_BYTES = 256 * 1024;
  var MAX_EVENT_AGE_MS = 5 * 60 * 1000;
  var MAX_TAIL_EVENTS = 100;
  var MAX_TAIL_BYTES = 32 * 1024;
  var MAX_SAFE_SEQUENCE = 9007199254740991;
  var RESTORE_IDENTITY_TIMEOUT_MS = 2000;
  var ROUTINE_INTERVAL_MS = 60 * 1000;
  var DEFAULT_CORS_FALLBACK_BASE_DELAY_MS = 15 * 1000;
  var DEFAULT_CORS_FALLBACK_JITTER_MS = 5 * 1000;

  if (window[LOADED_FLAG]) return;
  window[LOADED_FLAG] = true;

  var config = window[GLOBAL_CONFIG];
  if (
    !config ||
    config.enabled === false ||
    typeof config.endpoint !== 'string' ||
    !config.endpoint ||
    !config.source ||
    typeof config.source.keyId !== 'string' ||
    typeof config.source.token !== 'string'
  ) {
    return;
  }

  var disabled = false;
  var internalFailures = 0;
  var eventSequence = 0;
  var eventBuffer = [];
  var eventBufferBytes = 0;
  var issueMap = {};
  var snapshotTimer = null;
  var channelPort = null;
  var transportInFlight = null;
  var latestQueuedTransport = null;
  var completionWritten = false;
  var completionCommitted = false;
  var completionQueuedByTimegate = false;
  var activeScormSetValueCalls = [];
  var activeScormFinishCalls = [];
  var quarantinedPending = null;
  var pendingRestoreTimer = null;
  var timegateClock = {
    activeSeconds: 0,
    idleSeconds: 0,
    idleBaseSeconds: 0,
    segmentStarted: false
  };

  function configuredTransportDelay(name, fallback) {
    var value = clampedNumber(config[name], 0, 60 * 1000);
    return value === null ? fallback : Math.floor(value);
  }

  var corsFallbackBaseDelayMs = configuredTransportDelay(
    'corsFallbackBaseDelayMs',
    DEFAULT_CORS_FALLBACK_BASE_DELAY_MS
  );
  var corsFallbackJitterMs = configuredTransportDelay(
    'corsFallbackJitterMs',
    DEFAULT_CORS_FALLBACK_JITTER_MS
  );

  function nowIso() {
    return new Date().toISOString();
  }

  function boundedString(value, max) {
    if (value === null || typeof value === 'undefined') return '';
    var text = String(value);
    return text.length > max ? text.slice(0, max) : text;
  }

  function boundedNullableString(value, max) {
    if (value === null || typeof value === 'undefined' || value === '') return null;
    return boundedString(value, max);
  }

  function finiteNumber(value) {
    if (value === null || typeof value === 'undefined' || value === '') return null;
    var number = Number(value);
    return isFinite(number) ? number : null;
  }

  function clampedNumber(value, minimum, maximum) {
    var number = finiteNumber(value);
    if (number === null) return null;
    return Math.min(maximum, Math.max(minimum, number));
  }

  function normalizeBoolean(value) {
    if (value === true || value === 1) return true;
    if (value === false || value === 0 || value === null) return false;
    var normalized = String(value).toLowerCase();
    return normalized === 'true' || normalized === '1';
  }

  function safeJsonParse(value) {
    try {
      return JSON.parse(value);
    } catch (error) {
      return null;
    }
  }

  function safeJsonStringify(value) {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return null;
    }
  }

  function randomId() {
    var cryptoObject = window.crypto || window.msCrypto;
    if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
      try {
        return cryptoObject.randomUUID();
      } catch (error) {
        // Fall through to random bytes.
      }
    }
    if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
      try {
        var bytes = new Uint8Array(16);
        cryptoObject.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        var hex = [];
        for (var i = 0; i < bytes.length; i++) {
          hex.push((bytes[i] + 256).toString(16).slice(1));
        }
        return (
          hex.slice(0, 4).join('') + '-' +
          hex.slice(4, 6).join('') + '-' +
          hex.slice(6, 8).join('') + '-' +
          hex.slice(8, 10).join('') + '-' +
          hex.slice(10, 16).join('')
        );
      } catch (error) {
        // Fall through to the non-cryptographic session identifier.
      }
    }
    var randomHex = '';
    for (var j = 0; j < 32; j++) {
      randomHex += Math.floor(Math.random() * 16).toString(16);
    }
    return (
      randomHex.slice(0, 8) + '-' +
      randomHex.slice(8, 12) + '-4' +
      randomHex.slice(13, 16) + '-' +
      ((parseInt(randomHex.charAt(16), 16) & 3) | 8).toString(16) +
      randomHex.slice(17, 20) + '-' +
      randomHex.slice(20, 32)
    );
  }

  function copyStringArray(values, maxItems, maxLength) {
    var out = [];
    if (!values || typeof values.length !== 'number') return out;
    for (var i = 0; i < values.length && i < maxItems; i++) {
      if (typeof values[i] === 'string') {
        out.push(boundedString(values[i], maxLength));
      }
    }
    return out;
  }

  function sanitizeQuiz(input) {
    if (!input || typeof input !== 'object') return null;
    var questions = [];
    if (Array.isArray(input.questions)) {
      for (var i = 0; i < input.questions.length && i < 500; i++) {
        var question = input.questions[i];
        if (!question || typeof question !== 'object') continue;
        questions.push({
          id: boundedString(question.id, 256),
          type: boundedString(question.type, 80)
        });
      }
    }
    var passingScore = clampedNumber(input.passingScore, 0, 100);
    var retryLimit = finiteNumber(input.retryLimit);
    return {
      id: boundedString(input.id, 256),
      passingScore: passingScore === null ? 0 : passingScore,
      retryLimit:
        retryLimit === null ?
          null : Math.min(10000, Math.max(0, Math.floor(retryLimit))),
      unlimitedRetries: !!input.unlimitedRetries,
      passToContinue: !!input.passToContinue,
      questionCount: questions.length,
      questions: questions
    };
  }

  function sanitizeBlocks(values) {
    var out = [];
    if (!Array.isArray(values)) return out;
    for (var i = 0; i < values.length && i < 1000; i++) {
      var input = values[i];
      if (!input || typeof input !== 'object') continue;
      var media = [];
      var gates = [];
      var mediaInput = Array.isArray(input.media) ? input.media : [];
      var gateInput = Array.isArray(input.continueGates) ? input.continueGates : [];
      for (var j = 0; j < mediaInput.length && j < 100; j++) {
        var mediaItem = mediaInput[j];
        if (!mediaItem || typeof mediaItem !== 'object') continue;
        var sanitizedMedia = {
          id: boundedString(mediaItem.id, 256),
          type: boundedString(mediaItem.type, 80)
        };
        var durationSeconds = clampedNumber(
          mediaItem.durationSeconds,
          0,
          86400
        );
        if (durationSeconds !== null) sanitizedMedia.durationSeconds = durationSeconds;
        media.push(sanitizedMedia);
      }
      for (var k = 0; k < gateInput.length && k < 100; k++) {
        var gate = gateInput[k];
        if (!gate || typeof gate !== 'object') continue;
        gates.push({
          id: boundedString(gate.id, 256),
          completionItemId: boundedString(gate.completionItemId, 256)
        });
      }
      out.push({
        id: boundedString(input.id, 256),
        type: boundedString(input.type, 80),
        family: boundedString(input.family, 80),
        variant: boundedString(input.variant, 80),
        forwardSeekRestricted: !!input.forwardSeekRestricted,
        media: media,
        continueGates: gates
      });
    }
    return out;
  }

  function sanitizeLessons(values) {
    var out = [];
    if (!Array.isArray(values)) return out;
    for (var i = 0; i < values.length && i < 500; i++) {
      var input = values[i];
      if (!input || typeof input !== 'object') continue;
      var lesson = {
        id: boundedString(input.id, 256),
        type: boundedString(input.type, 80),
        blocks: sanitizeBlocks(input.blocks)
      };
      var quiz = sanitizeQuiz(input.quiz);
      if (quiz) lesson.quiz = quiz;
      out.push(lesson);
    }
    return out;
  }

  function sanitizeWarnings(values) {
    var out = [];
    if (!Array.isArray(values)) return out;
    for (var i = 0; i < values.length && i < 20; i++) {
      var input = values[i];
      if (!input || typeof input !== 'object') continue;
      var warning = { code: boundedString(input.code, 80) };
      if (warning.code === 'PACKAGE_VERSION_MISMATCH') {
        warning.driverPackageVersion = boundedString(input.driverPackageVersion, 128);
        warning.runtimePackageVersion = boundedString(input.runtimePackageVersion, 128);
      } else if (warning.code === 'QUIZ_PRESENT_NOT_COMPLETION_TRIGGER') {
        warning.quizIds = copyStringArray(input.quizIds, 100, 256);
        warning.authoritativeTriggerType =
          input.authoritativeTriggerType === 'storyline' ?
            'storyline' : 'progress';
      } else if (warning.code !== 'CLIENT_DESCRIPTOR_TRUNCATED') {
        continue;
      }
      out.push(warning);
    }
    return out;
  }

  /*
   * Course metadata is copied through an allowlist. This prevents a future
   * extractor change from accidentally transmitting authored lesson/question
   * prose or tenant metadata.
   */
  function sanitizeCourseDescriptor(input) {
    input = input && typeof input === 'object' ? input : {};
    var policy = input.completionPolicy && typeof input.completionPolicy === 'object' ?
      input.completionPolicy : {};
    var descriptor = {
      schemaVersion: 1,
      scormVersion: input.scormVersion === '2004' ? '2004' : '1.2',
      manifestIdentifier: boundedString(input.manifestIdentifier, 256),
      organizationIdentifier: boundedString(input.organizationIdentifier, 256),
      scoResourceIdentifier: boundedString(input.scoResourceIdentifier, 256),
      scoLaunchPath: boundedString(input.scoLaunchPath, 512),
      riseCourseId: boundedString(input.riseCourseId, 256),
      packageVersion: boundedString(input.packageVersion, 128),
      runtimePackageVersion: boundedString(input.runtimePackageVersion, 128),
      structureHash: boundedString(input.structureHash, 128),
      title: boundedString(input.title, 512),
      paycomCourseId: boundedString(input.paycomCourseId, 128),
      navigationMode: boundedString(input.navigationMode, 80),
      forcedCommitIntervalSeconds: clampedNumber(
        input.forcedCommitIntervalSeconds,
        0,
        86400
      ),
      completionPolicy: {
        reporting: boundedString(policy.reporting, 80),
        completionPercentage: clampedNumber(
          policy.completionPercentage,
          0,
          100
        ),
        resetLearnerData: !!policy.resetLearnerData,
        triggerType: boundedString(policy.triggerType, 80),
        triggerId: boundedNullableString(policy.triggerId, 256)
      },
      lessons: sanitizeLessons(input.lessons),
      warnings: sanitizeWarnings(input.warnings)
    };
    return descriptor;
  }

  function fitCourseDescriptor(input) {
    var copy = safeJsonParse(safeJsonStringify(input));
    if (!copy) return input;
    if (utf8Length(safeJsonStringify(copy)) <= 32 * 1024) return copy;

    var hasTruncationWarning = false;
    for (var i = 0; i < copy.warnings.length; i++) {
      if (copy.warnings[i].code === 'CLIENT_DESCRIPTOR_TRUNCATED') {
        hasTruncationWarning = true;
        break;
      }
    }
    if (!hasTruncationWarning) {
      copy.warnings.push({ code: 'CLIENT_DESCRIPTOR_TRUNCATED' });
    }

    var serialized = safeJsonStringify(copy);
    while (
      serialized &&
      utf8Length(serialized) > 32 * 1024 &&
      copy.lessons.length
    ) {
      var lesson = copy.lessons[copy.lessons.length - 1];
      if (lesson.blocks.length) {
        lesson.blocks.splice(Math.floor(lesson.blocks.length / 2));
      } else if (lesson.quiz && lesson.quiz.questions.length) {
        lesson.quiz.questions.splice(
          Math.floor(lesson.quiz.questions.length / 2)
        );
        lesson.quiz.questionCount = lesson.quiz.questions.length;
      } else {
        copy.lessons.pop();
      }
      serialized = safeJsonStringify(copy);
    }
    return copy;
  }

  var courseDescriptor = fitCourseDescriptor(
    sanitizeCourseDescriptor(config.course)
  );
  var instrumentationVersion = boundedString(
    config.instrumentationVersion || DEFAULT_INSTRUMENTATION_VERSION,
    40
  );
  var timegateVersion = boundedString(config.timegateVersion || '', 40);
  var session = {
    id: randomId(),
    revision: 0,
    startedAt: nowIso(),
    observedAt: nowIso(),
    endedAt: null,
    lifecycle: 'active'
  };
  var learnerId = '';
  var runtimeState = {
    initialized: false,
    lessonStatus: null,
    progressPercent: null,
    scoreRaw: null,
    lastCommitResult: null,
    finishResult: null,
    lastErrorCode: null
  };

  function redactUrlPathSecrets(value) {
    var text = boundedString(value, 1000).replace(
      /\b(token|access_token|auth|authorization|cookie|secret|api_key|key)=([^&#\s/]+)/gi,
      '$1=[redacted]'
    );
    var staticSegments = {
      scormcontent: true,
      scormdriver: true,
      index: true,
      indexapi: true,
      launch: true,
      course: true,
      courses: true,
      content: true,
      lesson: true,
      lessons: true,
      block: true,
      blocks: true,
      quiz: true,
      quizzes: true,
      preview: true,
      review: true,
      results: true,
      summary: true,
      home: true,
      player: true
    };
    return text.replace(/(^|[\/#])([^\/?#]+)/g, function (
      match,
      prefix,
      segment
    ) {
      var lower = segment.toLowerCase();
      if (staticSegments[lower]) return prefix + segment;
      var file = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9]{1,8})$/.exec(segment);
      if (
        file &&
        (staticSegments[file[1].toLowerCase()] ||
          /^(js|css|html|htm|png|jpg|jpeg|gif|svg|webp|woff2?)$/i.test(file[2]))
      ) {
        return prefix + '[resource].' + file[2].toLowerCase();
      }
      return prefix + '[redacted-route-segment]';
    });
  }

  function stripUrlSecrets(value) {
    var text = boundedString(value, 500);
    if (!text) return '';
    try {
      var parsed = new URL(text, window.location && window.location.href || undefined);
      var hash = parsed.hash || '';
      var hashQuery = hash.indexOf('?');
      if (hashQuery !== -1) hash = hash.slice(0, hashQuery);
      return boundedString(redactUrlPathSecrets(parsed.pathname + hash), 500);
    } catch (error) {
      var queryIndex = text.indexOf('?');
      if (queryIndex !== -1) text = text.slice(0, queryIndex);
      return boundedString(redactUrlPathSecrets(text), 500);
    }
  }

  function sanitizeRiseBookmark(value) {
    var text = boundedString(value, 500);
    if (!text) return '';
    /*
     * Rise passes a bare lesson/block identifier here. Treat that contract
     * differently from a URL so URL(base, id) does not fabricate a path.
     */
    if (/^[A-Za-z0-9._:-]{1,256}$/.test(text)) {
      return text;
    }
    return stripUrlSecrets(text);
  }

  function safeDiagnosticMessage(value) {
    var aliases = {
      'LMS call failed': 'LMSCallFailed',
      'Media playback error': 'MediaPlaybackError',
      'Resource failed to load': 'ResourceLoadError',
      'Rise method threw': 'RiseMethodError',
      'SCORM helper threw': 'SCORMHelperError'
    };
    var allowed = {
      AbortError: true,
      BrowserRuntimeError: true,
      DOMException: true,
      Error: true,
      EvalError: true,
      LMSCallFailed: true,
      MediaError: true,
      MediaPlaybackError: true,
      NetworkError: true,
      NotAllowedError: true,
      ObservabilityError: true,
      QuotaExceededError: true,
      RangeError: true,
      ReferenceError: true,
      ResourceLoadError: true,
      RiseMethodError: true,
      SCORMHelperError: true,
      SecurityError: true,
      SyntaxError: true,
      TypeError: true,
      URIError: true
    };
    var rawMessage = boundedString(value, 80);
    var message = aliases[rawMessage] || rawMessage.replace(/\s+/g, '');
    return allowed[message] ? message : 'DiagnosticError';
  }

  function safeErrorMessage() {
    return 'ObservabilityError';
  }

  function sanitizeEvidence(input) {
    var output = {};
    if (!input || typeof input !== 'object') return output;
    var allowed = [
      'method', 'operation', 'element', 'result', 'reason', 'eventType', 'route',
      'resource', 'tagName', 'mediaId', 'mediaErrorCode', 'questionId',
      'quizId', 'retryNumber', 'previousRevision', 'revision', 'backend',
      'errorCode', 'sessionTime', 'persistence', 'resultBoolean'
    ];
    for (var i = 0; i < allowed.length; i++) {
      var key = allowed[i];
      var value = input[key];
      if (typeof value === 'string') output[key] = boundedString(value, 300);
      else if (typeof value === 'boolean') output[key] = value;
      else if (finiteNumber(value) !== null) {
        if (key === 'length' || key === 'valueLength') {
          output[key] = Math.min(
            10000000,
            Math.max(0, Math.floor(finiteNumber(value)))
          );
        } else {
          output[key] = clampedNumber(value, -1000000000, 1000000000);
        }
      }
    }
    if (input.message) output.message = safeDiagnosticMessage(input.message);
    return output;
  }

  function issueKey(code) {
    return boundedString(code, 80).toUpperCase();
  }

  function normalizedSeverity(value, fallback) {
    if (value === 'error' || value === 'warning' || value === 'info') {
      return value;
    }
    return fallback;
  }

  function resultMarker(result, originalError) {
    if (originalError) return 'threw';
    if (typeof result === 'boolean') return result ? 'true' : 'false';
    if (typeof result === 'undefined') return 'void';
    return 'returned';
  }

  function upsertIssue(code, severity, source, evidence, active) {
    var key = issueKey(code);
    if (!key) return;
    var timestamp = nowIso();
    var existing = issueMap[key];
    if (!existing) {
      existing = {
        code: key,
        severity: normalizedSeverity(severity, 'warning'),
        source: boundedString(source || 'client', 40),
        active: active !== false,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        occurrenceCount: 0,
        evidence: {}
      };
      issueMap[key] = existing;
    }
    existing.lastSeenAt = timestamp;
    existing.occurrenceCount = Math.min(
      1000000,
      existing.occurrenceCount + 1
    );
    existing.active = active !== false;
    existing.evidence = sanitizeEvidence(evidence);
  }

  function resolveIssue(code) {
    var existing = issueMap[issueKey(code)];
    if (!existing) return;
    existing.active = false;
    existing.lastSeenAt = nowIso();
  }

  function issuesArray() {
    var out = [];
    for (var key in issueMap) {
      if (Object.prototype.hasOwnProperty.call(issueMap, key)) {
        var issue = issueMap[key];
        out.push({
          code: issue.code,
          severity: issue.severity,
          source: issue.source,
          active: issue.active,
          firstSeenAt: issue.firstSeenAt,
          lastSeenAt: issue.lastSeenAt,
          occurrenceCount: issue.occurrenceCount,
          evidence: issue.evidence
        });
      }
    }
    out.sort(function (left, right) {
      if (left.code < right.code) return -1;
      if (left.code > right.code) return 1;
      return 0;
    });
    return out;
  }

  function pruneEvents(timestamp) {
    var cutoff = timestamp - MAX_EVENT_AGE_MS;
    while (
      eventBuffer.length &&
      (
        eventBuffer[0].timestamp < cutoff ||
        eventBuffer.length > MAX_EVENTS ||
        eventBufferBytes > MAX_BUFFER_BYTES
      )
    ) {
      var removed = eventBuffer.shift();
      eventBufferBytes -= removed.bytes;
    }
    if (eventBufferBytes < 0) eventBufferBytes = 0;
  }

  function recordEvent(type, source, severity, data, milestone) {
    if (disabled) return;
    var timestamp = Date.now();
    var event = {
      sequence: ++eventSequence,
      occurredAt: new Date(timestamp).toISOString(),
      type: boundedString(type, 80),
      source: boundedString(source, 40),
      severity: normalizedSeverity(severity, 'info'),
      milestone: !!milestone,
      data: data && typeof data === 'object' ? data : {}
    };
    var serialized = safeJsonStringify(event);
    if (!serialized) throw new Error('Could not serialize diagnostic event');
    var serializedBytes = utf8Length(serialized);
    eventBuffer.push({
      timestamp: timestamp,
      bytes: serializedBytes,
      event: event
    });
    eventBufferBytes += serializedBytes;
    pruneEvents(timestamp);
  }

  function registerInternalFailure(error, stage) {
    internalFailures += 1;
    if (!disabled) {
      try {
        recordEvent('instrumentation_error', 'host', 'error', {
          operation: boundedString(stage, 80),
          message: safeErrorMessage(error)
        }, true);
      } catch (ignored) {
        // The event buffer itself may be the failing component.
      }
    }
    if (internalFailures >= MAX_INTERNAL_FAILURES && !disabled) {
      upsertIssue('DEGRADED_SHIM', 'error', 'host', {
        reason: boundedString(stage, 80),
        message: safeErrorMessage(error)
      }, true);
      disabled = true;
      /* Attempt one final degraded snapshot; any failure remains fail-open. */
      try {
        scheduleSnapshot('shim_disabled', 'active', true, true);
      } catch (ignored) {
        // ignore
      }
    }
  }

  function observe(stage, callback) {
    if (disabled) return;
    try {
      callback();
    } catch (error) {
      registerInternalFailure(error, stage);
    }
  }

  function safeEventData(input) {
    var output = {};
    if (!input || typeof input !== 'object') return output;
    var stringKeys = [
      'operation', 'method', 'element', 'result', 'errorCode', 'questionId',
      'quizId', 'questionType', 'status', 'sessionTime', 'bookmark', 'route',
      'resourceType', 'filename', 'lessonId', 'blockId', 'reason',
      'completionStatus', 'expected', 'actual', 'correlationStatus',
      'eventType'
    ];
    var numberKeys = [
      'valueLength', 'latencyMs', 'retryNumber', 'score', 'mediaCurrentTime',
      'progressPercent', 'attempt', 'durationSeconds', 'activeSeconds',
      'idleSeconds', 'limitSeconds', 'candidateCount'
    ];
    for (var i = 0; i < stringKeys.length; i++) {
      var stringKey = stringKeys[i];
      if (typeof input[stringKey] === 'string') {
        output[stringKey] = boundedString(input[stringKey], 500);
      }
    }
    if (typeof output.element === 'string') {
      output.element = safeScormElement(output.element);
    }
    if (typeof output.errorCode === 'string') {
      output.errorCode = safeScormErrorCode(output.errorCode);
    }
    if (typeof output.sessionTime === 'string') {
      output.sessionTime = safeSessionTime(output.sessionTime);
    }
    if (typeof output.questionType === 'string') {
      output.questionType = normalizedQuestionType(output.questionType);
    }
    if (typeof output.completionStatus === 'string') {
      output.completionStatus = normalizedScormStatus(
        output.completionStatus
      );
    }
    for (var j = 0; j < numberKeys.length; j++) {
      var numberKey = numberKeys[j];
      var number = finiteNumber(input[numberKey]);
      if (number !== null) {
        if (numberKey === 'valueLength') {
          output[numberKey] = Math.min(
            10000000,
            Math.max(0, Math.floor(number))
          );
        } else if (numberKey === 'progressPercent') {
          output[numberKey] = clampedNumber(number, 0, 100);
        } else if (numberKey === 'score') {
          output[numberKey] = clampedNumber(number, -1000000, 1000000);
        } else {
          output[numberKey] = clampedNumber(
            number,
            -1000000000,
            1000000000
          );
        }
      }
    }
    if (typeof input.correctness === 'boolean') {
      output.correctness = input.correctness;
    }
    if (typeof input.success === 'boolean') output.success = input.success;
    if (typeof input.resultBoolean === 'boolean') {
      output.resultBoolean = input.resultBoolean;
    }
    if (typeof input.sessionTime === 'boolean') {
      output.sessionTime = input.sessionTime;
    }
    if (typeof input.persistence === 'boolean') {
      output.persistence = input.persistence;
    }
    if (typeof input.canonicalCompletion === 'boolean') {
      output.canonicalCompletion = input.canonicalCompletion;
    }
    if (typeof input.message === 'string') {
      output.message = safeDiagnosticMessage(input.message);
    }
    if (typeof input.valueSha256 === 'string') {
      output.valueSha256 = boundedString(input.valueSha256, 128);
    }
    return output;
  }

  function utf8Bytes(text) {
    if (typeof window.TextEncoder === 'function') {
      return new window.TextEncoder().encode(text);
    }
    var encoded = unescape(encodeURIComponent(text));
    var bytes = new Uint8Array(encoded.length);
    for (var i = 0; i < encoded.length; i++) {
      bytes[i] = encoded.charCodeAt(i);
    }
    return bytes;
  }

  function utf8Length(text) {
    return utf8Bytes(String(text || '')).length;
  }

  function fingerprintSensitive(value, target, onComplete) {
    var text = value === null || typeof value === 'undefined' ? '' : String(value);
    target.valueLength = text.length;
    var cryptoObject = window.crypto || window.msCrypto;
    if (
      !cryptoObject ||
      !cryptoObject.subtle ||
      typeof cryptoObject.subtle.digest !== 'function'
    ) {
      return;
    }
    try {
      var bytes = utf8Bytes(text);
      text = null;
      cryptoObject.subtle.digest('SHA-256', bytes).then(function (digest) {
        var view = new Uint8Array(digest);
        var hash = '';
        for (var i = 0; i < view.length; i++) {
          hash += (view[i] + 256).toString(16).slice(1);
        }
        target.valueSha256 = hash;
        if (typeof onComplete === 'function') {
          onComplete({
            valueLength: target.valueLength,
            valueSha256: hash
          });
        }
      }, function () {
        // Hashing is diagnostic-only and must remain fail-open.
      });
    } catch (error) {
      // Hashing is diagnostic-only and must remain fail-open.
    }
  }

  function scormElementIsSensitive(element) {
    var normalized = String(element || '').toLowerCase();
    return (
      normalized === 'cmi.suspend_data' ||
      normalized === 'cmi.launch_data' ||
      normalized === 'cmi.comments' ||
      normalized === 'cmi.comments_from_lms' ||
      normalized === 'cmi.core.student_name' ||
      normalized === 'cmi.learner_name' ||
      normalized === 'cmi.core.student_id' ||
      normalized === 'cmi.learner_id' ||
      normalized.indexOf('.student_response') !== -1 ||
      normalized.indexOf('.learner_response') !== -1 ||
      normalized.indexOf('.correct_responses') !== -1 ||
      normalized.indexOf('.description') !== -1
    );
  }

  function scormElementIsSafeValue(element) {
    var normalized = String(element || '').toLowerCase();
    return (
      normalized === 'cmi.core.lesson_status' ||
      normalized === 'cmi.completion_status' ||
      normalized === 'cmi.success_status' ||
      normalized === 'cmi.core.score.raw' ||
      normalized === 'cmi.score.raw' ||
      normalized === 'cmi.core.session_time' ||
      normalized === 'cmi.session_time' ||
      normalized === 'cmi.core.exit' ||
      normalized === 'cmi.exit' ||
      normalized === 'cmi.core.lesson_location' ||
      normalized === 'cmi.location' ||
      /\.type$/.test(normalized) ||
      /\.result$/.test(normalized) ||
      /\.latency$/.test(normalized) ||
      /\.time$/.test(normalized) ||
      /\.timestamp$/.test(normalized)
    );
  }

  function completionElement(element, value) {
    var normalizedElement = String(element || '').toLowerCase();
    var normalizedValue = String(value || '').toLowerCase();
    if (normalizedElement === 'cmi.core.lesson_status') {
      return (
        normalizedValue === 'completed' ||
        normalizedValue === 'passed' ||
        normalizedValue === 'failed'
      );
    }
    if (normalizedElement === 'cmi.completion_status') {
      return normalizedValue === 'completed';
    }
    return false;
  }

  function canonicalCompletionStatusElement(element) {
    var normalizedElement = String(element || '').toLowerCase();
    if (courseDescriptor.scormVersion === '2004') {
      return normalizedElement === 'cmi.completion_status';
    }
    return normalizedElement === 'cmi.core.lesson_status';
  }

  function recognizedCanonicalCompletionStatus(element, value) {
    if (!canonicalCompletionStatusElement(element)) return false;
    var status = String(value || '').toLowerCase();
    if (courseDescriptor.scormVersion === '2004') {
      return (
        status === 'completed' ||
        status === 'incomplete' ||
        status === 'not attempted' ||
        status === 'unknown'
      );
    }
    return (
      status === 'browsed' ||
      status === 'completed' ||
      status === 'failed' ||
      status === 'incomplete' ||
      status === 'not attempted' ||
      status === 'passed'
    );
  }

  function terminalCanonicalCompletionStatus(value) {
    var status = normalizedScormStatus(value);
    if (courseDescriptor.scormVersion === '2004') {
      return status === 'completed';
    }
    return (
      status === 'completed' ||
      status === 'passed' ||
      status === 'failed'
    );
  }

  function timegateGateableStatusElement(element, value) {
    if (completionElement(element, value)) return true;
    var normalizedElement = String(element || '').toLowerCase();
    var normalizedValue = String(value || '').toLowerCase();
    return normalizedElement === 'cmi.success_status' && (
      normalizedValue === 'passed' || normalizedValue === 'failed'
    );
  }

  function normalizedScormStatus(value) {
    var status = String(value || '').toLowerCase();
    var allowed = {
      browsed: true,
      completed: true,
      failed: true,
      incomplete: true,
      'not attempted': true,
      passed: true,
      unknown: true
    };
    return allowed[status] ? status : 'unknown';
  }

  function normalizedQuestionType(value) {
    var questionType = String(value || '').toLowerCase();
    var normalized = questionType.replace(/[\s-]+/g, '_');
    var known = {
      choice: 'choice',
      fill_in: 'fill-in',
      fill_in_the_blank: 'fill_in_the_blank',
      likert: 'likert',
      matching: 'matching',
      multiple_choice: 'multiple_choice',
      multiple_response: 'multiple_response',
      numeric: 'numeric',
      performance: 'performance',
      sequencing: 'sequencing',
      true_false: 'true-false'
    };
    return known[normalized] || 'unknown';
  }

  function safeScormElement(value) {
    return (
      typeof value === 'string' &&
      /^[A-Za-z0-9_.]{1,200}$/.test(value)
    ) ? value : 'invalid_element';
  }

  function safeScormErrorCode(value) {
    var code = String(
      value === null || typeof value === 'undefined' ? '' : value
    );
    if (!code) return '';
    return /^\d{1,8}$/.test(code) ? code : 'unknown';
  }

  function safeSessionTime(value) {
    var text = String(
      value === null || typeof value === 'undefined' ? '' : value
    );
    if (
      /^\d{1,5}:\d{2}:\d{2}(?:\.\d{1,2})?$/.test(text) ||
      /^PT(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?$/i.test(text)
    ) {
      return boundedString(text, 80);
    }
    var seconds = finiteNumber(value);
    return seconds !== null ? boundedString(seconds, 80) : 'invalid';
  }

  function updateStateFromScorm(element, value, observedFromLms) {
    var normalized = String(element || '').toLowerCase();
    if (
      normalized === 'cmi.core.student_id' ||
      normalized === 'cmi.learner_id'
    ) {
      learnerId = boundedString(value, 128);
      resolveQuarantinedLearner(learnerId, false);
    } else if (
      normalized === 'cmi.core.lesson_status' ||
      normalized === 'cmi.completion_status'
    ) {
      runtimeState.lessonStatus = normalizedScormStatus(value);
      if (
        observedFromLms &&
        recognizedCanonicalCompletionStatus(element, value)
      ) {
        observeQuarantinedCanonicalStatus();
      }
    } else if (
      normalized === 'cmi.core.score.raw' ||
      normalized === 'cmi.score.raw'
    ) {
      runtimeState.scoreRaw = clampedNumber(value, -1000000, 1000000);
    }
  }

  function currentDurations() {
    return {
      activeSeconds: Math.min(
        31536000,
        Math.max(0, Math.floor(timegateClock.activeSeconds))
      ),
      idleSeconds: Math.min(
        31536000,
        Math.max(0, Math.floor(timegateClock.idleSeconds))
      )
    };
  }

  function hasActiveIssue() {
    for (var key in issueMap) {
      if (
        Object.prototype.hasOwnProperty.call(issueMap, key) &&
        issueMap[key].active
      ) {
        return true;
      }
    }
    return false;
  }

  function publicDiagnosticEvent(entry) {
    var event = entry.event;
    return {
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      type: event.type,
      source: event.source,
      severity: event.severity,
      data: safeEventData(event.data)
    };
  }

  function selectDiagnosticTail() {
    pruneEvents(Date.now());
    var unhealthy = hasActiveIssue();
    var selected = [];
    var selectedSequence = {};
    /* Include JSON array brackets and commas in the worker's exact 32 KB cap. */
    var bytes = utf8Length('[]');

    function add(entry) {
      if (selected.length >= MAX_TAIL_EVENTS) return false;
      if (selectedSequence[entry.event.sequence]) return true;
      var output = publicDiagnosticEvent(entry);
      var serialized = safeJsonStringify(output);
      var serializedBytes = serialized ? utf8Length(serialized) : 0;
      var delimiterBytes = selected.length ? utf8Length(',') : 0;
      if (
        !serialized ||
        bytes + delimiterBytes + serializedBytes > MAX_TAIL_BYTES
      ) {
        return false;
      }
      selected.push(output);
      selectedSequence[entry.event.sequence] = true;
      bytes += delimiterBytes + serializedBytes;
      return true;
    }

    if (unhealthy) {
      for (var i = eventBuffer.length - 1; i >= 0; i--) {
        var priority = eventBuffer[i].event;
        if (priority.severity !== 'info' || priority.milestone) add(eventBuffer[i]);
      }
      for (var j = eventBuffer.length - 1; j >= 0; j--) {
        if (!add(eventBuffer[j])) break;
      }
    } else {
      for (var k = eventBuffer.length - 1; k >= 0; k--) {
        if (eventBuffer[k].event.milestone && !add(eventBuffer[k])) break;
      }
    }

    selected.sort(function (left, right) {
      return left.sequence - right.sequence;
    });
    return selected;
  }

  function buildSnapshot(lifecycle) {
    var timestamp = Date.now();
    var observedAt = new Date(timestamp).toISOString();
    var durations = currentDurations();
    session.revision += 1;
    session.observedAt = observedAt;
    var requestedLifecycle = lifecycle || session.lifecycle || 'active';
    if (session.lifecycle === 'forced_exit') {
      requestedLifecycle = 'forced_exit';
    } else if (session.lifecycle === 'terminated' && requestedLifecycle !== 'forced_exit') {
      requestedLifecycle = 'terminated';
    }
    session.lifecycle = requestedLifecycle;
    if (
      session.lifecycle === 'terminated' ||
      session.lifecycle === 'forced_exit'
    ) {
      session.endedAt = session.endedAt || observedAt;
    }
    return {
      schemaVersion: PROTOCOL_VERSION,
      source: {
        keyId: boundedString(config.source.keyId, 64),
        token: boundedString(config.source.token, 512)
      },
      session: {
        id: session.id,
        revision: session.revision,
        startedAt: session.startedAt,
        observedAt: session.observedAt,
        endedAt: session.endedAt || undefined,
        lifecycle: session.lifecycle
      },
      course: courseDescriptor,
      learner: {
        lmsLearnerId: learnerId
      },
      instrumentation: {
        version: instrumentationVersion,
        timegateVersion: timegateVersion,
        scormVersion: courseDescriptor.scormVersion
      },
      state: {
        initialized: !!runtimeState.initialized,
        lessonStatus: runtimeState.lessonStatus === null ? undefined : runtimeState.lessonStatus,
        progressPercent: runtimeState.progressPercent === null ? undefined : runtimeState.progressPercent,
        scoreRaw: runtimeState.scoreRaw === null ? undefined : runtimeState.scoreRaw,
        activeSeconds: durations.activeSeconds,
        idleSeconds: durations.idleSeconds,
        lastCommitResult:
          runtimeState.lastCommitResult === null ? undefined : runtimeState.lastCommitResult,
        finishResult:
          runtimeState.finishResult === null ? undefined : runtimeState.finishResult,
        lastErrorCode:
          runtimeState.lastErrorCode === null ? undefined : runtimeState.lastErrorCode
      },
      issues: issuesArray(),
      diagnosticTail: selectDiagnosticTail()
    };
  }

  function serializedWithinLimit(snapshot) {
    var copy = safeJsonParse(safeJsonStringify(snapshot));
    if (!copy) return null;
    var serialized = safeJsonStringify(copy);
    while (
      serialized &&
      utf8Length(serialized) > 63 * 1024 &&
      copy.diagnosticTail &&
      copy.diagnosticTail.length
    ) {
      copy.diagnosticTail.shift();
      serialized = safeJsonStringify(copy);
    }
    /*
     * Very large courses can exceed the worker's hard request limit even with
     * no diagnostic events. Trim structure details from the end while keeping
     * the canonical full-structure hash and top-level course identity.
     */
    var structureTrimmed = false;
    while (
      serialized &&
      utf8Length(serialized) > 63 * 1024 &&
      copy.course &&
      copy.course.lessons &&
      copy.course.lessons.length
    ) {
      var lastLesson = copy.course.lessons[copy.course.lessons.length - 1];
      if (lastLesson.blocks && lastLesson.blocks.length) {
        lastLesson.blocks.pop();
      } else {
        copy.course.lessons.pop();
      }
      structureTrimmed = true;
      serialized = safeJsonStringify(copy);
    }
    if (structureTrimmed && copy.course) {
      copy.course.warnings = copy.course.warnings || [];
      copy.course.warnings.push({
        code: 'CLIENT_DESCRIPTOR_TRUNCATED'
      });
      serialized = safeJsonStringify(copy);
    }
    return serialized && utf8Length(serialized) <= 64 * 1024 ? serialized : null;
  }

  function getSessionStorage() {
    try {
      return window.sessionStorage || null;
    } catch (error) {
      return null;
    }
  }

  function storePending(serialized) {
    var sessionStorage = getSessionStorage();
    if (!sessionStorage) {
      upsertIssue('TELEMETRY_STORAGE_FAILED', 'warning', 'host', {
        backend: 'sessionStorage',
        reason: 'unavailable'
      }, true);
      return false;
    }
    try {
      sessionStorage.setItem(STORAGE_KEY, serialized);
      resolveIssue('TELEMETRY_STORAGE_FAILED');
      return true;
    } catch (error) {
      upsertIssue('TELEMETRY_STORAGE_FAILED', 'warning', 'host', {
        backend: 'sessionStorage',
        reason: 'write_failed'
      }, true);
      observe('storage_event', function () {
        recordEvent('storage_failed', 'host', 'warning', {
          operation: 'sessionStorage.write',
          reason: 'write_failed'
        }, true);
      });
      return false;
    }
  }

  function clearPending(snapshotId, revision) {
    var sessionStorage = getSessionStorage();
    if (!sessionStorage) return;
    try {
      var current = safeJsonParse(sessionStorage.getItem(STORAGE_KEY));
      if (
        current &&
        current.session &&
        current.session.id === snapshotId &&
        current.session.revision === revision
      ) {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch (error) {
      // Pending cleanup is best-effort.
    }
  }

  function startQueuedTransport(delivery) {
    transportInFlight = delivery;
    var serialized = delivery.serialized;
    var snapshotId = delivery.snapshotId;
    var revision = delivery.revision;
    var options = {
      method: 'POST',
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8'
      },
      body: serialized,
      keepalive: utf8Length(serialized) < 60 * 1024
    };
    var request;
    try {
      request = window.fetch(config.endpoint, options).then(function (response) {
        if (!response || !response.ok) {
          var httpError = new Error('Telemetry endpoint returned an error');
          httpError.httpResponse = true;
          throw httpError;
        }
        clearPending(snapshotId, revision);
      }).catch(function (error) {
        if (error && error.httpResponse) {
          observe('transport_http_error', function () {
            recordEvent('transport_failed', 'transport', 'warning', {
              reason: 'http_error'
            }, false);
          });
          return;
        }
        var jitter = 0;
        try {
          jitter = Math.floor(
            Math.random() * (corsFallbackJitterMs + 1)
          );
        } catch (randomError) {
          jitter = 0;
        }
        return new window.Promise(function (resolve) {
          window.setTimeout(
            resolve,
            corsFallbackBaseDelayMs + jitter
          );
        }).then(function () {
          /*
           * A blocked CORS response is ambiguous: the POST may already have
           * succeeded. Give it time to settle, and do not replay an obsolete
           * revision after a newer cumulative snapshot has been produced.
           */
          if (
            session.id !== snapshotId ||
            session.revision !== revision
          ) {
            return;
          }
          var opaqueOptions = {
            method: 'POST',
            mode: 'no-cors',
            cache: 'no-store',
            credentials: 'omit',
            headers: {
              'Content-Type': 'text/plain;charset=UTF-8'
            },
            body: serialized,
            keepalive: utf8Length(serialized) < 60 * 1024
          };
          return window.fetch(config.endpoint, opaqueOptions).then(function () {
            clearPending(snapshotId, revision);
          }, function () {
            observe('transport_network_error', function () {
              recordEvent('transport_failed', 'transport', 'warning', {
                reason: 'network_error'
              }, false);
            });
          });
        });
      });
    } catch (error) {
      request = window.Promise.resolve();
    }
    window.Promise.resolve(request).then(finishQueuedTransport, finishQueuedTransport);
  }

  function finishQueuedTransport() {
    transportInFlight = null;
    if (!latestQueuedTransport) return;
    var next = latestQueuedTransport;
    latestQueuedTransport = null;
    startQueuedTransport(next);
  }

  function transportWithFetch(serialized, snapshotId, revision) {
    if (typeof window.fetch !== 'function') {
      observe('transport_unavailable', function () {
        recordEvent('transport_failed', 'transport', 'warning', {
          reason: 'fetch_unavailable'
        }, true);
      });
      return;
    }
    var delivery = {
      serialized: serialized,
      snapshotId: snapshotId,
      revision: revision,
      bytes: utf8Length(serialized)
    };
    if (transportInFlight) {
      /*
       * Keep at most the current request and the newest cumulative snapshot.
       * Replacing this slot prevents a hung fetch from retaining an unbounded
       * Promise chain of obsolete bodies.
       */
      latestQueuedTransport = delivery;
      return;
    }
    startQueuedTransport(delivery);
  }

  function transportWithBeacon(serialized, snapshotId, revision) {
    try {
      if (
        window.navigator &&
        typeof window.navigator.sendBeacon === 'function' &&
        typeof window.Blob === 'function'
      ) {
        var body = new window.Blob([serialized], { type: 'text/plain;charset=UTF-8' });
        if (window.navigator.sendBeacon(config.endpoint, body)) {
          /*
           * A true result means "queued", not delivered. Keep the cumulative
           * snapshot in sessionStorage until a later confirmed CORS response.
           */
          return true;
        }
      }
    } catch (error) {
      // Fall through to keepalive fetch.
    }
    transportWithFetch(serialized, snapshotId, revision);
    return false;
  }

  function emitSnapshot(reason, lifecycle, useBeacon, allowDisabled) {
    if (disabled && !allowDisabled) return;
    if (quarantinedPending) {
      queuedReason = boundedString(reason || 'event', 80);
      queuedLifecycle = strongerLifecycle(
        queuedLifecycle,
        lifecycle || 'active'
      );
      queuedAllowDisabled = queuedAllowDisabled || !!allowDisabled;
      queuedUseBeacon = queuedUseBeacon || !!useBeacon;
      return;
    }
    if (
      (lifecycle === 'terminated' || lifecycle === 'forced_exit') &&
      (completionWritten || completionQueuedByTimegate) &&
      !completionCommitted
    ) {
      upsertIssue('COMPLETION_NOT_COMMITTED', 'error', 'host', {
        reason: lifecycle
      }, true);
    }
    var snapshot = buildSnapshot(lifecycle);
    var serialized = serializedWithinLimit(snapshot);
    if (!serialized) {
      registerInternalFailure(new Error('Snapshot exceeds delivery limit'), 'snapshot_size');
      return;
    }
    storePending(serialized);
    recordEvent('snapshot_queued', 'transport', 'info', {
      reason: boundedString(reason, 80)
    }, false);
    if (useBeacon) {
      transportWithBeacon(serialized, snapshot.session.id, snapshot.session.revision);
    } else {
      transportWithFetch(serialized, snapshot.session.id, snapshot.session.revision);
    }
  }

  var queuedReason = '';
  var queuedLifecycle = null;
  var queuedAllowDisabled = false;
  var queuedUseBeacon = false;

  function strongerLifecycle(current, next) {
    var rank = {
      active: 0,
      page_hidden: 1,
      terminated: 2,
      forced_exit: 3
    };
    if (!current) return next || 'active';
    if (!next) return current;
    return (rank[next] || 0) > (rank[current] || 0) ? next : current;
  }

  function releaseQuarantinedSnapshots() {
    if (quarantinedPending) return;
    if (snapshotTimer !== null) {
      window.clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }
    var reason = queuedReason || 'launch';
    var lifecycle = queuedLifecycle || session.lifecycle || 'active';
    var allowDisabled = queuedAllowDisabled;
    var useBeacon = queuedUseBeacon;
    queuedReason = '';
    queuedLifecycle = null;
    queuedAllowDisabled = false;
    queuedUseBeacon = false;
    emitSnapshot(reason, lifecycle, useBeacon, allowDisabled);
  }

  function scheduleSnapshot(reason, lifecycle, immediate, allowDisabled) {
    if (disabled && !allowDisabled) return;
    queuedReason = boundedString(reason || 'event', 80);
    queuedLifecycle = strongerLifecycle(queuedLifecycle, lifecycle || 'active');
    queuedAllowDisabled = queuedAllowDisabled || !!allowDisabled;
    if (quarantinedPending) return;
    if (immediate) {
      if (snapshotTimer !== null) {
        window.clearTimeout(snapshotTimer);
        snapshotTimer = null;
      }
      var immediateReason = queuedReason;
      var immediateLifecycle = queuedLifecycle;
      var immediateAllowDisabled = queuedAllowDisabled;
      queuedLifecycle = null;
      queuedAllowDisabled = false;
      queuedUseBeacon = false;
      emitSnapshot(immediateReason, immediateLifecycle, false, immediateAllowDisabled);
      return;
    }
    if (snapshotTimer !== null) return;
    snapshotTimer = window.setTimeout(function () {
      snapshotTimer = null;
      var reasonToSend = queuedReason;
      var lifecycleToSend = queuedLifecycle || session.lifecycle || 'active';
      var allowDisabledToSend = queuedAllowDisabled;
      queuedLifecycle = null;
      queuedAllowDisabled = false;
      queuedUseBeacon = false;
      emitSnapshot(reasonToSend, lifecycleToSend, false, allowDisabledToSend);
    }, 0);
  }

  function wrapFunction(target, name, observer) {
    if (!target || typeof target[name] !== 'function') return false;
    var original = target[name];
    if (original[WRAPPED_FLAG]) return true;

    var wrapped = function () {
      var args = Array.prototype.slice.call(arguments);
      var callContext = null;
      var callContextStack = null;
      if (name === 'SCORM_CallLMSSetValue') {
        callContext = {
          element: args.length ? args[0] : '',
          value: args.length > 1 ? args[1] : '',
          completionGatedByTimegate: false,
          completionReplay: null
        };
        callContextStack = activeScormSetValueCalls;
      } else if (name === 'SCORM_CallLMSFinish') {
        callContext = {
          terminationDeferredByTimegate: false,
          timegateFailureOperation: ''
        };
        callContextStack = activeScormFinishCalls;
      }
      if (callContextStack) callContextStack.push(callContext);
      var result;
      try {
        result = original.apply(this, arguments);
      } catch (originalError) {
        observe('observe_throw_' + name, function () {
          observer(name, args, undefined, originalError, callContext);
        });
        if (callContextStack) callContextStack.pop();
        throw originalError;
      }
      observe('observe_' + name, function () {
        observer(name, args, result, null, callContext);
      });
      if (callContextStack) callContextStack.pop();
      return result;
    };
    try {
      Object.defineProperty(wrapped, WRAPPED_FLAG, {
        value: true,
        enumerable: false
      });
    } catch (error) {
      wrapped[WRAPPED_FLAG] = true;
    }
    target[name] = wrapped;
    return target[name] === wrapped;
  }

  function scormDiagnosticValue(element, value, method) {
    var normalized = String(element || '').toLowerCase();
    var output = {};
    if (scormElementIsSensitive(normalized) || !scormElementIsSafeValue(normalized)) {
      fingerprintSensitive(value, output, function (fingerprint) {
        observe('sensitive_value_hash', function () {
          recordEvent('scorm_call', 'scorm', 'info', {
            method: boundedString(method, 40),
            element: boundedString(element, 200),
            result: 'fingerprinted',
            valueLength: fingerprint.valueLength,
            valueSha256: fingerprint.valueSha256
          }, true);
        });
      });
      return output;
    }
    if (
      normalized === 'cmi.core.lesson_status' ||
      normalized === 'cmi.completion_status' ||
      normalized === 'cmi.success_status'
    ) {
      output.completionStatus = normalizedScormStatus(value);
    } else if (
      normalized === 'cmi.core.score.raw' ||
      normalized === 'cmi.score.raw'
    ) {
      var score = clampedNumber(value, -1000000, 1000000);
      if (score !== null) output.score = score;
    } else if (
      normalized === 'cmi.core.session_time' ||
      normalized === 'cmi.session_time'
    ) {
      output.sessionTime = safeSessionTime(value);
    } else if (
      normalized === 'cmi.core.lesson_location' ||
      normalized === 'cmi.location'
    ) {
      output.bookmark = sanitizeRiseBookmark(value);
    } else if (/\.type$/.test(normalized)) {
      output.questionType = normalizedQuestionType(value);
    } else if (/\.result$/.test(normalized)) {
      var result = String(value || '').toLowerCase();
      var numericResult = finiteNumber(result);
      output.result =
        result === 'correct' ||
        result === 'wrong' ||
        result === 'unanticipated' ||
        result === 'neutral' ||
        numericResult !== null ?
          boundedString(result, 80) : 'unknown';
    } else if (
      normalized === 'cmi.core.exit' ||
      normalized === 'cmi.exit'
    ) {
      var exitStatus = String(value || '').toLowerCase();
      output.status =
        exitStatus === '' ||
        exitStatus === 'logout' ||
        exitStatus === 'suspend' ||
        exitStatus === 'time-out' ||
        exitStatus === 'normal' ?
          exitStatus : 'unknown';
    } else {
      output.status = 'observed';
    }
    return output;
  }

  function mergeEventData(left, right) {
    var output = {};
    var key;
    for (key in left) {
      if (Object.prototype.hasOwnProperty.call(left, key)) output[key] = left[key];
    }
    for (key in right) {
      if (Object.prototype.hasOwnProperty.call(right, key)) output[key] = right[key];
    }
    return output;
  }

  function cachedScormError() {
    var code =
      typeof window.intSCORMError !== 'undefined' ?
        window.intSCORMError : '';
    return {
      errorCode: safeScormErrorCode(code),
      /*
       * Rustici/LMS diagnostic strings can echo rejected values (including
       * suspend data and learner answers). Keep the structured code and a
       * generic message instead of forwarding opaque LMS text.
       */
      message: code && String(code) !== '0' ? 'LMS call failed' : ''
    };
  }

  function observeScormCall(name, args, result, originalError, callContext) {
    var method = name.replace('SCORM_CallLMS', '');
    var data = {
      method: method,
      result:
        originalError ? 'threw' :
        name === 'SCORM_CallLMSGetValue' ? 'returned' :
        normalizeBoolean(result) ? 'true' : 'false'
    };
    var severity = originalError ? 'error' : 'info';
    var milestone = false;
    var booleanResultMethod = name !== 'SCORM_CallLMSGetValue';
    var cachedErrorForCall = cachedScormError();
    var cachedCodeIsError = !!(
      cachedErrorForCall.errorCode &&
      cachedErrorForCall.errorCode !== '0'
    );
    var callFailed = !!originalError || (
      booleanResultMethod ? !normalizeBoolean(result) : cachedCodeIsError
    );
    if (callFailed) severity = 'error';
    if (callFailed) {
      var cachedError = cachedErrorForCall;
      if (cachedError.errorCode) {
        runtimeState.lastErrorCode = cachedError.errorCode;
        data.errorCode = cachedError.errorCode;
      }
      if (!data.message && cachedError.message) data.message = cachedError.message;
    }

    if (name === 'SCORM_CallLMSInitialize') {
      var initialized = !originalError && normalizeBoolean(result);
      var alreadyInitialized = runtimeState.initialized;
      runtimeState.initialized = initialized || alreadyInitialized;
      data.status = initialized ? 'initialized' :
        alreadyInitialized ? 'already_initialized' : 'failed';
      milestone = true;
      if (initialized) {
        resolveIssue('INITIALIZATION_FAILED');
        resolveIssue('MISSING_SCORM_API');
      } else if (!alreadyInitialized) {
        upsertIssue('INITIALIZATION_FAILED', 'error', 'scorm', {
          method: method,
          result: data.result,
          errorCode: data.errorCode,
          message: data.message
        }, true);
        if (
          (
            typeof window.SCORM_objAPI === 'undefined' ||
            window.SCORM_objAPI === null
          ) &&
          !hasRawScormApi()
        ) {
          upsertIssue('MISSING_SCORM_API', 'error', 'scorm', {
            reason: 'api_discovery_failed'
          }, true);
        }
      }
      scheduleSnapshot('scorm_initialize', 'active', false, false);
    } else if (name === 'SCORM_CallLMSGetValue') {
      var getElement = boundedString(args[0], 200);
      data.element = getElement;
      if (!originalError && !callFailed) {
        updateStateFromScorm(getElement, result, true);
      }
      data = mergeEventData(
        data,
        scormDiagnosticValue(getElement, result, method)
      );
    } else if (name === 'SCORM_CallLMSSetValue') {
      var setElement = boundedString(args[0], 200);
      var setValue = args.length > 1 ? args[1] : '';
      var setSucceeded = !originalError && normalizeBoolean(result);
      var completionWasGated = !!(
        callContext &&
        callContext.completionGatedByTimegate &&
        timegateGateableStatusElement(setElement, setValue)
      );
      data.element = setElement;
      data = mergeEventData(
        data,
        scormDiagnosticValue(setElement, setValue, method)
      );
      if (completionWasGated) {
        data.result = 'queued';
        data.status = 'timegate_gated';
      } else if (setSucceeded) {
        updateStateFromScorm(setElement, setValue, false);
      }
      if (completionElement(setElement, setValue)) {
        milestone = true;
        if (completionWasGated) {
          completionQueuedByTimegate = true;
        } else if (setSucceeded) {
          var synchronousReplay =
            callContext && callContext.completionReplay;
          if (
            synchronousReplay &&
            synchronousReplay.canonicalCompletion &&
            synchronousReplay.success === false
          ) {
            completionQueuedByTimegate = true;
            completionWritten = false;
            completionCommitted = false;
          } else {
            completionQueuedByTimegate = false;
            completionWritten = true;
            completionCommitted = !!(
              synchronousReplay &&
              synchronousReplay.canonicalCompletion &&
              synchronousReplay.success === true &&
              synchronousReplay.resultBoolean === true
            );
            resolveIssue('COMPLETION_WRITE_FAILED');
            if (completionCommitted) {
              resolveIssue('COMMIT_FAILED');
              resolveIssue('COMPLETION_NOT_COMMITTED');
            }
          }
        } else {
          upsertIssue('COMPLETION_WRITE_FAILED', 'error', 'scorm', {
            method: method,
            element: setElement,
            result: data.result,
            errorCode: data.errorCode,
            message: data.message
          }, true);
        }
        scheduleSnapshot(
          completionWasGated ? 'completion_gated' : 'completion_write',
          'active',
          false,
          false
        );
      }
    } else if (name === 'SCORM_CallLMSCommit') {
      var commitSucceeded = !originalError && normalizeBoolean(result);
      runtimeState.lastCommitResult = commitSucceeded;
      milestone = true;
      if (commitSucceeded) {
        if (completionWritten) {
          completionCommitted = true;
          resolveIssue('COMPLETION_NOT_COMMITTED');
        }
        resolveIssue('COMMIT_FAILED');
      } else {
        upsertIssue('COMMIT_FAILED', 'error', 'scorm', {
          method: method,
          result: data.result,
          errorCode: data.errorCode,
          message: data.message
        }, true);
      }
      scheduleSnapshot('scorm_commit', 'active', false, false);
    } else if (name === 'SCORM_CallLMSFinish') {
      var finishSucceeded = !originalError && normalizeBoolean(result);
      milestone = true;
      if (callContext && callContext.terminationDeferredByTimegate) {
        runtimeState.finishResult = null;
        data.result = 'queued';
        data.status = 'pending';
        scheduleSnapshot('scorm_finish_deferred', 'active', false, false);
      } else if (finishSucceeded) {
        runtimeState.finishResult = true;
        resolveIssue('LMS_FINALIZATION_FAILED');
        resolveIssue('LMS_TERMINATION_FAILED');
        resolveIssue('LMS_OPERATION_FAILED');
        scheduleSnapshot('scorm_finish', 'terminated', false, false);
      } else {
        runtimeState.finishResult = false;
        if (!(callContext && callContext.timegateFailureOperation)) {
          upsertIssue('LMS_TERMINATION_FAILED', 'error', 'scorm', {
            method: method,
            result: data.result,
            errorCode: data.errorCode,
            message: data.message
          }, true);
        }
        scheduleSnapshot('scorm_finish_failed', 'active', false, false);
      }
    }

    if (originalError) data.message = 'SCORM helper threw';
    recordEvent('scorm_call', 'scorm', severity, safeEventData(data), milestone);
    if (callFailed) {
      scheduleSnapshot('scorm_error', session.lifecycle, false, false);
    }
  }

  function observeRawScormGetValue(name, args, result, originalError) {
    if (originalError || !args || !args.length) return;
    if (typeof args[0] !== 'string') return;
    var element = args[0].toLowerCase();
    if (
      element === 'cmi.core.student_id' ||
      element === 'cmi.learner_id'
    ) {
      if (typeof result === 'string' || typeof result === 'number') {
        learnerId = boundedString(result, 128);
        resolveQuarantinedLearner(learnerId, false);
      }
    } else if (
      recognizedCanonicalCompletionStatus(element, result)
    ) {
      updateStateFromScorm(element, result, true);
    }
  }

  function collectRawApiCandidates() {
    var candidates = [];
    var aliases = ['API', 'API_1484_11', 'SCORM_objAPI'];

    function inspect(frame) {
      for (var i = 0; i < aliases.length; i++) {
        try {
          var candidate = frame[aliases[i]];
          if (
            candidate &&
            typeof candidate === 'object' &&
            candidates.indexOf(candidate) === -1
          ) {
            candidates.push(candidate);
          }
        } catch (ignored) {
          // Cross-origin or protected frame; do not traverse it.
        }
      }
    }

    function inspectParents(start) {
      var current = start;
      for (var depth = 0; current && depth < 20; depth++) {
        inspect(current);
        try {
          if (!current.parent || current.parent === current) break;
          current = current.parent;
        } catch (ignored) {
          break;
        }
      }
    }

    inspectParents(window);
    try {
      if (window.opener) inspectParents(window.opener);
    } catch (ignored) {
      // Cross-origin opener; same-origin API discovery remains available.
    }
    return candidates;
  }

  function installRawApiLearnerWrappers() {
    var candidates = collectRawApiCandidates();
    for (var j = 0; j < candidates.length; j++) {
      wrapFunction(candidates[j], 'LMSGetValue', observeRawScormGetValue);
      wrapFunction(candidates[j], 'GetValue', observeRawScormGetValue);
    }
  }

  function hasRawScormApi() {
    var candidates = collectRawApiCandidates();
    for (var i = 0; i < candidates.length; i++) {
      try {
        var candidate = candidates[i];
        if (
          (
            typeof candidate.LMSGetValue === 'function' ||
            typeof candidate.GetValue === 'function'
          )
        ) {
          return true;
        }
      } catch (ignored) {
        // Continue checking other same-frame API aliases.
      }
    }
    return false;
  }

  function installScormWrappers() {
    var names = [
      'SCORM_CallLMSInitialize',
      'SCORM_CallLMSGetValue',
      'SCORM_CallLMSSetValue',
      'SCORM_CallLMSCommit',
      'SCORM_CallLMSFinish'
    ];
    var found = 0;
    for (var i = 0; i < names.length; i++) {
      if (typeof window[names[i]] === 'function') {
        if (wrapFunction(window, names[i], observeScormCall)) found += 1;
      }
    }
    if (found === 0) {
      if (!hasRawScormApi()) {
        upsertIssue('MISSING_SCORM_API', 'error', 'scorm', {
          reason: 'rustici_helpers_missing'
        }, true);
      }
      upsertIssue('DEGRADED_SHIM', 'warning', 'scorm', {
        reason: 'rustici_helpers_missing'
      }, true);
      recordEvent('instrumentation_error', 'scorm', 'error', {
        operation: 'installScormWrappers',
        reason: 'rustici_helpers_missing'
      }, true);
    } else if (found < names.length) {
      upsertIssue('DEGRADED_SHIM', 'warning', 'scorm', {
        reason: 'rustici_helpers_incomplete'
      }, true);
    }
  }

  function safeAnswerData(input) {
    var output = {};
    if (!input || typeof input !== 'object') return output;
    var explicitQuestionId = input.itemId || input.questionId;
    var questionId = explicitQuestionId || input.id;
    var quizId =
      input.quizId ||
      input.assessmentId ||
      (explicitQuestionId ? input.id : null);
    if (questionId !== null && typeof questionId !== 'undefined') {
      output.questionId = boundedString(questionId, 256);
    }
    if (quizId !== null && typeof quizId !== 'undefined') {
      output.quizId = boundedString(quizId, 256);
    }
    if (input.type) output.questionType = normalizedQuestionType(input.type);
    if (typeof input.isCorrect === 'boolean') output.correctness = input.isCorrect;
    var latency = finiteNumber(input.latency);
    if (latency !== null) output.latencyMs = latency;
    var retry = finiteNumber(input.retryAttempts);
    if (retry !== null) output.retryNumber = retry;
    return output;
  }

  function riseDiagnosticData(name, args) {
    var input = args && args.length ? args[0] : null;
    var output = { method: name };
    if (name === 'initialize' && input && typeof input === 'object') {
      output.status = 'configuration_received';
      if (input.quizId) output.quizId = boundedString(input.quizId, 256);
      if (finiteNumber(input.completionPercentage) !== null) {
        output.progressPercent = clampedNumber(
          input.completionPercentage,
          0,
          100
        );
      }
    } else if (name === 'setCourseProgress') {
      if (input && typeof input === 'object') {
        var progress = clampedNumber(input.percentComplete, 0, 100);
        if (progress !== null) {
          output.progressPercent = progress;
          runtimeState.progressPercent = progress;
        }
      } else if (finiteNumber(input) !== null) {
        output.progressPercent = clampedNumber(input, 0, 100);
        runtimeState.progressPercent = clampedNumber(input, 0, 100);
      }
    } else if (name === 'setLessonProgress') {
      if (input && typeof input === 'object') {
        output.lessonId = boundedString(input.id, 256);
        var lessonProgress = clampedNumber(input.percentComplete, 0, 100);
        if (lessonProgress !== null) output.progressPercent = lessonProgress;
      }
    } else if (name === 'finishQuiz') {
      output.status = normalizeBoolean(args[0]) ? 'passed' : 'failed';
      var quizScore = clampedNumber(args[1], -1000000, 1000000);
      if (quizScore !== null) {
        output.score = quizScore;
        runtimeState.scoreRaw = quizScore;
      }
      output.quizId = boundedString(args[2], 256);
    } else if (name === 'finishStoryline') {
      output.status = normalizeBoolean(args[1]) ? 'passed' : 'failed';
      output.quizId = boundedString(args[0], 256);
      var storylineScore = clampedNumber(args[3], -1000000, 1000000);
      if (storylineScore !== null) {
        output.score = storylineScore;
        runtimeState.scoreRaw = storylineScore;
      }
    } else if (name === 'reportAnswer') {
      output = mergeEventData(output, safeAnswerData(input));
    } else if (name === 'reportUngradedAnswers') {
      output.attempt = Array.isArray(input) ? Math.min(input.length, 500) : 0;
    } else if (name === 'setBookmark') {
      output.bookmark = sanitizeRiseBookmark(input);
    } else if (name === 'setSessionTime') {
      output.sessionTime = safeSessionTime(input);
    } else if (name === 'reportScore' || name === 'setScore') {
      var score = clampedNumber(input, -1000000, 1000000);
      if (score !== null) {
        output.score = score;
        runtimeState.scoreRaw = score;
      }
    } else if (
      name === 'exit' ||
      name === 'suspend' ||
      name === 'timeout' ||
      name === 'unload'
    ) {
      output.status = name;
    }
    return output;
  }

  function observeRiseCall(name, args, result, originalError) {
    var data = riseDiagnosticData(name, args);
    data.result = resultMarker(result, originalError);
    if (originalError) data.message = 'Rise method threw';
    var milestoneNames = {
      setCourseProgress: true,
      setLessonProgress: true,
      finish: true,
      finishQuiz: true,
      finishStoryline: true,
      reportAnswer: true,
      reportUngradedAnswers: true,
      setBookmark: true,
      exit: true,
      suspend: true,
      timeout: true,
      unload: true
    };
    var milestone = !!milestoneNames[name];
    recordEvent(
      'rise_call',
      'rise',
      originalError ? 'error' : 'info',
      safeEventData(data),
      milestone
    );
    if (milestone) {
      var lifecycle =
        name === 'exit' || name === 'unload' || name === 'timeout' ?
          'terminated' : 'active';
      scheduleSnapshot('rise_' + name, lifecycle, false, false);
    }
  }

  function installRiseWrappers() {
    var rise = window.RiseLMSInterface;
    if (!rise || typeof rise !== 'object') {
      upsertIssue('DEGRADED_SHIM', 'warning', 'rise', {
        reason: 'rise_interface_missing'
      }, true);
      return;
    }
    var names = [
      'initialize', 'start', 'setCourseProgress', 'setLessonProgress',
      'finish', 'finishQuiz', 'finishStoryline', 'reportAnswer',
      'reportUngradedAnswers', 'setBookmark', 'setSessionTime',
      'pauseTimeTracking', 'resumeTimeTracking', 'reportScore', 'setScore',
      'exit', 'suspend', 'timeout', 'unload', 'commit'
    ];
    var wrappedCount = 0;
    for (var i = 0; i < names.length; i++) {
      if (typeof rise[names[i]] === 'function') {
        if (wrapFunction(rise, names[i], observeRiseCall)) wrappedCount += 1;
      }
    }
    if (wrappedCount === 0) {
      upsertIssue('DEGRADED_SHIM', 'warning', 'rise', {
        reason: 'rise_methods_unavailable'
      }, true);
    }
  }

  function expectedContentWindow(source) {
    var frame = null;
    try {
      frame =
        document.getElementById('content-frame') ||
        document.querySelector('iframe[name="scormdriver_content"]');
    } catch (error) {
      return false;
    }
    if (!frame) return false;
    try {
      return frame.contentWindow === source;
    } catch (error) {
      return false;
    }
  }

  function expectedMessageOrigin(origin) {
    var ownOrigin = '';
    try {
      ownOrigin = window.location.origin;
    } catch (error) {
      return false;
    }
    if (ownOrigin === 'null') return origin === 'null';
    return !!ownOrigin && origin === ownOrigin;
  }

  function observeProbeEvent(probeEvent) {
    if (!probeEvent || typeof probeEvent !== 'object') return;
    var type = boundedString(probeEvent.type, 80);
    var allowed = {
      javascript_error: true,
      unhandled_rejection: true,
      resource_error: true,
      route_change: true,
      media_event: true
    };
    if (!allowed[type]) return;
    var data = safeEventData(probeEvent.data);
    var informational = (
      type === 'route_change' ||
      (type === 'media_event' && data.operation !== 'error')
    );
    var severity = informational ? 'info' : 'error';
    var milestone = severity === 'error';
    recordEvent(type, 'content_probe', severity, data, milestone);
    if (
      type === 'javascript_error' ||
      type === 'unhandled_rejection' ||
      type === 'resource_error'
    ) {
      upsertIssue('JAVASCRIPT_ERROR', 'error', 'content_probe', {
        eventType: type,
        message: data.message,
        resource: data.filename
      }, true);
    } else if (type === 'media_event' && data.operation === 'error') {
      upsertIssue('MEDIA_ERROR', 'error', 'content_probe', {
        eventType: type,
        message: data.message
      }, true);
    }
    if (milestone) scheduleSnapshot('content_' + type, 'active', false, false);
  }

  function installContentChannel() {
    if (typeof window.MessageChannel !== 'function') {
      upsertIssue('DEGRADED_SHIM', 'warning', 'content_probe', {
        reason: 'message_channel_unavailable'
      }, true);
      return;
    }
    window.addEventListener('message', function (event) {
      observe('content_channel_connect', function () {
        var message = event && event.data;
        if (
          !message ||
          message.type !== 'sis-observability-connect' ||
          message.protocolVersion !== PROTOCOL_VERSION ||
          typeof message.nonce !== 'string' ||
          !expectedContentWindow(event.source) ||
          !expectedMessageOrigin(event.origin)
        ) {
          return;
        }
        if (channelPort && typeof channelPort.close === 'function') {
          try { channelPort.close(); } catch (error) { /* ignore */ }
        }
        var channel = new window.MessageChannel();
        channelPort = channel.port1;
        var nonce = boundedString(message.nonce, 100);
        channelPort.onmessage = function (portEvent) {
          observe('content_channel_event', function () {
            var payload = portEvent && portEvent.data;
            if (
              !payload ||
              payload.type !== 'sis-observability-event' ||
              payload.protocolVersion !== PROTOCOL_VERSION ||
              payload.nonce !== nonce
            ) {
              return;
            }
            observeProbeEvent(payload.event);
          });
        };
        if (typeof channelPort.start === 'function') channelPort.start();
        var targetOrigin = event.origin === 'null' ? '*' : event.origin;
        event.source.postMessage({
          type: 'sis-observability-connected',
          protocolVersion: PROTOCOL_VERSION,
          nonce: nonce
        }, targetOrigin, [channel.port2]);
      });
    }, false);
  }

  function updateTimegateClock(type, detail) {
    var canonicalActive = finiteNumber(detail.activeSeconds);
    var canonicalIdle = finiteNumber(detail.idleSeconds);
    if (canonicalActive !== null) {
      timegateClock.activeSeconds = Math.max(
        timegateClock.activeSeconds,
        canonicalActive
      );
    }
    if (type === 'tracking_started') {
      timegateClock.idleBaseSeconds = timegateClock.idleSeconds;
      timegateClock.segmentStarted = true;
    }
    if (canonicalIdle !== null) {
      var idleBase = timegateClock.segmentStarted ?
        timegateClock.idleBaseSeconds : 0;
      timegateClock.idleSeconds = Math.max(
        timegateClock.idleSeconds,
        idleBase + canonicalIdle
      );
    }
  }

  function safeTimegateLmsOperation(value) {
    var operation = String(value || '');
    var allowed = {
      finalize: true,
      Initialize: true,
      LMSInitialize: true,
      LMSFinish: true,
      Terminate: true
    };
    return allowed[operation] ? operation : 'lms_operation';
  }

  function safeTimegateLmsReason(value) {
    var reason = String(value || '');
    var allowed = {
      course: true,
      inactivity: true,
      initialize: true,
      maximum: true
    };
    return allowed[reason] ? reason : 'lms_operation_failed';
  }

  function installTimegateEvents() {
    document.addEventListener('sis:timegate', function (event) {
      observe('timegate_event', function () {
        var detail = event && event.detail;
        if (!detail || detail.version !== 1 || typeof detail.type !== 'string') return;
        var allowed = {
          tracking_started: true,
          idle_entered: true,
          idle_exited: true,
          completion_gated: true,
          completion_reset: true,
          minimum_time_met: true,
          completion_replayed: true,
          persistence_failed: true,
          persistence_recovered: true,
          configuration_failed: true,
          lms_operation_failed: true,
          termination_deferred: true,
          termination_completed: true,
          forced_exit: true,
          maximum_time_reached: true,
          metrics: true
        };
        var type = boundedString(detail.type, 80);
        if (!allowed[type]) return;
        if (type === 'completion_gated') {
          var completionGateAccepted = detail.success !== false;
          var activeSetValueCall = activeScormSetValueCalls.length ?
            activeScormSetValueCalls[activeScormSetValueCalls.length - 1] : null;
          if (
            completionGateAccepted &&
            (
              !activeSetValueCall ||
              completionElement(activeSetValueCall.element, activeSetValueCall.value)
            )
          ) {
            completionQueuedByTimegate = true;
          }
          if (
            completionGateAccepted &&
            activeSetValueCall &&
            timegateGateableStatusElement(
              activeSetValueCall.element,
              activeSetValueCall.value
            )
          ) {
            activeSetValueCall.completionGatedByTimegate = true;
          }
        } else if (type === 'termination_deferred') {
          var terminationDeferralAccepted = detail.success !== false;
          var activeFinishCall = activeScormFinishCalls.length ?
            activeScormFinishCalls[activeScormFinishCalls.length - 1] : null;
          if (terminationDeferralAccepted && activeFinishCall) {
            activeFinishCall.terminationDeferredByTimegate = true;
          }
          if (terminationDeferralAccepted) {
            runtimeState.finishResult = null;
          }
        }
        updateTimegateClock(type, detail);
        var eventReason = boundedString(detail.reason, 80);
        var eventOperation = type;
        if (type === 'configuration_failed') {
          eventReason = 'configuration_error';
        } else if (type === 'lms_operation_failed') {
          eventReason = safeTimegateLmsReason(detail.reason);
          eventOperation = safeTimegateLmsOperation(detail.operation);
        } else if (type === 'termination_deferred') {
          eventReason = 'completion_pending';
        }
        var data = safeEventData({
          eventType: type,
          operation: eventOperation,
          reason: eventReason,
          status: type === 'termination_deferred' ?
            detail.success === false ? 'failed' : 'pending' : null,
          durationSeconds: finiteNumber(detail.durationSeconds),
          activeSeconds: finiteNumber(detail.activeSeconds),
          idleSeconds: finiteNumber(detail.idleSeconds),
          limitSeconds: finiteNumber(detail.limitSeconds),
          completionStatus: boundedString(detail.completionStatus, 40),
          canonicalCompletion: detail.canonicalCompletion,
          sessionTime: detail.sessionTime,
          persistence: detail.persistence,
          success: detail.success,
          resultBoolean: detail.resultBoolean
        });
        var severity =
          type === 'configuration_failed' ||
          type === 'lms_operation_failed' ?
            'error' :
          type === 'persistence_failed' ||
          type === 'forced_exit' ||
          type === 'maximum_time_reached' ?
            'warning' : 'info';
        recordEvent(
          'timegate_event',
          'timegate',
          severity,
          data,
          type !== 'metrics'
        );
        if (type === 'persistence_failed') {
          upsertIssue('TIMEGATE_PERSISTENCE_FAILED', 'warning', 'timegate', {
            reason: boundedString(detail.reason, 80),
            backend: boundedString(detail.backend, 80)
          }, true);
        } else if (type === 'persistence_recovered') {
          resolveIssue('TIMEGATE_PERSISTENCE_FAILED');
        } else if (type === 'configuration_failed') {
          upsertIssue(
            'TIMEGATE_CONFIGURATION_FAILED',
            'error',
            'timegate',
            { reason: 'configuration_error' },
            true
          );
        } else if (type === 'lms_operation_failed') {
          var failedOperation = safeTimegateLmsOperation(detail.operation);
          var failureEvidence = {
            operation: failedOperation,
            reason: safeTimegateLmsReason(detail.reason),
            result: 'false',
            sessionTime: detail.sessionTime,
            persistence: detail.persistence,
            resultBoolean: detail.resultBoolean
          };
          var pendingFinishCall = activeScormFinishCalls.length ?
            activeScormFinishCalls[activeScormFinishCalls.length - 1] : null;
          if (pendingFinishCall) {
            pendingFinishCall.timegateFailureOperation = failedOperation;
          }
          if (failedOperation === 'finalize') {
            if (typeof detail.resultBoolean === 'boolean') {
              runtimeState.lastCommitResult = detail.resultBoolean;
            }
            upsertIssue(
              'LMS_FINALIZATION_FAILED',
              'error',
              'timegate',
              failureEvidence,
              true
            );
          } else if (
            failedOperation === 'Initialize' ||
            failedOperation === 'LMSInitialize'
          ) {
            if (!runtimeState.initialized) {
              upsertIssue(
                'INITIALIZATION_FAILED',
                'error',
                'timegate',
                failureEvidence,
                true
              );
            }
          } else if (
            failedOperation === 'Terminate' ||
            failedOperation === 'LMSFinish'
          ) {
            runtimeState.finishResult = false;
            upsertIssue(
              'LMS_TERMINATION_FAILED',
              'error',
              'timegate',
              failureEvidence,
              true
            );
          } else {
            upsertIssue(
              'LMS_OPERATION_FAILED',
              'error',
              'timegate',
              failureEvidence,
              true
            );
          }
        } else if (type === 'completion_replayed') {
          var canonicalCompletionReplay = detail.canonicalCompletion === true;
          var replayingSetValueCall = activeScormSetValueCalls.length ?
            activeScormSetValueCalls[activeScormSetValueCalls.length - 1] : null;
          if (
            replayingSetValueCall &&
            detail.reason === 'scorm'
          ) {
            replayingSetValueCall.completionReplay = {
              canonicalCompletion: canonicalCompletionReplay,
              success: detail.success,
              resultBoolean: detail.resultBoolean
            };
          }
          if (canonicalCompletionReplay) {
            if (detail.success === false) {
              completionQueuedByTimegate = true;
              completionWritten = false;
              completionCommitted = false;
              upsertIssue('COMPLETION_WRITE_FAILED', 'error', 'timegate', {
                reason: boundedString(detail.reason || 'replay_failed', 80),
                result: 'false'
              }, true);
            } else if (detail.success === true) {
              completionQueuedByTimegate = false;
              completionWritten = true;
              resolveIssue('COMPLETION_WRITE_FAILED');
              if (detail.reason === 'rise_driver') {
                completionCommitted = true;
                resolveIssue('COMMIT_FAILED');
                resolveIssue('COMPLETION_NOT_COMMITTED');
              }
            }
          }
          if (detail.reason === 'scorm') {
            if (detail.resultBoolean === false) {
              upsertIssue('COMMIT_FAILED', 'error', 'timegate', {
                reason: 'completion_replay',
                result: 'false'
              }, true);
              if (canonicalCompletionReplay) {
                completionCommitted = false;
                upsertIssue('COMPLETION_NOT_COMMITTED', 'error', 'timegate', {
                  reason: 'completion_replay'
                }, true);
              }
            } else if (
              detail.resultBoolean === true &&
              detail.success === true
            ) {
              resolveIssue('COMMIT_FAILED');
              if (canonicalCompletionReplay) {
                completionCommitted = true;
                resolveIssue('COMPLETION_NOT_COMMITTED');
              }
            }
          }
        } else if (type === 'completion_reset') {
          if (detail.canonicalCompletion === true) {
            completionQueuedByTimegate = false;
            completionWritten = false;
            completionCommitted = false;
            resolveIssue('COMPLETION_WRITE_FAILED');
            resolveIssue('COMPLETION_NOT_COMMITTED');
            if (
              recognizedCanonicalCompletionStatus(
                courseDescriptor.scormVersion === '2004' ?
                  'cmi.completion_status' : 'cmi.core.lesson_status',
                detail.completionStatus
              )
            ) {
              runtimeState.lessonStatus = normalizedScormStatus(
                detail.completionStatus
              );
            }
          }
        } else if (
          type === 'termination_completed' &&
          detail.success === true
        ) {
          runtimeState.finishResult = true;
          resolveIssue('LMS_FINALIZATION_FAILED');
          resolveIssue('LMS_TERMINATION_FAILED');
          resolveIssue('LMS_OPERATION_FAILED');
          scheduleSnapshot(
            'timegate_termination_completed',
            'terminated',
            false,
            false
          );
          return;
        } else if (type === 'forced_exit') {
          upsertIssue('FORCED_IDLE_EXIT', 'error', 'timegate', {
            reason: boundedString(detail.reason || 'inactivity', 80)
          }, true);
          scheduleSnapshot('timegate_forced_exit', 'forced_exit', false, false);
          return;
        } else if (type === 'maximum_time_reached') {
          upsertIssue('MAXIMUM_TIME_REACHED', 'warning', 'timegate', {
            reason: boundedString(detail.reason || 'maximum_time_reached', 80),
            limitSeconds: finiteNumber(detail.limitSeconds)
          }, true);
          scheduleSnapshot('timegate_maximum_time', 'forced_exit', false, false);
          return;
        }
        if (type !== 'metrics') {
          scheduleSnapshot('timegate_' + type, 'active', false, false);
        }
      });
    }, false);
  }

  function rehydrateIssues(values) {
    var allowedCodes = {
      MISSING_SCORM_API: true,
      INITIALIZATION_FAILED: true,
      COMPLETION_WRITE_FAILED: true,
      COMMIT_FAILED: true,
      COMPLETION_NOT_COMMITTED: true,
      FORCED_IDLE_EXIT: true,
      MAXIMUM_TIME_REACHED: true,
      JAVASCRIPT_ERROR: true,
      MEDIA_ERROR: true,
      DEGRADED_SHIM: true,
      TELEMETRY_STORAGE_FAILED: true,
      TIMEGATE_PERSISTENCE_FAILED: true,
      TIMEGATE_CONFIGURATION_FAILED: true,
      LMS_FINALIZATION_FAILED: true,
      LMS_TERMINATION_FAILED: true,
      LMS_OPERATION_FAILED: true
    };
    if (!Array.isArray(values)) return;
    for (var i = 0; i < values.length && i < 30; i++) {
      var input = values[i];
      if (!input || typeof input !== 'object') continue;
      var code = issueKey(input.code);
      if (!allowedCodes[code]) continue;
      issueMap[code] = {
        code: code,
        severity: normalizedSeverity(input.severity, 'warning'),
        source: boundedString(input.source || 'host', 40),
        active: input.active !== false,
        firstSeenAt: boundedString(input.firstSeenAt, 40) || nowIso(),
        lastSeenAt: boundedString(input.lastSeenAt, 40) || nowIso(),
        occurrenceCount: Math.max(
          1,
          Math.min(1000000, finiteNumber(input.occurrenceCount) || 1)
        ),
        evidence: sanitizeEvidence(input.evidence)
      };
    }
  }

  function rehydrateDiagnosticTail(values) {
    var allowedTypes = {
      telemetry_started: true,
      scorm_call: true,
      rise_call: true,
      timegate_event: true,
      javascript_error: true,
      unhandled_rejection: true,
      resource_error: true,
      route_change: true,
      media_event: true,
      instrumentation_error: true,
      storage_failed: true,
      transport_failed: true,
      snapshot_queued: true
    };
    var allowedSources = {
      host: true,
      scorm: true,
      rise: true,
      timegate: true,
      content_probe: true,
      transport: true
    };
    if (!Array.isArray(values)) return;
    var start = Math.max(0, values.length - MAX_TAIL_EVENTS);
    for (var i = start; i < values.length; i++) {
      var input = values[i];
      if (!input || typeof input !== 'object') continue;
      var type = boundedString(input.type, 80);
      var source = boundedString(input.source, 40);
      if (!allowedTypes[type] || !allowedSources[source]) continue;
      var sequence = Math.min(
        MAX_SAFE_SEQUENCE - 1,
        Math.max(
          1,
          Math.floor(finiteNumber(input.sequence) || eventSequence + 1)
        )
      );
      eventSequence = Math.max(eventSequence, sequence);
      var parsedTimestamp = Date.parse(input.occurredAt);
      var timestamp = isFinite(parsedTimestamp) ? parsedTimestamp : Date.now();
      var event = {
        sequence: sequence,
        occurredAt: new Date(timestamp).toISOString(),
        type: type,
        source: source,
        severity: normalizedSeverity(input.severity, 'info'),
        milestone:
          input.severity === 'error' ||
          type === 'scorm_call' ||
          type === 'rise_call' ||
          type === 'timegate_event',
        data: safeEventData(input.data)
      };
      var serialized = safeJsonStringify(event);
      if (!serialized) continue;
      var serializedBytes = utf8Length(serialized);
      eventBuffer.push({
        timestamp: timestamp,
        bytes: serializedBytes,
        event: event
      });
      eventBufferBytes += serializedBytes;
    }
    eventBuffer.sort(function (left, right) {
      return left.event.sequence - right.event.sequence;
    });
    pruneEvents(Date.now());
  }

  function mergeQuarantinedPending(pending) {
    var currentState = {
      initialized: runtimeState.initialized,
      lessonStatus: runtimeState.lessonStatus,
      progressPercent: runtimeState.progressPercent,
      scoreRaw: runtimeState.scoreRaw,
      lastCommitResult: runtimeState.lastCommitResult,
      finishResult: runtimeState.finishResult,
      lastErrorCode: runtimeState.lastErrorCode,
      activeSeconds: timegateClock.activeSeconds,
      idleSeconds: timegateClock.idleSeconds
    };
    var currentIssues = issueMap;
    var currentEvents = eventBuffer.slice();
    var pendingState =
      pending.state && typeof pending.state === 'object' ?
        pending.state : {};

    session.id = boundedString(pending.session.id, 80);
    session.revision = finiteNumber(pending.session.revision) || 0;
    session.startedAt =
      boundedString(pending.session.startedAt, 40) || session.startedAt;

    var restoredLessonStatus =
      typeof pendingState.lessonStatus === 'string' ?
        normalizedScormStatus(pendingState.lessonStatus) : null;
    var restoredProgress = clampedNumber(
      pendingState.progressPercent,
      0,
      100
    );
    var restoredScore = clampedNumber(
      pendingState.scoreRaw,
      -1000000,
      1000000
    );
    var restoredCommit =
      typeof pendingState.lastCommitResult === 'boolean' ?
        pendingState.lastCommitResult : null;
    var restoredError =
      typeof pendingState.lastErrorCode === 'string' ?
        boundedString(pendingState.lastErrorCode, 32) : null;

    runtimeState.initialized =
      currentState.initialized || !!pendingState.initialized;
    /* The release gate guarantees this is the current LMS value. */
    runtimeState.lessonStatus = currentState.lessonStatus;
    runtimeState.progressPercent =
      currentState.progressPercent !== null ?
        currentState.progressPercent : restoredProgress;
    runtimeState.scoreRaw =
      currentState.scoreRaw !== null ? currentState.scoreRaw : restoredScore;
    var restoredCompletion = terminalCanonicalCompletionStatus(
      restoredLessonStatus
    );
    var liveCompletion = terminalCanonicalCompletionStatus(
      currentState.lessonStatus
    );
    runtimeState.lastCommitResult =
      currentState.lastCommitResult !== null ?
        currentState.lastCommitResult :
        restoredCompletion === liveCompletion ? restoredCommit : null;
    /* A prior document's terminal result cannot terminate this document. */
    runtimeState.finishResult = currentState.finishResult;
    runtimeState.lastErrorCode =
      currentState.lastErrorCode !== null ?
        currentState.lastErrorCode : restoredError;
    timegateClock.activeSeconds = Math.max(
      Math.max(0, finiteNumber(pendingState.activeSeconds) || 0),
      currentState.activeSeconds
    );
    timegateClock.idleSeconds = Math.max(
      Math.max(0, finiteNumber(pendingState.idleSeconds) || 0),
      currentState.idleSeconds
    );

    if (liveCompletion) {
      completionQueuedByTimegate = false;
      completionWritten = true;
      completionCommitted = true;
    } else if (!completionQueuedByTimegate) {
      completionWritten = false;
      completionCommitted = false;
    }

    issueMap = {};
    rehydrateIssues(pending.issues);
    var severityRank = { info: 0, warning: 1, error: 2, critical: 3 };
    for (var issueCode in currentIssues) {
      if (!Object.prototype.hasOwnProperty.call(currentIssues, issueCode)) {
        continue;
      }
      var currentIssue = currentIssues[issueCode];
      var restoredIssue = issueMap[issueCode];
      if (!restoredIssue) {
        issueMap[issueCode] = currentIssue;
        continue;
      }
      restoredIssue.occurrenceCount = Math.min(
        1000000,
        restoredIssue.occurrenceCount + currentIssue.occurrenceCount
      );
      restoredIssue.firstSeenAt =
        restoredIssue.firstSeenAt < currentIssue.firstSeenAt ?
          restoredIssue.firstSeenAt : currentIssue.firstSeenAt;
      restoredIssue.lastSeenAt =
        restoredIssue.lastSeenAt > currentIssue.lastSeenAt ?
          restoredIssue.lastSeenAt : currentIssue.lastSeenAt;
      restoredIssue.active = currentIssue.active;
      if (
        (severityRank[currentIssue.severity] || 0) >=
        (severityRank[restoredIssue.severity] || 0)
      ) {
        restoredIssue.severity = currentIssue.severity;
      }
      restoredIssue.source = currentIssue.source;
      restoredIssue.evidence = currentIssue.evidence;
    }
    if (liveCompletion) {
      resolveIssue('COMPLETION_WRITE_FAILED');
      resolveIssue('COMPLETION_NOT_COMMITTED');
    }

    eventBuffer = [];
    eventBufferBytes = 0;
    eventSequence = 0;
    rehydrateDiagnosticTail(pending.diagnosticTail);
    for (var i = 0; i < currentEvents.length; i++) {
      var currentEvent = currentEvents[i].event;
      recordEvent(
        currentEvent.type,
        currentEvent.source,
        currentEvent.severity,
        safeEventData(currentEvent.data),
        currentEvent.milestone
      );
    }
  }

  function clearPendingRestoreTimer() {
    if (pendingRestoreTimer !== null) {
      window.clearTimeout(pendingRestoreTimer);
      pendingRestoreTimer = null;
    }
  }

  function discardQuarantinedPending(candidate) {
    clearPendingRestoreTimer();
    clearPending(candidate.sessionId, candidate.revision);
    quarantinedPending = null;
    releaseQuarantinedSnapshots();
  }

  function releaseMatchedQuarantinedPending() {
    if (
      !quarantinedPending ||
      !quarantinedPending.learnerMatched ||
      !quarantinedPending.canonicalStatusObserved
    ) {
      return;
    }
    var candidate = quarantinedPending;
    clearPendingRestoreTimer();
    mergeQuarantinedPending(candidate.snapshot);
    try {
      if (window[GLOBAL_RUNTIME]) {
        window[GLOBAL_RUNTIME].sessionId = session.id;
      }
    } catch (ignored) {
      // The public status surface is diagnostic-only.
    }
    quarantinedPending = null;
    releaseQuarantinedSnapshots();
  }

  function observeQuarantinedCanonicalStatus() {
    if (!quarantinedPending) return;
    quarantinedPending.canonicalStatusObserved = true;
    releaseMatchedQuarantinedPending();
  }

  function resolveQuarantinedLearner(observedLearnerId, timedOut) {
    if (!quarantinedPending) return;
    var candidate = quarantinedPending;
    var matches = (
      !timedOut &&
      !!observedLearnerId &&
      observedLearnerId === candidate.learnerId
    );
    if (matches) {
      candidate.learnerMatched = true;
      releaseMatchedQuarantinedPending();
    } else {
      discardQuarantinedPending(candidate);
    }
  }

  function isConfirmedDocumentContinuation() {
    try {
      if (
        window.performance &&
        typeof window.performance.getEntriesByType === 'function'
      ) {
        var entries = window.performance.getEntriesByType('navigation');
        if (entries && entries.length) {
          return (
            entries[0].type === 'reload' ||
            entries[0].type === 'back_forward'
          );
        }
      }
      if (window.performance && window.performance.navigation) {
        return (
          window.performance.navigation.type === 1 ||
          window.performance.navigation.type === 2
        );
      }
    } catch (ignored) {
      // Unknown navigation provenance is treated as a fresh launch.
    }
    return false;
  }

  function restoreLatestPending() {
    var sessionStorage = getSessionStorage();
    if (!sessionStorage) return;
    var raw = null;
    try {
      raw = sessionStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return;
    }
    if (!raw) return;
    var pending = safeJsonParse(raw);
    if (
      !pending ||
      pending.schemaVersion !== PROTOCOL_VERSION ||
      !pending.source ||
      !pending.session ||
      !pending.course ||
      pending.source.keyId !== boundedString(config.source.keyId, 64) ||
      pending.course.paycomCourseId !== courseDescriptor.paycomCourseId ||
      pending.course.packageVersion !== courseDescriptor.packageVersion ||
      pending.course.riseCourseId !== courseDescriptor.riseCourseId ||
      pending.course.manifestIdentifier !== courseDescriptor.manifestIdentifier ||
      pending.course.structureHash !== courseDescriptor.structureHash
    ) {
      return;
    }
    var pendingRevision = finiteNumber(pending.session.revision);
    var pendingStartedAt = Date.parse(pending.session.startedAt);
    var pendingObservedAt = Date.parse(pending.session.observedAt);
    if (
      pendingRevision === null ||
      pendingRevision < 0 ||
      pendingRevision >= MAX_SAFE_SEQUENCE ||
      Math.floor(pendingRevision) !== pendingRevision ||
      !isFinite(pendingStartedAt) ||
      !isFinite(pendingObservedAt) ||
      pendingObservedAt < pendingStartedAt
    ) {
      return;
    }
    var pendingLifecycle = pending.session.lifecycle;
    if (pendingLifecycle !== 'active' && pendingLifecycle !== 'page_hidden') {
      return;
    }
    var pendingId = boundedString(pending.session.id, 80);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        pendingId
      )
    ) {
      return;
    }
    if (!isConfirmedDocumentContinuation()) {
      clearPending(pendingId, pendingRevision);
      return;
    }
    var pendingLearnerId =
      pending.learner &&
      typeof pending.learner.lmsLearnerId === 'string' ?
        boundedString(pending.learner.lmsLearnerId, 128) : '';
    if (!pendingLearnerId) {
      clearPending(pendingId, pendingRevision);
      return;
    }

    /*
     * A tab can be reused for another learner. Keep the stored snapshot inert
     * until LMS calls already being made by Rise/Timegate observe both the
     * current learner ID and the canonical completion status. No old session,
     * learner, terminal state, or diagnostics can reach transport before that
     * exact identity match and authoritative status read.
     */
    quarantinedPending = {
      snapshot: pending,
      sessionId: pendingId,
      revision: pendingRevision,
      learnerId: pendingLearnerId,
      learnerMatched: false,
      canonicalStatusObserved: false
    };
    pendingRestoreTimer = window.setTimeout(function () {
      observe('pending_restore_identity_timeout', function () {
        resolveQuarantinedLearner('', true);
      });
    }, RESTORE_IDENTITY_TIMEOUT_MS);
  }

  function installLifecycle() {
    window.addEventListener('pagehide', function () {
      /* Let later pagehide listeners publish final LMS results first. */
      window.Promise.resolve().then(function () {
        observe('pagehide_snapshot', function () {
          emitSnapshot('pagehide', 'page_hidden', true, false);
        });
      });
    }, false);
    window.addEventListener('pageshow', function () {
      if (session.lifecycle === 'page_hidden') {
        session.lifecycle = 'active';
      }
    }, false);
    window.setInterval(function () {
      observe('routine_snapshot', function () {
        scheduleSnapshot('routine', 'active', false, false);
      });
    }, ROUTINE_INTERVAL_MS);
  }

  restoreLatestPending();
  observe('install_scorm', installScormWrappers);
  observe('install_raw_api_learner', installRawApiLearnerWrappers);
  observe('install_rise', installRiseWrappers);
  observe('install_content_channel', installContentChannel);
  observe('install_timegate_events', installTimegateEvents);
  observe('install_lifecycle', installLifecycle);
  observe('startup_event', function () {
    recordEvent('telemetry_started', 'host', 'info', {
      operation: 'startup'
    }, true);
  });

  window[GLOBAL_RUNTIME] = {
    version: instrumentationVersion,
    sessionId: session.id,
    flush: function () {
      observe('manual_flush', function () {
        scheduleSnapshot('manual', session.lifecycle, true, false);
      });
    },
    status: function () {
      return {
        enabled: !disabled,
        sessionId: session.id,
        revision: session.revision,
        internalFailures: internalFailures,
        bufferedEvents: eventBuffer.length,
        bufferedBytes: eventBufferBytes,
        transportQueueDepth:
          (transportInFlight ? 1 : 0) + (latestQueuedTransport ? 1 : 0),
        transportRetainedBytes:
          (transportInFlight ? transportInFlight.bytes : 0) +
          (latestQueuedTransport ? latestQueuedTransport.bytes : 0)
      };
    }
  };

  scheduleSnapshot('launch', 'active', false, false);
})();
