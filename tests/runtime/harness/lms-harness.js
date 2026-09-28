(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var apiMode = params.get('api') || 'full';
  var riseMode = params.get('rise') || 'full';
  var telemetryMode = params.get('telemetry') || 'ok';
  var timegateMode = params.get('timegate') || '';
  var timegateConfigMode = params.get('timegateConfig') || 'inline';
  var driverMode = params.get('driver') || '';
  var seatTimeMode = params.get('seat') || '';
  var seatTimeResponseMode = params.get('seatResponse') || 'ok';
  var seatTimeOutboxPrefix = '__timegate_seat_time_outbox_v1.';
  var strictScorm = params.get('strictScorm') === '1';
  var privacySentinel = 'Synthetic Learner selected sprinkler';
  var telemetryPort = Number(window.location.port || '4173') + 1;
  var nativeFetch = window.fetch.bind(window);
  var nativeSendBeacon =
    typeof navigator.sendBeacon === 'function' ?
      navigator.sendBeacon.bind(navigator) : null;
  var attemptMarker =
    '__timegate_harness_attempt__' + timegateMode + '|' +
    (params.get('learner') || 'POC-LEARNER-001');
  var isResumeLaunch = params.get('entry') === 'resume';
  try {
    isResumeLaunch = isResumeLaunch ||
      window.sessionStorage.getItem(attemptMarker) === 'started';
  } catch (error) {
    isResumeLaunch = false;
  }
  var seededSuspendData = '';
  var seatTimeOutboxWrites = [];
  if (params.get('seedSuspend') === '1') {
    try {
      seededSuspendData = window.localStorage.getItem(
        '__timegate_harness_suspend_seed'
      ) || '';
    } catch (error) {
      seededSuspendData = '';
    }
  }
  if (params.get('bootstrapSuspend') === '1') {
    seededSuspendData = JSON.stringify({
      v: 3,
      d: 'OLD-RISE-STATE',
      __timegate_v2: {
        version: 1,
        courseKey: params.get('courseKey') ||
          'observability-browser-' + timegateMode,
        learnerKey: params.get('learner') || 'POC-LEARNER-001',
        elapsedSeconds: 90,
        courseCompletePending: true
      }
    });
  }
  if (timegateConfigMode === 'external-delayed') {
    var nativeXhrSend = window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      var sendArguments = arguments;
      window.setTimeout(function () {
        nativeXhrSend.apply(xhr, sendArguments);
      }, 250);
    };
  }
  if (window.Storage && window.Storage.prototype) {
    var nativeStorageSetItem = window.Storage.prototype.setItem;
    window.Storage.prototype.setItem = function (key, value) {
      if (
        String(key).indexOf(seatTimeOutboxPrefix) === 0
      ) {
        var parsedEntry = null;
        try {
          parsedEntry = JSON.parse(String(value));
        } catch (error) {
          parsedEntry = null;
        }
        seatTimeOutboxWrites.push({
          entry: parsedEntry,
          key: String(key)
        });
        if (params.get('seatOutbox') === 'fail') {
          throw new Error('synthetic seat-time outbox failure');
        }
      }
      return nativeStorageSetItem.call(this, key, value);
    };
  }

  var values = {
    'cmi.core.student_id': params.get('learner') || 'POC-LEARNER-001',
    'cmi.core.student_name': 'Learner, Synthetic',
    'cmi.core.lesson_status':
      isResumeLaunch && params.get('resumeCompleted') === '1' ?
        'completed' : 'incomplete',
    'cmi.core.score.raw': '',
    'cmi.core.lesson_location': '',
    'cmi.core.exit': '',
    'cmi.core.entry': isResumeLaunch ? 'resume' : 'ab-initio',
    'cmi.suspend_data': seededSuspendData
  };
  var calls = [];
  var riseCalls = [];
  var snapshots = [];
  var transportAttempts = [];
  var beaconAttempts = [];
  var seatTimeRequests = [];
  var seatTimeBeaconAttempts = [];
  var seatTimeResponseControls = [];
  var failure = {
    initialize: false,
    setValue: false,
    commit: false,
    finish: false,
    driver: false
  };
  var lifecycle = {
    initialized: false,
    terminated: false
  };

  function booleanResult(succeeded, errorCode) {
    window.intSCORMError = succeeded ? '0' : String(errorCode || 101);
    return succeeded ? 'true' : 'false';
  }

  function sessionIsActive() {
    return lifecycle.initialized && !lifecycle.terminated;
  }

  function callAllowed() {
    return !strictScorm || sessionIsActive();
  }

  function recordCall() {
    calls.push(Array.prototype.slice.call(arguments));
    render();
  }

  if (apiMode !== 'missing') {
    window.API = {
      LMSInitialize: function () {
        recordCall('LMSInitialize');
        var succeeded = !!(
          !failure.initialize &&
          (
            !strictScorm ||
            (!lifecycle.initialized && !lifecycle.terminated)
          )
        );
        if (succeeded) {
          lifecycle.initialized = true;
          try {
            window.sessionStorage.setItem(attemptMarker, 'started');
          } catch (error) {
            // ignore harness storage failures
          }
        }
        return booleanResult(succeeded, 101);
      },
      LMSGetValue: function (element) {
        recordCall('LMSGetValue', element);
        if (!callAllowed()) {
          window.intSCORMError = '301';
          return '';
        }
        window.intSCORMError = '0';
        return Object.prototype.hasOwnProperty.call(values, element) ?
          values[element] : '';
      },
      LMSGetLastError: function () {
        return window.intSCORMError;
      },
      LMSSetValue: function (element, value) {
        recordCall('LMSSetValue', element, value);
        var succeeded = callAllowed() && !failure.setValue;
        if (succeeded) values[element] = String(value);
        return booleanResult(succeeded, callAllowed() ? 351 : 301);
      },
      LMSCommit: function () {
        recordCall('LMSCommit');
        return booleanResult(
          callAllowed() && !failure.commit,
          callAllowed() ? 391 : 301
        );
      },
      LMSFinish: function () {
        recordCall('LMSFinish');
        var succeeded = callAllowed() && !failure.finish;
        if (succeeded) {
          lifecycle.initialized = false;
          lifecycle.terminated = true;
        }
        return booleanResult(succeeded, callAllowed() ? 101 : 301);
      }
    };

    window.SCORM_objAPI = window.API;
    window.SCORM_CallLMSInitialize = function (value) {
      return window.API.LMSInitialize(value);
    };
    window.SCORM_CallLMSGetValue = function (element) {
      return window.API.LMSGetValue(element);
    };
    window.SCORM_CallLMSSetValue = function (element, value) {
      return window.API.LMSSetValue(element, value);
    };
    window.SCORM_CallLMSCommit = function (value) {
      return window.API.LMSCommit(value);
    };
    window.SCORM_CallLMSFinish = function (value) {
      return window.API.LMSFinish(value);
    };
  }

  if (driverMode === 'rise') {
    window.SetReachedEnd = function () {
      riseCalls.push(['SetReachedEnd']);
      render();
      if (failure.driver) return false;
      return window.SCORM_CallLMSSetValue(
        'cmi.core.lesson_status',
        'completed'
      ) !== 'false';
    };
  }

  function riseMethod(name, returnValue) {
    return function () {
      riseCalls.push([name]);
      render();
      return returnValue;
    };
  }

  if (riseMode !== 'missing') {
    window.RiseLMSInterface = {
      initialize: riseMethod('initialize'),
      start: riseMethod('start'),
      setCourseProgress: riseMethod('setCourseProgress'),
      setLessonProgress: riseMethod('setLessonProgress'),
      finish: riseMethod('finish', true),
      finishQuiz: riseMethod('finishQuiz', true),
      reportAnswer: riseMethod('reportAnswer', true),
      setBookmark: riseMethod('setBookmark', true),
      setSessionTime: riseMethod('setSessionTime', true),
      exit: riseMethod('exit', true),
      unload: riseMethod('unload', true),
      commit: riseMethod('commit', true)
    };
  }

  function parseSnapshot(body) {
    if (typeof body !== 'string') return null;
    try {
      return JSON.parse(body);
    } catch (error) {
      return null;
    }
  }

  function seatTimeResponse(httpOk, jsonOk) {
    return {
      ok: httpOk,
      json: function () {
        return Promise.resolve({ ok: jsonOk });
      }
    };
  }

  window.fetch = function (url, options) {
    if (
      typeof url === 'string' &&
      url.indexOf('/seat-time') !== -1 &&
      options &&
      options.method === 'POST'
    ) {
      var seatPayload = parseSnapshot(options.body);
      seatTimeRequests.push({
        contentType:
          options.headers && options.headers['Content-Type'] || '',
        payload: seatPayload,
        url: String(url)
      });
      render();
      if (seatTimeResponseMode === 'manual') {
        return new Promise(function (resolve) {
          seatTimeResponseControls.push({ resolve: resolve, settled: false });
          render();
        });
      }
      if (seatTimeResponseMode === 'http-error') {
        return Promise.resolve(seatTimeResponse(false, false));
      }
      if (seatTimeResponseMode === 'not-ok') {
        return Promise.resolve(seatTimeResponse(true, false));
      }
      return Promise.resolve(seatTimeResponse(true, true));
    }
    if (
      typeof url === 'string' &&
      url.indexOf('/telemetry') !== -1 &&
      options &&
      options.method === 'POST'
    ) {
      var snapshot = parseSnapshot(options.body);
      if (snapshot) snapshots.push(snapshot);
      transportAttempts.push({
        mode: options.mode || '',
        revision:
          snapshot && snapshot.session ? snapshot.session.revision : null,
        url: String(url)
      });
      render();
    }
    return nativeFetch(url, options);
  };

  function wrappedBeacon(url, body) {
    if (String(url).indexOf('/seat-time') !== -1) {
      var seatAttempt = { payload: null, url: String(url) };
      seatTimeBeaconAttempts.push(seatAttempt);
      if (body && typeof body.text === 'function') {
        body.text().then(function (text) {
          seatAttempt.payload = parseSnapshot(text);
          render();
        });
      }
      render();
      return true;
    }
    var attempt = { url: String(url), revision: null };
    beaconAttempts.push(attempt);
    if (body && typeof body.text === 'function') {
      body.text().then(function (text) {
        var snapshot = parseSnapshot(text);
        if (snapshot) {
          snapshots.push(snapshot);
          attempt.revision = snapshot.session.revision;
        }
        render();
      });
    }
    render();
    return nativeSendBeacon ? nativeSendBeacon(url, body) : false;
  }

  try {
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: wrappedBeacon
    });
  } catch (error) {
    navigator.sendBeacon = wrappedBeacon;
  }

  var endpoint;
  if (telemetryMode === 'offline') {
    endpoint = 'http://127.0.0.1:' + (telemetryPort + 97) + '/telemetry';
  } else {
    endpoint =
      'http://127.0.0.1:' + telemetryPort +
      '/telemetry?mode=' +
      (telemetryMode === 'cors-fallback' ? 'cors-fallback' : 'ok');
  }

  window.__SIS_OBSERVABILITY_CONFIG__ = {
    enabled: telemetryMode !== 'disabled',
    endpoint: endpoint,
    source: { keyId: 'local-harness', token: 'local-pilot-token' },
    course: {
      schemaVersion: 1,
      scormVersion: '1.2',
      manifestIdentifier: 'local-manifest',
      organizationIdentifier: 'local-organization',
      title: 'Local Observability Harness',
      scoResourceIdentifier: 'local-sco',
      scoLaunchPath: 'scormdriver/indexAPI.html',
      riseCourseId: 'local-rise-course',
      packageVersion: 'local-v1',
      runtimePackageVersion: 'local-v1',
      navigationMode: 'free',
      forcedCommitIntervalSeconds: 20,
      completionPolicy: {
        reporting: 'completed-incomplete',
        completionPercentage: 100,
        resetLearnerData: false,
        triggerType: 'progress',
        triggerId: null
      },
      lessons: [],
      warnings: [],
      structureHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      paycomCourseId: 'LOCAL-COURSE'
    },
    instrumentationVersion: 'local',
    timegateVersion: 'local',
    corsFallbackBaseDelayMs: 100,
    corsFallbackJitterMs: 50
  };

  if (timegateMode) {
    var minimumMinutes = 10;
    var maximumMinutes = null;
    if (timegateMode === 'delay' || timegateMode === 'max-invalid') {
      minimumMinutes = 0.04;
    } else if (timegateMode === 'max' || timegateMode === 'seat') {
      minimumMinutes = 0;
    } else if (timegateMode === 'ring') {
      minimumMinutes = 20;
    } else if (timegateMode === 'dual-shared') {
      minimumMinutes = 10;
    }
    if (timegateMode === 'max' || timegateMode === 'max-invalid') {
      maximumMinutes = 0.04;
    } else if (timegateMode === 'ring') {
      maximumMinutes = 75;
    }
    if (params.has('min')) minimumMinutes = Number(params.get('min'));
    if (params.has('max')) maximumMinutes = Number(params.get('max'));
    var audioMode = params.get('audio') || '0';
    window.TIMEGATE_CONFIG = {
      courseKey:
        params.get('courseKey') || 'observability-browser-' + timegateMode,
      minRequiredMinutes: minimumMinutes,
      maxAllowedMinutes: maximumMinutes,
      enforceCompletion: true,
      idleTimeoutSeconds: Number(params.get('seatIdle') || '120'),
      backgroundGraceSeconds: Number(params.get('seatGrace') || '0'),
      countWhileMediaPlaying: false,
      hideWhenComplete: params.get('hideComplete') === '1',
      position: 'bottom-right',
      debug: false,
      storageMode:
        params.get('storage') ||
        (timegateMode === 'dual-shared' ? 'dual' : 'localStorage'),
      inactivityForceExitEnabled: timegateMode === 'idle',
      inactivityForceExitMinutes:
        timegateMode === 'idle' ?
          Number(params.get('idleExit') || '0.03') : 5,
      inactivityWarningSeconds: Number(params.get('idleWarning') || '0.5'),
      gentleNudgeEnabled: params.get('gentle') === '1',
      gentleNudgeSeconds: Number(params.get('idleNudge') || '1'),
      launchModalEnabled:
        timegateMode === 'modal' || params.get('launch') === '1',
      audioCuesEnabled: audioMode === 'invalid' ? 'true' : audioMode === '1',
      disableVideoSkip: false
    };
    if (seatTimeMode) {
      if (seatTimeMode === 'invalid') {
        window.TIMEGATE_CONFIG.seatTimeRelayUrl =
          'http://example.test/seat-time';
      } else if (seatTimeMode === 'whitespace') {
        window.TIMEGATE_CONFIG.seatTimeRelayUrl =
          ' ' + window.location.origin + '/seat-time';
      } else {
        window.TIMEGATE_CONFIG.seatTimeRelayUrl =
          window.location.origin + '/seat-time';
      }
      if (seatTimeMode === 'disabled') {
        window.TIMEGATE_CONFIG.seatTimeReportingEnabled = false;
        window.TIMEGATE_CONFIG.seatTimeRelayKey = '';
        window.TIMEGATE_CONFIG.courseId = '';
      } else {
        window.TIMEGATE_CONFIG.seatTimeReportingEnabled = true;
        window.TIMEGATE_CONFIG.seatTimeRelayKey =
          params.get('seatKey') || 'LOCAL-SEAT-KEY';
        window.TIMEGATE_CONFIG.courseId =
          params.get('seatCourse') || 'LOCAL-COURSE-3982';
      }
    }
    if (timegateMode === 'missing-floor') {
      delete window.TIMEGATE_CONFIG.minRequiredMinutes;
    }
    if (timegateConfigMode === 'external-delayed') {
      delete window.TIMEGATE_CONFIG;
    }
  }

  function latestSnapshot() {
    if (!snapshots.length) return null;
    return snapshots.reduce(function (latest, current) {
      if (!latest) return current;
      return current.session.revision >= latest.session.revision ?
        current : latest;
    }, null);
  }

  function seatTimeOutbox() {
    var entries = [];
    for (var index = 0; index < window.localStorage.length; index++) {
      var key = window.localStorage.key(index);
      if (!key || key.indexOf(seatTimeOutboxPrefix) !== 0) continue;
      var entry = parseSnapshot(window.localStorage.getItem(key));
      if (entry) entries.push(entry);
    }
    if (!entries.length) return null;
    entries.sort(function (left, right) {
      if (right.updatedAt !== left.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }
      return right.revision - left.revision;
    });
    return { version: 1, entries: entries };
  }

  function seatTimeOutboxRaw() {
    var records = [];
    for (var index = 0; index < window.localStorage.length; index++) {
      var key = window.localStorage.key(index);
      if (!key || key.indexOf(seatTimeOutboxPrefix) !== 0) continue;
      records.push({ key: key, value: window.localStorage.getItem(key) });
    }
    return records.length ? JSON.stringify(records) : null;
  }

  function render() {
    var output = document.getElementById('timeline');
    if (!output) return;
    output.textContent = JSON.stringify({
      calls: calls,
      riseCalls: riseCalls,
      snapshots: snapshots,
      transportAttempts: transportAttempts,
      beaconAttempts: beaconAttempts,
      seatTimeRequests: seatTimeRequests,
      seatTimeBeaconAttempts: seatTimeBeaconAttempts,
      seatTimeResponseControlCount: seatTimeResponseControls.length
    }, null, 2);
  }

  window.localLmsHarness = {
    values: values,
    calls: calls,
    riseCalls: riseCalls,
    snapshots: snapshots,
    transportAttempts: transportAttempts,
    beaconAttempts: beaconAttempts,
    seatTimeRequests: seatTimeRequests,
    seatTimeBeaconAttempts: seatTimeBeaconAttempts,
    seatTimeOutboxWrites: seatTimeOutboxWrites,
    seatTimeResponseControls: seatTimeResponseControls,
    failure: failure,
    lifecycle: lifecycle,
    privacySentinel: privacySentinel,
    timegateReady: !timegateMode,
    bootstrapSuspendWrite: null,
    latestSnapshot: latestSnapshot,
    reset: function () {
      calls.length = 0;
      riseCalls.length = 0;
      snapshots.length = 0;
      transportAttempts.length = 0;
      beaconAttempts.length = 0;
      seatTimeRequests.length = 0;
      seatTimeBeaconAttempts.length = 0;
      seatTimeOutboxWrites.length = 0;
      seatTimeResponseControls.length = 0;
      lifecycle.initialized = false;
      lifecycle.terminated = false;
      render();
    },
    initialize: function () {
      return typeof window.SCORM_CallLMSInitialize === 'function' ?
        window.SCORM_CallLMSInitialize('') : null;
    },
    readLearner: function () {
      return window.API && typeof window.API.LMSGetValue === 'function' ?
        window.API.LMSGetValue('cmi.core.student_id') : null;
    },
    progress: function (percent) {
      if (window.RiseLMSInterface) {
        return window.RiseLMSInterface.setCourseProgress({
          percentComplete: percent
        });
      }
      return null;
    },
    complete: function () {
      return typeof window.SCORM_CallLMSSetValue === 'function' ?
        window.SCORM_CallLMSSetValue(
          'cmi.core.lesson_status',
          'completed'
        ) : null;
    },
    driverComplete: function () {
      return typeof window.SetReachedEnd === 'function' ?
        window.SetReachedEnd() : null;
    },
    commit: function () {
      return typeof window.SCORM_CallLMSCommit === 'function' ?
        window.SCORM_CallLMSCommit('') : null;
    },
    finish: function () {
      return typeof window.SCORM_CallLMSFinish === 'function' ?
        window.SCORM_CallLMSFinish('') : null;
    },
    seatTimeOutbox: seatTimeOutbox,
    seatTimeOutboxRaw: seatTimeOutboxRaw,
    resolveNextSeatTimeResponse: function (httpOk, jsonOk) {
      for (var index = 0; index < seatTimeResponseControls.length; index++) {
        var control = seatTimeResponseControls[index];
        if (control.settled) continue;
        control.settled = true;
        control.resolve(seatTimeResponse(
          httpOk !== false,
          jsonOk !== false
        ));
        render();
        return true;
      }
      return false;
    },
    setSeatTimeResponseMode: function (mode) {
      seatTimeResponseMode = String(mode || 'ok');
    },
    quizFailure: function () {
      if (!window.RiseLMSInterface) return null;
      window.RiseLMSInterface.reportAnswer({
        itemId: 'question-1',
        id: 'quiz-1',
        type: 'multiple-choice',
        isCorrect: false,
        latency: 320,
        retryAttempts: 0,
        learnerResponse: privacySentinel,
        correctResponse: 'Never transmitted'
      });
      return window.RiseLMSInterface.finishQuiz(false, 40, 'quiz-1');
    },
    quizRetry: function () {
      if (!window.RiseLMSInterface) return null;
      window.RiseLMSInterface.reportAnswer({
        itemId: 'question-1',
        id: 'quiz-1',
        type: 'multiple-choice',
        isCorrect: true,
        latency: 180,
        retryAttempts: 1,
        learnerResponse: privacySentinel,
        correctResponse: 'Never transmitted'
      });
      return window.RiseLMSInterface.finishQuiz(true, 100, 'quiz-1');
    },
    render: render
  };

  if (timegateMode) {
    window.addEventListener('DOMContentLoaded', function () {
      var script = document.createElement('script');
      script.src = '../../../src/timegate.js';
      if (params.get('storage') === 'localStorage') {
        script.setAttribute(
          'data-timegate-storage-mode',
          'localStorage'
        );
      }
      script.onload = function () {
        if (params.get('earlySuspendWrite') === '1') {
          if (!lifecycle.initialized) {
            window.localLmsHarness.initialize();
          }
          var authoredSuspendData = JSON.stringify({
            v: 3,
            d: 'NEW-RISE-STATE'
          });
          var suspendWriteStart = calls.length;
          var supportReadyBeforeWrite = !!(
            window.__SIS_TIMEGATE_SUPPORT__ &&
            typeof window.__SIS_TIMEGATE_SUPPORT__.build === 'function'
          );
          var suspendWriteResult = window.SCORM_CallLMSSetValue(
            'cmi.suspend_data',
            authoredSuspendData
          );
          window.localLmsHarness.bootstrapSuspendWrite = {
            authored: authoredSuspendData,
            calls: calls.slice(suspendWriteStart),
            persisted: values['cmi.suspend_data'],
            result: suspendWriteResult,
            supportReadyBeforeWrite: supportReadyBeforeWrite
          };
        }
        window.localLmsHarness.timegateReady = true;
        window.dispatchEvent(new Event('timegate-harness-ready'));
        render();
      };
      document.head.appendChild(script);
    });
  }
})();
