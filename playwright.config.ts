import { defineConfig } from '@playwright/test';

// These tests drive a real Chrome against the real github.com. That makes them
// slow and rate-limited, so: one worker, generous timeouts, and no retries by
// default — a flaky pass here is worse than a failure, because the whole point
// of this suite is to be the thing that tells the truth about the browser.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
