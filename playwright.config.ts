import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalTeardown: './e2e/global-teardown.ts',
  forbidOnly: !!process.env.CI,
  timeout: 120_000, // 2 min per test — hot reload + backoff needs headroom
  expect: {
    timeout: 30_000,
  },
  fullyParallel: true, // Each test gets its own dynamic ports — safe to parallelize
  retries: 1, // 1 retry for resilience under parallel load (Chrome/extension startup can be flaky)
  workers: process.env.CI ? 2 : 8,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'e2e',
      testMatch: '**/*.e2e.ts',
    },
  ],
});
