const { defineConfig } = require('@playwright/test');

const port = Number(process.env.SCORM_HARNESS_PORT || 4173);

module.exports = defineConfig({
  testDir: './tests/runtime',
  testMatch: 'observability.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 20_000,
  expect: {
    timeout: 7_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tests/runtime/harness/server.js',
    url: `http://127.0.0.1:${port}/__health`,
    timeout: 10_000,
    reuseExistingServer: !process.env.CI,
    env: {
      SCORM_HARNESS_PORT: String(port),
    },
  },
});
