const { test, expect } = require('@playwright/test');

const harnessPath = '/tests/runtime/harness/index.html';
const scorm2004HarnessPath = '/tests/runtime/harness/scorm2004.html';

async function installAudioContextRecorder(page, mode = 'ok') {
  await page.addInitScript(({ recorderMode }) => {
    const recorder = {
      closes: 0,
      contexts: 0,
      events: [],
      oscillatorStarts: [],
      pendingResumes: [],
      resumes: 0,
    };
    window.__timegateAudioRecorder = recorder;
    document.addEventListener('sis:timegate', (event) => {
      const detail = event && event.detail;
      if (detail && detail.type) recorder.events.push({ ...detail });
    });

    function audioParam(initialValue = 0) {
      return {
        value: initialValue,
        setValueAtTime(value) {
          this.value = value;
        },
        exponentialRampToValueAtTime(value) {
          this.value = value;
        },
      };
    }

    class TimegateAudioContextMock {
      constructor() {
        recorder.contexts += 1;
        if (recorderMode === 'constructor-fail') {
          throw new Error('synthetic AudioContext constructor failure');
        }
        this.currentTime = 10;
        this.destination = {};
        this.state = recorderMode === 'resume-fail' ? 'suspended' : 'running';
        recorder.latestContext = this;
      }

      createGain() {
        return {
          connect() {},
          disconnect() {},
          gain: audioParam(1),
        };
      }

      createOscillator() {
        if (recorderMode === 'schedule-fail') {
          throw new Error('synthetic oscillator failure');
        }
        const frequency = audioParam(440);
        return {
          connect() {},
          disconnect() {},
          frequency,
          onended: null,
          start(at) {
            recorder.oscillatorStarts.push({ at, frequency: frequency.value });
          },
          stop() {},
          type: 'sine',
        };
      }

      resume() {
        recorder.resumes += 1;
        if (recorderMode === 'resume-fail') {
          return Promise.reject(new Error('synthetic AudioContext resume failure'));
        }
        if (recorderMode === 'resume-deferred') {
          return new Promise((resolve) => {
            recorder.pendingResumes.push({ context: this, resolve });
          });
        }
        this.state = 'running';
        return Promise.resolve();
      }

      close() {
        recorder.closes += 1;
        this.state = 'closed';
        return Promise.resolve();
      }
    }

    recorder.suspendLatestContext = () => {
      if (!recorder.latestContext) return false;
      recorder.latestContext.state = 'suspended';
      return true;
    };
    recorder.resolveNextResume = () => {
      const pending = recorder.pendingResumes.shift();
      if (!pending) return false;
      pending.context.state = 'running';
      pending.resolve();
      return true;
    };

    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: TimegateAudioContextMock,
    });
    Object.defineProperty(window, 'webkitAudioContext', {
      configurable: true,
      value: TimegateAudioContextMock,
    });
  }, { recorderMode: mode });
}

async function waitForAudioCue(page, reason) {
  await page.waitForFunction((expectedReason) =>
    window.__timegateAudioRecorder.events.some(
      (event) =>
        event.type === 'audio_cue_played' && event.reason === expectedReason,
    ), reason);
}

test('sound cues require learner opt-in and keep the preference local to the learner and course', async ({
  page,
}) => {
  await installAudioContextRecorder(page);
  const url = `${harnessPath}?timegate=modal&strictScorm=1&audio=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());

  const choice = page.getByRole('checkbox', {
    name: /Play helpful sound cues/,
  });
  await expect(choice).toBeVisible();
  await expect(choice).not.toBeChecked();
  expect(
    await page.evaluate(() => window.__timegateAudioRecorder.contexts),
  ).toBe(0);

  await choice.check();
  await waitForAudioCue(page, 'audio_enabled');
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem(
        'timegate-v2.audio-enabled.v1.' +
          '["observability-browser-modal","POC-LEARNER-001"]',
      ),
    ),
  ).toBe('1');
  expect(
    await page.evaluate(() =>
      JSON.stringify(window.localLmsHarness.values['cmi.suspend_data']),
    ),
  ).not.toContain('audio');

  await page.getByRole('button', { name: 'I understand' }).click();
  await expect(page.locator('.timegate-audio-toggle')).toHaveCount(0);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await expect(page.getByRole('checkbox', {
    name: /Play helpful sound cues/,
  })).toBeChecked();
  expect(
    await page.evaluate(() => window.__timegateAudioRecorder.events),
  ).toEqual([]);

  await page.getByRole('checkbox', {
    name: /Play helpful sound cues/,
  }).uncheck();
  await page.getByRole('button', { name: 'I understand' }).click();
  await expect(page.locator('.timegate-audio-toggle')).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.__timegateAudioRecorder.events.filter(
        (event) => event.type === 'audio_cue_played',
      ),
    ),
  ).toEqual([]);

  expect(
    await page.evaluate(() =>
      window.localStorage.getItem(
        'timegate-v2.audio-enabled.v1.' +
          '["observability-browser-modal","POC-LEARNER-001"]',
      ),
    ),
  ).toBe('0');
});

test('sound consent does not transfer between learners in the same course', async ({
  page,
}) => {
  await installAudioContextRecorder(page);
  async function openForLearner(courseKey, learner) {
    const query = new URLSearchParams({
      audio: '1',
      courseKey,
      launch: '1',
      learner,
      strictScorm: '1',
      timegate: 'modal',
    });
    await page.goto(`${harnessPath}?${query}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(
      () =>
        window.localLmsHarness.timegateReady &&
        Boolean(document.getElementById('timegate-root')),
    );
    expect(
      await page.evaluate(() => window.localLmsHarness.initialize()),
    ).toBe('true');
    return page.getByRole('checkbox', {
      name: /Play helpful sound cues/,
    });
  }

  const learnerAChoice = await openForLearner('course.a', 'b');
  await expect(learnerAChoice).not.toBeChecked();
  await learnerAChoice.check();
  await waitForAudioCue(page, 'audio_enabled');

  const learnerBChoice = await openForLearner('course', 'a.b');
  await expect(learnerBChoice).not.toBeChecked();

  const returningLearnerAChoice = await openForLearner('course.a', 'b');
  await expect(returningLearnerAChoice).toBeChecked();
});

test('standard launch modal inerts the course and traps focus between its controls', async ({
  page,
}) => {
  await installAudioContextRecorder(page);
  await page.setViewportSize({ width: 320, height: 667 });
  await page.goto(
    `${harnessPath}?timegate=modal&strictScorm=1&audio=1`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );

  const dialog = page.getByRole('dialog', { name: 'Before you begin' });
  const choice = page.getByRole('checkbox', {
    name: /Play helpful sound cues/,
  });
  const acknowledge = page.getByRole('button', { name: 'I understand' });
  const initialize = page.locator('#initialize');

  await expect(dialog).toBeVisible();
  await expect(page.locator('#timegate-modal-preview')).toBeHidden();
  expect(
    await page.evaluate(() =>
      document.querySelector('.timegate-launch-card').scrollTop,
    ),
  ).toBe(0);
  await expect(choice).toBeDisabled();
  await page.evaluate(() => {
    document.getElementById('timegate-audio-opt-in').click();
  });
  await expect(choice).not.toBeChecked();
  expect(
    await page.evaluate(() => ({
      audioContexts: window.__timegateAudioRecorder.contexts,
      preferenceKeys: Object.keys(window.localStorage).filter((key) =>
        key.startsWith('timegate-v2.audio-enabled.v1.'),
      ),
    })),
  ).toEqual({ audioContexts: 0, preferenceKeys: [] });
  await expect(initialize).toHaveAttribute('inert', '');
  await expect(initialize).toHaveAttribute('aria-hidden', 'true');
  expect(
    await page.evaluate(() => {
      const modal = document.getElementById('timegate-launch-modal');
      return Array.from(document.body.children)
        .filter(
          (node) =>
            node !== modal && node.id !== 'timegate-handoff-clone',
        )
        .filter(
          (node) =>
            !node.hasAttribute('inert') ||
            node.getAttribute('aria-hidden') !== 'true',
        )
        .map((node) => node.id || node.tagName);
    }),
  ).toEqual([]);
  expect(
    await page.evaluate(() => {
      const clone = document.getElementById('timegate-handoff-clone');
      return !clone || (
        clone.getAttribute('aria-hidden') === 'true' &&
        !clone.querySelector('button, input, select, textarea, [tabindex]')
      );
    }),
  ).toBe(true);

  expect(
    await page.evaluate(() => window.localLmsHarness.initialize()),
  ).toBe('true');
  await expect(choice).toBeEnabled();

  await expect(page.locator('#timegate-launch-title')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(choice).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(acknowledge).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(choice).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(acknowledge).toBeFocused();

  await acknowledge.click();
  await expect(dialog).toHaveCount(0);
  await expect(initialize).not.toHaveAttribute('inert', '');
  await expect(initialize).not.toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#timegate-root .timegate-ring-svg')).toBeFocused();
});

test('inactivity cues play once at each visible transition and never create course media', async ({
  page,
}) => {
  await installAudioContextRecorder(page);
  await page.goto(
    `${harnessPath}?timegate=idle&strictScorm=1&launch=1&audio=1` +
      '&gentle=1&idleExit=0.08&idleWarning=2&idleNudge=1',
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await page.getByRole('checkbox', {
    name: /Play helpful sound cues/,
  }).check();
  await waitForAudioCue(page, 'audio_enabled');
  await page.getByRole('button', { name: 'I understand' }).click();
  await page.evaluate(() => {
    window.__timegateAudioRecorder.events = [];
    window.__timegateAudioRecorder.oscillatorStarts = [];
  });

  await waitForAudioCue(page, 'inactivity_nudge');
  await waitForAudioCue(page, 'inactivity_warning');
  await expect(page.locator('#timegate-walkback')).toBeVisible({
    timeout: 8_000,
  });
  await waitForAudioCue(page, 'session_ended');

  const result = await page.evaluate(() => {
    const events = window.__timegateAudioRecorder.events;
    const count = (type, reason) => events.filter(
      (event) =>
        event.type === type && (!reason || event.reason === reason),
    ).length;
    return {
      audioElements: document.querySelectorAll('audio').length,
      cueCounts: {
        nudge: count('audio_cue_played', 'inactivity_nudge'),
        sessionEnded: count('audio_cue_played', 'session_ended'),
        warning: count('audio_cue_played', 'inactivity_warning'),
      },
      transitionCounts: {
        nudge: count('inactivity_nudge'),
        warning: count('inactivity_warning'),
      },
    };
  });
  expect(result).toEqual({
    audioElements: 0,
    cueCounts: { nudge: 1, sessionEnded: 1, warning: 1 },
    transitionCounts: { nudge: 1, warning: 1 },
  });
});

test('minimum-time sound is live-only and does not replay after hydration', async ({
  page,
}) => {
  await installAudioContextRecorder(page);
  const url = `${harnessPath}?timegate=delay&strictScorm=1&launch=1&audio=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await page.getByRole('checkbox', {
    name: /Play helpful sound cues/,
  }).check();
  await waitForAudioCue(page, 'audio_enabled');
  await page.getByRole('button', { name: 'I understand' }).click();
  await page.evaluate(() => { window.__timegateAudioRecorder.events = []; });

  await waitForAudioCue(page, 'minimum_time_met');
  expect(
    await page.evaluate(() =>
      window.__timegateAudioRecorder.events.filter(
        (event) =>
          event.type === 'audio_cue_played' &&
          event.reason === 'minimum_time_met',
      ).length,
    ),
  ).toBe(1);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await expect(page.getByRole('checkbox', {
    name: /Play helpful sound cues/,
  })).toBeChecked();
  await page.getByRole('button', { name: 'I understand' }).click();
  await page.waitForTimeout(1_500);
  expect(
    await page.evaluate(() =>
      window.__timegateAudioRecorder.events.some(
        (event) =>
          event.type === 'audio_cue_played' &&
          event.reason === 'minimum_time_met',
      ),
    ),
  ).toBe(false);
});

test('course status remains reachable when confirmed completion hides the timer', async ({
  page,
}) => {
  await installAudioContextRecorder(page);
  await page.goto(
    `${harnessPath}?timegate=delay&strictScorm=1&launch=1&audio=1` +
      '&hideComplete=1',
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await page.getByRole('checkbox', {
    name: /Play helpful sound cues/,
  }).check();
  await waitForAudioCue(page, 'audio_enabled');
  await page.getByRole('button', { name: 'I understand' }).click();

  await waitForAudioCue(page, 'minimum_time_met');
  await expect(page.locator('#timegate-root .timegate-ring')).toBeVisible();
  expect(
    await page.evaluate(() => window.localLmsHarness.complete()),
  ).toBe('true');
  await waitForAudioCue(page, 'completion_confirmed');
  await expect(page.locator('#timegate-root .timegate-ring')).toBeHidden();

  await expect(page.locator('.timegate-audio-toggle')).toHaveCount(0);
  const statusButton = page.locator('#timegate-support-button');
  await expect(statusButton).toBeVisible();
  await statusButton.click();
  await expect(page.locator('#timegate-support-dialog')).toBeVisible();
});

test('confirmed completion replaces a same-tick minimum cue', async ({ page }) => {
  await installAudioContextRecorder(page);
  await page.goto(
    `${harnessPath}?timegate=delay&strictScorm=1&launch=1&audio=1`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await page.getByRole('checkbox', {
    name: /Play helpful sound cues/,
  }).check();
  await waitForAudioCue(page, 'audio_enabled');
  await page.getByRole('button', { name: 'I understand' }).click();
  await page.evaluate(() => {
    window.__timegateAudioRecorder.events = [];
    window.localLmsHarness.complete();
  });

  await waitForAudioCue(page, 'completion_confirmed');
  const result = await page.evaluate(() => ({
    cueReasons: window.__timegateAudioRecorder.events
      .filter((event) => event.type === 'audio_cue_played')
      .map((event) => event.reason),
    minimumTransitionSeen: window.__timegateAudioRecorder.events.some(
      (event) => event.type === 'minimum_time_met' && event.reason === 'timer',
    ),
    status: window.localLmsHarness.values['cmi.core.lesson_status'],
  }));
  expect(result.status).toBe('completed');
  expect(result.minimumTransitionSeen).toBe(true);
  expect(result.cueReasons).toEqual(['completion_confirmed']);
});

test('audio failures and malformed optional settings never affect LMS completion', async ({
  browser,
  page,
}) => {
  for (const mode of ['constructor-fail', 'resume-fail', 'schedule-fail']) {
    const context = await browser.newContext();
    const failurePage = await context.newPage();
    const pageErrors = [];
    failurePage.on('pageerror', (error) => pageErrors.push(error.message));
    await installAudioContextRecorder(failurePage, mode);
    await failurePage.goto(
      `${harnessPath}?timegate=seat&strictScorm=1&launch=1&audio=1`,
      { waitUntil: 'domcontentloaded' },
    );
    await failurePage.waitForFunction(
      () =>
        window.localLmsHarness.timegateReady &&
        Boolean(document.getElementById('timegate-root')),
    );
    await failurePage.evaluate(() => window.localLmsHarness.initialize());
    await failurePage.getByRole('checkbox', {
      name: /Play helpful sound cues/,
    }).check();
    await failurePage.getByRole('button', { name: 'I understand' }).click();
    expect(
      await failurePage.evaluate(() => window.localLmsHarness.complete()),
    ).toBe('true');
    await failurePage.waitForTimeout(50);
    expect(
      await failurePage.evaluate(() => ({
        audioEvents: window.__timegateAudioRecorder.events.filter(
          (event) => event.type === 'audio_cue_played',
        ),
        status: window.localLmsHarness.values['cmi.core.lesson_status'],
      })),
    ).toEqual({ audioEvents: [], status: 'completed' });
    expect(pageErrors).toEqual([]);
    await context.close();
  }

  await page.goto(
    `${harnessPath}?timegate=modal&strictScorm=1&audio=invalid`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  expect(
    await page.evaluate(() => window.localLmsHarness.initialize()),
  ).toBe('true');
  await expect(page.getByRole('checkbox', {
    name: /Play helpful sound cues/,
  })).toHaveCount(0);
  await expect(page.locator('#timegate-walkback')).toHaveCount(0);
});

test('only the primary learner tab may play a live timing cue', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const primary = await context.newPage();
  const secondary = await context.newPage();
  await installAudioContextRecorder(primary);
  await installAudioContextRecorder(secondary);
  const url = `${harnessPath}?timegate=delay&strictScorm=1&launch=1&audio=1`;

  await primary.goto(url, { waitUntil: 'domcontentloaded' });
  await secondary.goto(url, { waitUntil: 'domcontentloaded' });
  await Promise.all([
    primary.waitForFunction(() =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
    ),
    secondary.waitForFunction(() =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
    ),
  ]);
  await primary.evaluate(() => window.localLmsHarness.initialize());
  await secondary.evaluate(() => window.localLmsHarness.initialize());

  await primary.bringToFront();
  await primary.getByRole('checkbox', {
    name: /Play helpful sound cues/,
  }).check();
  await waitForAudioCue(primary, 'audio_enabled');
  await expect(secondary.getByRole('checkbox', {
    name: /Play helpful sound cues/,
  })).toBeChecked();
  await primary.getByRole('button', { name: 'I understand' }).click();
  await secondary.getByRole('button', { name: 'I understand' }).click();
  await primary.evaluate(() => { window.__timegateAudioRecorder.events = []; });
  await secondary.evaluate(() => { window.__timegateAudioRecorder.events = []; });
  await primary.bringToFront();

  await waitForAudioCue(primary, 'minimum_time_met');
  await primary.waitForTimeout(300);
  expect(
    await secondary.evaluate(() =>
      window.__timegateAudioRecorder.events.filter(
        (event) => event.type === 'audio_cue_played',
      ),
    ),
  ).toEqual([]);
  await context.close();
});

test('a deferred audio resume cannot play after the tab loses primary ownership', async ({
  page,
}) => {
  await installAudioContextRecorder(page, 'resume-deferred');
  await page.goto(
    `${harnessPath}?timegate=delay&strictScorm=1&launch=1&audio=1`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await page.getByRole('checkbox', {
    name: /Play helpful sound cues/,
  }).check();
  await waitForAudioCue(page, 'audio_enabled');
  await page.getByRole('button', { name: 'I understand' }).click();
  await page.evaluate(() => {
    window.__timegateAudioRecorder.events = [];
    window.__timegateAudioRecorder.oscillatorStarts = [];
    window.__timegateAudioRecorder.suspendLatestContext();
  });

  await page.waitForFunction(
    () =>
      window.__timegateAudioRecorder.pendingResumes.length === 1 &&
      window.__timegateAudioRecorder.events.some(
        (event) =>
          event.type === 'minimum_time_met' && event.reason === 'timer',
      ),
  );

  await page.evaluate(() => {
    window.localStorage.setItem(
      'timegate-v2.lock.observability-browser-delay.POC-LEARNER-001',
      JSON.stringify({ tabId: 'foreign-primary', ts: Date.now() }),
    );
  });
  await expect(page.locator('#timegate-root')).toHaveClass(
    /timegate--paused/,
    { timeout: 3_000 },
  );
  expect(
    await page.evaluate(() =>
      window.__timegateAudioRecorder.resolveNextResume(),
    ),
  ).toBe(true);
  await page.waitForTimeout(100);

  expect(
    await page.evaluate(() => ({
      cueEvents: window.__timegateAudioRecorder.events.filter(
        (event) => event.type === 'audio_cue_played',
      ),
      oscillatorStarts: window.__timegateAudioRecorder.oscillatorStarts,
    })),
  ).toEqual({ cueEvents: [], oscillatorStarts: [] });
});

test('maximum-time exit plays one terminal cue and never replays it', async ({
  page,
}) => {
  await installAudioContextRecorder(page);
  const url = `${harnessPath}?timegate=max&strictScorm=1&launch=1&audio=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await page.getByRole('checkbox', {
    name: /Play helpful sound cues/,
  }).check();
  await waitForAudioCue(page, 'audio_enabled');
  await page.getByRole('button', { name: 'I understand' }).click();
  await page.evaluate(() => { window.__timegateAudioRecorder.events = []; });

  await expect(page.locator('#timegate-walkback')).toBeVisible({
    timeout: 7_000,
  });
  await waitForAudioCue(page, 'session_ended');
  await page.waitForTimeout(1_200);
  expect(
    await page.evaluate(() =>
      window.__timegateAudioRecorder.events.filter(
        (event) =>
          event.type === 'audio_cue_played' &&
          event.reason === 'session_ended',
      ).length,
    ),
  ).toBe(1);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await expect(page.locator('#timegate-walkback')).toBeVisible();
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(() =>
      window.__timegateAudioRecorder.events.some(
        (event) =>
          event.type === 'audio_cue_played' &&
          event.reason === 'session_ended',
      ),
    ),
  ).toBe(false);
});

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

async function openSeatTimeHarness(
  page,
  {
    seat = 'enabled',
    response = 'ok',
    timegate = 'seat',
    extra = '',
  } = {},
) {
  const suffix = extra ? `&${extra}` : '';
  await page.goto(
    `${harnessPath}?timegate=${timegate}&strictScorm=1&seat=${seat}` +
      `&seatResponse=${response}${suffix}`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.localLmsHarness &&
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
}

async function initializeSeatTime(page) {
  return page.evaluate(() => window.localLmsHarness.initialize());
}

async function waitForSeatTimeRequests(page, count = 1, timeout = 7_000) {
  await page.waitForFunction(
    (expected) =>
      window.localLmsHarness.seatTimeRequests.length >= expected,
    count,
    { timeout },
  );
}

async function readPersistedTimegateState(page, learnerId) {
  return page.evaluate((learner) => {
    let persisted = null;
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (
        key &&
        key.startsWith('timegate-v2.v1.') &&
        key.endsWith(`.${learner}`)
      ) {
        persisted = JSON.parse(window.localStorage.getItem(key));
      }
    }
    return persisted;
  }, learnerId);
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

test('terminated page releases the learner lock without reacquiring it', async ({
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

  const termination = await page.evaluate(() => {
    window.localLmsHarness.initialize();
    const lockKeys = () => Object.keys(window.localStorage)
      .filter((key) => key.startsWith('timegate-v2.lock.'));
    const lockExisted = lockKeys().length === 1;
    const finish = window.localLmsHarness.finish();
    return {
      finish,
      lockExisted,
      lockKeysAfterFinish: lockKeys(),
      terminated: window.localLmsHarness.lifecycle.terminated,
    };
  });
  expect(termination).toMatchObject({
    finish: 'true',
    lockExisted: true,
    lockKeysAfterFinish: [],
    terminated: true,
  });

  await page.waitForTimeout(2_200);
  expect(
    await page.evaluate(() => Object.keys(window.localStorage)
      .filter((key) => key.startsWith('timegate-v2.lock.'))),
  ).toEqual([]);
});

test('inactivity relaunch notice is saved before Finish and consumed once', async ({
  page,
}) => {
  const url = `${harnessPath}?timegate=idle&strictScorm=1&launch=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await expect(page.locator('#timegate-launch-modal')).toBeVisible();

  await page.evaluate(() => {
    const calls = window.localLmsHarness.calls;
    const nativePush = calls.push;
    calls.push = function captureStateBeforeFinish(...items) {
      if (items.some((item) => item && item[0] === 'LMSFinish')) {
        window.__timegateStateAtFinish = Object.keys(window.localStorage)
          .filter((key) => key.startsWith('timegate-v2.v1.'))
          .map((key) => JSON.parse(window.localStorage.getItem(key)))
          .find((value) => value && value.inactivityExitNotice) || null;
      }
      return nativePush.apply(this, items);
    };
    window.localLmsHarness.initialize();
  });
  await page.getByRole('button', { name: 'I understand' }).click();
  await expect(page.locator('#timegate-walkback')).toBeVisible({
    timeout: 6_000,
  });

  const exitResult = await page.evaluate(() => ({
    calls: window.localLmsHarness.calls.slice(),
    stateAtFinish: window.__timegateStateAtFinish,
  }));
  expect(exitResult.calls.some((call) => call[0] === 'LMSFinish')).toBe(true);
  expect(exitResult.stateAtFinish.inactivityExitNotice).toMatchObject({
    reason: 'inactivity',
    thresholdSeconds: 2,
  });
  expect(
    Date.parse(exitResult.stateAtFinish.inactivityExitNotice.occurredAt),
  ).not.toBeNaN();

  for (let relaunch = 0; relaunch < 2; relaunch += 1) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () =>
        window.localLmsHarness.timegateReady &&
        Boolean(document.getElementById('timegate-root')),
    );
    await page.evaluate(() => window.localLmsHarness.initialize());

    const resumeButton = page.getByRole('button', { name: 'Resume course' });
    await expect(page.getByRole('dialog', {
      name: 'Your previous session ended',
    })).toBeVisible();
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(1);
    await expect(page.locator('#timegate-launch-modal')).toHaveCount(0);
    const relaunchTitle = page.locator('#timegate-inactivity-relaunch-title');
    await expect(relaunchTitle).toBeFocused();
    await expect(page.locator('#timegate-inactivity-relaunch-message')).toContainText(
      'after 2 seconds without activity',
    );

    if (relaunch === 0) {
      await page.keyboard.press('Escape');
      await expect(relaunchTitle).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(resumeButton).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(resumeButton).toBeFocused();
    } else {
      await resumeButton.click();
    }
  }

  await expect(page.locator('#timegate-inactivity-relaunch-modal')).toHaveCount(0);
  await expect(page.locator('#timegate-root')).toBeVisible();
  const acknowledgedState = await readPersistedTimegateState(
    page,
    'POC-LEARNER-001',
  );
  expect(acknowledgedState.inactivityExitNotice).toBeNull();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await expect(page.locator('#timegate-inactivity-relaunch-modal')).toHaveCount(0);
  await expect(page.locator('#timegate-launch-modal')).toBeVisible();
});

test('inactivity before LMS Initialize is persisted for the resolved learner', async ({
  page,
}) => {
  const url = `${harnessPath}?timegate=idle&strictScorm=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await expect(page.locator('#timegate-walkback')).toBeVisible({
    timeout: 6_000,
  });
  expect(
    await page.evaluate(() =>
      window.localLmsHarness.calls.some((call) => call[0] === 'LMSFinish'),
    ),
  ).toBe(false);

  expect(
    await page.evaluate(() => window.localLmsHarness.initialize()),
  ).toBe('true');
  await page.waitForFunction(
    () => window.localLmsHarness.lifecycle.terminated,
    null,
    { timeout: 6_000 },
  );
  const exitedState = await readPersistedTimegateState(
    page,
    'POC-LEARNER-001',
  );
  expect(exitedState.inactivityExitNotice).toMatchObject({
    reason: 'inactivity',
    thresholdSeconds: 2,
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await expect(page.getByRole('dialog', {
    name: 'Your previous session ended',
  })).toBeVisible();
});

test('seat-time reporting resumes after a late-hydrated inactivity notice', async ({
  page,
}) => {
  await page.goto(harnessPath, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.localStorage.setItem(
      'timegate-v2.v1.observability-browser-idle.POC-LEARNER-001',
      JSON.stringify({
        version: 1,
        courseKey: 'observability-browser-idle',
        learnerKey: 'POC-LEARNER-001',
        elapsedSeconds: 30,
        inactivityExitNotice: {
          reason: 'inactivity',
          occurredAt: '2026-09-08T12:00:00.000Z',
          thresholdSeconds: 300,
        },
      }),
    );
    window.sessionStorage.setItem(
      '__timegate_harness_attempt__idle|POC-LEARNER-001',
      'started',
    );
  });
  await page.goto(
    `${harnessPath}?timegate=idle&strictScorm=1&seat=enabled`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  expect(
    await page.evaluate(() => window.localLmsHarness.initialize()),
  ).toBe('true');
  await expect(page.getByRole('dialog', {
    name: 'Your previous session ended',
  })).toBeVisible();
  await page.waitForTimeout(250);
  expect(
    await page.evaluate(() => ({
      requests: window.localLmsHarness.seatTimeRequests.length,
      writes: window.localLmsHarness.seatTimeOutboxWrites.length,
    })),
  ).toEqual({ requests: 0, writes: 0 });

  await page.getByRole('button', { name: 'Resume course' }).click();
  await page.waitForFunction(() =>
    window.localLmsHarness.seatTimeOutboxWrites.some(
      (write) => write.entry && write.entry.reason === 'tracking-resumed',
    ),
  );
  const resumed = await page.evaluate(() => ({
    requestReasons: window.localLmsHarness.seatTimeRequests.map(
      (request) => request.payload.reason,
    ),
    write: window.localLmsHarness.seatTimeOutboxWrites.find(
      (write) => write.entry && write.entry.reason === 'tracking-resumed',
    ).entry,
  }));
  expect(resumed.write.attemptId).toMatch(/^attempt-/);
  expect(resumed.requestReasons).toContain('tracking-resumed');
});

test('dual storage clears the relaunch notice from LMS suspend data', async ({
  page,
}) => {
  const url = `${harnessPath}?timegate=idle&strictScorm=1&storage=dual`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await expect(page.locator('#timegate-walkback')).toBeVisible({
    timeout: 6_000,
  });

  const exited = await page.evaluate(() => {
    const raw = window.localLmsHarness.values['cmi.suspend_data'];
    window.localStorage.setItem('__timegate_harness_suspend_seed', raw);
    const calls = window.localLmsHarness.calls;
    const exitIndex = calls.findIndex(
      (call) =>
        call[0] === 'LMSSetValue' &&
        call[1] === 'cmi.core.exit' &&
        call[2] === 'suspend',
    );
    const markerIndex = calls.findIndex((call) => {
      if (call[0] !== 'LMSSetValue' || call[1] !== 'cmi.suspend_data') {
        return false;
      }
      try {
        return Boolean(JSON.parse(call[2]).__timegate_v2.inactivityExit);
      } catch (error) {
        return false;
      }
    });
    return {
      exitIndex,
      finishIndex: calls.findIndex((call) => call[0] === 'LMSFinish'),
      markerIndex,
      suspendState: JSON.parse(raw).__timegate_v2,
    };
  });
  expect(exited.suspendState.inactivityExit).toEqual([
    expect.any(Number),
    2,
  ]);
  expect(exited.exitIndex).toBeGreaterThanOrEqual(0);
  expect(exited.markerIndex).toBeGreaterThan(exited.exitIndex);
  expect(exited.finishIndex).toBeGreaterThan(exited.markerIndex);

  await page.goto(`${url}&seedSuspend=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await expect(page.getByRole('dialog', {
    name: 'Your previous session ended',
  })).toBeVisible();
  await page.getByRole('button', { name: 'Resume course' }).click();

  const resumedState = await page.evaluate(() => ({
    local: Object.keys(window.localStorage)
      .filter((key) =>
        key.startsWith('timegate-v2.v1.observability-browser-idle.'),
      )
      .map((key) => JSON.parse(window.localStorage.getItem(key)))
      .find(Boolean),
    suspend:
      JSON.parse(window.localLmsHarness.values['cmi.suspend_data'])
        .__timegate_v2,
  }));
  expect(resumedState.local.inactivityExitNotice).toBeNull();
  expect(resumedState.suspend.inactivityExit).toBeUndefined();
  expect(
    resumedState.suspend.pendingTerminate &&
      resumedState.suspend.pendingTerminate.reason,
  ).not.toBe('inactivity');
});

test('dual storage reconciles a newer local inactivity notice and acknowledgement', async ({
  page,
}) => {
  const url = `${harnessPath}?timegate=idle&strictScorm=1&storage=dual`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => {
    window.localLmsHarness.initialize();
    window.localLmsHarness.failure.setValue = true;
  });
  await expect(page.locator('#timegate-walkback')).toBeVisible({
    timeout: 6_000,
  });

  const divergedExit = await page.evaluate(() => {
    const suspendRaw = window.localLmsHarness.values['cmi.suspend_data'];
    window.localStorage.setItem('__timegate_harness_suspend_seed', suspendRaw);
    const local = Object.keys(window.localStorage)
      .filter((key) =>
        key.startsWith('timegate-v2.v1.observability-browser-idle.'),
      )
      .map((key) => JSON.parse(window.localStorage.getItem(key)))
      .find(Boolean);
    return {
      localNotice: local.inactivityExitNotice,
      suspendNotice:
        JSON.parse(suspendRaw).__timegate_v2.inactivityExit || null,
    };
  });
  expect(divergedExit.localNotice).toMatchObject({ reason: 'inactivity' });
  expect(divergedExit.suspendNotice).toBeNull();

  await page.goto(`${url}&seedSuspend=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await expect(page.getByRole('dialog', {
    name: 'Your previous session ended',
  })).toBeVisible();

  await page.evaluate(() => {
    window.localLmsHarness.failure.setValue = true;
    window.__timegateNativeDateNow = Date.now;
    Date.now = () => 1_000;
  });
  await page.getByRole('button', { name: 'Resume course' }).click();
  const divergedAcknowledgement = await page.evaluate(() => {
    Date.now = window.__timegateNativeDateNow;
    delete window.__timegateNativeDateNow;
    const suspendRaw = window.localLmsHarness.values['cmi.suspend_data'];
    window.localStorage.setItem('__timegate_harness_suspend_seed', suspendRaw);
    const local = Object.keys(window.localStorage)
      .filter((key) =>
        key.startsWith('timegate-v2.v1.observability-browser-idle.'),
      )
      .map((key) => JSON.parse(window.localStorage.getItem(key)))
      .find(Boolean);
    return {
      localRevision: local.persistenceRevision,
      localTimestamp: local.lastTickTs,
      localNotice: local.inactivityExitNotice,
      suspendRevision:
        JSON.parse(suspendRaw).__timegate_v2.persistenceRevision,
      suspendTimestamp: JSON.parse(suspendRaw).__timegate_v2.lastTickTs,
      suspendNotice: JSON.parse(suspendRaw).__timegate_v2.inactivityExit,
    };
  });
  expect(divergedAcknowledgement.localNotice).toBeNull();
  expect(divergedAcknowledgement.localRevision).toBeGreaterThan(
    divergedAcknowledgement.suspendRevision,
  );
  expect(divergedAcknowledgement.localTimestamp).toBeLessThan(
    divergedAcknowledgement.suspendTimestamp,
  );
  expect(divergedAcknowledgement.suspendNotice).toEqual([
    expect.any(Number),
    2,
  ]);

  await page.goto(`${url}&seedSuspend=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await expect(page.locator('#timegate-inactivity-relaunch-modal')).toHaveCount(0);
  await expect(page.locator('#timegate-root')).toBeVisible();
});

test('compact LMS persistence preserves inactivity termination near the suspend-data limit', async ({
  page,
}) => {
  const url = `${harnessPath}?timegate=idle&strictScorm=1&storage=dual`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  const baseline = await page.evaluate(() => {
    window.localLmsHarness.values['cmi.suspend_data'] = JSON.stringify({
      ownerData: 'x'.repeat(2_600),
    });
    window.localLmsHarness.initialize();
    const container = JSON.parse(
      window.localLmsHarness.values['cmi.suspend_data'],
    );
    let raw = JSON.stringify(container);
    container.ownerData += 'x'.repeat(Math.max(0, 3_750 - raw.length));
    raw = JSON.stringify(container);
    window.localLmsHarness.values['cmi.suspend_data'] = raw;
    return {
      hasNormalState: Boolean(container.__timegate_v2),
      length: raw.length,
    };
  });
  expect(baseline).toEqual({ hasNormalState: true, length: 3_750 });

  await expect(page.locator('#timegate-walkback')).toBeVisible({
    timeout: 6_000,
  });
  const result = await page.evaluate(() => {
    const suspendRaw = window.localLmsHarness.values['cmi.suspend_data'];
    const suspendContainer = JSON.parse(suspendRaw);
    const localState = Object.keys(window.localStorage)
      .filter((key) =>
        key.startsWith('timegate-v2.v1.observability-browser-idle.'),
      )
      .map((key) => JSON.parse(window.localStorage.getItem(key)))
      .find(Boolean);
    const uncompressedContainer = { ...suspendContainer };
    uncompressedContainer.__timegate_v2 = localState;
    return {
      finishCalls: window.localLmsHarness.calls.filter(
        (call) => call[0] === 'LMSFinish',
      ).length,
      lifecycle: { ...window.localLmsHarness.lifecycle },
      suspendLength: suspendRaw.length,
      suspendNotice: suspendContainer.__timegate_v2.inactivityExit,
      uncompressedLength: JSON.stringify(uncompressedContainer).length,
    };
  });
  expect(result.uncompressedLength).toBeGreaterThan(3_800);
  expect(result.suspendLength).toBeLessThanOrEqual(3_800);
  expect(result.suspendNotice).toEqual([expect.any(Number), 2]);
  expect(result.finishCalls).toBe(1);
  expect(result.lifecycle).toEqual({ initialized: false, terminated: true });
});

test('failed inactivity termination is not replayed against the resumed LMS session', async ({
  page,
}) => {
  const url = `${harnessPath}?timegate=idle&strictScorm=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => {
    window.localLmsHarness.failure.finish = true;
    window.localLmsHarness.initialize();
  });
  await expect(page.locator('#timegate-walkback')).toBeVisible({
    timeout: 6_000,
  });
  const failedExitState = await readPersistedTimegateState(
    page,
    'POC-LEARNER-001',
  );
  expect(failedExitState.pendingTerminate).toMatchObject({
    reason: 'inactivity',
  });
  expect(failedExitState.inactivityExitNotice).not.toBeNull();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await expect(page.getByRole('dialog', {
    name: 'Your previous session ended',
  })).toBeVisible();
  await page.waitForTimeout(1_200);
  expect(
    await page.evaluate(() =>
      window.localLmsHarness.calls.some((call) => call[0] === 'LMSFinish'),
    ),
  ).toBe(false);

  await page.getByRole('button', { name: 'Resume course' }).click();
  const resumedState = await readPersistedTimegateState(
    page,
    'POC-LEARNER-001',
  );
  expect(resumedState.pendingTerminate).toBeNull();
  expect(resumedState.inactivityExitNotice).toBeNull();
  expect(await page.evaluate(() => window.localLmsHarness.lifecycle.initialized)).toBe(
    true,
  );
});

test('inactivity relaunch notice is scoped to learner, course, and resume entry', async ({
  browser,
}) => {
  const cases = [
    {
      name: 'learner',
      storedLearner: 'LEARNER-A',
      launchLearner: 'LEARNER-B',
      storedCourse: 'COURSE-A',
      launchCourse: 'COURSE-A',
      resume: true,
    },
    {
      name: 'course',
      storedLearner: 'LEARNER-A',
      launchLearner: 'LEARNER-A',
      storedCourse: 'COURSE-A',
      launchCourse: 'COURSE-B',
      resume: true,
    },
    {
      name: 'attempt',
      storedLearner: 'LEARNER-A',
      launchLearner: 'LEARNER-A',
      storedCourse: 'COURSE-A',
      launchCourse: 'COURSE-A',
      resume: false,
    },
  ];

  for (const testCase of cases) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(harnessPath, { waitUntil: 'domcontentloaded' });
    await page.evaluate((scope) => {
      window.localStorage.setItem(
        `timegate-v2.v1.${scope.storedCourse}.${scope.storedLearner}`,
        JSON.stringify({
          version: 1,
          courseKey: scope.storedCourse,
          learnerKey: scope.storedLearner,
          elapsedSeconds: 30,
          inactivityExitNotice: {
            reason: 'inactivity',
            occurredAt: '2026-09-08T12:00:00.000Z',
            thresholdSeconds: 300,
          },
        }),
      );
      if (scope.resume) {
        window.sessionStorage.setItem(
          `__timegate_harness_attempt__idle|${scope.launchLearner}`,
          'started',
        );
      }
    }, testCase);
    const query = new URLSearchParams({
      timegate: 'idle',
      strictScorm: '1',
      launch: '1',
      learner: testCase.launchLearner,
      courseKey: testCase.launchCourse,
    });
    await page.goto(`${harnessPath}?${query}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(
      () =>
        window.localLmsHarness.timegateReady &&
        Boolean(document.getElementById('timegate-root')),
    );
    await page.evaluate(() => window.localLmsHarness.initialize());
    await expect(
      page.locator('#timegate-inactivity-relaunch-modal'),
      `${testCase.name} scope`,
    ).toHaveCount(0);
    await expect(page.locator('#timegate-launch-modal')).toBeVisible();
    await context.close();
  }
});

test('a secondary tab presents the notice when it takes learner ownership', async ({
  page,
}) => {
  const courseKey = 'observability-browser-delay';
  const learnerKey = 'POC-LEARNER-001';
  const lockKey = `timegate-v2.lock.${courseKey}.${learnerKey}`;
  const stateKey = `timegate-v2.v1.${courseKey}.${learnerKey}`;

  await page.goto(harnessPath, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ lock, state, course, learner }) => {
    window.sessionStorage.setItem(
      `__timegate_harness_attempt__delay|${learner}`,
      'started',
    );
    window.localStorage.setItem(
      lock,
      JSON.stringify({ tabId: 'synthetic-primary', ts: Date.now() }),
    );
    window.localStorage.setItem(
      state,
      JSON.stringify({
        version: 1,
        courseKey: course,
        learnerKey: learner,
        elapsedSeconds: 30,
        lastTickTs: Date.now(),
        inactivityExitNotice: {
          reason: 'inactivity',
          occurredAt: new Date().toISOString(),
          thresholdSeconds: 300,
        },
      }),
    );
  }, {
    lock: lockKey,
    state: stateKey,
    course: courseKey,
    learner: learnerKey,
  });
  await page.goto(`${harnessPath}?timegate=delay&strictScorm=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await expect(page.locator('#timegate-inactivity-relaunch-modal')).toHaveCount(0);

  await page.evaluate((lock) => window.localStorage.removeItem(lock), lockKey);

  await expect(page.getByRole('dialog', {
    name: 'Your previous session ended',
  })).toBeVisible({ timeout: 4_000 });
  await expect(page.locator('#timegate-root')).toBeHidden();

  await page.evaluate((lock) => {
    window.localStorage.setItem(
      lock,
      JSON.stringify({ tabId: 'new-primary', ts: Date.now() }),
    );
  }, lockKey);
  await page.getByRole('button', { name: 'Resume course' }).click();
  await expect(page.getByRole('dialog', {
    name: 'Your previous session ended',
  })).toBeVisible();
  expect(
    (await readPersistedTimegateState(page, learnerKey)).inactivityExitNotice,
  ).not.toBeNull();

  await page.evaluate((lock) => window.localStorage.removeItem(lock), lockKey);
  await page.getByRole('button', { name: 'Resume course' }).click();
  await expect(page.locator('#timegate-inactivity-relaunch-modal')).toHaveCount(0);
  expect(
    (await readPersistedTimegateState(page, learnerKey)).inactivityExitNotice,
  ).toBeNull();
});

test('a secondary tab does not inactivity-exit before it can take ownership', async ({
  page,
}) => {
  const lockKey =
    'timegate-v2.lock.observability-browser-idle.POC-LEARNER-001';
  await page.goto(harnessPath, { waitUntil: 'domcontentloaded' });
  await page.evaluate((lock) => {
    window.localStorage.setItem(
      lock,
      JSON.stringify({ tabId: 'synthetic-primary', ts: Date.now() }),
    );
  }, lockKey);
  await page.goto(`${harnessPath}?timegate=idle&strictScorm=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());

  await page.waitForTimeout(2_500);
  await expect(page.locator('#timegate-walkback')).toHaveCount(0);
  expect(
    await page.evaluate(() => ({ ...window.localLmsHarness.lifecycle })),
  ).toEqual({ initialized: true, terminated: false });

  await page.evaluate((lock) => window.localStorage.removeItem(lock), lockKey);
  await page.waitForFunction((lock) => {
    const value = window.localStorage.getItem(lock);
    if (!value) return false;
    return JSON.parse(value).tabId !== 'synthetic-primary';
  }, lockKey);
  await page.evaluate(() => {
    document.dispatchEvent(new Event('mousemove'));
  });
  await expect(page.locator('#timegate-walkback')).toHaveCount(0);
  expect(
    await page.evaluate(() => ({ ...window.localLmsHarness.lifecycle })),
  ).toEqual({ initialized: true, terminated: false });
});

test('fresh-attempt takeover does not import an older local termination', async ({
  page,
}) => {
  const courseKey = 'observability-browser-delay';
  const learnerKey = 'POC-LEARNER-001';
  const lockKey = `timegate-v2.lock.${courseKey}.${learnerKey}`;
  const stateKey = `timegate-v2.v1.${courseKey}.${learnerKey}`;
  await page.goto(harnessPath, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ lock, state, course, learner }) => {
    window.localStorage.setItem(
      lock,
      JSON.stringify({ tabId: 'synthetic-primary', ts: Date.now() }),
    );
    window.localStorage.setItem(
      state,
      JSON.stringify({
        version: 1,
        courseKey: course,
        learnerKey: learner,
        elapsedSeconds: 30,
        lastTickTs: Date.now(),
        pendingTerminate: {
          requestedAt: new Date().toISOString(),
          reason: 'course',
        },
      }),
    );
  }, {
    lock: lockKey,
    state: stateKey,
    course: courseKey,
    learner: learnerKey,
  });
  await page.goto(`${harnessPath}?timegate=delay&strictScorm=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await page.evaluate((lock) => window.localStorage.removeItem(lock), lockKey);
  await page.waitForTimeout(1_800);

  expect(
    await page.evaluate(() => ({
      entry: window.localLmsHarness.values['cmi.core.entry'],
      finishCalls: window.localLmsHarness.calls.filter(
        (call) => call[0] === 'LMSFinish',
      ).length,
      lifecycle: { ...window.localLmsHarness.lifecycle },
    })),
  ).toEqual({
    entry: 'ab-initio',
    finishCalls: 0,
    lifecycle: { initialized: true, terminated: false },
  });
});

test('a pre-initialize inactivity exit waits for resolved learner ownership', async ({
  page,
}) => {
  const lockKey =
    'timegate-v2.lock.observability-browser-idle.POC-LEARNER-001';
  await page.goto(`${harnessPath}?timegate=idle&strictScorm=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await expect(page.locator('#timegate-walkback')).toBeVisible({
    timeout: 6_000,
  });

  await page.evaluate((lock) => {
    window.localStorage.setItem(
      lock,
      JSON.stringify({ tabId: 'synthetic-primary', ts: Date.now() }),
    );
  }, lockKey);
  expect(
    await page.evaluate(() => window.localLmsHarness.initialize()),
  ).toBe('true');
  await expect(page.locator('#timegate-walkback')).toHaveCount(0);
  await page.waitForTimeout(2_500);
  expect(
    await page.evaluate(() => ({
      finishCalls: window.localLmsHarness.calls.filter(
        (call) => call[0] === 'LMSFinish',
      ).length,
      lifecycle: { ...window.localLmsHarness.lifecycle },
    })),
  ).toEqual({
    finishCalls: 0,
    lifecycle: { initialized: true, terminated: false },
  });

  await page.evaluate((lock) => window.localStorage.removeItem(lock), lockKey);
  await page.waitForFunction(
    () => window.localLmsHarness.lifecycle.terminated,
    null,
    { timeout: 5_000 },
  );
  expect(
    await page.evaluate(() =>
      window.localLmsHarness.calls.filter(
        (call) => call[0] === 'LMSFinish',
      ).length,
    ),
  ).toBe(1);
  await expect(page.locator('#timegate-walkback')).toBeVisible();
  const exitedState = await readPersistedTimegateState(
    page,
    'POC-LEARNER-001',
  );
  expect(exitedState.inactivityExitNotice).toMatchObject({
    reason: 'inactivity',
    thresholdSeconds: 2,
  });
});

test('SCORM 2004 shows and clears the inactivity relaunch notice', async ({
  page,
}) => {
  const url =
    `${scorm2004HarnessPath}?api=missing&strictScorm=1&floor=delay&idle=1` +
    '&storage=dual';
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      window.localLmsHarness.apiVersion === '2004' &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await expect(page.locator('#timegate-walkback')).toBeVisible({
    timeout: 6_000,
  });
  const exited = await page.evaluate(() => {
    const calls = window.localLmsHarness.calls;
    const suspendRaw = window.localLmsHarness.values['cmi.suspend_data'];
    window.localStorage.setItem('__timegate_harness_suspend_seed', suspendRaw);
    const exitIndex = calls.findIndex(
      (call) =>
        call[0] === 'SetValue' &&
        call[1] === 'cmi.exit' &&
        call[2] === 'suspend',
    );
    const markerIndex = calls.findIndex((call) => {
      if (call[0] !== 'SetValue' || call[1] !== 'cmi.suspend_data') {
        return false;
      }
      try {
        return Boolean(JSON.parse(call[2]).__timegate_v2.inactivityExit);
      } catch (error) {
        return false;
      }
    });
    return {
      exitIndex,
      markerIndex,
      suspendState: JSON.parse(suspendRaw).__timegate_v2,
      terminateIndex: calls.findIndex((call) => call[0] === 'Terminate'),
    };
  });
  expect(exited.suspendState.inactivityExit).toEqual([
    expect.any(Number),
    2,
  ]);
  expect(exited.exitIndex).toBeGreaterThanOrEqual(0);
  expect(exited.markerIndex).toBeGreaterThan(exited.exitIndex);
  expect(exited.terminateIndex).toBeGreaterThan(exited.markerIndex);
  expect((await readScorm2004TimegateState(page)).inactivityExitNotice).toMatchObject({
    reason: 'inactivity',
    thresholdSeconds: 2,
  });

  await page.goto(`${url}&seedSuspend=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      window.localLmsHarness.apiVersion === '2004' &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await expect(page.getByRole('dialog', {
    name: 'Your previous session ended',
  })).toBeVisible();
  await page.getByRole('button', { name: 'Resume course' }).click();
  expect((await readScorm2004TimegateState(page)).inactivityExitNotice).toBeNull();
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

test('mis-scoped LMS state cannot terminate a different learner session', async ({
  page,
}) => {
  await page.goto(
    `${harnessPath}?timegate=dual-shared&strictScorm=1`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => {
    window.localLmsHarness.values['cmi.suspend_data'] = JSON.stringify({
      __timegate_v2: {
        version: 1,
        courseKey: 'observability-browser-dual-shared',
        learnerKey: 'OTHER-LEARNER',
        elapsedSeconds: 60,
        lastTickTs: Date.now() + 1_000,
        pendingTerminate: {
          requestedAt: new Date().toISOString(),
          reason: 'course',
        },
      },
    });
    window.localLmsHarness.initialize();
  });
  await page.waitForTimeout(1_500);

  expect(
    await page.evaluate(() => ({
      finishCalls: window.localLmsHarness.calls.filter(
        (call) => call[0] === 'LMSFinish',
      ).length,
      lifecycle: { ...window.localLmsHarness.lifecycle },
    })),
  ).toEqual({
    finishCalls: 0,
    lifecycle: { initialized: true, terminated: false },
  });
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

test('a stale maximum termination is discarded when the configured cap increases', async ({
  page,
}) => {
  await page.goto(harnessPath, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.localStorage.setItem(
      'timegate-v2.v1.observability-browser-ring.POC-LEARNER-001',
      JSON.stringify({
        version: 1,
        courseKey: 'observability-browser-ring',
        learnerKey: 'POC-LEARNER-001',
        elapsedSeconds: 300,
        lastTickTs: Date.now(),
        pendingTerminate: {
          requestedAt: new Date().toISOString(),
          reason: 'maximum',
        },
      }),
    );
    window.sessionStorage.setItem(
      '__timegate_harness_attempt__ring|POC-LEARNER-001',
      'started',
    );
  });
  await page.goto(`${harnessPath}?timegate=ring&strictScorm=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await page.waitForTimeout(1_500);

  const result = await page.evaluate(() => ({
    finishCalls: window.localLmsHarness.calls.filter(
      (call) => call[0] === 'LMSFinish',
    ).length,
    lifecycle: { ...window.localLmsHarness.lifecycle },
  }));
  expect(result.finishCalls).toBe(0);
  expect(result.lifecycle).toEqual({ initialized: true, terminated: false });
  await expect(page.locator('#timegate-walkback')).toHaveCount(0);
  await expect(page.locator('#timegate-root')).toBeVisible();
});

test('an ambiguous legacy termination is not replayed into a new LMS session', async ({
  page,
}) => {
  await page.goto(harnessPath, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.localStorage.setItem(
      'timegate-v2.v1.observability-browser-delay.POC-LEARNER-001',
      JSON.stringify({
        version: 1,
        courseKey: 'observability-browser-delay',
        learnerKey: 'POC-LEARNER-001',
        elapsedSeconds: 30,
        lastTickTs: Date.now(),
        courseCompletePending: false,
        pendingTerminate: {
          requestedAt: new Date().toISOString(),
        },
      }),
    );
    window.sessionStorage.setItem(
      '__timegate_harness_attempt__delay|POC-LEARNER-001',
      'started',
    );
  });
  await page.goto(`${harnessPath}?timegate=delay&strictScorm=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  await page.evaluate(() => window.localLmsHarness.initialize());
  await page.waitForTimeout(1_500);

  expect(
    await page.evaluate(() => ({
      finishCalls: window.localLmsHarness.calls.filter(
        (call) => call[0] === 'LMSFinish',
      ).length,
      lifecycle: { ...window.localLmsHarness.lifecycle },
    })),
  ).toEqual({
    finishCalls: 0,
    lifecycle: { initialized: true, terminated: false },
  });
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

for (const seatMode of ['disabled', 'invalid', 'whitespace']) {
  test(`seat-time ${seatMode} config fails open without relay requests`, async ({
    page,
  }) => {
    await openSeatTimeHarness(page, {
      seat: seatMode,
      response: 'manual',
    });
    const result = await page.evaluate(() => {
      window.localLmsHarness.reset();
      return {
        initialize: window.localLmsHarness.initialize(),
        completion: window.localLmsHarness.complete(),
        lessonStatus:
          window.localLmsHarness.values['cmi.core.lesson_status'],
      };
    });
    await page.waitForTimeout(250);

    expect(result).toEqual({
      initialize: 'true',
      completion: 'true',
      lessonStatus: 'completed',
    });
    expect(
      await page.evaluate(
        () => window.localLmsHarness.seatTimeRequests.length,
      ),
    ).toBe(0);
    await expect(page.locator('#timegate-walkback')).not.toBeVisible();
  });
}

test('seat-time disabled preserves the core suspend-data shape at its size limit', async ({
  page,
}) => {
  await openSeatTimeHarness(page, {
    seat: 'disabled',
    timegate: 'dual-shared',
  });
  const result = await page.evaluate(() => {
    const initialize = window.localLmsHarness.initialize();
    const initialContainer = JSON.parse(
      window.localLmsHarness.values['cmi.suspend_data'],
    );
    const template = { ...initialContainer.__timegate_v2 };
    delete template.seatTimeScopeToken;
    delete template.seatTimeCompletionTimestamp;
    const emptyBoundary = JSON.stringify({
      padding: '',
      __timegate_v2: template,
    });
    const paddingLength = 3_800 - emptyBoundary.length;
    window.localLmsHarness.values['cmi.suspend_data'] = JSON.stringify({
      padding: 'x'.repeat(paddingLength),
    });
    const reset = window.SCORM_CallLMSSetValue(
      'cmi.core.lesson_status',
      'incomplete',
    );
    const raw = window.localLmsHarness.values['cmi.suspend_data'];
    const persistedContainer = JSON.parse(raw);
    return {
      initialize,
      initialState: initialContainer.__timegate_v2,
      paddingLength,
      persistedPaddingLength: persistedContainer.padding.length,
      persistedState: persistedContainer.__timegate_v2 || null,
      rawLength: raw.length,
      reset,
    };
  });

  expect(result.initialize).toBe('true');
  expect(result.reset).toBe('true');
  expect(result.paddingLength).toBeGreaterThan(0);
  expect(result.persistedPaddingLength).toBe(result.paddingLength);
  expect(result.persistedState).not.toBeNull();
  expect(result.rawLength).toBeLessThanOrEqual(3_800);
  for (const state of [result.initialState, result.persistedState]) {
    expect(state).not.toHaveProperty('seatTimeScopeToken');
    expect(state).not.toHaveProperty('seatTimeCompletionTimestamp');
  }
});

test('seat-time waits for identity, stores privately, and protects newer revisions from old acknowledgements', async ({
  page,
}) => {
  await openSeatTimeHarness(page, {
    response: 'manual',
    extra:
      'seatGrace=5&seatKey=%20LOCAL-SEAT-KEY%20' +
      '&seatCourse=%20LOCAL-COURSE-3982%20',
  });
  await page.waitForTimeout(2_600);

  const beforeIdentity = await page.evaluate(() => ({
    outbox: window.localLmsHarness.seatTimeOutbox(),
    requests: window.localLmsHarness.seatTimeRequests.length,
  }));
  expect(beforeIdentity).toEqual({ outbox: null, requests: 0 });

  expect(await initializeSeatTime(page)).toBe('true');
  await page.waitForFunction(
    () =>
      window.localLmsHarness.seatTimeRequests.length === 1 &&
      window.localLmsHarness.seatTimeResponseControls.length === 1 &&
      window.localLmsHarness.seatTimeOutbox() &&
      window.localLmsHarness.seatTimeOutbox().entries.length === 1,
  );

  const stored = await page.evaluate(() => ({
    outbox: window.localLmsHarness.seatTimeOutbox(),
    raw: window.localLmsHarness.seatTimeOutboxRaw(),
    request: window.localLmsHarness.seatTimeRequests[0],
  }));
  const firstPayload = stored.request.payload;
  const latestStored = stored.outbox.entries[0];
  const storedRecords = JSON.parse(stored.raw);

  expect(stored.request.contentType).toBe('text/plain;charset=UTF-8');
  expect(stored.request.url).toBe(`${new URL(page.url()).origin}/seat-time`);
  expect(firstPayload).toMatchObject({
    contractVersion: 1,
    relayKey: ' LOCAL-SEAT-KEY ',
    employeeId: 'POC-LEARNER-001',
    employeeName: 'Learner, Synthetic',
    courseId: ' LOCAL-COURSE-3982 ',
    completed: false,
    minRequiredMinutes: 0,
  });
  expect(firstPayload.attemptId).toMatch(
    /^attempt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(firstPayload.revision).toBe(1);
  expect(firstPayload.completionTimestamp).toBeNull();
  expect(firstPayload.activeSeconds).toBeGreaterThanOrEqual(1);
  expect(firstPayload.totalSeconds).toBeGreaterThanOrEqual(1);
  expect(firstPayload.totalSeconds).toBeGreaterThanOrEqual(
    firstPayload.activeSeconds,
  );
  expect(Number.isNaN(Date.parse(firstPayload.reportedAt))).toBe(false);
  expect(latestStored.attemptId).toBe(firstPayload.attemptId);
  expect(latestStored.revision).toBeGreaterThan(firstPayload.revision);
  expect(
    await page.evaluate(() =>
      window.localLmsHarness.seatTimeOutboxWrites.some(
        (write) => write.entry && write.entry.reason === 'minimum-met',
      ),
    ),
  ).toBe(true);
  expect(storedRecords).toHaveLength(1);
  expect(storedRecords[0].key).toBe(
    `__timegate_seat_time_outbox_v1.${latestStored.attemptId}.` +
      latestStored.revision,
  );
  expect(stored.raw).not.toContain('LOCAL-SEAT-KEY');
  expect(stored.raw).not.toContain('POC-LEARNER-001');
  expect(stored.raw).not.toContain('Learner, Synthetic');
  expect(stored.raw).not.toContain('relayKey');
  expect(stored.raw).not.toContain('employeeId');
  expect(stored.raw).not.toContain('employeeName');

  expect(
    await page.evaluate(() =>
      window.localLmsHarness.resolveNextSeatTimeResponse(true, true),
    ),
  ).toBe(true);
  await page.waitForFunction(
    () => window.localLmsHarness.seatTimeRequests.length === 2,
  );

  const afterOldAcknowledgement = await page.evaluate(() => ({
    outbox: window.localLmsHarness.seatTimeOutbox(),
    request: window.localLmsHarness.seatTimeRequests[1],
  }));
  expect(afterOldAcknowledgement.outbox.entries).toHaveLength(1);
  expect(afterOldAcknowledgement.outbox.entries[0].revision).toBe(
    afterOldAcknowledgement.request.payload.revision,
  );
  expect(afterOldAcknowledgement.request.payload.revision).toBe(
    latestStored.revision,
  );

  expect(
    await page.evaluate(() =>
      window.localLmsHarness.resolveNextSeatTimeResponse(true, true),
    ),
  ).toBe(true);
  await page.waitForFunction(() => {
    const outbox = window.localLmsHarness.seatTimeOutbox();
    return !outbox;
  });
});

test('seat-time selects the highest attempt revision despite client clock reversal', async ({
  page,
}) => {
  await openSeatTimeHarness(page, { response: 'manual' });
  expect(await initializeSeatTime(page)).toBe('true');
  await page.waitForFunction(
    () =>
      window.localLmsHarness.seatTimeRequests.length === 1 &&
      window.localLmsHarness.seatTimeOutbox(),
  );
  const fakeAttempt =
    'attempt-11111111-1111-4111-8111-111111111111';
  await page.evaluate((attemptId) => {
    const base = window.localLmsHarness.seatTimeOutbox().entries[0];
    const now = Date.now();
    const higher = {
      ...base,
      attemptId,
      revision: 2,
      reportedAt: new Date(now - 10_000).toISOString(),
      reason: 'synthetic-revision',
      updatedAt: now - 10_000,
      expiresAt: now + 60_000,
    };
    const lower = {
      ...higher,
      revision: 1,
      reportedAt: new Date(now + 10_000).toISOString(),
      updatedAt: now + 10_000,
    };
    window.localStorage.setItem(
      `__timegate_seat_time_outbox_v1.${attemptId}.2`,
      JSON.stringify(higher),
    );
    window.localStorage.setItem(
      `__timegate_seat_time_outbox_v1.${attemptId}.1`,
      JSON.stringify(lower),
    );
  }, fakeAttempt);

  expect(
    await page.evaluate(() => window.localLmsHarness.complete()),
  ).toBe('true');
  await page.waitForFunction(
    (attemptId) =>
      window.localStorage.getItem(
        `__timegate_seat_time_outbox_v1.${attemptId}.1`,
      ) === null,
    fakeAttempt,
  );
  expect(
    await page.evaluate(() =>
      window.localLmsHarness.resolveNextSeatTimeResponse(true, true),
    ),
  ).toBe(true);
  await page.waitForFunction(
    (attemptId) =>
      window.localLmsHarness.seatTimeRequests.some(
        (request) => request.payload.attemptId === attemptId,
      ),
    fakeAttempt,
  );
  const sent = await page.evaluate((attemptId) =>
    window.localLmsHarness.seatTimeRequests.find(
      (request) => request.payload.attemptId === attemptId,
    ).payload,
  fakeAttempt);
  expect(sent.revision).toBe(2);
});

test('seat-time metrics remain monotonic across an actual clock rollback', async ({
  page,
}) => {
  await openSeatTimeHarness(page, {
    response: 'manual',
    extra: 'seatIdle=0.25',
  });
  expect(await initializeSeatTime(page)).toBe('true');
  await page.waitForFunction(
    () =>
      window.localLmsHarness.seatTimeRequests.length === 1 &&
      window.localLmsHarness.seatTimeOutbox(),
  );
  await page.waitForTimeout(1_250);
  expect(
    await page.evaluate(() => window.localLmsHarness.complete()),
  ).toBe('true');
  await page.waitForFunction(() => {
    const outbox = window.localLmsHarness.seatTimeOutbox();
    return outbox && outbox.entries[0].idleSeconds >= 1;
  });
  const beforeRollback = await page.evaluate(
    () => window.localLmsHarness.seatTimeOutbox().entries[0],
  );

  expect(
    await page.evaluate(() => {
      const actualNow = Date.now;
      const rolledBackNow = actualNow() - 60_000;
      Date.now = () => rolledBackNow;
      try {
        return window.SCORM_CallLMSSetValue(
          'cmi.core.lesson_status',
          'incomplete',
        );
      } finally {
        Date.now = actualNow;
      }
    }),
  ).toBe('true');
  await page.waitForFunction(
    (revision) => {
      const outbox = window.localLmsHarness.seatTimeOutbox();
      return outbox && outbox.entries[0].revision > revision;
    },
    beforeRollback.revision,
  );
  const afterRollback = await page.evaluate(
    () => window.localLmsHarness.seatTimeOutbox().entries[0],
  );

  expect(afterRollback.revision).toBeGreaterThan(beforeRollback.revision);
  expect(afterRollback.activeSeconds).toBeGreaterThanOrEqual(
    beforeRollback.activeSeconds,
  );
  expect(afterRollback.idleSeconds).toBeGreaterThanOrEqual(
    beforeRollback.idleSeconds,
  );
  expect(afterRollback.totalSeconds).toBeGreaterThanOrEqual(
    beforeRollback.totalSeconds,
  );
  expect(afterRollback.totalSeconds).toBe(
    afterRollback.activeSeconds + afterRollback.idleSeconds,
  );
});

test('seat-time discards corrupt stored metrics instead of relaying them', async ({
  page,
}) => {
  await openSeatTimeHarness(page, { response: 'manual' });
  const corruptAttempt =
    'attempt-22222222-2222-4222-8222-222222222222';
  await page.evaluate((attemptId) => {
    const now = Date.now();
    window.localStorage.setItem(
      `__timegate_seat_time_outbox_v1.${attemptId}.1`,
      JSON.stringify({
        version: 1,
        endpoint: `${window.location.origin}/seat-time`,
        courseId: 'LOCAL-COURSE-3982',
        scopeToken: 'scope-33333333-3333-4333-8333-333333333333',
        attemptId,
        revision: 1,
        activeSeconds: 9,
        idleSeconds: 0,
        totalSeconds: 2,
        completed: false,
        minRequiredMinutes: 0,
        completionTimestamp: null,
        reportedAt: new Date(now).toISOString(),
        reason: 'corrupt',
        updatedAt: now,
        expiresAt: now + 60_000,
      }),
    );
  }, corruptAttempt);
  expect(await initializeSeatTime(page)).toBe('true');
  await waitForSeatTimeRequests(page);

  expect(
    await page.evaluate(
      (attemptId) =>
        window.localStorage.getItem(
          `__timegate_seat_time_outbox_v1.${attemptId}.1`,
        ),
      corruptAttempt,
    ),
  ).toBeNull();
  expect(
    await page.evaluate(
      (attemptId) =>
        window.localLmsHarness.seatTimeRequests.some(
          (request) => request.payload.attemptId === attemptId,
        ),
      corruptAttempt,
    ),
  ).toBe(false);
});

for (const responseMode of ['http-error', 'not-ok']) {
  test(`seat-time retains and retries after ${responseMode} relay responses`, async ({
    page,
  }) => {
    await openSeatTimeHarness(page, { response: responseMode });
    expect(await initializeSeatTime(page)).toBe('true');
    await page.waitForFunction(
      () =>
        window.localLmsHarness.seatTimeRequests.length === 1 &&
        window.localLmsHarness.seatTimeOutbox() &&
        window.localLmsHarness.seatTimeOutbox().entries.length === 1,
    );
    await page.waitForTimeout(250);
    expect(
      await page.evaluate(
        () => window.localLmsHarness.seatTimeRequests.length,
      ),
    ).toBe(1);
    expect(
      await page.evaluate(
        () => window.localLmsHarness.seatTimeOutbox().entries.length,
      ),
    ).toBe(1);

    await page.evaluate(() =>
      window.localLmsHarness.setSeatTimeResponseMode('ok'),
    );
    await page.waitForFunction(
      () => window.localLmsHarness.seatTimeRequests.length >= 2,
      null,
      { timeout: 8_000 },
    );
    await page.waitForFunction(() => {
      const outbox = window.localLmsHarness.seatTimeOutbox();
      return !outbox;
    });
  });
}

test('seat-time waits for durable scope persistence before first delivery', async ({
  page,
}) => {
  await openSeatTimeHarness(page, {
    response: 'manual',
    timegate: 'dual-shared',
  });
  const initialize = await page.evaluate(() => {
    window.localLmsHarness.failure.setValue = true;
    return window.localLmsHarness.initialize();
  });
  expect(initialize).toBe('true');
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(() => ({
      outbox: window.localLmsHarness.seatTimeOutbox(),
      requests: window.localLmsHarness.seatTimeRequests.length,
    })),
  ).toEqual({ outbox: null, requests: 0 });

  await page.evaluate(() => {
    window.localLmsHarness.failure.setValue = false;
  });
  await page.waitForFunction(
    () =>
      window.localLmsHarness.seatTimeRequests.length === 1 &&
      window.localLmsHarness.seatTimeOutbox() &&
      Boolean(window.localLmsHarness.values['cmi.suspend_data']),
    null,
    { timeout: 6_000 },
  );
  const durable = await page.evaluate(() => ({
    outboxScope:
      window.localLmsHarness.seatTimeOutbox().entries[0].scopeToken,
    persistedScope:
      JSON.parse(window.localLmsHarness.values['cmi.suspend_data'])
        .__timegate_v2.seatTimeScopeToken,
  }));
  expect(durable.persistedScope).toBe(durable.outboxScope);
  expect(durable.persistedScope).toMatch(/^scope-[0-9a-f-]{36}$/i);
});

test('seat-time outbox failure emits one private diagnostic without changing LMS completion', async ({
  page,
}) => {
  await openSeatTimeHarness(page, {
    response: 'manual',
    extra: 'seatOutbox=fail',
  });
  const result = await page.evaluate(() => {
    window.__seatTimeEvents = [];
    document.addEventListener('sis:timegate', (event) => {
      if (event.detail && event.detail.type.indexOf('seat_time_') === 0) {
        window.__seatTimeEvents.push(event.detail);
      }
    });
    const initialize = window.localLmsHarness.initialize();
    const completion = window.localLmsHarness.complete();
    return { completion, initialize };
  });
  await page.waitForTimeout(1_250);
  const observed = await page.evaluate(() => ({
    events: window.__seatTimeEvents,
    lessonStatus:
      window.localLmsHarness.values['cmi.core.lesson_status'],
    outbox: window.localLmsHarness.seatTimeOutbox(),
    outboxWrites: window.localLmsHarness.seatTimeOutboxWrites.length,
    requests: window.localLmsHarness.seatTimeRequests.length,
  }));

  expect(result).toEqual({ completion: 'true', initialize: 'true' });
  expect(observed.lessonStatus).toBe('completed');
  expect(observed.outbox).toBeNull();
  expect(observed.outboxWrites).toBe(1);
  expect(observed.requests).toBe(0);
  expect(observed.events).toEqual([
    expect.objectContaining({
      reason: 'outbox_unavailable',
      type: 'seat_time_delivery_disabled',
    }),
  ]);
  const eventJson = JSON.stringify(observed.events);
  expect(eventJson).not.toContain('LOCAL-SEAT-KEY');
  expect(eventJson).not.toContain('POC-LEARNER-001');
  expect(eventJson).not.toContain('Learner, Synthetic');
});

test('seat-time relay sends only from the tab holding primary ownership', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const primary = await context.newPage();
  const secondary = await context.newPage();
  await openSeatTimeHarness(primary, {
    response: 'manual',
    timegate: 'dual-shared',
  });
  await openSeatTimeHarness(secondary, {
    response: 'manual',
    timegate: 'dual-shared',
  });

  expect(await initializeSeatTime(primary)).toBe('true');
  await waitForSeatTimeRequests(primary);
  expect(await initializeSeatTime(secondary)).toBe('true');
  await secondary.waitForTimeout(1_250);

  expect(
    await primary.evaluate(
      () => window.localLmsHarness.seatTimeRequests.length,
    ),
  ).toBe(1);
  expect(
    await secondary.evaluate(
      () => window.localLmsHarness.seatTimeRequests.length,
    ),
  ).toBe(0);
  await context.close();
});

test('seat-time does not rebind a stored learner scope to a different learner', async ({
  page,
}) => {
  await openSeatTimeHarness(page, {
    response: 'manual',
    timegate: 'dual-shared',
  });
  expect(await initializeSeatTime(page)).toBe('true');
  await page.waitForFunction(
    () =>
      window.localLmsHarness.seatTimeRequests.length === 1 &&
      Boolean(window.localLmsHarness.values['cmi.suspend_data']),
  );
  const learnerA = await page.evaluate(() => {
    const request = window.localLmsHarness.seatTimeRequests[0];
    window.localStorage.setItem(
      '__timegate_harness_suspend_seed',
      window.localLmsHarness.values['cmi.suspend_data'],
    );
    return {
      attemptId: request.payload.attemptId,
      revision: request.payload.revision,
    };
  });

  await openSeatTimeHarness(page, {
    response: 'manual',
    timegate: 'dual-shared',
    extra: 'learner=LEARNER-B&seedSuspend=1',
  });
  expect(await initializeSeatTime(page)).toBe('true');
  await waitForSeatTimeRequests(page);

  const learnerB = await page.evaluate(() => ({
    outbox: window.localLmsHarness.seatTimeOutbox(),
    requests: window.localLmsHarness.seatTimeRequests.map(
      (request) => request.payload,
    ),
  }));
  expect(learnerB.requests).toHaveLength(1);
  expect(learnerB.requests[0].employeeId).toBe('LEARNER-B');
  expect(learnerB.requests[0].attemptId).not.toBe(learnerA.attemptId);
  expect(
    learnerB.outbox.entries.some(
      (entry) =>
        entry.attemptId === learnerA.attemptId &&
        entry.revision >= learnerA.revision,
    ),
  ).toBe(true);
});

test('seat-time persists a confirmed completion timestamp across resume and clears it on reset', async ({
  page,
}) => {
  await openSeatTimeHarness(page, {
    response: 'ok',
    extra: 'resumeCompleted=1',
  });
  expect(await initializeSeatTime(page)).toBe('true');
  await waitForSeatTimeRequests(page);
  expect(
    await page.evaluate(() =>
      window.localLmsHarness.seatTimeRequests.every(
        (request) => request.payload.completionTimestamp === null,
      ),
    ),
  ).toBe(true);

  expect(
    await page.evaluate(() => window.localLmsHarness.complete()),
  ).toBe('true');
  await page.waitForFunction(() =>
    window.localLmsHarness.seatTimeRequests.some(
      (request) =>
        request.payload.completed === true &&
        Boolean(request.payload.completionTimestamp),
    ),
  );
  const initialPayload = await page.evaluate(() =>
    window.localLmsHarness.seatTimeRequests.find(
      (candidate) => candidate.payload.completed === true,
    ).payload,
  );
  const initialPersisted = await readPersistedTimegateState(
    page,
    'POC-LEARNER-001',
  );
  expect(initialPersisted.seatTimeCompletionTimestamp).toBe(
    initialPayload.completionTimestamp,
  );
  expect(
    Number.isNaN(Date.parse(initialPayload.completionTimestamp)),
  ).toBe(false);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.localLmsHarness &&
      window.localLmsHarness.timegateReady &&
      Boolean(document.getElementById('timegate-root')),
  );
  expect(await initializeSeatTime(page)).toBe('true');
  await page.waitForFunction(() =>
    window.localLmsHarness.seatTimeRequests.some(
      (request) => request.payload.completed === true,
    ),
  );
  const resumedTimestamp = await page.evaluate(() =>
    window.localLmsHarness.seatTimeRequests.find(
      (request) => request.payload.completed === true,
    ).payload.completionTimestamp,
  );
  expect(resumedTimestamp).toBe(initialPayload.completionTimestamp);

  expect(
    await page.evaluate(() =>
      window.SCORM_CallLMSSetValue(
        'cmi.core.lesson_status',
        'incomplete',
      ),
    ),
  ).toBe('true');
  await page.waitForFunction(() =>
    window.localLmsHarness.seatTimeRequests.some(
      (request) => request.payload.reason === 'completion-reset',
    ),
  );
  const resetPayload = await page.evaluate(() =>
    window.localLmsHarness.seatTimeRequests.find(
      (candidate) => candidate.payload.reason === 'completion-reset',
    ).payload,
  );
  const resetPersisted = await readPersistedTimegateState(
    page,
    'POC-LEARNER-001',
  );
  expect(resetPayload.completed).toBe(false);
  expect(resetPayload.completionTimestamp).toBeNull();
  expect(resetPersisted.seatTimeCompletionTimestamp).toBeNull();
});

for (const lifecycleCase of [
  { mode: 'max', reason: 'maximum-exit' },
  { mode: 'idle', reason: 'inactivity-exit' },
]) {
  test(`seat-time checkpoints ${lifecycleCase.reason} before forced termination`, async ({
    page,
  }) => {
    await openSeatTimeHarness(page, {
      response: 'manual',
      timegate: lifecycleCase.mode,
    });
    expect(await initializeSeatTime(page)).toBe('true');
    await page.waitForFunction(
      (reason) =>
        window.localLmsHarness.seatTimeOutboxWrites.some(
          (write) => write.entry && write.entry.reason === reason,
        ),
      lifecycleCase.reason,
      { timeout: 8_000 },
    );
    await page.waitForFunction(
      () =>
        window.localLmsHarness.seatTimeOutboxWrites.some(
          (write) => write.entry && write.entry.reason === 'terminated',
        ) && window.localLmsHarness.lifecycle.terminated,
      null,
      { timeout: 8_000 },
    );
    const reasons = await page.evaluate(() =>
      window.localLmsHarness.seatTimeOutboxWrites.map(
        (write) => write.entry && write.entry.reason,
      ),
    );
    expect(reasons).toContain(lifecycleCase.reason);
    expect(reasons).toContain('terminated');
    await expect(page.locator('#timegate-walkback')).toBeVisible();
  });
}

test('seat-time freezes completion and termination metrics while pagehide beacon remains pending', async ({
  page,
}) => {
  await openSeatTimeHarness(page, { response: 'manual' });
  expect(await initializeSeatTime(page)).toBe('true');
  await waitForSeatTimeRequests(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() =>
    window.localLmsHarness.seatTimeOutboxWrites.some(
      (write) => write.entry && write.entry.reason === 'hidden',
    ),
  );
  expect(
    await page.evaluate(() => window.localLmsHarness.complete()),
  ).toBe('true');
  await page.waitForFunction(() => {
    const outbox = window.localLmsHarness.seatTimeOutbox();
    return Boolean(
      outbox &&
      outbox.entries[0] &&
      outbox.entries[0].completed &&
      outbox.entries[0].completionTimestamp,
    );
  });
  expect(
    await page.evaluate(() => window.localLmsHarness.finish()),
  ).toBe('true');
  await page.waitForFunction(() => {
    const outbox = window.localLmsHarness.seatTimeOutbox();
    return Boolean(
      outbox &&
      outbox.entries[0] &&
      outbox.entries[0].reason === 'terminated',
    );
  });
  const terminated = await page.evaluate(
    () => window.localLmsHarness.seatTimeOutbox().entries[0],
  );

  await page.waitForTimeout(1_250);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.waitForFunction(
    () =>
      window.localLmsHarness.seatTimeBeaconAttempts.length === 1 &&
      Boolean(window.localLmsHarness.seatTimeBeaconAttempts[0].payload),
  );
  const pagehide = await page.evaluate(() => ({
    beacon: window.localLmsHarness.seatTimeBeaconAttempts[0].payload,
    outbox: window.localLmsHarness.seatTimeOutbox(),
  }));

  expect(pagehide.beacon.reason).toBe('pagehide');
  expect(pagehide.beacon.attemptId).toBe(terminated.attemptId);
  expect(pagehide.beacon.revision).toBeGreaterThan(terminated.revision);
  expect(pagehide.beacon.completed).toBe(true);
  expect(pagehide.beacon.completionTimestamp).toBe(
    terminated.completionTimestamp,
  );
  expect(pagehide.beacon.activeSeconds).toBe(terminated.activeSeconds);
  expect(pagehide.beacon.totalSeconds).toBe(terminated.totalSeconds);
  expect(pagehide.outbox.entries).toHaveLength(1);
  expect(pagehide.outbox.entries[0].revision).toBe(
    pagehide.beacon.revision,
  );
});

test('seat-time pageshow starts a fresh ownership segment after pagehide', async ({
  page,
}) => {
  await openSeatTimeHarness(page, { response: 'manual' });
  expect(await initializeSeatTime(page)).toBe('true');
  await waitForSeatTimeRequests(page);
  const firstAttempt = await page.evaluate(
    () => window.localLmsHarness.seatTimeRequests[0].payload.attemptId,
  );

  await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pageshow'));
  });
  await page.waitForFunction((attemptId) => {
    const outbox = window.localLmsHarness.seatTimeOutbox();
    return Boolean(
      outbox &&
      outbox.entries.some((entry) => entry.attemptId !== attemptId),
    );
  }, firstAttempt);
  const result = await page.evaluate(() => ({
    attempts: window.localLmsHarness.seatTimeOutbox().entries.map(
      (entry) => entry.attemptId,
    ),
    records: JSON.parse(window.localLmsHarness.seatTimeOutboxRaw()),
  }));
  const attempts = result.attempts;
  expect(attempts).toContain(firstAttempt);
  expect(attempts.some((attemptId) => attemptId !== firstAttempt)).toBe(true);
  expect(result.records).toHaveLength(2);
  expect(new Set(result.records.map((record) => record.key)).size).toBe(2);
});

const supportReportBeginMarker =
  '-----BEGIN TIMEGATE SUPPORT DATA-----';
const supportReportEndMarker = '-----END TIMEGATE SUPPORT DATA-----';

function parseLearnerSupportReport(artifact) {
  const begin = artifact.indexOf(supportReportBeginMarker);
  const end = artifact.indexOf(supportReportEndMarker);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  return JSON.parse(
    artifact.slice(begin + supportReportBeginMarker.length, end).trim(),
  );
}

async function openLearnerSupportHarness(
  page,
  query = 'timegate=delay&min=0&strictScorm=1&telemetry=disabled',
) {
  await page.goto(`${harnessPath}?${query}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() =>
    Boolean(
      window.localLmsHarness &&
      window.localLmsHarness.timegateReady &&
      window.__SIS_TIMEGATE_SUPPORT__ &&
      typeof window.__SIS_TIMEGATE_SUPPORT__.build === 'function' &&
      document.getElementById('timegate-support-button'),
    ),
  );
  expect(
    await page.evaluate(() => window.localLmsHarness.initialize()),
  ).toBe('true');
}

async function buildLearnerSupportReport(page) {
  const artifact = await page.evaluate(() =>
    window.__SIS_TIMEGATE_SUPPORT__.build(),
  );
  expect(typeof artifact).toBe('string');
  expect(artifact).toContain('TIMEGATE SUPPORT REPORT v1');
  const parsed = parseLearnerSupportReport(artifact);
  expect(parsed.schema).toBe('sis.timegate.support-report');
  expect(parsed.schemaVersion).toBe(1);
  expect(parsed.privacyProfile).toBe('learner-support-minimized-v1');
  return { artifact, parsed };
}

test('learner support distinguishes minimum time met from course completion', async ({
  page,
}) => {
  await openLearnerSupportHarness(page);

  const { artifact, parsed } = await buildLearnerSupportReport(page);

  expect(artifact).toContain('Status: Completion has not been confirmed');
  expect(parsed.payload.summary).toMatchObject({
    state: 'minimum_met_course_not_finished',
    completionSafeToClose: false,
    reasonCode: 'COURSE_COMPLETION_NOT_REQUESTED',
  });
  expect(parsed.payload.timing.minimumMet).toBe(true);
  expect(parsed.payload.completion).toMatchObject({
    courseSignalObserved: false,
    deliveryState: 'not_requested',
    pending: false,
  });

  await page.locator('#timegate-support-button').click();
  await expect(page.locator('#timegate-support-dialog')).toBeVisible();
  await expect(page.locator('#timegate-support-title')).toHaveText(
    'Course status',
  );
  await expect(page.locator('#timegate-support-dialog')).toContainText(
    'Minimum time met. Finish any remaining course activities.',
  );
  await expect(page.locator('.timegate-support-timing')).toContainText(
    'Required',
  );
  await expect(page.locator('.timegate-support-lms')).toHaveCount(0);
  await expect(page.locator('.timegate-support-privacy')).toHaveCount(0);
  await expect(page.locator('#timegate-copy-support')).toBeVisible();
});

test('learner controls keep a compact status trigger and no floating audio button', async ({
  page,
}) => {
  await openLearnerSupportHarness(page);

  const trigger = page.locator('#timegate-support-button');
  await expect(trigger).toHaveAttribute(
    'aria-label',
    /Open course status\./,
  );
  await expect(trigger.locator('span')).toHaveText('i');
  await expect(page.locator('.timegate-audio-toggle')).toHaveCount(0);

  const size = await trigger.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const iconBounds = element.firstElementChild.getBoundingClientRect();
    return {
      targetWidth: bounds.width,
      targetHeight: bounds.height,
      iconWidth: iconBounds.width,
      iconHeight: iconBounds.height,
    };
  });
  expect(size).toEqual({
    targetWidth: 44,
    targetHeight: 44,
    iconWidth: 30,
    iconHeight: 30,
  });
});

test('learner support reports a completion held for minimum time', async ({
  page,
}) => {
  await openLearnerSupportHarness(
    page,
    'timegate=delay&min=1&strictScorm=1&telemetry=disabled',
  );
  expect(
    await page.evaluate(() => window.localLmsHarness.complete()),
  ).toBe('true');

  const { parsed } = await buildLearnerSupportReport(page);

  expect(parsed.payload.summary).toMatchObject({
    state: 'completion_held_for_time',
    completionSafeToClose: false,
    reasonCode: 'COMPLETION_HELD_FOR_MINIMUM',
  });
  expect(parsed.payload.completion).toMatchObject({
    courseSignalObserved: true,
    deliveryState: 'held_for_minimum',
    pending: true,
  });
});

test('learner support exposes a retryable LMS commit failure', async ({
  page,
}) => {
  await openLearnerSupportHarness(page);
  await page.evaluate(() => {
    window.localLmsHarness.failure.commit = true;
    window.localLmsHarness.complete();
  });
  await page.waitForFunction(async () => {
    const artifact = await window.__SIS_TIMEGATE_SUPPORT__.build();
    return artifact.includes('LMS_COMMIT_FAILED');
  });

  const { parsed } = await buildLearnerSupportReport(page);

  expect(parsed.payload.summary).toMatchObject({
    state: 'completion_retrying',
    completionSafeToClose: false,
    reasonCode: 'LMS_COMMIT_FAILED',
  });
  expect(parsed.payload.completion).toMatchObject({
    courseSignalObserved: true,
    deliveryState: 'commit_failed',
    lastWriteResult: true,
    lastCommitResult: false,
    pending: true,
  });
  expect(parsed.payload.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'LMS_COMMIT_FAILED',
        active: true,
      }),
    ]),
  );
});

test('learner support report is privacy-minimized and generation is side-effect free', async ({
  page,
}) => {
  const privateLearnerId = 'EMPLOYEE-ID-PRIVATE-9173';
  const privateCourseKey =
    'https://private.example.test/launch?auth=PRIVATE-COURSE-TOKEN';
  const query = new URLSearchParams({
    courseKey: privateCourseKey,
    learner: privateLearnerId,
    min: '0',
    strictScorm: '1',
    telemetry: 'disabled',
    timegate: 'delay',
  });
  await openLearnerSupportHarness(page, query.toString());

  const sideEffects = await page.evaluate(async () => {
    const sentinels = {
      answer: 'PRIVATE-ANSWER-SPRINKLER-7721',
      cookie: 'PRIVATE-COOKIE-5518',
      email: 'private.learner.4187@example.test',
      localStorage: 'PRIVATE-LOCAL-STORAGE-6629',
      name: 'Private Learner Name 2046',
      relayKey: 'PRIVATE-RELAY-KEY-8214',
      sessionStorage: 'PRIVATE-SESSION-STORAGE-3291',
      stack: 'PRIVATE-STACK-TRACE-9916',
      suspendData: 'PRIVATE-SUSPEND-DATA-1807',
      telemetryToken: window.__SIS_OBSERVABILITY_CONFIG__.source.token,
    };
    window.localLmsHarness.values['cmi.core.student_name'] = sentinels.name;
    window.localLmsHarness.values['cmi.core.student_id'] =
      'EMPLOYEE-ID-PRIVATE-9173';
    window.localLmsHarness.values['cmi.suspend_data'] = sentinels.suspendData;
    window.localStorage.setItem('PRIVATE-SUPPORT-KEY', sentinels.localStorage);
    window.sessionStorage.setItem(
      'PRIVATE-SUPPORT-SESSION-KEY',
      sentinels.sessionStorage,
    );
    document.cookie = `private_support=${sentinels.cookie}; SameSite=Lax`;
    window.TIMEGATE_CONFIG.seatTimeRelayKey = sentinels.relayKey;
    window.__privateCourseAnswer = sentinels.answer;
    window.__privateSupportError = {
      message: sentinels.email,
      stack: sentinels.stack,
    };

    const recorder = { beacon: 0, fetch: 0 };
    const nativeFetch = window.fetch;
    window.fetch = function () {
      recorder.fetch += 1;
      return nativeFetch.apply(this, arguments);
    };
    const nativeBeacon = navigator.sendBeacon;
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: function () {
        recorder.beacon += 1;
        return nativeBeacon ? nativeBeacon.apply(this, arguments) : false;
      },
    });

    const callsBefore = window.localLmsHarness.calls.slice();
    const networkBefore = {
      beaconAttempts: window.localLmsHarness.beaconAttempts.length,
      seatTimeBeaconAttempts:
        window.localLmsHarness.seatTimeBeaconAttempts.length,
      seatTimeRequests: window.localLmsHarness.seatTimeRequests.length,
      transportAttempts: window.localLmsHarness.transportAttempts.length,
    };
    const artifact = await window.__SIS_TIMEGATE_SUPPORT__.build();
    return {
      artifact,
      callsAfter: window.localLmsHarness.calls.slice(),
      callsBefore,
      dynamicSentinels: {
        href: window.location.href,
        learnerId: 'EMPLOYEE-ID-PRIVATE-9173',
        name: sentinels.name,
        rawCourseKey:
          'https://private.example.test/launch?auth=PRIVATE-COURSE-TOKEN',
        userAgent: navigator.userAgent,
      },
      networkAfter: {
        beaconAttempts: window.localLmsHarness.beaconAttempts.length,
        seatTimeBeaconAttempts:
          window.localLmsHarness.seatTimeBeaconAttempts.length,
        seatTimeRequests: window.localLmsHarness.seatTimeRequests.length,
        transportAttempts: window.localLmsHarness.transportAttempts.length,
      },
      networkBefore,
      recorder,
      sentinels,
    };
  });

  const parsed = parseLearnerSupportReport(sideEffects.artifact);
  expect(parsed.schema).toBe('sis.timegate.support-report');
  expect(
    new TextEncoder().encode(sideEffects.artifact).byteLength,
  ).toBeLessThanOrEqual(12 * 1024);
  expect(sideEffects.callsAfter).toEqual(sideEffects.callsBefore);
  expect(sideEffects.networkAfter).toEqual(sideEffects.networkBefore);
  expect(sideEffects.recorder).toEqual({ beacon: 0, fetch: 0 });
  for (const sentinel of [
    ...Object.values(sideEffects.sentinels),
    ...Object.values(sideEffects.dynamicSentinels),
  ]) {
    expect(sideEffects.artifact).not.toContain(sentinel);
  }
});

test('learner support confirms clipboard copy and downloads the same report format', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'clipboard', {
      configurable: true,
      get: function () {
        return {
          writeText: function (value) {
            window.__timegateCopiedSupportReport = value;
            return Promise.resolve();
          },
        };
      },
    });
  });
  await openLearnerSupportHarness(page);
  await page.locator('#timegate-support-button').click();

  const dialog = page.locator('#timegate-support-dialog');
  await expect(dialog).toContainText('training@sis.us');
  await expect(page.locator('#timegate-support-code')).toHaveCount(0);

  const copy = page.locator('#timegate-copy-support');
  await copy.click();
  await expect(copy).toHaveText('Copied to clipboard.');
  const copiedArtifact = await page.evaluate(
    () => window.__timegateCopiedSupportReport,
  );
  expect(parseLearnerSupportReport(copiedArtifact).schema).toBe(
    'sis.timegate.support-report',
  );

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#timegate-download-support').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^timegate-support-report-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.txt$/,
  );
  expect(download.suggestedFilename()).not.toContain('TG-');

  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const downloadedArtifact = Buffer.concat(chunks).toString('utf8');
  expect(parseLearnerSupportReport(downloadedArtifact).schema).toBe(
    'sis.timegate.support-report',
  );
  expect(downloadedArtifact).toContain('Support code: TG-');
  await expect(page.locator('#timegate-download-support')).toHaveText(
    'Downloaded',
  );
});

test('learner support reveals selectable text when clipboard access is denied', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'clipboard', {
      configurable: true,
      get: function () {
        return {
          writeText: function (value) {
            window.__timegateClipboardAttempt = value;
            return Promise.reject(
              new DOMException('Clipboard denied for test', 'NotAllowedError'),
            );
          },
        };
      },
    });
  });
  await openLearnerSupportHarness(page);
  await page.locator('#timegate-support-button').click();
  await expect(page.locator('#timegate-support-dialog')).toBeVisible();
  await page.locator('#timegate-copy-support').click();

  const fallback = page.locator('#timegate-support-text');
  await expect(fallback).toBeVisible();
  await expect(fallback).toHaveAttribute('readonly', '');
  const fallbackText = await fallback.inputValue();
  expect(fallbackText).toContain('TIMEGATE SUPPORT REPORT v1');
  expect(parseLearnerSupportReport(fallbackText).schema).toBe(
    'sis.timegate.support-report',
  );
  expect(fallbackText).toBe(
    await page.evaluate(() => window.__timegateClipboardAttempt),
  );
});

test('learner support confirms completion only after readback and finalization', async ({
  page,
}) => {
  await openLearnerSupportHarness(page);
  const result = await page.evaluate(() => {
    const startIndex = window.localLmsHarness.calls.length;
    const completionResult = window.localLmsHarness.complete();
    return {
      calls: window.localLmsHarness.calls.slice(startIndex),
      completionResult,
    };
  });

  const { parsed } = await buildLearnerSupportReport(page);

  expect(result.completionResult).toBe('true');
  expect(parsed.payload.summary).toEqual({
    state: 'completion_confirmed',
    completionSafeToClose: true,
    reasonCode: null,
  });
  expect(parsed.payload.completion).toMatchObject({
    courseSignalObserved: true,
    deliveryState: 'confirmed',
    lastWriteResult: true,
    lastCommitResult: true,
    lastReadbackStatus: 'completed',
    lmsApiAcknowledged: true,
    pending: false,
  });
  expect(parsed.payload.lms.canonicalStatus).toBe('completed');

  const completionWriteIndex = result.calls.findIndex(
    (call) =>
      call[0] === 'LMSSetValue' &&
      call[1] === 'cmi.core.lesson_status' &&
      call[2] === 'completed',
  );
  const completionCommitIndex = result.calls.findIndex(
    (call, index) => index > completionWriteIndex && call[0] === 'LMSCommit',
  );
  const readbackIndex = result.calls.findIndex(
    (call, index) =>
      index > completionCommitIndex &&
      call[0] === 'LMSGetValue' &&
      call[1] === 'cmi.core.lesson_status',
  );
  const sessionTimeIndex = result.calls.findIndex(
    (call, index) =>
      index > readbackIndex &&
      call[0] === 'LMSSetValue' &&
      call[1] === 'cmi.core.session_time',
  );
  const finalCommitIndex = result.calls.findIndex(
    (call, index) => index > sessionTimeIndex && call[0] === 'LMSCommit',
  );

  expect(completionWriteIndex).toBeGreaterThanOrEqual(0);
  expect(completionCommitIndex).toBeGreaterThan(completionWriteIndex);
  expect(readbackIndex).toBeGreaterThan(completionCommitIndex);
  expect(sessionTimeIndex).toBeGreaterThan(readbackIndex);
  expect(finalCommitIndex).toBeGreaterThan(sessionTimeIndex);

  expect(
    await page.evaluate(() => window.localLmsHarness.finish()),
  ).toBe('true');
  const afterTermination = (await buildLearnerSupportReport(page)).parsed;
  expect(afterTermination.payload.summary).toEqual({
    state: 'completion_confirmed',
    completionSafeToClose: true,
    reasonCode: null,
  });
  expect(afterTermination.payload.attempt.tabRole).toBe('primary');
});

test('learner support keeps a committed completion pending when readback is incomplete', async ({
  page,
}) => {
  await openLearnerSupportHarness(page);
  const result = await page.evaluate(() => {
    Object.defineProperty(
      window.localLmsHarness.values,
      'cmi.core.lesson_status',
      {
        configurable: true,
        enumerable: true,
        get: function () {
          return 'incomplete';
        },
        set: function () {},
      },
    );
    const startIndex = window.localLmsHarness.calls.length;
    const completionResult = window.localLmsHarness.complete();
    return {
      calls: window.localLmsHarness.calls.slice(startIndex),
      completionResult,
    };
  });

  const { parsed } = await buildLearnerSupportReport(page);

  expect(result.completionResult).toBe('true');
  expect(parsed.payload.summary).toEqual({
    state: 'completion_retrying',
    completionSafeToClose: false,
    reasonCode: 'COMPLETION_READBACK_UNCONFIRMED',
  });
  expect(parsed.payload.completion).toMatchObject({
    courseSignalObserved: true,
    deliveryState: 'readback_unconfirmed',
    lastWriteResult: true,
    lastCommitResult: true,
    lastReadbackStatus: 'incomplete',
    lmsApiAcknowledged: true,
    pending: true,
  });
  expect(parsed.payload.lms.canonicalStatus).toBe('incomplete');
  expect(parsed.payload.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'COMPLETION_READBACK_UNCONFIRMED',
        active: true,
      }),
    ]),
  );
  expect(
    result.calls.some(
      (call) =>
        call[0] === 'LMSSetValue' &&
        call[1] === 'cmi.core.session_time',
    ),
  ).toBe(false);
});

test('learner support preserves attempt correlation and rotates launch and report identifiers on resume', async ({
  page,
}) => {
  const query =
    'timegate=delay&min=0&strictScorm=1&telemetry=disabled&storage=dual' +
    '&courseKey=support-resume-identifiers';
  await openLearnerSupportHarness(page, query);
  const first = (await buildLearnerSupportReport(page)).parsed.payload;
  const sameLaunch = (await buildLearnerSupportReport(page)).parsed.payload;

  expect(first.attempt.entryMode).toBe('fresh');
  expect(sameLaunch.attempt.attemptId).toBe(first.attempt.attemptId);
  expect(sameLaunch.attempt.launchId).toBe(first.attempt.launchId);
  expect(sameLaunch.report.supportCode).toBe(first.report.supportCode);
  expect(sameLaunch.report.reportId).not.toBe(first.report.reportId);

  await openLearnerSupportHarness(page, query);
  const resumed = (await buildLearnerSupportReport(page)).parsed.payload;

  expect(resumed.attempt.entryMode).toBe('resume');
  expect(resumed.attempt.resumeSource).toMatch(
    /^(?:lms_suspend_data|local_backup)$/,
  );
  expect(resumed.attempt.attemptId).toBe(first.attempt.attemptId);
  expect(resumed.report.supportCode).toBe(first.report.supportCode);
  expect(resumed.attempt.launchId).not.toBe(first.attempt.launchId);
  expect(resumed.report.reportId).not.toBe(sameLaunch.report.reportId);
});

test('learner support review preserves a gated completion beside near-limit authored suspend data', async ({
  page,
}) => {
  await openLearnerSupportHarness(
    page,
    'timegate=delay&min=1&strictScorm=1&telemetry=disabled&storage=dual',
  );

  const result = await page.evaluate(() => {
    const initialContainer = JSON.parse(
      window.localLmsHarness.values['cmi.suspend_data'],
    );
    const stateWithoutOptionalSupport = {
      ...initialContainer.__timegate_v2,
    };
    delete stateWithoutOptionalSupport.supportAttemptId;
    delete stateWithoutOptionalSupport.supportCompletion;
    const boundaryTemplate = JSON.stringify({
      authoredData: '',
      __timegate_v2: stateWithoutOptionalSupport,
    });
    const authoredDataLength = 3_500 - boundaryTemplate.length;
    const authoredContainer = {
      authoredData: 'a'.repeat(authoredDataLength),
    };
    const authoredRaw = JSON.stringify(authoredContainer);
    window.localLmsHarness.values['cmi.suspend_data'] = authoredRaw;

    const completionResult = window.localLmsHarness.complete();
    const persistedRaw = window.localLmsHarness.values['cmi.suspend_data'];
    const persistedContainer = JSON.parse(persistedRaw);
    const localState = Object.keys(window.localStorage)
      .filter((key) =>
        key.startsWith(
          'timegate-v2.v1.observability-browser-delay.POC-LEARNER-001',
        ),
      )
      .map((key) => JSON.parse(window.localStorage.getItem(key)))
      .find(Boolean);
    const uncompressedContainer = {
      ...persistedContainer,
      __timegate_v2: localState,
    };
    return {
      authoredDataLength,
      authoredRawLength: authoredRaw.length,
      completionResult,
      localState,
      persistedContainer,
      persistedRawLength: persistedRaw.length,
      uncompressedLength: JSON.stringify(uncompressedContainer).length,
    };
  });

  expect(result.authoredDataLength).toBeGreaterThan(0);
  expect(result.authoredRawLength).toBeLessThan(3_800);
  expect(result.completionResult).toBe('true');
  expect(result.persistedRawLength).toBeLessThanOrEqual(3_800);
  expect(result.persistedContainer.authoredData).toHaveLength(
    result.authoredDataLength,
  );
  expect(result.persistedContainer.__timegate_v2).toMatchObject({
    courseCompletePending: true,
    courseCompleteSent: false,
    pendingScorm: {
      'cmi.core.lesson_status': 'completed',
    },
  });
  expect(result.localState).toHaveProperty('supportAttemptId');
  expect(result.localState).toHaveProperty('supportCompletion');
  expect(result.uncompressedLength).toBeGreaterThan(3_800);

  const { parsed } = await buildLearnerSupportReport(page);
  expect(parsed.payload.summary.state).toBe('completion_held_for_time');
  expect(parsed.payload.completion).toMatchObject({
    courseSignalObserved: true,
    pending: true,
    pendingDurableInLms: true,
  });
});

test('authored Rise suspend-data updates retain Timegate state below the shared limit', async ({
  page,
}) => {
  await openLearnerSupportHarness(
    page,
    'timegate=delay&min=1&strictScorm=1&telemetry=disabled&storage=dual' +
      '&courseKey=rise-authored-overwrite',
  );

  const result = await page.evaluate(() => {
    const lms = window.localLmsHarness;
    const before = JSON.parse(lms.values['cmi.suspend_data']);
    const writes = [];
    for (const length of [1_700, 2_500]) {
      const authored = JSON.stringify({
        v: 3,
        d: 'r'.repeat(length),
      });
      const result = window.SCORM_CallLMSSetValue(
        'cmi.suspend_data',
        authored,
      );
      writes.push({
        result,
        persisted: JSON.parse(lms.values['cmi.suspend_data']),
      });
    }
    return { before, writes };
  });

  expect(result.before.__timegate_v2).toMatchObject({
    courseKey: 'rise-authored-overwrite',
    learnerKey: 'POC-LEARNER-001',
  });
  for (const [index, length] of [1_700, 2_500].entries()) {
    const write = result.writes[index];
    expect(write.result).toBe('true');
    expect(write.persisted.v).toBe(3);
    expect(write.persisted.d).toHaveLength(length);
    expect(write.persisted.__timegate_v2).toMatchObject({
      courseKey: 'rise-authored-overwrite',
      learnerKey: 'POC-LEARNER-001',
      persistenceRevision:
        result.before.__timegate_v2.persistenceRevision,
    });
  }
});

test('strict localStorage mode does not fall back to suspend_data when browser storage is unavailable', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: function () {
        throw new DOMException(
          'Synthetic browser storage denial',
          'SecurityError',
        );
      },
    });
  });
  await openLearnerSupportHarness(
    page,
    'timegate=delay&min=0&strictScorm=1&telemetry=disabled' +
      '&storage=localStorage&courseKey=local-only-storage-denied',
  );

  const result = await page.evaluate(() => {
    const lms = window.localLmsHarness;
    const authored = JSON.stringify({ v: 3, d: 'RISE-STATE-MUST-SURVIVE' });
    lms.values['cmi.suspend_data'] = authored;
    const callIndex = lms.calls.length;
    const completionResult = lms.complete();
    return {
      authored,
      completionResult,
      persisted: lms.values['cmi.suspend_data'],
      suspendWrites: lms.calls.slice(callIndex).filter((call) =>
        call[0] === 'LMSSetValue' && call[1] === 'cmi.suspend_data',
      ),
    };
  });
  const report = (await buildLearnerSupportReport(page)).parsed.payload;

  expect(result.completionResult).toBe('true');
  expect(result.persisted).toBe(result.authored);
  expect(result.suspendWrites).toEqual([]);
  expect(report.persistence).toMatchObject({
    mode: 'localStorage',
    lmsState: 'not_applicable',
  });
  expect(['failed', 'unavailable']).toContain(
    report.persistence.browserState,
  );
  expect(report.summary).toMatchObject({
    state: 'completion_retrying',
    completionSafeToClose: false,
    reasonCode: 'LMS_FINALIZATION_FAILED',
  });
  expect(report.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: 'LMS_FINALIZATION_FAILED',
      active: true,
    }),
  ]));
});

test('package local-only hint passes an early Rise suspend-data write through exactly', async ({
  page,
}) => {
  const query =
    'timegate=delay&strictScorm=1&telemetry=disabled' +
    '&storage=localStorage&timegateConfig=external-delayed' +
    '&entry=resume&bootstrapSuspend=1&earlySuspendWrite=1' +
    '&courseKey=local-only-bootstrap';
  await page.goto(`${harnessPath}?${query}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() => Boolean(
    window.localLmsHarness &&
    window.localLmsHarness.bootstrapSuspendWrite,
  ));

  const result = await page.evaluate(() =>
    window.localLmsHarness.bootstrapSuspendWrite,
  );

  expect(result.supportReadyBeforeWrite).toBe(false);
  expect(result.result).toBe('true');
  expect(result.persisted).toBe(result.authored);
  expect(JSON.parse(result.persisted)).toEqual({
    v: 3,
    d: 'NEW-RISE-STATE',
  });
  expect(result.calls.filter((call) =>
    call[0] === 'LMSSetValue' && call[1] === 'cmi.suspend_data',
  )).toEqual([
    ['LMSSetValue', 'cmi.suspend_data', result.authored],
  ]);
});

test('localStorage mode completes and finalizes without Timegate suspend-data writes', async ({
  page,
}) => {
  await openLearnerSupportHarness(
    page,
    'timegate=delay&min=0&strictScorm=1&telemetry=disabled' +
      '&storage=localStorage&courseKey=local-only-finalization',
  );

  const result = await page.evaluate(() => {
    const lms = window.localLmsHarness;
    const callIndex = lms.calls.length;
    const completionResult = lms.complete();
    const localKey = Object.keys(window.localStorage).find((key) =>
      key.startsWith('timegate-v2.v1.local-only-finalization.'),
    );
    return {
      completionResult,
      localState: localKey ?
        JSON.parse(window.localStorage.getItem(localKey)) : null,
      suspendWrites: lms.calls.slice(callIndex).filter((call) =>
        call[0] === 'LMSSetValue' && call[1] === 'cmi.suspend_data',
      ),
    };
  });
  const report = (await buildLearnerSupportReport(page)).parsed.payload;

  expect(result.completionResult).toBe('true');
  expect(result.suspendWrites).toEqual([]);
  expect(result.localState).toMatchObject({
    courseKey: 'local-only-finalization',
    learnerKey: 'POC-LEARNER-001',
    courseCompleteSent: true,
    courseCompletePending: false,
    pendingScorm: null,
  });
  expect(report.persistence).toMatchObject({
    mode: 'localStorage',
    browserState: 'written',
    lmsState: 'not_applicable',
  });
  expect(report.summary).toEqual({
    state: 'completion_confirmed',
    completionSafeToClose: true,
    reasonCode: null,
  });
});

test('authored empty suspend-data reset passes through exactly', async ({
  page,
}) => {
  await openLearnerSupportHarness(
    page,
    'timegate=delay&min=1&strictScorm=1&telemetry=disabled&storage=dual' +
      '&courseKey=rise-empty-reset',
  );

  const result = await page.evaluate(() => {
    const lms = window.localLmsHarness;
    const authored = JSON.stringify({ v: 3, d: 'r'.repeat(500) });
    const authoredResult = window.SCORM_CallLMSSetValue(
      'cmi.suspend_data',
      authored,
    );
    const beforeReset = lms.values['cmi.suspend_data'];
    const callIndex = lms.calls.length;
    const resetResult = window.SCORM_CallLMSSetValue('cmi.suspend_data', '');
    return {
      authoredResult,
      beforeReset,
      lmsRawAfterReset: lms.values['cmi.suspend_data'],
      resetResult,
      suspendWrites: lms.calls.slice(callIndex).filter((call) =>
        call[0] === 'LMSSetValue' && call[1] === 'cmi.suspend_data',
      ).map((call) => call[2]),
    };
  });

  expect(result.authoredResult).toBe('true');
  expect(JSON.parse(result.beforeReset)).toMatchObject({
    v: 3,
    __timegate_v2: {
      courseKey: 'rise-empty-reset',
      learnerKey: 'POC-LEARNER-001',
    },
  });
  expect(result.resetResult).toBe('true');
  expect(result.suspendWrites).toEqual(['']);
  expect(result.lmsRawAfterReset).toBe('');
});

test('failed LMS suspend-data read does not overwrite the stored Rise value', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let api;
    window.__failSuspendRead = false;
    window.__failedSuspendReads = 0;
    Object.defineProperty(window, 'API', {
      configurable: true,
      get() { return api; },
      set(value) {
        const originalGetValue = value.LMSGetValue;
        value.LMSGetValue = function (element) {
          if (element === 'cmi.suspend_data' && window.__failSuspendRead) {
            window.__failedSuspendReads += 1;
            window.intSCORMError = '301';
            return '';
          }
          return originalGetValue.apply(this, arguments);
        };
        api = value;
      },
    });
  });
  await openLearnerSupportHarness(
    page,
    'timegate=delay&min=1&strictScorm=1&telemetry=disabled&storage=dual' +
      '&courseKey=rise-read-failure',
  );

  const result = await page.evaluate(() => {
    const lms = window.localLmsHarness;
    const authored = JSON.stringify({ v: 3, d: 'r'.repeat(500) });
    const authoredResult = window.SCORM_CallLMSSetValue(
      'cmi.suspend_data',
      authored,
    );
    const storedRaw = lms.values['cmi.suspend_data'];
    const callIndex = lms.calls.length;
    window.__failSuspendRead = true;
    const completionResult = lms.complete();
    const localKey = Object.keys(window.localStorage).find((key) =>
      key.startsWith('timegate-v2.v1.rise-read-failure.'),
    );
    return {
      authoredResult,
      completionResult,
      failedSuspendReads: window.__failedSuspendReads,
      lmsUnchanged: lms.values['cmi.suspend_data'] === storedRaw,
      localState: localKey ?
        JSON.parse(window.localStorage.getItem(localKey)) : null,
      suspendWrites: lms.calls.slice(callIndex).filter((call) =>
        call[0] === 'LMSSetValue' && call[1] === 'cmi.suspend_data',
      ).length,
    };
  });
  const report = (await buildLearnerSupportReport(page)).parsed.payload;

  expect(result.authoredResult).toBe('true');
  expect(result.completionResult).toBe('false');
  expect(result.failedSuspendReads).toBeGreaterThan(0);
  expect(result.lmsUnchanged).toBe(true);
  expect(result.suspendWrites).toBe(0);
  expect(result.localState).toMatchObject({
    courseCompletePending: true,
    pendingScorm: { 'cmi.core.lesson_status': 'completed' },
  });
  expect(report.persistence).toMatchObject({
    browserState: 'written',
    lmsState: 'failed',
    lmsFailureReason: 'read_failed',
    lmsErrorCode: '301',
  });
});

for (const lastErrorMode of ['missing', 'throws']) {
  test(`unconfirmed empty LMS suspend-data read with ${lastErrorMode} GetLastError preserves Rise data`, async ({
    page,
  }) => {
    await page.addInitScript(({ mode }) => {
      let api;
      window.__failSuspendRead = false;
      window.__failedSuspendReads = 0;
      Object.defineProperty(window, 'API', {
        configurable: true,
        get() { return api; },
        set(value) {
          const originalGetValue = value.LMSGetValue;
          value.LMSGetValue = function (element) {
            if (element === 'cmi.suspend_data' && window.__failSuspendRead) {
              window.__failedSuspendReads += 1;
              window.intSCORMError = '0';
              return '';
            }
            return originalGetValue.apply(this, arguments);
          };
          if (mode === 'missing') {
            delete value.LMSGetLastError;
          } else {
            value.LMSGetLastError = function () {
              throw new Error('synthetic LMSGetLastError failure');
            };
          }
          api = value;
        },
      });
    }, { mode: lastErrorMode });
    await openLearnerSupportHarness(
      page,
      'timegate=delay&min=1&strictScorm=1&telemetry=disabled&storage=dual' +
        `&courseKey=rise-unconfirmed-read-${lastErrorMode}`,
    );

    const result = await page.evaluate((mode) => {
      const lms = window.localLmsHarness;
      const storedRaw = JSON.stringify({ v: 3, d: 'r'.repeat(500) });
      lms.values['cmi.suspend_data'] = storedRaw;
      const callIndex = lms.calls.length;
      window.__failSuspendRead = true;
      const completionResult = lms.complete();
      const localKey = Object.keys(window.localStorage).find((key) =>
        key.startsWith(`timegate-v2.v1.rise-unconfirmed-read-${mode}.`),
      );
      return {
        completionResult,
        failedSuspendReads: window.__failedSuspendReads,
        lmsUnchanged: lms.values['cmi.suspend_data'] === storedRaw,
        localState: localKey ?
          JSON.parse(window.localStorage.getItem(localKey)) : null,
        suspendWrites: lms.calls.slice(callIndex).filter((call) =>
          call[0] === 'LMSSetValue' && call[1] === 'cmi.suspend_data',
        ).length,
      };
    }, lastErrorMode);
    const report = (await buildLearnerSupportReport(page)).parsed.payload;

    expect(result.completionResult).toBe('false');
    expect(result.failedSuspendReads).toBeGreaterThan(0);
    expect(result.lmsUnchanged).toBe(true);
    expect(result.suspendWrites).toBe(0);
    expect(result.localState).toMatchObject({
      courseCompletePending: true,
      pendingScorm: { 'cmi.core.lesson_status': 'completed' },
    });
    expect(report.persistence).toMatchObject({
      browserState: 'written',
      lmsState: 'failed',
      lmsFailureReason: 'read_failed',
      lmsErrorCode: null,
    });
  });
}

test('LMS rejection of merged suspend data preserves the exact Rise save and Timegate browser backup', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let api;
    window.__rejectedMergedSuspendWrites = 0;
    Object.defineProperty(window, 'API', {
      configurable: true,
      get() { return api; },
      set(value) {
        const originalSetValue = value.LMSSetValue;
        value.LMSSetValue = function (element, raw) {
          if (element === 'cmi.suspend_data') {
            let parsed;
            try {
              parsed = JSON.parse(raw);
            } catch (error) {
              parsed = null;
            }
            if (parsed && parsed.v === 3 && parsed.__timegate_v2) {
              window.__rejectedMergedSuspendWrites += 1;
              window.intSCORMError = '351';
              return 'false';
            }
          }
          return originalSetValue.apply(this, arguments);
        };
        api = value;
      },
    });
  });
  await openLearnerSupportHarness(
    page,
    'timegate=delay&min=1&strictScorm=1&telemetry=disabled&storage=dual' +
      '&courseKey=rise-merge-rejection',
  );
  const before = (await buildLearnerSupportReport(page)).parsed.payload;
  expect(before.persistence.lmsState).toBe('written');

  const result = await page.evaluate(() => {
    const authored = JSON.stringify({ v: 3, d: 'r'.repeat(1_700) });
    const writeResult = window.SCORM_CallLMSSetValue(
      'cmi.suspend_data',
      authored,
    );
    const localKey = Object.keys(window.localStorage).find((key) =>
      key.startsWith('timegate-v2.v1.rise-merge-rejection.'),
    );
    return {
      authoredSavedExactly:
        window.localLmsHarness.values['cmi.suspend_data'] === authored,
      localState: localKey ?
        JSON.parse(window.localStorage.getItem(localKey)) : null,
      rejectedMergedWrites: window.__rejectedMergedSuspendWrites,
      writeResult,
    };
  });
  const report = (await buildLearnerSupportReport(page)).parsed.payload;

  expect(result.writeResult).toBe('true');
  expect(result.authoredSavedExactly).toBe(true);
  expect(result.rejectedMergedWrites).toBeGreaterThan(0);
  expect(result.localState).toMatchObject({
    courseKey: 'rise-merge-rejection',
    learnerKey: 'POC-LEARNER-001',
  });
  expect(result.localState.persistenceRevision).toBeGreaterThan(
    before.persistence.revision,
  );
  expect(report.persistence).toMatchObject({
    browserState: 'written',
    lmsState: 'failed',
    lmsFailureReason: 'set_value_failed',
    lmsErrorCode: '351',
    lastSuccessAt: before.persistence.lastSuccessAt,
  });
  expect(report.summary.completionSafeToClose).toBe(false);
});

test('growing authored suspend data leaves a failed Timegate save in the browser backup for resume', async ({
  page,
}) => {
  const query =
    'timegate=delay&min=1&strictScorm=1&telemetry=disabled&storage=dual' +
    '&courseKey=suspend-growth-capacity';
  await openLearnerSupportHarness(page, query);
  const before = (await buildLearnerSupportReport(page)).parsed.payload;
  expect(before.persistence.lmsState).toBe('written');

  const attempted = await page.evaluate(() => {
    const lms = window.localLmsHarness;
    const container = JSON.parse(lms.values['cmi.suspend_data']);
    delete container.__timegate_v2.supportAttemptId;
    const withEmptyAuthoredData = JSON.stringify({
      ...container,
      v: 3,
      d: '',
    });
    container.v = 3;
    container.d = 'PRIVATE-RISE-RESUME-DATA-'.repeat(
      Math.ceil((3_780 - withEmptyAuthoredData.length) / 25),
    ).slice(0, 3_780 - withEmptyAuthoredData.length);
    const authoredRaw = JSON.stringify(container);
    lms.values['cmi.suspend_data'] = authoredRaw;
    window.localStorage.setItem(
      '__timegate_harness_suspend_seed',
      authoredRaw,
    );
    const callIndex = lms.calls.length;
    const completionResult = lms.complete();
    const localKey = Object.keys(window.localStorage).find((key) =>
      key.startsWith('timegate-v2.v1.suspend-growth-capacity.'),
    );
    return {
      authoredLength: authoredRaw.length,
      completionResult,
      localState: localKey ?
        JSON.parse(window.localStorage.getItem(localKey)) : null,
      lmsUnchanged: lms.values['cmi.suspend_data'] === authoredRaw,
      suspendWriteCalls: lms.calls.slice(callIndex).filter((call) =>
        call[0] === 'LMSSetValue' && call[1] === 'cmi.suspend_data',
      ).length,
    };
  });
  const failed = (await buildLearnerSupportReport(page)).parsed.payload;

  expect(attempted.authoredLength).toBe(3_780);
  expect(attempted.completionResult).toBe('false');
  expect(attempted.lmsUnchanged).toBe(true);
  expect(attempted.suspendWriteCalls).toBe(0);
  expect(attempted.localState).toMatchObject({
    courseCompletePending: true,
    courseCompleteSent: false,
    pendingScorm: { 'cmi.core.lesson_status': 'completed' },
  });
  expect(failed.persistence).toMatchObject({
    browserState: 'written',
    lmsState: 'failed',
    lmsFailureReason: 'payload_too_large',
    lmsExistingChars: 3_780,
    lastSuccessAt: before.persistence.lastSuccessAt,
  });
  expect(failed.persistence.lmsAttemptedChars).toBeGreaterThan(3_800);
  expect(failed.persistence.lmsErrorCode).toBeNull();
  expect(failed.completion).toMatchObject({
    pending: true,
    pendingDurableInLms: false,
  });
  expect(failed.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: 'TIMEGATE_STATE_SAVE_FAILED',
      active: true,
    }),
  ]));
  expect(JSON.stringify(failed)).not.toContain('PRIVATE-RISE-RESUME-DATA');

  await openLearnerSupportHarness(page, `${query}&seedSuspend=1`);
  const resumed = (await buildLearnerSupportReport(page)).parsed.payload;
  expect(resumed.attempt.entryMode).toBe('resume');
  expect(resumed.attempt.resumeSource).toBe('local_backup');
  expect(resumed.completion.pending).toBe(true);
  expect(resumed.summary.completionSafeToClose).toBe(false);
});

test('learner support review exposes a working copy action on every terminal walkback', async ({
  browser,
}) => {
  const cases = [
    {
      name: 'configuration',
      query: 'timegate=missing-floor&strictScorm=1&telemetry=disabled',
    },
    {
      name: 'maximum',
      query: 'timegate=max&strictScorm=1&telemetry=disabled',
    },
    {
      name: 'inactivity',
      query:
        'timegate=idle&strictScorm=1&telemetry=disabled' +
        '&idleExit=0.03&idleWarning=0.5',
    },
  ];

  for (const terminalCase of cases) {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'clipboard', {
        configurable: true,
        get: function () {
          return {
            writeText: function (value) {
              window.__walkbackSupportCopy = value;
              return Promise.resolve();
            },
          };
        },
      });
    });
    const terminalPage = await context.newPage();
    await terminalPage.goto(`${harnessPath}?${terminalCase.query}`, {
      waitUntil: 'domcontentloaded',
    });
    await terminalPage.waitForFunction(() =>
      Boolean(
        window.localLmsHarness &&
        window.localLmsHarness.timegateReady &&
        window.__SIS_TIMEGATE_SUPPORT__,
      ),
    );
    expect(
      await terminalPage.evaluate(() =>
        window.localLmsHarness.initialize(),
      ),
    ).toBe('true');

    const walkback = terminalPage.locator('#timegate-walkback');
    await expect(walkback, terminalCase.name).toBeVisible({ timeout: 7_000 });
    const copyAction = walkback.getByRole('button', {
      name: 'Copy support report',
    });
    await expect(copyAction, terminalCase.name).toBeVisible();
    await copyAction.click();
    await terminalPage.waitForFunction(() =>
      Boolean(window.__walkbackSupportCopy),
    );
    const artifact = await terminalPage.evaluate(
      () => window.__walkbackSupportCopy,
    );
    expect(artifact).toContain('TIMEGATE SUPPORT REPORT v1');
    expect(parseLearnerSupportReport(artifact).schema).toBe(
      'sis.timegate.support-report',
    );
    await context.close();
  }
});

test('learner support review rejects a stale mismatched terminal readback', async ({
  page,
}) => {
  await openLearnerSupportHarness(page);
  const result = await page.evaluate(() => {
    Object.defineProperty(
      window.localLmsHarness.values,
      'cmi.core.lesson_status',
      {
        configurable: true,
        enumerable: true,
        get: function () {
          return 'failed';
        },
        set: function () {},
      },
    );
    const startIndex = window.localLmsHarness.calls.length;
    const completionResult = window.SCORM_CallLMSSetValue(
      'cmi.core.lesson_status',
      'passed',
    );
    return {
      calls: window.localLmsHarness.calls.slice(startIndex),
      completionResult,
    };
  });

  const { parsed } = await buildLearnerSupportReport(page);

  expect(result.completionResult).toBe('true');
  expect(parsed.payload.summary).toEqual({
    state: 'completion_retrying',
    completionSafeToClose: false,
    reasonCode: 'COMPLETION_READBACK_UNCONFIRMED',
  });
  expect(parsed.payload.completion).toMatchObject({
    courseSignalObserved: true,
    requestedStatus: 'passed',
    deliveryState: 'readback_unconfirmed',
    lastWriteResult: true,
    lastCommitResult: true,
    lastReadbackStatus: 'failed',
    pending: true,
  });
  expect(parsed.payload.lms.canonicalStatus).toBe('failed');
  expect(
    result.calls.some(
      (call) =>
        call[0] === 'LMSSetValue' &&
        call[1] === 'cmi.core.session_time',
    ),
  ).toBe(false);
});

test('learner support review ignores a stale completion queue on a fresh attempt', async ({
  page,
}) => {
  const courseKey = 'support-fresh-no-hydrate';
  const learnerKey = 'FRESH-SUPPORT-LEARNER';
  const staleAttemptId = '11111111-1111-4111-8111-111111111111';
  await page.goto(harnessPath, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ course, learner, staleAttempt }) => {
    window.localStorage.setItem(
      '__timegate_harness_suspend_seed',
      JSON.stringify({
        authoredData: 'preserve-this-authored-state',
        __timegate_v2: {
          version: 1,
          persistenceRevision: 27,
          courseKey: course,
          learnerKey: learner,
          elapsedSeconds: 600,
          minRequiredSeconds: 60,
          minMetAt: '2026-09-14T18:00:00.000Z',
          lastTickTs: Date.now(),
          courseCompleteSent: false,
          courseCompletePending: true,
          pendingScorm: {
            'cmi.core.lesson_status': 'completed',
          },
          supportAttemptId: staleAttempt,
          supportCompletion: {
            courseSignalObserved: true,
            signalSource: 'scorm_set_value',
            requestedStatus: 'completed',
            firstRequestedAt: '2026-09-14T18:01:00.000Z',
            lastRequestedAt: '2026-09-14T18:02:00.000Z',
            deliveryState: 'commit_failed',
            deliveryAttemptCount: 3,
            lastWriteResult: true,
            lastCommitResult: false,
            lastReadbackStatus: 'incomplete',
            lmsApiAcknowledged: false,
            pendingDurableInLms: true,
            terminationDeferred: false,
            lastTerminationResult: null,
            finalizationSucceeded: false,
          },
        },
      }),
    );
  }, {
    course: courseKey,
    learner: learnerKey,
    staleAttempt: staleAttemptId,
  });

  const query = new URLSearchParams({
    courseKey,
    learner: learnerKey,
    min: '1',
    seedSuspend: '1',
    storage: 'dual',
    strictScorm: '1',
    telemetry: 'disabled',
    timegate: 'delay',
  });
  await openLearnerSupportHarness(page, query.toString());
  await page.waitForTimeout(1_100);
  const { parsed } = await buildLearnerSupportReport(page);

  expect(parsed.payload.attempt).toMatchObject({
    entryMode: 'fresh',
    resumeSource: 'none',
  });
  expect(parsed.payload.attempt.attemptId).not.toBe(staleAttemptId);
  expect(parsed.payload.timing).toMatchObject({
    cumulativeActiveSeconds: 0,
    minimumMet: false,
  });
  expect(parsed.payload.completion).toMatchObject({
    courseSignalObserved: false,
    deliveryState: 'not_requested',
    pending: false,
  });
  expect(
    await page.evaluate(() =>
      window.localLmsHarness.calls.some(
        (call) =>
          call[0] === 'LMSSetValue' &&
          call[1] === 'cmi.core.lesson_status' &&
          call[2] === 'completed',
      ),
    ),
  ).toBe(false);
});

test('learner support observability enrichment is bounded and never changes completion safety', async ({
  browser,
}) => {
  async function reportForTelemetryMode(mode) {
    const context = await browser.newContext();
    const telemetryPage = await context.newPage();
    await openLearnerSupportHarness(
      telemetryPage,
      `timegate=delay&min=0&strictScorm=1&telemetry=${mode}`,
    );
    expect(
      await telemetryPage.evaluate(() => window.localLmsHarness.complete()),
    ).toBe('true');
    await telemetryPage.evaluate(() => window.__SIS_OBSERVABILITY__.flush());
    const expectedDelivery = mode === 'offline' ? 'failed' : 'succeeded';
    await telemetryPage.waitForFunction(
      (expected) =>
        window.__SIS_OBSERVABILITY__.publicSupportSnapshot().delivery.state ===
        expected,
      expectedDelivery,
    );
    const artifact = await telemetryPage.evaluate(() =>
      window.__SIS_TIMEGATE_SUPPORT__.build(),
    );
    const publicProjection = await telemetryPage.evaluate(() =>
      window.__SIS_OBSERVABILITY__.publicSupportSnapshot(),
    );
    await context.close();
    return {
      artifact,
      payload: parseLearnerSupportReport(artifact).payload,
      publicProjection,
    };
  }

  const failed = await reportForTelemetryMode('offline');
  expect(failed.payload.summary).toEqual({
    state: 'completion_confirmed',
    completionSafeToClose: true,
    reasonCode: null,
  });
  expect(failed.payload.attempt).toMatchObject({
    priorDeviceDiagnostics: 'unavailable',
    observabilitySessionId: expect.any(String),
  });
  expect(failed.payload.observability).toEqual({
    enabled: true,
    deliveryState: 'failed',
    revision: expect.any(Number),
  });
  expect(Number.isInteger(failed.payload.observability.revision)).toBe(true);
  expect(failed.payload.observability.revision).toBeGreaterThanOrEqual(0);
  expect(failed.payload.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'OBSERVABILITY_DELIVERY_FAILED',
        active: true,
      }),
    ]),
  );
  expect(failed.publicProjection.delivery.state).toBe('failed');

  const succeeded = await reportForTelemetryMode('ok');
  expect(succeeded.payload.summary).toEqual({
    state: 'completion_confirmed',
    completionSafeToClose: true,
    reasonCode: null,
  });
  expect(succeeded.payload.attempt).toMatchObject({
    priorDeviceDiagnostics: 'available_via_observability',
    observabilitySessionId: expect.any(String),
  });
  expect(succeeded.payload.observability).toEqual({
    enabled: true,
    deliveryState: 'succeeded',
    revision: expect.any(Number),
  });
  expect(succeeded.payload.issues).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'OBSERVABILITY_DELIVERY_FAILED' }),
    ]),
  );

  for (const artifact of [failed.artifact, succeeded.artifact]) {
    expect(new TextEncoder().encode(artifact).byteLength).toBeLessThanOrEqual(
      12 * 1024,
    );
    expect(artifact).not.toContain('local-pilot-token');
    expect(artifact).not.toContain('POC-LEARNER-001');
    expect(artifact).not.toMatch(/http:\/\/127\.0\.0\.1:\d+\/telemetry/);
  }
});

test('learner support final review accepts only numeric SCORM error codes', async ({
  page,
}) => {
  await openLearnerSupportHarness(page);
  const privateErrorCode = 'PRIVATE_LMS_ERROR_CODE_4821';
  await page.evaluate((sentinel) => {
    Object.defineProperty(window, 'intSCORMError', {
      configurable: true,
      get: function () {
        return sentinel;
      },
      set: function () {},
    });
    window.localLmsHarness.failure.commit = true;
    window.localLmsHarness.complete();
  }, privateErrorCode);

  const { artifact, parsed } = await buildLearnerSupportReport(page);

  expect(parsed.payload.summary.reasonCode).toBe('LMS_COMMIT_FAILED');
  expect(parsed.payload.lms.lastErrorCode).toBeNull();
  expect(artifact).not.toContain(privateErrorCode);
  for (const event of parsed.payload.timeline) {
    if (event.errorCode !== undefined) {
      expect(event.errorCode).toMatch(/^\d+$/);
    }
  }
});

test('learner support final review ignores stale clipboard rejection after close and pagehide', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const controls = [];
    window.__timegateDeferredClipboard = controls;
    window.__rejectTimegateClipboard = function () {
      const control = controls.find((candidate) => !candidate.settled);
      if (!control) return false;
      control.settled = true;
      control.reject(
        new DOMException('Synthetic clipboard denial', 'NotAllowedError'),
      );
      return true;
    };
    Object.defineProperty(Navigator.prototype, 'clipboard', {
      configurable: true,
      get: function () {
        return {
          writeText: function (value) {
            return new Promise(function (resolve, reject) {
              controls.push({
                value,
                resolve,
                reject,
                settled: false,
              });
            });
          },
        };
      },
    });
  });
  await openLearnerSupportHarness(page);

  async function beginDeferredCopy() {
    await page.locator('#timegate-support-button').click();
    await expect(page.locator('#timegate-support-dialog')).toBeVisible();
    const priorCount = await page.evaluate(
      () => window.__timegateDeferredClipboard.length,
    );
    await page.locator('#timegate-copy-support').click();
    await page.waitForFunction(
      (count) => window.__timegateDeferredClipboard.length > count,
      priorCount,
    );
  }

  await beginDeferredCopy();
  await page.getByRole('button', {
    name: 'Close course status',
  }).click();
  expect(await page.evaluate(() => window.__rejectTimegateClipboard())).toBe(
    true,
  );
  await page.waitForTimeout(50);
  expect(
    await page.locator('#timegate-support-text').evaluate((textarea) => ({
      hidden: textarea.hidden,
      value: textarea.value,
    })),
  ).toEqual({ hidden: true, value: '' });

  await beginDeferredCopy();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(await page.evaluate(() => window.__rejectTimegateClipboard())).toBe(
    true,
  );
  await page.waitForTimeout(50);
  expect(
    await page.locator('#timegate-support-text').evaluate((textarea) => ({
      hidden: textarea.hidden,
      value: textarea.value,
    })),
  ).toEqual({ hidden: true, value: '' });
});

test('learner support final review throttles timer termination retries but lets the learner retry now', async ({
  browser,
}) => {
  const terminationContext = await browser.newContext();
  const terminationPage = await terminationContext.newPage();
  await openLearnerSupportHarness(terminationPage);
  expect(
    await terminationPage.evaluate(() => window.localLmsHarness.complete()),
  ).toBe('true');
  const firstTermination = await terminationPage.evaluate(() => {
    window.__timegateFinishAttemptTimes = [];
    const calls = window.localLmsHarness.calls;
    calls.push = function () {
      const entry = arguments[0];
      if (entry && entry[0] === 'LMSFinish') {
        window.__timegateFinishAttemptTimes.push(Date.now());
      }
      return Array.prototype.push.apply(this, arguments);
    };
    window.localLmsHarness.failure.finish = true;
    return window.localLmsHarness.finish();
  });
  expect(firstTermination).toBe('false');
  await terminationPage.waitForTimeout(3_500);
  expect(
    await terminationPage.evaluate(
      () => window.__timegateFinishAttemptTimes.length,
    ),
  ).toBe(1);
  await terminationPage.waitForFunction(
    () => window.__timegateFinishAttemptTimes.length >= 2,
    null,
    { timeout: 3_500 },
  );
  const retrySpacing = await terminationPage.evaluate(
    () =>
      window.__timegateFinishAttemptTimes[1] -
      window.__timegateFinishAttemptTimes[0],
  );
  expect(retrySpacing).toBeGreaterThanOrEqual(4_900);
  await terminationContext.close();

  const learnerContext = await browser.newContext();
  const learnerPage = await learnerContext.newPage();
  await openLearnerSupportHarness(learnerPage);
  await learnerPage.evaluate(() => {
    window.localLmsHarness.failure.commit = true;
    window.localLmsHarness.complete();
  });
  await learnerPage.locator('#timegate-support-button').click();
  const retry = learnerPage.locator('#timegate-retry-completion');
  await expect(retry).toBeVisible();
  const attemptsBefore = await learnerPage.evaluate(() =>
    window.localLmsHarness.calls.filter(
      (call) =>
        call[0] === 'LMSSetValue' &&
        call[1] === 'cmi.core.lesson_status' &&
        call[2] === 'completed',
    ).length,
  );
  await learnerPage.evaluate(() => {
    window.localLmsHarness.failure.commit = false;
  });
  await retry.click();
  const immediate = await learnerPage.evaluate((before) => ({
    completionSafeToClose:
      window.__SIS_TIMEGATE_SUPPORT__.status().completionSafeToClose,
    writeAttempts: window.localLmsHarness.calls.filter(
      (call) =>
        call[0] === 'LMSSetValue' &&
        call[1] === 'cmi.core.lesson_status' &&
        call[2] === 'completed',
    ).length - before,
  }), attemptsBefore);
  expect(immediate.writeAttempts).toBeGreaterThanOrEqual(1);
  expect(immediate.completionSafeToClose).toBe(true);
  await learnerContext.close();
});

test('learner support final review keeps a bottom-left problem banner inside a 320px viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 667 });
  await page.addInitScript(() => {
    let timegateConfig;
    Object.defineProperty(window, 'TIMEGATE_CONFIG', {
      configurable: true,
      get: function () {
        return timegateConfig;
      },
      set: function (value) {
        value.position = 'bottom-left';
        timegateConfig = value;
      },
    });
  });
  await openLearnerSupportHarness(page);
  await page.evaluate(() => {
    window.localLmsHarness.failure.commit = true;
    window.localLmsHarness.complete();
  });

  const banner = page.locator('#timegate-support-banner');
  await expect(banner).toBeVisible();
  await expect(page.locator('#timegate-root')).toHaveClass(/timegate--bottom-left/);
  const geometry = await banner.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
});

test('learner support final review keeps projection-only issues out of runtime history', async ({
  page,
}) => {
  await openLearnerSupportHarness(page);
  const first = (await buildLearnerSupportReport(page)).parsed.payload;
  const second = (await buildLearnerSupportReport(page)).parsed.payload;
  const firstProjection = first.issues.find(
    (issue) => issue.code === 'COURSE_COMPLETION_NOT_REQUESTED',
  );
  const secondProjection = second.issues.find(
    (issue) => issue.code === 'COURSE_COMPLETION_NOT_REQUESTED',
  );

  expect(firstProjection).toBeDefined();
  expect(secondProjection).toEqual(firstProjection);
  expect(second.timeline).toEqual(first.timeline);

  expect(await page.evaluate(() => window.localLmsHarness.complete())).toBe(
    'true',
  );
  const afterCompletion = (
    await buildLearnerSupportReport(page)
  ).parsed.payload;
  expect(afterCompletion.summary.completionSafeToClose).toBe(true);
  expect(
    afterCompletion.issues.some(
      (issue) => issue.code === 'COURSE_COMPLETION_NOT_REQUESTED',
    ),
  ).toBe(false);
});

test('learner support final review inerts the background and announces dialog status', async ({
  page,
}) => {
  await openLearnerSupportHarness(page);
  await page.evaluate(() => {
    window.__supportLiveTransitions = [];
    const live = document.getElementById('timegate-support-live');
    new MutationObserver(function () {
      const value = live.textContent.trim();
      if (value) window.__supportLiveTransitions.push(value);
    }).observe(live, { childList: true, characterData: true, subtree: true });
  });

  const invoker = page.locator('#timegate-support-button');
  await invoker.click();
  const overlay = page.locator('#timegate-support-overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay).not.toHaveAttribute('inert', '');
  await expect(page.locator('#timegate-support-live')).toHaveAttribute(
    'aria-live',
    'polite',
  );
  await page.waitForTimeout(100);
  const announcement = await page.evaluate(
    () => window.__supportLiveTransitions.at(-1) || '',
  );
  const visibleStatus = await page.locator('#timegate-support-status').innerText();
  expect.soft(announcement).toMatch(/course status.*open/i);
  expect.soft(announcement).toContain(visibleStatus);

  const background = await page.evaluate(() => {
    const overlayNode = document.getElementById('timegate-support-overlay');
    return Array.from(document.body.children)
      .filter((node) => node !== overlayNode)
      .map((node) => ({
        id: node.id,
        inert: node.hasAttribute('inert'),
      }));
  });
  expect.soft(background.length).toBeGreaterThan(0);
  expect.soft(background.every((item) => item.inert)).toBe(true);

  await page.getByRole('button', {
    name: 'Close course status',
  }).click();
  await expect(overlay).toBeHidden();
  await expect(page.locator('#timegate-root')).not.toHaveAttribute('inert', '');
  await expect(invoker).toBeFocused();
});

async function installScorm2004RiseOutcomeDrivers(page) {
  await page.addInitScript(() => {
    window.__rise2004OutcomeCalls = [];

    function reportOutcome(name, outcome) {
      window.__rise2004OutcomeCalls.push([name]);
      const completionResult = window.SCORM_CallLMSSetValue(
        'cmi.completion_status',
        'completed',
      );
      const outcomeResult = window.SCORM_CallLMSSetValue(
        'cmi.success_status',
        outcome,
      );
      return completionResult !== 'false' && outcomeResult !== 'false';
    }

    window.SetPassed = function () {
      return reportOutcome('SetPassed', 'passed');
    };
    window.SetFailed = function () {
      return reportOutcome('SetFailed', 'failed');
    };
  });
}

async function installScorm2004SuccessStatusFailureSwitch(page) {
  await page.addInitScript(() => {
    window.__failScorm2004SuccessStatus = false;
    let api;
    Object.defineProperty(window, 'API_1484_11', {
      configurable: true,
      enumerable: true,
      get: function () {
        return api;
      },
      set: function (value) {
        const originalSetValue = value.SetValue;
        value.SetValue = function (element) {
          if (
            element === 'cmi.success_status' &&
            window.__failScorm2004SuccessStatus
          ) {
            const previousFailure =
              window.localLmsHarness.failure.setValue;
            window.localLmsHarness.failure.setValue = true;
            try {
              return originalSetValue.apply(this, arguments);
            } finally {
              window.localLmsHarness.failure.setValue = previousFailure;
            }
          }
          return originalSetValue.apply(this, arguments);
        };
        api = value;
      },
    });
  });
}

test('learner support SCORM 2004 canonical readback confirms Rise passed and failed outcomes', async ({
  browser,
}) => {
  for (const scenario of [
    { driver: 'SetPassed', outcome: 'passed' },
    { driver: 'SetFailed', outcome: 'failed' },
  ]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await installScorm2004RiseOutcomeDrivers(page);
    await openScorm2004Harness(page, 'immediate');
    expect(
      await page.evaluate(() => window.localLmsHarness.initialize()),
    ).toBe('true');

    const result = await page.evaluate((driver) => ({
      driverResult: window[driver](),
      calls: window.localLmsHarness.calls.slice(),
      completionStatus:
        window.localLmsHarness.values['cmi.completion_status'],
      successStatus: window.localLmsHarness.values['cmi.success_status'],
    }), scenario.driver);
    const report = (await buildLearnerSupportReport(page)).parsed.payload;

    expect(result.driverResult).toBe(true);
    expect(result.completionStatus).toBe('completed');
    expect(result.successStatus).toBe(scenario.outcome);
    expect(result.calls).toEqual(
      expect.arrayContaining([
        ['SetValue', 'cmi.completion_status', 'completed'],
        ['SetValue', 'cmi.success_status', scenario.outcome],
        ['GetValue', 'cmi.completion_status'],
      ]),
    );
    expect(report.course.scormVersion).toBe('2004');
    expect(report.lms.canonicalStatus).toBe('completed');
    expect(report.completion).toMatchObject({
      lastReadbackStatus: 'completed',
      pending: false,
    });
    expect(report.summary).toEqual({
      state: 'completion_confirmed',
      completionSafeToClose: true,
      reasonCode: null,
    });

    await context.close();
  }
});

test('learner support SCORM 2004 remains pending until a failed noncanonical outcome queue clears', async ({
  page,
}) => {
  await installScorm2004SuccessStatusFailureSwitch(page);
  await openScorm2004Harness(page, 'immediate');
  expect(
    await page.evaluate(() => window.localLmsHarness.initialize()),
  ).toBe('true');

  const delivery = await page.evaluate(() => {
    const completionResult = window.localLmsHarness.complete();
    window.__failScorm2004SuccessStatus = true;
    const outcomeResult = window.localLmsHarness.setSuccess('passed');
    return {
      completionResult,
      completionStatus:
        window.localLmsHarness.values['cmi.completion_status'],
      outcomeResult,
      successStatus: window.localLmsHarness.values['cmi.success_status'],
    };
  });
  const pendingState = await readScorm2004TimegateState(page);
  const pendingReport = (await buildLearnerSupportReport(page)).parsed.payload;

  expect(delivery).toEqual({
    completionResult: 'true',
    completionStatus: 'completed',
    outcomeResult: 'false',
    successStatus: 'unknown',
  });
  expect(pendingState.pendingScorm).toEqual({
    'cmi.success_status': 'passed',
  });
  expect(pendingState.courseCompletePending).toBe(true);
  expect(pendingReport.lms.canonicalStatus).toBe('completed');
  expect(pendingReport.completion.pending).toBe(true);
  expect(pendingReport.summary.completionSafeToClose).toBe(false);

  await page.locator('#timegate-support-button').click();
  const retry = page.locator('#timegate-retry-completion');
  await expect(retry).toBeVisible();
  await page.evaluate(() => {
    window.__failScorm2004SuccessStatus = false;
  });
  await retry.click();
  await page.waitForFunction(() =>
    window.localLmsHarness.values['cmi.success_status'] === 'passed',
  );

  const clearedState = await readScorm2004TimegateState(page);
  const clearedReport = (await buildLearnerSupportReport(page)).parsed.payload;
  expect(clearedState.pendingScorm).toBeNull();
  expect(clearedState.courseCompletePending).toBe(false);
  expect(clearedReport.completion.pending).toBe(false);
  expect(clearedReport.summary).toEqual({
    state: 'completion_confirmed',
    completionSafeToClose: true,
    reasonCode: null,
  });
});
