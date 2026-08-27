const { test, expect } = require('@playwright/test');

const harnessPath = '/tests/runtime/harness/index.html';
const scorm2004HarnessPath = '/tests/runtime/harness/scorm2004.html';

async function openTimegateHarness(page) {
  await page.goto(`${harnessPath}?timegate=delay`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () =>
      window.localLmsHarness &&
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
}

async function openScorm2004Harness(page, floor = 'delay') {
  await page.goto(
    `${scorm2004HarnessPath}?api=missing&strictScorm=1&floor=${floor}`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.localLmsHarness &&
      window.localLmsHarness.timegateReady &&
      window.localLmsHarness.apiVersion === '2004' &&
      Boolean(document.getElementById('timegate-root')),
  );
}

async function openDualStorageHarness(page) {
  await page.goto(
    `${harnessPath}?timegate=dual-shared&strictScorm=1`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.localLmsHarness &&
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
}

async function openRiseDriverHarness(page) {
  await page.goto(
    `${harnessPath}?timegate=delay&strictScorm=1&driver=rise`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.localLmsHarness &&
      window.localLmsHarness.timegateReady &&
      typeof window.localLmsHarness.driverComplete === 'function' &&
      Boolean(document.getElementById('timegate-root')),
  );
}

async function readScorm2004TimegateState(page) {
  return page.evaluate(() => {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (
        key &&
        key.startsWith('timegate-v2.v1.') &&
        key.includes('observability-browser-scorm2004-') &&
        key.endsWith('.SCORM-2004-LEARNER')
      ) {
        return JSON.parse(window.localStorage.getItem(key));
      }
    }
    return null;
  });
}

async function flush(page) {
  await page.evaluate(() => window.__SIS_OBSERVABILITY__.flush());
  await page.waitForTimeout(150);
}

test('a Timegate-queued completion is not attested as written or committed', async ({ page }) => {
  await openTimegateHarness(page);
  await page.evaluate(() => {
    window.localLmsHarness.reset();
    window.localLmsHarness.initialize();
    window.localLmsHarness.complete();
    window.localLmsHarness.commit();
    window.__SIS_OBSERVABILITY__.flush();
  });
  await page.waitForTimeout(150);

  let result = await page.evaluate(() => ({
    lmsStatus: window.localLmsHarness.values['cmi.core.lesson_status'],
    snapshot: window.localLmsHarness.latestSnapshot(),
  }));

  expect(result.lmsStatus).toBe('incomplete');
  expect(result.snapshot.state.lessonStatus).not.toBe('completed');
  expect(result.snapshot.state.lastCommitResult).toBe(true);
  expect(
    result.snapshot.diagnosticTail.some(
      (event) =>
        event.type === 'scorm_call' &&
        event.data.element === 'cmi.core.lesson_status' &&
        event.data.result === 'queued' &&
        event.data.status === 'timegate_gated',
    ),
  ).toBe(true);

  await page.evaluate(() => window.localLmsHarness.finish());
  await flush(page);
  result = await page.evaluate(() => ({
    calls: window.localLmsHarness.calls.slice(),
    lmsStatus: window.localLmsHarness.values['cmi.core.lesson_status'],
    snapshot: window.localLmsHarness.latestSnapshot(),
  }));

  expect(result.lmsStatus).toBe('incomplete');
  expect(result.snapshot.state.lessonStatus).not.toBe('completed');
  expect(result.snapshot.session.lifecycle).toBe('active');
  expect(result.calls.some((call) => call[0] === 'LMSFinish')).toBe(false);
  expect(
    result.snapshot.issues.some(
      (issue) => issue.code === 'COMPLETION_NOT_COMMITTED' && issue.active,
    ),
  ).toBe(false);
});

test('a failed Timegate replay remains an explicit completion failure', async ({ page }) => {
  await openTimegateHarness(page);
  await page.evaluate(() => {
    window.localLmsHarness.reset();
    window.localLmsHarness.initialize();
    window.localLmsHarness.failure.setValue = true;
    window.localLmsHarness.complete();
  });

  await page.waitForFunction(() => {
    const snapshot = window.localLmsHarness.latestSnapshot();
    return Boolean(
      snapshot &&
      snapshot.issues.some(
        (issue) => issue.code === 'COMPLETION_WRITE_FAILED' && issue.active,
      ),
    );
  });
  await flush(page);

  const result = await page.evaluate(() => ({
    lmsStatus: window.localLmsHarness.values['cmi.core.lesson_status'],
    snapshot: window.localLmsHarness.latestSnapshot(),
  }));

  expect(result.lmsStatus).toBe('incomplete');
  expect(result.snapshot.state.lessonStatus).not.toBe('completed');
  expect(
    result.snapshot.issues.some(
      (issue) => issue.code === 'COMPLETION_WRITE_FAILED' && issue.active,
    ),
  ).toBe(true);
});

test('SCORM 2004 gates and replays completion before one lifecycle-aware termination', async ({
  page,
}) => {
  await openScorm2004Harness(page);
  const immediate = await page.evaluate(() => {
    window.localLmsHarness.reset();
    return {
      initialize: window.localLmsHarness.initialize(),
      completion: window.localLmsHarness.complete(),
      terminate: window.localLmsHarness.rawApi.Terminate(''),
      calls: window.localLmsHarness.calls.slice(),
    };
  });

  expect(immediate.initialize).toBe('true');
  expect(immediate.completion).toBe('true');
  expect(immediate.terminate).toBe('true');
  expect(
    immediate.calls.some(
      (call) =>
        call[0] === 'SetValue' &&
        call[1] === 'cmi.completion_status' &&
        call[2] === 'completed',
    ),
  ).toBe(false);
  expect(immediate.calls.some((call) => call[0] === 'Terminate')).toBe(false);

  await page.waitForFunction(() =>
    window.localLmsHarness.calls.some((call) => call[0] === 'Terminate'),
  );
  await flush(page);

  const result = await page.evaluate(() => {
    const secondTerminate = window.localLmsHarness.rawApi.Terminate('');
    return {
      calls: window.localLmsHarness.calls.slice(),
      completionStatus:
        window.localLmsHarness.values['cmi.completion_status'],
      lifecycle: { ...window.localLmsHarness.lifecycle },
      secondTerminate,
      snapshot: window.localLmsHarness.latestSnapshot(),
    };
  });
  const sessionTimeWrites = result.calls.filter(
    (call) => call[0] === 'SetValue' && call[1] === 'cmi.session_time',
  );

  expect(result.completionStatus).toBe('completed');
  expect(
    result.calls.some(
      (call) =>
        call[0] === 'SetValue' &&
        call[1] === 'cmi.completion_status' &&
        call[2] === 'completed',
    ),
  ).toBe(true);
  expect(sessionTimeWrites).toHaveLength(1);
  expect(sessionTimeWrites[0][2]).toMatch(
    /^PT\d+H\d+M\d+(?:\.\d+)?S$/,
  );
  expect(
    result.calls.filter((call) => call[0] === 'Commit').length,
  ).toBeGreaterThanOrEqual(2);
  expect(
    result.calls.filter((call) => call[0] === 'Terminate'),
  ).toHaveLength(1);
  expect(result.secondTerminate).toBe('true');
  expect(result.lifecycle).toEqual({ initialized: false, terminated: true });
  expect(
    result.snapshot.diagnosticTail.some(
      (event) =>
        event.type === 'scorm_call' &&
        event.data.element === 'cmi.completion_status' &&
        event.data.result === 'queued' &&
        event.data.status === 'timegate_gated',
    ),
  ).toBe(true);
});

test('SCORM 2004 success alone is not reported as course completion', async ({
  page,
}) => {
  await openScorm2004Harness(page, 'immediate');
  const successResult = await page.evaluate(() => {
    window.localLmsHarness.reset();
    window.localLmsHarness.initialize();
    window.localLmsHarness.failure.commit = true;
    return window.localLmsHarness.setSuccess('passed');
  });
  await flush(page);

  const persisted = await readScorm2004TimegateState(page);
  const result = await page.evaluate(() => ({
    completionStatus:
      window.localLmsHarness.values['cmi.completion_status'],
    successStatus: window.localLmsHarness.values['cmi.success_status'],
    snapshot: window.localLmsHarness.latestSnapshot(),
  }));

  expect(successResult).toBe('true');
  expect(result.successStatus).toBe('passed');
  expect(result.completionStatus).toBe('incomplete');
  expect(persisted).not.toBeNull();
  expect(persisted.courseCompleteSent).toBe(false);
  expect(result.snapshot.state.lessonStatus).toBe('incomplete');
  expect(
    result.snapshot.issues.some(
      (issue) => issue.code === 'COMMIT_FAILED' && issue.active,
    ),
  ).toBe(true);
  expect(
    result.snapshot.issues.some(
      (issue) => issue.code === 'COMPLETION_NOT_COMMITTED' && issue.active,
    ),
  ).toBe(false);
});

test('SCORM 2004 keeps failed completion writes pending for retry', async ({
  page,
}) => {
  await openScorm2004Harness(page);
  await page.evaluate(() => {
    window.localLmsHarness.reset();
    window.localLmsHarness.initialize();
    window.localLmsHarness.failure.setValue = true;
    window.localLmsHarness.failure.commit = true;
    window.localLmsHarness.complete();
  });
  await page.waitForFunction(() =>
    window.localLmsHarness.calls.some(
      (call) =>
        call[0] === 'SetValue' &&
        call[1] === 'cmi.completion_status' &&
        call[2] === 'completed',
    ),
  );
  await flush(page);

  const persisted = await readScorm2004TimegateState(page);
  const result = await page.evaluate(() => ({
    calls: window.localLmsHarness.calls.slice(),
    completionStatus:
      window.localLmsHarness.values['cmi.completion_status'],
    snapshot: window.localLmsHarness.latestSnapshot(),
  }));

  expect(result.completionStatus).toBe('incomplete');
  expect(
    result.calls.some((call) => call[0] === 'Commit'),
  ).toBe(true);
  expect(persisted).not.toBeNull();
  expect(persisted.pendingScorm).toEqual({
    'cmi.completion_status': 'completed',
  });
  expect(persisted.courseCompletePending).toBe(true);
  expect(persisted.courseCompleteSent).toBe(false);
  expect(
    result.snapshot.issues.some(
      (issue) => issue.code === 'COMPLETION_WRITE_FAILED' && issue.active,
    ),
  ).toBe(true);
  expect(
    result.snapshot.issues.some(
      (issue) => issue.code === 'COMMIT_FAILED' && issue.active,
    ),
  ).toBe(true);
});

test('default dual storage reports failed LMS durability and retries promptly', async ({
  page,
}) => {
  await openDualStorageHarness(page);
  const failedAttempt = await page.evaluate(() => {
    window.localLmsHarness.reset();
    window.localLmsHarness.failure.setValue = true;
    const initializeResult = window.localLmsHarness.initialize();
    const completionResult = window.localLmsHarness.complete();
    const suspendWriteCount = window.localLmsHarness.calls.filter(
      (call) =>
        call[0] === 'LMSSetValue' && call[1] === 'cmi.suspend_data',
    ).length;
    const localBackup = Object.keys(window.localStorage)
      .filter((key) => key.includes('observability-browser-dual-shared'))
      .map((key) => window.localStorage.getItem(key))
      .find(Boolean) || null;
    const lmsSuspendData =
      window.localLmsHarness.values['cmi.suspend_data'];
    window.localLmsHarness.failure.setValue = false;
    return {
      completionResult,
      initializeResult,
      lmsSuspendData,
      localBackup,
      suspendWriteCount,
    };
  });

  expect(failedAttempt.initializeResult).toBe('true');
  expect(failedAttempt.completionResult).toBe('false');
  expect(failedAttempt.suspendWriteCount).toBeGreaterThan(0);
  expect(failedAttempt.localBackup).not.toBeNull();
  expect(failedAttempt.lmsSuspendData).toBe('');

  await page.waitForFunction(
    (previousCount) =>
      window.localLmsHarness.calls.filter(
        (call) =>
          call[0] === 'LMSSetValue' && call[1] === 'cmi.suspend_data',
      ).length > previousCount,
    failedAttempt.suspendWriteCount,
    { timeout: 2_500 },
  );
  await flush(page);

  const recovered = await page.evaluate(() => ({
    calls: window.localLmsHarness.calls.slice(),
    lmsSuspendData: window.localLmsHarness.values['cmi.suspend_data'],
    snapshot: window.localLmsHarness.latestSnapshot(),
  }));

  expect(recovered.lmsSuspendData).not.toBe('');
  expect(
    recovered.calls.filter(
      (call) =>
        call[0] === 'LMSSetValue' && call[1] === 'cmi.suspend_data',
    ).length,
  ).toBeGreaterThan(failedAttempt.suspendWriteCount);
  expect(
    recovered.calls.some((call) => call[0] === 'LMSCommit'),
  ).toBe(true);
  expect(
    recovered.snapshot.diagnosticTail.some(
      (event) =>
        event.type === 'timegate_event' &&
        event.data.operation === 'persistence_failed',
    ),
  ).toBe(true);
  expect(
    recovered.snapshot.issues.some(
      (issue) =>
        issue.code === 'TIMEGATE_PERSISTENCE_FAILED' && issue.active,
    ),
  ).toBe(false);
});

test('Rise driver completion remains pending and replays after relaunch recovery', async ({
  page,
}) => {
  await openRiseDriverHarness(page);
  const queued = await page.evaluate(() => {
    window.localLmsHarness.reset();
    window.localLmsHarness.initialize();
    const result = window.localLmsHarness.driverComplete();
    window.localLmsHarness.failure.driver = true;
    return {
      result,
      riseCalls: window.localLmsHarness.riseCalls.slice(),
    };
  });

  expect(queued.result).toBe(true);
  expect(queued.riseCalls).toHaveLength(0);
  await page.waitForFunction(() =>
    window.localLmsHarness.riseCalls.some(
      (call) => call[0] === 'SetReachedEnd',
    ),
  );
  await flush(page);

  const failedReplay = await page.evaluate(() => {
    let persisted = null;
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (
        key &&
        key.startsWith('timegate-v2.v1.') &&
        key.includes('observability-browser-delay') &&
        key.endsWith('.POC-LEARNER-001')
      ) {
        persisted = JSON.parse(window.localStorage.getItem(key));
        break;
      }
    }
    return {
      lmsStatus: window.localLmsHarness.values['cmi.core.lesson_status'],
      persisted,
      snapshot: window.localLmsHarness.latestSnapshot(),
    };
  });

  expect(failedReplay.lmsStatus).toBe('incomplete');
  expect(failedReplay.persisted).not.toBeNull();
  expect(failedReplay.persisted.pendingDriverCalls).toEqual([
    { name: 'SetReachedEnd', args: [] },
  ]);
  expect(failedReplay.persisted.courseCompletePending).toBe(true);
  expect(failedReplay.persisted.courseCompleteSent).toBe(false);
  expect(
    failedReplay.snapshot.issues.some(
      (issue) => issue.code === 'COMPLETION_WRITE_FAILED' && issue.active,
    ),
  ).toBe(true);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness &&
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => {
    window.localLmsHarness.reset();
    window.localLmsHarness.initialize();
  });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.values['cmi.core.lesson_status'] === 'completed' &&
      window.localLmsHarness.riseCalls.some(
        (call) => call[0] === 'SetReachedEnd',
      ),
  );

  const recovered = await page.evaluate(() => {
    let persisted = null;
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (
        key &&
        key.startsWith('timegate-v2.v1.') &&
        key.includes('observability-browser-delay') &&
        key.endsWith('.POC-LEARNER-001')
      ) {
        persisted = JSON.parse(window.localStorage.getItem(key));
        break;
      }
    }
    return {
      calls: window.localLmsHarness.calls.slice(),
      lmsStatus: window.localLmsHarness.values['cmi.core.lesson_status'],
      persisted,
      riseCalls: window.localLmsHarness.riseCalls.slice(),
    };
  });

  expect(recovered.lmsStatus).toBe('completed');
  expect(recovered.riseCalls).toContainEqual(['SetReachedEnd']);
  expect(
    recovered.calls.some(
      (call) =>
        call[0] === 'LMSSetValue' &&
        call[1] === 'cmi.core.lesson_status' &&
        call[2] === 'completed',
    ),
  ).toBe(true);
  expect(
    recovered.calls.some((call) => call[0] === 'LMSCommit'),
  ).toBe(true);
  expect(recovered.persisted).not.toBeNull();
  expect(recovered.persisted.pendingDriverCalls).toBeNull();
  expect(recovered.persisted.courseCompletePending).toBe(false);
  expect(recovered.persisted.courseCompleteSent).toBe(true);
});

test('SCORM 2004 outcome reset preserves queued canonical completion', async ({
  page,
}) => {
  await openScorm2004Harness(page);
  const immediate = await page.evaluate(() => {
    window.localLmsHarness.reset();
    window.localLmsHarness.initialize();
    return {
      completion: window.localLmsHarness.complete(),
      outcomeReset: window.localLmsHarness.setSuccess('unknown'),
    };
  });

  expect(immediate).toEqual({ completion: 'true', outcomeReset: 'true' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.values['cmi.completion_status'] === 'completed',
    null,
    { timeout: 6_000 },
  );

  const result = await page.evaluate(() => ({
    calls: window.localLmsHarness.calls.slice(),
    completion: window.localLmsHarness.values['cmi.completion_status'],
    success: window.localLmsHarness.values['cmi.success_status'],
  }));
  expect(result.completion).toBe('completed');
  expect(result.success).toBe('unknown');
  expect(
    result.calls.some(
      (call) =>
        call[0] === 'SetValue' &&
        call[1] === 'cmi.completion_status' &&
        call[2] === 'completed',
    ),
  ).toBe(true);
});

test('SCORM 2004 completion reset preserves queued outcome only', async ({
  page,
}) => {
  await openScorm2004Harness(page);
  const immediate = await page.evaluate(() => {
    window.localLmsHarness.reset();
    window.localLmsHarness.initialize();
    return {
      outcome: window.localLmsHarness.setSuccess('passed'),
      completionReset: window.SCORM_CallLMSSetValue(
        'cmi.completion_status',
        'incomplete',
      ),
    };
  });

  expect(immediate).toEqual({ outcome: 'true', completionReset: 'true' });
  await page.waitForFunction(
    () => window.localLmsHarness.values['cmi.success_status'] === 'passed',
    null,
    { timeout: 6_000 },
  );
  const result = await page.evaluate(() => ({
    completion: window.localLmsHarness.values['cmi.completion_status'],
    persisted: (() => {
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (
          key &&
          key.startsWith('timegate-v2.v1.') &&
          key.includes('observability-browser-scorm2004-delay')
        ) {
          return JSON.parse(window.localStorage.getItem(key));
        }
      }
      return null;
    })(),
    success: window.localLmsHarness.values['cmi.success_status'],
  }));
  expect(result.completion).toBe('incomplete');
  expect(result.success).toBe('passed');
  expect(result.persisted.courseCompletePending).toBe(false);
  expect(result.persisted.courseCompleteSent).toBe(false);
});

test('failed duplicate Initialize does not strand an active LMS session', async ({
  page,
}) => {
  await page.goto(`${harnessPath}?timegate=delay&strictScorm=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  const results = await page.evaluate(() => {
    window.localLmsHarness.reset();
    return {
      firstInitialize: window.localLmsHarness.initialize(),
      duplicateInitialize: window.localLmsHarness.initialize(),
      completion: window.localLmsHarness.complete(),
    };
  });
  expect(results).toEqual({
    firstInitialize: 'true',
    duplicateInitialize: 'false',
    completion: 'true',
  });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.values['cmi.core.lesson_status'] === 'completed',
    null,
    { timeout: 6_000 },
  );
  expect(
    await page.evaluate(() => window.localLmsHarness.lifecycle.initialized),
  ).toBe(true);
});

test('deferred Finish survives relaunch and clears only after termination', async ({
  page,
}) => {
  await page.goto(`${harnessPath}?timegate=delay&strictScorm=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  const deferred = await page.evaluate(() => {
    window.localLmsHarness.reset();
    window.localLmsHarness.initialize();
    window.localLmsHarness.complete();
    const finish = window.localLmsHarness.finish();
    const finishCalls = window.localLmsHarness.calls.filter(
      (call) => call[0] === 'LMSFinish',
    ).length;
    const persisted = Object.keys(window.localStorage)
      .filter(
        (key) =>
          key.startsWith('timegate-v2.v1.') &&
          key.includes('observability-browser-delay'),
      )
      .map((key) => JSON.parse(window.localStorage.getItem(key)))
      .find((value) => value && value.pendingTerminate);
    return { finish, finishCalls, persisted };
  });
  expect(deferred.finish).toBe('true');
  expect(deferred.finishCalls).toBe(0);
  expect(deferred.persisted.pendingTerminate).not.toBeNull();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => {
    window.localLmsHarness.reset();
    window.localLmsHarness.initialize();
  });
  await page.waitForFunction(
    () => window.localLmsHarness.calls.some((call) => call[0] === 'LMSFinish'),
    null,
    { timeout: 6_000 },
  );

  const recovered = await page.evaluate(() => {
    const persisted = Object.keys(window.localStorage)
      .filter(
        (key) =>
          key.startsWith('timegate-v2.v1.') &&
          key.includes('observability-browser-delay'),
      )
      .map((key) => JSON.parse(window.localStorage.getItem(key)))
      .find(Boolean);
    return {
      calls: window.localLmsHarness.calls.slice(),
      persisted,
      status: window.localLmsHarness.values['cmi.core.lesson_status'],
    };
  });
  const completionIndex = recovered.calls.findIndex(
    (call) =>
      call[0] === 'LMSSetValue' &&
      call[1] === 'cmi.core.lesson_status' &&
      call[2] === 'completed',
  );
  const finishIndex = recovered.calls.findIndex(
    (call) => call[0] === 'LMSFinish',
  );
  expect(recovered.status).toBe('completed');
  expect(completionIndex).toBeGreaterThanOrEqual(0);
  expect(finishIndex).toBeGreaterThan(completionIndex);
  expect(recovered.persisted.pendingTerminate).toBeNull();
});

test('array suspend_data is rejected instead of falsely reporting durability', async ({
  page,
}) => {
  await openDualStorageHarness(page);
  await page.evaluate(() => {
    window.localLmsHarness.reset();
    window.localLmsHarness.values['cmi.suspend_data'] = '[]';
    window.localLmsHarness.initialize();
  });
  await page.waitForFunction(() => {
    const snapshot = window.localLmsHarness.latestSnapshot();
    return Boolean(
      snapshot &&
      snapshot.issues.some(
        (issue) =>
          issue.code === 'TIMEGATE_PERSISTENCE_FAILED' && issue.active,
      )
    );
  });
  const result = await page.evaluate(() => ({
    calls: window.localLmsHarness.calls.slice(),
    suspendData: window.localLmsHarness.values['cmi.suspend_data'],
  }));
  expect(result.suspendData).toBe('[]');
  expect(
    result.calls.some(
      (call) =>
        call[0] === 'LMSSetValue' && call[1] === 'cmi.suspend_data',
    ),
  ).toBe(false);
});

test('pagehide beacon includes Timegate finalization failure', async ({ page }) => {
  await openTimegateHarness(page);
  await page.evaluate(() => {
    window.localLmsHarness.reset();
    window.localLmsHarness.initialize();
    window.localLmsHarness.failure.commit = true;
    window.dispatchEvent(new Event('pagehide'));
  });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.beaconAttempts.length > 0 &&
      window.localLmsHarness.snapshots.some((snapshot) =>
        snapshot.issues.some(
          (issue) =>
            issue.code === 'LMS_FINALIZATION_FAILED' && issue.active,
        ),
      ),
  );
  const snapshot = await page.evaluate(() =>
    window.localLmsHarness.snapshots
      .filter((candidate) => candidate.session.lifecycle === 'page_hidden')
      .sort((left, right) => right.session.revision - left.session.revision)[0],
  );
  expect(
    snapshot.issues.some(
      (issue) =>
        issue.code === 'LMS_FINALIZATION_FAILED' && issue.active,
    ),
  ).toBe(true);
});

test('maximum exit waits for finalization recovery before one Terminate', async ({
  page,
}) => {
  await page.goto(`${harnessPath}?timegate=max&strictScorm=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => {
    window.localLmsHarness.reset();
    window.localLmsHarness.failure.commit = true;
    window.localLmsHarness.initialize();
  });
  await expect(page.locator('#timegate-walkback')).toBeVisible({
    timeout: 6_000,
  });
  await page.waitForFunction(() => {
    const snapshot = window.localLmsHarness.latestSnapshot();
    return Boolean(
      snapshot &&
      snapshot.issues.some(
        (issue) =>
          issue.code === 'LMS_FINALIZATION_FAILED' && issue.active,
      )
    );
  });
  expect(
    await page.evaluate(() =>
      window.localLmsHarness.calls.some((call) => call[0] === 'LMSFinish'),
    ),
  ).toBe(false);

  await page.evaluate(() => {
    window.localLmsHarness.failure.commit = false;
  });
  await page.waitForFunction(
    () => window.localLmsHarness.calls.some((call) => call[0] === 'LMSFinish'),
    null,
    { timeout: 8_000 },
  );
  const result = await page.evaluate(() => ({
    finishes: window.localLmsHarness.calls.filter(
      (call) => call[0] === 'LMSFinish',
    ).length,
    lifecycle: { ...window.localLmsHarness.lifecycle },
    snapshot: window.localLmsHarness.latestSnapshot(),
  }));
  expect(result.finishes).toBe(1);
  expect(result.lifecycle).toEqual({ initialized: false, terminated: true });
  expect(
    result.snapshot.issues.some(
      (issue) =>
        issue.code === 'LMS_FINALIZATION_FAILED' && issue.active,
    ),
  ).toBe(false);
});

test('secondary tab cannot overwrite the primary completion queue', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const primary = await context.newPage();
  const secondary = await context.newPage();
  await openDualStorageHarness(primary);
  await openDualStorageHarness(secondary);

  const primaryInitialize = await primary.evaluate(() => {
    window.localLmsHarness.reset();
    return window.localLmsHarness.initialize();
  });
  const secondaryInitialize = await secondary.evaluate(() => {
    window.localLmsHarness.reset();
    return window.localLmsHarness.initialize();
  });
  expect(primaryInitialize).toBe('true');
  expect(secondaryInitialize).toBe('true');

  const primaryCompletion = await primary.evaluate(() =>
    window.localLmsHarness.complete(),
  );
  const secondaryCompletion = await secondary.evaluate(() =>
    window.localLmsHarness.complete(),
  );
  expect(primaryCompletion).toBe('true');
  expect(secondaryCompletion).toBe('false');

  await primary.waitForTimeout(5_500);
  const persisted = await primary.evaluate(() => {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (
        key &&
        key.startsWith('timegate-v2.v1.') &&
        key.includes('observability-browser-dual-shared')
      ) {
        return JSON.parse(window.localStorage.getItem(key));
      }
    }
    return null;
  });
  expect(persisted).not.toBeNull();
  expect(persisted.pendingScorm).toEqual({
    'cmi.core.lesson_status': 'completed',
  });
  expect(persisted.courseCompletePending).toBe(true);
  await context.close();
});

test('missing required config fails closed instead of using a zero-minute floor', async ({
  page,
}) => {
  await page.goto(`${harnessPath}?timegate=missing-floor&strictScorm=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await expect(page.locator('#timegate-root .timegate-ring-label')).toHaveText(
    'Settings',
  );
  const result = await page.evaluate(() => {
    window.localLmsHarness.reset();
    window.localLmsHarness.initialize();
    return {
      completion: window.localLmsHarness.complete(),
      status: window.localLmsHarness.values['cmi.core.lesson_status'],
    };
  });
  expect(result.completion).toBe('false');
  expect(result.status).toBe('incomplete');
});
