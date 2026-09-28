'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { MessageChannel } = require('node:worker_threads');

const ROOT = path.resolve(__dirname, '../..');
const HOST_SOURCE = fs.readFileSync(
  path.join(ROOT, 'src/observability/host.js'),
  'utf8',
);

function eventTarget(target) {
  const listeners = new Map();
  target.addEventListener = function (type, listener) {
    const current = listeners.get(type) || [];
    current.push(listener);
    listeners.set(type, current);
  };
  target.removeEventListener = function (type, listener) {
    const current = listeners.get(type) || [];
    listeners.set(type, current.filter((item) => item !== listener));
  };
  target.dispatchEvent = function (event) {
    if (!event || !event.type) throw new Error('Event type is required');
    for (const listener of (listeners.get(event.type) || []).slice()) {
      listener.call(target, event);
    }
    return true;
  };
  return target;
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function courseDescriptor() {
  return {
    schemaVersion: 1,
    scormVersion: '1.2',
    manifestIdentifier: 'manifest-safe',
    organizationIdentifier: 'ORGANIZATION_PRIVATE_SENTINEL',
    title: 'Support report test course',
    scoResourceIdentifier: 'sco-private',
    scoLaunchPath: '/launch/SECRET_LAUNCH_PATH_SENTINEL?token=secret',
    riseCourseId: 'rise-safe',
    packageVersion: 'package-safe',
    runtimePackageVersion: 'runtime-safe',
    structureHash: 'a'.repeat(64),
    paycomCourseId: 'course-safe',
    lessons: [],
    warnings: [],
  };
}

function createHost(options = {}) {
  const calls = [];
  const fetchCalls = [];
  const values = {
    'cmi.core.student_id': 'LEARNER_ID_SENTINEL',
    'cmi.core.lesson_status': 'incomplete',
  };
  const flags = {
    initialize: true,
    setValue: true,
    commit: true,
    finish: true,
  };
  const window = eventTarget({});
  const document = eventTarget({});
  const contentWindow = eventTarget({});
  const frame = { contentWindow };

  document.getElementById = (id) => id === 'content-frame' ? frame : null;
  document.querySelector = () => null;
  document.createEvent = () => ({
    initCustomEvent(type, bubbles, cancelable, detail) {
      this.type = type;
      this.detail = detail;
    },
  });

  class FakeCustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
  }

  Object.assign(window, {
    window,
    self: window,
    globalThis: window,
    parent: window,
    top: window,
    document,
    location: {
      origin: 'https://training.example',
      href: 'https://training.example/scormdriver/indexAPI.html',
    },
    navigator: {},
    performance: {
      getEntriesByType() {
        return [{ type: 'navigate' }];
      },
    },
    sessionStorage: memoryStorage(),
    crypto: crypto.webcrypto,
    TextEncoder,
    URL,
    Uint8Array,
    Blob,
    Promise,
    MessageChannel,
    CustomEvent: FakeCustomEvent,
    setTimeout,
    clearTimeout,
    setInterval() {
      return 1;
    },
    clearInterval() {},
    console: { log() {}, warn() {}, error() {} },
  });

  window.navigator.sendBeacon = () => true;
  if (!options.fetchUnavailable) {
    window.fetch = function (url, fetchOptions) {
      fetchCalls.push({ url, options: fetchOptions });
      if (options.fetchNever) return new Promise(() => {});
      if (options.fetchReject) return Promise.reject(new Error('offline'));
      return Promise.resolve({ ok: true });
    };
  }

  function setError(code) {
    window.intSCORMError = String(code);
  }

  window.SCORM_CallLMSInitialize = function () {
    calls.push('Initialize');
    setError(flags.initialize ? 0 : 101);
    return flags.initialize ? 'true' : 'false';
  };
  window.SCORM_CallLMSGetValue = function (element) {
    calls.push('GetValue');
    setError(0);
    return Object.prototype.hasOwnProperty.call(values, element) ?
      values[element] : '';
  };
  window.SCORM_CallLMSSetValue = function (element, value) {
    calls.push('SetValue');
    setError(flags.setValue ? 0 : 351);
    if (flags.setValue) values[element] = value;
    return flags.setValue ? 'true' : 'false';
  };
  window.SCORM_CallLMSCommit = function () {
    calls.push('Commit');
    setError(flags.commit ? 0 : 391);
    return flags.commit ? 'true' : 'false';
  };
  window.SCORM_CallLMSFinish = function () {
    calls.push('Finish');
    setError(flags.finish ? 0 : 101);
    return flags.finish ? 'true' : 'false';
  };

  function noop() {}
  window.RiseLMSInterface = {
    initialize: noop,
    start: noop,
    setCourseProgress: noop,
    setLessonProgress: noop,
    finish: noop,
    finishQuiz: noop,
    finishStoryline: noop,
    reportAnswer: noop,
    reportUngradedAnswers: noop,
    setBookmark: noop,
    setSessionTime: noop,
    pauseTimeTracking: noop,
    resumeTimeTracking: noop,
    reportScore: noop,
    setScore: noop,
    exit: noop,
    suspend: noop,
    timeout: noop,
    unload: noop,
    commit: noop,
  };

  window.__SIS_OBSERVABILITY_CONFIG__ = {
    enabled: true,
    endpoint: 'https://ENDPOINT_SENTINEL.example/collect',
    source: {
      keyId: 'SOURCE_KEY_ID_SENTINEL',
      token: 'TRANSPORT_TOKEN_SENTINEL',
    },
    course: courseDescriptor(),
    instrumentationVersion: 'observability-test',
    timegateVersion: 'timegate-test',
    corsFallbackBaseDelayMs: 0,
    corsFallbackJitterMs: 0,
  };

  vm.runInNewContext(HOST_SOURCE, window, { filename: 'host.js' });
  return { window, document, values, flags, calls, fetchCalls };
}

function dispatchTimegate(host, type, detail = {}) {
  host.document.dispatchEvent(new host.window.CustomEvent('sis:timegate', {
    detail: {
      version: 1,
      type,
      ...detail,
    },
  }));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test('public support projection is allowlisted, read-only, and returns fresh copies', async () => {
  const host = createHost();
  await settle();
  host.window.SCORM_CallLMSInitialize('');
  host.window.SCORM_CallLMSGetValue('cmi.core.student_id');
  host.window.SCORM_CallLMSSetValue(
    'cmi.interactions.0.student_response',
    'ANSWER_SENTINEL',
  );
  dispatchTimegate(host, 'persistence_failed', {
    reason: 'ARBITRARY_ISSUE_SENTINEL',
    backend: 'PRIVATE_BACKEND_SENTINEL',
  });
  await settle();

  const runtime = host.window.__SIS_OBSERVABILITY__;
  const revisionBefore = runtime.status().revision;
  const callsBefore = host.calls.length;
  const requestsBefore = host.fetchCalls.length;
  const snapshot = plain(runtime.publicSupportSnapshot());

  assert.deepEqual(Object.keys(snapshot), [
    'schemaVersion',
    'session',
    'delivery',
    'instrumentation',
    'course',
    'state',
    'issues',
    'diagnosticTail',
  ]);
  assert.deepEqual(Object.keys(snapshot.session), [
    'id',
    'revision',
    'lifecycle',
  ]);
  assert.deepEqual(Object.keys(snapshot.delivery), ['enabled', 'state']);
  assert.deepEqual(Object.keys(snapshot.course), [
    'title',
    'paycomCourseId',
    'riseCourseId',
    'manifestIdentifier',
    'packageVersion',
    'runtimePackageVersion',
    'structureHash',
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'learner'), false);
  assert.equal(snapshot.delivery.enabled, true);
  assert.equal(snapshot.delivery.state, 'succeeded');
  assert.equal(runtime.status().revision, revisionBefore);
  assert.equal(host.calls.length, callsBefore);
  assert.equal(host.fetchCalls.length, requestsBefore);

  const serialized = JSON.stringify(snapshot);
  for (const sentinel of [
    'LEARNER_ID_SENTINEL',
    'ANSWER_SENTINEL',
    'TRANSPORT_TOKEN_SENTINEL',
    'SOURCE_KEY_ID_SENTINEL',
    'ENDPOINT_SENTINEL',
    'SECRET_LAUNCH_PATH_SENTINEL',
    'ORGANIZATION_PRIVATE_SENTINEL',
    'ARBITRARY_ISSUE_SENTINEL',
    'PRIVATE_BACKEND_SENTINEL',
  ]) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }

  const first = runtime.publicSupportSnapshot();
  first.course.title = 'MUTATED';
  first.issues[0].code = 'MUTATED';
  first.diagnosticTail[0].code = 'MUTATED';
  const second = plain(runtime.publicSupportSnapshot());
  assert.equal(second.course.title, 'Support report test course');
  assert.equal(JSON.stringify(second).includes('MUTATED'), false);
});

test('public support projection maps completion failures and bounds diagnostics', async () => {
  const host = createHost();
  await settle();
  host.window.SCORM_CallLMSInitialize('');
  host.window.SCORM_CallLMSSetValue(
    'cmi.core.lesson_status',
    'completed',
  );
  host.flags.commit = false;
  host.window.SCORM_CallLMSCommit('');
  dispatchTimegate(host, 'minimum_time_met', {
    activeSeconds: 900,
    idleSeconds: 12,
  });
  for (let index = 0; index < 30; index += 1) {
    dispatchTimegate(host, index % 2 ? 'idle_entered' : 'idle_exited', {
      activeSeconds: 900 + index,
      idleSeconds: 12 + index,
    });
  }

  const snapshot = plain(
    host.window.__SIS_OBSERVABILITY__.publicSupportSnapshot(),
  );
  assert.equal(snapshot.state.initialized, true);
  assert.equal(snapshot.state.completionWritten, true);
  assert.equal(snapshot.state.completionCommitted, false);
  assert.equal(snapshot.state.lastCommitResult, false);
  assert.equal(snapshot.state.lastErrorCode, '391');
  assert.ok(snapshot.state.activeSeconds >= 900);

  const commitIssue = snapshot.issues.find(
    (issue) => issue.code === 'LMS_COMMIT_FAILED',
  );
  assert.ok(commitIssue);
  assert.deepEqual(Object.keys(commitIssue), [
    'code',
    'severity',
    'active',
    'firstSeenAt',
    'lastSeenAt',
    'occurrenceCount',
  ]);
  assert.equal(commitIssue.active, true);
  assert.ok(snapshot.issues.length <= 10);
  assert.ok(snapshot.diagnosticTail.length <= 20);

  assert.ok(snapshot.diagnosticTail.some(
    (event) => event.code === 'COURSE_COMPLETION_WRITE',
  ));
  const commitEvent = snapshot.diagnosticTail.find(
    (event) => event.code === 'LMS_COMMIT',
  );
  assert.ok(commitEvent);
  assert.equal(commitEvent.result, 'failure');
  assert.equal(commitEvent.operation, 'scorm_commit');
  assert.equal(commitEvent.errorCode, '391');
  const minimumEvent = snapshot.diagnosticTail.find(
    (event) => event.code === 'MINIMUM_TIME_MET',
  );
  assert.ok(minimumEvent);
  assert.equal(minimumEvent.result, 'success');
  for (const event of snapshot.diagnosticTail) {
    const allowedKeys = new Set([
      'sequence',
      'occurredAt',
      'code',
      'result',
      'operation',
      'errorCode',
    ]);
    assert.ok(event.occurredAt);
    assert.ok(Object.keys(event).every((key) => allowedKeys.has(key)));
  }
});

test('public support projection reports pending, failed, and unavailable delivery', async () => {
  const pending = createHost({ fetchNever: true });
  await settle();
  assert.equal(
    pending.window.__SIS_OBSERVABILITY__.publicSupportSnapshot().delivery.state,
    'pending',
  );

  const failed = createHost({ fetchReject: true });
  await settle();
  assert.equal(
    failed.window.__SIS_OBSERVABILITY__.publicSupportSnapshot().delivery.state,
    'failed',
  );

  const unavailable = createHost({ fetchUnavailable: true });
  await settle();
  assert.equal(
    unavailable.window.__SIS_OBSERVABILITY__.publicSupportSnapshot().delivery.state,
    'unavailable',
  );
});
