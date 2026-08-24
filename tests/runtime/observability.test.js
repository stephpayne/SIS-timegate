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
  'utf8'
);
const PROBE_SOURCE = fs.readFileSync(
  path.join(ROOT, 'src/observability/content-probe.js'),
  'utf8'
);
const TIMEGATE_SOURCE = fs.readFileSync(
  path.join(ROOT, 'src/timegate.js'),
  'utf8'
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
    if (!Object.prototype.hasOwnProperty.call(event, 'target')) event.target = target;
    for (const listener of (listeners.get(event.type) || []).slice()) {
      listener.call(target, event);
    }
    return true;
  };
  target.__listeners = listeners;
  return target;
}

function memoryStorage(shared = new Map(), options = {}) {
  return {
    getItem(key) {
      if (options.throwOnRead) throw new Error('storage read disabled');
      return shared.has(key) ? shared.get(key) : null;
    },
    setItem(key, value) {
      if (options.throwOnWrite) throw new Error('storage write disabled');
      shared.set(key, String(value));
    },
    removeItem(key) {
      shared.delete(key);
    },
    shared
  };
}

function descriptor() {
  return {
    schemaVersion: 1,
    scormVersion: '1.2',
    manifestIdentifier: 'manifest-1',
    organizationIdentifier: 'organization-1',
    title: 'Runtime test course',
    scoResourceIdentifier: 'sco-1',
    scoLaunchPath: 'scormdriver/indexAPI.html',
    riseCourseId: 'rise-course-1',
    packageVersion: 'package-1',
    runtimePackageVersion: 'package-1',
    navigationMode: 'free',
    forcedCommitIntervalSeconds: 20,
    completionPolicy: {
      reporting: 'completed-incomplete',
      completionPercentage: 100,
      resetLearnerData: false,
      triggerType: 'progress',
      triggerId: null
    },
    lessons: [{
      id: 'lesson-1',
      type: 'lesson',
      blocks: [{
        id: 'block-1',
        type: 'video',
        family: 'media',
        variant: 'video',
        forwardSeekRestricted: true,
        media: [{ id: 'media-1', type: 'video', durationSeconds: 12.5 }],
        continueGates: [{ id: 'gate-1', completionItemId: 'media-1' }]
      }]
    }],
    warnings: [],
    structureHash: 'a'.repeat(64),
    paycomCourseId: 'PAYCOM-COURSE-1'
  };
}

function createHost(options = {}) {
  const bodies = [];
  const fetchCalls = [];
  const beacons = [];
  const calls = [];
  const intervals = [];
  const shared = options.sharedStorage || new Map();
  const storage = memoryStorage(shared, options.storageOptions);
  const flags = {
    initialize: true,
    setValue: true,
    commit: true,
    finish: true,
    getError: false,
    throwGet: null
  };
  const values = {
    'cmi.core.student_id': options.learnerId || 'EMPLOYEE-001',
    'cmi.core.student_name': '',
    'cmi.core.lesson_status': 'incomplete',
    'cmi.suspend_data': ''
  };
  const window = eventTarget({});
  const document = eventTarget({});
  const contentWindow = eventTarget({});
  const frame = { contentWindow };

  document.getElementById = (id) => id === 'content-frame' ? frame : null;
  document.querySelector = (selector) =>
    selector === 'iframe[name="scormdriver_content"]' ? frame : null;
  document.createEvent = () => ({
    initCustomEvent(type, bubbles, cancelable, detail) {
      this.type = type;
      this.detail = detail;
    }
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
      pathname: '/scormdriver/indexAPI.html',
      hash: ''
    },
    navigator: {},
    performance: {
      getEntriesByType(type) {
        if (type !== 'navigation') return [];
        return [{ type: options.navigationType || 'navigate' }];
      },
      navigation: {
        type:
          options.navigationType === 'reload' ? 1 :
          options.navigationType === 'back_forward' ? 2 : 0
      }
    },
    sessionStorage: storage,
    crypto: options.noCrypto ? undefined : crypto.webcrypto,
    TextEncoder,
    URL,
    Uint8Array,
    Blob,
    Promise,
    MessageChannel,
    CustomEvent: FakeCustomEvent,
    setTimeout,
    clearTimeout,
    setInterval(callback) {
      intervals.push(callback);
      return intervals.length;
    },
    clearInterval() {},
    console: { log() {}, warn() {}, error() {} }
  });
  if (options.rawApi) {
    const rawApi = {
      LMSGetValue(element) {
        calls.push({
          method: 'rawGetValue',
          args: [element],
          thisValue: this
        });
        return Object.prototype.hasOwnProperty.call(values, element) ?
          values[element] : '';
      }
    };
    if (options.parentRawApi) {
      const parentWindow = { API: rawApi };
      parentWindow.parent = parentWindow;
      window.parent = parentWindow;
    } else {
      window.API = rawApi;
    }
  }

  window.navigator.sendBeacon = function (url, blob) {
    Promise.resolve(blob.text()).then((body) => {
      beacons.push(body);
    });
    return true;
  };
  window.fetch = function (url, fetchOptions) {
    bodies.push(fetchOptions.body);
    fetchCalls.push({ url, options: fetchOptions });
    if (options.fetchNever) return new Promise(() => {});
    if (options.corsFallback && fetchOptions.mode === 'cors') {
      return Promise.reject(new Error('cors response blocked'));
    }
    if (options.fetchReject) return Promise.reject(new Error('offline'));
    return Promise.resolve({ ok: true });
  };

  function setCachedError(code, message = '') {
    window.intSCORMError = String(code);
    window.strSCORMErrorString = message;
    window.strSCORMErrorDiagnostic = message;
  }

  if (!options.missingScorm) {
    window.SCORM_CallLMSInitialize = function (...args) {
      calls.push({ method: 'initialize', args, thisValue: this });
      setCachedError(flags.initialize ? 0 : 101, 'initialize failed');
      return flags.initialize ? 'true' : 'false';
    };
    window.SCORM_CallLMSGetValue = function (element) {
      calls.push({ method: 'getValue', args: [element], thisValue: this });
      if (flags.throwGet) throw flags.throwGet;
      if (flags.getError) {
        setCachedError(301, 'rejected value SUSPEND_ERROR_ECHO_SENTINEL');
        return 'SUSPEND_ERROR_ECHO_SENTINEL';
      }
      setCachedError(0);
      return Object.prototype.hasOwnProperty.call(values, element) ? values[element] : '';
    };
    window.SCORM_CallLMSSetValue = function (element, value) {
      calls.push({ method: 'setValue', args: [element, value], thisValue: this });
      if (typeof options.onSetValue === 'function') {
        options.onSetValue({ document, element, value, window });
      }
      setCachedError(
        flags.setValue ? 0 : 351,
        'rejected ANSWER_ERROR_ECHO_SENTINEL'
      );
      if (flags.setValue) values[element] = value;
      return flags.setValue ? 'true' : 'false';
    };
    window.SCORM_CallLMSCommit = function (...args) {
      calls.push({ method: 'commit', args, thisValue: this });
      setCachedError(flags.commit ? 0 : 391, 'commit failed token=COMMIT_TOKEN_SENTINEL');
      return flags.commit ? 'true' : 'false';
    };
    window.SCORM_CallLMSFinish = function (...args) {
      calls.push({ method: 'finish', args, thisValue: this });
      if (typeof options.onFinish === 'function') {
        options.onFinish({ document, window });
      }
      setCachedError(flags.finish ? 0 : 101, 'finish failed');
      return flags.finish ? 'true' : 'false';
    };
  }

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
    commit: noop
  };
  window.__SIS_OBSERVABILITY_CONFIG__ = {
    enabled: true,
    endpoint: 'https://worker.example/scorm',
    source: {
      keyId: 'runtime-tests',
      token: 'runtime-test-token'
    },
    course: options.course || descriptor(),
    instrumentationVersion: 'test',
    timegateVersion: 'test',
    corsFallbackBaseDelayMs:
      options.corsFallbackBaseDelayMs === undefined ?
        0 : options.corsFallbackBaseDelayMs,
    corsFallbackJitterMs:
      options.corsFallbackJitterMs === undefined ?
        0 : options.corsFallbackJitterMs
  };

  vm.runInNewContext(HOST_SOURCE, window, { filename: 'host.js' });
  return {
    window,
    document,
    contentWindow,
    storage,
    shared,
    values,
    flags,
    calls,
    bodies,
    fetchCalls,
    beacons,
    intervals
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 15));
}

function snapshots(host) {
  return host.bodies.concat(host.beacons).map((body) => JSON.parse(body));
}

function latestSnapshot(host) {
  const all = snapshots(host);
  assert.ok(all.length, 'expected at least one snapshot');
  return all.reduce((latest, item) =>
    item.session.revision > latest.session.revision ? item : latest
  );
}

test('wrappers preserve behavior and exclude names, answers, raw state, title IDs, and URL secrets', async () => {
  const host = createHost();
  await settle();
  host.bodies.length = 0;
  host.beacons.length = 0;

  assert.equal(host.window.SCORM_CallLMSInitialize(''), 'true');
  assert.equal(host.window.SCORM_CallLMSGetValue('cmi.core.student_id'), 'EMPLOYEE-001');
  assert.equal(host.calls.at(-1).thisValue, host.window);

  host.values['cmi.core.student_name'] = 'LEARNER_NAME_SENTINEL';
  host.values['cmi.suspend_data'] = 'SUSPEND_DATA_SENTINEL';
  host.window.SCORM_CallLMSGetValue('cmi.core.student_name');
  host.window.SCORM_CallLMSGetValue('cmi.suspend_data');
  host.window.SCORM_CallLMSSetValue(
    'cmi.interactions.0.student_response',
    'ANSWER_RESPONSE_SENTINEL'
  );
  host.window.SCORM_CallLMSSetValue(
    'cmi.interactions.0.correct_responses.0.pattern',
    'CORRECT_RESPONSE_SENTINEL'
  );
  host.window.SCORM_CallLMSSetValue(
    'cmi.interactions.0.id',
    'QUIZ_TITLE_QUESTION_TITLE_SENTINEL'
  );
  host.window.RiseLMSInterface.reportAnswer({
    id: 'quiz-opaque',
    itemId: 'question-opaque',
    type: 'MULTIPLE-CHOICE',
    isCorrect: false,
    latency: 1200,
    retryAttempts: 2,
    quizTitle: 'QUIZ_PROSE_SENTINEL',
    questionTitle: 'QUESTION_PROSE_SENTINEL',
    response: 'RISE_ANSWER_SENTINEL',
    correctResponse: 'RISE_CORRECT_SENTINEL'
  });

  const originalError = new Error(
    'Failed https://service.example/path?token=URL_TOKEN_SENTINEL'
  );
  host.flags.throwGet = originalError;
  assert.throws(
    () => host.window.SCORM_CallLMSGetValue('cmi.core.lesson_status'),
    (error) => error === originalError
  );
  host.flags.throwGet = null;

  await settle(); // allow SHA-256 promises to populate fingerprint events
  host.window.__SIS_OBSERVABILITY__.flush();
  await settle();

  const raw = host.bodies.join('\n');
  for (const sentinel of [
    'LEARNER_NAME_SENTINEL',
    'SUSPEND_DATA_SENTINEL',
    'ANSWER_RESPONSE_SENTINEL',
    'CORRECT_RESPONSE_SENTINEL',
    'QUIZ_TITLE_QUESTION_TITLE_SENTINEL',
    'QUIZ_PROSE_SENTINEL',
    'QUESTION_PROSE_SENTINEL',
    'RISE_ANSWER_SENTINEL',
    'RISE_CORRECT_SENTINEL',
    'URL_TOKEN_SENTINEL'
  ]) {
    assert.equal(raw.includes(sentinel), false, `leaked ${sentinel}`);
  }
  const snapshot = latestSnapshot(host);
  assert.equal(snapshot.learner.lmsLearnerId, 'EMPLOYEE-001');
  assert.equal(snapshot.course.scormVersion, '1.2');
  assert.equal(snapshot.instrumentation.scormVersion, '1.2');
  const fingerprint = snapshot.diagnosticTail.find(
    (event) => event.data && event.data.valueSha256
  );
  assert.ok(fingerprint, 'expected async SHA-256 fingerprint event');
  assert.match(fingerprint.data.valueSha256, /^[0-9a-f]{64}$/);
  assert.ok(
    snapshot.diagnosticTail.some(
      (event) =>
        event.data &&
        event.data.questionId === 'question-opaque' &&
        event.data.quizId === 'quiz-opaque' &&
        event.data.questionType === 'multiple_choice'
    )
  );
});

test('existing ancestor raw API reads populate correlation without an extra LMS call', async () => {
  const host = createHost({ rawApi: true, parentRawApi: true });
  await settle();
  host.bodies.length = 0;

  const rawApi = host.window.parent.API;
  assert.equal(
    rawApi.LMSGetValue('cmi.core.student_id'),
    'EMPLOYEE-001'
  );
  assert.equal(
    host.calls.filter((call) => call.method === 'rawGetValue').length,
    1,
    'observability must not issue its own learner lookup'
  );
  assert.equal(host.calls.at(-1).thisValue, rawApi);

  host.window.__SIS_OBSERVABILITY__.flush();
  await settle();
  assert.equal(latestSnapshot(host).learner.lmsLearnerId, 'EMPLOYEE-001');
});

test('failed duplicate Initialize preserves a confirmed active session', async () => {
  const host = createHost();
  await settle();
  host.bodies.length = 0;

  assert.equal(host.window.SCORM_CallLMSInitialize(''), 'true');
  host.flags.initialize = false;
  assert.equal(host.window.SCORM_CallLMSInitialize(''), 'false');
  host.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'lms_operation_failed',
      operation: 'Initialize',
      reason: 'initialize'
    }
  });
  host.window.__SIS_OBSERVABILITY__.flush();
  await settle();

  const snapshot = latestSnapshot(host);
  assert.equal(snapshot.state.initialized, true);
  assert.equal(
    snapshot.issues.some(
      (issue) => issue.code === 'INITIALIZATION_FAILED' && issue.active
    ),
    false
  );
  const duplicate = snapshot.diagnosticTail.find(
    (event) =>
      event.type === 'scorm_call' &&
      event.data.method === 'Initialize' &&
      event.data.status === 'already_initialized'
  );
  assert.ok(duplicate);
});

test('cached LMS errors populate lastErrorCode without echoing values and terminal lifecycle never regresses', async () => {
  const host = createHost();
  await settle();
  host.bodies.length = 0;

  host.flags.setValue = false;
  assert.equal(
    host.window.SCORM_CallLMSSetValue('cmi.core.lesson_status', 'completed'),
    'false'
  );
  host.flags.setValue = true;
  host.window.SCORM_CallLMSSetValue('cmi.core.score.raw', '88');
  host.flags.commit = false;
  assert.equal(host.window.SCORM_CallLMSCommit(''), 'false');
  host.window.__SIS_OBSERVABILITY__.flush();
  await settle();

  let snapshot = latestSnapshot(host);
  assert.equal(snapshot.state.lastErrorCode, '391');
  assert.equal(JSON.stringify(snapshot).includes('ANSWER_ERROR_ECHO_SENTINEL'), false);
  assert.equal(JSON.stringify(snapshot).includes('COMMIT_TOKEN_SENTINEL'), false);
  assert.ok(snapshot.issues.some((issue) => issue.code === 'COMMIT_FAILED'));
  assert.ok(snapshot.issues.some((issue) => issue.code === 'COMPLETION_WRITE_FAILED'));

  host.flags.commit = true;
  host.window.SCORM_CallLMSCommit('');
  host.window.SCORM_CallLMSFinish('');
  host.window.__SIS_OBSERVABILITY__.flush();
  host.window.dispatchEvent({ type: 'pagehide' });
  await settle();
  snapshot = latestSnapshot(host);
  assert.equal(snapshot.session.lifecycle, 'terminated');
  assert.ok(snapshot.session.endedAt);
  assert.equal(snapshot.state.lastErrorCode, '391', 'last nonzero LMS error is retained');

  host.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'forced_exit',
      reason: 'inactivity',
      activeSeconds: 30,
      durationSeconds: 300
    }
  });
  await settle();
  host.window.__SIS_OBSERVABILITY__.flush();
  host.window.dispatchEvent({ type: 'pagehide' });
  await settle();
  snapshot = latestSnapshot(host);
  assert.equal(snapshot.session.lifecycle, 'forced_exit');
});

test('failed GetValue reads cached error without forwarding returned error text', async () => {
  const host = createHost();
  await settle();
  host.bodies.length = 0;
  host.flags.getError = true;
  host.window.SCORM_CallLMSGetValue('cmi.suspend_data');
  host.window.__SIS_OBSERVABILITY__.flush();
  await settle();
  const snapshot = latestSnapshot(host);
  assert.equal(snapshot.state.lastErrorCode, '301');
  assert.equal(JSON.stringify(snapshot).includes('SUSPEND_ERROR_ECHO_SENTINEL'), false);
});

test('hot path remains below 5ms average and UTF-8 buffers/requests remain bounded', async (t) => {
  const host = createHost({ noCrypto: true });
  await settle();
  host.bodies.length = 0;
  host.values['cmi.core.lesson_status'] = '未完了🔥';

  const iterations = 10000;
  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index++) {
    host.window.SCORM_CallLMSGetValue('cmi.core.lesson_status');
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const averageMs = elapsedMs / iterations;
  t.diagnostic(`wrapped GetValue average: ${averageMs.toFixed(6)}ms`);
  assert.ok(averageMs < 5, `average was ${averageMs}ms`);

  const status = host.window.__SIS_OBSERVABILITY__.status();
  assert.ok(status.bufferedEvents <= 300);
  assert.ok(status.bufferedBytes <= 256 * 1024);
  host.window.__SIS_OBSERVABILITY__.flush();
  await settle();
  const largestBody = Math.max(...host.bodies.map((body) => Buffer.byteLength(body)));
  const snapshot = latestSnapshot(host);
  assert.ok(
    Buffer.byteLength(JSON.stringify(snapshot.diagnosticTail)) <= 32 * 1024
  );
  assert.ok(largestBody <= 64 * 1024);
  assert.ok(
    status.bufferedBytes + largestBody < 1024 * 1024,
    'bounded runtime data is under the 1 MB acceptance ceiling'
  );
});

test('large course descriptors are UTF-8 bounded with an explicit truncation warning', async () => {
  const course = descriptor();
  course.lessons[0].blocks = Array.from({ length: 1000 }, (_, index) => ({
    id: `block-${index}-${'界'.repeat(30)}`,
    type: 'text',
    family: 'text',
    variant: 'paragraph',
    forwardSeekRestricted: false,
    media: [],
    continueGates: []
  }));
  const host = createHost({ course });
  await settle();
  const snapshot = latestSnapshot(host);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.course)) <= 32 * 1024);
  assert.ok(
    snapshot.course.warnings.some(
      (warning) => warning.code === 'CLIENT_DESCRIPTOR_TRUNCATED'
    )
  );
});

test('diagnostic tail accounts for exact UTF-8 array punctuation near 32 KB', async () => {
  const host = createHost();
  await settle();
  host.bodies.length = 0;
  for (let index = 0; index < 150; index++) {
    host.window.RiseLMSInterface.reportAnswer({
      id: `quiz-${index}-${'q'.repeat(220)}`,
      itemId: `question-${index}-${'i'.repeat(215)}`,
      type: index % 2 ? 'MULTIPLE_RESPONSE' : 'FILL-IN-THE-BLANK',
      isCorrect: index % 2 === 0,
      latency: index,
      retryAttempts: 1
    });
  }
  host.window.__SIS_OBSERVABILITY__.flush();
  await settle();
  const tailBytes = Buffer.byteLength(
    JSON.stringify(latestSnapshot(host).diagnosticTail)
  );
  assert.ok(tailBytes > 28 * 1024, `tail was only ${tailBytes} bytes`);
  assert.ok(tailBytes <= 32 * 1024, `tail was ${tailBytes} bytes`);
});

test('abnormal LMS and Rise numbers are clamped to the worker contract', async () => {
  const host = createHost();
  await settle();
  host.bodies.length = 0;
  host.values['cmi.core.score.raw'] = '1e99';
  host.window.SCORM_CallLMSGetValue('cmi.core.score.raw');
  host.window.RiseLMSInterface.setCourseProgress({ percentComplete: 500 });
  host.window.RiseLMSInterface.setScore(-1e99);
  host.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'idle_exited',
      activeSeconds: 1e99,
      idleSeconds: 1e99,
      durationSeconds: 1e99
    }
  });
  host.window.__SIS_OBSERVABILITY__.flush();
  await settle();

  const snapshot = latestSnapshot(host);
  assert.equal(snapshot.state.progressPercent, 100);
  assert.equal(snapshot.state.scoreRaw, -1000000);
  assert.equal(snapshot.state.activeSeconds, 31536000);
  assert.equal(snapshot.state.idleSeconds, 31536000);
  const timegateEvent = snapshot.diagnosticTail.find(
    (event) =>
      event.type === 'timegate_event' &&
      event.data &&
      event.data.operation === 'idle_exited'
  );
  assert.equal(timegateEvent.data.durationSeconds, 1000000000);
  assert.equal(timegateEvent.data.activeSeconds, 1000000000);
});

test('a hung fetch retains only one in-flight and the latest cumulative snapshot', async () => {
  const host = createHost({ fetchNever: true, noCrypto: true });
  await settle();
  for (let revision = 0; revision < 250; revision++) {
    host.window.SCORM_CallLMSGetValue('cmi.core.lesson_status');
    host.window.__SIS_OBSERVABILITY__.flush();
  }
  const status = host.window.__SIS_OBSERVABILITY__.status();
  assert.equal(status.transportQueueDepth, 2);
  assert.ok(status.transportRetainedBytes <= 128 * 1024);
  assert.ok(status.bufferedBytes <= 256 * 1024);
  assert.equal(host.bodies.length, 1, 'only the in-flight request reached fetch');
  const pending = host.shared.get('__sis_observability_pending_v1');
  assert.ok(pending);
  assert.ok(Buffer.byteLength(pending) <= 64 * 1024);
});

test('CORS rejection retries the same revision once in no-cors mode', async () => {
  const host = createHost({ corsFallback: true });
  await settle();
  assert.deepEqual(
    host.fetchCalls.slice(0, 2).map((call) => call.options.mode),
    ['cors', 'no-cors']
  );
  const revisions = host.fetchCalls.slice(0, 2).map(
    (call) => JSON.parse(call.options.body).session.revision
  );
  assert.deepEqual(revisions, [revisions[0], revisions[0]]);
  assert.equal(host.shared.has('__sis_observability_pending_v1'), false);
});

test('CORS fallback waits and suppresses an obsolete revision', async () => {
  const host = createHost({
    corsFallback: true,
    corsFallbackBaseDelayMs: 50
  });
  await settle();
  assert.deepEqual(
    host.fetchCalls.map((call) => call.options.mode),
    ['cors']
  );

  host.window.__SIS_OBSERVABILITY__.flush();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(
    host.fetchCalls.map((call) => call.options.mode),
    ['cors', 'cors']
  );

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(
    host.fetchCalls.map((call) => call.options.mode),
    ['cors', 'cors', 'no-cors']
  );
  const revisions = host.fetchCalls.map(
    (call) => JSON.parse(call.options.body).session.revision
  );
  assert.deepEqual(revisions, [revisions[0], revisions[1], revisions[1]]);
  assert.ok(revisions[1] > revisions[0]);
});

test('sessionStorage quota failure is reported without affecting LMS behavior', async () => {
  const host = createHost({ storageOptions: { throwOnWrite: true } });
  await settle();
  assert.equal(host.window.SCORM_CallLMSGetValue('cmi.core.lesson_status'), 'incomplete');
  host.window.__SIS_OBSERVABILITY__.flush();
  await settle();
  const snapshot = latestSnapshot(host);
  assert.ok(
    snapshot.issues.some((issue) => issue.code === 'TELEMETRY_STORAGE_FAILED')
  );
});

test('offline reload restores cumulative issues, diagnostic tail, session, and sequence', async () => {
  const sharedStorage = new Map();
  const first = createHost({ sharedStorage, fetchReject: true });
  await settle();
  first.window.SCORM_CallLMSGetValue('cmi.core.student_id');
  first.flags.commit = false;
  first.window.SCORM_CallLMSCommit('');
  first.window.__SIS_OBSERVABILITY__.flush();
  await settle();
  const pendingRaw = sharedStorage.get('__sis_observability_pending_v1');
  assert.ok(pendingRaw);
  const pending = JSON.parse(pendingRaw);
  pending.course.authoredProse = 'STORED_PROSE_SENTINEL';
  pending.learner.name = 'STORED_LEARNER_NAME_SENTINEL';
  pending.state.lessonStatus = 'STORED_STATUS_PROSE_SENTINEL';
  pending.state.progressPercent = 1e99;
  pending.state.scoreRaw = -1e99;
  pending.state.lastErrorCode = '9'.repeat(100);
  pending.issues.find(
    (issue) => issue.code === 'COMMIT_FAILED'
  ).occurrenceCount = 1000000;
  pending.diagnosticTail.push({
    sequence: 999999,
    occurredAt: new Date().toISOString(),
    type: 'javascript_error',
    source: 'content_probe',
    severity: 'error',
    data: { message: 'STORED_DIAGNOSTIC_PROSE_SENTINEL' }
  });
  sharedStorage.set(
    '__sis_observability_pending_v1',
    JSON.stringify(pending)
  );

  const second = createHost({
    sharedStorage,
    navigationType: 'reload',
    rawApi: true
  });
  await settle();
  assert.equal(
    second.bodies.length,
    0,
    'quarantined restore must not transmit before identity is observed'
  );
  second.window.API.LMSGetValue('cmi.core.student_id');
  await settle();
  assert.equal(
    second.bodies.length,
    0,
    'identity alone must not release restored telemetry'
  );
  second.window.API.LMSGetValue('cmi.core.lesson_status');
  await settle();
  const restoredLaunch = latestSnapshot(second);
  assert.equal(restoredLaunch.state.lastErrorCode.length, 32);
  second.flags.commit = false;
  second.window.SCORM_CallLMSCommit('');
  second.window.__SIS_OBSERVABILITY__.flush();
  await settle();
  const restored = latestSnapshot(second);
  assert.equal(restored.session.id, pending.session.id);
  assert.equal(
    second.window.__SIS_OBSERVABILITY__.sessionId,
    pending.session.id
  );
  assert.ok(restored.session.revision > pending.session.revision);
  assert.equal(
    restored.issues.find(
      (issue) => issue.code === 'COMMIT_FAILED'
    ).occurrenceCount,
    1000000
  );
  assert.equal(restored.state.lessonStatus, 'incomplete');
  assert.equal(restored.state.progressPercent, 100);
  assert.equal(restored.state.scoreRaw, -1000000);
  assert.ok(restored.state.lastErrorCode.length <= 32);
  const sequences = restored.diagnosticTail.map((event) => event.sequence);
  assert.deepEqual(sequences, sequences.slice().sort((a, b) => a - b));
  const retransmitted = second.bodies.join('\n');
  assert.equal(retransmitted.includes('STORED_PROSE_SENTINEL'), false);
  assert.equal(retransmitted.includes('STORED_LEARNER_NAME_SENTINEL'), false);
  assert.equal(retransmitted.includes('STORED_DIAGNOSTIC_PROSE_SENTINEL'), false);
});

test('same-learner reload cannot restore completion over a live incomplete LMS status', async () => {
  const sharedStorage = new Map();
  const first = createHost({ sharedStorage, fetchReject: true });
  await settle();
  first.window.SCORM_CallLMSGetValue('cmi.core.student_id');
  first.window.SCORM_CallLMSSetValue(
    'cmi.core.lesson_status',
    'completed'
  );
  first.window.SCORM_CallLMSCommit('');
  first.window.__SIS_OBSERVABILITY__.flush();
  await settle();
  const prior = JSON.parse(
    sharedStorage.get('__sis_observability_pending_v1')
  );
  assert.equal(prior.state.lessonStatus, 'completed');
  assert.equal(prior.state.lastCommitResult, true);

  const second = createHost({
    sharedStorage,
    navigationType: 'reload',
    rawApi: true
  });
  await settle();
  second.window.API.LMSGetValue('cmi.core.student_id');
  await settle();
  assert.equal(second.bodies.length, 0);

  second.window.API.LMSGetValue('cmi.core.lesson_status');
  await settle();
  let current = latestSnapshot(second);
  assert.equal(current.session.id, prior.session.id);
  assert.equal(current.state.lessonStatus, 'incomplete');
  assert.equal(current.state.lastCommitResult, undefined);

  second.window.SCORM_CallLMSFinish('');
  second.window.__SIS_OBSERVABILITY__.flush();
  await settle();
  current = latestSnapshot(second);
  assert.equal(current.session.lifecycle, 'terminated');
  assert.equal(current.state.lessonStatus, 'incomplete');
  assert.equal(current.state.lastCommitResult, undefined);
  assert.equal(
    current.issues.some(
      (issue) => issue.code === 'COMPLETION_NOT_COMMITTED' && issue.active
    ),
    false
  );
});

test('same-course pending state is discarded for a different learner', async () => {
  const sharedStorage = new Map();
  const first = createHost({ sharedStorage, fetchReject: true });
  await settle();
  first.window.SCORM_CallLMSGetValue('cmi.core.student_id');
  first.window.SCORM_CallLMSSetValue(
    'cmi.core.lesson_status',
    'completed'
  );
  first.window.__SIS_OBSERVABILITY__.flush();
  await settle();
  const prior = JSON.parse(
    sharedStorage.get('__sis_observability_pending_v1')
  );
  assert.equal(prior.learner.lmsLearnerId, 'EMPLOYEE-001');

  const second = createHost({
    sharedStorage,
    learnerId: 'EMPLOYEE-002',
    navigationType: 'reload'
  });
  await settle();
  assert.equal(second.bodies.length, 0);
  second.window.SCORM_CallLMSGetValue('cmi.core.student_id');
  await settle();
  second.window.__SIS_OBSERVABILITY__.flush();
  await settle();

  const current = latestSnapshot(second);
  assert.equal(current.learner.lmsLearnerId, 'EMPLOYEE-002');
  assert.notEqual(current.session.id, prior.session.id);
  assert.equal(current.state.lessonStatus, undefined);
  const transmitted = second.bodies.join('\n');
  assert.equal(transmitted.includes('EMPLOYEE-001'), false);
  assert.equal(transmitted.includes(prior.session.id), false);
});

test('same learner fresh navigation starts a new course session', async () => {
  const sharedStorage = new Map();
  const first = createHost({ sharedStorage, fetchReject: true });
  await settle();
  first.window.SCORM_CallLMSGetValue('cmi.core.student_id');
  first.window.SCORM_CallLMSSetValue(
    'cmi.core.lesson_status',
    'completed'
  );
  first.window.__SIS_OBSERVABILITY__.flush();
  await settle();
  const prior = JSON.parse(
    sharedStorage.get('__sis_observability_pending_v1')
  );

  const second = createHost({
    sharedStorage,
    learnerId: 'EMPLOYEE-001',
    navigationType: 'navigate'
  });
  await settle();
  second.window.SCORM_CallLMSGetValue('cmi.core.student_id');
  second.window.__SIS_OBSERVABILITY__.flush();
  await settle();

  const current = latestSnapshot(second);
  assert.equal(current.learner.lmsLearnerId, 'EMPLOYEE-001');
  assert.notEqual(current.session.id, prior.session.id);
  assert.equal(current.state.lessonStatus, undefined);
  assert.equal(second.bodies.join('\n').includes(prior.session.id), false);
});

test('pending snapshots are scoped to the exact source and course identity', async () => {
  const sharedStorage = new Map();
  const first = createHost({ sharedStorage, fetchReject: true });
  await settle();
  const firstPending = JSON.parse(
    sharedStorage.get('__sis_observability_pending_v1')
  );

  const anotherCourse = descriptor();
  anotherCourse.paycomCourseId = 'PAYCOM-COURSE-2';
  anotherCourse.structureHash = 'b'.repeat(64);
  const second = createHost({ sharedStorage, course: anotherCourse });
  await settle();

  const current = latestSnapshot(second);
  assert.notEqual(current.session.id, firstPending.session.id);
  assert.equal(current.course.paycomCourseId, 'PAYCOM-COURSE-2');
});

test('pagehide beacon keeps the latest cumulative snapshot pending', async () => {
  const host = createHost();
  await settle();
  assert.equal(host.shared.has('__sis_observability_pending_v1'), false);

  host.window.dispatchEvent({ type: 'pagehide' });
  await settle();
  const pending = JSON.parse(
    host.shared.get('__sis_observability_pending_v1')
  );
  assert.equal(pending.session.lifecycle, 'page_hidden');
  assert.ok(host.beacons.length >= 1);
});

test('Timegate is the canonical active and idle clock and replay failures become issues', async () => {
  const host = createHost();
  await settle();
  host.bodies.length = 0;

  host.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'tracking_started',
      activeSeconds: 12,
      idleSeconds: 4
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  host.window.__SIS_OBSERVABILITY__.flush();
  await settle();
  let snapshot = latestSnapshot(host);
  assert.equal(snapshot.state.activeSeconds, 12);
  assert.equal(snapshot.state.idleSeconds, 4);

  host.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'completion_replayed',
      reason: 'scorm',
      canonicalCompletion: true,
      activeSeconds: 14,
      idleSeconds: 5,
      success: false,
      resultBoolean: false
    }
  });
  await settle();
  snapshot = latestSnapshot(host);
  assert.equal(snapshot.state.activeSeconds, 14);
  assert.equal(snapshot.state.idleSeconds, 5);
  assert.ok(
    snapshot.issues.some(
      (issue) => issue.code === 'COMPLETION_WRITE_FAILED' && issue.active
    )
  );
  assert.ok(
    snapshot.issues.some(
      (issue) => issue.code === 'COMMIT_FAILED' && issue.active
    )
  );
  assert.ok(
    snapshot.issues.some(
      (issue) => issue.code === 'COMPLETION_NOT_COMMITTED' && issue.active
    )
  );
});

test('Timegate persistence recovery resolves the active durability issue', async () => {
  const host = createHost();
  await settle();
  host.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'persistence_failed',
      reason: 'write_failed',
      backend: 'dual'
    }
  });
  await settle();
  let snapshot = latestSnapshot(host);
  assert.ok(
    snapshot.issues.some(
      (issue) =>
        issue.code === 'TIMEGATE_PERSISTENCE_FAILED' && issue.active
    )
  );

  host.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'persistence_recovered',
      reason: 'write_succeeded',
      backend: 'dual'
    }
  });
  await settle();
  snapshot = latestSnapshot(host);
  assert.equal(
    snapshot.issues.some(
      (issue) =>
        issue.code === 'TIMEGATE_PERSISTENCE_FAILED' && issue.active
    ),
    false
  );
});

test('synchronous direct replay commit survives the enclosing SetValue observer', async () => {
  const host = createHost({
    onSetValue({ document, element, value }) {
      if (element !== 'cmi.core.lesson_status' || value !== 'completed') return;
      document.dispatchEvent({
        type: 'sis:timegate',
        detail: {
          version: 1,
          type: 'completion_replayed',
          reason: 'scorm',
          replayMode: 'direct',
          canonicalCompletion: true,
          completionStatus: value,
          success: true,
          resultBoolean: true
        }
      });
    }
  });
  await settle();
  host.bodies.length = 0;

  host.window.SCORM_CallLMSSetValue(
    'cmi.core.lesson_status',
    'completed'
  );
  host.window.SCORM_CallLMSFinish('');
  host.window.__SIS_OBSERVABILITY__.flush();
  await settle();

  const snapshot = latestSnapshot(host);
  assert.equal(snapshot.state.lessonStatus, 'completed');
  assert.equal(snapshot.session.lifecycle, 'terminated');
  assert.equal(
    snapshot.issues.some(
      (issue) =>
        (issue.code === 'COMMIT_FAILED' ||
          issue.code === 'COMPLETION_NOT_COMMITTED') &&
        issue.active
    ),
    false
  );
});

test('confirmed Rise replay is committed completion and reset clears terminal state', async () => {
  const host = createHost();
  await settle();
  host.bodies.length = 0;

  host.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'completion_replayed',
      reason: 'rise_driver',
      canonicalCompletion: true,
      completionStatus: 'replayed',
      success: false
    }
  });
  host.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'completion_replayed',
      reason: 'rise_driver',
      canonicalCompletion: true,
      completionStatus: 'replayed',
      success: true
    }
  });
  host.window.SCORM_CallLMSFinish('');
  host.window.__SIS_OBSERVABILITY__.flush();
  await settle();

  let snapshot = latestSnapshot(host);
  assert.equal(snapshot.session.lifecycle, 'terminated');
  assert.equal(
    snapshot.issues.some(
      (issue) =>
        (issue.code === 'COMPLETION_WRITE_FAILED' ||
          issue.code === 'COMPLETION_NOT_COMMITTED') &&
        issue.active
    ),
    false
  );

  const reset = createHost();
  await settle();
  reset.bodies.length = 0;
  reset.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'completion_gated',
      completionStatus: 'completed'
    }
  });
  reset.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'completion_reset',
      completionStatus: 'incomplete',
      canonicalCompletion: true
    }
  });
  reset.window.SCORM_CallLMSFinish('');
  reset.window.__SIS_OBSERVABILITY__.flush();
  await settle();
  snapshot = latestSnapshot(reset);
  assert.equal(snapshot.state.lessonStatus, 'incomplete');
  assert.equal(snapshot.session.lifecycle, 'terminated');
  assert.equal(
    snapshot.issues.some(
      (issue) => issue.code === 'COMPLETION_NOT_COMMITTED' && issue.active
    ),
    false
  );

  const outcomeReset = createHost({
    course: Object.assign(descriptor(), { scormVersion: '2004' })
  });
  await settle();
  outcomeReset.bodies.length = 0;
  outcomeReset.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'completion_gated',
      completionStatus: 'completed',
      success: true
    }
  });
  outcomeReset.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'completion_reset',
      completionStatus: 'unknown',
      canonicalCompletion: false
    }
  });
  outcomeReset.window.SCORM_CallLMSFinish('');
  outcomeReset.window.__SIS_OBSERVABILITY__.flush();
  await settle();
  snapshot = latestSnapshot(outcomeReset);
  assert.equal(snapshot.state.lessonStatus, undefined);
  assert.ok(
    snapshot.issues.some(
      (issue) => issue.code === 'COMPLETION_NOT_COMMITTED' && issue.active
    )
  );
});

test('Timegate configuration and LMS finalization failures are active and privacy-safe', async () => {
  const host = createHost();
  await settle();
  host.bodies.length = 0;
  const secret = 'PRIVATE_CONFIGURATION_DETAIL_SENTINEL';

  host.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'configuration_failed',
      reason: secret
    }
  });
  host.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'lms_operation_failed',
      reason: secret,
      operation: 'finalize',
      sessionTime: false,
      persistence: true,
      resultBoolean: false
    }
  });
  host.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'lms_operation_failed',
      reason: 'course',
      operation: 'LMSFinish'
    }
  });
  host.window.__SIS_OBSERVABILITY__.flush();
  await settle();

  const snapshot = latestSnapshot(host);
  const issues = Object.fromEntries(
    snapshot.issues.map((issue) => [issue.code, issue])
  );
  assert.equal(issues.TIMEGATE_CONFIGURATION_FAILED.active, true);
  assert.equal(issues.TIMEGATE_CONFIGURATION_FAILED.severity, 'error');
  assert.equal(issues.LMS_FINALIZATION_FAILED.active, true);
  assert.deepEqual(issues.LMS_FINALIZATION_FAILED.evidence, {
    operation: 'finalize',
    reason: 'lms_operation_failed',
    result: 'false',
    sessionTime: false,
    persistence: true,
    resultBoolean: false
  });
  assert.equal(issues.LMS_TERMINATION_FAILED.active, true);
  assert.equal(snapshot.state.lastCommitResult, false);
  assert.equal(snapshot.state.finishResult, false);
  assert.equal(snapshot.session.lifecycle, 'active');
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
  const failureEvent = snapshot.diagnosticTail.find(
    (event) =>
      event.source === 'timegate' &&
      event.data.eventType === 'lms_operation_failed' &&
      event.data.operation === 'finalize'
  );
  assert.equal(failureEvent.severity, 'error');
  assert.equal(failureEvent.data.sessionTime, false);
  assert.equal(failureEvent.data.persistence, true);
  assert.equal(failureEvent.data.resultBoolean, false);
});

test('Timegate-deferred termination stays pending instead of ending the LMS session', async () => {
  const host = createHost({
    onFinish({ document }) {
      document.dispatchEvent({
        type: 'sis:timegate',
        detail: {
          version: 1,
          type: 'termination_deferred',
          reason: 'completion_pending',
          success: true,
          activeSeconds: 12,
          idleSeconds: 3
        }
      });
    }
  });
  await settle();
  host.bodies.length = 0;

  assert.equal(host.window.SCORM_CallLMSFinish(''), 'true');
  host.window.__SIS_OBSERVABILITY__.flush();
  await settle();

  const snapshot = latestSnapshot(host);
  assert.equal(snapshot.session.lifecycle, 'active');
  assert.equal(snapshot.session.endedAt, undefined);
  assert.equal(snapshot.state.finishResult, undefined);
  assert.equal(snapshot.state.activeSeconds, 12);
  assert.equal(snapshot.state.idleSeconds, 3);
  assert.equal(
    snapshot.issues.some((issue) => issue.code === 'LMS_TERMINATION_FAILED'),
    false
  );
  const finishEvent = snapshot.diagnosticTail.find(
    (event) => event.type === 'scorm_call' && event.data.method === 'Finish'
  );
  assert.equal(finishEvent.data.result, 'queued');
  assert.equal(finishEvent.data.status, 'pending');
  const deferredEvent = snapshot.diagnosticTail.find(
    (event) =>
      event.source === 'timegate' &&
      event.data.eventType === 'termination_deferred'
  );
  assert.equal(deferredEvent.data.operation, 'termination_deferred');
  assert.equal(deferredEvent.data.reason, 'completion_pending');
  assert.equal(deferredEvent.data.status, 'pending');
  assert.equal(deferredEvent.data.success, true);
});

test('rejected Timegate gating and deferral preserve failed helper calls', async () => {
  const host = createHost({
    onSetValue({ document, element, value }) {
      if (element !== 'cmi.core.lesson_status' || value !== 'completed') return;
      document.dispatchEvent({
        type: 'sis:timegate',
        detail: {
          version: 1,
          type: 'completion_gated',
          reason: 'configuration_error',
          completionStatus: value,
          success: false
        }
      });
    },
    onFinish({ document }) {
      document.dispatchEvent({
        type: 'sis:timegate',
        detail: {
          version: 1,
          type: 'termination_deferred',
          reason: 'completion_pending',
          success: false
        }
      });
    }
  });
  await settle();
  host.bodies.length = 0;
  host.flags.setValue = false;
  host.flags.finish = false;

  assert.equal(
    host.window.SCORM_CallLMSSetValue(
      'cmi.core.lesson_status',
      'completed'
    ),
    'false'
  );
  assert.equal(host.window.SCORM_CallLMSFinish(''), 'false');
  host.window.__SIS_OBSERVABILITY__.flush();
  await settle();

  const snapshot = latestSnapshot(host);
  assert.equal(snapshot.session.lifecycle, 'active');
  assert.equal(snapshot.state.finishResult, false);
  assert.ok(
    snapshot.issues.some(
      (issue) => issue.code === 'COMPLETION_WRITE_FAILED' && issue.active
    )
  );
  assert.ok(
    snapshot.issues.some(
      (issue) => issue.code === 'LMS_TERMINATION_FAILED' && issue.active
    )
  );
  const finishCall = snapshot.diagnosticTail.find(
    (event) => event.type === 'scorm_call' && event.data.method === 'Finish'
  );
  assert.equal(finishCall.data.result, 'false');
  assert.notEqual(finishCall.data.status, 'pending');
  const rejectedDeferral = snapshot.diagnosticTail.find(
    (event) =>
      event.source === 'timegate' &&
      event.data.eventType === 'termination_deferred'
  );
  assert.equal(rejectedDeferral.data.success, false);
  assert.equal(rejectedDeferral.data.status, 'failed');
});

test('Timegate termination completion resolves deferred lifecycle failures', async () => {
  const host = createHost();
  await settle();
  host.bodies.length = 0;

  host.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'termination_deferred',
      reason: 'completion_pending'
    }
  });
  host.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'lms_operation_failed',
      operation: 'Terminate',
      reason: 'course'
    }
  });
  host.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'termination_completed',
      reason: 'completion_replayed',
      success: true
    }
  });
  await settle();

  const snapshot = latestSnapshot(host);
  assert.equal(snapshot.session.lifecycle, 'terminated');
  assert.equal(snapshot.state.finishResult, true);
  assert.equal(
    snapshot.issues.some(
      (issue) =>
        (issue.code === 'LMS_TERMINATION_FAILED' ||
          issue.code === 'LMS_OPERATION_FAILED') &&
        issue.active
    ),
    false
  );
  assert.ok(
    snapshot.diagnosticTail.some(
      (event) =>
        event.source === 'timegate' &&
        event.data.eventType === 'termination_completed'
    )
  );
});

test('pagehide beacon includes the preceding Timegate finalization failure', async () => {
  const host = createHost();
  await settle();
  host.beacons.length = 0;

  host.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'lms_operation_failed',
      operation: 'finalize',
      reason: 'course',
      resultBoolean: false
    }
  });
  host.window.dispatchEvent({ type: 'pagehide' });
  await settle();

  assert.ok(host.beacons.length);
  const beacon = host.beacons
    .map((body) => JSON.parse(body))
    .reduce((latest, item) =>
      item.session.revision > latest.session.revision ? item : latest
    );
  assert.equal(beacon.session.lifecycle, 'page_hidden');
  assert.ok(
    beacon.issues.some(
      (issue) => issue.code === 'LMS_FINALIZATION_FAILED' && issue.active
    )
  );
});

test('SCORM 2004 success status is not treated as course completion', async () => {
  const course2004 = descriptor();
  course2004.scormVersion = '2004';
  const successOnly = createHost({
    course: course2004,
    onSetValue({ document, element, value }) {
      if (element !== 'cmi.success_status') return;
      document.dispatchEvent({
        type: 'sis:timegate',
        detail: {
          version: 1,
          type: 'completion_replayed',
          reason: 'scorm',
          replayMode: 'direct',
          canonicalCompletion: false,
          completionStatus: value,
          success: true,
          resultBoolean: false
        }
      });
    }
  });
  await settle();
  successOnly.bodies.length = 0;
  successOnly.window.SCORM_CallLMSSetValue('cmi.success_status', 'passed');
  successOnly.window.SCORM_CallLMSFinish('');
  successOnly.window.__SIS_OBSERVABILITY__.flush();
  await settle();
  const successSnapshot = latestSnapshot(successOnly);
  assert.equal(successSnapshot.course.scormVersion, '2004');
  assert.equal(successSnapshot.instrumentation.scormVersion, '2004');
  assert.equal(
    successSnapshot.issues.some(
      (issue) => issue.code === 'COMPLETION_NOT_COMMITTED' && issue.active
    ),
    false
  );
  assert.ok(
    successSnapshot.issues.some(
      (issue) => issue.code === 'COMMIT_FAILED' && issue.active
    )
  );
  const outcomeReplay = successSnapshot.diagnosticTail.find(
    (event) =>
      event.source === 'timegate' &&
      event.data.eventType === 'completion_replayed'
  );
  assert.equal(outcomeReplay.data.canonicalCompletion, false);

  const completed = createHost();
  await settle();
  completed.bodies.length = 0;
  completed.window.SCORM_CallLMSSetValue(
    'cmi.completion_status',
    'completed'
  );
  completed.window.SCORM_CallLMSFinish('');
  completed.window.__SIS_OBSERVABILITY__.flush();
  await settle();
  assert.ok(
    latestSnapshot(completed).issues.some(
      (issue) => issue.code === 'COMPLETION_NOT_COMMITTED' && issue.active
    )
  );
});

test('maximum-time exits are distinct from forced idle exits', async () => {
  const host = createHost();
  await settle();
  host.document.dispatchEvent({
    type: 'sis:timegate',
    detail: {
      version: 1,
      type: 'maximum_time_reached',
      reason: 'timer',
      activeSeconds: 2700,
      idleSeconds: 120,
      limitSeconds: 2700
    }
  });
  await settle();
  const snapshot = latestSnapshot(host);
  assert.equal(snapshot.session.lifecycle, 'forced_exit');
  assert.ok(
    snapshot.issues.some(
      (issue) => issue.code === 'MAXIMUM_TIME_REACHED' && issue.active
    )
  );
  assert.equal(
    snapshot.issues.some((issue) => issue.code === 'FORCED_IDLE_EXIT'),
    false
  );
  const maximumEvent = snapshot.diagnosticTail.find(
    (event) =>
      event.source === 'timegate' &&
      event.data.operation === 'maximum_time_reached'
  );
  assert.equal(maximumEvent.data.limitSeconds, 2700);
});

test('missing SCORM API still produces a fail-open unmatched launch snapshot', async () => {
  const host = createHost({ missingScorm: true });
  await settle();
  const snapshot = latestSnapshot(host);
  assert.equal(snapshot.learner.lmsLearnerId, '');
  assert.ok(snapshot.issues.some((issue) => issue.code === 'MISSING_SCORM_API'));
  assert.match(snapshot.session.id, /^[0-9a-f-]{36}$/);
});

test('three internal probe failures disable telemetry without changing LMS calls', async () => {
  const host = createHost();
  await settle();
  for (let attempt = 0; attempt < 3; attempt++) {
    const hostileEvent = {
      type: 'message',
      source: host.contentWindow,
      origin: 'https://training.example'
    };
    Object.defineProperty(hostileEvent, 'data', {
      get() { throw new Error('hostile message getter'); }
    });
    host.window.dispatchEvent(hostileEvent);
  }
  assert.equal(host.window.__SIS_OBSERVABILITY__.status().enabled, false);
  assert.equal(
    host.window.SCORM_CallLMSGetValue('cmi.core.lesson_status'),
    'incomplete'
  );
  assert.equal(host.calls.at(-1).thisValue, host.window);
});

test('content probe uses only a validated MessageChannel and redacts URL/message secrets', () => {
  const outgoing = [];
  const parentMessages = [];
  const parent = {
    postMessage(message, targetOrigin) {
      parentMessages.push({ message, targetOrigin });
    }
  };
  const window = eventTarget({});
  const document = eventTarget({});
  Object.assign(window, {
    window,
    self: window,
    globalThis: window,
    parent,
    document,
    location: {
      origin: 'https://training.example',
      href: 'https://training.example/scormcontent/index.html#/preview',
      pathname: '/scormcontent/index.html',
      hash: '#/preview'
    },
    history: {
      pushState() {},
      replaceState() {}
    },
    crypto: crypto.webcrypto,
    URL,
    Uint8Array,
    setTimeout() { return 1; },
    clearTimeout() {}
  });
  Object.defineProperty(window, 'fetch', {
    get() { throw new Error('probe must not access fetch'); }
  });
  Object.defineProperty(window, 'sessionStorage', {
    get() { throw new Error('probe must not access storage'); }
  });

  vm.runInNewContext(PROBE_SOURCE, window, { filename: 'content-probe.js' });
  assert.equal(parentMessages.length, 1);
  const connect = parentMessages[0].message;
  const fakePort = {
    start() {},
    postMessage(message) { outgoing.push(message); }
  };
  window.dispatchEvent({
    type: 'message',
    source: parent,
    origin: 'https://training.example',
    data: {
      type: 'sis-observability-connected',
      protocolVersion: 1,
      nonce: connect.nonce
    },
    ports: [fakePort]
  });
  window.dispatchEvent({
    type: 'error',
    target: null,
    error: new Error('Failed https://cdn.example/a.js?token=PROBE_URL_SECRET_SENTINEL'),
    filename: 'https://cdn.example/a.js?token=PROBE_FILE_SECRET_SENTINEL'
  });
  window.dispatchEvent({
    type: 'unhandledrejection',
    reason: new Error(
      'Synthetic Learner selected sprinkler ANSWER_VALUE_SECRET_SENTINEL'
    )
  });
  window.dispatchEvent({
    type: 'error',
    target: {
      tagName: 'SCRIPT',
      src: 'https://cdn.example/chunk.js?token=RESOURCE_SECRET_SENTINEL'
    }
  });
  document.dispatchEvent({
    type: 'stalled',
    target: {
      tagName: 'VIDEO',
      currentTime: 12.25,
      parentNode: null,
      getAttribute() { return null; }
    }
  });
  const opaquePath = 'AbCdEf1234567890';
  window.location.hash =
    `#/launch/${opaquePath}?token=ROUTE_SECRET_SENTINEL`;
  window.history.pushState({}, '', window.location.hash);

  const raw = JSON.stringify(outgoing);
  for (const sentinel of [
    'PROBE_URL_SECRET_SENTINEL',
    'PROBE_FILE_SECRET_SENTINEL',
    'ANSWER_VALUE_SECRET_SENTINEL',
    'Synthetic Learner selected sprinkler',
    'RESOURCE_SECRET_SENTINEL',
    'ROUTE_SECRET_SENTINEL',
    opaquePath
  ]) {
    assert.equal(raw.includes(sentinel), false);
  }
  const types = outgoing.map((message) => message.event.type);
  assert.ok(types.includes('javascript_error'));
  assert.ok(types.includes('unhandled_rejection'));
  assert.ok(types.includes('resource_error'));
  assert.ok(types.includes('media_event'));
  assert.ok(types.includes('route_change'));
});

test('Rise bookmarks keep bare IDs but redact URL parameters', async () => {
  const host = createHost();
  await settle();
  host.bodies.length = 0;
  host.window.RiseLMSInterface.setBookmark('lesson-123');
  host.window.RiseLMSInterface.setBookmark(
    'https://training.example/lesson-456?token=BOOKMARK_TOKEN_SENTINEL'
  );
  host.window.__SIS_OBSERVABILITY__.flush();
  await settle();
  const raw = host.bodies.join('\n');
  assert.ok(raw.includes('"bookmark":"lesson-123"'));
  assert.equal(raw.includes('BOOKMARK_TOKEN_SENTINEL'), false);
});

test('Timegate exposes every guarded observability transition without a telemetry dependency', () => {
  for (const type of [
    'tracking_started',
    'idle_entered',
    'idle_exited',
    'completion_gated',
    'completion_reset',
    'minimum_time_met',
    'completion_replayed',
    'persistence_failed',
    'persistence_recovered',
    'configuration_failed',
    'lms_operation_failed',
    'termination_deferred',
    'termination_completed',
    'forced_exit',
    'maximum_time_reached'
  ]) {
    assert.match(TIMEGATE_SOURCE, new RegExp(`emitTimegateEvent\\('${type}'`));
  }
  assert.equal(TIMEGATE_SOURCE.includes('__SIS_OBSERVABILITY_CONFIG__'), false);
});
