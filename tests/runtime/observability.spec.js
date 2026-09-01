const { test, expect } = require('@playwright/test');

const harnessPath = '/tests/runtime/harness/index.html';
const launcherPath = '/tests/runtime/harness/launcher.html';
const pendingKey = '__sis_observability_pending_v1';
const privacySentinel = 'Synthetic Learner selected sprinkler';

async function openHarness(page, query = '') {
  await page.goto(`${harnessPath}${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.localLmsHarness));
}

async function flush(page) {
  await page.evaluate(() => {
    if (window.__SIS_OBSERVABILITY__) {
      window.__SIS_OBSERVABILITY__.flush();
    }
  });
  await page.waitForTimeout(150);
}

async function latestSnapshot(page) {
  return page.evaluate(() => window.localLmsHarness.latestSnapshot());
}

async function waitForIssue(page, code) {
  await page.waitForFunction((expectedCode) => {
    const snapshot = window.localLmsHarness.latestSnapshot();
    return Boolean(
      snapshot &&
      snapshot.issues.some((issue) => issue.code === expectedCode),
    );
  }, code);
}

async function clickLifecycle(page) {
  await page.locator('#initialize').click();
  await page.locator('#read-learner').click();
  await page.locator('#progress-50').click();
  await page.locator('#complete').click();
  await page.locator('#commit').click();
  await page.locator('#finish').click();
}

test('normal SCORM lifecycle preserves raw calls and captures learner correlation', async ({ page }) => {
  await openHarness(page);
  await page.evaluate(() => window.localLmsHarness.reset());
  await clickLifecycle(page);
  await flush(page);

  const result = await page.evaluate(() => ({
    calls: window.localLmsHarness.calls,
    snapshot: window.localLmsHarness.latestSnapshot(),
  }));

  expect(result.calls).toEqual([
    ['LMSInitialize'],
    ['LMSGetValue', 'cmi.core.student_id'],
    ['LMSSetValue', 'cmi.core.lesson_status', 'completed'],
    ['LMSCommit'],
    ['LMSFinish'],
  ]);
  expect(
    result.calls.filter(
      (call) =>
        call[0] === 'LMSGetValue' &&
        call[1] === 'cmi.core.student_id',
    ),
  ).toHaveLength(1);
  expect(result.snapshot.learner.lmsLearnerId).toBe('POC-LEARNER-001');
  expect(result.snapshot.state).toMatchObject({
    initialized: true,
    lessonStatus: 'completed',
    progressPercent: 50,
    lastCommitResult: true,
    finishResult: true,
  });
  expect(result.snapshot.session.lifecycle).toBe('terminated');
});

test('quiz failure and retry remain assessment milestones, not course completion', async ({ page }) => {
  await openHarness(page);
  await page.evaluate(() => window.localLmsHarness.reset());
  await page.locator('#quiz-failure').click();
  await page.locator('#quiz-retry').click();
  await flush(page);

  const result = await page.evaluate(() => ({
    calls: window.localLmsHarness.calls,
    riseCalls: window.localLmsHarness.riseCalls,
    snapshots: window.localLmsHarness.snapshots,
    snapshot: window.localLmsHarness.latestSnapshot(),
  }));

  expect(
    result.calls.some(
      (call) =>
        call[0] === 'LMSSetValue' &&
        call[1] === 'cmi.core.lesson_status',
    ),
  ).toBe(false);
  expect(result.riseCalls).toEqual([
    ['reportAnswer'],
    ['finishQuiz'],
    ['reportAnswer'],
    ['finishQuiz'],
  ]);
  expect(result.snapshot.state.lessonStatus).toBeUndefined();
  expect(JSON.stringify(result.snapshots)).not.toContain(privacySentinel);
});

test('completion write and commit failures become issues without changing return values', async ({ page }) => {
  await openHarness(page);
  await page.evaluate(() => {
    window.localLmsHarness.reset();
    window.localLmsHarness.failure.setValue = true;
    window.localLmsHarness.failure.commit = true;
  });

  expect(await page.locator('#complete').evaluate((button) => button.click())).toBeUndefined();
  await page.locator('#commit').click();
  await flush(page);
  await waitForIssue(page, 'COMPLETION_WRITE_FAILED');
  await waitForIssue(page, 'COMMIT_FAILED');

  const result = await page.evaluate(() => ({
    completeResult: window.localLmsHarness.complete(),
    commitResult: window.localLmsHarness.commit(),
    snapshot: window.localLmsHarness.latestSnapshot(),
  }));
  expect(result.completeResult).toBe('false');
  expect(result.commitResult).toBe('false');
  expect(result.snapshot.state.lastCommitResult).toBe(false);
});

test('missing SCORM API and missing Rise interface stay fail-open with explicit degraded issues', async ({ browser }) => {
  const missingApiContext = await browser.newContext();
  const missingApiPage = await missingApiContext.newPage();
  await openHarness(missingApiPage, '?api=missing');
  await missingApiPage.locator('#progress-50').click();
  await flush(missingApiPage);
  await waitForIssue(missingApiPage, 'MISSING_SCORM_API');
  const semanticSnapshot = await latestSnapshot(missingApiPage);
  expect(semanticSnapshot.state.progressPercent).toBe(50);
  expect(await missingApiPage.evaluate(() => window.localLmsHarness.calls)).toEqual([]);
  await missingApiContext.close();

  const missingRiseContext = await browser.newContext();
  const missingRisePage = await missingRiseContext.newPage();
  await openHarness(missingRisePage, '?rise=missing');
  await missingRisePage.locator('#initialize').click();
  await flush(missingRisePage);
  await waitForIssue(missingRisePage, 'DEGRADED_SHIM');
  expect(await missingRisePage.evaluate(() => window.localLmsHarness.calls)).toEqual([
    ['LMSInitialize'],
  ]);
  await missingRiseContext.close();
});

test('Timegate delays completion replay and emits a forced idle exit', async ({ browser }) => {
  const delayContext = await browser.newContext();
  const delayPage = await delayContext.newPage();
  await openHarness(delayPage, '?timegate=delay');
  await delayPage.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await delayPage.evaluate(() => window.localLmsHarness.reset());
  await delayPage.locator('#initialize').click();
  await delayPage.locator('#complete').click();

  expect(
    await delayPage.evaluate(() =>
      window.localLmsHarness.calls.some(
        (call) =>
          call[0] === 'LMSSetValue' &&
          call[1] === 'cmi.core.lesson_status' &&
          call[2] === 'completed',
      ),
    ),
  ).toBe(false);

  await delayPage.waitForFunction(() =>
    window.localLmsHarness.calls.some(
      (call) =>
        call[0] === 'LMSSetValue' &&
        call[1] === 'cmi.core.lesson_status' &&
        call[2] === 'completed',
    ),
  );
  await delayPage.waitForFunction(() => {
    const snapshot = window.localLmsHarness.latestSnapshot();
    return Boolean(
      snapshot &&
      snapshot.diagnosticTail.some(
        (event) =>
          event.source === 'timegate' &&
          event.data.operation === 'completion_replayed',
      ),
    );
  });
  expect(
    (await latestSnapshot(delayPage)).learner.lmsLearnerId,
  ).toBe('POC-LEARNER-001');
  await delayContext.close();

  const idleContext = await browser.newContext();
  const idlePage = await idleContext.newPage();
  await openHarness(idlePage, '?timegate=idle');
  await idlePage.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await idlePage.locator('#initialize').click();
  await expect(idlePage.locator('#timegate-walkback')).toBeVisible({
    timeout: 6_000,
  });
  await idlePage.waitForFunction(() => {
    const snapshot = window.localLmsHarness.latestSnapshot();
    return snapshot && snapshot.session.lifecycle === 'forced_exit';
  });
  const idleResult = await idlePage.evaluate(() => ({
    calls: window.localLmsHarness.calls,
    snapshot: window.localLmsHarness.latestSnapshot(),
  }));
  expect(idleResult.calls.some((call) => call[0] === 'LMSCommit')).toBe(true);
  expect(idleResult.calls.some((call) => call[0] === 'LMSFinish')).toBe(true);
  expect(idleResult.snapshot.session.lifecycle).toBe('forced_exit');
  await idleContext.close();
});

test('hidden tabs pause inactivity force-exit until warnings are visible', async ({ page }) => {
  await openHarness(page, '?timegate=idle');
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.locator('#initialize').click();

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(2_500);

  await expect(page.locator('#timegate-walkback')).toBeHidden();
  expect(
    await page.evaluate(() =>
      window.localLmsHarness.calls.some((call) => call[0] === 'LMSFinish'),
    ),
  ).toBe(false);

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await expect(page.locator('#timegate-walkback')).toBeVisible({
    timeout: 6_000,
  });
  await page.waitForFunction(() =>
    window.localLmsHarness.calls.some((call) => call[0] === 'LMSFinish'),
  );
});

test('Timegate persists and enforces an optional cumulative maximum', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openHarness(page, '?timegate=max');
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await expect(page.locator('#timegate-root .timegate-ring-label')).toHaveText(
    'Min met',
  );
  await expect(page.locator('#timegate-root .timegate-ring-value')).toHaveText(
    '0:00',
  );
  await expect(page.locator('#timegate-root .timegate-ring-svg')).toHaveAttribute(
    'role',
    'progressbar',
  );
  await expect(page.locator('#timegate-root .timegate-ring-dot')).toHaveCount(3);
  await page.locator('#initialize').click();

  await expect(page.locator('#timegate-walkback')).toBeVisible({ timeout: 6_000 });
  await expect(page.locator('#timegate-walkback')).toContainText(
    'Maximum course time reached',
  );
  await page.waitForFunction(() => {
    const snapshot = window.localLmsHarness.latestSnapshot();
    return Boolean(
      snapshot &&
      snapshot.issues.some(
        (issue) => issue.code === 'MAXIMUM_TIME_REACHED' && issue.active,
      ),
    );
  });
  await page.locator('#complete').click();

  const result = await page.evaluate(() => ({
    calls: window.localLmsHarness.calls,
    snapshot: window.localLmsHarness.latestSnapshot(),
  }));
  expect(result.calls.some((call) => call[0] === 'LMSCommit')).toBe(true);
  expect(result.calls.some((call) => call[0] === 'LMSFinish')).toBe(true);
  expect(
    result.calls.some(
      (call) =>
        call[0] === 'LMSSetValue' &&
        call[1] === 'cmi.core.lesson_status' &&
        call[2] === 'completed',
    ),
  ).toBe(false);
  expect(
    result.snapshot.issues.some((issue) => issue.code === 'FORCED_IDLE_EXIT'),
  ).toBe(false);

  await page.reload();
  await page.waitForFunction(() => window.localLmsHarness.timegateReady);
  await page.locator('#initialize').click();
  await expect(page.locator('#timegate-walkback')).toBeVisible({ timeout: 3_000 });
  await context.close();

  const invalidContext = await browser.newContext();
  const invalidPage = await invalidContext.newPage();
  await openHarness(invalidPage, '?timegate=max-invalid');
  await invalidPage.waitForFunction(() => window.localLmsHarness.timegateReady);
  await expect(invalidPage.locator('#timegate-root .timegate-ring-label')).toHaveText(
    'Settings',
    { timeout: 6_000 },
  );
  await expect(invalidPage.locator('#timegate-walkback')).toContainText(
    'Course reporting unavailable',
  );
  await invalidContext.close();
});

test('Timegate ring places Min on the Max scale and cycles compact details', async ({ page }) => {
  await openHarness(page, '?timegate=ring');
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );

  const root = page.locator('#timegate-root');
  await expect(root.locator('.timegate-ring-marker')).toHaveAttribute(
    'transform',
    'rotate(96.00 50 50)',
  );
  await expect(root.locator('.timegate-ring-svg')).toHaveAttribute(
    'aria-valuetext',
    /Min required 20:00\. Max allowed 1:15:00/,
  );
  await expect(root.locator('.timegate-ring-dot')).toHaveCount(3);
  await expect(root.locator('.timegate-ring-label')).toHaveText('Min left');

  const center = root.locator('.timegate-ring-center');
  await center.click();
  await expect(center).toHaveClass(/timegate-ring-changing/);
  await expect(root.locator('.timegate-ring-label')).toHaveText('Min required');
  await expect(root.locator('.timegate-ring-value')).toHaveText('20:00');

  await center.click();
  await expect(root.locator('.timegate-ring-label')).toHaveText('Max allowed');
  await expect(root.locator('.timegate-ring-value')).toHaveText('1:15:00');
});

test('Timegate cancels queued completion when the course resets to incomplete', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openHarness(page, '?timegate=delay&strictScorm=1');
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.reset());
  await page.locator('#initialize').click();

  const immediateResults = await page.evaluate(() => ({
    completed: window.SCORM_CallLMSSetValue(
      'cmi.core.lesson_status',
      'completed',
    ),
    reset: window.SCORM_CallLMSSetValue(
      'cmi.core.lesson_status',
      'incomplete',
    ),
  }));
  expect(immediateResults).toEqual({ completed: 'true', reset: 'true' });

  await page.waitForTimeout(3_500);
  const result = await page.evaluate(() => ({
    calls: window.localLmsHarness.calls.slice(),
    status: window.localLmsHarness.values['cmi.core.lesson_status'],
  }));
  const replayedCompletion = result.calls.filter(
    (call) =>
      call[0] === 'LMSSetValue' &&
      call[1] === 'cmi.core.lesson_status' &&
      call[2] === 'completed',
  );

  expect(result.status).toBe('incomplete');
  expect(replayedCompletion).toHaveLength(0);
  await context.close();
});

test('Timegate retains failed completion and retries after a clean relaunch', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openHarness(page, '?timegate=delay&strictScorm=1');
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.reset());
  await page.locator('#initialize').click();
  await page.locator('#complete').click();
  await page.evaluate(() => {
    window.localLmsHarness.failure.setValue = true;
    window.localLmsHarness.failure.commit = true;
  });
  await page.waitForFunction(() =>
    window.localLmsHarness.calls.some(
      (call) =>
        call[0] === 'LMSSetValue' &&
        call[1] === 'cmi.core.lesson_status' &&
        call[2] === 'completed',
    ),
  );

  const persistedAfterFailure = await page.evaluate(() => {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && key.includes('observability-browser-delay')) {
        return JSON.parse(window.localStorage.getItem(key));
      }
    }
    return null;
  });
  expect.soft(persistedAfterFailure).not.toBeNull();
  expect.soft(persistedAfterFailure && persistedAfterFailure.pendingScorm).toEqual({
    'cmi.core.lesson_status': 'completed',
  });
  expect.soft(
    persistedAfterFailure && persistedAfterFailure.courseCompletePending,
  ).toBe(true);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.localLmsHarness.timegateReady);
  await page.evaluate(() => window.localLmsHarness.reset());
  await page.locator('#initialize').click();
  await page.waitForTimeout(2_000);

  const relaunched = await page.evaluate(() => ({
    calls: window.localLmsHarness.calls.slice(),
    status: window.localLmsHarness.values['cmi.core.lesson_status'],
  }));
  expect(relaunched.status).toBe('completed');
  expect(
    relaunched.calls.some(
      (call) =>
        call[0] === 'LMSSetValue' &&
        call[1] === 'cmi.core.lesson_status' &&
        call[2] === 'completed',
    ),
  ).toBe(true);
  expect(relaunched.calls.some((call) => call[0] === 'LMSCommit')).toBe(true);
  await context.close();
});

test('production boot cannot report completion while Timegate config is delayed', async ({ page }) => {
  await page.goto('/tests/runtime/harness/timegate-production-order.html', {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.productionOrderHarness.booted);
  const atCourseBoot = await page.evaluate(() => ({
    calls: window.productionOrderHarness.calls.slice(),
    status:
      window.productionOrderHarness.values['cmi.core.lesson_status'],
  }));
  await page.waitForSelector('#timegate-root', { state: 'attached' });
  const afterTimegate = await page.evaluate(() => ({
    calls: window.productionOrderHarness.calls.slice(),
    status:
      window.productionOrderHarness.values['cmi.core.lesson_status'],
  }));

  expect(
    atCourseBoot.calls.some(
      (call) =>
        call[0] === 'LMSSetValue' &&
        call[1] === 'cmi.core.lesson_status' &&
        call[2] === 'completed',
    ),
  ).toBe(false);
  expect(atCourseBoot.status).toBe('incomplete');
  expect(afterTimegate.status).toBe('incomplete');
});

test('production bootstrap terminates once on pagehide before config resolves', async ({ page }) => {
  await page.goto('/tests/runtime/harness/timegate-production-order.html', {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => window.productionOrderHarness.booted);

  const result = await page.evaluate(() => {
    const timegateReady = Boolean(document.getElementById('timegate-root'));
    const finishResult = window.API.LMSFinish('');
    const finishesBeforePagehide = window.productionOrderHarness.calls.filter(
      (call) => call[0] === 'LMSFinish',
    ).length;
    window.dispatchEvent(new PageTransitionEvent('pagehide', {
      persisted: false,
    }));
    window.dispatchEvent(new PageTransitionEvent('pagehide', {
      persisted: false,
    }));
    return {
      calls: window.productionOrderHarness.calls.slice(),
      finishesBeforePagehide,
      finishResult,
      status: window.productionOrderHarness.values['cmi.core.lesson_status'],
      timegateReady,
    };
  });

  expect(result.timegateReady).toBe(false);
  expect(result.finishResult).toBe('true');
  expect(result.finishesBeforePagehide).toBe(0);
  expect(result.status).toBe('incomplete');
  expect(
    result.calls.filter((call) => call[0] === 'LMSFinish'),
  ).toHaveLength(1);
  expect(
    result.calls.some(
      (call) =>
        call[0] === 'LMSSetValue' &&
        call[1] === 'cmi.core.lesson_status' &&
        call[2] === 'completed',
    ),
  ).toBe(false);
});

test('maximum lock preserves SetValue results and terminates only once', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openHarness(page, '?timegate=max&strictScorm=1');
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.reset());
  await page.locator('#initialize').click();
  await expect(page.locator('#timegate-walkback')).toBeVisible({ timeout: 6_000 });
  await page.waitForFunction(() =>
    window.localLmsHarness.calls.some((call) => call[0] === 'LMSFinish'),
  );

  const result = await page.evaluate(() => {
    const finishesBefore = window.localLmsHarness.calls.filter(
      (call) => call[0] === 'LMSFinish',
    ).length;
    const writes = [
      ['cmi.core.session_time', '00:00:03'],
      ['cmi.core.lesson_location', 'lesson-after-limit'],
      ['cmi.suspend_data', '{"bookmark":"after-limit"}'],
    ];
    const results = writes.map(([element, value]) =>
      window.SCORM_CallLMSSetValue(element, value),
    );
    return {
      calls: window.localLmsHarness.calls.slice(),
      finishesBefore,
      results,
      writes,
    };
  });

  expect(result.results).toEqual(['false', 'false', 'false']);
  for (const [element, value] of result.writes) {
    expect(
      result.calls.some(
        (call) =>
          call[0] === 'LMSSetValue' &&
          call[1] === element &&
          call[2] === value,
      ),
    ).toBe(true);
  }
  expect(
    result.calls.filter((call) => call[0] === 'LMSFinish'),
  ).toHaveLength(result.finishesBefore);
  await context.close();
});

test('default dual storage does not import anonymous state for another learner', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openHarness(page);
  await page.evaluate(() => {
    const priorLearnerState = {
      version: 1,
      courseKey: 'observability-browser-dual-shared',
      learnerKey: 'anonymous',
      elapsedSeconds: 600,
      minRequiredSeconds: 600,
      maxAllowedSeconds: null,
      minMetAt: '2026-01-01T00:00:00.000Z',
      maxReachedAt: null,
      lastTickTs: Date.now(),
      courseCompleteSent: false,
      courseCompletePending: false,
      pendingScorm: null,
      pendingDriverCalls: null,
    };
    window.localStorage.setItem(
      'timegate-v2.v1.observability-browser-dual-shared.anonymous',
      JSON.stringify(priorLearnerState),
    );
  });

  await openHarness(
    page,
    '?timegate=dual-shared&learner=LEARNER-B&strictScorm=1',
  );
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.reset());
  await page.locator('#initialize').click();

  await expect(page.locator('#timegate-root .timegate-ring-label')).toHaveText(
    'Min left',
  );
  await expect(page.locator('#timegate-root .timegate-ring-value')).not.toHaveText(
    '0:00',
  );
  await context.close();
});

test('Timegate visually hands off the modal timer and explains the live indicator', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openHarness(page, '?timegate=modal');
  await page.waitForFunction(() => window.localLmsHarness.timegateReady);

  await expect(page.locator('#timegate-launch-modal')).toBeVisible();
  await expect(page.locator('.timegate-launch-guide-title')).toHaveText(
    'Track active time at a glance',
  );
  await expect(
    page.locator('#timegate-launch-modal .timegate-demo-card'),
  ).toBeVisible();
  await expect(page.locator('#timegate-modal-preview')).toBeVisible({
    timeout: 3_000,
  });

  await page.getByRole('button', { name: 'I understand' }).click();
  await expect(page.locator('#timegate-root')).toBeVisible();
  await expect(page.locator('#timegate-root .timegate-ring-label')).toHaveText(
    'Min left',
  );
  await expect(page.locator('#timegate-root .timegate-ring-value')).toContainText(
    ':',
  );
  await expect(page.locator('#timegate-root .timegate-ring-svg')).toHaveAttribute(
    'role',
    'progressbar',
  );
  await expect(page.locator('#timegate-root .timegate-ring')).toHaveClass(
    /timegate-ring-attention/,
  );
  await expect(page.locator('#timegate-root .timegate-ring-label')).toHaveText(
    'Min required',
    { timeout: 4_000 },
  );
  await context.close();

  const reducedContext = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 390, height: 844 },
  });
  const reducedPage = await reducedContext.newPage();
  await openHarness(reducedPage, '?timegate=modal');
  await reducedPage.waitForFunction(() => window.localLmsHarness.timegateReady);
  await expect(reducedPage.locator('#timegate-modal-preview')).toBeVisible();
  await expect(reducedPage.locator('#timegate-handoff-clone')).toHaveCount(0);
  expect(
    await reducedPage.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await reducedContext.close();
});

test('content probe captures browser and media failures without leaking authored text', async ({ page }) => {
  await openHarness(page);
  const content = page.frameLocator('#content-frame');
  await content.locator('#change-route').click();
  await content.locator('#throw-error').click();
  await content.locator('#reject-promise').click();
  await content.locator('#fail-resource').click();
  await content.locator('#media-events').click();

  await waitForIssue(page, 'JAVASCRIPT_ERROR');
  await waitForIssue(page, 'MEDIA_ERROR');
  await flush(page);

  const result = await page.evaluate(() => ({
    serialized: JSON.stringify(window.localLmsHarness.snapshots),
    eventTypes: window.localLmsHarness.latestSnapshot().diagnosticTail.map(
      (event) => event.type,
    ),
  }));
  expect(result.serialized).not.toContain(privacySentinel);
  expect(result.eventTypes).toEqual(
    expect.arrayContaining([
      'route_change',
      'javascript_error',
      'unhandled_rejection',
      'resource_error',
      'media_event',
    ]),
  );
});

test('real CORS failure retries the same revision once as no-cors', async ({ page, request }) => {
  await request.delete('/__telemetry');
  await openHarness(page, '?telemetry=cors-fallback');
  await page.waitForFunction(
    () => window.localLmsHarness.transportAttempts.length >= 2,
  );

  const attempts = await page.evaluate(
    () => window.localLmsHarness.transportAttempts.slice(0, 2),
  );
  expect(attempts.map((attempt) => attempt.mode)).toEqual(['cors', 'no-cors']);
  expect(attempts[0].revision).toBe(attempts[1].revision);

  await expect.poll(async () => {
    const response = await request.get('/__telemetry');
    return (await response.json()).length;
  }).toBeGreaterThanOrEqual(2);
  const deliveries = await (await request.get('/__telemetry')).json();
  const first = JSON.parse(deliveries[0].body);
  const second = JSON.parse(deliveries[1].body);
  expect(first.session.revision).toBe(second.session.revision);
  expect(deliveries.slice(0, 2).map((delivery) => delivery.mode)).toEqual([
    'cors',
    'no-cors',
  ]);
});

test('offline delivery retains the cumulative snapshot and pagehide beacon remains pending', async ({ browser }) => {
  const offlineContext = await browser.newContext();
  const offlinePage = await offlineContext.newPage();
  await openHarness(offlinePage, '?telemetry=offline');
  await offlinePage.waitForFunction(
    () => window.localLmsHarness.transportAttempts.length >= 2,
  );
  const offlinePending = await offlinePage.evaluate(
    (key) => JSON.parse(sessionStorage.getItem(key)),
    pendingKey,
  );
  expect(offlinePending.session.revision).toBeGreaterThan(0);
  await offlineContext.close();

  const beaconContext = await browser.newContext();
  const beaconPage = await beaconContext.newPage();
  await openHarness(beaconPage);
  await expect.poll(() =>
    beaconPage.evaluate((key) => sessionStorage.getItem(key), pendingKey),
  ).toBeNull();
  await beaconPage.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', {
      persisted: false,
    }));
  });
  await beaconPage.waitForFunction(
    () =>
      window.localLmsHarness.beaconAttempts.length > 0 &&
      window.localLmsHarness.beaconAttempts[0].revision !== null,
  );
  const beaconResult = await beaconPage.evaluate((key) => ({
    attempt: window.localLmsHarness.beaconAttempts[0],
    pending: JSON.parse(sessionStorage.getItem(key)),
  }), pendingKey);
  expect(beaconResult.pending.session.lifecycle).toBe('page_hidden');
  expect(beaconResult.pending.session.revision).toBe(
    beaconResult.attempt.revision,
  );
  await beaconContext.close();
});

test('browser reload resumes only the same learner while fresh navigation starts a new session', async ({ page }) => {
  await openHarness(page, '?telemetry=offline');
  await page.locator('#read-learner').click();
  await flush(page);
  const initial = await latestSnapshot(page);
  expect(initial.learner.lmsLearnerId).toBe('POC-LEARNER-001');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.localLmsHarness));
  expect(
    await page.evaluate(() => window.localLmsHarness.snapshots.length),
  ).toBe(0);
  await page.locator('#read-learner').click();
  await page.evaluate(() =>
    window.SCORM_CallLMSGetValue('cmi.core.lesson_status'),
  );
  await page.waitForFunction(() =>
    Boolean(window.localLmsHarness.latestSnapshot()),
  );
  const resumed = await latestSnapshot(page);
  expect(resumed.session.id).toBe(initial.session.id);
  expect(
    await page.evaluate(() => window.__SIS_OBSERVABILITY__.sessionId),
  ).toBe(initial.session.id);

  await openHarness(page, '?telemetry=offline');
  await page.locator('#read-learner').click();
  await flush(page);
  const fresh = await latestSnapshot(page);
  expect(fresh.learner.lmsLearnerId).toBe('POC-LEARNER-001');
  expect(fresh.session.id).not.toBe(initial.session.id);
});

test('sessionStorage write failure is observable but does not affect LMS calls', async ({ page }) => {
  await page.addInitScript((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      }
      return original.call(this, name, value);
    };
  }, pendingKey);
  await openHarness(page);
  await page.evaluate(() => window.localLmsHarness.reset());
  await clickLifecycle(page);
  await flush(page);
  await waitForIssue(page, 'TELEMETRY_STORAGE_FAILED');

  expect(await page.evaluate(() => window.localLmsHarness.calls)).toEqual([
    ['LMSInitialize'],
    ['LMSGetValue', 'cmi.core.student_id'],
    ['LMSSetValue', 'cmi.core.lesson_status', 'completed'],
    ['LMSCommit'],
    ['LMSFinish'],
  ]);
});

test('enabled, disabled, and unreachable telemetry produce identical LMS behavior', async ({ browser }) => {
  async function runScenario(query) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await openHarness(page, query);
    await page.evaluate(() => window.localLmsHarness.reset());
    await clickLifecycle(page);
    const calls = await page.evaluate(() => window.localLmsHarness.calls);
    await context.close();
    return calls;
  }

  const enabled = await runScenario('');
  const disabled = await runScenario('?telemetry=disabled');
  const offline = await runScenario('?telemetry=offline');
  expect(disabled).toEqual(enabled);
  expect(offline).toEqual(enabled);
});

test('launcher supports iframe and popup modes without horizontal clipping', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(`${launcherPath}?mode=iframe`, {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('#launch').click();
  await expect(page.locator('#target iframe')).toBeVisible();
  await expect(
    page.frameLocator('#target iframe').getByRole('heading', {
      name: 'SCORM Observability Local LMS Harness',
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await testInfo.attach('iframe-launcher', {
    body: await page.screenshot({ type: 'png' }),
    contentType: 'image/png',
  });

  await page.selectOption('#mode', 'popup');
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#launch').click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  await expect(
    popup.getByRole('heading', {
      name: 'SCORM Observability Local LMS Harness',
    }),
  ).toBeVisible();
  await popup.close();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
});
