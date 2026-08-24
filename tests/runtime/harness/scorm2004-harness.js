(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var floorMode = params.get('floor') === 'immediate' ? 'immediate' : 'delay';
  var harness = window.localLmsHarness;
  var values = harness.values;
  var calls = harness.calls;
  var failure = harness.failure;
  var lifecycle = harness.lifecycle;

  values['cmi.learner_id'] =
    params.get('learner') || 'SCORM-2004-LEARNER';
  values['cmi.entry'] = 'ab-initio';
  values['cmi.completion_status'] = 'incomplete';
  values['cmi.success_status'] = 'unknown';
  values['cmi.score.raw'] = '';
  values['cmi.location'] = '';
  values['cmi.exit'] = '';
  values['cmi.session_time'] = '';

  function recordCall() {
    calls.push(Array.prototype.slice.call(arguments));
    harness.render();
  }

  function booleanResult(succeeded, errorCode) {
    window.intSCORMError = succeeded ? '0' : String(errorCode || 101);
    return succeeded ? 'true' : 'false';
  }

  function sessionIsActive() {
    return lifecycle.initialized && !lifecycle.terminated;
  }

  window.API_1484_11 = {
    Initialize: function () {
      recordCall('Initialize');
      var succeeded = !!(
        !failure.initialize &&
        !lifecycle.initialized &&
        !lifecycle.terminated
      );
      if (succeeded) lifecycle.initialized = true;
      return booleanResult(succeeded, 103);
    },
    GetValue: function (element) {
      recordCall('GetValue', element);
      if (!sessionIsActive()) {
        window.intSCORMError = '122';
        return '';
      }
      window.intSCORMError = '0';
      return Object.prototype.hasOwnProperty.call(values, element) ?
        values[element] : '';
    },
    SetValue: function (element, value) {
      recordCall('SetValue', element, value);
      var succeeded = sessionIsActive() && !failure.setValue;
      if (succeeded) values[element] = String(value);
      return booleanResult(succeeded, sessionIsActive() ? 351 : 132);
    },
    Commit: function () {
      recordCall('Commit');
      return booleanResult(
        sessionIsActive() && !failure.commit,
        sessionIsActive() ? 391 : 142
      );
    },
    Terminate: function () {
      recordCall('Terminate');
      var succeeded = sessionIsActive() && !failure.finish;
      if (succeeded) {
        lifecycle.initialized = false;
        lifecycle.terminated = true;
      }
      return booleanResult(succeeded, succeeded ? 0 : 113);
    }
  };

  window.SCORM_CallLMSInitialize = function (value) {
    return window.API_1484_11.Initialize(value);
  };
  window.SCORM_CallLMSGetValue = function (element) {
    return window.API_1484_11.GetValue(element);
  };
  window.SCORM_CallLMSSetValue = function (element, value) {
    return window.API_1484_11.SetValue(element, value);
  };
  window.SCORM_CallLMSCommit = function (value) {
    return window.API_1484_11.Commit(value);
  };
  window.SCORM_CallLMSFinish = function (value) {
    return window.API_1484_11.Terminate(value);
  };

  var baseReset = harness.reset;
  harness.reset = function () {
    baseReset();
    failure.initialize = false;
    failure.setValue = false;
    failure.commit = false;
    failure.finish = false;
    values['cmi.entry'] = 'ab-initio';
    values['cmi.completion_status'] = 'incomplete';
    values['cmi.success_status'] = 'unknown';
    values['cmi.session_time'] = '';
    values['cmi.exit'] = '';
  };
  harness.rawApi = window.API_1484_11;
  harness.apiVersion = '2004';
  harness.timegateReady = false;
  harness.initialize = function () {
    return window.SCORM_CallLMSInitialize('');
  };
  harness.readLearner = function () {
    return window.SCORM_CallLMSGetValue('cmi.learner_id');
  };
  harness.complete = function () {
    return window.SCORM_CallLMSSetValue(
      'cmi.completion_status',
      'completed'
    );
  };
  harness.setSuccess = function (value) {
    return window.SCORM_CallLMSSetValue('cmi.success_status', value);
  };
  harness.commit = function () {
    return window.SCORM_CallLMSCommit('');
  };
  harness.finish = function () {
    return window.SCORM_CallLMSFinish('');
  };

  window.__SIS_OBSERVABILITY_CONFIG__.course.scormVersion = '2004';
  window.__SIS_OBSERVABILITY_CONFIG__.course.title =
    'Local SCORM 2004 Timegate Harness';
  window.TIMEGATE_CONFIG = {
    courseKey: 'observability-browser-scorm2004-' + floorMode,
    minRequiredMinutes: floorMode === 'immediate' ? 0 : 0.04,
    maxAllowedMinutes: null,
    enforceCompletion: true,
    idleTimeoutSeconds: 120,
    backgroundGraceSeconds: 0,
    countWhileMediaPlaying: false,
    hideWhenComplete: false,
    position: 'bottom-right',
    debug: false,
    storageMode: 'localStorage',
    inactivityForceExitEnabled: false,
    inactivityForceExitMinutes: 5,
    inactivityWarningSeconds: 30,
    gentleNudgeEnabled: false,
    launchModalEnabled: false,
    disableVideoSkip: false
  };
})();
