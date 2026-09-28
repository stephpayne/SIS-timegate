/* Timegate — module wrapper and bootstrap. */
(function () {
  'use strict';

  var INSTANCE_KEY = 'timegate-v2';
  var LOADED_FLAG = '__timegateV2Loaded';
  var WRAPPED_FLAG = '__timegateV2Wrapped';
  var SUSPEND_DATA_KEY = '__timegate_v2';
  var bootstrapStorageMode = '';

  // The package can declare strict local-only storage on the script tag. This
  // is available before the asynchronous configuration request completes, so
  // the bootstrap gate can leave authored suspend_data entirely to the course.
  try {
    var bootstrapScript = document.currentScript;
    if (!bootstrapScript) {
      var bootstrapScripts = document.getElementsByTagName('script');
      bootstrapScript = bootstrapScripts[bootstrapScripts.length - 1];
    }
    if (bootstrapScript && bootstrapScript.getAttribute) {
      bootstrapStorageMode = String(
        bootstrapScript.getAttribute('data-timegate-storage-mode') || ''
      );
    }
  } catch (e) {
    bootstrapStorageMode = '';
  }

  if (window[LOADED_FLAG]) {
    return;
  }
  window[LOADED_FLAG] = true;

  var DEFAULT_CONFIG = {
    minRequiredMinutes: 0,
    maxAllowedMinutes: null,
    enforceCompletion: true,
    idleTimeoutSeconds: 120,
    backgroundGraceSeconds: 30,
    countWhileMediaPlaying: true,
    hideWhenComplete: false,
    position: 'bottom-right',
    debug: false,
    storageMode: 'dual',
    inactivityForceExitEnabled: true,
    inactivityForceExitMinutes: 5,
    inactivityWarningSeconds: 30,
    gentleNudgeEnabled: true,
    gentleNudgeSeconds: 60,
    launchModalEnabled: true,
    audioCuesEnabled: true,
    disableVideoSkip: true,
    seatTimeReportingEnabled: false,
    seatTimeRelayUrl: '',
    seatTimeRelayKey: '',
    courseId: ''
  };

  var STATE_VERSION = 1;
  var PERSIST_INTERVAL_MS = 5000;
  var LOCK_TTL_MS = 15000;
  var MAX_DELTA_MS = 5000;
  var MEDIA_SCAN_INTERVAL_MS = 2000;
  var OBSERVABILITY_METRICS_INTERVAL_MS = 5000;
  var COMPLETION_RETRY_INTERVAL_MS = 5000;
  var CONFIG_LOAD_TIMEOUT_MS = 10000;
  var AUDIO_PREFERENCE_KEY_PREFIX = 'timegate-v2.audio-enabled.v1.';
  var TIMEGATE_RUNTIME_VERSION = '1.4.0';
  var SUPPORT_SCHEMA_VERSION = 1;
  var SUPPORT_MAX_BYTES = 12 * 1024;
  var SUPPORT_MAX_MEMORY_EVENTS = 32;
  var SUPPORT_MAX_REPORT_EVENTS = 20;
  var SUPPORT_MAX_ISSUES = 10;

  var config = null;
  var state = null;
  var lastPersistTs = 0;
  var lastUiRender = '';
  var lastActivityTs = Date.now();
  var lastTickTs = Date.now();
  var backgroundSinceTs = null;
  var mediaPlaying = false;
  var iframeDoc = null;
  var isPrimaryTab = true;
  var storage = null;
  var apiAdapter = null;
  var apiInitialized = false;
  var apiTerminated = false;
  var bootstrapGate = null;
  var pendingInitHydrate = false;
  var replayingScorm = false;
  var lastCompletionReplayTs = 0;
  var lastCompletionFinalizationTs = 0;
  var tabId = String(Math.random()).slice(2);
  var lockKey = null;
  var driverAdapter = null;
  var timerStarted = false;
  var forceExitTriggered = false;
  var forcedTerminationReason = '';
  var lastTerminationAttemptTs = 0;
  var warningEl = null;
  var gentleNudgeEl = null;
  var walkBackEl = null;
  var launchModalEl = null;
  var launchModalPreviewEl = null;
  var launchModalHandoff = null;
  var launchModalKind = '';
  var launchModalKeydownHandler = null;
  var launchModalBackgroundState = [];
  var launchModalPreviousFocus = null;
  var inactivityNoticeHydratedHandler = null;
  var acknowledgedInactivityExitAt = '';
  var observedPauseReason = '';
  var observedPauseSinceTs = null;
  var observedIdleSeconds = 0;
  var lastMetricsEventTs = 0;
  var persistenceFailureActive = false;
  var minimumTimeEventSent = false;
  var maximumTimeEventSent = false;
  var maximumExitFinalized = false;
  var configurationBlocked = false;
  var seatTimeConfigValid = false;
  var seatTimeConfigError = '';
  var seatTimeSegment = null;
  var seatTimeProvisionalStart = null;
  var seatTimeCompletionTimestamp = null;
  var seatTimeIdentityVerified = false;
  var seatTimeLearnerName = '';
  var seatTimeTransportInFlight = null;
  var seatTimeRetryTimer = null;
  var seatTimeRetryNotBeforeTs = 0;
  var seatTimeConsecutiveFailures = 0;
  var seatTimeScopeDurable = false;
  var seatTimeIdentityRetryNotBeforeTs = 0;
  var seatTimeIdentityConsecutiveFailures = 0;
  var seatTimeDeliveryDisabled = false;
  var lastSeatTimeCheckpointTs = 0;
  var seatTimeTerminal = false;
  var audioCuesUserEnabled = false;
  var audioContext = null;
  var audioPlaybackReady = false;
  var audioPlaybackGeneration = 0;
  var pendingAudioCue = null;
  var pendingAudioCueTimer = null;
  var activeAudioSources = [];
  var completionAudioCueSent = false;
  var supportLaunchId = '';
  var supportLaunchStartedAt = new Date().toISOString();
  var supportEvents = [];
  var supportEventSequence = 0;
  var supportIssues = {};
  var supportUi = null;
  var supportPreviousFocus = null;
  var supportKeydownHandler = null;
  var supportCopyGeneration = 0;
  var supportBackgroundState = [];
  var supportLocalStorageAvailable = null;
  var supportSessionStorageAvailable = null;
  var supportRuntime = {
    apiState: 'not_checked',
    canonicalStatus: null,
    lastErrorCode: null,
    hydratedFrom: 'none',
    persistence: {
      lastAttemptAt: null,
      lastSuccessAt: null,
      lmsState: 'not_attempted',
      browserState: 'not_attempted',
      lmsFailureReason: null,
      lmsExistingChars: null,
      lmsAttemptedChars: null,
      lmsErrorCode: null
    },
    completion: {
      courseSignalObserved: false,
      signalSource: 'unknown',
      requestedStatus: null,
      firstRequestedAt: null,
      lastRequestedAt: null,
      deliveryState: 'not_requested',
      deliveryAttemptCount: 0,
      lastWriteResult: null,
      lastCommitResult: null,
      lastReadbackStatus: null,
      lmsApiAcknowledged: false,
      pendingDurableInLms: false,
      terminationDeferred: false,
      lastTerminationResult: null,
      finalizationSucceeded: false
    }
  };

  var RING_CAROUSEL_INTERVAL_MS = 2800;
  var RING_CAROUSEL_TRANSITION_MS = 150;
  var RING_CAROUSEL_PULSE_WINDOW_MS = 700;
  var SEAT_TIME_CONTRACT_VERSION = 1;
  var SEAT_TIME_OUTBOX_VERSION = 1;
  var SEAT_TIME_OUTBOX_KEY_PREFIX = '__timegate_seat_time_outbox_v1.';
  var SEAT_TIME_OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  var SEAT_TIME_OUTBOX_MAX_ENTRIES = 25;
  var SEAT_TIME_CHECKPOINT_INTERVAL_MS = 30000;
  var SEAT_TIME_RETRY_DELAY_MS = 5000;
  var SEAT_TIME_IDENTITY_RETRY_DELAY_MS = 2000;
  var AUDIO_CUE_PRIORITIES = {
    audio_enabled: 5,
    inactivity_nudge: 10,
    minimum_time_met: 20,
    completion_confirmed: 30,
    inactivity_warning: 40,
    session_ended: 50
  };
  var AUDIO_CUE_DEFINITIONS = {
    audio_enabled: [
      { frequency: 587.33, offset: 0, duration: 0.08, gain: 0.025, type: 'sine' },
      { frequency: 739.99, offset: 0.09, duration: 0.11, gain: 0.025, type: 'sine' }
    ],
    inactivity_nudge: [
      { frequency: 392.00, offset: 0, duration: 0.14, gain: 0.03, type: 'triangle' }
    ],
    minimum_time_met: [
      { frequency: 523.25, offset: 0, duration: 0.10, gain: 0.035, type: 'sine' },
      { frequency: 659.25, offset: 0.10, duration: 0.16, gain: 0.04, type: 'sine' }
    ],
    completion_confirmed: [
      { frequency: 523.25, offset: 0, duration: 0.12, gain: 0.04, type: 'sine' },
      { frequency: 783.99, offset: 0.12, duration: 0.20, gain: 0.045, type: 'sine' }
    ],
    inactivity_warning: [
      { frequency: 440.00, offset: 0, duration: 0.12, gain: 0.05, type: 'sine' },
      { frequency: 440.00, offset: 0.17, duration: 0.12, gain: 0.05, type: 'sine' }
    ],
    session_ended: [
      { frequency: 392.00, offset: 0, duration: 0.16, gain: 0.045, type: 'sine' },
      { frequency: 261.63, offset: 0.15, duration: 0.22, gain: 0.05, type: 'sine' }
    ]
  };

  /* Debug logger gated by config. */
  function log() {
    if (!config || !config.debug) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[timegate]');
    try {
      console.log.apply(console, args);
    } catch (e) {
      // ignore
    }
  }

  /*
   * Publish a narrow, privacy-safe event stream for optional observability.
   * Event construction and dispatch are fully guarded so a listener (or an
   * older browser without CustomEvent) can never affect Timegate behavior.
   */
  function emitTimegateEvent(type, detail) {
    try {
      var payload = {
        version: 1,
        type: String(type || ''),
        occurredAt: new Date().toISOString()
      };
      var key;
      if (detail && typeof detail === 'object') {
        for (key in detail) {
          if (Object.prototype.hasOwnProperty.call(detail, key)) {
            payload[key] = detail[key];
          }
        }
      }
      captureSupportEvent(payload);
      if (supportUi && state) updateLearnerSupportSurface();
      var event;
      if (typeof window.CustomEvent === 'function') {
        event = new window.CustomEvent('sis:timegate', { detail: payload });
      } else {
        event = document.createEvent('CustomEvent');
        event.initCustomEvent('sis:timegate', false, false, payload);
      }
      document.dispatchEvent(event);
      requestAudioCueForTimegateEvent(payload);
    } catch (e) {
      // Observability is strictly fail-open.
    }
  }

  function currentObservedIdleSeconds(timestamp) {
    var total = observedIdleSeconds;
    if (observedPauseReason && observedPauseSinceTs !== null) {
      total += Math.max(0, (timestamp - observedPauseSinceTs) / 1000);
    }
    return total;
  }

  /* Resolve storage mode from config with backward compatibility. */
  function resolveStorageMode() {
    var mode = config && typeof config.storageMode === 'string' ? config.storageMode : '';
    if (mode) return mode;
    return 'localStorage';
  }

  /* Parse JSON safely, returning null on failure. */
  function safeJsonParse(str) {
    try {
      return JSON.parse(str);
    } catch (e) {
      return null;
    }
  }

  /*
   * Strip // line comments and block comments, plus trailing commas, so the
   * config file can be annotated with section headers and edited forgivingly
   * by non-developers. String-aware so comment markers inside values survive.
   * Only used for timegate.config.json, never for stored SCORM state.
   */
  function stripJsonComments(text) {
    if (typeof text !== 'string') return text;
    var out = '';
    var inString = false, strChar = '', inLine = false, inBlock = false;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i), n = text.charAt(i + 1);
      if (inLine) {
        if (c === '\n') { inLine = false; out += c; }
        continue;
      }
      if (inBlock) {
        if (c === '*' && n === '/') { inBlock = false; i++; }
        continue;
      }
      if (inString) {
        out += c;
        if (c === '\\') { out += n; i++; continue; }
        if (c === strChar) inString = false;
        continue;
      }
      if (c === '"' || c === "'") { inString = true; strChar = c; out += c; continue; }
      if (c === '/' && n === '/') { inLine = true; i++; continue; }
      if (c === '/' && n === '*') { inBlock = true; i++; continue; }
      out += c;
    }
    return out.replace(/,(\s*[}\]])/g, '$1');
  }

  /* Stringify JSON safely, returning null on failure. */
  function safeJsonStringify(obj) {
    try {
      return JSON.stringify(obj);
    } catch (e) {
      return null;
    }
  }

  function supportBoundedString(value, maxLength) {
    if (value === null || typeof value === 'undefined') return null;
    return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maxLength);
  }

  function createSupportUuid() {
    try {
      var cryptoApi = window.crypto;
      if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
        return cryptoApi.randomUUID();
      }
      if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
        var bytes = new Uint8Array(16);
        cryptoApi.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        var hex = [];
        for (var i = 0; i < bytes.length; i++) {
          hex.push((bytes[i] + 256).toString(16).slice(1));
        }
        return hex.slice(0, 4).join('') + '-' +
          hex.slice(4, 6).join('') + '-' +
          hex.slice(6, 8).join('') + '-' +
          hex.slice(8, 10).join('') + '-' +
          hex.slice(10, 16).join('');
      }
    } catch (e) {
      // Fall through to a non-identity-derived compatibility value.
    }
    var seed = '';
    for (var j = 0; j < 32; j++) {
      seed += Math.floor(Math.random() * 16).toString(16);
    }
    return seed.slice(0, 8) + '-' + seed.slice(8, 12) + '-4' +
      seed.slice(13, 16) + '-a' + seed.slice(17, 20) + '-' + seed.slice(20, 32);
  }

  function validSupportUuid(value) {
    return typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  function supportCodeForAttempt(attemptId) {
    var alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    var compact = String(attemptId || '').replace(/[^0-9a-f]/gi, '');
    // Skip the fixed UUID version nibble so all encoded bits are random.
    var hex = compact.slice(0, 12) + compact.slice(13, 15);
    var bytes = [];
    for (var i = 0; i + 1 < hex.length; i += 2) {
      bytes.push(parseInt(hex.slice(i, i + 2), 16));
    }
    var output = '';
    var buffer = 0;
    var bits = 0;
    for (var j = 0; j < bytes.length && output.length < 10; j++) {
      buffer = (buffer << 8) | bytes[j];
      bits += 8;
      while (bits >= 5 && output.length < 10) {
        bits -= 5;
        output += alphabet.charAt((buffer >> bits) & 31);
        buffer &= (1 << bits) - 1;
      }
    }
    while (output.length < 10) output += '0';
    return 'TG-' + output.slice(0, 4) + '-' + output.slice(4, 8) + '-' +
      output.slice(8, 10);
  }

  function supportTimestamp(value) {
    if (typeof value !== 'string') return null;
    try {
      return new Date(value).toISOString() === value ? value : null;
    } catch (e) {
      return null;
    }
  }

  function supportInteger(value) {
    var number = Number(value);
    if (!isFinite(number) || number < 0) return 0;
    return Math.floor(number);
  }

  function supportLengthOrNull(value) {
    return value === null || value === undefined ?
      null : Math.min(1000000, supportInteger(value));
  }

  function supportBooleanOrNull(value) {
    return typeof value === 'boolean' ? value : null;
  }

  var SUPPORT_ISSUE_CODES = {
    LMS_API_MISSING: true,
    LMS_INITIALIZATION_FAILED: true,
    LEARNER_IDENTITY_UNVERIFIED: true,
    BROWSER_STORAGE_UNAVAILABLE: true,
    TIMEGATE_STATE_SAVE_FAILED: true,
    COURSE_COMPLETION_NOT_REQUESTED: true,
    COMPLETION_HELD_FOR_MINIMUM: true,
    COMPLETION_WRITE_FAILED: true,
    LMS_COMMIT_FAILED: true,
    COMPLETION_READBACK_UNCONFIRMED: true,
    COMPLETION_TERMINATION_DEFERRED: true,
    LMS_FINALIZATION_FAILED: true,
    LMS_TERMINATION_FAILED: true,
    SECONDARY_SESSION: true,
    CONFIGURATION_INVALID: true,
    MAXIMUM_TIME_REACHED: true,
    SESSION_ENDED_FOR_INACTIVITY: true,
    OBSERVABILITY_UNAVAILABLE: true,
    OBSERVABILITY_DELIVERY_FAILED: true,
    RELAY_DELIVERY_FAILED: true,
    SUPPORT_REPORT_GENERATION_DEGRADED: true
  };

  function markSupportIssue(code, severity, active, occurredAt) {
    if (!SUPPORT_ISSUE_CODES[code]) return;
    var timestamp = supportTimestamp(occurredAt) || new Date().toISOString();
    var existing = supportIssues[code];
    if (!existing) {
      existing = {
        code: code,
        severity: severity === 'warning' ? 'warning' : 'error',
        active: active !== false,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        occurrenceCount: 0
      };
      supportIssues[code] = existing;
    }
    existing.severity = severity === 'warning' ? 'warning' : 'error';
    existing.active = active !== false;
    existing.lastSeenAt = timestamp;
    existing.occurrenceCount += 1;
  }

  function clearSupportIssue(code, occurredAt) {
    if (!supportIssues[code]) return;
    supportIssues[code].active = false;
    supportIssues[code].lastSeenAt =
      supportTimestamp(occurredAt) || new Date().toISOString();
  }

  function recordSupportEvent(code, result, operation, errorCode, occurredAt) {
    var allowedResult = {
      observed: true,
      success: true,
      failed: true,
      queued: true,
      deferred: true,
      reset: true,
      warning: true
    };
    if (!/^[A-Z0-9_]{3,64}$/.test(String(code || ''))) return;
    supportEventSequence += 1;
    var event = {
      sequence: supportEventSequence,
      occurredAt: supportTimestamp(occurredAt) || new Date().toISOString(),
      code: String(code),
      result: allowedResult[result] ? result : 'observed'
    };
    var safeOperation = supportBoundedString(operation, 32);
    if (safeOperation && /^[a-z0-9_]+$/.test(safeOperation)) {
      event.operation = safeOperation;
    }
    var safeErrorCode = supportBoundedString(errorCode, 8);
    if (safeErrorCode && /^\d{1,8}$/.test(safeErrorCode)) {
      event.errorCode = safeErrorCode;
    }
    supportEvents.push(event);
    if (supportEvents.length > SUPPORT_MAX_MEMORY_EVENTS) supportEvents.shift();
  }

  function normalizeSupportRequestedStatus(value) {
    var normalized = String(value || '').toLowerCase().trim();
    if (normalized === 'completed' || normalized === 'passed' || normalized === 'failed') {
      return normalized;
    }
    if (normalized === 'setreachedend') return 'completed';
    if (normalized === 'setpassed') return 'passed';
    if (normalized === 'setfailed') return 'failed';
    return null;
  }

  function expectedDriverCompletionStatus(name, args) {
    // Rise completion helpers can also set SCORM 2004 success_status, but the
    // canonical course-completion readback is always completion_status.
    if (apiAdapter && apiAdapter.is2004) return 'completed';
    var namedStatus = normalizeSupportRequestedStatus(name);
    if (namedStatus) return namedStatus;
    if (name !== 'SetStatus' || !args || !args.length) return null;
    var directStatus = normalizeSupportRequestedStatus(args[0]);
    if (directStatus) return directStatus;
    if (typeof args[0] !== 'number') return null;
    var constants = [
      ['LESSON_STATUS_COMPLETED', 'completed'],
      ['LESSON_STATUS_PASSED', 'passed'],
      ['LESSON_STATUS_FAILED', 'failed']
    ];
    for (var i = 0; i < constants.length; i++) {
      if (
        typeof window[constants[i][0]] !== 'undefined' &&
        args[0] === window[constants[i][0]]
      ) return constants[i][1];
    }
    return null;
  }

  function supportReadbackMatchesRequest(readbackStatus, requestedStatus) {
    var actual = normalizeSupportCanonicalStatus(readbackStatus);
    var expected = normalizeSupportRequestedStatus(requestedStatus);
    if (!expected || !actual) return false;
    if (apiAdapter && apiAdapter.is2004) {
      return expected === 'completed' && actual === 'completed';
    }
    return actual === expected;
  }

  function observeSupportCompletionRequest(source, value, occurredAt) {
    var completion = supportRuntime.completion;
    var timestamp = supportTimestamp(occurredAt) || new Date().toISOString();
    completion.courseSignalObserved = true;
    completion.signalSource = source === 'rise_driver' ?
      'rise_driver' : source === 'lms_readback' ? 'lms_readback' : 'scorm_set_value';
    completion.requestedStatus = normalizeSupportRequestedStatus(value) ||
      completion.requestedStatus || 'completed';
    clearSupportIssue('COURSE_COMPLETION_NOT_REQUESTED', timestamp);
    if (!completion.firstRequestedAt) completion.firstRequestedAt = timestamp;
    completion.lastRequestedAt = timestamp;
    if (configurationBlocked) {
      completion.deliveryState = 'blocked_configuration';
    } else if (!isPrimaryTab && !apiTerminated) {
      completion.deliveryState = 'blocked_secondary_session';
    } else if (isMaximumTimeReached()) {
      completion.deliveryState = 'blocked_maximum';
    } else if (state && !state.minMetAt) {
      completion.deliveryState = 'held_for_minimum';
    } else if (completion.deliveryState !== 'confirmed') {
      completion.deliveryState = 'queued';
    }
    recordSupportEvent(
      'COURSE_COMPLETION_REQUESTED',
      completion.deliveryState === 'held_for_minimum' ? 'queued' : 'observed',
      completion.signalSource,
      null,
      timestamp
    );
  }

  function recordSupportCompletionAttempt(
    writeResult,
    commitResult,
    readbackStatus,
    requestedStatus
  ) {
    var completion = supportRuntime.completion;
    var expectedStatus = normalizeSupportRequestedStatus(requestedStatus) ||
      completion.requestedStatus;
    var readbackConfirmed = supportReadbackMatchesRequest(
      readbackStatus,
      expectedStatus
    );
    completion.deliveryAttemptCount += 1;
    completion.lastWriteResult = supportBooleanOrNull(writeResult);
    completion.lastCommitResult = supportBooleanOrNull(commitResult);
    completion.lastReadbackStatus = normalizeSupportCanonicalStatus(readbackStatus);
    completion.lmsApiAcknowledged = writeResult === true && commitResult === true;
    if (
      writeResult !== true ||
      commitResult !== true ||
      !readbackConfirmed
    ) {
      captureSupportScormError();
    } else {
      supportRuntime.lastErrorCode = null;
    }
    clearSupportIssue('COMPLETION_WRITE_FAILED');
    clearSupportIssue('LMS_COMMIT_FAILED');
    clearSupportIssue('COMPLETION_READBACK_UNCONFIRMED');
    clearSupportIssue('COMPLETION_HELD_FOR_MINIMUM');
    if (writeResult !== true) {
      completion.deliveryState = 'write_failed';
      markSupportIssue('COMPLETION_WRITE_FAILED', 'error', true);
      recordSupportEvent('LMS_COMPLETION_WRITE', 'failed', 'set_value');
      return;
    }
    recordSupportEvent('LMS_COMPLETION_WRITE', 'success', 'set_value');
    if (commitResult !== true) {
      completion.deliveryState = 'commit_failed';
      markSupportIssue('LMS_COMMIT_FAILED', 'error', true);
      recordSupportEvent('LMS_COMPLETION_COMMIT', 'failed', 'commit');
      return;
    }
    recordSupportEvent('LMS_COMPLETION_COMMIT', 'success', 'commit');
    if (!readbackConfirmed) {
      completion.deliveryState = 'readback_unconfirmed';
      markSupportIssue('COMPLETION_READBACK_UNCONFIRMED', 'error', true);
      recordSupportEvent('LMS_COMPLETION_READBACK', 'failed', 'get_value');
      return;
    }
    completion.deliveryState = 'confirmed';
    completion.pendingDurableInLms = false;
    recordSupportEvent('LMS_COMPLETION_READBACK', 'success', 'get_value');
  }

  function normalizeSupportCanonicalStatus(value) {
    var normalized = String(value || '').toLowerCase();
    var allowed = {
      completed: true,
      passed: true,
      failed: true,
      incomplete: true,
      'not attempted': true,
      browsed: true,
      unknown: true
    };
    return allowed[normalized] ? normalized : null;
  }

  function captureSupportEvent(payload) {
    if (!payload || !payload.type) return;
    var type = payload.type;
    if (type === 'minimum_time_met') {
      recordSupportEvent('MINIMUM_TIME_MET', 'success', 'timegate', null, payload.occurredAt);
    } else if (type === 'completion_gated') {
      if (payload.canonicalCompletion !== false) {
        observeSupportCompletionRequest(
          payload.signalSource || 'scorm_set_value',
          payload.completionStatus,
          payload.occurredAt
        );
        if (payload.reason === 'minimum_time_not_met') {
          markSupportIssue('COMPLETION_HELD_FOR_MINIMUM', 'warning', true, payload.occurredAt);
        }
      }
    } else if (type === 'completion_reset') {
      supportRuntime.completion.deliveryState = 'reset';
      supportRuntime.completion.lmsApiAcknowledged = false;
      supportRuntime.completion.pendingDurableInLms = false;
      supportRuntime.completion.finalizationSucceeded = false;
      supportRuntime.completion.lastReadbackStatus =
        normalizeSupportCanonicalStatus(payload.completionStatus);
      recordSupportEvent('COURSE_COMPLETION_RESET', 'reset', 'completion', null, payload.occurredAt);
    } else if (type === 'termination_deferred') {
      supportRuntime.completion.terminationDeferred = true;
      markSupportIssue('COMPLETION_TERMINATION_DEFERRED', 'warning', true, payload.occurredAt);
      recordSupportEvent('LMS_TERMINATION', 'deferred', 'terminate', null, payload.occurredAt);
    } else if (type === 'termination_completed') {
      supportRuntime.completion.terminationDeferred = false;
      supportRuntime.completion.lastTerminationResult = true;
      clearSupportIssue('COMPLETION_TERMINATION_DEFERRED', payload.occurredAt);
      clearSupportIssue('LMS_TERMINATION_FAILED', payload.occurredAt);
      recordSupportEvent('LMS_TERMINATION', 'success', 'terminate', null, payload.occurredAt);
    } else if (type === 'persistence_failed') {
      markSupportIssue('TIMEGATE_STATE_SAVE_FAILED', 'error', true, payload.occurredAt);
      recordSupportEvent('TIMEGATE_STATE_SAVE', 'failed', 'persistence', null, payload.occurredAt);
    } else if (type === 'persistence_recovered') {
      clearSupportIssue('TIMEGATE_STATE_SAVE_FAILED', payload.occurredAt);
      recordSupportEvent('TIMEGATE_STATE_SAVE', 'success', 'persistence', null, payload.occurredAt);
    } else if (type === 'configuration_failed') {
      markSupportIssue('CONFIGURATION_INVALID', 'error', true, payload.occurredAt);
      recordSupportEvent('TIMEGATE_CONFIGURATION', 'failed', 'configuration', null, payload.occurredAt);
    } else if (type === 'maximum_time_reached') {
      markSupportIssue('MAXIMUM_TIME_REACHED', 'error', true, payload.occurredAt);
      recordSupportEvent('MAXIMUM_TIME_REACHED', 'observed', 'timegate', null, payload.occurredAt);
    } else if (type === 'forced_exit' && payload.reason === 'inactivity') {
      markSupportIssue('SESSION_ENDED_FOR_INACTIVITY', 'error', true, payload.occurredAt);
      recordSupportEvent('SESSION_ENDED_FOR_INACTIVITY', 'observed', 'timegate', null, payload.occurredAt);
    } else if (type === 'lms_operation_failed') {
      var operation = String(payload.operation || '').toLowerCase();
      var issueCode = operation.indexOf('initialize') !== -1 ?
        'LMS_INITIALIZATION_FAILED' : operation.indexOf('terminate') !== -1 ||
        operation.indexOf('finish') !== -1 ? 'LMS_TERMINATION_FAILED' :
          'LMS_FINALIZATION_FAILED';
      markSupportIssue(issueCode, 'error', true, payload.occurredAt);
      recordSupportEvent(issueCode, 'failed', 'lms', payload.errorCode, payload.occurredAt);
      if (issueCode === 'LMS_INITIALIZATION_FAILED') {
        supportRuntime.apiState = 'initialization_failed';
      }
      if (issueCode === 'LMS_TERMINATION_FAILED') {
        supportRuntime.completion.lastTerminationResult = false;
      }
    }
  }

  function copySupportCompletionState(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    var allowedDelivery = {
      not_requested: true,
      held_for_minimum: true,
      queued: true,
      write_failed: true,
      commit_failed: true,
      readback_unconfirmed: true,
      confirmed: true,
      reset: true,
      blocked_configuration: true,
      blocked_maximum: true,
      blocked_secondary_session: true
    };
    var allowedSource = {
      scorm_set_value: true,
      rise_driver: true,
      lms_readback: true,
      unknown: true
    };
    return {
      courseSignalObserved: source.courseSignalObserved === true,
      signalSource: allowedSource[source.signalSource] ? source.signalSource : 'unknown',
      requestedStatus: normalizeSupportRequestedStatus(source.requestedStatus),
      firstRequestedAt: supportTimestamp(source.firstRequestedAt),
      lastRequestedAt: supportTimestamp(source.lastRequestedAt),
      deliveryState: allowedDelivery[source.deliveryState] ?
        source.deliveryState : 'not_requested',
      deliveryAttemptCount: supportInteger(source.deliveryAttemptCount),
      lastWriteResult: supportBooleanOrNull(source.lastWriteResult),
      lastCommitResult: supportBooleanOrNull(source.lastCommitResult),
      lastReadbackStatus: normalizeSupportCanonicalStatus(source.lastReadbackStatus),
      lmsApiAcknowledged: source.lmsApiAcknowledged === true,
      pendingDurableInLms: source.pendingDurableInLms === true,
      terminationDeferred: source.terminationDeferred === true,
      lastTerminationResult: supportBooleanOrNull(source.lastTerminationResult),
      finalizationSucceeded: source.finalizationSucceeded === true
    };
  }

  function applyHydratedSupportCompletion(source) {
    var hydrated = copySupportCompletionState(source);
    if (!hydrated) return;
    hydrated.finalizationSucceeded = false;
    hydrated.lastTerminationResult = null;
    supportRuntime.completion = hydrated;
  }

  function currentSupportSummary() {
    var completion = supportRuntime.completion;
    var summary = {
      state: 'time_in_progress',
      completionSafeToClose: false,
      reasonCode: null
    };
    if (configurationBlocked) {
      summary.state = 'configuration_error';
      summary.reasonCode = 'CONFIGURATION_INVALID';
    } else if (isMaximumTimeReached()) {
      summary.state = 'maximum_reached';
      summary.reasonCode = 'MAXIMUM_TIME_REACHED';
    } else if (forceExitTriggered && forcedTerminationReason === 'inactivity') {
      summary.state = 'inactivity_exit';
      summary.reasonCode = 'SESSION_ENDED_FOR_INACTIVITY';
    } else if (!isPrimaryTab && !apiTerminated) {
      summary.state = 'secondary_session';
      summary.reasonCode = 'SECONDARY_SESSION';
    } else if (!apiAdapter || supportRuntime.apiState === 'initialization_failed') {
      summary.state = 'lms_unavailable';
      summary.reasonCode = !apiAdapter ? 'LMS_API_MISSING' : 'LMS_INITIALIZATION_FAILED';
    } else if (completion.courseSignalObserved) {
      if (completion.deliveryState === 'reset') {
        summary.state = state && state.minMetAt ?
          'minimum_met_course_not_finished' : 'time_in_progress';
      } else if (!state || !state.minMetAt || completion.deliveryState === 'held_for_minimum') {
        summary.state = 'completion_held_for_time';
        summary.reasonCode = 'COMPLETION_HELD_FOR_MINIMUM';
      } else if (completion.deliveryState === 'confirmed') {
        if (state && state.courseCompletePending) {
          summary.state = 'completion_saved_finalizing';
        } else if (
          supportIssues.LMS_FINALIZATION_FAILED &&
          supportIssues.LMS_FINALIZATION_FAILED.active
        ) {
          summary.state = 'completion_retrying';
          summary.reasonCode = 'LMS_FINALIZATION_FAILED';
        } else if (completion.lastTerminationResult === false) {
          summary.state = 'completion_retrying';
          summary.reasonCode = 'LMS_TERMINATION_FAILED';
        } else if (
          completion.finalizationSucceeded &&
          !completion.terminationDeferred &&
          completion.lastTerminationResult !== false
        ) {
          summary.state = 'completion_confirmed';
          summary.completionSafeToClose = true;
        } else {
          summary.state = 'completion_saved_finalizing';
          summary.reasonCode = completion.terminationDeferred ?
            'COMPLETION_TERMINATION_DEFERRED' : null;
        }
      } else if (completion.deliveryState === 'write_failed') {
        summary.state = 'completion_retrying';
        summary.reasonCode = 'COMPLETION_WRITE_FAILED';
      } else if (completion.deliveryState === 'commit_failed') {
        summary.state = 'completion_retrying';
        summary.reasonCode = 'LMS_COMMIT_FAILED';
      } else if (completion.deliveryState === 'readback_unconfirmed') {
        summary.state = 'completion_retrying';
        summary.reasonCode = 'COMPLETION_READBACK_UNCONFIRMED';
      } else {
        summary.state = 'completion_saving';
      }
    } else if (state && state.minMetAt) {
      summary.state = 'minimum_met_course_not_finished';
      summary.reasonCode = 'COURSE_COMPLETION_NOT_REQUESTED';
    }
    return summary;
  }

  var SUPPORT_STATUS_COPY = {
    configuration_error: 'Course reporting is unavailable. Keep this course open and contact training@sis.us.',
    maximum_reached: 'The maximum course time was reached. Contact training@sis.us for help.',
    inactivity_exit: 'This session ended after an extended period of inactivity. Relaunch it from the LMS to resume.',
    secondary_session: 'Another tab is tracking this course. Continue in the original tab.',
    lms_unavailable: 'The course is not connected to the LMS. Keep it open and contact training@sis.us.',
    completion_saved_finalizing: 'Your completion was accepted. Keep this course open while the session finishes saving.',
    completion_confirmed: 'Completion confirmed. You may close the course.',
    completion_retrying: "We're still saving your completion. Keep this course open while we retry. If this message remains, send the support report to training@sis.us.",
    completion_saving: 'Saving your completion. Keep this course open.',
    completion_held_for_time: 'Course finished. Keep this course open until the time requirement is met.',
    minimum_met_course_not_finished: 'Minimum time met. Finish any remaining course activities.',
    time_in_progress: 'Time requirement in progress.'
  };

  function mergeSupportIssueProjection(byCode, issue) {
    if (!issue || !SUPPORT_ISSUE_CODES[issue.code]) return;
    var normalized = {
      code: issue.code,
      severity: issue.severity === 'error' ? 'error' : 'warning',
      active: issue.active !== false,
      firstSeenAt: supportTimestamp(issue.firstSeenAt),
      lastSeenAt: supportTimestamp(issue.lastSeenAt),
      occurrenceCount: Math.max(1, supportInteger(issue.occurrenceCount))
    };
    var existing = byCode[normalized.code];
    if (!existing) {
      byCode[normalized.code] = normalized;
      return;
    }
    if (normalized.severity === 'error') existing.severity = 'error';
    existing.active = existing.active || normalized.active;
    if (
      normalized.firstSeenAt &&
      (!existing.firstSeenAt || normalized.firstSeenAt < existing.firstSeenAt)
    ) existing.firstSeenAt = normalized.firstSeenAt;
    if (
      normalized.lastSeenAt &&
      (!existing.lastSeenAt || normalized.lastSeenAt > existing.lastSeenAt)
    ) existing.lastSeenAt = normalized.lastSeenAt;
    existing.occurrenceCount = Math.max(
      existing.occurrenceCount,
      normalized.occurrenceCount
    );
  }

  function buildSupportIssues(summary, enrichment, generatedAt) {
    var byCode = {};
    var code;
    for (code in supportIssues) {
      if (Object.prototype.hasOwnProperty.call(supportIssues, code)) {
        mergeSupportIssueProjection(byCode, supportIssues[code]);
      }
    }
    var derived = summary && summary.reasonCode;
    if (derived && SUPPORT_ISSUE_CODES[derived]) {
      var derivedAt = supportRuntime.completion.firstRequestedAt ||
        state && state.minMetAt || supportLaunchStartedAt;
      mergeSupportIssueProjection(byCode, {
        code: derived,
        severity:
          derived === 'COURSE_COMPLETION_NOT_REQUESTED' ||
          derived === 'COMPLETION_HELD_FOR_MINIMUM' ||
          derived === 'COMPLETION_TERMINATION_DEFERRED' ? 'warning' : 'error',
        active: true,
        firstSeenAt: derivedAt,
        lastSeenAt: derivedAt,
        occurrenceCount: 1
      });
    }
    if (supportLocalStorageAvailable === false) {
      mergeSupportIssueProjection(byCode, {
        code: 'BROWSER_STORAGE_UNAVAILABLE',
        severity: 'warning',
        active: true,
        firstSeenAt: supportLaunchStartedAt,
        lastSeenAt: generatedAt,
        occurrenceCount: 1
      });
    }
    if (apiInitialized && state && state.learnerKey === 'unresolved') {
      mergeSupportIssueProjection(byCode, {
        code: 'LEARNER_IDENTITY_UNVERIFIED',
        severity: 'warning',
        active: true,
        firstSeenAt: supportLaunchStartedAt,
        lastSeenAt: generatedAt,
        occurrenceCount: 1
      });
    }
    if (enrichment && enrichment.issues) {
      for (var i = 0; i < enrichment.issues.length; i++) {
        mergeSupportIssueProjection(byCode, enrichment.issues[i]);
      }
    }
    if (enrichment && enrichment.delivery && enrichment.delivery.enabled) {
      var deliveryState = enrichment.delivery.state;
      if (deliveryState === 'failed') {
        mergeSupportIssueProjection(byCode, {
          code: 'OBSERVABILITY_DELIVERY_FAILED',
          severity: 'warning',
          active: true,
          firstSeenAt: generatedAt,
          lastSeenAt: generatedAt,
          occurrenceCount: 1
        });
      } else if (
        deliveryState === 'pending' ||
        deliveryState === 'unconfirmed' ||
        deliveryState === 'unavailable' ||
        deliveryState === 'not_attempted'
      ) {
        mergeSupportIssueProjection(byCode, {
          code: 'OBSERVABILITY_UNAVAILABLE',
          severity: 'warning',
          active: true,
          firstSeenAt: generatedAt,
          lastSeenAt: generatedAt,
          occurrenceCount: 1
        });
      }
    }
    var values = [];
    for (code in byCode) {
      if (Object.prototype.hasOwnProperty.call(byCode, code)) {
        values.push(byCode[code]);
      }
    }
    values.sort(function (left, right) {
      if (left.active !== right.active) return left.active ? -1 : 1;
      if (left.severity !== right.severity) return left.severity === 'error' ? -1 : 1;
      return String(right.lastSeenAt).localeCompare(String(left.lastSeenAt));
    });
    return values.slice(0, SUPPORT_MAX_ISSUES).map(function (issue) {
      return {
        code: issue.code,
        severity: issue.severity,
        active: !!issue.active,
        firstSeenAt: issue.firstSeenAt,
        lastSeenAt: issue.lastSeenAt,
        occurrenceCount: supportInteger(issue.occurrenceCount)
      };
    });
  }

  function detectSupportEnvironment() {
    var ua = '';
    try { ua = String(window.navigator.userAgent || ''); } catch (e) { ua = ''; }
    var browserFamily = 'Unknown';
    var browserEngine = 'Unknown';
    var browserMajor = null;
    var match;
    if ((match = ua.match(/EdgiOS\/(\d+)/))) {
      browserFamily = 'Edge'; browserEngine = 'WebKit'; browserMajor = Number(match[1]);
    } else if ((match = ua.match(/Edg\/(\d+)/))) {
      browserFamily = 'Edge'; browserEngine = 'Chromium'; browserMajor = Number(match[1]);
    } else if ((match = ua.match(/CriOS\/(\d+)/))) {
      browserFamily = 'Chrome'; browserEngine = 'WebKit'; browserMajor = Number(match[1]);
    } else if ((match = ua.match(/Chrome\/(\d+)/))) {
      browserFamily = 'Chrome'; browserEngine = 'Chromium'; browserMajor = Number(match[1]);
    } else if ((match = ua.match(/FxiOS\/(\d+)/))) {
      browserFamily = 'Firefox'; browserEngine = 'WebKit'; browserMajor = Number(match[1]);
    } else if ((match = ua.match(/Firefox\/(\d+)/))) {
      browserFamily = 'Firefox'; browserEngine = 'Gecko'; browserMajor = Number(match[1]);
    } else if ((match = ua.match(/Version\/(\d+).*Safari/))) {
      browserFamily = 'Safari'; browserEngine = 'WebKit'; browserMajor = Number(match[1]);
    }
    var iPadLike = /iPad|Tablet/i.test(ua) ||
      (/Android/i.test(ua) && !/Mobi/i.test(ua)) || !!(
      /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1
    );
    var osFamily = 'Unknown';
    if (/Android/i.test(ua)) osFamily = 'Android';
    else if (/iPhone|iPod/i.test(ua) || iPadLike) osFamily = 'iOS';
    else if (/Windows/i.test(ua)) osFamily = 'Windows';
    else if (/Mac OS X|Macintosh/i.test(ua)) osFamily = 'macOS';
    else if (/Linux/i.test(ua)) osFamily = 'Linux';
    var deviceClass = iPadLike ? 'tablet' :
      /Mobi|Android|iPhone|iPod/i.test(ua) ? 'mobile' : 'desktop';
    return {
      browserFamily: browserFamily,
      browserMajor: isFinite(browserMajor) ? browserMajor : null,
      browserEngine: browserEngine,
      osFamily: osFamily,
      deviceClass: deviceClass,
      online: typeof navigator.onLine === 'boolean' ? navigator.onLine : null,
      visibility: document.hidden ? 'hidden' : 'visible',
      capabilities: {
        localStorage: supportLocalStorageAvailable === true,
        sessionStorage: supportSessionStorageAvailable === true,
        clipboardWrite: !!(
          navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
        ),
        pageVisibility: typeof document.hidden === 'boolean',
        pagehide: 'onpagehide' in window,
        fetch: typeof window.fetch === 'function',
        sendBeacon: typeof navigator.sendBeacon === 'function'
      }
    };
  }

  function utf8Bytes(value) {
    var textValue = String(value || '');
    if (typeof window.TextEncoder === 'function') {
      return new window.TextEncoder().encode(textValue);
    }
    var encoded;
    try { encoded = unescape(encodeURIComponent(textValue)); }
    catch (e) { encoded = textValue; }
    var bytes = new Uint8Array(encoded.length);
    for (var i = 0; i < encoded.length; i++) bytes[i] = encoded.charCodeAt(i) & 255;
    return bytes;
  }

  function sha256Text(value) {
    try {
      if (!window.crypto || !window.crypto.subtle ||
          typeof window.crypto.subtle.digest !== 'function') {
        return Promise.resolve(null);
      }
      return window.crypto.subtle.digest('SHA-256', utf8Bytes(value)).then(
        function (buffer) {
          var bytes = new Uint8Array(buffer);
          var hex = '';
          for (var i = 0; i < bytes.length; i++) {
            hex += (bytes[i] + 256).toString(16).slice(1);
          }
          return 'sha256:' + hex;
        },
        function () { return null; }
      );
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function supportArtifactText(payload, integrity) {
    var summary = payload.summary;
    var headerStatus = summary.completionSafeToClose ?
      'Completion confirmed' : 'Completion has not been confirmed';
    var root = {
      schema: 'sis.timegate.support-report',
      schemaVersion: SUPPORT_SCHEMA_VERSION,
      privacyProfile: 'learner-support-minimized-v1',
      payload: payload,
      integrity: integrity
    };
    return 'TIMEGATE SUPPORT REPORT v1\n' +
      'Support code: ' + payload.report.supportCode + '\n' +
      'Status: ' + headerStatus + '\n' +
      'Generated: ' + payload.report.generatedAt + '\n' +
      'Diagnostic only; this is not proof of course completion.\n' +
      '-----BEGIN TIMEGATE SUPPORT DATA-----\n' +
      safeJsonStringify(root) + '\n' +
      '-----END TIMEGATE SUPPORT DATA-----';
  }

  function supportApiState() {
    if (apiTerminated) return 'terminated';
    if (supportRuntime.apiState === 'initialization_failed') return 'initialization_failed';
    if (!apiAdapter) return 'missing';
    return apiInitialized ? 'initialized' : 'found';
  }

  function supportRelayState() {
    if (!seatTimeConfigValid || !config || !config.seatTimeReportingEnabled) return 'disabled';
    if (seatTimeDeliveryDisabled || seatTimeConsecutiveFailures > 0) return 'failed';
    if (seatTimeTransportInFlight) return 'pending';
    return seatTimeTerminal ? 'complete' : 'idle';
  }

  function supportObservabilityDeliveryState(value) {
    var allowed = {
      disabled: true,
      not_attempted: true,
      pending: true,
      succeeded: true,
      failed: true,
      unconfirmed: true,
      unavailable: true
    };
    return allowed[value] ? value : 'unconfirmed';
  }

  function readPublicObservabilityIssues(snapshot) {
    var source = snapshot && Array.isArray(snapshot.issues) ? snapshot.issues : [];
    var issues = [];
    for (var i = 0; i < source.length && issues.length < SUPPORT_MAX_ISSUES; i++) {
      var issue = source[i];
      var code = issue && supportBoundedString(issue.code, 64);
      if (!code || !SUPPORT_ISSUE_CODES[code]) continue;
      issues.push({
        code: code,
        severity: issue.severity === 'error' ? 'error' : 'warning',
        active: issue.active === true,
        firstSeenAt: supportTimestamp(issue.firstSeenAt),
        lastSeenAt: supportTimestamp(issue.lastSeenAt),
        occurrenceCount: supportInteger(issue.occurrenceCount)
      });
    }
    return issues;
  }

  var SUPPORT_OBSERVABILITY_EVENT_CODES = {
    LMS_INITIALIZE: true,
    COURSE_COMPLETION_REQUESTED: true,
    COURSE_COMPLETION_WRITE: true,
    LMS_COMPLETION_READBACK: true,
    LMS_COMMIT: true,
    COMPLETION_HELD_FOR_MINIMUM: true,
    MINIMUM_TIME_MET: true,
    COMPLETION_REPLAYED: true,
    COMPLETION_TERMINATION_DEFERRED: true,
    LMS_TERMINATION: true,
    SESSION_ENDED_FOR_INACTIVITY: true,
    MAXIMUM_TIME_REACHED: true,
    OBSERVABILITY_DELIVERY_FAILED: true
  };

  function readPublicObservabilityEvents(snapshot) {
    var source = snapshot && Array.isArray(snapshot.diagnosticTail) ?
      snapshot.diagnosticTail : [];
    var events = [];
    for (
      var i = 0;
      i < source.length && events.length < SUPPORT_MAX_REPORT_EVENTS;
      i++
    ) {
      var entry = source[i];
      var code = entry && supportBoundedString(entry.code, 64);
      var occurredAt = entry && supportTimestamp(entry.occurredAt);
      if (!code || !SUPPORT_OBSERVABILITY_EVENT_CODES[code] || !occurredAt) continue;
      var result = entry.result === 'failure' ? 'failed' :
        entry.result === 'pending' ? 'queued' : entry.result;
      var allowedResult = {
        observed: true,
        success: true,
        failed: true,
        queued: true,
        deferred: true,
        reset: true,
        warning: true
      };
      if (!allowedResult[result]) result = 'observed';
      var event = {
        occurredAt: occurredAt,
        code: code,
        result: result
      };
      var operation = supportBoundedString(entry.operation, 32);
      if (operation && /^[a-z0-9_]+$/.test(operation)) {
        event.operation = operation;
      }
      var errorCode = supportBoundedString(entry.errorCode, 8);
      if (errorCode && /^\d{1,8}$/.test(errorCode)) {
        event.errorCode = errorCode;
      }
      events.push(event);
    }
    return events;
  }

  function readPublicSupportEnrichment() {
    try {
      var runtime = window.__SIS_OBSERVABILITY__;
      if (!runtime || typeof runtime.publicSupportSnapshot !== 'function') return null;
      var snapshot = runtime.publicSupportSnapshot();
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
      var session = snapshot.session;
      var id = session && supportBoundedString(session.id, 64);
      if (!validSupportUuid(id)) return null;
      var delivery = snapshot.delivery && typeof snapshot.delivery === 'object' ?
        snapshot.delivery : {};
      var publicCourse = snapshot.course && typeof snapshot.course === 'object' ?
        snapshot.course : {};
      var structureHash = supportBoundedString(publicCourse.structureHash, 128);
      if (structureHash && !/^(?:sha256:)?[0-9a-f]{64}$/i.test(structureHash)) {
        structureHash = null;
      }
      return {
        sessionId: id,
        revision: Math.min(2147483647, supportInteger(session.revision)),
        delivery: {
          enabled: delivery.enabled === true,
          state: supportObservabilityDeliveryState(delivery.state)
        },
        course: {
          title: supportBoundedString(publicCourse.title, 256),
          paycomCourseId: supportBoundedString(publicCourse.paycomCourseId, 128),
          packageVersion: supportBoundedString(publicCourse.packageVersion, 128),
          structureHash: structureHash
        },
        issues: readPublicObservabilityIssues(snapshot),
        events: readPublicObservabilityEvents(snapshot)
      };
    } catch (e) {
      markSupportIssue('SUPPORT_REPORT_GENERATION_DEGRADED', 'warning', true);
      return null;
    }
  }

  function buildSupportCourseTitle(enrichment) {
    try {
      if (typeof window.getCourseTitle === 'function') {
        return supportBoundedString(window.getCourseTitle(), 256);
      }
    } catch (e) {
      // Use the installer-provided public descriptor when available.
    }
    return enrichment && enrichment.course ? enrichment.course.title : null;
  }

  function buildSupportTimeline(enrichment) {
    var candidates = [];
    var seen = {};
    var add = function (event) {
      if (!event || !event.occurredAt || !event.code || !event.result) return;
      var key = [
        event.occurredAt,
        event.code,
        event.result,
        event.operation || '',
        event.errorCode || ''
      ].join('|');
      if (seen[key]) return;
      seen[key] = true;
      candidates.push({
        occurredAt: event.occurredAt,
        code: event.code,
        result: event.result,
        operation: event.operation || null,
        errorCode: event.errorCode || null,
        order: candidates.length
      });
    };
    for (var i = 0; i < supportEvents.length; i++) add(supportEvents[i]);
    var publicEvents = enrichment && enrichment.events ? enrichment.events : [];
    for (var j = 0; j < publicEvents.length; j++) add(publicEvents[j]);
    candidates.sort(function (left, right) {
      if (left.occurredAt !== right.occurredAt) {
        return left.occurredAt < right.occurredAt ? -1 : 1;
      }
      return left.order - right.order;
    });
    var shiftedEventCount = Math.max(0, supportEventSequence - supportEvents.length);
    var omittedEventCount = shiftedEventCount +
      Math.max(0, candidates.length - SUPPORT_MAX_REPORT_EVENTS);
    var retained = candidates.slice(-SUPPORT_MAX_REPORT_EVENTS);
    return {
      omittedEventCount: omittedEventCount,
      events: retained.map(function (event, index) {
        var copy = {
          sequence: index + 1,
          occurredAt: event.occurredAt,
          code: event.code,
          result: event.result
        };
        if (event.operation) copy.operation = event.operation;
        if (event.errorCode) copy.errorCode = event.errorCode;
        return copy;
      })
    };
  }

  function buildSupportPayload(reportId, generatedAt, courseFingerprint, enrichment) {
    var summary = currentSupportSummary();
    var completion = supportRuntime.completion;
    var timeline = buildSupportTimeline(enrichment);
    var entryMode = state && state.entryMode === 'resume' ? 'resume' :
      state && state.entryMode ? 'fresh' : 'unknown';
    var resumeSource = entryMode !== 'resume' ? 'none' :
      supportRuntime.hydratedFrom === 'suspend_data' ? 'lms_suspend_data' :
        supportRuntime.hydratedFrom === 'localStorage' ? 'local_backup' : 'none';
    var attempt = {
      attemptId: state.supportAttemptId,
      launchId: supportLaunchId,
      entryMode: entryMode,
      resumeSource: resumeSource,
      lifecycle: apiTerminated ? 'terminated' : forceExitTriggered ? 'ended' : 'active',
      launchStartedAt: supportLaunchStartedAt,
      tabRole: supportLocalStorageAvailable === false ?
        'uncoordinated' : isPrimaryTab || apiTerminated ? 'primary' : 'secondary',
      coordinationScope: 'same_browser_only',
      priorDeviceDiagnostics:
        enrichment && enrichment.delivery.state === 'succeeded' ?
          'available_via_observability' : 'unavailable',
      observabilitySessionId:
        enrichment && enrichment.delivery.enabled ? enrichment.sessionId : null
    };
    return {
      report: {
        reportId: reportId,
        supportCode: supportCodeForAttempt(state.supportAttemptId),
        generatedAt: generatedAt,
        truncated: false,
        omittedEventCount: timeline.omittedEventCount
      },
      summary: summary,
      course: {
        title: buildSupportCourseTitle(enrichment),
        courseId: config && supportBoundedString(config.courseId, 256) ||
          enrichment && enrichment.course.paycomCourseId || null,
        courseKeyFingerprint: courseFingerprint,
        scormVersion: apiAdapter ? (apiAdapter.is2004 ? '2004' : '1.2') : null,
        timegateVersion: TIMEGATE_RUNTIME_VERSION,
        packageVersion: enrichment ? enrichment.course.packageVersion : null,
        structureHash: enrichment ? enrichment.course.structureHash : null
      },
      attempt: attempt,
      timing: {
        cumulativeActiveSeconds: supportInteger(state.elapsedSeconds),
        launchActiveSeconds: supportInteger(state.sessionSeconds),
        launchIdleSeconds: supportInteger(currentObservedIdleSeconds(Date.now())),
        minimumRequiredSeconds: supportInteger(state.minRequiredSeconds),
        minimumMet: !!state.minMetAt,
        minimumMetAt: supportTimestamp(state.minMetAt),
        maximumAllowedSeconds: state.maxAllowedSeconds === null ?
          null : supportInteger(state.maxAllowedSeconds),
        maximumReached: isMaximumTimeReached(),
        pauseReason: observedPauseReason || null
      },
      completion: {
        courseSignalObserved: completion.courseSignalObserved === true,
        signalSource: completion.signalSource,
        requestedStatus: completion.requestedStatus,
        firstRequestedAt: completion.firstRequestedAt,
        lastRequestedAt: completion.lastRequestedAt,
        deliveryState: completion.deliveryState,
        deliveryAttemptCount: supportInteger(completion.deliveryAttemptCount),
        lastWriteResult: completion.lastWriteResult,
        lastCommitResult: completion.lastCommitResult,
        lastReadbackStatus: completion.lastReadbackStatus,
        lmsApiAcknowledged: completion.lmsApiAcknowledged === true,
        serverRecordVerified: 'not_available_in_course',
        pending: !!(
          state.courseCompletePending ||
          completion.deliveryState === 'held_for_minimum' ||
          completion.deliveryState === 'queued' ||
          completion.deliveryState === 'write_failed' ||
          completion.deliveryState === 'commit_failed' ||
          completion.deliveryState === 'readback_unconfirmed'
        ),
        pendingDurableInLms: completion.pendingDurableInLms === true,
        terminationDeferred: completion.terminationDeferred === true,
        lastTerminationResult: completion.lastTerminationResult
      },
      lms: {
        apiState: supportApiState(),
        learnerVerified: !!(
          state.learnerKey && state.learnerKey !== 'unresolved'
        ),
        canonicalStatus: supportRuntime.canonicalStatus,
        lastErrorCode: supportRuntime.lastErrorCode
      },
      persistence: {
        mode: resolveStorageMode(),
        revision: supportInteger(state.persistenceRevision),
        lastAttemptAt: supportRuntime.persistence.lastAttemptAt,
        lastSuccessAt: supportRuntime.persistence.lastSuccessAt,
        lmsState: supportRuntime.persistence.lmsState,
        browserState: supportRuntime.persistence.browserState,
        hydratedFrom: supportRuntime.hydratedFrom,
        lmsFailureReason: supportRuntime.persistence.lmsFailureReason,
        lmsExistingChars:
          supportLengthOrNull(supportRuntime.persistence.lmsExistingChars),
        lmsAttemptedChars:
          supportLengthOrNull(supportRuntime.persistence.lmsAttemptedChars),
        lmsErrorCode: supportRuntime.persistence.lmsErrorCode
      },
      relay: {
        enabled: !!(seatTimeConfigValid && config && config.seatTimeReportingEnabled),
        deliveryState: supportRelayState(),
        relayAttemptId: seatTimeSegment &&
          validSeatTimeOpaqueId(seatTimeSegment.attemptId, 'attempt') ?
            seatTimeSegment.attemptId : null
      },
      observability: {
        enabled: !!(enrichment && enrichment.delivery.enabled),
        deliveryState: enrichment ? enrichment.delivery.state : 'unavailable',
        revision: enrichment ? enrichment.revision : 0
      },
      environment: detectSupportEnvironment(),
      issues: buildSupportIssues(summary, enrichment, generatedAt),
      timeline: timeline.events
    };
  }

  function finalizeSupportArtifact(payload) {
    var canonicalPayload = safeJsonStringify(payload) || '{}';
    return sha256Text(canonicalPayload).then(function (digest) {
      var integrity = digest ? {
        algorithm: 'SHA-256',
        digest: digest,
        scope: 'canonical-payload',
        meaning: 'truncation-detection-only'
      } : {
        algorithm: 'unavailable',
        digest: null,
        scope: 'canonical-payload',
        meaning: 'truncation-detection-only'
      };
      var artifact = supportArtifactText(payload, integrity);
      if (utf8Bytes(artifact).length <= SUPPORT_MAX_BYTES) return artifact;
      if (payload.timeline.length) {
        payload.timeline.shift();
        payload.report.truncated = true;
        payload.report.omittedEventCount += 1;
        return finalizeSupportArtifact(payload);
      }
      if (payload.environment) {
        payload.environment = null;
        payload.report.truncated = true;
        return finalizeSupportArtifact(payload);
      }
      markSupportIssue('SUPPORT_REPORT_GENERATION_DEGRADED', 'warning', true);
      return minimalLearnerSupportReport();
    });
  }

  function minimalLearnerSupportReport() {
    var attemptId = state && validSupportUuid(state.supportAttemptId) ?
      state.supportAttemptId : createSupportUuid();
    var generatedAt = new Date().toISOString();
    var summary = state ? currentSupportSummary() : {
      state: 'lms_unavailable',
      completionSafeToClose: false,
      reasonCode: 'SUPPORT_REPORT_GENERATION_DEGRADED'
    };
    summary.completionSafeToClose = false;
    summary.reasonCode = 'SUPPORT_REPORT_GENERATION_DEGRADED';
    return supportArtifactText({
      report: {
        reportId: createSupportUuid(),
        supportCode: supportCodeForAttempt(attemptId),
        generatedAt: generatedAt,
        truncated: true,
        omittedEventCount: supportEvents.length
      },
      summary: summary,
      course: {
        title: null,
        courseId: config ? supportBoundedString(config.courseId, 256) : null,
        courseKeyFingerprint: null,
        scormVersion: apiAdapter ? (apiAdapter.is2004 ? '2004' : '1.2') : null,
        timegateVersion: TIMEGATE_RUNTIME_VERSION,
        packageVersion: null,
        structureHash: null
      },
      attempt: {
        attemptId: attemptId,
        launchId: supportLaunchId || createSupportUuid(),
        entryMode: 'unknown',
        resumeSource: 'none',
        lifecycle: apiTerminated ? 'terminated' : 'active',
        launchStartedAt: supportLaunchStartedAt,
        tabRole: 'uncoordinated',
        coordinationScope: 'same_browser_only',
        priorDeviceDiagnostics: 'unavailable',
        observabilitySessionId: null
      },
      timing: {
        cumulativeActiveSeconds: state ? supportInteger(state.elapsedSeconds) : 0,
        launchActiveSeconds: state ? supportInteger(state.sessionSeconds) : 0,
        launchIdleSeconds: 0,
        minimumRequiredSeconds: state ? supportInteger(state.minRequiredSeconds) : 0,
        minimumMet: !!(state && state.minMetAt),
        minimumMetAt: state ? supportTimestamp(state.minMetAt) : null,
        maximumAllowedSeconds: null,
        maximumReached: false,
        pauseReason: null
      },
      completion: {
        courseSignalObserved: false,
        signalSource: 'unknown',
        requestedStatus: null,
        firstRequestedAt: null,
        lastRequestedAt: null,
        deliveryState: 'not_requested',
        deliveryAttemptCount: 0,
        lastWriteResult: null,
        lastCommitResult: null,
        lastReadbackStatus: null,
        lmsApiAcknowledged: false,
        serverRecordVerified: 'not_available_in_course',
        pending: false,
        pendingDurableInLms: false,
        terminationDeferred: false,
        lastTerminationResult: null
      },
      lms: {
        apiState: supportApiState(),
        learnerVerified: false,
        canonicalStatus: null,
        lastErrorCode: null
      },
      persistence: {
        mode: config ? resolveStorageMode() : 'unknown',
        revision: 0,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lmsState: 'unknown',
        browserState: 'unknown',
        hydratedFrom: 'none',
        lmsFailureReason: null,
        lmsExistingChars: null,
        lmsAttemptedChars: null,
        lmsErrorCode: null
      },
      relay: {
        enabled: false,
        deliveryState: 'unknown',
        relayAttemptId: null
      },
      environment: null,
      issues: [{
        code: 'SUPPORT_REPORT_GENERATION_DEGRADED',
        severity: 'warning',
        active: true,
        firstSeenAt: generatedAt,
        lastSeenAt: generatedAt,
        occurrenceCount: 1
      }],
      timeline: []
    }, {
      algorithm: 'unavailable',
      digest: null,
      scope: 'canonical-payload',
      meaning: 'truncation-detection-only'
    });
  }

  function buildLearnerSupportReport() {
    return Promise.resolve().then(function () {
      if (!state) return minimalLearnerSupportReport();
      var reportId = createSupportUuid();
      var generatedAt = new Date().toISOString();
      var enrichment = readPublicSupportEnrichment();
      return sha256Text(state.courseKey || '').then(function (courseFingerprint) {
        var payload = buildSupportPayload(
          reportId,
          generatedAt,
          courseFingerprint,
          enrichment
        );
        return finalizeSupportArtifact(payload);
      });
    }).catch(function () {
      markSupportIssue('SUPPORT_REPORT_GENERATION_DEGRADED', 'warning', true);
      return minimalLearnerSupportReport();
    });
  }

  function getAudioContextConstructor() {
    try {
      return window.AudioContext || window.webkitAudioContext || null;
    } catch (e) {
      return null;
    }
  }

  function audioCueFeatureAvailable() {
    return !!(
      config &&
      config.audioCuesEnabled &&
      !config.configLoadError &&
      getAudioContextConstructor()
    );
  }

  function audioPreferenceStorageKey() {
    if (
      !state ||
      !state.courseKey ||
      !state.learnerKey ||
      state.learnerKey === 'unresolved'
    ) return '';
    var scope = safeJsonStringify([
      String(state.courseKey),
      String(state.learnerKey)
    ]);
    return scope ? AUDIO_PREFERENCE_KEY_PREFIX + scope : '';
  }

  function readAudioCuePreference() {
    var key = audioPreferenceStorageKey();
    if (!key) return false;
    try {
      return window.localStorage.getItem(key) === '1';
    } catch (e) {
      return false;
    }
  }

  function writeAudioCuePreference(enabled) {
    var key = audioPreferenceStorageKey();
    if (!key) return;
    try {
      window.localStorage.setItem(key, enabled ? '1' : '0');
    } catch (e) {
      // The preference remains effective for this page when storage is blocked.
    }
  }

  function syncAudioCuePreferenceForLearner() {
    var key = audioPreferenceStorageKey();
    audioCuesUserEnabled = false;
    cancelAudioCuePlayback(true);
    if (key) {
      audioCuesUserEnabled = audioCueFeatureAvailable() && readAudioCuePreference();
    }
    updateAudioPreferenceControls();
  }

  function updateAudioPreferenceControls() {
    var controls;
    var enabled = audioCuesUserEnabled;
    var preferenceAvailable = !!audioPreferenceStorageKey();
    var pressedValue = enabled ? 'true' : 'false';
    try {
      controls = document.querySelectorAll('[data-timegate-audio-preference]');
    } catch (e) {
      return;
    }
    for (var i = 0; i < controls.length; i++) {
      var control = controls[i];
      control.disabled = !preferenceAvailable;
      if (control.tagName === 'INPUT') {
        control.checked = enabled;
        continue;
      }
      control.setAttribute('data-enabled', pressedValue);
      control.setAttribute('aria-pressed', pressedValue);
      control.setAttribute(
        'aria-label',
        enabled ? 'Turn sound cues off' : 'Turn sound cues on'
      );
      control.setAttribute(
        'title',
        enabled ? 'Sound cues on' : 'Sound cues off'
      );
    }
  }

  function removeActiveAudioSource(source) {
    for (var i = activeAudioSources.length - 1; i >= 0; i--) {
      if (activeAudioSources[i] === source) {
        activeAudioSources.splice(i, 1);
      }
    }
  }

  function cancelAudioCuePlayback(closeContext) {
    audioPlaybackGeneration += 1;
    if (pendingAudioCueTimer !== null) {
      window.clearTimeout(pendingAudioCueTimer);
      pendingAudioCueTimer = null;
    }
    pendingAudioCue = null;
    while (activeAudioSources.length) {
      var source = activeAudioSources.pop();
      try { source.stop(0); } catch (e) { /* already stopped */ }
      try { source.disconnect(); } catch (e) { /* ignore */ }
    }
    if (closeContext && audioContext) {
      try {
        var closeResult = audioContext.close();
        if (closeResult && typeof closeResult.then === 'function') {
          closeResult.then(null, function () { /* fail open */ });
        }
      } catch (e) {
        // Audio teardown is fail-open.
      }
      audioContext = null;
      audioPlaybackReady = false;
    }
  }

  function runWithResumedAudioContext(callback) {
    if (!audioContext || !audioPlaybackReady) return;
    var context = audioContext;
    var playbackGeneration = audioPlaybackGeneration;
    if (context.state === 'closed') {
      audioContext = null;
      audioPlaybackReady = false;
      return;
    }
    if (context.state === 'suspended' && typeof context.resume === 'function') {
      try {
        var resumeResult = context.resume();
        if (resumeResult && typeof resumeResult.then === 'function') {
          resumeResult.then(function () {
            if (
              audioContext === context &&
              audioPlaybackGeneration === playbackGeneration &&
              audioPlaybackReady &&
              audioCuesUserEnabled
            ) {
              callback(context);
            }
          }, function () {
            // A blocked resume simply leaves visual feedback in charge.
          });
          return;
        }
      } catch (e) {
        return;
      }
    }
    callback(context);
  }

  function unlockAudioCuePlayback(playPreview) {
    if (!audioCuesUserEnabled || !audioCueFeatureAvailable()) return false;
    if (!audioContext || audioContext.state === 'closed') {
      var AudioContextConstructor = getAudioContextConstructor();
      if (!AudioContextConstructor) return false;
      try {
        audioContext = new AudioContextConstructor();
      } catch (e) {
        audioContext = null;
        audioPlaybackReady = false;
        return false;
      }
    }
    audioPlaybackReady = true;
    if (playPreview) {
      runWithResumedAudioContext(function () {
        requestAudioCue('audio_enabled', { userInitiated: true });
      });
    } else {
      runWithResumedAudioContext(function () { /* unlock only */ });
    }
    return true;
  }

  function setAudioCuesUserEnabled(enabled, playPreview) {
    if (!audioPreferenceStorageKey()) {
      audioCuesUserEnabled = false;
      updateAudioPreferenceControls();
      return;
    }
    audioCuesUserEnabled = !!enabled && audioCueFeatureAvailable();
    writeAudioCuePreference(audioCuesUserEnabled);
    updateAudioPreferenceControls();
    if (!audioCuesUserEnabled) {
      cancelAudioCuePlayback(true);
      return;
    }
    unlockAudioCuePlayback(!!playPreview);
  }

  function initializeAudioCuePreference() {
    audioCuesUserEnabled = audioCueFeatureAvailable() && readAudioCuePreference();
    audioContext = null;
    audioPlaybackReady = false;
    audioPlaybackGeneration = 0;
    pendingAudioCue = null;
    pendingAudioCueTimer = null;
    activeAudioSources = [];
  }

  function handleAudioPreferenceStorage(event) {
    var key = audioPreferenceStorageKey();
    if (!key || !event || event.key !== key) return;
    audioCuesUserEnabled = audioCueFeatureAvailable() && event.newValue === '1';
    if (!audioCuesUserEnabled) cancelAudioCuePlayback(true);
    updateAudioPreferenceControls();
  }

  function canRequestAudioCue(options) {
    options = options || {};
    if (
      !audioCueFeatureAvailable() ||
      !audioPreferenceStorageKey() ||
      !audioCuesUserEnabled ||
      !audioPlaybackReady ||
      !isPrimaryTab ||
      document.hidden ||
      (typeof document.hasFocus === 'function' && !document.hasFocus())
    ) return false;
    if (options.userInitiated) return true;
    if (!timerStarted || apiTerminated) return false;
    if (apiAdapter && !apiInitialized) return false;
    return true;
  }

  function scheduleAudioNote(context, note) {
    var oscillator = context.createOscillator();
    var gainNode = context.createGain();
    var startAt = context.currentTime + Math.max(0, note.offset || 0);
    var endAt = startAt + Math.max(0.04, note.duration || 0.1);
    oscillator.type = note.type || 'sine';
    if (
      oscillator.frequency &&
      typeof oscillator.frequency.setValueAtTime === 'function'
    ) {
      oscillator.frequency.setValueAtTime(note.frequency, startAt);
    } else if (oscillator.frequency) {
      oscillator.frequency.value = note.frequency;
    }
    if (gainNode.gain && typeof gainNode.gain.setValueAtTime === 'function') {
      gainNode.gain.setValueAtTime(0.0001, startAt);
      if (typeof gainNode.gain.exponentialRampToValueAtTime === 'function') {
        gainNode.gain.exponentialRampToValueAtTime(
          Math.max(0.0001, note.gain || 0.03),
          startAt + 0.015
        );
        gainNode.gain.exponentialRampToValueAtTime(0.0001, endAt);
      } else {
        gainNode.gain.setValueAtTime(note.gain || 0.03, startAt + 0.015);
        gainNode.gain.setValueAtTime(0.0001, endAt);
      }
    }
    oscillator.connect(gainNode);
    gainNode.connect(context.destination);
    oscillator.onended = function () {
      removeActiveAudioSource(oscillator);
      try { oscillator.disconnect(); } catch (e) { /* ignore */ }
      try { gainNode.disconnect(); } catch (e) { /* ignore */ }
    };
    oscillator.start(startAt);
    activeAudioSources.push(oscillator);
    oscillator.stop(endAt + 0.02);
  }

  function playSynthesizedAudioCue(cue) {
    if (!cue || cue.generation !== audioPlaybackGeneration) return;
    var notes = AUDIO_CUE_DEFINITIONS[cue.name];
    if (!notes || !notes.length) return;
    runWithResumedAudioContext(function (context) {
      if (
        cue.generation !== audioPlaybackGeneration ||
        !canRequestAudioCue(cue.options)
      ) return;
      var scheduled = 0;
      for (var i = 0; i < notes.length; i++) {
        try {
          scheduleAudioNote(context, notes[i]);
          scheduled += 1;
        } catch (e) {
          // Keep the cue and every Timegate path fail-open.
        }
      }
      if (scheduled > 0) {
        emitTimegateEvent('audio_cue_played', {
          reason: cue.name,
          success: true
        });
      }
    });
  }

  function flushPendingAudioCue() {
    pendingAudioCueTimer = null;
    var cue = pendingAudioCue;
    pendingAudioCue = null;
    if (
      !cue ||
      cue.generation !== audioPlaybackGeneration ||
      !canRequestAudioCue(cue.options)
    ) return;
    playSynthesizedAudioCue(cue);
  }

  function requestAudioCue(cueName, options) {
    options = options || {};
    if (!AUDIO_CUE_DEFINITIONS[cueName] || !canRequestAudioCue(options)) {
      return false;
    }
    var priority = AUDIO_CUE_PRIORITIES[cueName] || 0;
    var cue = {
      name: cueName,
      priority: priority,
      generation: audioPlaybackGeneration,
      options: options
    };
    if (options.immediate) {
      if (pendingAudioCueTimer !== null) {
        window.clearTimeout(pendingAudioCueTimer);
        pendingAudioCueTimer = null;
      }
      pendingAudioCue = null;
      playSynthesizedAudioCue(cue);
      return true;
    }
    if (!pendingAudioCue || priority >= pendingAudioCue.priority) {
      pendingAudioCue = cue;
    }
    if (pendingAudioCueTimer === null) {
      pendingAudioCueTimer = window.setTimeout(flushPendingAudioCue, 0);
    }
    return true;
  }

  function requestAudioCueForTimegateEvent(payload) {
    if (!payload || !payload.type) return;
    if (payload.type === 'completion_reset') {
      completionAudioCueSent = false;
      return;
    }
    if (payload.type === 'inactivity_nudge') {
      requestAudioCue('inactivity_nudge');
      return;
    }
    if (payload.type === 'inactivity_warning') {
      requestAudioCue('inactivity_warning');
      return;
    }
    if (payload.type === 'minimum_time_met') {
      if (payload.reason === 'timer' && !mediaPlaying) {
        requestAudioCue('minimum_time_met');
      }
      return;
    }
    if (payload.type === 'completion_replayed') {
      if (
        payload.canonicalCompletion === true &&
        payload.success === true &&
        payload.resultBoolean === true &&
        payload.readbackConfirmed === true &&
        !completionAudioCueSent
      ) {
        completionAudioCueSent = true;
        if (!mediaPlaying) requestAudioCue('completion_confirmed');
      }
      return;
    }
    if (payload.type === 'forced_exit') {
      requestAudioCue('session_ended', { immediate: true });
      return;
    }
    if (
      payload.type === 'maximum_time_reached' &&
      payload.reason !== 'hydrated' &&
      payload.reason !== 'initial'
    ) {
      requestAudioCue('session_ended', { immediate: true });
    }
  }

  /* Merge default config with overrides. */
  function mergeConfig(base, override) {
    var out = {};
    var key;
    for (key in base) {
      if (Object.prototype.hasOwnProperty.call(base, key)) {
        out[key] = base[key];
      }
    }
    if (override) {
      for (key in override) {
        if (Object.prototype.hasOwnProperty.call(override, key)) {
          out[key] = override[key];
        }
      }
    }
    return out;
  }

  function isAllowedSeatTimeRelayUrl(value) {
    if (typeof value !== 'string' || !value) return false;
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return false;
    try {
      var parsed = typeof window.URL === 'function' ?
        new window.URL(value) : null;
      if (!parsed) return false;
      if (parsed.protocol === 'https:') return true;
      if (parsed.protocol !== 'http:') return false;
      return parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === '::1';
    } catch (e) {
      return false;
    }
  }

  /*
   * Seat-time is optional and must never change the LMS completion gate. Invalid
   * seat-only settings disable this subsystem without contributing to the core
   * configLoadError that deliberately fails Timegate closed.
   */
  function normalizeSeatTimeConfig(normalized) {
    var reasons = [];
    var enabled = normalized.seatTimeReportingEnabled;
    var relayUrl = normalized.seatTimeRelayUrl;
    var relayKey = normalized.seatTimeRelayKey;
    var courseId = normalized.courseId;

    if (typeof enabled !== 'boolean') {
      reasons.push('enabled_type');
    }
    if (typeof relayUrl !== 'string' || relayUrl.length > 2048) {
      reasons.push('url_type_or_length');
      relayUrl = '';
    } else {
      if (/\s/.test(relayUrl)) reasons.push('url_invalid');
      relayUrl = relayUrl.trim();
      if (relayUrl && !isAllowedSeatTimeRelayUrl(relayUrl)) {
        reasons.push('url_invalid');
      }
    }
    if (typeof relayKey !== 'string' || relayKey.length > 512) {
      reasons.push('key_type_or_length');
      relayKey = '';
    }
    if (typeof courseId !== 'string' || courseId.length > 256) {
      reasons.push('course_type_or_length');
      courseId = '';
    }
    if (
      enabled === true &&
      (
        !relayUrl ||
        !relayKey.trim() ||
        !courseId.trim()
      )
    ) {
      reasons.push('enabled_fields_missing');
    }

    normalized.seatTimeRelayUrl = relayUrl;
    normalized.seatTimeRelayKey = relayKey;
    normalized.courseId = courseId;
    seatTimeConfigValid = enabled === true && reasons.length === 0;
    seatTimeConfigError = reasons.length ? reasons[0] : '';
    normalized.seatTimeReportingEnabled = seatTimeConfigValid;
  }

  /* Audio is optional; malformed audio settings disable sound, never Timegate. */
  function normalizeAudioCueConfig(normalized) {
    normalized.audioCuesEnabled = normalized.audioCuesEnabled === true;
  }

  /* Validate configuration without allowing malformed values to disable gates. */
  function normalizeTimeLimits(loaded) {
    var normalized = mergeConfig(DEFAULT_CONFIG, loaded || {});
    var errors = [];
    var numericRules = {
      minRequiredMinutes: 0,
      idleTimeoutSeconds: 0,
      backgroundGraceSeconds: 0,
      inactivityForceExitMinutes: 0,
      inactivityWarningSeconds: 0,
      gentleNudgeSeconds: 0
    };
    var numericMaximums = {
      minRequiredMinutes: 600,
      idleTimeoutSeconds: 3600,
      backgroundGraceSeconds: 3600,
      inactivityForceExitMinutes: 240,
      inactivityWarningSeconds: 600,
      gentleNudgeSeconds: 600
    };
    var key;

    if (loaded && !loaded.configLoadError) {
      if (!Object.prototype.hasOwnProperty.call(loaded, 'minRequiredMinutes')) {
        errors.push('minRequiredMinutes is required');
      }
      for (key in loaded) {
        if (!Object.prototype.hasOwnProperty.call(loaded, key)) continue;
        if (
          !Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key) &&
          key !== 'courseKey'
        ) {
          errors.push('Unknown configuration field: ' + key);
        }
      }
    }

    for (key in numericRules) {
      if (!Object.prototype.hasOwnProperty.call(numericRules, key)) continue;
      var rawNumericValue = normalized[key];
      var numericValue = rawNumericValue;
      if (
        rawNumericValue === null ||
        rawNumericValue === '' ||
        typeof rawNumericValue !== 'number' ||
        !isFinite(numericValue) ||
        numericValue < numericRules[key]
      ) {
        errors.push(key + ' must be a finite non-negative number');
      } else if (numericValue > numericMaximums[key]) {
        errors.push(key + ' exceeds the supported maximum');
      } else {
        normalized[key] = numericValue;
      }
    }
    if (normalized.idleTimeoutSeconds <= 0) {
      errors.push('idleTimeoutSeconds must be greater than zero');
    }
    if (normalized.inactivityForceExitMinutes <= 0) {
      errors.push('inactivityForceExitMinutes must be greater than zero');
    }

    var rawMax = normalized.maxAllowedMinutes;
    if (rawMax === null) {
      normalized.maxAllowedMinutes = null;
    } else {
      var maxMinutes = rawMax;
      if (
        typeof rawMax !== 'number' ||
        !isFinite(maxMinutes) ||
        maxMinutes > 600 ||
        maxMinutes <= normalized.minRequiredMinutes
      ) {
        errors.push(
          'maxAllowedMinutes must be at most 600 and greater than minRequiredMinutes'
        );
        normalized.maxAllowedMinutes = null;
      } else {
        normalized.maxAllowedMinutes = maxMinutes;
      }
    }

    var booleanKeys = [
      'enforceCompletion',
      'countWhileMediaPlaying',
      'hideWhenComplete',
      'debug',
      'inactivityForceExitEnabled',
      'gentleNudgeEnabled',
      'launchModalEnabled',
      'disableVideoSkip'
    ];
    for (var i = 0; i < booleanKeys.length; i++) {
      key = booleanKeys[i];
      if (typeof normalized[key] !== 'boolean') {
        errors.push(key + ' must be true or false');
      }
    }

    if (
      normalized.position !== 'bottom-left' &&
      normalized.position !== 'bottom-right'
    ) {
      errors.push('position must be bottom-left or bottom-right');
    }
    if (
      normalized.storageMode !== 'dual' &&
      normalized.storageMode !== 'localStorage' &&
      normalized.storageMode !== 'suspend_data'
    ) {
      errors.push('storageMode must be dual, localStorage, or suspend_data');
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'courseKey')) {
      if (
        typeof normalized.courseKey !== 'string' ||
        normalized.courseKey.trim() === ''
      ) {
        errors.push('courseKey must be a non-empty string when provided');
      } else if (normalized.courseKey.length > 256) {
        errors.push('courseKey must not exceed 256 characters');
      }
    }

    if (loaded && loaded.configLoadError) {
      errors.unshift(String(loaded.configLoadError));
    }
    normalizeSeatTimeConfig(normalized);
    normalizeAudioCueConfig(normalized);
    if (errors.length) {
      normalized.configLoadError = errors.join('; ');
      normalized.enforceCompletion = true;
    } else {
      delete normalized.configLoadError;
    }
    return normalized;
  }

  function hasMaximumTimeLimit() {
    return !!(
      state &&
      typeof state.maxAllowedSeconds === 'number' &&
      isFinite(state.maxAllowedSeconds) &&
      state.maxAllowedSeconds > 0
    );
  }

  function isMaximumTimeReached() {
    return !!(
      hasMaximumTimeLimit() &&
      state.elapsedSeconds >= state.maxAllowedSeconds
    );
  }

  /* Resolve base URL of current script for config loading. */
  function getScriptBaseUrl() {
    var script = document.currentScript;
    if (!script) {
      var scripts = document.getElementsByTagName('script');
      script = scripts[scripts.length - 1];
    }
    if (!script || !script.src) return '';
    return script.src.replace(/\/[^/]*$/, '/');
  }

  function failedConfig(message) {
    return mergeConfig(DEFAULT_CONFIG, {
      configLoadError: message || 'Timegate configuration could not be loaded',
      enforceCompletion: true
    });
  }

  /* Load config from global or JSON file. The bootstrap gate stays closed. */
  function loadConfig(done) {
    if (typeof window.TIMEGATE_CONFIG !== 'undefined') {
      if (
        window.TIMEGATE_CONFIG &&
        typeof window.TIMEGATE_CONFIG === 'object' &&
        !Array.isArray(window.TIMEGATE_CONFIG)
      ) {
        done(window.TIMEGATE_CONFIG);
      } else {
        done(failedConfig('window.TIMEGATE_CONFIG must be an object'));
      }
      return;
    }

    var baseUrl = getScriptBaseUrl();
    var configUrl =
      baseUrl ?
        baseUrl + 'timegate.config.json'
      : 'timegate/timegate.config.json'; // fallback only; normally resolved relative to this script's URL

    try {
      var xhr = new XMLHttpRequest();
      var settled = false;
      var timeoutId = null;
      var finish = function (value) {
        if (settled) return;
        settled = true;
        if (timeoutId) window.clearTimeout(timeoutId);
        done(value);
      };
      timeoutId = window.setTimeout(function () {
        try { xhr.abort(); } catch (e) { /* ignore */ }
        finish(failedConfig('timegate.config.json did not load in time'));
      }, CONFIG_LOAD_TIMEOUT_MS);
      xhr.open('GET', configUrl, true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          var parsed = safeJsonParse(stripJsonComments(xhr.responseText));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            finish(failedConfig('timegate.config.json is not valid JSON'));
            return;
          }
          finish(parsed);
        } else {
          finish(failedConfig(
            'timegate.config.json could not be loaded (HTTP ' + xhr.status + ')'
          ));
        }
      };
      xhr.onerror = function () {
        finish(failedConfig('timegate.config.json could not be loaded'));
      };
      xhr.send(null);
    } catch (e) {
      done(failedConfig('timegate.config.json could not be loaded'));
    }
  }

  /* Format seconds as H:MM:SS or M:SS. */
  function formatTime(totalSeconds) {
    var seconds = Math.max(0, Math.floor(totalSeconds));
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var secs = seconds % 60;
    var pad = function (n) {
      return n < 10 ? '0' + n : '' + n;
    };
    if (hours > 0) {
      return hours + ':' + pad(minutes) + ':' + pad(secs);
    }
    return minutes + ':' + pad(secs);
  }

  /* Clamp timer delta to avoid time jumps. */
  function clampDelta(ms) {
    if (ms < 0) return 0;
    if (ms > MAX_DELTA_MS) return MAX_DELTA_MS;
    return ms;
  }

  function createSvgElement(name) {
    return document.createElementNS('http://www.w3.org/2000/svg', name);
  }

  function createRingVisual(className, interactive) {
    var ring = document.createElement('div');
    ring.className = className;
    ring.setAttribute('data-carousel-focus', 'elapsed');

    var svg = createSvgElement('svg');
    svg.classList.add('timegate-ring-svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('role', 'progressbar');
    svg.setAttribute('aria-valuemin', '0');
    svg.setAttribute('aria-valuemax', '100');
    svg.setAttribute('aria-valuenow', '0');
    if (interactive) svg.setAttribute('tabindex', '-1');

    var track = createSvgElement('circle');
    track.classList.add('timegate-ring-track');
    track.setAttribute('cx', '50');
    track.setAttribute('cy', '50');
    track.setAttribute('r', '38');

    var fill = createSvgElement('circle');
    fill.classList.add('timegate-ring-fill');
    fill.setAttribute('cx', '50');
    fill.setAttribute('cy', '50');
    fill.setAttribute('r', '38');
    fill.setAttribute('pathLength', '100');
    fill.setAttribute('stroke-dasharray', '0 100');

    var marker = createSvgElement('line');
    marker.classList.add('timegate-ring-marker');
    marker.setAttribute('x1', '50');
    marker.setAttribute('y1', '6');
    marker.setAttribute('x2', '50');
    marker.setAttribute('y2', '16');
    marker.hidden = true;

    svg.appendChild(track);
    svg.appendChild(fill);
    svg.appendChild(marker);

    var center = document.createElement(interactive ? 'button' : 'div');
    center.className = 'timegate-ring-center';
    if (interactive) center.type = 'button';

    var value = document.createElement('strong');
    value.className = 'timegate-ring-value';
    value.textContent = '0:00';

    var label = document.createElement('span');
    label.className = 'timegate-ring-label';
    label.textContent = 'Time elapsed';

    var dots = document.createElement('span');
    dots.className = 'timegate-ring-dots';
    dots.setAttribute('aria-hidden', 'true');
    var dotElements = [];
    for (var index = 0; index < 3; index += 1) {
      var dot = document.createElement('i');
      dot.className = 'timegate-ring-dot';
      dot.setAttribute('data-current', index === 0 ? 'true' : 'false');
      dots.appendChild(dot);
      dotElements.push(dot);
    }

    center.appendChild(value);
    center.appendChild(label);
    center.appendChild(dots);
    ring.appendChild(svg);
    ring.appendChild(center);

    return {
      ring: ring,
      svg: svg,
      fill: fill,
      marker: marker,
      center: center,
      value: value,
      label: label,
      dots: dots,
      dotElements: dotElements
    };
  }

  function prefersReducedMotion() {
    try {
      return !!(
        window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      );
    } catch (e) {
      return false;
    }
  }

  function applyRingSlide(ui) {
    if (!ui.slides || !ui.slides.length) return;
    if (ui.carouselIndex >= ui.slides.length) ui.carouselIndex = 0;
    var slide = ui.slides[ui.carouselIndex];
    ui.value.textContent = slide.value;
    ui.label.textContent = slide.label;
    ui.ring.setAttribute(
      'data-carousel-focus',
      slide.visualTarget || 'none'
    );
    applyRingSlidePulse(ui, slide.visualTarget);
    ui.center.setAttribute(
      'aria-label',
      slide.label + ': ' + slide.value + '. Activate to show the next detail.'
    );
    ui.dotElements.forEach(function (dot, index) {
      dot.hidden = index >= ui.slides.length;
      dot.setAttribute(
        'data-current',
        index === ui.carouselIndex ? 'true' : 'false'
      );
    });
  }

  function applyRingSlidePulse(ui, visualTarget) {
    if (
      ui.activePulseTarget === visualTarget &&
      ui.carouselPulseTimer !== null
    ) return;

    if (ui.carouselPulseTimer !== null) {
      window.clearTimeout(ui.carouselPulseTimer);
      ui.carouselPulseTimer = null;
    }
    ui.activePulseTarget = null;
    ui.ring.removeAttribute('data-carousel-pulse');

    if (!visualTarget || ui.pulsedVisualTargets[visualTarget]) return;
    ui.pulsedVisualTargets[visualTarget] = true;
    ui.activePulseTarget = visualTarget;
    ui.ring.setAttribute('data-carousel-pulse', visualTarget);
    ui.carouselPulseTimer = window.setTimeout(function () {
      ui.ring.removeAttribute('data-carousel-pulse');
      ui.activePulseTarget = null;
      ui.carouselPulseTimer = null;
    }, RING_CAROUSEL_PULSE_WINDOW_MS);
  }

  function renderRingSlide(ui, animate) {
    if (!animate && ui.carouselTransitionTimer !== null) return;
    if (
      !animate ||
      prefersReducedMotion() ||
      !ui.slides ||
      ui.slides.length < 2
    ) {
      applyRingSlide(ui);
      return;
    }
    if (ui.carouselTransitionTimer !== null) {
      window.clearTimeout(ui.carouselTransitionTimer);
    }
    ui.center.classList.add('timegate-ring-changing');
    ui.carouselTransitionTimer = window.setTimeout(function () {
      applyRingSlide(ui);
      ui.center.classList.remove('timegate-ring-changing');
      ui.carouselTransitionTimer = null;
    }, RING_CAROUSEL_TRANSITION_MS);
  }

  function stopRingCarousel(ui) {
    if (ui.carouselTimer !== null) window.clearInterval(ui.carouselTimer);
    ui.carouselTimer = null;
  }

  function startRingCarousel(ui) {
    stopRingCarousel(ui);
    ui.carouselTimer = window.setInterval(function () {
      if (!ui.slides || ui.slides.length < 2) return;
      ui.carouselIndex = (ui.carouselIndex + 1) % ui.slides.length;
      renderRingSlide(ui, true);
    }, RING_CAROUSEL_INTERVAL_MS);
  }

  function updateRingScale(visual, progressPercent, markerPercent, ariaText) {
    var progress = Math.max(0, Math.min(100, progressPercent));
    visual.fill.setAttribute(
      'stroke-dasharray',
      progress.toFixed(2) + ' 100'
    );
    visual.svg.setAttribute('aria-valuenow', String(Math.round(progress)));
    visual.svg.setAttribute('aria-valuetext', ariaText);
    if (typeof markerPercent === 'number' && isFinite(markerPercent)) {
      var marker = Math.max(0, Math.min(100, markerPercent));
      visual.marker.hidden = false;
      visual.marker.setAttribute(
        'transform',
        'rotate(' + (marker * 3.6).toFixed(2) + ' 50 50)'
      );
    } else {
      visual.marker.hidden = true;
      visual.marker.removeAttribute('transform');
    }
  }

  function createLaunchAudioChoice() {
    if (!audioCueFeatureAvailable()) return null;
    var label = document.createElement('label');
    label.className = 'timegate-audio-choice';

    var input = document.createElement('input');
    input.type = 'checkbox';
    input.id = 'timegate-audio-opt-in';
    input.setAttribute('data-timegate-audio-preference', '');
    input.checked = audioCuesUserEnabled;
    input.disabled = !audioPreferenceStorageKey();
    input.onchange = function () {
      setAudioCuesUserEnabled(input.checked, input.checked);
    };

    var copy = document.createElement('span');
    copy.className = 'timegate-audio-choice-copy';

    var title = document.createElement('strong');
    title.textContent = 'Play helpful sound cues';

    var description = document.createElement('span');
    description.textContent =
      'Enable brief cues for time milestones and inactivity warnings.';

    copy.appendChild(title);
    copy.appendChild(description);
    label.appendChild(input);
    label.appendChild(copy);
    return label;
  }

  function updateLearnerSupportSurface() {
    if (!supportUi) return;
    var summary = currentSupportSummary();
    var statusCopy = SUPPORT_STATUS_COPY[summary.state] ||
      SUPPORT_STATUS_COPY.time_in_progress;
    var previousStatus = supportUi.status.textContent;
    supportUi.status.textContent = statusCopy;
    if (
      !supportUi.overlay.hidden &&
      previousStatus &&
      previousStatus !== statusCopy
    ) {
      supportUi.live.textContent = 'Course status updated. ' + statusCopy;
    }
    supportUi.timing.textContent =
      'Active ' + formatTime(state.elapsedSeconds) +
      ' · Required ' + formatTime(state.minRequiredSeconds) +
      (hasMaximumTimeLimit() ?
        ' · Limit ' + formatTime(state.maxAllowedSeconds) : '');
    supportUi.dialog.setAttribute('data-support-state', summary.state);
    var persistenceError = !!(
      supportIssues.TIMEGATE_STATE_SAVE_FAILED &&
      supportIssues.TIMEGATE_STATE_SAVE_FAILED.active
    );
    supportUi.button.setAttribute(
      'data-support-state',
      persistenceError ? 'persistence_warning' : summary.state
    );
    supportUi.button.setAttribute(
      'aria-label',
      'Open course status. ' + statusCopy
    );
    var retryable = !!(
      state.courseCompletePending &&
      state.minMetAt &&
      !configurationBlocked &&
      !apiTerminated &&
      isPrimaryTab
    );
    supportUi.retry.hidden = !retryable;
    var completionPendingLong = !!(
      state.courseCompletePending &&
      supportRuntime.completion.firstRequestedAt &&
      Date.now() - Date.parse(supportRuntime.completion.firstRequestedAt) >= 10000
    );
    var needsBanner = persistenceError || completionPendingLong ||
      summary.state === 'completion_retrying' ||
      summary.state === 'lms_unavailable' ||
      summary.state === 'configuration_error' ||
      summary.state === 'secondary_session';
    supportUi.banner.hidden = !needsBanner;
    supportUi.banner.textContent = needsBanner ?
      persistenceError ?
        'Course progress is having trouble saving. Open course status for help.' :
        statusCopy : '';
  }

  function inertLearnerSupportBackground() {
    supportBackgroundState = [];
    var children = document.body ? document.body.children : [];
    for (var i = 0; i < children.length; i++) {
      var element = children[i];
      if (supportUi && element === supportUi.overlay) continue;
      supportBackgroundState.push({
        element: element,
        hadInert: element.hasAttribute('inert'),
        ariaHidden: element.getAttribute('aria-hidden')
      });
      element.setAttribute('inert', '');
      element.setAttribute('aria-hidden', 'true');
    }
  }

  function restoreLearnerSupportBackground() {
    for (var i = 0; i < supportBackgroundState.length; i++) {
      var item = supportBackgroundState[i];
      if (!item.element) continue;
      if (!item.hadInert) item.element.removeAttribute('inert');
      if (item.ariaHidden === null) {
        item.element.removeAttribute('aria-hidden');
      } else {
        item.element.setAttribute('aria-hidden', item.ariaHidden);
      }
    }
    supportBackgroundState = [];
  }

  function learnerSupportFocusableElements() {
    if (!supportUi || supportUi.overlay.hidden) return [];
    var nodes = supportUi.dialog.querySelectorAll(
      'button:not([disabled]):not([hidden]), textarea:not([hidden])'
    );
    return Array.prototype.slice.call(nodes).filter(function (node) {
      return !node.hidden && node.offsetParent !== null;
    });
  }

  function closeLearnerSupportDialog() {
    if (!supportUi || supportUi.overlay.hidden) return;
    supportCopyGeneration += 1;
    supportUi.overlay.hidden = true;
    supportUi.overlay.setAttribute('inert', '');
    supportUi.dialog.setAttribute('aria-modal', 'false');
    supportUi.fallback.hidden = true;
    supportUi.fallback.value = '';
    document.removeEventListener('keydown', supportKeydownHandler, true);
    supportKeydownHandler = null;
    restoreLearnerSupportBackground();
    if (supportPreviousFocus && typeof supportPreviousFocus.focus === 'function') {
      try { supportPreviousFocus.focus(); } catch (e) { /* ignore */ }
    }
    supportPreviousFocus = null;
  }

  function openLearnerSupportDialog() {
    if (!supportUi) return;
    if (!supportUi.overlay.hidden) {
      try { supportUi.close.focus(); } catch (e) { /* ignore */ }
      return;
    }
    updateLearnerSupportSurface();
    supportPreviousFocus = document.activeElement;
    supportUi.fallback.hidden = true;
    supportUi.fallback.value = '';
    supportUi.copy.disabled = false;
    supportUi.copy.textContent = 'Copy support report';
    supportUi.download.disabled = false;
    supportUi.download.textContent = 'Download support report';
    supportUi.live.textContent = '';
    // A terminal walk-back screen is appended after the standard controls.
    // Move the support surface to the end so it remains visible above it.
    document.body.appendChild(supportUi.overlay);
    inertLearnerSupportBackground();
    supportUi.overlay.hidden = false;
    supportUi.overlay.removeAttribute('inert');
    supportUi.dialog.setAttribute('aria-modal', 'true');
    supportUi.live.textContent =
      'Course status is open. ' + supportUi.status.textContent;
    supportKeydownHandler = function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeLearnerSupportDialog();
        return;
      }
      if (event.key !== 'Tab') return;
      var focusable = learnerSupportFocusableElements();
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', supportKeydownHandler, true);
    try { supportUi.close.focus(); } catch (e) { /* ignore */ }
  }

  function supportCopyIsCurrent(generation) {
    return !!(
      supportUi &&
      !supportUi.overlay.hidden &&
      generation === supportCopyGeneration
    );
  }

  function revealSupportFallback(artifact, message, generation) {
    if (!supportCopyIsCurrent(generation)) return;
    supportUi.fallback.value = artifact;
    supportUi.fallback.hidden = false;
    supportUi.live.textContent = message ||
      'Copy was blocked. Select the report text and copy it manually.';
    try {
      supportUi.fallback.focus();
      supportUi.fallback.select();
    } catch (e) {
      // The report remains selectable even when programmatic selection fails.
    }
  }

  function setSupportArtifactActionsDisabled(disabled) {
    if (!supportUi) return;
    supportUi.copy.disabled = disabled;
    supportUi.download.disabled = disabled;
  }

  function copyLearnerSupportReport() {
    if (!supportUi || supportUi.copy.disabled) return;
    supportCopyGeneration += 1;
    var generation = supportCopyGeneration;
    setSupportArtifactActionsDisabled(true);
    supportUi.copy.textContent = 'Preparing report…';
    supportUi.live.textContent = 'Preparing support report.';
    buildLearnerSupportReport().then(function (artifact) {
      if (!supportCopyIsCurrent(generation)) return;
      var clipboard = null;
      try { clipboard = navigator.clipboard; } catch (e) { clipboard = null; }
      if (!clipboard || typeof clipboard.writeText !== 'function') {
        revealSupportFallback(artifact, null, generation);
        if (!supportCopyIsCurrent(generation)) return;
        setSupportArtifactActionsDisabled(false);
        supportUi.copy.textContent = 'Try copying again';
        return;
      }
      var write;
      try { write = clipboard.writeText(artifact); }
      catch (e) { write = Promise.reject(e); }
      Promise.resolve(write).then(function () {
        if (!supportCopyIsCurrent(generation)) return;
        supportUi.fallback.hidden = true;
        supportUi.fallback.value = '';
        setSupportArtifactActionsDisabled(false);
        supportUi.copy.textContent = 'Copied to clipboard.';
        supportUi.live.textContent =
          'Copied to clipboard. Send the report to training@sis.us.';
      }, function () {
        revealSupportFallback(artifact, null, generation);
        if (!supportCopyIsCurrent(generation)) return;
        setSupportArtifactActionsDisabled(false);
        supportUi.copy.textContent = 'Try copying again';
      });
    }, function () {
      if (!supportCopyIsCurrent(generation)) return;
      setSupportArtifactActionsDisabled(false);
      supportUi.copy.textContent = 'Try again';
      supportUi.live.textContent =
        'The support report could not be prepared. Keep the course open and contact training@sis.us.';
      markSupportIssue('SUPPORT_REPORT_GENERATION_DEGRADED', 'warning', true);
    });
  }

  function supportReportDownloadFilename() {
    var generatedAt = new Date().toISOString().replace(/[:.]/g, '-');
    return 'timegate-support-report-' + generatedAt + '.txt';
  }

  function downloadLearnerSupportReport() {
    if (!supportUi || supportUi.download.disabled) return;
    supportCopyGeneration += 1;
    var generation = supportCopyGeneration;
    setSupportArtifactActionsDisabled(true);
    supportUi.download.textContent = 'Preparing download…';
    supportUi.live.textContent = 'Preparing support report download.';
    buildLearnerSupportReport().then(function (artifact) {
      if (!supportCopyIsCurrent(generation)) return;
      try {
        if (
          typeof Blob !== 'function' ||
          !window.URL ||
          typeof window.URL.createObjectURL !== 'function'
        ) {
          throw new Error('DownloadUnavailable');
        }
        var blob = new Blob([artifact], { type: 'text/plain;charset=utf-8' });
        var objectUrl = window.URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = objectUrl;
        link.download = supportReportDownloadFilename();
        link.hidden = true;
        document.body.appendChild(link);
        link.click();
        link.parentNode.removeChild(link);
        window.setTimeout(function () {
          try { window.URL.revokeObjectURL(objectUrl); } catch (e) { /* ignore */ }
        }, 1000);
        setSupportArtifactActionsDisabled(false);
        supportUi.download.textContent = 'Downloaded';
        supportUi.live.textContent =
          'Support report downloaded. Send the file to training@sis.us.';
      } catch (e) {
        revealSupportFallback(
          artifact,
          'Download was unavailable. Select the report text and save it manually.',
          generation
        );
        if (!supportCopyIsCurrent(generation)) return;
        setSupportArtifactActionsDisabled(false);
        supportUi.download.textContent = 'Try downloading again';
      }
    }, function () {
      if (!supportCopyIsCurrent(generation)) return;
      setSupportArtifactActionsDisabled(false);
      supportUi.download.textContent = 'Try again';
      supportUi.live.textContent =
        'The support report could not be prepared. Keep the course open and contact training@sis.us.';
      markSupportIssue('SUPPORT_REPORT_GENERATION_DEGRADED', 'warning', true);
    });
  }

  function createLearnerSupportUi(root) {
    var button = document.createElement('button');
    button.type = 'button';
    button.id = 'timegate-support-button';
    button.className = 'timegate-support-button';
    button.title = 'Course status';
    button.setAttribute('aria-label', 'Open course status');
    var buttonIcon = document.createElement('span');
    buttonIcon.setAttribute('aria-hidden', 'true');
    buttonIcon.textContent = 'i';
    button.appendChild(buttonIcon);
    button.onclick = openLearnerSupportDialog;
    root.appendChild(button);

    var banner = document.createElement('button');
    banner.type = 'button';
    banner.id = 'timegate-support-banner';
    banner.className = 'timegate-support-banner';
    banner.hidden = true;
    banner.onclick = openLearnerSupportDialog;
    root.appendChild(banner);

    var overlay = document.createElement('div');
    overlay.id = 'timegate-support-overlay';
    overlay.className = 'timegate-support-overlay';
    overlay.hidden = true;

    var dialog = document.createElement('section');
    dialog.id = 'timegate-support-dialog';
    dialog.className = 'timegate-support-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'false');
    dialog.setAttribute('aria-labelledby', 'timegate-support-title');
    dialog.setAttribute('aria-describedby', 'timegate-support-status');

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'timegate-support-close';
    close.setAttribute('aria-label', 'Close course status');
    close.textContent = '×';
    close.onclick = closeLearnerSupportDialog;

    var title = document.createElement('h2');
    title.id = 'timegate-support-title';
    title.textContent = 'Course status';

    var status = document.createElement('p');
    status.id = 'timegate-support-status';
    status.className = 'timegate-support-status';

    var timing = document.createElement('p');
    timing.className = 'timegate-support-timing';

    var guidance = document.createElement('p');
    guidance.className = 'timegate-support-guidance';
    guidance.textContent =
      'Need help? Copy or download the support report and send it to training@sis.us.';

    var actions = document.createElement('div');
    actions.className = 'timegate-support-actions';

    var retry = document.createElement('button');
    retry.type = 'button';
    retry.id = 'timegate-retry-completion';
    retry.className = 'timegate-support-secondary';
    retry.textContent = 'Try saving completion';
    retry.hidden = true;
    retry.onclick = function () {
      retry.disabled = true;
      replayPendingCompletion('learner_retry');
      replayPendingTerminate('learner_retry');
      updateLearnerSupportSurface();
      supportUi.live.textContent = 'Timegate tried the pending save again.';
      setTimeout(function () { retry.disabled = false; }, 1000);
    };

    var copy = document.createElement('button');
    copy.type = 'button';
    copy.id = 'timegate-copy-support';
    copy.className = 'timegate-support-primary';
    copy.textContent = 'Copy support report';
    copy.onclick = copyLearnerSupportReport;

    var download = document.createElement('button');
    download.type = 'button';
    download.id = 'timegate-download-support';
    download.className = 'timegate-support-secondary';
    download.textContent = 'Download support report';
    download.onclick = downloadLearnerSupportReport;

    var fallback = document.createElement('textarea');
    fallback.id = 'timegate-support-text';
    fallback.className = 'timegate-support-text';
    fallback.readOnly = true;
    fallback.hidden = true;
    fallback.rows = 8;
    fallback.setAttribute('aria-label', 'Support report text for manual copying');

    var live = document.createElement('p');
    live.id = 'timegate-support-live';
    live.className = 'timegate-support-live';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');

    actions.appendChild(retry);
    actions.appendChild(copy);
    actions.appendChild(download);
    dialog.appendChild(close);
    dialog.appendChild(title);
    dialog.appendChild(status);
    dialog.appendChild(timing);
    dialog.appendChild(guidance);
    dialog.appendChild(actions);
    dialog.appendChild(fallback);
    dialog.appendChild(live);
    overlay.appendChild(dialog);
    overlay.setAttribute('inert', '');
    document.body.appendChild(overlay);

    overlay.addEventListener('mousedown', function (event) {
      if (event.target === overlay) closeLearnerSupportDialog();
    });

    supportUi = {
      button: button,
      banner: banner,
      overlay: overlay,
      dialog: dialog,
      close: close,
      status: status,
      timing: timing,
      retry: retry,
      copy: copy,
      download: download,
      fallback: fallback,
      live: live
    };
    updateLearnerSupportSurface();
  }

  function installLearnerSupportApi() {
    window.__SIS_TIMEGATE_SUPPORT__ = {
      build: buildLearnerSupportReport,
      open: openLearnerSupportDialog,
      status: function () {
        var summary = currentSupportSummary();
        return {
          state: summary.state,
          completionSafeToClose: summary.completionSafeToClose,
          reasonCode: summary.reasonCode,
          supportCode: state ? supportCodeForAttempt(state.supportAttemptId) : null
        };
      }
    };
  }

  /* Build and insert the timer overlay UI. */
  function createUi() {
    var root = document.createElement('div');
    root.id = 'timegate-root';
    root.className =
      'timegate--' +
      (config.position === 'bottom-left' ? 'bottom-left' : 'bottom-right');

    var visual = createRingVisual('timegate-ring', true);
    root.appendChild(visual.ring);

    document.body.appendChild(root);
    createLearnerSupportUi(root);
    updateAudioPreferenceControls();

    var ui = {
      root: root,
      ring: visual.ring,
      svg: visual.svg,
      fill: visual.fill,
      marker: visual.marker,
      center: visual.center,
      value: visual.value,
      label: visual.label,
      dots: visual.dots,
      dotElements: visual.dotElements,
      slides: [],
      carouselIndex: 0,
      carouselTimer: null,
      carouselTransitionTimer: null,
      carouselPulseTimer: null,
      activePulseTarget: null,
      pulsedVisualTargets: {}
    };

    ui.center.onclick = function () {
      if (!ui.slides || ui.slides.length < 2) return;
      ui.carouselIndex = (ui.carouselIndex + 1) % ui.slides.length;
      renderRingSlide(ui, true);
      startRingCarousel(ui);
    };
    ui.center.onmouseenter = function () { stopRingCarousel(ui); };
    ui.center.onmouseleave = function () { startRingCarousel(ui); };
    ui.center.onfocus = function () { stopRingCarousel(ui); };
    ui.center.onblur = function () { startRingCarousel(ui); };
    startRingCarousel(ui);

    return ui;
  }

  /* Animate the modal's sample timer into the corner where the live timer stays. */
  function startTimerHandoff(source, targetRoot) {
    if (
      !source ||
      !targetRoot ||
      typeof targetRoot.querySelector !== 'function'
    ) return null;
    var target = targetRoot.querySelector('.timegate-preview-card');
    if (!target) return null;

    var reducedMotion = false;
    try {
      reducedMotion = !!(
        window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      );
    } catch (e) {
      reducedMotion = false;
    }

    function revealTarget() {
      targetRoot.classList.remove('timegate-preview-awaiting');
      targetRoot.classList.add('timegate-preview-arrived');
    }

    if (reducedMotion || typeof source.animate !== 'function') {
      revealTarget();
      return null;
    }

    var sourceRect = source.getBoundingClientRect();
    var targetRect = target.getBoundingClientRect();
    if (!sourceRect.width || !sourceRect.height || !targetRect.width) {
      revealTarget();
      return null;
    }

    var clone = source.cloneNode(true);
    clone.id = 'timegate-handoff-clone';
    clone.className = source.className + ' timegate-handoff-clone';
    clone.setAttribute('aria-hidden', 'true');
    clone.style.left = sourceRect.left + 'px';
    clone.style.top = sourceRect.top + 'px';
    clone.style.width = sourceRect.width + 'px';
    document.body.appendChild(clone);

    var deltaX = targetRect.left - sourceRect.left;
    var deltaY = targetRect.top - sourceRect.top;
    var targetScale = targetRect.width / sourceRect.width;
    var destinationTransform =
      'translate3d(' + deltaX + 'px, ' + deltaY + 'px, 0) ' +
      'scale(' + targetScale + ')';
    var animation;
    try {
      animation = clone.animate([
        {
          opacity: 0.96,
          transform: 'translate3d(0, 0, 0) scale(1)'
        },
        {
          offset: 0.82,
          opacity: 0.88,
          transform: destinationTransform
        },
        {
          opacity: 0,
          transform: destinationTransform
        }
      ], {
        duration: 1100,
        easing: 'cubic-bezier(0.2, 0.75, 0.25, 1)',
        fill: 'forwards'
      });
    } catch (e) {
      if (clone.parentNode) clone.parentNode.removeChild(clone);
      revealTarget();
      return null;
    }

    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      if (clone.parentNode) clone.parentNode.removeChild(clone);
      revealTarget();
    }
    animation.onfinish = finish;
    animation.oncancel = finish;

    return {
      cancel: function () {
        try { animation.cancel(); } catch (e) { finish(); }
      }
    };
  }

  function restoreLaunchModalBackground() {
    for (var i = 0; i < launchModalBackgroundState.length; i++) {
      var item = launchModalBackgroundState[i];
      if (!item.node || !document.documentElement.contains(item.node)) continue;
      if (item.ariaHidden === null) {
        item.node.removeAttribute('aria-hidden');
      } else {
        item.node.setAttribute('aria-hidden', item.ariaHidden);
      }
      if (item.inert) {
        item.node.setAttribute('inert', '');
      } else {
        item.node.removeAttribute('inert');
      }
    }
    launchModalBackgroundState = [];
  }

  function makeLaunchModalBackgroundInert(overlay) {
    restoreLaunchModalBackground();
    if (!document.body) return;
    var children = document.body.children;
    for (var i = 0; i < children.length; i++) {
      var node = children[i];
      if (node === overlay) continue;
      launchModalBackgroundState.push({
        node: node,
        ariaHidden: node.getAttribute('aria-hidden'),
        inert: node.hasAttribute('inert')
      });
      node.setAttribute('aria-hidden', 'true');
      node.setAttribute('inert', '');
    }
  }

  function installLaunchModalFocusFence(overlay) {
    makeLaunchModalBackgroundInert(overlay);
    launchModalKeydownHandler = function (event) {
      if (launchModalEl !== overlay) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== 'Tab') return;
      var controls = overlay.querySelectorAll(
        'input:not([disabled]), button:not([disabled])'
      );
      if (!controls.length) {
        event.preventDefault();
        return;
      }
      var first = controls[0];
      var last = controls[controls.length - 1];
      var active = document.activeElement;
      var activeIsControl = false;
      for (var i = 0; i < controls.length; i++) {
        if (controls[i] === active) activeIsControl = true;
      }
      if (
        event.shiftKey &&
        (active === first || !activeIsControl)
      ) {
        event.preventDefault();
        try { last.focus(); } catch (e) { /* ignore */ }
      } else if (
        !event.shiftKey &&
        (active === last || !activeIsControl)
      ) {
        event.preventDefault();
        try { first.focus(); } catch (e) { /* ignore */ }
      }
    };
    document.addEventListener('keydown', launchModalKeydownHandler, true);
  }

  function removeLaunchModal(restoreFocus) {
    if (launchModalHandoff && typeof launchModalHandoff.cancel === 'function') {
      launchModalHandoff.cancel();
    }
    launchModalHandoff = null;
    if (launchModalEl && launchModalEl.parentNode) {
      launchModalEl.parentNode.removeChild(launchModalEl);
    }
    if (launchModalPreviewEl && launchModalPreviewEl.parentNode) {
      launchModalPreviewEl.parentNode.removeChild(launchModalPreviewEl);
    }
    if (launchModalKeydownHandler) {
      document.removeEventListener('keydown', launchModalKeydownHandler, true);
    }
    restoreLaunchModalBackground();
    var previousFocus = launchModalPreviousFocus;
    launchModalEl = null;
    launchModalPreviewEl = null;
    launchModalKind = '';
    launchModalKeydownHandler = null;
    launchModalPreviousFocus = null;
    if (
      restoreFocus &&
      previousFocus &&
      document.documentElement.contains(previousFocus) &&
      typeof previousFocus.focus === 'function'
    ) {
      try { previousFocus.focus(); } catch (e) { /* ignore */ }
    }
  }

  function normalizeInactivityExitNotice(value) {
    if (Array.isArray(value) && value.length === 2) {
      var occurredAtMs = Number(value[0]);
      if (!isFinite(occurredAtMs) || occurredAtMs <= 0) return null;
      try {
        value = {
          reason: 'inactivity',
          occurredAt: new Date(occurredAtMs).toISOString(),
          thresholdSeconds: value[1]
        };
      } catch (e) {
        return null;
      }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.reason !== 'inactivity') return null;
    if (typeof value.occurredAt !== 'string') return null;
    try {
      if (new Date(value.occurredAt).toISOString() !== value.occurredAt) return null;
    } catch (e) {
      return null;
    }
    var thresholdSeconds = Number(value.thresholdSeconds);
    if (
      !isFinite(thresholdSeconds) ||
      Math.floor(thresholdSeconds) !== thresholdSeconds ||
      thresholdSeconds <= 0 ||
      thresholdSeconds > 86400
    ) return null;
    return {
      reason: 'inactivity',
      occurredAt: value.occurredAt,
      thresholdSeconds: thresholdSeconds
    };
  }

  function hasUnacknowledgedInactivityExitNotice() {
    var notice = state ?
      normalizeInactivityExitNotice(state.inactivityExitNotice) : null;
    return !!(
      notice && notice.occurredAt !== acknowledgedInactivityExitAt
    );
  }

  function formatInactivityNoticeDuration(seconds) {
    var totalSeconds = Math.max(1, Math.round(Number(seconds) || 0));
    if (totalSeconds < 60) {
      return totalSeconds + (totalSeconds === 1 ? ' second' : ' seconds');
    }
    var minutes = Math.floor(totalSeconds / 60);
    var remainder = totalSeconds % 60;
    var text = minutes + (minutes === 1 ? ' minute' : ' minutes');
    if (remainder) {
      text += ' and ' + remainder + (remainder === 1 ? ' second' : ' seconds');
    }
    return text;
  }

  function createInactivityRelaunchModal(notice, onAcknowledge) {
    var normalizedNotice = normalizeInactivityExitNotice(notice);
    if (!normalizedNotice) return null;
    if (launchModalKind === 'inactivity') return launchModalEl;

    var previousFocus = document.activeElement;
    removeLaunchModal(false);
    if (
      previousFocus &&
      document.documentElement.contains(previousFocus) &&
      previousFocus !== document.body
    ) {
      launchModalPreviousFocus = previousFocus;
    }

    var overlay = document.createElement('div');
    overlay.id = 'timegate-inactivity-relaunch-modal';
    overlay.className = 'timegate-launch-modal timegate-relaunch-modal';

    var card = document.createElement('div');
    card.className = 'timegate-launch-card';

    var title = document.createElement('h2');
    title.className = 'timegate-launch-title';
    title.id = 'timegate-inactivity-relaunch-title';
    title.tabIndex = -1;
    title.textContent = 'Your previous session ended';

    var body = document.createElement('div');
    body.className = 'timegate-launch-body';

    var message = document.createElement('p');
    message.id = 'timegate-inactivity-relaunch-message';
    message.textContent =
      'Your previous course session ended after ' +
      formatInactivityNoticeDuration(normalizedNotice.thresholdSeconds) +
      ' without activity, so only active training time is reported to your LMS. ' +
      'Select Resume course to start a new tracked session.';

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'timegate-launch-button';
    button.textContent = 'Resume course';
    button.onclick = function () {
      unlockAudioCuePlayback(false);
      var acknowledged = typeof onAcknowledge === 'function' ?
        onAcknowledge(normalizedNotice) : true;
      if (acknowledged === false) return;
      removeLaunchModal(true);
    };

    body.appendChild(message);
    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(button);
    overlay.appendChild(card);
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', title.id);
    overlay.setAttribute('aria-describedby', message.id);
    document.body.appendChild(overlay);

    launchModalEl = overlay;
    launchModalKind = 'inactivity';
    installLaunchModalFocusFence(overlay);
    try { title.focus(); } catch (e) { /* ignore */ }
    return overlay;
  }

  /* Build and insert the launch acknowledgment modal. */
  function createLaunchModal(onAcknowledge) {
    removeLaunchModal(false);
    var overlay = document.createElement('div');
    overlay.id = 'timegate-launch-modal';
    overlay.className = 'timegate-launch-modal';

    var card = document.createElement('div');
    card.className = 'timegate-launch-card';

    var title = document.createElement('h2');
    title.className = 'timegate-launch-title';
    title.textContent = 'Before you begin';
    title.id = 'timegate-launch-title';
    title.tabIndex = -1;

    var body = document.createElement('div');
    body.className = 'timegate-launch-body';
    body.id = 'timegate-launch-description';

    var p1 = document.createElement('p');
    p1.textContent =
      'The ring in the bottom right tracks your active time. To complete this ' +
      'course, you\u2019ll need to finish all the content and meet the ' +
      formatTime(state.minRequiredSeconds) +
      ' Min requirement.';

    if (hasMaximumTimeLimit()) {
      p1.textContent +=
        ' The yellow marker is Min, and the full ring is the ' +
        formatTime(state.maxAllowedSeconds) +
        ' Max allowed.';
    }

    var p2 = document.createElement('p');
    p2.textContent =
      'Take your time, read carefully, and engage with the material. ' +
      'Pacing yourself supports better understanding and retention. It also ensures your training counts.';

    body.appendChild(p1);
    body.appendChild(p2);

    var guide = document.createElement('div');
    guide.className = 'timegate-launch-guide';

    var guideCopy = document.createElement('div');
    guideCopy.className = 'timegate-launch-guide-copy';

    var guideTitle = document.createElement('div');
    guideTitle.className = 'timegate-launch-guide-title';
    guideTitle.textContent = 'Track active time at a glance';

    var guideText = document.createElement('div');
    guideText.className = 'timegate-launch-guide-text';
    guideText.textContent =
      'The ring fills only while you are active. Its center rotates between ' +
      'Time elapsed, Min required, and Max allowed.';

    var previewElapsed = state ? Math.max(0, state.elapsedSeconds) : 0;
    var previewScaleSeconds = hasMaximumTimeLimit() ?
      state.maxAllowedSeconds : state.minRequiredSeconds;
    var previewProgressPercent = previewScaleSeconds > 0 ?
      (previewElapsed / previewScaleSeconds) * 100 : 100;
    var previewMarkerPercent = hasMaximumTimeLimit() && previewScaleSeconds > 0 ?
      (state.minRequiredSeconds / previewScaleSeconds) * 100 : null;
    var previewAriaText =
      formatTime(previewElapsed) +
      ' active. Min required ' +
      formatTime(state.minRequiredSeconds) +
      (hasMaximumTimeLimit() ?
        '. Max allowed ' + formatTime(state.maxAllowedSeconds) : '');

    var demoCard = document.createElement('div');
    demoCard.className = 'timegate-demo-card';
    var demoVisual = createRingVisual('timegate-ring timegate-demo-ring', false);
    demoVisual.value.textContent = formatTime(previewElapsed);
    demoVisual.label.textContent = 'Time elapsed';
    demoVisual.dots.hidden = !hasMaximumTimeLimit();
    updateRingScale(
      demoVisual,
      previewProgressPercent,
      previewMarkerPercent,
      previewAriaText
    );

    guideCopy.appendChild(guideTitle);
    guideCopy.appendChild(guideText);
    demoCard.appendChild(demoVisual.ring);
    guide.appendChild(guideCopy);
    guide.appendChild(demoCard);
    body.appendChild(guide);

    /* Preview timer widget — pulses in corner during modal to show learner where the timer will live. */
    var previewRoot = document.createElement('div');
    previewRoot.id = 'timegate-modal-preview';
    previewRoot.className = 'timegate-preview-awaiting';
    if (config && config.position === 'bottom-left') {
      previewRoot.className += ' timegate--bottom-left';
    }

    var previewCard = document.createElement('div');
    previewCard.className = 'timegate-preview-card';
    var previewVisual = createRingVisual(
      'timegate-ring timegate-preview-ring',
      false
    );
    previewVisual.value.textContent = formatTime(previewElapsed);
    previewVisual.label.textContent = 'Time elapsed';
    previewVisual.dots.hidden = !hasMaximumTimeLimit();
    updateRingScale(
      previewVisual,
      previewProgressPercent,
      previewMarkerPercent,
      previewAriaText
    );

    previewCard.appendChild(previewVisual.ring);
    previewRoot.appendChild(previewCard);
    previewRoot.setAttribute('aria-hidden', 'true');
    previewRoot.setAttribute('inert', '');
    document.body.appendChild(previewRoot);
    launchModalPreviewEl = previewRoot;

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'timegate-launch-button';
    button.textContent = 'I understand';
    button.onclick = function () {
      unlockAudioCuePlayback(false);
      removeLaunchModal(false);
      if (typeof onAcknowledge === 'function') onAcknowledge();
      var liveRoot = document.getElementById('timegate-root');
      var focusTarget = liveRoot && liveRoot.classList.contains('timegate--hidden') ?
        liveRoot.querySelector('.timegate-support-button') :
        liveRoot && liveRoot.querySelector('.timegate-ring-svg');
      if (focusTarget && typeof focusTarget.focus === 'function') {
        try { focusTarget.focus(); } catch (e) { /* ignore */ }
      }
      var liveRing = document.querySelector('#timegate-root .timegate-ring');
      if (liveRing) {
        liveRing.classList.add('timegate-ring-attention');
        setTimeout(function () {
          liveRing.classList.remove('timegate-ring-attention');
        }, 1400);
      }
    };

    card.appendChild(title);
    card.appendChild(body);
    var audioChoice = createLaunchAudioChoice();
    if (audioChoice) card.appendChild(audioChoice);
    card.appendChild(button);
    overlay.appendChild(card);

    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'timegate-launch-title');
    overlay.setAttribute('aria-describedby', 'timegate-launch-description');

    document.body.appendChild(overlay);
    launchModalEl = overlay;
    launchModalKind = 'standard';
    installLaunchModalFocusFence(overlay);

    launchModalHandoff = startTimerHandoff(demoCard, previewRoot);

    try { title.focus(); } catch (e) { /* ignore */ }

    return overlay;
  }

  /* Build the inactivity warning toast (hidden by default). */
  function createWarningToast() {
    var toast = document.createElement('div');
    toast.id = 'timegate-warning';
    toast.className = 'timegate-warning';
    toast.style.display = 'none';
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'assertive');

    var title = document.createElement('div');
    title.className = 'timegate-warning-title';
    title.textContent = 'Still there? Session ending';

    var msg = document.createElement('div');
    msg.className = 'timegate-warning-msg';

    var msgText = document.createTextNode('Session ending in ');
    var strong = document.createElement('strong');
    var secondsSpan = document.createElement('span');
    secondsSpan.className = 'timegate-warning-seconds';
    secondsSpan.textContent = '30';
    strong.appendChild(secondsSpan);
    var secondsLabel = document.createTextNode(' seconds');
    strong.appendChild(secondsLabel);
    var msgText2 = document.createTextNode(' due to inactivity.');
    msg.appendChild(msgText);
    msg.appendChild(strong);
    msg.appendChild(msgText2);

    var sub = document.createElement('div');
    sub.className = 'timegate-warning-sub';
    sub.textContent = 'Move your mouse or press any key to stay in the course.';

    toast.appendChild(title);
    toast.appendChild(msg);
    toast.appendChild(sub);
    document.body.appendChild(toast);

    warningEl = toast;
    return toast;
  }

  /* Show/update the warning toast countdown. */
  function showWarning(secondsRemaining) {
    if (!warningEl) createWarningToast();
    var secs = Math.max(0, Math.ceil(secondsRemaining));
    var secondsSpan = warningEl.querySelector('.timegate-warning-seconds');
    if (secondsSpan) secondsSpan.textContent = secs;
    if (warningEl.style.display === 'none') {
      warningEl.style.display = '';
      emitTimegateEvent('inactivity_warning', {
        reason: 'countdown_started',
        remainingSeconds: secs,
        activeSeconds: state ? Math.floor(state.elapsedSeconds || 0) : 0,
        idleSeconds: currentObservedIdleSeconds(Date.now())
      });
    }
  }

  /* Hide the warning toast. */
  function hideWarning() {
    if (warningEl && warningEl.style.display !== 'none') {
      warningEl.style.display = 'none';
    }
  }

  /* Build the gentle "are you still here?" nudge (hidden by default). */
  function createGentleNudge() {
    var nudge = document.createElement('div');
    nudge.id = 'timegate-nudge';
    nudge.className = 'timegate-nudge';
    nudge.style.display = 'none';
    nudge.setAttribute('role', 'status');
    nudge.setAttribute('aria-live', 'polite');

    var title = document.createElement('div');
    title.className = 'timegate-nudge-title';
    title.textContent = 'Are you still here?';

    var sub = document.createElement('div');
    sub.className = 'timegate-nudge-sub';
    sub.textContent = 'Move your mouse, press a key, or tap the screen to keep going.';

    nudge.appendChild(title);
    nudge.appendChild(sub);
    document.body.appendChild(nudge);

    gentleNudgeEl = nudge;
    return nudge;
  }

  /* Show the gentle nudge. */
  function showGentleNudge() {
    if (!gentleNudgeEl) createGentleNudge();
    if (gentleNudgeEl.style.display === 'none') {
      gentleNudgeEl.style.display = '';
      emitTimegateEvent('inactivity_nudge', {
        reason: 'nudge_started',
        activeSeconds: state ? Math.floor(state.elapsedSeconds || 0) : 0,
        idleSeconds: currentObservedIdleSeconds(Date.now())
      });
    }
  }

  /* Hide the gentle nudge. */
  function hideGentleNudge() {
    if (gentleNudgeEl && gentleNudgeEl.style.display !== 'none') {
      gentleNudgeEl.style.display = 'none';
    }
  }

  /* Build and display the walk-back overlay covering the course UI. */
  function showWalkBackOverlay(titleText, messageText) {
    if (walkBackEl) return;

    var overlay = document.createElement('div');
    overlay.id = 'timegate-walkback';
    overlay.className = 'timegate-walkback';

    var card = document.createElement('div');
    card.className = 'timegate-walkback-card';

    var title = document.createElement('div');
    title.className = 'timegate-walkback-title';
    title.id = 'timegate-walkback-title';
    title.textContent = titleText || 'Session ended due to inactivity';

    var msg = document.createElement('p');
    msg.className = 'timegate-walkback-msg';
    msg.textContent = messageText ||
      'Your course session was closed after an extended period of no activity. ' +
      'Please close this window and relaunch the course from your LMS to resume where you left off.';

    var supportButton = document.createElement('button');
    supportButton.type = 'button';
    supportButton.className = 'timegate-walkback-support';
    supportButton.textContent = 'Copy support report';
    supportButton.onclick = function () {
      openLearnerSupportDialog();
      copyLearnerSupportReport();
    };

    card.appendChild(title);
    card.appendChild(msg);
    card.appendChild(supportButton);
    overlay.appendChild(card);

    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'timegate-walkback-title');
    document.body.appendChild(overlay);

    walkBackEl = overlay;
  }

  function hideWalkBackOverlay() {
    if (walkBackEl && walkBackEl.parentNode) {
      walkBackEl.parentNode.removeChild(walkBackEl);
    }
    walkBackEl = null;
  }

  function formatScorm12SessionTime(seconds) {
    var hundredths = Math.max(0, Math.round(Number(seconds || 0) * 100));
    var totalSeconds = Math.floor(hundredths / 100);
    var fraction = hundredths % 100;
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var secs = totalSeconds % 60;
    var pad2 = function (value) {
      return value < 10 ? '0' + value : String(value);
    };
    var hourText = String(hours);
    while (hourText.length < 4) hourText = '0' + hourText;
    return hourText + ':' + pad2(minutes) + ':' + pad2(secs) + '.' + pad2(fraction);
  }

  function formatScorm2004SessionTime(seconds) {
    var hundredths = Math.max(0, Math.round(Number(seconds || 0) * 100));
    var hours = Math.floor(hundredths / 360000);
    var minutes = Math.floor((hundredths % 360000) / 6000);
    var secs = (hundredths % 6000) / 100;
    return 'PT' + hours + 'H' + minutes + 'M' + secs + 'S';
  }

  function writeSessionTime() {
    if (!apiAdapter || !apiInitialized || apiTerminated) return false;
    var element = apiAdapter.is2004 ?
      'cmi.session_time' : 'cmi.core.session_time';
    var value = apiAdapter.is2004 ?
      formatScorm2004SessionTime(state.sessionSeconds) :
      formatScorm12SessionTime(state.sessionSeconds);
    return setScormValue(element, value);
  }

  function finalizeLmsData(reason) {
    if (!apiAdapter || !apiInitialized || apiTerminated) {
      return { ok: false, sessionTime: false, persistence: false, commit: false };
    }
    var sessionTimeOk = writeSessionTime();
    var exitOk = true;
    if (reason === 'inactivity' || reason === 'maximum') {
      exitOk = setScormValue(
        apiAdapter.is2004 ? 'cmi.exit' : 'cmi.core.exit',
        'suspend'
      );
    }
    var persistenceOk = persistState(true);
    var commitOk = commitScorm();
    var ok = sessionTimeOk && exitOk && persistenceOk && commitOk;
    if (!ok) {
      var finalizationErrorCode = captureSupportScormError();
      emitTimegateEvent('lms_operation_failed', {
        reason: reason || 'course',
        operation: 'finalize',
        sessionTime: sessionTimeOk,
        persistence: persistenceOk,
        resultBoolean: commitOk,
        errorCode: finalizationErrorCode
      });
    }
    return {
      ok: ok,
      sessionTime: sessionTimeOk,
      persistence: persistenceOk,
      commit: commitOk
    };
  }

  function finalizeConfirmedCompletion() {
    if (
      !state ||
      !state.courseCompleteSent ||
      !state.minMetAt ||
      state.courseCompletePending ||
      state.pendingTerminate ||
      supportRuntime.completion.deliveryState !== 'confirmed'
    ) return false;
    lastCompletionFinalizationTs = Date.now();
    var result = finalizeLmsData('completion');
    supportRuntime.completion.finalizationSucceeded = result.ok;
    if (result.ok) {
      supportRuntime.lastErrorCode = null;
      clearSupportIssue('LMS_FINALIZATION_FAILED');
      recordSupportEvent('LMS_FINALIZATION', 'success', 'finalize');
    }
    return result.ok;
  }

  function normalizeTerminationReason(reason) {
    if (reason === 'inactivity' || reason === 'maximum') return reason;
    return 'course';
  }

  function buildPendingTerminate(reason, existing) {
    return {
      requestedAt:
        existing && typeof existing.requestedAt === 'string' ?
          existing.requestedAt : new Date().toISOString(),
      reason: normalizeTerminationReason(reason)
    };
  }

  function terminateLmsSession(reason, args) {
    if (apiTerminated) return 'true';
    if (!apiAdapter || !apiAdapter.original.terminate || !apiInitialized) {
      return 'false';
    }
    lastTerminationAttemptTs = Date.now();
    var pendingBeforeAttempt = state.pendingTerminate;
    state.pendingTerminate = null;
    var finalization = finalizeLmsData(reason);
    if (!finalization.ok) {
      if (state.courseCompleteSent) {
        supportRuntime.completion.finalizationSucceeded = false;
      }
      supportRuntime.completion.terminationDeferred = true;
      state.pendingTerminate = buildPendingTerminate(reason, pendingBeforeAttempt);
      persistState(true);
      return 'false';
    }
    if (state.courseCompleteSent) {
      supportRuntime.completion.finalizationSucceeded = true;
    }
    var result;
    try {
      result = apiAdapter.original.terminate.apply(
        apiAdapter.api,
        args && args.length ? args : ['']
      );
    } catch (e) {
      result = 'false';
    }
    if (scormCallSucceeded(result)) {
      supportRuntime.lastErrorCode = null;
      supportRuntime.completion.terminationDeferred = false;
      supportRuntime.completion.lastTerminationResult = true;
      runSeatTimeSafely(function () {
        seatTimeTerminal = true;
        freezeSeatTimeSegment('terminated', false, true);
      });
      apiTerminated = true;
      apiInitialized = false;
      timerStarted = false;
      state.pendingTerminate = null;
      releaseLock();
      isPrimaryTab = false;
      maximumExitFinalized = reason === 'maximum' || maximumExitFinalized;
      emitTimegateEvent('termination_completed', {
        reason: reason || 'course',
        operation: apiAdapter.method.terminate,
        activeSeconds: Math.floor(state.elapsedSeconds || 0),
        idleSeconds: currentObservedIdleSeconds(Date.now()),
        success: true
      });
    } else {
      supportRuntime.completion.terminationDeferred = true;
      supportRuntime.completion.lastTerminationResult = false;
      state.pendingTerminate = buildPendingTerminate(reason, pendingBeforeAttempt);
      persistState(true);
      emitTimegateEvent('lms_operation_failed', {
        reason: reason || 'course',
        operation: apiAdapter.method.terminate,
        errorCode: captureSupportScormError()
      });
    }
    return result;
  }

  function replayPendingTerminate(reason) {
    if (
      !state ||
      !state.pendingTerminate ||
      state.courseCompletePending ||
      apiTerminated ||
      !apiInitialized
    ) return;
    if (
      reason === 'timer_retry' &&
      Date.now() - lastTerminationAttemptTs < COMPLETION_RETRY_INTERVAL_MS
    ) return;
    var pendingReason = normalizeTerminationReason(
      state.pendingTerminate.reason || (reason === 'maximum' ? 'maximum' : 'course')
    );
    if (pendingReason === 'inactivity') {
      state.pendingTerminate = null;
      persistState(true);
      return;
    }
    terminateLmsSession(pendingReason, ['']);
  }

  /* Terminate the SCORM session and show walk-back overlay. */
  function triggerForceExit() {
    if (!forceExitTriggered) {
      forceExitTriggered = true;
      forcedTerminationReason = 'inactivity';
      state.inactivityExitNotice = {
        reason: 'inactivity',
        occurredAt: new Date().toISOString(),
        thresholdSeconds: Math.max(
          1,
          Math.round((config.inactivityForceExitMinutes || 0) * 60)
        )
      };
      log('Force exit triggered due to inactivity');
      emitTimegateEvent('forced_exit', {
        reason: 'inactivity',
        activeSeconds: state ? Math.floor(state.elapsedSeconds || 0) : 0,
        idleSeconds: currentObservedIdleSeconds(Date.now()),
        durationSeconds: Math.max(0, (Date.now() - lastActivityTs) / 1000)
      });
      runSeatTimeSafely(function () {
        seatTimeTerminal = true;
        freezeSeatTimeSegment('inactivity-exit', false, true);
      });
    }

    if (!apiTerminated && apiInitialized) {
      terminateLmsSession('inactivity', ['']);
    } else {
      persistState(true);
    }

    hideWarning();
    hideGentleNudge();
    showWalkBackOverlay();
  }

  /* Persist and lock the course when cumulative active time reaches its cap. */
  function triggerMaximumTimeExit(reason) {
    if (!isMaximumTimeReached()) return;
    if (!isPrimaryTab) {
      hideWalkBackOverlay();
      return;
    }
    if (state.elapsedSeconds > state.maxAllowedSeconds) {
      state.elapsedSeconds = state.maxAllowedSeconds;
    }
    if (!state.maxReachedAt) state.maxReachedAt = new Date().toISOString();

    if (!maximumTimeEventSent) {
      maximumTimeEventSent = true;
      emitTimegateEvent('maximum_time_reached', {
        reason: reason || 'timer',
        activeSeconds: Math.floor(state.elapsedSeconds || 0),
        idleSeconds: currentObservedIdleSeconds(Date.now()),
        limitSeconds: state.maxAllowedSeconds
      });
    }

    forceExitTriggered = true;
    forcedTerminationReason = 'maximum';
    runSeatTimeSafely(function () {
      seatTimeTerminal = true;
      freezeSeatTimeSegment('maximum-exit', false, true);
    });
    clearPendingCompletion();
    persistState(true);
    if (!maximumExitFinalized && !apiTerminated && apiInitialized) {
      terminateLmsSession('maximum', ['']);
    }
    hideWarning();
    hideGentleNudge();
    showWalkBackOverlay(
      'Maximum course time reached',
      'You have reached the maximum active time allowed for this course. ' +
      'Please close this window and contact your training administrator if you need another attempt.'
    );
  }

  /* Evaluate inactivity thresholds; show warning or trigger force exit. */
  function evaluateInactivity() {
    if (!config.inactivityForceExitEnabled) return;
    if (forceExitTriggered) return;
    if (!timerStarted) return;

    /*
     * The inactivity clock only runs in the visible tab that owns this learner
     * session. Otherwise the warnings cannot be acted on, and seat time is
     * already paused by the background or secondary-tab rule.
     */
    if (!isPrimaryTab || document.hidden) {
      lastActivityTs = Date.now();
      hideWarning();
      hideGentleNudge();
      return;
    }

    /*
     * Playing media counts as activity. A learner watching a video does not
     * generate mouse/keyboard events, so without this they would be force-
     * exited mid-playback. While media plays we treat the learner as active:
     * reset the inactivity clock and clear any pending warning. Gated by
     * countWhileMediaPlaying so publishers can opt out.
     */
    if (config.countWhileMediaPlaying && mediaPlaying) {
      lastActivityTs = Date.now();
      hideWarning();
      hideGentleNudge();
      return;
    }

    var now = Date.now();
    var inactiveMs = now - lastActivityTs;
    var forceExitMs = (config.inactivityForceExitMinutes || 0) * 60 * 1000;
    var warningMs = (config.inactivityWarningSeconds || 0) * 1000;
    var nudgeMs = config.gentleNudgeEnabled ? (config.gentleNudgeSeconds || 0) * 1000 : 0;

    if (forceExitMs <= 0) return;

    /*
     * Three-phase inactivity, measured backward from the force-exit point:
     *   [active] -> [gentle nudge] -> [final warning + countdown] -> [exit]
     * The gentle nudge gives a calm "still here?" prompt low on the screen
     * before the firmer countdown toast appears. Any activity (or playing
     * media, handled above) resets the clock and clears both.
     */
    if (inactiveMs >= forceExitMs) {
      triggerForceExit();
      return;
    }

    var msUntilExit = forceExitMs - inactiveMs;
    if (msUntilExit <= warningMs) {
      hideGentleNudge();
      showWarning(msUntilExit / 1000);
    } else if (nudgeMs > 0 && msUntilExit <= warningMs + nudgeMs) {
      hideWarning();
      showGentleNudge();
    } else {
      hideWarning();
      hideGentleNudge();
    }
  }

  /* Update overlay text and state classes. */
  function updateUi(ui, opts) {
    var complete = opts.complete;
    var paused = opts.paused;
    var locked = opts.locked;
    var stateClass = opts.stateClass;

    ui.slides = opts.slides;
    if (ui.carouselIndex >= ui.slides.length) ui.carouselIndex = 0;
    renderRingSlide(ui, false);
    updateRingScale(
      ui,
      opts.progressPercent,
      opts.markerPercent,
      opts.progressText
    );

    var rootClass = ui.root.className;
    var nextClass =
      'timegate--' +
      (config.position === 'bottom-left' ? 'bottom-left' : 'bottom-right');

    if (paused) nextClass += ' timegate--paused';
    if (locked) nextClass += ' timegate--locked';
    if (complete) nextClass += ' timegate--complete';
    if (stateClass) nextClass += ' ' + stateClass;
    if (config.hideWhenComplete && complete && !hasMaximumTimeLimit()) {
      nextClass += ' timegate--hidden';
    }

    if (rootClass !== nextClass) {
      ui.root.className = nextClass;
    }
  }

  /* Test and return localStorage if usable. */
  function getLocalStorage() {
    try {
      var ls = window.localStorage;
      var key = '__timegate_v2_test__';
      ls.setItem(key, '1');
      ls.removeItem(key);
      supportLocalStorageAvailable = true;
      return ls;
    } catch (e) {
      supportLocalStorageAvailable = false;
      return null;
    }
  }

  function probeSessionStorage() {
    try {
      var session = window.sessionStorage;
      var key = '__timegate_support_test__';
      session.setItem(key, '1');
      session.removeItem(key);
      supportSessionStorageAvailable = true;
    } catch (e) {
      supportSessionStorageAvailable = false;
    }
  }

  function seatTimeEnabled() {
    return !!(
      seatTimeConfigValid &&
      config &&
      config.seatTimeReportingEnabled &&
      !seatTimeDeliveryDisabled &&
      !configurationBlocked
    );
  }

  function runSeatTimeSafely(action) {
    if (!seatTimeEnabled()) return;
    try {
      action();
    } catch (e) {
      /* Seat reporting is isolated from all LMS and timer behavior. */
    }
  }

  function createSeatTimeOpaqueId(prefix) {
    try {
      var cryptoApi = window.crypto;
      if (!cryptoApi) return null;
      var uuid;
      if (typeof cryptoApi.randomUUID === 'function') {
        uuid = cryptoApi.randomUUID();
      } else if (typeof cryptoApi.getRandomValues === 'function') {
        var bytes = new Uint8Array(16);
        cryptoApi.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        var hex = [];
        for (var i = 0; i < bytes.length; i++) {
          hex.push((bytes[i] + 256).toString(16).slice(1));
        }
        uuid = hex.slice(0, 4).join('') + '-' +
          hex.slice(4, 6).join('') + '-' +
          hex.slice(6, 8).join('') + '-' +
          hex.slice(8, 10).join('') + '-' +
          hex.slice(10, 16).join('');
      }
      if (!uuid) return null;
      return String(prefix || 'seat') + '-' + uuid;
    } catch (e) {
      return null;
    }
  }

  function validSeatTimeOpaqueId(value, prefix) {
    return typeof value === 'string' && new RegExp(
      '^' + prefix +
      '-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      'i'
    ).test(value);
  }

  function buildSeatTimeCourseName() {
    try {
      if (typeof window.getCourseTitle === 'function') {
        return String(
          window.getCourseTitle() || document.title || 'Unknown course'
        ).slice(0, 512);
      }
    } catch (e) {
      // Fall through to the document title.
    }
    return String(document.title || 'Unknown course').slice(0, 512);
  }

  function readSeatTimeLearnerName() {
    if (!apiAdapter || !apiInitialized || apiTerminated) return '';
    var value = getScormValue(
      apiAdapter.is2004 ? 'cmi.learner_name' : 'cmi.core.student_name'
    );
    return String(value || '').slice(0, 256);
  }

  function emptySeatTimeOutbox() {
    return { version: SEAT_TIME_OUTBOX_VERSION, entries: [] };
  }

  function finiteSeatTimeNumber(value) {
    return typeof value === 'number' && isFinite(value) && value >= 0;
  }

  function seatTimeInteger(value) {
    return finiteSeatTimeNumber(value) && Math.floor(value) === value;
  }

  function validSeatTimeTimestamp(value) {
    if (typeof value !== 'string') return false;
    try {
      return new Date(value).toISOString() === value;
    } catch (e) {
      return false;
    }
  }

  function validSeatTimeOutboxEntry(entry, now) {
    return !!(
      entry &&
      entry.version === SEAT_TIME_OUTBOX_VERSION &&
      typeof entry.endpoint === 'string' &&
      entry.endpoint.length > 0 &&
      entry.endpoint.length <= 2048 &&
      !/\s/.test(entry.endpoint) &&
      isAllowedSeatTimeRelayUrl(entry.endpoint) &&
      typeof entry.courseId === 'string' &&
      entry.courseId.trim().length > 0 &&
      entry.courseId.length <= 256 &&
      validSeatTimeOpaqueId(entry.scopeToken, 'scope') &&
      validSeatTimeOpaqueId(entry.attemptId, 'attempt') &&
      seatTimeInteger(entry.revision) &&
      entry.revision > 0 &&
      seatTimeInteger(entry.activeSeconds) &&
      seatTimeInteger(entry.idleSeconds) &&
      seatTimeInteger(entry.totalSeconds) &&
      entry.activeSeconds <= entry.totalSeconds &&
      entry.idleSeconds === entry.totalSeconds - entry.activeSeconds &&
      typeof entry.completed === 'boolean' &&
      finiteSeatTimeNumber(entry.minRequiredMinutes) &&
      (
        (
          entry.completed === true &&
          validSeatTimeTimestamp(entry.completionTimestamp)
        ) ||
        (
          entry.completed === false &&
          entry.completionTimestamp === null
        )
      ) &&
      validSeatTimeTimestamp(entry.reportedAt) &&
      typeof entry.reason === 'string' &&
      entry.reason.length > 0 &&
      entry.reason.length <= 80 &&
      finiteSeatTimeNumber(entry.updatedAt) &&
      finiteSeatTimeNumber(entry.expiresAt) &&
      entry.expiresAt >= entry.updatedAt &&
      entry.expiresAt > now
    );
  }

  function seatTimeOutboxStorageKey(attemptId, revision) {
    return SEAT_TIME_OUTBOX_KEY_PREFIX + attemptId + '.' + revision;
  }

  function reportSeatTimeOutboxUnavailable() {
    if (seatTimeDeliveryDisabled) return;
    seatTimeDeliveryDisabled = true;
    emitTimegateEvent('seat_time_delivery_disabled', {
      reason: 'outbox_unavailable'
    });
  }

  function removeSeatTimeOutboxKey(ls, key) {
    try {
      ls.removeItem(key);
      return true;
    } catch (e) {
      reportSeatTimeOutboxUnavailable();
      return false;
    }
  }

  function readSeatTimeOutbox() {
    var ls = getLocalStorage();
    if (!ls) return emptySeatTimeOutbox();
    var now = Date.now();
    var records = [];
    var keysToRemove = [];
    try {
      for (var index = 0; index < ls.length; index++) {
        var key = ls.key(index);
        if (!key || key.indexOf(SEAT_TIME_OUTBOX_KEY_PREFIX) !== 0) continue;
        var entry = safeJsonParse(ls.getItem(key));
        if (
          !validSeatTimeOutboxEntry(entry, now) ||
          key !== seatTimeOutboxStorageKey(entry.attemptId, entry.revision)
        ) {
          keysToRemove.push(key);
          continue;
        }
        records.push({ key: key, entry: entry });
      }
    } catch (e) {
      reportSeatTimeOutboxUnavailable();
      return emptySeatTimeOutbox();
    }

    var latestByAttempt = {};
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      var current = latestByAttempt[record.entry.attemptId];
      if (!current || record.entry.revision > current.entry.revision) {
        if (current) keysToRemove.push(current.key);
        latestByAttempt[record.entry.attemptId] = record;
      } else {
        keysToRemove.push(record.key);
      }
    }
    var latestRecords = [];
    var attemptId;
    for (attemptId in latestByAttempt) {
      if (Object.prototype.hasOwnProperty.call(latestByAttempt, attemptId)) {
        latestRecords.push(latestByAttempt[attemptId]);
      }
    }
    latestRecords.sort(function (left, right) {
      return right.entry.updatedAt - left.entry.updatedAt;
    });
    var retained = [];
    for (var latestIndex = 0; latestIndex < latestRecords.length; latestIndex++) {
      if (retained.length >= SEAT_TIME_OUTBOX_MAX_ENTRIES) {
        keysToRemove.push(latestRecords[latestIndex].key);
        continue;
      }
      retained.push(latestRecords[latestIndex].entry);
    }
    for (var removeIndex = 0; removeIndex < keysToRemove.length; removeIndex++) {
      removeSeatTimeOutboxKey(ls, keysToRemove[removeIndex]);
    }
    return { version: SEAT_TIME_OUTBOX_VERSION, entries: retained };
  }

  function seatTimeScopeMatches(entry) {
    return !!(
      entry &&
      state &&
      entry.endpoint === config.seatTimeRelayUrl &&
      entry.courseId === config.courseId &&
      entry.scopeToken === state.seatTimeScopeToken
    );
  }

  function storeSeatTimeSnapshot(entry) {
    var ls = getLocalStorage();
    var serialized = safeJsonStringify(entry);
    if (!ls || !serialized) {
      reportSeatTimeOutboxUnavailable();
      return false;
    }
    try {
      ls.setItem(
        seatTimeOutboxStorageKey(entry.attemptId, entry.revision),
        serialized
      );
    } catch (e) {
      reportSeatTimeOutboxUnavailable();
      return false;
    }
    readSeatTimeOutbox();
    return true;
  }

  function clearSeatTimeSnapshot(attemptId, revision) {
    var ls = getLocalStorage();
    if (!ls) {
      reportSeatTimeOutboxUnavailable();
      return false;
    }
    return removeSeatTimeOutboxKey(
      ls,
      seatTimeOutboxStorageKey(attemptId, revision)
    );
  }

  function buildSeatTimePayload(entry) {
    var ownsTerminalEntry = !!(
      seatTimeTerminal &&
      seatTimeSegment &&
      entry &&
      seatTimeSegment.attemptId === entry.attemptId
    );
    if (
      !seatTimeScopeMatches(entry) ||
      !seatTimeIdentityVerified ||
      (!isPrimaryTab && !ownsTerminalEntry)
    ) return null;
    var learnerId = String(state.learnerKey || '');
    if (!learnerId || learnerId === 'unresolved') return null;
    var courseName = buildSeatTimeCourseName();
    var payload = {
      contractVersion: SEAT_TIME_CONTRACT_VERSION,
      relayKey: config.seatTimeRelayKey,
      employeeId: learnerId,
      employeeName: seatTimeLearnerName,
      course: courseName,
      courseId: config.courseId,
      enrollment: learnerId + ' | ' + courseName,
      activeSeconds: entry.activeSeconds,
      idleSeconds: entry.idleSeconds,
      totalSeconds: entry.totalSeconds,
      attemptId: entry.attemptId,
      revision: entry.revision,
      completed: entry.completed,
      minRequiredMinutes: entry.minRequiredMinutes,
      completionTimestamp: entry.completed && entry.completionTimestamp ?
        entry.completionTimestamp : null,
      reportedAt: entry.reportedAt,
      reason: entry.reason
    };
    return payload;
  }

  function scheduleSeatTimeRetry() {
    if (seatTimeRetryTimer !== null) return;
    seatTimeConsecutiveFailures += 1;
    var exponent = Math.min(4, seatTimeConsecutiveFailures - 1);
    var delay = Math.min(
      60000,
      SEAT_TIME_RETRY_DELAY_MS * Math.pow(2, exponent)
    );
    seatTimeRetryNotBeforeTs = Date.now() + delay;
    seatTimeRetryTimer = window.setTimeout(function () {
      seatTimeRetryTimer = null;
      seatTimeRetryNotBeforeTs = 0;
      runSeatTimeSafely(flushSeatTimeOutbox);
    }, delay);
  }

  function finishSeatTimeFetch(succeeded) {
    seatTimeTransportInFlight = null;
    if (succeeded) {
      seatTimeConsecutiveFailures = 0;
      seatTimeRetryNotBeforeTs = 0;
      runSeatTimeSafely(flushSeatTimeOutbox);
    } else {
      scheduleSeatTimeRetry();
    }
  }

  function startSeatTimeFetch(entry) {
    if (seatTimeTransportInFlight || typeof window.fetch !== 'function') {
      if (typeof window.fetch !== 'function') scheduleSeatTimeRetry();
      return;
    }
    var payload = buildSeatTimePayload(entry);
    var serialized = payload ? safeJsonStringify(payload) : null;
    if (!serialized) return;
    seatTimeTransportInFlight = true;
    var request;
    try {
      request = window.fetch(config.seatTimeRelayUrl, {
        method: 'POST',
        mode: 'cors',
        cache: 'no-store',
        credentials: 'omit',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: serialized,
        keepalive: serialized.length < 60000
      });
    } catch (e) {
      finishSeatTimeFetch(false);
      return;
    }
    window.Promise.resolve(request).then(function (response) {
      if (!response || response.ok !== true) throw new Error('seat_http');
      return response.json();
    }).then(function (json) {
      if (!json || json.ok !== true) {
        finishSeatTimeFetch(false);
        return;
      }
      finishSeatTimeFetch(
        clearSeatTimeSnapshot(entry.attemptId, entry.revision)
      );
    }, function () {
      finishSeatTimeFetch(false);
    });
  }

  function matchingSeatTimeEntries() {
    var outbox = readSeatTimeOutbox();
    var matches = [];
    for (var i = 0; i < outbox.entries.length; i++) {
      if (seatTimeScopeMatches(outbox.entries[i])) {
        matches.push(outbox.entries[i]);
      }
    }
    matches.sort(function (left, right) {
      return left.updatedAt - right.updatedAt;
    });
    return matches;
  }

  function flushSeatTimeOutbox() {
    if (
      !seatTimeEnabled() ||
      !seatTimeIdentityVerified ||
      !isPrimaryTab ||
      seatTimeTransportInFlight ||
      Date.now() < seatTimeRetryNotBeforeTs
    ) return;
    var entries = matchingSeatTimeEntries();
    if (entries.length) startSeatTimeFetch(entries[0]);
  }

  function sendSeatTimeBeacon(entry) {
    var payload = buildSeatTimePayload(entry);
    var serialized = payload ? safeJsonStringify(payload) : null;
    if (!serialized) return false;
    try {
      if (
        window.navigator &&
        typeof window.navigator.sendBeacon === 'function' &&
        typeof window.Blob === 'function'
      ) {
        return window.navigator.sendBeacon(
          config.seatTimeRelayUrl,
          new window.Blob([serialized], { type: 'text/plain;charset=UTF-8' })
        );
      }
    } catch (e) {
      // The stored revision remains pending for a later readable retry.
    }
    return false;
  }

  function currentSeatTimeDurations(timestamp) {
    var endTs = seatTimeSegment.endTs === null ?
      timestamp : seatTimeSegment.endTs;
    /*
     * sessionSeconds is Timegate's canonical per-launch active clock. It is
     * incremented by tick() while configured background grace remains active.
     */
    var activeClock = seatTimeSegment.activeEndSeconds === null ?
      Number(state.sessionSeconds || 0) :
      Number(seatTimeSegment.activeEndSeconds || 0);
    var measuredActive = Math.max(
      0,
      Math.floor(
        activeClock -
        Number(seatTimeSegment.activeStartSeconds || 0)
      )
    );
    var measuredTotal = Math.max(
      measuredActive,
      Math.floor(Math.max(0, endTs - seatTimeSegment.startedAt) / 1000)
    );
    var active = Math.max(
      measuredActive,
      Number(seatTimeSegment.maxActiveSeconds || 0)
    );
    var idle = Math.max(
      measuredTotal - measuredActive,
      Number(seatTimeSegment.maxIdleSeconds || 0)
    );
    seatTimeSegment.maxActiveSeconds = active;
    seatTimeSegment.maxIdleSeconds = idle;
    return {
      activeSeconds: active,
      idleSeconds: idle,
      totalSeconds: active + idle
    };
  }

  function checkpointSeatTime(reason, useBeacon) {
    if (
      !seatTimeEnabled() ||
      !seatTimeSegment ||
      !seatTimeIdentityVerified ||
      !state ||
      !state.seatTimeScopeToken
    ) return;
    var now = Date.now();
    var durations = currentSeatTimeDurations(now);
    var completed = !!(
      state.courseCompleteSent &&
      validSeatTimeTimestamp(seatTimeCompletionTimestamp)
    );
    seatTimeSegment.revision += 1;
    var entry = {
      version: SEAT_TIME_OUTBOX_VERSION,
      endpoint: config.seatTimeRelayUrl,
      courseId: config.courseId,
      scopeToken: state.seatTimeScopeToken,
      attemptId: seatTimeSegment.attemptId,
      revision: seatTimeSegment.revision,
      activeSeconds: durations.activeSeconds,
      idleSeconds: durations.idleSeconds,
      totalSeconds: durations.totalSeconds,
      completed: completed,
      minRequiredMinutes: Number(config.minRequiredMinutes) || 0,
      completionTimestamp: completed ? seatTimeCompletionTimestamp : null,
      reportedAt: new Date(now).toISOString(),
      reason: String(reason || 'checkpoint').slice(0, 80),
      updatedAt: now,
      expiresAt: now + SEAT_TIME_OUTBOX_TTL_MS
    };
    if (!storeSeatTimeSnapshot(entry)) return;
    lastSeatTimeCheckpointTs = now;
    if (useBeacon) {
      /* A queued Beacon is not an acknowledgement; leave this revision stored. */
      sendSeatTimeBeacon(entry);
    } else {
      flushSeatTimeOutbox();
    }
  }

  function startSeatTimeSegment(reason) {
    if (
      !seatTimeEnabled() ||
      !timerStarted ||
      seatTimeTerminal ||
      seatTimeSegment ||
      hasUnacknowledgedInactivityExitNotice()
    ) return;
    if (!seatTimeIdentityVerified) {
      if (!seatTimeProvisionalStart) {
        seatTimeProvisionalStart = {
          activeStartSeconds: Number(state.sessionSeconds || 0),
          startedAt: Date.now()
        };
      }
      return;
    }
    if (!isPrimaryTab) {
      seatTimeProvisionalStart = null;
      return;
    }
    var attemptId = createSeatTimeOpaqueId('attempt');
    if (!attemptId) return;
    var now = Date.now();
    var provisional = seatTimeProvisionalStart;
    seatTimeProvisionalStart = null;
    seatTimeSegment = {
      attemptId: attemptId,
      activeStartSeconds: provisional ?
        provisional.activeStartSeconds : Number(state.sessionSeconds || 0),
      activeEndSeconds: null,
      startedAt: provisional ? provisional.startedAt : now,
      endTs: null,
      maxActiveSeconds: 0,
      maxIdleSeconds: 0,
      revision: 0
    };
    checkpointSeatTime(reason || 'tracking-started', false);
    if (state.minMetAt) checkpointSeatTime('minimum-met', false);
  }

  function freezeSeatTimeSegment(reason, useBeacon, preserve) {
    if (!seatTimeSegment) {
      seatTimeProvisionalStart = null;
      return;
    }
    if (seatTimeSegment.endTs === null) {
      seatTimeSegment.endTs = Date.now();
      seatTimeSegment.activeEndSeconds = Number(state.sessionSeconds || 0);
    }
    checkpointSeatTime(reason, useBeacon);
    if (!preserve) seatTimeSegment = null;
  }

  function scheduleSeatTimeIdentityRetry() {
    seatTimeIdentityConsecutiveFailures += 1;
    var exponent = Math.min(5, seatTimeIdentityConsecutiveFailures - 1);
    seatTimeIdentityRetryNotBeforeTs = Date.now() + Math.min(
      60000,
      SEAT_TIME_IDENTITY_RETRY_DELAY_MS * Math.pow(2, exponent)
    );
  }

  function activateSeatTimeIdentity(reason) {
    if (
      !seatTimeEnabled() ||
      !apiInitialized ||
      apiTerminated ||
      !state ||
      !state.learnerKey ||
      state.learnerKey === 'unresolved'
    ) return;
    if (!isPrimaryTab) {
      seatTimeProvisionalStart = null;
      return;
    }
    if (hasUnacknowledgedInactivityExitNotice()) {
      seatTimeProvisionalStart = null;
      return;
    }
    if (seatTimeIdentityVerified) {
      startSeatTimeSegment(reason || 'identity-verified');
      flushSeatTimeOutbox();
      return;
    }
    if (Date.now() < seatTimeIdentityRetryNotBeforeTs) return;
    if (!validSeatTimeOpaqueId(state.seatTimeScopeToken, 'scope')) {
      state.seatTimeScopeToken = createSeatTimeOpaqueId('scope');
      seatTimeScopeDurable = false;
    }
    if (!state.seatTimeScopeToken) {
      scheduleSeatTimeIdentityRetry();
      return;
    }
    if (!seatTimeScopeDurable) {
      if (!persistState(true)) {
        scheduleSeatTimeIdentityRetry();
        return;
      }
      seatTimeScopeDurable = true;
    }
    seatTimeIdentityRetryNotBeforeTs = 0;
    seatTimeIdentityConsecutiveFailures = 0;
    seatTimeIdentityVerified = true;
    seatTimeLearnerName = readSeatTimeLearnerName();
    startSeatTimeSegment(reason || 'identity-verified');
    flushSeatTimeOutbox();
  }

  function observeSeatTimeOwnership(wasPrimary) {
    if (wasPrimary !== isPrimaryTab) {
      if (isPrimaryTab) {
        clearSupportIssue('SECONDARY_SESSION');
        recordSupportEvent('PRIMARY_SESSION_ACQUIRED', 'success', 'coordination');
      } else {
        markSupportIssue('SECONDARY_SESSION', 'warning', true);
        recordSupportEvent('SECONDARY_SESSION', 'warning', 'coordination');
      }
    }
    if (wasPrimary && !isPrimaryTab) {
      cancelAudioCuePlayback(false);
    }
    runSeatTimeSafely(function () {
      if (wasPrimary === isPrimaryTab) return;
      if (wasPrimary) {
        freezeSeatTimeSegment('lock-lost', false, false);
        return;
      }
      startSeatTimeSegment('lock-acquired');
    });
  }

  function confirmSeatTimeCompletion(reason) {
    if (!state || !state.courseCompleteSent) return;
    if (!seatTimeCompletionTimestamp) {
      seatTimeCompletionTimestamp = new Date().toISOString();
    }
    checkpointSeatTime(reason || 'completion-confirmed', false);
  }

  function resetSeatTimeCompletion(reason) {
    seatTimeCompletionTimestamp = null;
    checkpointSeatTime(reason || 'completion-reset', false);
  }

  function checkpointSeatTimePeriodically(timestamp) {
    if (
      !seatTimeSegment ||
      seatTimeSegment.endTs !== null ||
      timestamp - lastSeatTimeCheckpointTs < SEAT_TIME_CHECKPOINT_INTERVAL_MS
    ) return;
    checkpointSeatTime('periodic', false);
  }

  /* Locate SCORM API in window ancestry, opener, or child frames. */
  function findApi(win) {
    var maxDepth = 10;
    var visited = [];
    var trace = [];

    function describeWindow(target) {
      var info = { name: '', href: '', isTop: false };
      if (!target) return info;
      try {
        info.name = target.name || '';
      } catch (e) {
        // ignore
      }
      try {
        info.href = target.location && target.location.href ? target.location.href : '';
      } catch (e) {
        // ignore
      }
      try {
        info.isTop = target === target.top;
      } catch (e) {
        // ignore
      }
      return info;
    }

    function recordTrace(kind, context, target, extra) {
      if (!config || !config.debug) return;
      var info = describeWindow(target);
      trace.push({
        kind: kind,
        context: context || '',
        name: info.name,
        href: info.href,
        isTop: info.isTop,
        extra: extra || ''
      });
    }

    function wasVisited(target) {
      for (var i = 0; i < visited.length; i++) {
        if (visited[i] === target) return true;
      }
      return false;
    }

    function markVisited(target) {
      if (!target || wasVisited(target)) return false;
      visited.push(target);
      return true;
    }

    function checkWindow(target, context) {
      if (!target || !markVisited(target)) return null;
      try {
        if (target.API_1484_11) {
          recordTrace('found', context, target, '2004');
          return { api: target.API_1484_11, version: '2004' };
        }
        if (target.API) {
          recordTrace('found', context, target, '1.2');
          return { api: target.API, version: '1.2' };
        }
        recordTrace('checked', context, target, 'none');
      } catch (e) {
        recordTrace('blocked', context, target, 'cross-domain');
      }
      return null;
    }

    function scanParents(start) {
      var current = start;
      var depth = 0;
      while (current && depth++ < maxDepth) {
        var found = checkWindow(current, 'parent:' + depth);
        if (found) return found;
        try {
          if (current.parent && current.parent !== current) {
            current = current.parent;
            continue;
          }
        } catch (e) {
          // ignore cross-domain
        }
        break;
      }
      return null;
    }

    function scanChildren(start, depth) {
      if (!start || depth > maxDepth) return null;
      var frames;
      try {
        frames = start.frames;
      } catch (e) {
        recordTrace('blocked', 'children:' + depth, start, 'cross-domain');
        return null;
      }
      if (!frames || !frames.length) return null;
      for (var i = 0; i < frames.length; i++) {
        var child = frames[i];
        var found = checkWindow(child, 'child:' + depth + '.' + i);
        if (found) return found;
        found = scanChildren(child, depth + 1);
        if (found) return found;
      }
      return null;
    }

    var api = scanParents(win);
    if (api) {
      if (trace.length) log('SCORM API trace', trace);
      return api;
    }

    var opener = null;
    try {
      if (win.top && win.top.opener) opener = win.top.opener;
    } catch (e) {
      // ignore cross-domain
    }
    if (!opener) {
      try {
        if (win.opener) opener = win.opener;
      } catch (e) {
        // ignore cross-domain
      }
    }
    if (opener) {
      api = scanParents(opener);
      if (api) {
        if (trace.length) log('SCORM API trace', trace);
        return api;
      }
      api = scanChildren(opener, 0);
      if (api) {
        if (trace.length) log('SCORM API trace', trace);
        return api;
      }
    }

    api = scanChildren(win, 0);
    if (api) {
      if (trace.length) log('SCORM API trace', trace);
      return api;
    }

    if (trace.length) log('SCORM API trace', trace);

    return null;
  }

  function isTerminalStatusForVersion(is2004, element, value) {
    var el = String(element || '');
    var val = String(value || '').toLowerCase();
    if (is2004) {
      if (el === 'cmi.completion_status') return val === 'completed';
      if (el === 'cmi.success_status') {
        return val === 'passed' || val === 'failed';
      }
      return false;
    }
    return el === 'cmi.core.lesson_status' && (
      val === 'completed' || val === 'passed' || val === 'failed'
    );
  }

  function isNonterminalStatusForVersion(is2004, element, value) {
    var el = String(element || '');
    var val = String(value || '').toLowerCase();
    if (is2004) {
      if (el === 'cmi.completion_status') {
        return val === 'incomplete' || val === 'not attempted' || val === 'unknown';
      }
      if (el === 'cmi.success_status') return val === 'unknown';
      return false;
    }
    return el === 'cmi.core.lesson_status' && (
      val === 'incomplete' || val === 'not attempted' || val === 'browsed'
    );
  }

  function isCanonicalStatusForVersion(is2004, element) {
    var el = String(element || '');
    return is2004 ?
      el === 'cmi.completion_status' :
      el === 'cmi.core.lesson_status';
  }

  function objectHasKeys(value) {
    if (!value || typeof value !== 'object') return false;
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) return true;
    }
    return false;
  }

  /*
   * Install a minimal gate synchronously, before the asynchronous config read.
   * This closes the launch-order window where Rise could report completion and
   * terminate the LMS session before the full runtime was ready.
   */
  function installBootstrapGate() {
    var info = findApi(window);
    if (!info || !info.api) return null;
    var api = info.api;
    var is2004 = info.version === '2004';
    var method = {
      initialize: is2004 ? 'Initialize' : 'LMSInitialize',
      terminate: is2004 ? 'Terminate' : 'LMSFinish',
      getValue: is2004 ? 'GetValue' : 'LMSGetValue',
      getLastError: is2004 ? 'GetLastError' : 'LMSGetLastError',
      setValue: is2004 ? 'SetValue' : 'LMSSetValue'
    };
    if (typeof api[method.setValue] !== 'function') return null;

    var gate = {
      active: true,
      api: api,
      is2004: is2004,
      method: method,
      initialized: false,
      terminated: false,
      pendingScorm: {},
      pendingTerminate: null,
      original: {
        initialize:
          typeof api[method.initialize] === 'function' ?
            api[method.initialize].bind(api) : null,
        terminate:
          typeof api[method.terminate] === 'function' ?
            api[method.terminate].bind(api) : null,
        getValue:
          typeof api[method.getValue] === 'function' ?
            api[method.getValue].bind(api) : null,
        getLastError:
          typeof api[method.getLastError] === 'function' ?
            api[method.getLastError].bind(api) : null,
        setValue: api[method.setValue].bind(api)
      }
    };

    if (gate.original.initialize) {
      api[method.initialize] = function () {
        var result = gate.original.initialize.apply(api, arguments);
        if (scormCallSucceeded(result)) gate.initialized = true;
        return result;
      };
    }
    api[method.setValue] = function (element, value) {
      if (!gate.active) return gate.original.setValue(element, value);
      var el = String(element);
      if (isTerminalStatusForVersion(is2004, el, value)) {
        gate.pendingScorm[el] = value;
        emitTimegateEvent('completion_gated', {
          reason: 'runtime_initializing',
          completionStatus: String(value).slice(0, 40),
          canonicalCompletion: isCanonicalStatusForVersion(is2004, el),
          signalSource: 'scorm_set_value',
          success: true,
          activeSeconds: 0,
          idleSeconds: 0
        });
        return 'true';
      }
      if (isNonterminalStatusForVersion(is2004, el, value)) {
        var resetResult = gate.original.setValue(el, value);
        if (scormCallSucceeded(resetResult)) {
          delete gate.pendingScorm[el];
          emitTimegateEvent('completion_reset', {
            reason: 'status_reset',
            completionStatus: String(value).slice(0, 40),
            canonicalCompletion: isCanonicalStatusForVersion(is2004, el),
            activeSeconds: 0,
            idleSeconds: 0
          });
        }
        return resetResult;
      }
      if (
        bootstrapStorageMode !== 'localStorage' &&
        el === 'cmi.suspend_data' && value !== '' &&
        gate.original.getValue
      ) {
        // Rise can rewrite suspend_data before the asynchronous Timegate
        // configuration has loaded. Preserve the already stored checkpoint
        // on an LMS resume; the full runtime will validate its identity.
        var entry;
        var previous;
        try {
          entry = gate.original.getValue(
            is2004 ? 'cmi.entry' : 'cmi.core.entry'
          );
          if (
            !gate.original.getLastError ||
            String(gate.original.getLastError('')) !== '0'
          ) entry = null;
          if (String(entry).toLowerCase() === 'resume') {
            previous = gate.original.getValue('cmi.suspend_data');
            if (
              !gate.original.getLastError ||
              String(gate.original.getLastError('')) !== '0'
            ) previous = null;
          }
        } catch (e) {
          previous = null;
        }
        var oldContainer = previous ? safeJsonParse(previous) : null;
        var authoredContainer = safeJsonParse(String(value));
        if (
          oldContainer && typeof oldContainer === 'object' &&
          !Array.isArray(oldContainer) &&
          oldContainer[SUSPEND_DATA_KEY] &&
          authoredContainer && typeof authoredContainer === 'object' &&
          !Array.isArray(authoredContainer)
        ) {
          authoredContainer[SUSPEND_DATA_KEY] =
            oldContainer[SUSPEND_DATA_KEY];
          var merged = safeJsonStringify(authoredContainer);
          if (merged && merged.length <= 3800) {
            var mergedResult;
            try {
              mergedResult = gate.original.setValue(el, merged);
            } catch (e) {
              mergedResult = 'false';
            }
            if (scormCallSucceeded(mergedResult)) return mergedResult;
          }
        }
      }
      return gate.original.setValue(el, value);
    };
    if (gate.original.terminate) {
      api[method.terminate] = function () {
        if (gate.active && objectHasKeys(gate.pendingScorm)) {
          gate.pendingTerminate = Array.prototype.slice.call(arguments);
          emitTimegateEvent('termination_deferred', {
            reason: 'completion_pending',
            success: true,
            activeSeconds: 0,
            idleSeconds: 0
          });
          return 'true';
        }
        var result = gate.original.terminate.apply(api, arguments);
        if (scormCallSucceeded(result)) gate.terminated = true;
        return result;
      };
    }

    /*
     * A course can report completion and Finish before configuration finishes
     * loading. If the page then unloads, the full runtime has not installed its
     * lifecycle listener or durable state yet. End that LMS session without
     * forwarding the gated completion; otherwise the acknowledged Finish is
     * lost with the page.
     */
    window.addEventListener('pagehide', function (event) {
      if (
        !gate.active ||
        gate.terminated ||
        !gate.pendingTerminate ||
        !gate.original.terminate ||
        (event && event.persisted === true)
      ) return;

      var args = gate.pendingTerminate;
      var result;
      try {
        result = gate.original.terminate.apply(
          api,
          args.length ? args : ['']
        );
      } catch (e) {
        result = 'false';
      }
      if (scormCallSucceeded(result)) {
        gate.terminated = true;
        gate.initialized = false;
        gate.pendingTerminate = null;
        emitTimegateEvent('termination_completed', {
          reason: 'course',
          operation: method.terminate,
          activeSeconds: 0,
          idleSeconds: 0,
          success: true
        });
      } else {
        emitTimegateEvent('lms_operation_failed', {
          reason: 'course',
          operation: method.terminate
        });
      }
    }, true);
    return gate;
  }

  /* Create SCORM adapter and wrap Initialize if present. */
  function createApiAdapter() {
    var info = findApi(window);
    if (!info) {
      log('SCORM API not found');
      return null;
    }

    var api = info.api;
    var is2004 = info.version === '2004';
    var method = {
      initialize: is2004 ? 'Initialize' : 'LMSInitialize',
      terminate: is2004 ? 'Terminate' : 'LMSFinish',
      getValue: is2004 ? 'GetValue' : 'LMSGetValue',
      setValue: is2004 ? 'SetValue' : 'LMSSetValue',
      commit: is2004 ? 'Commit' : 'LMSCommit',
      getLastError: is2004 ? 'GetLastError' : 'LMSGetLastError',
    };

    if (!api[method.setValue]) {
      log('SCORM API missing SetValue');
      return null;
    }

    var boot = bootstrapGate && bootstrapGate.api === api ? bootstrapGate : null;
    var adapter = {
      api: api,
      is2004: is2004,
      method: method,
      original: {
        initialize:
          boot ? boot.original.initialize :
            (api[method.initialize] ? api[method.initialize].bind(api) : null),
        terminate:
          boot ? boot.original.terminate :
            (api[method.terminate] ? api[method.terminate].bind(api) : null),
        getValue: api[method.getValue] ? api[method.getValue].bind(api) : null,
        setValue: boot ? boot.original.setValue : api[method.setValue].bind(api),
        commit: api[method.commit] ? api[method.commit].bind(api) : null,
        getLastError: api[method.getLastError] ?
          api[method.getLastError].bind(api) : null,
      },
    };

    if (boot) {
      boot.active = false;
      apiInitialized = !!boot.initialized;
      apiTerminated = !!boot.terminated;
    }

    if (adapter.original.initialize) {
      api[method.initialize] = function () {
        var result = adapter.original.initialize.apply(api, arguments);
        var initializeSucceeded = scormCallSucceeded(result);
        if (!initializeSucceeded) {
          emitTimegateEvent('lms_operation_failed', {
            reason: 'initialize',
            operation: method.initialize,
            errorCode: captureSupportScormError()
          });
          return result;
        }
        apiInitialized = true;
        apiTerminated = false;
        supportRuntime.apiState = 'initialized';
        clearSupportIssue('LMS_INITIALIZATION_FAILED');
        refreshLearnerIdentity();
        if (pendingInitHydrate) {
          pendingInitHydrate = false;
          hydrateFromStorage();
        }
        syncCompletionFromLms('initialize');
        if (state.courseCompleteSent) completionAudioCueSent = true;
        if (isMaximumTimeReached()) {
          triggerMaximumTimeExit('hydrated');
          return result;
        }
        if (forceExitTriggered && forcedTerminationReason) {
          if (isPrimaryTab) {
            terminateLmsSession(forcedTerminationReason, ['']);
          } else {
            hideWalkBackOverlay();
          }
          return result;
        }
        if (typeof inactivityNoticeHydratedHandler === 'function') {
          inactivityNoticeHydratedHandler();
        }
        runSeatTimeSafely(function () {
          activateSeatTimeIdentity('identity-verified');
        });
        if (storage && (storage.type === 'suspend_data' || storage.type === 'dual')) {
          persistState(true);
        }
        replayPendingCompletion('initialize');
        return result;
      };
    }

    return adapter;
  }

  /* Wrap driver-level completion functions (Rise uses these). */
  function createDriverAdapter() {
    var names = ['SetReachedEnd', 'SetPassed', 'SetFailed', 'SetStatus'];
    var originals = {};
    var found = false;
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (typeof window[name] === 'function') {
        originals[name] = window[name].bind(window);
        found = true;
      }
    }
    if (!found) return null;
    return { originals: originals };
  }

  /* Read SCORM value safely. */
  function getScormValue(element) {
    if (
      !apiAdapter ||
      !apiAdapter.original.getValue ||
      !apiInitialized ||
      apiTerminated
    ) return '';
    try {
      return apiAdapter.original.getValue(element);
    } catch (e) {
      return '';
    }
  }

  /* Write SCORM value safely. */
  function setScormValue(element, value) {
    if (!apiAdapter || !apiInitialized || apiTerminated) return false;
    try {
      return scormCallSucceeded(apiAdapter.original.setValue(element, value));
    } catch (e) {
      return false;
    }
  }

  /* Commit SCORM data safely. */
  function commitScorm() {
    if (
      !apiAdapter ||
      !apiAdapter.original.commit ||
      !apiInitialized ||
      apiTerminated
    ) return false;
    try {
      return scormCallSucceeded(apiAdapter.original.commit(''));
    } catch (e) {
      return false;
    }
  }

  function captureSupportScormError() {
    var value = null;
    try {
      if (
        apiAdapter &&
        apiAdapter.original.getLastError &&
        !apiTerminated
      ) {
        value = apiAdapter.original.getLastError('');
      } else if (typeof window.intSCORMError !== 'undefined') {
        value = window.intSCORMError;
      }
    } catch (e) {
      value = null;
    }
    value = supportBoundedString(value, 8);
    supportRuntime.lastErrorCode =
      value && value !== '0' && /^\d{1,8}$/.test(value) ? value : null;
    return supportRuntime.lastErrorCode;
  }

  /* Derive a stable course key for storage. */
  function buildCourseKey() {
    if (config && config.courseKey) return config.courseKey;
    var title = '';
    try {
      if (typeof window.getCourseTitle === 'function') {
        title = window.getCourseTitle();
      } else {
        title = document.title || '';
      }
    } catch (e) {
      title = document.title || '';
    }
    var path =
      window.location && window.location.pathname ?
        window.location.pathname
      : '';
    var origin =
      window.location && window.location.origin ? window.location.origin : '';
    return origin + '|' + (path || 'course') + '|' + title;
  }

  /* Resolve learner identity only after the LMS accepts Initialize. */
  function buildLearnerKey() {
    if (!apiInitialized || apiTerminated) return null;
    var id = '';
    if (apiAdapter && apiAdapter.original.getValue) {
      if (apiAdapter.is2004) {
        id = getScormValue('cmi.learner_id');
      } else {
        id = getScormValue('cmi.core.student_id');
      }
    }
    id = String(id || '').trim();
    return id || null;
  }

  function readEntryMode() {
    if (!apiInitialized || apiTerminated) return '';
    var value = getScormValue(
      apiAdapter && apiAdapter.is2004 ? 'cmi.entry' : 'cmi.core.entry'
    );
    return String(value || '').toLowerCase();
  }

  function refreshLearnerIdentity() {
    if (!state || !apiInitialized || apiTerminated) return false;
    var resolved = buildLearnerKey();
    var learnerChanged = !!(resolved && state.learnerKey !== resolved);
    if (learnerChanged) {
      var previousLearnerKey = state.learnerKey;
      var changingResolvedLearner = !!(
        previousLearnerKey && previousLearnerKey !== 'unresolved'
      );
      if (changingResolvedLearner) {
        seatTimeSegment = null;
        seatTimeProvisionalStart = null;
      }
      state.seatTimeScopeToken = null;
      seatTimeScopeDurable = false;
      seatTimeIdentityVerified = false;
      seatTimeIdentityRetryNotBeforeTs = 0;
      seatTimeIdentityConsecutiveFailures = 0;
      seatTimeCompletionTimestamp = null;
      seatTimeLearnerName = '';
      // A pre-initialize inactivity exit still belongs to the identity just read.
      if (changingResolvedLearner) {
        state.inactivityExitNotice = null;
        acknowledgedInactivityExitAt = '';
      }
      state.learnerKey = resolved;
    }
    state.entryMode = readEntryMode();
    state.allowLocalFallback = !!(
      resolved && state.entryMode === 'resume'
    );
    state.storageKey =
      INSTANCE_KEY + '.v1.' + state.courseKey + '.' +
      (resolved || 'unresolved');
    lockKey = resolved ?
      INSTANCE_KEY + '.lock.' + state.courseKey + '.' + resolved : null;
    updateLock();
    if (learnerChanged) syncAudioCuePreferenceForLearner();
    return !!resolved;
  }

  /* Read Timegate payload from suspend_data. */
  function readSuspendData() {
    if (!apiAdapter) return null;
    var raw = getScormValue('cmi.suspend_data');
    if (config && config.debug) {
      log('Suspend_data read', {
        length: raw ? raw.length : 0,
        hasValue: !!raw,
      });
    }
    if (!raw) return null;
    var parsed = safeJsonParse(raw);
    if (config && config.debug) {
      log('Suspend_data parse', {
        json: !!parsed,
        hasTimegate: !!(parsed && parsed[SUSPEND_DATA_KEY])
      });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    if (!parsed[SUSPEND_DATA_KEY]) return null;
    return safeJsonStringify(parsed[SUSPEND_DATA_KEY]);
  }

  /* Preserve headroom in the LMS's small suspend_data budget. */
  function compactStateForSuspendData(serialized) {
    var payload = safeJsonParse(serialized);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    var notice = normalizeInactivityExitNotice(payload.inactivityExitNotice);
    delete payload.inactivityExitNotice;
    if (notice) {
      payload.inactivityExit = [
        Date.parse(notice.occurredAt),
        notice.thresholdSeconds
      ];
    } else {
      delete payload.inactivityExit;
    }
    var nullableKeys = [
      'maxAllowedSeconds',
      'minMetAt',
      'maxReachedAt',
      'pendingScorm',
      'pendingDriverCalls',
      'pendingTerminate'
    ];
    for (var i = 0; i < nullableKeys.length; i++) {
      if (payload[nullableKeys[i]] === null) delete payload[nullableKeys[i]];
    }
    // The completion queue is authoritative and must win the small SCORM 1.2
    // budget. Support diagnostics can be reconstructed from that queue and
    // canonical LMS readback after resume.
    delete payload.supportCompletion;
    return payload;
  }

  function recordSuspendDataFailure(reason, existingChars, attemptedChars, errorCode) {
    var persistence = supportRuntime.persistence;
    persistence.lmsFailureReason = reason;
    persistence.lmsExistingChars = existingChars;
    persistence.lmsAttemptedChars = attemptedChars;
    persistence.lmsErrorCode = errorCode || null;
  }

  function clearSuspendDataFailure() {
    recordSuspendDataFailure(null, null, null, null);
  }

  function prepareSuspendDataWrite(raw, serialized) {
    var existingChars = raw ? raw.length : 0;
    var container = {};
    if (raw) {
      var parsed = safeJsonParse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        container = parsed;
      } else {
        // Unsafe to overwrite unknown suspend_data format.
        return { reason: 'unsupported_format', existingChars: existingChars };
      }
    }
    var payload = compactStateForSuspendData(serialized);
    if (!payload) {
      return { reason: 'serialization_failed', existingChars: existingChars };
    }
    container[SUSPEND_DATA_KEY] = payload;
    var next = safeJsonStringify(container);
    if (!next) {
      return { reason: 'serialization_failed', existingChars: existingChars };
    }
    if (next.length > 3800 && payload.supportAttemptId) {
      // Preserve authored suspend_data and the completion queue even when the
      // optional cross-launch support correlation ID cannot fit.
      delete payload.supportAttemptId;
      next = safeJsonStringify(container);
      if (!next) {
        return { reason: 'serialization_failed', existingChars: existingChars };
      }
    }
    if (next.length > 3800) {
      return {
        reason: 'payload_too_large',
        existingChars: existingChars,
        attemptedChars: next.length
      };
    }
    return {
      value: next,
      existingChars: existingChars,
      attemptedChars: next.length
    };
  }

  /* Write Timegate payload into suspend_data namespace. */
  function writeSuspendData(serialized) {
    if (!apiAdapter) return false;
    // An empty GetValue result is also how some LMSs report a failed read.
    // Confirm the read before merging so an unavailable authored value is
    // never mistaken for an empty field and overwritten.
    var raw;
    try {
      if (!apiAdapter.original.getValue || !apiInitialized || apiTerminated) {
        recordSuspendDataFailure('read_failed', null, null, null);
        return false;
      }
      raw = apiAdapter.original.getValue('cmi.suspend_data');
    } catch (e) {
      recordSuspendDataFailure('read_failed', null, null, null);
      return false;
    }
    var readErrorCode = null;
    var readStatusConfirmed = false;
    if (apiAdapter.original.getLastError) {
      try {
        var readStatus = supportBoundedString(
          apiAdapter.original.getLastError(''), 8
        );
        if (readStatus && /^\d{1,8}$/.test(readStatus)) {
          readStatusConfirmed = true;
          if (readStatus !== '0') readErrorCode = readStatus;
        }
      } catch (e) {
        readStatusConfirmed = false;
      }
    }
    supportRuntime.lastErrorCode = readErrorCode;
    if (
      readErrorCode || typeof raw !== 'string' ||
      (raw === '' && !readStatusConfirmed)
    ) {
      recordSuspendDataFailure('read_failed', null, null, readErrorCode);
      return false;
    }
    var prepared = prepareSuspendDataWrite(raw, serialized);
    if (prepared.reason) {
      recordSuspendDataFailure(
        prepared.reason, prepared.existingChars,
        prepared.attemptedChars || null, null
      );
      return false;
    }
    if (!setScormValue('cmi.suspend_data', prepared.value)) {
      recordSuspendDataFailure(
        'set_value_failed', prepared.existingChars,
        prepared.attemptedChars, captureSupportScormError()
      );
      return false;
    }
    if (!commitScorm()) {
      recordSuspendDataFailure(
        'commit_failed', prepared.existingChars,
        prepared.attemptedChars, captureSupportScormError()
      );
      return false;
    }
    clearSuspendDataFailure();
    return true;
  }

  function persistedStateCandidate(serialized) {
    if (!serialized) return null;
    var parsed = safeJsonParse(serialized);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      parsed.version !== STATE_VERSION ||
      !state ||
      parsed.courseKey !== state.courseKey ||
      parsed.learnerKey !== state.learnerKey
    ) return null;
    var lastTickTs = Number(parsed.lastTickTs);
    if (!isFinite(lastTickTs) || lastTickTs < 0) lastTickTs = 0;
    var persistenceRevision = Number(parsed.persistenceRevision);
    if (
      !isFinite(persistenceRevision) ||
      Math.floor(persistenceRevision) !== persistenceRevision ||
      persistenceRevision < 0
    ) persistenceRevision = 0;
    return {
      serialized: serialized,
      persistenceRevision: persistenceRevision,
      lastTickTs: lastTickTs,
    };
  }

  /* Choose persistence backend (localStorage or suspend_data). */
  function createStorage() {
    var ls = getLocalStorage();
    var mode = resolveStorageMode();

    if (mode === 'dual' && ls && apiAdapter) {
      return {
        type: 'dual',
        get: function (key) {
          var scormVal = apiInitialized ? readSuspendData() : null;
          var localVal = null;
          if (state && state.allowLocalFallback && state.learnerKey) {
            try {
              localVal = ls.getItem(key);
            } catch (e) {
              localVal = null;
            }
          }
          var scormCandidate = persistedStateCandidate(scormVal);
          var localCandidate = persistedStateCandidate(localVal);
          // A partial write can leave either backend one revision behind.
          if (
            localCandidate &&
            (!scormCandidate ||
              localCandidate.persistenceRevision >
                scormCandidate.persistenceRevision ||
              (localCandidate.persistenceRevision ===
                scormCandidate.persistenceRevision &&
                localCandidate.lastTickTs > scormCandidate.lastTickTs))
          ) {
            if (storage) storage.lastGetSource = 'localStorage';
            return localCandidate.serialized;
          }
          if (scormCandidate) {
            if (storage) storage.lastGetSource = 'suspend_data';
            return scormCandidate.serialized;
          }
          if (localCandidate) {
            if (storage) storage.lastGetSource = 'localStorage';
            return localCandidate.serialized;
          }
          if (storage) storage.lastGetSource = 'suspend_data';
          return null;
        },
        set: function (key, value) {
          var localOk = false;
          if (state && state.learnerKey && state.learnerKey !== 'unresolved') {
            try {
              ls.setItem(key, value);
              localOk = true;
            } catch (e) {
              localOk = false;
            }
          }
          var sdOk = apiInitialized && !apiTerminated ?
            writeSuspendData(value) : false;
          if (storage) {
            storage.lastBrowserWriteOk = localOk;
            storage.lastLmsWriteOk = sdOk;
          }
          log('Persist', {
            backend: 'dual',
            localStorage: localOk,
            suspend_data: apiInitialized ? sdOk : 'deferred',
            bytes: value ? value.length : 0
          });
          return apiInitialized ? sdOk : false;
        },
      };
    }

    if (mode === 'suspend_data') {
      return {
        type: 'suspend_data',
        get: function (key) {
          if (storage) storage.lastGetSource = 'suspend_data';
          return readSuspendData();
        },
        set: function (key, value) {
          var ok = apiInitialized ? writeSuspendData(value) : false;
          log('Persist', {
            backend: 'suspend_data',
            ok: apiInitialized ? ok : false,
            reason: apiInitialized ? '' : 'api-not-initialized',
            bytes: value ? value.length : 0
          });
          return ok;
        },
      };
    }

    if (mode === 'localStorage') {
      return {
        type: 'localStorage',
        get: function (key) {
          if (
            !ls ||
            !state ||
            !state.allowLocalFallback ||
            !state.learnerKey ||
            state.learnerKey === 'unresolved'
          ) {
            return null;
          }
          try {
            if (storage) storage.lastGetSource = 'localStorage';
            return ls.getItem(key);
          } catch (e) {
            return null;
          }
        },
        set: function (key, value) {
          if (
            !ls || !state || !state.learnerKey ||
            state.learnerKey === 'unresolved'
          ) {
            log('Persist', {
              backend: 'localStorage',
              ok: false,
              bytes: value ? value.length : 0
            });
            return false;
          }
          try {
            ls.setItem(key, value);
            log('Persist', {
              backend: 'localStorage',
              ok: true,
              bytes: value ? value.length : 0
            });
            return true;
          } catch (e) {
            log('Persist', {
              backend: 'localStorage',
              ok: false,
              bytes: value ? value.length : 0
            });
            return false;
          }
        },
      };
    }

    if (mode === 'dual' && apiAdapter) {
      return {
        type: 'suspend_data',
        get: function (key) {
          if (storage) storage.lastGetSource = 'suspend_data';
          return readSuspendData();
        },
        set: function (key, value) {
          var ok = apiInitialized ? writeSuspendData(value) : false;
          log('Persist', {
            backend: 'suspend_data',
            ok: apiInitialized ? ok : false,
            reason: apiInitialized ? '' : 'api-not-initialized',
            bytes: value ? value.length : 0
          });
          return ok;
        },
      };
    }

    if (apiAdapter) {
      return {
        type: 'suspend_data',
        get: function (key) {
          if (storage) storage.lastGetSource = 'suspend_data';
          return readSuspendData();
        },
        set: function (key, value) {
          var ok = apiInitialized ? writeSuspendData(value) : false;
          log('Persist', {
            backend: 'suspend_data',
            ok: apiInitialized ? ok : false,
            reason: apiInitialized ? '' : 'api-not-initialized',
            bytes: value ? value.length : 0
          });
          return ok;
        },
      };
    }

    return {
      type: 'memory',
      get: function () {
        if (storage) storage.lastGetSource = 'memory';
        return null;
      },
      set: function () {
        return false;
      },
    };
  }

  /* Load persisted timer state into memory. */
  function hydrateFromStorage() {
    if (!storage) return false;
    var currentInactivityNotice = normalizeInactivityExitNotice(
      state.inactivityExitNotice
    );
    var raw = storage.get(state.storageKey);
    if (!raw) return false;
    var parsed = safeJsonParse(raw);
    if (!parsed || parsed.version !== STATE_VERSION) return false;
    if (parsed.courseKey !== state.courseKey) return false;
    if (parsed.learnerKey !== state.learnerKey) return false;
    // Only an LMS-declared resume may import state from an earlier launch.
    // Fresh/ab-initio launches must never inherit prior time or completion.
    if (state.entryMode !== 'resume') return false;
    var hydratedRevision = Number(parsed.persistenceRevision);
    if (
      isFinite(hydratedRevision) &&
      Math.floor(hydratedRevision) === hydratedRevision &&
      hydratedRevision > state.persistenceRevision
    ) {
      state.persistenceRevision = hydratedRevision;
    }

    var storedElapsed = Number(parsed.elapsedSeconds) || 0;
    if (!isFinite(storedElapsed) || storedElapsed < 0) storedElapsed = 0;
    if (storedElapsed > state.elapsedSeconds) {
      state.elapsedSeconds = storedElapsed;
    }
    if (
      !configurationBlocked &&
      !state.minMetAt &&
      storedElapsed >= state.minRequiredSeconds
    ) {
      state.minMetAt = parsed.minMetAt || new Date().toISOString();
    }
    if (typeof parsed.courseCompleteSent === 'boolean') {
      state.courseCompleteSent = parsed.courseCompleteSent;
      if (state.courseCompleteSent) completionAudioCueSent = true;
    }
    if (typeof parsed.courseCompletePending === 'boolean') {
      state.courseCompletePending = parsed.courseCompletePending;
    }
    if (
      validSupportUuid(parsed.supportAttemptId)
    ) {
      state.supportAttemptId = parsed.supportAttemptId;
      applyHydratedSupportCompletion(parsed.supportCompletion);
    }
    if (!state.pendingScorm && parsed.pendingScorm) {
      state.pendingScorm = parsed.pendingScorm;
    }
    if (
      !state.pendingDriverCalls &&
      parsed.pendingDriverCalls
    ) {
      state.pendingDriverCalls = parsed.pendingDriverCalls;
    }
    var hydratedInactivityNotice = null;
    if (
      parsed.courseKey === state.courseKey &&
      parsed.learnerKey === state.learnerKey &&
      state.entryMode === 'resume'
    ) {
      hydratedInactivityNotice = normalizeInactivityExitNotice(
        parsed.inactivityExitNotice || parsed.inactivityExit
      );
      if (
        hydratedInactivityNotice &&
        hydratedInactivityNotice.occurredAt === acknowledgedInactivityExitAt
      ) {
        hydratedInactivityNotice = null;
      }
    }
    state.inactivityExitNotice =
      forceExitTriggered &&
      forcedTerminationReason === 'inactivity' &&
      currentInactivityNotice ?
        currentInactivityNotice : hydratedInactivityNotice;
    if (
      !state.pendingTerminate &&
      parsed.pendingTerminate &&
      typeof parsed.pendingTerminate === 'object' &&
      typeof parsed.pendingTerminate.requestedAt === 'string'
    ) {
      var storedPendingReason = parsed.pendingTerminate.reason;
      var pendingReason = typeof storedPendingReason === 'string' ?
        normalizeTerminationReason(storedPendingReason) : '';
      if (
        pendingReason &&
        pendingReason !== 'inactivity' &&
        (pendingReason !== 'maximum' || isMaximumTimeReached())
      ) {
        state.pendingTerminate = buildPendingTerminate(
          pendingReason,
          parsed.pendingTerminate
        );
      }
    }
    if (parsed.learnerKey === state.learnerKey) {
      if (validSeatTimeOpaqueId(parsed.seatTimeScopeToken, 'scope')) {
        state.seatTimeScopeToken = parsed.seatTimeScopeToken;
        seatTimeScopeDurable = true;
      }
      seatTimeCompletionTimestamp =
        parsed.courseCompleteSent === true &&
        validSeatTimeTimestamp(parsed.seatTimeCompletionTimestamp) ?
          parsed.seatTimeCompletionTimestamp : null;
    }
    if (isMaximumTimeReached()) {
      state.elapsedSeconds = state.maxAllowedSeconds;
      state.maxReachedAt = parsed.maxReachedAt || new Date().toISOString();
    } else {
      state.maxReachedAt = null;
    }

    supportRuntime.hydratedFrom = storage.lastGetSource || storage.type || 'none';
    if (
      supportRuntime.hydratedFrom === 'suspend_data' &&
      state.courseCompletePending
    ) {
      supportRuntime.completion.pendingDurableInLms = true;
    }

    log('Hydrated state', state);
    log('Hydrated from', storage.lastGetSource || storage.type || 'unknown');
    return true;
  }

  function buildPersistedStatePayload(now) {
    var payload = {
      version: STATE_VERSION,
      persistenceRevision: state.persistenceRevision,
      courseKey: state.courseKey,
      learnerKey: state.learnerKey,
      elapsedSeconds: Math.floor(state.elapsedSeconds || 0),
      minRequiredSeconds: state.minRequiredSeconds,
      maxAllowedSeconds: state.maxAllowedSeconds,
      minMetAt: state.minMetAt,
      maxReachedAt: state.maxReachedAt,
      lastTickTs: now,
      courseCompleteSent: !!state.courseCompleteSent,
      courseCompletePending: !!state.courseCompletePending,
      pendingScorm: state.pendingScorm || null,
      pendingDriverCalls: state.pendingDriverCalls || null,
      pendingTerminate: state.pendingTerminate || null,
      inactivityExitNotice:
        normalizeInactivityExitNotice(state.inactivityExitNotice),
      supportAttemptId: state.supportAttemptId,
      supportCompletion: copySupportCompletionState(supportRuntime.completion),
    };
    var shouldPersistSeatTimeState =
      seatTimeConfigValid ||
      validSeatTimeOpaqueId(state.seatTimeScopeToken, 'scope') ||
      validSeatTimeTimestamp(seatTimeCompletionTimestamp);
    if (shouldPersistSeatTimeState) {
      payload.seatTimeScopeToken = state.seatTimeScopeToken || null;
      payload.seatTimeCompletionTimestamp =
        state.courseCompleteSent &&
        validSeatTimeTimestamp(seatTimeCompletionTimestamp) ?
          seatTimeCompletionTimestamp : null;
    }

    return payload;
  }

  /* Persist current state at a controlled cadence. */
  function persistState(force) {
    if (!storage || !state) return false;
    supportRuntime.persistence.lastAttemptAt = new Date().toISOString();
    if (lockKey && !isPrimaryTab) {
      if (!persistenceFailureActive) {
        persistenceFailureActive = true;
        emitTimegateEvent('persistence_failed', {
          reason: 'secondary_tab',
          backend: storage.type || 'unknown',
          activeSeconds: Math.floor(state.elapsedSeconds || 0),
          idleSeconds: currentObservedIdleSeconds(Date.now())
        });
      }
      return false;
    }
    var now = Date.now();
    if (!force && now - lastPersistTs < PERSIST_INTERVAL_MS) return true;
    state.persistenceRevision += 1;
    var serialized = safeJsonStringify(buildPersistedStatePayload(now));
    if (!serialized) return false;
    var ok = storage.set(state.storageKey, serialized);
    if (storage.type === 'dual') {
      supportRuntime.persistence.browserState =
        storage.lastBrowserWriteOk === true ? 'written' : 'failed';
      supportRuntime.persistence.lmsState =
        storage.lastLmsWriteOk === true ? 'written' : 'failed';
    } else if (storage.type === 'localStorage') {
      supportRuntime.persistence.browserState = ok ? 'written' : 'failed';
      supportRuntime.persistence.lmsState = 'not_applicable';
    } else if (storage.type === 'suspend_data') {
      supportRuntime.persistence.browserState = 'not_applicable';
      supportRuntime.persistence.lmsState = ok ? 'written' : 'failed';
    } else {
      supportRuntime.persistence.browserState = 'unavailable';
      supportRuntime.persistence.lmsState = 'unavailable';
    }
    if (ok) {
      var recovered = persistenceFailureActive;
      lastPersistTs = now;
      persistenceFailureActive = false;
      supportRuntime.persistence.lastSuccessAt = new Date().toISOString();
      if (
        state.courseCompletePending &&
        (storage.type === 'suspend_data' || storage.type === 'dual')
      ) {
        supportRuntime.completion.pendingDurableInLms =
          supportRuntime.persistence.lmsState === 'written';
      } else if (!state.courseCompletePending) {
        supportRuntime.completion.pendingDurableInLms = false;
      }
      if (recovered) {
        emitTimegateEvent('persistence_recovered', {
          reason: 'write_succeeded',
          backend: storage.type || 'unknown',
          activeSeconds: Math.floor(state.elapsedSeconds || 0),
          idleSeconds: currentObservedIdleSeconds(now)
        });
      }
    } else {
      var deferredUntilInitialize = !!(
        !apiInitialized && apiAdapter
      );
      if (!deferredUntilInitialize && !persistenceFailureActive) {
        persistenceFailureActive = true;
        emitTimegateEvent('persistence_failed', {
          reason: 'write_failed',
          backend: storage.type || 'unknown',
          activeSeconds: Math.floor(state.elapsedSeconds || 0),
          idleSeconds: currentObservedIdleSeconds(now)
        });
      }
    }
    return !!ok;
  }

  /* Determine if time should accrue right now. */
  function getPauseReason() {
    var now = Date.now();
    var idleLimit = (config.idleTimeoutSeconds || 60) * 1000;
    var backgroundGraceMs = (config.backgroundGraceSeconds || 0) * 1000;
    var idle = now - lastActivityTs > idleLimit;
    var isForeground = true;

    if (document.hidden) isForeground = false;
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) isForeground = false;
    if (!isPrimaryTab) isForeground = false;

    if (!isForeground) {
      if (backgroundSinceTs === null) {
        backgroundSinceTs = now;
      }
      if (now - backgroundSinceTs > backgroundGraceMs) {
        return 'background';
      }
    } else {
      backgroundSinceTs = null;
    }

    if (idle) {
      if (config.countWhileMediaPlaying && mediaPlaying) {
        return '';
      }
      return 'inactivity';
    }
    return '';
  }

  function isActive() {
    return !getPauseReason();
  }

  /* Enforce single active tab using a storage lock. */
  function updateLock() {
    var ls = getLocalStorage();
    var wasPrimary = isPrimaryTab;
    var now = Date.now();
    if (!lockKey || !ls) {
      isPrimaryTab = true;
      observeSeatTimeOwnership(wasPrimary);
      return;
    }
    var raw = null;
    try { raw = ls.getItem(lockKey); } catch (e) { raw = null; }
    var parsed = raw ? safeJsonParse(raw) : null;
    if (!parsed || !parsed.tabId || now - parsed.ts > LOCK_TTL_MS) {
      try {
        ls.setItem(lockKey, safeJsonStringify({ tabId: tabId, ts: now }));
      } catch (e) {
        isPrimaryTab = true;
        observeSeatTimeOwnership(wasPrimary);
        return;
      }
      isPrimaryTab = true;
      if (!wasPrimary && state && storage) {
        var previousLocalFallback = state.allowLocalFallback;
        state.allowLocalFallback = state.entryMode === 'resume';
        hydrateFromStorage();
        state.allowLocalFallback = previousLocalFallback;
      }
      if (
        !wasPrimary &&
        typeof inactivityNoticeHydratedHandler === 'function'
      ) {
        inactivityNoticeHydratedHandler();
      }
      observeSeatTimeOwnership(wasPrimary);
      return;
    }
    if (parsed.tabId === tabId) {
      try {
        ls.setItem(lockKey, safeJsonStringify({ tabId: tabId, ts: now }));
      } catch (e) {
        // Keep the current lock decision for this tick.
      }
      isPrimaryTab = true;
      observeSeatTimeOwnership(wasPrimary);
      return;
    }
    isPrimaryTab = false;
    observeSeatTimeOwnership(wasPrimary);
  }

  function releaseLock() {
    if (!lockKey) return;
    var ls = getLocalStorage();
    if (!ls) return;
    try {
      var current = safeJsonParse(ls.getItem(lockKey));
      if (current && current.tabId === tabId) ls.removeItem(lockKey);
    } catch (e) {
      // The lock expires automatically if storage is unavailable during exit.
    }
  }

  /* Return true if any video/audio element in a document is playing. */
  function docHasPlayingMedia(doc) {
    if (!doc) return false;
    var media;
    try {
      media = doc.querySelectorAll('video, audio');
    } catch (e) {
      return false;
    }
    for (var i = 0; i < media.length; i++) {
      var el = media[i];
      try {
        if (!el.paused && !el.ended && el.readyState >= 2) {
          return true;
        }
      } catch (e) {
        // ignore individual element errors
      }
    }
    return false;
  }

  /* Recursively scan a window and its same-origin frames for playing media. */
  function windowHasPlayingMedia(win, depth) {
    if (!win || depth > 6) return false;
    var doc;
    try {
      doc = win.document;
    } catch (e) {
      return false; // cross-origin frame; cannot inspect
    }
    if (docHasPlayingMedia(doc)) return true;
    var frames;
    try {
      frames = win.frames;
    } catch (e) {
      return false;
    }
    if (!frames || !frames.length) return false;
    for (var i = 0; i < frames.length; i++) {
      try {
        if (windowHasPlayingMedia(frames[i], depth + 1)) return true;
      } catch (e) {
        // ignore cross-origin child
      }
    }
    return false;
  }

  /*
   * Detect active media playback. Rise nests its content (and video) in one or
   * more iframes, so we scan the top window and every same-origin frame, not
   * just the single bound iframe document. The bound iframeDoc is checked as a
   * fallback in case frame traversal misses it.
   */
  function updateMediaPlaying() {
    if (!config.countWhileMediaPlaying) {
      mediaPlaying = false;
      return;
    }
    var playing = false;
    try {
      playing = windowHasPlayingMedia(window, 0);
    } catch (e) {
      playing = false;
    }
    if (!playing && iframeDoc) {
      playing = docHasPlayingMedia(iframeDoc);
    }
    mediaPlaying = playing;
  }

  /*
   * Forward-skip prevention. Mirrors the "restrict seeking" behavior an author
   * can set on a Rise video block, but applies it at runtime so it holds even
   * when the author forgot. For each video we track the furthest point actually
   * watched and silently clamp any forward seek back to it; rewinding to
   * re-watch is always allowed. Works for plain MP4 and HLS alike because it
   * operates on the element's currentTime. Same-origin only — a cross-origin
   * embedded player cannot be controlled.
   */
  var SEEK_TOLERANCE_S = 0.75;

  function guardVideoSeek(video) {
    if (!video || video.__timegateSeekGuarded) return;
    video.__timegateSeekGuarded = true;
    // Seed the watermark from the current position so a legitimate resume
    // (Rise restoring a saved spot) is not yanked back to zero.
    var maxWatched = video.currentTime || 0;
    video.addEventListener('timeupdate', function () {
      if (!video.seeking && video.currentTime > maxWatched) {
        maxWatched = video.currentTime;
      }
    });
    var clamp = function () {
      try {
        if (video.currentTime > maxWatched + SEEK_TOLERANCE_S) {
          video.currentTime = maxWatched;
        }
      } catch (e) {
        // ignore element errors
      }
    };
    video.addEventListener('seeking', clamp);
    video.addEventListener('seeked', clamp);
    log('seek guard attached to a video element');
  }

  /* Attach the seek guard to every video element in a document. */
  function guardDocVideos(doc) {
    if (!doc) return;
    var vids;
    try {
      vids = doc.querySelectorAll('video');
    } catch (e) {
      return;
    }
    for (var i = 0; i < vids.length; i++) {
      try {
        guardVideoSeek(vids[i]);
      } catch (e) {
        // ignore individual element errors
      }
    }
  }

  /* Recursively guard videos in a window and its same-origin frames. */
  function guardWindowVideos(win, depth) {
    if (!win || depth > 6) return;
    var doc;
    try {
      doc = win.document;
    } catch (e) {
      if (depth > 0) log('cross-origin frame; cannot disable video skip there');
      return;
    }
    guardDocVideos(doc);
    var frames;
    try {
      frames = win.frames;
    } catch (e) {
      return;
    }
    if (!frames || !frames.length) return;
    for (var i = 0; i < frames.length; i++) {
      try {
        guardWindowVideos(frames[i], depth + 1);
      } catch (e) {
        // ignore cross-origin child
      }
    }
  }

  /*
   * Find and guard any not-yet-guarded videos. Run on the same periodic scan as
   * media detection so videos that load as the learner navigates (Rise loads
   * lessons on demand) are picked up shortly after they appear.
   */
  function updateVideoSeekGuards() {
    if (!config.disableVideoSkip) return;
    try {
      guardWindowVideos(window, 0);
    } catch (e) {
      // ignore
    }
    if (iframeDoc) guardDocVideos(iframeDoc);
  }

  /* Mark recent user activity. */
  function trackActivity(event) {
    lastActivityTs = Date.now();
    if (
      event &&
      event.isTrusted &&
      event.type !== 'mousemove' &&
      event.type !== 'wheel' &&
      audioCuesUserEnabled &&
      (
        !audioPlaybackReady ||
        !audioContext ||
        audioContext.state === 'suspended'
      )
    ) {
      unlockAudioCuePlayback(false);
    }
  }

  function handleVisibilityChange() {
    var now = Date.now();
    if (document.hidden) {
      cancelAudioCuePlayback(false);
      if (backgroundSinceTs === null) backgroundSinceTs = now;
      runSeatTimeSafely(function () {
        checkpointSeatTime('hidden', false);
      });
    } else {
      /* Do not treat returning to a frozen/background tab as learner activity. */
      lastTickTs = now;
    }
  }

  /* Attach activity listeners to a document. */
  function attachActivityListeners(doc) {
    if (!doc) return;
    var events = [
      'mousemove',
      'mousedown',
      'keydown',
      'touchstart',
      'pointerdown',
      'wheel',
    ];
    for (var i = 0; i < events.length; i++) {
      doc.addEventListener(events[i], trackActivity, true);
    }
  }

  /* Bind to course iframe and wire activity tracking. */
  function attachIframeListeners() {
    var iframe =
      document.getElementById('content-frame') ||
      document.querySelector('iframe[name="scormdriver_content"]');
    if (!iframe) return;

    iframe.addEventListener('load', function () {
      try {
        iframeDoc = iframe.contentWindow.document;
        attachActivityListeners(iframeDoc);
      } catch (e) {
        iframeDoc = null;
      }
    });

    try {
      if (iframe.contentWindow && iframe.contentWindow.document) {
        iframeDoc = iframe.contentWindow.document;
        attachActivityListeners(iframeDoc);
      }
    } catch (e) {
      iframeDoc = null;
    }
  }

  /* Check if a SCORM element/value is a terminal reporting status. */
  function isCompletionElement(element, value) {
    return !!(
      apiAdapter &&
      isTerminalStatusForVersion(apiAdapter.is2004, element, value)
    );
  }

  function isNonterminalCompletionElement(element, value) {
    return !!(
      apiAdapter &&
      isNonterminalStatusForVersion(apiAdapter.is2004, element, value)
    );
  }

  function isCanonicalCompletionElement(element) {
    if (!apiAdapter) return false;
    return isCanonicalStatusForVersion(apiAdapter.is2004, element);
  }

  function isCompletionValue(value) {
    if (value === null || typeof value === 'undefined') return false;
    var val = String(value).toLowerCase();
    return val === 'completed' || val === 'passed' || val === 'failed';
  }

  function readCompletionFromLms(requestedStatus) {
    if (!apiAdapter || !apiAdapter.original.getValue) return null;
    if (apiAdapter.is2004) {
      var completion = getScormValue('cmi.completion_status');
      supportRuntime.canonicalStatus = normalizeSupportCanonicalStatus(completion);
      if (requestedStatus) {
        return supportReadbackMatchesRequest(
          supportRuntime.canonicalStatus,
          requestedStatus
        );
      }
      if (supportRuntime.canonicalStatus === 'completed') return true;
      if (completion) return false;
      return null;
    }
    var status = getScormValue('cmi.core.lesson_status');
    supportRuntime.canonicalStatus = normalizeSupportCanonicalStatus(status);
    if (requestedStatus) {
      return supportReadbackMatchesRequest(
        supportRuntime.canonicalStatus,
        requestedStatus
      );
    }
    if (isCompletionValue(supportRuntime.canonicalStatus)) return true;
    if (status) return false;
    return null;
  }

  function syncCompletionFromLms(source) {
    var completed = readCompletionFromLms();
    if (completed === true) {
      if (!supportRuntime.completion.courseSignalObserved) {
        observeSupportCompletionRequest(
          'lms_readback',
          supportRuntime.canonicalStatus,
          new Date().toISOString()
        );
      }
      supportRuntime.completion.deliveryState = 'confirmed';
      supportRuntime.completion.lastReadbackStatus = supportRuntime.canonicalStatus;
      state.courseCompleteSent = true;
      if (!objectHasKeys(state.pendingScorm)) state.pendingScorm = null;
      updateCompletionPendingFlag();
      if (state.minMetAt && !state.courseCompletePending) {
        finalizeConfirmedCompletion();
      }
      log('Completion sync', source || 'unknown');
      runSeatTimeSafely(function () {
        confirmSeatTimeCompletion('completion-confirmed');
      });
      persistState(true);
    } else if (completed === false) {
      var wasPreviouslyComplete = !!state.courseCompleteSent;
      var hadCompletionTimestamp = !!seatTimeCompletionTimestamp;
      state.courseCompleteSent = false;
      if (
        wasPreviouslyComplete ||
        supportRuntime.completion.deliveryState === 'confirmed'
      ) {
        emitTimegateEvent('completion_reset', {
          reason: 'lms_readback_reset',
          completionStatus: supportRuntime.canonicalStatus || 'unknown',
          canonicalCompletion: true,
          activeSeconds: Math.floor(state.elapsedSeconds || 0),
          idleSeconds: currentObservedIdleSeconds(Date.now())
        });
      }
      if (wasPreviouslyComplete || hadCompletionTimestamp) {
        runSeatTimeSafely(function () {
          resetSeatTimeCompletion('completion-reset');
        });
        persistState(true);
      }
    }
  }

  function updateCompletionPendingFlag() {
    if (!state) return;
    state.courseCompletePending = !!(
      objectHasKeys(state.pendingScorm) ||
      (state.pendingDriverCalls && state.pendingDriverCalls.length)
    );
  }

  function completionGateOpen() {
    return !!(
      state &&
      isPrimaryTab &&
      !configurationBlocked &&
      state.minMetAt &&
      !isMaximumTimeReached()
    );
  }

  function queueScormStatus(element, value) {
    if (!state.pendingScorm) state.pendingScorm = {};
    state.pendingScorm[String(element)] = value;
    updateCompletionPendingFlag();
  }

  function clearPendingCompletion() {
    state.pendingScorm = null;
    state.pendingDriverCalls = null;
    state.courseCompletePending = false;
  }

  function resetPendingScormStatus(element, value) {
    var canonical = isCanonicalCompletionElement(element);
    if (state.pendingScorm) {
      delete state.pendingScorm[element];
      if (!objectHasKeys(state.pendingScorm)) state.pendingScorm = null;
    }
    if (canonical) {
      state.pendingDriverCalls = null;
      state.courseCompleteSent = false;
      runSeatTimeSafely(function () {
        resetSeatTimeCompletion('completion-reset');
      });
    }
    updateCompletionPendingFlag();
    persistState(true);
    emitTimegateEvent('completion_reset', {
      reason: 'status_reset',
      completionStatus: String(value).slice(0, 40),
      canonicalCompletion: canonical,
      activeSeconds: Math.floor(state.elapsedSeconds || 0),
      idleSeconds: currentObservedIdleSeconds(Date.now())
    });
  }

  /* Check if a driver function call implies completion. */
  function isDriverCompletion(name, args) {
    if (name === 'SetReachedEnd' || name === 'SetPassed' || name === 'SetFailed') {
      return true;
    }
    if (name === 'SetStatus') {
      var val = args && args.length ? args[0] : null;
      if (typeof val === 'string') {
        var norm = val.toLowerCase();
        return norm === 'completed' || norm === 'passed' || norm === 'failed';
      }
      if (typeof val === 'number') {
        if (typeof window.LESSON_STATUS_PASSED !== 'undefined' && val === window.LESSON_STATUS_PASSED) return true;
        if (typeof window.LESSON_STATUS_COMPLETED !== 'undefined' && val === window.LESSON_STATUS_COMPLETED) return true;
        if (typeof window.LESSON_STATUS_FAILED !== 'undefined' && val === window.LESSON_STATUS_FAILED) return true;
      }
    }
    return false;
  }

  function isDriverReset(name, args) {
    if (name !== 'SetStatus') return false;
    var value = args && args.length ? args[0] : null;
    if (typeof value === 'string') {
      var normalized = value.toLowerCase();
      return normalized === 'incomplete' ||
        normalized === 'not attempted' ||
        normalized === 'unknown' ||
        normalized === 'browsed';
    }
    if (typeof value !== 'number') return false;
    var resetConstants = [
      'LESSON_STATUS_INCOMPLETE',
      'LESSON_STATUS_NOT_ATTEMPTED',
      'LESSON_STATUS_BROWSED'
    ];
    for (var i = 0; i < resetConstants.length; i++) {
      if (
        typeof window[resetConstants[i]] !== 'undefined' &&
        value === window[resetConstants[i]]
      ) return true;
    }
    return false;
  }

  function driverCallSucceeded(result) {
    if (result === false || result === 0) return false;
    return !(
      typeof result === 'string' && result.toLowerCase() === 'false'
    );
  }

  function confirmDriverCompletion(driverSucceeded, requestedStatus) {
    if (!driverSucceeded) {
      return {
        confirmed: false,
        committed: false,
        readbackStatus: null,
        succeeded: false
      };
    }
    if (!apiAdapter) {
      return {
        confirmed: false,
        committed: false,
        readbackStatus: null,
        succeeded: false
      };
    }
    var committed = commitScorm();
    var confirmed = committed &&
      readCompletionFromLms(requestedStatus) === true;
    return {
      confirmed: confirmed,
      committed: committed,
      readbackStatus: supportRuntime.canonicalStatus,
      succeeded: confirmed && committed
    };
  }

  /* Rise rewrites the whole field from its cache. Keep our sibling checkpoint
   * with each authored write when it fits; never sacrifice course progress. */
  function writeAuthoredSuspendData(element, value, original) {
    // Rise may intentionally clear the field when resetting its learner data.
    // Preserve that exact operation; a later Timegate save can checkpoint the
    // current timer without restoring the discarded course data.
    if (value === '') return original(element, value);
    if (
      !state || !storage || !apiInitialized || !isPrimaryTab ||
      state.learnerKey === 'unresolved' ||
      (storage.type !== 'dual' && storage.type !== 'suspend_data')
    ) return original(element, value);

    var serialized = safeJsonStringify(buildPersistedStatePayload(Date.now()));
    var prepared = serialized ?
      prepareSuspendDataWrite(String(value == null ? '' : value), serialized) :
      { reason: 'serialization_failed' };
    if (prepared.value) {
      var mergedResult;
      try {
        mergedResult = original(element, prepared.value);
      } catch (e) {
        mergedResult = 'false';
      }
      if (scormCallSucceeded(mergedResult)) return mergedResult;
    }

    // A full or unsupported field still belongs to the authored course.
    // Retry its exact value, then record the Timegate save outcome separately.
    var authoredResult = original(element, value);
    if (scormCallSucceeded(authoredResult)) persistState(true);
    return authoredResult;
  }

  /* Intercept SCORM SetValue to gate completion. */
  function wrapScormSetValue() {
    if (!apiAdapter) return;
    var methodName = apiAdapter.method.setValue;
    var original = apiAdapter.original.setValue;

    apiAdapter.api[methodName] = function (element, value) {
      var el = String(element);
      var isCompletion = isCompletionElement(el, value);
      var isReset = isNonterminalCompletionElement(el, value);

      if (apiTerminated) {
        if (isCompletion) {
          emitTimegateEvent('completion_gated', {
            reason: 'lms_session_terminated',
            completionStatus: String(value).slice(0, 40),
            canonicalCompletion: isCanonicalCompletionElement(el),
            signalSource: 'scorm_set_value',
            success: false,
            activeSeconds: Math.floor(state.elapsedSeconds || 0),
            idleSeconds: currentObservedIdleSeconds(Date.now())
          });
          return 'false';
        }
        return original(el, value);
      }

      if (el === 'cmi.suspend_data') {
        return writeAuthoredSuspendData(el, value, original);
      }

      if (isMaximumTimeReached() && isCompletion) {
        triggerMaximumTimeExit('completion_call');
        emitTimegateEvent('completion_gated', {
          reason: 'maximum_time_reached',
          completionStatus: String(value).slice(0, 40),
          canonicalCompletion: isCanonicalCompletionElement(el),
          signalSource: 'scorm_set_value',
          success: false,
          activeSeconds: Math.floor(state.elapsedSeconds || 0),
          idleSeconds: currentObservedIdleSeconds(Date.now())
        });
        return 'false';
      }

      if (isReset) {
        var resetResult = original(el, value);
        if (scormCallSucceeded(resetResult)) {
          resetPendingScormStatus(el, value);
          replayPendingTerminate('status_reset');
        }
        return resetResult;
      }

      if (
        config.enforceCompletion &&
        !replayingScorm &&
        !completionGateOpen() &&
        isCompletion
      ) {
        queueScormStatus(el, value);
        var queuedDurably = persistState(true);
        log('Gated completion status', el, value);
        emitTimegateEvent('completion_gated', {
          reason: configurationBlocked ?
            'configuration_error' : 'minimum_time_not_met',
          completionStatus:
            typeof value === 'string' ? value.slice(0, 40) : '',
          canonicalCompletion: isCanonicalCompletionElement(el),
          signalSource: 'scorm_set_value',
          success: queuedDurably && !configurationBlocked,
          activeSeconds: Math.floor(state.elapsedSeconds || 0),
          idleSeconds: currentObservedIdleSeconds(Date.now())
        });
        return queuedDurably && !configurationBlocked ? 'true' : 'false';
      }
      if (isCompletion) {
        var canonicalCompletion = isCanonicalCompletionElement(el);
        if (canonicalCompletion) {
          var requestedStatus = normalizeSupportRequestedStatus(value);
          observeSupportCompletionRequest(
            'scorm_set_value',
            requestedStatus,
            new Date().toISOString()
          );
        }
        queueScormStatus(el, value);
        var setResult = original(el, value);
        var writeSucceeded = scormCallSucceeded(setResult);
        var commitSucceeded = writeSucceeded && commitScorm();
        var readbackConfirmed = false;
        var readbackStatus = null;
        if (canonicalCompletion && commitSucceeded) {
          readbackConfirmed = readCompletionFromLms(requestedStatus) === true;
          readbackStatus = supportRuntime.canonicalStatus;
        }
        if (canonicalCompletion) {
          recordSupportCompletionAttempt(
            writeSucceeded,
            commitSucceeded,
            readbackStatus,
            requestedStatus
          );
        }
        var deliverySucceeded = writeSucceeded && commitSucceeded &&
          (!canonicalCompletion || readbackConfirmed);
        if (deliverySucceeded) {
          if (state.pendingScorm) delete state.pendingScorm[el];
          if (!objectHasKeys(state.pendingScorm)) state.pendingScorm = null;
          if (canonicalCompletion) {
            state.courseCompleteSent = true;
            runSeatTimeSafely(function () {
              confirmSeatTimeCompletion('completion-confirmed');
            });
          }
          updateCompletionPendingFlag();
        }
        if (canonicalCompletion && deliverySucceeded) {
          finalizeConfirmedCompletion();
        }
        persistState(true);
        emitTimegateEvent('completion_replayed', {
          reason: 'scorm',
          replayMode: 'direct',
          canonicalCompletion: canonicalCompletion,
          activeSeconds: Math.floor(state.elapsedSeconds || 0),
          idleSeconds: currentObservedIdleSeconds(Date.now()),
          completionStatus: String(value).slice(0, 40),
          success: writeSucceeded,
          resultBoolean: commitSucceeded,
          readbackConfirmed: readbackConfirmed,
          readbackStatus: readbackStatus
        });
        if (deliverySucceeded) {
          replayPendingTerminate('direct_completion');
        }
        return setResult;
      }
      return original(el, value);
    };
  }

  function wrapScormTerminate() {
    if (!apiAdapter || !apiAdapter.original.terminate) return;
    var methodName = apiAdapter.method.terminate;
    apiAdapter.api[methodName] = function () {
      var args = Array.prototype.slice.call(arguments);
      if (apiTerminated) return 'true';
      if (forceExitTriggered && forcedTerminationReason) {
        return terminateLmsSession(forcedTerminationReason, args);
      }
      if (configurationBlocked) {
        clearPendingCompletion();
        persistState(true);
        return terminateLmsSession('course', args);
      }
      if (
        config.enforceCompletion &&
        state.courseCompletePending &&
        !forceExitTriggered
      ) {
        state.pendingTerminate = buildPendingTerminate('course', null);
        var terminateQueuedDurably = persistState(true);
        emitTimegateEvent('termination_deferred', {
          reason: 'completion_pending',
          success: terminateQueuedDurably,
          activeSeconds: Math.floor(state.elapsedSeconds || 0),
          idleSeconds: currentObservedIdleSeconds(Date.now())
        });
        return terminateQueuedDurably ? 'true' : 'false';
      }
      return terminateLmsSession('course', args);
    };
  }

  /* Intercept driver functions used by Rise to report completion. */
  function wrapDriverFunctions() {
    if (!driverAdapter || !driverAdapter.originals) return;
    var originals = driverAdapter.originals;
    var names = Object.keys(originals);
    for (var i = 0; i < names.length; i++) {
      (function (name) {
        if (window[name] && window[name][WRAPPED_FLAG]) {
          return;
        }
        window[name] = function () {
          var args = ([]).slice.call(arguments);
          var isCompletion = isDriverCompletion(name, args);
          var isReset = isDriverReset(name, args);
          if (isMaximumTimeReached() && isCompletion) {
            triggerMaximumTimeExit('driver_call');
            return false;
          }
          if (isReset) {
            var resetResult = originals[name].apply(window, args);
            if (driverCallSucceeded(resetResult)) {
              clearPendingCompletion();
              state.courseCompleteSent = false;
              runSeatTimeSafely(function () {
                resetSeatTimeCompletion('completion-reset');
              });
              persistState(true);
              emitTimegateEvent('completion_reset', {
                reason: 'driver_status_reset',
                completionStatus: name,
                canonicalCompletion: true,
                activeSeconds: Math.floor(state.elapsedSeconds || 0),
                idleSeconds: currentObservedIdleSeconds(Date.now())
              });
              replayPendingTerminate('driver_status_reset');
            }
            return resetResult;
          }
          if (
            config.enforceCompletion &&
            !replayingScorm &&
            !completionGateOpen() &&
            isCompletion
          ) {
            state.pendingDriverCalls = [{ name: name, args: args }];
            updateCompletionPendingFlag();
            var driverQueuedDurably = persistState(true);
            log('Gated driver completion', name, args);
            emitTimegateEvent('completion_gated', {
              reason: 'minimum_time_not_met',
              completionStatus: name,
              canonicalCompletion: true,
              signalSource: 'rise_driver',
              success: driverQueuedDurably,
              activeSeconds: Math.floor(state.elapsedSeconds || 0),
              idleSeconds: currentObservedIdleSeconds(Date.now())
            });
            return driverQueuedDurably;
          }
          if (isCompletion) {
            var expectedStatus = expectedDriverCompletionStatus(name, args);
            observeSupportCompletionRequest(
              'rise_driver',
              expectedStatus,
              new Date().toISOString()
            );
            state.pendingDriverCalls = [{ name: name, args: args }];
            updateCompletionPendingFlag();
            var result = originals[name].apply(window, args);
            var driverSucceeded = driverCallSucceeded(result);
            var confirmation = confirmDriverCompletion(
              driverSucceeded,
              expectedStatus
            );
            recordSupportCompletionAttempt(
              driverSucceeded,
              confirmation.committed,
              confirmation.readbackStatus,
              expectedStatus
            );
            if (confirmation.succeeded) {
              state.pendingDriverCalls = null;
              state.courseCompleteSent = true;
              updateCompletionPendingFlag();
              runSeatTimeSafely(function () {
                confirmSeatTimeCompletion('completion-confirmed');
              });
              finalizeConfirmedCompletion();
            }
            persistState(true);
            emitTimegateEvent('completion_replayed', {
              reason: 'rise_driver',
              replayMode: 'direct',
              activeSeconds: Math.floor(state.elapsedSeconds || 0),
              idleSeconds: currentObservedIdleSeconds(Date.now()),
              completionStatus: name,
              canonicalCompletion: true,
              success: confirmation.succeeded,
              resultBoolean: confirmation.committed,
              readbackConfirmed: confirmation.confirmed,
              readbackStatus: confirmation.readbackStatus
            });
            if (!state.courseCompletePending) {
              replayPendingTerminate('direct_driver_completion');
            }
            return result;
          }
          return originals[name].apply(window, args);
        };
        window[name][WRAPPED_FLAG] = true;
      })(names[i]);
    }
  }

  /* Replay deferred SCORM completion values. */
  function scormCallSucceeded(result) {
    if (result === true || result === 1) return true;
    if (typeof result !== 'string') return false;
    var normalized = result.toLowerCase();
    return normalized === 'true' || normalized === '1';
  }

  function replayPendingScorm() {
    if (!config.enforceCompletion) return;
    if (!objectHasKeys(state.pendingScorm)) return;
    if (!apiAdapter || !apiInitialized || apiTerminated) return;
    if (!completionGateOpen()) return;

    var replayCount = 0;
    var writeSucceeded = true;
    var commitSucceeded = !!apiAdapter.original.commit;
    var canonicalCompletionReplayed = false;
    var canonicalRequestedStatus = null;
    replayingScorm = true;
    var key;
    for (key in state.pendingScorm) {
      if (Object.prototype.hasOwnProperty.call(state.pendingScorm, key)) {
        replayCount += 1;
        if (isCanonicalCompletionElement(key)) {
          canonicalCompletionReplayed = true;
          canonicalRequestedStatus = state.pendingScorm[key];
        }
        try {
          var setResult =
            apiAdapter.original.setValue(key, state.pendingScorm[key]);
          if (!scormCallSucceeded(setResult)) writeSucceeded = false;
        } catch (e) {
          writeSucceeded = false;
        }
      }
    }
    if (apiAdapter.original.commit) {
      try {
        commitSucceeded =
          scormCallSucceeded(apiAdapter.original.commit(''));
      } catch (e) {
        commitSucceeded = false;
      }
    }
    replayingScorm = false;

    if (
      canonicalCompletionReplayed &&
      !supportRuntime.completion.courseSignalObserved
    ) {
      observeSupportCompletionRequest(
        'scorm_set_value',
        canonicalRequestedStatus,
        new Date().toISOString()
      );
    }
    var readbackConfirmed = false;
    var readbackStatus = null;
    if (canonicalCompletionReplayed && commitSucceeded) {
      readbackConfirmed = readCompletionFromLms(
        canonicalRequestedStatus
      ) === true;
      readbackStatus = supportRuntime.canonicalStatus;
    }
    if (canonicalCompletionReplayed) {
      recordSupportCompletionAttempt(
        writeSucceeded,
        commitSucceeded,
        readbackStatus,
        canonicalRequestedStatus
      );
    }
    var succeeded = writeSucceeded && commitSucceeded &&
      (!canonicalCompletionReplayed || readbackConfirmed);
    if (succeeded) {
      state.pendingScorm = null;
      updateCompletionPendingFlag();
      if (canonicalCompletionReplayed) {
        state.courseCompleteSent = true;
        runSeatTimeSafely(function () {
          confirmSeatTimeCompletion('completion-confirmed');
        });
        finalizeConfirmedCompletion();
      }
    } else {
      updateCompletionPendingFlag();
    }
    persistState(true);
    emitTimegateEvent('completion_replayed', {
      reason: 'scorm',
      activeSeconds: Math.floor(state.elapsedSeconds || 0),
      idleSeconds: currentObservedIdleSeconds(Date.now()),
      completionStatus: replayCount ? 'replayed' : 'none',
      canonicalCompletion: canonicalCompletionReplayed,
      success: writeSucceeded,
      resultBoolean: commitSucceeded,
      readbackConfirmed: readbackConfirmed,
      readbackStatus: readbackStatus
    });
    if (succeeded) replayPendingTerminate('scorm_replay');
  }

  /* Replay deferred driver completion calls. */
  function replayPendingDriverCalls() {
    if (!config.enforceCompletion) return;
    if (!state.pendingDriverCalls || !state.pendingDriverCalls.length) return;
    if (!driverAdapter || !driverAdapter.originals) return;
    if (!completionGateOpen() || apiTerminated) return;

    var replayCount = state.pendingDriverCalls.length;
    var replaySucceeded = true;
    replayingScorm = true;
    for (var i = 0; i < state.pendingDriverCalls.length; i++) {
      var call = state.pendingDriverCalls[i];
      if (!call || !call.name || !driverAdapter.originals[call.name]) continue;
      try {
        var driverResult =
          driverAdapter.originals[call.name].apply(window, call.args || []);
        if (!driverCallSucceeded(driverResult)) replaySucceeded = false;
      } catch (e) {
        replaySucceeded = false;
      }
    }
    replayingScorm = false;

    var replayCall = state.pendingDriverCalls[0];
    var replayName = replayCall && replayCall.name;
    var replayExpectedStatus = expectedDriverCompletionStatus(
      replayName,
      replayCall && replayCall.args
    );
    if (!supportRuntime.completion.courseSignalObserved) {
      observeSupportCompletionRequest(
        'rise_driver',
        replayExpectedStatus,
        new Date().toISOString()
      );
    }
    var confirmation = confirmDriverCompletion(
      replaySucceeded,
      replayExpectedStatus
    );
    recordSupportCompletionAttempt(
      replaySucceeded,
      confirmation.committed,
      confirmation.readbackStatus,
      replayExpectedStatus
    );
    if (confirmation.succeeded) {
      state.pendingDriverCalls = null;
      state.courseCompleteSent = true;
      updateCompletionPendingFlag();
      runSeatTimeSafely(function () {
        confirmSeatTimeCompletion('completion-confirmed');
      });
      finalizeConfirmedCompletion();
    }
    updateCompletionPendingFlag();
    persistState(true);
    emitTimegateEvent('completion_replayed', {
      reason: 'rise_driver',
      activeSeconds: Math.floor(state.elapsedSeconds || 0),
      idleSeconds: currentObservedIdleSeconds(Date.now()),
      completionStatus: replayCount ? 'replayed' : 'none',
      canonicalCompletion: true,
      success: confirmation.succeeded,
      resultBoolean: confirmation.committed,
      readbackConfirmed: confirmation.confirmed,
      readbackStatus: confirmation.readbackStatus
    });
    if (!state.courseCompletePending) {
      replayPendingTerminate('driver_replay');
    }
  }

  function replayPendingCompletion(reason) {
    if (!state || !completionGateOpen() || apiTerminated) return;
    var now = Date.now();
    if (
      reason === 'timer_retry' &&
      now - lastCompletionReplayTs < COMPLETION_RETRY_INTERVAL_MS
    ) return;
    lastCompletionReplayTs = now;
    replayPendingScorm();
    replayPendingDriverCalls();
  }

  function emitMinimumTimeMet(reason) {
    if (minimumTimeEventSent || !state || !state.minMetAt) return;
    minimumTimeEventSent = true;
    emitTimegateEvent('minimum_time_met', {
      reason: reason || 'timer',
      activeSeconds: Math.floor(state.elapsedSeconds || 0),
      idleSeconds: currentObservedIdleSeconds(Date.now())
    });
  }

  function observePauseTransition(reason, timestamp) {
    var nextReason = reason || '';
    if (nextReason === observedPauseReason) return;
    if (observedPauseReason) {
      var pausedDuration =
        observedPauseSinceTs === null ?
          0 : Math.max(0, (timestamp - observedPauseSinceTs) / 1000);
      observedIdleSeconds += pausedDuration;
      emitTimegateEvent('idle_exited', {
        reason: observedPauseReason,
        durationSeconds: pausedDuration,
        activeSeconds: Math.floor(state.elapsedSeconds || 0),
        idleSeconds: observedIdleSeconds
      });
    }
    observedPauseReason = nextReason;
    observedPauseSinceTs = nextReason ? timestamp : null;
    if (nextReason) {
      emitTimegateEvent('idle_entered', {
        reason: nextReason,
        activeSeconds: Math.floor(state.elapsedSeconds || 0),
        idleSeconds: observedIdleSeconds
      });
    }
  }

  /* Compute UI state based on timer and activity. */
  function computeUiState() {
    var elapsedSeconds = Math.max(0, state.elapsedSeconds || 0);
    var minRequiredSeconds = Math.max(0, state.minRequiredSeconds || 0);
    var pauseReason = getPauseReason();
    var paused = !!pauseReason;
    var locked = !!(config.enforceCompletion && !state.minMetAt);
    var minMet = !!state.minMetAt;
    var completionConfirmed = currentSupportSummary().completionSafeToClose;
    var stateClass = 'timegate--state-normal';
    var scaleSeconds = hasMaximumTimeLimit() ?
      state.maxAllowedSeconds : minRequiredSeconds;
    var progressPercent = scaleSeconds > 0 ?
      (elapsedSeconds / scaleSeconds) * 100 : 100;
    var markerPercent = hasMaximumTimeLimit() && scaleSeconds > 0 ?
      (minRequiredSeconds / scaleSeconds) * 100 : null;
    var slides = [
      {
        value: formatTime(elapsedSeconds),
        label: 'Time elapsed',
        visualTarget: 'elapsed'
      },
      {
        value: formatTime(minRequiredSeconds),
        label: 'Min required',
        visualTarget: 'minimum'
      }
    ];
    if (hasMaximumTimeLimit()) {
      slides.push({
        value: formatTime(state.maxAllowedSeconds),
        label: 'Max allowed',
        visualTarget: 'maximum'
      });
    }
    var progressText =
      formatTime(elapsedSeconds) +
      ' active. Min required ' +
      formatTime(minRequiredSeconds) +
      (hasMaximumTimeLimit() ?
        '. Max allowed ' + formatTime(state.maxAllowedSeconds) : '');

    if (configurationBlocked) {
      stateClass = 'timegate--state-paused';
      progressPercent = 0;
      markerPercent = null;
      progressText = 'Required-time progress unavailable';
      slides = [{ value: 'Error', label: 'Settings' }];
    } else if (isMaximumTimeReached()) {
      stateClass = 'timegate--state-paused';
      slides = [{ value: '0:00', label: 'Max reached' }];
    } else if (completionConfirmed) {
      stateClass = 'timegate--state-complete';
    } else if (minMet) {
      stateClass = 'timegate--state-minimum-met';
    } else if (paused) {
      stateClass = 'timegate--state-paused';
    }

    return {
      paused: paused,
      locked: locked,
      complete: completionConfirmed,
      stateClass: stateClass,
      pauseReason: pauseReason,
      progressPercent: Math.max(0, Math.min(100, progressPercent)),
      markerPercent: markerPercent,
      progressText: progressText,
      slides: slides
    };
  }

  /* Advance timer, persist, and render UI. */
  function tick(ui) {
    var now = Date.now();
    var delta = clampDelta(now - lastTickTs);
    lastTickTs = now;

    if (apiTerminated) return;

    if (forceExitTriggered) {
      updateLock();
      if (!isPrimaryTab) {
        hideWalkBackOverlay();
        return;
      }
      if (
        forcedTerminationReason &&
        apiInitialized &&
        now - lastTerminationAttemptTs >= COMPLETION_RETRY_INTERVAL_MS
      ) {
        terminateLmsSession(forcedTerminationReason, ['']);
      }
      if (forcedTerminationReason === 'maximum') {
        showWalkBackOverlay(
          'Maximum course time reached',
          'You have reached the maximum active time allowed for this course. ' +
          'Please close this window and contact your training administrator if you need another attempt.'
        );
      } else {
        showWalkBackOverlay();
      }
      return;
    }

    updateLock();
    runSeatTimeSafely(function () {
      if (!seatTimeIdentityVerified) {
        activateSeatTimeIdentity('identity-retry');
      }
    });

    evaluateInactivity();
    if (forceExitTriggered) return;

    if (timerStarted && isActive()) {
      var activeDelta = delta / 1000;
      if (hasMaximumTimeLimit()) {
        activeDelta = Math.min(
          activeDelta,
          Math.max(0, state.maxAllowedSeconds - state.elapsedSeconds)
        );
      }
      state.elapsedSeconds += activeDelta;
      state.sessionSeconds += activeDelta;
    }

    if (
      !configurationBlocked &&
      !state.minMetAt &&
      state.elapsedSeconds >= state.minRequiredSeconds
    ) {
      state.minMetAt = new Date().toISOString();
      emitMinimumTimeMet('timer');
      syncCompletionFromLms('timer-complete');
      replayPendingCompletion('minimum_met');
      runSeatTimeSafely(function () {
        checkpointSeatTime('minimum-met', false);
      });
    }

    if (isMaximumTimeReached()) {
      state.elapsedSeconds = state.maxAllowedSeconds;
      triggerMaximumTimeExit('timer');
      return;
    }

    persistState(false);
    replayPendingCompletion('timer_retry');
    replayPendingTerminate('timer_retry');
    if (
      supportRuntime.completion.deliveryState === 'confirmed' &&
      !supportRuntime.completion.finalizationSucceeded &&
      !state.courseCompletePending &&
      !state.pendingTerminate &&
      now - lastCompletionFinalizationTs >= COMPLETION_RETRY_INTERVAL_MS
    ) {
      finalizeConfirmedCompletion();
      persistState(true);
    }
    runSeatTimeSafely(function () {
      checkpointSeatTimePeriodically(now);
    });

    var uiState = computeUiState();
    updateLearnerSupportSurface();
    if (timerStarted) {
      observePauseTransition(uiState.pauseReason, now);
      if (
        lastMetricsEventTs === 0 ||
        now - lastMetricsEventTs >= OBSERVABILITY_METRICS_INTERVAL_MS
      ) {
        lastMetricsEventTs = now;
        emitTimegateEvent('metrics', {
          activeSeconds: Math.floor(state.elapsedSeconds || 0),
          idleSeconds: currentObservedIdleSeconds(now)
        });
      }
    }
    var signature =
      (uiState.complete ? '1' : '0') +
      '|' +
      (uiState.paused ? '1' : '0') +
      '|' +
      (uiState.locked ? '1' : '0') +
      '|' +
      uiState.stateClass +
      '|' +
      uiState.progressPercent.toFixed(2) +
      '|' +
      String(uiState.markerPercent) +
      '|' +
      uiState.progressText +
      '|' +
      uiState.slides.map(function (slide) {
        return slide.value + ':' + slide.label;
      }).join(',');
    if (signature !== lastUiRender) {
      updateUi(ui, uiState);
      lastUiRender = signature;
    }
  }

  /* Start timers, listeners, and periodic checks. */
  function start(ui) {
    attachIframeListeners();
    attachActivityListeners(document);
    document.addEventListener('visibilitychange', handleVisibilityChange, true);
    window.addEventListener('storage', handleAudioPreferenceStorage, false);

    setInterval(function () {
      updateMediaPlaying();
      updateVideoSeekGuards();
    }, MEDIA_SCAN_INTERVAL_MS);

    setInterval(function () {
      tick(ui);
    }, 1000);

    window.addEventListener('pagehide', function () {
      cancelAudioCuePlayback(false);
      supportCopyGeneration += 1;
      if (supportUi) {
        supportUi.overlay.hidden = true;
        supportUi.overlay.setAttribute('inert', '');
        supportUi.dialog.setAttribute('aria-modal', 'false');
        supportUi.fallback.hidden = true;
        supportUi.fallback.value = '';
      }
      restoreLearnerSupportBackground();
      document.removeEventListener('keydown', supportKeydownHandler, true);
      supportKeydownHandler = null;
      supportPreviousFocus = null;
      runSeatTimeSafely(function () {
        freezeSeatTimeSegment('pagehide', true, true);
      });
      stopRingCarousel(ui);
      if (!apiInitialized || apiTerminated) {
        persistState(true);
        releaseLock();
        isPrimaryTab = false;
        return;
      }
      var sessionTimeOk = writeSessionTime();
      var persistenceOk = persistState(true);
      var commitOk = commitScorm();
      if (state.courseCompleteSent) {
        supportRuntime.completion.finalizationSucceeded =
          sessionTimeOk && persistenceOk && commitOk;
      }
      if (!sessionTimeOk || !persistenceOk || !commitOk) {
        emitTimegateEvent('lms_operation_failed', {
          reason: 'course',
          operation: 'finalize',
          sessionTime: sessionTimeOk,
          persistence: persistenceOk,
          resultBoolean: commitOk,
          errorCode: captureSupportScormError()
        });
      }
      releaseLock();
      isPrimaryTab = false;
    }, true);
    window.addEventListener('pageshow', function () {
      lastTickTs = Date.now();
      startRingCarousel(ui);
      runSeatTimeSafely(function () {
        if (seatTimeTerminal) return;
        if (seatTimeSegment && seatTimeSegment.endTs !== null) {
          seatTimeSegment = null;
        }
        updateLock();
        startSeatTimeSegment('pageshow');
      });
    });
  }

  /* Initialize Timegate state and UI. */
  function init() {
    apiAdapter = createApiAdapter();
    driverAdapter = createDriverAdapter();
    supportLaunchId = createSupportUuid();
    supportLaunchStartedAt = new Date().toISOString();
    probeSessionStorage();
    supportRuntime.apiState = !apiAdapter ?
      'missing' : apiInitialized ? 'initialized' : 'found';
    if (!apiAdapter) {
      markSupportIssue('LMS_API_MISSING', 'error', true);
      recordSupportEvent('LMS_API_MISSING', 'failed', 'initialize');
    }

    storage = createStorage();
    configurationBlocked = !!config.configLoadError;
    if (seatTimeConfigError) {
      emitTimegateEvent('seat_time_disabled', {
        reason: seatTimeConfigError
      });
    }

    var minRequiredSeconds = Math.max(
      0,
      Math.floor((config.minRequiredMinutes || 0) * 60)
    );
    var maxAllowedSeconds =
      config.maxAllowedMinutes === null ?
        null : Math.floor(config.maxAllowedMinutes * 60);
    if (maxAllowedSeconds !== null && maxAllowedSeconds <= minRequiredSeconds) {
      maxAllowedSeconds = null;
    }

    state = {
      version: STATE_VERSION,
      persistenceRevision: 0,
      courseKey: buildCourseKey(),
      learnerKey: 'unresolved',
      entryMode: '',
      allowLocalFallback: false,
      elapsedSeconds: 0,
      sessionSeconds: 0,
      minRequiredSeconds: minRequiredSeconds,
      maxAllowedSeconds: maxAllowedSeconds,
      minMetAt: null,
      maxReachedAt: null,
      courseCompleteSent: false,
      courseCompletePending: false,
      pendingScorm:
        bootstrapGate && objectHasKeys(bootstrapGate.pendingScorm) ?
          bootstrapGate.pendingScorm : null,
      pendingDriverCalls: null,
      pendingTerminate:
        bootstrapGate && bootstrapGate.pendingTerminate ?
          buildPendingTerminate('course', null) : null,
      inactivityExitNotice: null,
      seatTimeScopeToken: null,
      supportAttemptId: createSupportUuid(),
    };

    state.storageKey =
      INSTANCE_KEY + '.v1.' + state.courseKey + '.unresolved';
    initializeAudioCuePreference();
    updateCompletionPendingFlag();

    var hydrated = false;
    if (apiInitialized && !apiTerminated) {
      refreshLearnerIdentity();
      hydrated = hydrateFromStorage();
    }
    pendingInitHydrate = !!(apiAdapter && !apiInitialized && !apiTerminated);
    syncCompletionFromLms('init');
    completionAudioCueSent = !!state.courseCompleteSent;
    runSeatTimeSafely(function () {
      activateSeatTimeIdentity('identity-verified');
    });

    if (
      !configurationBlocked &&
      !state.minMetAt &&
      state.minRequiredSeconds === 0
    ) {
      state.minMetAt = new Date().toISOString();
    }
    emitMinimumTimeMet(hydrated ? 'hydrated' : 'initial');

    if (apiAdapter) {
      wrapScormSetValue();
      wrapScormTerminate();
    }
    if (driverAdapter) {
      wrapDriverFunctions();
    }

    installLearnerSupportApi();
    var ui = createUi();
    if (
      (config.launchModalEnabled || state.inactivityExitNotice) &&
      !configurationBlocked &&
      !isMaximumTimeReached()
    ) {
      ui.root.style.visibility = 'hidden';
    }
    start(ui);
    if (configurationBlocked) {
      tick(ui);
      emitTimegateEvent('configuration_failed', {
        reason: config.configLoadError,
        activeSeconds: 0,
        idleSeconds: 0
      });
      showWalkBackOverlay(
        'Course reporting unavailable',
        'Timegate could not verify this course\'s settings, so progress will not ' +
        'be reported as complete. Please close the course and contact your ' +
        'training administrator.'
      );
      if (state.pendingTerminate) {
        clearPendingCompletion();
        persistState(true);
        replayPendingTerminate('configuration_error');
      }
    } else if (isMaximumTimeReached()) {
      triggerMaximumTimeExit(hydrated ? 'hydrated' : 'initial');
    } else {
      tick(ui);
    }

    replayPendingCompletion(hydrated ? 'hydrated' : 'initial');
    replayPendingTerminate('initial');

    var trackingStartedOnce = false;

    function beginTracking(reason) {
      var firstStart = !trackingStartedOnce;
      trackingStartedOnce = true;
      timerStarted = true;
      lastActivityTs = Date.now();
      lastTickTs = Date.now();
      lastMetricsEventTs = lastTickTs;
      if (ui && ui.root) ui.root.style.visibility = '';
      log('Timer tracking started');
      if (firstStart) {
        emitTimegateEvent('tracking_started', {
          reason: reason || 'automatic',
          activeSeconds: Math.floor(state.elapsedSeconds || 0),
          idleSeconds: observedIdleSeconds
        });
      }
      runSeatTimeSafely(function () {
        var seatTimeReason = firstStart ?
          'tracking-started' : 'tracking-resumed';
        if (seatTimeIdentityVerified) {
          startSeatTimeSegment(seatTimeReason);
        } else if (apiInitialized) {
          activateSeatTimeIdentity(seatTimeReason);
        } else {
          startSeatTimeSegment(seatTimeReason);
        }
      });
    }

    function presentInactivityRelaunchNotice() {
      if (
        configurationBlocked ||
        forceExitTriggered ||
        !isPrimaryTab ||
        isMaximumTimeReached()
      ) return false;
      var notice = normalizeInactivityExitNotice(state.inactivityExitNotice);
      if (
        !notice ||
        notice.occurredAt === acknowledgedInactivityExitAt
      ) return false;
      if (launchModalKind === 'inactivity') return true;

      if (timerStarted) {
        runSeatTimeSafely(function () {
          freezeSeatTimeSegment('inactivity-relaunch-notice', false, false);
        });
      }
      timerStarted = false;
      if (ui && ui.root) ui.root.style.visibility = 'hidden';
      createInactivityRelaunchModal(notice, function (acknowledgedNotice) {
        updateLock();
        if (!isPrimaryTab) return false;
        acknowledgedInactivityExitAt = acknowledgedNotice.occurredAt;
        state.inactivityExitNotice = null;
        persistState(true);
        beginTracking('acknowledged');
        return true;
      });
      return true;
    }

    inactivityNoticeHydratedHandler = presentInactivityRelaunchNotice;

    if (
      !configurationBlocked &&
      !forceExitTriggered
    ) {
      if (!presentInactivityRelaunchNotice()) {
        if (config.launchModalEnabled) {
          createLaunchModal(function () {
            beginTracking('acknowledged');
          });
        } else {
          beginTracking('automatic');
        }
      }
    }

    log('Timegate initialized', state);
  }

  bootstrapGate = installBootstrapGate();
  loadConfig(function (loaded) {
    config = normalizeTimeLimits(loaded);
    if (bootstrapStorageMode === 'localStorage') {
      config.storageMode = 'localStorage';
    }
    if (document.body) {
      init();
      return;
    }
    document.addEventListener('DOMContentLoaded', function initializeAfterParse() {
      document.removeEventListener(
        'DOMContentLoaded',
        initializeAfterParse,
        false
      );
      init();
    }, false);
  });
})();
